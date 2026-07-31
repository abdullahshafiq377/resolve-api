import BlockedKeyword, { type BlockedKeywordMatchMode } from '../../models/BlockedKeyword';

// Block-list matching (comments-voting-reporting-moderation.md §4.3).
//
// Previously this normalised the comment and each term to a letters-only skeleton
// and did a substring test. That deletes symbols, which is right when a symbol
// *separates* two real letters (`f.u.c.k`) but wrong when it *replaces* a missing
// one (`f*ck` collapsed to `fck` and published). A single skeleton cannot represent
// both readings at once, and mixed input like `f*c*k` — first star a stand-in for
// `u`, second star a separator — defeats any fixed choice between them.
//
// So each term is compiled once into a regex instead, and the engine decides per
// position whether a symbol is a separator or a stand-in. See §"Matching rules".

// ---------------------------------------------------------------------------
// Matching rules
// ---------------------------------------------------------------------------
//
// For a term `fuck` the compiled pattern is roughly:
//
//   (?<![\p{L}\p{N}]) (?:[f]+|CENSOR) SEP (?:[uv]+|CENSOR) SEP
//                     (?:[ck]+|CENSOR) SEP (?:[ck]+|CENSOR) (?![\p{L}\p{N}])
//
//   SEP    — up to 2 separator characters between letters (`f.u.c.k`, `f*u*c*k`)
//   CENSOR — exactly one symbol standing in for exactly one letter (`f*ck`, `f***`)
//   `+`    — repeated-letter stretching (`fuuuck`) without mutating the text
//
// Keeping CENSOR at one-symbol-per-letter is deliberate: it couples symbol count
// to letter count, so `f***` (4 positions) matches `fuck` (4 letters) while `f*k`
// (3) does not — consistent with dropped-letter forms like `fuk` being out of
// scope. Letting one symbol run stand for 1..n letters would make `****` match
// every short term on the list, and `...` / `!!!` are ordinary comment text.
//
// Deliberately NOT handled: letters dropped with no symbol left behind (`fuk`,
// `phuck`). Edit-distance on 3-4 letter words matches far too much that is
// innocent (`cant`~`cunt`, `shot`~`shit`, `bus`~`kus`). Those forms are covered by
// putting them on the list as terms of their own, which moderators can already do.

// Visual / leet equivalents, applied per letter of the term rather than as a
// global rewrite of the comment. A global `0`->`o`, `1`->`l` pass (what this used
// to do) also mangles ordinary text — `1984` became `l984` before matching.
const LETTER_CLASS: Record<string, string> = {
  a: 'a@4',
  b: 'b8',
  c: 'ck',
  e: 'e3',
  g: 'g69',
  i: 'i1!|l',
  k: 'kc',
  l: 'l1|i',
  o: 'o0',
  s: 's$5z',
  t: 't7',
  u: 'uv',
  z: 'z2s',
};

// One symbol standing in for one letter.
const CENSOR = '[*#@$!%.\\-_+~^]';
// Separator characters permitted between two letters of a term.
const SEP_CHARS = '._*\\-+#\'"~^';

// Whitespace only counts as a separator for terms of 4+ characters. For a
// 3-letter term it opens up ordinary prose — `kus` would otherwise be one
// boundary check away from matching "…k us s…".
const MIN_LENGTH_FOR_SPACE_SEPARATOR = 4;

// Word mode anchors both edges, but a trailing inflection is not an evasion and
// should still be held: `fucking`, `f***ing`, `bitches`, `shitty`. Allowing an
// arbitrary suffix would just be substring mode again, so the set is closed —
// `shiitake` is still not `shit`, because `ake` is not in it.
const SUFFIX = "(?:ing|in|ings|ed|er|ers|es|s|y|ies)?";

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// NFKC + lowercase + strip combining diacritics (`fück` -> `fuck`). Symbols are
// preserved — the pattern, not this function, decides what they mean.
export function normalizeForMatch(input: string): string {
  const s = input.normalize('NFKC').toLowerCase();
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface CompiledTerm {
  term: string;
  pattern: RegExp;
  // Minimum number of real (non-censor) characters the match must contain.
  minRealChars: number;
}

export function compileTerm(rawTerm: string, mode: BlockedKeywordMatchMode = 'word'): CompiledTerm | null {
  const term = normalizeForMatch(rawTerm).trim();
  if (!term) return null;

  const allowSpaceSeparator = term.length >= MIN_LENGTH_FOR_SPACE_SEPARATOR;
  const sep = `[${SEP_CHARS}${allowSpaceSeparator ? '\\s' : ''}]{0,2}`;

  const parts: string[] = [];
  const chars = [...term];
  chars.forEach((ch, index) => {
    if (index > 0 && !/\s/.test(ch) && !/\s/.test(chars[index - 1])) parts.push(sep);
    if (/\s/.test(ch)) {
      // Multi-word terms: require real whitespace, never a censor character.
      parts.push('\\s+');
      return;
    }
    if (/[\p{L}\p{N}]/u.test(ch)) {
      const cls = LETTER_CLASS[ch] ?? ch;
      parts.push(`(?:[${cls.replace(/[[\]\\^-]/g, '\\$&')}]+|${CENSOR})`);
      return;
    }
    parts.push(escapeRegex(ch));
  });

  const body = parts.join('');
  const source =
    mode === 'substring'
      ? body
      : `(?<![\\p{L}\\p{N}])${body}${SUFFIX}(?![\\p{L}\\p{N}])`;

  // A run of pure punctuation must never match. `f***` keeps one real letter and
  // is held; `****` and `...` have none and are not. Short terms need more than
  // that — `k**` should not match `kus` — so they must be all-but-one real.
  const letterCount = chars.filter((ch) => /[\p{L}\p{N}]/u.test(ch)).length;
  const minRealChars = letterCount <= 3 ? Math.max(1, letterCount - 1) : 1;

  return { term, pattern: new RegExp(source, 'u'), minRealChars };
}

function countRealChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

// Test a single term against already-normalised text. Exported for tests.
export function matchesTerm(normalizedText: string, compiled: CompiledTerm): boolean {
  const found = compiled.pattern.exec(normalizedText);
  if (!found) return false;
  return countRealChars(found[0]) >= compiled.minRealChars;
}

let cache: { terms: CompiledTerm[]; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function getActiveTerms(): Promise<CompiledTerm[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.terms;
  const docs = await BlockedKeyword.find({ isActive: true }).select('term matchMode').lean();
  // Compiled once per cache fill, never per request.
  const terms = docs
    .map((d) => compileTerm(d.term, (d.matchMode as BlockedKeywordMatchMode) ?? 'word'))
    .filter((t): t is CompiledTerm => t !== null);
  cache = { terms, at: Date.now() };
  return terms;
}

// Invalidate the in-process term cache (called by block-list CRUD endpoints).
export function invalidateBlockListCache(): void {
  cache = null;
}

// Returns true if the comment should be held. The matched term is deliberately
// not returned — callers must not be able to leak it to the author.
export async function isBlocked(bodyText: string): Promise<boolean> {
  const terms = await getActiveTerms();
  if (!terms.length) return false;
  const haystack = normalizeForMatch(bodyText);
  return terms.some((compiled) => matchesTerm(haystack, compiled));
}
