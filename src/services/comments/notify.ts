import { Types } from 'mongoose';
import User from '../../models/User';
import { fire } from '../notifications/service';
import { parentPath } from './parents';
import type { CommentParentType, CommentMention } from '../../models/Comment';

const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';

export function commentInAppLink(
  parentType: CommentParentType,
  slug: string,
  commentId: Types.ObjectId | string,
): string {
  return `${parentPath(parentType, slug)}#comment-${String(commentId)}`;
}

export function absoluteUrl(path: string): string {
  return `${FRONTEND_ORIGIN}${path}`;
}

const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

// Moderator + super-admin recipients (userId + email) for moderator notifications.
export async function moderatorRecipients(): Promise<{ userId: string; email: string | null }[]> {
  const ids = new Set<string>();
  const mods = await User.find({ role: 'moderator', deletedAt: null })
    .select('clerkUserId email')
    .lean();
  const out: { userId: string; email: string | null }[] = [];
  for (const m of mods) {
    ids.add(m.clerkUserId);
    out.push({ userId: m.clerkUserId, email: m.email ?? null });
  }
  if (SUPER_ADMIN_USER_ID && !ids.has(SUPER_ADMIN_USER_ID)) {
    const sa = await User.findOne({ clerkUserId: SUPER_ADMIN_USER_ID }).select('email').lean();
    out.push({ userId: SUPER_ADMIN_USER_ID, email: sa?.email ?? null });
  }
  return out;
}

// Look up mirrored emails for a set of users.
export async function emailsFor(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (!userIds.length) return map;
  const users = await User.find({ clerkUserId: { $in: userIds } })
    .select('clerkUserId email')
    .lean();
  for (const u of users) map.set(u.clerkUserId, u.email ?? null);
  return map;
}

interface NotifyContext {
  parentType: CommentParentType;
  parentId: Types.ObjectId;
  parentSlug: string;
  parentTitle: string;
  commentId: Types.ObjectId;
  actorName: string;
  excerpt: string;
}

// Fan out reply + mention notifications (in-app + email). Reply goes to the
// replied-to author (if not the actor); mentions go to each mentioned user. A
// user mentioned AND replied-to is de-duplicated to the reply only.
export async function notifyOnComment(
  ctx: NotifyContext,
  opts: { replyToAuthorId?: string | null; mentions: CommentMention[]; actorId: string },
): Promise<void> {
  const link = commentInAppLink(ctx.parentType, ctx.parentSlug, ctx.commentId);
  const ctaUrl = absoluteUrl(link);

  const recipients = new Set<string>();
  const replyTo =
    opts.replyToAuthorId && opts.replyToAuthorId !== opts.actorId ? opts.replyToAuthorId : null;
  if (replyTo) recipients.add(replyTo);
  const mentionTargets = opts.mentions
    .map((m) => m.userId)
    .filter((id) => id !== opts.actorId && id !== replyTo);
  for (const id of mentionTargets) recipients.add(id);

  const emails = await emailsFor([...recipients]);

  if (replyTo) {
    await fire({
      userId: replyTo,
      type: 'comment_reply',
      requestId: null,
      commentId: ctx.commentId,
      parentType: ctx.parentType,
      parentId: ctx.parentId,
      title: `New reply to your comment on ${ctx.parentTitle}`,
      body: `${ctx.actorName}: ${ctx.excerpt}`,
      link,
      email: {
        to: emails.get(replyTo) ?? null,
        template: 'comment_reply',
        vars: { requestTitle: ctx.parentTitle, ctaUrl, detail: ctx.excerpt },
      },
    });
  }

  for (const userId of mentionTargets) {
    await fire({
      userId,
      type: 'comment_mention',
      requestId: null,
      commentId: ctx.commentId,
      parentType: ctx.parentType,
      parentId: ctx.parentId,
      title: `${ctx.actorName} mentioned you on ${ctx.parentTitle}`,
      body: ctx.excerpt,
      link,
      email: {
        to: emails.get(userId) ?? null,
        template: 'comment_mention',
        vars: { requestTitle: ctx.parentTitle, ctaUrl, detail: ctx.excerpt },
      },
    });
  }
}
