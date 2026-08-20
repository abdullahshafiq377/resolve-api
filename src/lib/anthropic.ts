import Anthropic from '@anthropic-ai/sdk';
import type { PlanTier } from '../middleware/auth';

// ── Config (env-driven; model IDs never hardcoded) ──────────────────────────
// The SDK reads ANTHROPIC_API_KEY on its own, but the deployed env names the key
// CLAUDE_API_KEY. Accept either so neither name is load-bearing.
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

const CHAT_MODEL_VELO = process.env.ANTHROPIC_CHAT_MODEL_VELO || 'claude-sonnet-5';
const CHAT_MODEL_CORE = process.env.ANTHROPIC_CHAT_MODEL_CORE || 'claude-opus-5';
const CHAT_MODEL_MAX = process.env.ANTHROPIC_CHAT_MODEL_MAX || 'claude-opus-5';

const WEB_SEARCH_MAX_USES = Math.max(1, Number(process.env.WEB_SEARCH_MAX_USES) || 5);

// `max_uses` is enforced per REQUEST, not per turn — and one turn can span several
// requests, because a paused turn is resumed by re-sending (see MAX_PAUSE_CONTINUATIONS).
// Sending the full figure on every resume handed each continuation a fresh budget, so the
// real ceiling was WEB_SEARCH_MAX_USES x (MAX_PAUSE_CONTINUATIONS + 1) — 20 searches
// against a documented 5 (FINDINGS F-141). The budget is now carried across continuations:
// each resume asks for what is left, and a turn that has spent it all resumes with no
// search tool at all, which makes the model answer from what it already gathered rather
// than burning a request on a tool it cannot use.
export function searchBudgetRemaining(used: number): number {
  return Math.max(0, WEB_SEARCH_MAX_USES - used);
}

// Ceiling for the non-streaming utility calls (Brief, AI Summary). Both produce
// short structured JSON; the cap exists so a runaway generation cannot bill
// without limit, not because the output should ever approach it.
const UTILITY_MAX_TOKENS = 4_096;

// A server-side tool loop can stop with stop_reason 'pause_turn' after 10 internal
// iterations. We re-send to resume, but bounded — an unbounded loop would let one
// turn spend without limit.
const MAX_PAUSE_CONTINUATIONS = 3;

if (!API_KEY) {
  // Warn loudly at boot rather than failing every request with an opaque 500.
  console.warn('[anthropic] ANTHROPIC_API_KEY / CLAUDE_API_KEY is not set — chat will fail.');
}

// Single shared client. The SDK is a thin HTTP wrapper; no connection pooling concerns.
let client: Anthropic | null = null;
function ai(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: API_KEY });
  return client;
}

export type ChatRole = 'user' | 'assistant';
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

// An image attached to the current user turn, sent inline (base64, no `data:`
// prefix). History turns are text-only. `mimeType` is the wire name the composer
// already produces; it maps to Claude's `media_type`.
export interface ChatImage {
  mimeType: string;
  data: string;
}

// Claude accepts exactly these four. The composer used to hand anything `image/*`
// straight to Gemini, which was more permissive — an iPhone HEIC upload now 400s
// instead of being described, so the allowlist is enforced at the edge.
export const SUPPORTED_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;

