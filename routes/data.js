var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('data', { title: 'Oslo Metro data' });
});

module.exports = router;
