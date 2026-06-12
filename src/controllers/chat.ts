import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { getAuth } from '@clerk/express';
import Article from '../models/Article';
import ChatUsage from '../models/ChatUsage';
import Conversation, { ConversationDoc } from '../models/Conversation';
import ChatMessage from '../models/ChatMessage';
import { isPremium } from '../middleware/auth';
import { streamChat, resolveModel, type ChatTurn } from '../lib/gemini';
import { extractPlainText, approxTokens } from '../lib/articleText';
import { retrieveChunks, type RetrievedPassage } from '../services/articleEmbeddings';

// ── Constants (overview §3) ─────────────────────────────────────────────────
const FREE_DAILY_LIMIT = 4;
// Rolling free-tier window: 24h measured from each user's FIRST message, not a
// shared calendar day. See models/ChatUsage.
const FREE_WINDOW_MS = 24 * 60 * 60 * 1000;
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

// ── System prompt (requirements: neutral, journalistic, grounded) ───────────
const BASE_SYSTEM_PROMPT = `You are Resolve AI, the assistant for Resolve — a publication of dense, context-heavy Pakistani journalism. Your readers are often diaspora audiences who lack local background (institutions, acronyms, political history).

Guidelines:
- Be concise, clear, and neutral. Explain context plainly without sensational or partisan framing.
- On contested or politically sensitive topics, present perspectives even-handedly and attribute claims rather than asserting them as settled fact.
- State uncertainty honestly; do not invent facts, figures, names, dates, or quotes. If you are unsure or lack the information, say so.
- Decline requests that are harmful, illegal, or hateful.
- Prefer short paragraphs. Do not use markdown headings.`;

function articleContextPrompt(
  article: { title: string; category: string; publishDate: Date },
  bodyText: string,
): string {
  const meta = `Title: ${article.title}\nCategory: ${article.category}\nPublished: ${article.publishDate.toISOString().slice(0, 10)}`;
  return `${BASE_SYSTEM_PROMPT}

You are answering questions about ONE specific Resolve article. Base your answers on the article's text below. If the answer is not in the article, say the article does not cover it (you may add brief general context, clearly noting it goes beyond the article).

--- ARTICLE METADATA ---
${meta}

--- ARTICLE TEXT ---
${bodyText}`;
}