export function isSupportedImageMimeType(mimeType: string): boolean {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

// Stable product model keys (NOT the UI labels). Each maps to a provider model
// id (env) and has a minimum tier; tiers unlock models cumulatively:
//   Free → velo · Core → velo, core · Premium → velo, core, max
export type ChatModelKey = 'velo' | 'core' | 'max';

export const CHAT_MODEL_KEYS: readonly ChatModelKey[] = ['velo', 'core', 'max'] as const;

const MODEL_BY_KEY: Record<ChatModelKey, string> = {
  velo: CHAT_MODEL_VELO,
  core: CHAT_MODEL_CORE,
  max: CHAT_MODEL_MAX,
};

// Highest model key each tier may use (inclusive of all lower keys).
const MAX_MODEL_FOR_TIER: Record<PlanTier, ChatModelKey> = {
  free: 'velo',
  core: 'core',
  premium: 'max',
};

const MODEL_ORDER: ChatModelKey[] = ['velo', 'core', 'max'];

// Resolve the requested model to a Resolve model KEY, clamped to the tier's
// ceiling. Server-authoritative: an out-of-tier or unknown/missing key falls back
// to the best model the tier allows (never trust the client).
//
// The key, not the provider id, is what gets persisted and returned to clients —
// directive §7 forbids naming the engine anywhere user-facing.
export function resolveModelKey(requested: string | undefined, tier: PlanTier): ChatModelKey {
  const ceiling = MAX_MODEL_FOR_TIER[tier];
  const ceilingIdx = MODEL_ORDER.indexOf(ceiling);
  const requestedIdx = MODEL_ORDER.indexOf(requested as ChatModelKey);
  return requestedIdx >= 0 && requestedIdx <= ceilingIdx ? (requested as ChatModelKey) : ceiling;
}

// The provider model id for a resolved key. Kept separate from resolveModelKey so
// the id never has to travel further than the API call itself.
export function providerModelFor(key: ChatModelKey): string {
  return MODEL_BY_KEY[key];
}

// ── Per-tier request shape ──────────────────────────────────────────────────
// Three tiers, two provider models: velo runs Sonnet 5, core and max both run
// Opus 5 and are separated by `effort` alone (core high, max max).
//
//   · `output_config.effort` is supported on both Sonnet 5 and Opus 5 across the
//     full low–max range, so every tier now carries one. The Haiku 4.5 constraint
//     that forced velo to omit it no longer applies.
//   · Every tier now takes the dynamic-filtering `web_search_20260209`. The basic
//     `web_search_20250305` existed only because Haiku 4.5 rejected the newer
//     tool, which closes the migration plan's open item 5 (velo search quality).
//   · Omitting `thinking` is NOT a safe default — it has meant different things on
//     different models — so it is always explicit. Thinking is ON for all three:
//     it is also the routing fix for F-006, since a model with no thinking channel
//     plans in a visible text block instead, and the stream loop drops `thinking`
//     blocks but forwards `text`.
//   · `thinking: {type:'disabled'}` is rejected on Opus 5 at effort xhigh/max, so
//     max could not disable it even if we wanted to.
//
// max_tokens caps thinking AND response text together, so every tier needs
// headroom well above the visible answer.
interface TierConfig {
  model: string;
  maxTokens: number;
  thinking: { type: 'adaptive' } | { type: 'disabled' };
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  webSearchType: 'web_search_20250305' | 'web_search_20260209';
}

const TIER_CONFIG: Record<ChatModelKey, TierConfig> = {
  velo: {
    model: MODEL_BY_KEY.velo,
    // Was 4,096 for Haiku with thinking off. Sonnet 5 thinks inside the same cap,
    // so the old ceiling would truncate a long free-tier answer.
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS_VELO) || 16_000,
    thinking: { type: 'adaptive' },
    // 'low' first, then raised: at low effort velo narrated its own retrieval in 4 of 8
    // harness runs while core (same family, effort high) narrated in 0 of 8 — thinking
    // depth is what keeps planning out of the visible text block (F-006).
    effort: 'medium',
    webSearchType: 'web_search_20260209',
  },
  core: {
    model: MODEL_BY_KEY.core,
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS_CORE) || 32_000,
    thinking: { type: 'adaptive' },
    effort: 'high',
    webSearchType: 'web_search_20260209',
  },
  max: {
    model: MODEL_BY_KEY.max,
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS_MAX) || 64_000,
    thinking: { type: 'adaptive' },
    effort: 'max',
    webSearchType: 'web_search_20260209',
  },
};

// Appended to the system prompt for the one request that resumes a turn whose
// search budget is gone. Without it the model finds itself with no search tool,
// treats that absence as news, and tells the reader about it — three of eight runs
// in the 19 August sweep said "against a search limit just now", "the REPL is fine
// now", "my check of outside sources did not come back" (F-006, the directive §7
// half). Telling it not to mention the limit was not enough on its own; it needs
// the sentence it is supposed to write instead.
const SOURCES_EXHAUSTED_DIRECTIVE = `

# Sources for this turn
You now have all the source material you are going to get for this turn. Write the
answer from what you already have.

Never tell the reader anything about how the material was gathered. Do not mention
searching, tools, retries, limits, quotas, budgets, sessions or why you stopped
looking — none of that exists as far as the reader is concerned, and naming it
breaks the white-label rule in the same way naming the model would.

Where something could not be established, say so in editorial terms and move on:
"I could not confirm the latest figure", "there is no reliable public reporting on
this yet". Never explain why.`;

