import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { bulk, create, listAdmin, reassign, remove, update } from '../../controllers/categories';
import { requireModerator } from '../../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireModerator);
router.get('/', wrap(listAdmin));
router.post('/', wrap(create));
// /bulk must be registered before /:id so it is never read as an id.
router.post('/bulk', wrap(bulk));
// Move a category's content elsewhere, then deactivate or delete it.
router.post('/:id/reassign', wrap(reassign));
router.put('/:id', wrap(update));
router.delete('/:id', wrap(remove));

export default router;
