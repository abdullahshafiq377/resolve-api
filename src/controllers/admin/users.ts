import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import { clerk } from '../../config/clerk';
import { isSuperAdmin, type PlanTier } from '../../middleware/auth';
import { invalidateBanCache } from '../../middleware/requireNotBanned';
import { COMMENT_BAN_TIERS, type CommentBanTier } from '../../models/CommentBan';
import { issueCommentBan, issueWarning } from '../../services/comments/banActions';
import {
  invalidateAdminUserCache,
  listAdminUsers,
  type AdminUserListParams,
  type UserSortKey,
  type UserStatus,
} from '../../services/adminUsers';
import { softDeleteUser } from '../../services/users';
import { purgeUserResearchData } from '../../services/userResearchCascade';

const STATUSES: UserStatus[] = ['active', 'warned', 'banned', 'frozen'];
const SORT_KEYS: UserSortKey[] = ['user', 'tier', 'role', 'status', 'joined'];
const TIERS: PlanTier[] = ['free', 'core', 'premium'];

// Bulk actions the users table can run on a selection. `freeze`/`unfreeze` are the
// Clerk-level account ban; `comment_ban` is the tiered commenting restriction.
export const BULK_USER_ACTIONS = [
  'warn',
  'comment_ban',
  'freeze',
  'unfreeze',
  'delete',
] as const;
export type BulkUserAction = (typeof BULK_USER_ACTIONS)[number];

// Same ceiling as the comments queue's bulk endpoint.
const BULK_LIMIT = 100;

function pick<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === 'string' && (allowed as string[]).includes(value)
    ? (value as T)
    : undefined;
}

// GET /api/admin/users — the merged admin users index.
export async function listUsers(req: Request, res: Response) {
  const q = req.query as Record<string, string | undefined>;
  const params: AdminUserListParams = {
    search: q.search ?? q.query,
    status: pick(q.status, STATUSES),
    role: pick(q.role, ['moderator', 'reader']),
    tier: pick(q.tier, TIERS),
    sort: pick(q.sort, SORT_KEYS),
    order: pick(q.order, ['asc', 'desc']),
    page: q.page ? Number(q.page) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
  };
  res.json(await listAdminUsers(params));
}

/**
 * POST /api/admin/users/bulk — run one moderation action over a selection.
 *
 * Privileged targets (the super admin, moderators, the acting moderator) are
 * counted as skipped rather than failing the batch, so a select-all never dead-ends
 * on a row the caller was never allowed to touch.
 */
export async function bulkUsers(req: Request, res: Response) {
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
  const action = pick(body.action, [...BULK_USER_ACTIONS]);
  if (!action) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'action', reason: 'invalid' } });
  }
  // Deleting an account stays super-admin-only, as the single-user route is.
  if (action === 'delete' && !isSuperAdmin(actorId)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
  if (action === 'warn' && !reason) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'reason', reason: 'required' } });
  }
  const banTier = pick(body.tier, [...COMMENT_BAN_TIERS]) as CommentBanTier | undefined;
  if (action === 'comment_ban' && !banTier) {
    return res
      .status(400)
      .json({ error: 'validation_error', details: { field: 'tier', reason: 'invalid' } });
  }

  const ids = [...new Set((body.ids as unknown[]).filter((id): id is string => typeof id === 'string'))];

  let affected = 0;
  let skipped = 0;

  for (const id of ids) {
    if (id === actorId || isSuperAdmin(id)) {
      skipped += 1;
      continue;
    }

    let target;
    try {
      target = await clerk.users.getUser(id);
    } catch {
      // Gone from Clerk between the list and the action.
      skipped += 1;
      continue;
    }
    // Moderators are only touchable by the role endpoint, matching the per-user
    // ban/unban guard. Delete is the one exception: it is super-admin-only and
    // removing a moderator's account is a deliberate super-admin act.
    if (target.publicMetadata?.role === 'moderator' && action !== 'delete') {
      skipped += 1;
      continue;
    }

    switch (action) {
      case 'warn':
        await issueWarning(id, actorId, reason as string);
        break;
      case 'comment_ban':
        await issueCommentBan(id, actorId, banTier as CommentBanTier, reason);
        break;
      case 'freeze':
        if (target.banned) {
          skipped += 1;
          continue;
        }
        await clerk.users.banUser(id);
        await purgeUserResearchData(id);
        invalidateBanCache(id);
        break;
      case 'unfreeze':
        if (!target.banned) {
          skipped += 1;
          continue;
        }
        await clerk.users.unbanUser(id);
        invalidateBanCache(id);
        break;
      case 'delete':
        await clerk.users.deleteUser(id);
        // Soft-delete the mirror so articles authored by this user keep their FK.
        await softDeleteUser(id);
        await purgeUserResearchData(id);
        break;
    }
    invalidateAdminUserCache(id);
    affected += 1;
  }

  invalidateAdminUserCache();
  res.json({ action, affected, skipped });
}
