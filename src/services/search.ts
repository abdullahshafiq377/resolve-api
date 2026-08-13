// Global search over public content. Backs GET /api/search, which powers both
// the site-header search (results navigate) and the AI-chat "+" attach picker
// (results attach). One case-insensitive regex query per requested type over the
// public-visible corpus, merged round-robin so no single type dominates a mixed
// search. Kept deliberately simple (regex, not a text index) — the picker asks
// for a handful of results, not ranked full-text.

import Article, { type GateTier } from '../models/Article';
import Short from '../models/Short';
import Category from '../models/Category';
import ResearchRequest from '../models/ResearchRequest';
import Poll from '../models/Poll';

export type SearchType = 'article' | 'short' | 'category' | 'research-request' | 'poll';

export const SEARCH_TYPES: SearchType[] = ['article', 'short', 'category', 'research-request', 'poll'];

export function isSearchType(value: string): value is SearchType {
  return (SEARCH_TYPES as string[]).includes(value);
}

export interface SearchResult {
  type: SearchType;
  id: string;
  title: string;
  slug?: string;
  subtitle?: string;
  /** Articles only: minimum plan needed to read past the gate; null = open. */
  gateTier?: GateTier | null;
}

// Escape user input so it's matched literally inside a RegExp.
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function snippet(text: string | null | undefined, max = 120): string | undefined {
  if (!text) return undefined;
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function searchArticles(rx: RegExp, limit: number): Promise<SearchResult[]> {
  const docs = await Article.find({ status: 'published', $or: [{ title: rx }, { excerpt: rx }] })
    .sort({ publishDate: -1 })
    .limit(limit)
    .select('title slug excerpt gateTier')
    .lean();
  return docs.map((d) => ({
    type: 'article',
    id: String(d._id),
    title: d.title,
    slug: d.slug,
    subtitle: snippet(d.excerpt),
    // Which plan a reader needs to get past this article's gate, or null when it
    // is open. Published metadata, not content — it is already on every article
    // card and hero. The AI-chat attach picker uses it to refuse a locked article
    // up front rather than letting the reader compose a question that the chat
    // endpoint would only reject afterwards.
    gateTier: d.gateTier ?? null,
  }));
}

async function searchShorts(rx: RegExp, limit: number): Promise<SearchResult[]> {
  const docs = await Short.find({ status: 'published', $or: [{ title: rx }, { description: rx }] })
    .sort({ publishedAt: -1, createdAt: -1 })
    .limit(limit)
    .select('title slug description')
    .lean();
  return docs.map((d) => ({
    type: 'short',
    id: String(d._id),
    title: d.title,
    slug: d.slug,
    subtitle: snippet(d.description),
  }));
}

async function searchCategories(rx: RegExp, limit: number): Promise<SearchResult[]> {
  const docs = await Category.find({ active: true, title: rx })
    .sort({ title: 1 })
    .limit(limit)
    .select('title slug')
    .lean();
  return docs.map((d) => ({ type: 'category', id: String(d._id), title: d.title, slug: d.slug }));
}

async function searchResearchRequests(rx: RegExp, limit: number): Promise<SearchResult[]> {
  // Public visibility gate: approved and not rejected (mirrors the leaderboard).
  const docs = await ResearchRequest.find({
    approvedAt: { $ne: null },
    status: { $ne: 'rejected' },
    $or: [{ title: rx }, { description: rx }],
  })
    .sort({ voteCount: -1, createdAt: -1 })
    .limit(limit)
    .select('title slug description')
    .lean();
  return docs.map((d) => ({
    type: 'research-request',
    id: String(d._id),
    title: d.title,
    slug: d.slug,
    subtitle: snippet(d.description),
  }));
}

async function searchPolls(rx: RegExp, limit: number): Promise<SearchResult[]> {
  // Public polls are the open + closed ones (drafts/scheduled are hidden).
  const docs = await Poll.find({
    status: { $in: ['open', 'closed'] },
    $or: [{ question: rx }, { description: rx }],
  })
    .sort({ status: 1, createdAt: -1 })
    .limit(limit)
    .select('question slug description')
    .lean();
  return docs.map((d) => ({
    type: 'poll',
    id: String(d._id),
    title: d.question,
    slug: d.slug,
    subtitle: snippet(d.description),
  }));
}

const RUNNERS: Record<SearchType, (rx: RegExp, limit: number) => Promise<SearchResult[]>> = {
  article: searchArticles,
  short: searchShorts,
  category: searchCategories,
  'research-request': searchResearchRequests,
  poll: searchPolls,
};

// Interleave the per-type result lists round-robin so a mixed-type search shows
// variety instead of exhausting one type first, then cap to `limit`.
function interleave(lists: SearchResult[][], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max && out.length < limit; i++) {
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/**
 * Run a global search. `types` selects which content kinds to include; each is
 * queried up to `limit`, then the lists are interleaved and capped to `limit`.
 * An empty/whitespace query returns nothing (no wildcard dumps).
 */
export async function runSearch(
  query: string,
  types: SearchType[],
  limit: number,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const rx = new RegExp(escapeRegex(q), 'i');
  const wanted = types.length ? types : SEARCH_TYPES;
  const lists = await Promise.all(wanted.map((t) => RUNNERS[t](rx, limit)));
  return interleave(lists, limit);
}
