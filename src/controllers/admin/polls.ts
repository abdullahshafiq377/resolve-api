import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Poll, {
  POLL_DESCRIPTION_MAX,
  POLL_FEATURED_MAX,
  POLL_OPTION_MAX,
  POLL_OPTION_MIN,
  POLL_OPTION_TEXT_MAX,
  POLL_QUESTION_MAX,
  POLL_QUESTION_MIN,
  type PollDoc,
} from '../../models/Poll';
import PollVote from '../../models/PollVote';
import Article from '../../models/Article';
import Category from '../../models/Category';
import { generateUniquePollSlug } from '../../services/publicPulse/slug';
import { bodyContainsPublicPulse } from '../../services/publicPulse/body';
import { parseOrder, parseSortKey, searchRegex, stableSort } from '../../utils/query';
import { serializeAdminPoll, serializeResults } from '../../services/publicPulse/serializers';
import {
  ACTIVITY_DEFAULT_LIMIT,
  listActivity,
  purgeActivity,
  recordActivities,
  recordActivity,
} from '../../services/activity';
import {
  buildPollUpdateActivity,
  diffPollStatus,
  snapshotPoll,
  toPollActivity,
} from '../../services/pollActivity';

const MAX_LIMIT = 100;

function parsePagination(query: Request['query'], defaultLimit = 20) {
  const page = Math.max(1, parseInt(query.page as string, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit as string, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function pagination(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDefinition(body: Record<string, unknown>, existing?: PollDoc) {
  const details: { field: string; message: string }[] = [];
  const question = typeof body.question === 'string' ? body.question.trim() : existing?.question ?? '';
  const description = typeof body.description === 'string' ? body.description.trim() : existing?.description ?? '';
  const closeDate = body.closeDate !== undefined ? parseDate(body.closeDate) : existing?.closeDate ?? null;

  if (question.length < POLL_QUESTION_MIN || question.length > POLL_QUESTION_MAX) {
    details.push({ field: 'question', message: `Question must be ${POLL_QUESTION_MIN}-${POLL_QUESTION_MAX} characters.` });
  }
  if (description.length > POLL_DESCRIPTION_MAX) {
    details.push({ field: 'description', message: `Description must be ${POLL_DESCRIPTION_MAX} characters or fewer.` });
  }
  if (!closeDate) details.push({ field: 'closeDate', message: 'Close date is required.' });

  let options: string[] | undefined;
  if (Array.isArray(body.options)) {
    options = body.options.map((value) => (typeof value === 'string' ? value.trim() : ''));
    if (options.length < POLL_OPTION_MIN || options.length > POLL_OPTION_MAX) {
      details.push({ field: 'options', message: `Polls need ${POLL_OPTION_MIN}-${POLL_OPTION_MAX} options.` });
    }
    options.forEach((option, index) => {
      if (!option || option.length > POLL_OPTION_TEXT_MAX) {
        details.push({ field: `options.${index}`, message: `Options must be 1-${POLL_OPTION_TEXT_MAX} characters.` });
      }
    });
    const normalized = options.map((option) => option.toLowerCase().replace(/\s+/g, ' '));
    if (new Set(normalized).size !== normalized.length) {
      details.push({ field: 'options', message: 'Options must be unique.' });
    }
  }

  if (details.length) return { details };
  return { question, description, closeDate: closeDate!, options };
}

// Resolves a category by id, mirroring the Article create/update flow. Responds
// with 400 invalid_category and returns null when the id is missing or unknown,
// so callers can `if (!cat) return;` in the same style as loadOr404.
async function resolveCategoryOr400(value: unknown, res: Response) {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
    res.status(400).json({ error: 'invalid_category' });
    return null;
  }
  const category = await Category.findById(value);
  if (!category) {
    res.status(400).json({ error: 'invalid_category' });
    return null;
  }
  return category;
}

async function loadOr404(req: Request, res: Response): Promise<PollDoc | null> {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const poll = await Poll.findById(req.params.id);
  if (!poll) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return poll;
}

// Columns the admin polls table can be ordered by.
const POLL_SORT_KEYS = ['question', 'votes', 'submitted', 'updatedAt'] as const;
const POLL_SORT_FIELDS: Record<(typeof POLL_SORT_KEYS)[number], string> = {
  question: 'question',
  votes: 'totalVotes',
  submitted: 'createdAt',
  updatedAt: 'updatedAt',
};

// Case- and accent-insensitive ordering for the text columns.
const LIST_COLLATION = { locale: 'en', strength: 2 } as const;

export async function listPolls(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === 'string' && req.query.status) {
    filter.status = { $in: req.query.status.split(',') };
  }
  if (typeof req.query.categoryId === 'string' && mongoose.Types.ObjectId.isValid(req.query.categoryId)) {
    filter.categoryId = new mongoose.Types.ObjectId(req.query.categoryId);
  }
  if (req.query.mine === 'true' && userId) filter.createdBy = userId;
  const term = searchRegex(req.query.search);
  if (term) filter.question = term;

  // The table's sortable columns, ordered server-side across the whole
  // collection rather than within the page the client happens to hold.
  const sortKey = parseSortKey(req.query.sort, POLL_SORT_KEYS, 'updatedAt');
  const order = parseOrder(req.query.order, sortKey === 'question' ? 1 : -1);

  const [polls, total] = await Promise.all([
    Poll.find(filter)
      .collation(LIST_COLLATION)
      .sort(stableSort(POLL_SORT_FIELDS[sortKey], order))
      .skip(skip)
      .limit(limit),
    Poll.countDocuments(filter),
  ]);
  res.json({ data: polls.map(serializeAdminPoll), pagination: pagination(total, page, limit) });
}

export async function createPoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const normalized = normalizeDefinition(req.body as Record<string, unknown>);
  if ('details' in normalized) return res.status(400).json({ error: 'validation_error', details: normalized.details });

  // Category is required for new polls (mirrors the Article editorial flow).
  const category = await resolveCategoryOr400(req.body.categoryId, res);
  if (!category) return;

  const slug = await generateUniquePollSlug(normalized.question, Poll);
  const poll = await Poll.create({
    question: normalized.question,
    description: normalized.description,
    slug,
    options: normalized.options!.map((text, order) => ({ _id: new mongoose.Types.ObjectId(), text, order })),
    closeDate: normalized.closeDate,
    status: 'draft',
    categoryId: category._id,
    category: category.title,
    categorySlug: category.slug,
    createdBy: userId,
    lastEditedBy: userId,
  });

  await recordActivity({
    entityType: 'poll',
    entityId: poll._id as mongoose.Types.ObjectId,
    action: 'created',
    actorId: userId,
    metadata: { status: poll.status },
  });

  res.status(201).json(serializeAdminPoll(poll));
}

export async function getPoll(req: Request, res: Response) {
  const poll = await loadOr404(req, res);
  if (!poll) return;
  res.json(serializeAdminPoll(poll));
}

export async function updatePoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (poll.status === 'closed') return res.status(400).json({ error: 'invalid_state_transition' });

  const normalized = normalizeDefinition(req.body as Record<string, unknown>, poll);
  if ('details' in normalized) return res.status(400).json({ error: 'validation_error', details: normalized.details });
  if (poll.status === 'open' && normalized.closeDate <= new Date()) {
    return res.status(400).json({ error: 'validation_error', details: [{ field: 'closeDate', message: 'closeDate must be in the future for an open poll.' }] });
  }
  if (poll.status === 'open' && normalized.closeDate < poll.closeDate && req.body.confirmCloseDateShorten !== true) {
    return res.status(400).json({ error: 'validation_error', details: { confirmationRequired: true, field: 'closeDate' } });
  }

  // Read the fields the timeline diffs before any of them are overwritten.
  const before = snapshotPoll(poll);

  if (req.body.categoryId !== undefined) {
    const category = await resolveCategoryOr400(req.body.categoryId, res);
    if (!category) return;
    poll.categoryId = category._id as mongoose.Types.ObjectId;
    poll.category = category.title;
    poll.categorySlug = category.slug;
  }

  poll.question = normalized.question;
  poll.description = normalized.description;
  poll.closeDate = normalized.closeDate;
  poll.lastEditedBy = userId ?? poll.lastEditedBy;

  if (normalized.options) {
    if (poll.totalVotes > 0) return res.status(409).json({ error: 'options_locked' });
    poll.options = normalized.options.map((text, order) => ({
      _id: poll.options[order]?._id ?? new mongoose.Types.ObjectId(),
      text,
      order,
    }));
  }

  // Display order alone, by option id. Unlike an `options` edit this touches no
  // text and mints no ids, so a tally keyed on those ids stays intact — which is
  // why it is allowed after voting has started.
  if (req.body.optionOrder !== undefined) {
    const orderIds = Array.isArray(req.body.optionOrder)
      ? (req.body.optionOrder as unknown[]).map((value) => String(value))
      : null;
    const currentIds = poll.options.map((option) => String(option._id));
    const isPermutation =
      orderIds !== null &&
      orderIds.length === currentIds.length &&
      new Set(orderIds).size === orderIds.length &&
      orderIds.every((id) => currentIds.includes(id));
    if (!isPermutation) {
      return res.status(400).json({
        error: 'validation_error',
        details: [{ field: 'optionOrder', message: "optionOrder must list every existing option id exactly once." }],
      });
    }
    poll.options.forEach((option) => {
      option.order = orderIds.indexOf(String(option._id));
    });
  }

  await poll.save();

  await recordActivities(
    toPollActivity(
      poll._id as mongoose.Types.ObjectId,
      userId ?? null,
      buildPollUpdateActivity({
        before,
        after: poll,
        // An `options` rewrite mints text; `optionOrder` alone only moves it.
        reordered: !normalized.options && req.body.optionOrder !== undefined,
      }),
    ),
  );

  res.json(serializeAdminPoll(poll));
}

