import mongoose from 'mongoose';
import Category from '../models/Category';
import BriefPreference, { BriefPreferenceDoc } from '../models/BriefPreference';
import Region from '../models/Region';
import { httpError } from '../utils/errors';
import { findActiveRegionIdsOrThrow } from './regions';
import { serializeCategory } from './categories';
import { serializeRegion } from './regions';

function sortedObjectIds(ids: mongoose.Types.ObjectId[]): mongoose.Types.ObjectId[] {
  return [...ids].sort((a, b) => String(a).localeCompare(String(b)));
}

async function findActiveCategoryIdsOrThrow(values: unknown): Promise<mongoose.Types.ObjectId[]> {
  if (!Array.isArray(values)) throw httpError(400, 'invalid_categories');
  const ids = [...new Set(values.map((value) => String(value)))].filter(Boolean);
  if (ids.length === 0) return [];
  if (!ids.every((id) => mongoose.Types.ObjectId.isValid(id))) throw httpError(400, 'invalid_categories');
  const categories = await Category.find({ _id: { $in: ids }, active: true });
  if (categories.length !== ids.length) throw httpError(400, 'invalid_categories');
  return ids.sort().map((id) => new mongoose.Types.ObjectId(id));
}

export function serializeBriefPreference(preference: BriefPreferenceDoc | null): Record<string, unknown> {
  return {
    enabled: preference?.enabled ?? true,
    emailEnabled: preference?.emailEnabled ?? true,
    onboardingCompleted: preference?.onboardingCompleted ?? false,
    categoryIds: preference?.categoryIds?.map(String) ?? [],
    regionIds: preference?.regionIds?.map(String) ?? [],
  };
}

export async function getPreferencePayload(clerkUserId: string): Promise<Record<string, unknown>> {
  const [preference, categories, regions] = await Promise.all([
    BriefPreference.findOne({ clerkUserId, deletedAt: null }),
    Category.find({ active: true }).sort({ order: 1, title: 1 }),
    Region.find({ active: true }).sort({ order: 1, title: 1 }),
  ]);

  return {
    preference: serializeBriefPreference(preference),
    categories: categories.map(serializeCategory),
    regions: regions.map(serializeRegion),
  };
}

export async function updatePreference(
  clerkUserId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const enabled = payload.enabled !== false;
  const emailEnabled = payload.emailEnabled !== false;
  const onboardingCompleted = payload.onboardingCompleted === true;
  const categoryIds = sortedObjectIds(await findActiveCategoryIdsOrThrow(payload.categoryIds ?? []));
  const regionIds = sortedObjectIds(await findActiveRegionIdsOrThrow(payload.regionIds ?? []));

  if (enabled && onboardingCompleted) {
    if (categoryIds.length === 0) throw httpError(400, 'at_least_one_category_required');
    if (regionIds.length === 0) throw httpError(400, 'at_least_one_region_required');
  }

  const existing = await BriefPreference.findOne({ clerkUserId });
  const completedAt =
    onboardingCompleted && !existing?.completedAt ? new Date() : existing?.completedAt ?? null;

  await BriefPreference.findOneAndUpdate(
    { clerkUserId },
    {
      $set: {
        enabled,
        emailEnabled,
        onboardingCompleted,
        categoryIds,
        regionIds,
        completedAt,
        lastUpdatedBy: 'user',
        deletedAt: null,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );

  return getPreferencePayload(clerkUserId);
}