// ── Narration filter ────────────────────────────────────────────────────────
// F-006: the model plans its retrieval out loud, and that planning arrives as its
// own assistant text block sitting between the tool calls — which is why the
// narration and the answer run together with no space at the join ("…in 2026.Now
// let me search…"). The prompt cannot govern it, because the Voice section is
// about the answer and the model does not consider this to be the answer.
//
// It can be recognised structurally instead: a SHORT text block that a
// `server_tool_use` immediately follows was written to introduce that tool call,
// never to the reader. So a text block is held back until one of three things
// settles what it was:
//
//   · it passes NARRATION_HOLD_CHARS  — too long to be a hand-off line, so it is
//     the answer: flush it and stream the rest of that block live
//   · a tool call starts             — it was narration: drop it unsent
//   · the turn ends, or another text block starts — nothing followed it, so it
//     was real text: flush it
//
// The cost is that the first NARRATION_HOLD_CHARS of an answer arrive in one piece
// rather than token by token. The risk is that a genuinely short piece of answer
// text followed by one more search is dropped; the threshold is set well above the
// length of every narration line observed (the longest was 96 characters) and well
// below a paragraph of answer, which is the trade this makes deliberately.
const NARRATION_HOLD_CHARS = 400;

export interface NarrationFilter {
  /** Text arriving in the current block. Returns what should be emitted now. */
  onText(text: string): string;
  /** A new text block began; anything still held belongs to the previous one. */
  onTextBlockStart(): string;
  /** A server tool call began; anything still held was its introduction. */
  onToolUse(): void;
  /** End of turn. Returns whatever is still held. */
  flush(): string;
}

export function createNarrationFilter(limit: number = NARRATION_HOLD_CHARS): NarrationFilter {
  let held = '';
  // Once a block is past the threshold it is the answer, and the rest of it
  // streams straight through — re-buffering it would stutter the output.
  let streaming = false;

  return {
    onText(text) {
      if (streaming) return text;
      held += text;
      if (held.length <= limit) return '';
      const out = held;
      held = '';
      streaming = true;
      return out;
    },
    onTextBlockStart() {
      const out = held;
      held = '';
      streaming = false;
      return out;
    },
    onToolUse() {
      held = '';
      streaming = false;
    },
    flush() {
      const out = held;
      held = '';
      streaming = false;
      return out;
    },
  };
}

// ── Stream events ───────────────────────────────────────────────────────────
// Web search runs server-side mid-turn, which stalls the text stream for seconds.
// Without a signal the client reads that pause as a hang, so the generator yields
// search transitions alongside text rather than text alone.
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'search'; status: 'started' | 'done' };

// Thrown when the model's safety classifiers decline the request. Surfaces as a
// distinct SSE error so a decline is not reported as an empty answer — Resolve
// covers militancy, defence and contested politics, which is exactly the terrain
// where a false positive is plausible.
export class ModelRefusalError extends Error {
  readonly category: string | null;
  constructor(category: string | null) {
    super('model_refused');
    this.name = 'ModelRefusalError';
    this.category = category;
  }
}

// Thrown when a non-streaming call hits `max_tokens` mid-generation. Under
// structured outputs that leaves syntactically invalid JSON, so without this the
// failure surfaces to an admin as "Unexpected end of JSON input" — which points at
// the parser rather than at the real cause.
export class ModelTruncatedError extends Error {
  constructor() {
    super('model_response_truncated');
    this.name = 'ModelTruncatedError';
  }
}

// History maps 1:1 except the role name ('assistant', not Gemini's 'model').
// Images ride on the current turn as base64 blocks.
function toMessages(
  history: ChatTurn[],
  message: string,
  images: ChatImage[],
): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = history.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const content: Anthropic.ContentBlockParam[] = [];
  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: img.data,
      },
    });
  }
  // Text last: with an image-only turn the model needs something to answer, and a
  // trailing instruction reads better than a leading one.
  if (message) content.push({ type: 'text', text: message });
  if (content.length === 0) content.push({ type: 'text', text: ' ' });

  messages.push({ role: 'user', content });
  return messages;
}

export interface StreamChatParams {
  modelKey: ChatModelKey;
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  images?: ChatImage[];
  signal?: AbortSignal;
}

