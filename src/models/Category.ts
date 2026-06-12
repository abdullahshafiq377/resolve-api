import mongoose, { Schema, Document, Model } from 'mongoose';

export interface CategoryDoc extends Document {
  title: string;
  slug: string;
  active: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const CategorySchema = new Schema<CategoryDoc>(
  {
    title: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    active: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const Category: Model<CategoryDoc> =
  mongoose.models.Category || mongoose.model<CategoryDoc>('Category', CategorySchema);

export default Category;
