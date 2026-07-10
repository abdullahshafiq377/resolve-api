import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ResearchRequestVoteDoc extends Document {
  requestId: mongoose.Types.ObjectId;
  // Clerk user ID of the voter.
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

const ResearchRequestVoteSchema = new Schema<ResearchRequestVoteDoc>(
  {
    requestId: { type: Schema.Types.ObjectId, ref: 'ResearchRequest', required: true },
    userId: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

// One vote per user per request. The real guard against double-voting.
ResearchRequestVoteSchema.index({ requestId: 1, userId: 1 }, { unique: true });
// "My upvoted" account view (newest vote first).
ResearchRequestVoteSchema.index({ userId: 1, createdAt: -1 });
// Admin upvoter list, ordered by recency.
ResearchRequestVoteSchema.index({ requestId: 1, createdAt: -1 });

const ResearchRequestVote: Model<ResearchRequestVoteDoc> =
  mongoose.models.ResearchRequestVote ||
  mongoose.model<ResearchRequestVoteDoc>('ResearchRequestVote', ResearchRequestVoteSchema);

export default ResearchRequestVote;
