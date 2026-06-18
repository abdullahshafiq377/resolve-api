import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import usersRouter from './users';
import categoriesRouter from './categories';
import researchRequestsRouter from './researchRequests';
import pollsRouter from './polls';

const router = express.Router();

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/users', usersRouter);
router.use('/research-requests', researchRequestsRouter);
router.use('/polls', pollsRouter);

export default router;
