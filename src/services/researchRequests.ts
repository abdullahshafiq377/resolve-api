import mongoose from 'mongoose';
import ResearchRequest, { type ResearchRequestDoc } from '../models/ResearchRequest';
import ResearchRequestVote from '../models/ResearchRequestVote';
import Category, { type CategoryDoc } from '../models/Category';
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

export { ResearchRequest };
