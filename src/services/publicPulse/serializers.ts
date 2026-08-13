import type { PollDoc, PollOptionDoc } from '../../models/Poll';

export interface OptionTally {
  id: string;
  text: string;
  order: number;
  // Null when the tally is withheld — see `canSeeTally`. The option itself is
  // always returned; only the numbers are held back, so the client can render
  // the choices without knowing the split.
  count: number | null;
  percentage: number | null;
}

function countFor(poll: PollDoc, option: PollOptionDoc): number {
  return poll.optionVoteCounts?.get(String(option._id)) ?? 0;
}

/**
 * Whether a viewer is entitled to see the numbers behind an option.
 *
 * The product rule is one sentence — a reader sees the tally once they have
 * voted, or once the poll has closed — and this is the only place it is
 * decided. Every public read path calls it; admin reads bypass it.
 *
 * It deters anchoring, it does not keep a secret: a reader can vote and see
 * the tally a moment later. Withholding is about not showing the standings to
 * someone who has not committed to an answer yet.
 */
export function canSeeTally(poll: PollDoc, viewerOptionId: string | null): boolean {
  return poll.status === 'closed' || Boolean(viewerOptionId);
}

export function buildTallies(poll: PollDoc, revealTally = true): OptionTally[] {
  const total = poll.totalVotes || 0;
  return [...poll.options]
    .sort((a, b) => a.order - b.order)
    .map((option) => {
      const count = countFor(poll, option);
      return {
        id: String(option._id),
        text: option.text,
        order: option.order,
        count: revealTally ? count : null,
        percentage: revealTally ? (total > 0 ? Math.round((count / total) * 1000) / 10 : 0) : null,
      };
    });
}

export function serializePublicPoll(poll: PollDoc, viewerOptionId: string | null = null) {
  // `totalVotes` stays visible either way. "1,205 votes" is on the card before
  // the reader votes by design, and the total says nothing about the split.
  const revealTally = canSeeTally(poll, viewerOptionId);
  return {
    id: String(poll._id),
    slug: poll.slug,
    question: poll.question,
    description: poll.description,
    status: poll.status,
    closeDate: poll.closeDate.toISOString(),
    opensAt: poll.opensAt ? poll.opensAt.toISOString() : null,
    totalVotes: poll.totalVotes,
    commentCount: poll.commentCount,
    featured: poll.featured,
    categoryId: poll.categoryId ? String(poll.categoryId) : null,
    category: poll.category,
    categorySlug: poll.categorySlug,
    options: buildTallies(poll, revealTally),
    viewerOptionId,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    publishedAt: poll.publishedAt ? poll.publishedAt.toISOString() : null,
  };
}

export function serializeAdminPoll(poll: PollDoc) {
  return {
    ...serializePublicPoll(poll),
    // Admins are not subject to the public visibility rule — the poll table,
    // the detail chart and the metrics panel all read real numbers whether or
    // not the moderator voted. This overwrites the withheld options above.
    options: buildTallies(poll),
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

/**
 * Tally-only payload for the refresh path and the vote response.
 *
 * `revealTally` defaults to true because the vote write is its main caller —
 * a reader who just voted is entitled to the numbers, and returning them here
 * is what lets the widget render results without a second round-trip. The
 * public GET passes the flag explicitly.
 */
export function serializeResults(poll: PollDoc, revealTally = true) {
  return {
    pollId: String(poll._id),
    totalVotes: poll.totalVotes,
    options: buildTallies(poll, revealTally),
    status: poll.status,
    closeDate: poll.closeDate.toISOString(),
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
  };
}
