import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import type { Request, Response } from 'express';
import Article, {
  ARTICLE_STATUSES,
  ArticleDoc,
  GATE_TIERS,
  type ArticleStatus,
  type GateTier,
} from '../models/Article';
import ArticleSummary from '../models/ArticleSummary';
import { findAssetMeta, recordUploadedAsset } from '../models/UploadedAsset';
import Category, { CategoryDoc } from '../models/Category';
import Region from '../models/Region';
import { generateUniqueSlug } from '../utils/slugify';
import { createArticleUploadUrl, deleteS3Object } from '../config/s3';
import { httpError } from '../utils/errors';
import {
  findActiveUser,
  findUsersByIds,
  toAuthorSummary,
  type AuthorSummary,
} from '../services/users';
import { syncArticleEmbeddings, purgeArticleChunks } from '../services/articleEmbeddings';
import {
  actorFromRequest,
  listActivity,
  purgeActivity,
  recordActivities,
  ACTIVITY_DEFAULT_LIMIT,
} from '../services/activity';
import {
  buildArticleUpdateActivity,
  diffStatus,
  toArticleActivity,
  type ArticleActivityDraft,
} from '../services/articleActivity';
import { findCategoryByIdOrThrow, findCategoryBySlug } from '../services/categories';
import User from '../models/User';
import { parseOrder, parseSortKey, searchRegex, stableSort } from '../utils/query';
import ResearchRequest from '../models/ResearchRequest';
import { sanitizePublicPulseBlocks } from '../services/publicPulse/body';
import {
  findActiveRegionIdsOrThrow,
  getGlobalRegion,
  serializeRegion,
  sortRegionsForDisplay,
} from '../services/regions';
import { getTier } from '../middleware/auth';
import { clipBodyForAudience, countGateNodes, keepFirstGateNode, type Audience } from '../lib/articleGate';

const MAX_LIMIT = 100;
const FEATURED_MAX = 5;
const HIGHLIGHT_MAX = 3;
const KEY_STORY_MAX = 5;
const TOP_STORIES_MAX = 3;
const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

// Admin/editor routes serialize for the editor, not for a reader — see the
// `Audience` note on serializeArticle. Already behind requireModerator.
const ADMIN_AUDIENCE = 'admin' as const;

function validateReadTime(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw httpError(400, 'readTimeMinutes must be a positive integer');
  }
  return value as number;
}

// '' / 'none' / null all mean "ungated" — the admin select submits '' for None.
function normalizeGateTier(value: unknown, fallback: GateTier | undefined = undefined): GateTier | undefined {
  if (value === undefined) return fallback;
  if (value === null || value === '' || value === 'none') return undefined;
  if (GATE_TIERS.includes(value as GateTier)) return value as GateTier;
  throw httpError(400, 'invalid_gateTier');
}

// The gate invariant: gateTier is set IFF the body has a gate node. Half a gate
// is the dangerous state — a tier with no node would fail closed and blank the
// article, a node with no tier would render as a silent no-op — so reject both
// at the boundary rather than letting either reach the reader.
function assertGateConsistency(body: unknown, gateTier: GateTier | undefined): void {
  const gates = countGateNodes(body);
  if (gateTier && gates === 0) {
    throw httpError(400, 'gate_tier_without_gate_node');
  }
  if (!gateTier && gates > 0) {
    throw httpError(400, 'gate_node_without_gate_tier');
  }
}

function normalizeStatus(value: unknown, fallback: ArticleStatus = 'draft'): ArticleStatus {
  if (value === undefined) return fallback;
  if (ARTICLE_STATUSES.includes(value as ArticleStatus)) return value as ArticleStatus;
  throw httpError(400, 'invalid_status');
}

// Placement (featured/highlight/keyStory/topStories) is a property of a live
// article. Scheduled and archived articles are not live, so they carry no
// placement — same rule drafts have always followed.
function isLive(status: ArticleStatus): boolean {
  return status === 'published';
}

// `scheduled` is the only status whose publish date the client owns: it names
// the future moment the cron should publish the article. Every other status has
// a system-managed date (stamped on publish, absent otherwise).
function normalizeScheduledDate(value: unknown): Date {
  if (value === undefined || value === null || value === '') {
    throw httpError(400, 'publish_date_required_for_scheduled');
  }
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) throw httpError(400, 'invalid_publish_date');
  if (date.getTime() <= Date.now()) throw httpError(400, 'publish_date_must_be_future');
  return date;
}

