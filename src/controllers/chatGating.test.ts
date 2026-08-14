// The gating regression pass for the chat HTTP path (migration plan open item 6).
//
// `lib/articleGate` and `lib/chatTierAccess` are already covered on their own. What
// was not covered is the wiring in `postChat` around them: that the tier comes from
// Clerk rather than the client, that the gate is consulted BEFORE a model call, and
// that a locked article's text never reaches the provider. Those are the parts that
// regress silently — a reordered await or a hardcoded tier still passes every
// unit test underneath it.
//
// The plan's first choice was a signed-in free/core session against the live
// endpoint. This is its documented alternative: mock `@clerk/express` and drive
// `postChat` directly. It needs no account and no network, so it runs in `npm test`
// on every change rather than once by hand.
//
// The load-bearing trick: `streamChat` is replaced with a stub that THROWS. Any test
// asserting a 4xx therefore also proves no model call was made — if the gate ever
// moves after the provider call, these tests fail loudly rather than passing while
// billing for a request that gets thrown away.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { PlanTier } from '../middleware/auth';

// Clerk is NOT mocked. `getAuth(req)` reads `req.auth()` off the request and hands
// the result through Clerk's own token-type check, so injecting an auth object on
// the fake request drives the real `getAuth` — the same code path production runs.
// That also means `tokenType: 'session_token'` is load-bearing below: without it
// Clerk returns a signed-out object, which is a real behaviour worth keeping in the
// test rather than mocking away.

// ── Test doubles ────────────────────────────────────────────────────────────

// Shaped like the slice of Clerk's AuthObject that middleware/auth reads. The real
// `getTier` runs against it, so plan-claim -> tier resolution is covered here too
// rather than being assumed.
function authFor(tier: PlanTier | 'signed-out') {
  const base = { tokenType: 'session_token' as const, sessionClaims: {} };
  if (tier === 'signed-out') return { ...base, userId: null, has: () => false };
  const plans: Record<Exclude<PlanTier, 'free'>, string> = {
    core: 'user:core',
    premium: 'user:premium',
  };
  const granted = tier === 'free' ? [] : [plans[tier]];
  return {
    ...base,
    userId: `user_${tier}`,
    has: ({ plan }: { plan: string }) => granted.includes(plan),
  };
}

let currentAuth: ReturnType<typeof authFor> = authFor('free');

interface FakeRes {
  statusCode: number | null;
  jsonBody: unknown;
  headWritten: boolean;
  chunks: string[];
  ended: boolean;
}

function makeRes(): { res: Response; state: FakeRes } {
  const state: FakeRes = {
    statusCode: null,
    jsonBody: undefined,
    headWritten: false,
    chunks: [],
    ended: false,
  };
  const res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.jsonBody = payload;
      return this;
    },
    writeHead(code: number) {
      state.statusCode = code;
      state.headWritten = true;
      return this;
    },
    flushHeaders() {},
    write(chunk: string) {
      state.chunks.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

function makeReq(body: Record<string, unknown>): Request {
  // `auth` is the hook Clerk's middleware installs; `getAuth` calls it.
  return { body, auth: () => currentAuth, on: () => {} } as unknown as Request;
}

// A published article gated at `gateTier`, with prose either side of the gate
// marker. The preamble matters: it is what makes "locked" a real decision rather
// than an empty-body accident.
const PREAMBLE = 'Free preamble that any reader may see.';
const GATED_TEXT = 'PAYWALLED-SENTINEL text that must never reach the provider.';

function articleFixture(gateTier: PlanTier | null, status = 'published') {
  return {
    _id: 'a1',
    title: 'Test Article',
    category: 'Politics',
    status,
    gateTier,
    publishDate: new Date('2026-01-01T00:00:00Z'),
    body: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: PREAMBLE }] },
        { type: 'gate' },
        { type: 'paragraph', content: [{ type: 'text', text: GATED_TEXT }] },
      ],
    },
  };
}

let currentArticle: ReturnType<typeof articleFixture> | null = articleFixture('premium');

// An article-scope thread owned by the caller, used by the resume tests.
let currentConversation: { _id: string; title: string; scope: string; articleId: string } | null = {
  _id: '507f1f77bcf86cd799439012',
  title: 'Test Article',
  scope: 'article',
  articleId: '507f1f77bcf86cd799439011',
};

// ── Module mocks ────────────────────────────────────────────────────────────

const streamChatCalls: unknown[] = [];
const retrieveCalls: { query: string; opts: { k: number; tier: PlanTier } }[] = [];

// The controller is imported on first use, after the remaining mocks are in place.
// `lib/anthropic` and `services/articleEmbeddings` are spread from the genuine
// modules so only the two functions that would hit the network are replaced —
// `resolveModelKey` and the tier config stay real, because the model key a tier
// resolves to is part of what is under test.
let controller: typeof import('./chat') | null = null;

