// Regression pass for the Brief bulk endpoint (`F-014`).
//
// The endpoint's whole contract is that a selection is a rough gesture: rows that
// cannot take the action are SKIPPED, and the rest still go through. A batch that
// failed because one row was already approved would be useless, and a batch that
// silently reported those rows as done would be worse. These tests pin the split
// between `affected`, `skipped` and `failed`.
//
// They also pin the two rules that are easy to lose in a refactor: the eligibility
// check is the same one the single-segment route uses (so the two cannot drift),
// and an approved segment is not regenerated in bulk without the `F-013`
// acknowledgement.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

type Status = 'draft' | 'approved' | 'rejected';

interface FakeSegment {
  _id: string;
  status: Status;
  title: string | null;
  summary: string | null;
  stories: unknown[];
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  save: () => Promise<void>;
}

function segment(id: string, status: Status, complete = true): FakeSegment {
  return {
    _id: id,
    status,
    title: complete ? 'A title' : null,
    summary: complete ? 'A summary' : null,
    stories: complete ? [{ headline: 'One' }] : [],
    approvedAt: null,
    approvedBy: null,
    rejectedAt: null,
    rejectedBy: null,
    rejectionReason: null,
    async save() {},
  };
}

interface Harness {
  bulk: (req: Request, res: Response) => Promise<unknown>;
  /** Segments a send was actually attempted for — approve must never appear here. */
  emailCalls: string[];
  /** Segments whose queue was counted, i.e. the ones approve handed to the cron. */
  queueCounts: string[];
  regenerateCalls: { id: string; acknowledgeSent?: boolean }[];
}

async function setup(segments: FakeSegment[]): Promise<Harness> {
  mock.restoreAll();
  const emailCalls: string[] = [];
  const queueCounts: string[] = [];
  const regenerateCalls: { id: string; acknowledgeSent?: boolean }[] = [];

  mock.module('../models/BriefSegment', {
    exports: {
      default: {
        find: async () => segments,
        findById: async (id: string) => segments.find((s) => s._id === id) ?? null,
      },
    },
  });

  mock.module('../services/briefEmail', {
    exports: {
      async sendApprovedSegmentEmails(id: string) {
        emailCalls.push(id);
        return { attempted: 1, sent: 2, failed: 0, skipped: 0 };
      },
      async countQueuedRecipients(id: string) {
        queueCounts.push(id);
        return 7;
      },
    },
  });

  mock.module('../services/resolveBriefGeneration', {
    exports: {
      async processBriefGenerationBatch() {
        return {};
      },
      async regenerateSegment(id: string, _adminId: string, options?: { acknowledgeSent?: boolean }) {
        regenerateCalls.push({ id, acknowledgeSent: options?.acknowledgeSent });
        return {};
      },
    },
  });

  const mod = await import(`./adminBriefs?bulk=${Math.random()}`);
  return { bulk: mod.bulk, emailCalls, queueCounts, regenerateCalls };
}

/** Captures the JSON body and status a handler writes. */
function fakeRes() {
  const captured: { status: number; body: unknown } = { status: 200, body: null };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, captured };
}

function fakeReq(body: Record<string, unknown>): Request {
  // Clerk is not mocked: `getAuth(req)` reads `req.auth()` and runs its own
  // token-type check, so `tokenType` is load-bearing — without it Clerk returns a
  // signed-out object and the recorded admin id would be the 'admin' fallback.
  return {
    body,
    params: {},
    query: {},
    auth: () => ({ userId: 'user_admin', tokenType: 'session_token', sessionClaims: {} }),
  } as unknown as Request;
}

