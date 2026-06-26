import {
  GoogleGenAI,
  HarmCategory,
  HarmBlockThreshold,
  type SafetySetting,
  type Content,
} from '@google/genai';
import type { PlanTier } from '../middleware/auth';

// ── Config (env-driven; model IDs never hardcoded) ──────────────────────────
const API_KEY = process.env.GEMINI_API_KEY;
const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-flash-latest';
const CHAT_MODEL_THINKING = process.env.GEMINI_CHAT_MODEL_THINKING || CHAT_MODEL;
const CHAT_MODEL_PRO = process.env.GEMINI_CHAT_MODEL_PRO || CHAT_MODEL;
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
export const EMBED_DIM = Number(process.env.GEMINI_EMBED_DIM) || 768;

if (!API_KEY) {
  // Warn loudly at boot rather than failing every request with an opaque 500.
  console.warn('[gemini] GEMINI_API_KEY is not set — chat & embeddings will fail.');
}

// Single shared client. The SDK is a thin HTTP wrapper; no connection pooling concerns.
let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: API_KEY });
  return client;
}

export type ChatRole = 'user' | 'assistant';
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

// Neutral defaults: block only HIGH-probability harmful content so legitimate
// Pakistani political/defence journalism (which discusses violence, militancy,
// contested topics) is not over-filtered. Tone/neutrality is steered by the
// system prompt; these settings backstop genuinely harmful output.
export const DEFAULT_SAFETY_SETTINGS: SafetySetting[] = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  {
    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
  },
  {
    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
    threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
  },
];

// Stable product model keys (NOT the UI labels). Each maps to a provider model
// id (env) and has a minimum tier; tiers unlock models cumulatively:
//   Free → velo · Standard → velo, core · Premium → velo, core, max
export type ChatModelKey = 'velo' | 'core' | 'max';

const MODEL_BY_KEY: Record<ChatModelKey, string> = {
  velo: CHAT_MODEL,
  core: CHAT_MODEL_THINKING,
  max: CHAT_MODEL_PRO,
};

// Highest model key each tier may use (inclusive of all lower keys).
const MAX_MODEL_FOR_TIER: Record<PlanTier, ChatModelKey> = {
  free: 'velo',
  standard: 'core',
  premium: 'max',
};

const MODEL_ORDER: ChatModelKey[] = ['velo', 'core', 'max'];

// Resolve the requested model to a provider id, clamped to the tier's ceiling.
// Server-authoritative: an out-of-tier or unknown/missing key falls back to the
// best model the tier allows (never trust the client).
export function resolveModel(requested: string | undefined, tier: PlanTier): string {
  const ceiling = MAX_MODEL_FOR_TIER[tier];
  const ceilingIdx = MODEL_ORDER.indexOf(ceiling);
  const requestedIdx = MODEL_ORDER.indexOf(requested as ChatModelKey);
  const key: ChatModelKey =
    requestedIdx >= 0 && requestedIdx <= ceilingIdx ? (requested as ChatModelKey) : ceiling;
  return MODEL_BY_KEY[key];
}

// Gemini uses the role 'model' for assistant turns.
function toGeminiContents(history: ChatTurn[], message: string): Content[] {
  const contents: Content[] = history.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content }],
  }));
  contents.push({ role: 'user', parts: [{ text: message }] });
  return contents;
}

export interface StreamChatParams {
  model: string;
  systemPrompt: string;
  history: ChatTurn[];
  message: string;
  safetySettings?: SafetySetting[];
  signal?: AbortSignal;
}

// Streams text deltas from Gemini. Throws on upstream failure (caller decides
// whether headers were already sent). Respects an AbortSignal for client-disconnect.
export async function* streamChat(params: StreamChatParams): AsyncGenerator<string> {
  const { model, systemPrompt, history, message, safetySettings, signal } = params;
  const stream = await ai().models.generateContentStream({
    model,
    contents: toGeminiContents(history, message),
    config: {
      systemInstruction: systemPrompt,
      safetySettings: safetySettings ?? DEFAULT_SAFETY_SETTINGS,
      abortSignal: signal,
    },
  });
  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) yield text;
  }
}

export async function generateText(params: {
  model?: string;
  systemPrompt: string;
  message: string;
  safetySettings?: SafetySetting[];
}): Promise<string> {
  const response = await ai().models.generateContent({
    model: params.model || CHAT_MODEL,
    contents: [{ role: 'user', parts: [{ text: params.message }] }],
    config: {
      systemInstruction: params.systemPrompt,
      safetySettings: params.safetySettings ?? DEFAULT_SAFETY_SETTINGS,
    },
  });
  return response.text ?? '';
}

// 'RETRIEVAL_DOCUMENT' for stored article chunks, 'RETRIEVAL_QUERY' for the
// user's question — Gemini embeds them into the same space but asymmetrically
// for better retrieval. Returns one vector per input, in order.
export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' | 'SEMANTIC_SIMILARITY';

export async function embed(
  texts: string[],
  taskType: EmbedTaskType = 'RETRIEVAL_DOCUMENT',
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await ai().models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
    config: { taskType, outputDimensionality: EMBED_DIM },
  });
  const embeddings = res.embeddings ?? [];
  return embeddings.map((e) => {
    const values = e.values ?? [];
    return normalizeIfNeeded(values);
  });
}

// gemini-embedding-001 returns L2-normalized vectors only at 3072 dims; at
// reduced output dimensionality the vectors must be re-normalized before cosine
// search. Harmless when already unit-length.
function normalizeIfNeeded(values: number[]): number[] {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const norm = Math.sqrt(sumSq);
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return values;
  return values.map((v) => v / norm);
}
