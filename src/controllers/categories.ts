import type { Request, Response } from 'express';
import type { PipelineStage } from 'mongoose';
import Article from '../models/Article';
import Category from '../models/Category';
import type { CategoryDoc } from '../models/Category';
import Poll from '../models/Poll';
import ResearchRequest from '../models/ResearchRequest';
import Short from '../models/Short';
import {
  getCategoryUsage,
  isCategoryInUse,
  reassignCategoryContent,
  serializeCategory,
} from '../services/categories';
import { httpError } from '../utils/errors';
import { parseOrder, parseSortKey, searchRegex } from '../utils/query';
import {
  assertTitleAvailable,
  isDuplicateKeyError,
  LIST_COLLATION,
  parseTaxonomyTitle,
} from '../utils/taxonomy';
import { generateUniqueSlug } from '../utils/slugify';

/**
 * Columns the admin table can be ordered by.
 *
 * Manual ordering was dropped — a hand-kept `order` number only ever disagreed
 * with the alphabetical list editors actually read — so title is the default
 * everywhere and `usage` sorts on the computed total, not a stored field.
 */
const CATEGORY_SORT_KEYS = ['title', 'usage'] as const;

const MAX_LIMIT = 100;

async function serializeAdminCategory(category: CategoryDoc | null) {
  if (!category) return null;
  const usage = await getCategoryUsage(String(category._id));
  return {
    ...serializeCategory(category),
    ...usage,
    locked: isCategoryInUse(usage),
  };
}

export async function listPublic(_req: Request, res: Response) {
  const categories = await Category.find({ active: true })
    .collation(LIST_COLLATION)
    .sort({ title: 1 });
  res.json({ data: categories.map(serializeCategory) });
}

/**
 * Per-category usage counts, computed inside one aggregation.
 *
 * A `countDocuments` fan-out per row was fine while the table held every
 * category in the browser, but sorting and paginating server-side means the
 * counts have to exist before the sort does. Each lookup runs a `$count` against
 * the referencing collection rather than pulling the matching documents back, so
 * a category with fourteen thousand articles costs the same as an empty one.
 */
const USAGE_STAGES: PipelineStage[] = [
  ...[
    { model: Article, as: 'articleUsage' },
    { model: Short, as: 'shortUsage' },
    { model: Poll, as: 'pollUsage' },
    {
      model: ResearchRequest,
      as: 'researchRequestUsage',
      // Only publicly visible requests lock a category, mirroring getCategoryUsage.
      extra: { approvedAt: { $ne: null }, status: { $ne: 'rejected' } },
    },
  ].map(
    ({ model, as, extra }): PipelineStage => ({
      $lookup: {
        from: model.collection.name,
        let: { categoryId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$categoryId', '$$categoryId'] }, ...(extra ?? {}) } },
          { $count: 'total' },
        ],
        as,
      },
    }),
  ),
  {
    $addFields: {
      articleCount: { $ifNull: [{ $arrayElemAt: ['$articleUsage.total', 0] }, 0] },
      shortCount: { $ifNull: [{ $arrayElemAt: ['$shortUsage.total', 0] }, 0] },
      pollCount: { $ifNull: [{ $arrayElemAt: ['$pollUsage.total', 0] }, 0] },
      researchRequestCount: {
        $ifNull: [{ $arrayElemAt: ['$researchRequestUsage.total', 0] }, 0],
      },
    },
  },
  {
    $addFields: {
      usageTotal: {
        $add: ['$articleCount', '$shortCount', '$pollCount', '$researchRequestCount'],
      },
    },
  },
  { $project: { articleUsage: 0, shortUsage: 0, pollUsage: 0, researchRequestUsage: 0 } },
];

/**
 * GET /api/admin/categories
 *
 * Two shapes, chosen by whether `page` is present:
 *  · paginated — what the admin table asks for. Search, sort and pagination all
 *    run over the whole collection rather than over the rows in hand.
 *  · unpaginated — what the category pickers on the article, short and poll
 *    forms ask for. They need every category in one go and have no page control.
 * Both return `{ data, pagination }` so a caller never has to branch on shape.
 *
 * `usage=false` drops the counts and the `locked` flag with them. The pickers
 * render nothing but a title, so making them pay for a four-collection lookup
 * per category is pure waste. Counts are included by default, so a caller that
 * does not ask sees no change.
 */
