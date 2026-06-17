import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import chatRouter from './chat';
import adminRouter from './admin';
import categoriesRouter from './categories';
import researchRequestsRouter from './researchRequests';
import accountRouter from './account';
import notificationsRouter from './notifications';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/chat', chatRouter);
router.use('/research-requests', researchRequestsRouter);
router.use('/account', accountRouter);
router.use('/notifications', notificationsRouter);
router.use('/admin', adminRouter);

export default router;
