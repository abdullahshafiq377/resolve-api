import mongoose, { Schema, Document, Model } from 'mongoose';

export const POLL_STATUSES = ['draft', 'scheduled', 'active', 'closed'] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

export const POLL_RESULTS_MODES = ['hidden_until_vote', 'always_visible'] as const;
export type PollResultsMode = (typeof POLL_RESULTS_MODES)[number];

export const POLL_OPTION_MIN = 2;
export const POLL_OPTION_MAX = 6;
export const POLL_QUESTION_MIN = 8;
export const POLL_QUESTION_MAX = 200;
export const POLL_OPTION_TEXT_MIN = 1;
export const POLL_OPTION_TEXT_MAX = 120;
export const POLL_DESCRIPTION_MAX = 1000;
export const POLL_RECENTLY_CLOSED_WINDOW_DAYS = 14;

export interface PollOptionDoc {
  _id: mongoose.Types.ObjectId;
  text: string;
  order: number;
}

export interface PollDoc extends Document {
  question: string;
  description: string;
  slug: string;
  options: PollOptionDoc[];
  status: PollStatus;
  closeDate: Date;
  opensAt: Date | null;
  resultsMode: PollResultsMode;
  totalVotes: number;
  optionVoteCounts: Map<string, number>;
  commentCount: number;
  createdBy: string;
  createdAt: Date;
  lastEditedBy: string;
  updatedAt: Date;
  publishedBy: string | null;
  publishedAt: Date | null;
  closedBy: string | null;
  closedAt: Date | null;
  lastSystemTransitionAt: Date | null;
}

const PollOptionSchema = new Schema<PollOptionDoc>(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    text: {
      type: String,
      required: true,
      trim: true,
      minlength: POLL_OPTION_TEXT_MIN,
      maxlength: POLL_OPTION_TEXT_MAX,
    },
    order: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const PollSchema = new Schema<PollDoc>(
  {
    question: {
      type: String,
      required: true,
      trim: true,
      minlength: POLL_QUESTION_MIN,
      maxlength: POLL_QUESTION_MAX,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: POLL_DESCRIPTION_MAX,
    },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    options: {
      type: [PollOptionSchema],
      required: true,
      validate: {
        validator: (v: PollOptionDoc[]) =>
          v.length >= POLL_OPTION_MIN && v.length <= POLL_OPTION_MAX,
        message: `Poll must have between ${POLL_OPTION_MIN} and ${POLL_OPTION_MAX} options.`,
      },
    },
    status: { type: String, enum: POLL_STATUSES, required: true, default: 'draft', index: true },
    closeDate: { type: Date, required: true },
    opensAt: { type: Date, default: null },
    resultsMode: {
      type: String,
      enum: POLL_RESULTS_MODES,
      required: true,
      default: 'hidden_until_vote',
    },
    totalVotes: { type: Number, default: 0, min: 0 },
    optionVoteCounts: {
      type: Map,
      of: Number,
      default: () => new Map<string, number>(),
    },
    commentCount: { type: Number, default: 0, min: 0 },
    createdBy: { type: String, required: true, trim: true, index: true },
    lastEditedBy: { type: String, required: true, trim: true },
    publishedBy: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    closedBy: { type: String, default: null },
    closedAt: { type: Date, default: null },
    lastSystemTransitionAt: { type: Date, default: null },
  },
  { timestamps: true },
);

PollSchema.index({ status: 1, closeDate: 1 });
PollSchema.index({ status: 1, opensAt: 1 });
PollSchema.index({ status: 1, createdAt: -1 });
PollSchema.index({ status: 1, closedAt: -1 });
PollSchema.index({ createdBy: 1, createdAt: -1 });

const Poll: Model<PollDoc> =
  mongoose.models.Poll || mongoose.model<PollDoc>('Poll', PollSchema);

export default Poll;
