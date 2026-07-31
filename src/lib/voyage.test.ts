// Batching and normalisation for the Voyage client.
//
// These are the two places where a bug is silent rather than loud. A bad batch
// split throws a 400 from the provider mid-backfill; worse, a normalisation
// mistake produces vectors that still search successfully and just rank subtly
// wrong, which no smoke test would catch.

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing, EMBED_DIM } from './voyage';

const { batchTexts, normalizeIfNeeded, MAX_INPUTS_PER_REQUEST } = __testing;

function flatten(batches: string[][]): string[] {
  return batches.flat();
}

test('batchTexts', async (t) => {
  await t.test('returns nothing for no input', () => {
    assert.deepEqual(batchTexts([]), []);
  });

  await t.test('keeps a small set in a single batch', () => {
    const texts = ['a', 'b', 'c'];
    assert.deepEqual(batchTexts(texts), [texts]);
  });

  await t.test('never loses, duplicates or reorders a text', () => {
    // Order is load-bearing: the caller zips the returned vectors back onto its
    // chunks by index, so a reshuffle here writes the wrong vector to the wrong
    // chunk and retrieval silently returns the wrong article.
    const texts = Array.from({ length: 500 }, (_, i) => `chunk-${i}`);
    assert.deepEqual(flatten(batchTexts(texts)), texts);
  });

  await t.test('splits on the input-count ceiling', () => {
    const texts = Array.from({ length: MAX_INPUTS_PER_REQUEST * 2 + 1 }, (_, i) => `t${i}`);
    const batches = batchTexts(texts);
    assert.equal(batches.length, 3);
    for (const batch of batches) {
      assert.ok(batch.length <= MAX_INPUTS_PER_REQUEST, `batch of ${batch.length}`);
    }
  });

  await t.test('splits on the token ceiling before the count ceiling', () => {
    // Ten very long texts: far under the count limit, far over the token limit.
    const huge = 'x'.repeat(40_000 * 4); // ~40k estimated tokens each
    const batches = batchTexts(Array.from({ length: 10 }, () => huge));
    assert.ok(batches.length > 1, 'expected the token ceiling to force a split');
    for (const batch of batches) {
      assert.ok(batch.length < MAX_INPUTS_PER_REQUEST);
    }
  });

  await t.test('a single oversized text still gets its own batch rather than being dropped', () => {
    // It may well be rejected upstream, but that is the provider's 400 to
    // return — silently discarding a chunk would leave a hole in the index that
    // nothing reports.
    const monster = 'y'.repeat(1_000_000);
    const batches = batchTexts([monster]);
    assert.deepEqual(batches, [[monster]]);
  });
});

test('normalizeIfNeeded', async (t) => {
  await t.test('leaves a unit vector untouched', () => {
    const unit = [1, 0, 0];
    assert.equal(normalizeIfNeeded(unit), unit, 'should return the same array, not a copy');
  });

  await t.test('scales a non-unit vector to length 1', () => {
    const out = normalizeIfNeeded([3, 4]);
    assert.equal(Math.round(Math.hypot(...out) * 1e6) / 1e6, 1);
    assert.deepEqual(out, [0.6, 0.8]);
  });

  await t.test('leaves an all-zero vector alone rather than dividing by zero', () => {
    assert.deepEqual(normalizeIfNeeded([0, 0, 0]), [0, 0, 0]);
  });
});

test('EMBED_DIM matches what the v2 Atlas index is built for', () => {
  // numDimensions is immutable in Atlas, so a mismatch between this and the
  // index is unrecoverable without a rebuild.
  assert.equal(EMBED_DIM, 1024);
});
