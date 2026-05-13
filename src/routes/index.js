const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', require('./articles'));
router.use('/shorts', require('./shorts'));
router.use('/admin', require('./admin'));

module.exports = router;
