import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  approve,
  detail,
  generate,
  list,
  regenerate,
  reject,
  retryEmail,
  update,
} from '../../controllers/adminBriefs';
import { requireModerator } from '../../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireModerator);
router.get('/', wrap(list));
router.post('/generate', wrap(generate));
router.get('/:id', wrap(detail));
router.put('/:id', wrap(update));
router.post('/:id/approve', wrap(approve));
router.post('/:id/reject', wrap(reject));
router.post('/:id/regenerate', wrap(regenerate));
router.post('/:id/retry-email', wrap(retryEmail));

export default router;