// Streams the assistant turn. Throws on upstream failure (caller decides whether
// headers were already sent) and on a safety decline. Respects an AbortSignal for
// client-disconnect.
export async function* streamChat(params: StreamChatParams): AsyncGenerator<ChatStreamEvent> {
  const cfg = TIER_CONFIG[params.modelKey];
  const messages = toMessages(params.history, params.message, params.images ?? []);

  // Spans the whole turn, every continuation included.
  let searchesUsed = 0;

  // Also spans the whole turn: a text block can be the last thing in a paused
  // message and be followed by a tool call in the message that resumes it, so the
  // held text has to survive the continuation boundary to be judged correctly.
  const narration = createNarrationFilter();

  for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt += 1) {
    const budget = searchBudgetRemaining(searchesUsed);
    const stream = ai().messages.stream(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system: budget > 0 ? params.systemPrompt : params.systemPrompt + SOURCES_EXHAUSTED_DIRECTIVE,
        thinking: cfg.thinking,
        ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
        tools: budget > 0
          ? [
              {
                type: cfg.webSearchType,
                name: 'web_search',
                max_uses: budget,
              } as Anthropic.ToolUnion,
            ]
          : [],
        messages,
      },
      { signal: params.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          // Whatever text was held introduced this search rather than addressing
          // the reader, so it is dropped rather than emitted (F-006).
          narration.onToolUse();
          searchesUsed += 1;
          yield { type: 'search', status: 'started' };
        } else if (block.type === 'text') {
          const flushed = narration.onTextBlockStart();
          if (flushed) yield { type: 'text', text: flushed };
        } else if (block.type === 'web_search_tool_result') {
          // A server-tool failure arrives as HTTP 200 with an error OBJECT here
          // rather than a list of results, so this must not be iterated blindly.
          const content = block.content as unknown;
          if (!Array.isArray(content)) {
            const code = (content as { error_code?: string })?.error_code ?? 'unknown';
            console.warn('[anthropic] web_search failed:', code);
          }
          yield { type: 'search', status: 'done' };
        }
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        const out = narration.onText(event.delta.text);
        if (out) yield { type: 'text', text: out };
      }
    }

    const finalMessage = await stream.finalMessage();

    if (finalMessage.stop_reason === 'refusal') {
      throw new ModelRefusalError(finalMessage.stop_details?.category ?? null);
    }

    if (finalMessage.stop_reason !== 'pause_turn') {
      // The turn is over, so nothing can follow the held text: it was real.
      const tail = narration.flush();
      if (tail) yield { type: 'text', text: tail };
      return;
    }

    // Paused mid-turn. Append the assistant turn and re-send; the API detects the
    // trailing server_tool_use block and resumes on its own — deliberately no
    // extra "Continue." user message.
    messages.push({ role: 'assistant', content: finalMessage.content });
  }

  // Out of continuations rather than finished, but the same reasoning applies —
  // nothing further will arrive to prove the held text was a hand-off line.
  const tail = narration.flush();
  if (tail) yield { type: 'text', text: tail };

  console.warn('[anthropic] gave up resuming after', MAX_PAUSE_CONTINUATIONS, 'pause_turn continuations');
}

// ── One-shot generation (Brief, AI Summary) ─────────────────────────────────

export interface GenerateTextParams {
  // Required, not defaulted. The Gemini version defaulted a missing model to the
  // chat model, which is how GEMINI_BRIEF_MODEL came to be set in two envs and
  // read by nothing (FINDINGS AI3). A required argument makes that class of
  // silent fallthrough impossible.
  model: string;
  systemPrompt: string;
  message: string;
  maxTokens?: number;
  // A JSON Schema. When present the model is constrained to emit exactly this
  // shape rather than being asked for JSON in prose. Verified against the live
  // API: properties omitted from `required` are genuinely optional, nullable
  // type-arrays are accepted, and nested arrays of objects work — but every
  // object needs `additionalProperties: false`, and the size keywords
  // (minItems/maxItems/minLength/…) are dropped, so any count or length rule
  // still has to be enforced after parsing.
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
}

// Non-streaming generation for the jobs that want a whole answer at once. These
// are batch/admin paths with no reader waiting on a token stream, so thinking is
// off: it would multiply cost across every brief signature for output whose shape
// is already pinned by the schema.
export async function generateText(params: GenerateTextParams): Promise<string> {
  const message = await ai().messages.create(
    {
      model: params.model,
      max_tokens: params.maxTokens ?? UTILITY_MAX_TOKENS,
      system: params.systemPrompt,
      thinking: { type: 'disabled' },
      ...(params.schema
        ? { output_config: { format: { type: 'json_schema' as const, schema: params.schema } } }
        : {}),
      messages: [{ role: 'user', content: params.message }],
    },
    { signal: params.signal },
  );

  if (message.stop_reason === 'refusal') {
    throw new ModelRefusalError(message.stop_details?.category ?? null);
  }
  if (message.stop_reason === 'max_tokens') throw new ModelTruncatedError();

  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
