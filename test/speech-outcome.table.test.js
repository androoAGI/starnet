/* node test/speech-outcome.table.test.js — every speech failure has a TYPED, NAMED outcome, end to end.

   Lane speech-outcome-and-canary (10-26 reliability audit, family B13: four speech ladders that each explained a
   failure in free text the desk then re-read with regexes). On 10-26 Microsoft refused the Edge token with HTTP 403;
   no regex knew that text, so every keyless station retried a permanent refusal as a blip on every sentence and the
   speaker could only say "unreachable".

   ONE TABLE, BOTH SIDES OF THE SEAM. Each row drives the REAL sidecar ladder (sidecar/media-service.js handleTts with
   the real edgetts.js aimed at a loopback Edge server, or a provider fetch answering the row's HTTP status) and takes
   the exact envelope it answers. That envelope is then fed to the REAL desk (frontend/app/voice.js in a vm, with the
   real Harness.classifyApiFailure lifted from harness.js), and the row pins, for one spoken sentence:
     - the typed code and terminal flag the sidecar decided (and the legacy `reason` kept for one release)
     - how many /api/tts requests the desk spends on the sentence (a terminal verdict: 1; a transient one: 3)
     - the cold-off: whether the NEXT reply asks again
     - the speaker tooltip and the note, which must NAME the leg that failed
   No row may fall through as unclassified. The desk runs on an INJECTED clock (Voice.init({ now })), so the long
   cold-off's expiry is proven by moving the clock, not by sleeping (gh#38).

   Then the seams the outcome rides on: one deadline per sentence caps every leg, a desk that goes away cancels the
   leg it was waiting on, and GET /api/tts/status names the last outcome of every leg. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const edge = require('../sidecar/edgetts.js');
const SO = require('../sidecar/speech-outcome.js');
const { makeMediaService } = require('../sidecar/media-service.js');

const ROOT = path.join(__dirname, '..');
const VOICE_SRC = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'voice.js'), 'utf8');
const HARNESS_SRC = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'harness.js'), 'utf8');
const CLASSIFY_API_FAILURE = (() => {
  const m = /(  function classifyApiFailure\([\s\S]*?\n  \})/.exec(HARNESS_SRC);
  if (!m) throw new Error('harness.js no longer defines classifyApiFailure');
  return new Function(m[1] + '\nreturn classifyApiFailure;')();   // eslint-disable-line no-new-func
})();
const tick = (n = 10) => new Promise(r => setTimeout(r, n));
async function until(pred, ms) { for (let w = 0; w < ms; w += 10) { if (pred()) return true; await tick(10); } return pred(); }

// ---- a loopback Edge read-aloud server speaking the real codec ----------------------------------------------------
let edgeMode = 'ok', edgeSockets = 0, edgeClosedEarly = 0;
const CLIP = Buffer.alloc(3000, 0x5a);
function audioFrame(chunk) {
  const hdr = Buffer.from('X-RequestId:t\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
  const hl = Buffer.alloc(2); hl.writeUInt16BE(hdr.length, 0);
  return edge.wsEncode(0x2, Buffer.concat([hl, hdr, chunk]), { mask: false });
}
const edgeServer = http.createServer((rq, rs) => { rs.writeHead(426); rs.end(); });
edgeServer.on('upgrade', (rq, socket) => {
  edgeSockets++;
  if (edgeMode === 'refuse403') {
    // the server's own clock agrees on the token window: a REAL refusal (the v1-token outage), not a skewed clock
    socket.write('HTTP/1.1 403 Forbidden\r\nDate: ' + new Date(1784000000000).toUTCString() + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.end(); return;
  }
  const accept = crypto.createHash('sha1').update(String(rq.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  let finished = false;
  socket.on('error', () => {});
  // the client's destroy() arrives as 'end' on this half-open server socket
  socket.on('end', () => { if (!finished) edgeClosedEarly++; try { socket.end(); } catch (_) { /* gone */ } });
  socket.on('data', edge.makeWsParser((op, payload) => {
    if (!(op === 0x1 && payload.toString('utf8').includes('Path:ssml'))) return;
    if (edgeMode === 'hang') return;
    socket.write(audioFrame(CLIP.subarray(0, 1500)));
    if (edgeMode === 'cut') { finished = true; socket.write(edge.wsEncode(0x8, Buffer.from([0x03, 0xe8]), { mask: false })); return; }
    socket.write(audioFrame(CLIP.subarray(1500)));
    finished = true;
    socket.write(edge.wsEncode(0x1, Buffer.from('X-RequestId:t\r\nPath:turn.end\r\n\r\n{}', 'utf8'), { mask: false }));
  }, () => {}));
});

