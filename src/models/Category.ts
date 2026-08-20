import mongoose, { Schema, Document, Model } from 'mongoose';

export interface CategoryDoc extends Document {
  title: string;
  slug: string;
  /**
   * Slugs this category used to live at.
   *
   * `/category/<slug>` is linked from published articles, shares and search
   * results, so a rename must not strand them. Every old slug is kept here,
   * `findCategoryBySlug` falls back to it, and the public page permanently
   * redirects to the current slug.
   */
  previousSlugs: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CategorySchema = new Schema<CategoryDoc>(
  {
    title: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    previousSlugs: { type: [String], default: [], index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

// Categories read alphabetically everywhere — see the `listPublic` comment in
// `controllers/categories.ts`. There is no manual `order`; documents written
// before it was dropped are cleaned by
// `npm run migrate:unset-taxonomy-order` (`F-023`).
const Category: Model<CategoryDoc> =
  mongoose.models.Category || mongoose.model<CategoryDoc>('Category', CategorySchema);

export default Category;
