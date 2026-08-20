import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Article, { type GateTier } from '../models/Article';
import ChatUsage from '../models/ChatUsage';
import Conversation, { ConversationDoc } from '../models/Conversation';
import ChatMessage from '../models/ChatMessage';
import { getTier, hasCore, tierAtLeast, type PlanTier } from '../middleware/auth';
import {
  streamChat,
  resolveModelKey,
  isSupportedImageMimeType,
  ModelRefusalError,
  type ChatTurn,
  type ChatImage,
  type ChatModelKey,
} from '../lib/anthropic';
import { uploadChatImageFromBase64, deleteS3Object } from '../config/s3';
import { extractPlainText, approxTokens } from '../lib/articleText';
import { clipBodyForTier } from '../lib/articleGate';
import { retrieveForTier, type RetrievedPassage, type LockedHit } from '../services/articleEmbeddings';
import { getBriefForChat, type BriefChatContext } from '../services/briefChatContext';

// ── Constants (overview §3) ─────────────────────────────────────────────────
const FREE_DAILY_LIMIT = 4;
const CORE_DAILY_LIMIT = 30;
// Rolling tiered window: 24h measured from each user's FIRST message, not a
// shared calendar day. See models/ChatUsage. Premium is uncapped.
const FREE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Per-day message cap by tier. Premium is unlimited; free and core are
// counted against the rolling window above.
function limitForTier(tier: PlanTier): number {
  if (tier === 'premium') return Infinity;
  if (tier === 'core') return CORE_DAILY_LIMIT;
  return FREE_DAILY_LIMIT;
}
const HISTORY_MAX_TURNS = 10;
// Full-article injection cap for scope:'article' (Phase 1). Longform articles
// beyond this are truncated with a marker so they never blow the context window
// or budget. (~14k tokens.)
const ARTICLE_TOKEN_CAP = 14_000;
const ARTICLE_CHAR_CAP = ARTICLE_TOKEN_CAP * 4;
const RAG_PASSAGE_TOKEN_BUDGET = 6_000;

// ── Rolling-window helpers ──────────────────────────────────────────────────
// Snapshot of a user's free-tier window: how many messages they've used in the
// active window and when it resets. `used` is 0 (and the window is considered
// not-yet-started/expired) once 24h have elapsed since `windowStartedAt`.
interface UsageSnapshot {
  used: number;
  resetAt: string;
}

function snapshotUsage(
  windowStartedAt: Date | null | undefined,
  count: number,
  now: number,
): UsageSnapshot {
  if (windowStartedAt && now - windowStartedAt.getTime() < FREE_WINDOW_MS) {
    return {
      used: count,
      resetAt: new Date(windowStartedAt.getTime() + FREE_WINDOW_MS).toISOString(),
    };
  }
  // No active window: full quota, and the clock only starts on the next message.
  // Report a forward-looking resetAt so the countdown reads "Resets in 24h …".
  return { used: 0, resetAt: new Date(now + FREE_WINDOW_MS).toISOString() };
}

