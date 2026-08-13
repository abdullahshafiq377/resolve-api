import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  buildTallies,
  canSeeTally,
  serializeAdminPoll,
  serializePublicPoll,
  serializeResults,
} from './serializers';
import type { PollDoc, PollStatus } from '../../models/Poll';

// These exercise the serializers directly rather than the controllers, which
// need Mongo. The poll is a hand-built stand-in carrying only the fields the
// serializers read — `optionVoteCounts` is a real Map because that is what
// Mongoose hands back for a Map path.
function makePoll(status: PollStatus, counts: Record<string, number>): PollDoc {
  const ids = Object.keys(counts);
  return {
    _id: new mongoose.Types.ObjectId(),
    slug: 'should-pakistan-join-brics',
    question: 'Should Pakistan join the BRICS alliance?',
    description: '',
    status,
    closeDate: new Date('2026-09-01T00:00:00.000Z'),
    opensAt: null,
    totalVotes: Object.values(counts).reduce((sum, n) => sum + n, 0),
    commentCount: 0,
    featured: false,
    categoryId: null,
    category: '',
    categorySlug: null,
    options: ids.map((id, index) => ({
      _id: id as unknown as mongoose.Types.ObjectId,
      text: `Option ${index + 1}`,
      order: index,
    })),
    optionVoteCounts: new Map(Object.entries(counts)),
    closedAt: status === 'closed' ? new Date('2026-08-01T00:00:00.000Z') : null,
    publishedAt: new Date('2026-07-01T00:00:00.000Z'),
    createdBy: 'user_1',
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    lastEditedBy: 'user_1',
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    publishedBy: 'user_1',
    closedBy: null,
    lastSystemTransitionAt: null,
  } as unknown as PollDoc;
}

const COUNTS = { a: 8, b: 2 };

describe('canSeeTally', () => {
  it('withholds an open poll from a viewer who has not voted', () => {
    assert.equal(canSeeTally(makePoll('open', COUNTS), null), false);
  });

  it('reveals an open poll once the viewer has voted', () => {
    assert.equal(canSeeTally(makePoll('open', COUNTS), 'a'), true);
  });

  it('reveals a closed poll to everyone, voter or not', () => {
    assert.equal(canSeeTally(makePoll('closed', COUNTS), null), true);
    assert.equal(canSeeTally(makePoll('closed', COUNTS), 'a'), true);
  });
});

describe('buildTallies', () => {
  it('nulls the numbers when withholding, and keeps the options themselves', () => {
    const options = buildTallies(makePoll('open', COUNTS), false);
    assert.equal(options.length, 2);
    // The choices must survive — the reader still has to be able to vote.
    assert.deepEqual(
      options.map((option) => option.text),
      ['Option 1', 'Option 2'],
    );
    // Null, never 0: a 0 would render as an empty bar rather than no bar.
    assert.deepEqual(
      options.map((option) => option.count),
      [null, null],
    );
    assert.deepEqual(
      options.map((option) => option.percentage),
      [null, null],
    );
  });

  it('computes counts and percentages when revealing', () => {
    const options = buildTallies(makePoll('open', COUNTS), true);
    assert.deepEqual(
      options.map((option) => option.count),
      [8, 2],
    );
    assert.deepEqual(
      options.map((option) => option.percentage),
      [80, 20],
    );
  });
});

describe('serializePublicPoll', () => {
  it('withholds the tally from a non-voter on an open poll', () => {
    const payload = serializePublicPoll(makePoll('open', COUNTS), null);
    assert.deepEqual(
      payload.options.map((option) => option.count),
      [null, null],
    );
    // The total is not part of the rule — the card shows it before voting.
    assert.equal(payload.totalVotes, 10);
  });

  it('reveals the tally to a voter on an open poll', () => {
    const payload = serializePublicPoll(makePoll('open', COUNTS), 'a');
    assert.deepEqual(
      payload.options.map((option) => option.count),
      [8, 2],
    );
  });

  it('reveals the tally on a closed poll with no viewer vote', () => {
    const payload = serializePublicPoll(makePoll('closed', COUNTS), null);
    assert.deepEqual(
      payload.options.map((option) => option.count),
      [8, 2],
    );
  });
});

describe('serializeAdminPoll', () => {
  it('never withholds — a moderator who has not voted still sees the numbers', () => {
    const payload = serializeAdminPoll(makePoll('open', COUNTS));
    assert.deepEqual(
      payload.options.map((option) => option.count),
      [8, 2],
    );
  });
});

describe('serializeResults', () => {
  it('withholds when told to', () => {
    const payload = serializeResults(makePoll('open', COUNTS), false);
    assert.deepEqual(
      payload.options.map((option) => option.count),
      [null, null],
    );
  });

  it('reveals by default, which is what the vote response returns', () => {
    const payload = serializeResults(makePoll('open', COUNTS));
    assert.deepEqual(
      payload.options.map((option) => option.count),
      [8, 2],
    );
  });
});