async function assertFeaturedLimit(excludeId: string | null = null): Promise<void> {
  const query: Record<string, unknown> = { status: 'published', featured: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= FEATURED_MAX) throw httpError(400, `Featured limit reached (max ${FEATURED_MAX})`);
}

async function assertHighlightLimit(excludeId: string | null = null): Promise<void> {
  const query: Record<string, unknown> = { status: 'published', highlight: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= HIGHLIGHT_MAX) throw httpError(400, `Highlight limit reached (max ${HIGHLIGHT_MAX})`);
}

async function assertKeyStoryLimit(excludeId: string | null = null): Promise<void> {
  const query: Record<string, unknown> = { status: 'published', keyStory: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= KEY_STORY_MAX) throw httpError(400, `Key stories limit reached (max ${KEY_STORY_MAX})`);
}

async function assertTopStoriesLimit(excludeId: string | null = null): Promise<void> {
  const query: Record<string, unknown> = { status: 'published', topStories: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= TOP_STORIES_MAX) throw httpError(400, `Top Stories limit reached (max ${TOP_STORIES_MAX})`);
}


// An article author must be the super admin (env-derived) or an active moderator (§6a).
async function assertValidAuthor(authorId: unknown): Promise<string> {
  if (typeof authorId !== 'string' || !authorId) throw httpError(400, 'invalid_author');
  if (authorId === SUPER_ADMIN_USER_ID) return authorId;
  const user = await findActiveUser(authorId);
  if (!user || user.role !== 'moderator') throw httpError(400, 'invalid_author');
  return authorId;
}

function fallbackAuthor(authorId: string): AuthorSummary {
  return { id: authorId, displayName: 'Unknown', imageUrl: null };
}

function applyCategory(obj: Record<string, unknown>, category: CategoryDoc | null | undefined, fallback?: string) {
  if (category) {
    obj.category = category.title;
    obj.categorySlug = category.slug;
    obj.categoryId = String(category._id);
  } else {
    obj.category = fallback ?? '';
    obj.categorySlug = null;
    obj.categoryId = null;
  }
}

// Replace authorId with a nested author object joined from the users mirror (§6a).
//
// `audience` decides how much of the body comes back: this is the only place a
// full body is handed to a caller, so the clip has to happen here rather than in
// the route. Deliberately required and un-defaulted — a default would fail open,
// silently unclipping any future caller that forgot it.
//
// See `Audience` in lib/articleGate.ts for why 'admin' is not just "premium".
async function serializeArticle(doc: ArticleDoc, audience: Audience): Promise<Record<string, unknown>> {
  const [users, category, regions, aiSummary] = await Promise.all([
    findUsersByIds([doc.authorId]),
    doc.categoryId ? Category.findById(doc.categoryId) : Promise.resolve(null),
    Region.find({ _id: { $in: doc.regionIds ?? [] } }).sort({ title: 1 }),
    ArticleSummary.findOne({ articleId: doc._id, approved: true }).select('format content'),
  ]);
  const obj = doc.toObject() as Record<string, unknown>;
  delete obj.authorId;
  const user = users[0];
  obj.author = user ? toAuthorSummary(user) : fallbackAuthor(doc.authorId);
  applyCategory(obj, category, doc.category);
  // Global leads the list; the rest follow alphabetically.
  const ordered = sortRegionsForDisplay(regions);
  obj.regions = ordered.map(serializeRegion);
  obj.regionIds = ordered.map((region) => String(region._id));

  const gateTier = (doc.gateTier ?? null) as GateTier | null;
  const { body, teaser, locked } = clipBodyForAudience(doc.body, gateTier, audience);
  obj.gateTier = gateTier;
  obj.body = body;
  // `viewerTier` is for copy only — the gate card addresses a Core member
  // differently from a signed-out reader. Returned from here rather than
  // re-derived on the frontend so there's one authority on what plan someone is
  // on. Never a permission signal: the body above is already clipped.
  obj.access = locked
    ? { locked: true, requiredTier: gateTier, viewerTier: audience === 'admin' ? 'premium' : audience, teaser }
    : { locked: false, requiredTier: gateTier };

  // The AI summary is distilled from the whole article, so for a locked reader
  // it is the gated content — just shorter. Withhold it rather than hand over
  // the payload in miniature.
  if (aiSummary && !locked) {
    obj.aiSummary = {
      format: aiSummary.format,
      content: aiSummary.content,
    };
  }

  // Same reasoning as the summary: the audio narrates the WHOLE article, gate and
  // all. Not hiding the player — dropping the URL, because a link left in the
  // payload is the article, readable with devtools and no plan.
  if (locked) {
    delete obj.audioUrl;
    delete obj.audioKey;
  }

  // Upload names and sizes label files in the admin editor. A filename is the
  // uploader's own words and can carry internal intent ("hero-EMBARGOED.jpg"),
  // so it does not belong in a reader-facing payload.
  if (audience !== 'admin') {
    delete obj.featuredImageName;
    delete obj.featuredImageSize;
    delete obj.audioName;
    delete obj.audioSize;
  }
  return obj;
}

