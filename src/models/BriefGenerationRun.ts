import mongoose, { Schema, Document, Model } from 'mongoose';

export const BRIEF_RUN_STATUSES = ['running', 'completed', 'failed'] as const;
export type BriefRunStatus = (typeof BRIEF_RUN_STATUSES)[number];

export interface BriefGenerationRunDoc extends Document {
  briefDate: string;
  status: BriefRunStatus;
  articleWindowStart: Date;
  articleWindowEnd: Date;
  lastPreferenceId: mongoose.Types.ObjectId | null;
  processedCount: number;
  eligibleCount: number;
  skippedCount: number;
  failedCount: number;
  createdSegmentCount: number;
  reusedSegmentCount: number;
  createdRecipientCount: number;
  lockToken: string | null;
  lockUntil: Date | null;
  lastError: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const BriefGenerationRunSchema = new Schema<BriefGenerationRunDoc>(
  {
    briefDate: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: BRIEF_RUN_STATUSES, default: 'running', index: true },
    articleWindowStart: { type: Date, required: true },
    articleWindowEnd: { type: Date, required: true },
    lastPreferenceId: { type: Schema.Types.ObjectId, default: null },
    processedCount: { type: Number, default: 0 },
    eligibleCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    createdSegmentCount: { type: Number, default: 0 },
    reusedSegmentCount: { type: Number, default: 0 },
    createdRecipientCount: { type: Number, default: 0 },
    lockToken: { type: String, default: null },
    lockUntil: { type: Date, default: null, index: true },
    lastError: { type: String, default: null },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BriefGenerationRunSchema.index({ status: 1, lockUntil: 1 });

const BriefGenerationRun: Model<BriefGenerationRunDoc> =
  mongoose.models.BriefGenerationRun ||
  mongoose.model<BriefGenerationRunDoc>('BriefGenerationRun', BriefGenerationRunSchema);

export default BriefGenerationRun;
