import mongoose, { Schema, Document, Model } from 'mongoose';

// Audit log for every moderator action on comments and commenters.
export const MODERATION_ACTION_TYPES = [
  'warning',
  'ban_24h',
  'ban_7d',
  'ban_30d',
  'ban_permanent',
  'ban_lifted',
  'comment_removed',
  'comment_approved',
  'comment_denied',
] as const;
export type ModerationActionType = (typeof MODERATION_ACTION_TYPES)[number];

export interface ModerationActionDoc extends Document {
  type: ModerationActionType;
  // Clerk user ID of the moderator who performed the action.
  actorId: string;
  // Clerk user ID of the user the action targets (recipient of warning/ban/removal).
  targetUserId: string | null;
  commentId: mongoose.Types.ObjectId | null;
  reason: string | null;
  // Type-specific payload (e.g. previous ban tier when lifted).
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const ModerationActionSchema = new Schema<ModerationActionDoc>(
  {
    type: { type: String, enum: MODERATION_ACTION_TYPES, required: true },
    actorId: { type: String, required: true, trim: true },
    targetUserId: { type: String, default: null },
    commentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    reason: { type: String, default: null, maxlength: 500 },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// Per-user history view.
ModerationActionSchema.index({ targetUserId: 1, createdAt: -1 });
// Audit views by action type.
ModerationActionSchema.index({ type: 1, createdAt: -1 });
// Per-comment audit trail.
ModerationActionSchema.index({ commentId: 1 });

const ModerationAction: Model<ModerationActionDoc> =
  mongoose.models.ModerationAction ||
  mongoose.model<ModerationActionDoc>('ModerationAction', ModerationActionSchema);

export default ModerationAction;
