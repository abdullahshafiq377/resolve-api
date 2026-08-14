import mongoose, { Schema, Document, Model } from 'mongoose';

// Surfaces a comment can be attached to. Mirrors the parent collections.
export const COMMENT_PARENT_TYPES = ['article', 'poll', 'researchRequest'] as const;
export type CommentParentType = (typeof COMMENT_PARENT_TYPES)[number];

// Lifecycle states. `held` is caught by the block list and never surfaces
// publicly. `deleted_by_user` / `removed` always keep the row as a placeholder,
// with the body and mentions blanked — deletion is never destructive here, and
// nothing in this collection is ever hard-deleted on a user's own delete,
// whether or not the comment has replies. A reader sees a "[deleted]" tombstone
// in place of the text; the row itself stays so the thread structure, counters
// and any replies hanging off it survive.
export const COMMENT_STATUSES = ['visible', 'held', 'removed', 'deleted_by_user'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

// Snapshot of the author's tier at post time. Only premium-tier users (premium
// plan, or moderators/super admins who inherit it) can post, so this is
// effectively always 'premium' today; kept as an enum for forward-compatibility.
export const COMMENT_AUTHOR_TIERS = ['core', 'premium'] as const;
export type CommentAuthorTier = (typeof COMMENT_AUTHOR_TIERS)[number];

// `displayName` here is the name as typed into the body, kept so `position`
// still lines up with the text. Serializers render the chip from the live users
// mirror instead, so a renamed member is not stuck under their old name.
export interface CommentMention {
  userId: string;
  displayName: string;
  position: number;
}

export interface CommentDoc extends Document {
  // Polymorphic parent reference.
  parentType: CommentParentType;
  parentId: mongoose.Types.ObjectId;

  // Threading. parentCommentId is null for top-level (level 0). rootCommentId is
  // always the top-level ancestor (equal to _id for level 0). `path` is a
  // materialised path (",<id>,<id>,") for efficient subtree queries — always
  // regenerated server-side, never trusted from the client.
  parentCommentId: mongoose.Types.ObjectId | null;
  level: 0 | 1 | 2;
  rootCommentId: mongoose.Types.ObjectId;
  path: string;

  // Author reference. `authorId` is the identity; the display fields below are a
  // post-time snapshot kept only as a fallback for when the users mirror has no
  // row (a Clerk webhook that never landed). Serializers join the live mirror
  // instead — see `loadCommentAuthors` in lib/serializers/comment.ts — so a
  // member who changes their avatar or name sees it on comments they already
  // posted. Never read these fields directly in a response.
  authorId: string;
  authorDisplayName: string;
  authorAvatarUrl: string | null;
  authorTier: CommentAuthorTier;

  // Body is stored as Tiptap/ProseMirror JSON (consistent with articles).
  // bodyText is the extracted plain text used for length checks, the block-list
  // match, mention extraction, and email excerpts.
  body: unknown;
  bodyText: string;
  mentions: CommentMention[];

  // Denormalised counters.
  upvotes: number;
  downvotes: number;
  netScore: number;
  replyCount: number;

  // State.
  status: CommentStatus;
  visibleAt: Date | null;
  edited: boolean;
  editedAt: Date | null;

  // Audit.
  createdAt: Date;
  updatedAt: Date;
  removedAt: Date | null;
  removedBy: string | null;
}

const MentionSchema = new Schema<CommentMention>(
  {
    userId: { type: String, required: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    position: { type: Number, required: true },
  },
  { _id: false },
);

const CommentSchema = new Schema<CommentDoc>(
  {
    parentType: { type: String, enum: COMMENT_PARENT_TYPES, required: true },
    parentId: { type: Schema.Types.ObjectId, required: true },

    parentCommentId: { type: Schema.Types.ObjectId, ref: 'Comment', default: null },
    level: { type: Number, enum: [0, 1, 2], required: true, default: 0 },
    rootCommentId: { type: Schema.Types.ObjectId, ref: 'Comment', required: true },
    path: { type: String, required: true, default: '' },

    authorId: { type: String, required: true, trim: true },
    authorDisplayName: { type: String, required: true, trim: true },
    authorAvatarUrl: { type: String, default: null },
    authorTier: { type: String, enum: COMMENT_AUTHOR_TIERS, required: true, default: 'premium' },

    body: { type: Schema.Types.Mixed, required: true },
    // Not `required` — Mongoose's String required-validator rejects '', and the
    // delete / moderator-remove paths blank this out on the surviving placeholder.
    // Non-emptiness on real posts is enforced by the content validator instead.
    bodyText: { type: String, default: '' },
    mentions: { type: [MentionSchema], default: [] },

    upvotes: { type: Number, default: 0, min: 0 },
    downvotes: { type: Number, default: 0, min: 0 },
    netScore: { type: Number, default: 0 },
    replyCount: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: COMMENT_STATUSES, required: true, default: 'visible' },
    visibleAt: { type: Date, default: null },
    edited: { type: Boolean, default: false },
    editedAt: { type: Date, default: null },

    removedAt: { type: Date, default: null },
    removedBy: { type: String, default: null },
  },
  { timestamps: true },
);

// List a parent's comments (newest first) — default sort.
CommentSchema.index({ parentType: 1, parentId: 1, status: 1, createdAt: -1 });
// "Most upvoted" sort.
CommentSchema.index({ parentType: 1, parentId: 1, status: 1, netScore: -1 });
// "Most replied" sort.
CommentSchema.index({ parentType: 1, parentId: 1, status: 1, replyCount: -1 });
// Reply thread rendering.
CommentSchema.index({ rootCommentId: 1, level: 1, createdAt: 1 });
// Per-user comment history.
CommentSchema.index({ authorId: 1, createdAt: -1 });
// Held queue (admin), FIFO.
CommentSchema.index({ status: 1, createdAt: 1 });
// Mention notification fan-out.
CommentSchema.index({ 'mentions.userId': 1 });
// Subtree counts / queries.
CommentSchema.index({ path: 1 });

const Comment: Model<CommentDoc> =
  mongoose.models.Comment || mongoose.model<CommentDoc>('Comment', CommentSchema);

export default Comment;
