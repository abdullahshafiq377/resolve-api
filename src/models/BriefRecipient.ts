import mongoose, { Schema, Document, Model } from 'mongoose';
import { EMAIL_DELIVERY_OUTCOMES, type EmailDeliveryOutcome } from './emailDelivery';

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
  // What Resend reported *after* accepting the message, via the webhook at
  // /api/webhooks/resend (`F-041`). `emailStatus` above stops at 'sent', which
  // only ever meant "Resend accepted it" — these three say whether it landed.
  emailDelivery: EmailDeliveryOutcome;
  emailDeliveryAt: Date | null;
  // Bounce or complaint detail as the provider phrased it, e.g.
  // "Permanent/Suppressed: The recipient's email address is on the suppression list".
  emailDeliveryDetail: string | null;
  // First time the recipient opened this edition on the web (POST /:id/read).
  // Write-once — a re-read does not move it — so it reads as "when they first
  // got to it". Null for editions delivered but never opened, and for every
  // edition that predates read tracking.
  readAt: Date | null;
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
    emailDelivery: { type: String, enum: EMAIL_DELIVERY_OUTCOMES, default: 'unknown', index: true },
    emailDeliveryAt: { type: Date, default: null },
    emailDeliveryDetail: { type: String, default: null, maxlength: 500 },
    readAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BriefRecipientSchema.index({ clerkUserId: 1, briefDate: 1 }, { unique: true });
BriefRecipientSchema.index({ clerkUserId: 1, briefDate: -1, deletedAt: 1 });
BriefRecipientSchema.index({ emailStatus: 1, emailEnabled: 1, briefDate: -1 });
// The Resend webhook arrives with a message id and nothing else to match on.
// Sparse: only rows that were actually accepted by Resend carry one.
BriefRecipientSchema.index({ emailMessageId: 1 }, { sparse: true });
// Account overview: "briefs read this month" for one user.
BriefRecipientSchema.index({ clerkUserId: 1, readAt: -1 });

const BriefRecipient: Model<BriefRecipientDoc> =
  mongoose.models.BriefRecipient ||
  mongoose.model<BriefRecipientDoc>('BriefRecipient', BriefRecipientSchema);

export default BriefRecipient;