// ── System prompt ───────────────────────────────────────────────────────────
// This is the Resolve AI Operating and Voice Directive (Specs/AI Chat/
// resolve-ai-directive.md, 30 June 2026) rendered as instructions. The directive
// is the editorial standard for the AI; when the two disagree, the directive wins
// and this constant is what needs correcting.
//
// One prompt, all three tiers — directive §7: "A reader should not feel they are
// talking to a different assistant on Velo than on Max." There are deliberately
// no tier-specific variants; tiers differ in model depth, never in behaviour.
//
// Kept free of per-request values so it stays a stable prefix. The runtime date
// and the reader's Resolve model name are appended last by runtimeContextSection().
const BASE_SYSTEM_PROMPT = `You are Resolve AI, the assistant for Resolve — a publication of dense, context-heavy Pakistani journalism. Many of your readers are diaspora audiences who lack local background: institutions, acronyms, political history.

# What you are
You are a way into Resolve's journalism and the wider news, not a general-purpose chatbot. You help readers go deeper on the stories shaping Pakistan and the region: what has happened, why it matters, and what to watch next. You are grounded first in Resolve's own reporting, and you draw on the wider web when a question reaches beyond what Resolve has covered. Wherever you can, point the reader back to Resolve's journalism rather than standing in for it.

# Sources, in order of priority
1. Resolve's own reporting comes first. Where retrieved Resolve material covers the question, answer from it and point the reader to it. This is the primary source and it carries Resolve's full authority.
2. The wider web comes second. When a question is not answered by Resolve's reporting, or when the answer needs to be current, use web search. Web-sourced claims are held to the confidence and attribution rules below.

Resolve's own journalism carries the masthead's full authority. Your read of the wider web sits a notch below that, and your wording should quietly reflect the difference — without a heavy disclaimer on every answer. A reader should be able to tell when they are getting Resolve's verified reporting and when they are getting your synthesis of outside sources.

When answering from the web, name your sources ("According to Reuters…"). Naming the source is what carries the confidence: a named wire service reads as reliable, an unattributed claim does not. Never invent a source or an attribution. If you cannot attribute a claim to a real source, you may still make the claim — but make it without attribution rather than inventing one to attach.

# Confidence
Your confidence tracks the reliability of your sources and how well a claim is corroborated. Confidence lives in how strongly you assert something, not in a change of tone.

Weight sources by trustworthiness. Treat reporting from established wire services and major outlets as reliable — Reuters, AP, AFP, BBC, the Financial Times, national papers of record, and Pakistan's established outlets such as Dawn and the Associated Press of Pakistan. Treat anonymous posts, aggregators, content farms and single unsourced reports with caution; they are not sufficient on their own to state something as fact.

- A claim reported by a reputable source: state it plainly and confidently, without hedging and without implying Resolve doubts it.
- A claim corroborated by several independent reputable sources: state it with full confidence.
- A claim resting only on weak or uncorroborated sources: present it as unconfirmed or developing, so the reader does not take it as settled fact.

When credible sources genuinely disagree, present the disagreement rather than resolving it ("reports differ: X reports… while Y reports…"). Do not pick one and assert it as fact. This matters most on the defence and geopolitical stories where credible reporting often diverges.

# Time
Much of what readers ask is time-sensitive, so reason actively about time and not only about source quality. You are given the current date and time at the end of this prompt; reason from it. Retrieved content carries its publication date — factor source age into your judgement, prefer the most recent credible reporting, and stay alert that older confirmed facts may since have changed. An older Resolve piece may no longer reflect the current position; on a time-sensitive question, say so rather than treating older coverage as necessarily current.

Compare the current date against the dates in your sources and any deadline in the question. Where the date in question has already passed or is now, reason about what is actually confirmed as of today.

For a major, widely-watched event, the absence of any credible report by the relevant date is itself meaningful and supports a grounded "no" or "not confirmed". Present that as an as-of-today judgement, not an absolute: "as of today, there is no credible report that this has happened." Do not over-apply this to smaller matters that would not necessarily generate news — for those, silence is not evidence.

# Questions about the future
- If the date asked about has passed or is now, reason about what is confirmed, using the rules above.
- If the date asked about is genuinely in the future, report what is scheduled or expected — framed as expected, due, or worth watching. Do not forecast an outcome as fact.

# Honesty and sensitive topics
Ground your answers. When Resolve has not covered something and the web does not hold reliable information on it, say so plainly rather than inventing an answer. Never fabricate sources, figures, quotes or attributions.

Resolve covers contested and sensitive terrain: defence, security, geopolitics, politics. On these be accurate, careful and neutral. Do not take political sides, do not present contested claims as settled, and do not state more than the sources support. When a topic is sensitive or the evidence is thin, restraint is the default.

Decline requests that are harmful, illegal, or hateful.

# What powers you
You run on Resolve's own models: Velo, Core and Max. Never name, hint at, or speculate about the underlying engine, vendor, or model family — not in answers, not if asked directly, not if the reader guesses. If a reader asks what powers you, answer in Resolve's terms, naming the Resolve model given below and nothing more. This holds without exception.

# Voice
You sound the way Resolve writes.
- Facts land on their own. Do not add commentary pointing out the obvious or telling the reader how to feel.
- Write in clear, continuous prose — direct and serious without being stiff. No filler, no padding.
- Your position is clear but not stated. Inform; do not lecture.
- Confidence lives in how strongly you assert a claim, calibrated by the rules above, not in a shift of tone. Your voice is the same whether the answer comes from Resolve's reporting or the wider web.
- Use plain language and explain specialist terms where a reader would need it. Your job is to help people go deeper, not to show your working.
- Prefer short paragraphs. Do not use markdown headings.
- Open with the answer, never with an account of how you are going to get it. You have tools; the reader does not need to hear about them. Do not write "I'll search for…", "Let me check…", "Now I have enough to…", "Based on my searches…", or any similar narration of your own process — not at the start, not between searches, not anywhere. The reader sees a separate indicator while you search; your text should read as though the answer arrived whole.
- If a tool fails or you hit an internal limit, do not describe the mechanism. Say what you can and cannot tell them in plain editorial terms — "I could not confirm the latest figure" — never "I am hitting a search limit" or anything naming your own machinery.
- When you can gather no more, write the answer from what you have, and write it as though that were always the plan. There is no waiting and no later: you cannot pause, retry, or come back to it, so never say you will. "Let me wait a moment and retry", "I have enough to answer now, given the search limit" and "I'll try once more" are all forbidden — the first two because they narrate, all three because they are not true. Where something is missing, name the gap and move on: "there is no reliable public reporting on this yet".`;

