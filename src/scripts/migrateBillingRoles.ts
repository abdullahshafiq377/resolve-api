/**
 * One-shot migration for the billing redesign (BACKEND_BILLING.md §"Backend
 * agent action items", steps 3–4).
 *
 * Tier (premium/free) is no longer stored as a role. This script clears the
 * legacy 'free_user' / 'premium_user' values from both stores so the only role
 * left is 'moderator' (everyone else: NULL). Premium is read live from Clerk's
 * plan claim at request time.
 *
 *   1. DB backfill   — users.role = NULL where role IN ('free_user','premium_user').
 *   2. Clerk cleanup — clear publicMetadata.role for users whose role is one of
 *                      those legacy values (paged via the Backend API).
 *
 * Idempotent: re-running matches nothing once clean. Moderator rows untouched.
 *
 * Run once after deploying the schema/handler change:
 *   npm run migrate:billing-roles
 */
import 'dotenv/config';
import { connectDB, closeDB } from '../config/db';
import User from '../models/User';
import { clerk } from '../config/clerk';

const LEGACY_ROLES = ['free_user', 'premium_user'];

// Step 3: clear legacy tier roles in the local users mirror.
async function backfillMirror(): Promise<void> {
  const res = await User.collection.updateMany(
    { role: { $in: LEGACY_ROLES } },
    { $set: { role: null } },
  );
  console.log(`DB: cleared role on ${res.modifiedCount} user row(s).`);
}

// Step 4: clear legacy tier roles in Clerk publicMetadata, paging the full list.
async function cleanupClerk(): Promise<void> {
  const pageSize = 500;
  let offset = 0;
  let cleared = 0;
  let scanned = 0;

  for (;;) {
    const page = await clerk.users.getUserList({ limit: pageSize, offset });
    if (page.data.length === 0) break;
    scanned += page.data.length;

    for (const u of page.data) {
      const role = u.publicMetadata?.role;
      if (role === 'free_user' || role === 'premium_user') {
        await clerk.users.updateUserMetadata(u.id, { publicMetadata: { role: null } });
        cleared += 1;
      }
    }

    if (page.data.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`Clerk: scanned ${scanned} user(s), cleared role on ${cleared}.`);
}

async function run(): Promise<void> {
  await connectDB();
  await backfillMirror();
  await cleanupClerk();
  await closeDB();
  console.log('Migration complete.');
}

run().catch(async (err) => {
  console.error('Migration failed:', err);
  await closeDB().catch(() => {});
  process.exit(1);
});
