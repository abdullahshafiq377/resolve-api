import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import ResearchRequest from '../models/ResearchRequest';
import ResearchRequestVote from '../models/ResearchRequestVote';
import Article from '../models/Article';
import Category from '../models/Category';
import { httpError } from '../utils/errors';
import { toSlug, generateUniqueSlug } from '../utils/slugify';
import {
  PUBLIC_VISIBILITY_FILTER,
  buildLookupMaps,
  getVotedRequestIds,
  parsePagination,
  buildPagination,
} from '../services/researchRequests';
import {
  serializePublicRequest,
  serializeLinkedArticle,
  serializeAccountRequest,
  serializeCompactRequest,
} from '../lib/serializers/researchRequest';


const SORTS: Record<string, Record<string, 1 | -1>> = {
  most_voted: { voteCount: -1, createdAt: -1 },
  newest: { createdAt: -1 },
  recently_active: { updatedAt: -1 },
};

// GET /api/research-requests — public leaderboard.
export async function listPublic(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'most_voted';
  const sort = SORTS[sortKey];
  if (!sort) throw httpError(400, 'invalid_query');

  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);

  const filter: Record<string, unknown> = { ...PUBLIC_VISIBILITY_FILTER };
  const categoryId = req.query.categoryId;
  if (typeof categoryId === 'string' && categoryId) {
    if (!mongoose.Types.ObjectId.isValid(categoryId)) throw httpError(400, 'invalid_query');
    filter.categoryId = new mongoose.Types.ObjectId(categoryId);
  }

  const requests = await ResearchRequest.find(filter).sort(sort).skip(skip).limit(limit);
  const { userMap, categoryMap } = await buildLookupMaps(requests);
  const votedRequestIds = await getVotedRequestIds(
    userId,
    requests.map((r) => r._id as mongoose.Types.ObjectId),
  );

  const total = await ResearchRequest.countDocuments(filter);
  res.json({
    data: requests.map((r) => serializePublicRequest(r, { userMap, categoryMap, votedRequestIds })),
    pagination: buildPagination(total, page, limit),
  });
}

// GET /api/research-requests/sidebar-preview — top 4 by votes for Long Reads.
export async function sidebarPreview(_req: Request, res: Response) {
  const requests = await ResearchRequest.find(PUBLIC_VISIBILITY_FILTER)
    .sort({ voteCount: -1, createdAt: -1 })
    .limit(4);
  const { userMap } = await buildLookupMaps(requests);
  res.json({ data: requests.map((r) => serializeCompactRequest(r, userMap)) });
}

// GET /api/research-requests/:slug — per-request page. 404 for hidden requests.
export async function getBySlug(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const request = await ResearchRequest.findOne({ slug: req.params.slug });
  if (!request || request.approvedAt === null || request.status === 'rejected') {
    return res.status(404).json({ error: 'not_found' });
  }

  const { userMap, categoryMap } = await buildLookupMaps([request]);
  const votedRequestIds = await getVotedRequestIds(userId, [request._id as mongoose.Types.ObjectId]);

  let linkedArticle = null;
  if (request.status === 'published' && request.linkedArticleId) {
    const article = await Article.findById(request.linkedArticleId);
    linkedArticle = serializeLinkedArticle(request, article);
  }

  res.json({
    ...serializePublicRequest(request, { userMap, categoryMap, votedRequestIds }),
    linkedArticle,
  });
}

// POST /api/research-requests — submit a new request (signed-in, not banned).
export async function submit(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
  const rawCategoryId = req.body.categoryId;

  const details: { field: string; message: string }[] = [];
  if (title.length < 8 || title.length > 120) {
    details.push({ field: 'title', message: 'Title must be 8–120 characters.' });
  }
  if (description.length < 20 || description.length > 500) {
    details.push({ field: 'description', message: 'Description must be 20–500 characters.' });
  }
  if (details.length) {
    return res.status(400).json({ error: 'validation_error', details });
  }

  let categoryId: mongoose.Types.ObjectId | null = null;
  if (rawCategoryId !== undefined && rawCategoryId !== null && rawCategoryId !== '') {
    if (typeof rawCategoryId !== 'string' || !mongoose.Types.ObjectId.isValid(rawCategoryId)) {
      throw httpError(400, 'invalid_category');
    }
    const category = await Category.findById(rawCategoryId);
    if (!category) throw httpError(400, 'invalid_category');
    if (!category.active) throw httpError(400, 'inactive_category');
    categoryId = category._id as mongoose.Types.ObjectId;
  }

  // Soft duplicate heuristic: same user + same title (by slug base) within 60s.
  const base = toSlug(title);
  const since = new Date(Date.now() - 60_000);
  const duplicate = await ResearchRequest.findOne({
    submitterId: userId,
    createdAt: { $gt: since },
    slug: { $regex: `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$` },
  });
  if (duplicate) throw httpError(409, 'duplicate_submission');

  const slug = await generateUniqueSlug(title, ResearchRequest);
  const request = await ResearchRequest.create({
    title,
    description,
    slug,
    submitterId: userId,
    categoryId,
    status: 'submitted',
    approvedAt: null,
    voteCount: 0,
    submittedAt: new Date(),
    submittedBy: userId,
  });

  res.status(201).json({
    id: String(request._id),
    slug: request.slug,
    title: request.title,
    description: request.description,
    status: request.status,
    approvedAt: null,
    submittedAt: request.submittedAt.toISOString(),
  });
}

