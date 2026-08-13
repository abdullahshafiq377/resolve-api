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

// Manual ordering was dropped from the admin screens; every list now reads
// alphabetically (with Global pinned in code — see sortRegionsForDisplay). The
// `order` field is left on the schema so existing documents stay valid, but
// nothing reads it any more.
RegionSchema.index({ active: 1, title: 1 });

const Region: Model<RegionDoc> =
  mongoose.models.Region || mongoose.model<RegionDoc>('Region', RegionSchema);

export default Region;
