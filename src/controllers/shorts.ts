import type { Request, Response } from 'express';
import Short, { ShortDoc } from '../models/Short';
import Category, { CategoryDoc } from '../models/Category';
import ShortView from '../models/ShortView';

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

async function serializeShorts(shorts: ShortDoc[]): Promise<Record<string, unknown>[]> {
  const categoryIds = [
    ...new Set(shorts.map((short) => short.categoryId?.toString()).filter((id): id is string => Boolean(id))),
  ];
  const categories = await Category.find({ _id: { $in: categoryIds } });
  const categoryMap = new Map(categories.map((category) => [String(category._id), category]));
  return shorts.map((short) => {
    const obj = short.toObject() as Record<string, unknown>;
    applyCategory(obj, categoryMap.get(String(short.categoryId)), short.category);
    return obj;
  });
}

// GET /api/shorts
// Returns only featured + published shorts for the homepage.
export async function listFeatured(req: Request, res: Response) {
  const shorts = await Short.find({ status: 'published', featured: true }).sort({ publishedAt: -1 });
  res.json({ shorts: await serializeShorts(shorts) });
}

// GET /api/shorts/:slug
// Returns the requested short plus all published shorts for the player feed.
export async function getBySlug(req: Request, res: Response) {
  const currentShort = await Short.findOne({ slug: req.params.slug, status: 'published' });
  if (!currentShort) return res.status(404).json({ error: 'Short not found' });

  const shorts = await Short.find({ status: 'published' }).sort({ publishedAt: -1 });
  const serialized = await serializeShorts([currentShort, ...shorts]);

  res.json({ currentShort: serialized[0], shorts: serialized.slice(1) });
}

// POST /api/shorts/:id/view
export async function recordView(req: Request, res: Response) {
  const short = await Short.findById(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });

  const ip = req.ip;

  try {
    await ShortView.create({ shortId: short._id, ip });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return res.json({ views: short.views });
    }
    throw err;
  }

  const updated = await Short.findByIdAndUpdate(short._id, { $inc: { views: 1 } }, { new: true });

  res.json({ views: updated?.views });
}
