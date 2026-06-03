import User, { UserRole, UserDoc } from '../models/User';

interface UpsertUserInput {
  clerkUserId: string;
  email: string | null;
  displayName: string | null;
  imageUrl: string | null;
  role: UserRole | null;
}

// Shape of the Clerk user payload fields we read to build a display name.
export interface ClerkNameSource {
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  email_addresses?: { email_address: string }[];
}

// Mirror of Clerk's display identity used in API responses.
export interface AuthorSummary {
  id: string;
  displayName: string;
  imageUrl: string | null;
}

export function buildDisplayName(u: ClerkNameSource): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
  return name || u.username || u.email_addresses?.[0]?.email_address || 'Anonymous';
}

// Mirror a Clerk user into the local DB (§6). `role: null` leaves the existing
// stored role untouched (used by user.updated when metadata role is absent).
export async function upsertUser({
  clerkUserId,
  email,
  displayName,
  imageUrl,
  role,
}: UpsertUserInput): Promise<void> {
  const set: Record<string, unknown> = { clerkUserId, email, displayName, imageUrl };
  if (role !== null) set.role = role;

  await User.updateOne({ clerkUserId }, { $set: set }, { upsert: true });
}

// Soft delete (§6): preserve the row + FK integrity for authored articles.
export async function softDeleteUser(clerkUserId: string): Promise<void> {
  await User.updateOne({ clerkUserId }, { $set: { deletedAt: new Date() } });
}

export async function findActiveUser(clerkUserId: string): Promise<UserDoc | null> {
  return User.findOne({ clerkUserId, deletedAt: null });
}

// Fetch users by id for display joins. Includes soft-deleted rows so a byline
// still resolves (the row keeps its cached displayName); callers can inspect
// deletedAt to render a "former contributor" state.
export async function findUsersByIds(ids: string[]): Promise<UserDoc[]> {
  if (ids.length === 0) return [];
  return User.find({ clerkUserId: { $in: ids } });
}

// Active moderators, sorted by display name (used by the moderator picker).
export async function listActiveModerators(): Promise<UserDoc[]> {
  return User.find({ role: 'moderator', deletedAt: null }).sort({ displayName: 1 });
}

export function toAuthorSummary(u: UserDoc): AuthorSummary {
  return {
    id: u.clerkUserId,
    displayName: u.displayName || u.email || 'Anonymous',
    imageUrl: u.imageUrl ?? null,
  };
}
