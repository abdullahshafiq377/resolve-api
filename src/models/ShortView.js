const mongoose = require('mongoose');

const ShortViewSchema = new mongoose.Schema({
  shortId: { type: mongoose.Schema.Types.ObjectId, ref: 'Short', required: true },
  ip: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // TTL: 24 hours
});

ShortViewSchema.index({ shortId: 1, ip: 1 }, { unique: true });

module.exports = mongoose.model('ShortView', ShortViewSchema);
