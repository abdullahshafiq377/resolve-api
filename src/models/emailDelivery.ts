// What the provider told us happened to a message *after* it accepted it.
//
// Deliberately separate from `emailStatus` on both `BriefRecipient` and
// `Notification`. Those record what the *sender* knows — pending, sent, failed —
// and drive the retry filter. Folding a bounce into `emailStatus = 'failed'`
// would have put a hard-bouncing address straight back into the re-send queue,
// which is the reputation damage this was recorded to prevent (`F-041`).

export const EMAIL_DELIVERY_OUTCOMES = [
  'unknown',
  'delayed',
  'delivered',
  'bounced',
  'complained',
] as const;
export type EmailDeliveryOutcome = (typeof EMAIL_DELIVERY_OUTCOMES)[number];

/**
 * Webhooks arrive out of order and are re-delivered on retry, so an outcome is
 * applied only when it outranks the one already recorded. Without this, Resend
 * re-sending `email.delivered` after `email.complained` would erase the
 * complaint — and a complaint is the strongest signal there is: the reader
 * pressed "spam".
 *
 * `bounced` outranks `delivered` for the same reason: the two are mutually
 * exclusive in reality, so seeing both means the order was wrong, not the fact.
 */
const RANK: Record<EmailDeliveryOutcome, number> = {
  unknown: 0,
  delayed: 1,
  delivered: 2,
  bounced: 3,
  complained: 4,
};

export function outranks(next: EmailDeliveryOutcome, current: EmailDeliveryOutcome): boolean {
  return RANK[next] > RANK[current];
}
