import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import NotificationPreference, {
  type NotificationPreferenceDoc,
} from '../models/NotificationPreference';
import type { UpdateNotificationPreferencesInput } from '../schemas/notificationPreference';
import { httpError } from '../utils/errors';

// Product default: everything on. A user who has never touched the section has
// no row, and reads/writes fall back to these rather than 404-ing.
const DEFAULTS = {
  briefReady: true,
  researchUpdates: true,
  commentReplies: true,
  weeklyNewsletter: true,
};

function serialize(doc: NotificationPreferenceDoc | null) {
  if (!doc) return { ...DEFAULTS };
  return {
    briefReady: doc.briefReady,
    researchUpdates: doc.researchUpdates,
    commentReplies: doc.commentReplies,
    weeklyNewsletter: doc.weeklyNewsletter,
  };
}

/** GET /api/account/notification-preferences */
export async function getNotificationPreferences(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const row = await NotificationPreference.findOne({ clerkUserId: userId });
  res.json({ preferences: serialize(row) });
}

/**
 * PATCH /api/account/notification-preferences — partial update. The page sends
 * only the switch that changed, so unsent keys keep their stored value (or the
 * default, on a first write).
 */
export async function updateNotificationPreferences(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const patch = req.body as UpdateNotificationPreferencesInput;
  const row = await NotificationPreference.findOneAndUpdate(
    { clerkUserId: userId },
    { $set: patch, $setOnInsert: { clerkUserId: userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  res.json({ preferences: serialize(row) });
}
