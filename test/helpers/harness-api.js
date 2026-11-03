'use strict';
/* test/helpers/harness-api.js — the PRODUCTION Harness.api (frontend/app/harness.js) for a test that runs a page control in node.

   WHY (truthful acks, 2026-11-03): the ROUTINES, LOOPS and CONNECTORS controls answer from Harness.api.post's
   { ok, status, code, j } and word a refusal with Harness.api.why. A test that runs one of those controls must prove its
   acknowledgement against the client the page really runs, never a hand-written stand-in that could drift from it. This lifts
   the same slice test/harness-api.contract.test.js and test/api-json-lifecycle.test.js lift (requestJson .. '// ONE fold
   point': requestJson, stationCodeOf, readReply, whyRefused, api) and hands it the transport edge.

     harnessApi(fetch, extra?)   -> the real { get, post, del, read, why, stationCode }, with `fetch` as its only transport
     answer(status, body, hdrs?) -> a WHATWG Response the way the station answers (an object body is sent as JSON)        */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'app', 'harness.js'), 'utf8');
const start = source.indexOf('  async function requestJson(');
const end = source.indexOf('\n  // ONE fold point', start);
if (start < 0 || end <= start) throw new Error('harness-api helper: the client slice (requestJson .. ONE fold point) was not found in frontend/app/harness.js');
const SLICE = source.slice(start, end) + '\nthis.api = api;';

function harnessApi(fetchImpl, extra) {
  const ctx = vm.createContext(Object.assign({ AbortController, setTimeout, clearTimeout, fetch: fetchImpl }, extra || {}));
  vm.runInContext(SLICE, ctx, { filename: 'harness.js (requestJson .. ONE fold point)' });
  return ctx.api;
}

function answer(status, body, headers) {
  const json = body !== null && typeof body === 'object';
  return new Response(json ? JSON.stringify(body) : String(body == null ? '' : body),
    { status, headers: Object.assign(json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'text/plain; charset=utf-8' }, headers || {}) });
}

module.exports = { harnessApi, answer };
