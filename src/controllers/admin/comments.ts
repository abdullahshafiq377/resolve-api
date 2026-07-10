import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Comment from '../../models/Comment';
import CommentReport from '../../models/CommentReport';
import CommentBan from '../../models/CommentBan';
import ModerationAction from '../../models/ModerationAction';
import User from '../../models/User';
import { httpError } from '../../utils/errors';
import { parsePagination } from '../../services/researchRequests';
import {
  serializeAdminComment,
  serializePublicComment,
} from '../../lib/serializers/comment';
import { resolveParentState, parentPath } from '../../services/comments/parents';
import { getActiveCommentBan } from '../../services/comments/bans';
import {
  approveHeldComment,
  denyHeldComment,
  removeComment,
  resolveReports,
} from '../../services/comments/moderation';
import { issueWarning, issueCommentBan, liftCommentBan } from '../../services/comments/banActions';
import { COMMENT_BAN_TIERS, type CommentBanTier } from '../../models/CommentBan';
import BlockedKeyword, {
  BLOCKED_KEYWORD_LANGUAGES,
  type BlockedKeywordLanguage,
} from '../../models/BlockedKeyword';
import { invalidateBlockListCache } from '../../services/comments/blocklist';

async function loadComment(id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, 'comment_not_found');
  const comment = await Comment.findById(id);
  if (!comment) throw httpError(404, 'comment_not_found');
  return comment;
}

async function displayNameMap(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!userIds.length) return map;
  const users = await User.find({ clerkUserId: { $in: userIds } })
    .select('clerkUserId displayName')
    .lean();
  for (const u of users) map.set(u.clerkUserId, u.displayName || 'Resolve reader');
  return map;
}

