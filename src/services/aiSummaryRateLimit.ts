import { httpError } from '../utils/errors';

const WINDOW_MS = 60 * 1000;
const LIMIT = Math.max(1, Number(process.env.AI_SUMMARY_GENERATION_LIMIT_PER_MINUTE) || 6);

const hits = new Map<string, number[]>();

export function assertAiSummaryRateLimit(userId: string): void {
  const now = Date.now();
  const since = now - WINDOW_MS;
  const recent = (hits.get(userId) ?? []).filter((time) => time > since);
  if (recent.length >= LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    const err = httpError(429, 'ai_summary_rate_limited');
    Object.assign(err, { retryAfterSeconds });
    throw err;
  }
  recent.push(now);
  hits.set(userId, recent);
}
