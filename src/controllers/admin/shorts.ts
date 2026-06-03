import type { Request, Response } from 'express';
import Short from '../../models/Short';
import { generateUniqueSlug } from '../../utils/slugify';
import { createUploadUrl } from '../../config/s3';

const MAX_LIMIT = 100;

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
  const { status } = req.query as Record<string, string | undefined>;
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit as string, 10) || 20));

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;

  const skip = (page - 1) * limit;

  const [shorts, total] = await Promise.all([
    Short.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Short.countDocuments(filter),
  ]);

  res.json({
    data: shorts,
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
    category, tags,
    featured, status,
  } = req.body;

  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!videoUrl || !videoKey) return res.status(400).json({ error: 'videoUrl and videoKey are required' });

  const slug = await generateUniqueSlug(title, Short);

  const doc: Record<string, unknown> = {
    title, slug, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds, category, tags,
    featured, status,
  };

  if (status === 'published') doc.publishedAt = new Date();

  const short = await Short.create(doc);
  res.status(201).json(short);
}

// GET /api/admin/shorts/:id
export async function getById(req: Request, res: Response) {
  const short = await Short.findById(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.json(short);
}

// PATCH /api/admin/shorts/:id
export async function update(req: Request, res: Response) {
  const {
    title, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds,
    category, tags,
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
  if (category !== undefined) patch.category = category;
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

  res.json(short);
}

// DELETE /api/admin/shorts/:id  — soft archive
export async function archive(req: Request, res: Response) {
  const short = await Short.findByIdAndUpdate(req.params.id, { status: 'archived' }, { new: true });
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.json(short);
}

// DELETE /api/admin/shorts/:id/permanent  — hard delete
export async function permanentRemove(req: Request, res: Response) {
  const short = await Short.findByIdAndDelete(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.status(204).send();
}
