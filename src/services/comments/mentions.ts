/* eslint-disable @typescript-eslint/no-explicit-any */
import User from '../../models/User';
import type { CommentMention } from '../../models/Comment';

// Mention token: '@' preceded by a boundary, then 2–50 word chars. Trailing
// punctuation (e.g. "@alice!") naturally stops the capture; "email@x.com" is not
// a mention because '@' is preceded by a word char.
//
// This is the *fallback* path, for an @name typed by hand without going through
// the picker. It cannot see past the first word, so it only ever resolves a
// single-word display name — which is why mentions made through the picker carry
// a `userId` on the mark instead (see `extractMarkedMentions`).
const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{2,50})/g;

export interface ExtractedToken {
  token: string;
  position: number;
}

// Find candidate @tokens in the plain-text body (deduped by lowercased token,
// first position wins).
export function extractMentionTokens(bodyText: string): ExtractedToken[] {
  const seen = new Set<string>();
  const out: ExtractedToken[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(bodyText)) !== null) {
    const token = m[2];
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token, position: m.index + m[1].length });
  }
  return out;
}

export interface MarkedMention {
  userId: string;
  /** The mention's text as typed, "@Shirza Firtas" — used only to locate it. */
  text: string;
}

/**
 * Mentions carried structurally by the body: a text span marked
 * `{ type: 'mention', attrs: { userId } }`, written by the composer's picker and
 * preserved by `sanitizeCommentBody`.
 *
 * This is the authoritative path. It is exact (the picker chose the user), it
 * survives a display name containing spaces or punctuation, and it keeps working
 * after the mentioned member renames themselves.
 */
export function extractMarkedMentions(body: unknown): MarkedMention[] {
  const out: MarkedMention[] = [];
  const seen = new Set<string>();

  function walk(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        const userId = mark?.type === 'mention' ? mark?.attrs?.userId : null;
        if (typeof userId !== 'string' || !userId || seen.has(userId)) continue;
        seen.add(userId);
        out.push({ userId, text: typeof node.text === 'string' ? node.text : '' });
      }
    }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  }

  walk(body);
  return out;
}

/**
 * Resolve a comment's mentions to real users: the marked mentions first, then any
 * hand-typed @tokens the mark path did not already cover. Inactive users, the
 * author themselves, and duplicates are dropped.
 *
 * `position` is the mention's offset in `bodyText`, kept for callers that want to
 * locate it there. It is best-effort for marked mentions (the text is searched
 * for) and 0 when it cannot be found — nothing rendering a comment depends on it,
 * because the body's own marks say where each mention is.
 */
export async function resolveMentions(
  body: unknown,
  bodyText: string,
  authorId: string,
): Promise<CommentMention[]> {
  const marked = extractMarkedMentions(body);
  const tokens = extractMentionTokens(bodyText);
  if (!marked.length && !tokens.length) return [];

  const [byIdUsers, byNameUsers] = await Promise.all([
    marked.length
      ? User.find({ deletedAt: null, clerkUserId: { $in: marked.map((m) => m.userId) } })
          .select('clerkUserId displayName')
          .lean()
      : Promise.resolve([]),
    tokens.length
      ? User.find({
          deletedAt: null,
          displayName: { $in: tokens.map((t) => new RegExp(`^${escapeRegex(t.token)}$`, 'i')) },
        })
          .select('clerkUserId displayName')
          .lean()
      : Promise.resolve([]),
  ]);

  const mentions: CommentMention[] = [];
  const seenUsers = new Set<string>();

  const byId = new Map(byIdUsers.map((u) => [u.clerkUserId, u]));
  for (const m of marked) {
    const user = byId.get(m.userId);
    if (!user || user.clerkUserId === authorId || seenUsers.has(user.clerkUserId)) continue;
    seenUsers.add(user.clerkUserId);
    const position = m.text ? bodyText.indexOf(m.text) : -1;
    mentions.push({
      userId: user.clerkUserId,
      // Snapshot of the name at post time; serializers prefer the live mirror.
      displayName: user.displayName ?? m.text.replace(/^@/, ''),
      position: position >= 0 ? position : 0,
    });
  }

  // Map lowercased displayName -> user.
  const byName = new Map<string, { clerkUserId: string; displayName: string | null }>();
  for (const u of byNameUsers) {
    if (u.displayName) byName.set(u.displayName.toLowerCase(), u);
  }
  for (const t of tokens) {
    const u = byName.get(t.token.toLowerCase());
    if (!u || u.clerkUserId === authorId || seenUsers.has(u.clerkUserId)) continue;
    seenUsers.add(u.clerkUserId);
    mentions.push({
      userId: u.clerkUserId,
      displayName: u.displayName ?? t.token,
      position: t.position,
    });
  }

  return mentions;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