async function setup(): Promise<typeof import('./chat')> {
  if (controller) return controller;

  const realAnthropic = await import('../lib/anthropic');
  const realEmbeddings = await import('../services/articleEmbeddings');

  // `findById` is awaited directly by postChat and chained
  // (`.select(...).lean()`) by getConversationDetail, so the mock has to be both
  // a thenable and a query builder.
  mock.module('../models/Article', {
    exports: {
      default: {
        findById: () => ({
          then: (resolve: (v: unknown) => unknown) => resolve(currentArticle),
          select: () => ({ lean: async () => currentArticle }),
        }),
      },
    },
  });

  mock.module('../models/ChatUsage', {
    exports: {
      default: {
        findOne: async () => null,
        findOneAndUpdate: async () => null,
      },
    },
  });

  mock.module('../models/Conversation', {
    exports: {
      default: {
        findOne: () => ({
          then: (resolve: (v: unknown) => unknown) => resolve(null),
          lean: async () => currentConversation,
        }),
        create: async () => ({ _id: 'c1' }),
      },
    },
  });

  mock.module('../models/ChatMessage', {
    exports: {
      default: {
        create: async () => ({}),
        insertMany: async () => [],
        find: () => ({ sort: () => ({ lean: async () => [] }) }),
      },
    },
  });

  mock.module('../lib/anthropic', {
    exports: {
      ...realAnthropic,
      // eslint-disable-next-line require-yield
      async *streamChat(params: unknown) {
        streamChatCalls.push(params);
        throw new Error('streamChat must not be reached on a rejected request');
      },
    },
  });

  mock.module('../services/articleEmbeddings', {
    exports: {
      ...realEmbeddings,
      async retrieveForTier(query: string, opts: { k: number; tier: PlanTier }) {
        retrieveCalls.push({ query, opts });
        return { passages: [], lockedHits: [] };
      },
    },
  });

  controller = await import('./chat');
  return controller;
}

async function postChat(req: Request, res: Response): Promise<void> {
  const mod = await setup();
  return mod.postChat(req, res);
}

async function getConversationDetail(req: Request, res: Response): Promise<void> {
  const mod = await setup();
  return mod.getConversationDetail(req, res);
}

function reset() {
  streamChatCalls.length = 0;
  retrieveCalls.length = 0;
  currentArticle = articleFixture('premium');
  currentAuth = authFor('free');
}