export async function publishPoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (poll.status !== 'draft' && poll.status !== 'scheduled') {
    return res.status(400).json({ error: 'invalid_state_transition' });
  }
  const target = req.body.status === 'scheduled' ? 'scheduled' : 'open';
  const previousStatus = poll.status;
  const now = new Date();
  if (poll.closeDate <= now) return res.status(400).json({ error: 'validation_error', details: [{ field: 'closeDate', message: 'closeDate must be in the future.' }] });

  if (target === 'scheduled') {
    const opensAt = parseDate(req.body.opensAt);
    if (!opensAt || opensAt <= now) return res.status(400).json({ error: 'validation_error', details: [{ field: 'opensAt', message: 'opensAt must be in the future.' }] });
    if (opensAt >= poll.closeDate) return res.status(400).json({ error: 'validation_error', details: [{ field: 'opensAt', message: 'opensAt must be before closeDate.' }] });
    poll.status = 'scheduled';
    poll.opensAt = opensAt;
  } else {
    poll.status = 'open';
    poll.opensAt = null;
    poll.publishedBy = userId ?? null;
    poll.publishedAt = now;
  }
  poll.lastEditedBy = userId ?? poll.lastEditedBy;
  await poll.save();

  await recordActivities(
    toPollActivity(
      poll._id as mongoose.Types.ObjectId,
      userId ?? null,
      diffPollStatus(previousStatus, poll.status),
    ),
  );

  res.json(serializeAdminPoll(poll));
}

