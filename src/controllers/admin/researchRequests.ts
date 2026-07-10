import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import ResearchRequest from '../../models/ResearchRequest';
import ResearchRequestVote from '../../models/ResearchRequestVote';
import Notification from '../../models/Notification';
import Article from '../../models/Article';
import Category from '../../models/Category';
import { isSuperAdmin } from '../../middleware/auth';
import { httpError } from '../../utils/errors';
import { findUsersByIds } from '../../services/users';
import {
  buildLookupMaps,
  getUpvoterRecipients,
  parsePagination,
  buildPagination,
  isPubliclyVisible,
} from '../../services/researchRequests';
import { fire, fanOut } from '../../services/notifications/service';
import {
  serializeAdminRequest,
  buildAuditTrail,
} from '../../lib/serializers/researchRequest';
import type { ResearchRequestDoc, ResearchRequestStatus } from '../../models/ResearchRequest';
import { PUBLIC_SETTABLE_STATUSES } from '../../models/ResearchRequest';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

function requestPath(request: ResearchRequestDoc): string {
  return `/research-requests/${request.slug}`;
}

function absolute(path: string): string {
  return `${FRONTEND_ORIGIN}${path}`;
}

async function loadOr404(req: Request, res: Response): Promise<ResearchRequestDoc | null> {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const request = await ResearchRequest.findById(req.params.id);
  if (!request) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return request;
}

async function serializeOne(request: ResearchRequestDoc) {
  const { userMap, categoryMap } = await buildLookupMaps([request]);
  return serializeAdminRequest(request, { userMap, categoryMap });
}

// Notify all upvoters (email + socket) and the submitter (in-app only, unless the
// submitter is also an upvoter, in which case they already got the email row).
async function fanOutHighSignal(
  request: ResearchRequestDoc,
  type: 'request_published' | 'request_rejected' | 'request_not_pursued',
  title: string,
  body: string,
  link: string,
  emailTemplate: 'request_published' | 'request_rejected' | 'request_not_pursued',
  ctaUrl: string,
  detail?: string,
) {
  const recipients = await getUpvoterRecipients(request._id as mongoose.Types.ObjectId);
  const upvoterIds = new Set(recipients.map((r) => r.userId));

  await fanOut({
    requestId: request._id as mongoose.Types.ObjectId,
    type,
    title,
    body,
    link,
    emailTemplate,
    emailVars: { requestTitle: request.title, ctaUrl, detail },
    recipients,
  });

  // Submitter gets the same in-app notification (no email) if not already an upvoter.
  if (!upvoterIds.has(request.submitterId)) {
    await fire({
      userId: request.submitterId,
      type,
      requestId: request._id as mongoose.Types.ObjectId,
      title,
      body,
      link,
    });
  }
}

// Low-signal status change → submitter in-app only.
async function notifySubmitterStatusChange(request: ResearchRequestDoc) {
  const map: Partial<Record<ResearchRequestStatus, { type: 'request_under_consideration' | 'request_being_investigated'; label: string }>> = {
    under_consideration: { type: 'request_under_consideration', label: 'is now under consideration' },
    being_investigated: { type: 'request_being_investigated', label: 'is now being investigated' },
  };
  const entry = map[request.status];
  if (!entry) return;
  await fire({
    userId: request.submitterId,
    type: entry.type,
    requestId: request._id as mongoose.Types.ObjectId,
    title: 'Update on your research request',
    body: `“${request.title}” ${entry.label}.`,
    link: requestPath(request),
  });
}

