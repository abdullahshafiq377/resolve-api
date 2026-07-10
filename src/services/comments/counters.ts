import mongoose from 'mongoose';
import Article from '../../models/Article';
import Poll from '../../models/Poll';
import ResearchRequest from '../../models/ResearchRequest';
import Comment from '../../models/Comment';
import type { CommentParentType } from '../../models/Comment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PARENT_MODELS: Record<CommentParentType, mongoose.Model<any>> = {
  article: Article,
  poll: Poll,
  researchRequest: ResearchRequest,
};

// Adjust a parent's denormalised visible-comment count (clamped at 0).
export async function adjustParentCommentCount(
  parentType: CommentParentType,
  parentId: mongoose.Types.ObjectId | string,
  delta: number,
): Promise<void> {
  const Model = PARENT_MODELS[parentType];
  await Model.updateOne({ _id: parentId }, { $inc: { commentCount: delta } });
  await Model.updateOne({ _id: parentId, commentCount: { $lt: 0 } }, { $set: { commentCount: 0 } });
}

// Adjust a top-level comment's reply count (clamped at 0). Replies at any depth
// increment their root's counter.
export async function adjustReplyCount(
  rootCommentId: mongoose.Types.ObjectId | string,
  delta: number,
): Promise<void> {
  await Comment.updateOne({ _id: rootCommentId }, { $inc: { replyCount: delta } });
  await Comment.updateOne(
    { _id: rootCommentId, replyCount: { $lt: 0 } },
    { $set: { replyCount: 0 } },
  );
}
