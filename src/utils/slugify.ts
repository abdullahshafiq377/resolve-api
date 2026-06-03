import type { Model } from 'mongoose';

export function toSlug(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function generateUniqueSlug(
  title: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Model: Model<any>,
  excludeId: string | null = null,
): Promise<string> {
  const base = toSlug(title);
  let slug = base;
  let counter = 1;

  while (true) {
    const query: Record<string, unknown> = { slug };
    if (excludeId) query._id = { $ne: excludeId };

    const exists = await Model.exists(query);
    if (!exists) return slug;

    slug = `${base}-${counter}`;
    counter++;
  }
}
