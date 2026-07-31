import crypto from 'crypto';
import mongoose from 'mongoose';
import type { ArticleDoc } from '../models/Article';
import Article from '../models/Article';
import ArticleChunk from '../models/ArticleChunk';
import { embed } from '../lib/gemini';
import { embed as embedVoyage } from '../lib/voyage';
import { extractGatedPlainText, chunkText } from '../lib/articleText';
import { tierAtLeast, type PlanTier } from '../middleware/auth';

// Name of the Atlas Vector Search index serving retrieval.
//
// Flipped to the Voyage index on 30 July 2026 (migration plan W4, cutover step
// 4) after the backfill covered all 95 chunks and a side-by-side comparison put
// the same article at #1 on 8/8 representative queries. The Gemini index and
// `embedding` field still exist and are still dual-written, so reverting is a
// two-line change back to the v1 constants below.
export const VECTOR_INDEX = 'article_chunks_vector_v2';

// Document path the index is built on. Kept beside VECTOR_INDEX because the two
// must always move together: there are three consumers (searchChunks,
// probeLockedHits, scripts/createVectorIndex.ts), and changing the index without
// changing the path — or updating only one query site — fails silently rather
// than loudly. Retrieval would keep working while the gate-notice probe queried
// the wrong vectors. See FINDINGS AI2.
export const VECTOR_PATH = 'embeddingV2';

// The two indexes, named explicitly. Both exist at once because Atlas treats
// `numDimensions` as immutable, so Gemini's 768 and Voyage's 1024 cannot share
// one. VECTOR_INDEX / VECTOR_PATH above are what retrieval actually reads and
// now point at v2; these named constants are what `createVectorIndex.ts` builds
// and what a rollback would point back at. They are kept until cutover step 6
// drops the Gemini column and index for good.
// True when Atlas is telling us the index already exists, so the caller should
// update its definition in place instead of failing.
//
// This lives here, and is tested, because getting it wrong is invisible: the
// create call throws, the script exits non-zero, and the *existing* index keeps
// whatever stale definition it had. That is exactly how the live index kept a
// pre-gating definition for months (FINDINGS AI7) — the wording Atlas actually
// uses is "already defined", not "already exists".
export function isIndexAlreadyExistsError(message: string): boolean {
  // `IndexAlreadyExists` (no separator) is MongoDB's own codeName and shows up
  // in some driver messages, so it is matched separately from the prose forms.
  return /already ?exists|already defined|Duplicate Index/i.test(message);
}

export const VECTOR_INDEX_V1 = 'article_chunks_vector';
export const VECTOR_PATH_V1 = 'embedding';
export const VECTOR_INDEX_V2 = 'article_chunks_vector_v2';
export const VECTOR_PATH_V2 = 'embeddingV2';

const TIER_ORDER: PlanTier[] = ['free', 'standard', 'premium'];