export async function cancelSchedule(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (poll.status !== 'scheduled') return res.status(400).json({ error: 'invalid_state_transition' });
  poll.status = 'draft';
  poll.opensAt = null;
  poll.lastEditedBy = userId ?? poll.lastEditedBy;
  await poll.save();

  await recordActivities(
    toPollActivity(
      poll._id as mongoose.Types.ObjectId,
      userId ?? null,
      diffPollStatus('scheduled', 'draft'),
    ),
  );

  res.json(serializeAdminPoll(poll));
}

export async function closePoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (poll.status !== 'open') return res.status(400).json({ error: 'invalid_state_transition' });
  const now = new Date();
  poll.status = 'closed';
  poll.featured = false;
  poll.closedBy = userId ?? null;
  poll.closedAt = now;
  poll.lastEditedBy = userId ?? poll.lastEditedBy;
  await poll.save();

  await recordActivities(
    toPollActivity(
      poll._id as mongoose.Types.ObjectId,
      userId ?? null,
      diffPollStatus('open', 'closed'),
    ),
  );

  res.json(serializeAdminPoll(poll));
}

// PATCH /api/admin/polls/:id/featured — toggle the featured flag.
// Only open polls can be featured, capped at POLL_FEATURED_MAX.
export async function setFeatured(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;

  const featured = req.body.featured === true;
  if (featured && !poll.featured) {
    if (poll.status !== 'open') return res.status(400).json({ error: 'not_featurable' });
    const count = await Poll.countDocuments({ status: 'open', featured: true });
    if (count >= POLL_FEATURED_MAX) {
      return res.status(400).json({ error: 'featured_limit_reached', details: { max: POLL_FEATURED_MAX } });
    }
  }

  const featuredChanged = poll.featured !== featured;
  poll.featured = featured;
  poll.lastEditedBy = userId ?? poll.lastEditedBy;
  await poll.save();

  if (featuredChanged) {
    await recordActivity({
      entityType: 'poll',
      entityId: poll._id as mongoose.Types.ObjectId,
      action: 'featured_changed',
      actorId: userId ?? null,
      metadata: { value: featured },
    });
  }

  res.json(serializeAdminPoll(poll));
}

