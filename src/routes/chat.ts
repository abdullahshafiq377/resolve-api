import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireSignedIn } from '../middleware/auth';
import { chatRateLimit } from '../middleware/chatRateLimit';
import {
  postChat,
  getUsage,
  listConversations,
  getConversationDetail,
  renameConversation,
  deleteConversation,
} from '../controllers/chat';

const router = express.Router();

const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// All chat endpoints require any signed-in user (anonymous -> 401, overview §4).
router.use(requireSignedIn);

// Per-minute rate limit runs BEFORE the controller's daily-limit check (Phase 3).
router.post('/', chatRateLimit, wrap(postChat));
router.get('/usage', wrap(getUsage));

// Phase 3, premium-only. `/conversations` before `/conversations/:id`.
router.get('/conversations', wrap(listConversations));
router.get('/conversations/:id', wrap(getConversationDetail));
router.patch('/conversations/:id', wrap(renameConversation));
router.delete('/conversations/:id', wrap(deleteConversation));

export default router;
