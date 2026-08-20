import express, { type Request, type Response } from 'express';
import { Webhook } from 'svix';
import { parseResendEvent, recordEmailOutcome, type ResendWebhookEvent } from '../../services/emailDeliveryOutcome';

const router = express.Router();

// IMPORTANT: raw body, not parsed JSON. Resend signs webhooks with svix, exactly
// as Clerk does, and the signature covers the bytes — re-stringifying parsed JSON
// breaks it. Mounted BEFORE app.use(express.json()) in app.ts.
router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const secret = process.env.RESEND_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    console.error('[webhook] RESEND_WEBHOOK_SIGNING_SECRET is not set');
    return res.status(500).json({ error: 'webhook_not_configured' });
  }

  let evt: ResendWebhookEvent;
  try {
    // Construct inside the try: an invalid/malformed signing secret throws here,
    // and must surface as 400 rather than crashing the process.
    const wh = new Webhook(secret);
    evt = wh.verify(req.body, {
      'svix-id': req.header('svix-id')!,
      'svix-timestamp': req.header('svix-timestamp')!,
      'svix-signature': req.header('svix-signature')!,
    }) as ResendWebhookEvent;
  } catch {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  // An event this route does not act on — or one too malformed to act on — is
  // acknowledged, not rejected. A 4xx would put it into Resend's retry schedule
  // for something that will never parse differently the second time.
  const parsed = parseResendEvent(evt);
  if (!parsed) return res.status(200).json({ ok: true, recorded: false });

  try {
    const result = await recordEmailOutcome(parsed);
    // A match count of zero is normal, not an error: the id may belong to a mail
    // sent before this route existed, or to a row already carrying a stronger
    // outcome. It is logged because a *persistent* zero means the send path
    // stopped recording message ids, which is the failure that would make this
    // whole route silently useless.
    if (result.briefRecipients + result.notifications === 0) {
      console.warn(`[webhook] resend ${parsed.outcome} matched no row for ${parsed.messageId}`);
    }
    return res.status(200).json({ ok: true, recorded: true });
  } catch (err) {
    // Never crash the process on a side-effect failure. Log and 500 so Resend
    // retries later (signature already verified, so this is a real processing
    // error) — the write is replay-safe by rank.
    console.error(`[webhook] failed handling ${String(evt.type)}:`, err);
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }
});

export default router;
