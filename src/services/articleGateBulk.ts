// Rows for the bulk gate action (`F-001`).
//
// `gateTier` is set if and only if the body holds exactly one `gate` node, so
// gating a selection is a body edit, not a field write. That makes it the one
// bulk action an editor should see before it happens: this module turns a
// selection into rows the admin can read — where the cut lands, what is either
// side of it, which articles were left alone and why — and produces the body to
// save for the rows that survive.
//
// Preview and apply call the same function. Apply passes the hash the preview
// returned; if the body has changed since, the row is skipped as `stale` rather
// than cut at a point nobody approved. The client's index is never an input.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto';

import { countGateNodes, splitBodyAtGate, stripGateNodes } from '../lib/articleGate';
import { extractPlainText } from '../lib/articleText';
import {
  DEFAULT_GATE_FRACTION,
  insertGateNode,
  planGateInsertion,
  type GateSkipReason,
} from '../lib/gatePlacement';
import type { GateTier } from '../models/Article';

type JSONContent = any;

// How much prose either side of the cut the preview shows. Enough to recognise
// the paragraph, not enough to make the response a copy of the article.
export const GATE_SNIPPET_CHARS = 160;

export type GateRowReason =
  | GateSkipReason
  // The body changed between the preview and the write.
  | 'stale'
  // Asked to ungate an article that carries no gate.
  | 'not_gated';

export interface GateRow {
  id: string;
  slug: string;
  title: string;
  status: 'planned' | 'skipped';
  reason?: GateRowReason;
  // The body this row was planned against, so a later apply can prove the
  // article has not been edited since the editor looked at it.
  bodyHash: string;
  // The tier that would be written. Null when the row ungates.
  gateTier?: GateTier | null;
  // Present on planned rows only.
  index?: number;
  preChars?: number;
  totalChars?: number;
  preFraction?: number;
  before?: string;
  after?: string;
}

export interface GatePlanResult {
  row: GateRow;
  // The body to save, or null when the row was skipped.
  body: JSONContent | null;
}

// Any article-shaped object. Kept structural so the planner can be tested
// without a Mongoose document.
export interface GateBulkArticle {
  _id: unknown;
  slug?: string | null;
  title?: string | null;
  body?: JSONContent;
  gateTier?: GateTier | null;
}

// Stable fingerprint of a body. JSON.stringify over the stored document is
// enough: the comparison only ever runs against a hash this same function
// produced moments earlier from the same source, so key order is not in play.
export function hashArticleBody(body: JSONContent): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

function identity(article: GateBulkArticle, bodyHash: string) {
  return {
    id: String(article._id),
    slug: article.slug ?? '',
    title: article.title ?? '',
    bodyHash,
  };
}

function tail(text: string): string {
  return text.length > GATE_SNIPPET_CHARS ? `…${text.slice(-GATE_SNIPPET_CHARS)}` : text;
}

function head(text: string): string {
  return text.length > GATE_SNIPPET_CHARS ? `${text.slice(0, GATE_SNIPPET_CHARS)}…` : text;
}

export interface PlanGateOptions {
  gateTier: GateTier;
  fraction?: number;
  expectBodyHash?: string;
}

// Plan the gate for one article. Returns the row to report and, when the article
// can take the action, the body to write beside `gateTier`.
export function planGateRow(article: GateBulkArticle, options: PlanGateOptions): GatePlanResult {
  const { gateTier, fraction = DEFAULT_GATE_FRACTION, expectBodyHash } = options;
  const bodyHash = hashArticleBody(article.body);
  const base = identity(article, bodyHash);

  if (expectBodyHash && expectBodyHash !== bodyHash) {
    return { row: { ...base, status: 'skipped', reason: 'stale' }, body: null };
  }

  const placement = planGateInsertion(article.body, fraction);
  if (!placement.ok) {
    return { row: { ...base, status: 'skipped', reason: placement.reason }, body: null };
  }

  const { index, preChars, totalChars, preFraction } = placement.plan;
  const body = insertGateNode(article.body, index);
  const { pre, post } = splitBodyAtGate(body, gateTier);

  return {
    row: {
      ...base,
      status: 'planned',
      gateTier,
      index,
      preChars,
      totalChars,
      preFraction,
      before: tail(extractPlainText(pre)),
      after: head(extractPlainText(post)),
    },
    body,
  };
}

// The inverse: drop the marker and clear the tier. An editor who gates forty
// articles needs one gesture that undoes it.
export function planUngateRow(
  article: GateBulkArticle,
  options: { expectBodyHash?: string } = {},
): GatePlanResult {
  const bodyHash = hashArticleBody(article.body);
  const base = identity(article, bodyHash);

  if (options.expectBodyHash && options.expectBodyHash !== bodyHash) {
    return { row: { ...base, status: 'skipped', reason: 'stale' }, body: null };
  }

  if (countGateNodes(article.body) === 0) {
    return { row: { ...base, status: 'skipped', reason: 'not_gated' }, body: null };
  }

  return {
    row: { ...base, status: 'planned', gateTier: null },
    body: stripGateNodes(article.body),
  };
}
