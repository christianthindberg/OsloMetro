var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('rpi', { title: 'Oslo Metro RPI' });
});

module.exports = router;
