'use strict';
/* node test/harness-api.contract.test.js — INV-5, the proven-ack client (truthful-ack lane, 2026-11-03).

   Harness.api is the page's one client for the station's JSON exchanges. Its post/del used to REJECT on any answer that was
   not JSON — the gate's plain-text 403 'forbidden token', an HTML 5xx, the static 404 'not found' — so the control that
   asked said "could not reach the station" about a station that had answered; a 200 {ok:false} resolved ok:true; and no
   result said which refusal it was. The contract now:
     · post/del resolve { ok, status, code, j } for EVERY answer, and reject only when no answer came (a network failure,
       an abort, the deadline — with today's sentences);
     · ok === true iff 2xx AND a JSON object AND j.ok !== false;
     · when ok is false, code is never empty: the station's X-StarNet-Code, else j.code, else bad_body (a 2xx that is not
       JSON), refused (a 2xx {ok:false}) or http_<status>;
     · j is the parsed body or null, never synthesized;
     · get returns the body of a 2xx JSON answer, or throws an Error carrying { status, code, j };
     · Harness.api.why words the refusal from the code (the gate's own trouble) or the route's own sentence.
   The production code runs: requestJson .. '// ONE fold point' lifted from frontend/app/harness.js by source (the slice
   test/api-json-lifecycle.test.js lifts), with a fake fetch at the transport edge answering real WHATWG Responses. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const start = source.indexOf('  async function requestJson(');
const end = source.indexOf('\n  // ONE fold point', start);
A.ok(start > 0 && end > start, 'harness.js: the client slice (requestJson .. ONE fold point) is found');
const SLICE = source.slice(start, end) + '\nthis.api = api;';

// a client whose fetch answers `answer()` (a Response, a thrown error, or a promise that never settles)
function client(answer, extra) {
  const timers = new Map();
  const seen = { calls: 0, signal: null };
  const ctx = vm.createContext(Object.assign({
    AbortController,
    setTimeout: fn => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: id => { timers.delete(id); },
    fetch: (url, init) => { seen.calls++; seen.signal = init && init.signal; return answer(init); }
  }, extra || {}));
  vm.runInContext(SLICE, ctx);
  return { api: ctx.api, timers, seen, fire: () => { for (const fn of [...timers.values()]) fn(); } };
}
const reply = (status, body, headers) => () => Promise.resolve(new Response(body, { status, headers: headers || {} }));
const settle = () => new Promise(r => setImmediate(r));

/* ---- 1. the answer table: status x body x header ---- */
const STATUSES = [200, 201, 400, 403, 404, 409, 413, 500, 502, 503];
const BODIES = {
  'json ok': '{"ok":true,"value":7}',
  'json no ok field': '{"value":7}',
  'json ok:false': '{"ok":false,"error":"the route said no"}',
  'json ok:false + code': '{"ok":false,"code":"route_own_code","error":"named"}',
  'json array': '[1,2]',
  'plain text': 'forbidden token',
  'html': '<html><body>502 Bad Gateway</body></html>',
  'empty': ''
};
const HEADERS = { 'no header': null, 'header': 'not_found' };
const isJsonObject = text => { try { const v = JSON.parse(text); return v !== null && typeof v === 'object'; } catch (_) { return false; } };
const parsed = text => { try { return JSON.parse(text); } catch (_) { return null; } };

