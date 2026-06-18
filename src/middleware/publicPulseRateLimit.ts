import type { Request, Response, NextFunction } from 'express';
import { getAuth } from '@clerk/express';

const WINDOW_MS = 60_000;
const LIMIT = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

export function publicPulseVoteRateLimit(req: Request, res: Response, next: NextFunction): void {
  const { userId } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const now = Date.now();
  const entry = hits.get(userId);
  if (!entry || entry.resetAt <= now) {
    hits.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= LIMIT) {
    res.status(429).json({ error: 'too_many_requests' });
    return;
  }

  entry.count += 1;
  next();
}
