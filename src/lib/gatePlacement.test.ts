// Where an automatically-placed gate lands (`F-001`).
//
// The gate is a top-level atom node, so "one third of the article" can only ever
// be a boundary between top-level nodes — the question is which one. These pin
// the three things that decide it, because each was a real failure mode on the
// live bodies in `DB Data Export/resolve.articles.json`:
//
//   1. Nearest boundary, not the first one to cross the target. First-crossing
//      put the gate at 44.3% of one real article because a single fat block
//      straddled the line.
//   2. The successor must be teasable. Every landing spot in that export was
//      followed by a `horizontalRule`, and `TEASER_NODE_TYPES` in articleGate.ts
//      is `{paragraph, heading}` — so the locked reader would have seen no teaser
//      at all under the paywall gradient.
//   3. A heading is never the last public node. Its section is what got gated, so
//      it belongs below the line, not stranded above it.
//
// Placement is a pure function over the body: no database, no article document.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GATE_FRACTION,
  isValidGateFraction,
  MIN_GATE_POST_CHARS,
  MIN_GATE_PRE_CHARS,
  insertGateNode,
  planGateInsertion,
} from './gatePlacement';
import { GATE_NODE_TYPE, clipBodyForTier, countGateNodes, splitBodyAtGate } from './articleGate';
import { extractPlainText } from './articleText';

/* eslint-disable @typescript-eslint/no-explicit-any */

// A paragraph whose plain text is exactly `chars` long.
function para(chars: number, fill = 'a'): any {
  return { type: 'paragraph', content: [{ type: 'text', text: fill.repeat(chars) }] };
}

function heading(chars: number): any {
  return { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'h'.repeat(chars) }] };
}

const rule = { type: 'horizontalRule' };
const image = { type: 'image', attrs: { src: 'https://example.com/a.jpg' } };

function doc(...nodes: any[]): any {
  return { type: 'doc', content: nodes };
}

function planOrThrow(body: any, fraction?: number) {
  const result = planGateInsertion(body, fraction);
  assert.equal(result.ok, true, `expected a plan, got ${JSON.stringify(result)}`);
  return (result as { ok: true; plan: any }).plan;
}

test('splits at the boundary nearest the target fraction', () => {
  // Nine equal paragraphs: the boundary after the third is exactly one third.
  const body = doc(...Array.from({ length: 9 }, () => para(100)));
  const plan = planOrThrow(body);

  assert.equal(plan.index, 3);
  assert.equal(plan.preChars, 300);
  assert.equal(plan.totalChars, 900);
  assert.equal(Math.round(plan.preFraction * 1000) / 1000, 0.333);
});

test('prefers the nearer boundary rather than the first one to cross the target', () => {
  // Target is 400 of 1200. Crossing first happens at index 2 (pre = 700, off by
  // 300); the boundary before it is pre = 200, off by 200. Nearest wins.
  const body = doc(para(200), para(500), para(200), para(300));
  const plan = planOrThrow(body);

  assert.equal(plan.index, 1);
  assert.equal(plan.preChars, 200);
});

test('honours a caller-supplied fraction', () => {
  const body = doc(...Array.from({ length: 8 }, () => para(100)));

  assert.equal(planOrThrow(body, 0.25).index, 2);
  assert.equal(planOrThrow(body, 0.5).index, 4);
  assert.equal(planOrThrow(body, 0.75).index, 6);
});

test('defaults to one third when no fraction is given', () => {
  const body = doc(...Array.from({ length: 9 }, () => para(100)));

  assert.equal(planOrThrow(body).index, planOrThrow(body, DEFAULT_GATE_FRACTION).index);
});

test('slides past a separator so the gate has a teasable successor', () => {
  // A rule carries no text, so the boundaries either side of it are equally
  // near the target and the earlier one wins — which puts the gate in front of
  // the rule. A rule is not in TEASER_NODE_TYPES, so the teaser loop would
  // break at once and the locked reader would see nothing faded at all.
  const body = doc(para(150), para(150), rule, para(300), para(300));
  const plan = planOrThrow(body);

  assert.equal(plan.index, 3, 'gate should sit after the rule, not before it');
  assert.equal((body.content as any[])[plan.index].type, 'paragraph');
});

test('slides past a run of non-prose nodes, not just one', () => {
  const body = doc(para(150), para(150), rule, image, rule, para(300), para(300));
  const plan = planOrThrow(body);

  assert.equal(plan.index, 5);
  assert.equal((body.content as any[])[plan.index].type, 'paragraph');
});

