import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  archive,
  getById,
  getGeneric,
  getPreferences,
  latest,
  putPreferences,
} from '../controllers/brief';
import { requireSignedIn, requireStandard } from '../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/preferences', requireSignedIn, wrap(getPreferences));
router.put('/preferences', requireSignedIn, wrap(putPreferences));
// Generic free brief: any signed-in user (Free included). Must precede '/:id'.
router.get('/generic', requireSignedIn, wrap(getGeneric));
router.get('/latest', requireStandard, wrap(latest));
router.get('/archive', requireStandard, wrap(archive));
router.get('/:id', requireStandard, wrap(getById));

export default router;
