import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment, { BriefSegmentDoc, BriefStory } from '../models/BriefSegment';
import Category from '../models/Category';
import Region from '../models/Region';
import { enrichStories } from './brief';
import { countQueuedRecipients, sendApprovedSegmentEmails } from '../services/briefEmail';
import { findUsersByIds } from '../services/users';
import { processBriefGenerationBatch, regenerateSegment } from '../services/resolveBriefGeneration';
import { parseBriefDate } from '../services/briefDates';
import { httpError } from '../utils/errors';
import { parseOrder, parseSortKey, searchRegex } from '../utils/query';

function adminUserId(req: Request): string {
  return getAuth(req).userId || 'admin';
}

interface SegmentCounts {
  recipientCount: number;
  emailSentCount: number;
  emailFailedCount: number;
  // What Resend reported after accepting the message (`F-041`). Counted
  // separately from `emailSentCount` rather than folded into it: "accepted" and
  // "landed" are different facts, and a segment showing 500 sent / 480 delivered
  // / 20 bounced is the whole point of recording them.
  emailDeliveredCount: number;
  emailBouncedCount: number;
  emailComplainedCount: number;
}

function emptyCounts(): SegmentCounts {
  return {
    recipientCount: 0,
    emailSentCount: 0,
    emailFailedCount: 0,
    emailDeliveredCount: 0,
    emailBouncedCount: 0,
    emailComplainedCount: 0,
  };
}

