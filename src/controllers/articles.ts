import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import Article, { ArticleDoc } from '../models/Article';
import ArticleSummary from '../models/ArticleSummary';
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
import { findCategoryByIdOrThrow, findCategoryBySlug } from '../services/categories';
import { findActiveRegionIdsOrThrow, getGlobalRegion, serializeRegion } from '../services/regions';

const MAX_LIMIT = 100;
const FEATURED_MAX = 5;
const HIGHLIGHT_MAX = 3;
const TOP_STORIES_MAX = 3;
const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

function validateReadTime(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw httpError(400, 'readTimeMinutes must be a positive integer');
  }
  return value as number;
}

function normalizeStatus(value: unknown, fallback: ArticleDoc['status'] = 'draft'): ArticleDoc['status'] {
  if (value === undefined) return fallback;
  if (value === 'draft' || value === 'published') return value;
  throw httpError(400, 'invalid_status');
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
async function serializeArticle(doc: ArticleDoc): Promise<Record<string, unknown>> {
  const [users, category, regions, aiSummary] = await Promise.all([
    findUsersByIds([doc.authorId]),
    doc.categoryId ? Category.findById(doc.categoryId) : Promise.resolve(null),
    Region.find({ _id: { $in: doc.regionIds ?? [] } }).sort({ order: 1, title: 1 }),
    ArticleSummary.findOne({ articleId: doc._id, approved: true }).select('format content'),
  ]);
  const obj = doc.toObject() as Record<string, unknown>;
  delete obj.authorId;
  const user = users[0];
  obj.author = user ? toAuthorSummary(user) : fallbackAuthor(doc.authorId);
  applyCategory(obj, category, doc.category);
  obj.regions = regions.map(serializeRegion);
  obj.regionIds = regions.map((region) => String(region._id));
  if (aiSummary) {
    obj.aiSummary = {
      format: aiSummary.format,
      content: aiSummary.content,
    };
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
    Region.find({ _id: { $in: regionIds } }).sort({ order: 1, title: 1 }),
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
  res.json(result);
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
    if (req.query.featured === 'true') filter.featured = true;
    if (req.query.highlight === 'true') filter.highlight = true;
    if (req.query.topStories === 'true') filter.topStories = true;
    if (excludeId && mongoose.isValidObjectId(excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
    }

    const skip = (page - 1) * limit;

    const [articles, total] = await Promise.all([
      Article.find(filter).sort({ publishDate: -1 }).skip(skip).limit(limit).select('-body'),
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
export async function getPublishedBySlug(req: Request, res: Response) {
  const article = await Article.findOne({ slug: req.params.slug, status: 'published' });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(await serializeArticle(article));
}

// GET /api/admin/articles/slug/:slug (admin — any status)
export async function getAdminBySlug(req: Request, res: Response) {
  const article = await Article.findOne({ slug: req.params.slug });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(await serializeArticle(article));
}

// POST /api/admin/articles
export async function create(req: Request, res: Response) {
  const {
    title, excerpt, author_id,
    categoryId, regionIds, featuredImage, featuredImageCaption, featuredImageKey,
    audioUrl, audioKey,
    template, status, body,
    featured, highlight, topStories, readTimeMinutes,
  } = req.body;

  const authorId = await assertValidAuthor(author_id);
  const categoryDoc = await findCategoryByIdOrThrow(categoryId);
  const selectedRegionIds = Array.isArray(regionIds) && regionIds.length > 0
    ? await findActiveRegionIdsOrThrow(regionIds)
    : [(await getGlobalRegion())._id];
  const nextStatus = normalizeStatus(status);
  const nextFeatured = nextStatus === 'published' && featured === true;
  const nextHighlight = nextStatus === 'published' && highlight === true;
  const nextTopStories = nextStatus === 'published' && topStories === true;
  if (nextFeatured) await assertFeaturedLimit();
  if (nextHighlight) await assertHighlightLimit();
  if (nextTopStories) await assertTopStoriesLimit();
  const readTime = validateReadTime(readTimeMinutes);

  const slug = await generateUniqueSlug(title, Article);

  const article = await Article.create({
    title, slug, excerpt, authorId, categoryId: categoryDoc._id, category: categoryDoc.title,
    regionIds: selectedRegionIds,
    featuredImage, featuredImageCaption, featuredImageKey,
    audioUrl: audioUrl || undefined, audioKey: audioKey || undefined,
    template,
    // Publish date is system-managed: stamped when published, absent for drafts.
    publishDate: nextStatus === 'published' ? new Date() : undefined,
    status: nextStatus, body,
    featured: nextFeatured, highlight: nextHighlight, topStories: nextTopStories,
    readTimeMinutes: readTime,
  });

  // Keep the RAG index in sync (Phase 2): only published articles get chunks.
  // Awaited (not fire-and-forget) so it runs reliably on serverless; the call
  // never throws and the bodyHash skip makes unchanged re-saves cheap.
  if (article.status === 'published') await syncArticleEmbeddings(article);

  res.status(201).json(await serializeArticle(article));
}

// PUT /api/admin/articles/:id
export async function update(req: Request, res: Response) {
  const {
    title, excerpt, author_id,
    categoryId, regionIds, featuredImage, featuredImageCaption, featuredImageKey,
    audioUrl, audioKey,
    template, status, body,
    featured, highlight, topStories, readTimeMinutes,
  } = req.body;

  const current = await Article.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Article not found' });

  const nextStatus = normalizeStatus(status, current.status);
  const wasPublished = current.status === 'published';
  const currentFeatured = current.status === 'published' ? current.featured : false;
  const currentHighlight = current.status === 'published' ? current.highlight : false;
  const nextFeatured =
    nextStatus === 'published' ? (featured !== undefined ? featured === true : currentFeatured) : false;
  const nextHighlight =
    nextStatus === 'published' ? (highlight !== undefined ? highlight === true : currentHighlight) : false;
  const currentTopStories = current.status === 'published' ? current.topStories : false;
  const nextTopStories =
    nextStatus === 'published' ? (topStories !== undefined ? topStories === true : currentTopStories) : false;
  const shouldClearDraftFeatured = nextStatus === 'draft' && current.featured;
  const shouldClearDraftHighlight = nextStatus === 'draft' && current.highlight;
  const shouldClearDraftTopStories = nextStatus === 'draft' && current.topStories;
  const isRemovingAudio =
    audioUrl === null || audioUrl === '' || audioKey === null || audioKey === '';
  const shouldDeleteOldAudio =
    !!current.audioKey &&
    (isRemovingAudio || (typeof audioKey === 'string' && audioKey !== current.audioKey));

  // Only published articles can be featured/highlighted; limits count published
  // placements only.
  if (nextFeatured && !currentFeatured) await assertFeaturedLimit(req.params.id);
  if (nextHighlight && !currentHighlight) await assertHighlightLimit(req.params.id);
  if (nextTopStories && !currentTopStories) await assertTopStoriesLimit(req.params.id);
  if (readTimeMinutes !== undefined) validateReadTime(readTimeMinutes);

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
  }
  if (regionIds !== undefined) {
    patch.regionIds = Array.isArray(regionIds) && regionIds.length > 0
      ? await findActiveRegionIdsOrThrow(regionIds)
      : [(await getGlobalRegion())._id];
  }
  if (featuredImage !== undefined) patch.featuredImage = featuredImage;
  if (featuredImageCaption !== undefined) patch.featuredImageCaption = featuredImageCaption;
  if (featuredImageKey !== undefined) patch.featuredImageKey = featuredImageKey;
  if (audioUrl !== undefined || isRemovingAudio) {
    if (audioUrl === null || audioUrl === '' || isRemovingAudio) unset.audioUrl = 1;
    else patch.audioUrl = audioUrl;
  }
  if (audioKey !== undefined || isRemovingAudio) {
    if (audioKey === null || audioKey === '' || isRemovingAudio) unset.audioKey = 1;
    else patch.audioKey = audioKey;
  }
  if (template !== undefined) patch.template = template;
  // Publish date is system-managed by status: stamped the moment a draft goes
  // live, and cleared whenever the article is a draft (even if it was published
  // before). A published article that stays published keeps its original date.
  if (nextStatus === 'draft') {
    if (current.publishDate) unset.publishDate = 1;
  } else if (!wasPublished) {
    patch.publishDate = new Date();
  }
  if (status !== undefined) patch.status = nextStatus;
  if (body !== undefined) patch.body = body;
  if (featured !== undefined || status !== undefined || shouldClearDraftFeatured) patch.featured = nextFeatured;
  if (highlight !== undefined || status !== undefined || shouldClearDraftHighlight) patch.highlight = nextHighlight;
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

  res.json(await serializeArticle(article!));
}

// DELETE /api/admin/articles/:id
export async function remove(req: Request, res: Response) {
  const article = await Article.findByIdAndDelete(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  // Drop the article's chunks from the RAG index (Phase 2 index hygiene).
  await purgeArticleChunks(String(article._id));
  await ArticleSummary.deleteOne({ articleId: article._id });
  if (article.audioKey) {
    await deleteS3Object(article.audioKey).catch((err) => {
      console.warn('Failed to delete article audio from S3', err);
    });
  }
  res.status(204).send();
}
