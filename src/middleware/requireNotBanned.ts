import type { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';
import { clerk } from '../config/clerk';

// Rejects banned users with 403 `banned`. Bans are Clerk-native (see
// routes/admin/users.ts → clerk.users.banUser). A banned user's session is
// normally revoked by Clerk, but we check explicitly so write endpoints return a
// clear `banned` code rather than a generic 401.
//
// Mount AFTER requireSignedIn. A short in-memory TTL cache avoids a Clerk API
// round-trip on every write for the same user within the window.
const TTL_MS = 30_000;
const cache = new Map<string, { banned: boolean; at: number }>();

export async function requireNotBanned(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId } = getAuth(req);
  if (!userId) {
    // requireSignedIn should have run first; defend anyway.
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && now - cached.at < TTL_MS) {
    if (cached.banned) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    next();
    return;
  }

  try {
    const user = await clerk.users.getUser(userId);
    const banned = Boolean(user.banned);
    cache.set(userId, { banned, at: now });
    if (banned) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    next();
  } catch {
    // If Clerk lookup fails, fail open on the ban check (the request is still
    // authenticated). The action's own auth has already passed.
    next();
  }
}

// Invalidate the cache when a user's ban state changes (called by the ban/unban
// admin endpoints so the new state takes effect immediately).
export function invalidateBanCache(userId: string): void {
  cache.delete(userId);
}