/**
 * GET /api/admin/polls/:id/activity
 *
 * Newest-first page of the poll's activity timeline. Moderator-only, like every
 * other admin poll route.
 */
export async function activity(req: Request, res: Response) {
  const poll = await loadOr404(req, res);
  if (!poll) return;

  res.json(
    await listActivity('poll', String(poll._id), {
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || ACTIVITY_DEFAULT_LIMIT,
    }),
  );
}

export async function metrics(req: Request, res: Response) {
  const poll = await loadOr404(req, res);
  if (!poll) return;
  const pollId = poll._id as mongoose.Types.ObjectId;
  const since = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000);
  const votes = await PollVote.find({ pollId, updatedAt: { $gte: since } });
  const buckets = new Map<string, number>();
  for (let i = 0; i < 14; i += 1) {
    const day = new Date(since);
    day.setDate(since.getDate() + i);
    buckets.set(day.toISOString().slice(0, 10), 0);
  }
  votes.forEach((vote) => {
    const key = vote.updatedAt.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  });
  const articles = await Article.find({ status: 'published' }).select('body');
  const pollIdString = String(poll._id);
  res.json({
    pollId: pollIdString,
    totalVotes: poll.totalVotes,
    uniqueVoters: poll.totalVotes,
    options: serializeResults(poll).options,
    votesOverTime: [...buckets.entries()].map(([date, count]) => ({ date, count })),
    embeddedInCount: articles.filter((article) => bodyContainsPublicPulse(article.body, pollIdString)).length,
  });
}

// Why a single poll was left out of a batch. Stable codes, not sentences — the
// admin panel owns the wording, the same way it owns every other status label.
export type BulkSkipReason =
  | 'not_found'
  | 'already_draft'
  | 'already_open'
  | 'already_closed'
  | 'not_open_yet'
  | 'close_date_passed'
  | 'opens_after_close'
  | 'poll_closed';

interface BulkOutcome {
  id: string;
  question: string;
  ok: boolean;
  reason?: BulkSkipReason;
}

// The single reason a poll cannot make this transition, or null when it can.
// Mirrors the publish / cancel-schedule / close endpoints, which each accept
// exactly one source status.
function statusSkipReason(
  poll: PollDoc,
  target: 'draft' | 'scheduled' | 'open' | 'closed',
  opensAt: Date | null,
  now: Date,
): BulkSkipReason | null {
  if (target === 'open' || target === 'scheduled') {
    if (poll.status === 'closed') return 'already_closed';
    if (poll.status === 'open') return 'already_open';
    if (poll.closeDate <= now) return 'close_date_passed';
    if (target === 'scheduled' && (!opensAt || opensAt >= poll.closeDate)) return 'opens_after_close';
    return null;
  }
  if (target === 'closed') {
    if (poll.status === 'closed') return 'already_closed';
    if (poll.status !== 'open') return 'not_open_yet';
    return null;
  }
  // Back to draft — only a scheduled poll can be pulled back.
  if (poll.status === 'draft') return 'already_draft';
  if (poll.status === 'open') return 'already_open';
  if (poll.status === 'closed') return 'already_closed';
  return null;
}

