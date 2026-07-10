import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { accountSubmissions, accountUpvoted } from '../controllers/researchRequests';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/research-requests', requireSignedIn, requireNotBanned, wrap(accountSubmissions));
router.get(
  '/research-requests/upvoted',
  requireSignedIn,
  requireNotBanned,
  wrap(accountUpvoted),
);

export default router;
