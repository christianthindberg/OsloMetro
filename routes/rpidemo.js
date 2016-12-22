var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('rpidemo', { title: 'Oslo Metro RPI Demo' });
});

module.exports = router;
