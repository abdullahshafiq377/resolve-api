import mongoose, { Schema, Document, Model } from 'mongoose';

// Per-user rolling-window counter for the free-tier 4-messages limit (overview §3).
// ONE row per user. The window is anchored at the user's *first* message
// (`windowStartedAt`) and lasts 24h — it does NOT reset on a shared calendar
// boundary, so every free user gets their own independent clock. `count` is
// incremented only on a successfully completed POST /api/chat (invariant 1);
// premium users are never counted. When `now - windowStartedAt >= 24h` the
// window is treated as expired and the next message starts a fresh one.
//
// Stored in a dedicated collection (`chat_usage_windows`) so it never collides
// with the legacy per-UTC-day `chatusages` collection / its compound unique
// index — no migration required to switch over.
export interface ChatUsageDoc extends Document {
  clerkUserId: string;
  windowStartedAt: Date;
  count: number;
  createdAt: Date;
  updatedAt: Date;
}

const ChatUsageSchema = new Schema<ChatUsageDoc>(
  {
    clerkUserId: { type: String, required: true, unique: true },
    windowStartedAt: { type: Date, required: true },
    count: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const ChatUsage: Model<ChatUsageDoc> =
  mongoose.models.ChatUsage ||
  mongoose.model<ChatUsageDoc>('ChatUsage', ChatUsageSchema, 'chat_usage_windows');

export default ChatUsage;
