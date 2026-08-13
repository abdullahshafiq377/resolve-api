import type { Request, Response } from 'express';
import type { PipelineStage } from 'mongoose';
import Article from '../models/Article';
import BriefPreference from '../models/BriefPreference';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment from '../models/BriefSegment';
import Region, { RegionDoc } from '../models/Region';
import { generateUniqueSlug } from '../utils/slugify';
import { httpError } from '../utils/errors';
import { parseOrder, parseSortKey, searchRegex } from '../utils/query';
import {
  assertTitleAvailable,
  isDuplicateKeyError,
  LIST_COLLATION,
  parseTaxonomyTitle,
} from '../utils/taxonomy';
import {
  getRegionUsage,
  isGlobalRegion,
  isRegionInUse,
  reassignRegionContent,
  serializeRegion,
} from '../services/regions';

/** Columns the admin table can be ordered by. Manual ordering was dropped. */
const REGION_SORT_KEYS = ['title', 'articles', 'recipients'] as const;

const REGION_SORT_FIELDS: Record<(typeof REGION_SORT_KEYS)[number], string> = {
  title: 'title',
  articles: 'articleCount',
  recipients: 'recipientCount',
};

const MAX_LIMIT = 100;

async function serializeAdminRegion(region: RegionDoc | null) {
  if (!region) return null;
  const usage = await getRegionUsage(String(region._id));
  return {
    ...serializeRegion(region),
    ...usage,
    locked: isRegionInUse(usage),
    global: await isGlobalRegion(region),
  };
}

/**
 * Per-region usage counts, computed inside one aggregation.
 *
 * Same shape as the categories pipeline: each lookup runs a `$count` against the
 * referencing collection instead of pulling documents back, so the table can
 * sort and paginate on counts it has not had to fetch.
 */
const USAGE_STAGES: PipelineStage[] = [
  ...[
    { model: Article, as: 'articleUsage', field: 'regionIds' },
    { model: BriefPreference, as: 'preferenceUsage', field: 'regionIds', live: true },
    { model: BriefSegment, as: 'segmentUsage', field: 'regionIds', live: true },
    {
      model: BriefRecipient,
      as: 'recipientUsage',
      field: 'preferenceSnapshot.regionIds',
      live: true,
      // The snapshot stores ids as plain strings, not ObjectIds — it is a copy of
      // what was sent, not a reference — so the region's _id has to be stringified
      // before it will match. The other three hold real ObjectIds.
      asString: true,
    },
  ].map(
    ({ model, as, field, live, asString }): PipelineStage => ({
      $lookup: {
        from: model.collection.name,
        let: { regionId: asString ? { $toString: '$_id' } : '$_id' },
        pipeline: [
          {
            $match: {
              $expr: { $in: ['$$regionId', { $ifNull: [`$${field}`, []] }] },
              ...(live ? { deletedAt: null } : {}),
            },
          },
          { $count: 'total' },
        ],
        as,
      },
    }),
  ),
  {
    $addFields: {
      articleCount: { $ifNull: [{ $arrayElemAt: ['$articleUsage.total', 0] }, 0] },
      preferenceCount: { $ifNull: [{ $arrayElemAt: ['$preferenceUsage.total', 0] }, 0] },
      segmentCount: { $ifNull: [{ $arrayElemAt: ['$segmentUsage.total', 0] }, 0] },
      recipientCount: { $ifNull: [{ $arrayElemAt: ['$recipientUsage.total', 0] }, 0] },
    },
  },
  { $project: { articleUsage: 0, preferenceUsage: 0, segmentUsage: 0, recipientUsage: 0 } },
];

/**
 * GET /api/admin/regions
 *
 * Paginated when `page` or `limit` is given — what the admin table asks for —
 * and the whole set otherwise, which is what the region pickers on the article
 * forms need. Both shapes return `{ data, pagination }`.
 *
 * `usage=false` drops the counts and the `locked` flag with them. The pickers
 * render nothing but a title, so making them pay for a four-collection lookup
 * per region is pure waste. Counts are included by default.
 */
