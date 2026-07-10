import mongoose, { Schema, Document, Model } from 'mongoose';

export const COMMENT_REPORT_REASONS = [
  'harassment',
  'hate_speech',
  'spam',
  'off_topic',
  'other',
] as const;
export type CommentReportReason = (typeof COMMENT_REPORT_REASONS)[number];

export const COMMENT_REPORT_STATUSES = [
  'open',
  'resolved_removed',
  'resolved_no_action',
] as const;
export type CommentReportStatus = (typeof COMMENT_REPORT_STATUSES)[number];

export interface CommentReportDoc extends Document {
  commentId: mongoose.Types.ObjectId;
  // Clerk user ID of the reporter.
  reporterId: string;
  reason: CommentReportReason;
  context: string | null;
  status: CommentReportStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CommentReportSchema = new Schema<CommentReportDoc>(
  {
    commentId: { type: Schema.Types.ObjectId, ref: 'Comment', required: true },
    reporterId: { type: String, required: true, trim: true },
    reason: { type: String, enum: COMMENT_REPORT_REASONS, required: true },
    context: { type: String, default: null, maxlength: 500 },
    status: { type: String, enum: COMMENT_REPORT_STATUSES, required: true, default: 'open' },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// One report per (user, comment).
CommentReportSchema.index({ commentId: 1, reporterId: 1 }, { unique: true });
// Open report queue (newest first within status).
CommentReportSchema.index({ status: 1, createdAt: -1 });
// Aggregation for the most-reported sort + resolving a comment's reports together.
CommentReportSchema.index({ commentId: 1, status: 1 });
// Reporter history.
CommentReportSchema.index({ reporterId: 1, createdAt: -1 });

const CommentReport: Model<CommentReportDoc> =
  mongoose.models.CommentReport ||
  mongoose.model<CommentReportDoc>('CommentReport', CommentReportSchema);

export default CommentReport;
