import crypto from 'crypto';
import mongoose from 'mongoose';
import Article, { ArticleDoc } from '../models/Article';
import BriefGenerationRun from '../models/BriefGenerationRun';
import BriefPreference, { BriefPreferenceDoc } from '../models/BriefPreference';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment, { BriefStory } from '../models/BriefSegment';
import Category from '../models/Category';
import Region from '../models/Region';
import { extractPlainText } from '../lib/articleText';
import { generateText } from '../lib/gemini';
import { httpError } from '../utils/errors';
import { defaultArticleWindow, getPakistanDateString } from './briefDates';
import { getBriefPremiumEligibility } from './briefPremium';
import { getGlobalRegion, GLOBAL_REGION_SLUG } from './regions';

const SIGNATURE_VERSION = 1;
const DEFAULT_BATCH_SIZE = Math.max(1, Number(process.env.RESOLVE_BRIEF_BATCH_SIZE) || 100);
const LOCK_MS = 10 * 60 * 1000;

interface Candidate {
  preference: BriefPreferenceDoc;
  signatureHash: string;
  categoryIds: string[];
  regionIds: string[];
}

interface SegmentDraft {
  headlineSummary: string;
  stories: BriefStory[];
  editorialNote: string | null;
  generationStatus: 'generated' | 'failed' | 'manual';
  generationError: string | null;
}

function asIdStrings(ids: mongoose.Types.ObjectId[]): string[] {
  return ids.map(String).sort();
}

function signatureHash(input: {
  briefDate: string;
  categoryIds: string[];
  regionIds: string[];
  articleWindowStart: Date;
  articleWindowEnd: Date;
}): string {
  const json = JSON.stringify({
    version: SIGNATURE_VERSION,
    briefDate: input.briefDate,
    categoryIds: input.categoryIds,
    regionIds: input.regionIds,
    articleWindowStart: input.articleWindowStart.toISOString(),
    articleWindowEnd: input.articleWindowEnd.toISOString(),
  });
  return crypto.createHash('sha256').update(json).digest('hex');
}

function articleUrl(article: ArticleDoc): string {
  return `/articles/${article.slug}`;
}

async function articleQuery(
  categoryIds: string[],
  regionIds: string[],
  start: Date,
  end: Date,
  dropRegionFilter: boolean,
) {
  const global = await getGlobalRegion();
  const includesGlobal = regionIds.includes(String(global._id));
  const filter: Record<string, unknown> = {
    status: 'published',
    categoryId: { $in: categoryIds },
    publishDate: { $gte: start, $lte: end },
  };
  if (!dropRegionFilter && !includesGlobal) filter.regionIds = { $in: regionIds };
  return Article.find(filter).sort({ publishDate: -1, createdAt: -1 }).limit(7);
}

async function selectArticles(
  categoryIds: string[],
  regionIds: string[],
  start: Date,
  end: Date,
): Promise<{ articles: ArticleDoc[]; warning: string | null }> {
  let articles = await articleQuery(categoryIds, regionIds, start, end, false);
  if (articles.length >= 5) return { articles, warning: null };

  const fortyEight = new Date(end.getTime() - 48 * 60 * 60 * 1000);
  articles = await articleQuery(categoryIds, regionIds, fortyEight, end, false);
  if (articles.length >= 5) return { articles, warning: null };

  articles = await articleQuery(categoryIds, regionIds, fortyEight, end, true);
  if (articles.length >= 5) return { articles, warning: 'region_filter_relaxed' };

  const seventyTwo = new Date(end.getTime() - 72 * 60 * 60 * 1000);
  articles = await articleQuery(categoryIds, regionIds, seventyTwo, end, true);
  return {
    articles,
    warning: articles.length < 5 ? `only_${articles.length}_source_articles` : 'region_filter_relaxed',
  };
}

