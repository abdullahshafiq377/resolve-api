import {
  AI_SUMMARY_FORMATS,
  type AiSummaryContent,
  type AiSummaryFormat,
  type BulletSummaryContent,
  type ParagraphSummaryContent,
} from '../models/ArticleSummary';
import { httpError } from '../utils/errors';

const MAX_BULLET_LENGTH = 500;
const MAX_PARAGRAPH_LENGTH = 2000;

export function normalizeAiSummaryFormat(value: unknown): AiSummaryFormat {
  if (AI_SUMMARY_FORMATS.includes(value as AiSummaryFormat)) return value as AiSummaryFormat;
  throw httpError(400, 'invalid_summary_format');
}

function cleanText(value: unknown, maxLength: number, errorCode: string): string {
  if (typeof value !== 'string') throw httpError(400, errorCode);
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw httpError(400, errorCode);
  if (text.length > maxLength) throw httpError(400, errorCode);
  return text;
}

export function normalizeAiSummaryContent(format: AiSummaryFormat, value: unknown): AiSummaryContent {
  if (!value || typeof value !== 'object') throw httpError(400, 'invalid_summary_content');

  if (format === 'bullets') {
    const items = (value as Partial<BulletSummaryContent>).items;
    if (!Array.isArray(items) || items.length < 2 || items.length > 4) {
      throw httpError(400, 'invalid_summary_bullets');
    }
    return {
      items: items.map((item) => cleanText(item, MAX_BULLET_LENGTH, 'invalid_summary_bullets')),
    };
  }

  const text = (value as Partial<ParagraphSummaryContent>).text;
  return {
    text: cleanText(text, MAX_PARAGRAPH_LENGTH, 'invalid_summary_paragraph'),
  };
}

export function assertAiSummaryContentValid(format: AiSummaryFormat, value: unknown): AiSummaryContent {
  return normalizeAiSummaryContent(format, value);
}