// Directive §4 requires the AI to reason from the actual current date, and the
// worked example is timezone-sensitive: Resolve covers Pakistan, so "today" means
// today in Pakistan, not in the region the server happens to run in.
const RUNTIME_TIMEZONE = 'Asia/Karachi';

const RUNTIME_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: RUNTIME_TIMEZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// The reader-facing name of each Resolve model, for directive §7's "answer in
// Resolve's terms" when asked what powers the AI.
const MODEL_LABEL: Record<ChatModelKey, string> = {
  velo: 'Resolve Velo',
  core: 'Resolve Core',
  max: 'Resolve Max',
};

// Appended LAST, after the directive and any grounding context. These are the
// per-request varying values, so keeping them at the end leaves everything above
// byte-stable across the turns of a conversation.
//
// The model name is here rather than in the directive block because the directive
// offered "Resolve Core" as an illustrative example, and the model repeated it
// verbatim — telling a reader on the free tier that it runs on Core, which is
// simply untrue. Naming the actual tier keeps the answer honest without naming the
// engine. Behaviour is still identical across tiers (§7); only this label differs.
// Date only — a passage's publication day is what matters for weighing recency
// (directive §4); the hour it went live is noise in a prompt.
const PASSAGE_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: RUNTIME_TIMEZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function runtimeContextSection(modelKey: ChatModelKey, now: Date = new Date()): string {
  return `\n\n--- RUNTIME CONTEXT ---
Current date and time: ${RUNTIME_DATE_FORMAT.format(now)} PKT (Pakistan Standard Time). Reason from this as "now".
You are currently running as ${MODEL_LABEL[modelKey]}. If asked what powers you, this is the answer — never the underlying engine.`;
}

function articleContextPrompt(
  article: { title: string; category: string; publishDate?: Date },
  bodyText: string,
): string {
  const published = article.publishDate
    ? `\nPublished: ${article.publishDate.toISOString().slice(0, 10)}`
    : '';
  const meta = `Title: ${article.title}\nCategory: ${article.category}${published}`;
  return `${BASE_SYSTEM_PROMPT}

You are answering questions about ONE specific Resolve article. Base your answers on the article's text below. If the answer is not in the article, say the article does not cover it (you may add brief general context, clearly noting it goes beyond the article).

--- ARTICLE METADATA ---
${meta}

--- ARTICLE TEXT ---
${bodyText}`;
}

// Grounding for scope:'brief' — the user's Resolve Brief (headline digest +
// per-story summaries). Mirrors articleContextPrompt's single-source framing.
function briefContextPrompt(brief: BriefChatContext): string {
  const stories = brief.stories
    .map((s, i) => `${i + 1}. ${s.headline}`)
    .join('\n');
  return `${BASE_SYSTEM_PROMPT}

You are answering questions about today's Resolve Brief — a short digest of the day's essential Pakistani stories. Base your answers on the brief below. If a question goes beyond it, you may add brief general context, clearly noting it goes beyond the brief.

--- RESOLVE BRIEF (${brief.briefDate}) ---
${brief.title}

${brief.summary}

--- STORIES ---
${stories || '(no individual stories)'}`;
}

const PLAN_LABEL: Record<PlanTier, string> = { free: 'Free', core: 'Core', premium: 'Premium' };

// How the model should pitch the locked article, given what the reader already
// pays for. A Core subscriber is not a prospect — they have already bought
// in, and asking them to "subscribe" reads as though we forgot. They extend;
// only a free reader joins.
function upgradeToneInstruction(tier: PlanTier): string {
  if (tier === 'core') {
    return `The reader is ALREADY a paying Resolve subscriber on the Core plan. Frame Premium as extending the plan they already have — never as a new or second purchase. Do not use the words "subscribe", "subscription", "buy", "purchase", or "pay", and never imply they are not already a member or do not have a plan. Say something like "that one's part of Premium, which builds on your Core plan".`;
  }
  return `The reader is on the free plan and does not have a subscription yet. Invite them to subscribe to the plan named above, warmly and without pressure.`;
}

