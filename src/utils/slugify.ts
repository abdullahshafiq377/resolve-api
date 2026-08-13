import type { Model } from 'mongoose';

export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A slug for `title` that no other document is using.
 *
 * `alsoMatch` names extra fields that must not hold the slug either. Categories
 * keep their retired slugs in `previousSlugs` so old links keep resolving, and a
 * new category handed one of those would make the lookup ambiguous — the same
 * slug would point at two rows. Passing `['previousSlugs']` makes the generator
 * step over the history as well as the live slugs.
 *
 * `excludeId` skips the document being renamed, so a category can always move
 * back to a slug that only its own history holds.
 */
export async function generateUniqueSlug(
  title: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model: Model<any>,
  excludeId: string | null = null,
  alsoMatch: string[] = [],
): Promise<string> {
  const base = toSlug(title);
  let slug = base;
  let counter = 1;

  while (true) {
    const query: Record<string, unknown> = alsoMatch.length
      ? { $or: [{ slug }, ...alsoMatch.map((field) => ({ [field]: slug }))] }
      : { slug };
    if (excludeId) query._id = { $ne: excludeId };

    const exists = await Model.exists(query);
    if (!exists) return slug;

    slug = `${base}-${counter}`;
    counter++;
  }
}
