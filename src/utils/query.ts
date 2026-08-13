/**
 * Shared query-string parsing for the admin list endpoints.
 *
 * Every admin table filters, searches, sorts and paginates over the whole
 * collection rather than over the page it happens to be holding, so all of them
 * need the same four things off `req.query`. Parsing lives here so one endpoint
 * cannot quietly disagree with another about what `order=asc` means.
 */

/** Escape user input so it is matched literally inside a RegExp. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Case-insensitive "contains" matcher for a free-text search box.
 *
 * Returns null for an empty search so callers can skip the clause entirely —
 * an unanchored regex is the expensive part of these queries and is not worth
 * paying for a blank box.
 */
export function searchRegex(value: unknown): RegExp | null {
  const term = typeof value === 'string' ? value.trim() : '';
  if (!term) return null;
  return new RegExp(escapeRegex(term), 'i');
}

/** `sort`, validated against the columns the endpoint actually supports. */
export function parseSortKey<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** `order`, as the 1 / -1 mongo wants. Anything but an explicit `asc` is descending. */
export function parseOrder(value: unknown, fallback: 1 | -1 = -1): 1 | -1 {
  if (value === 'asc') return 1;
  if (value === 'desc') return -1;
  return fallback;
}

export interface ParsedPagination {
  page: number;
  limit: number;
  skip: number;
}

export function parsePage(query: Record<string, unknown>, defaultLimit = 10, maxLimit = 100): ParsedPagination {
  const page = Math.max(1, parseInt(String(query.page ?? ''), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(query.limit ?? ''), 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * A sort document with `_id` appended as a tiebreaker.
 *
 * Without it, rows sharing a sort value (every draft has no publish date, most
 * categories share a title prefix) can be returned in a different order on each
 * query, which makes a row appear on two pages or on none.
 */
export function stableSort(field: string, direction: 1 | -1): Record<string, 1 | -1> {
  return field === '_id' ? { _id: direction } : { [field]: direction, _id: direction };
}
