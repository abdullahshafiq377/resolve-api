import Anthropic from '@anthropic-ai/sdk';
import type { PlanTier } from '../middleware/auth';

// ── Config (env-driven; model IDs never hardcoded) ──────────────────────────
// The SDK reads ANTHROPIC_API_KEY on its own, but the deployed env names the key
// CLAUDE_API_KEY. Accept either so neither name is load-bearing.
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;

const CHAT_MODEL_VELO = process.env.ANTHROPIC_CHAT_MODEL_VELO || 'claude-haiku-4-5';
const CHAT_MODEL_CORE = process.env.ANTHROPIC_CHAT_MODEL_CORE || 'claude-sonnet-5';
const CHAT_MODEL_MAX = process.env.ANTHROPIC_CHAT_MODEL_MAX || 'claude-opus-4-8';

const WEB_SEARCH_MAX_USES = Math.max(1, Number(process.env.WEB_SEARCH_MAX_USES) || 5);

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
//   Free → velo · Standard → velo, core · Premium → velo, core, max
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
  standard: 'core',
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
// The three tiers do NOT share one config shape, and the differences are hard
// API constraints rather than preferences (all verified against the live API):
//
//   · `output_config.effort` is rejected on Haiku 4.5 ("This model does not
//     support the effort parameter") — velo must omit it entirely.
//   · The dynamic-filtering web search tool `web_search_20260209` is rejected on
//     Haiku 4.5; velo gets the older basic `web_search_20250305`. Behaviourally
//     the same, noisier results.
//   · Omitting `thinking` is NOT a safe default: Sonnet 5 runs adaptive when the
//     field is absent while Opus 4.8 runs without thinking. Both are set
//     explicitly so neither depends on a per-model default.
//
// max_tokens caps thinking AND response text together, so core/max carry more
// headroom than the visible answer needs.
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
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS_VELO) || 4_096,
    thinking: { type: 'disabled' },
    webSearchType: 'web_search_20250305',
  },
  core: {
    model: MODEL_BY_KEY.core,
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS_CORE) || 16_000,
    thinking: { type: 'adaptive' },
    effort: 'medium',
    webSearchType: 'web_search_20260209',
  },
  max: {
    model: MODEL_BY_KEY.max,
    maxTokens: Number(process.env.ANTHROPIC_MAX_TOKENS_MAX) || 24_000,
    thinking: { type: 'adaptive' },
    effort: 'high',
    webSearchType: 'web_search_20260209',
  },
};

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

  for (let attempt = 0; attempt <= MAX_PAUSE_CONTINUATIONS; attempt += 1) {
    const stream = ai().messages.stream(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        system: params.systemPrompt,
        thinking: cfg.thinking,
        ...(cfg.effort ? { output_config: { effort: cfg.effort } } : {}),
        tools: [
          {
            type: cfg.webSearchType,
            name: 'web_search',
            max_uses: WEB_SEARCH_MAX_USES,
          } as Anthropic.ToolUnion,
        ],
        messages,
      },
      { signal: params.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'server_tool_use' && block.name === 'web_search') {
          yield { type: 'search', status: 'started' };
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
        yield { type: 'text', text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();

    if (finalMessage.stop_reason === 'refusal') {
      throw new ModelRefusalError(finalMessage.stop_details?.category ?? null);
    }

    if (finalMessage.stop_reason !== 'pause_turn') return;

    // Paused mid-turn. Append the assistant turn and re-send; the API detects the
    // trailing server_tool_use block and resumes on its own — deliberately no
    // extra "Continue." user message.
    messages.push({ role: 'assistant', content: finalMessage.content });
  }

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
