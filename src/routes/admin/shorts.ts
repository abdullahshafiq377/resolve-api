import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireModerator } from '../../middleware/auth';
import {
  uploadUrl,
  list,
  getById,
  create,
  update,
  archive,
  permanentRemove,
} from '../../controllers/admin/shorts';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// All admin shorts routes require moderator-or-above.
router.use(requireModerator);

// /upload-url must be registered before /:id to avoid Express treating the literal as an ID.
router.post('/upload-url', wrap(uploadUrl));
router.get('/', wrap(list));
router.get('/:id', wrap(getById));
router.post('/', wrap(create));
router.patch('/:id', wrap(update));
// /permanent must be registered before /:id for the same reason.
router.delete('/:id/permanent', wrap(permanentRemove));
router.delete('/:id', wrap(archive));

export default router;
