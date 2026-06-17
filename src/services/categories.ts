import mongoose from 'mongoose';
import Article from '../models/Article';
import Category, { CategoryDoc } from '../models/Category';
import Short from '../models/Short';
import ResearchRequest from '../models/ResearchRequest';
import { httpError } from '../utils/errors';

export const DEFAULT_CATEGORIES = [
  { title: 'Defense and Security', slug: 'defense-and-security', legacy: ['Defence'], order: 10 },
  { title: 'Geopolitics', slug: 'geopolitics', legacy: ['Geopolitics'], order: 20 },
  { title: 'Politics', slug: 'politics', legacy: ['Politics'], order: 30 },
  { title: 'Economy and Business', slug: 'economy-and-business', legacy: ['Economy'], order: 40 },
  { title: 'Opinion and Analysis', slug: 'opinion-and-analysis', legacy: ['Opinion'], order: 50 },
] as const;

export function serializeCategory(category: CategoryDoc): Record<string, unknown> {
  const obj = category.toObject() as Record<string, unknown>;
  obj.id = String(category._id);
  return obj;
}

export async function findCategoryByIdOrThrow(value: unknown): Promise<CategoryDoc> {
  if (typeof value !== 'string' || !mongoose.Types.ObjectId.isValid(value)) {
    throw httpError(400, 'invalid_category');
  }
  const category = await Category.findById(value);
  if (!category) throw httpError(400, 'invalid_category');
  return category;
}

export async function findCategoryBySlug(slug: string): Promise<CategoryDoc | null> {
  return Category.findOne({ slug });
}

export interface CategoryUsage {
  articleCount: number;
  shortCount: number;
  // Only approved, non-rejected research requests lock a category (public visibility).
  researchRequestCount: number;
}

export async function getCategoryUsage(categoryId: string): Promise<CategoryUsage> {
  const [articleCount, shortCount, researchRequestCount] = await Promise.all([
    Article.countDocuments({ categoryId }),
    Short.countDocuments({ categoryId }),
    ResearchRequest.countDocuments({
      categoryId,
      approvedAt: { $ne: null },
      status: { $ne: 'rejected' },
    }),
  ]);
  return { articleCount, shortCount, researchRequestCount };
}

// True when a category is referenced by any article, short, or approved research request.
export function isCategoryInUse(usage: CategoryUsage): boolean {
  return usage.articleCount + usage.shortCount + usage.researchRequestCount > 0;
}

export async function ensureDefaultCategories(): Promise<Map<string, CategoryDoc>> {
  const map = new Map<string, CategoryDoc>();
  for (const spec of DEFAULT_CATEGORIES) {
    const category = await Category.findOneAndUpdate(
      { slug: spec.slug },
      { $setOnInsert: { title: spec.title, slug: spec.slug, active: true, order: spec.order } },
      { new: true, upsert: true },
    );
    for (const legacy of spec.legacy) map.set(legacy, category);
  }
  return map;
}
