import type { Request, Response } from 'express';
import Region, { RegionDoc } from '../models/Region';
import { generateUniqueSlug } from '../utils/slugify';
import { httpError } from '../utils/errors';
import { getRegionUsage, serializeRegion, isGlobalRegion } from '../services/regions';

function parseOrder(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num)) throw httpError(400, 'invalid_order');
  return num;
}

async function serializeAdminRegion(region: RegionDoc | null) {
  if (!region) return null;
  const usage = await getRegionUsage(String(region._id));
  return {
    ...serializeRegion(region),
    ...usage,
    locked: usage.articleCount + usage.preferenceCount + usage.segmentCount + usage.recipientCount > 0,
    global: await isGlobalRegion(region),
  };
}

export async function listAdmin(req: Request, res: Response) {
  const filter = req.query.includeInactive === 'false' ? { active: true } : {};
  const regions = await Region.find(filter).sort({ order: 1, title: 1 });
  const data = await Promise.all(regions.map((region) => serializeAdminRegion(region)));
  res.json({ data });
}

export async function create(req: Request, res: Response) {
  const { title, active = true, order } = req.body;
  if (typeof title !== 'string' || !title.trim()) throw httpError(400, 'title_required');
  const slug = await generateUniqueSlug(title, Region);
  const region = await Region.create({
    title: title.trim(),
    slug,
    active: active !== false,
    order: parseOrder(order),
  });
  res.status(201).json(await serializeAdminRegion(region));
}

export async function update(req: Request, res: Response) {
  const region = await Region.findById(req.params.id);
  if (!region) return res.status(404).json({ error: 'not_found' });
  const usage = await getRegionUsage(String(region._id));
  const locked = usage.articleCount + usage.preferenceCount + usage.segmentCount + usage.recipientCount > 0;
  const { title, active, order } = req.body;
  const patch: Record<string, unknown> = {};

  if (title !== undefined) {
    if (locked) throw httpError(423, 'region_locked');
    if (typeof title !== 'string' || !title.trim()) throw httpError(400, 'title_required');
    patch.title = title.trim();
    patch.slug = await generateUniqueSlug(title, Region, req.params.id);
  }
  if (active !== undefined) patch.active = active !== false;
  if (order !== undefined) patch.order = parseOrder(order);

  const updated = await Region.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  res.json(await serializeAdminRegion(updated));
}

export async function remove(req: Request, res: Response) {
  const region = await Region.findById(req.params.id);
  if (!region) return res.status(404).json({ error: 'not_found' });
  if (await isGlobalRegion(region)) throw httpError(400, 'global_region_required');
  const usage = await getRegionUsage(String(region._id));
  if (usage.articleCount + usage.preferenceCount + usage.segmentCount + usage.recipientCount > 0) {
    throw httpError(423, 'region_locked');
  }
  await region.deleteOne();
  res.status(204).send();
}
