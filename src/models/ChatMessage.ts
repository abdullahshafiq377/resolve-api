import mongoose, { Schema, Model } from 'mongoose';

const ROLES = ['user', 'assistant'] as const;

// Resolve's own model names. `model` stores one of these and NEVER the provider
// model id: getConversationDetail returns this field to the client, and directive
// §7 ("white-labelling is absolute") forbids naming the underlying engine anywhere
// user-facing. Enforced by the schema enum so a provider id cannot be written back
// in by accident — the field previously held values like 'gemini-flash-latest'.
// Legacy rows are rewritten by scripts/migrateChatMessageModel.ts.
export const CHAT_MODEL_KEYS = ['velo', 'core', 'max'] as const;
export type ChatMessageModelKey = (typeof CHAT_MODEL_KEYS)[number];

// A single turn in a persisted (paid-tier) Conversation. `model` records which
// Resolve model produced an assistant turn (Phase 3). Ordered by createdAt.
// NOTE: intentionally does NOT extend mongoose's `Document` — that interface
// reserves a `.model` method which would clash with our `model` field. We read
// these docs via `.lean()`, so the hydrated-document methods aren't needed.
// A persisted chat image attachment (user turns only). Stored in S3; the doc
// keeps the durable public `url` for rendering plus the `key` for cleanup.
export interface ChatMessageImage {
  url: string;
  key: string;
  mimeType: string;
}

export interface ChatMessageDoc {
  conversationId: mongoose.Types.ObjectId;
  role: (typeof ROLES)[number];
  content: string;
  model?: ChatMessageModelKey;
  images?: ChatMessageImage[];
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
    model: { type: String, enum: CHAT_MODEL_KEYS },
    seq: { type: Number },
    images: {
      type: [
        {
          _id: false,
          url: { type: String, required: true },
          key: { type: String, required: true },
          mimeType: { type: String, required: true },
        },
      ],
      default: undefined,
    },
  },
  { timestamps: true },
);

// Fetch a thread's messages in order (seq primary, createdAt for legacy rows).
ChatMessageSchema.index({ conversationId: 1, seq: 1, createdAt: 1 });

const ChatMessage: Model<ChatMessageDoc> =
  mongoose.models.ChatMessage || mongoose.model<ChatMessageDoc>('ChatMessage', ChatMessageSchema);

export default ChatMessage;
