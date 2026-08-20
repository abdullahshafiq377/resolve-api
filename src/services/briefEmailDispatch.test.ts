// The Brief email dispatcher (`F-012`).
//
// Approving a segment used to send exactly one batch — ten recipients by default
// — and nothing swept the rest, so a segment with 200 readers mailed ten of them
// and then sat there until an admin pressed "retry delivery" twenty times.
// Delivery now belongs to `POST /api/cron/brief-email-dispatch`, and these tests
// pin the three properties that make a sweep safe to run every minute: it drains
// past one batch, it stops on a budget rather than on a timeout, and it gives up
// on a recipient that will never succeed.
//
// The models are mocked rather than reached: this suite runs without a database,
// like the rest of `src/services`. `RESEND_API_KEY` is deliberately absent, so
// every send inside `sendOne` records `resend_not_configured` and comes back
// `failed` — which is exactly the retry pressure the ceiling has to survive.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

interface FakeRecipient {
  _id: string;
  segmentId: string;
  emailEnabled: boolean;
  emailStatus: string;
  emailRetryCount: number;
  emailProvider: string | null;
  emailFailedAt: Date | null;
  emailLastError: string | null;
  deletedAt: Date | null;
  save: () => Promise<void>;
}

function recipient(id: string, segmentId: string): FakeRecipient {
  return {
    _id: id,
    segmentId,
    emailEnabled: true,
    emailStatus: 'pending',
    emailRetryCount: 0,
    emailProvider: null,
    emailFailedAt: null,
    emailLastError: null,
    deletedAt: null,
    async save() {},
  };
}

interface FakeSegment {
  _id: string;
  status: string;
  approvedAt: Date;
}

/** Applies the same predicate the service's filter expresses, over the fake store. */
function matches(row: FakeRecipient, filter: Record<string, any>): boolean {
  if (filter.segmentId?.$in) {
    if (!filter.segmentId.$in.map(String).includes(String(row.segmentId))) return false;
  } else if (filter.segmentId !== undefined && String(filter.segmentId) !== String(row.segmentId)) {
    return false;
  }
  if (row.deletedAt !== null) return false;
  if (filter.emailEnabled === true && !row.emailEnabled) return false;
  if (filter.emailStatus?.$in && !filter.emailStatus.$in.includes(row.emailStatus)) return false;
  if (filter.emailRetryCount?.$lt !== undefined && !(row.emailRetryCount < filter.emailRetryCount.$lt)) {
    return false;
  }
  return true;
}

async function setup(rows: FakeRecipient[], segments: FakeSegment[], batchSize = 10) {
  mock.restoreAll();
  process.env.RESOLVE_BRIEF_EMAIL_BATCH_SIZE = String(batchSize);
  delete process.env.RESEND_API_KEY;

  const sortedBy: string[] = [];

  mock.module('../models/BriefRecipient', {
    exports: {
      default: {
        find(filter: Record<string, any>) {
          const hits = rows.filter((row) => matches(row, filter));
          return { limit: (n: number) => Promise.resolve(hits.slice(0, n)) };
        },
        countDocuments: async (filter: Record<string, any>) =>
          rows.filter((row) => matches(row, filter)).length,
        distinct: async (field: string, filter: Record<string, any>) => [
          ...new Set(rows.filter((row) => matches(row, filter)).map((row) => (row as any)[field])),
        ],
        aggregate: async () => [],
      },
    },
  });

  mock.module('../models/BriefSegment', {
    exports: {
      default: {
        find(filter: Record<string, any>) {
          const ids = (filter._id?.$in ?? []).map(String);
          const hits = segments.filter(
            (segment) => ids.includes(String(segment._id)) && segment.status === filter.status,
          );
          return {
            sort(spec: Record<string, number>) {
              sortedBy.push(Object.keys(spec).join(','));
              return Promise.resolve(
                [...hits].sort((a, b) => a.approvedAt.getTime() - b.approvedAt.getTime()),
              );
            },
          };
        },
      },
    },
  });

  mock.module('./users', { exports: { findActiveUser: async () => ({ email: 'reader@example.com' }) } });
  mock.module('../config/clerk', { exports: { clerk: { users: { getUser: async () => ({}) } } } });

  const mod = await import(`./briefEmail?dispatch=${Math.random()}`);
  return { mod, sortedBy };
}