test('never leaves a heading as the last public node', () => {
  // Nearest boundary by text is index 2, immediately after the heading — which
  // would strand the heading above the line while the section it introduces is
  // gated. It backs off to index 1, in front of the heading.
  const body = doc(para(200), heading(20), para(300), para(300));
  const plan = planOrThrow(body);

  assert.equal(plan.index, 1);
  assert.equal(plan.preChars, 200);
  assert.equal((body.content as any[])[plan.index].type, 'heading');
});

test('leaves at least one node on each side', () => {
  const body = doc(para(400), para(400), para(400));

  for (const fraction of [0.01, 0.99]) {
    const plan = planOrThrow(body, fraction);
    assert.ok(plan.index >= 1, `index ${plan.index} would gate the whole article`);
    assert.ok(plan.index <= 2, `index ${plan.index} would gate nothing`);
  }
});

test('keeps enough text on each side of the gate', () => {
  const body = doc(para(50), para(1000), para(1000));
  const plan = planOrThrow(body, 0.01);

  assert.ok(plan.preChars >= MIN_GATE_PRE_CHARS);
  assert.ok(plan.totalChars - plan.preChars >= MIN_GATE_POST_CHARS);
});

test('reads text out of custom blocks, not just paragraphs', () => {
  // keyPoints and timeline carry their text in attrs. blockToText already knows
  // how to read them, and placement has to weigh them or a block-heavy article
  // (which is what the live export mostly is) measures as nearly empty.
  const keyPoints = {
    type: 'keyPoints',
    attrs: { items: [{ title: 'T'.repeat(100), description: 'D'.repeat(100) }] },
  };
  const body = doc(keyPoints, para(100), para(100), para(100), para(100), para(100));
  const plan = planOrThrow(body);

  assert.ok(plan.totalChars > 500, `custom block text was not counted (total ${plan.totalChars})`);
});

test('an already-gated body is skipped rather than re-cut', () => {
  const body = doc(para(400), { type: GATE_NODE_TYPE }, para(400), para(400));
  const result = planGateInsertion(body);

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'already_gated');
});

test('a body with no extractable text is skipped', () => {
  const result = planGateInsertion(doc(image, rule, image));

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'no_text');
});

test('a body too short to split is skipped', () => {
  const result = planGateInsertion(doc(para(80), para(80)));

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'too_short');
});

test('a single-node body has no boundary to use', () => {
  const result = planGateInsertion(doc(para(2000)));

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'no_valid_boundary');
});

test('an empty body is skipped as textless, not as a crash', () => {
  assert.equal(planGateInsertion(doc()).ok, false);
  assert.equal(planGateInsertion(null).ok, false);
  assert.equal(planGateInsertion({ type: 'doc' }).ok, false);
});

test('insertGateNode puts exactly one gate at the planned index', () => {
  const body = doc(...Array.from({ length: 9 }, () => para(100)));
  const plan = planOrThrow(body);
  const gated = insertGateNode(body, plan.index);

  assert.equal(countGateNodes(gated), 1);
  assert.equal(gated.content[plan.index].type, GATE_NODE_TYPE);
  assert.equal(gated.content.length, 10);
  assert.equal(gated.type, 'doc', 'the doc wrapper survives');
  assert.deepEqual(body.content.length, 9, 'the input body is not mutated');
});

test('the planned split is the split the reader actually gets', () => {
  const body = doc(...Array.from({ length: 9 }, () => para(100)));
  const plan = planOrThrow(body);
  const gated = insertGateNode(body, plan.index);

  const { pre } = splitBodyAtGate(gated, 'premium');
  assert.equal(extractPlainText(pre).replace(/\n/g, '').length, plan.preChars);
});

test('a locked reader gets a non-empty teaser at the planned gate', () => {
  const body = doc(para(150), para(150), rule, para(300), para(300));
  const gated = insertGateNode(body, planOrThrow(body).index);

  const clipped = clipBodyForTier(gated, 'premium', 'free');
  assert.equal(clipped.locked, true);
  assert.ok(clipped.teaser, 'the gate landed somewhere with nothing to tease');
  assert.ok((clipped.teaser as any).content.length > 0);
});

test('rejects a fraction outside the open unit interval', () => {
  const body = doc(...Array.from({ length: 9 }, () => para(100)));

  for (const bad of [0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isValidGateFraction(bad), false, `${bad} should not be a valid fraction`);
    assert.throws(() => planGateInsertion(body, bad), RangeError);
  }
  assert.equal(isValidGateFraction(DEFAULT_GATE_FRACTION), true);
});
