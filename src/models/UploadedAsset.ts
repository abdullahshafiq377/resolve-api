import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * What was actually uploaded to S3, recorded at the moment the presigned URL is
 * minted.
 *
 * The object key is a generated UUID, so nothing downstream can recover the
 * name the editor chose or the size of the file from the URL alone — which is
 * why the admin editors used to show `9aa92b83-…jpg` with no size beside it.
 * The upload-url endpoint already receives both, so they are kept here and
 * denormalised onto the article or short when the media is attached.
 *
 * A row is written per presigned URL, so uploads that are never attached leave
 * one behind. That is deliberate: it is also the only record that an upload
 * happened at all.
 */
export interface UploadedAssetDoc extends Document {
  /** S3 object key. The join key for everything that references the upload. */
  fileKey: string;
  /** Filename as it was on the uploader's machine. */
  originalName: string;
  /** Size in bytes, as reported by the browser at request time. */
  size: number;
  contentType: string;
  /** Which admin surface asked for the URL. */
  surface: 'article' | 'short';
  /** The `type` passed to the upload-url endpoint (featured, body, audio, …). */
  kind: string;
  /** Clerk user id of the moderator who requested the upload. */
  uploadedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UploadedAssetSchema = new Schema<UploadedAssetDoc>(
  {
    fileKey: { type: String, required: true, unique: true, trim: true },
    originalName: { type: String, required: true, trim: true },
    size: { type: Number, required: true },
    contentType: { type: String, required: true, trim: true },
    surface: { type: String, required: true, enum: ['article', 'short'] },
    kind: { type: String, required: true, trim: true },
    uploadedBy: { type: String, trim: true },
  },
  { timestamps: true },
);

const UploadedAsset: Model<UploadedAssetDoc> =
  mongoose.models.UploadedAsset ||
  mongoose.model<UploadedAssetDoc>('UploadedAsset', UploadedAssetSchema);

export default UploadedAsset;

export interface AssetMeta {
  originalName: string;
  size: number;
}

/** Records an upload. Never throws — a failed write must not fail the upload. */
export async function recordUploadedAsset(entry: {
  fileKey: string;
  originalName: string;
  size: number;
  contentType: string;
  surface: 'article' | 'short';
  kind: string;
  uploadedBy?: string;
}): Promise<void> {
  try {
    await UploadedAsset.updateOne(
      { fileKey: entry.fileKey },
      { $set: entry },
      { upsert: true },
    ).exec();
  } catch (err) {
    // The presigned URL is already valid at this point, so refusing the upload
    // over a bookkeeping failure would be worse than losing the label.
    console.error('[uploads] failed to record asset metadata', entry.fileKey, err);
  }
}

/**
 * Name and size for an object key, or null when the upload predates this
 * collection — every asset uploaded before it existed resolves to null, which
 * is why every consumer treats the metadata as optional.
 */
export async function findAssetMeta(fileKey: string): Promise<AssetMeta | null> {
  const doc = await UploadedAsset.findOne({ fileKey })
    .select('originalName size')
    .lean<{ originalName: string; size: number } | null>()
    .exec();
  return doc ? { originalName: doc.originalName, size: doc.size } : null;
}