export async function listAdmin(req: Request, res: Response) {
  const filter: Record<string, unknown> = {};
  if (req.query.status === 'active') filter.active = true;
  else if (req.query.status === 'inactive') filter.active = false;

  const term = searchRegex(req.query.search ?? req.query.q);
  if (term) filter.title = term;

  const withUsage = req.query.usage !== 'false';
  // Ordering by usage needs counts to order by, so without them it is title.
  const sortKey = withUsage
    ? parseSortKey(req.query.sort, CATEGORY_SORT_KEYS, 'title')
    : 'title';
  const order = parseOrder(req.query.order, sortKey === 'title' ? 1 : -1);
  const sortField = sortKey === 'title' ? 'title' : 'usageTotal';

  const paginated = req.query.page !== undefined || req.query.limit !== undefined;
  const page = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || 10));

  const pipeline: PipelineStage[] = [
    { $match: filter },
    ...(withUsage ? USAGE_STAGES : []),
    // _id breaks ties so a row cannot land on two pages, or on none.
    { $sort: { [sortField]: order, _id: order } },
  ];
  if (paginated) pipeline.push({ $skip: (page - 1) * limit }, { $limit: limit });

  const [rows, total] = await Promise.all([
    Category.aggregate(pipeline).collation(LIST_COLLATION),
    Category.countDocuments(filter),
  ]);

  const data = rows.map((row) => {
    const { usageTotal, ...rest } = row as Record<string, unknown> & { usageTotal: number };
    // `locked` is derived from the counts, so it goes when they do rather than
    // being reported as a confident `false`.
    return withUsage
      ? { ...rest, id: String(row._id), locked: usageTotal > 0 }
      : { ...rest, id: String(row._id) };
  });

  res.json({
    data,
    pagination: paginated
      ? { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) }
      : { total, page: 1, limit: total, pages: 1 },
  });
}

export async function create(req: Request, res: Response) {
  const title = parseTaxonomyTitle(req.body.title);
  await assertTitleAvailable(Category, title);
  const slug = await generateUniqueSlug(title, Category);
  // New categories are always active — there is no reason to create one hidden,
  // and the add modal no longer offers the toggle.
  try {
    const category = await Category.create({ title, slug, active: true });
    res.status(201).json(await serializeAdminCategory(category));
  } catch (err) {
    // The unique index catches what the check above raced past.
    if (isDuplicateKeyError(err)) throw httpError(409, 'title_taken');
    throw err;
  }
}

/**
 * PUT /api/admin/categories/:id
 *
 * Renaming is always allowed, in use or not: every article, short, poll and
 * request references the category by id, so a rename reaches all of them at once
 * and is the only way to fix a typo. The slug follows the title so the public
 * URL keeps matching what the category is called, and the address it is moving
 * off is kept in `previousSlugs` so every published `/category/<slug>` link
 * still resolves — the public page redirects them to the current one.
 *
 * Deactivating is the guarded half. A category in use is still in public
 * navigation, so it is refused here and the admin is sent through
 * `reassign` instead, which gives the content another home first.
 */
export async function update(req: Request, res: Response) {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ error: 'not_found' });
  const usage = await getCategoryUsage(String(category._id));
  const inUse = isCategoryInUse(usage);

  const { title, active } = req.body;
  const patch: Record<string, unknown> = {};

  if (title !== undefined) {
    patch.title = parseTaxonomyTitle(title);
    await assertTitleAvailable(Category, patch.title as string, req.params.id);

    // The generator steps over every category's retired slugs as well as their
    // live ones, so the new slug can never collide with an address that still
    // has to resolve somewhere else.
    const nextSlug = await generateUniqueSlug(patch.title as string, Category, req.params.id, [
      'previousSlugs',
    ]);
    if (nextSlug !== category.slug) {
      patch.slug = nextSlug;
      // Retire the address being vacated, and drop the one being taken up in
      // case this is a rename back to somewhere the category has been before.
      patch.previousSlugs = [
        ...new Set([...(category.previousSlugs ?? []), category.slug]),
      ].filter((slug) => slug !== nextSlug);
    }
  }
  if (active !== undefined && active === false && category.active && inUse) {
    throw httpError(409, 'category_in_use');
  }
  if (active !== undefined) patch.active = active !== false;

  try {
    const updated = await Category.findByIdAndUpdate(req.params.id, patch, {
      new: true,
      runValidators: true,
    });
    res.json(await serializeAdminCategory(updated));
  } catch (err) {
    // The unique index catches what the check above raced past.
    if (isDuplicateKeyError(err)) throw httpError(409, 'title_taken');
    throw err;
  }
}

