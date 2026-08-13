import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Short, { ShortDoc } from '../../models/Short';
import { findAssetMeta, recordUploadedAsset } from '../../models/UploadedAsset';
import Category, { CategoryDoc } from '../../models/Category';
import { generateUniqueSlug } from '../../utils/slugify';
import { createUploadUrl } from '../../config/s3';
import { findCategoryByIdOrThrow, findCategoryBySlug } from '../../services/categories';
import { parseOrder, parseSortKey, searchRegex, stableSort } from '../../utils/query';

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

  // The key is a UUID, so this is the only moment the real name and size are
  // known. Recorded here and read back when the media is attached.
  await recordUploadedAsset({
    fileKey: result.fileKey,
    originalName: filename,
    size: fileSize,
    contentType,
    surface: 'short',
    kind: type ?? 'video',
    uploadedBy: getAuth(req).userId ?? undefined,
  });

  res.json(result);
}

// GET /api/admin/shorts
// Columns the admin shorts table can be ordered by.
const SHORT_SORT_KEYS = ['title', 'views', 'createdAt', 'publishedAt'] as const;
const SHORT_SORT_FIELDS: Record<(typeof SHORT_SORT_KEYS)[number], string> = {
  title: 'title',
  views: 'views',
  createdAt: 'createdAt',
  publishedAt: 'publishedAt',
};

// Case- and accent-insensitive ordering for the text columns.
const LIST_COLLATION = { locale: 'en', strength: 2 } as const;

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

  // Search and sort run over the whole collection, not the page in hand.
  const term = searchRegex(req.query.search);
  if (term) filter.$or = [{ title: term }, { description: term }];

  const sortKey = parseSortKey(req.query.sort, SHORT_SORT_KEYS, 'createdAt');
  const order = parseOrder(req.query.order, sortKey === 'title' ? 1 : -1);

  const skip = (page - 1) * limit;

  const [shorts, total] = await Promise.all([
    Short.find(filter)
      .collation(LIST_COLLATION)
      .sort(stableSort(SHORT_SORT_FIELDS[sortKey], order))
      .skip(skip)
      .limit(limit),
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

  // Name and size come from the upload record, never from the request body, so
  // the label cannot disagree with what was actually uploaded.
  const videoMeta = videoKey ? await findAssetMeta(videoKey) : null;
  const thumbnailMeta = thumbnailKey ? await findAssetMeta(thumbnailKey) : null;

  const doc: Record<string, unknown> = {
    title, slug, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    videoName: videoMeta?.originalName,
    videoSize: videoMeta?.size,
    thumbnailName: thumbnailMeta?.originalName,
    thumbnailSize: thumbnailMeta?.size,
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
  const unset: Record<string, 1> = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Short, req.params.id);
  }
  if (description !== undefined) patch.description = description;
  if (videoUrl !== undefined) patch.videoUrl = videoUrl;
  // Name and size track their key and come from the upload record. An upload
  // predating that collection resolves to null, so the stale label is cleared
  // rather than left describing the previous file.
  if (videoKey !== undefined) {
    patch.videoKey = videoKey;
    const meta = await findAssetMeta(videoKey);
    if (meta) {
      patch.videoName = meta.originalName;
      patch.videoSize = meta.size;
    } else {
      // `$set: undefined` is dropped by Mongoose, so an unknown upload has to
      // unset explicitly or the previous file's label would survive.
      unset.videoName = 1;
      unset.videoSize = 1;
    }
  }
  if (thumbnailUrl !== undefined) patch.thumbnailUrl = thumbnailUrl;
  if (thumbnailKey !== undefined) {
    patch.thumbnailKey = thumbnailKey;
    const meta = await findAssetMeta(thumbnailKey);
    if (meta) {
      patch.thumbnailName = meta.originalName;
      patch.thumbnailSize = meta.size;
    } else {
      unset.thumbnailName = 1;
      unset.thumbnailSize = 1;
    }
  }
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

  const short = await Short.findByIdAndUpdate(
    req.params.id,
    {
      ...(Object.keys(patch).length > 0 ? { $set: patch } : {}),
      ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
    },
    { new: true, runValidators: true },
  );

  res.json(await serializeShort(short));
}

// POST /api/admin/shorts/bulk — batch status change.
//
// Shorts have no transition rules: any of draft / published / archived can follow
// any other, exactly as the single PATCH allows. Publishing stamps `publishedAt`
// the first time a short goes live and never restamps it.
export async function bulkShorts(req: Request, res: Response) {
  const { ids, action, status } = req.body as {
    ids?: unknown;
    action?: unknown;
    status?: unknown;
  };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (action !== 'status') return res.status(400).json({ error: 'invalid_action' });
  if (status !== 'draft' && status !== 'published' && status !== 'archived') {
    return res.status(400).json({
      error: 'validation_error',
      details: [{ field: 'status', message: 'Invalid status.' }],
    });
  }

  const shorts = await Short.find({ _id: { $in: ids } });
  if (shorts.length === 0) return res.status(404).json({ error: 'Short not found' });

  const ownIds = shorts.map((short) => short._id);
  await Short.updateMany({ _id: { $in: ownIds } }, { $set: { status } });

  if (status === 'published') {
    // Only the shorts that have never been published get a publish date.
    const firstPublish = shorts.filter((short) => !short.publishedAt).map((short) => short._id);
    if (firstPublish.length) {
      await Short.updateMany({ _id: { $in: firstPublish } }, { $set: { publishedAt: new Date() } });
    }
  }

  res.json({ action, status, affected: shorts.length });
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
