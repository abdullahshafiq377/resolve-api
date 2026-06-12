import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { listPublic } from '../controllers/categories';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(listPublic));

export default router;
