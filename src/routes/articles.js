const express = require('express');
const auth = require('../middleware/auth');
const {
  uploadUrl,
  list,
  slugCheck,
  getBySlug,
  create,
  update,
  remove,
} = require('../controllers/articles');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// upload-url and slug-check must be registered before /:slug to avoid being matched as a slug
router.post('/upload-url', auth, wrap(uploadUrl));
router.get('/slug-check', wrap(slugCheck));
router.get('/', wrap(list));
router.get('/:slug', wrap(getBySlug));
router.post('/', auth, wrap(create));
router.put('/:id', auth, wrap(update));
router.delete('/:id', auth, wrap(remove));

module.exports = router;
