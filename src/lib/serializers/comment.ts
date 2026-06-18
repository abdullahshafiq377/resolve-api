import type { CommentDoc, CommentStatus } from '../../models/Comment';

export const DELETED_BY_USER_TEXT = '[deleted by user]';
export const REMOVED_BY_MODERATOR_TEXT = '[removed by moderator]';

// A minimal ProseMirror doc carrying placeholder text, so the client can render
// it through the same EditorJsContent renderer as real bodies.
function placeholderBody(text: string) {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

// User-relevant status surfaced to the client. `held` never reaches this layer.
type PublicStatus = 'visible' | 'deleted_by_user' | 'removed';

export interface CommentSerializeContext {
  // Map of commentId -> the requester's vote (1 | -1). Absent = no vote / signed out.
  userVotes: Map<string, 1 | -1>;
}

// Public comment shape (comments-api §2.1). Author identity is redacted and the
// body replaced for deleted/removed placeholders.
export function serializePublicComment(comment: CommentDoc, ctx: CommentSerializeContext) {
  const id = String(comment._id);
  const status = comment.status as PublicStatus;
  const isDeleted = status === 'deleted_by_user';
  const isRemoved = status === 'removed';
  const redacted = isDeleted || isRemoved;

  const body = isDeleted
    ? placeholderBody(DELETED_BY_USER_TEXT)
    : isRemoved
      ? placeholderBody(REMOVED_BY_MODERATOR_TEXT)
      : comment.body;

  return {
    id,
    parentType: comment.parentType,
    parentId: String(comment.parentId),
    parentCommentId: comment.parentCommentId ? String(comment.parentCommentId) : null,
    level: comment.level,
    rootCommentId: String(comment.rootCommentId),
    path: comment.path,

    body,

    author: redacted
      ? null
      : {
          userId: comment.authorId,
          displayName: comment.authorDisplayName,
          avatarUrl: comment.authorAvatarUrl,
          tier: comment.authorTier,
        },

    upvotes: comment.upvotes,
    downvotes: comment.downvotes,
    netScore: comment.netScore,
    replyCount: comment.replyCount,

    status,
    mentions: redacted
      ? []
      : comment.mentions.map((m) => ({ userId: m.userId, displayName: m.displayName })),
    edited: comment.edited,
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,

    userVote: ctx.userVotes.get(id) ?? null,

    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

// Statuses that surface in the public list (held is always excluded).
export const PUBLIC_LIST_STATUSES: CommentStatus[] = ['visible', 'removed', 'deleted_by_user'];

// Internal/admin comment shape — full body + author identity regardless of status
// (moderators see held/removed content).
export function serializeAdminComment(comment: CommentDoc) {
  return {
    id: String(comment._id),
    parentType: comment.parentType,
    parentId: String(comment.parentId),
    parentCommentId: comment.parentCommentId ? String(comment.parentCommentId) : null,
    level: comment.level,
    rootCommentId: String(comment.rootCommentId),
    body: comment.body,
    bodyText: comment.bodyText,
    author: {
      userId: comment.authorId,
      displayName: comment.authorDisplayName,
      avatarUrl: comment.authorAvatarUrl,
      tier: comment.authorTier,
    },
    upvotes: comment.upvotes,
    downvotes: comment.downvotes,
    netScore: comment.netScore,
    replyCount: comment.replyCount,
    status: comment.status,
    mentions: comment.mentions.map((m) => ({ userId: m.userId, displayName: m.displayName })),
    edited: comment.edited,
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
    removedAt: comment.removedAt ? comment.removedAt.toISOString() : null,
    removedBy: comment.removedBy,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}
