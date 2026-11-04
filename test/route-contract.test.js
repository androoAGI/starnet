/* node test/route-contract.test.js — INV-4 (truthful-ack-client): ONE FAILURE SHAPE ON THE WIRE.

   A page could not tell the station's refusals apart. The token gate answered a page from before a restart and a page
   the station withheld its key from with the same 403 'forbidden token'; a route's own 403 (a malformed agent id) looked
   no different; and every reader guessed from the status or a word ('forbidden' read as "the station restarted").
   Now every answer >= 400 names itself in X-StarNet-Code, from ONE table (sidecar/respond.js CODES):
     · respond.fail writes {ok:false, code, error} with the header naming the same code, and writes nothing once the
       head went out;
     · respond.stampFailureCodes, the main request handler's first statement, gives an unlabelled failure (an explicit
       writeHead, an implicit one through write()/end(), a statusCode assignment) its status default. An explicit code
       always wins. It never changes a status, a body or another header, and never touches a 1xx/2xx/3xx answer or a
       stream: proven against an identical unstamped server;
     · the gate refuses in one place (refuseAtGate): token_stale, token_missing, forbidden_origin, forbidden_host, with
       the legacy text bodies byte-identical (an older page's stale-token recovery reads 'forbidden token' verbatim);
     · the desktop page is cross-origin, and Access-Control-Expose-Headers lets it read the code.
   Unit (a fake res, then two in-process servers), the seam (the real sidecar through SidecarFixture), and a census of
   the gate's refusal texts. Registered in test/http.list. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const respond = require('../sidecar/respond.js');
const Tickets = require('../sidecar/apitickets.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');
const errorClass = require('../sidecar/providers/errorClass.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { readSidecarSource, sidecarSourceFiles } = require('./helpers/source.js');

const CODE = 'x-starnet-code';
const DEADLINE_MS = 5000;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const CODES = respond.CODES || {};

// ---- 1. the one table ------------------------------------------------------------------------------------------
{
  A.ok(!!respond.CODES && Object.isFrozen(respond.CODES), 'respond.js exports CODES, the one frozen table of station failure codes');
  for (const name of ['token_stale', 'token_missing', 'forbidden_origin', 'forbidden_host']) A.eq(CODES[name], 403, 'the gate code ' + name + ' rides a 403');
  for (const name of ['bad_request', 'bad_json', 'bad_agent_id', 'refused', 'forbidden', 'wrong_owner', 'path_refused', 'ticket_refused', 'not_found',
    'method_not_allowed', 'conflict', 'too_large', 'frozen', 'rate_limited', 'station_error', 'upstream_error', 'unavailable', 'upstream_timeout']) {
    A.ok(has(CODES, name), 'CODES names ' + name);
  }
  const names = Object.keys(CODES);
  A.ok(names.length > 0 && names.every(n => /^[a-z]+(?:_[a-z]+)*$/.test(n) && Number.isInteger(CODES[n]) && CODES[n] >= 400 && CODES[n] <= 599),
    'every code is a snake_case name on a 4xx or 5xx status');
  A.eq(names.filter(n => has(errorClass.REASONS, n)), [], 'no station code is also a provider reason (providers/errorClass.js), so none can be read as one');
  A.ok(typeof respond.failureCodeFor === 'function', 'respond.failureCodeFor names an unlabelled failure by its status');
  if (typeof respond.failureCodeFor === 'function') {
    const want = { 400: 'bad_request', 403: 'forbidden', 404: 'not_found', 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 423: 'frozen',
      429: 'rate_limited', 500: 'station_error', 502: 'upstream_error', 503: 'unavailable', 504: 'upstream_timeout',
      401: 'refused', 416: 'refused', 418: 'refused', 422: 'refused', 501: 'station_error', 507: 'station_error' };
    for (const s of Object.keys(want)) A.eq(respond.failureCodeFor(Number(s)), want[s], 'an unlabelled ' + s + ' is named ' + want[s]);
    for (const s of Object.keys(want)) A.ok(has(CODES, want[s]), 'the default for ' + s + ' is a row of the table');
    for (const s of Object.keys(want).filter(s => want[s] !== 'refused' && want[s] !== 'station_error')) A.eq(CODES[want[s]], Number(s), 'the ' + want[s] + ' row rides ' + s);
    for (const s of [100, 200, 204, 302, 304, 399]) A.eq(respond.failureCodeFor(s), '', 'a ' + s + ' is no failure and has no code');
  }
}

// ---- 2. respond.fail on a fake response ----------------------------------------------------------------------------
function fakeRes(sent) {
  return {
    headersSent: !!sent, status: 0, head: null, body: null, heads: 0,
    writeHead(status, head) { this.heads++; this.status = status; this.head = head; this.headersSent = true; return this; },
    end(body) { this.body = body === undefined ? '' : String(body); }
  };
}
{
  A.ok(typeof respond.fail === 'function', 'respond.fail is the canonical failure path');
  if (typeof respond.fail === 'function') {
    const r = fakeRes();
    A.eq(respond.fail(r, 404, 'not_found', 'no such run', { runId: 'r1' }), true, 'fail answers true when it wrote the failure');
    const j = JSON.parse(r.body);
    A.eq(r.status, 404, 'the status is the one given');
    A.eq([j.ok, j.code, j.error, j.runId], [false, 'not_found', 'no such run', 'r1'], 'the body is {...extra, ok:false, code, error}');
    A.eq(r.head['X-StarNet-Code'], j.code, 'the header names the same code as the body');
    A.eq([r.head['Cache-Control'], /^application\/json/.test(r.head['Content-Type'])], ['no-store', true], 'JSON, never cached');
    const over = fakeRes();
    respond.fail(over, 409, 'conflict', 'busy', { ok: true, code: 'mine', error: 'hidden' });
    const jo = JSON.parse(over.body);
    A.eq([jo.ok, jo.code, jo.error, over.head['X-StarNet-Code']], [false, 'conflict', 'busy', 'conflict'], 'extra can never overwrite ok, code or error');
    const stray = fakeRes();
    respond.fail(stray, 400, 'not_a_code', 'x');
    A.eq([stray.head['X-StarNet-Code'], JSON.parse(stray.body).code], ['bad_request', 'bad_request'], 'a code outside the table is written as its status default: the vocabulary stays closed');
    const late = fakeRes(true);
    A.eq(respond.fail(late, 400, 'bad_json', 'bad json'), false, 'fail answers false once the head went out');
    A.eq([late.heads, late.body], [0, null], 'and writes nothing (readBody already answered its 413)');
  }
}

// ---- 3. the stamp on real responses: a stamped and an unstamped server answer the same handlers ---------------------
// [path, handler, the code the stamped answer must carry (null: none)]
const CASES = [
  ['/explicit-404', (q, s) => { s.writeHead(404); s.end('not found'); }, 'not_found'],
  ['/explicit-json-400', (q, s) => { s.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); s.end('{"error":"bad json"}'); }, 'bad_request'],
  ['/assigned-500', (q, s) => { s.statusCode = 500; s.end('boom'); }, 'station_error'],                                   // implicit head through end()
  ['/assigned-503-write', (q, s) => { s.statusCode = 503; s.setHeader('Retry-After', '5'); s.write('a'); s.end('b'); }, 'unavailable'], // ... through write()
  ['/chained-409', (q, s) => { s.writeHead(409, { 'Content-Type': 'application/json' }).end('{"ok":false}'); }, 'conflict'],            // writeHead still returns res
  ['/message-404', (q, s) => { s.writeHead(404, 'Gone Fishing', { 'X-Other': '1' }); s.end(); }, 'not_found'],
  ['/teapot', (q, s) => { s.writeHead(418); s.end(); }, 'refused'],
  ['/insufficient', (q, s) => { s.writeHead(507); s.end('disk full'); }, 'station_error'],
  ['/explicit-code', (q, s) => { s.writeHead(403, 'Nope', { 'X-StarNet-Code': 'wrong_owner' }); s.end('x'); }, 'wrong_owner'],
  ['/explicit-code-lower', (q, s) => { s.writeHead(403, { 'x-starnet-code': 'path_refused' }); s.end('x'); }, 'path_refused'],
  ['/explicit-code-raw', (q, s) => { s.writeHead(403, ['X-StarNet-Code', 'ticket_refused', 'X-Other', '2']); s.end('x'); }, 'ticket_refused'],
  ['/set-before', (q, s) => { s.setHeader('X-StarNet-Code', 'frozen'); s.writeHead(423); s.end('x'); }, 'frozen'],
  ['/fail', (q, s) => { respond.fail(s, 413, 'too_large', 'too big'); }, 'too_large'],
  ['/stamp-twice', (q, s) => { respond.stampFailureCodes(s); s.writeHead(404); s.end(); }, 'not_found'],
  ['/ok-saying-no', (q, s) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end('{"ok":false,"error":"x"}'); }, null],
  ['/ok-implicit', (q, s) => { s.end('fine'); }, null],
  ['/created', (q, s) => { s.writeHead(201); s.end(); }, null],
  ['/no-content', (q, s) => { s.writeHead(204); s.end(); }, null],
  ['/redirect', (q, s) => { s.writeHead(302, { Location: '/' }); s.end(); }, null],
  ['/not-modified', (q, s) => { s.writeHead(304); s.end(); }, null],
  ['/stream', (q, s) => { s.writeHead(200, { 'Content-Type': 'application/x-ndjson' }); s.write('{"name":"error"}\n'); setTimeout(() => s.end('{"name":"done"}\n'), 5); }, null],
  // after the head went out, writeHead must refuse exactly as Node's own does (the stamp never calls setHeader then)
  ['/late-head', (q, s) => { s.writeHead(200); s.write('sent;'); try { s.writeHead(500); s.end('no refusal'); } catch (e) { s.end(e.code + ':' + e.message); } }, null]
];
const HANDLERS = new Map(CASES.map(c => [c[0], c[1]]));

function listen(stamped) {
  const srv = http.createServer((req, res) => {
    if (stamped) respond.stampFailureCodes(res);
    const handler = HANDLERS.get(String(req.url || '').split('?')[0]);
    if (handler) handler(req, res); else { res.statusCode = 400; res.end('no such case'); }
  });
  return new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve(srv)); });
}
function rawRequest(port, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: headers || {}, agent: false, timeout: DEADLINE_MS }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, message: res.statusMessage, headers: res.headers, rawHeaders: res.rawHeaders, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error(method + ' ' + p + ': no answer within ' + DEADLINE_MS + ' ms')));
    req.on('error', reject);
    req.end(body);
  });
}
const codeLines = r => r.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === CODE).length;
const restOf = r => { const h = Object.assign({}, r.headers); delete h.date; delete h[CODE]; return h; };

async function stampOnRealResponses() {
  if (typeof respond.stampFailureCodes !== 'function') { A.ok(false, 'respond.stampFailureCodes exists'); return; }
  const plain = await listen(false), stamped = await listen(true);
  try {
    for (const [p, , want] of CASES) {
      for (const method of ['GET', 'HEAD']) {
        const a = await rawRequest(plain.address().port, method, p), b = await rawRequest(stamped.address().port, method, p);
        const tag = method + ' ' + p;
        A.eq([b.status, b.message, b.body], [a.status, a.message, a.body], tag + ': the stamp changes no status, status message or body');
        A.eq(restOf(b), restOf(a), tag + ': and no other header');
        A.eq(b.headers[CODE] || null, want, tag + ': X-StarNet-Code is ' + want);
        if (want) A.eq(codeLines(b), 1, tag + ': one X-StarNet-Code line, never a second');
      }
    }
    const late = await rawRequest(stamped.address().port, 'GET', '/late-head');
    A.ok(/^sent;ERR_HTTP_HEADERS_SENT:Cannot write headers/.test(late.body), 'a writeHead after the head went out is refused by Node, not by the stamp: ' + late.body);
  } finally {
    await Promise.all([plain, stamped].map(s => new Promise(r => s.close(r))));
  }
}

// ---- 4. the seam: the real sidecar ---------------------------------------------------------------------------------
async function seam() {
  const app = SidecarFixture.create({ prefix: 'starnet-route-contract-' });
  // Exact old index bytes may replace only the composition root. All relative dependencies,
  // actual stores, route table and HTTP transport remain the real isolated sidecar's.
  if (process.env.ACK_ROUTE_CONTROL) {
    const original = path.resolve(process.env.ACK_ROUTE_CONTROL);
    const index = path.resolve(__dirname, '../sidecar/index.js');
    const entry = path.join(app.profile, 'route-control.cjs');
    fs.writeFileSync(entry, "const fs=require('node:fs'),M=require('node:module'),p=require('node:path');\n"
      + 'const f=' + JSON.stringify(index) + ',m=new M(f,module);m.filename=f;m.paths=M._nodeModulePaths(p.dirname(f));\n'
      + 'm._compile(fs.readFileSync(' + JSON.stringify(original) + ",'utf8'),f);\n");
    app.entry = entry;
  }
  const journal = makeRunJournal({ dir: path.join(app.workspace, '.run-journal') });
  journal.begin({ runId: 'ack-owned-recovery', agentId: 'agent', streamId: 'ack-stream', trigger: 'directive', model: 'fixture-no-call' });
  journal.checkpoint('ack-owned-recovery', { phase: 'initial', turn: 0, messages: [{ role: 'user', content: 'fixture history only' }] });
  const site = path.join(app.workspace, 'agent', 'ack-site');
  fs.mkdirSync(site, { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>ACK ownership fixture</h1>');
  try {
    await app.start();
    const B = app.baseUrl, port = Number(new URL(B).port);
    const ask = (p, headers, init) => fetch(B + p, Object.assign({ headers: Object.assign({ Origin: B }, headers || {}), signal: AbortSignal.timeout(DEADLINE_MS) }, init || {}));
    const keyed = headers => Object.assign({ 'X-StarNet-Token': app.token }, headers || {});

    // a 2xx carries no code, and the desktop page may read the header
    const health = await ask('/api/health', keyed());
    A.eq([health.status, health.headers.get(CODE)], [200, null], 'a 2xx carries no code');
    await health.text();
    const desk = await ask('/api/cron', keyed({ Origin: 'tauri://localhost' }));
    const exposed = String(desk.headers.get('access-control-expose-headers') || '').toLowerCase().split(/\s*,\s*/);
    A.ok(exposed.includes(CODE), 'the desktop (Tauri) page may read X-StarNet-Code: Access-Control-Expose-Headers is ' + desk.headers.get('access-control-expose-headers'));
    A.ok(exposed.includes('x-voice-provider') && exposed.includes('x-voice-cache'), 'the voice headers stay exposed');
    A.eq([desk.status, desk.headers.get(CODE)], [200, null], 'the desktop page\'s own 2xx carries no code');
    await desk.text();
    const preflight = await ask('/api/cron', { Origin: 'tauri://localhost', 'Access-Control-Request-Method': 'POST' }, { method: 'OPTIONS' });
    A.eq([preflight.status, preflight.headers.get(CODE)], [204, null], 'a CORS preflight carries no code');

    // the gate: four refusals, four names, the legacy bodies byte-identical
    const gate = async (label, res, body, code) => A.eq([res.status, await res.text(), res.headers.get(CODE)], [403, body, code], label);
    await gate('a wrong key: the legacy body, named token_stale', await ask('/api/cron', { 'X-StarNet-Token': 'not-this-launch' }), 'forbidden token', 'token_stale');
    await gate('no key at all: the same body, named token_missing', await ask('/api/cron'), 'forbidden token', 'token_missing');
    await gate('a stale ?ticket= on the EventSource shape is a stale page', await ask('/api/channels/events?ticket=old-launch-ticket'), 'forbidden token', 'token_stale');
    await gate('the EventSource shape with no ticket carried no key', await ask('/api/channels/events'), 'forbidden token', 'token_missing');
    await gate('a foreign Origin is named forbidden_origin', await ask('/api/cron', keyed({ Origin: 'https://evil.example' })), 'forbidden origin', 'forbidden_origin');
    const deskStale = await ask('/api/cron', { Origin: 'tauri://localhost', 'X-StarNet-Token': 'not-this-launch' });
    A.eq(deskStale.headers.get('access-control-allow-origin'), 'tauri://localhost', 'the desktop page may read its own refusal');
    await gate('the desktop page\'s stale key is named token_stale too', deskStale, 'forbidden token', 'token_stale');
    for (const p of ['/', '/api/cron']) {
      const r = await rawRequest(port, 'GET', p, { Host: 'rebind.evil.example:' + port });
      A.eq([r.status, r.body, r.headers[CODE]], [403, 'forbidden host', 'forbidden_host'], 'a rebound Host on ' + p + ' is named forbidden_host');
    }

    // routes: an unlabelled failure carries its status default, its body untouched
    const unknownApi = await ask('/api/definitely-not-a-route', keyed());
    A.eq([unknownApi.status, unknownApi.headers.get(CODE), await unknownApi.text()], [404, 'not_found', 'not found'], 'an unknown /api route: 404 not_found, its body as it was');
    const unknownStatic = await ask('/definitely-not-a-page.html');
    A.eq([unknownStatic.status, unknownStatic.headers.get(CODE)], [404, 'not_found'], 'a missing static file: 404 not_found');
    await unknownStatic.text();
    const badJson = await ask('/api/cron/remove', keyed({ 'Content-Type': 'application/json' }), { method: 'POST', body: 'not json' });
    const badCode = badJson.headers.get(CODE);
    A.eq([badJson.status, await badJson.text()], [400, '{"error":"bad json"}'], 'bad JSON keeps its status and its body');
    A.ok(has(CODES, badCode) && CODES[badCode] === 400, 'and is named by a 400 row of the table: ' + badCode);
    const noRoutine = await ask('/api/cron/run', keyed({ 'Content-Type': 'application/json' }), { method: 'POST', body: JSON.stringify({ id: 'no-such-routine' }) });
    A.eq([noRoutine.status, noRoutine.headers.get(CODE), await noRoutine.text()], [404, 'not_found', '{"error":"no such routine"}'], 'a route\'s own JSON 404 is named, its body untouched');
    // a seam that answers before the API gate is stamped too: the stamp is the request handler's first statement
    const hook = await rawRequest(port, 'POST', '/api/hooks/trg_nosuchtrigger01', { Host: 'abc.trycloudflare.com', 'Content-Type': 'application/json' }, '{}');
    A.eq([hook.status, hook.headers[CODE], hook.body], [401, 'refused', '{"ok":false,"error":"unauthorized"}'], 'the trigger webhook\'s 401 (an unlisted 4xx) is named refused, its body untouched');

    await agentRoutes(app, ask, keyed);

    // a 2xx NDJSON stream carries no code and streams as it always did
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DEADLINE_MS);
    try {
      const stream = await fetch(B + '/api/run/stream', { headers: keyed({ Origin: B }), signal: ac.signal });
      A.eq([stream.status, stream.headers.get(CODE)], [200, null], 'a 2xx NDJSON stream carries no code');
      A.ok(/x-ndjson/.test(stream.headers.get('content-type') || ''), 'it is the NDJSON stream');
      const first = await stream.body.getReader().read();
      A.ok(/"stream":"ready"/.test(Buffer.from(first.value || []).toString('utf8')), 'and its first line arrives as before');
    } finally { clearTimeout(timer); ac.abort(); }
  } finally {
    await app.dispose();
  }
}