async function serializeArticles(docs: ArticleDoc[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(docs.map((d) => d.authorId).filter(Boolean))];
  const categoryIds = [
    ...new Set(docs.map((d) => d.categoryId?.toString()).filter((id): id is string => Boolean(id))),
  ];
  const regionIds = [
    ...new Set(docs.flatMap((d) => (d.regionIds ?? []).map(String)).filter(Boolean)),
  ];
  const [users, categories, regions] = await Promise.all([
    findUsersByIds(ids),
    Category.find({ _id: { $in: categoryIds } }),
    Region.find({ _id: { $in: regionIds } }).sort({ title: 1 }),
  ]);
  const map = new Map(users.map((u) => [u.clerkUserId, u]));
  const categoryMap = new Map(categories.map((category) => [String(category._id), category]));
  const regionMap = new Map(regions.map((region) => [String(region._id), region]));
  return docs.map((d) => {
    const obj = d.toObject() as Record<string, unknown>;
    delete obj.authorId;
    const u = map.get(d.authorId);
    obj.author = u ? toAuthorSummary(u) : fallbackAuthor(d.authorId);
    applyCategory(obj, categoryMap.get(String(d.categoryId)), d.category);
    const articleRegions = (d.regionIds ?? [])
      .map((id) => regionMap.get(String(id)))
      .filter((region): region is NonNullable<typeof region> => Boolean(region));
    obj.regions = articleRegions.map(serializeRegion);
    obj.regionIds = articleRegions.map((region) => String(region._id));
    // Listings are body-less (`.select('-body')`), so there is nothing to clip —
    // gateTier only drives the tier pill on cards. That keeps listings identical
    // for every reader, and their shared `revalidate: 60` cache safe.
    obj.gateTier = d.gateTier ?? null;
    // …but `-body` does not exclude the audio, and the narration is the whole
    // article. Left in, a listing would hand out the full contents of every gated
    // article to anyone who called it. Dropped for gated articles regardless of
    // who is asking: no listing UI plays audio, and keeping this reader-independent
    // is what lets listings stay cached.
    if (d.gateTier) {
      delete obj.audioUrl;
      delete obj.audioKey;
    }
    // Listings are shared between the admin table and public surfaces and are
    // cached reader-independently, so the upload labels come out of all of them.
    // Only the single-article admin fetch needs them.
    delete obj.featuredImageName;
    delete obj.featuredImageSize;
    delete obj.audioName;
    delete obj.audioSize;
    return obj;
  });
}

// POST /api/admin/articles/upload-url
export async function uploadUrl(req: Request, res: Response) {
  const { filename, contentType, fileSize, type } = req.body;

  if (!filename || !contentType || fileSize == null) {
    return res.status(400).json({ error: 'filename, contentType, and fileSize are required' });
  }

  const result = await createArticleUploadUrl({ filename, contentType, fileSize, type });

  // The key is a UUID, so this is the only moment the real name and size are
  // known. Recorded here and read back when the media is attached.
  await recordUploadedAsset({
    fileKey: result.fileKey,
    originalName: filename,
    size: fileSize,
    contentType,
    surface: 'article',
    kind: type ?? 'featured',
    uploadedBy: getAuth(req).userId ?? undefined,
  });

  res.json(result);
}

// Columns the admin articles table can be ordered by, mapped onto the fields
// they actually render. Anything outside this list falls back to publish date.
const ARTICLE_SORT_KEYS = ['title', 'publishDate', 'status', 'category', 'createdAt', 'updatedAt'] as const;
const ARTICLE_SORT_FIELDS: Record<(typeof ARTICLE_SORT_KEYS)[number], string> = {
  title: 'title',
  publishDate: 'publishDate',
  status: 'status',
  category: 'category',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
};

// Case- and accent-insensitive ordering, so "Zeb" does not sort before "apple".
const COLLATION = { locale: 'en', strength: 2 } as const;