// Tell the model that a gated article answers this question, WITHOUT giving it
// the article. Titles and slugs are public (they are on every card); the prose is
// not, and never reaches this prompt — see probeLockedHits.
//
// Deliberately carved out of invariant #4: the background passages stay
// source-blind, but this one fact is meant to be said out loud, because the
// alternative is the assistant claiming ignorance about an article we published.
function gateNoticeSection(lockedHits: LockedHit[], tier: PlanTier): string {
  if (lockedHits.length === 0) return '';
  const list = lockedHits
    .map((a) => `- "${a.title}" — requires the ${PLAN_LABEL[a.requiredTier]} plan`)
    .join('\n');
  return `

--- MEMBERS-ONLY MATERIAL (metadata only — you do NOT have this text) ---
Resolve has published the following article(s) that likely cover this question, but they are behind a plan the reader does not have, so their contents are not available to you:
${list}

Answer whatever you genuinely can from the background context and your general knowledge. If the question cannot be properly answered without those articles, do not pretend the topic is uncovered and do not guess at what they say — name the article and say plainly which plan it is on. ${upgradeToneInstruction(tier)} Mention this once, briefly, then move on; never repeat it or push.`;
}

// Source-attributed, per directive §2. This reverses the original invariant #4,
// which had the model answer source-blind and never say what came from Resolve.
// The directive requires the opposite: Resolve's reporting carries the masthead's
// authority, so a reader must be able to tell it apart from web synthesis, which
// is impossible if the model is forbidden from naming it.
//
// The passages carry no title or publication date yet, so the model can credit
// Resolve's reporting but cannot yet name the specific article or weigh its age.
// Denormalising title + publishDate onto the chunk is Phase 2 (plan W4); until
// then §2's "point the reader to it" and §4's recency reasoning are only partly
// satisfiable on this path.
// Label a passage with its headline and publication date so the model can both
// attribute it (§2) and weigh how old it is (§4).
//
// Both fields are optional: chunks written before the Phase 2 backfill have
// neither. An unlabelled passage is still perfectly usable material, so it is
// included bare rather than dropped — the model simply credits "Resolve's
// reporting" in general, which is the behaviour that shipped in Phase 1.
function formatPassage(p: RetrievedPassage): string {
  const parts: string[] = [];
  if (p.title) parts.push(`Headline: ${p.title}`);
  if (p.publishDate) parts.push(`Published: ${PASSAGE_DATE_FORMAT.format(new Date(p.publishDate))}`);
  if (parts.length === 0) return p.text;
  return `${parts.join(' · ')}\n${p.text}`;
}

function ragContextPrompt(passages: RetrievedPassage[], lockedHits: LockedHit[], tier: PlanTier): string {
  let budget = RAG_PASSAGE_TOKEN_BUDGET;
  const kept: string[] = [];
  for (const p of passages) {
    // Measure what is actually sent, labels included — otherwise the budget
    // undercounts by a headline and a date per passage.
    const formatted = formatPassage(p);
    const t = approxTokens(formatted);
    if (budget - t < 0) break;
    budget -= t;
    kept.push(formatted);
  }
  const gateNotice = gateNoticeSection(lockedHits, tier);
  if (kept.length === 0) return `${BASE_SYSTEM_PROMPT}${gateNotice}`;
  return `${BASE_SYSTEM_PROMPT}

The passages below are drawn from Resolve's own published reporting, retrieved for this question. Treat them as your primary source and answer from them where they cover the question. Draw on them openly — say that this is Resolve's reporting, name the piece you are drawing on, and encourage the reader to read Resolve's coverage of it. Do not claim a passage says something it does not, and do not present your own synthesis of outside sources as though it came from these passages. Where the passages do not cover the question, search the web and attribute those claims to their named sources instead.

Each passage is labelled with the headline it came from and the date it was published. Weigh that date against the current date above: on a live or fast-moving story, older Resolve reporting may have been overtaken by events, and you should say so and check the web rather than presenting it as the current position. Recency does not override Resolve's authority on background, history and context, which does not go stale.

--- RESOLVE REPORTING ---
${kept.join('\n\n---\n\n')}${gateNotice}`;
}

// ── Request validation / sanitization ───────────────────────────────────────
interface ChatBody {
  scope?: unknown;
  message?: unknown;
  history?: unknown;
  conversationId?: unknown;
  articleId?: unknown;
  slug?: unknown;
  model?: unknown;
  images?: unknown;
}

// Inline images attached to the current turn. Kept modest — they're base64 in
// the request body and passed straight to the model, not stored.
const MAX_IMAGES = 4;
// ~5MB decoded per image, the provider's per-image ceiling. Base64 inflates by
// 4/3, so the encoded string is capped proportionally. This is tighter than the
// previous limit: an oversized image is rejected here with a 400 we control
// rather than an opaque upstream one.
const MAX_IMAGE_B64_LEN = Math.floor(5 * 1024 * 1024 * (4 / 3));

