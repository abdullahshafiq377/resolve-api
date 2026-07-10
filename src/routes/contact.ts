import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { createContactMessage } from '../controllers/contactMessages';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.post('/', wrap(createContactMessage));

export default router;
