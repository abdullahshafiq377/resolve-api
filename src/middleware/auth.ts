import { clerkMiddleware, requireAuth, getAuth } from '@clerk/express';
import type { Request, Response, NextFunction } from 'express';

const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

if (!SUPER_ADMIN_USER_ID) {
  // Fail loud at boot rather than silently treating no one as super admin.
  console.warn('[auth] SUPER_ADMIN_USER_ID is not set — no user will resolve as super admin.');
}

// Mount once at the top of the Express app. Populates req.auth on every request;
// does NOT reject unauthenticated requests.
export const clerkAuth = clerkMiddleware();

// Use on routes that require ANY signed-in user.
export const requireSignedIn = requireAuth();

// Alias kept for spec parity.
export const requireAuthenticated = requireAuth();

// Only 'moderator' is mirrored into publicMetadata now. Premium tier is NOT a
// role — it is read live from Clerk's plan claim (BACKEND_BILLING.md).
type Role = 'moderator';

interface RoleClaims {
  metadata?: { role?: Role };
}

// Slug used by Clerk's plan claim; the `user:` namespace prefix is required.
const PREMIUM_PLAN = 'user:premium_plan';

export function isSuperAdmin(userId: string | null | undefined): boolean {
  return !!userId && !!SUPER_ADMIN_USER_ID && userId === SUPER_ADMIN_USER_ID;
}

export function isModerator(userId: string | null | undefined, sessionClaims: unknown): boolean {
  if (isSuperAdmin(userId)) return true;
  const role = (sessionClaims as RoleClaims)?.metadata?.role;
  return role === 'moderator';
}

// Moderator OR super admin.
export function requireModerator(req: Request, res: Response, next: NextFunction): void {
  const { userId, sessionClaims } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isModerator(userId, sessionClaims)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

// Premium OR moderator OR super admin (scaffold for future paid endpoints).
// Premium is checked against Clerk's live plan claim via has() — no metadata
// mirror, no DB lookup. Moderators/super admin pass implicitly.
export function requirePremium(req: Request, res: Response, next: NextFunction): void {
  const { userId, sessionClaims, has } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (isModerator(userId, sessionClaims)) {
    next();
    return;
  }
  if (has && has({ plan: PREMIUM_PLAN })) {
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden' });
}

// Super admin only (role mgmt + user deletion).
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isSuperAdmin(userId)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}
