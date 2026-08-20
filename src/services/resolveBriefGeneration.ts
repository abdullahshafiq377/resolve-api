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
import { generateText, ModelRefusalError, ModelTruncatedError } from '../lib/anthropic';
import { EDITORIAL_VOICE_PROMPT } from '../lib/editorialVoice';
import { httpError } from '../utils/errors';
import { defaultArticleWindow, getPakistanDateString } from './briefDates';
import { getBriefEligibility } from './briefPremium';
import { getGlobalRegion, GLOBAL_REGION_SLUG } from './regions';

// v2: the article window is no longer part of the signature. Segment identity is
// (briefDate + categories + regions) so a same-day re-generation with a refreshed
// window updates the same draft segment instead of orphaning it behind a new hash.
const SIGNATURE_VERSION = 2;
const DEFAULT_BATCH_SIZE = Math.max(1, Number(process.env.RESOLVE_BRIEF_BATCH_SIZE) || 100);
const LOCK_MS = 10 * 60 * 1000;

const BRIEF_MODEL = process.env.ANTHROPIC_BRIEF_MODEL || 'claude-sonnet-5';
// A multi-paragraph summary plus up to seven echoed stories. Well above what a
// brief actually needs; the cap only exists so a runaway generation cannot bill
// without limit, and hitting it raises ModelTruncatedError rather than producing
// half a brief.
const BRIEF_MAX_TOKENS = Math.max(1024, Number(process.env.ANTHROPIC_BRIEF_MAX_TOKENS) || 8_000);

interface Candidate {
  preference: BriefPreferenceDoc;
  signatureHash: string;
  categoryIds: string[];
  regionIds: string[];
}

interface SegmentDraft {
  title: string | null;
  summary: string | null;
  stories: BriefStory[];
  editorialNote: string | null;
  generationStatus: 'generated' | 'failed' | 'manual';
  generationError: string | null;
}

// Strict JSON contract. Constraining the output shape (rather than hoping a
// free-text prompt returns clean JSON) is what guarantees `title` and `summary`
// are always present — previously they silently came back empty.
//
// `additionalProperties: false` is mandatory on every object under structured
// outputs. `editorialNote` stays out of its `required` list, which is genuinely
// optional — verified against the live API rather than assumed, since the
// strict-mode convention elsewhere is to require everything and allow null.
// A story carries no `url`: the link is built from the article it names (F-017).
// The story-count rule (5-7) is not expressible: the size keywords are dropped,
// so it lives in the prompt and in the `.slice(0, 7)` below.
export const BRIEF_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          articleId: { type: 'string' },
          headline: { type: 'string' },
        },
        required: ['articleId', 'headline'],
        additionalProperties: false,
      },
    },
    editorialNote: { type: 'string' },
  },
  required: ['title', 'summary', 'stories'],
  additionalProperties: false,
};

function asIdStrings(ids: mongoose.Types.ObjectId[]): string[] {
  return ids.map(String).sort();
}

function signatureHash(input: {
  briefDate: string;
  categoryIds: string[];
  regionIds: string[];
}): string {
  const json = JSON.stringify({
    version: SIGNATURE_VERSION,
    briefDate: input.briefDate,
    categoryIds: input.categoryIds,
    regionIds: input.regionIds,
  });
  return crypto.createHash('sha256').update(json).digest('hex');
}

