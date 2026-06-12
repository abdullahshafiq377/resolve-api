import crypto from 'crypto';
import mongoose from 'mongoose';
import type { ArticleDoc } from '../models/Article';
import Article from '../models/Article';
import ArticleChunk from '../models/ArticleChunk';
import { embed } from '../lib/gemini';
import { extractPlainText, chunkText } from '../lib/articleText';

// Name of the Atlas Vector Search index on ArticleChunk.embedding.
export const VECTOR_INDEX = 'article_chunks_vector';

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
export async function syncArticleEmbeddings(article: Pick<ArticleDoc, '_id' | 'slug' | 'body' | 'bodyHash'>): Promise<void> {
  try {
    const articleId = article._id as mongoose.Types.ObjectId;
    const text = extractPlainText(article.body);

    if (!text) {
      // Published but no extractable prose — ensure no stale chunks linger.
      await purgeArticleChunks(articleId);
      await Article.updateOne({ _id: articleId }, { $unset: { bodyHash: 1 } });
      return;
    }

    const nextHash = hashText(text);
    if (article.bodyHash && article.bodyHash === nextHash) {
      return; // prose unchanged — nothing to do
    }

    const chunks = chunkText(text);
    const vectors = await embed(chunks, 'RETRIEVAL_DOCUMENT');

    // Upsert each chunk in place (no delete-then-insert gap).
    const ops = chunks.map((chunkTextValue, i) => ({
      updateOne: {
        filter: { articleId, chunkIndex: i },
        update: {
          $set: {
            slug: article.slug,
            text: chunkTextValue,
            embedding: vectors[i],
          },
        },
        upsert: true,
      },
    }));
    if (ops.length > 0) await ArticleChunk.bulkWrite(ops);

    // Drop any chunks left over from a previously-longer body.
    await ArticleChunk.deleteMany({ articleId, chunkIndex: { $gte: chunks.length } });

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

// RAG retrieval (Phase 2). Embeds the query and runs Atlas `$vectorSearch` over
// ArticleChunk. Optionally filtered to a single article (the Phase 1 long-article
// fallback). Returns [] and logs if the index is missing/unbuilt, so chat
// degrades gracefully to general knowledge rather than erroring.
export async function retrieveChunks(
  query: string,
  opts: { k?: number; articleId?: mongoose.Types.ObjectId | string } = {},
): Promise<RetrievedPassage[]> {
  const k = opts.k ?? 6;
  try {
    const [queryVector] = await embed([query], 'RETRIEVAL_QUERY');
    if (!queryVector) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorSearch: Record<string, any> = {
      index: VECTOR_INDEX,
      path: 'embedding',
      queryVector,
      numCandidates: Math.max(100, k * 15),
      limit: k,
    };
    if (opts.articleId) {
      const id =
        typeof opts.articleId === 'string'
          ? new mongoose.Types.ObjectId(opts.articleId)
          : opts.articleId;
      vectorSearch.filter = { articleId: id };
    }

    const rows = await ArticleChunk.aggregate([
      { $vectorSearch: vectorSearch } as mongoose.PipelineStage,
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
  } catch (err) {
    console.error('[embeddings] retrieval failed (is the Atlas vector index built?):', (err as Error).message);
    return [];
  }
}
