import mongoose from 'mongoose';
import type { ArticleDoc, ArticleStatus, GateTier } from '../models/Article';
import Region from '../models/Region';
import { resolveActorNames, type ActivityInput } from './activity';
import type { ActivityAction } from '../models/Activity';

// Body block types the timeline reports individually. Anything not listed is
// folded into the generic `body_updated` event, so a new editor extension
// degrades to "updated the article body" rather than to a raw node name.
export const TRACKED_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'image',
  'imageGallery',
  'imageText',
  'pullQuote',
  'keyPoints',
  'ctaSection',
  'videoSection',
  'embed',
  'timeline',
  'barChart',
  'lineChart',
  'horizontalRule',
  'gate',
] as const;

const PUBLIC_PULSE_BLOCK = 'publicPulse';

export type ArticleActivityDraft = { action: ActivityAction; metadata?: unknown };

/** Top-level block counts by node type, for the body diff. */
function countBlocks(body: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const content = (body as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return counts;
  for (const node of content) {
    const type = (node as { type?: unknown })?.type;
    if (typeof type !== 'string') continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

function sameIdList(a: mongoose.Types.ObjectId[], b: unknown): boolean {
  if (!Array.isArray(b)) return true;
  const left = a.map(String).sort();
  const right = b.map(String).sort();
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * Diff the body's block structure into add/remove events.
 *
 * Counts are aggregated per block type — three new paragraphs are one
 * "added 3 paragraph blocks" line, not three lines — so a heavy editing session
 * stays readable. A body whose block counts are unchanged but whose prose moved
 * produces a single `body_updated` instead.
 */
function diffBody(previous: unknown, next: unknown): ArticleActivityDraft[] {
  const before = countBlocks(previous);
  const after = countBlocks(next);
  const events: ArticleActivityDraft[] = [];

  for (const type of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(type) ?? 0) - (before.get(type) ?? 0);
    if (delta === 0) continue;
    if (type === PUBLIC_PULSE_BLOCK) {
      events.push({
        action: delta > 0 ? 'public_pulse_embedded' : 'public_pulse_removed',
        metadata: { count: Math.abs(delta) },
      });
      continue;
    }
    if (!(TRACKED_BLOCK_TYPES as readonly string[]).includes(type)) continue;
    events.push({
      action: delta > 0 ? 'block_added' : 'block_removed',
      metadata: { blockType: type, count: Math.abs(delta) },
    });
  }

  // Structural changes already say what happened; only a same-shape body needs
  // the catch-all "updated the article body".
  if (events.length === 0 && JSON.stringify(previous) !== JSON.stringify(next)) {
    events.push({ action: 'body_updated' });
  }
  return events;
}

/**
 * Turn a status transition into the phrasing the timeline uses.
 *
 * The plain `status_changed` line is the fallback; the transitions a moderator
 * actually thinks of as distinct acts — publishing, unpublishing, archiving,
 * restoring — get their own action so they read as verbs rather than as a
 * before/after pair.
 */
export function diffStatus(from: ArticleStatus, to: ArticleStatus): ArticleActivityDraft[] {
  if (from === to) return [];
  const metadata = { from, to };
  if (to === 'published') return [{ action: 'published', metadata }];
  if (to === 'archived') return [{ action: 'archived', metadata }];
  if (to === 'scheduled') return [{ action: 'scheduled', metadata }];
  if (from === 'published' && to === 'draft') return [{ action: 'unpublished', metadata }];
  if (from === 'archived') return [{ action: 'restored', metadata }];
  return [{ action: 'status_changed', metadata }];
}

export interface ArticleUpdateDiff {
  current: ArticleDoc;
  updated: ArticleDoc;
  // The `$set` / `$unset` documents the update handler built, so the diff sees
  // exactly the fields the caller actually submitted.
  patch: Record<string, unknown>;
  unset: Record<string, 1>;
  nextStatus: ArticleStatus;
  nextCategoryTitle: string | null;
  nextGateTier: GateTier | undefined;
}

/**
 * Diff the pre-update article against what was written and turn the differences
 * into activity events.
 *
 * Only real changes are logged — the editor submits the whole form on every
 * save, so comparing against `current` is what keeps the timeline a record of
 * what changed rather than of how often Save was pressed.
 */
export async function buildArticleUpdateActivity({
  current,
  updated,
  patch,
  unset,
  nextStatus,
  nextCategoryTitle,
  nextGateTier,
}: ArticleUpdateDiff): Promise<ArticleActivityDraft[]> {
  const events: ArticleActivityDraft[] = [];

  if ('title' in patch && patch.title !== current.title) {
    events.push({ action: 'title_changed', metadata: { from: current.title, to: patch.title } });
    // The slug is derived from the title, never submitted, so it is a System
    // event even though a moderator triggered the rename.
    if (patch.slug && patch.slug !== current.slug) {
      events.push({ action: 'slug_changed', metadata: { from: current.slug, to: patch.slug } });
    }
  }
  if ('excerpt' in patch && patch.excerpt !== current.excerpt) {
    events.push({ action: 'excerpt_changed' });
  }

  if ('authorId' in patch && patch.authorId !== current.authorId) {
    const names = await resolveActorNames([current.authorId, patch.authorId as string]);
    const to = patch.authorId as string;
    events.push(
      current.authorId
        ? {
            action: 'author_changed',
            metadata: {
              from: current.authorId,
              fromName: names.get(current.authorId) ?? null,
              to,
              toName: names.get(to) ?? null,
            },
          }
        : { action: 'author_assigned', metadata: { to, toName: names.get(to) ?? null } },
    );
  }

  if (nextCategoryTitle && nextCategoryTitle !== current.category) {
    events.push({
      action: 'category_changed',
      metadata: { from: current.category ?? null, to: nextCategoryTitle },
    });
  }

  if ('regionIds' in patch && !sameIdList(current.regionIds, patch.regionIds)) {
    // Titles, not ids — the timeline says "changed region to South Asia".
    const ids = [...current.regionIds.map(String), ...(patch.regionIds as unknown[]).map(String)];
    const regions = await Region.find({ _id: { $in: ids } }).select('title').lean();
    const titleFor = new Map(regions.map((r) => [String(r._id), r.title as string]));
    events.push({
      action: 'region_changed',
      metadata: {
        from: current.regionIds.map((id) => titleFor.get(String(id)) ?? null).filter(Boolean),
        to: (patch.regionIds as unknown[]).map((id) => titleFor.get(String(id)) ?? null).filter(Boolean),
      },
    });
  }

  if ('template' in patch && patch.template !== current.template) {
    events.push({ action: 'template_changed', metadata: { from: current.template, to: patch.template } });
  }
  if ((nextGateTier ?? null) !== (current.gateTier ?? null)) {
    events.push({
      action: 'gate_changed',
      metadata: { from: current.gateTier ?? null, to: nextGateTier ?? null },
    });
  }
  if ('readTimeMinutes' in patch && patch.readTimeMinutes !== current.readTimeMinutes) {
    events.push({
      action: 'read_time_changed',
      metadata: { from: current.readTimeMinutes, to: patch.readTimeMinutes },
    });
  }

  if ('featuredImage' in patch && patch.featuredImage !== current.featuredImage) {
    events.push({ action: current.featuredImage ? 'hero_image_replaced' : 'hero_image_uploaded' });
  }
  if ('featuredImageCaption' in patch && patch.featuredImageCaption !== current.featuredImageCaption) {
    events.push({ action: 'image_caption_changed' });
  }

  const audioBefore = current.audioUrl ?? null;
  const audioAfter = 'audioUrl' in unset ? null : ('audioUrl' in patch ? (patch.audioUrl as string) : audioBefore);
  if (audioBefore !== audioAfter) {
    events.push({
      action: audioAfter === null ? 'audio_removed' : audioBefore ? 'audio_replaced' : 'audio_uploaded',
    });
  }

  if ('body' in patch) events.push(...diffBody(current.body, patch.body));

  events.push(...diffStatus(current.status, nextStatus));

  // A scheduled article records its target moment separately from the status
  // move, so re-scheduling — which leaves the status untouched — still shows up.
  if (nextStatus === 'scheduled') {
    const before = current.status === 'scheduled' ? (current.publishDate?.getTime() ?? null) : null;
    const after = updated.publishDate?.getTime() ?? null;
    if (before !== null && before !== after) {
      events.push({
        action: 'publish_date_changed',
        metadata: {
          from: current.publishDate?.toISOString() ?? null,
          to: updated.publishDate?.toISOString() ?? null,
        },
      });
    }
  }

  return events;
}

/** Attach the entity envelope and actor to a batch of drafted events. */
export function toArticleActivity(
  articleId: mongoose.Types.ObjectId | string,
  actorId: string | null,
  drafts: ArticleActivityDraft[],
): ActivityInput[] {
  return drafts.map((draft) => ({
    entityType: 'article' as const,
    entityId: articleId,
    action: draft.action,
    // Auto-derived changes are the system's doing, whoever triggered them.
    actorId: draft.action === 'slug_changed' ? null : actorId,
    metadata: draft.metadata ?? null,
  }));
}
