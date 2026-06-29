import { Resend } from 'resend';
import { clerk } from '../config/clerk';
import BriefRecipient, { BriefRecipientDoc } from '../models/BriefRecipient';
import BriefSegment, { BriefSegmentDoc } from '../models/BriefSegment';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM = process.env.RESOLVE_BRIEF_EMAIL_FROM || 'The Resolve Brief <brief@example.com>';
const APP_URL = process.env.RESOLVE_APP_URL || 'http://localhost:3000';
const EMAIL_BATCH_SIZE = Math.max(1, Number(process.env.RESOLVE_BRIEF_EMAIL_BATCH_SIZE) || 10);

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
        <li style="margin:0 0 18px;">
          <a href="${escapeHtml(absolutize(story.url))}" style="color:#111827;font-weight:700;text-decoration:none;">${escapeHtml(story.headline)}</a>
          <p style="margin:6px 0 0;color:#374151;line-height:1.55;">${escapeHtml(story.summary)}</p>
        </li>
      `,
    )
    .join('');

  const note = segment.editorialNote
    ? `<p style="border-top:1px solid #e5e7eb;margin-top:24px;padding-top:16px;color:#374151;">${escapeHtml(segment.editorialNote)}</p>`
    : '';

  // The email is the morning edition: lead with the day's title + the full
  // synthesis summary (paragraph-split), then the "Go Deeper" stories. Fall back
  // to the short headlineSummary hook when the synthesis is absent.
  const title = segment.title
    ? `<h2 style="font-size:24px;line-height:1.2;margin:0 0 12px;">${escapeHtml(segment.title)}</h2>`
    : '';
  const summaryBody = segment.summary
    ? segment.summary
        .split(/\n{2,}/)
        .map((para) => para.trim())
        .filter(Boolean)
        .map((para) => `<p style="font-size:17px;line-height:1.6;margin:0 0 16px;">${escapeHtml(para)}</p>`)
        .join('')
    : `<p style="font-size:18px;line-height:1.55;margin:0 0 24px;">${escapeHtml(segment.headlineSummary)}</p>`;

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
    const user = await clerk.users.getUser(recipient.clerkUserId);
    const to = primaryEmail(user);
    if (!to) {
      recipient.emailStatus = 'skipped';
      recipient.emailLastError = 'missing_email';
      await recipient.save();
      return;
    }

    const response = await resend.emails.send({
      from: FROM,
      to,
      subject: `The Resolve Brief - ${segment.briefDate}`,
      html: buildBriefEmailHtml(segment),
    });

    recipient.emailStatus = 'sent';
    recipient.emailMessageId = response.data?.id ?? null;
    recipient.emailSentAt = new Date();
    recipient.emailFailedAt = null;
    recipient.emailLastError = null;
  } catch (err) {
    recipient.emailStatus = 'failed';
    recipient.emailFailedAt = new Date();
    recipient.emailLastError = err instanceof Error ? err.message.slice(0, 500) : 'email_failed';
  }
  await recipient.save();
}

export async function sendApprovedSegmentEmails(
  segmentId: string,
  recipientId?: string,
): Promise<{ attempted: number; sent: number; failed: number; skipped: number }> {
  const segment = await BriefSegment.findById(segmentId);
  if (!segment || segment.status !== 'approved') return { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  const filter: Record<string, unknown> = {
    segmentId: segment._id,
    deletedAt: null,
    emailEnabled: true,
    emailStatus: { $in: ['pending', 'failed'] },
  };
  if (recipientId) filter._id = recipientId;
  else filter.emailStatus = { $in: ['pending', 'failed'] };

  const recipients = await BriefRecipient.find(filter).limit(EMAIL_BATCH_SIZE);
  for (const recipient of recipients) await sendOne(segment, recipient);

  const counts = await BriefRecipient.aggregate([
    { $match: { segmentId: segment._id } },
    { $group: { _id: '$emailStatus', count: { $sum: 1 } } },
  ]);
  const map = new Map(counts.map((row) => [row._id, row.count]));
  return {
    attempted: recipients.length,
    sent: map.get('sent') ?? 0,
    failed: map.get('failed') ?? 0,
    skipped: map.get('skipped') ?? 0,
  };
}
