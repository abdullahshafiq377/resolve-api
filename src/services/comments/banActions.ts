import mongoose from 'mongoose';
import CommentBan, { type CommentBanTier } from '../../models/CommentBan';
import ModerationAction from '../../models/ModerationAction';
import { fire } from '../notifications/service';
import { emailsFor, absoluteUrl } from './notify';

const TIER_DURATIONS_MS: Record<Exclude<CommentBanTier, 'permanent'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const TIER_LABEL: Record<CommentBanTier, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  permanent: 'permanently',
};

function tierActionType(tier: CommentBanTier) {
  return `ban_${tier === 'permanent' ? 'permanent' : tier}` as
    | 'ban_24h'
    | 'ban_7d'
    | 'ban_30d'
    | 'ban_permanent';
}

async function notifyTarget(
  userId: string,
  type: 'comment_warning' | 'comment_banned' | 'comment_ban_lifted',
  title: string,
  body: string,
  detail: string | null,
  template: 'comment_warning' | 'comment_banned' | 'comment_ban_lifted',
): Promise<void> {
  const emails = await emailsFor([userId]);
  await fire({
    userId,
    type,
    requestId: null,
    title,
    body,
    link: '/account',
    email: {
      to: emails.get(userId) ?? null,
      template,
      vars: { requestTitle: title, ctaUrl: absoluteUrl('/account'), detail: detail ?? undefined },
    },
  }).catch(() => {});
}

export async function issueWarning(
  targetUserId: string,
  actorId: string,
  reason: string,
  commentId?: string | null,
): Promise<string> {
  const action = await ModerationAction.create({
    type: 'warning',
    actorId,
    targetUserId,
    commentId: commentId && mongoose.Types.ObjectId.isValid(commentId) ? commentId : null,
    reason,
  });
  await notifyTarget(
    targetUserId,
    'comment_warning',
    'You received a warning',
    reason,
    reason,
    'comment_warning',
  );
  return String(action._id);
}

export async function issueCommentBan(
  targetUserId: string,
  actorId: string,
  tier: CommentBanTier,
  reason: string | null,
  relatedCommentId?: string | null,
): Promise<{ id: string; activeUntil: Date | null }> {
  const activeUntil =
    tier === 'permanent' ? null : new Date(Date.now() + TIER_DURATIONS_MS[tier]);

  const ban = await CommentBan.create({
    userId: targetUserId,
    tier,
    reason,
    issuedBy: actorId,
    issuedAt: new Date(),
    activeUntil,
    isActive: true,
  });

  await ModerationAction.create({
    type: tierActionType(tier),
    actorId,
    targetUserId,
    commentId:
      relatedCommentId && mongoose.Types.ObjectId.isValid(relatedCommentId) ? relatedCommentId : null,
    reason,
    metadata: { tier, activeUntil },
  });

  const window =
    tier === 'permanent'
      ? 'permanently'
      : `until ${activeUntil!.toLocaleString()}`;
  await notifyTarget(
    targetUserId,
    'comment_banned',
    `Your commenting is restricted ${TIER_LABEL[tier]}`,
    `Your commenting is restricted ${window}.`,
    reason,
    'comment_banned',
  );

  return { id: String(ban._id), activeUntil };
}

export async function liftCommentBan(
  targetUserId: string,
  banId: string,
  actorId: string,
  reason?: string | null,
): Promise<{ id: string; liftedAt: Date }> {
  if (!mongoose.Types.ObjectId.isValid(banId)) {
    throw Object.assign(new Error('ban_not_found'), { status: 404 });
  }
  const ban = await CommentBan.findOne({ _id: banId, userId: targetUserId });
  if (!ban) throw Object.assign(new Error('ban_not_found'), { status: 404 });

  const now = new Date();
  ban.liftedAt = now;
  ban.liftedBy = actorId;
  ban.isActive = false;
  ban.activeUntil = ban.activeUntil ?? now;
  await ban.save();

  await ModerationAction.create({
    type: 'ban_lifted',
    actorId,
    targetUserId,
    reason: reason ?? null,
    metadata: { previousTier: ban.tier },
  });

  await notifyTarget(
    targetUserId,
    'comment_ban_lifted',
    'Your commenting restriction was lifted',
    'You can comment again on Resolve.',
    reason ?? null,
    'comment_ban_lifted',
  );

  return { id: String(ban._id), liftedAt: now };
}
