// Rows for the bulk gate preview and the write that follows (`F-001`).
//
// The endpoint's contract is the one the other bulk actions already set: a
// selection is a rough gesture, rows that cannot take the action are skipped
// with a reason, and the rest still go through. Two things are specific to this
// action and pinned here:
//
//   - Preview and apply run the same planner over the same body. Apply never
//     takes the index the client sends back; it recomputes and compares a hash of
//     the body it planned against, so an article edited in between is skipped as
//     `stale` rather than cut at a point nobody looked at.
//   - The gate node and `gateTier` are written as a pair. A row that produces a
//     body always names a tier, and ungating strips the node and clears the tier.

import test from 'node:test';
import assert from 'node:assert/strict';

import { GATE_NODE_TYPE, countGateNodes } from '../lib/articleGate';
import { hashArticleBody, planGateRow, planUngateRow } from './articleGateBulk';

/* eslint-disable @typescript-eslint/no-explicit-any */

function para(chars: number, fill = 'a'): any {
  return { type: 'paragraph', content: [{ type: 'text', text: fill.repeat(chars) }] };
}

function article(overrides: Record<string, unknown> = {}): any {
  return {
    _id: 'a1',
    slug: 'a-slug',
    title: 'A title',
    body: { type: 'doc', content: Array.from({ length: 9 }, () => para(100)) },
    gateTier: undefined,
    ...overrides,
  };
}

test('a planned row carries the split the editor is being asked to approve', () => {
  const { row, body } = planGateRow(article(), { gateTier: 'premium', fraction: 1 / 3 });

  assert.equal(row.status, 'planned');
  assert.equal(row.id, 'a1');
  assert.equal(row.slug, 'a-slug');
  assert.equal(row.title, 'A title');
  assert.equal(row.index, 3);
  assert.equal(row.preChars, 300);
  assert.equal(row.totalChars, 900);
  assert.equal(row.gateTier, 'premium');
  assert.ok(body, 'a planned row produces the body to write');
  assert.equal(countGateNodes(body), 1);
  assert.equal((body as any).content[3].type, GATE_NODE_TYPE);
});

test('a planned row shows the prose either side of the cut', () => {
  const body = {
    type: 'doc',
    content: [para(300, 'x'), para(300, 'y'), para(300, 'z')],
  };
  const { row } = planGateRow(article({ body }), { gateTier: 'core', fraction: 1 / 3 });

  assert.ok(row.before?.endsWith('x'), `before should end in the public half, got ${row.before}`);
  assert.ok(row.after?.startsWith('y'), `after should start in the gated half, got ${row.after}`);
});

test('a skipped row names its reason and produces no body', () => {
  const gated = {
    type: 'doc',
    content: [para(400), { type: GATE_NODE_TYPE }, para(400), para(400)],
  };
  const { row, body } = planGateRow(article({ body: gated, gateTier: 'core' }), {
    gateTier: 'premium',
    fraction: 1 / 3,
  });

  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'already_gated');
  assert.equal(body, null);
});

test('every row carries a hash of the body it was planned against', () => {
  const one = planGateRow(article(), { gateTier: 'core', fraction: 1 / 3 }).row;
  const same = planGateRow(article(), { gateTier: 'core', fraction: 1 / 3 }).row;
  const other = planGateRow(article({ body: { type: 'doc', content: [para(500), para(500)] } }), {
    gateTier: 'core',
    fraction: 1 / 3,
  }).row;

  assert.equal(one.bodyHash, same.bodyHash, 'the same body hashes the same');
  assert.notEqual(one.bodyHash, other.bodyHash, 'a different body hashes differently');
  assert.match(one.bodyHash, /^[0-9a-f]{64}$/);
});

test('a skipped row still carries a hash, so a re-preview can be compared', () => {
  const { row } = planGateRow(article({ body: { type: 'doc', content: [para(80), para(80)] } }), {
    gateTier: 'core',
    fraction: 1 / 3,
  });

  assert.equal(row.status, 'skipped');
  assert.match(row.bodyHash, /^[0-9a-f]{64}$/);
});

test('apply skips an article whose body changed since the preview', () => {
  const target = article();
  const { row } = planGateRow(target, {
    gateTier: 'premium',
    fraction: 1 / 3,
    expectBodyHash: hashArticleBody({ type: 'doc', content: [para(999)] }),
  });

  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'stale');
});

test('apply proceeds when the body is the one that was previewed', () => {
  const target = article();
  const { row, body } = planGateRow(target, {
    gateTier: 'premium',
    fraction: 1 / 3,
    expectBodyHash: hashArticleBody(target.body),
  });

  assert.equal(row.status, 'planned');
  assert.ok(body);
});

test('the fraction the caller asks for is the fraction that is planned', () => {
  const half = planGateRow(article(), { gateTier: 'core', fraction: 0.5 }).row;
  const third = planGateRow(article(), { gateTier: 'core', fraction: 1 / 3 }).row;

  assert.equal(third.index, 3);
  assert.equal(half.index, 4);
});

test('ungating strips the marker and clears the tier', () => {
  const gated = {
    type: 'doc',
    content: [para(400), { type: GATE_NODE_TYPE }, para(400)],
  };
  const { row, body } = planUngateRow(article({ body: gated, gateTier: 'premium' }));

  assert.equal(row.status, 'planned');
  assert.equal(row.gateTier, null);
  assert.ok(body);
  assert.equal(countGateNodes(body), 0);
  assert.equal((body as any).content.length, 2);
});

test('ungating an article that was never gated is a skip, not a write', () => {
  const { row, body } = planUngateRow(article());

  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'not_gated');
  assert.equal(body, null);
});

test('ungating respects the same staleness check', () => {
  const gated = {
    type: 'doc',
    content: [para(400), { type: GATE_NODE_TYPE }, para(400)],
  };
  const { row } = planUngateRow(article({ body: gated, gateTier: 'core' }), {
    expectBodyHash: hashArticleBody({ type: 'doc', content: [para(1)] }),
  });

  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, 'stale');
});

test('planning never mutates the article it was given', () => {
  const target = article();
  const before = JSON.stringify(target.body);
  planGateRow(target, { gateTier: 'premium', fraction: 1 / 3 });

  assert.equal(JSON.stringify(target.body), before);
  assert.equal(countGateNodes(target.body), 0);
});
