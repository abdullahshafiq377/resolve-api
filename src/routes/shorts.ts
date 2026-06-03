import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { listFeatured, getBySlug, recordView } from '../controllers/shorts';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(listFeatured));
router.get('/:slug', wrap(getBySlug));
router.post('/:id/view', wrap(recordView));

export default router;
