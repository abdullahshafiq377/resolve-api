import mongoose, { Schema, Document, Model } from 'mongoose';

const CATEGORIES = ['Politics', 'Defence', 'Geopolitics', 'Economy', 'Opinion'] as const;
const TEMPLATES = ['standard', 'longform', 'visual'] as const;
const STATUSES = ['draft', 'published'] as const;

export interface ArticleDoc extends Document {
  title: string;
  slug: string;
  excerpt: string;
  // Clerk user ID of the owning moderator / super admin (§6a). Replaces the
  // former free-text `author` byline; display fields are joined from the users mirror.
  authorId: string;
  category: (typeof CATEGORIES)[number];
  featuredImage: string;
  featuredImageCaption?: string;
  featuredImageKey?: string;
  template: (typeof TEMPLATES)[number];
  publishDate: Date;
  featured: boolean;
  highlight: boolean;
  status: (typeof STATUSES)[number];
  readTimeMinutes: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  createdAt: Date;
  updatedAt: Date;
}

const ArticleSchema = new Schema<ArticleDoc>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    excerpt: { type: String, required: true, trim: true },
    authorId: { type: String, required: true, trim: true, index: true },
    category: { type: String, enum: CATEGORIES, required: true },
    featuredImage: { type: String, required: true, trim: true },
    featuredImageCaption: { type: String, trim: true },
    featuredImageKey: { type: String, trim: true },
    template: { type: String, enum: TEMPLATES, required: true },
    publishDate: { type: Date, required: true },
    featured: { type: Boolean, default: false },
    highlight: { type: Boolean, default: false },
    status: { type: String, enum: STATUSES, default: 'draft' },
    readTimeMinutes: { type: Number, default: null },
    body: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true },
);

const Article: Model<ArticleDoc> =
  mongoose.models.Article || mongoose.model<ArticleDoc>('Article', ArticleSchema);

export default Article;