// GET /api/admin/comments/held — FIFO held-comment queue.
export async function listHeld(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 50, 200);
  const filter = { status: 'held' as const };
  const [docs, total] = await Promise.all([
    Comment.find(filter).sort({ createdAt: 1 }).skip(skip).limit(limit),
    Comment.countDocuments(filter),
  ]);
  res.json({
    items: docs.map(serializeAdminComment),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// POST /api/admin/comments/:id/approve — publish a held comment.
export async function approveHeld(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const comment = await loadComment(req.params.id);
  if (comment.status !== 'held') throw httpError(400, 'not_held');
  await approveHeldComment(comment, userId as string);
  res.json({ comment: serializeAdminComment(comment) });
}

// POST /api/admin/comments/:id/deny — hard-delete a held comment.
export async function denyHeld(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const comment = await loadComment(req.params.id);
  if (comment.status !== 'held') throw httpError(400, 'not_held');
  await denyHeldComment(comment, userId as string);
  res.status(204).end();
}

const REPORT_SORTS: Record<string, Record<string, 1 | -1>> = {
  most_reported: { reportCount: -1, firstReportAt: 1 },
  newest: { latestReportAt: -1 },
  oldest: { firstReportAt: 1 },
};

// GET /api/admin/comments/reports — aggregated open-report queue.
export async function listReports(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 50, 200);
  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'most_reported';
  const sort = REPORT_SORTS[sortKey] ?? REPORT_SORTS.most_reported;

  const match: Record<string, unknown> = { status: 'open' };
  if (typeof req.query.reason === 'string' && req.query.reason) match.reason = req.query.reason;

  const grouped = await CommentReport.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$commentId',
        reportCount: { $sum: 1 },
        latestReportAt: { $max: '$createdAt' },
        firstReportAt: { $min: '$createdAt' },
        reasons: { $push: '$reason' },
      },
    },
    { $sort: sort },
    { $skip: skip },
    { $limit: limit },
  ]);

  const commentIds = grouped.map((g) => g._id as mongoose.Types.ObjectId);
  const comments = await Comment.find({ _id: { $in: commentIds } });
  const commentMap = new Map(comments.map((c) => [String(c._id), c]));

  const items = [];
  for (const g of grouped) {
    const comment = commentMap.get(String(g._id));
    if (!comment) continue;
    const reasons: Record<string, number> = {};
    for (const r of g.reasons as string[]) reasons[r] = (reasons[r] ?? 0) + 1;

    const recent = await CommentReport.find({ commentId: g._id, status: 'open' })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();
    const names = await displayNameMap(recent.map((r) => r.reporterId));

    items.push({
      comment: serializeAdminComment(comment),
      reportCount: g.reportCount as number,
      reasons,
      latestReportAt: (g.latestReportAt as Date).toISOString(),
      firstReportAt: (g.firstReportAt as Date).toISOString(),
      reporters: recent.map((r) => ({
        userId: r.reporterId,
        displayName: names.get(r.reporterId) ?? 'Resolve reader',
        reason: r.reason,
        context: r.context,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }

  res.json({ items, page });
}

// GET /api/admin/comments/reports/:commentId — full report detail.
export async function reportDetail(req: Request, res: Response) {
  const comment = await loadComment(req.params.commentId);
  const reports = await CommentReport.find({ commentId: comment._id }).sort({ createdAt: -1 }).lean();
  const names = await displayNameMap(reports.map((r) => r.reporterId));
  res.json({
    comment: serializeAdminComment(comment),
    reports: reports.map((r) => ({
      id: String(r._id),
      reporter: { userId: r.reporterId, displayName: names.get(r.reporterId) ?? 'Resolve reader' },
      reason: r.reason,
      context: r.context,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

// POST /api/admin/comments/:id/resolve — remove the comment or dismiss reports.
// (Warning/ban handling is layered in by the bans slice.)
export async function resolveReport(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const actorId = userId as string;
  const comment = await loadComment(req.params.id);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const action = body.action;
  if (action !== 'remove_comment' && action !== 'no_action') {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'action', reason: 'invalid' } });
  }
  const reason = typeof body.reason === 'string' ? body.reason : null;

  const parent = await resolveParentState(comment.parentType, String(comment.parentId));
  const link = `${parentPath(comment.parentType, parent.slug)}#comment-${String(comment._id)}`;

  // Optional warning + ban applied alongside the resolution.
  const result: Record<string, unknown> = {};
  if (body.issueWarning === true) {
    result.warning = { id: await issueWarning(comment.authorId, actorId, reason ?? 'Warning', String(comment._id)) };
  }
  const ban = body.ban as { tier?: string; reason?: string } | undefined;
  if (ban && typeof ban.tier === 'string' && COMMENT_BAN_TIERS.includes(ban.tier as CommentBanTier)) {
    result.ban = await issueCommentBan(
      comment.authorId,
      actorId,
      ban.tier as CommentBanTier,
      ban.reason ?? reason ?? null,
      String(comment._id),
    );
  }

  if (action === 'remove_comment') {
    await removeComment(comment, actorId, reason);
    await resolveReports(comment._id as mongoose.Types.ObjectId, actorId, 'resolved_removed', link);
    return res.json({
      comment: serializePublicComment(comment, { userVotes: new Map() }),
      ...result,
    });
  }

  await resolveReports(comment._id as mongoose.Types.ObjectId, actorId, 'resolved_no_action', link);
  res.json({ ok: true, ...result });
}

// POST /api/admin/users/:userId/warning
export async function postWarning(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const reason = typeof (req.body ?? {}).reason === 'string' ? (req.body as { reason: string }).reason : '';
  if (!reason.trim()) {
    return res.status(400).json({ error: 'validation_error', details: { field: 'reason', reason: 'required' } });
  }
  const commentId = (req.body as { commentId?: string }).commentId;
  const id = await issueWarning(req.params.userId, userId as string, reason, commentId);
  res.status(201).json({ id });
}

// POST /api/admin/users/:userId/comment-ban
export async function postBan(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const body = (req.body ?? {}) as { tier?: string; reason?: string; relatedCommentId?: string };
  if (typeof body.tier !== 'string' || !COMMENT_BAN_TIERS.includes(body.tier as CommentBanTier)) {
    return res.status(400).json({ error: 'validation_error', details: { field: 'tier', reason: 'invalid' } });
  }
  const result = await issueCommentBan(
    req.params.userId,
    userId as string,
    body.tier as CommentBanTier,
    body.reason ?? null,
    body.relatedCommentId,
  );
  res.status(201).json(result);
}

// POST /api/admin/users/:userId/comment-ban/:banId/lift
export async function postLiftBan(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const reason = (req.body ?? {}).reason;
  const result = await liftCommentBan(
    req.params.userId,
    req.params.banId,
    userId as string,
    typeof reason === 'string' ? reason : null,
  );
  res.json(result);
}

// GET /api/admin/comments/stats — dashboard header counts.
export async function stats(_req: Request, res: Response) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const now = new Date();
  const [openReportComments, heldComments, activeBans, commentsLast24h] = await Promise.all([
    CommentReport.distinct('commentId', { status: 'open' }),
    Comment.countDocuments({ status: 'held' }),
    CommentBan.countDocuments({
      liftedAt: null,
      $or: [{ activeUntil: null }, { activeUntil: { $gt: now } }],
    }),
    Comment.countDocuments({ status: 'visible', createdAt: { $gte: since } }),
  ]);
  res.json({
    openReports: openReportComments.length,
    heldComments,
    activeBans,
    commentsLast24h,
  });
}

function serializeKeyword(k: {
  _id: unknown;
  term: string;
  language: string;
  addedBy: string;
  addedAt: Date;
  removedAt: Date | null;
  removedBy: string | null;
  reason: string | null;
  isActive: boolean;
}) {
  return {
    id: String(k._id),
    term: k.term,
    language: k.language,
    addedBy: k.addedBy,
    addedAt: k.addedAt.toISOString(),
    removedAt: k.removedAt ? k.removedAt.toISOString() : null,
    removedBy: k.removedBy,
    reason: k.reason,
    isActive: k.isActive,
  };
}

// GET /api/admin/comments/keywords — block-list entries (filter by language/status).
export async function listKeywords(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 50, 200);
  const filter: Record<string, unknown> = {};
  if (typeof req.query.language === 'string' && BLOCKED_KEYWORD_LANGUAGES.includes(req.query.language as BlockedKeywordLanguage)) {
    filter.language = req.query.language;
  }
  const status = typeof req.query.status === 'string' ? req.query.status : 'active';
  if (status === 'active') filter.isActive = true;
  else if (status === 'removed') filter.isActive = false;

  const [docs, total] = await Promise.all([
    BlockedKeyword.find(filter).sort({ addedAt: -1 }).skip(skip).limit(limit).lean(),
    BlockedKeyword.countDocuments(filter),
  ]);
  res.json({
    items: docs.map(serializeKeyword),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// POST /api/admin/comments/keywords — add a block-list term.
export async function addKeyword(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const body = (req.body ?? {}) as { term?: string; language?: string; reason?: string };
  const term = typeof body.term === 'string' ? body.term.trim().toLowerCase() : '';
  if (!term) {
    return res.status(400).json({ error: 'validation_error', details: { field: 'term', reason: 'required' } });
  }
  if (typeof body.language !== 'string' || !BLOCKED_KEYWORD_LANGUAGES.includes(body.language as BlockedKeywordLanguage)) {
    return res.status(400).json({ error: 'validation_error', details: { field: 'language', reason: 'invalid' } });
  }
  const existing = await BlockedKeyword.findOne({ term, isActive: true });
  if (existing) return res.status(409).json({ error: 'keyword_exists' });

  const doc = await BlockedKeyword.create({
    term,
    language: body.language as BlockedKeywordLanguage,
    addedBy: userId as string,
    addedAt: new Date(),
    reason: body.reason ?? null,
    isActive: true,
  });
  invalidateBlockListCache();
  res.status(201).json({ id: String(doc._id) });
}

// DELETE /api/admin/comments/keywords/:id — soft-delete a term.
export async function removeKeyword(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(404, 'keyword_not_found');
  const doc = await BlockedKeyword.findById(req.params.id);
  if (!doc) throw httpError(404, 'keyword_not_found');
  if (doc.isActive) {
    doc.isActive = false;
    doc.removedAt = new Date();
    doc.removedBy = userId as string;
    await doc.save();
    invalidateBlockListCache();
  }
  res.status(204).end();
}

// GET /api/admin/users/:userId/comment-history — interleaved feed.
export async function userHistory(req: Request, res: Response) {
  const targetUserId = req.params.userId;
  const { limit } = parsePagination(req.query as Record<string, unknown>, 50, 200);

  const [mirror, activeBan, comments, actions] = await Promise.all([
    User.findOne({ clerkUserId: targetUserId }).select('clerkUserId displayName imageUrl').lean(),
    getActiveCommentBan(targetUserId),
    Comment.find({ authorId: targetUserId }).sort({ createdAt: -1 }).limit(limit),
    ModerationAction.find({ targetUserId }).sort({ createdAt: -1 }).limit(limit),
  ]);

  type HistoryItem = { at: string; kind: string; [k: string]: unknown };
  const items: HistoryItem[] = [];
  for (const c of comments) {
    items.push({ kind: 'comment', at: c.createdAt.toISOString(), comment: serializeAdminComment(c) });
  }
  for (const a of actions) {
    items.push({
      kind: a.type.startsWith('ban') ? 'ban' : a.type === 'warning' ? 'warning' : 'removal',
      at: a.createdAt.toISOString(),
      type: a.type,
      reason: a.reason,
      by: a.actorId,
      commentId: a.commentId ? String(a.commentId) : null,
    });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : -1));

  res.json({
    user: {
      userId: targetUserId,
      displayName: mirror?.displayName ?? 'Resolve reader',
      avatarUrl: mirror?.imageUrl ?? null,
      isCommentingBanned: activeBan !== null,
      activeBan: activeBan
        ? {
            id: String(activeBan._id),
            tier: activeBan.tier,
            activeUntil: activeBan.activeUntil?.toISOString() ?? null,
          }
        : null,
    },
    items: items.slice(0, limit),
  });
}
