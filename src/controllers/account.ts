import mongoose from 'mongoose';
import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import BriefRecipient from '../models/BriefRecipient';
import Comment from '../models/Comment';
import Conversation from '../models/Conversation';
import Poll from '../models/Poll';
import ReadingHistory from '../models/ReadingHistory';
import ResearchRequest from '../models/ResearchRequest';
import SavedArticle from '../models/SavedArticle';
import type { CommentParentType } from '../models/Comment';
import { parentPath } from '../services/comments/parents';
import { pakistanMonthWindow } from '../services/briefDates';
import { httpError } from '../utils/errors';

/**
 * GET /api/account/overview — the three counters on the account overview's
 * "your month with Resolve" card, for the current Pakistan calendar month.
 *
 * Plan name, price, renewal date and join date are NOT here: Clerk owns all of
 * them and the page reads them client-side, so this endpoint stays a pure
 * activity rollup.
 *
 * `aiConversations` counts persisted chat threads, and threads are only written
 * for Premium members — Free and Standard members therefore always read 0. That
 * is a known product gap, not a bug in this query (see FINDINGS.md).
 */
export async function overview(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const month = pakistanMonthWindow();
  const window = { $gte: month.start, $lt: month.end };

  const [briefsRead, aiConversations, requestsSubmitted] = await Promise.all([
    BriefRecipient.countDocuments({ clerkUserId: userId, deletedAt: null, readAt: window }),
    Conversation.countDocuments({ clerkUserId: userId, createdAt: window }),
    ResearchRequest.countDocuments({ submitterId: userId, createdAt: window }),
  ]);

  res.json({
    month: month.key,
    stats: { briefsRead, aiConversations, requestsSubmitted },
  });
}

// ── Activity section ───────────────────────────────────────────────────────
//
// The three panels on /account/activity. Each is a newest-first list the panel
// pages through with its own "Load more" button: `limit` + `offset`, and a
// `hasMore` flag so the button knows when to retire. `limit` is clamped so a
// hand-rolled query string cannot ask for the whole collection.
//
// Offset paging (rather than a cursor) is deliberate: these lists are short and
// only ever grow at the head, so the worst case of a row arriving mid-paging is
// one repeated entry, not a corrupted sequence.

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

