import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { resolveBrief } from '../controllers/cron';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.post('/resolve-brief', wrap(resolveBrief));

export default router;
