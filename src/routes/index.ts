import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import chatRouter from './chat';
import adminRouter from './admin';
import categoriesRouter from './categories';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/chat', chatRouter);
router.use('/admin', adminRouter);

export default router;
