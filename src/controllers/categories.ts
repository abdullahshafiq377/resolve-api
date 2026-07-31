import type { Request, Response } from 'express';
import Category from '../models/Category';
import type { CategoryDoc } from '../models/Category';
import {
  getCategoryUsage,
  isCategoryInUse,
  serializeCategory,
} from '../services/categories';
import { httpError } from '../utils/errors';
import { generateUniqueSlug } from '../utils/slugify';

function parseOrder(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num)) throw httpError(400, 'invalid_order');
  return num;
}

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
  const categories = await Category.find({ active: true }).sort({ order: 1, title: 1 });
  res.json({ data: categories.map(serializeCategory) });
}

export async function listAdmin(_req: Request, res: Response) {
  const categories = await Category.find().sort({ order: 1, title: 1 });
  const data = await Promise.all(categories.map((category) => serializeAdminCategory(category)));
  res.json({ data });
}

export async function create(req: Request, res: Response) {
  const { title, active = true, order } = req.body;
  if (typeof title !== 'string' || !title.trim()) throw httpError(400, 'title_required');
  const slug = await generateUniqueSlug(title, Category);
  const category = await Category.create({
    title: title.trim(),
    slug,
    active: active !== false,
    order: parseOrder(order),
  });
  res.status(201).json(await serializeAdminCategory(category));
}

export async function update(req: Request, res: Response) {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ error: 'not_found' });
  const usage = await getCategoryUsage(String(category._id));
  if (isCategoryInUse(usage)) throw httpError(409, 'category_in_use');

  const { title, active, order } = req.body;
  const patch: Record<string, unknown> = {};
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) throw httpError(400, 'title_required');
    patch.title = title.trim();
    patch.slug = await generateUniqueSlug(title, Category, req.params.id);
  }
  if (active !== undefined) patch.active = active !== false;
  if (order !== undefined) patch.order = parseOrder(order);

  const updated = await Category.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  res.json(await serializeAdminCategory(updated));
}

// POST /api/admin/categories/bulk — batch activity change or delete.
//
// A category that anything uses is locked: it can be neither edited nor deleted
// (see `update` and `remove`). A batch therefore applies to the unused categories
// in the selection and reports the rest as skipped.
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

  // Usage decides eligibility for both actions.
  const usable: CategoryDoc[] = [];
  for (const category of categories) {
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

  const active = req.body.active !== false;
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
