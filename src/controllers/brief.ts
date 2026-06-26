import type { Request, Response } from 'express';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import BriefPreference from '../models/BriefPreference';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment from '../models/BriefSegment';
import { getPreferencePayload, updatePreference } from '../services/briefPreferences';
import { httpError } from '../utils/errors';

function userIdOrThrow(req: Request): string {
  const { userId } = getAuth(req);
  if (!userId) throw httpError(401, 'unauthenticated');
  return userId;
}

type SegmentStories = NonNullable<Awaited<ReturnType<typeof BriefSegment.findOne>>>['stories'];

// Enrich each brief story with display fields pulled from its source Article
// (image / category / read-time / publish date). One batched query — stories
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
      summary: story.summary,
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
    headlineSummary: segment.headlineSummary,
    title: segment.title,
    summary: segment.summary,
    stories: await enrichStories(segment.stories),
    editorialNote: segment.editorialNote,
    editorialNoteAuthor: segment.editorialNoteAuthor,
    emailStatus: recipient.emailStatus,
  };
}

// Generic brief has no recipient — the segment is the whole record. Mirror the
// UserBrief shape so the client can reuse the same type (id == segmentId).
async function serializeGenericBrief(segment: NonNullable<Awaited<ReturnType<typeof BriefSegment.findOne>>>) {
  return {
    id: String(segment._id),
    segmentId: String(segment._id),
    briefDate: segment.briefDate,
    headlineSummary: segment.headlineSummary,
    title: segment.title,
    summary: segment.summary,
    stories: await enrichStories(segment.stories),
    editorialNote: segment.editorialNote,
    editorialNoteAuthor: segment.editorialNoteAuthor,
    emailStatus: undefined as string | undefined,
  };
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
  const recipients = await BriefRecipient.find({ clerkUserId, deletedAt: null })
    .sort({ briefDate: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
  const total = await BriefRecipient.countDocuments({ clerkUserId, deletedAt: null });
  const segments = await BriefSegment.find({
    _id: { $in: recipients.map((recipient) => recipient.segmentId) },
    status: 'approved',
    deletedAt: null,
  });
  const segmentMap = new Map(segments.map((segment) => [String(segment._id), segment]));
  const data = await Promise.all(
    recipients
      .filter((recipient) => segmentMap.has(String(recipient.segmentId)))
      .map((recipient) => serializeBrief(recipient, segmentMap.get(String(recipient.segmentId))!)),
  );
  res.json({ data, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
}

// GET /api/brief/generic — the shared free brief for any signed-in user.
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