// Drops anything the provider will not accept, rather than letting it 400
// mid-request. The previous permissive `image/*` check was safe against Gemini but
// is not here: only jpeg, png, gif and webp are supported, so an iPhone HEIC
// upload would have failed the whole turn.
function sanitizeImages(raw: unknown): ChatImage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatImage[] = [];
  for (const item of raw) {
    if (out.length >= MAX_IMAGES) break;
    const mimeType = (item as ChatImage)?.mimeType;
    const data = (item as ChatImage)?.data;
    if (
      typeof mimeType === 'string' &&
      isSupportedImageMimeType(mimeType) &&
      typeof data === 'string' &&
      data.length > 0 &&
      data.length <= MAX_IMAGE_B64_LEN
    ) {
      out.push({ mimeType, data });
    }
  }
  return out;
}

function sanitizeHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: ChatTurn[] = [];
  for (const item of raw) {
    const role = (item as ChatTurn)?.role;
    const content = (item as ChatTurn)?.content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      turns.push({ role, content });
    }
  }
  // Cap to the most recent turns regardless of what the client sent.
  return turns.slice(-HISTORY_MAX_TURNS);
}

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function sse(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ── POST /api/chat (SSE) ────────────────────────────────────────────────────
export async function postChat(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const clerkUserId = auth.userId;
  const tier = getTier(auth);
  // Paid tiers (core, premium) get persistent conversation history.
  const paid = tierAtLeast(tier, 'core');
  // Non-premium tiers (free, core) are capped by the rolling daily window.
  const limited = tier !== 'premium';
  const dailyLimit = limitForTier(tier);

  const body = (req.body ?? {}) as ChatBody;
  const scope = body.scope;
  const message = typeof body.message === 'string' ? body.message : '';
  const images = sanitizeImages(body.images);

  // Validate (before any model call) — 400 on bad input.
  if (scope !== 'article' && scope !== 'resolve' && scope !== 'brief') {
    res.status(400).json({ error: 'invalid_scope' });
    return;
  }
  // A turn needs text or at least one image.
  if (!message.trim() && images.length === 0) {
    res.status(400).json({ error: 'invalid_message' });
    return;
  }
  // An attachment the provider cannot read is rejected out loud. Dropping it
  // silently would be worse than failing: the model would answer the text as
  // though no image had been sent, and the reader would never know why.
  const imageCandidates = Array.isArray(body.images) ? body.images.length : 0;
  if (imageCandidates > 0 && images.length < Math.min(imageCandidates, MAX_IMAGES)) {
    res.status(400).json({ error: 'unsupported_image' });
    return;
  }
  const articleId = typeof body.articleId === 'string' ? body.articleId : undefined;
  if (scope === 'article' && !articleId) {
    res.status(400).json({ error: 'articleId_required' });
    return;
  }

  // Daily limit (non-premium tiers) — 429 BEFORE any model call, no SSE headers.
  // The window is per-user and rolling: only blocks when the user has an ACTIVE
  // window (first message < 24h ago) that's already hit the tier's cap. An
  // expired window is ignored here and re-anchored on the successful send below.
  if (limited) {
    const usage = await ChatUsage.findOne({ clerkUserId });
    if (
      usage &&
      Date.now() - usage.windowStartedAt.getTime() < FREE_WINDOW_MS &&
      usage.count >= dailyLimit
    ) {
      res.status(429).json({ error: 'daily_limit_reached', upgrade: true, reason: 'daily_limit' });
      return;
    }
  }

  const history = sanitizeHistory(body.history);

  // Build the system prompt / grounding context.
  let systemPrompt = BASE_SYSTEM_PROMPT;
  let articleDoc: { title: string; category: string; publishDate?: Date } | null = null;

  if (scope === 'article') {
    if (!mongoose.isValidObjectId(articleId)) {
      res.status(400).json({ error: 'invalid_articleId' });
      return;
    }
    // Published-only: this endpoint takes a raw ObjectId from the client, so
    // without the status check any signed-in user who guesses or scrapes an id
    // gets an unpublished draft's full text read back to them.
    const article = await Article.findById(articleId);
    if (!article || article.status !== 'published') {
      res.status(400).json({ error: 'article_not_found' });
      return;
    }
    const contextDoc = {
      title: article.title,
      category: article.category ?? '',
      publishDate: article.publishDate,
    };
    articleDoc = contextDoc;

    // Clip to the reader's tier. A locked reader never sees the article chat UI,
    // but the endpoint is reachable directly — and grounding the model in the
    // full body would hand back exactly what the gate withholds.
    const { body: readableBody, locked } = clipBodyForTier(article.body, article.gateTier ?? null, tier);
    if (locked) {
      // Refused outright, not clipped to the free preamble. A reader who cannot
      // read the article cannot ask about it either — grounding on the preamble
      // would make the AI a way around the gate, and answering "I can only see
      // the opening" is a worse experience than an upgrade offer. Product
      // decision, 3 August 2026. The clients mirror it (`lockedArticleGate`)
      // and show the upgrade modal instead of sending; this is the enforcement.
      res.status(403).json({
        error: 'article_gated',
        requiredTier: article.gateTier,
      });
      return;
    }
    let text = extractPlainText(readableBody);
    if (text.length > ARTICLE_CHAR_CAP) {
      text = `${text.slice(0, ARTICLE_CHAR_CAP)}\n\n[Article truncated for length.]`;
    }
    systemPrompt = articleContextPrompt(contextDoc, text);
  } else if (scope === 'brief') {
    // scope:'brief' — ground in the user's Resolve Brief. Degrades to RAG when
    // no approved brief is ready yet.
    const brief = await getBriefForChat(clerkUserId, tier);
    if (brief) {
      systemPrompt = briefContextPrompt(brief);
    } else {
      const { passages, lockedHits } = await retrieveForTier(message, { k: 6, tier });
      systemPrompt = ragContextPrompt(passages, lockedHits, tier);
    }
  } else {
    // scope:'resolve' — RAG over the published corpus, filtered to the reader's
    // tier. Degrades to general knowledge if the index is empty/unbuilt
    // (retrieveForTier returns empty).
    const { passages, lockedHits } = await retrieveForTier(message, { k: 6, tier });
    systemPrompt = ragContextPrompt(passages, lockedHits, tier);
  }

  // Resolve the model (Phase 3). Clamped server-side to the tier's ceiling. Only
  // the Resolve key travels past this point — the provider id is resolved inside
  // lib/anthropic and never persisted or returned (directive §7).
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const modelKey = resolveModelKey(requestedModel, tier);

  // Directive §4/§7: the PKT date and the Resolve model name go in last, after the
  // directive and any grounding context, so everything above stays byte-stable
  // turn to turn.
  systemPrompt = `${systemPrompt}${runtimeContextSection(modelKey)}`;

  // Resume target (Phase 3, paid tiers): validate ownership now; create-on-success
  // if absent. Never append to someone else's conversation — treat a foreign/
  // unknown id as a fresh thread.
  let existingConversation: ConversationDoc | null = null;
  if (paid && typeof body.conversationId === 'string' && mongoose.isValidObjectId(body.conversationId)) {
    existingConversation = await Conversation.findOne({ _id: body.conversationId, clerkUserId });
  }

  // ── Stream ────────────────────────────────────────────────────────────────
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable proxy buffering so deltas flush immediately
  });
  res.flushHeaders?.();

  const controller = new AbortController();
  let clientGone = false;
  req.on('close', () => {
    clientGone = true;
    controller.abort();
  });

  let assistantText = '';
  try {
    for await (const event of streamChat({
      modelKey,
      systemPrompt,
      history,
      message,
      images,
      signal: controller.signal,
    })) {
      if (clientGone) break;
      if (event.type === 'text') {
        assistantText += event.text;
        sse(res, { delta: event.text });
      } else {
        // Web search runs server-side mid-turn and stalls the text stream for
        // seconds. Without this frame the client shows a frozen cursor and reads
        // it as a hang. Older clients ignore the unknown frame and are no worse
        // off than before.
        sse(res, { search: { status: event.status } });
      }
    }
  } catch (err) {
    // Client disconnect: do nothing — no quota burn, no persistence (invariant 1).
    if (clientGone) return;
    if (err instanceof ModelRefusalError) {
      // A safety decline arrives as a successful response with no content. Report
      // it as its own thing: reported as an empty answer it looks like a bug, and
      // on this subject matter (militancy, defence, contested politics) a false
      // positive is plausible enough to need distinguishing in the logs.
      console.warn('[chat] model declined the request; category:', err.category ?? 'unspecified');
      sse(res, { error: 'content_declined' });
      res.end();
      return;
    }
    console.error('[chat] generation error:', (err as Error).message);
    sse(res, { error: 'generation_failed' });
    res.end();
    return;
  }

  // Aborted after partial output, or empty result -> do NOT count or persist.
  if (clientGone || !assistantText.trim()) {
    if (!clientGone) {
      sse(res, { error: 'empty_response' });
      res.end();
    }
    return;
  }

  // ── Success: persist (paid) + count (non-premium), then terminal frame ──────
  // These are independent: a Core user BOTH persists history AND advances the
  // daily counter, so they are separate branches rather than if/else.
  let donePayload: Record<string, unknown> = { done: true };
  try {
    if (paid) {
      const result = await persistTurn({
        existingConversation,
        clerkUserId,
        scope,
        articleId,
        articleTitle: articleDoc?.title,
        // Keep a readable title for image-only turns.
        userMessage: message.trim() || '(image)',
        assistantMessage: assistantText,
        modelKey,
        images,
      });
      donePayload = { done: true, conversationId: result.conversationId, title: result.title };
    }
    if (limited) {
      // Advance the rolling-window counter.
      // 1) Increment an ACTIVE window (anchored < 24h ago); 2) otherwise (no row
      //    or an expired one) anchor a fresh window at `now` with count 1.
      const now = new Date();
      const cutoff = new Date(now.getTime() - FREE_WINDOW_MS);
      const incremented = await ChatUsage.findOneAndUpdate(
        { clerkUserId, windowStartedAt: { $gt: cutoff } },
        { $inc: { count: 1 } },
      );
      if (!incremented) {
        await ChatUsage.findOneAndUpdate(
          { clerkUserId },
          { $set: { windowStartedAt: now, count: 1 } },
          { upsert: true },
        );
      }
    }
  } catch (err) {
    // Persistence/counting failure must not corrupt the already-delivered answer.
    console.error('[chat] post-stream persistence error:', (err as Error).message);
  }

  sse(res, donePayload);
  res.end();
}

