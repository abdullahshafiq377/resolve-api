const mongoose = require('mongoose');

const CATEGORIES = ['Politics', 'Defence', 'Geopolitics', 'Economy', 'Opinion'];
const TEMPLATES = ['standard', 'longform', 'visual'];
const STATUSES = ['draft', 'published'];

const ArticleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    excerpt: { type: String, required: true, trim: true },
    author: { type: String, required: true, trim: true },
    category: { type: String, enum: CATEGORIES, required: true },
    featuredImage: { type: String, required: true, trim: true },
    template: { type: String, enum: TEMPLATES, required: true },
    publishDate: { type: Date, required: true },
    status: { type: String, enum: STATUSES, default: 'draft' },
    body: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Article', ArticleSchema);
