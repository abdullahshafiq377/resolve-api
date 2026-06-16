import type { Request, Response } from 'express';
import { parseBriefDate } from '../services/briefDates';
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
  const result = await processBriefGenerationBatch({
    briefDate: req.body?.date ? parseBriefDate(req.body.date) : undefined,
    batchSize: req.body?.batchSize,
  });
  res.json(result);
}
