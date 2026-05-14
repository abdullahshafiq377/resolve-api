const mongoose = require('mongoose');
const Article = require('../models/Article');
const { generateUniqueSlug } = require('../utils/slugify');
const { createArticleUploadUrl } = require('../config/s3');

const MAX_LIMIT = 100;
const FEATURED_MAX = 5;
const HIGHLIGHT_MAX = 3;

async function assertFeaturedLimit(excludeId = null) {
  const query = { featured: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= FEATURED_MAX) {
    const err = new Error(`Featured limit reached (max ${FEATURED_MAX})`);
    err.status = 400;
    throw err;
  }
}

async function assertHighlightLimit(excludeId = null) {
  const query = { highlight: true };
  if (excludeId) query._id = { $ne: excludeId };
  const count = await Article.countDocuments(query);
  if (count >= HIGHLIGHT_MAX) {
    const err = new Error(`Highlight limit reached (max ${HIGHLIGHT_MAX})`);
    err.status = 400;
    throw err;
  }
}

// POST /api/articles/upload-url
async function uploadUrl(req, res) {
  const { filename, contentType, fileSize, type } = req.body;

  if (!filename || !contentType || fileSize == null) {
    return res.status(400).json({ error: 'filename, contentType, and fileSize are required' });
  }

  const result = await createArticleUploadUrl({ filename, contentType, fileSize, type });
  res.json(result);
}

// GET /api/articles
async function list(req, res) {
  const { category, status, template, excludeId } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 10));

  const filter = {};
  if (category) filter.category = category;
  if (status) filter.status = status;
  if (template) filter.template = template;
  if (req.query.featured === 'true') filter.featured = true;
  if (req.query.highlight === 'true') filter.highlight = true;
  if (excludeId && mongoose.isValidObjectId(excludeId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
  }

  const skip = (page - 1) * limit;

  const [articles, total] = await Promise.all([
    Article.find(filter)
      .sort({ publishDate: -1 })
      .skip(skip)
      .limit(limit)
      .select('-body'),
    Article.countDocuments(filter),
  ]);

  res.json({
    data: articles,
    pagination: { total, page, limit, pages: Math.ceil(total / limit) },
  });
}

// GET /api/articles/slug-check?title=
async function slugCheck(req, res) {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'title query param required' });

  const slug = await generateUniqueSlug(title, Article);
  res.json({ slug });
}

// GET /api/articles/:slug
async function getBySlug(req, res) {
  const article = await Article.findOne({ slug: req.params.slug });
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
}

// POST /api/articles
async function create(req, res) {
  const {
    title, excerpt, author, category,
    featuredImage, featuredImageCaption, featuredImageKey,
    template, publishDate, status, body,
    featured, highlight,
  } = req.body;

  if (featured === true) await assertFeaturedLimit();
  if (highlight === true) await assertHighlightLimit();

  const slug = await generateUniqueSlug(title, Article);

  const article = await Article.create({
    title, slug, excerpt, author, category,
    featuredImage, featuredImageCaption, featuredImageKey,
    template,
    publishDate: new Date(publishDate),
    status, body,
    featured, highlight,
  });

  res.status(201).json(article);
}

// PUT /api/articles/:id
async function update(req, res) {
  const {
    title, excerpt, author, category,
    featuredImage, featuredImageCaption, featuredImageKey,
    template, publishDate, status, body,
    featured, highlight,
  } = req.body;

  const current = await Article.findById(req.params.id);
  if (!current) return res.status(404).json({ error: 'Article not found' });

  // Only check limits when toggling from false → true
  if (featured === true && !current.featured) await assertFeaturedLimit(req.params.id);
  if (highlight === true && !current.highlight) await assertHighlightLimit(req.params.id);

  const patch = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Article, req.params.id);
  }
  if (excerpt !== undefined) patch.excerpt = excerpt;
  if (author !== undefined) patch.author = author;
  if (category !== undefined) patch.category = category;
  if (featuredImage !== undefined) patch.featuredImage = featuredImage;
  if (featuredImageCaption !== undefined) patch.featuredImageCaption = featuredImageCaption;
  if (featuredImageKey !== undefined) patch.featuredImageKey = featuredImageKey;
  if (template !== undefined) patch.template = template;
  if (publishDate !== undefined) patch.publishDate = new Date(publishDate);
  if (status !== undefined) patch.status = status;
  if (body !== undefined) patch.body = body;
  if (featured !== undefined) patch.featured = featured;
  if (highlight !== undefined) patch.highlight = highlight;

  const article = await Article.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });

  res.json(article);
}

// DELETE /api/articles/:id
async function remove(req, res) {
  const article = await Article.findByIdAndDelete(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.status(204).send();
}

module.exports = { uploadUrl, list, slugCheck, getBySlug, create, update, remove };
