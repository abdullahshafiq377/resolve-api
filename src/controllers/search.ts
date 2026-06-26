import type { Request, Response } from 'express';
import Article from '../models/Article';
import Short from '../models/Short';
import Category from '../models/Category';

// Global search across public content. Powers both the site-header global search
// (results navigate) and the AI-chat "attach context" picker (results attach).
// One endpoint, one unified result shape — new content types slot into the
// discriminated union without changing callers.
//
// v1 uses case-insensitive substring (regex) matching, which mirrors the old
// client-side title filter the AI-chat picker used. Full-text / body search is a
// later iteration: article bodies are Tiptap JSON (not regex-searchable), but
// their plain text already lives in the ArticleChunk collection (RAG), so a
// future pass can search ArticleChunk.text or add a Mongo $text index.

const SEARCH_TYPES = ['article', 'short', 'category'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;

export type SearchResult =
  | { type: 'article'; id: string; title: string; slug: string; subtitle?: string }
  | { type: 'short'; id: string; title: string; slug: string; subtitle?: string }
  | { type: 'category'; id: string; title: string; slug: string };

// Escape user input before using it in a RegExp so special characters are
// treated literally (no injection, no invalid-pattern crashes).
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseTypes(raw: unknown): SearchType[] {
  if (typeof raw !== 'string' || !raw.trim()) return [...SEARCH_TYPES];
  const requested = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t));
  return requested.length ? requested : [...SEARCH_TYPES];
}

function durationLabel(seconds?: number): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// GET /api/search?q=&types=article,short,category&limit=
export async function search(req: Request, res: Response) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.json({ results: [] });
    return;
  }

  const types = parseTypes(req.query.types);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit as string, 10) || DEFAULT_LIMIT),
  );
  const rx = new RegExp(escapeRegex(q), 'i');

  const tasks: Promise<SearchResult[]>[] = [];

  if (types.includes('article')) {
    tasks.push(
      Article.find({ status: 'published', $or: [{ title: rx }, { excerpt: rx }] })
        .sort({ publishDate: -1 })
        .limit(limit)
        .select('title slug category')
        .then((docs) =>
          docs.map((doc) => ({
            type: 'article' as const,
            id: String(doc._id),
            title: doc.title,
            slug: doc.slug,
            subtitle: doc.category || undefined,
          })),
        ),
    );
  }

  if (types.includes('short')) {
    tasks.push(
      Short.find({ status: 'published', $or: [{ title: rx }, { description: rx }, { tags: rx }] })
        .sort({ publishedAt: -1 })
        .limit(limit)
        .select('title slug durationSeconds')
        .then((docs) =>
          docs.map((doc) => ({
            type: 'short' as const,
            id: String(doc._id),
            title: doc.title,
            slug: doc.slug,
            subtitle: durationLabel(doc.durationSeconds),
          })),
        ),
    );
  }

  if (types.includes('category')) {
    tasks.push(
      Category.find({ active: true, title: rx })
        .sort({ order: 1, title: 1 })
        .limit(limit)
        .select('title slug')
        .then((docs) =>
          docs.map((doc) => ({
            type: 'category' as const,
            id: String(doc._id),
            title: doc.title,
            slug: doc.slug,
          })),
        ),
    );
  }

  const grouped = await Promise.all(tasks);
  res.json({ results: grouped.flat() });
}