test('a mixed selection approves what it can and skips the rest', async () => {
  const segments = [
    segment('a', 'draft'),
    segment('b', 'approved'), // already approved — not approvable again
    segment('c', 'draft', false), // no synthesis — must never reach readers
  ];
  const harness = await setup(segments);
  const { res, captured } = fakeRes();

  await harness.bulk(fakeReq({ ids: ['a', 'b', 'c'], action: 'approve' }), res);

  const body = captured.body as {
    affected: number;
    skipped: number;
    failed: unknown[];
    email: { sent: number; queued: number };
  };
  assert.equal(body.affected, 1);
  assert.equal(body.skipped, 2);
  assert.deepEqual(body.failed, []);
  assert.equal(segments[0].status, 'approved');
  assert.equal(segments[2].status, 'draft', 'an incomplete draft is left alone');

  // `F-012`: approving queues, it does not send. Delivery is the cron's job, so
  // an approve batch that sent mail inline would be the bug coming back.
  assert.deepEqual(harness.emailCalls, [], 'approve must not send');
  assert.deepEqual(harness.queueCounts, ['a'], 'only the approved segment is queued');
  assert.equal(body.email.queued, 7);
  assert.equal(body.email.sent, 0);
});

test('one failing segment does not sink the batch', async () => {
  const segments = [segment('a', 'draft'), segment('b', 'draft')];
  segments[0].save = async () => {
    throw new Error('write_conflict');
  };
  const harness = await setup(segments);
  const { res, captured } = fakeRes();

  await harness.bulk(fakeReq({ ids: ['a', 'b'], action: 'reject', reason: 'Too thin' }), res);

  const body = captured.body as { affected: number; failed: { id: string; error: string }[] };
  assert.equal(body.affected, 1);
  assert.deepEqual(body.failed, [{ id: 'a', error: 'write_conflict' }]);
  assert.equal(segments[1].status, 'rejected');
  assert.equal(segments[1].rejectionReason, 'Too thin', 'the shared reason is recorded');
});

test('bulk regenerate skips an already-emailed segment unless the batch acknowledges it', async () => {
  const segments = [segment('a', 'draft'), segment('b', 'approved')];
  let harness = await setup(segments);
  let out = fakeRes();

  await harness.bulk(fakeReq({ ids: ['a', 'b'], action: 'regenerate' }), out.res);
  let body = out.captured.body as { affected: number; skipped: number };
  assert.equal(body.affected, 1);
  assert.equal(body.skipped, 1);
  assert.deepEqual(
    harness.regenerateCalls.map((call) => call.id),
    ['a'],
    'the sent segment must not be regenerated without acknowledgement',
  );

  harness = await setup([segment('a', 'draft'), segment('b', 'approved')]);
  out = fakeRes();
  await harness.bulk(
    fakeReq({ ids: ['a', 'b'], action: 'regenerate', acknowledgeSent: true }),
    out.res,
  );
  body = out.captured.body as { affected: number; skipped: number };
  assert.equal(body.affected, 2);
  assert.equal(body.skipped, 0);
  assert.equal(harness.regenerateCalls.length, 2);
  assert.ok(harness.regenerateCalls.every((call) => call.acknowledgeSent === true));
});

test('retry-email only touches approved segments', async () => {
  const harness = await setup([segment('a', 'draft'), segment('b', 'approved')]);
  const { res, captured } = fakeRes();

  await harness.bulk(fakeReq({ ids: ['a', 'b'], action: 'retry-email' }), res);

  const body = captured.body as { affected: number; skipped: number };
  assert.equal(body.affected, 1);
  assert.equal(body.skipped, 1);
  assert.deepEqual(harness.emailCalls, ['b']);
});

test('the request is rejected before any work when it is malformed', async () => {
  const harness = await setup([segment('a', 'draft')]);

  for (const body of [
    { ids: [], action: 'approve' },
    { ids: ['a'], action: 'delete' },
    { ids: Array.from({ length: 26 }, (_, i) => `id${i}`), action: 'approve' },
  ]) {
    const { res, captured } = fakeRes();
    await harness.bulk(fakeReq(body), res);
    assert.equal(captured.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.deepEqual(harness.emailCalls, [], 'a malformed request must do nothing');
});
