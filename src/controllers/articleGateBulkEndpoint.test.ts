// The bulk gate endpoint (`F-001`).
//
// `gateTier` is set if and only if the body holds one `gate` node, so this is the
// one bulk action that rewrites bodies. Three properties matter enough to pin:
//
//   - `gate-preview` writes nothing. Ever.
//   - `gate` recomputes placement and compares the hash the preview returned, so
//     an article edited in between is skipped rather than cut blind. The index
//     the client sends back is not an input at all.
//   - The pair invariant holds on every written row: a body with a gate node and
//     a tier, or neither.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import { countGateNodes } from '../lib/articleGate';
import { hashArticleBody } from '../services/articleGateBulk';

/* eslint-disable @typescript-eslint/no-explicit-any */

function para(chars: number, fill = 'a'): any {
  return { type: 'paragraph', content: [{ type: 'text', text: fill.repeat(chars) }] };
}

function longBody(): any {
  return { type: 'doc', content: Array.from({ length: 9 }, () => para(100)) };
}

interface FakeArticle {
  _id: string;
  slug: string;
  title: string;
  status: string;
  body: any;
  gateTier?: string | null;
}

// Real ObjectId-shaped ids: the endpoint validates the selection before it does
// anything else, so a readable stub id would 400 for the wrong reason.
function oid(seed: string): string {
  return seed.padStart(24, '0');
}

function fake(seed: string, overrides: Partial<FakeArticle> = {}): FakeArticle {
  const id = oid(seed);
  return {
    _id: id,
    slug: `slug-${seed}`,
    title: `Article ${seed}`,
    status: 'published',
    body: longBody(),
    ...overrides,
  };
}

interface Written {
  id: string;
  patch: Record<string, any>;
  unset: Record<string, any>;
}

// One controller module, reloaded once. `mock.module` is installed before the
// first import and the mocks read through this mutable state, so every later
// test swaps the data rather than trying to re-import a cached module.
const state: {
  articles: FakeArticle[];
  writes: Written[];
  embedded: string[];
  activity: any[];
} = { articles: [], writes: [], embedded: [], activity: [] };

let controller: { bulk: (req: Request, res: Response) => Promise<unknown> } | null = null;

async function setup(articles: FakeArticle[]) {
  state.articles = articles;
  state.writes = [];
  state.embedded = [];
  state.activity = [];

  if (!controller) {
    mock.module('../models/Article', {
      exports: {
        default: {
          find: async () => state.articles,
          findByIdAndUpdate: async (id: string, update: Record<string, any>) => {
            const patch = (update.$set ?? update) as Record<string, any>;
            const unset = (update.$unset ?? {}) as Record<string, any>;
            state.writes.push({ id: String(id), patch, unset });
            const target = state.articles.find((a) => a._id === String(id))!;
            return { ...target, ...patch, _id: target._id };
          },
        },
        ARTICLE_STATUSES: ['draft', 'scheduled', 'published', 'archived'],
        GATE_TIERS: ['core', 'premium'],
      },
    });

    mock.module('../services/articleEmbeddings', {
      exports: {
        async syncArticleEmbeddings(article: FakeArticle) {
          state.embedded.push(String(article._id));
        },
        async purgeArticleChunks() {},
      },
    });

    mock.module('../services/activity', {
      exports: {
        actorFromRequest: () => 'actor-1',
        async recordActivities(drafts: any[]) {
          state.activity.push(...drafts);
        },
        async purgeActivity() {},
        async listActivity() {
          return [];
        },
        ACTIVITY_DEFAULT_LIMIT: 20,
      },
    });

    controller = await import('./articles');
  }

  return {
    bulk: controller.bulk,
    get writes() {
      return state.writes;
    },
    get embedded() {
      return state.embedded;
    },
    get activity() {
      return state.activity;
    },
  };
}

function request(body: Record<string, unknown>): Request {
  return { body, query: {}, params: {} } as unknown as Request;
}

