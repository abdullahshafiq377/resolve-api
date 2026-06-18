import mongoose from 'mongoose';
import Poll from '../../models/Poll';

type JsonObject = Record<string, unknown>;

export function bodyContainsPublicPulse(body: unknown, pollId: string): boolean {
  if (!body || typeof body !== 'object') return false;
  const node = body as JsonObject;
  if (node.type === 'publicPulse' && (node.attrs as JsonObject | undefined)?.pollId === pollId) {
    return true;
  }
  const content = node.content;
  if (!Array.isArray(content)) return false;
  return content.some((child) => bodyContainsPublicPulse(child, pollId));
}

export async function sanitizePublicPulseBlocks(body: unknown): Promise<unknown> {
  async function visit(node: unknown): Promise<unknown | null> {
    if (!node || typeof node !== 'object') return node;
    const obj = node as JsonObject;

    if (obj.type === 'publicPulse') {
      const attrs = obj.attrs as JsonObject | undefined;
      const pollId = typeof attrs?.pollId === 'string' ? attrs.pollId : '';
      if (!mongoose.Types.ObjectId.isValid(pollId)) return null;
      const poll = await Poll.findById(pollId).select('status');
      if (!poll || poll.status === 'draft') return null;
      return { type: 'publicPulse', attrs: { pollId } };
    }

    if (Array.isArray(obj.content)) {
      const nextContent = [];
      for (const child of obj.content) {
        const next = await visit(child);
        if (next !== null) nextContent.push(next);
      }
      return { ...obj, content: nextContent };
    }
    return obj;
  }

  return visit(body);
}
