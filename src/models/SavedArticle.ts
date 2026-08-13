import mongoose, { Schema, Document, Model, Types } from 'mongoose';

/**
 * A reader's bookmark on an article — the "Saved articles" panel on the account
 * Activity section, and the save toggle on the article page.
 *
 * One row per (reader, article): saving twice is idempotent and un-saving
 * deletes the row, so there is no soft-delete state to reconcile. The article
 * itself is never copied here; titles and categories are joined at read time so
 * a retitled article reads correctly in an old bookmark.
 */
export interface SavedArticleDoc extends Document {
  clerkUserId: string;
  articleId: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const SavedArticleSchema = new Schema<SavedArticleDoc>(
  {
    clerkUserId: { type: String, required: true, trim: true },
    articleId: { type: Schema.Types.ObjectId, ref: 'Article', required: true },
  },
  { timestamps: true },
);

// One bookmark per reader per article, and the list query: newest saved first.
SavedArticleSchema.index({ clerkUserId: 1, articleId: 1 }, { unique: true });
SavedArticleSchema.index({ clerkUserId: 1, createdAt: -1 });

const SavedArticle: Model<SavedArticleDoc> =
  mongoose.models.SavedArticle ||
  mongoose.model<SavedArticleDoc>('SavedArticle', SavedArticleSchema);

export default SavedArticle;
