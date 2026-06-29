import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import BriefPreference from '../models/BriefPreference';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment from '../models/BriefSegment';
import Category from '../models/Category';
import Region from '../models/Region';
import { getPakistanDateString } from '../services/briefDates';
import { getPreferencePayload, updatePreference } from '../services/briefPreferences';
import { httpError } from '../utils/errors';

function userIdOrThrow(req: Request): string {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');
  return userId;
}

type SegmentStories = NonNullable<Awaited<ReturnType<typeof BriefSegment.findOne>>>['stories'];
type ArchiveRange = 'all' | 'week' | 'month' | 'last30';
type ArchiveSort = 'newest' | 'oldest';

// Enrich each brief story with display fields pulled from its source Article
// (image / category / read-time / publish date). One batched query - stories
// whose article is missing or unpublished simply get null visuals.
async function enrichStories(stories: SegmentStories) {
  const ids = stories.map((story) => story.articleId).filter(Boolean);
  const articles = ids.length
    ? await Article.find({ _id: { $in: ids } }).select('featuredImage category publishDate readTimeMinutes')
    : [];
  const byId = new Map(articles.map((article) => [String(article._id), article]));
  return stories.map((story) => {
    const article = byId.get(String(story.articleId));
    return {
      articleId: String(story.articleId),
      headline: story.headline,
      url: story.url,
      order: story.order,
      image: article?.featuredImage ?? null,
      category: article?.category ?? null,
      publishDate: article?.publishDate ?? null,
      readTimeMinutes: article?.readTimeMinutes ?? null,
    };
  });
}

async function serializeBrief(recipient: Awaited<ReturnType<typeof BriefRecipient.findOne>>, segment: Awaited<ReturnType<typeof BriefSegment.findOne>>) {
  if (!recipient || !segment) return null;
  return {
    id: String(recipient._id),
    segmentId: String(segment._id),
    briefDate: recipient.briefDate,
    title: segment.title,
    summary: segment.summary,
    stories: await enrichStories(segment.stories),
    editorialNote: segment.editorialNote,
    editorialNoteAuthor: segment.editorialNoteAuthor,
    emailStatus: recipient.emailStatus,
  };
}

// Generic brief has no recipient - the segment is the whole record. Mirror the
// UserBrief shape so the client can reuse the same type (id == segmentId).
async function serializeGenericBrief(segment: NonNullable<Awaited<ReturnType<typeof BriefSegment.findOne>>>) {
  return {
    id: String(segment._id),
    segmentId: String(segment._id),
    briefDate: segment.briefDate,
    title: segment.title,
    summary: segment.summary,
    stories: await enrichStories(segment.stories),
    editorialNote: segment.editorialNote,
    editorialNoteAuthor: segment.editorialNoteAuthor,
    emailStatus: undefined as string | undefined,
  };
}

function parseArchiveRange(value: unknown): ArchiveRange {
  if (value === undefined || value === null || value === '') return 'all';
  if (value === 'all' || value === 'week' || value === 'month' || value === 'last30') return value;
  throw httpError(400, 'invalid_archive_range');
}

function parseArchiveSort(value: unknown): ArchiveSort {
  if (value === undefined || value === null || value === '') return 'newest';
  if (value === 'newest' || value === 'oldest') return value;
  throw httpError(400, 'invalid_archive_sort');
}

