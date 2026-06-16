import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import chatRouter from './chat';
import adminRouter from './admin';
import categoriesRouter from './categories';
import briefRouter from './brief';
import cronRouter from './cron';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/chat', chatRouter);
router.use('/brief', briefRouter);
router.use('/admin', adminRouter);
router.use('/cron', cronRouter);

export default router;
