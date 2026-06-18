import type { Types } from 'mongoose';
import Notification, {
  HIGH_SIGNAL_TYPES,
  type NotificationType,
} from '../../models/Notification';
import { notify } from '../realtime/notify';
import { sendEmail } from '../email/resend';
import { renderEmail, type EmailTemplateKey, type EmailTemplateVars } from './templates';

const FANOUT_CONCURRENCY = Number(process.env.RESEARCH_REQUESTS_FANOUT_CONCURRENCY) || 50;
const FANOUT_SYNC_THRESHOLD = Number(process.env.RESEARCH_REQUESTS_FANOUT_SYNC_THRESHOLD) || 1000;

export interface FireInput {
  userId: string;
  type: NotificationType;
  requestId: Types.ObjectId | null;
  // Comment-feature references (null for research-request notifications).
  commentId?: Types.ObjectId | null;
  parentType?: 'article' | 'poll' | 'researchRequest' | null;
  parentId?: Types.ObjectId | null;
  title: string;
  body: string;
  link: string;
  // When present, an email is attempted (high-signal upvoter notifications only).
  email?: {
    to: string | null;
    template: EmailTemplateKey;
    vars: EmailTemplateVars;
  };
}

function isHighSignal(type: NotificationType): boolean {
  return HIGH_SIGNAL_TYPES.includes(type);
}

// Persist a notification (deduped for high-signal types via the partial unique
// index), push it over the socket, and optionally send an email. Never throws —
// email/socket failures are isolated so one recipient can't break a fan-out.
export async function fire(input: FireInput) {
  const wantsEmail = Boolean(input.email);

  let row;
  if (isHighSignal(input.type) && input.requestId) {
    // Upsert: one row per (user, request, high-signal-type). Re-firing refreshes
    // the display text and resurfaces it as unread instead of duplicating.
    row = await Notification.findOneAndUpdate(
      { userId: input.userId, requestId: input.requestId, type: input.type },
      {
        $set: {
          title: input.title,
          body: input.body,
          link: input.link,
          read: false,
          readAt: null,
          emailStatus: wantsEmail ? 'pending' : 'not_applicable',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } else {
    // Low-signal types are not deduplicated; each fire is a new row.
    row = await Notification.create({
      userId: input.userId,
      type: input.type,
      requestId: input.requestId,
      commentId: input.commentId ?? null,
      parentType: input.parentType ?? null,
      parentId: input.parentId ?? null,
      title: input.title,
      body: input.body,
      link: input.link,
      emailStatus: 'not_applicable',
    });
  }

  // Best-effort socket push.
  notify(input.userId, {
    id: String(row._id),
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    requestId: input.requestId ? String(input.requestId) : null,
    commentId: input.commentId ? String(input.commentId) : null,
    createdAt: row.createdAt.toISOString(),
  });

  // Email (high-signal only). Failures are recorded on the row, never thrown.
  if (input.email) {
    if (!input.email.to) {
      row.emailStatus = 'no_email';
      await row.save();
    } else {
      const { html, text } = renderEmail(input.email.template, input.email.vars);
      const result = await sendEmail({
        to: input.email.to,
        subject: input.title,
        html,
        text,
      });
      row.emailStatus = result.status;
      if (result.status === 'sent' || result.status === 'failed') row.emailSentAt = new Date();
      if (result.status === 'failed') row.emailError = result.error ?? 'unknown';
      await row.save();
    }
  }

  return row;
}

// Run an async task over items with a bounded concurrency (no external dep).
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index]).catch(() => {
        /* per-recipient failure already captured on the row */
      });
    }
  });
  await Promise.all(workers);
}

export interface FanOutRecipient {
  userId: string;
  email: string | null;
}

export interface FanOutInput {
  requestId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  // Email template + vars (omit to send in-app only, e.g. submitter notifications).
  emailTemplate?: EmailTemplateKey;
  emailVars?: EmailTemplateVars;
  recipients: FanOutRecipient[];
}

// Fan a notification out to many upvoters. Small fan-outs run synchronously;
// large ones (> threshold) are dispatched in the background so the HTTP response
// returns promptly. Concurrency is capped to protect the email provider + pool.
export async function fanOut(input: FanOutInput): Promise<{ deferred: boolean }> {
  const run = () =>
    mapWithConcurrency(input.recipients, FANOUT_CONCURRENCY, (recipient) =>
      fire({
        userId: recipient.userId,
        type: input.type,
        requestId: input.requestId,
        title: input.title,
        body: input.body,
        link: input.link,
        email:
          input.emailTemplate && input.emailVars
            ? { to: recipient.email, template: input.emailTemplate, vars: input.emailVars }
            : undefined,
      }).then(() => undefined),
    );

  if (input.recipients.length > FANOUT_SYNC_THRESHOLD) {
    // Detach: let the response return; the queue drains in-process.
    void run();
    return { deferred: true };
  }
  await run();
  return { deferred: false };
}
