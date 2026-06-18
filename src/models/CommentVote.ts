import mongoose, { Schema, Document, Model } from 'mongoose';

export interface CommentVoteDoc extends Document {
  commentId: mongoose.Types.ObjectId;
  // Clerk user ID of the voter.
  userId: string;
  // 1 = upvote, -1 = downvote. Neutral (0) is represented by the absence of a row.
  vote: 1 | -1;
  createdAt: Date;
  updatedAt: Date;
}

const CommentVoteSchema = new Schema<CommentVoteDoc>(
  {
    commentId: { type: Schema.Types.ObjectId, ref: 'Comment', required: true },
    userId: { type: String, required: true, trim: true },
    vote: { type: Number, enum: [1, -1], required: true },
  },
  { timestamps: true },
);

// One vote per user per comment. The real guard against double-voting.
CommentVoteSchema.index({ commentId: 1, userId: 1 }, { unique: true });
// Per-user vote activity.
CommentVoteSchema.index({ userId: 1, updatedAt: -1 });

const CommentVote: Model<CommentVoteDoc> =
  mongoose.models.CommentVote || mongoose.model<CommentVoteDoc>('CommentVote', CommentVoteSchema);

export default CommentVote;
