import NotificationPreference from '../../models/NotificationPreference';
import type { NotificationType } from '../../models/Notification';

export type NotificationPreferenceKey =
  | 'briefReady'
  | 'researchUpdates'
  | 'commentReplies'
  | 'weeklyNewsletter';

/**
 * Which account switch governs which notification type.
 *
 * This is an allowlist on purpose: a type absent from the map is always
 * delivered. Only the three in-product switches the Notifications section
 * actually offers appear here, so nothing a member has not been given a control
 * for can be silently withheld from them.
 *
 * Deliberately NOT mapped, and never suppressed:
 * - moderation and ban outcomes (`comment_removed`, `comment_banned`, …) — a
 *   member has to be told their comment was acted on, and someone who has just
 *   been moderated is exactly the person who would mute the channel;
 * - reports (`report_*`) — the same, from the reporter's side;
 * - billing and security (`payment_failed`, `security_updated`, …) — these are
 *   account-integrity messages, not preferences;
 * - `request_submitted` — the receipt for an action the member just took, which
 *   reads as a failed submission if it goes missing;
 * - `comment_mention` — the switch is labelled "Comment replies"; muting
 *   mentions on the strength of it would be doing more than it says.
 *
 * `weeklyNewsletter` has no producer to gate — there is no weekly mailing yet
 * (see FINDINGS.md), so the key exists here only to name the full set.
 */
export const PREFERENCE_BY_TYPE: Partial<Record<NotificationType, NotificationPreferenceKey>> = {
  // "Daily brief is ready" — the in-app ping only. Whether the brief is emailed
  // stays on BriefPreference.emailEnabled, per the NotificationPreference model.
  brief_ready: 'briefReady',

  // "Research request updates" — every newsroom-driven status change, to the
  // submitter and to upvoters, but not the submitter's own submission receipt.
  request_approved: 'researchUpdates',
  request_rejected: 'researchUpdates',
  request_under_consideration: 'researchUpdates',
  request_being_investigated: 'researchUpdates',
  request_published: 'researchUpdates',
  request_not_pursued: 'researchUpdates',
  request_supported_published: 'researchUpdates',

  // "Comment replies".
  comment_reply: 'commentReplies',
};

/**
 * Whether this member has turned this notification type off.
 *
 * Defaults to delivering: an unmapped type, a member with no preference row, and
 * a failed lookup all return false. Notifications are best-effort but a missed
 * one is a product failure, so the fallback is to send.
 */
export async function isMuted(userId: string, type: NotificationType): Promise<boolean> {
  const key = PREFERENCE_BY_TYPE[type];
  if (!key) return false;
  try {
    const row = await NotificationPreference.findOne(
      { clerkUserId: userId, [key]: false },
      { _id: 1 },
    ).lean();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * The subset of `userIds` that has this type turned off, in one query — for
 * fan-outs, which would otherwise do a lookup per recipient.
 */
export async function mutedUserIds(
  userIds: string[],
  type: NotificationType,
): Promise<Set<string>> {
  const key = PREFERENCE_BY_TYPE[type];
  if (!key || userIds.length === 0) return new Set();
  try {
    const rows = await NotificationPreference.find(
      { clerkUserId: { $in: userIds }, [key]: false },
      { clerkUserId: 1 },
    ).lean();
    return new Set(rows.map((row) => row.clerkUserId));
  } catch {
    return new Set();
  }
}
