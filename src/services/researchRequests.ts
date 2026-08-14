import mongoose from 'mongoose';
import ResearchRequest, { type ResearchRequestDoc } from '../models/ResearchRequest';
import ResearchRequestVote from '../models/ResearchRequestVote';
import Category, { type CategoryDoc } from '../models/Category';
import type { PlanTier } from '../middleware/auth';
import { pakistanMonthWindow } from './briefDates';
import { findUsersByIds } from './users';
import type { UserDoc } from '../models/User';

// A request is publicly visible iff it has been approved and not rejected.
export const PUBLIC_VISIBILITY_FILTER = {
  approvedAt: { $ne: null },
  status: { $ne: 'rejected' },
} as const;

export function isPubliclyVisible(request: ResearchRequestDoc): boolean {
  return request.approvedAt !== null && request.status !== 'rejected';
}

// Build the lookup maps the serializers need, in a fixed number of queries.
export async function buildLookupMaps(requests: ResearchRequestDoc[]): Promise<{
  userMap: Map<string, UserDoc>;
  categoryMap: Map<string, CategoryDoc>;
}> {
  const submitterIds = [...new Set(requests.map((r) => r.submitterId))];
  const categoryIds = [
    ...new Set(requests.filter((r) => r.categoryId).map((r) => String(r.categoryId))),
  ];

  const [users, categories] = await Promise.all([
    findUsersByIds(submitterIds),
    categoryIds.length ? Category.find({ _id: { $in: categoryIds } }) : Promise.resolve([]),
  ]);

  const userMap = new Map(users.map((u) => [u.clerkUserId, u]));
  const categoryMap = new Map(categories.map((c) => [String(c._id), c]));
  return { userMap, categoryMap };
}

// Which of the given request ids has this user upvoted? Empty set for anonymous.
export async function getVotedRequestIds(
  userId: string | null | undefined,
  requestIds: mongoose.Types.ObjectId[],
): Promise<Set<string>> {
  if (!userId || requestIds.length === 0) return new Set();
  const votes = await ResearchRequestVote.find({
    userId,
    requestId: { $in: requestIds },
  }).select('requestId');
  return new Set(votes.map((v) => String(v.requestId)));
}

// Resolve the upvoters of a request to { userId, email } for notification fan-out.
export async function getUpvoterRecipients(
  requestId: mongoose.Types.ObjectId,
): Promise<{ userId: string; email: string | null }[]> {
  const votes = await ResearchRequestVote.find({ requestId }).select('userId');
  const userIds = votes.map((v) => v.userId);
  const users = await findUsersByIds(userIds);
  const emailById = new Map(users.map((u) => [u.clerkUserId, u.email]));
  return userIds.map((userId) => ({ userId, email: emailById.get(userId) ?? null }));
}

export function parsePagination(query: Record<string, unknown>, defaultLimit = 20, maxLimit = 50) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(query.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function buildPagination(total: number, page: number, limit: number) {
  return { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
}

// ── Monthly submission allowance ───────────────────────────────────────────
//
// The published per-plan allowance, and the single place it is counted. The
// account meter and the `submit` guard both read this, so the number a reader
// is shown is the number that is enforced.
//
// The month is the Pakistan calendar month, matching the account overview's
// counters (`pakistanMonthWindow`), so "resets on the 1st" means the 1st in
// Karachi rather than wherever the reader happens to be.
//
// `null` = unlimited (premium). Free and Core matching at 6 is a settled
// business decision, not an oversight — Core's differentiator on Research
// Requests is upvoting, not volume. See AM20 in FINDINGS-RESOLVED.md before
// "fixing" the duplication.
export const RESEARCH_REQUEST_ALLOWANCE: Record<PlanTier, number | null> = {
  free: 6,
  core: 6,
  premium: null,
};

export interface RequestAllowance {
  used: number;
  limit: number | null;
  remaining: number | null;
  month: string;
  resetAt: string;
}

// Count what this user has submitted in the current Pakistan month and pair it
// with their tier's cap. Unlimited tiers still get a truthful `used`.
export async function getRequestAllowance(
  userId: string,
  tier: PlanTier,
): Promise<RequestAllowance> {
  const month = pakistanMonthWindow();
  const used = await ResearchRequest.countDocuments({
    submitterId: userId,
    createdAt: { $gte: month.start, $lt: month.end },
  });
  const limit = RESEARCH_REQUEST_ALLOWANCE[tier];
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    month: month.key,
    resetAt: month.end.toISOString(),
  };
}

export { ResearchRequest };
