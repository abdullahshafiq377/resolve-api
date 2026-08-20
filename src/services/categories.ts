import mongoose from 'mongoose';
import Article from '../models/Article';
import Category, { CategoryDoc } from '../models/Category';
import Short from '../models/Short';
import Poll from '../models/Poll';
import ResearchRequest from '../models/ResearchRequest';
import { httpError } from '../utils/errors';

/**
 * The seeded categories, and the legacy labels each one absorbs.
 *
 * Order here is not display order — every list sorts by title — so this array
 * is free to read in whatever sequence is clearest.
 */
export const DEFAULT_CATEGORIES = [
  { title: 'Defense and Security', slug: 'defense-and-security', legacy: ['Defence'] },
  { title: 'Geopolitics', slug: 'geopolitics', legacy: ['Geopolitics'] },
  { title: 'Politics', slug: 'politics', legacy: ['Politics'] },
  { title: 'Economy and Business', slug: 'economy-and-business', legacy: ['Economy'] },
  { title: 'Opinion and Analysis', slug: 'opinion-and-analysis', legacy: ['Opinion'] },
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

/**
 * Resolve a category by its current slug, falling back to its retired ones.
 *
 * A rename moves the slug, so every published link, share and search result
 * pointing at the old address would otherwise stop resolving. The live slug is
 * tried first: if a category has since taken a slug another one used to hold,
 * the category that owns it now wins.
 */
export async function findCategoryBySlug(slug: string): Promise<CategoryDoc | null> {
  const current = await Category.findOne({ slug });
  if (current) return current;
  return Category.findOne({ previousSlugs: slug });
}

export interface CategoryUsage {
  articleCount: number;
  shortCount: number;
  // Only approved, non-rejected research requests lock a category (public visibility).
  researchRequestCount: number;
  pollCount: number;
}

export async function getCategoryUsage(categoryId: string): Promise<CategoryUsage> {
  const [articleCount, shortCount, researchRequestCount, pollCount] = await Promise.all([
    Article.countDocuments({ categoryId }),
    Short.countDocuments({ categoryId }),
    ResearchRequest.countDocuments({
      categoryId,
      approvedAt: { $ne: null },
      status: { $ne: 'rejected' },
    }),
    Poll.countDocuments({ categoryId }),
  ]);
  return { articleCount, shortCount, researchRequestCount, pollCount };
}

// True when a category is referenced by any article, short, approved research request, or poll.
export function isCategoryInUse(usage: CategoryUsage): boolean {
  return usage.articleCount + usage.shortCount + usage.researchRequestCount + usage.pollCount > 0;
}

/**
 * Move everything filed under `fromId` to `toId`.
 *
 * A category in use cannot be deactivated or deleted, and the way out of that is
 * to give its content somewhere else to live first. Every reference is a single
 * `categoryId`, so each collection is one `updateMany` — after this runs the
 * source category's usage is zero and the caller is free to act on it.
 *
 * Research requests move wholesale, including the pending and rejected ones that
 * `getCategoryUsage` does not count: leaving them pointed at a deleted category
 * would break them the moment they were approved.
 */
export async function reassignCategoryContent(
  fromId: string,
  toId: string,
): Promise<CategoryUsage> {
  const [articles, shorts, researchRequests, polls] = await Promise.all([
    Article.updateMany({ categoryId: fromId }, { $set: { categoryId: toId } }),
    Short.updateMany({ categoryId: fromId }, { $set: { categoryId: toId } }),
    ResearchRequest.updateMany({ categoryId: fromId }, { $set: { categoryId: toId } }),
    Poll.updateMany({ categoryId: fromId }, { $set: { categoryId: toId } }),
  ]);
  return {
    articleCount: articles.modifiedCount,
    shortCount: shorts.modifiedCount,
    researchRequestCount: researchRequests.modifiedCount,
    pollCount: polls.modifiedCount,
  };
}

export async function ensureDefaultCategories(): Promise<Map<string, CategoryDoc>> {
  const map = new Map<string, CategoryDoc>();
  for (const spec of DEFAULT_CATEGORIES) {
    const category = await Category.findOneAndUpdate(
      { slug: spec.slug },
      { $setOnInsert: { title: spec.title, slug: spec.slug, active: true } },
      { new: true, upsert: true },
    );
    for (const legacy of spec.legacy) map.set(legacy, category);
  }
  return map;
}
