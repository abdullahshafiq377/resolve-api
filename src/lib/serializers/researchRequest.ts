import type { ResearchRequestDoc } from '../../models/ResearchRequest';
import type { NotificationDoc } from '../../models/Notification';
import type { UserDoc } from '../../models/User';
import type { CategoryDoc } from '../../models/Category';
import type { ArticleDoc } from '../../models/Article';

const ANONYMOUS_DISPLAY_NAME = 'Anonymous Resolve reader';

export interface SubmitterPublic {
  displayName: string;
  isAnonymous: boolean;
  // Cached Clerk avatar for the submitter, when the mirror row is present and
  // active. Null for hard/soft-deleted users so no stale identity leaks.
  avatarUrl: string | null;
}

// Build the public submitter identity from the local User mirror.
// - No mirror row (hard-deleted user) → isAnonymous: true.
// - Soft-deleted mirror row (deletedAt != null) → displayName falls back to the
//   anonymous label but isAnonymous stays false (the request itself is unaffected).
export function buildSubmitterPublic(
  userMap: Map<string, UserDoc>,
  submitterId: string,
): SubmitterPublic {
  const user = userMap.get(submitterId);
  if (!user) return { displayName: ANONYMOUS_DISPLAY_NAME, isAnonymous: true, avatarUrl: null };
  if (user.deletedAt) {
    return { displayName: ANONYMOUS_DISPLAY_NAME, isAnonymous: false, avatarUrl: null };
  }
  return {
    displayName: user.displayName || ANONYMOUS_DISPLAY_NAME,
    isAnonymous: false,
    avatarUrl: user.imageUrl ?? null,
  };
}

function serializeCategoryRef(category: CategoryDoc | undefined | null) {
  if (!category) return null;
  return { id: String(category._id), title: category.title, slug: category.slug };
}

export interface PublicContext {
  userMap: Map<string, UserDoc>;
  categoryMap: Map<string, CategoryDoc>;
  votedRequestIds: Set<string>;
}

