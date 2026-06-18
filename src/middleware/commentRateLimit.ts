import type { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';

// Per-user sliding-window rate limiters for Comments, mirroring
// researchRequestRateLimit. In-memory by design (single instance / dev) — swap
// the store for Redis/Atlas on a multi-instance deployment. Limits are env-tunable.

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

const FIVE_MIN = 5 * 60_000;
const POST = Number(process.env.COMMENTS_RATE_LIMIT_POST_PER_5M) || 30;
const VOTE = Number(process.env.COMMENTS_RATE_LIMIT_VOTE_PER_5M) || 120;
const REPORT = Number(process.env.COMMENTS_RATE_LIMIT_REPORT_PER_5M) || 10;
const MENTION = Number(process.env.COMMENTS_RATE_LIMIT_MENTION_PER_MIN) || 60;

export const postRateLimit = makeLimiter(FIVE_MIN, POST);
export const voteRateLimit = makeLimiter(FIVE_MIN, VOTE);
export const reportRateLimit = makeLimiter(FIVE_MIN, REPORT);
export const mentionRateLimit = makeLimiter(60_000, MENTION);
