import mongoose, { Schema, Document, Model } from 'mongoose';

export interface RegionDoc extends Document {
  title: string;
  slug: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const RegionSchema = new Schema<RegionDoc>(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

// Manual ordering was dropped from the admin screens; every list now reads
// alphabetically (with Global pinned in code — see sortRegionsForDisplay). The
// dead `order` field went with it — `npm run migrate:unset-taxonomy-order`
// clears it from documents written before that (`F-023`).
RegionSchema.index({ active: 1, title: 1 });

const Region: Model<RegionDoc> =
  mongoose.models.Region || mongoose.model<RegionDoc>('Region', RegionSchema);

export default Region;
