import type { AiSummaryContent, AiSummaryFormat } from '../models/ArticleSummary';
import type { ArticleDoc } from '../models/Article';
import { extractPlainText } from '../lib/articleText';
import { generateText } from '../lib/gemini';
import { httpError } from '../utils/errors';
import { assertAiSummaryContentValid } from './aiSummaryValidation';

const BODY_CHAR_LIMIT = Math.max(1000, Number(process.env.AI_SUMMARY_BODY_CHAR_LIMIT) || 14000);
const MODEL = process.env.GEMINI_SUMMARY_MODEL || process.env.GEMINI_CHAT_MODEL || 'gemini-flash-latest';

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

function promptFor(format: AiSummaryFormat): string {
  if (format === 'bullets') {
    return 'Return JSON exactly as {"items":["string","string"]}. Write 2 to 4 concise bullets. No markdown, no labels, no extra fields.';
  }
  return 'Return JSON exactly as {"text":"string"}. Write one concise paragraph, neutral and useful. No markdown, no labels, no extra fields.';
}

export async function generateAiSummary(article: ArticleDoc, format: AiSummaryFormat): Promise<{
  content: AiSummaryContent;
  model: string;
}> {
  const plainText = extractPlainText(article.body).slice(0, BODY_CHAR_LIMIT);
  if (plainText.length < 20) throw httpError(422, 'article_body_empty');

  const raw = await generateText({
    model: MODEL,
    systemPrompt:
      'You are Resolve AI Summary, an editorial assistant for Pakistani news. Summarize only the supplied article. Preserve facts, avoid speculation, stay neutral, and return valid JSON only.',
    message: JSON.stringify({
      title: article.title,
      excerpt: article.excerpt,
      format,
      instruction: promptFor(format),
      articleText: plainText,
    }),
  });

  const parsed = parseJson(raw);
  return {
    content: assertAiSummaryContentValid(format, parsed),
    model: MODEL,
  };
}
