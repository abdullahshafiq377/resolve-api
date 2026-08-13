import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import Article from '../../models/Article';
import ArticleSummary from '../../models/ArticleSummary';
import BriefRecipient from '../../models/BriefRecipient';
import BriefSegment from '../../models/BriefSegment';
import Comment from '../../models/Comment';
import CommentBan from '../../models/CommentBan';
import CommentReport from '../../models/CommentReport';
import ModerationAction from '../../models/ModerationAction';
import ResearchRequest from '../../models/ResearchRequest';
import type { CommentReportReason } from '../../models/CommentReport';
import { countPremiumSubscribers } from '../../services/billingTiers';
import { startOfPakistanDay } from '../../services/briefDates';
import { buildPagination, parsePagination } from '../../services/researchRequests';

/**
 * The admin overview. Two endpoints:
 *
 *   GET /api/admin/overview        — headline tiles and the three stat panels
 *   GET /api/admin/overview/queue  — the priority work queue, one merged list
 *
 * They are separate because the queue paginates and filters while the counters do
 * not: paging the table must not re-run a dozen aggregate counts.
 */

/** Bar colour for a stat row, mapped to design tokens by the client. */
type Tone = 'neutral' | 'warning' | 'danger' | 'success' | 'strong';

interface StatRow {
  key: string;
  label: string;
  value: number;
  tone: Tone;
}

/** Which slice of the queue a row belongs to — the table's filter pills. */
export const QUEUE_KINDS = ['moderation', 'research', 'brief', 'ai'] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

interface QueueItem {
  id: string;
  kind: QueueKind;
  /** Distinguishes the two moderation rows, which carry different icons. */
  variant: 'reported' | 'held' | 'research' | 'brief' | 'ai';
  title: string;
  subtitle: string;
  /**
   * When set, the client appends "<timePrefix> <relative createdAt>" to the
   * subtitle. Relative time is formatted client-side, in one place.
   */
  timePrefix: string | null;
  status: { label: string; tone: 'warning' | 'danger' };
  href: string;
  createdAt: string;
}

/** Report reasons as the queue title says them, lower-case mid-sentence. */
const REASON_LABELS: Record<CommentReportReason, string> = {
  harassment: 'harassment',
  hate_speech: 'hate speech',
  spam: 'spam',
  off_topic: 'being off topic',
  other: 'review',
};

/** A comment's parent, as the queue subtitle names it. */
const PARENT_LABELS: Record<string, string> = {
  article: 'article',
  poll: 'poll',
  researchRequest: 'research request',
};

/** Reported and held comments both live behind the comments queue's own filters. */
const COMMENT_HREF: Record<'reported' | 'held', string> = {
  reported: '/admin/comments?status=reported',
  held: '/admin/comments?status=held',
};

/**
 * Comment IDs carrying at least one open report. Distinct rather than counted,
 * because a comment with eight reports is one queue row and one number on the
 * "open moderation" tile.
 */
function reportedCommentIds(): Promise<mongoose.Types.ObjectId[]> {
  return CommentReport.distinct('commentId', { status: 'open' }) as Promise<
    mongoose.Types.ObjectId[]
  >;
}

/** Brief drafts a moderator can actually act on — a failed draft holds no content. */
const APPROVABLE_BRIEF_DRAFTS = {
  status: 'draft',
  deletedAt: null,
  generationStatus: { $ne: 'failed' },
} as const;

