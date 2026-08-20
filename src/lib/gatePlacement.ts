// Where an automatically-placed gate goes (`F-001`).
//
// `gateTier` is set if and only if the body contains exactly one `gate` node, so
// a bulk "gate these articles" action cannot write the field alone — it has to
// edit the bodies. This module decides where, and it is deliberately pure: no
// article document, no database, so the admin preview and the write that follows
// run the same code over the same input and cannot disagree.
//
// The gate is a top-level atom, so "one third of the article" can only ever be a
// boundary between top-level nodes. Three rules turn a target fraction into a
// boundary an editor would have chosen:
//
//   1. Nearest boundary to the target, not the first one past it. First-crossing
//      lands at 44% of a real article as soon as one fat block straddles the line.
//   2. The successor must be teasable. `clipBodyForTier` stops the teaser at the
//      first node that is not a paragraph or heading, so a gate placed in front
//      of a rule, image or chart shows a locked reader nothing at all under the
//      paywall gradient.
//   3. A heading is never the last public node — its section is what got gated,
//      so it belongs below the line rather than stranded above it.
//
// Nothing here writes `gateTier`. The caller pairs the returned body with the
// tier and runs the usual save-time invariant check.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { TEASER_NODE_TYPES, countGateNodes, nodesOf, withNodes, GATE_NODE_TYPE } from './articleGate';
import { topLevelTextLengths } from './articleText';

type JSONContent = any;

// Where the gate goes when the caller does not say.
export const DEFAULT_GATE_FRACTION = 1 / 3;

// A split is only worth making if both halves are worth having: enough public
// text to judge the article by, and enough gated text to be worth paying for.
// Below either bound the article is reported as skipped rather than gated badly.
export const MIN_GATE_PRE_CHARS = 200;
export const MIN_GATE_POST_CHARS = 200;

export type GateSkipReason =
  // The editor already placed a gate. Never move it — only the tier may change.
  | 'already_gated'
  // No extractable prose at all, so there is no "one third" to find.
  | 'no_text'
  // Too little text for both halves to clear their minimums.
  | 'too_short'
  // Long enough, but no boundary satisfies the minimums (a single huge block).
  | 'no_valid_boundary';

export interface GatePlan {
  // Index in the body's top-level node list where the gate node is inserted.
  index: number;
  // Plain-text characters left public, and in the whole body.
  preChars: number;
  totalChars: number;
  // preChars / totalChars — what the editor is shown, and what says how far the
  // realised split drifted from the fraction they asked for.
  preFraction: number;
}

export type GatePlacement = { ok: true; plan: GatePlan } | { ok: false; reason: GateSkipReason };

export function isValidGateFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
}

// Plan where a gate would go in `body`. Returns a reason instead of a plan when
// the article should be left alone; the caller reports those rows rather than
// silently dropping them.
export function planGateInsertion(
  body: JSONContent,
  fraction: number = DEFAULT_GATE_FRACTION,
): GatePlacement {
  if (!isValidGateFraction(fraction)) {
    throw new RangeError(`gate fraction must be between 0 and 1, got ${String(fraction)}`);
  }

  if (countGateNodes(body) > 0) return { ok: false, reason: 'already_gated' };

  const nodes = nodesOf(body);
  const lengths = topLevelTextLengths(body);
  const totalChars = lengths.reduce((sum, length) => sum + length, 0);

  if (totalChars === 0) return { ok: false, reason: 'no_text' };
  if (totalChars < MIN_GATE_PRE_CHARS + MIN_GATE_POST_CHARS) return { ok: false, reason: 'too_short' };

  // charsBefore[k] is the plain-text length of nodes[0..k-1] — the public half if
  // the gate were inserted at index k.
  const charsBefore: number[] = [0];
  for (const length of lengths) charsBefore.push(charsBefore[charsBefore.length - 1] + length);

  const fits = (index: number): boolean =>
    index >= 1 &&
    index <= nodes.length - 1 &&
    charsBefore[index] >= MIN_GATE_PRE_CHARS &&
    totalChars - charsBefore[index] >= MIN_GATE_POST_CHARS;

  const target = fraction * totalChars;
  let index = -1;
  let bestDistance = Infinity;
  // Strictly-better wins, so a tie between two boundaries (which a zero-length
  // node such as a rule creates on both its sides) resolves to the earlier one
  // and the slide below moves it past the rule deterministically.
  for (let candidate = 1; candidate <= nodes.length - 1; candidate += 1) {
    if (!fits(candidate)) continue;
    const distance = Math.abs(charsBefore[candidate] - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      index = candidate;
    }
  }

  if (index === -1) return { ok: false, reason: 'no_valid_boundary' };

  // Rule 3, before rule 2: a heading immediately above the line goes below it,
  // and a heading is itself teasable, so this can never create work for the slide.
  if (nodes[index - 1]?.type === 'heading' && fits(index - 1)) index -= 1;

  // Rule 2: walk forward to the first teasable successor, stopping if the gated
  // half would fall below its minimum. A body that ends in charts keeps the
  // text-nearest boundary and simply has no teaser.
  while (!TEASER_NODE_TYPES.has(nodes[index]?.type) && fits(index + 1)) index += 1;

  return {
    ok: true,
    plan: {
      index,
      preChars: charsBefore[index],
      totalChars,
      preFraction: charsBefore[index] / totalChars,
    },
  };
}

// Insert a gate node at `index`. Does not mutate `body`, and keeps whatever
// shape it was given (doc node or bare content array).
export function insertGateNode(body: JSONContent, index: number): JSONContent {
  const nodes = nodesOf(body);
  const at = Math.max(0, Math.min(index, nodes.length));
  return withNodes(body, [...nodes.slice(0, at), { type: GATE_NODE_TYPE }, ...nodes.slice(at)]);
}