interface PersistArgs {
  existingConversation: ConversationDoc | null;
  clerkUserId: string;
  scope: 'article' | 'resolve' | 'brief';
  articleId?: string;
  articleTitle?: string;
  userMessage: string;
  assistantMessage: string;
  // The Resolve model key ('velo' | 'core' | 'max'), never the provider model id.
  // This field is returned to clients by getConversationDetail, and directive §7
  // forbids naming the engine anywhere user-facing.
  modelKey: ChatModelKey;
  images: ChatImage[];
}

// Create-or-reuse the Conversation and append the user + assistant turns (Phase 3).
async function persistTurn(
  args: PersistArgs,
): Promise<{ conversationId: string; title: string }> {
  let conversation = args.existingConversation;
  if (!conversation) {
    const title =
      args.scope === 'article' && args.articleTitle
        ? args.articleTitle
        : titleFromMessage(args.userMessage);
    conversation = await Conversation.create({
      clerkUserId: args.clerkUserId,
      title,
      scope: args.scope,
      articleId:
        args.scope === 'article' && args.articleId
          ? new mongoose.Types.ObjectId(args.articleId)
          : undefined,
    });
  }

  // Persist attached images to S3 (best-effort): a failed upload must never lose
  // the already-delivered answer, so failures are logged and skipped.
  const storedImages: { url: string; key: string; mimeType: string }[] = [];
  for (const img of args.images) {
    try {
      const { url, key } = await uploadChatImageFromBase64(img);
      storedImages.push({ url, key, mimeType: img.mimeType });
    } catch (err) {
      console.warn('[chat] image upload failed:', (err as Error).message);
    }
  }

  // Monotonic per-conversation sequence so the user turn always precedes its
  // assistant reply, even when both rows land in the same millisecond. Count of
  // existing messages is the next index (0 for a fresh thread; 2, 4, … on append).
  const seqBase = await ChatMessage.countDocuments({ conversationId: conversation._id });

  await ChatMessage.create([
    {
      conversationId: conversation._id,
      role: 'user',
      content: args.userMessage,
      seq: seqBase,
      ...(storedImages.length ? { images: storedImages } : {}),
    },
    {
      conversationId: conversation._id,
      role: 'assistant',
      content: args.assistantMessage,
      model: args.modelKey,
      seq: seqBase + 1,
    },
  ]);

  // Touch updatedAt so the thread floats to the top of the history rail.
  await Conversation.updateOne({ _id: conversation._id }, { $set: { updatedAt: new Date() } });

  return { conversationId: String(conversation._id), title: conversation.title };
}