/**
 * POST /api/admin/categories/:id/reassign
 *
 * Move every item filed under this category to `replacementId`, then deactivate
 * or delete it in the same request. Doing both server-side means the admin
 * cannot end up looking at a half-finished state where the content has moved but
 * the category they wanted gone is still there.
 */
export async function reassign(req: Request, res: Response) {
  const { replacementId, action } = req.body as { replacementId?: unknown; action?: unknown };
  if (action !== 'deactivate' && action !== 'delete') {
    return res.status(400).json({ error: 'invalid_action' });
  }

  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ error: 'not_found' });

  if (typeof replacementId !== 'string' || replacementId === String(category._id)) {
    throw httpError(400, 'invalid_replacement');
  }
  const replacement = await Category.findById(replacementId);
  if (!replacement) throw httpError(400, 'invalid_replacement');
  // Moving content into a hidden category would take it out of public navigation
  // just as surely as leaving it where it was.
  if (!replacement.active) throw httpError(400, 'replacement_inactive');

  const moved = await reassignCategoryContent(String(category._id), String(replacement._id));
  const movedTotal =
    moved.articleCount + moved.shortCount + moved.researchRequestCount + moved.pollCount;

  if (action === 'delete') {
    await category.deleteOne();
    return res.json({ action, moved, movedTotal, replacement: serializeCategory(replacement) });
  }

  category.active = false;
  await category.save();
  res.json({
    action,
    moved,
    movedTotal,
    replacement: serializeCategory(replacement),
    category: await serializeAdminCategory(category),
  });
}

// POST /api/admin/categories/bulk — batch activity change or delete.
//
// A category that anything uses is locked: it can be neither deactivated nor
// deleted without giving its content somewhere else to go first, and picking one
// replacement for a whole selection would hide what each row actually holds. A
// batch therefore applies to the unused categories in the selection and reports
// the rest as skipped, leaving the locked ones to the per-row reassign flow.
export async function bulk(req: Request, res: Response) {
  const { ids, action } = req.body as { ids?: unknown; action?: unknown };

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (action !== 'active' && action !== 'delete') {
    return res.status(400).json({ error: 'invalid_action' });
  }

  const categories = await Category.find({ _id: { $in: ids } });
  if (categories.length === 0) return res.status(404).json({ error: 'not_found' });

  const active = req.body.active !== false;

  // Usage decides eligibility, except for activating: switching a category back
  // on is never destructive, so it is allowed even on a category in use.
  const usable: CategoryDoc[] = [];
  for (const category of categories) {
    if (action === 'active' && active) {
      usable.push(category);
      continue;
    }
    const usage = await getCategoryUsage(String(category._id));
    if (!isCategoryInUse(usage)) usable.push(category);
  }
  const skipped = categories.length - usable.length;

  if (action === 'delete') {
    if (usable.length) {
      await Category.deleteMany({ _id: { $in: usable.map((category) => category._id) } });
    }
    return res.json({ action, affected: usable.length, skipped });
  }

  if (usable.length) {
    await Category.updateMany(
      { _id: { $in: usable.map((category) => category._id) } },
      { $set: { active } },
    );
  }
  res.json({ action, active, affected: usable.length, skipped });
}

export async function remove(req: Request, res: Response) {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ error: 'not_found' });
  const usage = await getCategoryUsage(String(category._id));
  if (isCategoryInUse(usage)) throw httpError(409, 'category_in_use');
  await category.deleteOne();
  res.status(204).send();
}
