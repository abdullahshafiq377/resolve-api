import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import {
  listHeld,
  approveHeld,
  denyHeld,
  listReports,
  reportDetail,
  resolveReport,
  stats,
  listKeywords,
  addKeyword,
  removeKeyword,
} from '../../controllers/admin/comments';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// All comment-moderation routes require moderator-or-above.
router.use(requireModerator);

router.get('/stats', wrap(stats));
router.get('/held', wrap(listHeld));
router.post('/:id/approve', wrap(approveHeld));
router.post('/:id/deny', wrap(denyHeld));
router.get('/reports', wrap(listReports));
router.get('/reports/:commentId', wrap(reportDetail));
router.post('/:id/resolve', wrap(resolveReport));

router.get('/keywords', wrap(listKeywords));
router.post('/keywords', wrap(addKeyword));
router.delete('/keywords/:id', wrap(removeKeyword));

export default router;
