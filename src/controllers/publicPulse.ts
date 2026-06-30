import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Poll, {
  POLL_FEATURED_MAX,
  POLL_RECENTLY_CLOSED_WINDOW_DAYS,
  type PollDoc,
} from '../models/Poll';
import PollVote from '../models/PollVote';
import Article from '../models/Article';
import { httpError } from '../utils/errors';
import { bodyContainsPublicPulse } from '../services/publicPulse/body';
import { runPublicPulseTransitions } from '../services/publicPulse/lifecycle';
import { serializePublicPoll, serializeResults } from '../services/publicPulse/serializers';

const MAX_LIMIT = 50;

function parsePagination(query: Request['query'], defaultLimit = 20) {
  const page = Math.max(1, parseInt(query.page as string, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit as string, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

function pagination(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.ceil(total / limit) };
}

function recentlyClosedCutoff(): Date {
  return new Date(Date.now() - POLL_RECENTLY_CLOSED_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

async function findPoll(slugOrId: string, session?: mongoose.ClientSession): Promise<PollDoc | null> {
  if (mongoose.Types.ObjectId.isValid(slugOrId)) {
    const byId = await Poll.findById(slugOrId).session(session ?? null);
    if (byId) return byId;
  }
  return Poll.findOne({ slug: slugOrId }).session(session ?? null);
}

async function syncDueTransitions(now = new Date()) {
  await runPublicPulseTransitions(now);
}

async function viewerVote(userId: string | null | undefined, pollId: mongoose.Types.ObjectId) {
  if (!userId) return null;
  return PollVote.findOne({ pollId, userId });
}

async function withTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    if (result === undefined) throw httpError(500, 'transaction_failed');
    return result;
  } finally {
    await session.endSession();
  }
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

// GET /api/public-pulse — active polls.
export async function listActive(req: Request, res: Response) {
  await syncDueTransitions();
  const { page, limit, skip } = parsePagination(req.query);
  const filter: Record<string, unknown> = { status: 'active' };
  if (typeof req.query.categorySlug === 'string' && req.query.categorySlug) {
    filter.categorySlug = req.query.categorySlug;
  }
  const [polls, total] = await Promise.all([
    Poll.find(filter).sort({ publishedAt: -1, createdAt: -1 }).skip(skip).limit(limit),
    Poll.countDocuments(filter),
  ]);
  res.json({ data: polls.map((poll) => serializePublicPoll(poll)), pagination: pagination(total, page, limit) });
}

// GET /api/public-pulse/featured — active polls flagged featured (single column on the public page).
export async function listFeatured(req: Request, res: Response) {
  await syncDueTransitions();
  const { userId } = getAuth(req);
  const polls = await Poll.find({ status: 'active', featured: true })
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(POLL_FEATURED_MAX);

  const voteByPoll = new Map<string, string>();
  if (userId && polls.length) {
    const votes = await PollVote.find({
      pollId: { $in: polls.map((poll) => poll._id) },
      userId,
    });
    votes.forEach((vote) => voteByPoll.set(String(vote.pollId), String(vote.optionId)));
  }

  res.json({
    data: polls.map((poll) =>
      serializePublicPoll(poll, voteByPoll.get(String(poll._id)) ?? null),
    ),
  });
}

// GET /api/public-pulse/recent — closed inside recent window.
export async function listRecent(req: Request, res: Response) {
  await syncDueTransitions();
  const { userId } = getAuth(req);
  const { page, limit, skip } = parsePagination(req.query);
  const filter: Record<string, unknown> = { status: 'closed', closedAt: { $gte: recentlyClosedCutoff() } };
  if (typeof req.query.categorySlug === 'string' && req.query.categorySlug) {
    filter.categorySlug = req.query.categorySlug;
  }
  const [polls, total] = await Promise.all([
    Poll.find(filter).sort({ closedAt: -1 }).skip(skip).limit(limit),
    Poll.countDocuments(filter),
  ]);

  // When signed in, attach the viewer's vote per poll so closed cards can flag
  // the reader's own choice (mirrors listFeatured).
  const voteByPoll = new Map<string, string>();
  if (userId && polls.length) {
    const votes = await PollVote.find({
      pollId: { $in: polls.map((poll) => poll._id) },
      userId,
    });
    votes.forEach((vote) => voteByPoll.set(String(vote.pollId), String(vote.optionId)));
  }

  res.json({
    data: polls.map((poll) => serializePublicPoll(poll, voteByPoll.get(String(poll._id)) ?? null)),
    pagination: pagination(total, page, limit),
  });
}

// GET /api/public-pulse/archive — closed outside recent window.
export async function listArchive(req: Request, res: Response) {
  await syncDueTransitions();
  const { page, limit, skip } = parsePagination(req.query);
  const filter: Record<string, unknown> = {
    status: 'closed',
    $or: [{ closedAt: { $lt: recentlyClosedCutoff() } }, { closedAt: null }],
  };
  const [polls, total] = await Promise.all([
    Poll.find(filter).sort({ closedAt: -1, updatedAt: -1 }).skip(skip).limit(limit),
    Poll.countDocuments(filter),
  ]);
  res.json({ data: polls.map((poll) => serializePublicPoll(poll)), pagination: pagination(total, page, limit) });
}

// GET /api/public-pulse/:slugOrId
export async function getOne(req: Request, res: Response) {
  await syncDueTransitions();
  const { userId } = getAuth(req);
  const poll = await findPoll(req.params.slugOrId);
  if (!poll || poll.status === 'draft') return res.status(404).json({ error: 'not_found' });
  const vote = await viewerVote(userId, poll._id as mongoose.Types.ObjectId);
  res.json(serializePublicPoll(poll, vote ? String(vote.optionId) : null));
}

// GET /api/public-pulse/:slugOrId/results
export async function getResults(req: Request, res: Response) {
  await syncDueTransitions();
  const poll = await findPoll(req.params.slugOrId);
  if (!poll || poll.status === 'draft') return res.status(404).json({ error: 'not_found' });
  res.set('Cache-Control', 'public, max-age=5, stale-while-revalidate=15');
  res.json(serializeResults(poll));
}

// GET /api/public-pulse/:slugOrId/my-vote
export async function getMyVote(req: Request, res: Response) {
  await syncDueTransitions();
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const poll = await findPoll(req.params.slugOrId);
  if (!poll) return res.status(404).json({ error: 'not_found' });
  const vote = await viewerVote(userId, poll._id as mongoose.Types.ObjectId);
  res.json({
    pollId: String(poll._id),
    optionId: vote ? String(vote.optionId) : null,
    votedAt: vote ? vote.createdAt.toISOString() : null,
    updatedAt: vote ? vote.updatedAt.toISOString() : null,
  });
}

// GET /api/public-pulse/:slugOrId/embedded-in
export async function embeddedIn(req: Request, res: Response) {
  const poll = await findPoll(req.params.slugOrId);
  if (!poll) return res.status(404).json({ error: 'not_found' });
  const pollId = String(poll._id);
  const articles = await Article.find({ status: 'published' })
    .select('title slug featuredImage updatedAt body')
    .sort({ publishDate: -1 });
  const data = articles
    .filter((article) => bodyContainsPublicPulse(article.body, pollId))
    .map((article) => ({
      id: String(article._id),
      title: article.title,
      slug: article.slug,
      featuredImage: article.featuredImage,
      updatedAt: article.updatedAt.toISOString(),
    }));
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ data });
}

async function writeVote(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  const now = new Date();
  await syncDueTransitions(now);

  const optionId = typeof req.body.optionId === 'string' ? req.body.optionId : '';
  if (!mongoose.Types.ObjectId.isValid(optionId)) return res.status(400).json({ error: 'invalid_input' });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const payload = await withTransaction(async (session) => {
        const poll = await findPoll(req.params.slugOrId, session);
        if (!poll) throw httpError(404, 'not_found');
        if (poll.status === 'active' && poll.closeDate <= now) {
          throw httpError(410, 'gone');
        }
        if (poll.status === 'closed') throw httpError(410, 'gone');
        if (poll.status !== 'active') throw httpError(409, 'invalid_state');

        const option = poll.options.find((candidate) => String(candidate._id) === optionId);
        if (!option) throw httpError(400, 'invalid_input');

        const pollId = poll._id as mongoose.Types.ObjectId;
        const nextOption = new mongoose.Types.ObjectId(optionId);
        const existing = await PollVote.findOne({ pollId, userId }).session(session);

        if (!existing) {
          await PollVote.create([{ pollId, userId, optionId: nextOption }], { session });
          const updatedCounters = await Poll.updateOne(
            { _id: pollId, status: 'active', closeDate: { $gt: now } },
            { $inc: { totalVotes: 1, [`optionVoteCounts.${optionId}`]: 1 } },
            { session },
          );
          if (updatedCounters.matchedCount !== 1) throw httpError(410, 'gone');
        } else if (String(existing.optionId) !== optionId) {
          const previous = String(existing.optionId);
          existing.optionId = nextOption;
          await existing.save({ session });
          const updatedCounters = await Poll.updateOne(
            { _id: pollId, status: 'active', closeDate: { $gt: now } },
            { $inc: { [`optionVoteCounts.${previous}`]: -1, [`optionVoteCounts.${optionId}`]: 1 } },
            { session },
          );
          if (updatedCounters.matchedCount !== 1) throw httpError(410, 'gone');
        }

        const updated = await Poll.findById(pollId).session(session);
        if (!updated) throw httpError(404, 'not_found');
        return {
          ...serializeResults(updated),
          pollId: String(updated._id),
          updatedAt: new Date().toISOString(),
        };
      });
      return res.json(payload);
    } catch (err) {
      if ((err as { status?: number }).status === 410) {
        await syncDueTransitions(new Date());
      }
      if (attempt === 0 && isDuplicateKey(err)) continue;
      throw err;
    }
  }

  throw httpError(409, 'vote_conflict');
}

export const vote = writeVote;
export const changeVote = writeVote;

export async function notImplemented(_req: Request, res: Response) {
  res.status(501).json({ error: 'not_implemented' });
}
