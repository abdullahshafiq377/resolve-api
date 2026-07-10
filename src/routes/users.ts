import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { mentionRateLimit } from '../middleware/commentRateLimit';
import { mentionSearch } from '../controllers/comments';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// @mention autocomplete (signed-in; comment-ban checked in-controller).
router.get('/mentions', requireSignedIn, requireNotBanned, mentionRateLimit, wrap(mentionSearch));

export default router;
