import mongoose, { Schema, Model } from 'mongoose';

const ROLES = ['user', 'assistant'] as const;

// A single turn in a persisted (premium) Conversation. `model` records the
// resolved provider model id for assistant turns (Phase 3). Ordered by createdAt.
// NOTE: intentionally does NOT extend mongoose's `Document` — that interface
// reserves a `.model` method which would clash with our `model` field. We read
// these docs via `.lean()`, so the hydrated-document methods aren't needed.
export interface ChatMessageDoc {
  conversationId: mongoose.Types.ObjectId;
  role: (typeof ROLES)[number];
  content: string;
  model?: string;
  // Monotonic per-conversation insertion index (user turn before its assistant
  // reply). The authoritative ordering key — immune to createdAt collisions when
  // a turn's pair is written in the same millisecond. Optional: legacy rows
  // written before this field existed have no `seq` and fall back to createdAt/_id.
  seq?: number;
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<ChatMessageDoc>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    role: { type: String, enum: ROLES, required: true },
    content: { type: String, required: true },
    model: { type: String },
    seq: { type: Number },
  },
  { timestamps: true },
);

// Fetch a thread's messages in order (seq primary, createdAt for legacy rows).
ChatMessageSchema.index({ conversationId: 1, seq: 1, createdAt: 1 });

const ChatMessage: Model<ChatMessageDoc> =
  mongoose.models.ChatMessage || mongoose.model<ChatMessageDoc>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
