import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { validate } from '../middleware/validate';
import {
  accountAllowance,
  accountSubmissions,
  accountUpvoted,
} from '../controllers/researchRequests';
import {
  activityComments,
  overview,
  readingHistory,
  recordReadingHistory,
  saveArticle,
  savedArticleIds,
  savedArticles,
  unsaveArticle,
} from '../controllers/account';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from '../controllers/notificationPreferences';
import { updateNotificationPreferencesSchema } from '../schemas/notificationPreference';
import { articleRefSchema } from '../schemas/accountActivity';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/overview', requireSignedIn, requireNotBanned, wrap(overview));
router.get('/research-requests', requireSignedIn, requireNotBanned, wrap(accountSubmissions));
router.get(
  '/research-requests/allowance',
  requireSignedIn,
  requireNotBanned,
  wrap(accountAllowance),
);
router.get(
  '/research-requests/upvoted',
  requireSignedIn,
  requireNotBanned,
  wrap(accountUpvoted),
);
router.get(
  '/notification-preferences',
  requireSignedIn,
  requireNotBanned,
  wrap(getNotificationPreferences),
);
router.patch(
  '/notification-preferences',
  requireSignedIn,
  requireNotBanned,
  validate(updateNotificationPreferencesSchema),
  wrap(updateNotificationPreferences),
);

// ── Activity section ───────────────────────────────────────────────────────
// `/saved/ids` is declared before `/saved/:articleId` so the literal path wins.
router.get('/comments', requireSignedIn, requireNotBanned, wrap(activityComments));
router.get('/saved', requireSignedIn, requireNotBanned, wrap(savedArticles));
router.get('/saved/ids', requireSignedIn, requireNotBanned, wrap(savedArticleIds));
router.post(
  '/saved',
  requireSignedIn,
  requireNotBanned,
  validate(articleRefSchema),
  wrap(saveArticle),
);
router.delete('/saved/:articleId', requireSignedIn, requireNotBanned, wrap(unsaveArticle));
router.get('/reading-history', requireSignedIn, requireNotBanned, wrap(readingHistory));
router.post(
  '/reading-history',
  requireSignedIn,
  requireNotBanned,
  validate(articleRefSchema),
  wrap(recordReadingHistory),
);

export default router;
