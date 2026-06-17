import mongoose, { Schema, Document, Model } from 'mongoose';

// Public statuses + one internal (`rejected`) status. See the Research Requests
// Product Spec status model. `rejected` is never shown on public surfaces.
export const RESEARCH_REQUEST_STATUSES = [
  'submitted',
  'under_consideration',
  'being_investigated',
  'published',
  'not_pursued',
  'rejected',
] as const;

export type ResearchRequestStatus = (typeof RESEARCH_REQUEST_STATUSES)[number];

// The five statuses a moderator can set via the change-status endpoint.
// `rejected` is reachable only through the dedicated reject action.
export const PUBLIC_SETTABLE_STATUSES = [
  'submitted',
  'under_consideration',
  'being_investigated',
  'published',
  'not_pursued',
] as const;

export interface ResearchRequestDoc extends Document {
  title: string;
  description: string;
  slug: string;
  // Clerk user ID of the submitter.
  submitterId: string;
  categoryId: mongoose.Types.ObjectId | null;
  status: ResearchRequestStatus;
  // Set on first approval. Null while pending or after a never-approved rejection.
  // Public visibility gate: approvedAt !== null && status !== 'rejected'.
  approvedAt: Date | null;
  // Internal-only. Set when status = 'rejected'. Visible to submitter + moderators.
  rejectionReason: string | null;
  // Public. Set when status = 'not_pursued'.
  notPursuedReason: string | null;
  linkedArticleId: mongoose.Types.ObjectId | null;
  // Denormalised from Article.slug at link time so the public serializer can
  // avoid a join in the common case.
  linkedArticleSlug: string | null;
  // Denormalised counter maintained transactionally by the vote endpoints.
  voteCount: number;
  // Audit fields — all Clerk user IDs.
  submittedAt: Date;
  submittedBy: string;
  moderatedBy: string | null;
  moderatedAt: Date | null;
  statusChangedBy: string | null;
  statusChangedAt: Date | null;
  linkedArticleBy: string | null;
  linkedArticleAt: Date | null;
  notPursuedReasonSetBy: string | null;
  notPursuedReasonSetAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ResearchRequestSchema = new Schema<ResearchRequestDoc>(
  {
    title: { type: String, required: true, trim: true, minlength: 8, maxlength: 120 },
    description: { type: String, required: true, trim: true, minlength: 20, maxlength: 500 },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    submitterId: { type: String, required: true, trim: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    status: { type: String, enum: RESEARCH_REQUEST_STATUSES, default: 'submitted', index: true },
    approvedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null, trim: true, maxlength: 500 },
    notPursuedReason: { type: String, default: null, trim: true, maxlength: 280 },
    linkedArticleId: { type: Schema.Types.ObjectId, ref: 'Article', default: null },
    linkedArticleSlug: { type: String, default: null, trim: true },
    voteCount: { type: Number, default: 0, min: 0 },
    submittedAt: { type: Date, default: Date.now },
    submittedBy: { type: String, required: true, trim: true },
    moderatedBy: { type: String, default: null },
    moderatedAt: { type: Date, default: null },
    statusChangedBy: { type: String, default: null },
    statusChangedAt: { type: Date, default: null },
    linkedArticleBy: { type: String, default: null },
    linkedArticleAt: { type: Date, default: null },
    notPursuedReasonSetBy: { type: String, default: null },
    notPursuedReasonSetAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Public leaderboard: status != 'rejected' && approvedAt != null, sorted by votes.
ResearchRequestSchema.index({ status: 1, approvedAt: 1, voteCount: -1 });
// "Newest" sort.
ResearchRequestSchema.index({ status: 1, approvedAt: 1, createdAt: -1 });
// "Recently active" sort.
ResearchRequestSchema.index({ status: 1, approvedAt: 1, updatedAt: -1 });
// Category-filtered leaderboard.
ResearchRequestSchema.index({ categoryId: 1, status: 1, approvedAt: 1, voteCount: -1 });
// "Your submissions" account view.
ResearchRequestSchema.index({ submitterId: 1, createdAt: -1 });
// "Find the request linked to this article" lookup.
ResearchRequestSchema.index({ linkedArticleId: 1 });
// Moderation queue "Pending" / "Recently moderated".
ResearchRequestSchema.index({ status: 1, moderatedAt: -1 });

const ResearchRequest: Model<ResearchRequestDoc> =
  mongoose.models.ResearchRequest ||
  mongoose.model<ResearchRequestDoc>('ResearchRequest', ResearchRequestSchema);

export default ResearchRequest;
