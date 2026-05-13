const express = require('express');
const auth = require('../../middleware/auth');
const {
  uploadUrl, list, getById, create, update, archive, permanentRemove,
} = require('../../controllers/admin/shorts');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// /upload-url must be registered before /:id to avoid Express treating the literal as an ID
router.post('/upload-url', auth, wrap(uploadUrl));
router.get('/', auth, wrap(list));
router.get('/:id', auth, wrap(getById));
router.post('/', auth, wrap(create));
router.patch('/:id', auth, wrap(update));
// /permanent must be registered before /:id for the same reason
router.delete('/:id/permanent', auth, wrap(permanentRemove));
router.delete('/:id', auth, wrap(archive));

module.exports = router;