function fallbackDraft(articles: ArticleDoc[], warning: string | null): SegmentDraft {
  return {
    headlineSummary:
      articles.length > 0
        ? `Today's Brief follows ${articles.length} key ${articles.length === 1 ? 'story' : 'stories'} from Resolve's latest reporting.`
        : 'No matching Resolve stories were available for this Brief segment.',
    stories: articles.slice(0, 7).map((article, index) => ({
      articleId: article._id as mongoose.Types.ObjectId,
      headline: article.title,
      summary: article.excerpt,
      url: articleUrl(article),
      order: index + 1,
    })),
    editorialNote: null,
    generationStatus: warning ? 'failed' : 'manual',
    generationError: warning,
  };
}

function parseGeminiJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(trimmed);
}

async function generateDraft(
  briefDate: string,
  categoryIds: string[],
  regionIds: string[],
  articles: ArticleDoc[],
  warning: string | null,
): Promise<SegmentDraft> {
  if (articles.length === 0) return fallbackDraft(articles, warning);

  try {
    const [categories, regions] = await Promise.all([
      Category.find({ _id: { $in: categoryIds } }),
      Region.find({ _id: { $in: regionIds } }),
    ]);
    const articlePayload = articles.map((article) => ({
      id: String(article._id),
      title: article.title,
      excerpt: article.excerpt,
      url: articleUrl(article),
      publishDate: article.publishDate.toISOString(),
      bodyExcerpt: extractPlainText(article.body).slice(0, 1800),
    }));
    const raw = await generateText({
      systemPrompt:
        'You are an editor for Resolve. Return only valid JSON for The Resolve Brief. Keep summaries concise, neutral, and premium-newsroom quality.',
      message: JSON.stringify({
        briefDate,
        categories: categories.map((category) => category.title),
        regions: regions.map((region) => region.slug === GLOBAL_REGION_SLUG ? 'Global' : region.title),
        instruction:
          'Create a 3-5 minute daily brief with a 1-2 sentence headlineSummary, 5-7 stories when supplied, and an optional editorialNote.',
        requiredShape: {
          headlineSummary: 'string',
          stories: [{ articleId: 'string', headline: 'string', summary: 'string', url: 'string' }],
          editorialNote: 'string or null',
        },
        articles: articlePayload,
      }),
    });
    const parsed = parseGeminiJson(raw) as {
      headlineSummary?: unknown;
      stories?: { articleId?: unknown; headline?: unknown; summary?: unknown; url?: unknown }[];
      editorialNote?: unknown;
    };
    if (typeof parsed.headlineSummary !== 'string' || !Array.isArray(parsed.stories)) {
      throw new Error('invalid_gemini_shape');
    }
    const articleMap = new Map(articles.map((article) => [String(article._id), article]));
    const stories = parsed.stories
      .map((story, index) => {
        const source = typeof story.articleId === 'string' ? articleMap.get(story.articleId) : null;
        if (!source || typeof story.headline !== 'string' || typeof story.summary !== 'string') return null;
        return {
          articleId: source._id as mongoose.Types.ObjectId,
          headline: story.headline.trim() || source.title,
          summary: story.summary.trim() || source.excerpt,
          url: typeof story.url === 'string' && story.url ? story.url : articleUrl(source),
          order: index + 1,
        };
      })
      .filter((story): story is BriefStory => Boolean(story))
      .slice(0, 7);
    if (stories.length === 0) throw new Error('no_valid_gemini_stories');
    return {
      headlineSummary: parsed.headlineSummary.trim(),
      stories,
      editorialNote: typeof parsed.editorialNote === 'string' ? parsed.editorialNote.trim() : null,
      generationStatus: warning ? 'failed' : 'generated',
      generationError: warning,
    };
  } catch (err) {
    const fallback = fallbackDraft(articles, warning || 'gemini_generation_failed');
    fallback.generationError = err instanceof Error ? err.message.slice(0, 500) : fallback.generationError;
    return fallback;
  }
}

async function validatePreference(preference: BriefPreferenceDoc): Promise<boolean> {
  if (!preference.enabled || !preference.onboardingCompleted) return false;
  if (preference.categoryIds.length === 0 || preference.regionIds.length === 0) return false;
  const [categoryCount, regionCount] = await Promise.all([
    Category.countDocuments({ _id: { $in: preference.categoryIds }, active: true }),
    Region.countDocuments({ _id: { $in: preference.regionIds }, active: true }),
  ]);
  return categoryCount === preference.categoryIds.length && regionCount === preference.regionIds.length;
}