function dateFromYmd(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function ymdFromDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function archiveDateBounds(range: ArchiveRange): { start?: string; end?: string } {
  if (range === 'all') return {};
  const today = getPakistanDateString();
  const todayDate = dateFromYmd(today);
  if (range === 'month') return { start: `${today.slice(0, 7)}-01`, end: today };
  if (range === 'last30') return { start: ymdFromDate(addDays(todayDate, -29)), end: today };

  const day = todayDate.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  return { start: ymdFromDate(addDays(todayDate, -daysSinceMonday)), end: today };
}

export async function getPreferences(req: Request, res: Response) {
  res.json(await getPreferencePayload(userIdOrThrow(req)));
}

export async function putPreferences(req: Request, res: Response) {
  res.json(await updatePreference(userIdOrThrow(req), req.body));
}

export async function latest(req: Request, res: Response) {
  const clerkUserId = userIdOrThrow(req);
  const preference = await BriefPreference.findOne({ clerkUserId, deletedAt: null });
  if (!preference || !preference.onboardingCompleted) {
    return res.json({ state: 'needs_onboarding', brief: null });
  }
  if (!preference.enabled) return res.json({ state: 'disabled', brief: null });

  const recipients = await BriefRecipient.find({ clerkUserId, deletedAt: null })
    .sort({ briefDate: -1, createdAt: -1 })
    .limit(20);
  const segments = await BriefSegment.find({
    _id: { $in: recipients.map((recipient) => recipient.segmentId) },
    status: 'approved',
    deletedAt: null,
  });
  const segmentMap = new Map(segments.map((segment) => [String(segment._id), segment]));
  const recipient = recipients.find((row) => segmentMap.has(String(row.segmentId)));
  if (!recipient) return res.json({ state: 'not_ready', brief: null });
  res.json({ state: 'ready', brief: await serializeBrief(recipient, segmentMap.get(String(recipient.segmentId))!) });
}

export async function archive(req: Request, res: Response) {
  const clerkUserId = userIdOrThrow(req);
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string, 10) || 12));
  const range = parseArchiveRange(req.query.range);
  const sort = parseArchiveSort(req.query.sort);
  const sortDir = sort === 'oldest' ? 1 : -1;
  const dateBounds = archiveDateBounds(range);
  const recipientFilter: Record<string, unknown> = { clerkUserId, deletedAt: null };
  if (dateBounds.start && dateBounds.end) {
    recipientFilter.briefDate = { $gte: dateBounds.start, $lte: dateBounds.end };
  }

  const candidates = await BriefRecipient.find(recipientFilter).sort({ briefDate: sortDir, createdAt: sortDir });
  const segments = await BriefSegment.find({
    _id: { $in: candidates.map((recipient) => recipient.segmentId) },
    status: 'approved',
    deletedAt: null,
  });
  const segmentMap = new Map(segments.map((segment) => [String(segment._id), segment]));
  const visible = candidates.filter((recipient) => segmentMap.has(String(recipient.segmentId)));
  const total = visible.length;
  const recipients = visible.slice((page - 1) * limit, page * limit);
  const pageSegments = recipients
    .map((recipient) => segmentMap.get(String(recipient.segmentId)))
    .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));

  // Doc section 6: each archive row shows covered topics/regions and read time.
  const catIds = new Set<string>();
  const regionIds = new Set<string>();
  for (const segment of pageSegments) {
    segment.categoryIds.forEach((id) => catIds.add(String(id)));
    segment.regionIds.forEach((id) => regionIds.add(String(id)));
  }
  const [categories, regions] = await Promise.all([
    Category.find({ _id: { $in: [...catIds] } }).select('title'),
    Region.find({ _id: { $in: [...regionIds] } }).select('title'),
  ]);
  const catTitle = new Map(categories.map((c) => [String(c._id), c.title]));
  const regionTitle = new Map(regions.map((r) => [String(r._id), r.title]));

  const data = await Promise.all(
    recipients.map(async (recipient) => {
      const segment = segmentMap.get(String(recipient.segmentId))!;
      const brief = (await serializeBrief(recipient, segment))!;
      const readTimeMinutes = brief.stories.reduce(
        (sum, story) => sum + (story.readTimeMinutes ?? 0),
        0,
      );
      return {
        ...brief,
        categories: segment.categoryIds
          .map((id) => catTitle.get(String(id)))
          .filter((title): title is string => Boolean(title)),
        regions: segment.regionIds
          .map((id) => regionTitle.get(String(id)))
          .filter((title): title is string => Boolean(title)),
        readTimeMinutes: readTimeMinutes > 0 ? readTimeMinutes : null,
      };
    }),
  );
  res.json({ data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
}

// GET /api/brief/generic - the shared free brief for any signed-in user.
export async function getGeneric(req: Request, res: Response) {
  userIdOrThrow(req);
  const segment = await BriefSegment.findOne({
    isGeneric: true,
    status: 'approved',
    deletedAt: null,
  }).sort({ briefDate: -1, createdAt: -1 });
  if (!segment) return res.json({ state: 'not_ready', brief: null });
  res.json({ state: 'ready', brief: await serializeGenericBrief(segment) });
}

export async function getById(req: Request, res: Response) {
  const clerkUserId = userIdOrThrow(req);
  const recipient = await BriefRecipient.findOne({ _id: req.params.id, clerkUserId, deletedAt: null });
  if (!recipient) return res.status(404).json({ error: 'not_found' });
  const segment = await BriefSegment.findOne({ _id: recipient.segmentId, status: 'approved', deletedAt: null });
  if (!segment) return res.status(404).json({ error: 'not_found' });
  res.json({ brief: await serializeBrief(recipient, segment) });
}
