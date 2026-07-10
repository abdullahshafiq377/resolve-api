import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import searchRouter from './search';
import chatRouter from './chat';
import adminRouter from './admin';
import categoriesRouter from './categories';
import researchRequestsRouter from './researchRequests';
import publicPulseRouter from './publicPulse';
import accountRouter from './account';
import notificationsRouter from './notifications';
import commentsRouter from './comments';
import usersRouter from './users';
import contactRouter from './contact';
import briefRouter from './brief';
import cronRouter from './cron';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/search', searchRouter);
router.use('/categories', categoriesRouter);
router.use('/contact', contactRouter);
router.use('/chat', chatRouter);
router.use('/research-requests', researchRequestsRouter);
router.use('/public-pulse', publicPulseRouter);
router.use('/account', accountRouter);
router.use('/notifications', notificationsRouter);
router.use('/comments', commentsRouter);
router.use('/users', usersRouter);
router.use('/brief', briefRouter);
router.use('/admin', adminRouter);
router.use('/cron', cronRouter);

export default router;
