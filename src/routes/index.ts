import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import adminRouter from './admin';

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/admin', adminRouter);

export default router;
