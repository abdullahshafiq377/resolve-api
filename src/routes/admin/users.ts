import express, { type Request, type Response } from 'express';
import { clerk } from '../../config/clerk';
import { requireModerator, requireSuperAdmin } from '../../middleware/auth';
import {
  softDeleteUser,
  findActiveUser,
  listActiveModerators,
  toAuthorSummary,
  buildDisplayName,
  type AuthorSummary,
} from '../../services/users';
import { httpError } from '../../utils/errors';

const router = express.Router();
const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

// Throws if the target is the super admin or another moderator (cannot be touched
// by ban/unban). A missing target surfaces as 404 via the central error handler
// (clerk.users.getUser throws a Clerk API error mapped in utils/errors).
async function assertNotPrivileged(targetId: string): Promise<void> {
  if (targetId === SUPER_ADMIN_USER_ID) {
    throw httpError(400, 'cannot_modify_super_admin');
  }
  const target = await clerk.users.getUser(targetId);
  if (target.publicMetadata?.role === 'moderator') {
    throw httpError(400, 'cannot_modify_moderator');
  }
}

// GET /api/admin/users — list users (moderator-or-above)
router.get(
  '/',
  requireModerator,
  wrap(async (req, res) => {
    const { query, limit = '20', offset = '0' } = req.query as Record<string, string | undefined>;
    const result = await clerk.users.getUserList({
      query: query || undefined,
      limit: Number(limit),
      offset: Number(offset),
    });
    res.json({ data: result.data, totalCount: result.totalCount });
  }),
);

// GET /api/admin/users/moderators — selectable article authors (moderator-or-above).
// Includes the env-derived super admin plus all active role='moderator' users.
router.get(
  '/moderators',
  requireModerator,
  wrap(async (_req, res) => {
    const mods = await listActiveModerators();
    const summaries: AuthorSummary[] = mods.map(toAuthorSummary);

    // Super admin is env-derived (not necessarily role='moderator'); add explicitly.
    if (SUPER_ADMIN_USER_ID && !summaries.some((s) => s.id === SUPER_ADMIN_USER_ID)) {
      const saRow = await findActiveUser(SUPER_ADMIN_USER_ID);
      if (saRow) {
        summaries.push(toAuthorSummary(saRow));
      } else {
        // Mirror row not present yet — fall back to Clerk directly.
        try {
          const sa = await clerk.users.getUser(SUPER_ADMIN_USER_ID);
          summaries.push({
            id: sa.id,
            displayName: buildDisplayName({
              first_name: sa.firstName,
              last_name: sa.lastName,
              username: sa.username,
              email_addresses: sa.emailAddresses?.map((e) => ({ email_address: e.emailAddress })),
            }),
            imageUrl: sa.imageUrl ?? null,
          });
        } catch {
          // Super admin not resolvable in Clerk — omit rather than fail the list.
        }
      }
    }

    summaries.sort((a, b) => a.displayName.localeCompare(b.displayName));
    res.json({ data: summaries });
  }),
);

// POST /api/admin/users/:id/role — set publicMetadata.role (super admin only)
router.post(
  '/:id/role',
  requireSuperAdmin,
  wrap(async (req, res) => {
    if (req.params.id === SUPER_ADMIN_USER_ID) {
      return res.status(400).json({ error: 'cannot_modify_super_admin' });
    }
    const { role } = req.body as { role: 'moderator' | null };
    if (role !== 'moderator' && role !== null) {
      return res.status(400).json({ error: 'invalid_role' });
    }
    // null = demotion → clear the role. Tier is not a role (premium is read live
    // from Clerk's plan claim, BACKEND_BILLING.md), so a demoted user simply has
    // no role. Pass explicit null (Clerk strips undefined, but stores null).
    const nextRole = role === 'moderator' ? 'moderator' : null;
    const updated = await clerk.users.updateUserMetadata(req.params.id, {
      publicMetadata: { role: nextRole },
    });
    res.json(updated);
  }),
);

// POST /api/admin/users/:id/ban — ban a regular user (moderator-or-above)
router.post(
  '/:id/ban',
  requireModerator,
  wrap(async (req, res) => {
    await assertNotPrivileged(req.params.id);
    await clerk.users.banUser(req.params.id);
    res.json({ ok: true });
  }),
);

// POST /api/admin/users/:id/unban — unban a regular user (moderator-or-above)
router.post(
  '/:id/unban',
  requireModerator,
  wrap(async (req, res) => {
    await assertNotPrivileged(req.params.id);
    await clerk.users.unbanUser(req.params.id);
    res.json({ ok: true });
  }),
);

// DELETE /api/admin/users/:id — permanently delete a Clerk user (super admin only)
router.delete(
  '/:id',
  requireSuperAdmin,
  wrap(async (req, res) => {
    if (req.params.id === SUPER_ADMIN_USER_ID) {
      return res.status(400).json({ error: 'cannot_delete_super_admin' });
    }
    await clerk.users.deleteUser(req.params.id);
    // Cascade to the local mirror as a soft delete (§6) — preserves FK integrity
    // for articles authored by this user. (The user.deleted webhook also fires.)
    await softDeleteUser(req.params.id);
    res.status(204).end();
  }),
);

export default router;
