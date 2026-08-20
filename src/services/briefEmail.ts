import mongoose from 'mongoose';
import { Resend } from 'resend';
import { clerk } from '../config/clerk';
import BriefRecipient, { BriefRecipientDoc } from '../models/BriefRecipient';
import BriefSegment, { BriefSegmentDoc } from '../models/BriefSegment';
import { findActiveUser } from './users';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESOLVE_BRIEF_EMAIL_FROM || 'The Resolve Brief <brief@example.com>';
const APP_URL = process.env.RESOLVE_APP_URL || 'http://localhost:3000';
const EMAIL_BATCH_SIZE = Math.max(1, Number(process.env.RESOLVE_BRIEF_EMAIL_BATCH_SIZE) || 10);

/**
 * Roughly the most emails one dispatcher run will send, across all segments.
 *
 * Sends are serial, so this is really a wall-clock budget: the run has to finish
 * inside the caller's HTTP timeout (cron-job.org gives 30s by default). A run
 * that hits the cap leaves the rest queued and the next run picks up exactly
 * where it stopped, so a 2,000-recipient segment drains over several runs rather
 * than failing one long request.
 *
 * Soft, not exact: the budget is checked between batches, so a run can overshoot
 * by up to one `RESOLVE_BRIEF_EMAIL_BATCH_SIZE`. Stopping mid-batch would buy
 * precision nobody needs and a partially-sent batch to reason about.
 */
const DISPATCH_MAX_PER_RUN = Math.max(1, Number(process.env.RESOLVE_BRIEF_EMAIL_DISPATCH_MAX) || 100);

/**
 * How many times the dispatcher will attempt one recipient before leaving it
 * alone.
 *
 * Without a ceiling the sweep is a perpetual motion machine: a row that fails for
 * a reason that will never change — a malformed address Resend rejects outright —
 * comes back `failed`, is picked up again on the next run, and is re-sent every
 * few minutes for ever. `emailRetryCount` already counts every attempt, including
 * the first.
 *
 * The manual "retry delivery" button deliberately ignores this: a human pressing
 * it has decided the reason is gone.
 */