// S4: these are real routes with all unrelated required fields supplied. A malformed
// agent never reaches its store, file jail, stream or provider path. Defaults remain
// a separate positive contract; an unknown well-formed agent is not a malformed ID.
async function agentRoutes(app, ask, keyed) {
  const bad = 'bad.id';
  const gets = [
    '/api/notebook', '/api/save', '/api/runs', '/api/insights', '/api/transcript',
    '/api/memory/proposals', '/api/study/proposals', '/api/threads/proposals',
    '/api/memory/records', '/api/memory/pending', '/api/memory/declined',
    '/api/checkpoint', '/api/agent-skills', '/api/agent-skills/goldens',
    '/api/agent-skills/candidates', '/api/agent-skills/candidate', '/api/learning-status',
    '/api/workshop/backlog', '/api/workshop/pending', '/api/toolsets', '/api/slash/catalog',
    '/api/workspace/dir', '/api/file'
  ];
  const posts = [
    ['/api/workshop/grant', { agentId: bad }], ['/api/workshop/queue', { agentId: bad }],
    ['/api/workshop/remove', { agentId: bad }], ['/api/workshop/decide', { agentId: bad }],
    ['/api/workshop/undo', { agentId: bad }], ['/api/workshop/shift', { agentId: bad }],
    ['/api/workshop/implement', { agentId: bad }], ['/api/checkpoint/restore', { agentId: bad }],
    ['/api/agent/model', { agentId: bad }], ['/api/agent/approval', { agentId: bad }],
    ['/api/agent/personality', { agentId: bad }], ['/api/agent/delete', { agentId: bad }],
    ['/api/roster', { agents: [{ agentId: bad }] }],
    ['/api/skill-market/share', { agentId: bad }],
    ...['install', 'check', 'export', 'publish-handoff', 'generations', 'rollback'].map(x => ['/api/skill-exchange/' + x, { agentId: bad }]),
    ...['manage', 'allow', 'evaluate-candidate', 'approve-candidate', 'reject-candidate', 'evaluation-suite', 'share'].map(x => ['/api/agent-skills/' + x, { agentId: bad }]),
    ['/api/autonomy/write', { agentId: bad, path: 'must-not-exist.txt', content: 'never write' }],
    ['/api/nightshift/beat', { agentId: bad }],
    ['/api/notebook/restore', { agent: bad, notes: [] }], ['/api/save/recovery-ack', { agent: bad }],
    ['/api/save', { agent: { id: bad } }],
    ['/api/channels/handoff', { agentId: bad, channel: 'dev', chatId: 'ack-chat', streamId: 'ack_stream' }],
    ['/api/study/resolve', { agentId: bad }], ['/api/threads/turnin', { agentId: bad }],
    ...['turnin', 'reset', 'declined/restore', 'pin', 'edit', 'forget'].map(x => ['/api/memory/' + x, { agentId: bad }]),
    ['/api/attachments', { agent: bad, name: 'must-not-exist.txt', dataUrl: 'data:text/plain;base64,bmV2ZXI=' }],
    ['/api/diagnostics/live', { agentId: bad, confirmedLiveProbes: true }],
    ['/api/run-recoveries/resolve', { agentId: bad, runId: 'ack-owned-recovery', resolutionId: 'ack-resolution' }],
    ['/api/run-recoveries/continue', { agentId: bad, runId: 'ack-owned-recovery', continuationId: 'ack-continuation', confirmedSafeContinuation: true }]
  ];
  async function read(p, body) {
    const r = await ask(p, keyed(body ? { 'Content-Type': 'application/json' } : null),
      body ? { method: 'POST', body: JSON.stringify(body) } : null);
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch (_) {}
    return { status: r.status, code: r.headers.get(CODE), text, j };
  }
  async function invalid(p, body) {
    const r = await read(p, body);
    A.eq([r.status, r.code, r.j && r.j.ok, r.j && r.j.code], [400, 'bad_agent_id', false, 'bad_agent_id'],
      (body ? 'POST ' : 'GET ') + p + ': malformed ID has one honest refusal (got ' + r.text.slice(0, 150) + ')');
    A.ok(r.j && typeof r.j.error === 'string' && r.j.error.length > 0, p + ': the refusal gives a reason');
  }
  for (const p of gets) await invalid(p + '?agent=' + bad);
  await invalid('/api/toolsets?agentId=' + bad);
  await invalid('/api/subagents?agentId=' + bad);
  await invalid('/workshop-run/' + bad + '/run/index.html');
  await invalid('/view/~t/not-a-ticket/' + bad + '/ack-site/index.html');
  for (const [p, body] of posts) await invalid(p, body);
  A.ok(!fs.existsSync(path.join(app.workspace, bad)), 'malformed operations never create an agent workspace');
  A.ok(!fs.existsSync(path.join(app.workspace, bad + '.save.json')), 'malformed save never creates an agent record');

  for (const p of ['/api/runs?agent=*', '/api/runs', '/api/insights', '/api/subagents', '/api/toolsets', '/api/slash/catalog']) {
    const r = await read(p);
    A.eq([r.status, r.code], [200, null], p + ': its existing default or wildcard remains valid');
  }
  const unknown = await read('/api/toolsets?agent=missing_valid_agent');
  A.eq([unknown.status, unknown.code], [404, 'not_found'], 'a valid-shaped unknown agent remains not found, never malformed');
  const consent = await read('/api/diagnostics/live', { agentId: bad });
  A.eq(consent.status, 409, 'the live doctor retains consent-before-probe refusal');

  for (const [p, body] of [
    ['/api/run-recoveries/resolve', { runId: 'ack-owned-recovery', agentId: 'another_agent', resolutionId: 'ack-resolution', confirmedNoReplay: true }],
    ['/api/run-recoveries/continue', { runId: 'ack-owned-recovery', agentId: 'another_agent', continuationId: 'ack-continuation', confirmedSafeContinuation: true }]
  ]) {
    const r = await read(p, body);
    A.eq([r.status, r.code, r.j && r.j.code], [403, 'wrong_owner', 'wrong_owner'], p + ': another owner remains authorization refusal');
  }
  const held = await read('/api/run-recoveries?limit=100');
  A.ok(held.j && Array.isArray(held.j.recoveries) && held.j.recoveries.some(x => x.runId === 'ack-owned-recovery'), 'the real journal recovery remains present after refused decisions');

  const view = dir => '/view/~t/' + Tickets.mint(app.token, 'view', Tickets.scopeView('agent', dir), { now: Date.now() }) + '/agent/' + (dir || '~') + '/';
  const page = await read(view('ack-site') + 'index.html');
  A.eq([page.status, page.code], [200, null], 'a real folder-scoped ticket still reads its owned file');
  A.ok(page.text.includes('ACK ownership fixture'), 'ticket positive proves actual file bytes');
  for (const p of ['/view/agent/ack-site/index.html', '/view/~t/wrong/agent/ack-site/index.html',
    view('other-site').replace('/other-site/', '/ack-site/') + 'index.html']) {
    const r = await read(p);
    A.eq([r.status, r.code], [403, 'ticket_refused'], p.split('/').slice(0, 3).join('/') + ': missing/wrong-scope ticket is not a stale page');
  }
  for (const p of ['/api/file?agent=agent&path=..%2Foutside.txt', '/workshop-run/agent/run/..%2F..%2Foutside.txt', view('ack-site') + '.env']) {
    const r = await read(p);
    A.eq([r.status, r.code], [403, 'path_refused'], 'a genuine path refusal stays403 with its own code: ' + p.slice(0, 75));
  }
  A.eq(fs.readFileSync(path.join(app.workspace, 'agent', 'ack-site', 'index.html'), 'utf8'), '<h1>ACK ownership fixture</h1>', 'refusal controls preserve the exact real file');
}

