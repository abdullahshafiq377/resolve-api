import CommentBan from '../../models/CommentBan';

// Flip expired non-permanent, non-lifted bans to isActive: false. The hot-path
// ban check tests `activeUntil > now` directly, so correctness never depends on
// this running — it just keeps the `isActive` flag (and admin views) honest.
// Runs on a 5-minute cron (Render) via `npm run comments:ban-sweeper`.
export async function sweepExpiredCommentBans(now: Date = new Date()): Promise<number> {
  const res = await CommentBan.updateMany(
    { isActive: true, liftedAt: null, activeUntil: { $ne: null, $lte: now } },
    { $set: { isActive: false } },
  );
  return res.modifiedCount ?? 0;
}
