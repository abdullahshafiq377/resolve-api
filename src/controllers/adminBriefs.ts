import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment, { BriefStory } from '../models/BriefSegment';
import Category from '../models/Category';
import Region from '../models/Region';
import { clerk } from '../config/clerk';
import { enrichStories } from './brief';
import { sendApprovedSegmentEmails } from '../services/briefEmail';
import { processBriefGenerationBatch, regenerateSegment } from '../services/resolveBriefGeneration';
import { parseBriefDate } from '../services/briefDates';
import { httpError } from '../utils/errors';
import { parseOrder, parseSortKey, searchRegex } from '../utils/query';

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

// Columns the admin Brief table can be ordered by. `recipients` and `emails`
// are counts of BriefRecipient rows rather than fields on the segment, so they
// take the aggregation path below.
const BRIEF_SORT_KEYS = ['title', 'submitted', 'recipients', 'emails'] as const;
type BriefSortKey = (typeof BRIEF_SORT_KEYS)[number];
const COUNT_SORT_FIELDS: Partial<Record<BriefSortKey, string>> = {
  recipients: 'recipientCount',
  emails: 'emailSentCount',
};

// Case- and accent-insensitive ordering for the text columns.
const LIST_COLLATION = { locale: 'en', strength: 2 } as const;

/**
 * The ordered page of segment ids when sorting by a recipient count.
 *
 * The counts live in BriefRecipient, so ordering by them cannot be a `find`
 * sort. This resolves the order and the page in one aggregation and returns
 * only ids — the documents are then loaded and serialized by the usual path,
 * so the response shape is identical either way.
 */
async function pageIdsByCount(
  filter: Record<string, unknown>,
  field: string,
  order: 1 | -1,
  skip: number,
  limit: number,
): Promise<mongoose.Types.ObjectId[]> {
  const rows = await BriefSegment.aggregate<{ _id: mongoose.Types.ObjectId }>([
    { $match: filter },
    {
      $lookup: {
        from: BriefRecipient.collection.name,
        localField: '_id',
        foreignField: 'segmentId',
        pipeline: [{ $project: { emailStatus: 1 } }],
        as: 'recipients',
      },
    },
    {
      $addFields: {
        recipientCount: { $size: '$recipients' },
        emailSentCount: {
          $size: {
            $filter: { input: '$recipients', cond: { $eq: ['$$this.emailStatus', 'sent'] } },
          },
        },
      },
    },
    { $sort: { [field]: order, _id: order } },
    { $skip: skip },
    { $limit: limit },
    { $project: { _id: 1 } },
  ]);
  return rows.map((row) => row._id);
}

export async function list(req: Request, res: Response) {
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 20));
  const skip = (page - 1) * limit;
  const filter: Record<string, unknown> = { deletedAt: null };
  if (req.query.date) filter.briefDate = parseBriefDate(req.query.date);
  if (req.query.status) filter.status = req.query.status;

  // Search runs over the whole collection, not the page in hand. A segment's
  // title is optional, so the summary is matched too — that is what the table
  // falls back to displaying.
  const term = searchRegex(req.query.search);
  if (term) filter.$or = [{ title: term }, { summary: term }];

  const sortKey = parseSortKey(req.query.sort, BRIEF_SORT_KEYS, 'submitted');
  const order = parseOrder(req.query.order, sortKey === 'title' ? 1 : -1);
  const countField = COUNT_SORT_FIELDS[sortKey];

  const total = await BriefSegment.countDocuments(filter);
  let segments;
  if (countField) {
    const ids = await pageIdsByCount(filter, countField, order, skip, limit);
    const found = await BriefSegment.find({ _id: { $in: ids } });
    // `find` does not preserve the $in order, so restore the page's order.
    const byId = new Map(found.map((doc) => [String(doc._id), doc]));
    segments = ids.map((id) => byId.get(String(id))).filter((doc) => doc !== undefined);
  } else {
    segments = await BriefSegment.find(filter)
      .collation(LIST_COLLATION)
      .sort(
        sortKey === 'title'
          ? { title: order, _id: order }
          : { briefDate: order, createdAt: order, _id: order },
      )
      .skip(skip)
      .limit(limit);
  }
  const counts = await segmentCounts(segments.map((segment) => segment._id as mongoose.Types.ObjectId));
  const data = await Promise.all(
    segments.map(async (segment) => {
      const base = await serializeSegment(segment);
      return { ...base, ...(counts.get(String(segment._id)) ?? {}) };
    }),
  );
  res.json({ data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
}

/**
 * Recipient rows carry only a Clerk user id, but the admin table names the
 * reader. One batched Clerk lookup covers the page; a user Clerk no longer
 * knows about falls back to the bare id rather than dropping the row.
 */
async function hydrateRecipients(
  recipients: Awaited<ReturnType<typeof BriefRecipient.find>>,
) {
  const ids = [...new Set(recipients.map((recipient) => recipient.clerkUserId).filter(Boolean))];
  const byId = new Map<string, { displayName: string; email: string | null; imageUrl: string | null }>();
  if (ids.length) {
    try {
      const list = await clerk.users.getUserList({ userId: ids, limit: ids.length });
      for (const user of list.data) {
        const primary =
          user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)
            ?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
        byId.set(user.id, {
          displayName: name || user.username || primary || user.id,
          email: primary,
          imageUrl: user.imageUrl ?? null,
        });
      }
    } catch {
      // Clerk being unavailable must not take the whole segment down — the table
      // degrades to ids.
    }
  }
  return recipients.map((recipient) => {
    const profile = byId.get(recipient.clerkUserId);
    return {
      ...recipient.toObject(),
      displayName: profile?.displayName ?? recipient.clerkUserId,
      email: profile?.email ?? null,
      imageUrl: profile?.imageUrl ?? null,
    };
  });
}

export async function detail(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  const [serialized, sourceArticles, recipientRows, stories] = await Promise.all([
    serializeSegment(segment),
    Article.find({ _id: { $in: segment.sourceArticleIds } }).select('title slug excerpt publishDate categoryId regionIds'),
    BriefRecipient.find({ segmentId: segment._id }).sort({ emailStatus: 1, createdAt: -1 }).limit(100),
    // The admin view draws each story exactly as the reader sees it, so it needs
    // the same image / category / read-time enrichment the reader endpoints do.
    enrichStories(segment.stories),
  ]);
  const recipients = await hydrateRecipients(recipientRows);
  res.json({ segment: { ...serialized, stories }, sourceArticles, recipients });
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
