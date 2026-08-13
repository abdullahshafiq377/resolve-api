import mongoose, { Schema, Document, Model } from 'mongoose';

// Entities that can carry an activity timeline. `article` and `poll` are
// instrumented today; the rest are listed so the log can absorb them without a
// migration — the research-request trail in particular is currently synthesized
// from latest-actor fields and only ever remembers the most recent change of
// each kind (see lib/serializers/researchRequest.ts).
export const ACTIVITY_ENTITY_TYPES = [
  'article',
  'researchRequest',
  'poll',
  'brief',
  'comment',
  'user',
  'short',
] as const;
export type ActivityEntityType = (typeof ACTIVITY_ENTITY_TYPES)[number];

/**
 * Append-only event log behind the admin activity timelines.
 *
 * Every entry renders as one line — "{actor} {action phrase}" over a timestamp —
 * so the action vocabulary is deliberately specific ("changed the article
 * title") rather than generic ("updated"): the phrasing lives in the frontend
 * describe* helpers, and `metadata` carries whatever those need to fill in.
 *
 * Nothing here is reader-facing. It is read only by moderators.
 */
export const ACTIVITY_ACTIONS = [
  // ── Lifecycle ────────────────────────────────────────────────────────────
  // metadata: { status } — the status the item was created in
  'created',
  // Fallback for a field change with no dedicated action. metadata: { fields }
  'updated',
  // metadata: { from, to } — both ArticleStatus values
  'status_changed',
  'published',
  'unpublished',
  'archived',
  'restored',
  // metadata: { publishDate }
  'scheduled',
  // metadata: { from, to }
  'publish_date_changed',
  // The articles-publish-due cron flipping a due article live. No actor.
  'auto_published',

  // ── Article metadata ─────────────────────────────────────────────────────
  // metadata: { from, to }
  'title_changed',
  // Auto-derived from the title, so this is always a System event. metadata: { from, to }
  'slug_changed',
  'excerpt_changed',
  // metadata: { to, toName } — first assignment (no previous author)
  'author_assigned',
  // metadata: { from, fromName, to, toName }
  'author_changed',
  // metadata: { from, to } — category titles
  'category_changed',
  // metadata: { from, to } — region title lists
  'region_changed',
  // metadata: { from, to } — template names
  'template_changed',
  // metadata: { from, to } — gate tiers, null meaning free
  'gate_changed',
  // metadata: { from, to } — minutes
  'read_time_changed',
  // Homepage placement toggled. metadata: { flag, value }
  'placement_changed',

  // ── Media ────────────────────────────────────────────────────────────────
  'hero_image_uploaded',
  'hero_image_replaced',
  'image_caption_changed',
  'audio_uploaded',
  'audio_replaced',
  'audio_removed',

  // ── Body ─────────────────────────────────────────────────────────────────
  // Prose edited inside existing blocks, with no block added or removed.
  'body_updated',
  // metadata: { blockType, count }
  'block_added',
  'block_removed',
  'public_pulse_embedded',
  'public_pulse_removed',

  // ── Public Pulse ─────────────────────────────────────────────────────────
  // A poll's question is its title, and its answers are its body, so these sit
  // apart from the article vocabulary rather than reusing `title_changed`.
  // metadata: { from, to }
  'question_changed',
  'description_changed',
  // metadata: { from, to } — option text lists, in display order
  'options_changed',
  'options_reordered',
  // metadata: { from, to } — ISO timestamps
  'close_date_changed',
  // A scheduled poll pulled back to draft.
  'schedule_cancelled',
  // metadata: { from, to } — poll statuses
  'closed',
  // The Public Pulse cron closing a poll whose close date has passed. No actor.
  'auto_closed',
  // Featured on the Public Pulse hero. metadata: { value }
  'featured_changed',

  // ── AI summary ───────────────────────────────────────────────────────────
  // metadata: { format, model }
  'ai_summary_generated',
  'ai_summary_regenerated',
  'ai_summary_edited',
  'ai_summary_approved',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface ActivityDoc extends Document {
  entityType: ActivityEntityType;
  entityId: mongoose.Types.ObjectId;
  action: ActivityAction;
  // Clerk user ID of the moderator who acted. Null for system events (the
  // publish-due cron, auto-derived slugs), which render as "System".
  actorId: string | null;
  // Action-specific payload — see the action list above for the shape each one
  // carries. Mixed rather than a union so a new action needs no migration.
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}

const ActivitySchema = new Schema<ActivityDoc>(
  {
    entityType: { type: String, enum: ACTIVITY_ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    action: { type: String, enum: ACTIVITY_ACTIONS, required: true },
    actorId: { type: String, default: null, trim: true },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

// The timeline query: newest first for one entity.
ActivitySchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

const Activity: Model<ActivityDoc> =
  mongoose.models.Activity || mongoose.model<ActivityDoc>('Activity', ActivitySchema);

export default Activity;
