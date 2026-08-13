import express from 'express';
import articlesRouter from './articles';
import shortsRouter from './shorts';
import usersRouter from './users';
import categoriesRouter from './categories';
import researchRequestsRouter from './researchRequests';
import pollsRouter from './polls';
import commentsRouter from './comments';
import regionsRouter from './regions';
import briefsRouter from './briefs';
import contactMessagesRouter from './contactMessages';
import overviewRouter from './overview';

const router = express.Router();

router.use('/overview', overviewRouter);
router.use('/articles', articlesRouter);
router.use('/shorts', shortsRouter);
router.use('/categories', categoriesRouter);
router.use('/regions', regionsRouter);
router.use('/briefs', briefsRouter);
router.use('/contact-messages', contactMessagesRouter);
router.use('/users', usersRouter);
router.use('/research-requests', researchRequestsRouter);
router.use('/polls', pollsRouter);
router.use('/comments', commentsRouter);

export default router;
