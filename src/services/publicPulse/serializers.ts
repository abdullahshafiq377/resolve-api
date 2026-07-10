import type { PollDoc, PollOptionDoc } from '../../models/Poll';

export interface OptionTally {
  id: string;
  text: string;
  order: number;
  count: number;
  percentage: number;
}

function countFor(poll: PollDoc, option: PollOptionDoc): number {
  return poll.optionVoteCounts?.get(String(option._id)) ?? 0;
}

export function buildTallies(poll: PollDoc): OptionTally[] {
  const total = poll.totalVotes || 0;
  return [...poll.options]
    .sort((a, b) => a.order - b.order)
    .map((option) => {
      const count = countFor(poll, option);
      return {
        id: String(option._id),
        text: option.text,
        order: option.order,
        count,
        percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
      };
    });
}

export function serializePublicPoll(poll: PollDoc, viewerOptionId: string | null = null) {
  return {
    id: String(poll._id),
    slug: poll.slug,
    question: poll.question,
    description: poll.description,
    status: poll.status,
    closeDate: poll.closeDate.toISOString(),
    opensAt: poll.opensAt ? poll.opensAt.toISOString() : null,
    resultsMode: poll.resultsMode,
    totalVotes: poll.totalVotes,
    commentCount: poll.commentCount,
    featured: poll.featured,
    categoryId: poll.categoryId ? String(poll.categoryId) : null,
    category: poll.category,
    categorySlug: poll.categorySlug,
    options: buildTallies(poll),
    viewerOptionId,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    publishedAt: poll.publishedAt ? poll.publishedAt.toISOString() : null,
  };
}

export function serializeAdminPoll(poll: PollDoc) {
  return {
    ...serializePublicPoll(poll),
    createdBy: poll.createdBy,
    createdAt: poll.createdAt.toISOString(),
    lastEditedBy: poll.lastEditedBy,
    updatedAt: poll.updatedAt.toISOString(),
    publishedBy: poll.publishedBy,
    publishedAt: poll.publishedAt ? poll.publishedAt.toISOString() : null,
    closedBy: poll.closedBy,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    lastSystemTransitionAt: poll.lastSystemTransitionAt
      ? poll.lastSystemTransitionAt.toISOString()
      : null,
  };
}

export function serializeResults(poll: PollDoc) {
  return {
    pollId: String(poll._id),
    totalVotes: poll.totalVotes,
    options: buildTallies(poll),
    status: poll.status,
    closeDate: poll.closeDate.toISOString(),
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    resultsMode: poll.resultsMode,
  };
}
