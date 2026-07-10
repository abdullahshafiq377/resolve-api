import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Comment from '../models/Comment';
import CommentVote from '../models/CommentVote';
import CommentReport, { COMMENT_REPORT_REASONS, type CommentReportReason } from '../models/CommentReport';
import User from '../models/User';
import { COMMENT_PARENT_TYPES, type CommentParentType, type CommentDoc } from '../models/Comment';
import { httpError } from '../utils/errors';
import { resolveParentState } from '../services/comments/parents';
import {
  canPostComment,
  canEditOwnComment,
  canDeleteOwnComment,
  canVoteOnComment,
  canReportComment,
  permissionResponse,
} from '../services/comments/permissions';
import { prepareCommentBody } from '../services/comments/content';
import { isBlocked } from '../services/comments/blocklist';
import { resolveMentions } from '../services/comments/mentions';
import { adjustParentCommentCount, adjustReplyCount } from '../services/comments/counters';
import {
  notifyOnComment,
  moderatorRecipients,
  absoluteUrl,
} from '../services/comments/notify';
import { fire } from '../services/notifications/service';
import {
  COMMENT_SORTS,
  type CommentSort,
  parseLimit,
  sortSpec,
  decodeCursor,
  cursorFilter,
  cursorFor,
  getUserVotes,
} from '../services/comments/listing';
import { serializePublicComment, PUBLIC_LIST_STATUSES } from '../lib/serializers/comment';

function parseParent(req: Request): { parentType: CommentParentType; parentId: string } {
  const parentType = req.query.parentType;
  const parentId = req.query.parentId;
  if (
    typeof parentType !== 'string' ||
    !COMMENT_PARENT_TYPES.includes(parentType as CommentParentType) ||
    typeof parentId !== 'string' ||
    !mongoose.Types.ObjectId.isValid(parentId)
  ) {
    throw httpError(400, 'invalid_parent');
  }
  return { parentType: parentType as CommentParentType, parentId };
}

// GET /api/comments — top-level comments for a parent (sorted, cursor-paginated),
// with each returned thread's replies nested as flat items the client trees up.
export async function listComments(req: Request, res: Response) {
  const { userId } = getAuth(req);
  const { parentType, parentId } = parseParent(req);

  const sortKey = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  if (!COMMENT_SORTS.includes(sortKey as CommentSort)) throw httpError(400, 'invalid_query');
  const sort = sortKey as CommentSort;
  const limit = parseLimit(req.query.limit);

  const parent = await resolveParentState(parentType, parentId);
  if (!parent.found) throw httpError(404, 'parent_not_found');

  const parentObjId = new mongoose.Types.ObjectId(parentId);
  const baseFilter: Record<string, unknown> = {
    parentType,
    parentId: parentObjId,
    parentCommentId: null,
    status: { $in: PUBLIC_LIST_STATUSES },
  };

  // Keyset cursor.
  if (typeof req.query.cursor === 'string' && req.query.cursor) {
    const cursor = decodeCursor(req.query.cursor);
    if (!cursor) throw httpError(400, 'invalid_query');
    Object.assign(baseFilter, cursorFilter(sort, cursor));
  }

  // Fetch one extra to detect the next page.
  const roots = await Comment.find(baseFilter)
    .sort(sortSpec(sort))
    .limit(limit + 1);

  const hasMore = roots.length > limit;
  const pageRoots = hasMore ? roots.slice(0, limit) : roots;

  // Replies for the page's threads (chronological under each root).
  const rootIds = pageRoots.map((r) => r._id as mongoose.Types.ObjectId);
  const replies = rootIds.length
    ? await Comment.find({
        rootCommentId: { $in: rootIds },
        level: { $gt: 0 },
        status: { $in: PUBLIC_LIST_STATUSES },
      }).sort({ rootCommentId: 1, level: 1, createdAt: 1 })
    : [];

  const all = [...pageRoots, ...replies];
  const userVotes = await getUserVotes(
    userId,
    all.map((c) => c._id as mongoose.Types.ObjectId),
  );

  const nextCursor =
    hasMore && pageRoots.length
      ? cursorFor(sort, pageRoots[pageRoots.length - 1] as never)
      : null;

  res.json({
    items: all.map((c) => serializePublicComment(c, { userVotes })),
    nextCursor,
    // Cursor mode: total intentionally omitted (use GET /api/comments/count).
    total: null,
  });
}

