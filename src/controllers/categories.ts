import type { Request, Response } from 'express';
import Category from '../models/Category';
import type { CategoryDoc } from '../models/Category';
import {
  getCategoryUsage,
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
    locked: usage.articleCount + usage.shortCount > 0,
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
  if (usage.articleCount + usage.shortCount > 0) throw httpError(400, 'category_in_use');

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

export async function remove(req: Request, res: Response) {
  const category = await Category.findById(req.params.id);
  if (!category) return res.status(404).json({ error: 'not_found' });
  const usage = await getCategoryUsage(String(category._id));
  if (usage.articleCount + usage.shortCount > 0) throw httpError(400, 'category_in_use');
  await category.deleteOne();
  res.status(204).send();
}
