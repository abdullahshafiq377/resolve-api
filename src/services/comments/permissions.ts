import { isModerator, isPremium, type PremiumAuth } from '../../middleware/auth';
import type { CommentDoc } from '../../models/Comment';
import { getActiveCommentBan } from './bans';
import type { ParentState, FrozenReason } from './parents';

// Edit window: 5 minutes from the original post, strict (editing does not extend it).
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

export interface PermissionResult {
  allowed: boolean;
  // Error code surfaced by the route on denial.
  reason?:
    | 'not_authenticated'
    | 'commenting_restricted'
    | 'commenting_frozen'
    | 'edit_window_closed'
    | 'not_author'
    | 'forbidden';
  // Sub-reason for commenting_restricted / commenting_frozen.
  detail?: 'ban' | 'no_subscription' | FrozenReason;
  // Populated when denied for an active ban, for the client banner.
  activeUntil?: Date | null;
}

const ALLOW: PermissionResult = { allowed: true };

// Read is always allowed (Clerk-banned users are stopped site-wide upstream).
export function canReadComments(): PermissionResult {
  return ALLOW;
}

// Post a comment: signed-in premium (or mod/super-admin), no active comment ban,
// parent in an open state.
export async function canPostComment(
  auth: PremiumAuth,
  parent: ParentState,
): Promise<PermissionResult> {
  if (!auth.userId) return { allowed: false, reason: 'not_authenticated' };
  if (!isPremium(auth)) {
    return { allowed: false, reason: 'commenting_restricted', detail: 'no_subscription' };
  }
  const ban = await getActiveCommentBan(auth.userId);
  if (ban) {
    return {
      allowed: false,
      reason: 'commenting_restricted',
      detail: 'ban',
      activeUntil: ban.activeUntil,
    };
  }
  if (!parent.open) {
    return {
      allowed: false,
      reason: 'commenting_frozen',
      detail: parent.frozenReason ?? 'parent_not_published',
    };
  }
  return ALLOW;
}

// Vote: signed-in premium (or mod/super-admin), no active comment ban.
export async function canVoteOnComment(auth: PremiumAuth): Promise<PermissionResult> {
  if (!auth.userId) return { allowed: false, reason: 'not_authenticated' };
  if (!isPremium(auth)) {
    return { allowed: false, reason: 'commenting_restricted', detail: 'no_subscription' };
  }
  const ban = await getActiveCommentBan(auth.userId);
  if (ban) {
    return {
      allowed: false,
      reason: 'commenting_restricted',
      detail: 'ban',
      activeUntil: ban.activeUntil,
    };
  }
  return ALLOW;
}

// Report: any signed-in user (free included), no active comment ban.
export async function canReportComment(auth: PremiumAuth): Promise<PermissionResult> {
  if (!auth.userId) return { allowed: false, reason: 'not_authenticated' };
  const ban = await getActiveCommentBan(auth.userId);
  if (ban) {
    return {
      allowed: false,
      reason: 'commenting_restricted',
      detail: 'ban',
      activeUntil: ban.activeUntil,
    };
  }
  return ALLOW;
}

// Edit own comment: author, within the strict 5-minute window, no active ban.
export async function canEditOwnComment(
  auth: PremiumAuth,
  comment: Pick<CommentDoc, 'authorId' | 'createdAt'>,
): Promise<PermissionResult> {
  if (!auth.userId) return { allowed: false, reason: 'not_authenticated' };
  if (comment.authorId !== auth.userId) return { allowed: false, reason: 'not_author' };
  const ban = await getActiveCommentBan(auth.userId);
  if (ban) {
    return { allowed: false, reason: 'commenting_restricted', detail: 'ban', activeUntil: ban.activeUntil };
  }
  if (Date.now() - new Date(comment.createdAt).getTime() > EDIT_WINDOW_MS) {
    return { allowed: false, reason: 'edit_window_closed' };
  }
  return ALLOW;
}

// Delete own comment: author, no active ban (no time window — delete is anytime).
export async function canDeleteOwnComment(
  auth: PremiumAuth,
  comment: Pick<CommentDoc, 'authorId'>,
): Promise<PermissionResult> {
  if (!auth.userId) return { allowed: false, reason: 'not_authenticated' };
  if (comment.authorId !== auth.userId) return { allowed: false, reason: 'not_author' };
  const ban = await getActiveCommentBan(auth.userId);
  if (ban) {
    return { allowed: false, reason: 'commenting_restricted', detail: 'ban', activeUntil: ban.activeUntil };
  }
  return ALLOW;
}

export function canModerateComments(auth: PremiumAuth): PermissionResult {
  if (!auth.userId) return { allowed: false, reason: 'not_authenticated' };
  return isModerator(auth.userId, auth.sessionClaims)
    ? ALLOW
    : { allowed: false, reason: 'forbidden' };
}

export function canManageBlockList(auth: PremiumAuth): PermissionResult {
  return canModerateComments(auth);
}

// Map a denied permission to its HTTP status + response body (matches the API spec
// error codes). Only call when `allowed === false`.
export function permissionResponse(perm: PermissionResult): {
  status: number;
  body: Record<string, unknown>;
} {
  switch (perm.reason) {
    case 'not_authenticated':
      return { status: 401, body: { error: 'not_authenticated' } };
    case 'commenting_restricted':
      return {
        status: 403,
        body: {
          error: 'commenting_restricted',
          reason: perm.detail === 'ban' ? 'ban' : 'no_subscription',
          ...(perm.detail === 'ban'
            ? { activeUntil: perm.activeUntil ? perm.activeUntil.toISOString() : null }
            : {}),
        },
      };
    case 'commenting_frozen':
      return { status: 409, body: { error: 'commenting_frozen', reason: perm.detail } };
    case 'edit_window_closed':
      return { status: 403, body: { error: 'edit_window_closed' } };
    case 'not_author':
      return { status: 403, body: { error: 'not_author' } };
    default:
      return { status: 403, body: { error: 'forbidden' } };
  }
}
