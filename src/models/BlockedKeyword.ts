import mongoose, { Schema, Document, Model } from 'mongoose';

export const BLOCKED_KEYWORD_LANGUAGES = ['en', 'ur', 'ps'] as const;
export type BlockedKeywordLanguage = (typeof BLOCKED_KEYWORD_LANGUAGES)[number];

export interface BlockedKeywordDoc extends Document {
  // Stored lowercased. Matching itself runs in code (normalise + substring),
  // not via Mongo regex, for predictability across Unicode input.
  term: string;
  language: BlockedKeywordLanguage;
  // Clerk user ID of the moderator who added it.
  addedBy: string;
  addedAt: Date;
  removedAt: Date | null;
  removedBy: string | null;
  reason: string | null;
  // Convenience flag: removedAt === null.
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BlockedKeywordSchema = new Schema<BlockedKeywordDoc>(
  {
    term: { type: String, required: true, trim: true, lowercase: true },
    language: { type: String, enum: BLOCKED_KEYWORD_LANGUAGES, required: true },
    addedBy: { type: String, required: true, trim: true },
    addedAt: { type: Date, required: true, default: () => new Date() },
    removedAt: { type: Date, default: null },
    removedBy: { type: String, default: null },
    reason: { type: String, default: null, maxlength: 500 },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// Active list load (the match runs over active terms in process).
BlockedKeywordSchema.index({ isActive: 1, language: 1 });
// Lookup / duplicate detection.
BlockedKeywordSchema.index({ term: 1, isActive: 1 });

const BlockedKeyword: Model<BlockedKeywordDoc> =
  mongoose.models.BlockedKeyword ||
  mongoose.model<BlockedKeywordDoc>('BlockedKeyword', BlockedKeywordSchema);

export default BlockedKeyword;
