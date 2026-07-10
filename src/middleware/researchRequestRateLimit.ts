import type { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';

// Per-user sliding-window rate limiters for Research Requests, mirroring the
// chatRateLimit pattern. In-memory by design (single instance / dev); swap the
// store for Redis/Atlas on a multi-instance deployment.
//
// Submission has NO limit (client decision — the moderation queue is the gate).
// Voting is permissive; the unique index is the real guard. Admin actions are
// throttled to prevent accidental mass operations.

function makeLimiter(windowMs: number, maxRequests: number) {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();

  function sweep(now: number): void {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, times] of hits) {
      const fresh = times.filter((t) => now - t < windowMs);
      if (fresh.length === 0) hits.delete(key);
      else hits.set(key, fresh);
    }
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const { userId } = getAuth(req);
    if (!userId) {
      next();
      return;
    }
    const now = Date.now();
    sweep(now);
    const times = (hits.get(userId) ?? []).filter((t) => now - t < windowMs);
    if (times.length >= maxRequests) {
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    times.push(now);
    hits.set(userId, times);
    next();
  };
}

// 30 vote/retract actions per minute per user.
export const voteRateLimit = makeLimiter(60_000, 30);
// 60 admin actions per minute per moderator.
export const adminActionRateLimit = makeLimiter(60_000, 60);
