import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { approveSummary, generateSummary, getSummary, updateSummary } from '../../controllers/aiSummary';

const router = express.Router({ mergeParams: true });

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(getSummary));
router.post('/generate', wrap(generateSummary));
router.patch('/', wrap(updateSummary));
router.post('/approve', wrap(approveSummary));

export default router;
