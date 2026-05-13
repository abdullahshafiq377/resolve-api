const Article = require('../models/Article');
const { generateUniqueSlug } = require('../utils/slugify');

const MAX_LIMIT = 100;

// GET /api/articles
async function list(req, res) {
  const { category, status } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 10));

  const filter = {};
  if (category) filter.category = category;
  if (status) filter.status = status;

  const skip = (page - 1) * limit;

  const [articles, total] = await Promise.all([
    Article.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-body'),
    Article.countDocuments(filter),
  ]);

  res.json({
    data: articles,
    pagination: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
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
  const { title, excerpt, author, category, featuredImage, template, publishDate, status, body } = req.body;

  const slug = await generateUniqueSlug(title, Article);

  const article = await Article.create({
    title,
    slug,
    excerpt,
    author,
    category,
    featuredImage,
    template,
    publishDate: new Date(publishDate),
    status,
    body,
  });

  res.status(201).json(article);
}

// PUT /api/articles/:id
async function update(req, res) {
  const { title, excerpt, author, category, featuredImage, template, publishDate, status, body } = req.body;

  const patch = {};
  if (title !== undefined) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, Article, req.params.id);
  }
  if (excerpt !== undefined) patch.excerpt = excerpt;
  if (author !== undefined) patch.author = author;
  if (category !== undefined) patch.category = category;
  if (featuredImage !== undefined) patch.featuredImage = featuredImage;
  if (template !== undefined) patch.template = template;
  if (publishDate !== undefined) patch.publishDate = new Date(publishDate);
  if (status !== undefined) patch.status = status;
  if (body !== undefined) patch.body = body;

  const article = await Article.findByIdAndUpdate(req.params.id, patch, {
    new: true,
    runValidators: true,
  });

  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.json(article);
}

// DELETE /api/articles/:id
async function remove(req, res) {
  const article = await Article.findByIdAndDelete(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  res.status(204).send();
}

module.exports = { list, slugCheck, getBySlug, create, update, remove };
