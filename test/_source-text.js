'use strict';

const fs = require('node:fs');

module.exports = function readSourceText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
};