// GET /api/admin/overview — every counter on the page, in one round-trip.
export async function summary(_req: Request, res: Response) {
  const dayStart = startOfPakistanDay();
  const weekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const now = new Date();

  const reportedIds = await reportedCommentIds();

  const [
    publishedArticles,
    scheduledArticles,
    draftArticles,
    publishedToday,
    heldComments,
    briefDrafts,
    activeBans,
    warningsThisWeek,
    briefsSentToday,
    aiSummariesPending,
    pendingResearch,
    premium,
  ] = await Promise.all([
    Article.countDocuments({ status: 'published' }),
    Article.countDocuments({ status: 'scheduled' }),
    Article.countDocuments({ status: 'draft' }),
    Article.countDocuments({ status: 'published', publishDate: { $gte: dayStart } }),
    Comment.countDocuments({ status: 'held' }),
    BriefSegment.countDocuments(APPROVABLE_BRIEF_DRAFTS),
    CommentBan.countDocuments({
      liftedAt: null,
      $or: [{ activeUntil: null }, { activeUntil: { $gt: now } }],
    }),
    ModerationAction.countDocuments({ type: 'warning', createdAt: { $gte: weekStart } }),
    BriefRecipient.countDocuments({
      deletedAt: null,
      emailStatus: 'sent',
      emailSentAt: { $gte: dayStart },
    }),
    ArticleSummary.countDocuments({ approved: false }),
    ResearchRequest.countDocuments({ status: 'submitted' }),
    countPremiumSubscribers(),
  ]);

  const reportedComments = reportedIds.length;

  res.json({
    tiles: {
      publishedArticles,
      scheduledArticles,
      // One number for "needs a moderator": reported and held comments both do.
      openModeration: reportedComments + heldComments,
      briefApprovals: briefDrafts,
    },
    panels: {
      // No article review state exists in the schema, so the pipeline reports the
      // three statuses that do plus today's publishes.
      editorialPipeline: [
        { key: 'draft', label: 'Draft', value: draftArticles, tone: 'neutral' },
        { key: 'scheduled', label: 'Scheduled', value: scheduledArticles, tone: 'strong' },
        { key: 'publishedToday', label: 'Published today', value: publishedToday, tone: 'success' },
      ] satisfies StatRow[],
      communityModeration: [
        { key: 'reported', label: 'Reported comments', value: reportedComments, tone: 'danger' },
        { key: 'held', label: 'Held comments', value: heldComments, tone: 'warning' },
        { key: 'bans', label: 'Active bans', value: activeBans, tone: 'strong' },
        { key: 'warnings', label: 'Warnings this week', value: warningsThisWeek, tone: 'neutral' },
      ] satisfies StatRow[],
      premiumOperations: [
        { key: 'briefDrafts', label: 'Brief drafts awaiting approval', value: briefDrafts, tone: 'warning' },
        { key: 'briefsSent', label: 'Briefs sent today', value: briefsSentToday, tone: 'success' },
        { key: 'aiSummaries', label: 'AI summaries pending', value: aiSummariesPending, tone: 'warning' },
        { key: 'premium', label: 'Premium subscribers', value: premium.count, tone: 'strong' },
      ] satisfies StatRow[],
    },
    // The premium count is a snapshot of Clerk Billing, not a live read — the
    // client can surface how far behind it is.
    premiumSnapshot: { oldestCheckedAt: premium.oldestCheckedAt, unknownUsers: premium.unknown },
    queueCounts: {
      all: reportedComments + heldComments + pendingResearch + briefDrafts + aiSummariesPending,
      moderation: reportedComments + heldComments,
      research: pendingResearch,
      brief: briefDrafts,
      ai: aiSummariesPending,
    },
  });
}

/**
 * The five sources of queue rows, each newest-first.
 *
 * Every source is asked for the same `take` — the first `skip + limit` rows of
 * the merged list can only come from the first `skip + limit` rows of each
 * source, so slicing the merge afterwards is exact, not a sample.
 */
