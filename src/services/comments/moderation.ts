import mongoose from 'mongoose';
import Comment, { type CommentDoc } from '../../models/Comment';
import CommentVote from '../../models/CommentVote';
import CommentReport from '../../models/CommentReport';
import ModerationAction from '../../models/ModerationAction';
import { adjustParentCommentCount, adjustReplyCount } from './counters';
import { fire } from '../notifications/service';

// Approve a held comment → visible. Increments counters and logs the action.
export async function approveHeldComment(comment: CommentDoc, actorId: string): Promise<void> {
  if (comment.status !== 'held') return;
  comment.status = 'visible';
  comment.visibleAt = new Date();
  await comment.save();

  await adjustParentCommentCount(comment.parentType, comment.parentId, 1);
  if (comment.level > 0) await adjustReplyCount(comment.rootCommentId, 1);

  await ModerationAction.create({
    type: 'comment_approved',
    actorId,
    targetUserId: comment.authorId,
    commentId: comment._id,
  });
}

// Deny (hard-delete) a held comment. Logs the action.
export async function denyHeldComment(comment: CommentDoc, actorId: string): Promise<void> {
  await Comment.deleteOne({ _id: comment._id });
  await CommentVote.deleteMany({ commentId: comment._id });
  await ModerationAction.create({
    type: 'comment_denied',
    actorId,
    targetUserId: comment.authorId,
    commentId: comment._id,
  });
}

// Remove a visible comment → [removed by moderator]. Identity + body blanked,
// reply tree preserved, counters adjusted, action logged.
export async function removeComment(
  comment: CommentDoc,
  actorId: string,
  reason: string | null,
): Promise<void> {
  if (comment.status === 'removed') return;
  const wasVisible = comment.status === 'visible';

  comment.status = 'removed';
  comment.removedAt = new Date();
  comment.removedBy = actorId;
  comment.body = { type: 'doc', content: [] };
  comment.bodyText = '';
  comment.mentions = [];
  await comment.save();

  if (wasVisible) {
    await adjustParentCommentCount(comment.parentType, comment.parentId, -1);
    if (comment.level > 0) await adjustReplyCount(comment.rootCommentId, -1);
  }

  await ModerationAction.create({
    type: 'comment_removed',
    actorId,
    targetUserId: comment.authorId,
    commentId: comment._id,
    reason: reason ?? null,
  });
}

// Resolve all open reports on a comment and notify the reporters (in-app only).
export async function resolveReports(
  commentId: mongoose.Types.ObjectId,
  actorId: string,
  outcome: 'resolved_removed' | 'resolved_no_action',
  link: string,
): Promise<void> {
  const open = await CommentReport.find({ commentId, status: 'open' }).select('reporterId').lean();
  if (!open.length) return;

  await CommentReport.updateMany(
    { commentId, status: 'open' },
    { $set: { status: outcome, resolvedBy: actorId, resolvedAt: new Date() } },
  );

  const reporterIds = [...new Set(open.map((r) => r.reporterId))];
  const body =
    outcome === 'resolved_removed'
      ? 'Your report was reviewed — the comment was removed.'
      : 'Your report was reviewed — no action taken.';

  for (const reporterId of reporterIds) {
    await fire({
      userId: reporterId,
      type: 'report_resolved',
      requestId: null,
      commentId,
      title: 'Your report was reviewed',
      body,
      link,
    }).catch(() => {});
  }
}
