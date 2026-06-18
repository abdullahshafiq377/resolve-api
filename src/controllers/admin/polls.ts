import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Poll, {
  POLL_DESCRIPTION_MAX,
  POLL_OPTION_MAX,
  POLL_OPTION_MIN,
  POLL_OPTION_TEXT_MAX,
  POLL_QUESTION_MAX,
  POLL_QUESTION_MIN,
  type PollDoc,
  type PollResultsMode,
} from '../../models/Poll';
import PollVote from '../../models/PollVote';
import Article from '../../models/Article';
import { isSuperAdmin } from '../../middleware/auth';
import { generateUniquePollSlug } from '../../services/publicPulse/slug';
import { bodyContainsPublicPulse } from '../../services/publicPulse/body';
import { serializeAdminPoll, serializeResults } from '../../services/publicPulse/serializers';

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

export async function listPolls(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter: Record<string, unknown> = {};
  if (typeof req.query.status === 'string' && req.query.status) {
    filter.status = { $in: req.query.status.split(',') };
  }
  if (req.query.mine === 'true' && userId) filter.createdBy = userId;
  if (typeof req.query.search === 'string' && req.query.search.trim()) {
    filter.question = { $regex: req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const [polls, total] = await Promise.all([
    Poll.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit),
    Poll.countDocuments(filter),
  ]);
  res.json({ data: polls.map(serializeAdminPoll), pagination: pagination(total, page, limit) });
}

export async function createPoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const normalized = normalizeDefinition(req.body as Record<string, unknown>);
  if ('details' in normalized) return res.status(400).json({ error: 'validation_error', details: normalized.details });

  const resultsMode = req.body.resultsMode as PollResultsMode | undefined;
  if (resultsMode && resultsMode !== 'hidden_until_vote' && resultsMode !== 'always_visible') {
    return res.status(400).json({ error: 'validation_error', details: [{ field: 'resultsMode', message: 'Invalid results mode.' }] });
  }

  const slug = await generateUniquePollSlug(normalized.question, Poll);
  const poll = await Poll.create({
    question: normalized.question,
    description: normalized.description,
    slug,
    options: normalized.options!.map((text, order) => ({ _id: new mongoose.Types.ObjectId(), text, order })),
    closeDate: normalized.closeDate,
    resultsMode: resultsMode ?? 'hidden_until_vote',
    status: 'draft',
    createdBy: userId,
    lastEditedBy: userId,
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
  if (req.body.resultsMode !== undefined && req.body.resultsMode !== poll.resultsMode) {
    return res.status(400).json({ error: 'results_mode_locked' });
  }

  const normalized = normalizeDefinition(req.body as Record<string, unknown>, poll);
  if ('details' in normalized) return res.status(400).json({ error: 'validation_error', details: normalized.details });
  if (poll.status === 'active' && normalized.closeDate <= new Date()) {
    return res.status(400).json({ error: 'validation_error', details: [{ field: 'closeDate', message: 'closeDate must be in the future for an active poll.' }] });
  }
  if (poll.status === 'active' && normalized.closeDate < poll.closeDate && req.body.confirmCloseDateShorten !== true) {
    return res.status(400).json({ error: 'validation_error', details: { confirmationRequired: true, field: 'closeDate' } });
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

  await poll.save();
  res.json(serializeAdminPoll(poll));
}

export async function publishPoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (poll.status !== 'draft' && poll.status !== 'scheduled') {
    return res.status(400).json({ error: 'invalid_state_transition' });
  }
  const target = req.body.status === 'scheduled' ? 'scheduled' : 'active';
  const now = new Date();
  if (poll.closeDate <= now) return res.status(400).json({ error: 'validation_error', details: [{ field: 'closeDate', message: 'closeDate must be in the future.' }] });

  if (target === 'scheduled') {
    const opensAt = parseDate(req.body.opensAt);
    if (!opensAt || opensAt <= now) return res.status(400).json({ error: 'validation_error', details: [{ field: 'opensAt', message: 'opensAt must be in the future.' }] });
    if (opensAt >= poll.closeDate) return res.status(400).json({ error: 'validation_error', details: [{ field: 'opensAt', message: 'opensAt must be before closeDate.' }] });
    poll.status = 'scheduled';
    poll.opensAt = opensAt;
  } else {
    poll.status = 'active';
    poll.opensAt = null;
    poll.publishedBy = userId ?? null;
    poll.publishedAt = now;
  }
  poll.lastEditedBy = userId ?? poll.lastEditedBy;
  await poll.save();
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
  res.json(serializeAdminPoll(poll));
}

export async function closePoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (poll.status !== 'active') return res.status(400).json({ error: 'invalid_state_transition' });
  const now = new Date();
  poll.status = 'closed';
  poll.closedBy = userId ?? null;
  poll.closedAt = now;
  poll.lastEditedBy = userId ?? poll.lastEditedBy;
  await poll.save();
  res.json(serializeAdminPoll(poll));
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

export async function deletePoll(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const poll = await loadOr404(req, res);
  if (!poll) return;
  if (!isSuperAdmin(userId) && poll.createdBy !== userId) {
    return res.status(403).json({ error: 'forbidden' });
  }
  await PollVote.deleteMany({ pollId: poll._id });
  await poll.deleteOne();
  res.status(204).send();
}
