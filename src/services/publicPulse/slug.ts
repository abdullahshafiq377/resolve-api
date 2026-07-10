import type { Model } from 'mongoose';

export function generatePollSlug(question: string): string {
  const base = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return base || `poll-${Date.now()}`;
}

export async function generateUniquePollSlug<T>(
  question: string,
  PollModel: Model<T>,
): Promise<string> {
  const base = generatePollSlug(question);
  let candidate = base;
  let suffix = 1;
  while (suffix < 1000) {
    const existing = await PollModel.exists({ slug: candidate });
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return `${base}-${Date.now()}`;
}
