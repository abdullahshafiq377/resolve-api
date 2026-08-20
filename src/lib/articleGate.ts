// Article gating: the single source of truth for what a given tier is allowed to
// read out of a Tiptap article body.
//
// An editor marks the cut point by placing one `gate` node in the body; the
// article's `gateTier` says which plan is needed to read past it. Readers below
// that tier get the nodes before the gate plus a short teaser, and the rest never
// leaves the server — so every path that emits a body to a public caller (the
// article endpoint, chat grounding, RAG chunking) must route through here rather
// than reimplementing the split.
//
// Keep the node type in sync with the editor extension
// (resolve-webapp/src/lib/tiptap-extensions/GateExtension.tsx) and the plain-text
// walker (lib/articleText.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { tierAtLeast, type PlanTier } from '../middleware/auth';
import type { GateTier } from '../models/Article';

type JSONContent = any;

export const GATE_NODE_TYPE = 'gate';

// How many nodes past the gate a locked reader is shown as a faded teaser.
export const TEASER_NODES_AFTER_GATE = 3;

// Only prose teases. A chart / gallery / video / pull-quote past the gate is
// gated content in its own right (and expensive to render), so the teaser stops
// at the first node that isn't one of these rather than skipping over it —
// skipping would pull later, further-in prose forward into public view.
export const TEASER_NODE_TYPES = new Set(['paragraph', 'heading']);

// Bodies are stored as a doc node ({ type:'doc', content:[…] }), but the older
// helpers also accept a bare content array. Read either; give back what we got.
export function nodesOf(body: JSONContent): JSONContent[] {
  if (body == null) return [];
  if (Array.isArray(body)) return body;
  return Array.isArray(body.content) ? body.content : [];
}

export function withNodes(body: JSONContent, nodes: JSONContent[]): JSONContent {
  if (Array.isArray(body)) return nodes;
  if (body == null || typeof body !== 'object') return { type: 'doc', content: nodes };
  return { ...body, content: nodes };
}

// Index of the first `gate` node among the body's top-level nodes, or -1.
export function findGateIndex(body: JSONContent): number {
  return nodesOf(body).findIndex((node) => node?.type === GATE_NODE_TYPE);
}

export function countGateNodes(body: JSONContent): number {
  return nodesOf(body).filter((node) => node?.type === GATE_NODE_TYPE).length;
}

// Drop every `gate` node. Public responses never expose the marker — it is an
// editing affordance, and echoing it back would tell a locked reader exactly
// where the cut is.
export function stripGateNodes(body: JSONContent): JSONContent {
  return withNodes(
    body,
    nodesOf(body).filter((node) => node?.type !== GATE_NODE_TYPE),
  );
}

// Keep only the first gate node (defensive: paste/undo in the editor can
// duplicate an atom node). Used on save.
export function keepFirstGateNode(body: JSONContent): JSONContent {
  let seen = false;
  return withNodes(
    body,
    nodesOf(body).filter((node) => {
      if (node?.type !== GATE_NODE_TYPE) return true;
      if (seen) return false;
      seen = true;
      return true;
    }),
  );
}

export interface ClippedBody {
  // Everything the caller is allowed to render normally.
  body: JSONContent;
  // Up to TEASER_NODES_AFTER_GATE prose nodes past the gate, shown faded under
  // the paywall gradient. Null when the reader has full access.
  teaser: JSONContent | null;
  locked: boolean;
}

// Split `body` for a reader on `tier`.
//
// Fails closed: if the article claims a gateTier but has no gate node (bad data,
// a botched migration, a save that dodged validation), the reader gets nothing
// rather than everything.
export function clipBodyForTier(
  body: JSONContent,
  gateTier: GateTier | null | undefined,
  tier: PlanTier,
): ClippedBody {
  if (!gateTier || tierAtLeast(tier, gateTier)) {
    return { body: stripGateNodes(body), teaser: null, locked: false };
  }

  const nodes = nodesOf(body);
  const gateIndex = findGateIndex(body);
  if (gateIndex === -1) {
    return { body: withNodes(body, []), teaser: null, locked: true };
  }

  const teaser: JSONContent[] = [];
  for (const node of nodes.slice(gateIndex + 1, gateIndex + 1 + TEASER_NODES_AFTER_GATE)) {
    if (!TEASER_NODE_TYPES.has(node?.type)) break;
    teaser.push(node);
  }

  return {
    body: withNodes(body, nodes.slice(0, gateIndex)),
    teaser: teaser.length > 0 ? withNodes(body, teaser) : null,
    locked: true,
  };
}

// Who is asking for the body. 'admin' is not a plan — it's the editor
// round-tripping the document, which is the one caller that needs the gate marker
// back. Every reader tier gets the marker stripped and the body clipped.
export type Audience = PlanTier | 'admin';

// Clip for a caller. This is the boundary every body-emitting route should go
// through: it keeps "the editor sees everything" from being spelled as "the
// editor is a premium reader", which silently strips the marker the editor needs
// and leaves the article unsaveable.
export function clipBodyForAudience(
  body: JSONContent,
  gateTier: GateTier | null | undefined,
  audience: Audience,
): ClippedBody {
  if (audience === 'admin') return { body, teaser: null, locked: false };
  return clipBodyForTier(body, gateTier, audience);
}

// Split a body at the gate for the embedding pipeline: `pre` is readable by
// everyone, `post` needs the article's gateTier. Fails closed the same way —
// gateTier with no gate node means the whole body counts as gated.
export function splitBodyAtGate(
  body: JSONContent,
  gateTier: GateTier | null | undefined,
): { pre: JSONContent; post: JSONContent } {
  const nodes = nodesOf(body).filter((node) => node?.type !== GATE_NODE_TYPE);
  if (!gateTier) return { pre: withNodes(body, nodes), post: withNodes(body, []) };

  const gateIndex = findGateIndex(body);
  if (gateIndex === -1) return { pre: withNodes(body, []), post: withNodes(body, nodes) };

  // `nodes` has the gate removed, so everything from gateIndex on is post-gate.
  return {
    pre: withNodes(body, nodes.slice(0, gateIndex)),
    post: withNodes(body, nodes.slice(gateIndex)),
  };
}
