// Regression pass for reading a Resend send response (`F-143`).
//
// `sendOne` used to set `emailStatus = 'sent'` unconditionally after the call. The
// Resend SDK does not throw on a rejected send — its `Response<T>` is
// `{ data, error: null } | { data: null, error }` — so an invalid address, an
// unverified domain, a bad API key or a rate limit all resolved, and the row was
// stamped `sent`. The segment then reported as fully delivered and was never
// retried, because `sendApprovedSegmentEmails` only re-sends `pending`/`failed`.
//
// The response shapes below are taken from the SDK's own types
// (`node_modules/resend/dist/index.d.mts`): `ErrorResponse` is
// `{ message, statusCode, name }`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readSendResult } from './briefEmail';

test('an accepted send is sent, and keeps the message id', () => {
  const outcome = readSendResult({ data: { id: 'msg_123' }, error: null });

  assert.deepEqual(outcome, { status: 'sent', messageId: 'msg_123' });
});

test('a rejected send is failed, not sent', () => {
  const outcome = readSendResult({
    data: null,
    error: { name: 'validation_error', message: 'Invalid `to` field.' },
  });

  assert.equal(outcome.status, 'failed', 'this is the whole finding: it used to be "sent"');
  assert.equal(
    outcome.status === 'failed' ? outcome.error : null,
    'validation_error: Invalid `to` field.',
  );
});

test('the recorded reason carries both the code and the message', () => {
  // Stringifying `ErrorResponse` whole yields "[object Object]", which detects the
  // failure but throws away why — the same slip this finding covers next door in
  // `services/email/resend.ts`.
  const outcome = readSendResult({
    data: null,
    error: { name: 'rate_limit_exceeded', message: 'Too many requests.' },
  });

  const recorded = outcome.status === 'failed' ? outcome.error : '';
  assert.ok(!recorded.includes('[object Object]'));
  assert.ok(recorded.includes('rate_limit_exceeded'));
  assert.ok(recorded.includes('Too many requests.'));
});

test('a very long provider message is truncated to the column budget', () => {
  const outcome = readSendResult({
    data: null,
    error: { name: 'application_error', message: 'x'.repeat(900) },
  });

  assert.equal(outcome.status === 'failed' ? outcome.error.length : 0, 500);
});

test('an accepted send with no message id stays sent, and is not re-sent', () => {
  // Deliberate: the union guarantees `data` when `error` is null, and a false
  // failure would be picked up by the retry path — a duplicate Brief in a
  // reader's inbox is worse than a null message id.
  const outcome = readSendResult({ data: null, error: null });

  assert.deepEqual(outcome, { status: 'sent', messageId: null });
});
