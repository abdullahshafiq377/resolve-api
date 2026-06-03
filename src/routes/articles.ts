import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { listPublished, getPublishedBySlug } from '../controllers/articles';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Public, read-only. Listing forces status=published; detail 404s unless published.
// Admin/authoring endpoints moved to /api/admin/articles (requireModerator).
router.get('/', wrap(listPublished));
router.get('/:slug', wrap(getPublishedBySlug));

export default router;