async function segmentCounts(segmentIds: mongoose.Types.ObjectId[]) {
  const rows = await BriefRecipient.aggregate([
    { $match: { segmentId: { $in: segmentIds } } },
    {
      $group: {
        _id: {
          segmentId: '$segmentId',
          emailStatus: '$emailStatus',
          emailDelivery: '$emailDelivery',
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const map = new Map<string, SegmentCounts>();
  for (const id of segmentIds) map.set(String(id), emptyCounts());
  for (const row of rows) {
    const key = String(row._id.segmentId);
    const current = map.get(key) ?? emptyCounts();
    current.recipientCount += row.count;
    if (row._id.emailStatus === 'sent') current.emailSentCount += row.count;
    if (row._id.emailStatus === 'failed') current.emailFailedCount += row.count;
    if (row._id.emailDelivery === 'delivered') current.emailDeliveredCount += row.count;
    if (row._id.emailDelivery === 'bounced') current.emailBouncedCount += row.count;
    if (row._id.emailDelivery === 'complained') current.emailComplainedCount += row.count;
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
    ...(counts.get(String(segment._id)) ?? emptyCounts()),
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
 * reader. Display name, email and avatar are all mirrored onto `User` by the
 * Clerk webhook, so this is one indexed Mongo query per page rather than a
 * `getUserList` round-trip (`F-039`) — the same join `loadCommentAuthors` does.
 *
 * Reading the mirror also settles a real inconsistency: this table used to render
 * live Clerk identity while comments rendered a frozen snapshot, which is the
 * mismatch that surfaced `F-116`. A recipient with no mirror row falls back to
 * the bare id rather than dropping the row.
 *
 * No try/catch any more: the old one existed so an unavailable Clerk could not
 * take the whole segment down, and every other query in this handler is already
 * Mongo — a failure here is not a partial-degradation case.
 */
async function hydrateRecipients(
  recipients: Awaited<ReturnType<typeof BriefRecipient.find>>,
) {
  const ids = [...new Set(recipients.map((recipient) => recipient.clerkUserId).filter(Boolean))];
  const users = await findUsersByIds(ids);
  const byId = new Map(users.map((user) => [user.clerkUserId, user]));
  return recipients.map((recipient) => {
    const profile = byId.get(recipient.clerkUserId);
    return {
      ...recipient.toObject(),
      displayName: profile?.displayName || profile?.email || recipient.clerkUserId,
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

/**
 * Why this segment cannot be approved, or null when it can.
 *
 * Shared by the single-segment route and the bulk one so the two can never drift:
 * a rule added here applies to both. The single route turns the reason into a 409;
 * the bulk route counts it as a skip, the way every other admin bulk action does.
 *
 * Never publish a brief with no synthesis — a failed generation (or a draft an
 * editor has not filled in) has no title/summary/stories, so the empty/failed
 * state must not reach readers; the editor regenerates or edits first.
 */
function approvalBlocker(segment: BriefSegmentDoc): string | null {
  if (segment.status !== 'draft') return 'segment_not_approvable';
  if (!segment.title?.trim() || !segment.summary?.trim() || segment.stories.length === 0) {
    return 'segment_generation_incomplete';
  }
  return null;
}

/**
 * Approves a checked segment and queues its emails. Assumes `approvalBlocker` passed.
 *
 * Approval deliberately sends nothing itself (`F-012`). It used to send one batch
 * inline — ten recipients by default — and nothing swept the rest, so a segment
 * with 200 readers mailed ten of them and stopped. Delivery now belongs entirely
 * to `POST /api/cron/brief-email-dispatch`, which drains the queue across runs.
 *
 * The recipient rows are already `pending` from generation, so "queue" here is a
 * count, not a write: what changes is that the segment is now `approved`, which
 * is what makes the dispatcher pick it up.
 */
async function applyApproval(segment: BriefSegmentDoc, adminId: string) {
  segment.status = 'approved';
  segment.approvedAt = new Date();
  segment.approvedBy = adminId;
  segment.rejectedAt = null;
  segment.rejectedBy = null;
  segment.rejectionReason = null;
  await segment.save();
  return { queued: await countQueuedRecipients(String(segment._id)) };
}

async function applyRejection(segment: BriefSegmentDoc, adminId: string, reason: string | null) {
  segment.status = 'rejected';
  segment.rejectedAt = new Date();
  segment.rejectedBy = adminId;
  segment.rejectionReason = reason;
  await segment.save();
}

export async function approve(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  const blocker = approvalBlocker(segment);
  if (blocker) throw httpError(409, blocker);
  const email = await applyApproval(segment, adminUserId(req));
  res.json({ segment: await serializeSegment(segment), email });
}

export async function reject(req: Request, res: Response) {
  const segment = await BriefSegment.findById(req.params.id);
  if (!segment) return res.status(404).json({ error: 'not_found' });
  if (segment.status !== 'draft') throw httpError(409, 'segment_not_rejectable');
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
  await applyRejection(segment, adminUserId(req), reason);
  res.json({ segment: await serializeSegment(segment) });
}

export async function regenerate(req: Request, res: Response) {
  // An approved segment has already been emailed; the service refuses to redo one
  // without this flag, which the admin dialog collects as an explicit tick (`F-013`).
  const segment = await regenerateSegment(req.params.id, adminUserId(req), {
    acknowledgeSent: req.body?.acknowledgeSent === true,
  });
  res.json({ segment: await serializeSegment(segment) });
}

const BULK_ACTIONS = ['approve', 'reject', 'regenerate', 'retry-email'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/**
 * The most segments one bulk call will act on.
 *
 * `regenerate` is the binding constraint: each segment is a multi-second Anthropic
 * call and they run in series, so the cap is what keeps the request inside a normal
 * proxy timeout — and what stops one click from spending an unbounded amount on
 * generation. The admin list pages at 10, so a whole page always fits.
 */
const BULK_MAX_IDS = 25;

/**
 * Approve / reject / regenerate / retry-delivery across a selection (`F-014`).
 *
 * Every action reuses the same per-segment code the single-segment routes use, so
 * the two can never disagree about what is allowed. Ineligible segments are
 * *skipped*, not failed — the same contract as the other admin bulk endpoints
 * (`controllers/regions.bulk`): a selection is a rough gesture, and failing the
 * whole batch because one row was already approved would make the feature useless.
 *
 * The response separates the three outcomes so the admin can say what happened:
 * `affected` acted, `skipped` were ineligible, `failed` threw (a model error, a
 * mail provider outage) and are named so they can be retried.
 */
export async function bulk(req: Request, res: Response) {
  const { ids, action } = req.body as { ids?: unknown; action?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > BULK_MAX_IDS) {
    return res.status(400).json({ error: `at most ${BULK_MAX_IDS} segments per bulk action` });
  }
  if (!BULK_ACTIONS.includes(action as BulkAction)) {
    return res.status(400).json({ error: 'invalid_action' });
  }

  const valid = (ids as unknown[]).filter(
    (id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id),
  );
  const segments = await BriefSegment.find({ _id: { $in: valid }, deletedAt: null });
  if (segments.length === 0) return res.status(404).json({ error: 'not_found' });

  const adminId = adminUserId(req);
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : null;
  // Carried through to `regenerateSegment`, which refuses an already-emailed
  // segment without it (`F-013`). The admin collects one tick for the selection.
  const acknowledgeSent = req.body.acknowledgeSent === true;

  let affected = 0;
  // Ids the caller sent that matched no live segment count as skipped, not lost.
  let skipped = (ids as unknown[]).length - segments.length;
  const failed: { id: string; error: string }[] = [];
  // Aggregate mail outcome, so an approve/retry batch can report what happened to
  // the mail rather than only how many segments it touched. `queued` is what an
  // approve batch reports now that delivery belongs to the cron (`F-012`); the
  // send counts are the retry path's.
  const email = { sent: 0, failed: 0, skipped: 0, queued: 0 };

  // Serial on purpose. `regenerate` is a model call per segment and `retry-email`
  // sends mail per segment; running the selection concurrently would multiply
  // both against provider rate limits for no benefit an editor can perceive.
  for (const segment of segments) {
    const id = String(segment._id);
    try {
      if (action === 'approve') {
        if (approvalBlocker(segment)) {
          skipped += 1;
          continue;
        }
        const result = await applyApproval(segment, adminId);
        email.queued += result.queued;
      } else if (action === 'reject') {
        if (segment.status !== 'draft') {
          skipped += 1;
          continue;
        }
        await applyRejection(segment, adminId, reason);
      } else if (action === 'regenerate') {
        // An approved segment needs the acknowledgement; without it the service
        // raises 409 and the segment is reported as skipped rather than failed.
        if (segment.status === 'approved' && !acknowledgeSent) {
          skipped += 1;
          continue;
        }
        await regenerateSegment(id, adminId, { acknowledgeSent });
      } else {
        // Only an approved segment has mail to retry; `sendApprovedSegmentEmails`
        // returns zeros for anything else, which would read as a no-op success.
        if (segment.status !== 'approved') {
          skipped += 1;
          continue;
        }
        const result = await sendApprovedSegmentEmails(id);
        email.sent += result.sent;
        email.failed += result.failed;
        email.skipped += result.skipped;
      }
      affected += 1;
    } catch (err) {
      failed.push({ id, error: err instanceof Error ? err.message : 'action_failed' });
    }
  }

  res.json({ action, affected, skipped, failed, email });
}

export async function retryEmail(req: Request, res: Response) {
  const email = await sendApprovedSegmentEmails(req.params.id, req.body.recipientId);
  res.json({ email });
}