export async function listAdmin(req: Request, res: Response) {
  const filter: Record<string, unknown> = {};
  if (req.query.includeInactive === 'false' || req.query.status === 'active') filter.active = true;
  else if (req.query.status === 'inactive') filter.active = false;

  const term = searchRegex(req.query.search ?? req.query.q);
  if (term) filter.title = term;

  const withUsage = req.query.usage !== 'false';
  // Ordering by articles or recipients needs counts to order by.
  const sortKey = withUsage ? parseSortKey(req.query.sort, REGION_SORT_KEYS, 'title') : 'title';
  const order = parseOrder(req.query.order, sortKey === 'title' ? 1 : -1);

  const paginated = req.query.page !== undefined || req.query.limit !== undefined;
  const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || 10));

  const pipeline: PipelineStage[] = [{ $match: filter }, ...(withUsage ? USAGE_STAGES : [])];

  if (paginated) {
    // The table sorts purely by the column the admin picked — pinning Global to
    // the top of a list ordered by article count would just look wrong. `_id`
    // breaks ties so a row cannot land on two pages, or on none.
    pipeline.push(
      { $sort: { [REGION_SORT_FIELDS[sortKey]]: order, _id: order } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
    );
  } else {
    // The unpaginated shape feeds the region pickers, where Global leads: it is
    // the fallback a reader who has chosen nothing is served.
    pipeline.push(
      { $addFields: { isGlobal: { $eq: ['$slug', 'global'] } } },
      { $sort: { isGlobal: -1, [REGION_SORT_FIELDS[sortKey]]: order, _id: order } },
      { $project: { isGlobal: 0 } },
    );
  }

  const [rows, total] = await Promise.all([
    Region.aggregate(pipeline).collation(LIST_COLLATION),
    Region.countDocuments(filter),
  ]);

  // `locked` is derived from the counts, so it goes when they do rather than
  // being reported as a confident `false`. `global` is read off the slug and
  // survives either way — the pickers rely on it to pin the fallback.
  const data = rows.map((row) => ({
    ...row,
    id: String(row._id),
    ...(withUsage
      ? { locked: row.articleCount + row.preferenceCount + row.segmentCount > 0 }
      : {}),
    global: row.slug === 'global',
  }));

  res.json({
    data,
    pagination: paginated
      ? { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) }
      : { total, page: 1, limit: total, pages: 1 },
  });
}

export async function create(req: Request, res: Response) {
  const title = parseTaxonomyTitle(req.body.title);
  await assertTitleAvailable(Region, title);
  const slug = await generateUniqueSlug(title, Region);
  // New regions are always active; the add modal no longer offers the toggle.
  try {
    const region = await Region.create({ title, slug, active: true });
    res.status(201).json(await serializeAdminRegion(region));
  } catch (err) {
    if (isDuplicateKeyError(err)) throw httpError(409, 'title_taken');
    throw err;
  }
}

/**
 * PUT /api/admin/regions/:id
 *
 * Mirrors the category rules. Renaming is always allowed — every article,
 * segment and preference references the region by id, so a rename reaches all of
 * them and is the only way to fix a typo — and the slug follows the title.
 *
 * Regions need no `previousSlugs` the way categories do: nothing addresses a
 * region by slug from outside, so there is no published link to strand. The one
 * exception is Global, whose slug *is* load-bearing — the Brief fallback, the
 * targeting pin and brief generation all find it by slug — so it never moves,
 * however the region is retitled.
 *
 * Deactivating a region in use is refused and routed through `reassign`, so its
 * articles and its readers' Brief preferences are given another region before it
 * leaves the targeting lists.
 */
export async function update(req: Request, res: Response) {
  const region = await Region.findById(req.params.id);
  if (!region) return res.status(404).json({ error: 'not_found' });
  const usage = await getRegionUsage(String(region._id));
  const inUse = isRegionInUse(usage);

  const { title, active } = req.body;
  const patch: Record<string, unknown> = {};

  if (title !== undefined) {
    patch.title = parseTaxonomyTitle(title);
    await assertTitleAvailable(Region, patch.title as string, req.params.id);
    if (!(await isGlobalRegion(region))) {
      patch.slug = await generateUniqueSlug(patch.title as string, Region, req.params.id);
    }
  }
  if (active !== undefined && active === false && region.active) {
    // Global is what a reader with no region of their own is served; taking it
    // out of targeting would empty their Brief.
    if (await isGlobalRegion(region)) throw httpError(400, 'global_region_required');
    if (inUse) throw httpError(409, 'region_in_use');
  }
  if (active !== undefined) patch.active = active !== false;

  try {
    const updated = await Region.findByIdAndUpdate(req.params.id, patch, {
      new: true,
      runValidators: true,
    });
    res.json(await serializeAdminRegion(updated));
  } catch (err) {
    if (isDuplicateKeyError(err)) throw httpError(409, 'title_taken');
    throw err;
  }
}

