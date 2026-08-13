import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/**
 * What a signed-in reader has read, one row per (reader, article) — re-reading
 * an article moves its existing row up rather than appending a duplicate, which
 * is what the account Activity panel wants to show ("Why the rupee is under
 * pressure again · Today").
 *
 * Written by the article page on view (POST /api/account/reading-history), and
 * only for readers who can actually see the article: a locked/paywalled view is
 * not a read. Anonymous readers keep the localStorage last-read trail instead
 * (webapp lib/reading-history.ts) — nothing is stored server-side for them.
 */
export interface ReadingHistoryDoc extends Document {
  clerkUserId: string;
  articleId: Types.ObjectId;
  // Most recent read. The list is sorted on this, not on createdAt.
  lastReadAt: Date;
  // How many separate views have been recorded, for future "re-read" surfaces.
  readCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ReadingHistorySchema = new Schema<ReadingHistoryDoc>(
  {
    clerkUserId: { type: String, required: true, trim: true },
    articleId: { type: Schema.Types.ObjectId, ref: 'Article', required: true },
    lastReadAt: { type: Date, default: Date.now },
    readCount: { type: Number, default: 1 },
  },
  { timestamps: true },
);

// One row per reader per article, and the list query: most recently read first.
ReadingHistorySchema.index({ clerkUserId: 1, articleId: 1 }, { unique: true });
ReadingHistorySchema.index({ clerkUserId: 1, lastReadAt: -1 });

const ReadingHistory: Model<ReadingHistoryDoc> =
  mongoose.models.ReadingHistory ||
  mongoose.model<ReadingHistoryDoc>('ReadingHistory', ReadingHistorySchema);

export default ReadingHistory;