// DELETE /api/research-requests/:id — submitter delete, only while pending.
export async function deleteOwn(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const request = await ResearchRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });
  if (request.submitterId !== userId) return res.status(403).json({ error: 'not_owner' });
  if (request.approvedAt !== null) return res.status(403).json({ error: 'already_approved' });

  await ResearchRequestVote.deleteMany({ requestId: request._id });
  await request.deleteOne();
  res.status(204).send();
}

// POST /api/research-requests/:id/upvote — upvote (self-vote allowed).
export async function upvote(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const request = await ResearchRequest.findById(req.params.id);
  if (!request || request.approvedAt === null || request.status === 'rejected') {
    return res.status(404).json({ error: 'not_found' });
  }

  try {
    await ResearchRequestVote.create({ requestId: request._id, userId });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return res.status(409).json({ error: 'already_voted' });
    }
    throw err;
  }

  const updated = await ResearchRequest.findByIdAndUpdate(
    request._id,
    { $inc: { voteCount: 1 } },
    { new: true },
  );

  res.json({
    requestId: String(request._id),
    voteCount: updated?.voteCount ?? request.voteCount + 1,
    viewerHasVoted: true,
  });
}

// DELETE /api/research-requests/:id/upvote — retract upvote.
export async function retractVote(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const request = await ResearchRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ error: 'not_found' });

  const result = await ResearchRequestVote.deleteOne({ requestId: request._id, userId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'not_voted' });

  const updated = await ResearchRequest.findByIdAndUpdate(
    request._id,
    { $inc: { voteCount: -1 } },
    { new: true },
  );
  // Defensive clamp: never let the denormalised counter go negative.
  if (updated && updated.voteCount < 0) {
    updated.voteCount = 0;
    await updated.save();
  }

  res.json({
    requestId: String(request._id),
    voteCount: updated?.voteCount ?? Math.max(0, request.voteCount - 1),
    viewerHasVoted: false,
  });
}

// GET /api/account/research-requests — current user's submissions.
export async function accountSubmissions(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
  const filter: Record<string, unknown> = { submitterId: userId };

  const statusFilter = req.query.status;
  if (statusFilter === 'pending') filter.approvedAt = null;
  else if (statusFilter === 'approved') {
    filter.approvedAt = { $ne: null };
    filter.status = { $ne: 'rejected' };
  } else if (statusFilter === 'rejected') filter.status = 'rejected';

  const [requests, total] = await Promise.all([
    ResearchRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ResearchRequest.countDocuments(filter),
  ]);

  res.json({
    data: requests.map(serializeAccountRequest),
    pagination: buildPagination(total, page, limit),
  });
}

// GET /api/account/research-requests/upvoted — requests the user upvoted.
export async function accountUpvoted(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ error: 'unauthorized' });

  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>);
  const [votes, total] = await Promise.all([
    ResearchRequestVote.find({ userId }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ResearchRequestVote.countDocuments({ userId }),
  ]);

  const requestIds = votes.map((v) => v.requestId);
  const requests = await ResearchRequest.find({ _id: { $in: requestIds } });
  const byId = new Map(requests.map((r) => [String(r._id), r]));

  const data = votes
    .map((vote) => {
      const request = byId.get(String(vote.requestId));
      if (!request) return null;
      return {
        request: serializeCompactRequest(request),
        votedAt: vote.createdAt.toISOString(),
      };
    })
    .filter(Boolean);

  res.json({ data, pagination: buildPagination(total, page, limit) });
}

// GET /api/research-requests/by-article/:articleId — resolve the publicly-visible
// request slug for an article, so the "From the community" badge can link to it.
export async function getByArticle(req: Request, res: Response) {
  if (!mongoose.Types.ObjectId.isValid(req.params.articleId)) {
    return res.status(404).json({ error: "not_found" });
  }
  const request = await ResearchRequest.findOne({
    linkedArticleId: req.params.articleId,
    ...PUBLIC_VISIBILITY_FILTER,
  }).select("slug");
  if (!request) return res.status(404).json({ error: "not_found" });
  res.json({ slug: request.slug });
}