/**
 * POST /api/admin/regions/:id/reassign
 *
 * Move the region's articles, Brief segments and reader preferences to
 * `replacementId`, then deactivate or delete it in the same request. Recipient
 * snapshots are left untouched — see `reassignRegionContent`.
 */
export async function reassign(req: Request, res: Response) {
  const { replacementId, action } = req.body as { replacementId?: unknown; action?: unknown };
  if (action !== 'deactivate' && action !== 'delete') {
    return res.status(400).json({ error: 'invalid_action' });
  }

  const region = await Region.findById(req.params.id);
  if (!region) return res.status(404).json({ error: 'not_found' });
  if (await isGlobalRegion(region)) throw httpError(400, 'global_region_required');

  if (typeof replacementId !== 'string' || replacementId === String(region._id)) {
    throw httpError(400, 'invalid_replacement');
  }
  const replacement = await Region.findById(replacementId);
  if (!replacement) throw httpError(400, 'invalid_replacement');
  // Targeting only ever offers active regions, so moving content into an
  // inactive one would strand it exactly as leaving it in place would.
  if (!replacement.active) throw httpError(400, 'replacement_inactive');

  const moved = await reassignRegionContent(String(region._id), String(replacement._id));
  const movedTotal = moved.articleCount + moved.preferenceCount + moved.segmentCount;

  if (action === 'delete') {
    await region.deleteOne();
    return res.json({ action, moved, movedTotal, replacement: serializeRegion(replacement) });
  }

  region.active = false;
  await region.save();
  res.json({
    action,
    moved,
    movedTotal,
    replacement: serializeRegion(replacement),
    region: await serializeAdminRegion(region),
  });
}

// POST /api/admin/regions/bulk — batch activity change or delete.
//
// Two guards, both reported as skips rather than failing the batch:
//  · the global region is never touched — deleting it is refused outright, and
//    deactivating it would pull the fallback out of Brief targeting for everyone;
//  · a region in use can be neither deactivated nor deleted without giving its
//    content somewhere else to go, and one replacement chosen for a whole
//    selection would hide what each row holds. Those rows are left to the
//    per-row reassign flow.
// Activating is never destructive, so it is allowed even on a region in use.
export async function bulk(req: Request, res: Response) {
  const { ids, action } = req.body as { ids?: unknown; action?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (action !== 'active' && action !== 'delete') {
    return res.status(400).json({ error: 'invalid_action' });
  }

  const regions = await Region.find({ _id: { $in: ids } });
  if (regions.length === 0) return res.status(404).json({ error: 'not_found' });

  const active = req.body.active !== false;

  const eligible: RegionDoc[] = [];
  for (const region of regions) {
    if (await isGlobalRegion(region)) continue;
    if (!(action === 'active' && active)) {
      const usage = await getRegionUsage(String(region._id));
      if (isRegionInUse(usage)) continue;
    }
    eligible.push(region);
  }
  const skipped = regions.length - eligible.length;

  if (action === 'delete') {
    if (eligible.length) {
      await Region.deleteMany({ _id: { $in: eligible.map((region) => region._id) } });
    }
    return res.json({ action, affected: eligible.length, skipped });
  }

  if (eligible.length) {
    await Region.updateMany(
      { _id: { $in: eligible.map((region) => region._id) } },
      { $set: { active } },
    );
  }
  res.json({ action, active, affected: eligible.length, skipped });
}

export async function remove(req: Request, res: Response) {
  const region = await Region.findById(req.params.id);
  if (!region) return res.status(404).json({ error: 'not_found' });
  if (await isGlobalRegion(region)) throw httpError(400, 'global_region_required');
  const usage = await getRegionUsage(String(region._id));
  if (isRegionInUse(usage)) throw httpError(423, 'region_locked');
  await region.deleteOne();
  res.status(204).send();
}
