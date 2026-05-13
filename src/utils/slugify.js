function toSlug(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function generateUniqueSlug(title, Model, excludeId = null) {
  const base = toSlug(title);
  let slug = base;
  let counter = 1;

  while (true) {
    const query = { slug };
    if (excludeId) query._id = { $ne: excludeId };

    const exists = await Model.exists(query);
    if (!exists) return slug;

    slug = `${base}-${counter}`;
    counter++;
  }
}

module.exports = { toSlug, generateUniqueSlug };