async function acquireRun(briefDate: string) {
  const now = new Date();
  const window = defaultArticleWindow(now);
  await BriefGenerationRun.findOneAndUpdate(
    { briefDate },
    {
      $setOnInsert: {
        briefDate,
        status: 'running',
        articleWindowStart: window.start,
        articleWindowEnd: window.end,
        startedAt: now,
      },
    },
    { upsert: true, new: true },
  );

  const lockToken = crypto.randomUUID();
  const lockUntil = new Date(now.getTime() + LOCK_MS);
  const run = await BriefGenerationRun.findOneAndUpdate(
    {
      briefDate,
      status: { $ne: 'completed' },
      $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }, { lockToken: null }],
    },
    { $set: { lockToken, lockUntil, status: 'running' } },
    { new: true },
  );
  if (!run) {
    const existing = await BriefGenerationRun.findOne({ briefDate });
    if (existing?.status === 'completed') return { run: existing, lockToken: null };
    throw httpError(423, 'brief_generation_locked');
  }
  return { run, lockToken };
}

export async function processBriefGenerationBatch(input: {
  briefDate?: string;
  batchSize?: number;
}): Promise<{
  run: Record<string, unknown>;
  batch: { processed: number; eligible: number; skipped: number; failed: number; hasMore: boolean };
}> {
  const briefDate = input.briefDate || getPakistanDateString();
  const batchSize = Math.max(1, Math.min(500, input.batchSize || DEFAULT_BATCH_SIZE));
  const { run, lockToken } = await acquireRun(briefDate);
  if (!lockToken) {
    return {
      run: run.toObject() as unknown as Record<string, unknown>,
      batch: { processed: 0, eligible: 0, skipped: 0, failed: 0, hasMore: false },
    };
  }

  let processed = 0;
  let eligible = 0;
  let skipped = 0;
  let failed = 0;
  let createdSegments = 0;
  let reusedSegments = 0;
  let createdRecipients = 0;

  try {
    const query: Record<string, unknown> = {
      enabled: true,
      onboardingCompleted: true,
      deletedAt: null,
    };
    if (run.lastPreferenceId) query._id = { $gt: run.lastPreferenceId };
    const preferences = await BriefPreference.find(query).sort({ _id: 1 }).limit(batchSize);
    const candidates: Candidate[] = [];

    for (const preference of preferences) {
      processed += 1;
      const existingRecipient = await BriefRecipient.exists({
        clerkUserId: preference.clerkUserId,
        briefDate,
      });
      if (existingRecipient || !(await validatePreference(preference))) {
        skipped += 1;
        continue;
      }
      const eligibility = await getBriefPremiumEligibility(preference.clerkUserId);
      if (!eligibility.eligible) {
        if (eligibility.reason === 'clerk_error') failed += 1;
        else skipped += 1;
        continue;
      }
      const categoryIds = asIdStrings(preference.categoryIds);
      const regionIds = asIdStrings(preference.regionIds);
      eligible += 1;
      candidates.push({
        preference,
        categoryIds,
        regionIds,
        signatureHash: signatureHash({
          briefDate,
          categoryIds,
          regionIds,
          articleWindowStart: run.articleWindowStart,
          articleWindowEnd: run.articleWindowEnd,
        }),
      });
    }

    const bySignature = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const list = bySignature.get(candidate.signatureHash) ?? [];
      list.push(candidate);
      bySignature.set(candidate.signatureHash, list);
    }

    for (const [hash, group] of bySignature) {
      const first = group[0];
      let segment = await BriefSegment.findOne({ briefDate, signatureHash: hash });
      if (!segment) {
        const { articles, warning } = await selectArticles(
          first.categoryIds,
          first.regionIds,
          run.articleWindowStart,
          run.articleWindowEnd,
        );
        const draft = await generateDraft(briefDate, first.categoryIds, first.regionIds, articles, warning);
        segment = await BriefSegment.create({
          briefDate,
          signatureHash: hash,
          signatureVersion: SIGNATURE_VERSION,
          categoryIds: first.categoryIds,
          regionIds: first.regionIds,
          articleWindowStart: run.articleWindowStart,
          articleWindowEnd: run.articleWindowEnd,
          sourceArticleIds: articles.map((article) => article._id),
          status: 'draft',
          headlineSummary: draft.headlineSummary,
          stories: draft.stories,
          editorialNote: draft.editorialNote,
          generationStatus: draft.generationStatus,
          generationError: draft.generationError,
          generatedAt: new Date(),
          generatedBy: 'system',
        });
        createdSegments += 1;
      } else {
        reusedSegments += 1;
      }

        const ops = group.map((candidate) => ({
          updateOne: {
            filter: { clerkUserId: candidate.preference.clerkUserId, briefDate },
            update: {
            $setOnInsert: {
              clerkUserId: candidate.preference.clerkUserId,
              briefDate,
              segmentId: segment!._id,
              preferenceSnapshot: {
                categoryIds: candidate.categoryIds,
                regionIds: candidate.regionIds,
                emailEnabled: candidate.preference.emailEnabled,
                enabled: candidate.preference.enabled,
              },
              emailEnabled: candidate.preference.emailEnabled,
              emailStatus: candidate.preference.emailEnabled ? ('pending' as const) : ('not_requested' as const),
            },
          },
          upsert: true,
        },
      }));
      if (ops.length > 0) {
        const result = await BriefRecipient.bulkWrite(ops as Parameters<typeof BriefRecipient.bulkWrite>[0], { ordered: false });
        createdRecipients += result.upsertedCount;
      }
    }

    const lastPreference = preferences[preferences.length - 1];
    const hasMore = preferences.length === batchSize;
    await BriefGenerationRun.updateOne(
      { _id: run._id, lockToken },
      {
        $inc: {
          processedCount: processed,
          eligibleCount: eligible,
          skippedCount: skipped,
          failedCount: failed,
          createdSegmentCount: createdSegments,
          reusedSegmentCount: reusedSegments,
          createdRecipientCount: createdRecipients,
        },
        $set: {
          ...(lastPreference ? { lastPreferenceId: lastPreference._id } : {}),
          status: hasMore ? 'running' : 'completed',
          completedAt: hasMore ? null : new Date(),
          lockToken: null,
          lockUntil: null,
          lastError: null,
        },
      },
    );

    const freshRun = await BriefGenerationRun.findById(run._id);
    return {
      run: freshRun!.toObject() as unknown as Record<string, unknown>,
      batch: { processed, eligible, skipped, failed, hasMore },
    };
  } catch (err) {
    await BriefGenerationRun.updateOne(
      { _id: run._id, lockToken },
      {
        $set: {
          status: 'failed',
          lockToken: null,
          lockUntil: null,
          lastError: err instanceof Error ? err.message.slice(0, 500) : 'generation_failed',
        },
      },
    );
    throw err;
  }
}

export async function regenerateSegment(segmentId: string, adminUserId: string) {
  const segment = await BriefSegment.findById(segmentId);
  if (!segment) throw httpError(404, 'not_found');
  const { articles, warning } = await selectArticles(
    asIdStrings(segment.categoryIds),
    asIdStrings(segment.regionIds),
    segment.articleWindowStart,
    segment.articleWindowEnd,
  );
  const draft = await generateDraft(
    segment.briefDate,
    asIdStrings(segment.categoryIds),
    asIdStrings(segment.regionIds),
    articles,
    warning,
  );
  segment.status = 'draft';
  segment.headlineSummary = draft.headlineSummary;
  segment.stories = draft.stories;
  segment.editorialNote = draft.editorialNote;
  segment.sourceArticleIds = articles.map((article) => article._id as mongoose.Types.ObjectId);
  segment.generationStatus = draft.generationStatus;
  segment.generationError = draft.generationError;
  segment.generatedAt = new Date();
  segment.generatedBy = adminUserId;
  segment.approvedAt = null;
  segment.approvedBy = null;
  segment.rejectedAt = null;
  segment.rejectedBy = null;
  segment.rejectionReason = null;
  await segment.save();
  return segment;
}
