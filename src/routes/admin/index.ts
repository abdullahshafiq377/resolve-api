import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import usersRouter from './users';
import categoriesRouter from './categories';

const router = express.Router();

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/users', usersRouter);

export default router;
