const express = require('express');
const { listFeatured, getBySlug, recordView } = require('../controllers/shorts');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(listFeatured));
router.get('/:slug', wrap(getBySlug));
router.post('/:id/view', wrap(recordView));

module.exports = router;