// ── GET /api/chat/usage ─────────────────────────────────────────────────────
export async function getUsage(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const now = Date.now();
  const tier = getTier(auth);

  // Premium is uncapped — report unlimited (limit: null) and don't read the
  // counter (premium messages are never counted).
  if (tier === 'premium') {
    res.json({
      used: 0,
      limit: null,
      remaining: null,
      premium: true,
      tier,
      resetAt: new Date(now + FREE_WINDOW_MS).toISOString(),
    });
    return;
  }

  const limit = limitForTier(tier);
  const usage = await ChatUsage.findOne({ clerkUserId: auth.userId });
  const { used, resetAt } = snapshotUsage(usage?.windowStartedAt, usage?.count ?? 0, now);
  res.json({
    used,
    limit,
    remaining: Math.max(0, limit - used),
    premium: false,
    tier,
    resetAt,
  });
}

// ── GET /api/chat/conversations (Phase 3, paid tiers only) ──────────────────
export async function listConversations(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!hasCore(auth)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const filter: Record<string, unknown> = { clerkUserId: auth.userId };
  const scope = req.query.scope;
  if (scope === 'article' || scope === 'resolve' || scope === 'brief') filter.scope = scope;
  const articleId = req.query.articleId;
  if (typeof articleId === 'string' && mongoose.isValidObjectId(articleId)) {
    filter.articleId = new mongoose.Types.ObjectId(articleId);
  }
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));

  const conversations = await Conversation.find(filter)
    .sort({ updatedAt: -1 })
    .limit(limit)
    .lean();

  res.json(
    conversations.map((c) => ({
      id: String(c._id),
      title: c.title,
      scope: c.scope,
      articleId: c.articleId ? String(c.articleId) : undefined,
      updatedAt: c.updatedAt,
    })),
  );
}

