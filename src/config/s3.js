const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET_NAME;
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE_URL;
const SIGNED_URL_EXPIRY_SECONDS = 15 * 60;

const ALLOWED_VIDEO_TYPES = new Set(['video/mp4']);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_VIDEO_EXTS = new Set(['.mp4']);
const ALLOWED_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const MAX_VIDEO_BYTES = (parseInt(process.env.SHORTS_MAX_UPLOAD_MB, 10) || 100) * 1024 * 1024;
const MAX_IMAGE_BYTES = (parseInt(process.env.SHORTS_MAX_THUMBNAIL_MB, 10) || 10) * 1024 * 1024;

function buildPublicUrl(key) {
  if (PUBLIC_BASE) return `${PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function createUploadUrl({ filename, contentType, fileSize, type = 'video' }) {
  const ext = path.extname(filename).toLowerCase();

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  if (type === 'video') {
    if (!ALLOWED_VIDEO_TYPES.has(contentType)) throw badRequest('Only video/mp4 is accepted');
    if (!ALLOWED_VIDEO_EXTS.has(ext)) throw badRequest('Filename must have a .mp4 extension');
    if (fileSize > MAX_VIDEO_BYTES) {
      throw badRequest(`Video exceeds ${process.env.SHORTS_MAX_UPLOAD_MB || 100}MB limit`);
    }
  } else if (type === 'thumbnail') {
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) throw badRequest('Thumbnail must be jpeg, png, or webp');
    if (!ALLOWED_IMAGE_EXTS.has(ext)) throw badRequest('Thumbnail must have a valid image extension');
    if (fileSize > MAX_IMAGE_BYTES) {
      throw badRequest(`Thumbnail exceeds ${process.env.SHORTS_MAX_THUMBNAIL_MB || 10}MB limit`);
    }
  } else {
    throw badRequest('type must be "video" or "thumbnail"');
  }

  const folder = type === 'video' ? 'videos' : 'thumbnails';
  const fileKey = `shorts/${folder}/${year}/${month}/${crypto.randomUUID()}${ext}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: fileKey,
    ContentType: contentType,
    ContentLength: fileSize,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: SIGNED_URL_EXPIRY_SECONDS });

  return { uploadUrl, fileKey, publicUrl: buildPublicUrl(fileKey) };
}

module.exports = { createUploadUrl };
