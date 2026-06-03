import type { Request, Response } from 'express';
import Short from '../models/Short';
import ShortView from '../models/ShortView';

// GET /api/shorts
// Returns only featured + published shorts for the homepage.
export async function listFeatured(req: Request, res: Response) {
  const shorts = await Short.find({ status: 'published', featured: true }).sort({ publishedAt: -1 });
  res.json({ shorts });
}

// GET /api/shorts/:slug
// Returns the requested short plus all published shorts for the player feed.
export async function getBySlug(req: Request, res: Response) {
  const currentShort = await Short.findOne({ slug: req.params.slug, status: 'published' });
  if (!currentShort) return res.status(404).json({ error: 'Short not found' });

  const shorts = await Short.find({ status: 'published' }).sort({ publishedAt: -1 });

  res.json({ currentShort, shorts });
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