// POST /api/comments — create a top-level comment or a reply.
export async function createComment(req: Request, res: Response) {
  const auth = getAuth(req);
  const userId = auth.userId;
  if (!userId) return res.status(401).json({ error: 'not_authenticated' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const parentType = body.parentType;
  const parentId = body.parentId;
  const rawParentCommentId = body.parentCommentId ?? null;

  if (
    typeof parentType !== 'string' ||
    !COMMENT_PARENT_TYPES.includes(parentType as CommentParentType) ||
    typeof parentId !== 'string' ||
    !mongoose.Types.ObjectId.isValid(parentId)
  ) {
    throw httpError(400, 'invalid_parent');
  }
  const pType = parentType as CommentParentType;

  const parent = await resolveParentState(pType, parentId);
  if (!parent.found) throw httpError(404, 'parent_not_found');

  const perm = await canPostComment(auth, parent);
  if (!perm.allowed) {
    const r = permissionResponse(perm);
    return res.status(r.status).json(r.body);
  }

  const prepared = prepareCommentBody(body.body);
  if (!prepared.ok) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'body', reason: prepared.error } });
  }

  // Threading.
  let level: 0 | 1 | 2 = 0;
  let parentComment: CommentDoc | null = null;
  if (rawParentCommentId !== null) {
    if (typeof rawParentCommentId !== 'string' || !mongoose.Types.ObjectId.isValid(rawParentCommentId)) {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'parentCommentId', reason: 'invalid' } });
    }
    parentComment = await Comment.findById(rawParentCommentId);
    if (
      !parentComment ||
      parentComment.parentType !== pType ||
      String(parentComment.parentId) !== parentId
    ) {
      throw httpError(404, 'parent_not_found');
    }
    if (parentComment.status !== 'visible' && parentComment.status !== 'deleted_by_user') {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'parentCommentId', reason: 'invalid' } });
    }
    if (parentComment.level >= 2) {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'parentCommentId', reason: 'depth_exceeded' } });
    }
    level = (parentComment.level + 1) as 1 | 2;
  }

  const held = await isBlocked(prepared.value.bodyText);
  const status = held ? 'held' : 'visible';

  const mirror = await User.findOne({ clerkUserId: userId }).select('displayName imageUrl').lean();
  const mentions = await resolveMentions(prepared.value.bodyText, userId);

  const _id = new mongoose.Types.ObjectId();
  const isRoot = level === 0;
  const rootCommentId = isRoot ? _id : (parentComment!.rootCommentId as mongoose.Types.ObjectId);
  const path = isRoot ? `,${_id},` : `${parentComment!.path}${_id},`;

  const doc = await Comment.create({
    _id,
    parentType: pType,
    parentId: new mongoose.Types.ObjectId(parentId),
    parentCommentId: parentComment ? parentComment._id : null,
    level,
    rootCommentId,
    path,
    authorId: userId,
    authorDisplayName: mirror?.displayName || 'Resolve reader',
    authorAvatarUrl: mirror?.imageUrl ?? null,
    authorTier: 'premium',
    body: prepared.value.body,
    bodyText: prepared.value.bodyText,
    mentions,
    status,
    visibleAt: status === 'visible' ? new Date() : null,
  });

  if (status === 'visible') {
    await adjustParentCommentCount(pType, parentId, 1);
    if (!isRoot) await adjustReplyCount(rootCommentId, 1);

    // Fire-and-forget notifications (never block the response).
    void notifyOnComment(
      {
        parentType: pType,
        parentId: new mongoose.Types.ObjectId(parentId),
        parentSlug: parent.slug,
        parentTitle: parent.title,
        commentId: _id,
        actorName: doc.authorDisplayName,
        excerpt: prepared.value.bodyText.slice(0, 140),
      },
      { replyToAuthorId: parentComment?.authorId ?? null, mentions, actorId: userId },
    ).catch(() => {
      /* notification failures are non-fatal */
    });
  }

  res.status(201).json({
    comment: serializePublicComment(doc, { userVotes: new Map() }),
    status,
  });
}

async function loadComment(id: string): Promise<CommentDoc> {
  if (!mongoose.Types.ObjectId.isValid(id)) throw httpError(404, 'comment_not_found');
  const comment = await Comment.findById(id);
  if (!comment) throw httpError(404, 'comment_not_found');
  return comment;
}

