// Regression pass for tag matching in global search (`F-059`).
//
// The admin editor asks for tags on every short, and Short is the only model that
// carries them, so a term an editor deliberately tagged had to be findable or the
// field was dead data for discovery. This pins the query shape rather than the
// result, because that is where the bug was: one missing branch in an `$or`.
//
// It also pins the deliberate non-decision — no relevance ranking — by asserting
// the sort is still newest-first. Nothing in `search.ts` ranks, and ranking one
// type only would be the inconsistency.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

interface Captured {
  filter: Record<string, unknown>;
  sort: Record<string, unknown>;
}

async function setup() {
  mock.restoreAll();
  const calls: Captured[] = [];

  const chain = (filter: Record<string, unknown>) => {
    const captured: Captured = { filter, sort: {} };
    calls.push(captured);
    const self = {
      sort(sort: Record<string, unknown>) {
        captured.sort = sort;
        return self;
      },
      limit: () => self,
      select: () => self,
      lean: async () => [],
    };
    return self;
  };

  mock.module('../models/Short', {
    exports: { default: { find: (filter: Record<string, unknown>) => chain(filter) } },
  });

  const mod = await import(`./search?tags=${Math.random()}`);
  return { runSearch: mod.runSearch as typeof import('./search').runSearch, calls };
}

test('a shorts search matches tags alongside title and description', async () => {
  const { runSearch, calls } = await setup();

  await runSearch('islamabad', ['short'], 5);

  assert.equal(calls.length, 1);
  const or = calls[0].filter.$or as Record<string, unknown>[];
  const fields = or.flatMap((clause) => Object.keys(clause));
  assert.deepEqual(fields, ['title', 'description', 'tags']);
  assert.equal(calls[0].filter.status, 'published', 'unpublished shorts stay out of search');
});

test('the tag branch uses the same case-insensitive regex as the others', async () => {
  const { runSearch, calls } = await setup();

  await runSearch('Islamabad', ['short'], 5);

  const or = calls[0].filter.$or as Record<string, RegExp>[];
  const patterns = or.map((clause) => Object.values(clause)[0]);
  assert.ok(patterns.every((rx) => rx instanceof RegExp && rx.flags.includes('i')));
  assert.equal(new Set(patterns.map(String)).size, 1, 'one regex, matched against every field');
});

test('a regex metacharacter in the query is matched literally, tags included', async () => {
  const { runSearch, calls } = await setup();

  await runSearch('c++', ['short'], 5);

  const or = calls[0].filter.$or as Record<string, RegExp>[];
  const tagRx = Object.values(or[2])[0];
  assert.ok(tagRx.test('c++'), 'the literal term still matches');
  assert.ok(!tagRx.test('cxx'), 'the + is not treated as a quantifier');
});

test('search still orders newest-first — the tag branch adds no ranking', async () => {
  const { runSearch, calls } = await setup();

  await runSearch('islamabad', ['short'], 5);

  assert.deepEqual(calls[0].sort, { publishedAt: -1, createdAt: -1 });
});
