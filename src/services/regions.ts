import mongoose from 'mongoose';
import Article from '../models/Article';
import BriefPreference from '../models/BriefPreference';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment from '../models/BriefSegment';
import Region, { RegionDoc } from '../models/Region';
import { httpError } from '../utils/errors';

export const GLOBAL_REGION_SLUG = 'global';

export const DEFAULT_REGIONS = [
  { title: 'Global', slug: 'global', order: 0 },
  { title: 'South Asia', slug: 'south-asia', order: 10 },
  { title: 'Middle East', slug: 'middle-east', order: 20 },
  { title: 'North America', slug: 'north-america', order: 30 },
  { title: 'Europe', slug: 'europe', order: 40 },
  { title: 'Africa', slug: 'africa', order: 50 },
  { title: 'East Asia', slug: 'east-asia', order: 60 },
] as const;

export function serializeRegion(region: RegionDoc): Record<string, unknown> {
  const obj = region.toObject() as Record<string, unknown>;
  obj.id = String(region._id);
  return obj;
}

export async function ensureDefaultRegions(): Promise<RegionDoc[]> {
  const regions: RegionDoc[] = [];
  for (const spec of DEFAULT_REGIONS) {
    const region = await Region.findOneAndUpdate(
      { slug: spec.slug },
      {
        $setOnInsert: {
          title: spec.title,
          slug: spec.slug,
          active: true,
          order: spec.order,
        },
      },
      { new: true, upsert: true },
    );
    regions.push(region);
  }
  return regions;
}

export async function getGlobalRegion(): Promise<RegionDoc> {
  const global = await Region.findOneAndUpdate(
    { slug: GLOBAL_REGION_SLUG },
    { $setOnInsert: { title: 'Global', slug: GLOBAL_REGION_SLUG, active: true, order: 0 } },
    { new: true, upsert: true },
  );
  return global;
}

export async function findActiveRegionIdsOrThrow(values: unknown): Promise<mongoose.Types.ObjectId[]> {
  if (!Array.isArray(values)) throw httpError(400, 'invalid_regions');
  const ids = [...new Set(values.map((value) => String(value)))].filter(Boolean);
  if (ids.length === 0) return [];
  if (!ids.every((id) => mongoose.Types.ObjectId.isValid(id))) throw httpError(400, 'invalid_regions');
  const regions = await Region.find({ _id: { $in: ids }, active: true });
  if (regions.length !== ids.length) throw httpError(400, 'invalid_regions');
  return ids.sort().map((id) => new mongoose.Types.ObjectId(id));
}

export interface RegionUsage {
  articleCount: number;
  preferenceCount: number;
  segmentCount: number;
  recipientCount: number;
}

export async function getRegionUsage(regionId: string): Promise<RegionUsage> {
  const [articleCount, preferenceCount, segmentCount, recipientCount] = await Promise.all([
    Article.countDocuments({ regionIds: regionId }),
    BriefPreference.countDocuments({ regionIds: regionId, deletedAt: null }),
    BriefSegment.countDocuments({ regionIds: regionId, deletedAt: null }),
    BriefRecipient.countDocuments({ 'preferenceSnapshot.regionIds': regionId, deletedAt: null }),
  ]);
  return { articleCount, preferenceCount, segmentCount, recipientCount };
}

/**
 * True when something still live points at the region.
 *
 * Recipients are counted and shown but deliberately excluded: a `BriefRecipient`
 * records which regions a reader was sent a brief for on a date that has already
 * passed. It is history, not a live reference, so it must not keep a region
 * pinned in place forever — and, unlike the other three, it is never rewritten
 * by a reassignment (see `reassignRegionContent`).
 */
export function isRegionInUse(usage: RegionUsage): boolean {
  return usage.articleCount + usage.preferenceCount + usage.segmentCount > 0;
}

/**
 * Point everything at `toId` that currently points at `fromId`.
 *
 * `regionIds` is a set rather than a single value, so each document has the old
 * region pulled and the new one added — `$addToSet` rather than `$set`, or a
 * document already carrying both would end up with a duplicate.
 *
 * `BriefRecipient.preferenceSnapshot` is left alone on purpose. Those rows say
 * what a reader was actually sent; rewriting them would make the record disagree
 * with the email that went out.
 */
export async function reassignRegionContent(
  fromId: string,
  toId: string,
): Promise<Omit<RegionUsage, 'recipientCount'>> {
  // `$addToSet` and `$pull` cannot touch the same array in one update, so each
  // collection takes two passes over the same set of ids. The ids are captured
  // first so the second pass cannot pick up a document the first one changed.
  const articleIds = (await Article.find({ regionIds: fromId }).select('_id')).map((doc) => doc._id);
  if (articleIds.length) {
    await Article.updateMany({ _id: { $in: articleIds } }, { $addToSet: { regionIds: toId } });
    await Article.updateMany({ _id: { $in: articleIds } }, { $pull: { regionIds: fromId } });
  }

  const preferenceIds = (
    await BriefPreference.find({ regionIds: fromId, deletedAt: null }).select('_id')
  ).map((doc) => doc._id);
  if (preferenceIds.length) {
    await BriefPreference.updateMany(
      { _id: { $in: preferenceIds } },
      { $addToSet: { regionIds: toId } },
    );
    await BriefPreference.updateMany(
      { _id: { $in: preferenceIds } },
      { $pull: { regionIds: fromId } },
    );
  }

  const segmentIds = (
    await BriefSegment.find({ regionIds: fromId, deletedAt: null }).select('_id')
  ).map((doc) => doc._id);
  if (segmentIds.length) {
    await BriefSegment.updateMany({ _id: { $in: segmentIds } }, { $addToSet: { regionIds: toId } });
    await BriefSegment.updateMany({ _id: { $in: segmentIds } }, { $pull: { regionIds: fromId } });
  }

  return {
    articleCount: articleIds.length,
    preferenceCount: preferenceIds.length,
    segmentCount: segmentIds.length,
  };
}

/**
 * Global first, then alphabetical.
 *
 * Manual ordering was dropped from the admin screens, so nothing keeps the
 * `order` numbers honest any more. Global still has to lead every targeting list
 * — it is the fallback every reader falls back to — so it is pinned here rather
 * than left to sort under G.
 */
export function sortRegionsForDisplay<T extends { slug: string; title: string }>(regions: T[]): T[] {
  return [...regions].sort((a, b) => {
    if (a.slug === GLOBAL_REGION_SLUG) return b.slug === GLOBAL_REGION_SLUG ? 0 : -1;
    if (b.slug === GLOBAL_REGION_SLUG) return 1;
    return a.title.localeCompare(b.title);
  });
}

export async function isGlobalRegion(region: RegionDoc): Promise<boolean> {
  return region.slug === GLOBAL_REGION_SLUG;
}
