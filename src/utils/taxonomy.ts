/**
 * Shared rules for the two taxonomy admin screens — categories and regions.
 *
 * The screens are the same shape and their designs draw the same "0/25" counter
 * under the title field, so the limit and the case-insensitive list collation
 * live here rather than being restated (and eventually disagreeing) in both
 * controllers.
 */

import type { Model } from 'mongoose';
import { httpError } from './errors';

/** Matches the character counter the add/edit modals draw. */
export const TAXONOMY_TITLE_MAX_LENGTH = 25;

/** Case-insensitive sorting, so "africa" files next to "Africa". */
export const LIST_COLLATION = { locale: 'en', strength: 2 } as const;

/**
 * Trim and length-check a title from the request body.
 *
 * Throws `title_required` for anything blank and `title_too_long` past the limit
 * the modal enforces client-side, so a hand-rolled request cannot slip past it.
 */
export function parseTaxonomyTitle(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, 'title_required');
  const title = value.trim();
  if (title.length > TAXONOMY_TITLE_MAX_LENGTH) throw httpError(400, 'title_too_long');
  return title;
}

/**
 * Refuse a title another row already has, as a 409 rather than a 500.
 *
 * The check is case-insensitive — it reuses the list collation — which is
 * stricter than the unique index on `Category.title`: Mongo would happily accept
 * "Politics" alongside "politics", and to an editor reading the table those are
 * the same category. `Region.title` carries no unique index at all, so for
 * regions this is the only thing standing between the admin and two identically
 * named rows.
 *
 * Racy on its own — two requests can both pass before either writes — which is
 * what `isDuplicateKeyError` backstops on the models that do have the index.
 */
export async function assertTitleAvailable(
  model: Model<{ title: string }>,
  title: string,
  excludeId?: string,
): Promise<void> {
  const filter: Record<string, unknown> = { title };
  if (excludeId) filter._id = { $ne: excludeId };
  const clash = await model.findOne(filter).collation(LIST_COLLATION).select('_id');
  if (clash) throw httpError(409, 'title_taken');
}

/**
 * True for Mongo's duplicate-key error.
 *
 * Both taxonomy models generate their slug through `generateUniqueSlug`, so the
 * only index either can realistically collide on is the unique title — which is
 * why callers map this to `title_taken`.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
