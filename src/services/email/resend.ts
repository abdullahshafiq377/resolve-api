import { Resend } from 'resend';

// Thin, generic wrapper over the Resend SDK. Shared by any future feature.
// Lazily instantiated so the API boots even when RESEND_API_KEY is absent
// (email simply no-ops in that case — the in-app notification still fires).

let client: Resend | null = null;

function getClient(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!client) client = new Resend(key);
  return client;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEARCH_REQUESTS_EMAIL_FROM);
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  status: 'sent' | 'failed' | 'no_email';
  error?: string;
  // Resend's id for the accepted message. The only thing the delivery webhook
  // has to match an event back to the row that sent it (`F-041`), so a caller
  // that records the send must record this too.
  messageId?: string | null;
}

// Sends an email via Resend. Never throws — returns a status the caller records
// on the Notification row. `no_email` means email is not configured / no recipient.
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const resend = getClient();
  const from = process.env.RESEARCH_REQUESTS_EMAIL_FROM;
  if (!resend || !from) return { status: 'no_email' };
  if (!input.to) return { status: 'no_email' };

  try {
    const replyTo = process.env.RESEARCH_REQUESTS_EMAIL_REPLY_TO;
    const { data, error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(replyTo ? { replyTo } : {}),
    });
    // `ErrorResponse` is `{ message, statusCode, name }`, so `String(error)` here
    // recorded the literal "[object Object]" — the failure was detected but the
    // reason was thrown away (`F-143`).
    if (error) {
      return { status: 'failed', error: `${error.name}: ${error.message}`.slice(0, 500) };
    }
    return { status: 'sent', messageId: data?.id ?? null };
  } catch (err) {
    return { status: 'failed', error: String(err).slice(0, 500) };
  }
}
