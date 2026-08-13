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
  loadCommentAuthors,
  loadAuthorIdentities,
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
  BLOCKED_KEYWORD_MATCH_MODES,
  type BlockedKeywordLanguage,
  type BlockedKeywordMatchMode,
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
  const authors = await loadCommentAuthors(docs);
  res.json({
    items: docs.map((c) => serializeAdminComment(c, authors)),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// POST /api/admin/comments/:id/approve — publish a held comment.
export async function approveHeld(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const comment = await loadComment(req.params.id);
  if (comment.status !== 'held') throw httpError(400, 'not_held');
  await approveHeldComment(comment, userId as string);
  res.json({ comment: serializeAdminComment(comment, await loadCommentAuthors([comment])) });
}

// POST /api/admin/comments/:id/deny — hard-delete a held comment.
export async function denyHeld(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const comment = await loadComment(req.params.id);
  if (comment.status !== 'held') throw httpError(400, 'not_held');
  await denyHeldComment(comment, userId as string);
  res.status(204).end();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Columns the moderation queue can be ordered by. `reason` and `comment` sort on
// the fields the table actually renders, so the order always matches the page.
const QUEUE_SORT_FIELDS: Record<string, string> = {
  reports: 'reportCount',
  comment: 'bodyText',
  reason: 'reasonKey',
  newest: 'createdAt',
};

/**
 * GET /api/admin/comments/queue — one moderation list holding both halves of the
 * queue: comments held by the block list and visible comments carrying at least
 * one open report.
 *
 * A row's `reason` is the block list for held comments, and otherwise the reason
 * on the *earliest* open report — the one that put the comment in the queue.
 * Taking the earliest (rather than the most common) keeps the displayed reason
 * and the `reason` sort in agreement.
 */
export async function listQueue(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 10, 100);
  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'reports';
  const sortField = QUEUE_SORT_FIELDS[sortKey] ?? QUEUE_SORT_FIELDS.reports;
  const direction: 1 | -1 = req.query.order === 'asc' ? 1 : -1;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : '';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

  // Held comments are never `visible`, so the two halves of the queue are
  // separated by comment status first and by the open-report count second.
  const preMatch: Record<string, unknown> = {};
  if (statusFilter === 'held') preMatch.status = 'held';
  else if (statusFilter === 'reported') preMatch.status = 'visible';
  else preMatch.status = { $in: ['held', 'visible'] };
  if (search) preMatch.bodyText = { $regex: escapeRegex(search), $options: 'i' };

  const postMatch =
    statusFilter === 'held'
      ? {}
      : statusFilter === 'reported'
        ? { reportCount: { $gt: 0 } }
        : { $or: [{ status: 'held' }, { reportCount: { $gt: 0 } }] };

  const [result] = await Comment.aggregate([
    { $match: preMatch },
    {
      $lookup: {
        from: CommentReport.collection.name,
        let: { cid: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $and: [{ $eq: ['$commentId', '$$cid'] }, { $eq: ['$status', 'open'] }] },
            },
          },
          { $sort: { createdAt: 1 } },
          { $project: { reason: 1, createdAt: 1 } },
        ],
        as: 'openReports',
      },
    },
    {
      $addFields: {
        reportCount: { $size: '$openReports' },
        queueStatus: { $cond: [{ $eq: ['$status', 'held'] }, 'held', 'reported'] },
        reasonKey: {
          $cond: [
            { $eq: ['$status', 'held'] },
            'keyword_match',
            { $ifNull: [{ $arrayElemAt: ['$openReports.reason', 0] }, 'other'] },
          ],
        },
      },
    },
    ...(Object.keys(postMatch).length ? [{ $match: postMatch }] : []),
    {
      $facet: {
        items: [
          // `_id` breaks ties so paging stays stable across requests.
          { $sort: { [sortField]: direction, _id: 1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              bodyText: 1,
              status: 1,
              parentType: 1,
              parentId: 1,
              authorId: 1,
              authorDisplayName: 1,
              authorAvatarUrl: 1,
              authorTier: 1,
              createdAt: 1,
              reportCount: 1,
              queueStatus: 1,
              reasonKey: 1,
            },
          },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const docs = (result?.items ?? []) as Array<Record<string, any>>;
  const total = (result?.total?.[0]?.count ?? 0) as number;

  // This list is built by aggregation rather than through the serializer, so the
  // mirror join has to be repeated here — the projected author fields are the
  // post-time snapshot and go stale when a member changes their avatar or name.
  const identities = await loadAuthorIdentities(docs.map((doc) => doc.authorId as string));

  // Public deep link per row, for the table's "open on site" action.
  const items = await Promise.all(
    docs.map(async (doc) => {
      const parent = await resolveParentState(doc.parentType, String(doc.parentId));
      const live = identities.get(doc.authorId as string);
      return {
        id: String(doc._id),
        bodyText: doc.bodyText as string,
        status: doc.queueStatus as 'held' | 'reported',
        reason: doc.reasonKey as string,
        reportCount: doc.reportCount as number,
        author: {
          userId: doc.authorId as string,
          displayName: live?.displayName ?? (doc.authorDisplayName as string),
          avatarUrl: live ? live.avatarUrl : ((doc.authorAvatarUrl ?? null) as string | null),
          tier: doc.authorTier as string,
        },
        parentType: doc.parentType as string,
        parentTitle: parent.title,
        link: parent.found
          ? `${parentPath(doc.parentType, parent.slug)}#comment-${String(doc._id)}`
          : null,
        createdAt: (doc.createdAt as Date).toISOString(),
      };
    }),
  );

  res.json({
    items,
    pagination: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  });
}

const BULK_ACTIONS = ['approve', 'remove', 'mark_safe', 'warn', 'ban'] as const;
type BulkAction = (typeof BULK_ACTIONS)[number];

/** Cap on one bulk call, so a runaway selection can't fan out unbounded writes. */
const BULK_LIMIT = 100;

/**
 * POST /api/admin/comments/bulk — apply one moderation action to a selection.
 *
 * `approve` publishes held comments and dismisses any open reports; `remove`
 * blanks the comment and resolves its reports as removed; `mark_safe` only
 * dismisses reports; `warn` and `ban` act on the comments' authors, deduplicated
 * so one author is never warned or banned twice in a single call.
 */
export async function bulkModerate(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const actorId = userId as string;
  const body = (req.body ?? {}) as {
    ids?: unknown;
    action?: unknown;
    reason?: unknown;
    tier?: unknown;
  };

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'ids', reason: 'required' } });
  }
  if (body.ids.length > BULK_LIMIT) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'ids', reason: 'too_many' } });
  }
  if (typeof body.action !== 'string' || !BULK_ACTIONS.includes(body.action as BulkAction)) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'action', reason: 'invalid' } });
  }
  const action = body.action as BulkAction;
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;

  if (action === 'warn' && !reason) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'reason', reason: 'required' } });
  }
  if (action === 'ban' && (typeof body.tier !== 'string' || !COMMENT_BAN_TIERS.includes(body.tier as CommentBanTier))) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'tier', reason: 'invalid' } });
  }

  const ids = (body.ids as unknown[])
    .filter((id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id));
  const comments = await Comment.find({ _id: { $in: ids } });
  if (!comments.length) throw httpError(404, 'comment_not_found');

  let affected = 0;
  let skipped = 0;

  // Author-level actions run once per author, whatever the selection looks like.
  if (action === 'warn' || action === 'ban') {
    const seen = new Map<string, string>();
    for (const comment of comments) {
      if (!seen.has(comment.authorId)) seen.set(comment.authorId, String(comment._id));
    }
    for (const [authorId, commentId] of seen) {
      if (action === 'warn') await issueWarning(authorId, actorId, reason as string, commentId);
      else await issueCommentBan(authorId, actorId, body.tier as CommentBanTier, reason, commentId);
      affected += 1;
    }
    return res.json({ action, affected, skipped });
  }

  for (const comment of comments) {
    const parent = await resolveParentState(comment.parentType, String(comment.parentId));
    const link = `${parentPath(comment.parentType, parent.slug)}#comment-${String(comment._id)}`;
    const commentId = comment._id as mongoose.Types.ObjectId;

    if (action === 'approve') {
      if (comment.status === 'held') await approveHeldComment(comment, actorId);
      else if (comment.status !== 'visible') {
        skipped += 1;
        continue;
      }
      await resolveReports(commentId, actorId, 'resolved_no_action', link);
      affected += 1;
      continue;
    }

    if (action === 'remove') {
      if (comment.status === 'removed' || comment.status === 'deleted_by_user') {
        skipped += 1;
        continue;
      }
      await removeComment(comment, actorId, reason);
      await resolveReports(commentId, actorId, 'resolved_removed', link);
      affected += 1;
      continue;
    }

    // mark_safe — dismiss the reports, leave the comment exactly as it is.
    await resolveReports(commentId, actorId, 'resolved_no_action', link);
    affected += 1;
  }

  res.json({ action, affected, skipped });
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
      comment: serializeAdminComment(comment, await loadCommentAuthors([comment])),
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
    comment: serializeAdminComment(comment, await loadCommentAuthors([comment])),
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
      comment: serializePublicComment(comment, {
        userVotes: new Map(),
        authors: await loadCommentAuthors([comment]),
      }),
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