// Public leaderboard card / per-request payload. Omits all internal fields.
export function serializePublicRequest(request: ResearchRequestDoc, ctx: PublicContext) {
  const categoryId = request.categoryId ? String(request.categoryId) : null;
  return {
    id: String(request._id),
    slug: request.slug,
    title: request.title,
    description: request.description,
    submitter: buildSubmitterPublic(ctx.userMap, request.submitterId),
    category: categoryId ? serializeCategoryRef(ctx.categoryMap.get(categoryId)) : null,
    status: request.status,
    // Public only when the request is in not_pursued; omitted (null) otherwise.
    notPursuedReason: request.status === 'not_pursued' ? request.notPursuedReason : null,
    voteCount: request.voteCount,
    commentCount: request.commentCount ?? 0,
    viewerHasVoted: ctx.votedRequestIds.has(String(request._id)),
    submittedAt: request.submittedAt?.toISOString() ?? request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

// Linked-article block for the per-request page (only when status === 'published').
export function serializeLinkedArticle(
  request: ResearchRequestDoc,
  article: ArticleDoc | null,
) {
  if (request.status !== 'published' || !request.linkedArticleId) return null;
  if (!article || article.status !== 'published') {
    // Article was unpublished or hard-deleted — surface a removed marker.
    return {
      id: request.linkedArticleId ? String(request.linkedArticleId) : null,
      slug: request.linkedArticleSlug ?? null,
      title: null,
      excerpt: null,
      featuredImage: null,
      publishedAt: null,
      isRemoved: true,
    };
  }
  return {
    id: String(article._id),
    slug: article.slug,
    title: article.title,
    excerpt: article.excerpt,
    featuredImage: article.featuredImage,
    publishedAt: article.publishDate?.toISOString() ?? null,
    isRemoved: false,
  };
}

// Account "Your submissions" item — includes the private rejectionReason.
// When ctx is supplied, enriches with the request's category and the submitter's
// public identity (display name + avatar) so the leaderboard "My requests" tab
// can render the same card as the public list.
export function serializeAccountRequest(
  request: ResearchRequestDoc,
  ctx?: { userMap: Map<string, UserDoc>; categoryMap: Map<string, CategoryDoc> },
) {
  const categoryId = request.categoryId ? String(request.categoryId) : null;
  return {
    id: String(request._id),
    slug: request.slug,
    title: request.title,
    description: request.description,
    status: request.status,
    category: categoryId && ctx ? serializeCategoryRef(ctx.categoryMap.get(categoryId)) : null,
    submitter: ctx ? buildSubmitterPublic(ctx.userMap, request.submitterId) : undefined,
    // Public surfaces gate on approvedAt; the account view exposes the pending state.
    approvedAt: request.approvedAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
    notPursuedReason: request.notPursuedReason,
    voteCount: request.voteCount,
    submittedAt: request.submittedAt?.toISOString() ?? request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

// Compact request shape for the "My upvoted" list and the sidebar preview.
// Extra fields (description, category, commentCount, viewerHasVoted) are emitted
// only when the corresponding lookup maps / flags are supplied, so existing
// callers (sidebar preview) stay byte-compatible while the leaderboard's
// "My Upvotes" tab can render the full card.
export function serializeCompactRequest(
  request: ResearchRequestDoc,
  opts?: {
    userMap?: Map<string, UserDoc>;
    categoryMap?: Map<string, CategoryDoc>;
    viewerHasVoted?: boolean;
  },
) {
  const isPublic = request.approvedAt !== null && request.status !== 'rejected';
  const categoryId = request.categoryId ? String(request.categoryId) : null;
  return {
    id: String(request._id),
    slug: request.slug,
    title: request.title,
    description: request.description,
    status: request.status,
    category:
      categoryId && opts?.categoryMap ? serializeCategoryRef(opts.categoryMap.get(categoryId)) : null,
    voteCount: request.voteCount,
    commentCount: request.commentCount ?? 0,
    viewerHasVoted: opts?.viewerHasVoted ?? false,
    isRemoved: !isPublic,
    submitter: opts?.userMap ? buildSubmitterPublic(opts.userMap, request.submitterId) : undefined,
    submittedAt: request.submittedAt?.toISOString() ?? request.createdAt.toISOString(),
  };
}

export interface AdminContext {
  userMap: Map<string, UserDoc>;
  categoryMap: Map<string, CategoryDoc>;
}

// Admin payload — every field, plus submitter email (admin-only).
export function serializeAdminRequest(request: ResearchRequestDoc, ctx: AdminContext) {
  const categoryId = request.categoryId ? String(request.categoryId) : null;
  const submitter = ctx.userMap.get(request.submitterId);
  return {
    id: String(request._id),
    slug: request.slug,
    title: request.title,
    description: request.description,
    submitter: {
      clerkUserId: request.submitterId,
      displayName: submitter?.displayName ?? ANONYMOUS_DISPLAY_NAME,
      email: submitter?.email ?? null,
      avatarUrl: submitter?.imageUrl ?? null,
    },
    category: categoryId ? serializeCategoryRef(ctx.categoryMap.get(categoryId)) : null,
    status: request.status,
    approvedAt: request.approvedAt?.toISOString() ?? null,
    rejectionReason: request.rejectionReason,
    notPursuedReason: request.notPursuedReason,
    // Internal. Admin payloads only — `serializePublicRequest` deliberately
    // omits it, and both serializers list fields explicitly so it cannot leak
    // by accident.
    editorNote: request.editorNote
      ? {
          body: request.editorNote.body,
          authorName: request.editorNote.authorName ?? null,
          at: request.editorNote.at?.toISOString() ?? null,
        }
      : null,
    linkedArticleId: request.linkedArticleId ? String(request.linkedArticleId) : null,
    linkedArticleSlug: request.linkedArticleSlug,
    voteCount: request.voteCount,
    commentCount: request.commentCount,
    submittedAt: request.submittedAt?.toISOString() ?? request.createdAt.toISOString(),
    moderatedBy: request.moderatedBy,
    moderatedAt: request.moderatedAt?.toISOString() ?? null,
    statusChangedBy: request.statusChangedBy,
    statusChangedAt: request.statusChangedAt?.toISOString() ?? null,
    linkedArticleBy: request.linkedArticleBy,
    linkedArticleAt: request.linkedArticleAt?.toISOString() ?? null,
    notPursuedReasonSetBy: request.notPursuedReasonSetBy,
    notPursuedReasonSetAt: request.notPursuedReasonSetAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

// Synthesize a coarse audit trail from the latest-actor audit fields (not a full
// event log — that is an explicit follow-up).
export function buildAuditTrail(
  request: ResearchRequestDoc,
  /**
   * Clerk id → user, for naming the actor. A raw `user_3EcL…` is unreadable in
   * the admin activity timeline, so `byName` carries display name, then email.
   * Optional: callers without the map still get the ids.
   */
  userMap?: Map<string, { displayName?: string | null; email?: string | null }>,
) {
  const trail: { action: string; by: string | null; byName: string | null; at: string }[] = [];
  const nameFor = (id: string | null): string | null => {
    if (!id) return null;
    const user = userMap?.get(id);
    return user?.displayName || user?.email || null;
  };
  if (request.submittedBy) {
    trail.push({
      action: 'submitted',
      by: request.submittedBy,
      byName: nameFor(request.submittedBy),
      at: (request.submittedAt ?? request.createdAt).toISOString(),
    });
  }
  if (request.moderatedAt) {
    trail.push({
      action: request.status === 'rejected' ? 'rejected' : 'approved',
      by: request.moderatedBy,
      byName: nameFor(request.moderatedBy),
      at: request.moderatedAt.toISOString(),
    });
  }
  if (request.statusChangedAt) {
    trail.push({
      action: 'status_changed',
      by: request.statusChangedBy,
      byName: nameFor(request.statusChangedBy),
      at: request.statusChangedAt.toISOString(),
    });
  }
  if (request.linkedArticleAt) {
    trail.push({
      action: 'linked_article',
      by: request.linkedArticleBy,
      byName: nameFor(request.linkedArticleBy),
      at: request.linkedArticleAt.toISOString(),
    });
  }
  if (request.notPursuedReasonSetAt) {
    trail.push({
      action: 'not_pursued_reason_set',
      by: request.notPursuedReasonSetBy,
      byName: nameFor(request.notPursuedReasonSetBy),
      at: request.notPursuedReasonSetAt.toISOString(),
    });
  }
  return trail.sort((a, b) => a.at.localeCompare(b.at));
}

export function serializeNotification(notification: NotificationDoc) {
  return {
    id: String(notification._id),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    link: notification.link,
    requestId: notification.requestId ? String(notification.requestId) : null,
    read: notification.read,
    createdAt: notification.createdAt.toISOString(),
  };
}
