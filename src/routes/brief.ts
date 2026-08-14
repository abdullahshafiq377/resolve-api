import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import {
  archive,
  getById,
  getGeneric,
  getPreferences,
  latest,
  markRead,
  putPreferences,
} from '../controllers/brief';
import { requirePremium, requireCore } from '../middleware/auth';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Tuning the Brief is Core+, the same bar as reading it ('/latest' below).
// Free readers were able to read and write these until now; the account screen
// shows them the locked panel instead and never calls this.
router.get('/preferences', requireCore, wrap(getPreferences));
router.put('/preferences', requireCore, wrap(putPreferences));
// Generic free brief: public. Signed-out readers see the same shared edition a
// Free member does (it carries no per-user data), so the landing hero can show
// the real Brief and prompt for sign-in on the actions instead. Must precede '/:id'.
router.get('/generic', wrap(getGeneric));
router.get('/latest', requireCore, wrap(latest));
// Archive + single past edition are Premium-only (doc §5). Core gets the
// daily personalised brief but not the back catalogue.
router.get('/archive', requirePremium, wrap(archive));
// Read receipt for any edition the member owns. Core+, matching who can
// open a brief at all — the archive's Premium gate does not apply, since today's
// edition is Core-readable.
router.post('/:id/read', requireCore, wrap(markRead));
router.get('/:id', requirePremium, wrap(getById));

export default router;
