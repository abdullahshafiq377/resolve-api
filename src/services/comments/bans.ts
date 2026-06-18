import CommentBan, { CommentBanDoc } from '../../models/CommentBan';

// Hot-path active-ban lookup. Tests `activeUntil > now` (or null = permanent)
// directly rather than trusting the `isActive` flag, so an expired-but-unswept
// ban never blocks. Returns the active ban doc (for the UI banner) or null.
export async function getActiveCommentBan(
  userId: string | null | undefined,
): Promise<CommentBanDoc | null> {
  if (!userId) return null;
  const now = new Date();
  return CommentBan.findOne({
    userId,
    liftedAt: null,
    $or: [{ activeUntil: null }, { activeUntil: { $gt: now } }],
  }).sort({ issuedAt: -1 });
}

export async function hasActiveCommentBan(userId: string | null | undefined): Promise<boolean> {
  return (await getActiveCommentBan(userId)) !== null;
}
