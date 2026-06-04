import express, { type Request, type Response } from 'express';
import { Webhook } from 'svix';
import { upsertUser, softDeleteUser, buildDisplayName } from '../../services/users';

const router = express.Router();

interface ClerkEvent {
  type: string;
  data: Record<string, unknown>;
}

interface ClerkUserData {
  id: string;
  email_addresses?: { email_address: string }[];
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  image_url?: string;
  public_metadata?: { role?: string };
}

// IMPORTANT: raw body, not parsed JSON. Mounted BEFORE app.use(express.json()) in app.ts.
router.post('/', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  const secret = process.env.CLERK_WEBHOOK_SIGNING_SECRET;
  if (!secret) {
    console.error('[webhook] CLERK_WEBHOOK_SIGNING_SECRET is not set');
    return res.status(500).json({ error: 'webhook_not_configured' });
  }

  let evt: ClerkEvent;
  try {
    // Construct inside the try: an invalid/malformed signing secret throws here,
    // and must surface as 400 rather than crashing the process.
    const wh = new Webhook(secret);
    evt = wh.verify(req.body, {
      'svix-id': req.header('svix-id')!,
      'svix-timestamp': req.header('svix-timestamp')!,
      'svix-signature': req.header('svix-signature')!,
    }) as ClerkEvent;
  } catch {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    switch (evt.type) {
      case 'user.created': {
        const u = evt.data as unknown as ClerkUserData;
        // No tier role assigned: premium is read live from Clerk's plan claim
        // (BACKEND_BILLING.md). Mirror row stores role NULL unless promoted to
        // 'moderator' later via /api/admin/users/:id/role.
        await upsertUser({
          clerkUserId: u.id,
          email: u.email_addresses?.[0]?.email_address ?? null,
          displayName: buildDisplayName(u),
          imageUrl: u.image_url ?? null,
          role: (u.public_metadata?.role as never) ?? null,
        });
        break;
      }
      case 'user.updated': {
        const u = evt.data as unknown as ClerkUserData;
        await upsertUser({
          clerkUserId: u.id,
          email: u.email_addresses?.[0]?.email_address ?? null,
          displayName: buildDisplayName(u),
          imageUrl: u.image_url ?? null,
          role: (u.public_metadata?.role as never) ?? null,
        });
        break;
      }
      case 'user.deleted': {
        const u = evt.data as unknown as { id: string };
        // Soft delete to preserve FK integrity (articles still reference this user).
        await softDeleteUser(u.id);
        break;
      }

      // ── Clerk Billing events ─────────────────────────────────────────────
      // Explicit no-op. Premium tier is NOT mirrored into publicMetadata; it is
      // read live from Clerk's plan claim via has({ plan: 'user:premium_plan' })
      // at request time (BACKEND_BILLING.md). Clerk owns subscription state and
      // period-end semantics — duplicating it here caused the immediate-cancel
      // downgrade bug and webhook-ordering drift. Subscribed only in case these
      // are wired to analytics later; they change no role.
      case 'subscription.updated':
      case 'subscription.active':
      case 'subscription.created':
      case 'subscription.pastDue':
      case 'subscriptionItem.canceled':
        break;
    }
  } catch (err) {
    // Never crash the process on a side-effect failure. Log and 500 so Clerk
    // retries later (signature already verified, so this is a real processing error).
    console.error(`[webhook] failed handling ${evt.type}:`, err);
    return res.status(500).json({ error: 'webhook_processing_failed' });
  }

  res.status(200).json({ ok: true });
});

export default router;