interface KeywordAuthor {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

function serializeKeyword(
  k: {
    _id: unknown;
    term: string;
    language: string;
    matchMode?: string;
    addedBy: string;
    addedAt: Date;
    removedAt: Date | null;
    removedBy: string | null;
    isActive: boolean;
    hitCount?: number;
    lastHitAt?: Date | null;
  },
  authors?: Map<string, KeywordAuthor>,
) {
  return {
    id: String(k._id),
    term: k.term,
    language: k.language,
    // Rows added before the field existed read as the default.
    matchMode: k.matchMode ?? 'word',
    // The table shows who added a term, so the raw Clerk id is resolved against
    // the local user mirror. An id with no mirror row still renders as a person.
    addedBy: authors?.get(k.addedBy) ?? {
      userId: k.addedBy,
      displayName: 'Resolve moderator',
      avatarUrl: null,
    },
    addedAt: k.addedAt.toISOString(),
    removedAt: k.removedAt ? k.removedAt.toISOString() : null,
    removedBy: k.removedBy,
    isActive: k.isActive,
    hitCount: k.hitCount ?? 0,
    lastHitAt: k.lastHitAt ? k.lastHitAt.toISOString() : null,
  };
}

/** Clerk id -> display name + avatar, for the block list's "Added by" column. */
async function keywordAuthorMap(userIds: string[]): Promise<Map<string, KeywordAuthor>> {
  const map = new Map<string, KeywordAuthor>();
  const unique = [...new Set(userIds)];
  if (!unique.length) return map;
  const users = await User.find({ clerkUserId: { $in: unique } })
    .select('clerkUserId displayName imageUrl')
    .lean();
  for (const u of users) {
    map.set(u.clerkUserId, {
      userId: u.clerkUserId,
      displayName: u.displayName || 'Resolve moderator',
      avatarUrl: u.imageUrl ?? null,
    });
  }
  return map;
}

// Columns the block-list table can be ordered by, mapped to the field each one
// actually renders so the order always matches the page.
const KEYWORD_SORT_FIELDS: Record<string, string> = {
  term: 'term',
  hits: 'hitCount',
  lastHit: 'lastHitAt',
  added: 'addedAt',
};

// GET /api/admin/comments/keywords — block-list entries.
// Filters on language and status, searches the term, and sorts on any of the
// table's sortable columns.
export async function listKeywords(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 50, 200);
  const filter: Record<string, unknown> = {};
  if (typeof req.query.language === 'string' && BLOCKED_KEYWORD_LANGUAGES.includes(req.query.language as BlockedKeywordLanguage)) {
    filter.language = req.query.language;
  }
  // Terms are paused rather than removed now, so the status filter reads as
  // active/inactive. `removed` is still accepted as the old name for inactive.
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  if (status === 'active') filter.isActive = true;
  else if (status === 'inactive' || status === 'removed') filter.isActive = false;

  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  if (search) filter.term = { $regex: escapeRegex(search), $options: 'i' };

