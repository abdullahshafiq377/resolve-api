import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { postRateLimit, voteRateLimit, reportRateLimit } from '../middleware/commentRateLimit';
import {
  listComments,
  commentCount,
  createComment,
  editComment,
  deleteComment,
  voteComment,
  reportComment,
  banStatus,
} from '../controllers/comments';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Public reads (anonymous allowed; clerkAuth populates req.auth globally for userVote).
router.get('/', wrap(listComments));
router.get('/count', wrap(commentCount));
router.get('/ban-status', requireSignedIn, wrap(banStatus));

// Signed-in writes (Clerk-ban gated; commenting permissions enforced in-controller).
router.post('/', requireSignedIn, requireNotBanned, postRateLimit, wrap(createComment));
router.patch('/:id', requireSignedIn, requireNotBanned, postRateLimit, wrap(editComment));
router.delete('/:id', requireSignedIn, requireNotBanned, wrap(deleteComment));
router.put('/:id/vote', requireSignedIn, requireNotBanned, voteRateLimit, wrap(voteComment));
router.post('/:id/report', requireSignedIn, requireNotBanned, reportRateLimit, wrap(reportComment));

export default router;