// The webapp serves `/article/[slug]` and nothing else — there has never been an
// `/articles` route — so every generated Brief story link was a 404: on the reader's
// brief, in the Brief email, and in the admin review screens (F-017). Stories added by
// hand through the admin picker go through the webapp's own `getArticleHref`, which was
// always right, which is what kept the split out of sight. Keep this in step with
// `getArticleHref` in `resolve-webapp/src/lib/articles-api.ts`.
function articleUrl(article: ArticleDoc): string {
  return `/article/${article.slug}`;
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

export async function selectArticles(
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

// A failed draft stores NO fabricated content — the brief is the AI synthesis, so
// if the model does not produce one we record the failure for the admin to see
// and regenerate, rather than inventing a placeholder. Approval is blocked while
// a segment has no title/summary (see controllers/adminBriefs.approve).
function failedDraft(error: string): SegmentDraft {
  return {
    title: null,
    summary: null,
    stories: [],
    editorialNote: null,
    generationStatus: 'failed',
    generationError: error,
  };
}

// Structured outputs pin the shape, so the fence-stripping should never fire.
// Kept as a fallback for the same reason as in aiSummaryGeneration: it is free,
// and it is the difference between a bad day and an outage if the constraint is
// ever relaxed.
function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(trimmed);
}

export async function generateDraft(
  briefDate: string,
  categoryIds: string[],
  regionIds: string[],
  articles: ArticleDoc[],
  warning: string | null,
): Promise<SegmentDraft> {
  if (articles.length === 0) return failedDraft('no_source_articles');

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
      publishDate: (article.publishDate ?? article.createdAt).toISOString(),
      bodyExcerpt: extractPlainText(article.body).slice(0, 1800),
    }));
    const raw = await generateText({
      model: BRIEF_MODEL,
      maxTokens: BRIEF_MAX_TOKENS,
      schema: BRIEF_RESPONSE_SCHEMA,
      systemPrompt: `You are an editor for Resolve, writing The Resolve Brief. Synthesise only the supplied articles. Keep the writing concise, neutral, and premium-newsroom quality.

${EDITORIAL_VOICE_PROMPT}`,
      message: JSON.stringify({
        briefDate,
        categories: categories.map((category) => category.title),
        regions: regions.map((region) => region.slug === GLOBAL_REGION_SLUG ? 'Global' : region.title),
        instruction:
          'Create a 3-5 minute daily morning brief: an original synthesis that orients the reader. ' +
          'Produce a short editorial `title` (the headline of the day, ~6-12 words) ' +
          'and a multi-paragraph `summary` that (1) recaps what has happened since yesterday and overnight, ' +
          '(2) explains why it matters and connects the threads of the developing story, and ' +
          '(3) looks ahead to what is scheduled or expected, framed as "expected", "due", or "watch for". ' +
          'Separate summary paragraphs with a blank line. ' +
          'Also include 5-7 `stories` selected from the supplied articles (echo back each `articleId` ' +
          'and its `headline`), and an optional `editorialNote`.',
        articles: articlePayload,
      }),
    });
    // An empty response means the model returned nothing — almost always an
    // exhausted/invalid API key or a quota error. (A safety decline is no longer
    // one of the causes: it arrives as ModelRefusalError, handled below.) Surface
    // that clearly instead of letting JSON.parse('') throw an opaque
    // "Unexpected end of input".
    if (!raw.trim()) throw new Error('model_empty_response (quota or invalid API key)');
    const parsed = parseModelJson(raw) as {
      title?: unknown;
      summary?: unknown;
      stories?: { articleId?: unknown; headline?: unknown }[];
      editorialNote?: unknown;
    };
    if (
      typeof parsed.title !== 'string' ||
      !parsed.title.trim() ||
      typeof parsed.summary !== 'string' ||
      !parsed.summary.trim() ||
      !Array.isArray(parsed.stories)
    ) {
      throw new Error('invalid_brief_shape');
    }
    const articleMap = new Map(articles.map((article) => [String(article._id), article]));
    const stories = parsed.stories
      .map((story, index) => {
        const source = typeof story.articleId === 'string' ? articleMap.get(story.articleId) : null;
        if (!source || typeof story.headline !== 'string') return null;
        return {
          articleId: source._id as mongoose.Types.ObjectId,
          headline: story.headline.trim() || source.title,
          // Derived from the article, never taken from the model. The model is handed
          // each article's url in the payload, so echoing it back looks harmless — but
          // it made the model a second author of a route, which is how the wrong prefix
          // reached rows the admin never touched (F-017). The link is ours to build.
          url: articleUrl(source),
          order: index + 1,
        };
      })
      .filter((story): story is BriefStory => Boolean(story))
      .slice(0, 7);
    if (stories.length === 0) throw new Error('no_valid_brief_stories');
    // A successful synthesis stands on its own. A `warning` (e.g. relaxed region
    // filter, thin source pool) is recorded for the admin but is NOT a failure.
    return {
      title: parsed.title.trim(),
      summary: parsed.summary.trim(),
      stories,
      editorialNote: typeof parsed.editorialNote === 'string' ? parsed.editorialNote.trim() : null,
      generationStatus: 'generated',
      generationError: warning,
    };
  } catch (err) {
    // The two model-level failures carry no useful message of their own, so name
    // them here — an admin reading `generationError` in the UI (it is rendered
    // raw) should be able to tell a safety decline from a truncated generation
    // without reading the code.
    let reason: string;
    if (err instanceof ModelRefusalError) reason = `brief_declined (${err.category ?? 'unspecified'})`;
    else if (err instanceof ModelTruncatedError) reason = 'brief_truncated (raise ANTHROPIC_BRIEF_MAX_TOKENS)';
    else reason = err instanceof Error ? err.message.slice(0, 500) : 'brief_generation_failed';
    console.warn('[resolve-brief] generation failed', { briefDate, categoryIds, regionIds, reason });
    return failedDraft(reason);
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
  // Acquire the lock on any run not currently held by a live worker. We no longer
  // exclude `completed` runs: clicking Generate again is a deliberate re-run.
  const run = await BriefGenerationRun.findOneAndUpdate(
    {
      briefDate,
      $or: [{ lockUntil: null }, { lockUntil: { $lte: now } }, { lockToken: null }],
    },
    { $set: { lockToken, lockUntil } },
    { new: true },
  );
  if (!run) throw httpError(423, 'brief_generation_locked');

  // A finished (completed/failed) run is reopened as a fresh pass: refresh the
  // article window to now and rewind the keyset cursor so newly-published
  // articles — and any new eligible users — are picked up. A run that is still
  // mid-batch (running, lock just expired) keeps its window/cursor so pagination
  // stays consistent.
  let refreshed = false;
  if (run.status === 'completed' || run.status === 'failed') {
    run.articleWindowStart = window.start;
    run.articleWindowEnd = window.end;
    run.lastPreferenceId = null;
    run.status = 'running';
    run.completedAt = null;
    run.lastError = null;
    await run.save();
    refreshed = true;
  }
  return { run, lockToken, refreshed };
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
  const { run, lockToken, refreshed } = await acquireRun(briefDate);

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
      // Note: we no longer skip users who already have a recipient for the day.
      // Recipient creation is an idempotent upsert ($setOnInsert) below, so
      // re-running is safe — and re-processing lets a refreshed pass update the
      // shared draft segment with newly-published articles.
      if (!(await validatePreference(preference))) {
        skipped += 1;
        continue;
      }
      const eligibility = await getBriefEligibility(preference.clerkUserId);
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
        signatureHash: signatureHash({ briefDate, categoryIds, regionIds }),
      });
    }

    const bySignature = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const list = bySignature.get(candidate.signatureHash) ?? [];
      list.push(candidate);
      bySignature.set(candidate.signatureHash, list);
    }

    const refreshedSegmentIds = new Set<string>();
    for (const [hash, group] of bySignature) {
      const first = group[0];
      let segment = await BriefSegment.findOne({ briefDate, signatureHash: hash });

      // Refresh an existing DRAFT segment when this is a reopened pass and its
      // window is older than the run's current window (i.e. new articles may
      // exist). Approved/rejected segments are never silently clobbered — use the
      // admin Regenerate action for those. Each segment is refreshed at most once
      // per run.
      const staleDraft =
        !!segment &&
        refreshed &&
        segment.status === 'draft' &&
        segment.articleWindowEnd.getTime() < run.articleWindowEnd.getTime() &&
        !refreshedSegmentIds.has(String(segment._id));

      if (!segment || staleDraft) {
        const { articles, warning } = await selectArticles(
          first.categoryIds,
          first.regionIds,
          run.articleWindowStart,
          run.articleWindowEnd,
        );
        const draft = await generateDraft(briefDate, first.categoryIds, first.regionIds, articles, warning);
        if (!segment) {
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
            title: draft.title,
            summary: draft.summary,
            stories: draft.stories,
            editorialNote: draft.editorialNote,
            generationStatus: draft.generationStatus,
            generationError: draft.generationError,
            generatedAt: new Date(),
            generatedBy: 'system',
          });
          createdSegments += 1;
        } else {
          // Atomic update (not load-modify-save): generateDraft above is a slow
          // model call, so a versioned save() here races concurrent writes and
          // throws a Mongoose VersionError. findByIdAndUpdate avoids the __v guard.
          const refreshed = await BriefSegment.findByIdAndUpdate(
            segment._id,
            {
              $set: {
                articleWindowStart: run.articleWindowStart,
                articleWindowEnd: run.articleWindowEnd,
                sourceArticleIds: articles.map((article) => article._id as mongoose.Types.ObjectId),
                title: draft.title,
                summary: draft.summary,
                stories: draft.stories,
                editorialNote: draft.editorialNote,
                generationStatus: draft.generationStatus,
                generationError: draft.generationError,
                generatedAt: new Date(),
              },
            },
            { new: true, runValidators: true },
          );
          if (refreshed) segment = refreshed;
          refreshedSegmentIds.add(String(segment._id));
          reusedSegments += 1;
        }
      } else {
        reusedSegments += 1;
      }

        const ops = group.map((candidate) => ({
          updateOne: {
            filter: { clerkUserId: candidate.preference.clerkUserId, briefDate },
            update: {
              // Re-point existing recipients at the current segment: on a refreshed
              // pass (or a changed-preference signature) the recipient must follow
              // the freshly generated segment, not stay stuck on the prior one.
              $set: {
                segmentId: segment!._id,
                preferenceSnapshot: {
                  categoryIds: candidate.categoryIds,
                  regionIds: candidate.regionIds,
                  emailEnabled: candidate.preference.emailEnabled,
                  enabled: candidate.preference.enabled,
                },
                emailEnabled: candidate.preference.emailEnabled,
              },
              $setOnInsert: {
                clerkUserId: candidate.preference.clerkUserId,
                briefDate,
                emailStatus: candidate.preference.emailEnabled ? 'pending' : 'not_requested',
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

    // `emailStatus` is only stamped on insert (see the $setOnInsert above), so a
    // recipient first created while email was OFF stays parked at 'not_requested'
    // even after the user enables email and we flip emailEnabled→true via $set.
    // The send step ignores 'not_requested', so those users would silently never
    // be emailed. Promote them to 'pending' here (never touching already
    // sent/failed/pending rows) so a re-generation actually picks up the change.
    const emailEnabledUserIds = candidates
      .filter((candidate) => candidate.preference.emailEnabled)
      .map((candidate) => candidate.preference.clerkUserId);
    if (emailEnabledUserIds.length > 0) {
      await BriefRecipient.updateMany(
        {
          briefDate,
          clerkUserId: { $in: emailEnabledUserIds },
          emailEnabled: true,
          emailStatus: 'not_requested',
        },
        { $set: { emailStatus: 'pending' } },
      );
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

/**
 * Regenerating an approved segment is allowed, but never silently: approval is
 * what sends the emails, and once they are out the mail cannot be recalled. The
 * caller has to pass `acknowledgeSent` — the admin UI collects it as an explicit
 * tick in the confirmation dialog — and the edition being replaced is recorded in
 * `priorDeliveries` so the segment still shows that something went out (`F-013`).
 */
export async function regenerateSegment(
  segmentId: string,
  adminUserId: string,
  options: { acknowledgeSent?: boolean } = {},
) {
  const segment = await BriefSegment.findById(segmentId);
  if (!segment) throw httpError(404, 'not_found');
  const wasApproved = segment.status === 'approved';
  if (wasApproved && !options.acknowledgeSent) {
    throw httpError(409, 'segment_regenerate_requires_acknowledgement');
  }
  // Counted before the model call, so the number recorded is the one that was
  // true of the edition being replaced.
  const emailSentCount = wasApproved
    ? await BriefRecipient.countDocuments({ segmentId: segment._id, emailStatus: 'sent' })
    : 0;
  const priorDelivery = wasApproved
    ? {
        approvedAt: segment.approvedAt,
        approvedBy: segment.approvedBy,
        emailSentCount,
        supersededAt: new Date(),
        supersededBy: adminUserId,
      }
    : null;
  // Regenerate against a fresh window (now) so the manual admin redo picks up
  // articles published after the segment was first generated.
  const window = defaultArticleWindow(new Date());
  const { articles, warning } = await selectArticles(
    asIdStrings(segment.categoryIds),
    asIdStrings(segment.regionIds),
    window.start,
    window.end,
  );
  const draft = await generateDraft(
    segment.briefDate,
    asIdStrings(segment.categoryIds),
    asIdStrings(segment.regionIds),
    articles,
    warning,
  );
  // Apply the regenerated draft atomically. generateDraft above is a multi-second
  // model call, so a load-modify-`save()` here races concurrent writes (another
  // regenerate, a generate batch, or a double-click): the whole-array `stories`
  // reassignment makes Mongoose attach an optimistic __v guard, and a bumped __v
  // then throws a VersionError ("No matching document found ... version N"). A
  // single findByIdAndUpdate sidesteps the version guard and is concurrency-safe.
  const updated = await BriefSegment.findByIdAndUpdate(
    segmentId,
    {
      $set: {
        status: 'draft',
        title: draft.title,
        summary: draft.summary,
        stories: draft.stories,
        editorialNote: draft.editorialNote,
        articleWindowStart: window.start,
        articleWindowEnd: window.end,
        sourceArticleIds: articles.map((article) => article._id as mongoose.Types.ObjectId),
        generationStatus: draft.generationStatus,
        generationError: draft.generationError,
        generatedAt: new Date(),
        generatedBy: adminUserId,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
      },
      ...(priorDelivery ? { $push: { priorDeliveries: priorDelivery } } : {}),
    },
    { new: true, runValidators: true },
  );
  if (!updated) throw httpError(404, 'not_found');
  return updated;
}