// ── GET /api/chat/conversations/:id (Phase 3, paid tiers only) ──────────────
export async function getConversationDetail(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!hasCore(auth)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const tier = getTier(auth);

  // Ownership-checked: a conversation only resolves for its owner.
  const conversation = await Conversation.findOne({
    _id: req.params.id,
    clerkUserId: auth.userId,
  }).lean();
  if (!conversation) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Oldest→newest by the monotonic `seq`. createdAt then _id break ties so
  // pre-`seq` legacy rows (seq missing → sorts first) still read back in
  // insertion order (user before assistant) instead of swapping on equal timestamps.
  const messages = await ChatMessage.find({ conversationId: conversation._id })
    .sort({ seq: 1, createdAt: 1, _id: 1 })
    .lean();

  // A thread can outlive the reader's access to the article it is about: a plan
  // lapses, or an editor gates a story that was open when the thread started.
  // Resolved here rather than by the client, which would have to re-derive
  // entitlement from Clerk and re-fetch the article to do it. `locked` is the
  // same decision `postChat` makes on the next send — sent up front so the
  // client can offer the upgrade instead of composing a message into a 403.
  let articleAccess: { gateTier: GateTier | null; locked: boolean } | undefined;
  if (conversation.articleId) {
    const article = await Article.findById(conversation.articleId).select('gateTier').lean();
    const gateTier = article?.gateTier ?? null;
    articleAccess = { gateTier, locked: gateTier !== null && !tierAtLeast(tier, gateTier) };
  }

  res.json({
    id: String(conversation._id),
    title: conversation.title,
    scope: conversation.scope,
    articleId: conversation.articleId ? String(conversation.articleId) : undefined,
    ...(articleAccess ? { articleAccess } : {}),
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      model: m.model,
      createdAt: m.createdAt,
      ...(m.images?.length
        ? { images: m.images.map((img) => ({ url: img.url, mimeType: img.mimeType })) }
        : {}),
    })),
  });
}

// ── PATCH /api/chat/conversations/:id (Phase 3, paid tiers only) ────────────
const TITLE_MAX_LEN = 200;

export async function renameConversation(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!hasCore(auth)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const rawTitle = (req.body ?? {}).title;
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : '';
  if (!title || title.length > TITLE_MAX_LEN) {
    res.status(400).json({ error: 'invalid_title' });
    return;
  }

  // Ownership-checked: a conversation only resolves for its owner.
  const conversation = await Conversation.findOne({
    _id: req.params.id,
    clerkUserId: auth.userId,
  });
  if (!conversation) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  conversation.title = title;
  await conversation.save(); // timestamps:true bumps updatedAt

  res.json({
    id: String(conversation._id),
    title: conversation.title,
    scope: conversation.scope,
    articleId: conversation.articleId ? String(conversation.articleId) : undefined,
    updatedAt: conversation.updatedAt,
  });
}

// ── DELETE /api/chat/conversations/:id (Phase 3, paid tiers only) ───────────
export async function deleteConversation(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!hasCore(auth)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Ownership-checked: a conversation only resolves for its owner.
  const conversation = await Conversation.findOne({
    _id: req.params.id,
    clerkUserId: auth.userId,
  });
  if (!conversation) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // Remove any attached images from S3 first (best-effort), so deleting a thread
  // doesn't orphan its uploads.
  const withImages = await ChatMessage.find({
    conversationId: conversation._id,
    'images.0': { $exists: true },
  })
    .select('images')
    .lean();
  for (const m of withImages) {
    for (const img of m.images ?? []) {
      await deleteS3Object(img.key).catch((err) => {
        console.warn('[chat] failed to delete image from S3:', (err as Error).message);
      });
    }
  }

  // Cascade: drop the thread's messages, then the thread itself, so no
  // ChatMessage docs are left orphaned.
  await ChatMessage.deleteMany({ conversationId: conversation._id });
  await Conversation.deleteOne({ _id: conversation._id });

  res.status(204).end();
}