function response() {
  const captured: { status: number; payload: any } = { status: 200, payload: null };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: any) {
      captured.payload = payload;
      return res;
    },
  };
  return { res: res as unknown as Response, captured };
}

test('gate-preview reports a plan per article and writes nothing', async () => {
  const { bulk, writes, embedded } = await setup([fake('a1'), fake('a2')]);
  const { res, captured } = response();

  await bulk(request({ ids: [oid('a1'), oid('a2')], action: 'gate-preview', gateTier: 'premium' }), res);

  assert.equal(captured.status, 200);
  assert.equal(captured.payload.planned, 2);
  assert.equal(captured.payload.skipped, 0);
  assert.equal(captured.payload.rows.length, 2);
  assert.equal(captured.payload.rows[0].index, 3);
  assert.ok(captured.payload.rows[0].bodyHash);
  assert.deepEqual(writes, [], 'preview must not write');
  assert.deepEqual(embedded, [], 'preview must not re-embed');
});

test('gate-preview honours a caller-supplied fraction', async () => {
  const { bulk } = await setup([fake('a1')]);
  const { res, captured } = response();

  await bulk(
    request({ ids: [oid('a1')], action: 'gate-preview', gateTier: 'core', fraction: 0.5 }),
    res,
  );

  assert.equal(captured.payload.fraction, 0.5);
  assert.equal(captured.payload.rows[0].index, 4);
});

test('gate-preview separates the rows it cannot gate, with reasons', async () => {
  const short = fake('a2', { body: { type: 'doc', content: [para(40), para(40)] } });
  const { bulk } = await setup([fake('a1'), short]);
  const { res, captured } = response();

  await bulk(request({ ids: [oid('a1'), oid('a2')], action: 'gate-preview', gateTier: 'core' }), res);

  assert.equal(captured.payload.planned, 1);
  assert.equal(captured.payload.skipped, 1);
  const skipped = captured.payload.rows.find((row: any) => row.status === 'skipped');
  assert.equal(skipped.reason, 'too_short');
  assert.equal(skipped.slug, 'slug-a2');
});

test('gate writes the body and the tier as a pair', async () => {
  const target = fake('a1');
  const { bulk, writes, embedded, activity } = await setup([target]);
  const { res, captured } = response();

  await bulk(
    request({
      ids: [oid('a1')],
      action: 'gate',
      gateTier: 'premium',
      expect: [{ id: oid('a1'), bodyHash: hashArticleBody(target.body) }],
    }),
    res,
  );

  assert.equal(captured.status, 200);
  assert.equal(captured.payload.affected, 1);
  assert.equal(writes.length, 1);
  assert.equal(countGateNodes(writes[0].patch.body), 1);
  assert.equal(writes[0].patch.gateTier, 'premium');
  assert.deepEqual(embedded, [oid('a1')], 'a published article re-embeds around its new gate');
  assert.equal(activity.length, 1);
  assert.equal(activity[0].action, 'gate_changed');
  assert.deepEqual(activity[0].metadata, { from: null, to: 'premium' });
});

test('gate skips an article whose body moved since the preview', async () => {
  const target = fake('a1');
  const { bulk, writes } = await setup([target]);
  const { res, captured } = response();

  await bulk(
    request({
      ids: [oid('a1')],
      action: 'gate',
      gateTier: 'premium',
      expect: [{ id: oid('a1'), bodyHash: hashArticleBody({ type: 'doc', content: [para(1)] }) }],
    }),
    res,
  );

  assert.equal(captured.payload.affected, 0);
  assert.equal(captured.payload.skipped, 1);
  assert.equal(captured.payload.rows[0].reason, 'stale');
  assert.deepEqual(writes, []);
});

