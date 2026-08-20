// Resend delivery webhook: turning one event into a write on the row that sent
// the message (`F-041`).
//
// Before this, `emailStatus = 'sent'` was the last thing anyone recorded about a
// Brief email. "Sent" meant Resend accepted the request, nothing more — a
// segment could report 100% sent while every message hard-bounced, and the only
// way to find out was to open the Resend dashboard.
//
// Parsing is kept separate from the write so the event shapes can be tested
// without a database.

import BriefRecipient from '../models/BriefRecipient';
import Notification from '../models/Notification';
import { outranks, type EmailDeliveryOutcome } from '../models/emailDelivery';

/**
 * The subset of Resend's event types this route acts on.
 *
 * `email.sent` is deliberately not among them: the send path already recorded
 * that, and it carries no information the row does not have. Engagement events
 * (`email.opened`, `email.clicked`) are not recorded either — reading them would
 * mean tracking pixels and link rewriting, which is a product decision, not a
 * delivery one. Everything else is acknowledged and ignored, so Resend does not
 * retry an event we simply do not want.
 */
const OUTCOME_BY_EVENT: Record<string, EmailDeliveryOutcome> = {
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.delivery_delayed': 'delayed',
  // A send Resend could not carry out at all. It never reached a mail server,
  // so it is not a bounce — but the message is dead either way, and recording it
  // as a bounce would misreport why.
  'email.failed': 'bounced',
};

export interface ResendWebhookEvent {
  type?: unknown;
  created_at?: unknown;
  data?: {
    email_id?: unknown;
    bounce?: { type?: unknown; subType?: unknown; message?: unknown };
    failed?: { reason?: unknown };
  };
}

export interface ParsedOutcome {
  messageId: string;
  outcome: EmailDeliveryOutcome;
  at: Date;
  detail: string | null;
}

/** Reads `created_at` if it is a usable timestamp, otherwise falls back to now. */
function eventTime(raw: unknown, now: Date): Date {
  if (typeof raw !== 'string') return now;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

/**
 * Why the message did not land, as the provider phrased it. Kept verbatim rather
 * than mapped to a local vocabulary: "Permanent/Suppressed" and
 * "Transient/MailboxFull" are the difference between an address that will never
 * work and one that might tomorrow, and inventing our own words for that loses
 * the distinction.
 */
function bounceDetail(data: ResendWebhookEvent['data']): string | null {
  const bounce = data?.bounce;
  if (bounce) {
    const kind = [bounce.type, bounce.subType].filter((part) => typeof part === 'string').join('/');
    const message = typeof bounce.message === 'string' ? bounce.message : '';
    const detail = [kind, message].filter(Boolean).join(': ');
    if (detail) return detail.slice(0, 500);
  }
  const reason = data?.failed?.reason;
  if (typeof reason === 'string' && reason) return reason.slice(0, 500);
  return null;
}

/**
 * Normalises one webhook event, or returns null for an event this route does not
 * act on — including a malformed one. Null means "acknowledge and drop": a 400
 * here would make Resend retry an event that will never parse.
 */
export function parseResendEvent(event: ResendWebhookEvent, now = new Date()): ParsedOutcome | null {
  const type = typeof event.type === 'string' ? event.type : '';
  const outcome = OUTCOME_BY_EVENT[type];
  if (!outcome) return null;

  const messageId = event.data?.email_id;
  if (typeof messageId !== 'string' || !messageId) return null;

  return {
    messageId,
    outcome,
    at: eventTime(event.created_at, now),
    detail: outcome === 'delivered' || outcome === 'delayed' ? null : bounceDetail(event.data),
  };
}

export interface RecordResult {
  briefRecipients: number;
  notifications: number;
}

/**
 * Writes an outcome onto whichever row sent the message.
 *
 * Both collections are checked because both send through Resend and a message id
 * belongs to exactly one of them; which one is not knowable from the event.
 *
 * The `emailDelivery` filter is what makes this safe to replay: an event that
 * does not outrank what is already recorded matches no row and writes nothing,
 * so a redelivered `email.delivered` cannot erase a complaint, and a duplicate
 * of an event already applied is a no-op rather than a second write.
 */
export async function recordEmailOutcome(parsed: ParsedOutcome): Promise<RecordResult> {
  const $set = {
    emailDelivery: parsed.outcome,
    emailDeliveryAt: parsed.at,
    emailDeliveryDetail: parsed.detail,
  };
  const weaker = weakerThan(parsed.outcome);

  const [brief, notification] = await Promise.all([
    BriefRecipient.updateOne(
      { emailMessageId: parsed.messageId, emailDelivery: { $in: weaker } },
      { $set },
    ),
    Notification.updateOne(
      { emailMessageId: parsed.messageId, emailDelivery: { $in: weaker } },
      { $set },
    ),
  ]);

  return {
    briefRecipients: brief.modifiedCount,
    notifications: notification.modifiedCount,
  };
}

/** Every outcome the given one is allowed to overwrite. */
export function weakerThan(next: EmailDeliveryOutcome): EmailDeliveryOutcome[] {
  return (['unknown', 'delayed', 'delivered', 'bounced', 'complained'] as EmailDeliveryOutcome[])
    .filter((current) => outranks(next, current));
}
