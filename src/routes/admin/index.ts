import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import usersRouter from './users';
import categoriesRouter from './categories';
import regionsRouter from './regions';
import briefsRouter from './briefs';
import contactMessagesRouter from './contactMessages';

const router = express.Router();

router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/regions', regionsRouter);
router.use('/briefs', briefsRouter);
router.use('/contact-messages', contactMessagesRouter);
router.use('/users', usersRouter);

export default router;
