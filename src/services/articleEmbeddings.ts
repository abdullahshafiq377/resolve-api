import crypto from 'crypto';
import mongoose from 'mongoose';
import type { ArticleDoc } from '../models/Article';
import Article from '../models/Article';
import ArticleChunk from '../models/ArticleChunk';
import { embed } from '../lib/gemini';
import { extractGatedPlainText, chunkText } from '../lib/articleText';
import { tierAtLeast, type PlanTier } from '../middleware/auth';

// Name of the Atlas Vector Search index on ArticleChunk.embedding.
export const VECTOR_INDEX = 'article_chunks_vector';

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
  article: Pick<ArticleDoc, '_id' | 'slug' | 'body' | 'bodyHash' | 'gateTier'>,
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
      return; // prose, gate position and gate tier all unchanged — nothing to do
    }

    const parts: { text: string; requiredTier: PlanTier }[] = [
      ...chunkText(pre).map((text) => ({ text, requiredTier: 'free' as PlanTier })),
      ...chunkText(post).map((text) => ({ text, requiredTier: (gateTier ?? 'free') as PlanTier })),
    ];
    const vectors = await embed(parts.map((p) => p.text), 'RETRIEVAL_DOCUMENT');

    // Upsert each chunk in place (no delete-then-insert gap).
    const ops = parts.map((part, i) => ({
      updateOne: {
        filter: { articleId, chunkIndex: i },
        update: {
          $set: {
            slug: article.slug,
            text: part.text,
            embedding: vectors[i],
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
  const [queryVector] = await embed([query], 'RETRIEVAL_QUERY');
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
        path: 'embedding',
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
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);

  return rows.map((r: { text: string; slug: string; articleId: mongoose.Types.ObjectId; score: number }) => ({
    text: r.text,
    slug: r.slug,
    articleId: String(r.articleId),
    score: r.score,
  }));
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
        path: 'embedding',
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
// second Gemini call. Degrades to `{ passages: [], lockedHits: [] }` on failure,
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
