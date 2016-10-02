var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('log', { title: 'Oslo Metro log' });
});

module.exports = router;
