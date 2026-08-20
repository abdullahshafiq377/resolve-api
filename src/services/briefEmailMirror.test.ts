// Regression pass for resolving a Brief recipient's address from the local mirror
// (`F-038`).
//
// `sendOne` used to call `clerk.users.getUser` once per email sent, on the path
// that is already the slow one (see `F-012`). `User.email` is mirrored by the
// Clerk webhook, so the common case should be a local read with no round-trip.
//
// `recipientEmail` is tested directly rather than through `sendApprovedSegmentEmails`:
// the mail client is built at module load from `RESEND_API_KEY`, and interposing a
// fake there tests the plumbing rather than the rule. The rule is which source is
// consulted, in what order, and what happens when each one is empty.
//
// The load-bearing assertion is the negative one: on a mirror hit, Clerk must not
// be called at all. Without it these tests would pass against the old code too, so
// the Clerk stub also *throws* — a mirror hit that reached it would fail loudly
// rather than quietly costing a round-trip.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

interface Harness {
  recipientEmail: (clerkUserId: string) => Promise<string | null>;
  calls: () => number;
}

async function setup(mirrorEmail: string | null, clerkEmail: string | null | 'throws'): Promise<Harness> {
  mock.restoreAll();
  const state = { getUserCalls: 0 };

  mock.module('../config/clerk', {
    exports: {
      clerk: {
        users: {
          getUser: async () => {
            state.getUserCalls += 1;
            if (clerkEmail === 'throws') {
              throw new Error('Clerk must not be reached when the mirror has the address');
            }
            return {
              primaryEmailAddressId: 'e1',
              emailAddresses: clerkEmail ? [{ id: 'e1', emailAddress: clerkEmail }] : [],
            };
          },
        },
      },
    },
  });

  mock.module('./users', {
    exports: {
      findActiveUser: async () => (mirrorEmail === null ? null : { email: mirrorEmail }),
    },
  });

  const mod = await import(`./briefEmail?mirror=${Math.random()}`);
  return { recipientEmail: mod.recipientEmail, calls: () => state.getUserCalls };
}

test('a mirrored address is used, without calling Clerk at all', async () => {
  const harness = await setup('reader@example.com', 'throws');

  assert.equal(await harness.recipientEmail('user_1'), 'reader@example.com');
  assert.equal(harness.calls(), 0, 'the mirror hit must not cost a Clerk round-trip');
});

test('a recipient the mirror has never seen still resolves, via Clerk', async () => {
  const harness = await setup(null, 'reader@clerk.example');

  assert.equal(await harness.recipientEmail('user_1'), 'reader@clerk.example');
  assert.equal(harness.calls(), 1, 'a cold mirror falls back rather than dropping the send');
});

test('a mirror row that carries no address falls back rather than returning null', async () => {
  const harness = await setup(null, 'reader@clerk.example');

  assert.equal(await harness.recipientEmail('user_1'), 'reader@clerk.example');
  assert.equal(harness.calls(), 1);
});

test('no address in either source resolves to null, so the send is skipped', async () => {
  const harness = await setup(null, null);

  assert.equal(await harness.recipientEmail('user_1'), null);
  assert.equal(harness.calls(), 1);
});

test('the mirror wins even when Clerk holds a different address', async () => {
  // The mirror is fed by the webhook, so a disagreement means the webhook is
  // behind — but preferring Clerk here would reinstate the per-send round-trip
  // this finding removed. `F-044` is the finding that covers stale mirror rows.
  const harness = await setup('mirrored@example.com', 'different@clerk.example');

  assert.equal(await harness.recipientEmail('user_1'), 'mirrored@example.com');
  assert.equal(harness.calls(), 0);
});
