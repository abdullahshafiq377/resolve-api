import type { Request, Response } from 'express';
import Article from '../models/Article';
import { parseBriefDate } from '../services/briefDates';
import { generateGenericBrief } from '../services/briefGeneric';
import { processBriefGenerationBatch } from '../services/resolveBriefGeneration';
import { syncArticleEmbeddings } from '../services/articleEmbeddings';
import { httpError } from '../utils/errors';

function assertCron(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw httpError(500, 'cron_secret_not_configured');
  const header = req.header('authorization') || '';
  if (header !== `Bearer ${secret}`) throw httpError(403, 'forbidden');
}

export async function resolveBrief(req: Request, res: Response) {
  assertCron(req);
  const briefDate = req.body?.date ? parseBriefDate(req.body.date) : undefined;
  const result = await processBriefGenerationBatch({
    briefDate,
    batchSize: req.body?.batchSize,
  });
  // Also ensure the shared generic free brief exists for the day (idempotent;
  // returns the existing segment if already generated). Both await admin
  // approval in the same briefs UI.
  const generic = await generateGenericBrief({ briefDate });
  res.json({ ...result, genericSegmentId: String(generic._id) });
}

/**
 * POST /api/cron/articles-publish-due
 *
 * Publishes every `scheduled` article whose `publishDate` has passed. Run it on
 * a short interval (a minute or two) — the sweep is idempotent, and an article
 * whose moment has not arrived is simply skipped.
 *
 * `publishDate` is left as the scheduled moment rather than restamped to now, so
 * the article goes live carrying the date the editor chose. Placement flags stay
 * cleared: scheduling strips them, and a moderator sets them after it is live.
 */
export async function articlesPublishDue(req: Request, res: Response) {
  assertCron(req);

  const due = await Article.find({ status: 'scheduled', publishDate: { $lte: new Date() } });

  const published: string[] = [];
  for (const article of due) {
    article.status = 'published';
    await article.save();
    // Only published articles carry RAG chunks, so index on the way in.
    await syncArticleEmbeddings(article);
    published.push(String(article._id));
  }

  res.json({ due: due.length, published: published.length, ids: published });
}
