import type { CommentDoc, CommentStatus } from '../../models/Comment';
import { findUsersByIds } from '../../services/users';

export const DELETED_BY_USER_TEXT = 'This comment has been deleted by the user.';
export const REMOVED_BY_MODERATOR_TEXT = 'This comment has been removed by a moderator.';

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

// Display identity as it stands right now, read from the users mirror rather than
// from the snapshot frozen onto the comment at post time. Changing your avatar or
// name on /account/profile has to reach comments you already posted.
export interface CommentAuthorIdentity {
  displayName: string;
  avatarUrl: string | null;
}

export type CommentAuthorMap = Map<string, CommentAuthorIdentity>;

const FALLBACK_DISPLAY_NAME = 'Resolve reader';

// Every Clerk id a page of comments needs an identity for: the authors, plus
// everyone they mentioned (mention chips carry a display name too).
function identityIdsFor(comments: CommentDoc[]): string[] {
  const ids = new Set<string>();
  for (const c of comments) {
    ids.add(c.authorId);
    for (const m of c.mentions ?? []) ids.add(m.userId);
  }
  return [...ids];
}

// One mirror query for a set of Clerk ids. Exported for the admin moderation
// queue, which builds its rows by aggregation instead of through a serializer.
export async function loadAuthorIdentities(userIds: string[]): Promise<CommentAuthorMap> {
  const map: CommentAuthorMap = new Map();
  const users = await findUsersByIds([...new Set(userIds)]);
  for (const u of users) {
    map.set(u.clerkUserId, {
      displayName: u.displayName || u.email || FALLBACK_DISPLAY_NAME,
      avatarUrl: u.imageUrl ?? null,
    });
  }
  return map;
}

// One mirror query per page of comments — the same join `serializeArticle` does
// for article authors. Call this before serializing and pass the result through.
export function loadCommentAuthors(comments: CommentDoc[]): Promise<CommentAuthorMap> {
  return loadAuthorIdentities(identityIdsFor(comments));
}

// Prefer the live mirror; fall back to the stored snapshot only when there is no
// mirror row at all (a webhook that never landed). A row that exists but has
// `imageUrl: null` means the member removed their photo — that null wins, or
// clearing an avatar would silently restore the old one.
function resolveIdentity(
  authors: CommentAuthorMap,
  userId: string,
  snapshotName: string,
  snapshotAvatar: string | null,
): CommentAuthorIdentity {
  const live = authors.get(userId);
  if (live) return live;
  return { displayName: snapshotName || FALLBACK_DISPLAY_NAME, avatarUrl: snapshotAvatar };
}

function serializeMentions(comment: CommentDoc, authors: CommentAuthorMap) {
  return comment.mentions.map((m) => ({
    userId: m.userId,
    displayName: authors.get(m.userId)?.displayName ?? m.displayName,
  }));
}

export interface CommentSerializeContext {
  // Map of commentId -> the requester's vote (1 | -1). Absent = no vote / signed out.
  userVotes: Map<string, 1 | -1>;
  // Live display identity per Clerk id, from `loadCommentAuthors`. Required rather
  // than optional: an omitted map would silently fall back to stale snapshots.
  authors: CommentAuthorMap;
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

    // Reddit's split: a self-delete anonymises the author (the reader is
    // withdrawing their own speech), a moderator removal keeps them attributed
    // (the action was taken *on* a person, and that stays accountable). The
    // author is only ever redacted here — `authorId` survives on the document
    // for moderation history either way.
    author: isDeleted
      ? null
      : {
          userId: comment.authorId,
          ...resolveIdentity(
            ctx.authors,
            comment.authorId,
            comment.authorDisplayName,
            comment.authorAvatarUrl,
          ),
          tier: comment.authorTier,
        },

    upvotes: comment.upvotes,
    downvotes: comment.downvotes,
    netScore: comment.netScore,
    replyCount: comment.replyCount,

    status,
    mentions: redacted ? [] : serializeMentions(comment, ctx.authors),
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
export function serializeAdminComment(comment: CommentDoc, authors: CommentAuthorMap) {
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
      ...resolveIdentity(
        authors,
        comment.authorId,
        comment.authorDisplayName,
        comment.authorAvatarUrl,
      ),
      tier: comment.authorTier,
    },
    upvotes: comment.upvotes,
    downvotes: comment.downvotes,
    netScore: comment.netScore,
    replyCount: comment.replyCount,
    status: comment.status,
    mentions: serializeMentions(comment, authors),
    edited: comment.edited,
    editedAt: comment.editedAt ? comment.editedAt.toISOString() : null,
    removedAt: comment.removedAt ? comment.removedAt.toISOString() : null,
    removedBy: comment.removedBy,
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}
