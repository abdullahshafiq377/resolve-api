import mongoose, { Schema, Document, Model } from 'mongoose';

export const COMMENT_BAN_TIERS = ['24h', '7d', '30d', 'permanent'] as const;
export type CommentBanTier = (typeof COMMENT_BAN_TIERS)[number];

export interface CommentBanDoc extends Document {
  // Clerk user ID of the banned user.
  userId: string;
  tier: CommentBanTier;
  reason: string | null;
  // Clerk user ID of the issuing moderator.
  issuedBy: string;
  issuedAt: Date;
  // null for permanent bans.
  activeUntil: Date | null;
  liftedAt: Date | null;
  liftedBy: string | null;
  // Maintained by the sweeper + lift endpoint. The hot-path check also tests
  // activeUntil > now directly so an unswept-but-expired ban never blocks.
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CommentBanSchema = new Schema<CommentBanDoc>(
  {
    userId: { type: String, required: true, trim: true },
    tier: { type: String, enum: COMMENT_BAN_TIERS, required: true },
    reason: { type: String, default: null, maxlength: 500 },
    issuedBy: { type: String, required: true, trim: true },
    issuedAt: { type: Date, required: true, default: () => new Date() },
    activeUntil: { type: Date, default: null },
    liftedAt: { type: Date, default: null },
    liftedBy: { type: String, default: null },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
);

// Active-ban hot path.
CommentBanSchema.index({ userId: 1, isActive: 1 });
// User ban history (newest first).
CommentBanSchema.index({ userId: 1, issuedAt: -1 });

const CommentBan: Model<CommentBanDoc> =
  mongoose.models.CommentBan || mongoose.model<CommentBanDoc>('CommentBan', CommentBanSchema);

export default CommentBan;