// GET /api/admin/research-requests — moderation queue.
export async function listQueue(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 30, 100);
  const tab = typeof req.query.tab === 'string' ? req.query.tab : 'pending';

  const filter: Record<string, unknown> = {};
  if (tab === 'pending') filter.approvedAt = null;
  else if (tab === 'approved') {
    filter.approvedAt = { $ne: null };
    filter.status = { $ne: 'rejected' };
  } else if (tab === 'rejected') filter.status = 'rejected';
  // tab === 'all' → no extra filter

  const categoryId = req.query.categoryId;
  if (typeof categoryId === 'string' && categoryId && mongoose.Types.ObjectId.isValid(categoryId)) {
    filter.categoryId = new mongoose.Types.ObjectId(categoryId);
  }
  const search = req.query.search;
  if (typeof search === 'string' && search.trim()) {
    filter.title = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
  }

  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  const sort: Record<string, 1 | -1> =
    sortKey === 'oldest'
      ? { createdAt: 1 }
      : sortKey === 'most_voted'
        ? { voteCount: -1, createdAt: -1 }
        : { createdAt: -1 };

  const [requests, total] = await Promise.all([
    ResearchRequest.find(filter).sort(sort).skip(skip).limit(limit),
    ResearchRequest.countDocuments(filter),
  ]);

  const { userMap, categoryMap } = await buildLookupMaps(requests);
  res.json({
    data: requests.map((r) => serializeAdminRequest(r, { userMap, categoryMap })),
    total,
    pagination: buildPagination(total, page, limit),
  });
}

// GET /api/admin/research-requests/:id — detail with upvoters + audit trail.
export async function getDetail(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;

  const { userMap, categoryMap } = await buildLookupMaps([request]);
  const votes = await ResearchRequestVote.find({ requestId: request._id }).sort({ createdAt: -1 });
  const voterUsers = await findUsersByIds(votes.map((v) => v.userId));
  const voterById = new Map(voterUsers.map((u) => [u.clerkUserId, u]));

  const upvoters = votes.map((vote) => {
    const u = voterById.get(vote.userId);
    return {
      clerkUserId: vote.userId,
      displayName: u?.displayName ?? null,
      email: u?.email ?? null,
      votedAt: vote.createdAt.toISOString(),
    };
  });

  res.json({
    ...serializeAdminRequest(request, { userMap, categoryMap }),
    upvoters,
    auditTrail: buildAuditTrail(request),
  });
}

// PATCH /api/admin/research-requests/:id — edit title/description/category.
export async function editRequest(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;

  const { title, description, categoryId } = req.body as {
    title?: unknown;
    description?: unknown;
    categoryId?: unknown;
  };
  const details: { field: string; message: string }[] = [];

  if (title !== undefined) {
    const t = typeof title === 'string' ? title.trim() : '';
    if (t.length < 8 || t.length > 120) {
      details.push({ field: 'title', message: 'Title must be 8–120 characters.' });
    } else request.title = t;
  }
  if (description !== undefined) {
    const d = typeof description === 'string' ? description.trim() : '';
    if (d.length < 20 || d.length > 500) {
      details.push({ field: 'description', message: 'Description must be 20–500 characters.' });
    } else request.description = d;
  }
  if (details.length) return res.status(400).json({ error: 'validation_error', details });

  if (categoryId !== undefined) {
    if (categoryId === null || categoryId === '') {
      request.categoryId = null;
    } else if (typeof categoryId === 'string' && mongoose.Types.ObjectId.isValid(categoryId)) {
      const category = await Category.findById(categoryId);
      if (!category) throw httpError(400, 'invalid_category');
      request.categoryId = category._id as mongoose.Types.ObjectId;
    } else {
      throw httpError(400, 'invalid_category');
    }
  }

  // Slug is stable from submission; not regenerated on edit.
  await request.save();
  res.json(await serializeOne(request));
}

// POST /api/admin/research-requests/:id/approve
export async function approve(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;
  const { userId } = getAuth(req);
  if (request.approvedAt !== null) return res.status(400).json({ error: 'already_approved' });

  const now = new Date();
  request.approvedAt = now;
  request.moderatedBy = userId ?? null;
  request.moderatedAt = now;
  request.status = 'submitted';
  request.statusChangedBy = userId ?? null;
  request.statusChangedAt = now;
  await request.save();

  // Notify the submitter their request is now live (in-app only).
  await fire({
    userId: request.submitterId,
    type: 'request_approved',
    requestId: request._id as mongoose.Types.ObjectId,
    title: 'Your research request was approved',
    body: `“${request.title}” is now live on the leaderboard.`,
    link: requestPath(request),
  });

  res.json(await serializeOne(request));
}

