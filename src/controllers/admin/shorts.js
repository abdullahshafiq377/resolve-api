const Short = require('../../models/Short');
const { generateUniqueSlug } = require('../../utils/slugify');
const { createUploadUrl } = require('../../config/s3');

const MAX_LIMIT = 100;

// POST /api/admin/shorts/upload-url
async function uploadUrl(req, res) {
  const { filename, contentType, fileSize, type } = req.body;

  if (!filename || !contentType || fileSize == null) {
    return res.status(400).json({ error: 'filename, contentType, and fileSize are required' });
  }

  const result = await createUploadUrl({ filename, contentType, fileSize, type });
  res.json(result);
}

// GET /api/admin/shorts
async function list(req, res) {
  const { status } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));

  const filter = {};
  if (status) filter.status = status;

  const skip = (page - 1) * limit;

  const [shorts, total] = await Promise.all([
    Short.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Short.countDocuments(filter),
  ]);

  res.json({
    data: shorts,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// POST /api/admin/shorts
async function create(req, res) {
  const {
    title, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds,
    category, tags,
    featured, status,
  } = req.body;

  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!videoUrl || !videoKey) return res.status(400).json({ error: 'videoUrl and videoKey are required' });

  const slug = await generateUniqueSlug(title, Short);

  const doc = {
    title, slug, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds, category, tags,
    featured, status,
  };

  if (status === 'published') doc.publishedAt = new Date();

  const short = await Short.create(doc);
  res.status(201).json(short);
}

// GET /api/admin/shorts/:id
async function getById(req, res) {
  const short = await Short.findById(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.json(short);
}

// PATCH /api/admin/shorts/:id
async function update(req, res) {
  const {
    title, description,
    videoUrl, videoKey,
    thumbnailUrl, thumbnailKey,
    durationSeconds,
    category, tags,
    featured, status,
  } = req.body;

  const current = await Short.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Short not found' });

  const patch = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Short, req.params.id);
  }
  if (description !== undefined) patch.description = description;
  if (videoUrl !== undefined) patch.videoUrl = videoUrl;
  if (videoKey !== undefined) patch.videoKey = videoKey;
  if (thumbnailUrl !== undefined) patch.thumbnailUrl = thumbnailUrl;
  if (thumbnailKey !== undefined) patch.thumbnailKey = thumbnailKey;
  if (durationSeconds !== undefined) patch.durationSeconds = durationSeconds;
  if (category !== undefined) patch.category = category;
  if (tags !== undefined) patch.tags = tags;
  if (featured !== undefined) patch.featured = featured;
  if (status !== undefined) {
    patch.status = status;
    if (status === 'published' && !current.publishedAt) {
      patch.publishedAt = new Date();
    }
  }

  const short = await Short.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });

  res.json(short);
}

// DELETE /api/admin/shorts/:id  — soft archive
async function archive(req, res) {
  const short = await Short.findByIdAndUpdate(
    req.params.id,
    { status: 'archived' },
    { new: true }
  );
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.json(short);
}

// DELETE /api/admin/shorts/:id/permanent  — hard delete
async function permanentRemove(req, res) {
  const short = await Short.findByIdAndDelete(req.params.id);
  if (!short) return res.status(404).json({ error: 'Short not found' });
  res.status(204).send();
}

module.exports = { uploadUrl, list, getById, create, update, archive, permanentRemove };
