import type { Request, Response } from 'express';
import { runSearch, isSearchType, SEARCH_TYPES, type SearchType } from '../services/search';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

// GET /api/search?q=&types=article,poll&limit=6 (public, read-only).
// Shared by the site-header search and the AI-chat "+" attach picker. Returns
// { results: SearchResult[] }.
export async function search(req: Request, res: Response): Promise<void> {
  const q = typeof req.query.q === 'string' ? req.query.q : '';

  const rawLimit = parseInt(req.query.limit as string, 10);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT));

  const typesParam = typeof req.query.types === 'string' ? req.query.types : '';
  const requested: SearchType[] = typesParam
    ? typesParam.split(',').map((s) => s.trim()).filter(isSearchType)
    : SEARCH_TYPES;

  const results = await runSearch(q, requested, limit);
  res.json({ results });
}
