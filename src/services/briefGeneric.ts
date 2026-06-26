import mongoose from 'mongoose';
import BriefSegment, { BriefSegmentDoc } from '../models/BriefSegment';
import Category from '../models/Category';
import { defaultArticleWindow, getPakistanDateString } from './briefDates';
import { getGlobalRegion } from './regions';
import { generateDraft, selectArticles } from './resolveBriefGeneration';

// Sentinel signatureHash for the one shared free-tier brief per day. Real
// signatures are 64-char hex, so this never collides. The (briefDate,
// signatureHash) unique index keeps exactly one generic segment per day.
export const GENERIC_SIGNATURE_HASH = 'generic';

/**
 * Generate (once per day) the generic free brief — a single shared brief, the
 * same for everyone, drawn from the latest reporting across all active
 * categories (Global region). Reuses the personalised pipeline's article
 * selection + Gemini draft, stored as a `BriefSegment` with `isGeneric: true`
 * and no recipients. It flows through the existing admin approve/reject UI.
 *
 * Idempotent: if a generic segment already exists for the day it is returned
 * unchanged (so an approved brief is never silently clobbered — use the admin
 * regenerate endpoint for a redo).
 */
export async function generateGenericBrief(
  input: { briefDate?: string } = {},
): Promise<BriefSegmentDoc> {
  const now = new Date();
  const briefDate = input.briefDate ?? getPakistanDateString(now);

  const existing = await BriefSegment.findOne({
    briefDate,
    signatureHash: GENERIC_SIGNATURE_HASH,
  });
  if (existing) return existing;

  const window = defaultArticleWindow(now);
  const [categories, global] = await Promise.all([
    Category.find({ active: true }).select('_id'),
    getGlobalRegion(),
  ]);
  const categoryIds = categories.map((c) => String(c._id));
  const regionIds = [String(global._id)];

  const { articles, warning } = await selectArticles(
    categoryIds,
    regionIds,
    window.start,
    window.end,
  );
  const draft = await generateDraft(briefDate, categoryIds, regionIds, articles, warning);

  return BriefSegment.create({
    briefDate,
    signatureHash: GENERIC_SIGNATURE_HASH,
    signatureVersion: 1,
    categoryIds: categoryIds.map((id) => new mongoose.Types.ObjectId(id)),
    regionIds: regionIds.map((id) => new mongoose.Types.ObjectId(id)),
    articleWindowStart: window.start,
    articleWindowEnd: window.end,
    sourceArticleIds: articles.map((a) => a._id as mongoose.Types.ObjectId),
    isGeneric: true,
    status: 'draft',
    headlineSummary: draft.headlineSummary,
    stories: draft.stories,
    editorialNote: draft.editorialNote,
    generationStatus: draft.generationStatus,
    generationError: draft.generationError,
    generatedAt: new Date(),
    generatedBy: 'system',
  });
}
