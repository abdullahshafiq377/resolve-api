import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import { queue, summary } from '../../controllers/admin/overview';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// The overview reports across every admin surface, so it needs the same gate.
router.use(requireModerator);

router.get('/', wrap(summary));
router.get('/queue', wrap(queue));

export default router;
