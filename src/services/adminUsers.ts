import { clerk } from '../config/clerk';
import type { User as ClerkUser } from '@clerk/backend';
import CommentBan from '../models/CommentBan';
import ModerationAction from '../models/ModerationAction';
import type { PlanTier } from '../middleware/auth';
import { isSuperAdmin } from '../middleware/auth';

// The admin users table filters, sorts and paginates across the WHOLE user base,
// none of which Clerk's getUserList supports (it takes a text query only, and
// knows nothing about comment bans, warnings or plan tier). So the index is built
// here: the Clerk list is pulled in full and cached briefly, then joined against
// the moderation collections and Clerk Billing.

export type UserStatus = 'active' | 'warned' | 'banned' | 'frozen';
export type UserRoleFilter = 'moderator' | 'reader';
export type UserSortKey = 'user' | 'tier' | 'role' | 'status' | 'joined';

export interface AdminUserRow {
  id: string;
  displayName: string;
  email: string | null;
  imageUrl: string | null;
  role: 'moderator' | null;
  isSuperAdmin: boolean;
  tier: PlanTier;
  /** Clerk-level ban — the UI calls this "frozen". Blocks sign-in entirely. */
  frozen: boolean;
  commentBan: { tier: string; activeUntil: string | null } | null;
  warningCount: number;
  status: UserStatus;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface AdminUserListParams {
  search?: string;
  status?: UserStatus;
  role?: UserRoleFilter;
  tier?: PlanTier;
  sort?: UserSortKey;
  order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface AdminUserListResult {
  items: AdminUserRow[];
  pagination: { page: number; limit: number; total: number; pages: number };
}

// Clerk caps a single list page at 500.
const CLERK_PAGE_SIZE = 500;
// Enough Clerk pages for a user base far larger than today's; a hard stop keeps a
// paging bug from looping forever.
const MAX_CLERK_PAGES = 40;
const LIST_TTL_MS = 60_000;
const TIER_TTL_MS = 5 * 60_000;
// Billing has no bulk endpoint, so tiers are resolved one call per user. Cap the
// concurrency so a cold cache cannot flood Clerk.
const TIER_CONCURRENCY = 8;

let listCache: { at: number; users: ClerkUser[] } | null = null;
let listInFlight: Promise<ClerkUser[]> | null = null;
const tierCache = new Map<string, { at: number; tier: PlanTier }>();

/** Drop the cached Clerk list so the next list call reflects a just-made change. */
export function invalidateAdminUserCache(userId?: string): void {
  listCache = null;
  if (userId) tierCache.delete(userId);
}

async function fetchAllClerkUsers(): Promise<ClerkUser[]> {
  const users: ClerkUser[] = [];
  for (let page = 0; page < MAX_CLERK_PAGES; page += 1) {
    const res = await clerk.users.getUserList({
      limit: CLERK_PAGE_SIZE,
      offset: page * CLERK_PAGE_SIZE,
      orderBy: '-created_at',
    });
    users.push(...res.data);
    if (users.length >= res.totalCount || res.data.length < CLERK_PAGE_SIZE) break;
  }
  return users;
}

async function getClerkUsers(): Promise<ClerkUser[]> {
  if (listCache && Date.now() - listCache.at < LIST_TTL_MS) return listCache.users;
  // Collapse concurrent refreshes into one Clerk round-trip.
  if (!listInFlight) {
    listInFlight = fetchAllClerkUsers()
      .then((users) => {
        listCache = { at: Date.now(), users };
        return users;
      })
      .finally(() => {
        listInFlight = null;
      });
  }
  return listInFlight;
}

function planSlugToTier(slug: string | null | undefined): PlanTier | null {
  if (!slug) return null;
  // Slugs may arrive namespaced (`user:premium`) or bare (`premium`); the legacy
  // 2-plan slug `premium_plan` still maps to premium (middleware/auth.ts).
  const bare = slug.includes(':') ? slug.split(':').pop() ?? slug : slug;
  if (bare === 'premium' || bare === 'premium_plan') return 'premium';
  if (bare === 'standard') return 'standard';
  return null;
}

/**
 * Live plan tier for one user, read from Clerk Billing. Tier is not stored
 * anywhere (BACKEND_BILLING.md), so this is the only server-side source — cached
 * for five minutes because it costs one Clerk call per user.
 */
async function resolveTier(userId: string): Promise<PlanTier> {
  const cached = tierCache.get(userId);
  if (cached && Date.now() - cached.at < TIER_TTL_MS) return cached.tier;

  let tier: PlanTier = 'free';
  try {
    const subscription = await clerk.billing.getUserBillingSubscription(userId);
    for (const item of subscription.subscriptionItems ?? []) {
      if (item.status !== 'active') continue;
      const itemTier = planSlugToTier(item.plan?.slug ?? null);
      // A user can hold several items; the highest paid one wins.
      if (itemTier === 'premium') tier = 'premium';
      else if (itemTier === 'standard' && tier !== 'premium') tier = 'standard';
    }
  } catch {
    // No subscription (404) or Billing unavailable — the user reads as free
    // rather than failing the whole list.
    tier = 'free';
  }

  tierCache.set(userId, { at: Date.now(), tier });
  return tier;
}

async function resolveTiers(userIds: string[]): Promise<Map<string, PlanTier>> {
  const out = new Map<string, PlanTier>();
  const queue = [...userIds];
  const workers = Array.from({ length: Math.min(TIER_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      out.set(id, await resolveTier(id));
    }
  });
  await Promise.all(workers);
  return out;
}

function displayNameOf(user: ClerkUser): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return (
    name || user.username || user.emailAddresses[0]?.emailAddress || user.id
  );
}

function statusOf(row: {
  frozen: boolean;
  commentBan: unknown;
  warningCount: number;
}): UserStatus {
  // One chip per row, most severe state first.
  if (row.frozen) return 'frozen';
  if (row.commentBan) return 'banned';
  if (row.warningCount > 0) return 'warned';
  return 'active';
}

const STATUS_ORDER: Record<UserStatus, number> = { active: 0, warned: 1, banned: 2, frozen: 3 };
const TIER_ORDER: Record<PlanTier, number> = { free: 0, standard: 1, premium: 2 };

export async function listAdminUsers(
  params: AdminUserListParams,
): Promise<AdminUserListResult> {
  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(Math.max(1, params.limit ?? 10), 100);
  const sort: UserSortKey = params.sort ?? 'joined';
  const order = params.order ?? (sort === 'joined' ? 'desc' : 'asc');

  const now = new Date();
  const [clerkUsers, activeBans, warningCounts] = await Promise.all([
    getClerkUsers(),
    CommentBan.find({
      isActive: true,
      liftedAt: null,
      $or: [{ activeUntil: null }, { activeUntil: { $gt: now } }],
    })
      .select('userId tier activeUntil')
      .lean(),
    ModerationAction.aggregate<{ _id: string; count: number }>([
      { $match: { type: 'warning', targetUserId: { $ne: null } } },
      { $group: { _id: '$targetUserId', count: { $sum: 1 } } },
    ]),
  ]);

  const banByUser = new Map(activeBans.map((ban) => [ban.userId, ban]));
  const warningsByUser = new Map(warningCounts.map((row) => [row._id, row.count]));

  // Everything except tier is already in hand; tier costs a Clerk call per user,
  // so it is resolved only for the rows that survive the cheap filters.
  type Partial = Omit<AdminUserRow, 'tier'>;
  let rows: Partial[] = clerkUsers.map((user) => {
    const ban = banByUser.get(user.id);
    const warningCount = warningsByUser.get(user.id) ?? 0;
    const frozen = user.banned === true;
    const commentBan = ban
      ? { tier: ban.tier as string, activeUntil: ban.activeUntil?.toISOString() ?? null }
      : null;
    return {
      id: user.id,
      displayName: displayNameOf(user),
      email: user.emailAddresses[0]?.emailAddress ?? null,
      imageUrl: user.imageUrl ?? null,
      role: user.publicMetadata?.role === 'moderator' ? 'moderator' : null,
      isSuperAdmin: isSuperAdmin(user.id),
      frozen,
      commentBan,
      warningCount,
      status: statusOf({ frozen, commentBan, warningCount }),
      createdAt: new Date(user.createdAt).toISOString(),
      lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt).toISOString() : null,
    };
  });