// ---- the real sidecar ladder --------------------------------------------------------------------------------------
const roots = [];
let services = [];
async function sidecar(o) {
  const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-speech-table-'));
  roots.push(workspaces);
  const keys = o.keys || {};
  const svc = makeMediaService({
    workspaces, fs, fsp,
    fetch: o.fetch || (async () => { throw new Error('unexpected network'); }),
    edgetts: {
      enabled: () => o.edge !== false,
      resolveVoice: () => 'en-US-ChristopherNeural',
      synth: (text, opts) => edge.synth(text, Object.assign({}, opts, { host: '127.0.0.1', port: edgeServer.address().port, insecure: true }))
    },
    localVoice: { status: () => ({ available: false }), defaultVoice: () => 'af_heart', edgeVoiceFor: () => 'en-US-ChristopherNeural' },
    nativeStt: { status: () => ({ available: false }) },
    readBody: async req => req.__body,
    readBodyBuffer: async () => Buffer.alloc(0),
    providerRuntimeKey: p => keys[p] || '',
    providerRuntimeBaseUrl: () => '',
    normalizeProviderId: v => String(v || '').trim().toLowerCase(),
    env: () => '', processEnv: {}, redact: String,
    logger: { error() {}, warn() {}, log() {} },
    now: () => 1784000000000,
    monotonicNow: () => performance.now(),
    randomUUID: () => crypto.randomUUID()
  });
  services.push(svc);
  return svc;
}
// POST /api/tts against a service: a fake req/res pair that can also CLOSE early (the desk went away)
async function tts(svc, body, opts) {
  const o = opts || {};
  const out = { status: 0, headers: {}, body: Buffer.alloc(0), wrote: false };
  const listeners = {};
  const res = {
    headersSent: false, writableEnded: false, destroyed: false,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; this.headersSent = true; out.wrote = true; },
    end(value) { out.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value || '')); this.writableEnded = true; }
  };
  if (o.closeAfterMs) setTimeout(() => { res.destroyed = true; (listeners.close || []).forEach(fn => fn()); }, o.closeAfterMs);
  const t0 = Date.now();
  await svc.handleTts({ headers: o.headers || {}, __body: JSON.stringify(Object.assign({ text: 'A sentence for the table.' }, body || {})) }, res);
  out.ms = Date.now() - t0;
  out.json = /json/.test(String(out.headers['Content-Type'] || '')) ? JSON.parse(out.body.toString('utf8')) : null;
  return out;
}
function provider(status, bodyText, headers) {
  return async () => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: k => (headers || {})[String(k).toLowerCase()] || null },
    text: async () => bodyText, json: async () => JSON.parse(bodyText),
    arrayBuffer: async () => Buffer.from(bodyText)
  });
}

