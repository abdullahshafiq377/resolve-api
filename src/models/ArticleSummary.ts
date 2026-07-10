import mongoose, { HydratedDocument, Model, Schema } from 'mongoose';

export const AI_SUMMARY_FORMATS = ['bullets', 'paragraph'] as const;

export type AiSummaryFormat = (typeof AI_SUMMARY_FORMATS)[number];

export interface BulletSummaryContent {
  items: string[];
}

export interface ParagraphSummaryContent {
  text: string;
}

export type AiSummaryContent = BulletSummaryContent | ParagraphSummaryContent;

export interface ArticleSummaryAttrs {
  articleId: mongoose.Types.ObjectId;
  format: AiSummaryFormat;
  content: AiSummaryContent;
  model: string;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  generatedBy: string;
  generatedAt: Date;
  lastEditedBy: string;
  lastEditedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type ArticleSummaryDoc = HydratedDocument<ArticleSummaryAttrs>;

const ArticleSummarySchema = new Schema<ArticleSummaryAttrs>(
  {
    articleId: {
      type: Schema.Types.ObjectId,
      ref: 'Article',
      required: true,
      unique: true,
      index: true,
    },
    format: { type: String, enum: AI_SUMMARY_FORMATS, required: true },
    content: { type: Schema.Types.Mixed, required: true },
    model: { type: String, required: true, trim: true },
    approved: { type: Boolean, default: false, index: true },
    approvedBy: { type: String, trim: true, default: null },
    approvedAt: { type: Date, default: null },
    generatedBy: { type: String, required: true, trim: true },
    generatedAt: { type: Date, required: true },
    lastEditedBy: { type: String, required: true, trim: true },
    lastEditedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

ArticleSummarySchema.index({ articleId: 1, approved: 1 });
ArticleSummarySchema.index({ approved: 1, updatedAt: -1 });

const ArticleSummary: Model<ArticleSummaryAttrs> =
  mongoose.models.ArticleSummary ||
  mongoose.model<ArticleSummaryAttrs>('ArticleSummary', ArticleSummarySchema);

export default ArticleSummary;
