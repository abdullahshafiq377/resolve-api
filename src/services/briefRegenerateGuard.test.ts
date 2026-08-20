// Regression pass for the approved-Brief regeneration guard (`F-013`).
//
// `regenerateSegment` force-sets a segment back to `draft` and clears its approval.
// Approval is what sends the emails, so doing that to an approved segment silently
// erased the record of an edition readers already had in their inboxes. The fix is
// not a refusal: an editor may redo a sent Brief, but only by acknowledging that
// the mail cannot be recalled, and the superseded edition is kept in
// `priorDeliveries`.
//
// The load-bearing trick, borrowed from `controllers/chatGating.test.ts`: the
// model call is stubbed with a function that THROWS. A test asserting the refusal
// therefore also proves no generation was billed — if the guard ever moves after
// `generateDraft`, this fails loudly instead of passing while paying Anthropic for
// a draft that gets thrown away.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const SEGMENT_ID = '507f1f77bcf86cd799439011';

interface FakeSegment {
  _id: string;
  status: 'draft' | 'approved' | 'rejected';
  briefDate: string;
  categoryIds: string[];
  regionIds: string[];
  approvedAt: Date | null;
  approvedBy: string | null;
}

function approvedSegment(): FakeSegment {
  return {
    _id: SEGMENT_ID,
    status: 'approved',
    briefDate: '2026-08-19',
    categoryIds: ['507f1f77bcf86cd799439012'],
    regionIds: ['507f1f77bcf86cd799439013'],
    approvedAt: new Date('2026-08-19T02:00:00.000Z'),
    approvedBy: 'user_editor',
  };
}

function draftSegment(): FakeSegment {
  return { ...approvedSegment(), status: 'draft', approvedAt: null, approvedBy: null };
}

interface Harness {
  regenerateSegment: (
    segmentId: string,
    adminUserId: string,
    options?: { acknowledgeSent?: boolean },
  ) => Promise<unknown>;
  updates: { filter: unknown; update: Record<string, unknown> }[];
  generateTextCalls: number;
}

/**
 * Mounts the service over fake models. One published article is enough — the
 * synthesis path only has to reach `findByIdAndUpdate` so the update document can
 * be inspected.
 */
async function setup(segment: FakeSegment): Promise<Harness> {
  mock.restoreAll();
  const updates: { filter: unknown; update: Record<string, unknown> }[] = [];
  const state = { generateTextCalls: 0 };

  const article = {
    _id: '507f1f77bcf86cd799439014',
    title: 'A published article',
    excerpt: 'Excerpt.',
    slug: 'a-published-article',
    body: { type: 'doc', content: [] },
    publishDate: new Date('2026-08-19T01:00:00.000Z'),
    createdAt: new Date('2026-08-19T01:00:00.000Z'),
  };

  mock.module('../models/BriefSegment', {
    exports: {
      default: {
        findById: async () => segment,
        findByIdAndUpdate: async (
          filter: unknown,
          update: Record<string, unknown>,
        ) => {
          updates.push({ filter, update });
          return { ...segment, status: 'draft' };
        },
      },
      BRIEF_SEGMENT_STATUSES: ['draft', 'approved', 'rejected'],
    },
  });

  mock.module('../models/BriefRecipient', {
    exports: {
      default: {
        // Three readers already hold the edition being replaced.
        countDocuments: async () => 3,
      },
    },
  });

  mock.module('../models/Article', {
    exports: {
      default: {
        find: () => ({
          sort: () => ({ limit: async () => [article] }),
        }),
      },
    },
  });

  mock.module('../models/Category', {
    exports: { default: { find: async () => [{ title: 'Politics', slug: 'politics' }] } },
  });

  mock.module('../models/Region', {
    exports: { default: { find: async () => [{ title: 'Pakistan', slug: 'pakistan' }] } },
  });

  mock.module('./regions', {
    exports: {
      GLOBAL_REGION_SLUG: 'global',
      getGlobalRegion: async () => ({ _id: '507f1f77bcf86cd799439015', slug: 'global' }),
    },
  });

  mock.module('../lib/anthropic', {
    exports: {
      ModelRefusalError: class ModelRefusalError extends Error {},
      ModelTruncatedError: class ModelTruncatedError extends Error {},
      async generateText() {
        state.generateTextCalls += 1;
        return JSON.stringify({
          title: 'Regenerated headline',
          summary: 'A fresh synthesis.',
          stories: [{ articleId: article._id, headline: 'A published article' }],
          editorialNote: null,
        });
      },
    },
  });

  const mod = await import(`./resolveBriefGeneration?guard=${Math.random()}`);
  return {
    regenerateSegment: mod.regenerateSegment,
    updates,
    get generateTextCalls() {
      return state.generateTextCalls;
    },
  } as Harness;
}

test('regenerating an approved Brief without acknowledgement is refused before any model call', async () => {
  const harness = await setup(approvedSegment());

  await assert.rejects(
    () => harness.regenerateSegment(SEGMENT_ID, 'user_admin'),
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 409);
      assert.equal(err.message, 'segment_regenerate_requires_acknowledgement');
      return true;
    },
  );

  assert.equal(harness.generateTextCalls, 0, 'the refusal must precede the model call');
  assert.equal(harness.updates.length, 0, 'the segment must be left untouched');
});

test('an acknowledged regeneration proceeds and records the superseded delivery', async () => {
  const harness = await setup(approvedSegment());

  await harness.regenerateSegment(SEGMENT_ID, 'user_admin', { acknowledgeSent: true });

  assert.equal(harness.updates.length, 1);
  const update = harness.updates[0].update as {
    $set: Record<string, unknown>;
    $push?: { priorDeliveries: Record<string, unknown> };
  };
  assert.equal(update.$set.status, 'draft');
  assert.equal(update.$set.approvedAt, null);

  const prior = update.$push?.priorDeliveries;
  assert.ok(prior, 'the replaced edition must be recorded');
  assert.equal(prior.emailSentCount, 3);
  assert.equal(prior.approvedBy, 'user_editor');
  assert.equal(prior.supersededBy, 'user_admin');
  assert.ok(prior.supersededAt instanceof Date);
});

test('regenerating a draft needs no acknowledgement and records no delivery', async () => {
  const harness = await setup(draftSegment());

  await harness.regenerateSegment(SEGMENT_ID, 'user_admin');

  assert.equal(harness.updates.length, 1);
  const update = harness.updates[0].update as { $push?: unknown };
  assert.equal(update.$push, undefined, 'nothing was delivered, so nothing is superseded');
});
