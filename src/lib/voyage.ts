// Voyage AI embeddings — the retrieval half of the Claude migration.
//
// Anthropic ships no embeddings endpoint and points at Voyage, so this replaces
// `lib/gemini.ts`'s `embed()` and nothing else. The surface is deliberately the
// same shape (`embed(texts, inputType)` + `EMBED_DIM`) so `articleEmbeddings.ts`
// changes one import rather than its logic.
//
// There is no official Node SDK, so this is a direct HTTP call.

const API_KEY = process.env.VOYAGE_API_KEY;
const EMBED_MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-4';
export const EMBED_DIM = Number(process.env.VOYAGE_EMBED_DIM) || 1024;

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';

if (!API_KEY) {
  // Warn at boot rather than failing every retrieval with an opaque 500 — the
  // same contract lib/gemini.ts has.
  console.warn('[voyage] VOYAGE_API_KEY is not set — embeddings & retrieval will fail.');
}

// Voyage's asymmetric equivalents of Gemini's RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY.
// Stored chunks are 'document'; the user's question is 'query'. Embedding both
// sides the same way measurably degrades retrieval, so this is not cosmetic.
export type EmbedInputType = 'document' | 'query';

// Batch bounds. The API caps inputs per request and total tokens per request;
// the defaults sit well under both so a backfill never trips a 400 it could have
// avoided. Chunks are ~800 tokens, so 64 of them is ~51k tokens.
//
// Both are env-tunable because an account without a payment method is held to a
// far tighter tokens-per-minute ceiling than the per-request one — on that plan
// a 51k-token request can never succeed, at any retry count, and the batch has
// to be small enough to fit inside the rate limit itself.
const MAX_INPUTS_PER_REQUEST = Number(process.env.VOYAGE_MAX_INPUTS_PER_REQUEST) || 64;
const MAX_ESTIMATED_TOKENS_PER_REQUEST =
  Number(process.env.VOYAGE_MAX_TOKENS_PER_REQUEST) || 60_000;

// Optional client-side pacing, off by default (0 = unlimited). Set these when
// running a bulk backfill against a rate-limited account: pacing turns a run
// that would fail every batch into one that is merely slow. On the request path
// they stay unset — a single chat query is one small request.
const MAX_REQUESTS_PER_MINUTE = Number(process.env.VOYAGE_MAX_RPM) || 0;
const MAX_TOKENS_PER_MINUTE = Number(process.env.VOYAGE_MAX_TPM) || 0;
// Rough chars-per-token for English prose. Only used to split batches, so an
// imprecise estimate costs an extra request, never a failure.
const CHARS_PER_TOKEN = 4;

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
// A 429 is a per-minute quota, so retrying in half a second just burns an
// attempt inside the same window. Wait out the window instead.
const RATE_LIMIT_BACKOFF_MS = 62_000;

interface VoyageResponse {
  data?: { index: number; embedding: number[] }[];
  usage?: { total_tokens: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A sliding-window pacer over the last 60 seconds. Only active when the limits
// are configured; otherwise every call is a no-op. Requests are serialised by
// `embed`, so a plain array needs no locking.
const recentRequests: { at: number; tokens: number }[] = [];

async function awaitRateLimit(estimatedTokens: number): Promise<void> {
  if (MAX_REQUESTS_PER_MINUTE <= 0 && MAX_TOKENS_PER_MINUTE <= 0) return;

  // Loop rather than sleeping once: after waiting, the window has moved and the
  // next request may still not fit.
  for (;;) {
    const cutoff = Date.now() - 60_000;
    while (recentRequests.length > 0 && recentRequests[0].at <= cutoff) recentRequests.shift();

    const usedRequests = recentRequests.length;
    const usedTokens = recentRequests.reduce((sum, r) => sum + r.tokens, 0);

    const overRequests =
      MAX_REQUESTS_PER_MINUTE > 0 && usedRequests + 1 > MAX_REQUESTS_PER_MINUTE;
    const overTokens =
      MAX_TOKENS_PER_MINUTE > 0 && usedTokens + estimatedTokens > MAX_TOKENS_PER_MINUTE;
    if (!overRequests && !overTokens) break;

    // Wait until the oldest entry falls out of the window (plus a small margin
    // for clock skew against the server's own accounting).
    const oldest = recentRequests[0];
    if (!oldest) break; // window empty but still over: one request exceeds the cap outright
    await sleep(Math.max(1_000, oldest.at + 60_000 - Date.now() + 250));
  }

  recentRequests.push({ at: Date.now(), tokens: estimatedTokens });
}

function estimateTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / CHARS_PER_TOKEN), 0);
}

// Split by input count AND estimated tokens — a handful of very long chunks can
// blow the token ceiling well before the count ceiling.
function batchTexts(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;

  for (const text of texts) {
    const estimated = Math.ceil(text.length / CHARS_PER_TOKEN);
    const wouldOverflow =
      current.length >= MAX_INPUTS_PER_REQUEST ||
      (current.length > 0 && currentTokens + estimated > MAX_ESTIMATED_TOKENS_PER_REQUEST);
    if (wouldOverflow) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += estimated;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function embedBatch(texts: string[], inputType: EmbedInputType): Promise<number[][]> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await awaitRateLimit(estimateTokens(texts));
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: EMBED_MODEL,
          input_type: inputType,
          output_dimension: EMBED_DIM,
        }),
      });
    } catch (err) {
      // Network-level failure — worth retrying.
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }

    if (res.ok) {
      const body = (await res.json()) as VoyageResponse;
      const rows = body.data ?? [];
      if (rows.length !== texts.length) {
        throw new Error(`[voyage] expected ${texts.length} embeddings, got ${rows.length}`);
      }
      // Sort by `index` rather than trusting response order. It has been in
      // order every time observed, but retrieval silently returning the wrong
      // article's vector is not a failure mode worth leaving to convention.
      return [...rows]
        .sort((a, b) => a.index - b.index)
        .map((row) => normalizeIfNeeded(row.embedding));
    }

    // 429 and 5xx are transient; 4xx otherwise is a bad request that will fail
    // identically on retry, so fail fast and loudly.
    const retryable = res.status === 429 || res.status >= 500;
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    lastError = new Error(`[voyage] ${res.status} ${res.statusText}: ${detail}`);
    if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

    // Honour Retry-After when the server sends one. Otherwise a 429 waits out
    // the rate-limit window and a 5xx backs off exponentially.
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : res.status === 429
        ? RATE_LIMIT_BACKOFF_MS
        : BASE_BACKOFF_MS * 2 ** (attempt - 1);
    await sleep(waitMs);
  }

  throw lastError ?? new Error('[voyage] embedding failed');
}

// Returns one vector per input, in input order. Batches internally, so callers
// may pass an entire article's chunks without thinking about request limits.
export async function embed(
  texts: string[],
  inputType: EmbedInputType = 'document',
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (const batch of batchTexts(texts)) {
    out.push(...(await embedBatch(batch, inputType)));
  }
  return out;
}

// Voyage returns unit-length vectors, so this is a no-op today. Kept because
// cosine search silently returns subtly wrong rankings on non-normalised input
// rather than erroring, and a future dimension or model change could reintroduce
// that. Cheap insurance against a failure that would be very hard to spot.
function normalizeIfNeeded(values: number[]): number[] {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return values;
  return values.map((v) => v / norm);
}

// Exported for tests only.
export const __testing = { batchTexts, normalizeIfNeeded, MAX_INPUTS_PER_REQUEST };
