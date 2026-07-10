import mongoose, { Schema, Document, Model } from 'mongoose';

export interface BriefPreferenceDoc extends Document {
  clerkUserId: string;
  enabled: boolean;
  categoryIds: mongoose.Types.ObjectId[];
  regionIds: mongoose.Types.ObjectId[];
  emailEnabled: boolean;
  onboardingCompleted: boolean;
  completedAt: Date | null;
  lastUpdatedBy: 'user' | 'admin' | 'system' | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const BriefPreferenceSchema = new Schema<BriefPreferenceDoc>(
  {
    clerkUserId: { type: String, required: true, trim: true, index: true },
    enabled: { type: Boolean, default: true },
    categoryIds: [{ type: Schema.Types.ObjectId, ref: 'Category', required: true }],
    regionIds: [{ type: Schema.Types.ObjectId, ref: 'Region', required: true }],
    emailEnabled: { type: Boolean, default: true },
    onboardingCompleted: { type: Boolean, default: false, index: true },
    completedAt: { type: Date, default: null },
    lastUpdatedBy: { type: String, enum: ['user', 'admin', 'system', null], default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BriefPreferenceSchema.index({ clerkUserId: 1 }, { unique: true });
BriefPreferenceSchema.index({ enabled: 1, onboardingCompleted: 1, deletedAt: 1, _id: 1 });
BriefPreferenceSchema.index({ categoryIds: 1 });
BriefPreferenceSchema.index({ regionIds: 1 });

const BriefPreference: Model<BriefPreferenceDoc> =
  mongoose.models.BriefPreference ||
  mongoose.model<BriefPreferenceDoc>('BriefPreference', BriefPreferenceSchema);

export default BriefPreference;
