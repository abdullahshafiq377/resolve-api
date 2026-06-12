import type { Request, Response } from 'express';
import Short, { ShortDoc } from '../../models/Short';
import Category, { CategoryDoc } from '../../models/Category';
import { generateUniqueSlug } from '../../utils/slugify';
import { createUploadUrl } from '../../config/s3';
import { findCategoryByIdOrThrow, findCategoryBySlug } from '../../services/categories';

const MAX_LIMIT = 100;

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

async function serializeShort(short: ShortDoc | null) {
  if (!short) return null;
  const category = short.categoryId ? await Category.findById(short.categoryId) : null;
  const obj = short.toObject() as Record<string, unknown>;
  applyCategory(obj, category, short.category);
  return obj;
}

async function serializeShorts(shorts: ShortDoc[]): Promise<Record<string, unknown>[]> {
  const categoryIds = [
    ...new Set(shorts.map((s) => s.categoryId?.toString()).filter((id): id is string => Boolean(id))),
  ];
  const categories = await Category.find({ _id: { $in: categoryIds } });
  const categoryMap = new Map(categories.map((category) => [String(category._id), category]));
  return shorts.map((short) => {
    const obj = short.toObject() as Record<string, unknown>;
    applyCategory(obj, categoryMap.get(String(short.categoryId)), short.category);
    return obj;
  });
}

// POST /api/admin/shorts/upload-url
export async function uploadUrl(req: Request, res: Response) {
  const { filename, contentType, fileSize, type } = req.body;

  if (!filename || !contentType || fileSize == null) {
    return res.status(400).json({ error: 'filename, contentType, and fileSize are required' });
  }

  const result = await createUploadUrl({ filename, contentType, fileSize, type });
  res.json(result);
}

// GET /api/admin/shorts
export async function list(req: Request, res: Response) {
  const { status, categoryId, categorySlug } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (categoryId) filter.categoryId = categoryId;
  else if (categorySlug) {
    const category = await findCategoryBySlug(categorySlug);
    if (!category) {
      res.json({ data: [], pagination: { total: 0, page, limit, pages: 0 } });
      return;
    }
    filter.categoryId = category._id;
  }

  const skip = (page - 1) * limit;

  const [shorts, total] = await Promise.all([
    Short.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Short.countDocuments(filter),
  ]);

  res.json({
    data: await serializeShorts(shorts),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// POST /api/admin/shorts
export async function create(req: Request, res: Response) {
  const {
    title, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds,
    categoryId, tags,
    featured, status,
  } = req.body;

  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!videoUrl || !videoKey) return res.status(400).json({ error: 'videoUrl and videoKey are required' });
  const categoryDoc = await findCategoryByIdOrThrow(categoryId);

  const slug = await generateUniqueSlug(title, Short);

  const doc: Record<string, unknown> = {
    title, slug, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds, categoryId: categoryDoc._id, category: categoryDoc.title, tags,
    featured, status,
  };

  if (status === 'published') doc.publishedAt = new Date();

  const short = await Short.create(doc);
  res.status(201).json(await serializeShort(short));
}

// GET /api/admin/shorts/:id
export async function getById(req: Request, res: Response) {
  const short = await Short.findById(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.json(await serializeShort(short));
}

// PATCH /api/admin/shorts/:id
export async function update(req: Request, res: Response) {
  const {
    title, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds,
    categoryId, tags,
    featured, status,
  } = req.body;

  const current = await Short.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Short not found' });

  const patch: Record<string, unknown> = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Short, req.params.id);
  }
  if (description !== undefined) patch.description = description;
  if (videoUrl !== undefined) patch.videoUrl = videoUrl;
  if (videoKey !== undefined) patch.videoKey = videoKey;
  if (thumbnailUrl !== undefined) patch.thumbnailUrl = thumbnailUrl;
  if (thumbnailKey !== undefined) patch.thumbnailKey = thumbnailKey;
  if (durationSeconds !== undefined) patch.durationSeconds = durationSeconds;
  if (categoryId !== undefined) {
    const categoryDoc = await findCategoryByIdOrThrow(categoryId);
    patch.categoryId = categoryDoc._id;
    patch.category = categoryDoc.title;
  }
  if (tags !== undefined) patch.tags = tags;
  if (featured !== undefined) patch.featured = featured;
  if (status !== undefined) {
    patch.status = status;
    if (status === 'published' && !current.publishedAt) {
      patch.publishedAt = new Date();
    }
  }

  const short = await Short.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });

  res.json(await serializeShort(short));
}

// DELETE /api/admin/shorts/:id  — soft archive
export async function archive(req: Request, res: Response) {
  const short = await Short.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.json(await serializeShort(short));
}

// DELETE /api/admin/shorts/:id/permanent  — hard delete
export async function permanentRemove(req: Request, res: Response) {
  const short = await Short.findByIdAndDelete(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.status(204).send();
}