// POST /api/admin/polls/bulk — batch status change, category move or delete.
//
// A poll's status transitions are state-dependent (only a draft or scheduled poll
// can open, only an open one can close), so a batch applies to whatever is
// eligible and reports the rest as skipped rather than failing outright. Every
// response carries a per-poll `results` list so the caller can say which polls
// were left alone and why, not just how many.
export async function bulkPolls(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const { ids, action } = req.body as { ids?: unknown; action?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  const objectIds = ids.filter(
    (id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id),
  );
  if (objectIds.length !== ids.length) return res.status(400).json({ error: 'invalid_poll_id' });

  const polls = await Poll.find({ _id: { $in: objectIds } });
  if (polls.length === 0) return res.status(404).json({ error: 'not_found' });

  // An id with no poll behind it was deleted by someone else mid-selection.
  // It is a skip like any other, so it belongs in the same list.
  const found = new Set(polls.map((poll) => String(poll._id)));
  const missing: BulkOutcome[] = objectIds
    .filter((id) => !found.has(id))
    .map((id) => ({ id, question: '', ok: false, reason: 'not_found' as const }));

  const respond = (body: Record<string, unknown>, outcomes: BulkOutcome[]) => {
    const results = [...outcomes, ...missing];
    return res.json({
      ...body,
      affected: results.filter((result) => result.ok).length,
      skipped: results.filter((result) => !result.ok).length,
      results,
    });
  };

  if (action === 'delete') {
    // Same rule as the single delete: moderator-or-above, enforced by the router.
    const pollIds = polls.map((poll) => poll._id);
    await PollVote.deleteMany({ pollId: { $in: pollIds } });
    await Poll.deleteMany({ _id: { $in: pollIds } });
    // The log outlives nothing — a deleted poll takes its timeline with it.
    await Promise.all(pollIds.map((pollId) => purgeActivity('poll', pollId as mongoose.Types.ObjectId)));
    return respond(
      { action },
      polls.map((poll) => ({ id: String(poll._id), question: poll.question, ok: true })),
    );
  }

  if (action === 'category') {
    const category = await resolveCategoryOr400(req.body.categoryId, res);
    if (!category) return;
    // A closed poll is frozen — the single edit endpoint refuses it too.
    const editable = polls.filter((poll) => poll.status !== 'closed');
    if (editable.length) {
      await Poll.updateMany(
        { _id: { $in: editable.map((poll) => poll._id) } },
        {
          $set: {
            categoryId: category._id,
            category: category.title,
            categorySlug: category.slug,
            lastEditedBy: userId ?? null,
          },
        },
      );
      await recordActivities(
        editable
          .filter((poll) => poll.category !== category.title)
          .flatMap((poll) =>
            toPollActivity(poll._id as mongoose.Types.ObjectId, userId ?? null, [
              {
                action: 'category_changed',
                metadata: { from: poll.category || null, to: category.title },
              },
            ]),
          ),
      );
    }
    return respond(
      { action },
      polls.map((poll) => ({
        id: String(poll._id),
        question: poll.question,
        ok: poll.status !== 'closed',
        ...(poll.status === 'closed' ? { reason: 'poll_closed' as const } : {}),
      })),
    );
  }

  if (action === 'status') {
    const status = req.body.status;
    if (status !== 'draft' && status !== 'scheduled' && status !== 'open' && status !== 'closed') {
      return res.status(400).json({
        error: 'validation_error',
        details: [{ field: 'status', message: 'Invalid status.' }],
      });
    }

    const now = new Date();
    let opensAt: Date | null = null;
    if (status === 'scheduled') {
      opensAt = parseDate(req.body.opensAt);
      if (!opensAt || opensAt <= now) {
        return res.status(400).json({
          error: 'validation_error',
          details: [{ field: 'opensAt', message: 'opensAt must be in the future.' }],
        });
      }
    }

    const outcomes: BulkOutcome[] = [];
    const events: ReturnType<typeof toPollActivity> = [];
    for (const poll of polls) {
      const previousStatus = poll.status;
      const reason = statusSkipReason(poll, status, opensAt, now);
      if (reason) {
        outcomes.push({ id: String(poll._id), question: poll.question, ok: false, reason });
        continue;
      }

      if (status === 'open') {
        poll.status = 'open';
        poll.opensAt = null;
        poll.publishedBy = userId ?? null;
        poll.publishedAt = now;
      } else if (status === 'scheduled') {
        poll.status = 'scheduled';
        poll.opensAt = opensAt;
      } else if (status === 'closed') {
        poll.status = 'closed';
        poll.featured = false;
        poll.closedBy = userId ?? null;
        poll.closedAt = now;
      } else {
        poll.status = 'draft';
        poll.opensAt = null;
      }

      poll.lastEditedBy = userId ?? poll.lastEditedBy;
      await poll.save();
      events.push(
        ...toPollActivity(
          poll._id as mongoose.Types.ObjectId,
          userId ?? null,
          diffPollStatus(previousStatus, poll.status),
        ),
      );
      outcomes.push({ id: String(poll._id), question: poll.question, ok: true });
    }

    await recordActivities(events);

    return respond({ action, status }, outcomes);
  }

  return res.status(400).json({ error: 'invalid_action' });
}

// DELETE /api/admin/polls/:id — moderator-or-above delete + cascade. No ownership rule:
// any moderator can delete any poll, matching research requests.
export async function deletePoll(req: Request, res: Response) {
  const poll = await loadOr404(req, res);
  if (!poll) return;
  await PollVote.deleteMany({ pollId: poll._id });
  await poll.deleteOne();
  await purgeActivity('poll', poll._id as mongoose.Types.ObjectId);
  res.status(204).send();
}
