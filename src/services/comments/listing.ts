import mongoose from 'mongoose';
import CommentVote from '../../models/CommentVote';

export const COMMENT_SORTS = ['newest', 'oldest', 'top', 'replies'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

// Clamp the requested page size.
export function parseLimit(raw: unknown): number {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

// Mongo sort spec for each option (top-level keyset, _id as tiebreaker).
export function sortSpec(sort: CommentSort): Record<string, 1 | -1> {
  switch (sort) {
    case 'oldest':
      return { createdAt: 1, _id: 1 };
    case 'top':
      return { netScore: -1, _id: -1 };
    case 'replies':
      return { replyCount: -1, _id: -1 };
    case 'newest':
    default:
      return { createdAt: -1, _id: -1 };
  }
}

interface CursorPayload {
  // Primary sort field value (ISO date for newest/oldest, number for top/replies).
  v: string | number;
  // Last seen _id.
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed && (typeof parsed.v === 'string' || typeof parsed.v === 'number') && typeof parsed.id === 'string') {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

// Build the keyset "after this cursor" filter for the given sort.
export function cursorFilter(sort: CommentSort, cursor: CursorPayload): Record<string, unknown> {
  const id = new mongoose.Types.ObjectId(cursor.id);
  if (sort === 'oldest') {
    const v = new Date(cursor.v as string);
    return { $or: [{ createdAt: { $gt: v } }, { createdAt: v, _id: { $gt: id } }] };
  }
  if (sort === 'newest') {
    const v = new Date(cursor.v as string);
    return { $or: [{ createdAt: { $lt: v } }, { createdAt: v, _id: { $lt: id } }] };
  }
  // top | replies — descending on a numeric field.
  const field = sort === 'top' ? 'netScore' : 'replyCount';
  const v = cursor.v as number;
  return { $or: [{ [field]: { $lt: v } }, { [field]: v, _id: { $lt: id } }] };
}

// Cursor for the last item of a page, given the sort.
export function cursorFor(
  sort: CommentSort,
  last: { _id: unknown; createdAt: Date; netScore: number; replyCount: number },
): string {
  const id = String(last._id);
  if (sort === 'top') return encodeCursor({ v: last.netScore, id });
  if (sort === 'replies') return encodeCursor({ v: last.replyCount, id });
  return encodeCursor({ v: last.createdAt.toISOString(), id });
}

// Fetch the requester's votes across a set of comments.
export async function getUserVotes(
  userId: string | null | undefined,
  commentIds: mongoose.Types.ObjectId[],
): Promise<Map<string, 1 | -1>> {
  const map = new Map<string, 1 | -1>();
  if (!userId || commentIds.length === 0) return map;
  const votes = await CommentVote.find({ userId, commentId: { $in: commentIds } })
    .select('commentId vote')
    .lean();
  for (const v of votes) map.set(String(v.commentId), v.vote as 1 | -1);
  return map;
}
