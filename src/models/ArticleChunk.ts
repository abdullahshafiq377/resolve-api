import mongoose, { Schema, Document, Model } from 'mongoose';

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
