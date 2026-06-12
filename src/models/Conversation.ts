import mongoose, { Schema, Document, Model } from 'mongoose';

const SCOPES = ['article', 'resolve'] as const;

// A persisted chat thread. Premium-only (overview §3) — free users' chats are
// never written. Both scopes persist: `resolve` (Resolve AI page / header) and
// `article` (article drawer, with `articleId` set). All threads, regardless of
// origin surface, are listed on the AI Chat page history rail.
export interface ConversationDoc extends Document {
  clerkUserId: string;
  title: string;
  scope: (typeof SCOPES)[number];
  articleId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<ConversationDoc>(
  {
    clerkUserId: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    scope: { type: String, enum: SCOPES, required: true },
    articleId: { type: Schema.Types.ObjectId, ref: 'Article' },
  },
  { timestamps: true },
);

// History rail: newest-first list for one user. Also serves the article-drawer
// resume lookup (filtered by scope + articleId, newest first).
ConversationSchema.index({ clerkUserId: 1, updatedAt: -1 });

const Conversation: Model<ConversationDoc> =
  mongoose.models.Conversation ||
  mongoose.model<ConversationDoc>('Conversation', ConversationSchema);

export default Conversation;
