import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  articlesPublishDue,
  billingTierReconcile,
  briefEmailDispatch,
  resolveBrief,
} from '../controllers/cron';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.post('/resolve-brief', wrap(resolveBrief));
router.post('/articles-publish-due', wrap(articlesPublishDue));
router.post('/brief-email-dispatch', wrap(briefEmailDispatch));
router.post('/billing-tier-reconcile', wrap(billingTierReconcile));

export default router;