  const search = params.search?.trim().toLowerCase();
  if (search) {
    rows = rows.filter(
      (row) =>
        row.displayName.toLowerCase().includes(search) ||
        (row.email ?? '').toLowerCase().includes(search),
    );
  }
  if (params.status) rows = rows.filter((row) => row.status === params.status);
  if (params.role) {
    rows = rows.filter((row) =>
      params.role === 'moderator'
        ? row.role === 'moderator' || row.isSuperAdmin
        : row.role !== 'moderator' && !row.isSuperAdmin,
    );
  }

  const needsAllTiers = Boolean(params.tier) || sort === 'tier';
  const tierOf = (row: Partial, resolved: Map<string, PlanTier>): PlanTier =>
    // Moderators and the super admin inherit the top tier, exactly as getTier()
    // resolves them at request time — and it saves a Billing call.
    row.role === 'moderator' || row.isSuperAdmin ? 'premium' : resolved.get(row.id) ?? 'free';

  let tiers = new Map<string, PlanTier>();
  if (needsAllTiers) {
    tiers = await resolveTiers(
      rows.filter((row) => row.role !== 'moderator' && !row.isSuperAdmin).map((row) => row.id),
    );
    if (params.tier) rows = rows.filter((row) => tierOf(row, tiers) === params.tier);
  }

  const direction = order === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    switch (sort) {
      case 'user':
        return a.displayName.localeCompare(b.displayName) * direction;
      case 'role': {
        const rank = (row: Partial) => (row.isSuperAdmin ? 2 : row.role === 'moderator' ? 1 : 0);
        return (rank(a) - rank(b)) * direction;
      }
      case 'status':
        return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * direction;
      case 'tier':
        return (TIER_ORDER[tierOf(a, tiers)] - TIER_ORDER[tierOf(b, tiers)]) * direction;
      case 'joined':
      default:
        return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * direction;
    }
  });

  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const slice = rows.slice((page - 1) * limit, (page - 1) * limit + limit);

  if (!needsAllTiers) {
    const pageTiers = await resolveTiers(
      slice.filter((row) => row.role !== 'moderator' && !row.isSuperAdmin).map((row) => row.id),
    );
    for (const [id, tier] of pageTiers) tiers.set(id, tier);
  }

  return {
    items: slice.map((row) => ({ ...row, tier: tierOf(row, tiers) })),
    pagination: { page, limit, total, pages },
  };
}
