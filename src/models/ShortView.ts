import mongoose, { Schema, Document, Model, Types } from 'mongoose';

export interface ShortViewDoc extends Document {
  shortId: Types.ObjectId;
  ip: string;
  createdAt: Date;
}

const ShortViewSchema = new Schema<ShortViewDoc>({
  shortId: { type: Schema.Types.ObjectId, ref: 'Short', required: true },
  ip: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // TTL: 24 hours
});

ShortViewSchema.index({ shortId: 1, ip: 1 }, { unique: true });

const ShortView: Model<ShortViewDoc> =
  mongoose.models.ShortView || mongoose.model<ShortViewDoc>('ShortView', ShortViewSchema);

export default ShortView;
