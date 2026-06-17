import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import { adminActionRateLimit } from '../../middleware/researchRequestRateLimit';
import {
  listQueue,
  getDetail,
  editRequest,
  approve,
  reject,
  changeStatus,
  linkArticle,
  unlinkArticle,
  listUpvoters,
  hardDelete,
} from '../../controllers/admin/researchRequests';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// All admin research-request routes require moderator-or-above.
router.use(requireModerator);

router.get('/', wrap(listQueue));
router.get('/:id', wrap(getDetail));
router.get('/:id/upvoters', wrap(listUpvoters));
router.patch('/:id', wrap(editRequest));
router.post('/:id/approve', adminActionRateLimit, wrap(approve));
router.post('/:id/reject', adminActionRateLimit, wrap(reject));
router.post('/:id/change-status', adminActionRateLimit, wrap(changeStatus));
router.post('/:id/link-article', wrap(linkArticle));
router.post('/:id/unlink-article', wrap(unlinkArticle));
// Hard delete is super-admin-only; enforced inside the controller.
router.delete('/:id', wrap(hardDelete));

export default router;
