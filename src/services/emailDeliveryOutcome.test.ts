// Resend delivery webhook parsing (`F-041`).
//
// The payload shapes below are Resend's own, from
// https://resend.com/docs/dashboard/webhooks/introduction — `data.email_id` is
// the id `resend.emails.send` returns, and a bounce carries
// `data.bounce = { type, subType, message }`.
//
// Only the pure half is covered here: `recordEmailOutcome` writes to Mongo and
// this suite runs without a database, matching the rest of `src/services`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResendEvent, weakerThan } from './emailDeliveryOutcome';
import { outranks } from '../models/emailDelivery';

const AT = '2026-08-19T09:30:00.000Z';

test('a delivery names the message and carries no failure detail', () => {
  const parsed = parseResendEvent({
    type: 'email.delivered',
    created_at: AT,
    data: { email_id: 'msg_1' },
  });

  assert.deepEqual(parsed, {
    messageId: 'msg_1',
    outcome: 'delivered',
    at: new Date(AT),
    detail: null,
  });
});

test('a bounce keeps the provider wording, type and subtype included', () => {
  const parsed = parseResendEvent({
    type: 'email.bounced',
    created_at: AT,
    data: {
      email_id: 'msg_2',
      bounce: {
        type: 'Permanent',
        subType: 'Suppressed',
        message: "The recipient's email address is on the suppression list.",
      },
    },
  });

  assert.equal(parsed?.outcome, 'bounced');
  // Permanent vs Transient is the difference between an address that will never
  // work and one that might tomorrow — losing it would make the record useless.
  assert.equal(
    parsed?.detail,
    "Permanent/Suppressed: The recipient's email address is on the suppression list.",
  );
});

test('a complaint is recorded, because it is the strongest signal there is', () => {
  const parsed = parseResendEvent({ type: 'email.complained', data: { email_id: 'msg_3' } });

  assert.equal(parsed?.outcome, 'complained');
});

test('a failed send is recorded as bounced, with its reason', () => {
  const parsed = parseResendEvent({
    type: 'email.failed',
    data: { email_id: 'msg_4', failed: { reason: 'Domain not verified' } },
  });

  assert.equal(parsed?.outcome, 'bounced');
  assert.equal(parsed?.detail, 'Domain not verified');
});

test('email.sent is ignored — the send path already recorded it', () => {
  assert.equal(parseResendEvent({ type: 'email.sent', data: { email_id: 'msg_5' } }), null);
});

test('engagement and unrelated events are ignored, not rejected', () => {
  for (const type of ['email.opened', 'email.clicked', 'domain.created', 'contact.updated']) {
    assert.equal(parseResendEvent({ type, data: { email_id: 'msg_6' } }), null, type);
  }
});

test('an event with no message id is dropped rather than half-applied', () => {
  // Null means "acknowledge and drop" at the route: a 400 would put an event
  // that can never parse into Resend's retry schedule.
  assert.equal(parseResendEvent({ type: 'email.bounced', data: {} }), null);
  assert.equal(parseResendEvent({ type: 'email.bounced' }), null);
  assert.equal(parseResendEvent({ type: 'email.bounced', data: { email_id: 42 } }), null);
});

test('a missing or unparseable created_at falls back to now', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  assert.deepEqual(parseResendEvent({ type: 'email.delivered', data: { email_id: 'a' } }, now)?.at, now);
  assert.deepEqual(
    parseResendEvent({ type: 'email.delivered', created_at: 'not a date', data: { email_id: 'a' } }, now)?.at,
    now,
  );
});

test('a bounce with no detail at all still records the outcome', () => {
  const parsed = parseResendEvent({ type: 'email.bounced', data: { email_id: 'msg_7', bounce: {} } });

  assert.equal(parsed?.outcome, 'bounced');
  assert.equal(parsed?.detail, null);
});

test('a stronger outcome overwrites a weaker one, never the reverse', () => {
  assert.ok(outranks('bounced', 'delivered'));
  assert.ok(outranks('complained', 'delivered'));
  // The whole point of the rank: Resend re-delivering email.delivered after a
  // complaint must not erase the complaint.
  assert.ok(!outranks('delivered', 'complained'));
  assert.ok(!outranks('delivered', 'bounced'));
});

test('an outcome does not overwrite itself, so a replayed event is a no-op', () => {
  assert.ok(!outranks('delivered', 'delivered'));
  assert.ok(!weakerThan('delivered').includes('delivered'));
});

test('the update filter lists exactly the outcomes an event may overwrite', () => {
  assert.deepEqual(weakerThan('delivered'), ['unknown', 'delayed']);
  assert.deepEqual(weakerThan('bounced'), ['unknown', 'delayed', 'delivered']);
  assert.deepEqual(weakerThan('complained'), ['unknown', 'delayed', 'delivered', 'bounced']);
  assert.deepEqual(weakerThan('delayed'), ['unknown']);
});
