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

type Role = 'moderator' | 'premium_user' | 'free_user';

interface RoleClaims {
  metadata?: { role?: Role };
}

export function isSuperAdmin(userId: string | null | undefined): boolean {
  return !!userId && !!SUPER_ADMIN_USER_ID && userId === SUPER_ADMIN_USER_ID;
}

export function isModerator(userId: string | null | undefined, sessionClaims: unknown): boolean {
  if (isSuperAdmin(userId)) return true;
  const role = (sessionClaims as RoleClaims)?.metadata?.role;
  return role === 'moderator';
}

export function isPremium(userId: string | null | undefined, sessionClaims: unknown): boolean {
  if (isModerator(userId, sessionClaims)) return true;
  const role = (sessionClaims as RoleClaims)?.metadata?.role;
  return role === 'premium_user';
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
export function requirePremium(req: Request, res: Response, next: NextFunction): void {
  const { userId, sessionClaims } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isPremium(userId, sessionClaims)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
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
