'use strict';
/* node test/station-refusal-readers.test.js — INV-6, refusals are read from the station's code (truthful-ack lane, 2026-11-03).

   Every failure the station answers names itself in X-StarNet-Code (sidecar/respond.js CODES). The page used to decide
   "the station restarted — reload" from a bare 403 or the word 'forbidden': a malformed agent id, another run's
   ticket or a wrong address read as a restart, a 404 'no such run' read as "that model isn't available", and the
   page's own "the station refused this request (HTTP 403)" read as "the provider rejected the API key".

   Locked here, for EVERY code in CODES and every page reader, all running the production code:
     · "stale session / reload" iff the code is token_stale (a key from before a restart);
     · token_missing (no key rode) reads as the withheld notice, never "restarted";
     · no station code reads as a provider key, billing or model fault (not_found is never model_not_found);
     · parity: every CODES key has a STATION_CODE_TO_KIND row, and no row names a code the station does not send;
     · with no header (an older station) the legacy readings are unchanged;
     · the decisions that used to read a bare status (app.js's restart polls, group chat, the rating store, the save
       pull) now decide through the one reader — driven here with the real functions, not by their source text.
   Readers: staleTokenRecovery.isStaleReply, classifyApiFailure, keyCheckFailure and Harness.api.why (lifted from
   frontend/app/harness.js by source), Friendly.friendlyError via err.stationCode (node and the browser-shaped build),
   CloudSaveCore.causeOf, app.js gateRefusedPage, group-chat.js api(), XpStore.recordWorkRating, CloudSave's pull. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { CODES } = require('../sidecar/respond.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');
const harness = read('harness.js'), appSrc = read('app.js'), groupSrc = read('group-chat.js');
const ALL = Object.keys(CODES);
A.ok(ALL.length >= 20 && ALL.includes('token_stale') && ALL.includes('token_missing') && ALL.includes('not_found'), 'respond.js CODES is the table (' + ALL.length + ' codes)');
const TOKEN = c => c === 'token_stale' || c === 'token_missing';
const lift = (re, what) => { const m = re.exec(harness); A.ok(!!m, 'harness.js defines ' + what); return m ? m[0] : ''; };

// ---- the production readers ----
const classifySrc = lift(/ {2}function classifyApiFailure\([\s\S]*?\n {2}\}/, 'classifyApiFailure');
const classify = classifySrc ? new Function(classifySrc + '\nreturn classifyApiFailure;')() : () => null;
const keySrc = lift(/function keyCheckFailure\(status, j, text(?:, code)?\) \{[\s\S]*?\n {2}\}/, 'keyCheckFailure');
const keyCheckFor = withheld => keySrc ? new Function('tokenWithheld', keySrc + '\nreturn keyCheckFailure;')(withheld) : () => '';
const staleStart = harness.indexOf('  function staleTokenRecovery(o) {');
const staleTokenRecovery = new Function(harness.slice(staleStart, harness.indexOf('\n  }\n', staleStart) + 4) + '\nreturn staleTokenRecovery;')();
const apiStart = harness.indexOf('  async function requestJson(');
const apiCtx = vm.createContext({ AbortController, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no fetch')) });
vm.runInContext(harness.slice(apiStart, harness.indexOf('\n  // ONE fold point', apiStart)) + '\nthis.api = api;', apiCtx);
const why = typeof apiCtx.api.why === 'function' ? apiCtx.api.why : (A.ok(false, 'Harness.api.why exists'), () => '');
const NodeFriendly = require('../frontend/app/friendlyerror.js');
const BrowserFriendly = (() => { const sb = { console }; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(read('friendlyerror.js') + '\nthis.__F = Friendly;', sb); return sb.__F; })();
const CloudSaveCore = require('../frontend/app/cloudsavecore.js');

// one answer per code, shaped as the station sends it: the gate's legacy text bodies, a route's fail() envelope
const GATE_BODY = { token_stale: 'forbidden token', token_missing: 'forbidden token', forbidden_origin: 'forbidden origin', forbidden_host: 'forbidden host' };
const bodyOf = code => GATE_BODY[code] || JSON.stringify({ ok: false, code, error: code === 'not_found' ? 'no such run' : code.replace(/_/g, ' ') });
const answer = (code, body) => new Response(body == null ? bodyOf(code) : body, { status: CODES[code], headers: { 'X-StarNet-Code': code } });
const NOT_A_PROVIDER_FAULT = k => ['auth', 'billing', 'model_not_found', 'quota_exhausted', 'oauth', 'no_model', 'rate_limit', 'provider_server_error',
  'provider_unreachable', 'managed_credit', 'managed_credit_link', 'call_too_expensive', 'grok_oauth_unavailable'].indexOf(k) < 0;

(async () => {
  /* ---- parity: one STATION_CODE_TO_KIND row per code the station sends ---- */
  for (const [where, F] of [['node', NodeFriendly], ['browser', BrowserFriendly]]) {
    const table = F.STATION_CODE_TO_KIND || {};
    A.eq(Object.keys(table).sort().join(','), ALL.slice().sort().join(','), where + ': STATION_CODE_TO_KIND has exactly one row per respond.js code');
    for (const c of ALL) A.ok(!!(F.KINDS && F.KINDS[table[c]]), where + ': ' + c + ' maps to a real kind (' + table[c] + ')');
  }

  for (const code of ALL) {
    const status = CODES[code];
    /* staleTokenRecovery.isStaleReply: the in-place recovery takes ONLY the gate's key refusals */
    const rec = staleTokenRecovery({ rawFetch: () => Promise.reject(new Error('no page read here')), getToken: () => 'OLD', setToken() {}, canRefresh: () => false });
    A.eq(await rec.isStaleReply(answer(code)), TOKEN(code), 'isStaleReply(' + code + '): only the gate\'s key refusal is the recovery\'s');
    A.eq(await rec.isStaleReply(answer(code, 'forbidden token')), TOKEN(code), 'isStaleReply(' + code + '): the code decides, never the body\'s words');

    /* classifyApiFailure: stale iff token_stale, withheld iff token_missing, whatever the page's recovery state says */
    for (const state of [undefined, { sessionStale: true }, { sessionStale: false }, { tokenWithheld: 'lookup-failed', withheldNotice: 'THE NOTICE' }]) {
      for (const [shape, reply] of [['Response', answer(code)], ['Harness.api result', { ok: false, status, code, j: null }]]) {
        const f = classify(reply, state) || {};
        const label = 'classifyApiFailure(' + code + ', ' + shape + ', ' + JSON.stringify(state || null) + ')';
        A.eq(!!f.staleSession, code === 'token_stale', label + ': a stale session iff token_stale');
        A.eq(f.code === 'token_withheld', code === 'token_missing', label + ': the withheld notice iff token_missing');
        if (code === 'token_missing') A.ok(!!f.tokenWithheld && !/restarted/i.test(f.tokenWithheld + f.message), label + ': withheld, never "restarted"');
        A.ok(!/unreachable/i.test(String(f.message)), label + ': an answer is never "unreachable": ' + f.message);
        A.eq(f.stationCode, code, label + ': the station\'s code rides along');
      }
    }

    /* Harness.api.why: the one sentence */
    const line = why({ ok: false, status, code, j: null });
    A.eq(/restarted/.test(line) && /reload/.test(line), code === 'token_stale', 'why(' + code + '): "restarted — reload" iff token_stale: ' + line);
    A.eq(/not verified as your own account/.test(line), code === 'token_missing', 'why(' + code + '): the withheld line iff token_missing: ' + line);
    A.ok(!/api key|provider|credit|model/i.test(line), 'why(' + code + '): never a provider, key or model fault: ' + line);

    /* keyCheckFailure: the key-save hint */
    for (const withheld of ['', 'other-user']) {
      const k = keyCheckFor(withheld)(status, {}, GATE_BODY[code] || 'refused', code);
      A.eq(/station restarted since this page loaded; reload the page/.test(k), code === 'token_stale', 'keyCheckFailure(' + code + ', withheld=' + (withheld || 'no') + '): reload iff token_stale: ' + k);
      A.eq(/kept its key from this page/.test(k), code === 'token_missing', 'keyCheckFailure(' + code + ', withheld=' + (withheld || 'no') + '): the withheld hint iff token_missing: ' + k);
    }
    A.ok(!/restarted|reload/.test(keyCheckFor('')(status, {}, 'forbidden token', TOKEN(code) ? 'forbidden' : code)), 'keyCheckFailure: the code beats the body\'s words (' + code + ')');

    /* Friendly.friendlyError via err.stationCode — over texts the word ladders misread when no code rides along */
    for (const [where, F] of [['node', NodeFriendly], ['browser', BrowserFriendly]]) {
      for (const text of ['forbidden', 'no such run', 'not found', 'the station refused this request (HTTP 403)', 'Unauthorized', 'invalid api key', 'forbidden token', '']) {
        const raw = 'sidecar HTTP ' + status + (text ? ' — ' + text : '');
        const v = F.friendlyError(Object.assign(new Error(raw), { status, stationCode: code })) || {};
        const label = where + ' friendlyError("' + raw + '", ' + code + ')';
        A.eq(v.action === 'reload', code === 'token_stale', label + ': the RELOAD door iff token_stale (' + v.kind + ')');
        A.eq(/restarted/i.test(v.userMessage), code === 'token_stale', label + ': "restarted" iff token_stale: ' + v.userMessage);
        if (code === 'token_missing') A.ok(v.kind === 'stale_session' && v.withheld === true && v.action === null && /won’t take commands/.test(v.userMessage), label + ': the withheld notice, no door: ' + v.userMessage);
        A.ok(NOT_A_PROVIDER_FAULT(v.kind), label + ': never a provider key, billing or model fault (' + v.kind + ')');
        A.eq(v.kind, F.STATION_CODE_TO_KIND ? F.STATION_CODE_TO_KIND[code] : '(no table)', label + ': the kind is the code\'s row');
        if (v.kind === 'station_refused') A.ok(/^The station refused this request/.test(v.userMessage) && v.retryable === false && !F.actionButton(v), label + ': the station\'s own refusal leads, no doomed door: ' + v.userMessage);
      }
      // opts.stationCode reads the same as err.stationCode
      A.eq((F.friendlyError(new Error('sidecar HTTP ' + status + ' — x'), null, { stationCode: code }) || {}).kind, F.STATION_CODE_TO_KIND && F.STATION_CODE_TO_KIND[code], where + ': opts.stationCode is read too (' + code + ')');
    }

    /* CloudSaveCore.causeOf: a refused WINDOW is the gate's key refusal only */
    A.eq(CloudSaveCore.causeOf({ answered: true, status, body: null, code }) === 'forbidden', TOKEN(code), 'causeOf(' + code + '): "refused this window — reload" iff the gate refused its key');
    A.ok(CloudSaveCore.causeOf({ answered: true, status, body: null, code }) !== 'offline', 'causeOf(' + code + '): an answer is never "did not answer"');
  }

  /* ---- with no header (an older station) the legacy readings stand ---- */
  {
    const rec = staleTokenRecovery({ rawFetch: () => Promise.reject(new Error('x')), getToken: () => 'OLD', setToken() {}, canRefresh: () => false });
    A.eq(await rec.isStaleReply(new Response('forbidden token', { status: 403 })), true, 'legacy: the body \'forbidden token\' is the gate\'s');
    A.eq(await rec.isStaleReply(new Response('forbidden', { status: 403 })), false, 'legacy: a route\'s own 403 is not');
    A.eq(classify({ ok: false, status: 403 }, undefined).code, 'stale_session', 'legacy: a 403 with no recovery state reads as before (a stale session)');
    A.eq(classify({ ok: false, status: 403 }, { sessionStale: false }).code, 'forbidden', 'legacy: a 403 the recovery did not prove stale is the route\'s');
    A.eq(classify({ ok: false, status: 403, code: 'http_403', j: null }, { sessionStale: false }).code, 'forbidden', 'legacy: a code this page made up itself (http_<n>) is no station\'s');
    A.eq(classify({ ok: false, status: 404 }, {}).message, 'unreachable (HTTP 404)', 'legacy: the old wording, byte for byte');
    for (const F of [NodeFriendly, BrowserFriendly]) {
      A.eq(F.friendlyError(new Error('sidecar HTTP 403 — forbidden')).kind, 'stale_session', 'legacy: a code-less "sidecar HTTP 403" keeps its reading');
      A.eq(F.friendlyError(new Error('sidecar HTTP 404 — no such run')).kind, 'model_not_found', 'legacy: a code-less 404 keeps its reading');
    }
    A.eq(CloudSaveCore.causeOf({ answered: true, status: 403, body: null }), 'forbidden', 'legacy: any 401/403 is a refused window');
    A.eq(CloudSaveCore.causeOf({ answered: true, status: 401, body: {} }), 'forbidden', 'legacy: …401 too');
    A.ok(/reload the page/.test(keyCheckFor('')(403, {}, 'forbidden token')) && /kept its key/.test(keyCheckFor('other-user')(403, {}, 'forbidden token')), 'legacy: the key check reads the body\'s words');
  }

  /* ---- a route code leaves the station's own sentences their doors ---- */
  for (const F of [NodeFriendly, BrowserFriendly]) {
    const signin = F.friendlyError(Object.assign(new Error('sidecar HTTP 500 — sidecar failure: Not signed in to ChatGPT — connect a ChatGPT subscription first.'), { stationCode: 'station_error' }));
    A.ok(signin.kind === 'oauth' && /SIGN IN TO CHATGPT/.test((F.actionButton(signin) || {}).label || ''), 'a route\'s code keeps the station\'s sign-in sentence its door (EL-10): ' + signin.kind);
    const busy = F.friendlyError(Object.assign(new Error('sidecar HTTP 409 — That agent is already running a task — one run at a time per agent.'), { stationCode: 'conflict' }));
    A.eq(busy.kind, 'agent_busy', 'a route\'s code keeps the busy agent its own words');
    const host = F.friendlyError(Object.assign(new Error('sidecar HTTP 403 — forbidden host'), { stationCode: 'forbidden_host' }));
    A.ok(host.kind === 'wrong_address' && /localhost/.test(host.userMessage), 'forbidden_host names the loopback rule: ' + host.userMessage);
  }

  /* ---- the decisions that read a bare status now decide through the one reader (the real functions) ---- */
  const harnessFor = state => ({ classifyApiFailure: r => classify(r, Object.assign({ sessionStale: true, tokenWithheld: '', withheldNotice: '' }, state)) });
  // app.js: the START FRESH / RECOVER polls
  const gateSrc = A.fnBody(appSrc, 'function gateRefusedPage(');
  A.ok(gateSrc.length > 0 && gateSrc.length < 2000, 'app.js defines gateRefusedPage');
  const gateRefusedPage = h => gateSrc ? new Function('Harness', gateSrc + '\nreturn gateRefusedPage;')(h) : () => false;
  const priorGate = A.fnBody(appSrc, 'function showPriorStateGate(');
  A.eq((priorGate.match(/if \(gateRefusedPage\(probe\)\) \{ clearInterval\(timer\); location\.reload\(\); return; \}/g) || []).length, 2, 'both restart polls reload through gateRefusedPage');
  A.ok(!/probe\.status === 40[13]/.test(priorGate), 'no restart poll decides on a bare status');
  // group chat: its one /api/groups reader
  const apiSrc = A.fnBody(groupSrc, 'async function api(');
  A.ok(apiSrc.length > 200 && apiSrc.length < 4000, 'group-chat.js defines api()');
  const groupApi = (H, reply) => new Function('fetch', 'Harness', 'setTimeout', 'clearTimeout', 'AbortController', apiSrc + '\nreturn api;')(async () => reply, H, setTimeout, clearTimeout, AbortController);
  const groupWords = async (H, reply) => { try { await groupApi(H, reply)(null, ''); return 'NO THROW'; } catch (e) { return e.message; } };
  // the rating store
  global.Xp = require('../frontend/app/xp.js');
  global.Tutorial = { onLevelUp: () => {} };
  const { XpStore } = require('../frontend/app/xpstore.js');
  XpStore.init({ getAgent: () => ({ id: 'agent', name: 'A' }), agents: () => [{ id: 'agent', name: 'A' }], station: global.Xp.fresh(), persist: () => {} });
  // the save pull (the unreachable gate's reason)
  let nextPull = null;
  global.fetch = (url, init) => (((init && init.method) || 'GET') === 'GET' && nextPull) ? nextPull() : Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  const CloudSave = require('../frontend/app/cloudsave.js');
  for (const code of ALL) {
    const H = harnessFor({});
    A.eq(gateRefusedPage(H)(answer(code)), TOKEN(code), 'app.js poll (' + code + '): reloads iff the gate refused this page\'s key');
    const g = await groupWords(H, answer(code));
    A.eq(/Reconnect to this station by refreshing the page/.test(g), code === 'token_stale', 'group chat (' + code + '): "refresh to reconnect" iff token_stale: ' + g);
    A.eq(/StarNet could not confirm this browser/.test(g), code === 'token_missing', 'group chat (' + code + '): the withheld notice iff token_missing');
    global.Harness = H;
    const rated = await XpStore.recordWorkRating({ runId: 'r-' + code, verdict: 'great' }, async () => answer(code));
    delete global.Harness;
    A.eq(/Rating connection was rejected — reload/.test(rated.error), code === 'token_stale', 'rating (' + code + '): "rejected — reload" iff token_stale: ' + rated.error);
    A.eq(/StarNet could not confirm this browser/.test(rated.error), code === 'token_missing', 'rating (' + code + '): the withheld notice iff token_missing');
    nextPull = () => Promise.resolve(answer(code));
    const pulled = await CloudSave.reconcile(null);
    A.eq(pulled && pulled.reason === 'forbidden', TOKEN(code), 'save pull (' + code + '): "refused this window" iff the gate refused its key (' + (pulled && pulled.reason) + ')');
  }
  // no header and no Harness: the legacy status rules stand
  A.ok(/Reconnect to this station/.test(await groupWords(undefined, { ok: false, status: 403, json: async () => { throw new SyntaxError('x'); } })), 'legacy: group chat reads a bare 403 with no Harness');
  A.ok(/connection was rejected/.test((await XpStore.recordWorkRating({ runId: 'legacy', verdict: 'great' }, async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: 'forbidden' }) }))).error), 'legacy: the rating store reads a bare 403 with no Harness');
  nextPull = () => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) });
  A.eq((await CloudSave.reconcile(null)).reason, 'forbidden', 'legacy: the save pull reads a bare 403 as a refused window');

  A.report('station-refusal-readers.test');
})().catch(e => { console.error(e); process.exit(1); });