async function collectQueue(kind: QueueKind | 'all', take: number): Promise<QueueItem[]> {
  const wants = (k: QueueKind) => kind === 'all' || kind === k;
  const items: QueueItem[] = [];

  if (wants('research')) {
    const requests = await ResearchRequest.find({ status: 'submitted' })
      .select('title voteCount createdAt')
      .sort({ createdAt: -1 })
      .limit(take)
      .lean();
    for (const request of requests) {
      items.push({
        id: String(request._id),
        kind: 'research',
        variant: 'research',
        title: request.title,
        subtitle: `${request.voteCount.toLocaleString('en-US')} supporter${
          request.voteCount === 1 ? '' : 's'
        }`,
        timePrefix: 'Submitted',
        status: { label: 'Pending review', tone: 'warning' },
        href: `/admin/research-requests/${String(request._id)}`,
        createdAt: request.createdAt.toISOString(),
      });
    }
  }

  if (wants('moderation')) {
    const reportedIds = await reportedCommentIds();
    const [reported, held] = await Promise.all([
      Comment.aggregate<{
        _id: mongoose.Types.ObjectId;
        parentType: string;
        createdAt: Date;
        reportCount: number;
        reason: string;
      }>([
        { $match: { _id: { $in: reportedIds } } },
        { $sort: { createdAt: -1 } },
        { $limit: take },
        {
          $lookup: {
            from: CommentReport.collection.name,
            let: { cid: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: { $and: [{ $eq: ['$commentId', '$$cid'] }, { $eq: ['$status', 'open'] }] },
                },
              },
              { $sort: { createdAt: 1 } },
              { $project: { reason: 1 } },
            ],
            as: 'openReports',
          },
        },
        {
          $project: {
            parentType: 1,
            createdAt: 1,
            reportCount: { $size: '$openReports' },
            // The queue names a comment by why it was reported first.
            reason: { $ifNull: [{ $arrayElemAt: ['$openReports.reason', 0] }, 'other'] },
          },
        },
      ]),
      Comment.find({ status: 'held' })
        .select('parentType createdAt')
        .sort({ createdAt: -1 })
        .limit(take)
        .lean(),
    ]);

    for (const row of reported) {
      const reason = REASON_LABELS[row.reason as CommentReportReason] ?? REASON_LABELS.other;
      const parent = PARENT_LABELS[row.parentType] ?? 'page';
      items.push({
        id: String(row._id),
        kind: 'moderation',
        variant: 'reported',
        title: `Comment reported for ${reason}`,
        subtitle: `${row.reportCount} report${row.reportCount === 1 ? '' : 's'} · On ${parent}`,
        timePrefix: null,
        status: { label: 'Reported', tone: 'danger' },
        href: COMMENT_HREF.reported,
        createdAt: row.createdAt.toISOString(),
      });
    }

    for (const row of held) {
      const parent = PARENT_LABELS[row.parentType] ?? 'page';
      items.push({
        id: String(row._id),
        kind: 'moderation',
        variant: 'held',
        title: 'Comment held by keyword filter',
        subtitle: `Awaiting review · On ${parent}`,
        timePrefix: null,
        status: { label: 'Held', tone: 'warning' },
        href: COMMENT_HREF.held,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  if (wants('brief')) {
    const drafts = await BriefSegment.find(APPROVABLE_BRIEF_DRAFTS)
      .select('title briefDate isGeneric createdAt')
      .sort({ createdAt: -1 })
      .limit(take)
      .lean();

    // Recipient counts come from one grouped pass rather than a query per draft.
    const counts = await BriefRecipient.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
      { $match: { deletedAt: null, segmentId: { $in: drafts.map((draft) => draft._id) } } },
      { $group: { _id: '$segmentId', count: { $sum: 1 } } },
    ]);
    const recipientsBySegment = new Map(counts.map((row) => [String(row._id), row.count]));

    for (const draft of drafts) {
      const recipients = recipientsBySegment.get(String(draft._id)) ?? 0;
      items.push({
        id: String(draft._id),
        kind: 'brief',
        variant: 'brief',
        title: draft.title ?? `Resolve Brief · ${draft.briefDate}`,
        // A generic segment is the shared free-tier brief and has no recipient rows.
        subtitle: draft.isGeneric
          ? 'All free readers · Draft ready'
          : `${recipients.toLocaleString('en-US')} recipients · Draft ready`,
        timePrefix: null,
        status: { label: 'Needs approval', tone: 'warning' },
        href: `/admin/briefs/${String(draft._id)}`,
        createdAt: draft.createdAt.toISOString(),
      });
    }
  }

  if (wants('ai')) {
    const summaries = await ArticleSummary.find({ approved: false })
      .select('articleId createdAt')
      .sort({ createdAt: -1 })
      .limit(take)
      .lean();

    const articles = await Article.find({ _id: { $in: summaries.map((row) => row.articleId) } })
      .select('title slug')
      .lean();
    const articleById = new Map(articles.map((article) => [String(article._id), article]));

    for (const row of summaries) {
      const article = articleById.get(String(row.articleId));
      // A summary whose article is gone has nowhere to send the moderator.
      if (!article) continue;
      items.push({
        id: String(row._id),
        kind: 'ai',
        variant: 'ai',
        title: article.title,
        subtitle: 'AI draft',
        timePrefix: 'Generated',
        status: { label: 'Held', tone: 'warning' },
        href: `/admin/articles/${article.slug}/edit`,
        createdAt: row.createdAt.toISOString(),
      });
    }
  }

  return items;
}

/** Total rows for a filter, counted without materialising them. */
async function countQueue(kind: QueueKind | 'all'): Promise<number> {
  const wants = (k: QueueKind) => kind === 'all' || kind === k;
  const [moderation, research, brief, ai] = await Promise.all([
    wants('moderation')
      ? Promise.all([reportedCommentIds(), Comment.countDocuments({ status: 'held' })]).then(
          ([reported, held]) => reported.length + held,
        )
      : 0,
    wants('research') ? ResearchRequest.countDocuments({ status: 'submitted' }) : 0,
    wants('brief') ? BriefSegment.countDocuments(APPROVABLE_BRIEF_DRAFTS) : 0,
    wants('ai') ? ArticleSummary.countDocuments({ approved: false }) : 0,
  ]);
  return moderation + research + brief + ai;
}

// GET /api/admin/overview/queue — the priority work queue, newest first.
export async function queue(req: Request, res: Response) {
  const { page, limit, skip } = parsePagination(req.query as Record<string, unknown>, 5, 50);
  const requested = typeof req.query.kind === 'string' ? req.query.kind : 'all';
  const kind: QueueKind | 'all' = (QUEUE_KINDS as readonly string[]).includes(requested)
    ? (requested as QueueKind)
    : 'all';

  const [collected, total] = await Promise.all([collectQueue(kind, skip + limit), countQueue(kind)]);

  collected.sort((a, b) => {
    const gap = b.createdAt.localeCompare(a.createdAt);
    // Ids break ties so a page boundary never drops or repeats a row.
    return gap !== 0 ? gap : a.id.localeCompare(b.id);
  });

  res.json({
    items: collected.slice(skip, skip + limit),
    pagination: buildPagination(total, page, limit),
  });
}
