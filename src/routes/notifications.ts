import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { listNotifications, markRead } from '../controllers/notifications';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', requireSignedIn, requireNotBanned, wrap(listNotifications));
router.post('/mark-read', requireSignedIn, requireNotBanned, wrap(markRead));

export default router;
