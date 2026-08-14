/* eslint-disable @typescript-eslint/no-explicit-any */
import { extractPlainText } from '../../lib/articleText';

// Max body length (plain-text chars after trim). Env-tunable.
export const MAX_BODY_LENGTH = Number(process.env.COMMENTS_MAX_BODY_LENGTH) || 2000;

// The Tiptap/ProseMirror subset comments may use. Anything outside this is
// stripped before storage (no images, embeds, headings, tables, custom blocks).
const ALLOWED_NODE_TYPES = new Set([
  'doc',
  'paragraph',
  'text',
  'hardBreak',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'codeBlock',
]);

const ALLOWED_MARK_TYPES = new Set(['bold', 'italic', 'code', 'link', 'mention']);

function sanitizeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  // Allow http(s) and site-relative links only.
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) return trimmed;
  return null;
}

// Clerk ids are short opaque strings ("user_2ab…"); anything longer or of another
// shape did not come from the mention picker and is dropped rather than stored.
function sanitizeMentionUserId(userId: unknown): string | null {
  if (typeof userId !== 'string') return null;
  const trimmed = userId.trim();
  if (!trimmed || trimmed.length > 128) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

function sanitizeMarks(marks: any[]): any[] {
  const out: any[] = [];
  for (const mark of marks) {
    if (!mark || !ALLOWED_MARK_TYPES.has(mark.type)) continue;
    if (mark.type === 'link') {
      const href = sanitizeHref(mark.attrs?.href);
      if (!href) continue;
      out.push({ type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } });
    } else if (mark.type === 'mention') {
      // The mention's identity, not its typed text, is what makes it a mention:
      // the id survives the mentioned member renaming themselves, and it is what
      // `resolveMentions` reads. A mark without one is kept as plain styling —
      // legacy comments and hand-typed "@name" both land there.
      const userId = sanitizeMentionUserId(mark.attrs?.userId);
      out.push(userId ? { type: 'mention', attrs: { userId } } : { type: 'mention' });
    } else {
      out.push({ type: mark.type });
    }
  }
  return out;
}

function sanitizeNode(node: any): any | null {
  if (!node || typeof node !== 'object' || !ALLOWED_NODE_TYPES.has(node.type)) return null;

  const clean: any = { type: node.type };

  if (node.type === 'text') {
    clean.text = typeof node.text === 'string' ? node.text : '';
    if (Array.isArray(node.marks)) {
      const marks = sanitizeMarks(node.marks);
      if (marks.length) clean.marks = marks;
    }
    return clean.text ? clean : null;
  }

  if (Array.isArray(node.content)) {
    const content = node.content.map(sanitizeNode).filter(Boolean);
    if (content.length) clean.content = content;
  }
  return clean;
}

// Sanitise a comment body to the allowed Tiptap subset. Always returns a valid
// `doc` node (empty doc if nothing survived).
export function sanitizeCommentBody(body: unknown): any {
  const root = body && typeof body === 'object' ? (body as any) : null;
  if (!root || root.type !== 'doc' || !Array.isArray(root.content)) {
    return { type: 'doc', content: [] };
  }
  const content = root.content.map(sanitizeNode).filter(Boolean);
  return { type: 'doc', content };
}

export interface PreparedBody {
  body: any;
  bodyText: string;
}

export type BodyValidationError = 'empty' | 'too_long';

// Sanitise + extract text + validate length. Returns either a prepared body or a
// validation error code.
export function prepareCommentBody(
  rawBody: unknown,
): { ok: true; value: PreparedBody } | { ok: false; error: BodyValidationError } {
  const body = sanitizeCommentBody(rawBody);
  const bodyText = extractPlainText(body).trim();
  if (bodyText.length < 1) return { ok: false, error: 'empty' };
  if (bodyText.length > MAX_BODY_LENGTH) return { ok: false, error: 'too_long' };
  return { ok: true, value: { body, bodyText } };
}