// Tiers whose chunks `tier` may retrieve, for the Atlas `$in` filter.
export function allowedTiersFor(tier: PlanTier): PlanTier[] {
  return TIER_ORDER.filter((candidate) => tierAtLeast(tier, candidate));
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Rebuild one published article's chunks + embeddings. Idempotent.
//
// - Skips entirely when the body's plain text is unchanged (bodyHash), so
//   metadata-only edits / re-saves don't burn Gemini calls.
// - Upserts by (articleId, chunkIndex) and deletes only now-surplus higher
//   indices, so the old vectors keep serving until the new ones are written
//   (no "search gap" where the article silently drops out of retrieval).
//
// Cost scales with edits, never with corpus size. Safe to call fire-and-forget;
// it never throws — failures are logged so an article save is never blocked by Gemini.
export async function syncArticleEmbeddings(
  article: Pick<ArticleDoc, '_id' | 'slug' | 'body' | 'bodyHash' | 'gateTier' | 'title' | 'publishDate'>,
): Promise<void> {
  try {
    const articleId = article._id as mongoose.Types.ObjectId;
    const gateTier = article.gateTier ?? null;

    // Chunk each side of the gate independently. Chunking the joined text and
    // splitting afterwards would let a single ~800-token chunk straddle the gate,
    // and that chunk would have to be tagged with one tier or the other — either
    // leaking gated prose to free readers or hiding public prose from them.
    const { pre, post } = extractGatedPlainText(article.body, gateTier);

    if (!pre && !post) {
      // Published but no extractable prose — ensure no stale chunks linger.
      await purgeArticleChunks(articleId);
      await Article.updateOne({ _id: articleId }, { $unset: { bodyHash: 1 } });
      return;
    }

    // The hash covers the gate position and tier, not just the prose: moving the
    // gate or changing the tier leaves the text identical but must still re-tag
    // every chunk, so hashing text alone would silently skip the resync.
    const nextHash = hashText(JSON.stringify({ pre, post, gateTier }));
    if (article.bodyHash && article.bodyHash === nextHash) {
      // Prose, gate position and gate tier are unchanged, so the vectors are
      // still valid — but the title or publish date may have been edited, and
      // those are denormalised onto every chunk. Refresh them directly rather
      // than folding them into the hash: hashing them would re-embed the whole
      // article on a typo fix in the headline, which is pure cost for no
      // retrieval benefit.
      await refreshChunkMetadata(articleId, article.title, article.publishDate ?? null);
      return;
    }

    const parts: { text: string; requiredTier: PlanTier }[] = [
      ...chunkText(pre).map((text) => ({ text, requiredTier: 'free' as PlanTier })),
      ...chunkText(post).map((text) => ({ text, requiredTier: (gateTier ?? 'free') as PlanTier })),
    ];
    const texts = parts.map((p) => p.text);
    const vectors = await embed(texts, 'RETRIEVAL_DOCUMENT');

    // Dual-write during the cutover (migration plan W4, step 3): articles
    // published or edited mid-migration must land in BOTH indexes, or they are
    // invisible to whichever one is not yet serving reads.
    //
    // A Voyage failure must not take the live path down with it. `embedding` is
    // what serves every read until the flip, so a failure here degrades the
    // not-yet-live index only — the article still publishes and still retrieves.
    // The gap it leaves is closed by re-running the backfill, which is
    // idempotent and skips chunks that already have a v2 vector.
    let vectorsV2: number[][] | null = null;
    try {
      vectorsV2 = await embedVoyage(texts, 'document');
    } catch (err) {
      console.error(
        '[embeddings] voyage dual-write failed for article',
        String(articleId),
        (err as Error).message,
        '— gemini vectors written; re-run backfill:embeddings to fill the gap',
      );
    }

    // Upsert each chunk in place (no delete-then-insert gap).
    const ops = parts.map((part, i) => ({
      updateOne: {
        filter: { articleId, chunkIndex: i },
        update: {
          $set: {
            slug: article.slug,
            title: article.title,
            publishDate: article.publishDate ?? null,
            text: part.text,
            embedding: vectors[i],
            ...(vectorsV2 ? { embeddingV2: vectorsV2[i] } : {}),
            requiredTier: part.requiredTier,
          },
        },
        upsert: true,
      },
    }));
    if (ops.length > 0) await ArticleChunk.bulkWrite(ops);

    // Drop any chunks left over from a previously-longer body.
    await ArticleChunk.deleteMany({ articleId, chunkIndex: { $gte: parts.length } });

    // Record the hash so the next unchanged save is a no-op.
    await Article.updateOne({ _id: articleId }, { $set: { bodyHash: nextHash } });
  } catch (err) {
    console.error('[embeddings] sync failed for article', String(article._id), (err as Error).message);
  }
}

// Keep the denormalised title/publishDate on an article's chunks in step with
// the article, without touching its vectors. Cheap enough to run on every
// unchanged-body save. Never throws — stale attribution metadata is not worth
// failing a publish over.
async function refreshChunkMetadata(
  articleId: mongoose.Types.ObjectId,
  title: string,
  publishDate: Date | null,
): Promise<void> {
  try {
    await ArticleChunk.updateMany(
      // Only write when something actually differs, so the common case (no
      // metadata change) costs a query and no writes.
      {
        articleId,
        $or: [{ title: { $ne: title } }, { publishDate: { $ne: publishDate } }],
      },
      { $set: { title, publishDate } },
    );
  } catch (err) {
    console.error(
      '[embeddings] metadata refresh failed for article',
      String(articleId),
      (err as Error).message,
    );
  }
}

// Remove all chunks for an article (unpublish / delete). Never throws.
export async function purgeArticleChunks(
  articleId: mongoose.Types.ObjectId | string,
): Promise<void> {
  try {
    await ArticleChunk.deleteMany({ articleId });
    await Article.updateOne({ _id: articleId }, { $unset: { bodyHash: 1 } });
  } catch (err) {
    console.error('[embeddings] purge failed for article', String(articleId), (err as Error).message);
  }
}

export interface RetrievedPassage {
  text: string;
  slug: string;
  articleId: string;
  score: number;
  // Denormalised from Article. Optional because chunks written before the Phase 2
  // backfill have neither, and retrieval must not break on those — the prompt
  // builder omits the attribution line rather than printing "undefined".
  title?: string;
  publishDate?: Date | null;
}

// A gated article that outranked most of what the reader *can* see. Carries only
// public metadata — never chunk text. See probeLockedHits.
export interface LockedHit {
  articleId: string;
  slug: string;
  title: string;
  requiredTier: PlanTier;
}

// How far down the unfiltered ranking a gated article still counts as "what the
// reader is actually asking about". Kept tight: an upsell for an article that
// merely ranked 9th reads as spam, and this is the whole relevance guard — a
// locked row outside this window is never surfaced.
const GATE_NOTICE_TOP_N = 3;

async function embedQuery(query: string): Promise<number[] | null> {
  // Must match whatever VECTOR_PATH points at: a 768d Gemini vector against the
  // 1024d Voyage index is a hard failure, and querying the right index with the
  // wrong *task type* is a soft one — it retrieves, just worse.
  const [queryVector] = await embedVoyage([query], 'query');
  return queryVector ?? null;
}

async function searchChunks(
  queryVector: number[],
  opts: { k: number; tier: PlanTier; articleId?: mongoose.Types.ObjectId | string },
): Promise<RetrievedPassage[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conds: any[] = [{ requiredTier: { $in: allowedTiersFor(opts.tier) } }];
  if (opts.articleId) {
    conds.push({
      articleId:
        typeof opts.articleId === 'string' ? new mongoose.Types.ObjectId(opts.articleId) : opts.articleId,
    });
  }

  const rows = await ArticleChunk.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: VECTOR_PATH,
        queryVector,
        numCandidates: Math.max(100, opts.k * 15),
        limit: opts.k,
        filter: conds.length === 1 ? conds[0] : { $and: conds },
      },
    } as mongoose.PipelineStage,
    {
      $project: {
        _id: 0,
        text: 1,
        slug: 1,
        articleId: 1,
        title: 1,
        publishDate: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);

  return rows.map(
    (r: {
      text: string;
      slug: string;
      articleId: mongoose.Types.ObjectId;
      score: number;
      title?: string;
      publishDate?: Date | null;
    }) => ({
      text: r.text,
      slug: r.slug,
      articleId: String(r.articleId),
      score: r.score,
      title: r.title,
      publishDate: r.publishDate ?? null,
    }),
  );
}

