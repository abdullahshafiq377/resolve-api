import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { create, listAdmin, remove, update } from '../../controllers/categories';
import { requireModerator } from '../../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.use(requireModerator);
router.get('/', wrap(listAdmin));
router.post('/', wrap(create));
router.put('/:id', wrap(update));
router.delete('/:id', wrap(remove));

export default router;
