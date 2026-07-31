import type { AiSummaryContent, AiSummaryFormat } from '../models/ArticleSummary';
import type { ArticleDoc } from '../models/Article';
import { extractPlainText } from '../lib/articleText';
import { generateText, ModelRefusalError, ModelTruncatedError } from '../lib/anthropic';
import { EDITORIAL_VOICE_PROMPT } from '../lib/editorialVoice';
import { httpError } from '../utils/errors';
import { assertAiSummaryContentValid } from './aiSummaryValidation';

const BODY_CHAR_LIMIT = Math.max(1000, Number(process.env.AI_SUMMARY_BODY_CHAR_LIMIT) || 14000);
const MODEL = process.env.ANTHROPIC_SUMMARY_MODEL || 'claude-sonnet-5';

// Structured outputs pin the shape, so the fence-stripping below should never
// fire. Kept as a cheap fallback: it costs one regex on a path that already
// parses JSON, and it is the difference between a bad day and an outage if the
// constraint is ever relaxed.
function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(stripJsonFence(raw));
  } catch {
    throw httpError(502, 'ai_summary_invalid_json');
  }
}

// The bullet count (2-4) and the length ceilings are NOT expressible here —
// structured outputs drops minItems/maxItems/maxLength. They stay enforced by
// assertAiSummaryContentValid after parsing, and are restated in the prompt.
export const SCHEMA_BY_FORMAT: Record<AiSummaryFormat, Record<string, unknown>> = {
  bullets: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'string' } } },
    required: ['items'],
    additionalProperties: false,
  },
  paragraph: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

function promptFor(format: AiSummaryFormat): string {
  if (format === 'bullets') {
    return 'Write between 2 and 4 concise bullets — never fewer than 2, never more than 4. Each bullet is one sentence, no labels or leading dashes.';
  }
  return 'Write one concise paragraph, neutral and useful.';
}

export async function generateAiSummary(article: ArticleDoc, format: AiSummaryFormat): Promise<{
  content: AiSummaryContent;
  model: string;
}> {
  const plainText = extractPlainText(article.body).slice(0, BODY_CHAR_LIMIT);
  if (plainText.length < 20) throw httpError(422, 'article_body_empty');

  let raw: string;
  try {
    raw = await generateText({
      model: MODEL,
      schema: SCHEMA_BY_FORMAT[format],
      systemPrompt: `You are Resolve AI Summary, an editorial assistant for Pakistani news. Summarize only the supplied article. Preserve its facts and avoid speculation.

${EDITORIAL_VOICE_PROMPT}`,
      message: JSON.stringify({
        title: article.title,
        excerpt: article.excerpt,
        format,
        instruction: promptFor(format),
        articleText: plainText,
      }),
    });
  } catch (err) {
    // Both are HTTP 200 responses with unusable content, so they would otherwise
    // fall through to the parser and surface as a JSON error pointing at the
    // wrong thing. A refusal in particular is a judgement about the article, and
    // a moderator retrying it forever will not change that.
    if (err instanceof ModelRefusalError) throw httpError(502, 'ai_summary_declined');
    if (err instanceof ModelTruncatedError) throw httpError(502, 'ai_summary_truncated');
    throw err;
  }

  // An empty body means the model returned nothing — an exhausted or invalid API
  // key, or a quota error. Say that, rather than letting JSON.parse('') throw an
  // opaque "Unexpected end of input".
  if (!raw.trim()) throw httpError(502, 'ai_summary_empty_response');

  const parsed = parseJson(raw);
  return {
    content: assertAiSummaryContentValid(format, parsed),
    // Admin-only field (see FINDINGS AI4): serialized by controllers/aiSummary
    // behind the admin routes and absent from the public article payload, so this
    // is not the user-facing engine name directive §7 forbids. It must not be
    // added to a reader-facing response without being white-labelled first.
    model: MODEL,
  };
}