test('gate ignores any index the client sends and recomputes its own', async () => {
  const target = fake('a1');
  const { bulk, writes } = await setup([target]);
  const { res } = response();

  await bulk(
    request({
      ids: [oid('a1')],
      action: 'gate',
      gateTier: 'core',
      expect: [{ id: oid('a1'), bodyHash: hashArticleBody(target.body), index: 8 }],
    }),
    res,
  );

  assert.equal(writes[0].patch.body.content[3].type, 'gate', 'index 3 is the recomputed one');
});

test('gate refuses a selection with no expectations to check against', async () => {
  const { bulk, writes } = await setup([fake('a1')]);
  const { res, captured } = response();

  await bulk(request({ ids: [oid('a1')], action: 'gate', gateTier: 'core' }), res);

  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error, 'gate_expect_required');
  assert.deepEqual(writes, []);
});

test('gate rejects a fraction outside the open unit interval', async () => {
  const { bulk } = await setup([fake('a1')]);
  const { res, captured } = response();

  await bulk(request({ ids: [oid('a1')], action: 'gate-preview', gateTier: 'core', fraction: 0 }), res);

  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error, 'invalid_gate_fraction');
});

test('gate rejects an unknown tier', async () => {
  const { bulk } = await setup([fake('a1')]);
  const { res, captured } = response();

  await bulk(request({ ids: [oid('a1')], action: 'gate-preview', gateTier: 'platinum' }), res);

  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error, 'invalid_gateTier');
});

test('gate caps the selection so one call cannot re-embed the archive', async () => {
  const many = Array.from({ length: 60 }, (_, i) => fake(`a${i}`));
  const { bulk, writes } = await setup(many);
  const { res, captured } = response();

  await bulk(
    request({ ids: many.map((a) => a._id), action: 'gate-preview', gateTier: 'core' }),
    res,
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error, 'gate_bulk_too_many');
  assert.deepEqual(writes, []);
});

test('gateTier none ungates: the marker goes and the tier is cleared', async () => {
  const gated = fake('a1', {
    body: { type: 'doc', content: [para(400), { type: 'gate' }, para(400)] },
    gateTier: 'core',
  });
  const { bulk, writes, activity } = await setup([gated]);
  const { res, captured } = response();

  await bulk(
    request({
      ids: [oid('a1')],
      action: 'gate',
      gateTier: 'none',
      expect: [{ id: oid('a1'), bodyHash: hashArticleBody(gated.body) }],
    }),
    res,
  );

  assert.equal(captured.payload.affected, 1);
  assert.equal(countGateNodes(writes[0].patch.body), 0);
  assert.equal(writes[0].unset.gateTier, 1, 'the tier is unset, not written as null');
  assert.deepEqual(activity[0].metadata, { from: 'core', to: null });
});

test('a draft article is gated but not re-embedded', async () => {
  const draft = fake('a1', { status: 'draft' });
  const { bulk, writes, embedded } = await setup([draft]);
  const { res } = response();

  await bulk(
    request({
      ids: [oid('a1')],
      action: 'gate',
      gateTier: 'core',
      expect: [{ id: oid('a1'), bodyHash: hashArticleBody(draft.body) }],
    }),
    res,
  );

  assert.equal(writes.length, 1);
  assert.deepEqual(embedded, [], 'an unpublished article has no chunks to resync');
});

test('gate refuses when a selected article was never previewed', async () => {
  const one = fake('a1');
  const { bulk, writes } = await setup([one, fake('a2')]);
  const { res, captured } = response();

  await bulk(
    request({
      ids: [oid('a1'), oid('a2')],
      action: 'gate',
      gateTier: 'core',
      expect: [{ id: oid('a1'), bodyHash: hashArticleBody(one.body) }],
    }),
    res,
  );

  assert.equal(captured.status, 400);
  assert.equal(captured.payload.error, 'gate_expect_missing_ids');
  assert.deepEqual(captured.payload.ids, [oid('a2')]);
  assert.deepEqual(writes, [], 'a partial expectation set writes nothing at all');
});
