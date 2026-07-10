import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import {
  listPolls,
  createPoll,
  getPoll,
  updatePoll,
  publishPoll,
  cancelSchedule,
  closePoll,
  setFeatured,
  metrics,
  deletePoll,
} from '../../controllers/admin/polls';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireModerator);

router.get('/', wrap(listPolls));
router.post('/', wrap(createPoll));
router.get('/:id/metrics', wrap(metrics));
router.get('/:id', wrap(getPoll));
router.patch('/:id', wrap(updatePoll));
router.post('/:id/publish', wrap(publishPoll));
router.post('/:id/cancel-schedule', wrap(cancelSchedule));
router.post('/:id/close', wrap(closePoll));
router.patch('/:id/featured', wrap(setFeatured));
router.delete('/:id', wrap(deletePoll));

export default router;
