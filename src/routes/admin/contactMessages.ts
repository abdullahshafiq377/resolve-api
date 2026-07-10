import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { listAdminContactMessages } from '../../controllers/contactMessages';
import { requireModerator } from '../../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireModerator);
router.get('/', wrap(listAdminContactMessages));

export default router;
