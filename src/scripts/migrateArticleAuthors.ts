/**
 * One-shot migration for §6a (Articles ↔ Users relation).
 *
 *  1. Ensure the super admin has a row in the users mirror.
 *  2. Backfill authorId = SUPER_ADMIN_USER_ID on any article missing it.
 *  3. Drop the legacy free-text `author` field.
 *
 * Run once after deploying the schema change:
 *   npm run migrate:article-authors
 */
import 'dotenv/config';
import { connectDB, closeDB } from '../config/db';
import Article from '../models/Article';
import User from '../models/User';
import { clerk } from '../config/clerk';
import { buildDisplayName } from '../services/users';

async function ensureSuperAdminRow(superAdminId: string): Promise<void> {
  const existing = await User.findOne({ clerkUserId: superAdminId });
  if (existing) {
    console.log(`Super admin row already present (${superAdminId}).`);
    return;
  }

  let displayName: string | null = null;
  let imageUrl: string | null = null;
  let email: string | null = null;
  try {
    const sa = await clerk.users.getUser(superAdminId);
    email = sa.emailAddresses?.[0]?.emailAddress ?? null;
    imageUrl = sa.imageUrl ?? null;
    displayName = buildDisplayName({
      first_name: sa.firstName,
      last_name: sa.lastName,
      username: sa.username,
      email_addresses: sa.emailAddresses?.map((e) => ({ email_address: e.emailAddress })),
    });
  } catch (err) {
    console.warn('Could not fetch super admin from Clerk; inserting minimal row.', err);
  }

  await User.updateOne(
    { clerkUserId: superAdminId },
    { $set: { clerkUserId: superAdminId, email, displayName, imageUrl, role: 'free_user' } },
    { upsert: true },
  );
  console.log(`Inserted super admin row (${superAdminId}).`);
}

async function run(): Promise<void> {
  const superAdminId = process.env.SUPER_ADMIN_USER_ID;
  if (!superAdminId) throw new Error('SUPER_ADMIN_USER_ID is not set');

  await connectDB();
  await ensureSuperAdminRow(superAdminId);

  const backfill = await Article.collection.updateMany(
    { authorId: { $exists: false } },
    { $set: { authorId: superAdminId } },
  );
  console.log(`Backfilled authorId on ${backfill.modifiedCount} article(s).`);

  const dropped = await Article.collection.updateMany(
    { author: { $exists: true } },
    { $unset: { author: '' } },
  );
  console.log(`Dropped legacy author field on ${dropped.modifiedCount} article(s).`);

  await closeDB();
  console.log('Migration complete.');
}

run().catch(async (err) => {
  console.error('Migration failed:', err);
  await closeDB().catch(() => {});
  process.exit(1);
});
