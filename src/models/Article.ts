import mongoose, { Schema, Document, Model } from 'mongoose';
const TEMPLATES = ['standard', 'longform', 'visual'] as const;
const STATUSES = ['draft', 'published'] as const;

export interface ArticleDoc extends Document {
  title: string;
  slug: string;
  excerpt: string;
  // Clerk user ID of the owning moderator / super admin (§6a). Replaces the
  // former free-text `author` byline; display fields are joined from the users mirror.
  authorId: string;
  category?: string;
  categoryId: mongoose.Types.ObjectId;
  featuredImage: string;
  featuredImageCaption?: string;
  featuredImageKey?: string;
  audioUrl?: string;
  audioKey?: string;
  template: (typeof TEMPLATES)[number];
  publishDate: Date;
  featured: boolean;
  highlight: boolean;
  status: (typeof STATUSES)[number];
  readTimeMinutes: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
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
    featuredImage: { type: String, required: true, trim: true },
    featuredImageCaption: { type: String, trim: true },
    featuredImageKey: { type: String, trim: true },
    audioUrl: { type: String, trim: true },
    audioKey: { type: String, trim: true },
    template: { type: String, enum: TEMPLATES, required: true },
    publishDate: { type: Date, required: true },
    featured: { type: Boolean, default: false },
    highlight: { type: Boolean, default: false },
    status: { type: String, enum: STATUSES, default: 'draft' },
    readTimeMinutes: { type: Number, default: null },
    body: { type: Schema.Types.Mixed, required: true },
    bodyHash: { type: String },
    fromResearchRequest: { type: Boolean, default: false },
    researchRequestId: { type: Schema.Types.ObjectId, ref: 'ResearchRequest', default: null },
  },
  { timestamps: true },
);

const Article: Model<ArticleDoc> =
  mongoose.models.Article || mongoose.model<ArticleDoc>('Article', ArticleSchema);

export default Article;
