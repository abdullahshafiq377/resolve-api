import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { archive, getById, getPreferences, latest, putPreferences } from '../controllers/brief';
import { requirePremium, requireSignedIn } from '../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/preferences', requireSignedIn, wrap(getPreferences));
router.put('/preferences', requireSignedIn, wrap(putPreferences));
router.get('/latest', requirePremium, wrap(latest));
router.get('/archive', requirePremium, wrap(archive));
router.get('/:id', requirePremium, wrap(getById));

export default router;