// ---- 5. census: the gate refuses in one place ----------------------------------------------------------------------
/* Every write of a gate refusal text in the sidecar is refuseAtGate's, or one of these audited rows (exact counts, both
   ways: a new inline copy fails, and a row that shrank is lowered here in the same commit). */
const GATE_TEXT_ROWS = {
  'sidecar/index.js': 1,          // the crash-loop holding listener: a separate degraded server (no stores, no routes)
  'sidecar/openai-compat.js': 2,  // /v1's own Host pin, behind the main floor; /v1 keeps the OpenAI error contract
  'sidecar/plugin-surface.js': 1  // a plugin window's ticket-or-header check (frames and tabs; the status default names it)
};
{
  const src = readSidecarSource();
  const at = src.indexOf('const server = http.createServer((req, res) => {');
  A.ok(at >= 0, 'index.js declares the main server');
  const first = src.slice(at).split('\n').slice(1).find(l => l.trim() && !/^\s*\/\//.test(l)) || '';
  A.ok(/^\s*stampFailureCodes\(res\);/.test(first), 'the stamp is the first statement of the main request handler: ' + first.trim());
  const WRITE = /(?:\.end\(|fail\(res, 403, )'forbidden (?:token|origin|host)'\)/g;
  const counts = {};
  for (const f of sidecarSourceFiles()) {
    const n = (f.text.match(WRITE) || []).length;
    if (n) counts[f.rel] = n;
  }
  A.eq(counts, GATE_TEXT_ROWS, 'gate refusal texts are written only by refuseAtGate (res.end(reason)) and the audited rows');
  const gateFn = (/function refuseAtGate\(req, res, reason\) \{[\s\S]*?\n\}/.exec(src) || [''])[0];
  A.ok(/res\.end\(reason\)/.test(gateFn) && /'X-StarNet-Code': code/.test(gateFn), 'refuseAtGate writes the reason verbatim and names it in X-StarNet-Code');
  for (const reason of ['forbidden host', 'forbidden origin', 'forbidden token']) {
    A.ok(src.includes("return refuseAtGate(req, res, '" + reason + "');"), 'the ' + reason + ' check refuses through refuseAtGate');
  }
}

(async () => {
  try {
    await stampOnRealResponses();
    await seam();
  } catch (e) {
    A.ok(false, 'route-contract threw: ' + (e && e.stack || e));
  }
  A.report('route-contract.test');
})();
