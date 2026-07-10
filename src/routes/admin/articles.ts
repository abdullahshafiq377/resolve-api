import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import { uploadUrl, list, slugCheck, getAdminBySlug, create, update, remove } from '../../controllers/articles';
import aiSummaryRouter from './aiSummary';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// All admin article routes require moderator-or-above.
router.use(requireModerator);

// upload-url and slug-check must be registered before /:id to avoid being matched as an id.
router.post('/upload-url', wrap(uploadUrl));
router.get('/slug-check', wrap(slugCheck));
router.get('/slug/:slug', wrap(getAdminBySlug));
router.get('/', wrap(list)); // full filter set (any status, drafts, etc.)
router.post('/', wrap(create));
router.use('/:id/ai-summary', aiSummaryRouter);
router.put('/:id', wrap(update));
router.delete('/:id', wrap(remove));

export default router;
