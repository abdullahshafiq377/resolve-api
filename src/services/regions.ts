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

export async function getRegionUsage(regionId: string): Promise<{
  articleCount: number;
  preferenceCount: number;
  segmentCount: number;
  recipientCount: number;
}> {
  const [articleCount, preferenceCount, segmentCount, recipientCount] = await Promise.all([
    Article.countDocuments({ regionIds: regionId }),
    BriefPreference.countDocuments({ regionIds: regionId, deletedAt: null }),
    BriefSegment.countDocuments({ regionIds: regionId, deletedAt: null }),
    BriefRecipient.countDocuments({ 'preferenceSnapshot.regionIds': regionId, deletedAt: null }),
  ]);
  return { articleCount, preferenceCount, segmentCount, recipientCount };
}

export async function isGlobalRegion(region: RegionDoc): Promise<boolean> {
  return region.slug === GLOBAL_REGION_SLUG;
}
