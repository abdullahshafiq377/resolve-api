import mongoose, { Schema, Document, Model } from 'mongoose';

export interface RegionDoc extends Document {
  title: string;
  slug: string;
  active: boolean;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const RegionSchema = new Schema<RegionDoc>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    active: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);

RegionSchema.index({ active: 1, order: 1, title: 1 });

const Region: Model<RegionDoc> =
  mongoose.models.Region || mongoose.model<RegionDoc>('Region', RegionSchema);

export default Region;