const DISPATCH_MAX_RETRIES = Math.max(1, Number(process.env.RESOLVE_BRIEF_EMAIL_MAX_RETRIES) || 3);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function absolutize(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${APP_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function buildBriefEmailHtml(segment: BriefSegmentDoc): string {
  const stories = segment.stories
    .sort((a, b) => a.order - b.order)
    .map(
      (story) => `
        <li style="margin:0 0 12px;">
          <a href="${escapeHtml(absolutize(story.url))}" style="color:#111827;font-weight:700;text-decoration:none;">${escapeHtml(story.headline)}</a>
        </li>
      `,
    )
    .join('');

  const note = segment.editorialNote
    ? `<p style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:16px;color:#374151;">${escapeHtml(segment.editorialNote)}</p>`
    : '';

  // The email is the morning edition: lead with the day's title + the full
  // synthesis summary (paragraph-split), then the "Go Deeper" story headlines.
  const title = segment.title
    ? `<h2 style="font-size:24px;line-height:1.2;margin:0 0 12px;">${escapeHtml(segment.title)}</h2>`
    : '';
  const summaryBody = (segment.summary ?? '')
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p style="font-size:17px;line-height:1.6;margin:0 0 16px;">${escapeHtml(para)}</p>`)
    .join('');

  return `
    <div style="font-family:Georgia,'Times New Roman',serif;max-width:640px;margin:0 auto;padding:24px;color:#111827;">
      <p style="font-family:Arial,sans-serif;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#92400e;">The Resolve Brief</p>
      <h1 style="font-size:30px;line-height:1.15;margin:0 0 8px;">The Resolve Brief</h1>
      <p style="font-family:Arial,sans-serif;color:#6b7280;margin:0 0 20px;">${escapeHtml(segment.briefDate)}</p>
      ${title}
      <div style="margin:0 0 24px;">${summaryBody}</div>
      <ol style="padding-left:22px;margin:0;">${stories}</ol>
      ${note}
      <p style="font-family:Arial,sans-serif;font-size:13px;color:#6b7280;margin-top:28px;">
        Manage Brief email preferences in your
        <a href="${escapeHtml(absolutize('/account?section=brief'))}" style="color:#92400e;">Resolve account</a>.
      </p>
    </div>
  `;
}

function primaryEmail(user: Awaited<ReturnType<typeof clerk.users.getUser>>): string | null {
  const primaryId = user.primaryEmailAddressId;
  const primary = user.emailAddresses.find((email) => email.id === primaryId);
  return primary?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
}

/**
 * The address to send this recipient's Brief to.
 *
 * `User.email` is mirrored by the Clerk webhook, so the common path is a local
 * read — this used to be one `clerk.users.getUser` round-trip per email sent, on
 * the path that is already the slow one (`F-038`, and see `F-012`). Clerk stays
 * as the fallback for a recipient the mirror has never seen or whose row carries
 * no address, so a cold mirror still delivers rather than skipping.
 */
export async function recipientEmail(clerkUserId: string): Promise<string | null> {
  const mirrored = await findActiveUser(clerkUserId);
  if (mirrored?.email) return mirrored.email;
  const user = await clerk.users.getUser(clerkUserId);
  return primaryEmail(user);
}

/** What a Resend send attempt actually amounted to. */
export type SendOutcome =
  | { status: 'sent'; messageId: string | null }
  | { status: 'failed'; error: string };

/**
 * Reads a Resend send response.
 *
 * Resend reports a rejected send in the response body rather than throwing — its
 * `Response<T>` is `{ data, error: null } | { data: null, error }` — so an invalid
 * address, an unverified domain, a bad API key or a rate limit all arrive as a
 * resolved promise. This used to be `emailStatus = 'sent'` unconditionally, which
 * meant a wholly undelivered segment reported as fully sent, and was never retried
 * because only `pending`/`failed` rows are re-sent (`F-143`). A `try/catch` around
 * the call does not help: it only ever sees transport failures.
 *
 * A success with no `data.id` is deliberately NOT treated as a failure. The union
 * guarantees `data` whenever `error` is null, and a false failure would be re-sent
 * by the retry path — a duplicate Brief in a reader's inbox is a worse outcome
 * than a null message id.
 */
export function readSendResult(response: {
  data: { id: string } | null;
  error: { name: string; message: string } | null;
}): SendOutcome {
  if (response.error) {
    // `ErrorResponse` is an object, so stringifying it whole yields
    // "[object Object]" — name and message are what identify the failure.
    return {
      status: 'failed',
      error: `${response.error.name}: ${response.error.message}`.slice(0, 500),
    };
  }
  return { status: 'sent', messageId: response.data?.id ?? null };
}

async function sendOne(segment: BriefSegmentDoc, recipient: BriefRecipientDoc): Promise<void> {
  if (!recipient.emailEnabled) {
    recipient.emailStatus = 'not_requested';
    await recipient.save();
    return;
  }
  if (recipient.emailStatus === 'sent') return;
  if (!resend) {
    recipient.emailStatus = 'failed';
    recipient.emailProvider = 'resend';
    recipient.emailFailedAt = new Date();
    recipient.emailRetryCount += 1;
    recipient.emailLastError = 'resend_not_configured';
    await recipient.save();
    return;
  }

  recipient.emailStatus = 'pending';
  recipient.emailProvider = 'resend';
  recipient.emailRetryCount += 1;
  await recipient.save();

  try {
    const to = await recipientEmail(recipient.clerkUserId);
    if (!to) {
      recipient.emailStatus = 'skipped';
      recipient.emailLastError = 'missing_email';
      await recipient.save();
      return;
    }

    const outcome = readSendResult(
      await resend.emails.send({
        from: FROM,
        to,
        subject: `The Resolve Brief - ${segment.briefDate}`,
        html: buildBriefEmailHtml(segment),
      }),
    );

    if (outcome.status === 'failed') {
      recipient.emailStatus = 'failed';
      recipient.emailFailedAt = new Date();
      recipient.emailLastError = outcome.error;
    } else {
      recipient.emailStatus = 'sent';
      recipient.emailMessageId = outcome.messageId;
      recipient.emailSentAt = new Date();
      recipient.emailFailedAt = null;
      recipient.emailLastError = null;
    }
  } catch (err) {
    recipient.emailStatus = 'failed';
    recipient.emailFailedAt = new Date();
    recipient.emailLastError = err instanceof Error ? err.message.slice(0, 500) : 'email_failed';
  }
  await recipient.save();
}

/**
 * The filter for "recipients still waiting on their Brief".
 *
 * `pending` is a row that has never been sent or whose send died mid-flight;
 * `failed` is one that came back with an error worth another go. Anything `sent`,
 * `skipped` or `not_requested` is finished with.
 *
 * `maxRetries` is what stops the dispatcher retrying a permanently broken address
 * for ever. The manual retry path passes nothing and gets no ceiling.
 */
export function queuedRecipientFilter(segmentId: mongoose.Types.ObjectId | string, maxRetries?: number) {
  const filter: Record<string, unknown> = {
    segmentId,
    deletedAt: null,
    emailEnabled: true,
    emailStatus: { $in: ['pending', 'failed'] },
  };
  if (maxRetries !== undefined) filter.emailRetryCount = { $lt: maxRetries };
  return filter;
}

/** How many recipients of this segment are still waiting to be sent to. */
export async function countQueuedRecipients(segmentId: string, maxRetries?: number): Promise<number> {
  return BriefRecipient.countDocuments(queuedRecipientFilter(segmentId, maxRetries));
}

/** One batch, sent. Returns how many recipients were actually attempted. */
async function sendQueuedBatch(
  segment: BriefSegmentDoc,
  options?: { recipientId?: string; maxRetries?: number },
): Promise<number> {
  const filter = queuedRecipientFilter(segment._id as mongoose.Types.ObjectId, options?.maxRetries);
  if (options?.recipientId) filter._id = options.recipientId;

  const recipients = await BriefRecipient.find(filter).limit(EMAIL_BATCH_SIZE);
  for (const recipient of recipients) await sendOne(segment, recipient);
  return recipients.length;
}

export async function sendApprovedSegmentEmails(
  segmentId: string,
  recipientId?: string,
  options?: { maxRetries?: number },
): Promise<{ attempted: number; sent: number; failed: number; skipped: number }> {
  const segment = await BriefSegment.findById(segmentId);
  if (!segment || segment.status !== 'approved') return { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  const attempted = await sendQueuedBatch(segment, { recipientId, maxRetries: options?.maxRetries });

  const counts = await BriefRecipient.aggregate([
    { $match: { segmentId: segment._id } },
    { $group: { _id: '$emailStatus', count: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((row) => [row._id, row.count]));
  return {
    attempted,
    sent: map.get('sent') ?? 0,
    failed: map.get('failed') ?? 0,
    skipped: map.get('skipped') ?? 0,
  };
}

export interface DispatchResult {
  /** Approved segments that had queued recipients when the run started. */
  segments: number;
  /** Recipients actually attempted this run. */
  attempted: number;
  /** True when the run stopped on its budget rather than on an empty queue. */
  capped: boolean;
  /** Recipients still queued across all approved segments after the run. */
  remaining: number;
}

/**
 * Sends the Brief to everyone still queued for it, across every approved segment
 * (`F-012`).
 *
 * Approval used to send exactly one batch — `RESOLVE_BRIEF_EMAIL_BATCH_SIZE`, ten
 * by default — and nothing swept the rest. A segment with 200 recipients emailed
 * ten readers and then sat there until an admin pressed "retry delivery" twenty
 * times. Approval now only marks the segment approved; this is what delivers it.
 *
 * Oldest approval first, so a large segment cannot starve the one approved after
 * it: each run gives every waiting segment a turn in the order they were
 * approved, and a segment that does not finish is simply first in line next run.
 */
export async function dispatchQueuedBriefEmails(options?: {
  maxEmails?: number;
  maxRetries?: number;
}): Promise<DispatchResult> {
  const budget = Math.max(1, options?.maxEmails ?? DISPATCH_MAX_PER_RUN);
  const maxRetries = options?.maxRetries ?? DISPATCH_MAX_RETRIES;

  // Which approved segments have anyone waiting. Reading the ids first keeps the
  // sweep off segments with nothing to do, which is every segment on most runs.
  const queuedSegmentIds = await BriefRecipient.distinct('segmentId', {
    deletedAt: null,
    emailEnabled: true,
    emailStatus: { $in: ['pending', 'failed'] },
    emailRetryCount: { $lt: maxRetries },
  });
  const segments = await BriefSegment.find({ _id: { $in: queuedSegmentIds }, status: 'approved' }).sort({
    approvedAt: 1,
  });

  let attempted = 0;
  let capped = false;

  for (const segment of segments) {
    // Batch by batch until this segment is drained or the run is out of budget.
    // A zero-attempt batch is the guard against a segment that cannot progress:
    // without it, a row the filter keeps returning but `sendOne` declines to
    // touch would spin here for the whole run.
    for (;;) {
      if (attempted >= budget) {
        capped = true;
        break;
      }
      const sent = await sendQueuedBatch(segment, { maxRetries });
      attempted += sent;
      if (sent === 0) break;
    }
    if (capped) break;
  }

  const remaining = await BriefRecipient.countDocuments({
    segmentId: { $in: segments.map((segment) => segment._id) },
    deletedAt: null,
    emailEnabled: true,
    emailStatus: { $in: ['pending', 'failed'] },
    emailRetryCount: { $lt: maxRetries },
  });

  return { segments: segments.length, attempted, capped, remaining };
}
