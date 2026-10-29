/* node test/provider-aliases-parity.test.js — every provider alias the PAGE knows is one the STATION knows too.

   The page normalises a provider id in four places (harness.js and app.js normalizeProviderId, keycta.js normProv,
   modeldock.js normalizeProvider). The station now REFUSES a provider it does not know (/api/run, the channel connect and
   sync routes, routines, /v1) instead of re-homing it on OpenRouter, so a page alias the registry lacks ('supergrok',
   'kimi-for-coding' — review r5) turned a working selection into a 400. Each table is read from its source (every
   `p === '<alias>'` on a line that returns '<id>'), and every alias must normalise in sidecar/providers/registry.js to the
   SAME id the page maps it to. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Reg = require('../sidecar/providers/registry.js');

const APP = path.join(__dirname, '..', 'frontend', 'app');
const TABLES = [['harness.js', '  function normalizeProviderId(provider) {'], ['app.js', '  function normalizeProviderId(provider) {'],
  ['keycta.js', '  function normProv(p) {'], ['modeldock.js', '  function normalizeProvider(p) {']];

let checked = 0;
for (const [file, head] of TABLES) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8');
  const at = src.indexOf(head);
  A.ok(at >= 0, 'fixture: ' + file + ' still declares its provider alias table');
  const body = at >= 0 ? src.slice(at, src.indexOf('\n  }\n', at)) : '';
  const rows = body.split('\n').map(line => /^\s*if \((p === '[^']+'(?: \|\| p === '[^']+')*)\) return '([^']+)';/.exec(line)).filter(Boolean);
  A.ok(rows.length >= 6, 'fixture: ' + file + ' has its alias rows (' + rows.length + ')');
  for (const m of rows) {
    const id = m[2];
    A.ok(!!Reg.getProviderProfile(id), file + ': the page maps to "' + id + '", a provider the registry has');
    for (const alias of m[1].match(/'[^']+'/g).map(s => s.slice(1, -1))) {
      checked++;
      A.eq(Reg.normalizeProviderId(alias, ''), id, file + ': "' + alias + '" normalises in the registry to the page\'s "' + id + '"');
    }
  }
}
A.ok(checked >= 60, 'fixture: every table was read (' + checked + ' aliases)');
A.report('provider-aliases-parity: every provider alias the page knows normalises in the station registry');
