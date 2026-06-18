import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { publicPulseVoteRateLimit } from '../middleware/publicPulseRateLimit';
import {
  listActive,
  listRecent,
  listArchive,
  getOne,
  getResults,
  getMyVote,
  embeddedIn,
  vote,
  changeVote,
  notImplemented,
} from '../controllers/publicPulse';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(listActive));
router.get('/recent', wrap(listRecent));
router.get('/archive', wrap(listArchive));

router.get('/:slugOrId/results', wrap(getResults));
router.get('/:slugOrId/my-vote', requireSignedIn, wrap(getMyVote));
router.get('/:slugOrId/embedded-in', wrap(embeddedIn));
router.get('/:slugOrId', wrap(getOne));

router.post('/:slugOrId/vote', requireSignedIn, publicPulseVoteRateLimit, wrap(vote));
router.put('/:slugOrId/vote', requireSignedIn, publicPulseVoteRateLimit, wrap(changeVote));
router.delete('/:slugOrId/vote', requireSignedIn, wrap(notImplemented));

export default router;
