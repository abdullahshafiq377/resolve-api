import type { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';

// Per-user sliding-window rate limiter for POST /api/chat (Phase 3). Distinct
// from the daily free-tier limit: this guards against bursts for ALL users
// (premium included) and returns reason:'rate_limit' (no upgrade prompt).
//
// In-memory by design — adequate for a single instance / dev. On a multi-instance
// or serverless deployment this is per-process and should be backed by Redis/Atlas
// for a global window; the window math here is the contract, the store is swappable.
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;

const hits = new Map<string, number[]>();

// Opportunistic cleanup so the map doesn't grow unbounded for one-off users.
let lastSweep = Date.now();
function sweep(now: number): void {
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [key, times] of hits) {
    const fresh = times.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) hits.delete(key);
    else hits.set(key, fresh);
  }
}

export function chatRateLimit(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  if (!userId) {
    // Auth is enforced upstream; if we somehow get here unauthenticated, let the
    // route's requireAuth handle the 401 rather than rate-limiting an anon key.
    next();
    return;
  }

  const now = Date.now();
  sweep(now);

  const times = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= MAX_REQUESTS) {
    res.status(429).json({ error: 'rate_limited', upgrade: false, reason: 'rate_limit' });
    return;
  }
  times.push(now);
  hits.set(userId, times);
  next();
}
