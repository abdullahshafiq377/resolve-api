import { getAuth } from '@clerk/express';
import type { Request, Response } from 'express';
import Article from '../models/Article';
import ArticleSummary, { type ArticleSummaryDoc } from '../models/ArticleSummary';
import { httpError } from '../utils/errors';
import { generateAiSummary } from '../services/aiSummaryGeneration';
import { assertAiSummaryRateLimit } from '../services/aiSummaryRateLimit';
import { normalizeAiSummaryContent, normalizeAiSummaryFormat } from '../services/aiSummaryValidation';

function moderatorId(req: Request): string {
  return getAuth(req).userId || 'admin';
}

async function assertArticleExists(articleId: string) {
  const article = await Article.findById(articleId);
  if (!article) throw httpError(404, 'article_not_found');
  return article;
}

function serialize(summary: ArticleSummaryDoc | null) {
  if (!summary) return null;
  return {
    _id: String(summary._id),
    articleId: String(summary.articleId),
    format: summary.format,
    content: summary.content,
    model: summary.model,
    approved: summary.approved,
    approvedBy: summary.approvedBy,
    approvedAt: summary.approvedAt,
    generatedBy: summary.generatedBy,
    generatedAt: summary.generatedAt,
    lastEditedBy: summary.lastEditedBy,
    lastEditedAt: summary.lastEditedAt,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

export async function getSummary(req: Request, res: Response) {
  await assertArticleExists(req.params.id);
  const summary = await ArticleSummary.findOne({ articleId: req.params.id });
  res.json({ data: serialize(summary) });
}

export async function generateSummary(req: Request, res: Response) {
  const userId = moderatorId(req);
  assertAiSummaryRateLimit(userId);
  const format = normalizeAiSummaryFormat(req.body?.format);
  const article = await assertArticleExists(req.params.id);
  const generated = await generateAiSummary(article, format);
  const now = new Date();

  const summary = await ArticleSummary.findOneAndUpdate(
    { articleId: article._id },
    {
      $set: {
        articleId: article._id,
        format,
        content: generated.content,
        model: generated.model,
        approved: false,
        approvedBy: null,
        approvedAt: null,
        generatedBy: userId,
        generatedAt: now,
        lastEditedBy: userId,
        lastEditedAt: now,
      },
    },
    { new: true, upsert: true, runValidators: true },
  );

  res.json({ data: serialize(summary) });
}

export async function updateSummary(req: Request, res: Response) {
  const userId = moderatorId(req);
  await assertArticleExists(req.params.id);
  const summary = await ArticleSummary.findOne({ articleId: req.params.id });
  if (!summary) throw httpError(404, 'summary_not_found');

  const format = normalizeAiSummaryFormat(req.body?.format);
  const content = normalizeAiSummaryContent(format, req.body?.content);
  summary.format = format;
  summary.content = content;
  summary.approved = false;
  summary.approvedBy = null;
  summary.approvedAt = null;
  summary.lastEditedBy = userId;
  summary.lastEditedAt = new Date();
  await summary.save();

  res.json({ data: serialize(summary) });
}

export async function approveSummary(req: Request, res: Response) {
  const userId = moderatorId(req);
  await assertArticleExists(req.params.id);
  const summary = await ArticleSummary.findOne({ articleId: req.params.id });
  if (!summary) throw httpError(404, 'summary_not_found');

  summary.content = normalizeAiSummaryContent(summary.format, summary.content);
  summary.approved = true;
  summary.approvedBy = userId;
  summary.approvedAt = new Date();
  await summary.save();

  res.json({ data: serialize(summary) });
}
