import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { search } from '../controllers/search';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Public, read-only global search over published content.
router.get('/', wrap(search));

export default router;