// POST /api/admin/research-requests/:id/reject
export async function reject(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;
  const { userId } = getAuth(req);

  const reason = typeof req.body.rejectionReason === 'string' ? req.body.rejectionReason.trim() : '';
  if (!reason) return res.status(400).json({ error: 'validation_error', details: [{ field: 'rejectionReason', message: 'A rejection reason is required.' }] });

  const now = new Date();
  request.status = 'rejected';
  request.rejectionReason = reason;
  request.moderatedBy = userId ?? null;
  request.moderatedAt = now;
  request.statusChangedBy = userId ?? null;
  request.statusChangedAt = now;
  await request.save();

  // Upvoters get email + socket; submitter gets in-app (reason is in their account).
  await fanOutHighSignal(
    request,
    'request_rejected',
    'A research request you upvoted was not approved',
    `“${request.title}” was not approved by the editorial team.`,
    '/account/research-requests',
    'request_rejected',
    absolute('/research-requests'),
  );

  res.json(await serializeOne(request));
}

// POST /api/admin/research-requests/:id/change-status
export async function changeStatus(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;
  const { userId } = getAuth(req);

  const status = req.body.status as ResearchRequestStatus;
  if (!PUBLIC_SETTABLE_STATUSES.includes(status as (typeof PUBLIC_SETTABLE_STATUSES)[number])) {
    // 'rejected' must go through the reject endpoint; anything else is invalid.
    return res.status(400).json({ error: 'validation_error', details: [{ field: 'status', message: 'Invalid status.' }] });
  }

  const previousStatus = request.status;
  const now = new Date();

  // Resolve the linked article when moving to (or already at) published.
  if (status === 'published') {
    const rawArticleId =
      (req.body.linkedArticleId as string | undefined) ??
      (request.linkedArticleId ? String(request.linkedArticleId) : undefined);
    if (!rawArticleId) return res.status(400).json({ error: 'linked_article_required' });
    if (!mongoose.Types.ObjectId.isValid(rawArticleId)) {
      return res.status(400).json({ error: 'linked_article_not_found' });
    }
    const article = await Article.findById(rawArticleId);
    if (!article) return res.status(400).json({ error: 'linked_article_not_found' });
    if (article.status !== 'published') {
      return res.status(400).json({ error: 'linked_article_not_published' });
    }
    // Link (idempotent) + set the article badge.
    request.linkedArticleId = article._id as mongoose.Types.ObjectId;
    request.linkedArticleSlug = article.slug;
    request.linkedArticleBy = userId ?? null;
    request.linkedArticleAt = now;
    if (!article.fromResearchRequest || String(article.researchRequestId) !== String(request._id)) {
      article.fromResearchRequest = true;
      article.researchRequestId = request._id as mongoose.Types.ObjectId;
      await article.save();
    }
  }

  let notPursuedReason = request.notPursuedReason;
  if (status === 'not_pursued') {
    const reason = typeof req.body.notPursuedReason === 'string' ? req.body.notPursuedReason.trim() : '';
    if (!reason) return res.status(400).json({ error: 'not_pursued_reason_required' });
    notPursuedReason = reason;
    request.notPursuedReason = reason;
    request.notPursuedReasonSetBy = userId ?? null;
    request.notPursuedReasonSetAt = now;
  }

  request.status = status;
  request.statusChangedBy = userId ?? null;
  request.statusChangedAt = now;
  await request.save();

  // Only fire notifications on a real transition.
  if (status !== previousStatus) {
    if (status === 'published') {
      const ctaUrl = request.linkedArticleSlug
        ? absolute(`/article/${request.linkedArticleSlug}`)
        : absolute(requestPath(request));
      await fanOutHighSignal(
        request,
        'request_published',
        'The story you upvoted has been published',
        `“${request.title}” is now a published story.`,
        requestPath(request),
        'request_published',
        ctaUrl,
      );
    } else if (status === 'not_pursued') {
      await fanOutHighSignal(
        request,
        'request_not_pursued',
        'An update on a research request you upvoted',
        `The editorial team has decided not to pursue “${request.title}”.`,
        requestPath(request),
        'request_not_pursued',
        absolute(requestPath(request)),
        notPursuedReason ?? undefined,
      );
    } else {
      await notifySubmitterStatusChange(request);
    }
  }

  res.json(await serializeOne(request));
}