function parseLimit(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function parseOffset(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Split an over-fetched page. Every list below asks for `limit + 1` rows; the
 * extra one never ships, it just proves there is another page.
 */
function paginate<T>(rows: T[], limit: number): { page: T[]; hasMore: boolean } {
  return { page: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Comment bodies are stored whole; the panel shows a single teasing line. */
const EXCERPT_MAX = 90;

function excerpt(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= EXCERPT_MAX) return clean;
  return `${clean.slice(0, EXCERPT_MAX).trimEnd()}…`;
}

interface ParentRef {
  title: string;
  slug: string;
}

/**
 * Resolve the parent surfaces for a batch of comments — one query per parent
 * collection rather than one per comment. Returns a `${parentType}:${id}` map;
 * a comment whose parent has since been deleted is simply absent from it.
 */
async function loadCommentParents(
  comments: { parentType: CommentParentType; parentId: mongoose.Types.ObjectId }[],
): Promise<Map<string, ParentRef>> {
  const byType: Record<CommentParentType, mongoose.Types.ObjectId[]> = {
    article: [],
    poll: [],
    researchRequest: [],
  };
  for (const c of comments) byType[c.parentType].push(c.parentId);

  const [articles, polls, requests] = await Promise.all([
    byType.article.length
      ? Article.find({ _id: { $in: byType.article } }).select('title slug').lean()
      : [],
    byType.poll.length
      ? Poll.find({ _id: { $in: byType.poll } }).select('question slug').lean()
      : [],
    byType.researchRequest.length
      ? ResearchRequest.find({ _id: { $in: byType.researchRequest } }).select('title slug').lean()
      : [],
  ]);

  const map = new Map<string, ParentRef>();
  for (const a of articles) map.set(`article:${String(a._id)}`, { title: a.title, slug: a.slug });
  for (const p of polls) map.set(`poll:${String(p._id)}`, { title: p.question, slug: p.slug });
  for (const r of requests) {
    map.set(`researchRequest:${String(r._id)}`, { title: r.title, slug: r.slug });
  }
  return map;
}

/**
 * GET /api/account/comments — the reader's own comments, newest first.
 *
 * Only `visible` comments are returned: a comment the reader deleted, or one a
 * moderator removed, is not theirs to link back to. Each row carries the parent
 * surface's title plus the same `#comment-<id>` deep link the notification feed
 * uses, so "View thread" lands on the comment itself.
 */
export async function activityComments(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const rows = await Comment.find({ authorId: userId, status: 'visible' })
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit + 1)
    .select('parentType parentId bodyText createdAt')
    .lean();

  const { page: comments, hasMore } = paginate(rows, limit);
  const parents = await loadCommentParents(comments);

  res.json({
    hasMore,
    data: comments.map((c) => {
      const parent = parents.get(`${c.parentType}:${String(c.parentId)}`);
      return {
        id: String(c._id),
        excerpt: excerpt(c.bodyText ?? ''),
        parentType: c.parentType,
        parentTitle: parent?.title ?? null,
        // Null when the parent is gone — the row still renders, without a link.
        link: parent ? `${parentPath(c.parentType, parent.slug)}#comment-${String(c._id)}` : null,
        createdAt: c.createdAt,
      };
    }),
  });
}

/**
 * GET /api/account/saved — the reader's saved articles, most recently saved
 * first. Rows whose article has since been unpublished or deleted are dropped
 * rather than rendered as dead links.
 */
export async function savedArticles(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const rows = await SavedArticle.find({ clerkUserId: userId })
    .sort({ createdAt: -1 })
    .skip(offset)
    .limit(limit + 1)
    .lean();

  // `hasMore` counts saves, not surviving rows: a page whose article has since
  // been unpublished renders short, and the next page still exists.
  const { page: saves, hasMore } = paginate(rows, limit);

  const articles = await Article.find({
    _id: { $in: saves.map((s) => s.articleId) },
    status: 'published',
  })
    .select('title slug category')
    .lean();
  const byId = new Map(articles.map((a) => [String(a._id), a]));

  res.json({
    hasMore,
    data: saves.flatMap((s) => {
      const article = byId.get(String(s.articleId));
      if (!article) return [];
      return [
        {
          id: String(s._id),
          articleId: String(s.articleId),
          title: article.title,
          slug: article.slug,
          category: article.category ?? null,
          savedAt: s.createdAt,
        },
      ];
    }),
  });
}

/** Shared guard for the two article-scoped writes below. */
async function requirePublishedArticle(id: unknown): Promise<mongoose.Types.ObjectId> {
  if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) {
    throw httpError(400, 'invalid_article_id');
  }
  const objectId = new mongoose.Types.ObjectId(id);
  const exists = await Article.exists({ _id: objectId, status: 'published' });
  if (!exists) throw httpError(404, 'article_not_found');
  return objectId;
}

/**
 * POST /api/account/saved — save an article. Idempotent: saving an article that
 * is already saved succeeds and leaves the original timestamp alone, so the
 * button can fire without the client tracking state first.
 */
export async function saveArticle(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const articleId = await requirePublishedArticle((req.body as { articleId?: unknown })?.articleId);
  await SavedArticle.updateOne(
    { clerkUserId: userId, articleId },
    { $setOnInsert: { clerkUserId: userId, articleId } },
    { upsert: true },
  );

  res.status(201).json({ saved: true });
}

/** DELETE /api/account/saved/:articleId — un-save. Also idempotent. */
export async function unsaveArticle(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const raw = req.params.articleId;
  if (!mongoose.Types.ObjectId.isValid(raw)) throw httpError(400, 'invalid_article_id');
  await SavedArticle.deleteOne({ clerkUserId: userId, articleId: new mongoose.Types.ObjectId(raw) });

  res.json({ saved: false });
}

/**
 * GET /api/account/saved/ids — the saved-article id set, for the article page's
 * save toggle. Deliberately separate from the list above: the toggle needs one
 * cheap membership check, not titles and categories.
 */
export async function savedArticleIds(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const saves = await SavedArticle.find({ clerkUserId: userId }).select('articleId').lean();
  res.json({ data: saves.map((s) => String(s.articleId)) });
}

/**
 * GET /api/account/reading-history — most recently read first, one row per
 * article. Unpublished/deleted articles are dropped, as in the saved list.
 */
export async function readingHistory(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const limit = parseLimit(req.query.limit);
  const offset = parseOffset(req.query.offset);
  const found = await ReadingHistory.find({ clerkUserId: userId })
    .sort({ lastReadAt: -1 })
    .skip(offset)
    .limit(limit + 1)
    .lean();

  const { page: rows, hasMore } = paginate(found, limit);

  const articles = await Article.find({
    _id: { $in: rows.map((r) => r.articleId) },
    status: 'published',
  })
    .select('title slug category')
    .lean();
  const byId = new Map(articles.map((a) => [String(a._id), a]));

  res.json({
    hasMore,
    data: rows.flatMap((r) => {
      const article = byId.get(String(r.articleId));
      if (!article) return [];
      return [
        {
          id: String(r._id),
          articleId: String(r.articleId),
          title: article.title,
          slug: article.slug,
          category: article.category ?? null,
          readAt: r.lastReadAt,
        },
      ];
    }),
  });
}

/**
 * POST /api/account/reading-history — record a read. Re-reading an article
 * bumps its existing row instead of adding another, so the panel stays one line
 * per article. The article page only calls this for an unlocked view.
 */
export async function recordReadingHistory(req: Request, res: Response) {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');

  const articleId = await requirePublishedArticle((req.body as { articleId?: unknown })?.articleId);
  await ReadingHistory.updateOne(
    { clerkUserId: userId, articleId },
    {
      $set: { lastReadAt: new Date() },
      $inc: { readCount: 1 },
      $setOnInsert: { clerkUserId: userId, articleId },
    },
    // Defaults off on insert: `readCount` is owned by the $inc above, and
    // letting Mongoose also $setOnInsert it would collide on the same path.
    { upsert: true, setDefaultsOnInsert: false },
  );

  res.status(204).end();
}