// PATCH /api/comments/:id — edit own comment within the 5-minute window.
export async function editComment(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!auth.userId) return res.status(401).json({ error: 'not_authenticated' });

  const comment = await loadComment(req.params.id);
  const perm = await canEditOwnComment(auth, comment);
  if (!perm.allowed) {
    const r = permissionResponse(perm);
    return res.status(r.status).json(r.body);
  }

  const prepared = prepareCommentBody((req.body ?? {}).body);
  if (!prepared.ok) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'body', reason: prepared.error } });
  }

  const previousMentionIds = new Set(comment.mentions.map((m) => m.userId));
  const mentions = await resolveMentions(prepared.value.bodyText, auth.userId);

  comment.body = prepared.value.body;
  comment.bodyText = prepared.value.bodyText;
  comment.mentions = mentions;
  comment.edited = true;
  comment.editedAt = new Date();
  await comment.save();

  // Notify only newly-added mentions.
  const newMentions = mentions.filter((m) => !previousMentionIds.has(m.userId));
  if (newMentions.length && comment.status === 'visible') {
    const parent = await resolveParentState(comment.parentType, String(comment.parentId));
    void notifyOnComment(
      {
        parentType: comment.parentType,
        parentId: comment.parentId,
        parentSlug: parent.slug,
        parentTitle: parent.title,
        commentId: comment._id as mongoose.Types.ObjectId,
        actorName: comment.authorDisplayName,
        excerpt: prepared.value.bodyText.slice(0, 140),
      },
      { replyToAuthorId: null, mentions: newMentions, actorId: auth.userId },
    ).catch(() => {});
  }

  res.json({ comment: serializePublicComment(comment, { userVotes: new Map() }) });
}

// DELETE /api/comments/:id — author delete (soft if it has replies, else hard).
export async function deleteComment(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!auth.userId) return res.status(401).json({ error: 'not_authenticated' });

  const comment = await loadComment(req.params.id);
  const perm = await canDeleteOwnComment(auth, comment);
  if (!perm.allowed) {
    const r = permissionResponse(perm);
    return res.status(r.status).json(r.body);
  }

  const wasVisible = comment.status === 'visible';
  const hasReplies = await Comment.exists({ parentCommentId: comment._id });

  if (hasReplies) {
    // Soft delete: keep the row as a placeholder, blank the content + identity.
    comment.status = 'deleted_by_user';
    comment.body = { type: 'doc', content: [] };
    comment.bodyText = '';
    comment.mentions = [];
    await comment.save();
  } else {
    await Comment.deleteOne({ _id: comment._id });
    await CommentVote.deleteMany({ commentId: comment._id });
  }

  // Counter upkeep: any visible comment counts toward the parent; replies count
  // toward their root.
  if (wasVisible) {
    await adjustParentCommentCount(comment.parentType, comment.parentId, -1);
    if (comment.level > 0) await adjustReplyCount(comment.rootCommentId, -1);
  }

  res.status(204).end();
}

