import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { requireNotBanned } from '../middleware/requireNotBanned';
import { voteRateLimit } from '../middleware/researchRequestRateLimit';
import {
  listPublic,
  getBySlug,
  sidebarPreview,
  submit,
  deleteOwn,
  upvote,
  retractVote,
  getByArticle,
} from '../controllers/researchRequests';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Public reads (anonymous allowed; clerkAuth populates req.auth globally).
router.get('/', wrap(listPublic));
router.get('/sidebar-preview', wrap(sidebarPreview));
router.get('/by-article/:articleId', wrap(getByArticle));
router.get('/:slug', wrap(getBySlug));

// Signed-in writes (rejected for banned users).
router.post('/', requireSignedIn, requireNotBanned, wrap(submit));
router.delete('/:id', requireSignedIn, requireNotBanned, wrap(deleteOwn));
router.post('/:id/upvote', requireSignedIn, requireNotBanned, voteRateLimit, wrap(upvote));
router.delete('/:id/upvote', requireSignedIn, requireNotBanned, voteRateLimit, wrap(retractVote));

export default router;
