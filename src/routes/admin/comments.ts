import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import {
  listQueue,
  bulkModerate,
  listHeld,
  approveHeld,
  denyHeld,
  listReports,
  reportDetail,
  resolveReport,
  stats,
  listKeywords,
  addKeyword,
  updateKeyword,
  removeKeyword,
  bulkKeywords,
} from '../../controllers/admin/comments';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// All comment-moderation routes require moderator-or-above.
router.use(requireModerator);

router.get('/stats', wrap(stats));
// The unified moderation queue behind the admin table. Registered above the
// /:id routes so 'queue' and 'bulk' are never read as comment ids.
router.get('/queue', wrap(listQueue));
router.post('/bulk', wrap(bulkModerate));
router.get('/held', wrap(listHeld));
router.post('/:id/approve', wrap(approveHeld));
router.post('/:id/deny', wrap(denyHeld));
router.get('/reports', wrap(listReports));
router.get('/reports/:commentId', wrap(reportDetail));
router.post('/:id/resolve', wrap(resolveReport));

router.get('/keywords', wrap(listKeywords));
router.post('/keywords', wrap(addKeyword));
// Above /keywords/:id so 'bulk' is never read as a keyword id.
router.post('/keywords/bulk', wrap(bulkKeywords));
router.patch('/keywords/:id', wrap(updateKeyword));
router.delete('/keywords/:id', wrap(removeKeyword));

export default router;
