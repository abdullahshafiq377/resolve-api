import mongoose, { Schema, Document, Model } from 'mongoose';
const TEMPLATES = ['standard', 'longform', 'visual'] as const;
const STATUSES = ['draft', 'published'] as const;
// Minimum plan tier required to read past the `gate` node in the body. Only the
// paid tiers are gateable — an ungated article has no gateTier at all.
export const GATE_TIERS = ['standard', 'premium'] as const;
export type GateTier = (typeof GATE_TIERS)[number];

export interface ArticleDoc extends Document {
  title: string;
  slug: string;
  excerpt: string;
  // Clerk user ID of the owning moderator / super admin (§6a). Replaces the
  // former free-text `author` byline; display fields are joined from the users mirror.
  authorId: string;
  category?: string;
  categoryId: mongoose.Types.ObjectId;
  regionIds: mongoose.Types.ObjectId[];
  featuredImage: string;
  featuredImageCaption?: string;
  featuredImageKey?: string;
  audioUrl?: string;
  audioKey?: string;
  template: (typeof TEMPLATES)[number];
  // Set only while the article is published. Cleared on revert to draft so a
  // draft never carries a stale publish date (§ articles statuses).
  publishDate?: Date;
  featured: boolean;
  highlight: boolean;
  keyStory: boolean;
  topStories: boolean;
  status: (typeof STATUSES)[number];
  readTimeMinutes: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  // Article gating. Absent = readable by everyone. When set, the body carries a
  // `gate` node and readers below this tier get only the content before it (plus
  // a short teaser) — see lib/articleGate.ts. Invariant, enforced on save:
  // gateTier is set IFF the body contains exactly one `gate` node.
  gateTier?: GateTier;
  // SHA-256 of the extracted plain text of the last successfully-embedded body
  // (Phase 2). Lets the embedding pipeline skip re-embedding on metadata-only
  // edits / re-saves where the prose is unchanged. Absent until first embed.
  bodyHash?: string;
  // True when this article was published from a community Research Request. Auto-set
  // when a moderator links a published request to it; can be manually toggled.
  fromResearchRequest: boolean;
  // Bidirectional link back to the originating ResearchRequest (Option A). Lets the
  // "From the community" badge link to the request and lets request hard-delete clear the flag.
  researchRequestId?: mongoose.Types.ObjectId | null;
  // Denormalised count of visible comments. Kept in sync on comment create/delete
  // transitions to/from `visible`; repairable via `comments:resync-counts`.
  commentCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ArticleSchema = new Schema<ArticleDoc>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    excerpt: { type: String, required: true, trim: true },
    authorId: { type: String, required: true, trim: true, index: true },
    category: { type: String, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    regionIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Region' }], default: [], index: true },
    featuredImage: { type: String, required: true, trim: true },
    featuredImageCaption: { type: String, trim: true },
    featuredImageKey: { type: String, trim: true },
    audioUrl: { type: String, trim: true },
    audioKey: { type: String, trim: true },
    template: { type: String, enum: TEMPLATES, required: true },
    publishDate: { type: Date },
    featured: { type: Boolean, default: false },
    highlight: { type: Boolean, default: false },
    keyStory: { type: Boolean, default: false },
    topStories: { type: Boolean, default: false },
    status: { type: String, enum: STATUSES, default: 'draft' },
    readTimeMinutes: { type: Number, default: null },
    body: { type: Schema.Types.Mixed, required: true },
    gateTier: { type: String, enum: GATE_TIERS },
    bodyHash: { type: String },
    fromResearchRequest: { type: Boolean, default: false },
    researchRequestId: { type: Schema.Types.ObjectId, ref: 'ResearchRequest', default: null },
    commentCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

ArticleSchema.index({ regionIds: 1, status: 1, publishDate: -1 });

const Article: Model<ArticleDoc> =
  mongoose.models.Article || mongoose.model<ArticleDoc>('Article', ArticleSchema);

export default Article;
