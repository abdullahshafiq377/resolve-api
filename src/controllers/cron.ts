import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Article from '../models/Article';
import { recordActivity } from '../services/activity';
import { reconcileTierSnapshots } from '../services/billingTiers';
import { parseBriefDate } from '../services/briefDates';
import { dispatchQueuedBriefEmails } from '../services/briefEmail';
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
    // No actor: the sweep publishes on the schedule an editor set earlier, so
    // the timeline attributes it to System.
    await recordActivity({
      entityType: 'article',
      entityId: article._id as mongoose.Types.ObjectId,
      action: 'auto_published',
      actorId: null,
      metadata: { from: 'scheduled', to: 'published', publishDate: article.publishDate?.toISOString() ?? null },
    });
    published.push(String(article._id));
  }

  res.json({ due: due.length, published: published.length, ids: published });
}

/**
 * POST /api/cron/brief-email-dispatch
 *
 * Sends the Brief to everyone still queued for it, across every approved segment
 * (`F-012`). Run it on a short interval — a minute or two — from the moment
 * approvals start: approval no longer sends anything itself, it only marks the
 * segment approved, so until this runs no reader gets mail.
 *
 * Idempotent and resumable. Each run works to a bounded email budget and stops;
 * `capped: true` in the response means there was more to send and the next run
 * will continue from the same place, so a large segment drains over several runs
 * instead of failing one long request. A run with an empty queue is a no-op.
 */
export async function briefEmailDispatch(req: Request, res: Response) {
  assertCron(req);
  const result = await dispatchQueuedBriefEmails({
    maxEmails: req.body?.maxEmails,
    maxRetries: req.body?.maxRetries,
  });
  res.json(result);
}

/**
 * POST /api/cron/billing-tier-reconcile
 *
 * Refreshes the oldest stale `User.planTier` snapshots. Run it hourly: each run
 * touches a bounded batch, so the Clerk Billing call rate stays flat instead of
 * spiking on a full-population recount. Idempotent — a run with nothing stale is
 * a no-op.
 */
export async function billingTierReconcile(req: Request, res: Response) {
  assertCron(req);
  const result = await reconcileTierSnapshots({
    batchSize: req.body?.batchSize,
    staleAfterHours: req.body?.staleAfterHours,
  });
  res.json(result);
}