// ---- the real desk -------------------------------------------------------------------------------------------------
function mkEl(id) {
  const cls = new Set();
  return { id, value: '', textContent: '', title: '', innerHTML: '', style: {}, _attrs: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); }, contains: c => cls.has(c) },
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; }, addEventListener() {}, onclick: null };
}
class MockAudio { constructor() { this.onended = this.onerror = null; } play() { return Promise.resolve(); } pause() {} load() {} addEventListener() {} removeEventListener() {} }
function desk(envelope, harness) {
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => nodes[id] = mkEl(id));
  const state = { tts: 0, clock: 1784000000000 };
  const respond = () => {
    if (envelope.kind === 'stale403') {
      return { ok: false, status: 403, headers: { get: () => 'text/plain' }, json: () => Promise.reject(new SyntaxError('Unexpected token f')), blob: async () => ({ size: 0 }) };
    }
    return { ok: envelope.status >= 200 && envelope.status < 300, status: envelope.status,
      headers: { get: k => (/content-type/i.test(k) ? envelope.headers['Content-Type'] : (envelope.headers[k] || null)) },
      json: async () => JSON.parse(envelope.body.toString('utf8')), blob: async () => ({ size: envelope.body.length }) };
  };
  const H = Object.assign({ getKey: () => '', configured: () => false }, harness || {});
  H.classifyApiFailure = r => CLASSIFY_API_FAILURE(r, { sessionStale: typeof H.sessionStale === 'function' ? H.sessionStale() : undefined, tokenWithheld: '', withheldNotice: '' });
  const sandbox = {
    window: {}, document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    navigator: { mediaDevices: undefined }, location: { search: '' },
    localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })(),
    AudioContext: undefined, Audio: MockAudio,
    requestAnimationFrame: cb => setTimeout(() => cb(0), 16), cancelAnimationFrame: clearTimeout,
    // the rig compresses the desk's long ceilings, as voice.button.test does
    setTimeout: (fn, ms, ...a) => setTimeout(fn, ms >= 30000 ? 200 : (ms >= 1000 ? 50 : ms), ...a), clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, AbortController,
    Blob: class { constructor(p, o) { this.size = 1; this.type = (o && o.type) || ''; } },
    fetch: (url) => {
      if (String(url).indexOf('/api/tts') < 0) return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) });
      state.tts++;
      return Promise.resolve(respond());
    },
    Chat: { isBusy: () => false, status() {}, send() {}, autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: H
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VOICE_SRC + '\nthis.__Voice = Voice;', sandbox, { filename: 'voice.js' });
  const Voice = sandbox.__Voice;
  Voice.init({ name: 'Tester', now: () => state.clock });   // the injected clock (gh#38): cold-offs move only when the test moves it
  Voice.setSpeakReplies(true);
  return { Voice, nodes, state, title: () => String(nodes['voice-toggle'].title || '') };
}
async function speakOne(d, text) {
  const before = d.state.tts;
  d.Voice.speak(text, 'agent');
  await until(() => d.state.tts > before && !d.Voice.isReplyPending(), 5000);
  await until(() => !d.Voice.isReplyPending(), 5000);
  return d.state.tts - before;
}

// the speaker's verdicts the desk recorded for the sentence (Voice.speechDiagnostics)
const lastCode = d => { const ev = d.Voice.speechDiagnostics().filter(e => e.reason === 'synthesis_failure' && e.code); return ev.length ? ev[ev.length - 1].code : ''; };

