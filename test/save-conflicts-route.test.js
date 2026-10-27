/* node test/save-conflicts-route.test.js — GET /api/save/conflicts?after=<ms> reaches serveSaveConflicts through the
   REAL route table (final-polish 10-23). The boot preserved-save offer sends ?after= once the Commander has said
   "Not now" (frontend/app/cloudsave.js conflicts(since)). An `exact` entry compares the FULL req.url, so the query made
   it miss and the request fell through to the '/api/save' prefix entry (serveSaveLoad): the page read j.conflicts as
   undefined -> [] and never offered a preserved copy again, with no error anywhere.

   This slices the real ROUTES table, dispatchRoute and routePrefixMatches out of sidecar/index.js (never require it:
   that boots a sidecar) and evaluates the table with every free identifier stubbed by name, so the WHOLE table is
   walked in its real order and the test names whichever handler wins. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const { fnBody } = require('./_fnbody.js');

const src = readSidecarSource({ except: ['sidecar/tools/builtin/routines.js'] });   // routines.js declares a ROUTES table of its own
const rStart = src.indexOf('const ROUTES = [');
const rEnd = src.indexOf('\n];\n', rStart);
A.ok(rStart > 0 && rEnd > rStart, 'the ROUTES table is found in sidecar/index.js');
const routesSrc = src.slice(rStart, rEnd + 4);
const dispatchSrc = fnBody(src, 'function dispatchRoute(req, res)');
const prefixSrc = fnBody(src, 'function routePrefixMatches(url, prefix)');
A.ok(dispatchSrc && dispatchSrc.length < 3000, 'dispatchRoute is sliced');
A.ok(prefixSrc && prefixSrc.length < 1000, 'routePrefixMatches is sliced');

// every free identifier the table names (handlers, modules, route-family objects) is a callable stub that answers
// with its own name; a spread of a stub (`...x.routes`) adds no entries.
function stub(name) {
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === Symbol.iterator) return function* () {};
      if (typeof k === 'symbol') return undefined;
      return stub(name + '.' + String(k));
    },
    apply() { return name; }
  });
}
const scope = new Proxy({}, {
  has: (t, k) => typeof k === 'string' && !(k in globalThis),
  get: (t, k) => (k === Symbol.unscopables ? undefined : stub(String(k)))
});
// eslint-disable-next-line no-new-func
const build = new Function('scope', 'with (scope) { return (function () {\n' + routesSrc + '\n' + prefixSrc + '\n' + dispatchSrc +
  '\nreturn { ROUTES, dispatchRoute };\n})(); }');
const { ROUTES, dispatchRoute } = build(scope);
A.ok(Array.isArray(ROUTES) && ROUTES.length > 100, 'the real table evaluates (' + ROUTES.length + ' entries)');

const route = (method, url) => dispatchRoute({ method, url }, {});

// the boot offer after one "Not now": the query must not change which handler answers
A.eq(route('GET', '/api/save/conflicts?after=1729000000000'), 'serveSaveConflicts', 'GET /api/save/conflicts?after=<ms> reaches serveSaveConflicts');
A.eq(route('GET', '/api/save/conflicts'), 'serveSaveConflicts', 'GET /api/save/conflicts (no query) still reaches serveSaveConflicts');
A.eq(route('GET', '/api/save/conflicts?after=1&ticket=abc'), 'serveSaveConflicts', 'any further query param still reaches serveSaveConflicts');
// the neighbours are unchanged
A.eq(route('GET', '/api/save'), 'serveSaveLoad', 'GET /api/save still loads the station');
A.eq(route('GET', '/api/save?agent=agent'), 'serveSaveLoad', 'GET /api/save?agent= still loads the station');
A.eq(route('POST', '/api/save/conflicts/restore'), 'handleSaveConflictRestore', 'POST restore is unchanged');
A.eq(route('POST', '/api/save?ticket=t'), 'handleSaveWrite', 'POST /api/save (unload beacon) is unchanged');
A.eq(route('POST', '/api/save/recovery-ack'), 'handleSaveRecoveryAck', 'POST recovery-ack is unchanged');
A.ok(route('GET', '/api/save/conflictsX') !== 'serveSaveConflicts', 'a sibling path is never aliased onto serveSaveConflicts');

A.report('save-conflicts-route');
