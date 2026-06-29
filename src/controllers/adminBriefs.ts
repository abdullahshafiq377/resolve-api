import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment, { BriefStory } from '../models/BriefSegment';
import Category from '../models/Category';
import Region from '../models/Region';
import { sendApprovedSegmentEmails } from '../services/briefEmail';
import { processBriefGenerationBatch, regenerateSegment } from '../services/resolveBriefGeneration';
import { parseBriefDate } from '../services/briefDates';
import { httpError } from '../utils/errors';

function adminUserId(req: Request): string {
  return getAuth(req).userId || 'admin';
}

async function segmentCounts(segmentIds: mongoose.Types.ObjectId[]) {
  const rows = await BriefRecipient.aggregate([
    { $match: { segmentId: { $in: segmentIds } } },
    {
      $group: {
        _id: { segmentId: '$segmentId', emailStatus: '$emailStatus' },
        count: { $sum: 1 },
      },
    },
  ]);
  const map = new Map<string, { recipientCount: number; emailSentCount: number; emailFailedCount: number }>();
  for (const id of segmentIds) map.set(String(id), { recipientCount: 0, emailSentCount: 0, emailFailedCount: 0 });
  for (const row of rows) {
    const key = String(row._id.segmentId);
    const current = map.get(key) ?? { recipientCount: 0, emailSentCount: 0, emailFailedCount: 0 };
    current.recipientCount += row.count;
    if (row._id.emailStatus === 'sent') current.emailSentCount += row.count;
    if (row._id.emailStatus === 'failed') current.emailFailedCount += row.count;
    map.set(key, current);
  }
  return map;
}

async function serializeSegment(segment: Awaited<ReturnType<typeof BriefSegment.findOne>>) {
  if (!segment) return null;
  const [categories, regions] = await Promise.all([
    Category.find({ _id: { $in: segment.categoryIds } }).select('title slug'),
    Region.find({ _id: { $in: segment.regionIds } }).select('title slug'),
  ]);
  const counts = await segmentCounts([segment._id as mongoose.Types.ObjectId]);
  return {
    ...segment.toObject(),
    id: String(segment._id),
    categories,
    regions,
    ...(counts.get(String(segment._id)) ?? { recipientCount: 0, emailSentCount: 0, emailFailedCount: 0 }),
  };
}

export async function list(req: Request, res: Response) {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const filter: Record<string, unknown> = { deletedAt: null };
  if (req.query.date) filter.briefDate = parseBriefDate(req.query.date);
  if (req.query.status) filter.status = req.query.status;

  const [segments, total] = await Promise.all([
    BriefSegment.find(filter).sort({ briefDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    BriefSegment.countDocuments(filter),
  ]);
  const counts = await segmentCounts(segments.map((segment) => segment._id as mongoose.Types.ObjectId));
  const data = await Promise.all(
    segments.map(async (segment) => {
      const base = await serializeSegment(segment);
      return { ...base, ...(counts.get(String(segment._id)) ?? {}) };
    }),
  );
  res.json({ data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
}

export async function detail(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  const [serialized, sourceArticles, recipients] = await Promise.all([
    serializeSegment(segment),
    Article.find({ _id: { $in: segment.sourceArticleIds } }).select('title slug excerpt publishDate categoryId regionIds'),
    BriefRecipient.find({ segmentId: segment._id }).sort({ emailStatus: 1, createdAt: -1 }).limit(100),
  ]);
  res.json({ segment: serialized, sourceArticles, recipients });
}

function normalizeStories(value: unknown): BriefStory[] {
  if (!Array.isArray(value)) throw httpError(400, 'invalid_stories');
  return value.map((story, index) => {
    const item = story as Record<string, unknown>;
    if (typeof item.articleId !== 'string' || !mongoose.Types.ObjectId.isValid(item.articleId)) {
      throw httpError(400, 'invalid_story_article');
    }
    if (typeof item.headline !== 'string' || !item.headline.trim()) throw httpError(400, 'invalid_story_headline');
    if (typeof item.url !== 'string' || !item.url.trim()) throw httpError(400, 'invalid_story_url');
    return {
      articleId: new mongoose.Types.ObjectId(item.articleId),
      headline: item.headline.trim(),
      url: item.url.trim(),
      order: index + 1,
    };
  });
}

export async function update(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  if (segment.status !== 'draft') throw httpError(409, 'segment_not_editable');
  // Editing toward a publishable draft: title/summary may be cleared mid-edit
  // (stored as null); the non-empty requirement is enforced at approval, not here.
  if (req.body.title !== undefined) {
    segment.title = typeof req.body.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : null;
  }
  if (req.body.summary !== undefined) {
    segment.summary = typeof req.body.summary === 'string' && req.body.summary.trim()
      ? req.body.summary.trim()
      : null;
  }
  if (req.body.stories !== undefined) segment.stories = normalizeStories(req.body.stories);
  if (req.body.editorialNote !== undefined) {
    segment.editorialNote = typeof req.body.editorialNote === 'string' && req.body.editorialNote.trim()
      ? req.body.editorialNote.trim()
      : null;
  }
  if (req.body.editorialNoteAuthor !== undefined) {
    segment.editorialNoteAuthor = typeof req.body.editorialNoteAuthor === 'string' && req.body.editorialNoteAuthor.trim()
      ? req.body.editorialNoteAuthor.trim()
      : null;
  }
  segment.generationStatus = 'manual';
  await segment.save();
  res.json({ segment: await serializeSegment(segment) });
}

export async function generate(req: Request, res: Response) {
  const result = await processBriefGenerationBatch({
    briefDate: req.body.date ? parseBriefDate(req.body.date) : undefined,
    batchSize: req.body.batchSize,
  });
  res.json(result);
}

export async function approve(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  if (segment.status !== 'draft') throw httpError(409, 'segment_not_approvable');
  // Never publish a brief with no synthesis. A failed generation (or a draft an
  // editor has not filled in) has no title/summary/stories — block approval so the
  // empty/failed state can't reach readers; the editor must regenerate or edit first.
  if (!segment.title?.trim() || !segment.summary?.trim() || segment.stories.length === 0) {
    throw httpError(409, 'segment_generation_incomplete');
  }
  segment.status = 'approved';
  segment.approvedAt = new Date();
  segment.approvedBy = adminUserId(req);
  segment.rejectedAt = null;
  segment.rejectedBy = null;
  segment.rejectionReason = null;
  await segment.save();
  const email = await sendApprovedSegmentEmails(String(segment._id));
  res.json({ segment: await serializeSegment(segment), email });
}

export async function reject(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  if (segment.status !== 'draft') throw httpError(409, 'segment_not_rejectable');
  segment.status = 'rejected';
  segment.rejectedAt = new Date();
  segment.rejectedBy = adminUserId(req);
  segment.rejectionReason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
  await segment.save();
  res.json({ segment: await serializeSegment(segment) });
}

export async function regenerate(req: Request, res: Response) {
  const segment = await regenerateSegment(req.params.id, adminUserId(req));
  res.json({ segment: await serializeSegment(segment) });
}

export async function retryEmail(req: Request, res: Response) {
  const email = await sendApprovedSegmentEmails(req.params.id, req.body.recipientId);
  res.json({ email });
}