(async () => {
  await new Promise(r => edgeServer.listen(0, '127.0.0.1', r));
  try {
    const OR = { openrouter: 'sk-or-v1-table' };
    let staleNow = true;   // the stale row's page recovery state: it reconnects partway through the row
    const ROWS = [
      { name: 'Edge 403 (the 10-26 outage)', setup: async () => { edgeMode = 'refuse403'; return tts(await sidecar({})); },
        code: 'refused', engine: 'edge', http: 403, terminal: true, reason: /^edge: edge upgrade refused: HTTP 403$/,
        tooltip: /real voice failed — the free Edge voice refused the request \(HTTP 403\)/, note: /couldn’t be spoken — the free Edge voice refused the request \(HTTP 403\)\./ },
      { name: 'Edge timeout (the sentence deadline caps the leg)', setup: async () => { edgeMode = 'hang'; return tts(await sidecar({}), { deadlineMs: 700 }); },
        code: 'timeout', engine: 'edge', terminal: false, reason: /^edge: edge timeout$/,
        tooltip: /real voice unreachable — the free Edge voice timed out/, note: /couldn’t be spoken — the free Edge voice timed out\./ },
      { name: 'Edge stream cut before turn.end', setup: async () => { edgeMode = 'cut'; return tts(await sidecar({})); },
        code: 'cut_stream', engine: 'edge', terminal: false, reason: /^edge: edge socket closed before turn\.end$/,
        tooltip: /real voice unreachable — the free Edge voice cut the audio short/, note: /couldn’t be spoken — the free Edge voice cut the audio short\./ },
      { name: 'OpenRouter 401', setup: async () => tts(await sidecar({ keys: OR, edge: false, fetch: provider(401, '{"error":{"message":"No auth credentials found"}}') })),
        code: 'auth', engine: 'openrouter', http: 401, terminal: true, reason: /^openrouter 401 — .*; edge floor disabled$/,
        tooltip: /real voice failed — OpenRouter rejected the key \(HTTP 401\)/, note: /couldn’t be spoken — OpenRouter rejected the key \(HTTP 401\)\./ },
      { name: 'OpenRouter 402', setup: async () => tts(await sidecar({ keys: OR, edge: false, fetch: provider(402, '{"error":{"message":"Insufficient credits"}}') })),
        code: 'billing', engine: 'openrouter', http: 402, terminal: true, reason: /^openrouter 402 — /,
        tooltip: /real voice offline — OpenRouter is out of credits/, note: /couldn’t be spoken — OpenRouter is out of credits\./ },
      { name: 'OpenRouter 429', setup: async () => tts(await sidecar({ keys: OR, edge: false, fetch: provider(429, '{"error":{"message":"Rate limit exceeded"}}') })),
        code: 'rate_limited', engine: 'openrouter', http: 429, terminal: false, reason: /^openrouter 429 — /,
        tooltip: /real voice unreachable — OpenRouter is rate-limited/, note: /couldn’t be spoken — OpenRouter is rate-limited\./ },
      { name: 'OpenAI quota (insufficient_quota at HTTP 429)', setup: async () => tts(await sidecar({ keys: { openai: 'sk-proj-table' }, edge: false,
          fetch: provider(429, '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}') })),
        code: 'billing', engine: 'openai', http: 429, terminal: true, reason: /^openai 429 — /,
        tooltip: /real voice offline — OpenAI is out of credits/, note: /couldn’t be spoken — OpenAI is out of credits\./ },
      { name: 'Gemini per-minute quota (retry in 23s)', setup: async () => tts(await sidecar({ keys: { gemini: 'AIza-table' }, edge: false,
          fetch: provider(429, '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 10 Please retry in 23s.","status":"RESOURCE_EXHAUSTED"}}') })),
        code: 'rate_limited', engine: 'gemini', http: 429, terminal: false, retryAfterMs: 23000, requests: 1, reason: /^gemini 429 — /,
        tooltip: /real voice unreachable — Gemini is rate-limited \(retry in 23s\)/, note: /couldn’t be spoken — Gemini is rate-limited \(retry in 23s\)\./ },
      { name: 'a thrown /api/tts handler', setup: async () => {
          const svc = await sidecar({});
          const out = { status: 0, headers: {}, body: Buffer.alloc(0) };
          svc.ttsFailOpenPolicy({ headersSent: false, writeHead(s, h) { out.status = s; out.headers = h || {}; }, end(v) { out.body = Buffer.from(String(v || '')); } }, new TypeError('boom in the handler'));
          out.json = JSON.parse(out.body.toString('utf8'));
          return out;
        },
        code: 'internal_error', engine: 'station', terminal: true, reason: /^tts failure: boom in the handler$/,
        tooltip: /real voice failed — the station’s voice handler failed: tts failure: boom in the handler/, note: /couldn’t be spoken — the station’s voice handler failed/ },
      { name: 'a stale-token 403 (rejectBadApiToken, before any route)', setup: async () => ({ kind: 'stale403', json: null }),
        desk: { sessionStale: () => staleNow }, code: 'stale_session', terminal: true,
        tooltip: /voice offline — the station restarted; reload this page to reconnect/, note: /couldn’t be spoken — the station restarted; reload this page to reconnect\./ },
      { name: 'Edge disabled with no key', setup: async () => tts(await sidecar({ edge: false })),
        code: 'no_key', engine: 'keyed', terminal: true, reason: /^no key$/,
        tooltip: /real voice needs an OpenRouter, Gemini, or OpenAI credential — the free Edge voice is switched off/, note: /couldn’t be spoken — no OpenRouter, Gemini, or OpenAI credential\./ },
      // a NEWER sidecar's code this desk has never heard of: terminal and named, whatever its flag claims
      { name: 'an unknown code from a newer sidecar', setup: async () => {
          const body = { fallback: true, reason: 'edge: something new', outcome: { ok: false, terminal: false, retryAfterMs: 0, code: 'edge_throttled_v9', engine: 'edge', legs: [{ engine: 'edge', code: 'edge_throttled_v9', http: 0, detail: 'something new' }] } };
          return { status: 200, headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify(body)), json: body };
        },
        code: 'edge_throttled_v9', engine: 'edge', terminal: false, deskTerminal: true, reason: /^edge: something new$/,
        tooltip: /real voice failed — edge throttled v9 — something new/, note: /couldn’t be spoken — edge throttled v9 — something new\./ }
    ];

    for (const row of ROWS) {
      const env = await row.setup();
      // ---- the sidecar's side: a typed outcome, the 200 envelope, and the legacy reason for one release ----
      if (env.kind !== 'stale403') {
        A.eq(env.status, 200, row.name + ': the 200-always media contract');
        const o = env.json && env.json.outcome;
        A.ok(env.json && env.json.fallback === true, row.name + ': the fallback envelope');
        A.ok(o && typeof o.code === 'string', row.name + ': carries a typed outcome (' + JSON.stringify(env.json) + ')');
        A.eq(o && o.code, row.code, row.name + ': code');
        A.eq(o && o.terminal, row.terminal, row.name + ': terminal');
        if (row.engine) A.eq(o && o.engine, row.engine, row.name + ': the leg that decided');
        if (row.http) A.ok(o && o.legs.some(l => l.engine === row.engine && l.http === row.http), row.name + ': the leg carries HTTP ' + row.http);
        if (row.retryAfterMs) A.eq(o && o.retryAfterMs, row.retryAfterMs, row.name + ': retryAfterMs from the provider\'s own words');
        A.ok(o && o.legs.every(l => SO.isKnownCode(l.code) || row.code === 'edge_throttled_v9'), row.name + ': no leg is unclassified: ' + JSON.stringify(o && o.legs));
        A.ok(o && o.legs.every(l => Object.keys(l).sort().join() === 'code,detail,engine,http'), row.name + ': every leg is exactly {engine, code, http, detail}');
        A.ok(row.reason.test(String(env.json.reason)), row.name + ': the legacy reason string is kept: ' + env.json.reason);
      }
      // ---- the desk's side: requests, cold-off, tooltip and note, all from the verdict ----
      const d = desk(env, row.desk);
      const deskTerminal = row.deskTerminal != null ? row.deskTerminal : row.terminal;
      const wantRequests = row.requests != null ? row.requests : (deskTerminal ? 1 : 3);
      const spent = await speakOne(d, 'The first reply, one sentence.');
      A.eq(spent, wantRequests, row.name + ': the desk spends ' + wantRequests + ' request(s) on the sentence');
      A.eq(lastCode(d), row.code, row.name + ': the desk recorded the typed code, never an unclassified one');
      A.ok(row.note.test(d.title()), row.name + ': the note names what failed: ' + d.title());
      // the next reply: a terminal verdict holds the long cold-off (no request), a transient one asks again
      const next = await (async () => { const b = d.state.tts; d.Voice.speak('The next reply.', 'agent'); await tick(60); await until(() => !d.Voice.isReplyPending(), 5000); return d.state.tts - b; })();
      if (deskTerminal) {
        A.eq(next, 0, row.name + ': cold-off — the next reply does not re-ask a terminal failure');
        A.ok(row.tooltip.test(d.title()), row.name + ': the tooltip names the leg at once: ' + d.title());
        if (row.code === 'stale_session') {
          // the stale session's cold-off lifts the moment the page reconnects, not after 60 s
          staleNow = false;
        } else {
          d.state.clock += 59000;   // the injected clock: still inside the 60 s cold-off
          const held = await (async () => { const b = d.state.tts; d.Voice.speak('Still cold.', 'agent'); await tick(40); await until(() => !d.Voice.isReplyPending(), 5000); return d.state.tts - b; })();
          A.eq(held, 0, row.name + ': at +59 s (injected clock) the terminal cold-off still holds');
          d.state.clock += 2000;
        }
        const after = await (async () => { const b = d.state.tts; d.Voice.speak('After the cold-off.', 'agent'); await until(() => d.state.tts > b, 3000); await until(() => !d.Voice.isReplyPending(), 5000); return d.state.tts - b; })();
        A.ok(after >= 1, row.name + ': once the cold-off ' + (row.code === 'stale_session' ? 'is lifted by the reconnect' : 'expires (+61 s)') + ', the next reply asks again (no latch)');
      } else {
        A.ok(next >= 1, row.name + ': a transient failure never silences the next reply before it asks');
        await speakOne(d, 'A third reply.');
        A.ok(row.tooltip.test(d.title()), row.name + ': a blip is named once it proves persistent (three in a row): ' + d.title());
      }
    }

    // ---- SEAM: one deadline per sentence caps a keyed leg that would otherwise run 60 s ----
    {
      let aborted = false;
      const svc = await sidecar({ keys: OR, edge: false, fetch: (url, init) => new Promise((resolve, reject) => {
        const s = init && init.signal;
        if (s) s.addEventListener('abort', () => { aborted = true; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; reject(e); });
      }) });
      const r = await tts(svc, { deadlineMs: 800 });
      A.ok(r.ms < 3000, 'deadline: a hung keyed provider answers within the sentence deadline (' + r.ms + ' ms of an 800 ms budget), not at its 60 s cap');
      A.ok(aborted, 'deadline: the provider call itself was aborted');
      A.eq(r.json && r.json.outcome && r.json.outcome.code, 'timeout', 'deadline: the outcome is a typed timeout');
      A.eq(r.json && r.json.outcome && r.json.outcome.terminal, false, 'deadline: which a later sentence may retry');
      const viaHeader = await tts(svc, {}, { headers: { 'x-speech-deadline-ms': '700' } });
      A.ok(viaHeader.ms < 3000 && viaHeader.json.outcome.code === 'timeout', 'deadline: X-Speech-Deadline-Ms carries the same budget (' + viaHeader.ms + ' ms)');
    }
    // ---- SEAM: a desk that goes away cancels the Edge leg it was waiting on, and nothing is written ----
    {
      edgeMode = 'hang'; edgeClosedEarly = 0;
      const svc = await sidecar({});
      const r = await tts(svc, {}, { closeAfterMs: 150 });
      A.ok(r.ms < 3000, 'disconnect: the handler returns at once when the desk goes away (' + r.ms + ' ms)');
      A.eq(r.wrote, false, 'disconnect: nothing is written to a desk that is gone');
      await until(() => edgeClosedEarly >= 1, 2000);
      A.ok(edgeClosedEarly >= 1, 'disconnect: the Edge websocket is closed, not left to its 15 s cap');
      const st = svc.ttsStatus();
      A.ok(!(st.legs.edge && st.legs.edge.code === 'cancelled'), 'disconnect: a cancelled leg is not recorded as the engine\'s failure');
    }
    // ---- SEAM: a PAID keyed call every desk abandoned is aborted, but only after a grace a retry can join (df610df1) ----
    {
      let calls = 0, abortedAt = 0, release = null;
      const t0 = Date.now();
      const svc = await sidecar({ keys: OR, edge: false, fetch: (url, init) => new Promise((resolve, reject) => {
        calls++;
        release = () => resolve({ ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('ONE-PAID-CLIP') });
        const s = init && init.signal;
        // a provider takes a moment to honor an abort: the call is still settling when the next request arrives
        if (s) s.addEventListener('abort', () => { abortedAt = Date.now() - t0; setTimeout(() => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; reject(e); }, 400); });
      }) });
      const first = tts(svc, { text: 'One paid sentence.' }, { closeAfterMs: 100 });   // the desk gives up at once
      await tick(500);
      A.eq(abortedAt, 0, 'abandon: the paid call is NOT aborted the moment its only desk leaves (a spaced retry may join it)');
      const retry = tts(svc, { text: 'One paid sentence.' });                            // the desk's retry, 0.5 s later
      await tick(2600);
      A.eq(abortedAt, 0, 'abandon: a retry that joined within the grace keeps the call alive past it');
      release();
      const r = await retry;
      const gone = await first;
      A.eq(gone.wrote, false, 'abandon: nothing is written to the desk that left');
      A.eq([calls, r.body.toString()], [1, 'ONE-PAID-CLIP'], 'abandon: the retry is answered by the ONE paid call');
      calls = 0; abortedAt = 0;
      const lone = tts(svc, { text: 'A sentence nobody waits for.' }, { closeAfterMs: 100 });
      await until(() => abortedAt > 0, 4000);
      A.ok(abortedAt > 0, 'abandon: with no desk left after the grace, the paid call is aborted');
      const fresh = tts(svc, { text: 'A sentence nobody waits for.' });   // arrives while the aborted call is still settling
      await tick(50);
      A.eq(calls, 2, 'abandon: a request after the abort starts its own call, never joins the dying one');
      release();
      await fresh;
      await lone;
    }
    // ---- SEAM: GET /api/tts/status names the last outcome of every leg ----
    {
      edgeMode = 'refuse403';
      const svc = await sidecar({ keys: OR, fetch: provider(402, '{"error":{"message":"Insufficient credits"}}') });
      await tts(svc);
      const res = { status: 0, body: '' };
      svc.handleTtsStatus({}, { writeHead(s) { res.status = s; }, end(v) { res.body = String(v); } });
      const st = JSON.parse(res.body);
      A.eq(res.status, 200, 'status: 200');
      A.eq([st.legs.openrouter && st.legs.openrouter.code, st.legs.openrouter && st.legs.openrouter.http], ['billing', 402], 'status: the keyed leg is named (billing, HTTP 402)');
      A.eq([st.legs.edge && st.legs.edge.code, st.legs.edge && st.legs.edge.http], ['refused', 403], 'status: the floor leg is named (refused, HTTP 403)');
      A.ok(st.last && st.last.ok === false && st.last.code === 'billing' && st.last.terminal === true, 'status: the last outcome as a whole: ' + JSON.stringify(st.last));
      A.eq(st.edge, { enabled: true }, 'status: whether the floor is switched on');
      A.eq(st.keyed, ['openrouter'], 'status: which keyed providers hold a credential (names only)');
      A.ok(!res.body.includes('sk-or-v1-table'), 'status: never a secret');
      edgeMode = 'ok';
      const ok = await tts(svc, { text: 'Now the floor answers.' }, {});
      A.ok(/audio/.test(String(ok.headers['Content-Type'] || '')) || ok.json, 'status: a later request ran');
    }
  } finally {
    try { edgeServer.closeAllConnections && edgeServer.closeAllConnections(); } catch (_) { /* teardown */ }
    edgeServer.close();
    for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp dir */ } }
  }
  A.report('speech-outcome.table');
})().catch(e => { console.error(e); process.exit(1); });