// Which gated articles would have answered this query, without reading a word of
// them. Runs the search UNFILTERED so gated chunks can match, then projects only
// ids and tiers.
//
// The $project here is a security boundary, not a performance tweak: `text` must
// never appear in it. Titles and slugs are safe to name — they are already on
// every card — but the prose behind the gate must not leave the database on this
// path. Anything that needs chunk text goes through searchChunks, which filters.
async function probeLockedHits(queryVector: number[], tier: PlanTier): Promise<LockedHit[]> {
  // Top-tier readers can reach every chunk, so nothing could come back locked —
  // skip the aggregation rather than run it to prove the empty set.
  if (allowedTiersFor(tier).length === TIER_ORDER.length) return [];

  const rows: { articleId: mongoose.Types.ObjectId; requiredTier: PlanTier }[] = await ArticleChunk.aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX,
        path: VECTOR_PATH,
        queryVector,
        numCandidates: Math.max(100, GATE_NOTICE_TOP_N * 15),
        limit: GATE_NOTICE_TOP_N,
      },
    } as mongoose.PipelineStage,
    { $project: { _id: 0, articleId: 1, requiredTier: 1 } },
  ]);

  const lockedIds = [
    ...new Set(
      rows
        .filter((r) => !tierAtLeast(tier, r.requiredTier))
        .map((r) => String(r.articleId)),
    ),
  ];
  if (lockedIds.length === 0) return [];

  const articles = await Article.find({ _id: { $in: lockedIds }, status: 'published' }).select(
    'title slug gateTier',
  );
  return articles.map((a) => ({
    articleId: String(a._id),
    slug: a.slug,
    title: a.title,
    requiredTier: (a.gateTier ?? 'premium') as PlanTier,
  }));
}

// RAG retrieval (Phase 2). Embeds the query and runs Atlas `$vectorSearch` over
// ArticleChunk, filtered to the chunks `tier` is allowed to see. Optionally
// narrowed to a single article. Returns [] and logs if the index is
// missing/unbuilt, so chat degrades gracefully to general knowledge rather than
// erroring.
//
// `tier` is required and un-defaulted on purpose: a default would decide, at a
// distance, how much of the paywalled corpus a caller sees. Passing it is the
// caller's way of saying whose eyes these passages are for.
export async function retrieveChunks(
  query: string,
  opts: { k?: number; tier: PlanTier; articleId?: mongoose.Types.ObjectId | string },
): Promise<RetrievedPassage[]> {
  const k = opts.k ?? 6;
  try {
    const queryVector = await embedQuery(query);
    if (!queryVector) return [];
    return await searchChunks(queryVector, { k, tier: opts.tier, articleId: opts.articleId });
  } catch (err) {
    console.error('[embeddings] retrieval failed (is the Atlas vector index built?):', (err as Error).message);
    return [];
  }
}

// Retrieval for a chat turn: the passages the reader may see, plus any gated
// article that outranked them.
//
// Both halves share one embedding — the probe is a second aggregation, not a
// second embedding call. Degrades to `{ passages: [], lockedHits: [] }` on failure,
// same as retrieveChunks: a broken index must not take chat down, and must
// certainly not fall back to unfiltered results.
export async function retrieveForTier(
  query: string,
  opts: { k?: number; tier: PlanTier },
): Promise<{ passages: RetrievedPassage[]; lockedHits: LockedHit[] }> {
  const k = opts.k ?? 6;
  try {
    const queryVector = await embedQuery(query);
    if (!queryVector) return { passages: [], lockedHits: [] };

    const [passages, lockedHits] = await Promise.all([
      searchChunks(queryVector, { k, tier: opts.tier }),
      probeLockedHits(queryVector, opts.tier),
    ]);
    return { passages, lockedHits };
  } catch (err) {
    console.error('[embeddings] retrieval failed (is the Atlas vector index built?):', (err as Error).message);
    return { passages: [], lockedHits: [] };
  }
}