/** Clerk ids whose display name or email matches a search term. */
async function findUsersMatching(term: RegExp): Promise<string[]> {
  const users = await User.find({ $or: [{ displayName: term }, { email: term }] })
    .select('clerkUserId')
    .lean();
  return users.map((u) => u.clerkUserId as string);
}

// GET /api/articles (public — published only) and GET /api/admin/articles (full filter set).
// `forcePublished` is set by the public route so callers cannot request drafts.
function buildListHandler(forcePublished: boolean) {
  return async function list(req: Request, res: Response) {
    const { category, categoryId, categorySlug, template, excludeId } = req.query as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    const filter: Record<string, unknown> = {};
    if (categoryId) filter.categoryId = categoryId;
    else if (categorySlug) {
      const found = await findCategoryBySlug(categorySlug);
      if (!found) {
        res.json({ data: [], pagination: { total: 0, page, limit, pages: 0 } });
        return;
      }
      filter.categoryId = found._id;
    } else if (category) filter.category = category;
    if (forcePublished) {
      // Public listing always forces published; ignore any caller-supplied status.
      filter.status = 'published';
    } else if (req.query.status) {
      filter.status = req.query.status;
    }
    if (template) filter.template = template;
    // Admin-only gate filter. 'free' means ungated, and an ungated article carries
    // no gateTier at all — `null` matches both a missing field and an explicit null.
    if (!forcePublished && req.query.gateTier) {
      filter.gateTier = req.query.gateTier === 'free' ? null : req.query.gateTier;
    }
    if (req.query.featured === 'true') filter.featured = true;
    if (req.query.highlight === 'true') filter.highlight = true;
    if (req.query.keyStory === 'true') filter.keyStory = true;
    if (req.query.topStories === 'true') filter.topStories = true;
    if (excludeId && mongoose.isValidObjectId(excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
    }

    // Free-text search across the whole collection, not just the page in hand.
    // The byline lives on the users mirror rather than on the article, so a
    // matching author is resolved to Clerk ids first and folded into the $or.
    const term = searchRegex(req.query.search ?? req.query.q);
    if (term) {
      const authors = await findUsersMatching(term);
      const clauses: Record<string, unknown>[] = [
        { title: term },
        { slug: term },
        { excerpt: term },
        { category: term },
      ];
      if (authors.length > 0) clauses.push({ authorId: { $in: authors } });
      filter.$or = clauses;
    }

    const sortKey = parseSortKey(req.query.sort, ARTICLE_SORT_KEYS, 'publishDate');
    const order = parseOrder(req.query.order, sortKey === 'title' ? 1 : -1);

    const skip = (page - 1) * limit;

    const [articles, total] = await Promise.all([
      Article.find(filter)
        .collation(COLLATION)
        .sort(stableSort(ARTICLE_SORT_FIELDS[sortKey], order))
        .skip(skip)
        .limit(limit)
        .select('-body'),
      Article.countDocuments(filter),
    ]);

    res.json({
      data: await serializeArticles(articles),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  };
}

export const list = buildListHandler(false);
export const listPublished = buildListHandler(true);

// GET /api/admin/articles/slug-check?title=
export async function slugCheck(req: Request, res: Response) {
  const { title } = req.query as Record<string, string | undefined>;
  if (!title) return res.status(400).json({ error: 'title query param required' });

  const slug = await generateUniqueSlug(title, Article);
  res.json({ slug });
}

// GET /api/articles/:slug (public — 404 unless published)
//
// The response varies by the caller's plan (gated articles are clipped), so this
// must never be cached across readers — callers send `cache: 'no-store'`.
export async function getPublishedBySlug(req: Request, res: Response) {
  const article = await Article.findOne({ slug: req.params.slug, status: 'published' });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(await serializeArticle(article, getTier(getAuth(req))));
}

// GET /api/admin/articles/slug/:slug (admin — any status)
export async function getAdminBySlug(req: Request, res: Response) {
  const article = await Article.findOne({ slug: req.params.slug });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(await serializeArticle(article, ADMIN_AUDIENCE));
}

// POST /api/admin/articles
export async function create(req: Request, res: Response) {
  const {
    title, excerpt, author_id,
    categoryId, regionIds, featuredImage, featuredImageCaption, featuredImageKey,
    audioUrl, audioKey,
    template, status, body, gateTier, publishDate,
    featured, highlight, keyStory, topStories, readTimeMinutes,
  } = req.body;

  const authorId = await assertValidAuthor(author_id);
  const categoryDoc = await findCategoryByIdOrThrow(categoryId);
  const selectedRegionIds = Array.isArray(regionIds) && regionIds.length > 0
    ? await findActiveRegionIdsOrThrow(regionIds)
    : [(await getGlobalRegion())._id];
  const nextStatus = normalizeStatus(status);
  const nextFeatured = isLive(nextStatus) && featured === true;
  const nextHighlight = isLive(nextStatus) && highlight === true;
  const nextKeyStory = isLive(nextStatus) && keyStory === true;
  const nextTopStories = isLive(nextStatus) && topStories === true;
  if (nextFeatured) await assertFeaturedLimit();
  if (nextHighlight) await assertHighlightLimit();
  if (nextKeyStory) await assertKeyStoryLimit();
  if (nextTopStories) await assertTopStoriesLimit();
  const readTime = validateReadTime(readTimeMinutes);

  const slug = await generateUniqueSlug(title, Article);

  const nextGateTier = normalizeGateTier(gateTier);
  const sanitizedBody = keepFirstGateNode(await sanitizePublicPulseBlocks(body));
  assertGateConsistency(sanitizedBody, nextGateTier);

  // Name and size come from the upload record, never from the request body, so
  // the label cannot disagree with what was actually uploaded.
  const imageMeta = featuredImageKey ? await findAssetMeta(featuredImageKey) : null;
  const audioMeta = audioKey ? await findAssetMeta(audioKey) : null;

  const article = await Article.create({
    title, slug, excerpt, authorId, categoryId: categoryDoc._id, category: categoryDoc.title,
    regionIds: selectedRegionIds,
    featuredImage, featuredImageCaption, featuredImageKey,
    audioUrl: audioUrl || undefined, audioKey: audioKey || undefined,
    featuredImageName: imageMeta?.originalName,
    featuredImageSize: imageMeta?.size,
    audioName: audioMeta?.originalName,
    audioSize: audioMeta?.size,
    template,
    // Publish date is system-managed except when scheduling, where the caller
    // names the future moment the cron should publish: stamped now when
    // published, the caller's date when scheduled, absent otherwise.
    publishDate:
      nextStatus === 'published'
        ? new Date()
        : nextStatus === 'scheduled'
          ? normalizeScheduledDate(publishDate)
          : undefined,
    status: nextStatus, body: sanitizedBody, gateTier: nextGateTier,
    featured: nextFeatured, highlight: nextHighlight, keyStory: nextKeyStory, topStories: nextTopStories,
    readTimeMinutes: readTime,
  });

  // Keep the RAG index in sync (Phase 2): only published articles get chunks.
  // Awaited (not fire-and-forget) so it runs reliably on serverless; the call
  // never throws and the bodyHash skip makes unchanged re-saves cheap.
  if (article.status === 'published') await syncArticleEmbeddings(article);

  // An article created straight into scheduled/published carries its lifecycle
  // event too, so the timeline never opens on an unexplained live article.
  const createdDrafts: ArticleActivityDraft[] = [
    { action: 'created', metadata: { status: nextStatus } },
  ];
  if (nextStatus === 'scheduled') {
    createdDrafts.push({
      action: 'scheduled',
      metadata: { from: 'draft', to: nextStatus, publishDate: article.publishDate?.toISOString() ?? null },
    });
  } else if (nextStatus === 'published') {
    createdDrafts.push({ action: 'published', metadata: { from: 'draft', to: nextStatus } });
  } else if (nextStatus === 'archived') {
    createdDrafts.push({ action: 'archived', metadata: { from: 'draft', to: nextStatus } });
  }
  await recordActivities(
    toArticleActivity(article._id as mongoose.Types.ObjectId, actorFromRequest(req), createdDrafts),
  );

  res.status(201).json(await serializeArticle(article, ADMIN_AUDIENCE));
}
// Placement flags, in the order the admin table renders them.
const PLACEMENT_FLAGS = ['featured', 'highlight', 'keyStory', 'topStories'] as const;


// PUT /api/admin/articles/:id
export async function update(req: Request, res: Response) {
  const {
    title, excerpt, author_id,
    categoryId, regionIds, featuredImage, featuredImageCaption, featuredImageKey,
    audioUrl, audioKey,
    template, status, body, gateTier, publishDate,
    featured, highlight, keyStory, topStories, readTimeMinutes,
  } = req.body;

  const current = await Article.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Article not found' });

  const nextStatus = normalizeStatus(status, current.status);
  const wasPublished = current.status === 'published';
  const currentFeatured = isLive(current.status) ? current.featured : false;
  const currentHighlight = isLive(current.status) ? current.highlight : false;
  const currentKeyStory = isLive(current.status) ? current.keyStory : false;
  const nextFeatured =
    isLive(nextStatus) ? (featured !== undefined ? featured === true : currentFeatured) : false;
  const nextHighlight =
    isLive(nextStatus) ? (highlight !== undefined ? highlight === true : currentHighlight) : false;
  const nextKeyStory =
    isLive(nextStatus) ? (keyStory !== undefined ? keyStory === true : currentKeyStory) : false;
  const currentTopStories = isLive(current.status) ? current.topStories : false;
  const nextTopStories =
    isLive(nextStatus) ? (topStories !== undefined ? topStories === true : currentTopStories) : false;
  // Leaving the live state (to draft, scheduled or archived) strips placement.
  const leavesLive = !isLive(nextStatus);
  const shouldClearDraftFeatured = leavesLive && current.featured;
  const shouldClearDraftHighlight = leavesLive && current.highlight;
  const shouldClearDraftKeyStory = leavesLive && current.keyStory;
  const shouldClearDraftTopStories = leavesLive && current.topStories;
  const isRemovingAudio =
    audioUrl === null || audioUrl === '' || audioKey === null || audioKey === '';
  const shouldDeleteOldAudio =
    !!current.audioKey &&
    (isRemovingAudio || (typeof audioKey === 'string' && audioKey !== current.audioKey));

  // Only published articles can be featured/highlighted; limits count published
  // placements only.
  if (nextFeatured && !currentFeatured) await assertFeaturedLimit(req.params.id);
  if (nextHighlight && !currentHighlight) await assertHighlightLimit(req.params.id);
  if (nextKeyStory && !currentKeyStory) await assertKeyStoryLimit(req.params.id);
  if (nextTopStories && !currentTopStories) await assertTopStoriesLimit(req.params.id);
  if (readTimeMinutes !== undefined) validateReadTime(readTimeMinutes);

  // Captured while building the patch so the activity log can name the target
  // category rather than its id.
  let nextCategoryTitle: string | null = null;
  const patch: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Article, req.params.id);
  }
  if (excerpt !== undefined) patch.excerpt = excerpt;
  if (author_id !== undefined) patch.authorId = await assertValidAuthor(author_id);
  if (categoryId !== undefined) {
    const categoryDoc = await findCategoryByIdOrThrow(categoryId);
    patch.categoryId = categoryDoc._id;
    patch.category = categoryDoc.title;
    nextCategoryTitle = categoryDoc.title;
  }
  if (regionIds !== undefined) {
    patch.regionIds = Array.isArray(regionIds) && regionIds.length > 0
      ? await findActiveRegionIdsOrThrow(regionIds)
      : [(await getGlobalRegion())._id];
  }
  if (featuredImage !== undefined) patch.featuredImage = featuredImage;
  if (featuredImageCaption !== undefined) patch.featuredImageCaption = featuredImageCaption;
  if (featuredImageKey !== undefined) {
    patch.featuredImageKey = featuredImageKey;
    // Name and size track the key, and come from the upload record rather than
    // the request body. An upload predating that collection resolves to null,
    // so the stale label is cleared instead of left describing the old file.
    const meta = await findAssetMeta(featuredImageKey);
    if (meta) {
      patch.featuredImageName = meta.originalName;
      patch.featuredImageSize = meta.size;
    } else {
      unset.featuredImageName = 1;
      unset.featuredImageSize = 1;
    }
  }
  if (audioUrl !== undefined || isRemovingAudio) {
    if (audioUrl === null || audioUrl === '' || isRemovingAudio) unset.audioUrl = 1;
    else patch.audioUrl = audioUrl;
  }
  if (audioKey !== undefined || isRemovingAudio) {
    if (audioKey === null || audioKey === '' || isRemovingAudio) {
      unset.audioKey = 1;
      unset.audioName = 1;
      unset.audioSize = 1;
    } else {
      patch.audioKey = audioKey;
      const meta = await findAssetMeta(audioKey);
      if (meta) {
        patch.audioName = meta.originalName;
        patch.audioSize = meta.size;
      } else {
        unset.audioName = 1;
        unset.audioSize = 1;
      }
    }
  }
  if (template !== undefined) patch.template = template;
  // Publish date follows status: stamped the moment an article goes live, set
  // by the caller while scheduled, and cleared for draft/archived (even if the
  // article was published before). A published article that stays published
  // keeps its original date.
  if (nextStatus === 'draft' || nextStatus === 'archived') {
    if (current.publishDate) unset.publishDate = 1;
  } else if (nextStatus === 'scheduled') {
    // Re-scheduling without naming a new date keeps the pending one; there is
    // nothing to validate in that case beyond it still being in the future.
    patch.publishDate =
      publishDate !== undefined || current.status !== 'scheduled' || !current.publishDate
        ? normalizeScheduledDate(publishDate)
        : current.publishDate;
  } else if (!wasPublished) {
    patch.publishDate = new Date();
  }
  if (status !== undefined) patch.status = nextStatus;
  if (body !== undefined) patch.body = keepFirstGateNode(await sanitizePublicPulseBlocks(body));

  // Body and gateTier can be patched independently, so check the invariant
  // against the *resulting* pair — dropping the gate node without clearing the
  // tier (or vice versa) has to fail here, not at render time.
  const nextGateTier = normalizeGateTier(gateTier, current.gateTier);
  assertGateConsistency(body !== undefined ? patch.body : current.body, nextGateTier);
  if (gateTier !== undefined || body !== undefined) {
    if (nextGateTier) patch.gateTier = nextGateTier;
    else if (current.gateTier) unset.gateTier = 1;
  }

  if (featured !== undefined || status !== undefined || shouldClearDraftFeatured) patch.featured = nextFeatured;
  if (highlight !== undefined || status !== undefined || shouldClearDraftHighlight) patch.highlight = nextHighlight;
  if (keyStory !== undefined || status !== undefined || shouldClearDraftKeyStory) patch.keyStory = nextKeyStory;
  if (topStories !== undefined || status !== undefined || shouldClearDraftTopStories) patch.topStories = nextTopStories;
  if (readTimeMinutes !== undefined) patch.readTimeMinutes = readTimeMinutes ?? null;

  const updateDoc =
    Object.keys(unset).length > 0
      ? { ...(Object.keys(patch).length > 0 ? { $set: patch } : {}), $unset: unset }
      : patch;

  const article = await Article.findByIdAndUpdate(req.params.id, updateDoc, {
    new: true,
    runValidators: true,
  });

  // Sync the RAG index (Phase 2): re-embed when published (bodyHash skips no-op
  // prose), purge chunks when the article is not (or no longer) published.
  if (article!.status === 'published') await syncArticleEmbeddings(article!);
  else await purgeArticleChunks(String(article!._id));
  if (shouldDeleteOldAudio) {
    await deleteS3Object(current.audioKey!).catch((err) => {
      console.warn('Failed to delete old article audio from S3', err);
    });
  }

  await recordActivities(
    toArticleActivity(
      article!._id as mongoose.Types.ObjectId,
      actorFromRequest(req),
      await buildArticleUpdateActivity({
        current,
        updated: article!,
        patch,
        unset,
        nextStatus,
        nextCategoryTitle,
        nextGateTier,
      }),
    ),
  );

  res.json(await serializeArticle(article!, ADMIN_AUDIENCE));
}

// POST /api/admin/articles/bulk
//
// Applies one action to a selection made in the admin table. Actions map onto
// the same invariants the single-article handlers enforce:
//   delete   — permanent, with the same index/summary/S3 cleanup as DELETE /:id
//   status   — placement is stripped whenever the article leaves the live state,
//              publishDate follows the status, and the RAG index is re-synced
//   category — moves every selected article to one category
//
// Placement limits are deliberately not re-checked here: bulk status changes can
// only ever clear placement flags (nothing in this handler sets one), so they
// cannot push a category over its featured/highlight cap.
export async function bulk(req: Request, res: Response) {
  const { ids, action } = req.body as { ids?: unknown; action?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const objectIds = ids.filter((id): id is string => typeof id === 'string' && mongoose.isValidObjectId(id));
  if (objectIds.length !== ids.length) return res.status(400).json({ error: 'invalid_article_id' });

  const articles = await Article.find({ _id: { $in: objectIds } });
  if (articles.length === 0) return res.status(404).json({ error: 'No articles found' });

  const actorId = actorFromRequest(req);

  if (action === 'delete') {
    await Article.deleteMany({ _id: { $in: objectIds } });
    await Promise.all(
      articles.map(async (article) => {
        await purgeArticleChunks(String(article._id));
        await purgeActivity('article', article._id as mongoose.Types.ObjectId);
        await ArticleSummary.deleteOne({ articleId: article._id });
        if (article.audioKey) {
          await deleteS3Object(article.audioKey).catch((err) => {
            console.warn('Failed to delete article audio from S3', err);
          });
        }
      }),
    );
    return res.json({ action, affected: articles.length });
  }

  if (action === 'status') {
    const nextStatus = normalizeStatus((req.body as { status?: unknown }).status);
    const scheduledFor =
      nextStatus === 'scheduled'
        ? normalizeScheduledDate((req.body as { publishDate?: unknown }).publishDate)
        : null;

    await Promise.all(
      articles.map(async (article) => {
        const patch: Record<string, unknown> = { status: nextStatus };
        const unset: Record<string, 1> = {};

        if (!isLive(nextStatus)) {
          patch.featured = false;
          patch.highlight = false;
          patch.keyStory = false;
          patch.topStories = false;
        }
        if (nextStatus === 'draft' || nextStatus === 'archived') {
          if (article.publishDate) unset.publishDate = 1;
        } else if (nextStatus === 'scheduled') {
          patch.publishDate = scheduledFor;
        } else if (article.status !== 'published') {
          patch.publishDate = new Date();
        }

        const updated = await Article.findByIdAndUpdate(
          article._id,
          Object.keys(unset).length > 0 ? { $set: patch, $unset: unset } : patch,
          { new: true, runValidators: true },
        );
        if (updated!.status === 'published') await syncArticleEmbeddings(updated!);
        else await purgeArticleChunks(String(updated!._id));

        // Same events a single-article status change records, so a bulk move is
        // indistinguishable from an individual one in the timeline.
        const drafts = diffStatus(article.status, nextStatus);
        if (nextStatus === 'scheduled' && article.status === 'scheduled') {
          drafts.push({
            action: 'publish_date_changed',
            metadata: {
              from: article.publishDate?.toISOString() ?? null,
              to: scheduledFor?.toISOString() ?? null,
            },
          });
        }
        for (const flag of PLACEMENT_FLAGS) {
          if (!isLive(nextStatus) && article[flag]) {
            drafts.push({ action: 'placement_changed', metadata: { flag, value: false } });
          }
        }
        await recordActivities(
          toArticleActivity(article._id as mongoose.Types.ObjectId, actorId, drafts),
        );
      }),
    );
    return res.json({ action, status: nextStatus, affected: articles.length });
  }

  if (action === 'category') {
    const categoryDoc = await findCategoryByIdOrThrow((req.body as { categoryId?: unknown }).categoryId);
    await Article.updateMany(
      { _id: { $in: objectIds } },
      { $set: { categoryId: categoryDoc._id, category: categoryDoc.title } },
    );
    await recordActivities(
      articles
        .filter((article) => article.category !== categoryDoc.title)
        .flatMap((article) =>
          toArticleActivity(article._id as mongoose.Types.ObjectId, actorId, [
            {
              action: 'category_changed',
              metadata: { from: article.category ?? null, to: categoryDoc.title },
            },
          ]),
        ),
    );
    return res.json({ action, categoryId: String(categoryDoc._id), affected: articles.length });
  }

  return res.status(400).json({ error: 'invalid_action' });
}

// DELETE /api/admin/articles/:id
export async function remove(req: Request, res: Response) {
  const article = await Article.findByIdAndDelete(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  // Drop the article's chunks from the RAG index (Phase 2 index hygiene).
  await purgeArticleChunks(String(article._id));
  await ArticleSummary.deleteOne({ articleId: article._id });
  // The timeline is per-article and there is no longer an article to show it
  // against, so the log goes with it rather than becoming an orphan.
  await purgeActivity('article', article._id as mongoose.Types.ObjectId);
  if (article.audioKey) {
    await deleteS3Object(article.audioKey).catch((err) => {
      console.warn('Failed to delete article audio from S3', err);
    });
  }
  res.status(204).send();
}

/**
 * GET /api/admin/articles/:id/activity
 *
 * Newest-first page of the article's activity timeline. Moderator-only, like
 * every other admin article route.
 */
export async function activity(req: Request, res: Response) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: 'invalid_article_id' });
  }
  const exists = await Article.exists({ _id: req.params.id });
  if (!exists) return res.status(404).json({ error: 'Article not found' });

  res.json(
    await listActivity('article', req.params.id, {
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || ACTIVITY_DEFAULT_LIMIT,
    }),
  );
}
