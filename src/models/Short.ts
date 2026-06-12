import mongoose, { Schema, Document, Model } from 'mongoose';
const STATUSES = ['draft', 'published', 'archived'] as const;

export interface ShortDoc extends Document {
  title: string;
  slug: string;
  description?: string;
  videoUrl: string;
  videoKey: string;
  thumbnailUrl?: string;
  thumbnailKey?: string;
  durationSeconds?: number;
  category?: string;
  categoryId: mongoose.Types.ObjectId;
  tags: string[];
  featured: boolean;
  status: (typeof STATUSES)[number];
  publishedAt?: Date;
  views: number;
  createdAt: Date;
  updatedAt: Date;
}

const ShortSchema = new Schema<ShortDoc>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    description: { type: String, trim: true },

    videoUrl: { type: String, required: true, trim: true },
    videoKey: { type: String, required: true, trim: true },

    thumbnailUrl: { type: String, trim: true },
    thumbnailKey: { type: String, trim: true },

    durationSeconds: { type: Number, min: 0 },

    category: { type: String, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    tags: [{ type: String, trim: true }],

    featured: { type: Boolean, default: false },

    status: { type: String, enum: STATUSES, default: 'draft' },
    publishedAt: { type: Date },

    views: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const Short: Model<ShortDoc> =
  mongoose.models.Short || mongoose.model<ShortDoc>('Short', ShortSchema);

export default Short;
