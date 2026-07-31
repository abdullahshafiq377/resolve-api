import mongoose, { Schema, Document, Model } from 'mongoose';
import type { PlanTier } from '../middleware/auth';

const TIERS: PlanTier[] = ['free', 'standard', 'premium'];

// A ~800-token slice of a published article's plain text plus its Gemini
// embedding (Phase 2 RAG). One article -> many chunks, keyed by chunkIndex.
// Retrieval runs `$vectorSearch` over `embedding` via the Atlas index
// `article_chunks_vector` (see scripts/createVectorIndex.ts / aichatbackend.md).
// Only published articles have chunks; they are purged on unpublish/delete.
export interface ArticleChunkDoc extends Document {
  articleId: mongoose.Types.ObjectId;
  slug: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
  // Voyage vector (1024d), written alongside `embedding` during the Phase 2
  // dual-index cutover. Optional until the backfill completes and the read path
  // flips; `embedding` keeps serving every read until then. Both are dropped to
  // one field at the end of the cutover — see the migration plan's W4.
  embeddingV2?: number[];
  // Denormalised from Article so retrieval can attribute a passage and weigh how
  // old it is (directive §2 and §4) without a per-query $lookup. `slug` above is
  // the precedent. Kept fresh by syncArticleEmbeddings, which already runs on
  // every publish and edit. Optional until the backfill fills them in.
  title?: string;
  publishDate?: Date | null;
  // Minimum plan tier allowed to retrieve this chunk. 'free' for anything before
  // the article's gate (and for every chunk of an ungated article); the article's
  // gateTier for anything after it. Enforced as a `filter` field in the Atlas
  // index, so an ineligible reader's $vectorSearch can never match it — the text
  // is not merely hidden downstream, it is never read.
  requiredTier: PlanTier;
  updatedAt: Date;
  createdAt: Date;
}

const ArticleChunkSchema = new Schema<ArticleChunkDoc>(
  {
    articleId: { type: Schema.Types.ObjectId, ref: 'Article', required: true, index: true },
    slug: { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    text: { type: String, required: true },
    // Stored as a plain number[]; the Atlas vectorSearch index lives on this path.
    embedding: { type: [Number], required: true },
    embeddingV2: { type: [Number], required: false },
    title: { type: String, required: false },
    publishDate: { type: Date, required: false, default: null },
    requiredTier: { type: String, enum: TIERS, required: true, default: 'free' },
  },
  { timestamps: true },
);

// Upsert key — lets the embedding pipeline replace a chunk in place (avoiding the
// delete-then-insert "search gap") and delete only now-surplus higher indices.
ArticleChunkSchema.index({ articleId: 1, chunkIndex: 1 }, { unique: true });

const ArticleChunk: Model<ArticleChunkDoc> =
  mongoose.models.ArticleChunk ||
  mongoose.model<ArticleChunkDoc>('ArticleChunk', ArticleChunkSchema);

export default ArticleChunk;