// POST /api/admin/research-requests/:id/link-article
export async function linkArticle(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;
  const { userId } = getAuth(req);

  const rawArticleId = req.body.linkedArticleId;
  if (typeof rawArticleId !== 'string' || !mongoose.Types.ObjectId.isValid(rawArticleId)) {
    return res.status(400).json({ error: 'linked_article_not_found' });
  }
  const article = await Article.findById(rawArticleId);
  if (!article) return res.status(400).json({ error: 'linked_article_not_found' });
  if (article.status !== 'published') {
    return res.status(400).json({ error: 'linked_article_not_published' });
  }

  request.linkedArticleId = article._id as mongoose.Types.ObjectId;
  request.linkedArticleSlug = article.slug;
  request.linkedArticleBy = userId ?? null;
  request.linkedArticleAt = new Date();
  await request.save();

  article.fromResearchRequest = true;
  article.researchRequestId = request._id as mongoose.Types.ObjectId;
  await article.save();

  res.json(await serializeOne(request));
}

// POST /api/admin/research-requests/:id/unlink-article
export async function unlinkArticle(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;
  const { userId } = getAuth(req);

  if (request.linkedArticleId) {
    await Article.updateOne(
      { _id: request.linkedArticleId },
      { $set: { fromResearchRequest: false, researchRequestId: null } },
    );
  }
  request.linkedArticleId = null;
  request.linkedArticleSlug = null;
  request.linkedArticleBy = userId ?? null;
  request.linkedArticleAt = new Date();
  await request.save();

  res.json(await serializeOne(request));
}

// GET /api/admin/research-requests/:id/upvoters
export async function listUpvoters(req: Request, res: Response) {
  const request = await loadOr404(req, res);
  if (!request) return;

  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 30, 100);
  const [votes, total] = await Promise.all([
    ResearchRequestVote.find({ requestId: request._id }).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ResearchRequestVote.countDocuments({ requestId: request._id }),
  ]);
  const users = await findUsersByIds(votes.map((v) => v.userId));
  const byId = new Map(users.map((u) => [u.clerkUserId, u]));

  res.json({
    data: votes.map((vote) => {
      const u = byId.get(vote.userId);
      return {
        clerkUserId: vote.userId,
        displayName: u?.displayName ?? null,
        email: u?.email ?? null,
        votedAt: vote.createdAt.toISOString(),
      };
    }),
    total,
    pagination: buildPagination(total, page, limit),
  });
}

// DELETE /api/admin/research-requests/:id — super-admin hard delete + cascade.
export async function hardDelete(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!isSuperAdmin(userId)) return res.status(403).json({ error: 'not_super_admin' });

  const request = await loadOr404(req, res);
  if (!request) return;

  await ResearchRequestVote.deleteMany({ requestId: request._id });
  await Notification.deleteMany({ requestId: request._id });
  if (request.linkedArticleId) {
    await Article.updateOne(
      { _id: request.linkedArticleId },
      { $set: { fromResearchRequest: false, researchRequestId: null } },
    );
  }
  await request.deleteOne();
  res.status(204).send();
}

export { isPubliclyVisible };
