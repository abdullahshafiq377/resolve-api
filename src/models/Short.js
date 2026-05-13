const mongoose = require('mongoose');

const CATEGORIES = ['Politics', 'Defence', 'Geopolitics', 'Economy', 'Opinion'];
const STATUSES = ['draft', 'published', 'archived'];

const ShortSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    description: { type: String, trim: true },

    videoUrl: { type: String, required: true, trim: true },
    videoKey: { type: String, required: true, trim: true },

    thumbnailUrl: { type: String, trim: true },
    thumbnailKey: { type: String, trim: true },

    durationSeconds: { type: Number, min: 0 },

    category: { type: String, enum: CATEGORIES },
    tags: [{ type: String, trim: true }],

    featured: { type: Boolean, default: false },

    status: { type: String, enum: STATUSES, default: 'draft' },
    publishedAt: { type: Date },

    views: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Short', ShortSchema);