test('the queue filter asks for exactly the rows still waiting', async () => {
  const { mod } = await setup([], []);

  // No ceiling unless one is asked for: the manual "retry delivery" button is a
  // human deciding the reason is gone, and must not be capped.
  assert.deepEqual(mod.queuedRecipientFilter('seg'), {
    segmentId: 'seg',
    deletedAt: null,
    emailEnabled: true,
    emailStatus: { $in: ['pending', 'failed'] },
  });
  assert.deepEqual(mod.queuedRecipientFilter('seg', 3), {
    segmentId: 'seg',
    deletedAt: null,
    emailEnabled: true,
    emailStatus: { $in: ['pending', 'failed'] },
    emailRetryCount: { $lt: 3 },
  });
});

test('a segment larger than one batch is drained, not stopped at ten', async () => {
  // The finding itself: 25 recipients, batches of 10.
  const rows = Array.from({ length: 25 }, (_, i) => recipient(`r${i}`, 'seg'));
  const { mod } = await setup(rows, [{ _id: 'seg', status: 'approved', approvedAt: new Date(1) }]);

  const result = await mod.dispatchQueuedBriefEmails({ maxEmails: 1000, maxRetries: 1 });

  assert.equal(result.segments, 1);
  assert.equal(result.attempted, 25, 'every recipient is attempted, not just the first batch');
  assert.equal(result.capped, false);
  assert.equal(result.remaining, 0, 'nothing is left queued when the run completes');
});

test('a run stops on its budget and says so, leaving the rest for the next run', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => recipient(`r${i}`, 'seg'));
  const { mod } = await setup(rows, [{ _id: 'seg', status: 'approved', approvedAt: new Date(1) }]);

  const result = await mod.dispatchQueuedBriefEmails({ maxEmails: 30, maxRetries: 1 });

  assert.equal(result.capped, true);
  // The budget is checked between batches, so a run overshoots by at most one batch.
  assert.ok(result.attempted >= 30 && result.attempted <= 39, `attempted ${result.attempted}`);
  assert.ok(result.remaining > 0, 'the rest stays queued for the next run');
});

test('a permanently failing recipient is given up on, not retried for ever', async () => {
  // No RESEND_API_KEY, so every attempt fails. Without the ceiling this run never
  // terminates — the rows come straight back as `failed` and are picked up again.
  const rows = Array.from({ length: 4 }, (_, i) => recipient(`r${i}`, 'seg'));
  const { mod } = await setup(rows, [{ _id: 'seg', status: 'approved', approvedAt: new Date(1) }]);

  const result = await mod.dispatchQueuedBriefEmails({ maxEmails: 10_000, maxRetries: 3 });

  assert.equal(result.attempted, 12, '4 recipients × 3 attempts, then the ceiling holds');
  assert.equal(result.remaining, 0, 'exhausted rows are no longer queued');
  assert.ok(rows.every((row) => row.emailStatus === 'failed'));
  assert.ok(rows.every((row) => row.emailLastError === 'resend_not_configured'));
});

test('segments are drained oldest approval first, so a big one cannot starve a new one', async () => {
  const rows = [recipient('a1', 'older'), recipient('b1', 'newer')];
  const { mod, sortedBy } = await setup(rows, [
    { _id: 'newer', status: 'approved', approvedAt: new Date(2000) },
    { _id: 'older', status: 'approved', approvedAt: new Date(1000) },
  ]);

  const result = await mod.dispatchQueuedBriefEmails({ maxEmails: 1000, maxRetries: 1 });

  assert.equal(result.segments, 2);
  assert.deepEqual(sortedBy, ['approvedAt']);
});

test('a draft or rejected segment is never dispatched, however many rows it has', async () => {
  const rows = [recipient('d1', 'draft-seg'), recipient('r1', 'rejected-seg')];
  const { mod } = await setup(rows, [
    { _id: 'draft-seg', status: 'draft', approvedAt: new Date(1) },
    { _id: 'rejected-seg', status: 'rejected', approvedAt: new Date(1) },
  ]);

  const result = await mod.dispatchQueuedBriefEmails({ maxEmails: 1000, maxRetries: 3 });

  assert.equal(result.segments, 0);
  assert.equal(result.attempted, 0);
  assert.ok(rows.every((row) => row.emailStatus === 'pending'), 'unapproved mail is untouched');
});

test('an empty queue is a no-op, which is what most runs are', async () => {
  const { mod } = await setup([], [{ _id: 'seg', status: 'approved', approvedAt: new Date(1) }]);

  const result = await mod.dispatchQueuedBriefEmails({});

  assert.deepEqual(result, { segments: 0, attempted: 0, capped: false, remaining: 0 });
});
