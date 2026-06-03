import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import Article, { ArticleDoc } from '../models/Article';
import { generateUniqueSlug } from '../utils/slugify';
import { createArticleUploadUrl } from '../config/s3';
import { httpError } from '../utils/errors';
import {
  findActiveUser,
  findUsersByIds,
  toAuthorSummary,
  type AuthorSummary,
} from '../services/users';

const MAX_LIMIT = 100;
const FEATURED_MAX = 5;
const HIGHLIGHT_MAX = 3;
const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

function validateReadTime(value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw httpError(400, 'readTimeMinutes must be a positive integer');
  }
  return value as number;
}

async function assertFeaturedLimit(excludeId: string | null = null): Promise<void> {
  const query: Record<string, unknown> = { featured: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= FEATURED_MAX) throw httpError(400, `Featured limit reached (max ${FEATURED_MAX})`);
}

async function assertHighlightLimit(excludeId: string | null = null): Promise<void> {
  const query: Record<string, unknown> = { highlight: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= HIGHLIGHT_MAX) throw httpError(400, `Highlight limit reached (max ${HIGHLIGHT_MAX})`);
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

// Replace authorId with a nested author object joined from the users mirror (§6a).
async function serializeArticle(doc: ArticleDoc): Promise<Record<string, unknown>> {
  const [user] = await findUsersByIds([doc.authorId]);
  const obj = doc.toObject() as Record<string, unknown>;
  delete obj.authorId;
  obj.author = user ? toAuthorSummary(user) : fallbackAuthor(doc.authorId);
  return obj;
}

async function serializeArticles(docs: ArticleDoc[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(docs.map((d) => d.authorId).filter(Boolean))];
  const users = await findUsersByIds(ids);
  const map = new Map(users.map((u) => [u.clerkUserId, u]));
  return docs.map((d) => {
    const obj = d.toObject() as Record<string, unknown>;
    delete obj.authorId;
    const u = map.get(d.authorId);
    obj.author = u ? toAuthorSummary(u) : fallbackAuthor(d.authorId);
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
    const { category, template, excludeId } = req.query as Record<string, string | undefined>;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit as string, 10) || 10));

    const filter: Record<string, unknown> = {};
    if (category) filter.category = category;
    if (forcePublished) {
      // Public listing always forces published; ignore any caller-supplied status.
      filter.status = 'published';
    } else if (req.query.status) {
      filter.status = req.query.status;
    }
    if (template) filter.template = template;
    if (req.query.featured === 'true') filter.featured = true;
    if (req.query.highlight === 'true') filter.highlight = true;
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

// POST /api/admin/articles
export async function create(req: Request, res: Response) {
  const {
    title, excerpt, author_id,
    category, featuredImage, featuredImageCaption, featuredImageKey,
    template, publishDate, status, body,
    featured, highlight, readTimeMinutes,
  } = req.body;

  const authorId = await assertValidAuthor(author_id);
  if (featured === true) await assertFeaturedLimit();
  if (highlight === true) await assertHighlightLimit();
  const readTime = validateReadTime(readTimeMinutes);

  const slug = await generateUniqueSlug(title, Article);

  const article = await Article.create({
    title, slug, excerpt, authorId, category,
    featuredImage, featuredImageCaption, featuredImageKey,
    template,
    publishDate: new Date(publishDate),
    status, body,
    featured, highlight,
    readTimeMinutes: readTime,
  });

  res.status(201).json(await serializeArticle(article));
}

// PUT /api/admin/articles/:id
export async function update(req: Request, res: Response) {
  const {
    title, excerpt, author_id,
    category, featuredImage, featuredImageCaption, featuredImageKey,
    template, publishDate, status, body,
    featured, highlight, readTimeMinutes,
  } = req.body;

  const current = await Article.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Article not found' });

  // Only check limits when toggling from false → true
  if (featured === true && !current.featured) await assertFeaturedLimit(req.params.id);
  if (highlight === true && !current.highlight) await assertHighlightLimit(req.params.id);
  if (readTimeMinutes !== undefined) validateReadTime(readTimeMinutes);

  const patch: Record<string, unknown> = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Article, req.params.id);
  }
  if (excerpt !== undefined) patch.excerpt = excerpt;
  if (author_id !== undefined) patch.authorId = await assertValidAuthor(author_id);
  if (category !== undefined) patch.category = category;
  if (featuredImage !== undefined) patch.featuredImage = featuredImage;
  if (featuredImageCaption !== undefined) patch.featuredImageCaption = featuredImageCaption;
  if (featuredImageKey !== undefined) patch.featuredImageKey = featuredImageKey;
  if (template !== undefined) patch.template = template;
  if (publishDate !== undefined) patch.publishDate = new Date(publishDate);
  if (status !== undefined) patch.status = status;
  if (body !== undefined) patch.body = body;
  if (featured !== undefined) patch.featured = featured;
  if (highlight !== undefined) patch.highlight = highlight;
  if (readTimeMinutes !== undefined) patch.readTimeMinutes = readTimeMinutes ?? null;

  const article = await Article.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });

  res.json(await serializeArticle(article!));
}

// DELETE /api/admin/articles/:id
export async function remove(req: Request, res: Response) {
  const article = await Article.findByIdAndDelete(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.status(204).send();
}
