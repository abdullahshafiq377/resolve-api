import type { Request, Response } from 'express';
import { parseBriefDate } from '../services/briefDates';
import { generateGenericBrief } from '../services/briefGeneric';
import { processBriefGenerationBatch } from '../services/resolveBriefGeneration';
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