// PUT /api/comments/:id/vote — set the requester's vote (1 | -1 | 0).
export async function voteComment(req: Request, res: Response) {
  const auth = getAuth(req);
  const perm = await canVoteOnComment(auth);
  if (!perm.allowed) {
    const r = permissionResponse(perm);
    return res.status(r.status).json(r.body);
  }
  const userId = auth.userId as string;

  const raw = (req.body ?? {}).vote;
  const vote = raw === 1 || raw === -1 || raw === 0 ? raw : null;
  if (vote === null) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'vote', reason: 'invalid' } });
  }

  const comment = await loadComment(req.params.id);

  const existing = await CommentVote.findOne({ commentId: comment._id, userId });
  const prev = existing ? existing.vote : 0;

  if (prev === vote) {
    // Idempotent no-op.
    return res.json({
      upvotes: comment.upvotes,
      downvotes: comment.downvotes,
      netScore: comment.netScore,
      userVote: vote === 0 ? null : vote,
    });
  }

  let incUp = 0;
  let incDown = 0;
  if (prev === 1) incUp -= 1;
  if (prev === -1) incDown -= 1;
  if (vote === 1) incUp += 1;
  if (vote === -1) incDown += 1;

  if (vote === 0) {
    await CommentVote.deleteOne({ commentId: comment._id, userId });
  } else {
    await CommentVote.findOneAndUpdate(
      { commentId: comment._id, userId },
      { $set: { vote } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  const updated = await Comment.findByIdAndUpdate(
    comment._id,
    { $inc: { upvotes: incUp, downvotes: incDown } },
    { new: true },
  );
  if (!updated) throw httpError(404, 'comment_not_found');
  updated.netScore = updated.upvotes - updated.downvotes;
  await updated.save();

  res.json({
    upvotes: updated.upvotes,
    downvotes: updated.downvotes,
    netScore: updated.netScore,
    userVote: vote === 0 ? null : vote,
  });
}

// POST /api/comments/:id/report — report a comment.
export async function reportComment(req: Request, res: Response) {
  const auth = getAuth(req);
  const perm = await canReportComment(auth);
  if (!perm.allowed) {
    const r = permissionResponse(perm);
    return res.status(r.status).json(r.body);
  }
  const userId = auth.userId as string;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const reason = body.reason;
  if (typeof reason !== 'string' || !COMMENT_REPORT_REASONS.includes(reason as CommentReportReason)) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'reason', reason: 'invalid' } });
  }
  let context: string | null = null;
  if (body.context != null) {
    if (typeof body.context !== 'string' || body.context.length > 500) {
      return res
        .status(400)
        .json({ error: 'validation_error', details: { field: 'context', reason: 'too_long' } });
    }
    context = body.context.trim() || null;
  }

  const comment = await loadComment(req.params.id);
  if (comment.authorId === userId) {
    return res.status(403).json({ error: 'self_report_forbidden' });
  }

  let report;
  try {
    report = await CommentReport.create({
      commentId: comment._id,
      reporterId: userId,
      reason: reason as CommentReportReason,
      context,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return res.status(409).json({ error: 'already_reported' });
    }
    throw err;
  }

  // Notify moderators (in-app + email).
  const parent = await resolveParentState(comment.parentType, String(comment.parentId));
  const link = '/admin/comments/reports';
  const ctaUrl = absoluteUrl(link);
  const excerpt = comment.bodyText.slice(0, 140);
  void (async () => {
    const recipients = await moderatorRecipients();
    for (const m of recipients) {
      await fire({
        userId: m.userId,
        type: 'report_submitted',
        requestId: null,
        commentId: comment._id as mongoose.Types.ObjectId,
        parentType: comment.parentType,
        parentId: comment.parentId,
        title: `New report: ${reason} on ${parent.title}`,
        body: excerpt,
        link,
        email: {
          to: m.email,
          template: 'report_submitted',
          vars: { requestTitle: parent.title, ctaUrl, detail: context ?? excerpt },
        },
      });
    }
  })().catch(() => {});

  res.status(201).json({ reportId: String(report._id) });
}

// GET /api/users/mentions — autocomplete for @mentions (signed-in, not comment-banned).
export async function mentionSearch(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!auth.userId) return res.status(401).json({ error: 'not_authenticated' });

  const { getActiveCommentBan } = await import('../services/comments/bans');
  if (await getActiveCommentBan(auth.userId)) {
    return res.status(403).json({ error: 'commenting_restricted', reason: 'ban' });
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q.length < 1 || q.length > 50) throw httpError(400, 'invalid_query');
  const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 8;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 20) : 8;

  const prefix = new RegExp(`^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const users = await User.find({ deletedAt: null, displayName: prefix })
    .select('clerkUserId displayName imageUrl')
    .limit(limit)
    .lean();

  res.json({
    items: users.map((u) => ({
      userId: u.clerkUserId,
      displayName: u.displayName ?? '',
      avatarUrl: u.imageUrl ?? null,
    })),
  });
}

// GET /api/comments/ban-status — the signed-in user's commenting-ban state (for the banner).
export async function banStatus(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!auth.userId) return res.json({ banned: false });
  const { getActiveCommentBan } = await import('../services/comments/bans');
  const ban = await getActiveCommentBan(auth.userId);
  res.json({
    banned: ban !== null,
    tier: ban?.tier ?? null,
    activeUntil: ban?.activeUntil ? ban.activeUntil.toISOString() : null,
  });
}

// GET /api/comments/count — visible comment count for a parent (count badge).
export async function commentCount(req: Request, res: Response) {
  const { parentType, parentId } = parseParent(req);
  const count = await Comment.countDocuments({
    parentType,
    parentId: new mongoose.Types.ObjectId(parentId),
    status: 'visible',
  });
  res.json({ count });
}
