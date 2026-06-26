import mongoose, { Schema, Document, Model } from 'mongoose';

export const BRIEF_SEGMENT_STATUSES = ['draft', 'approved', 'rejected'] as const;
export type BriefSegmentStatus = (typeof BRIEF_SEGMENT_STATUSES)[number];

export const BRIEF_GENERATION_STATUSES = ['generated', 'failed', 'manual'] as const;
export type BriefGenerationStatus = (typeof BRIEF_GENERATION_STATUSES)[number];

export interface BriefStory {
  articleId: mongoose.Types.ObjectId;
  headline: string;
  summary: string;
  url: string;
  order: number;
}

export interface BriefSegmentDoc extends Document {
  briefDate: string;
  signatureHash: string;
  signatureVersion: number;
  categoryIds: mongoose.Types.ObjectId[];
  regionIds: mongoose.Types.ObjectId[];
  articleWindowStart: Date;
  articleWindowEnd: Date;
  sourceArticleIds: mongoose.Types.ObjectId[];
  // The single shared "generic" free-tier brief for a day (one per briefDate via
  // a sentinel signatureHash). Generic segments have no BriefRecipients.
  isGeneric: boolean;
  status: BriefSegmentStatus;
  headlineSummary: string;
  title: string | null;
  summary: string | null;
  stories: BriefStory[];
  editorialNote: string | null;
  editorialNoteAuthor: string | null;
  generationStatus: BriefGenerationStatus;
  generationError: string | null;
  generatedAt: Date | null;
  generatedBy: string;
  approvedAt: Date | null;
  approvedBy: string | null;
  rejectedAt: Date | null;
  rejectedBy: string | null;
  rejectionReason: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const BriefStorySchema = new Schema<BriefStory>(
  {
    articleId: { type: Schema.Types.ObjectId, ref: 'Article', required: true },
    headline: { type: String, required: true, trim: true },
    summary: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    order: { type: Number, required: true },
  },
  { _id: false },
);

const BriefSegmentSchema = new Schema<BriefSegmentDoc>(
  {
    briefDate: { type: String, required: true, index: true },
    signatureHash: { type: String, required: true, trim: true },
    signatureVersion: { type: Number, default: 1 },
    categoryIds: [{ type: Schema.Types.ObjectId, ref: 'Category', required: true }],
    regionIds: [{ type: Schema.Types.ObjectId, ref: 'Region', required: true }],
    articleWindowStart: { type: Date, required: true },
    articleWindowEnd: { type: Date, required: true },
    sourceArticleIds: [{ type: Schema.Types.ObjectId, ref: 'Article' }],
    isGeneric: { type: Boolean, default: false, index: true },
    status: { type: String, enum: BRIEF_SEGMENT_STATUSES, default: 'draft', index: true },
    headlineSummary: { type: String, required: true, trim: true },
    title: { type: String, default: null, trim: true },
    summary: { type: String, default: null, trim: true },
    stories: { type: [BriefStorySchema], default: [] },
    editorialNote: { type: String, default: null, trim: true },
    editorialNoteAuthor: { type: String, default: null, trim: true },
    generationStatus: { type: String, enum: BRIEF_GENERATION_STATUSES, default: 'generated' },
    generationError: { type: String, default: null },
    generatedAt: { type: Date, default: null },
    generatedBy: { type: String, default: 'system' },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
    rejectedAt: { type: Date, default: null },
    rejectedBy: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

BriefSegmentSchema.index({ briefDate: 1, signatureHash: 1 }, { unique: true });
BriefSegmentSchema.index({ briefDate: -1, status: 1, createdAt: -1 });
BriefSegmentSchema.index({ sourceArticleIds: 1 });

const BriefSegment: Model<BriefSegmentDoc> =
  mongoose.models.BriefSegment || mongoose.model<BriefSegmentDoc>('BriefSegment', BriefSegmentSchema);

export default BriefSegment;
