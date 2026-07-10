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

// Plan tiers are ordered: free < standard < premium. Slugs used by Clerk's plan
// claim require the `user:` namespace prefix. The legacy `premium_plan` slug is
// still honoured as premium so subscribers from the 2-plan era keep access until
// Clerk migrates them onto the new `premium` plan.
export type PlanTier = 'free' | 'standard' | 'premium';

const TIER_ORDER: PlanTier[] = ['free', 'standard', 'premium'];

const STANDARD_PLAN = 'user:standard';
const PREMIUM_PLAN = 'user:premium';
const LEGACY_PREMIUM_PLAN = 'user:premium_plan';

// True if `tier` is at least `min` in the free < standard < premium ordering.
export function tierAtLeast(tier: PlanTier, min: PlanTier): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(min);
}

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

// Subset of the @clerk/express AuthObject (getAuth(req)) that premium evaluation needs.
export interface PremiumAuth {
  userId?: string | null;
  sessionClaims?: unknown;
  has?: (params: { plan: string }) => boolean;
}

// Authoritative tier resolution (overview §3): read live from Clerk's plan claim
// via has(), PLUS moderator / super admin who inherit the top tier. This is the
// single server-side source of truth — the frontend `usePlanTier()` is for UI
// only and is never trusted. Pass the result of getAuth(req).
export function getTier(auth: PremiumAuth): PlanTier {
  const { userId, sessionClaims, has } = auth;
  if (!userId) return 'free';
  if (isModerator(userId, sessionClaims)) return 'premium';
  if (has && (has({ plan: PREMIUM_PLAN }) || has({ plan: LEGACY_PREMIUM_PLAN }))) {
    return 'premium';
  }
  if (has && has({ plan: STANDARD_PLAN })) return 'standard';
  return 'free';
}

// Premium-only check (e.g. the Max model). Moderators/super admin pass.
export function isPremium(auth: PremiumAuth): boolean {
  return getTier(auth) === 'premium';
}

// Any paid tier (standard or premium). Used by Standard-level features such as
// the Resolve Brief and persistent chat history.
export function hasStandard(auth: PremiumAuth): boolean {
  return tierAtLeast(getTier(auth), 'standard');
}

// Require at least Standard (any paid tier). 401 if signed out, 403 if Free.
export function requireStandard(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (hasStandard(getAuth(req))) {
    next();
    return;
  }
  res.status(403).json({ error: 'forbidden' });
}

// Premium OR moderator OR super admin. Premium is checked against Clerk's live
// plan claim via has() — no metadata mirror, no DB lookup.
export function requirePremium(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (isPremium(getAuth(req))) {
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
