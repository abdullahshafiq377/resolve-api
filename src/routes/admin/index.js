const express = require('express');

const router = express.Router();

router.use('/shorts', require('./shorts'));

module.exports = router;
