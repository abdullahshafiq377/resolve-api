import { resolveTier } from './adminUsers';
import User from '../models/User';

/**
 * Plan-tier snapshots on the user mirror.
 *
 * Clerk Billing answers "what tier is this user?" one user at a time and cannot
 * answer "how many premium subscribers are there?" at all — there is no
 * list-by-plan endpoint. So every trusted tier read is stamped onto
 * `User.planTier` (see resolveTier) and aggregate counts are served from that
 * column.
 *
 * Keeping the column warm is deliberately incremental rather than a periodic
 * recount of the whole user base: traffic that already resolves tiers (the admin
 * users table, auth paths) refreshes active users for free, and the sweep below
 * only touches rows nothing else has looked at recently. Clerk call volume stays
 * flat as the user base grows instead of arriving in a burst every cycle.
 */

/** A snapshot older than this is refreshed by the sweep. */
const DEFAULT_STALE_AFTER_HOURS = 12;
/** Rows per sweep run. Sized so an hourly cron keeps up without a call spike. */
const DEFAULT_BATCH_SIZE = 200;
/** Matches the concurrency cap the admin users table resolves tiers at. */
const CONCURRENCY = 8;

export interface ReconcileOptions {
  batchSize?: number;
  staleAfterHours?: number;
}

export interface ReconcileResult {
  /** Rows the sweep attempted to refresh. */
  checked: number;
  /** Rows whose tier actually changed. */
  changed: number;
  /** Rows still past the staleness cutoff after this run. */
  remaining: number;
}

/**
 * Refreshes the oldest stale tier snapshots, oldest first. Never-checked rows
 * (`planTierCheckedAt: null`) sort ahead of everything else, so a cold column
 * fills in over consecutive runs.
 */
export async function reconcileTierSnapshots(
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const batchSize = Math.min(Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE), 1000);
  const staleAfterHours = Math.max(1, options.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS);
  const cutoff = new Date(Date.now() - staleAfterHours * 60 * 60 * 1000);
  const staleFilter = {
    deletedAt: null,
    $or: [{ planTierCheckedAt: null }, { planTierCheckedAt: { $lt: cutoff } }],
  };

  const stale = await User.find(staleFilter)
    .select('clerkUserId planTier')
    .sort({ planTierCheckedAt: 1 })
    .limit(batchSize)
    .lean();

  const queue = [...stale];
  let changed = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      // resolveTier writes the snapshot itself when the read is trusted.
      const tier = await resolveTier(row.clerkUserId);
      if (tier !== row.planTier) changed += 1;
    }
  });
  await Promise.all(workers);

  return {
    checked: stale.length,
    changed,
    remaining: await User.countDocuments(staleFilter),
  };
}

export interface PremiumSubscriberCount {
  count: number;
  /** Oldest snapshot behind the count, so callers can judge its freshness. */
  oldestCheckedAt: string | null;
  /** Users whose tier has never been resolved, and so are missing from the count. */
  unknown: number;
}

/** Premium subscribers, from the snapshot column — no Clerk calls. */
export async function countPremiumSubscribers(): Promise<PremiumSubscriberCount> {
  const [count, unknown, oldest] = await Promise.all([
    User.countDocuments({ deletedAt: null, planTier: 'premium' }),
    User.countDocuments({ deletedAt: null, planTier: null }),
    User.find({ deletedAt: null, planTierCheckedAt: { $ne: null } })
      .select('planTierCheckedAt')
      .sort({ planTierCheckedAt: 1 })
      .limit(1)
      .lean(),
  ]);

  return {
    count,
    oldestCheckedAt: oldest[0]?.planTierCheckedAt?.toISOString() ?? null,
    unknown,
  };
}
