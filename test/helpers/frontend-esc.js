'use strict';
/* test/helpers/frontend-esc.js — the PRODUCTION U.esc (frontend/js/util.js), for a test that runs a frontend module in node.

   WHY (reliability wave 1, quick win 36, 2026-10-27): delegated.js and needsyou.js carried their own esc, which left a
   single quote raw. They now call U.esc, the one complete escaper, like app.js, build.js and world.js do. In the page
   util.js always loads first; a node test that requires those modules has no U, so it installs this one — the real
   method, sliced from util.js the way test/needs-you.test.js and test/session-indicators.test.js already read it — never a
   hand-written stand-in that could drift from production.

     esc(s)              the production U.esc
     installEsc(target?) gives target.U (default: global.U) the production esc, keeping any bus stub already on it */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const util = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'util.js'), 'utf8');
const start = util.indexOf('  esc(s) {'), end = util.indexOf('\n  // seeded-ish', start);
if (start < 0 || end <= start || end - start > 500) throw new Error('frontend-esc: the bounded U.esc method was not found in frontend/js/util.js');
const U = vm.runInNewContext('({' + util.slice(start, end) + '})');

function esc(s) { return U.esc(s); }

function installEsc(target) {
  const t = target || global;
  t.U = Object.assign(t.U || {}, { esc });
  return t.U;
}

module.exports = { esc, installEsc };
