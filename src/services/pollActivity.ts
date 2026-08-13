import mongoose from 'mongoose';
import type { ActivityAction } from '../models/Activity';
import type { PollDoc, PollStatus } from '../models/Poll';
import type { ActivityInput } from './activity';

/**
 * Drafts of the events a Public Pulse write produces, before the entity
 * envelope and actor are attached. Same shape as the article drafts — the poll
 * controller builds a list, then hands it to `toPollActivity`.
 */
export type PollActivityDraft = { action: ActivityAction; metadata?: unknown };

/** Option text in display order — what the timeline compares between saves. */
function optionTexts(poll: PollDoc): string[] {
  return [...poll.options].sort((a, b) => a.order - b.order).map((option) => option.text);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * A poll has one legal source per target status, so the phrasing can be
 * specific rather than a generic "status changed".
 */
export function diffPollStatus(from: PollStatus, to: PollStatus): PollActivityDraft[] {
  if (from === to) return [];
  const metadata = { from, to };
  if (to === 'open') return [{ action: 'published', metadata }];
  if (to === 'scheduled') return [{ action: 'scheduled', metadata }];
  if (to === 'closed') return [{ action: 'closed', metadata }];
  if (from === 'scheduled' && to === 'draft') return [{ action: 'schedule_cancelled', metadata }];
  return [{ action: 'status_changed', metadata }];
}

export interface PollUpdateDiff {
  /** Field values read off the poll before the edit was applied. */
  before: {
    question: string;
    description: string;
    closeDate: Date;
    category: string;
    options: string[];
  };
  /** The saved document. */
  after: PollDoc;
  /** True when the request reordered options rather than rewriting them. */
  reordered: boolean;
}

/** Snapshot the fields `buildPollUpdateActivity` diffs, before they are mutated. */
export function snapshotPoll(poll: PollDoc): PollUpdateDiff['before'] {
  return {
    question: poll.question,
    description: poll.description,
    closeDate: poll.closeDate,
    category: poll.category,
    options: optionTexts(poll),
  };
}

/**
 * Diff a poll edit into activity events.
 *
 * The editor submits the whole definition on every save, so comparing against
 * the pre-edit snapshot is what keeps the timeline a record of what changed
 * rather than of how often Save was pressed.
 */
export function buildPollUpdateActivity({
  before,
  after,
  reordered,
}: PollUpdateDiff): PollActivityDraft[] {
  const events: PollActivityDraft[] = [];

  if (before.question !== after.question) {
    events.push({
      action: 'question_changed',
      metadata: { from: before.question, to: after.question },
    });
  }
  if (before.description !== after.description) {
    events.push({ action: 'description_changed' });
  }
  if (before.category !== after.category) {
    events.push({
      action: 'category_changed',
      metadata: { from: before.category || null, to: after.category || null },
    });
  }
  if (before.closeDate.getTime() !== after.closeDate.getTime()) {
    events.push({
      action: 'close_date_changed',
      metadata: { from: before.closeDate.toISOString(), to: after.closeDate.toISOString() },
    });
  }

  const afterOptions = optionTexts(after);
  if (!sameList(before.options, afterOptions)) {
    // Reordering keeps every option's text and id, so it reads as a reorder
    // rather than an answer rewrite — a tally survives it.
    events.push(
      reordered
        ? { action: 'options_reordered', metadata: { from: before.options, to: afterOptions } }
        : { action: 'options_changed', metadata: { from: before.options, to: afterOptions } },
    );
  }

  return events;
}

/** Attach the entity envelope and actor to a batch of drafted events. */
export function toPollActivity(
  pollId: mongoose.Types.ObjectId | string,
  actorId: string | null,
  drafts: PollActivityDraft[],
): ActivityInput[] {
  return drafts.map((draft) => ({
    entityType: 'poll' as const,
    entityId: pollId,
    action: draft.action,
    actorId,
    metadata: draft.metadata ?? null,
  }));
}
