import mongoose from 'mongoose';
import type { Request } from 'express';
import { getAuth } from '@clerk/express';
import Activity, { type ActivityAction, type ActivityEntityType } from '../models/Activity';
import { findUsersByIds } from './users';

// How many events an admin timeline asks for by default. The log is append-only
// and a long-lived article accumulates a long tail, so the endpoint pages
// rather than returning everything.
export const ACTIVITY_DEFAULT_LIMIT = 50;
export const ACTIVITY_MAX_LIMIT = 200;

export interface ActivityInput {
  entityType: ActivityEntityType;
  entityId: mongoose.Types.ObjectId | string;
  action: ActivityAction;
  actorId?: string | null;
  metadata?: unknown;
}

/**
 * Append one event to an entity's activity log.
 *
 * Deliberately swallows its own failures: the log is an observability aid, and
 * a write that fails here must never fail the editorial action that produced
 * it. Callers therefore do not need to guard the call.
 */
export async function recordActivity(input: ActivityInput): Promise<void> {
  await recordActivities([input]);
}

/** Append several events in one round trip, with the same never-throws contract. */
export async function recordActivities(inputs: ActivityInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await Activity.insertMany(
      inputs.map((input) => ({
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorId: input.actorId ?? null,
        metadata: input.metadata ?? null,
      })),
      { ordered: false },
    );
  } catch (err) {
    console.warn('Failed to record activity', err);
  }
}

/** The acting moderator, or null when the caller is the cron / an unauthenticated path. */
export function actorFromRequest(req: Request): string | null {
  try {
    return getAuth(req).userId ?? null;
  } catch {
    return null;
  }
}

export interface SerializedActivity {
  id: string;
  action: ActivityAction;
  by: string | null;
  // Display name, then email — never the raw Clerk id, which is unreadable in
  // the timeline. Null means the event has no actor, and renders as "System".
  byName: string | null;
  metadata: unknown;
  at: string;
}

/** Newest-first page of an entity's activity, with actor ids resolved to names. */
export async function listActivity(
  entityType: ActivityEntityType,
  entityId: string,
  { page = 1, limit = ACTIVITY_DEFAULT_LIMIT }: { page?: number; limit?: number } = {},
): Promise<{
  data: SerializedActivity[];
  pagination: { total: number; page: number; limit: number; pages: number };
}> {
  const safeLimit = Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, limit));
  const safePage = Math.max(1, page);
  const skip = (safePage - 1) * safeLimit;
  const filter = { entityType, entityId };

  const [entries, total] = await Promise.all([
    Activity.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(safeLimit).lean(),
    Activity.countDocuments(filter),
  ]);

  // Actor ids resolve to names here rather than in the client, which has no way
  // to turn a Clerk id into a person.
  const actorIds = [...new Set(entries.map((e) => e.actorId).filter((id): id is string => Boolean(id)))];
  const actors = await findUsersByIds(actorIds);
  const actorMap = new Map(actors.map((u) => [u.clerkUserId, u]));

  return {
    data: entries.map((entry) => {
      const actor = entry.actorId ? actorMap.get(entry.actorId) : undefined;
      return {
        id: String(entry._id),
        action: entry.action,
        by: entry.actorId ?? null,
        byName: actor?.displayName || actor?.email || null,
        metadata: entry.metadata ?? null,
        at: entry.createdAt.toISOString(),
      };
    }),
    pagination: { total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) },
  };
}

/**
 * Resolve Clerk ids to display names for event metadata.
 *
 * Names are denormalised into `metadata` at write time so an event still reads
 * correctly after the user row changes or is deleted — "changed author from
 * Sara Malik to Danish Malik" is a statement about that moment.
 */
export async function resolveActorNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const users = await findUsersByIds(unique);
  return new Map(users.map((u) => [u.clerkUserId, u.displayName || u.email || u.clerkUserId]));
}

/** Drop an entity's log when the entity itself is deleted. */
export async function purgeActivity(
  entityType: ActivityEntityType,
  entityId: string | mongoose.Types.ObjectId,
): Promise<void> {
  await Activity.deleteMany({ entityType, entityId }).catch((err) => {
    console.warn('Failed to purge activity', err);
  });
}
