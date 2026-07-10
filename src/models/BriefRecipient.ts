import mongoose, { Schema, Document, Model } from 'mongoose';

export const BRIEF_EMAIL_STATUSES = ['not_requested', 'pending', 'sent', 'failed', 'skipped'] as const;
export type BriefEmailStatus = (typeof BRIEF_EMAIL_STATUSES)[number];

export interface BriefPreferenceSnapshot {
  categoryIds: string[];
  regionIds: string[];
  emailEnabled: boolean;
  enabled: boolean;
}

export interface BriefRecipientDoc extends Document {
  clerkUserId: string;
  briefDate: string;
  segmentId: mongoose.Types.ObjectId;
  preferenceSnapshot: BriefPreferenceSnapshot;
  emailEnabled: boolean;
  emailStatus: BriefEmailStatus;
  emailProvider: string | null;
  emailMessageId: string | null;
  emailSentAt: Date | null;
  emailFailedAt: Date | null;
  emailRetryCount: number;
  emailLastError: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PreferenceSnapshotSchema = new Schema<BriefPreferenceSnapshot>(
  {
    categoryIds: { type: [String], required: true },
    regionIds: { type: [String], required: true },
    emailEnabled: { type: Boolean, required: true },
    enabled: { type: Boolean, required: true },
  },
  { _id: false },
);

const BriefRecipientSchema = new Schema<BriefRecipientDoc>(
  {
    clerkUserId: { type: String, required: true, trim: true, index: true },
    briefDate: { type: String, required: true, index: true },
    segmentId: { type: Schema.Types.ObjectId, ref: 'BriefSegment', required: true, index: true },
    preferenceSnapshot: { type: PreferenceSnapshotSchema, required: true },
    emailEnabled: { type: Boolean, required: true },
    emailStatus: { type: String, enum: BRIEF_EMAIL_STATUSES, default: 'not_requested', index: true },
    emailProvider: { type: String, default: null },
    emailMessageId: { type: String, default: null },
    emailSentAt: { type: Date, default: null },
    emailFailedAt: { type: Date, default: null },
    emailRetryCount: { type: Number, default: 0 },
    emailLastError: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BriefRecipientSchema.index({ clerkUserId: 1, briefDate: 1 }, { unique: true });
BriefRecipientSchema.index({ clerkUserId: 1, briefDate: -1, deletedAt: 1 });
BriefRecipientSchema.index({ emailStatus: 1, emailEnabled: 1, briefDate: -1 });

const BriefRecipient: Model<BriefRecipientDoc> =
  mongoose.models.BriefRecipient ||
  mongoose.model<BriefRecipientDoc>('BriefRecipient', BriefRecipientSchema);

export default BriefRecipient;
