import mongoose from 'mongoose';
import Article from '../../models/Article';
import Poll from '../../models/Poll';
import ResearchRequest from '../../models/ResearchRequest';
import type { CommentParentType } from '../../models/Comment';

export type FrozenReason = 'parent_closed' | 'parent_not_published';

export interface ParentState {
  found: boolean;
  // Whether new comments / votes are accepted right now.
  open: boolean;
  frozenReason?: FrozenReason;
  // Human-readable parent title for notifications + emails.
  title: string;
  // Parent slug (for deep links).
  slug: string;
}

// In-app path to a parent surface.
export function parentPath(parentType: CommentParentType, slug: string): string {
  if (parentType === 'article') return `/article/${slug}`;
  if (parentType === 'poll') return `/public-pulse/${slug}`;
  return `/research-requests/${slug}`;
}

// Resolve a parent's existence + commenting-open state.
//
// Open-state rules (comments-posting-threading.md §1.1, reconciled with the real
// status enums):
//   - Article:         status === 'published'
//   - Poll:            status === 'active' && closeDate > now
//   - ResearchRequest: approvedAt !== null && status not in ['rejected','not_pursued']
export async function resolveParentState(
  parentType: CommentParentType,
  parentId: string,
): Promise<ParentState> {
  if (!mongoose.Types.ObjectId.isValid(parentId)) {
    return { found: false, open: false, title: '', slug: '' };
  }

  if (parentType === 'article') {
    const doc = await Article.findById(parentId).select('title slug status').lean();
    if (!doc) return { found: false, open: false, title: '', slug: '' };
    const open = doc.status === 'published';
    return {
      found: true,
      open,
      frozenReason: open ? undefined : 'parent_not_published',
      title: doc.title,
      slug: doc.slug,
    };
  }

  if (parentType === 'poll') {
    const doc = await Poll.findById(parentId).select('question slug status closeDate').lean();
    if (!doc) return { found: false, open: false, title: '', slug: '' };
    const open = doc.status === 'active' && (!doc.closeDate || doc.closeDate > new Date());
    return {
      found: true,
      open,
      frozenReason: open ? undefined : 'parent_closed',
      title: doc.question,
      slug: doc.slug,
    };
  }

  // researchRequest
  const doc = await ResearchRequest.findById(parentId).select('title slug status approvedAt').lean();
  if (!doc) return { found: false, open: false, title: '', slug: '' };
  const open =
    doc.approvedAt !== null && doc.status !== 'rejected' && doc.status !== 'not_pursued';
  return {
    found: true,
    open,
    frozenReason: open ? undefined : 'parent_not_published',
    title: doc.title,
    slug: doc.slug,
  };
}
