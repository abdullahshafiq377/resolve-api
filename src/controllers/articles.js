const Article = require('../models/Article');
const { generateUniqueSlug, toSlug } = require('../utils/slugify');

// GET /api/articles
async function list(req, res) {
  const { category, status, page = 1, limit = 10 } = req.query;

  const filter = {};
  if (category) filter.category = category;
  if (status) filter.status = status;

  const skip = (Number(page) - 1) * Number(limit);

  const [articles, total] = await Promise.all([
    Article.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .select('-body'),
    Article.countDocuments(filter),
  ]);

  res.json({
    data: articles,
    pagination: {
      total,
      page: Number(page),
      limit: Number(limit),
      pages: Math.ceil(total / Number(limit)),
    },
  });
}

// GET /api/articles/slug-check?title=
async function slugCheck(req, res) {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'title query param required' });

  const slug = await generateUniqueSlug(title);
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
  const { title, publishDate, ...rest } = req.body;

  const slug = await generateUniqueSlug(title);

  const article = await Article.create({
    title,
    slug,
    publishDate: new Date(publishDate),
    ...rest,
  });

  res.status(201).json(article);
}

// PUT /api/articles/:id
async function update(req, res) {
  const { title, publishDate, slug: _ignoredSlug, ...rest } = req.body;

  const patch = { ...rest };
  if (title) {
    patch.title = title;
    patch.slug = await generateUniqueSlug(title, req.params.id);
  }
  if (publishDate) patch.publishDate = new Date(publishDate);

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
