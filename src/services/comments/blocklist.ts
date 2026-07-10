import BlockedKeyword from '../../models/BlockedKeyword';

// Normalise text for block-list matching (comments-voting-reporting-moderation.md §4.3):
//   NFKC + lowercase
//   + leet substitutions (@→a, 0→o, 1→l, $→s, !→i)
//   + strip *, _, . separators (so f.uck / f*u*c*k collapse)
//   + strip combining diacritics (fück → fuck)
export function normalizeForMatch(input: string): string {
  let s = input.normalize('NFKC').toLowerCase();
  // Strip combining diacritical marks.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Leet substitutions.
  s = s
    .replace(/@/g, 'a')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/\$/g, 's')
    .replace(/!/g, 'i');
  // Strip common in-word separators used to evade filters.
  s = s.replace(/[*_.]/g, '');
  return s;
}

let cache: { terms: string[]; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function getActiveTerms(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.terms;
  const docs = await BlockedKeyword.find({ isActive: true }).select('term').lean();
  const terms = docs.map((d) => normalizeForMatch(d.term)).filter(Boolean);
  cache = { terms, at: Date.now() };
  return terms;
}

// Invalidate the in-process term cache (called by block-list CRUD endpoints).
export function invalidateBlockListCache(): void {
  cache = null;
}

// Substring match (intentional — slurs often appear as substrings) against the
// normalised active block list. Returns true if the comment should be held.
export async function isBlocked(bodyText: string): Promise<boolean> {
  const terms = await getActiveTerms();
  if (!terms.length) return false;
  const haystack = normalizeForMatch(bodyText);
  return terms.some((term) => haystack.includes(term));
}