  const sortField =
    KEYWORD_SORT_FIELDS[typeof req.query.sort === 'string' ? req.query.sort : ''] ?? 'addedAt';
  const direction = req.query.order === 'asc' ? 1 : -1;
  // `addedAt` breaks ties so paging stays stable when a column has repeats.
  const sort: Record<string, 1 | -1> =
    sortField === 'addedAt' ? { addedAt: direction } : { [sortField]: direction, addedAt: -1 };

  const [docs, total] = await Promise.all([
    BlockedKeyword.find(filter).sort(sort).skip(skip).limit(limit).lean(),
    BlockedKeyword.countDocuments(filter),
  ]);
  const authors = await keywordAuthorMap(docs.map((d) => d.addedBy));
  res.json({
    items: docs.map((doc) => serializeKeyword(doc, authors)),
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// POST /api/admin/comments/keywords — add a block-list term.
export async function addKeyword(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const body = (req.body ?? {}) as {
    term?: string;
    language?: string;
    matchMode?: string;
  };
  const term = typeof body.term === 'string' ? body.term.trim().toLowerCase() : '';
  if (!term) {
    return res.status(400).json({ error: 'validation_error', details: { field: 'term', reason: 'required' } });
  }
  if (typeof body.language !== 'string' || !BLOCKED_KEYWORD_LANGUAGES.includes(body.language as BlockedKeywordLanguage)) {
    return res.status(400).json({ error: 'validation_error', details: { field: 'language', reason: 'invalid' } });
  }
  if (body.matchMode !== undefined && !BLOCKED_KEYWORD_MATCH_MODES.includes(body.matchMode as BlockedKeywordMatchMode)) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'matchMode', reason: 'invalid' } });
  }
  // Terms are unique across the whole list, not just its active half: a paused
  // term still occupies the name, and re-adding it would leave two rows fighting
  // over one word. Reactivate the existing row instead.
  const existing = await BlockedKeyword.findOne({ term });
  if (existing) return res.status(409).json({ error: 'keyword_exists' });

  const doc = await BlockedKeyword.create({
    term,
    language: body.language as BlockedKeywordLanguage,
    matchMode: (body.matchMode as BlockedKeywordMatchMode) ?? 'word',
    addedBy: userId as string,
    addedAt: new Date(),
    isActive: true,
  });
  invalidateBlockListCache();
  res.status(201).json({ id: String(doc._id) });
}