// Drive one article-scope turn as `tier` against an article gated at `gateTier`.
async function articleTurn(tier: PlanTier | 'signed-out', gateTier: PlanTier | null) {
  reset();
  currentAuth = authFor(tier);
  currentArticle = articleFixture(gateTier);
  const { res, state } = makeRes();
  await postChat(makeReq({ scope: 'article', articleId: '507f1f77bcf86cd799439011', message: 'Summarise this.' }), res);
  return state;
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('postChat gating', async (t) => {
  await t.test('a signed-out caller is rejected before anything else', async () => {
    const state = await articleTurn('signed-out', 'premium');
    assert.equal(state.statusCode, 401);
    assert.deepEqual(state.jsonBody, { error: 'unauthenticated' });
    assert.equal(streamChatCalls.length, 0);
  });

  await t.test('a free reader is refused a premium-gated article', async () => {
    const state = await articleTurn('free', 'premium');
    assert.equal(state.statusCode, 403);
    assert.deepEqual(state.jsonBody, { error: 'article_gated', requiredTier: 'premium' });
  });

  await t.test('a core reader is refused a premium-gated article', async () => {
    // The interesting middle case: paid, but not paid enough. A boolean
    // is-subscriber check instead of the tier ordering would let this through.
    const state = await articleTurn('core', 'premium');
    assert.equal(state.statusCode, 403);
    assert.deepEqual(state.jsonBody, { error: 'article_gated', requiredTier: 'premium' });
  });

  await t.test('the gate is checked before any model call', async () => {
    await articleTurn('free', 'premium');
    assert.equal(
      streamChatCalls.length,
      0,
      'a gated request reached the provider — the gate has moved after the model call',
    );
  });

  await t.test('gated text never reaches the provider or the client', async () => {
    const state = await articleTurn('free', 'core');
    assert.equal(state.statusCode, 403);
    const written = state.chunks.join('') + JSON.stringify(state.jsonBody ?? '');
    assert.doesNotMatch(written, /PAYWALLED-SENTINEL/);
    assert.doesNotMatch(JSON.stringify(streamChatCalls), /PAYWALLED-SENTINEL/);
  });

  await t.test('an eligible reader passes the gate and reaches generation', async () => {
    // Same fixture, one tier up. The stub throws on call, and postChat converts
    // that into a generation_failed SSE frame — which is the proof the gate was
    // cleared and the request went on to the provider.
    const state = await articleTurn('premium', 'premium');
    assert.notEqual(state.statusCode, 403);
    assert.equal(streamChatCalls.length, 1);
    assert.match(state.chunks.join(''), /generation_failed/);
  });

  await t.test('a core reader clears a core gate', async () => {
    const state = await articleTurn('core', 'core');
    assert.notEqual(state.statusCode, 403);
    assert.equal(streamChatCalls.length, 1);
  });

  await t.test('an ungated article is open to a free reader', async () => {
    const state = await articleTurn('free', null);
    assert.notEqual(state.statusCode, 403);
    assert.equal(streamChatCalls.length, 1);
  });

  await t.test('an unpublished article is refused even to premium', async () => {
    // Guards the draft-leak check that sits above the gate: the endpoint takes a
    // raw ObjectId from the client, so status is the only thing standing between
    // a guessed id and an unpublished draft read back in full.
    reset();
    currentAuth = authFor('premium');
    currentArticle = articleFixture(null, 'draft');
    const { res, state } = makeRes();
    await postChat(
      makeReq({ scope: 'article', articleId: '507f1f77bcf86cd799439011', message: 'Summarise this.' }),
      res,
    );
    assert.equal(state.statusCode, 400);
    assert.deepEqual(state.jsonBody, { error: 'article_not_found' });
    assert.equal(streamChatCalls.length, 0);
  });
});

test('postChat passes the caller-resolved tier into retrieval', async (t) => {
  // Retrieval is gated by the `requiredTier` filter inside the Atlas query, which
  // is only as good as the tier handed to it. A constant here (or a tier read from
  // the request body) would defeat the filter without failing anything downstream.
  for (const tier of ['free', 'core', 'premium'] as PlanTier[]) {
    await t.test(`scope:'resolve' as ${tier}`, async () => {
      reset();
      currentAuth = authFor(tier);
      const { res } = makeRes();
      await postChat(makeReq({ scope: 'resolve', message: 'What is happening in Balochistan?' }), res);
      assert.equal(retrieveCalls.length, 1);
      assert.equal(retrieveCalls[0].opts.tier, tier);
    });
  }

  await t.test('a tier claimed in the request body is ignored', async () => {
    reset();
    currentAuth = authFor('free');
    const { res } = makeRes();
    await postChat(
      makeReq({ scope: 'resolve', message: 'Anything gated?', tier: 'premium', plan: 'premium' }),
      res,
    );
    assert.equal(retrieveCalls[0].opts.tier, 'free');
  });
});

test('getConversationDetail reports whether the article is still readable', async (t) => {
  // A thread outlives the access it was started with: a plan lapses, or an
  // editor gates a story that was open at the time. The conversation record only
  // stores the article id, so the client cannot work this out — the server has
  // to say. This is what lets the reader be offered an upgrade on resume rather
  // than composing a message into a 403.
  function detailReq() {
    return {
      body: {},
      params: { id: '507f1f77bcf86cd799439012' },
      auth: () => currentAuth,
      on: () => {},
    } as unknown as Request;
  }

  async function resumeAs(tier: PlanTier, gateTier: PlanTier | null) {
    reset();
    currentAuth = authFor(tier);
    currentArticle = articleFixture(gateTier);
    const { res, state } = makeRes();
    await getConversationDetail(detailReq(), res);
    return state.jsonBody as { articleAccess?: { gateTier: string | null; locked: boolean } };
  }

  await t.test('locked when the reader has dropped below the gate', async () => {
    const body = await resumeAs('core', 'premium');
    assert.deepEqual(body.articleAccess, { gateTier: 'premium', locked: true });
  });

  await t.test('open when the reader still qualifies', async () => {
    const body = await resumeAs('premium', 'premium');
    assert.deepEqual(body.articleAccess, { gateTier: 'premium', locked: false });
  });

  await t.test('an ungated article is never reported locked', async () => {
    const body = await resumeAs('core', null);
    assert.deepEqual(body.articleAccess, { gateTier: null, locked: false });
  });

  await t.test('a free reader cannot resume at all', async () => {
    // Persisted history is a paid feature, so the detail endpoint refuses free
    // readers outright and `articleAccess` never applies to them. Asserted so
    // the parity check below can legitimately skip the free tier.
    reset();
    currentAuth = authFor('free');
    const { res, state } = makeRes();
    await getConversationDetail(detailReq(), res);
    assert.equal(state.statusCode, 403);
    assert.deepEqual(state.jsonBody, { error: 'forbidden' });
  });

  await t.test('the answer matches what postChat would decide', async () => {
    // The two must not drift: a resume that says "open" followed by a send that
    // 403s is the exact dead end this field exists to remove. Paid tiers only —
    // free readers never reach resume (above).
    for (const [tier, gateTier] of [
      ['core', 'premium'],
      ['premium', 'premium'],
      ['core', 'core'],
      ['premium', null],
      ['core', null],
    ] as [PlanTier, PlanTier | null][]) {
      const body = await resumeAs(tier, gateTier);
      const sendState = await articleTurn(tier, gateTier);
      assert.equal(
        body.articleAccess?.locked,
        sendState.statusCode === 403,
        `resume and send disagree for ${tier} on a ${gateTier ?? 'ungated'} article`,
      );
    }
  });

  await t.test('a non-article thread carries no access field', async () => {
    reset();
    currentAuth = authFor('premium');
    currentConversation = {
      _id: '507f1f77bcf86cd799439012',
      title: 'General thread',
      scope: 'resolve',
      articleId: '',
    };
    const { res, state } = makeRes();
    await getConversationDetail(detailReq(), res);
    assert.equal((state.jsonBody as { articleAccess?: unknown }).articleAccess, undefined);
  });
});
