import BriefPreference from '../models/BriefPreference';
import BriefRecipient from '../models/BriefRecipient';
import BriefSegment from '../models/BriefSegment';
import { tierAtLeast, type PlanTier } from '../middleware/auth';

// A trimmed brief, just enough to ground a `scope:'brief'` chat. Mirrors the
// shape served by the brief controller (title + summary + story headlines)
// without the recipient/email metadata.
export interface BriefChatContext {
  briefDate: string;
  title: string;
  summary: string;
  stories: { headline: string }[];
}

function toContext(segment: {
  briefDate: string;
  title: string | null;
  summary: string | null;
  stories: { headline: string }[];
}): BriefChatContext {
  // Only approved segments reach here, and approval requires a non-empty
  // title/summary, so these are populated in practice; coerce for the type.
  return {
    briefDate: segment.briefDate,
    title: segment.title ?? '',
    summary: segment.summary ?? '',
    stories: (segment.stories ?? []).map((s) => ({ headline: s.headline })),
  };
}

// The newest personalised, approved brief for a paid user (mirrors
// controllers/brief.ts `latest`). Returns null when none is ready.
async function getPremiumBrief(clerkUserId: string): Promise<BriefChatContext | null> {
  const preference = await BriefPreference.findOne({ clerkUserId, deletedAt: null });
  if (!preference || !preference.onboardingCompleted || !preference.enabled) return null;

  const recipients = await BriefRecipient.find({ clerkUserId, deletedAt: null })
    .sort({ briefDate: -1, createdAt: -1 })
    .limit(20);
  if (recipients.length === 0) return null;

  const segments = await BriefSegment.find({
    _id: { $in: recipients.map((r) => r.segmentId) },
    status: 'approved',
    deletedAt: null,
  });
  const segmentMap = new Map(segments.map((s) => [String(s._id), s]));
  const recipient = recipients.find((r) => segmentMap.has(String(r.segmentId)));
  if (!recipient) return null;
  return toContext(segmentMap.get(String(recipient.segmentId))!);
}

// The shared free brief (mirrors controllers/brief.ts `getGeneric`).
async function getGenericBrief(): Promise<BriefChatContext | null> {
  const segment = await BriefSegment.findOne({
    isGeneric: true,
    status: 'approved',
    deletedAt: null,
  }).sort({ briefDate: -1, createdAt: -1 });
  return segment ? toContext(segment) : null;
}

/**
 * Resolve the brief that grounds a `scope:'brief'` chat. Paid users get their
 * personalised brief and fall back to the generic one; free users get generic.
 * Returns null when no approved brief exists yet (caller degrades to RAG).
 */
export async function getBriefForChat(
  clerkUserId: string,
  tier: PlanTier,
): Promise<BriefChatContext | null> {
  if (tierAtLeast(tier, 'standard')) {
    const personalised = await getPremiumBrief(clerkUserId);
    if (personalised) return personalised;
  }
  return getGenericBrief();
}