// PATCH /api/admin/comments/keywords/:id — edit a term, or pause/resume it.
// Pausing takes a term out of matching without losing its hit history, which is
// what the table's Active switch does.
export async function updateKeyword(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(404, 'keyword_not_found');
  const doc = await BlockedKeyword.findById(req.params.id);
  if (!doc) throw httpError(404, 'keyword_not_found');

  const body = (req.body ?? {}) as {
    term?: string;
    language?: string;
    matchMode?: string;
    isActive?: boolean;
  };

  if (body.term !== undefined) {
    const term = typeof body.term === 'string' ? body.term.trim().toLowerCase() : '';
    if (!term) {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'term', reason: 'required' } });
    }
    if (term !== doc.term) {
      const clash = await BlockedKeyword.findOne({ term, _id: { $ne: doc._id } });
      if (clash) return res.status(409).json({ error: 'keyword_exists' });
      doc.term = term;
    }
  }

  if (body.language !== undefined) {
    if (!BLOCKED_KEYWORD_LANGUAGES.includes(body.language as BlockedKeywordLanguage)) {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'language', reason: 'invalid' } });
    }
    doc.language = body.language as BlockedKeywordLanguage;
  }

  if (body.matchMode !== undefined) {
    if (!BLOCKED_KEYWORD_MATCH_MODES.includes(body.matchMode as BlockedKeywordMatchMode)) {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'matchMode', reason: 'invalid' } });
    }
    doc.matchMode = body.matchMode as BlockedKeywordMatchMode;
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'isActive', reason: 'invalid' } });
    }
    doc.isActive = body.isActive;
    // removedAt/removedBy now read as "paused at, by whom".
    doc.removedAt = body.isActive ? null : new Date();
    doc.removedBy = body.isActive ? null : (userId as string);
  }

  await doc.save();
  invalidateBlockListCache();
  const authors = await keywordAuthorMap([doc.addedBy]);
  res.json(serializeKeyword(doc.toObject(), authors));
}

// DELETE /api/admin/comments/keywords/:id — permanently remove a term.
// Deleting is final; a term that should only stop matching for now is paused
// through PATCH instead.
export async function removeKeyword(req: Request, res: Response) {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(404, 'keyword_not_found');
  const result = await BlockedKeyword.deleteOne({ _id: req.params.id });
  if (!result.deletedCount) throw httpError(404, 'keyword_not_found');
  invalidateBlockListCache();
  res.status(204).end();
}

const KEYWORD_BULK_ACTIONS = ['activate', 'deactivate', 'delete'] as const;
type KeywordBulkAction = (typeof KEYWORD_BULK_ACTIONS)[number];

// POST /api/admin/comments/keywords/bulk — apply one action to a selection.
export async function bulkKeywords(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const body = (req.body ?? {}) as { ids?: unknown; action?: unknown };
  const action = body.action as KeywordBulkAction;
  if (!KEYWORD_BULK_ACTIONS.includes(action)) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'action', reason: 'invalid' } });
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter(
        (id): id is string => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id),
      )
    : [];
  if (!ids.length) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'ids', reason: 'required' } });
  }

  let affected = 0;
  if (action === 'delete') {
    affected = (await BlockedKeyword.deleteMany({ _id: { $in: ids } })).deletedCount ?? 0;
  } else {
    const isActive = action === 'activate';
    const result = await BlockedKeyword.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          isActive,
          removedAt: isActive ? null : new Date(),
          removedBy: isActive ? null : (userId as string),
        },
      },
    );
    affected = result.modifiedCount ?? 0;
  }
  invalidateBlockListCache();
  res.json({ action, affected, skipped: ids.length - affected });
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
  const authors = await loadCommentAuthors(comments);
  for (const c of comments) {
    items.push({
      kind: 'comment',
      at: c.createdAt.toISOString(),
      comment: serializeAdminComment(c, authors),
    });
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