(async () => {
  let rows = 0;
  for (const status of STATUSES) for (const [bodyName, body] of Object.entries(BODIES)) for (const [hName, h] of Object.entries(HEADERS)) {
    const label = status + ' ' + bodyName + ' ' + hName;
    const headers = h ? { 'X-StarNet-Code': h } : {};
    const two = status >= 200 && status < 300;
    const j = parsed(body);
    const expectOk = two && isJsonObject(body) && j.ok !== false;
    const expectCode = expectOk ? '' : (h || (j && typeof j === 'object' && typeof j.code === 'string' ? j.code : '') || (two ? (isJsonObject(body) ? 'refused' : 'bad_body') : 'http_' + status));
    for (const method of ['post', 'del']) {
      const c = client(reply(status, body, headers));
      let r = null, err = null;
      try { r = await (method === 'post' ? c.api.post('/api/x', { a: 1 }) : c.api.del('/api/x')); } catch (e) { err = e; }
      A.ok(!err, method + ' ' + label + ': an answer is never a rejection (' + (err && err.message) + ')');
      if (!r) continue;
      A.eq(Object.keys(r).sort().join(','), 'code,j,ok,status', method + ' ' + label + ': the result is exactly { ok, status, code, j }');
      A.eq(r.ok, expectOk, method + ' ' + label + ': ok iff 2xx AND a JSON object AND j.ok !== false');
      A.eq(r.status, status, method + ' ' + label + ': status is the answer\'s');
      A.eq(r.code, expectCode, method + ' ' + label + ': code (header > j.code > bad_body / refused / http_<status>)');
      if (!r.ok) A.ok(typeof r.code === 'string' && r.code.length > 0, method + ' ' + label + ': a refusal always has a code');
      A.eq(JSON.stringify(r.j), JSON.stringify(j), method + ' ' + label + ': j is the parsed body, or null — never synthesized');
      A.eq(c.timers.size, 0, method + ' ' + label + ': the deadline is cleared once it answered');
      rows++;
    }
    // get: the body of a 2xx JSON answer, or a throw carrying what the station said
    {
      const c = client(reply(status, body, headers));
      let out, err = null;
      try { out = await c.api.get('/api/x'); } catch (e) { err = e; }
      if (two && j !== null) A.eq(JSON.stringify(out), JSON.stringify(j), 'get ' + label + ': a 2xx JSON answer resolves its body');
      else {
        A.ok(Object.prototype.toString.call(err) === '[object Error]', 'get ' + label + ': anything else throws an Error (a throw is never a fabricated success)');
        if (err) {
          A.eq(err.status, status, 'get ' + label + ': the thrown Error carries the status');
          A.eq(err.code, h || (j && typeof j === 'object' && typeof j.code === 'string' ? j.code : '') || (two ? 'bad_body' : 'http_' + status), 'get ' + label + ': …the code');
          A.eq(JSON.stringify(err.j), JSON.stringify(j), 'get ' + label + ': …and the parsed body (or null)');
          if (!two) A.eq(err.message, 'http ' + status, 'get ' + label + ': the message keeps its "http <status>" (the skill market reads it)');
        }
      }
    }
  }
  A.ok(rows === STATUSES.length * Object.keys(BODIES).length * Object.keys(HEADERS).length * 2, 'every row of the answer table ran (' + rows + ')');

  /* ---- 2. the gate's own refusals, as refuseAtGate sends them: text body, the code in the header ---- */
  for (const code of ['token_stale', 'token_missing']) {
    const r = await client(reply(403, 'forbidden token', { 'X-StarNet-Code': code, 'Content-Type': 'text/plain; charset=utf-8' })).api.post('/api/x', {});
    A.ok(r.ok === false && r.status === 403 && r.code === code && r.j === null, 'the gate\'s ' + code + ' resolves as a named refusal: ' + JSON.stringify(r));
  }

  // a header value that is no station code (a proxy's, a fake's: codes are lower-case names) is ignored, never read as one
  {
    const r = await client(reply(403, '{"ok":false,"code":"wrong_owner","error":"not yours"}', { 'X-StarNet-Code': 'text/plain' })).api.post('/api/x', {});
    A.eq(r.code, 'wrong_owner', 'a header value that is not a code falls through to the body\'s own code: ' + r.code);
  }

  /* ---- 3. no answer: still a rejection, with today's sentences ---- */
  {
    const c = client(() => { throw new TypeError('Failed to fetch'); });
    let err = null; try { await c.api.post('/api/x', {}); } catch (e) { err = e; }
    A.ok(err && /Failed to fetch/.test(err.message), 'a network failure (no answer) rejects post with the transport error');
    A.eq(c.timers.size, 0, '…and clears its deadline');
  }
  for (const [method, sentence] of [['post', 'The station did not confirm this change. Check its state before retrying.'], ['del', 'The station did not confirm this change. Check its state before retrying.'], ['get', 'The station took too long to respond. Please retry.']]) {
    const c = client(() => new Promise(() => {}));
    let err = null, done = false;
    const p = c.api[method]('/api/x', method === 'post' ? {} : undefined).then(() => { done = true; }, e => { err = e; done = true; });
    await settle(); c.fire(); await p;
    A.ok(done && err && err.message === sentence, method + ': the deadline rejects with today\'s sentence: ' + (err && err.message));
    A.ok(c.seen.signal && c.seen.signal.aborted, method + ': …and aborts the request');
  }
  {
    const ac = new AbortController();
    const c = client(init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })));
    const p = c.api.post('/api/x', {}, { signal: ac.signal });
    await settle(); ac.abort();
    let err = null; try { await p; } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'a caller\'s abort before the answer rejects (no answer came)');
  }
  {
    // the headers came, then the caller aborted the body read: no answer was read, so it rejects too
    const ac = new AbortController();
    const c = client(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })) }));
    let err = null; try { await c.api.post('/api/x', {}, { signal: ac.signal }); } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'an aborted body read is no answer: it rejects, never resolves bad_body');
  }

  /* ---- 4. Harness.api.read is the same reading, for a Response a caller already holds ---- */
  {
    const c = client(reply(200, '{}'));
    A.ok(typeof c.api.read === 'function' && typeof c.api.why === 'function', 'Harness.api exposes read(response) and why(result)');
    const r = await c.api.read(new Response('nope', { status: 409, headers: { 'X-StarNet-Code': 'conflict' } }));
    A.ok(r.ok === false && r.status === 409 && r.code === 'conflict' && r.j === null, 'read(response) answers the same shape: ' + JSON.stringify(r));
  }

  /* ---- 5. Harness.api.why words each refusal from the code, or the route's own sentence ---- */
  {
    const { why } = client(reply(200, '{}')).api;
    const NO_ANSWER = /could not reach|unreachable|did not answer|didn.t answer|not answering/i;
    const PROVIDER = /api key|provider|credit|billing|model/i;
    const cases = [
      [{ ok: false, status: 403, code: 'token_stale', j: null }, /restarted/, /reload the page/],
      [{ ok: false, status: 403, code: 'token_missing', j: null }, /not verified as your own account/, null],
      [{ ok: false, status: 403, code: 'forbidden_origin', j: null }, /address doesn.t match the station/, null],
      [{ ok: false, status: 403, code: 'forbidden_host', j: null }, /localhost/, null],
      [{ ok: false, status: 404, code: 'not_found', j: { ok: false, code: 'not_found', error: 'no such run' } }, /^no such run$/, null],
      [{ ok: false, status: 200, code: 'refused', j: { ok: false, message: 'That is already on the build list.' } }, /^That is already on the build list$/, null],
      [{ ok: false, status: 409, code: 'conflict', j: { ok: false, reason: 'busy' } }, /^busy$/, null],
      [{ ok: false, status: 400, code: 'http_400', j: null }, /^the station refused this \(HTTP 400\)$/, null],
      [{ ok: false, status: 502, code: 'upstream_error', j: null }, /^the station hit an error \(HTTP 502\)$/, null],
      [{ ok: false, status: 200, code: 'bad_body', j: null }, /answered \(HTTP 200\) but its reply could not be read/, null]
    ];
    for (const [r, must, also] of cases) {
      const line = why(r);
      A.ok(must.test(line) && (!also || also.test(line)), 'why(' + r.code + '): ' + line);
      A.ok(!NO_ANSWER.test(line), 'why(' + r.code + ') never calls an answer a lost station: ' + line);
      A.ok(!/[.]$/.test(line), 'why(' + r.code + ') has no full stop (callers add their own): ' + line);
    }
    for (const code of ['token_stale', 'token_missing', 'forbidden_origin', 'forbidden_host', 'not_found', 'forbidden', 'bad_agent_id']) {
      A.ok(!PROVIDER.test(why({ ok: false, status: 403, code, j: null })), 'why(' + code + ') never reads as a provider, key or model fault');
    }
    A.eq(why({ ok: true, status: 200, code: '', j: {} }), '', 'an ok result has nothing to explain');
    // a page the station kept its key from: the withheld notice it already shows, when the page knows its reason
    const withheld = client(reply(200, '{}'), { tokenWithheld: 'other-user', tokenWithheldNotice: r => 'StarNet could not confirm this browser (' + r + ').' }).api.why;
    A.eq(withheld({ ok: false, status: 403, code: 'token_missing', j: null }), 'StarNet could not confirm this browser (other-user)', 'token_missing reads as this page\'s own withheld notice when it knows the reason');
  }

  A.report('harness-api.contract.test');
})().catch(e => { console.error(e); process.exit(1); });
