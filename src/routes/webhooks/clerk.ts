import express, { type Request, type Response } from 'express';
import { Webhook } from 'svix';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import { clerk } from '../../config/clerk';
import { upsertUser, softDeleteUser, buildDisplayName } from '../../services/users';

// Fetch a Clerk user, returning null if they no longer exist (404) instead of
// throwing. A billing event can reference a since-deleted user; that must not
// crash the webhook or trigger endless Clerk retries.
async function safeGetUser(userId: string) {
  try {
    return await clerk.users.getUser(userId);
  } catch (err) {
    if (isClerkAPIResponseError(err) && (err as { status?: number }).status === 404) return null;
    throw err;
  }
}

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

interface BillingData {
  payer?: { user_id?: string };
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

  const SUPER_ADMIN_USER_ID = process.env.SUPER_ADMIN_USER_ID;

  try {
    switch (evt.type) {
      case 'user.created': {
        const u = evt.data as unknown as ClerkUserData;
        // Assign default role unless super admin (super admin role lives in env, not metadata).
        if (u.id !== SUPER_ADMIN_USER_ID && !u.public_metadata?.role) {
          await clerk.users.updateUserMetadata(u.id, {
            publicMetadata: { role: 'free_user' },
          });
        }
        await upsertUser({
          clerkUserId: u.id,
          email: u.email_addresses?.[0]?.email_address ?? null,
          displayName: buildDisplayName(u),
          imageUrl: u.image_url ?? null,
          role: (u.public_metadata?.role as never) ?? 'free_user',
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

      // ── Clerk Billing events ──────────────────────────────────────────
      // Upgrade to premium
      case 'subscription.active': {
        const sub = evt.data as unknown as BillingData;
        const targetUserId = sub.payer?.user_id;
        if (targetUserId && targetUserId !== SUPER_ADMIN_USER_ID) {
          const target = await safeGetUser(targetUserId);
          // Don't override moderator role — moderators stay moderators.
          if (target && target.publicMetadata?.role !== 'moderator') {
            await clerk.users.updateUserMetadata(targetUserId, {
              publicMetadata: { role: 'premium_user' },
            });
          }
        }
        break;
      }

      // Downgrade to free
      case 'subscription.pastDue':
      case 'subscriptionItem.canceled': {
        const data = evt.data as unknown as BillingData;
        const targetUserId = data.payer?.user_id;
        if (targetUserId && targetUserId !== SUPER_ADMIN_USER_ID) {
          const target = await safeGetUser(targetUserId);
          // Only downgrade premium users; leave moderators alone.
          if (target && target.publicMetadata?.role === 'premium_user') {
            await clerk.users.updateUserMetadata(targetUserId, {
              publicMetadata: { role: 'free_user' },
            });
          }
        }
        break;
      }

      // Informational events — no role change; re-evaluate on next active/canceled.
      case 'subscription.created':
      case 'subscription.updated':
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
