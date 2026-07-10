import User from '../../models/User';
import type { CommentMention } from '../../models/Comment';

// Mention token: '@' preceded by a boundary, then 2–50 word chars. Trailing
// punctuation (e.g. "@alice!") naturally stops the capture; "email@x.com" is not
// a mention because '@' is preceded by a word char.
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

// Resolve tokens to real users (case-insensitive displayName match, active users
// only), excluding the author. Returns the stored mention shape, deduped by user.
export async function resolveMentions(
  bodyText: string,
  authorId: string,
): Promise<CommentMention[]> {
  const tokens = extractMentionTokens(bodyText);
  if (!tokens.length) return [];

  const users = await User.find({
    deletedAt: null,
    displayName: { $in: tokens.map((t) => new RegExp(`^${escapeRegex(t.token)}$`, 'i')) },
  })
    .select('clerkUserId displayName')
    .lean();

  // Map lowercased displayName -> user.
  const byName = new Map<string, { clerkUserId: string; displayName: string | null }>();
  for (const u of users) {
    if (u.displayName) byName.set(u.displayName.toLowerCase(), u);
  }

  const mentions: CommentMention[] = [];
  const seenUsers = new Set<string>();
  for (const t of tokens) {
    const u = byName.get(t.token.toLowerCase());
    if (!u || u.clerkUserId === authorId || seenUsers.has(u.clerkUserId)) continue;
    seenUsers.add(u.clerkUserId);
    mentions.push({ userId: u.clerkUserId, displayName: u.displayName ?? t.token, position: t.position });
  }
  return mentions;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