// Source-blind (invariant #4): the passages are injected as background the model
// may use, with no instruction to label what came from Resolve vs. its own knowledge.
function ragContextPrompt(passages: RetrievedPassage[]): string {
  let budget = RAG_PASSAGE_TOKEN_BUDGET;
  const kept: string[] = [];
  for (const p of passages) {
    const t = approxTokens(p.text);
    if (budget - t < 0) break;
    budget -= t;
    kept.push(p.text);
  }
  if (kept.length === 0) return BASE_SYSTEM_PROMPT;
  return `${BASE_SYSTEM_PROMPT}

Use the following background context where relevant to answer the question. Answer naturally; do not mention or label these passages or describe where the information came from.

--- BACKGROUND CONTEXT ---
${kept.join('\n\n---\n\n')}`;
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
  const premium = isPremium(auth);

  const body = (req.body ?? {}) as ChatBody;
  const scope = body.scope;
  const message = body.message;

  // Validate (before any Gemini call) — 400 on bad input.
  if (scope !== 'article' && scope !== 'resolve') {
    res.status(400).json({ error: 'invalid_scope' });
    return;
  }
  if (typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'invalid_message' });
    return;
  }
  const articleId = typeof body.articleId === 'string' ? body.articleId : undefined;
  if (scope === 'article' && !articleId) {
    res.status(400).json({ error: 'articleId_required' });
    return;
  }

  // Daily limit (free users only) — 429 BEFORE any Gemini call, no SSE headers.
  // The window is per-user and rolling: only blocks when the user has an ACTIVE
  // window (first message < 24h ago) that's already hit the cap. An expired
  // window is ignored here and re-anchored on the successful send below.
  if (!premium) {
    const usage = await ChatUsage.findOne({ clerkUserId });
    if (
      usage &&
      Date.now() - usage.windowStartedAt.getTime() < FREE_WINDOW_MS &&
      usage.count >= FREE_DAILY_LIMIT
    ) {
      res.status(429).json({ error: 'daily_limit_reached', upgrade: true, reason: 'daily_limit' });
      return;
    }
  }

  const history = sanitizeHistory(body.history);

  // Build the system prompt / grounding context.
  let systemPrompt = BASE_SYSTEM_PROMPT;
  let articleDoc: { title: string; category: string; publishDate: Date } | null = null;

  if (scope === 'article') {
    if (!mongoose.isValidObjectId(articleId)) {
      res.status(400).json({ error: 'invalid_articleId' });
      return;
    }
    const article = await Article.findById(articleId);
    if (!article) {
      res.status(400).json({ error: 'article_not_found' });
      return;
    }
    const contextDoc = {
      title: article.title,
      category: article.category ?? '',
      publishDate: article.publishDate,
    };
    articleDoc = contextDoc;
    let text = extractPlainText(article.body);
    if (text.length > ARTICLE_CHAR_CAP) {
      text = `${text.slice(0, ARTICLE_CHAR_CAP)}\n\n[Article truncated for length.]`;
    }
    systemPrompt = articleContextPrompt(contextDoc, text);
  } else {
    // scope:'resolve' — RAG over the published corpus. Degrades to general
    // knowledge if the index is empty/unbuilt (retrieveChunks returns []).
    const passages = await retrieveChunks(message, { k: 6 });
    systemPrompt = ragContextPrompt(passages);
  }

  // Resolve the model (Phase 3). Free / unknown key -> default model.
  const requestedModel = typeof body.model === 'string' ? body.model : undefined;
  const modelId = resolveModel(requestedModel, premium);

  // Resume target (Phase 3, premium): validate ownership now; create-on-success
  // if absent. Never append to someone else's conversation — treat a foreign/
  // unknown id as a fresh thread.
  let existingConversation: ConversationDoc | null = null;
  if (premium && typeof body.conversationId === 'string' && mongoose.isValidObjectId(body.conversationId)) {
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
    for await (const delta of streamChat({
      model: modelId,
      systemPrompt,
      history,
      message,
      signal: controller.signal,
    })) {
      if (clientGone) break;
      assistantText += delta;
      sse(res, { delta });
    }
  } catch (err) {
    // Client disconnect: do nothing — no quota burn, no persistence (invariant 1).
    if (clientGone) return;
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

  // ── Success: persist (premium) + count (free), then terminal frame ──────────
  let donePayload: Record<string, unknown> = { done: true };
  try {
    if (premium) {
      const result = await persistTurn({
        existingConversation,
        clerkUserId,
        scope,
        articleId,
        articleTitle: articleDoc?.title,
        userMessage: message,
        assistantMessage: assistantText,
        model: modelId,
      });
      donePayload = { done: true, conversationId: result.conversationId, title: result.title };
    } else {
      // Free tier: nothing is persisted; advance the rolling-window counter.
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
  scope: 'article' | 'resolve';
  articleId?: string;
  articleTitle?: string;
  userMessage: string;
  assistantMessage: string;
  model: string;
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

  // Monotonic per-conversation sequence so the user turn always precedes its
  // assistant reply, even when both rows land in the same millisecond. Count of
  // existing messages is the next index (0 for a fresh thread; 2, 4, … on append).
  const seqBase = await ChatMessage.countDocuments({ conversationId: conversation._id });

  await ChatMessage.create([
    { conversationId: conversation._id, role: 'user', content: args.userMessage, seq: seqBase },
    {
      conversationId: conversation._id,
      role: 'assistant',
      content: args.assistantMessage,
      model: args.model,
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

  if (isPremium(auth)) {
    res.json({
      used: 0,
      limit: FREE_DAILY_LIMIT,
      remaining: FREE_DAILY_LIMIT,
      premium: true,
      resetAt: new Date(now + FREE_WINDOW_MS).toISOString(),
    });
    return;
  }

  const usage = await ChatUsage.findOne({ clerkUserId: auth.userId });
  const { used, resetAt } = snapshotUsage(usage?.windowStartedAt, usage?.count ?? 0, now);
  res.json({
    used,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - used),
    premium: false,
    resetAt,
  });
}

// ── GET /api/chat/conversations (Phase 3, premium only) ─────────────────────
export async function listConversations(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isPremium(auth)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const filter: Record<string, unknown> = { clerkUserId: auth.userId };
  const scope = req.query.scope;
  if (scope === 'article' || scope === 'resolve') filter.scope = scope;
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

// ── GET /api/chat/conversations/:id (Phase 3, premium only) ─────────────────
export async function getConversationDetail(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isPremium(auth)) {
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

  res.json({
    id: String(conversation._id),
    title: conversation.title,
    scope: conversation.scope,
    articleId: conversation.articleId ? String(conversation.articleId) : undefined,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      model: m.model,
      createdAt: m.createdAt,
    })),
  });
}

// ── PATCH /api/chat/conversations/:id (Phase 3, premium only) ───────────────
const TITLE_MAX_LEN = 200;

export async function renameConversation(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isPremium(auth)) {
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

// ── DELETE /api/chat/conversations/:id (Phase 3, premium only) ──────────────
export async function deleteConversation(req: Request, res: Response): Promise<void> {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  if (!isPremium(auth)) {
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

  // Cascade: drop the thread's messages, then the thread itself, so no
  // ChatMessage docs are left orphaned.
  await ChatMessage.deleteMany({ conversationId: conversation._id });
  await Conversation.deleteOne({ _id: conversation._id });

  res.status(204).end();
}
