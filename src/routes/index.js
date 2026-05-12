const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'resolve-api' });
});

router.use('/articles', require('./articles'));

module.exports = router;
