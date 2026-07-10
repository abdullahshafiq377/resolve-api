import mongoose, { Schema, Document, Model } from 'mongoose';

export interface PollVoteDoc extends Document {
  pollId: mongoose.Types.ObjectId;
  userId: string;
  optionId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PollVoteSchema = new Schema<PollVoteDoc>(
  {
    pollId: { type: Schema.Types.ObjectId, ref: 'Poll', required: true, index: true },
    userId: { type: String, required: true, trim: true },
    optionId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: true },
);

PollVoteSchema.index({ pollId: 1, userId: 1 }, { unique: true });
PollVoteSchema.index({ userId: 1, createdAt: -1 });
PollVoteSchema.index({ pollId: 1, optionId: 1, updatedAt: -1 });
PollVoteSchema.index({ pollId: 1, updatedAt: -1 });

const PollVote: Model<PollVoteDoc> =
  mongoose.models.PollVote || mongoose.model<PollVoteDoc>('PollVote', PollVoteSchema);

export default PollVote;
