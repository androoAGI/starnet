/* node test/resume-verdict.test.js — a verdict the station is still working out is no "no", and RESUME has ONE door (11-17).
   A cold boot of the installed 0.15.2 opened a signed-in Claude Code station on RESUME, "Enter your key to continue":
   the page decided ONCE from Harness.configured() while the station still answered claude-cli with credential
   'unknown' ("checking local sign-in" — its first `claude auth status` had not returned). A minute later the same
   station said ready and RETRY AUTO-RESUME went straight in.
   Locks: Harness.settleReadiness waits out a pending answer (bounded, past the station's own bound; stoppable) and returns
   a settled one at once; boot and every re-entry decide through ONE savedCanResume that hands its options on; the boot
   veil names only the check the station reports running; RESUME says what the station reports (never a key for a keyless
   provider, never a settled "no" for an answer it has not given) and keeps asking, bounded, while it has not settled.
   ONE DOOR (review of the fix): RETRY / a restored backup and WAKE both wait on the station; whichever enters first takes
   the door and the other stands down: never a second entry, never WAKE's new-Overseer path over a resumed station.
   Every function runs from its SHIPPED source against the real readiness cache and the station's real readiness
   projection, on a virtual clock (no wall-clock race can turn this gate red under load). */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('./_assert.js');
const { makeCache } = require('../frontend/app/provider-readiness.js');
const { makeProviderReadiness } = require('../sidecar/provider-readiness.js');
const { sidecarFunctionSource } = require('./helpers/source');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'app.js'), 'utf8');
const hs = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'harness.js'), 'utf8');
const cliHost = fs.readFileSync(path.join(ROOT, 'sidecar', 'providers', 'claude-cli.js'), 'utf8');

const S = {};
for (const [src, name, header] of [
  [hs, 'refreshProviderReadiness', '  function refreshProviderReadiness()'],
  [hs, 'readinessPending', '  function readinessPending(provider)'],
  [hs, 'settleReadiness', '  async function settleReadiness(provider, opts)'],
  [app, 'savedCanResume', '  async function savedCanResume(opts)'],
  [app, 'bootVeilLine', '  function bootVeilLine(row)'],
  [app, 'providerNeedsKey', '  function providerNeedsKey(provider)'],
  [app, 'providerLabel', '  function providerLabel(provider)'],
  [app, 'resumeUnsettled', '  function resumeUnsettled(r)'],
  [app, 'resumeAskLine', '  function resumeAskLine(provider)'],
  [app, 'paintResumeBanner', '  function paintResumeBanner()'],
  [app, 'watchResume', '  function watchResume(provider)'],
  [app, 'applyRecoveryMode', '  function applyRecoveryMode(recovery, savedAgent)'],
  [app, 'resumableSave', '  function resumableSave()'],
  [app, 'reentry', '  async function reentry()'],
  [app, 'onConnectBack', '  async function onConnectBack()'],
  [app, 'wakeBtnBusy', '  function wakeBtnBusy(busy)'],
  [app, 'onWake', '  async function onWake()'],
  [app, 'onWakeAttempt', '  async function onWakeAttempt(door)'],
  [app, 'refreshClaudeCliStatus', '  async function refreshClaudeCliStatus()']
]) {
  const b = A.fnBody(src, header);
  A.ok(b.length > 40 && b.length < 40000, name + ' is sliced from its shipped source');
  S[name] = b;
}

// THE STATION'S OWN ROWS: sidecar/index.js providerReadiness('claude-cli') hands project() these inputs per CLI state
// (pinned below: its pending branch says 'unknown', the word the page waits on).
const station = makeProviderReadiness({ now: () => 1000, digest: s => crypto.createHash('sha256').update(s).digest('hex') });
function cliRow(state) {
  const live = state === 'ready';
  const row = station.project({ id: 'claude-cli', key: '', url: '', required: true, present: live, materialReady: live, endpointConfigured: true,
    credentialStatus: live ? 'unverified' : state === 'checking' ? 'unknown' : state === 'unavailable' ? 'unavailable' : 'missing',
    reason: live ? 'local sign-in present; remote credential unverified' : state === 'checking' ? 'checking local sign-in'
      : state === 'unavailable' ? 'local sign-in status unavailable' : 'Claude Code is not signed in' });
  return Object.assign({ id: 'claude-cli' }, row);
}
const keyRow = (id, ready) => Object.assign({ id }, station.project({ id, key: ready ? 'k' : '', url: 'https://x', required: true, present: ready,
  materialReady: ready, endpointConfigured: true }));
const codexRow = () => Object.assign({ id: 'codex' }, station.project({ id: 'codex', key: 'tok', url: '', required: true, present: true,
  materialReady: true, endpointConfigured: true }));

// THE STATION'S OWN BOUND on its first sign-in check: the delay of authStatus's timeout (a literal, or a constant named in
// claude-cli.js). The page's default wait is judged against it by RUNNING the wait below, never by reading a number.
const authSrc = A.fnBody(cliHost, '    function authStatus()');
const boundRef = (/setTimeout\(\(\) => \{[^]*?auth status[^]*?\}, ([A-Za-z_$][\w$]*|\d[\d_]*)\);/.exec(authSrc) || [])[1] || '';
const stationBound = /^\d/.test(boundRef) ? Number(boundRef.replace(/_/g, ''))
  : Number(((new RegExp('const ' + boundRef + '\\s*=\\s*(\\d[\\d_]*)').exec(cliHost) || [])[1] || '').replace(/_/g, ''));
A.ok(stationBound >= 1000 && stationBound <= 120000, "the station's own bound on `claude auth status` is read from claude-cli.js (" + stationBound + ' ms)');

// A VIRTUAL CLOCK: timers run in time order, Date.now() is the clock, microtasks drain between steps. Deterministic.
function clock() {
  const T0 = 1e6; let now = T0, n = 0; const timers = [];
  const setTimeout = (fn, ms) => { const t = { id: ++n, at: now + Math.max(0, Number(ms) || 0), fn, dead: false }; timers.push(t); return t; };
  const clearTimeout = t => { if (t && typeof t === 'object') t.dead = true; };
  const flush = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
  const errors = [];
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      await flush();
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const i = timers.findIndex(t => !t.dead && t.at <= end);
      if (i < 0) break;
      const t = timers.splice(i, 1)[0];
      now = Math.max(now, t.at);
      try { t.fn(); } catch (e) { errors.push(e); }
    }
    now = end; await flush();
  }
  return { setTimeout, clearTimeout, Date: { now: () => now }, advance, flush, elapsed: () => now - T0, errors };
}
async function within(c, promise, maxMs) {
  let done = false, value, error = null;
  promise.then(v => { done = true; value = v; }, e => { done = true; error = e; });
  for (let t = 0; !done && t < maxMs; t += 100) await c.advance(100);
  await c.flush();
  return { done, value, error, at: c.elapsed() };
}

// One page: the real cache, the shipped readinessPending + settleReadiness, and a station that answers from a script
// (in order) or from the clock (o.station(ms)).
function page(script, opts) {
  const o = opts || {};
  const c = clock(), cache = makeCache(), calls = { refresh: 0 };
  const answer = step => { if (step === 'offline') cache.offline(); else cache.accept(Array.isArray(step) ? step : [step], cache.ticket()); };
  if (o.boot !== undefined) answer(o.boot);   // what Harness.init()'s own read left in the cache
  const refreshProviderReadiness = async () => { calls.refresh++; answer(o.station ? o.station(c.elapsed()) : (script.length ? script.shift() : 'offline')); };
  const readiness = id => cache.read(id);
  const H = new Function('readiness', 'refreshProviderReadiness', 'setTimeout', 'Date',
    S.readinessPending + '\n' + S.settleReadiness + '\nreturn { readinessPending, settleReadiness };')(readiness, refreshProviderReadiness, c.setTimeout, c.Date);
  return { cache, calls, readiness, H, c };
}

(async () => {
  // ---- the harness: settleReadiness ----
  {
    const p = page([cliRow('checking'), cliRow('ready')], { boot: cliRow('checking') });
    A.ok(p.H.readinessPending('claude-cli'), 'the station still checking Claude Code sign-in is PENDING, not a no');
    const seen = [];
    const r = await within(p.c, p.H.settleReadiness('claude-cli', { onPending: row => seen.push(row.credential.status + '/' + row.reason) }), 30000);
    A.ok(r.done && r.value.unattendedReady === true, 'a check that lands signed in settles READY: the boot goes straight into the station');
    A.eq(p.calls.refresh, 2, 'it re-asked the station until the answer settled, and no more');
    A.eq(r.at, 2000, 'one ask a second while it waits');
    A.eq(seen, ['unknown/checking local sign-in', 'unknown/checking local sign-in'], 'each wait names the check the station reports running');
  }
  {
    const p = page([cliRow('signedout'), cliRow('ready')], { boot: cliRow('checking') });
    const r = await within(p.c, p.H.settleReadiness('claude-cli', {}), 30000);
    A.ok(r.value.unattendedReady === false && r.value.credential.status === 'missing', 'a check that lands signed OUT settles not-ready (RESUME is then the truth)');
    A.eq(p.calls.refresh, 1, 'a settled no stops the asking at once');
  }
  {
    // the station's check may run its WHOLE bound; a sign-in it confirms at that last moment must still be waited for
    const p = page([], { boot: cliRow('checking'), station: ms => cliRow(ms < stationBound ? 'checking' : 'ready') });
    const r = await within(p.c, p.H.settleReadiness('claude-cli', {}), 60000);
    A.ok(r.done && r.value.unattendedReady === true, "the default wait outlasts the station's own " + stationBound + ' ms bound: a sign-in confirmed at its last moment still resumes (settled at ' + r.at + ' ms)');
  }
  {
    const p = page([], { boot: cliRow('checking'), station: () => cliRow('checking') });
    const r = await within(p.c, p.H.settleReadiness('claude-cli', {}), 60000);
    A.ok(r.done && r.value.credential.status === 'unknown' && r.at >= 20000 && r.at <= 21000, 'a check that never answers ends the default wait still pending, at 20s (' + r.at + ' ms)');
    A.ok(p.calls.refresh >= 19 && p.calls.refresh <= 21, 'about one ask a second, and no more (' + p.calls.refresh + ' asks)');
    const q = page([], { boot: cliRow('checking'), station: () => cliRow('checking') });
    const r2 = await within(q.c, q.H.settleReadiness('claude-cli', { waitMs: 3000 }), 60000);
    A.ok(r2.done && r2.at >= 3000 && r2.at <= 4000, 'waitMs bounds a caller\'s own wait (' + r2.at + ' ms)');
  }
  {
    const p = page([], { boot: cliRow('checking'), station: () => cliRow('checking') });
    let heard = 0;
    const r = await within(p.c, p.H.settleReadiness('claude-cli', { stop: () => heard >= 2, onPending: () => { heard++; } }), 30000);
    A.ok(r.done && r.at === 2000 && p.calls.refresh === 1, 'stop() ends the wait at once: a superseded caller stops asking (' + r.at + ' ms, ' + p.calls.refresh + ' asks)');
  }
  {
    const p = page([cliRow('ready')], { boot: cliRow('ready') });
    await within(p.c, p.H.settleReadiness('claude-cli', {}), 5000);
    A.eq(p.calls.refresh, 0, 'a settled READY answer resolves at once, with no extra question');
    await within(p.c, p.H.settleReadiness('claude-cli', { reask: true }), 5000);
    A.eq(p.calls.refresh, 1, 'reask: exactly one fresh question first (RETRY re-asks, never re-reads)');
  }
  {
    const p = page([cliRow('ready')]);   // the station has not answered at all yet
    A.ok(p.cache.read('claude-cli').cached === true && p.H.readinessPending('claude-cli'), 'no answer from the station yet is PENDING');
    const r = await within(p.c, p.H.settleReadiness('claude-cli', {}), 30000);
    A.ok(r.value.unattendedReady === true && p.calls.refresh === 1, 'the first answer settles it');
  }
  {
    // an answer KEPT from before the station went quiet is no settled "no" (the `cached` clause on its own: not 'unknown')
    const p = page([], { boot: cliRow('signedout'), station: ms => (ms < 3000 ? 'offline' : cliRow('ready')) });
    p.cache.offline();   // the page's last read failed: it holds the old answer, marked cached
    const kept = p.cache.read('claude-cli');
    A.ok(kept.cached === true && kept.credential.status === 'missing' && p.H.readinessPending('claude-cli'), 'a kept signed-out answer from before the station went quiet is PENDING');
    const r = await within(p.c, p.H.settleReadiness('claude-cli', {}), 30000);
    A.ok(r.done && r.value.unattendedReady === true && r.at >= 3000, 'the station back with READY settles it (' + r.at + ' ms)');
  }
  {
    const p = page(['offline'], { boot: cliRow('ready') });
    await within(p.c, p.H.settleReadiness('claude-cli', { reask: true }), 5000);
    A.ok(p.cache.read('claude-cli').cached === true && !p.H.readinessPending('claude-cli'),
      'an offline read keeps the last READY answer (cached) and does not wait on it');
  }
  {
    const p = page([], { boot: cliRow('unavailable') });
    const r = await within(p.c, p.H.settleReadiness('claude-cli', {}), 5000);
    A.ok(r.value.credential.status === 'unavailable' && p.calls.refresh === 0, "the station's settled \"could not tell\" (its own bound ran out) returns at once");
  }
  {
    const p = page([keyRow('openai', false)], { boot: keyRow('openai', false) });
    const r = await within(p.c, p.H.settleReadiness('openai', {}), 5000);
    A.ok(r.value.unattendedReady === false && p.calls.refresh === 0, 'a key provider with no key is a settled no: no wait');
  }

  // ---- the page: ONE resume decision for boot and re-entry, and it hands its options on ----
  function decide(p, prov, key) {
    let settled = 0;
    const Harness = {
      getKey: () => key || '', getProv: () => prov,
      configured: () => p.readiness(prov).unattendedReady === true,
      settleReadiness: (id, o) => { settled++; return p.H.settleReadiness(id, o); }
    };
    const fn = new Function('Harness', S.savedCanResume + '\nreturn savedCanResume;')(Harness);
    return { run: o => within(p.c, fn(o), 60000).then(r => r.value), settled: () => settled, oldRule: () => !!(Harness.getKey() || Harness.configured() || Harness.getProv() === 'codex') };
  }
  {
    const p = page([cliRow('checking'), cliRow('ready')], { boot: cliRow('checking') });
    const d = decide(p, 'claude-cli');
    A.eq(d.oldRule(), false, 'REPRO: at that boot moment the old one-shot rule said "cannot resume" (the 11-17 RESUME strand)');
    A.eq(await d.run({}), true, 'savedCanResume waits for the station and resumes the signed-in Claude Code station');
  }
  {
    const p = page([cliRow('signedout')], { boot: cliRow('checking') });
    A.eq(await decide(p, 'claude-cli').run({}), false, 'a station that answers signed out still lands on RESUME');
  }
  {
    // RETRY's options reach the wait: boot read READY, but RETRY re-asks first, and the fresh answer is still being worked out
    const p = page([cliRow('checking'), cliRow('ready')], { boot: cliRow('ready') });
    const heard = [];
    const ok = await decide(p, 'claude-cli').run({ reask: true, onPending: r => heard.push(r.credential.status) });
    A.ok(ok === true && p.calls.refresh === 2 && heard.join() === 'unknown', 'savedCanResume hands its options on: the re-ask happens and the veil hears the wait (' + p.calls.refresh + ' asks, heard ' + heard.join() + ')');
    const q = page([], { boot: cliRow('checking'), station: () => cliRow('checking') });
    A.ok(await decide(q, 'claude-cli').run({ stop: () => true }) === false && q.calls.refresh === 0, 'a stopped decision returns at once and asks nothing');
  }
  {
    const p = page([], { boot: cliRow('checking') });
    const d = decide(p, 'openrouter', 'sk-or-key');
    A.ok(await d.run({}) === true && d.settled() === 0 && p.calls.refresh === 0, 'a key in hand resumes without asking the station');
    const c = decide(p, 'codex');
    A.ok(await c.run({}) === true && c.settled() === 0, 'codex resumes without asking (its tokens live on the station)');
  }

  // ---- the boot veil: only the station's own words ----
  {
    const dots = { cls: 'boot-dots' };
    const line = { kids: [dots], querySelector: () => dots, appendChild(n) { this.kids = [n]; } };
    Object.defineProperty(line, 'textContent', { get() { return this._t; }, set(v) { this._t = v; this.kids = []; }, configurable: true });
    line.textContent = 'establishing local uplink'; line.kids = [dots];
    const document = { querySelector: s => (s === '#screen-boot .boot-line' ? line : null) };
    const normalizeProviderId = p => String(p || 'openrouter');
    const veil = new Function('document', 'normalizeProviderId', S.providerLabel + '\n' + S.bootVeilLine + '\nreturn bootVeilLine;')(document, normalizeProviderId);
    const answered = makeCache(); answered.accept([cliRow('checking')], answered.ticket());   // the row onPending hands it: readiness()
    veil(answered.read('claude-cli'));
    A.ok(line.textContent === 'checking CLAUDE CODE sign-in' && line.kids[0] === dots, 'while the station checks the sign-in the veil says exactly that (dots kept)');
    const silent = makeCache();
    A.eq(silent.read('claude-cli').credential.status, 'unknown', "(the cache's no-answer row reads 'unknown' too)");
    veil(silent.read('claude-cli'));
    A.eq(line.textContent, 'establishing local uplink', 'no answer from the station yet: the veil keeps "establishing local uplink", never a check it did not report');
    answered.offline();
    veil(answered.read('claude-cli'));
    A.eq(line.textContent, 'establishing local uplink', 'an answer kept from before the station went quiet is not a check running now');
  }

  // ---- RESUME says what the station reports ----
  {
    const normalizeProviderId = x => String(x || 'openrouter');
    const askOf = cache => new Function('Harness', 'normalizeProviderId', S.providerNeedsKey + '\n' + S.providerLabel + '\n' + S.resumeUnsettled + '\n' + S.resumeAskLine + '\nreturn resumeAskLine;')({ readiness: id => cache.read(id) }, normalizeProviderId);
    const settled = rows => { const c = makeCache(); c.accept(rows, c.ticket()); return c; };
    const NOT_YET = ' has not confirmed its connection yet — press RETRY AUTO-RESUME.';
    let ask = askOf(settled([cliRow('signedout'), keyRow('openai', false)]));
    A.eq(ask('openai'), 'Enter your key to continue.', 'a key provider whose key the station reports missing is asked for its key');
    A.eq(ask('claude-cli'), 'Reconnect CLAUDE CODE below to continue.', 'a signed-out Claude Code station is asked to reconnect Claude Code, never for a key');
    ask = askOf(settled([cliRow('ready'), keyRow('openai', true)]));
    A.eq(ask('claude-cli'), 'CLAUDE CODE is ready — press RETRY AUTO-RESUME.', 'an answer that landed READY after RESUME opened is said as ready (never "Reconnect")');
    A.eq(ask('openai'), 'OPENAI is ready — press RETRY AUTO-RESUME.', 'the same for a key provider');
    const silent = makeCache();
    ask = askOf(silent);
    A.eq(ask('claude-cli'), 'CLAUDE CODE' + NOT_YET, 'no answer from the station: not confirmed, for Claude Code');
    A.eq(ask('openai'), 'OPENAI' + NOT_YET, 'no answer from the station: not confirmed, for a key provider too (the station never said its key is missing)');
    const quiet = settled([cliRow('signedout'), keyRow('openai', false)]); quiet.offline();
    ask = askOf(quiet);
    A.eq(ask('claude-cli'), 'CLAUDE CODE' + NOT_YET, 'an answer kept from before the station went quiet: not confirmed');
    A.eq(ask('openai'), 'OPENAI' + NOT_YET, 'the same for a key provider');
    A.eq(askOf(settled([cliRow('checking')]))('claude-cli'), 'CLAUDE CODE' + NOT_YET, "the station still checking ('unknown'): not confirmed");
    A.eq(askOf(settled([cliRow('unavailable')]))('claude-cli'), 'CLAUDE CODE' + NOT_YET, "the station's own check timed out ('unavailable'): not confirmed");
    for (const state of ['checking', 'ready', 'signedout', 'unavailable']) {
      const c = settled([cliRow(state)].concat(['grok', 'kimi', 'ollama', 'custom', 'starnet'].map(id => keyRow(id, false))));
      for (const id of ['claude-cli', 'grok', 'kimi', 'ollama', 'custom', 'starnet']) A.ok(!/key/i.test(askOf(c)(id)), id + ' (' + state + '): RESUME never asks a keyless provider for a key');
    }
  }

  // ---- the Claude Code tile: an uncertain check is no "signed out" ----
  {
    const run = j => {
      const paints = [];
      const fn = new Function('claudeCliCall', 'paintClaudeCli', 'claudeCliWho', 'setTimeout',
        'let claudeCliSeq = 0, claudeCliState = null, claudeCliFlow = null, claudeCliTimer = null, pickedProvider = "claude-cli";\n' +
        'function stopClaudeCliTimer() {}\nfunction pollClaudeCli() {}\n' + S.refreshClaudeCliStatus + '\nreturn refreshClaudeCliStatus;')(
        async () => j, (mode, text) => paints.push(mode + ': ' + text), () => '', () => 0);
      return fn().then(() => paints[paints.length - 1]);
    };
    // the station's reply shapes (claude-cli-login.js publicStatus over claude-cli.js authStatus): error = message, code = error.code
    A.ok(/function notSignedIn\(\) \{[^}]*e\.code = 'provider_not_configured'/.test(cliHost) && /within 15s'\) \}\); \}, /.test(authSrc) && !/within 15s'\), \{ code/.test(authSrc),
      "(the station: signed out carries code 'provider_not_configured'; its timed-out check carries none)");
    A.ok(/^offline: .*didn.t answer its sign-in check/.test(await run({ installed: true, loggedIn: false, error: 'Claude Code did not answer `claude auth status` within 15s', code: '' })),
      "a check that timed out paints 'didn't answer — CHECK AGAIN', never 'sign in'");
    A.ok(/^offline: /.test(await run({ installed: true, loggedIn: false, error: 'Claude Code returned no usable local sign-in status', code: 'status_unavailable' })),
      'an unreadable status paints the same');
    A.ok(/^signedout: /.test(await run({ installed: true, loggedIn: false, error: 'Claude Code is installed but not signed in', code: 'provider_not_configured' })),
      'a real signed-out answer still asks to sign in');
    A.ok(/^connected: /.test(await run({ installed: true, loggedIn: true })), 'signed in paints connected');
    A.ok(/^missing: /.test(await run({ installed: false, loggedIn: false, error: 'not installed', code: 'provider_not_configured' })), 'not installed paints the install card');
  }

  // ---- ONE DOOR: RETRY / a restored backup and WAKE on the RESUME screen, against the shipped functions ----
  function world(o) {
    o = o || {};
    const c = clock();
    const log = [];
    const L = s => log.push('[' + c.elapsed() + '] ' + s);
    const st = { cli: o.cli || 'checking', latency: o.latency == null ? 5 : o.latency, asked: 0 };
    function fetch(url, init) {
      return new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        if (!/\/api\/providers$/.test(url)) return reject(new Error('unexpected fetch ' + url));
        st.asked++;
        c.setTimeout(() => {
          if (st.cli === 'offline') return reject(new TypeError('Failed to fetch'));
          resolve({ ok: true, json: async () => ({ providers: [cliRow(st.cli), codexRow()] }) });
        }, st.latency);
      });
    }
    const readinessCache = makeCache();
    if (o.boot) readinessCache.accept([cliRow(o.boot), codexRow()], readinessCache.ticket());
    let prov = 'claude-cli';
    const normalizeProviderId = p => String(p || 'openrouter');
    const getProv = () => prov;
    const H = new Function('readinessCache', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'Date', 'normalizeProviderId', 'getProv',
      '"use strict"; let readinessFlight = null, crewDefaultsMode = "off", cliEffortMode = "off";\n' +
      'function readiness(provider) { return readinessCache.read(normalizeProviderId(provider || getProv())); }\n' +
      S.refreshProviderReadiness + '\n' + S.readinessPending + '\n' + S.settleReadiness + '\n' +
      'return { readiness, refreshProviderReadiness, readinessPending, settleReadiness };'
    )(readinessCache, fetch, AbortController, c.setTimeout, c.clearTimeout, c.Date, normalizeProviderId, getProv);
    const Harness = {
      getKey: () => '', getProv, setProv: p => { prov = normalizeProviderId(p); }, configured: p => H.readiness(p).unattendedReady === true,
      readiness: H.readiness, refreshProviderReadiness: H.refreshProviderReadiness, settleReadiness: H.settleReadiness, readinessPending: H.readinessPending,
      setModel() {}, getModel: () => 'claude-sonnet-5-5', setReasoningEffort() {}, getReasoningEffort: () => 'medium',
      memoryReset: id => L('memoryReset(' + id + ')'), listModels: async () => [], resetTotals() {}
    };
    const els = {};
    function mk(id) {
      const cls = new Set(id === 'screen-boot' ? ['screen', 'active'] : /^screen-/.test(id) ? ['screen'] : []);
      return { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, readOnly: false, tabIndex: 0, dataset: {}, attrs: {},
        classList: { contains: k => cls.has(k), add: k => cls.add(k), remove: k => cls.delete(k), toggle: (k, on) => { if (on === undefined ? !cls.has(k) : on) cls.add(k); else cls.delete(k); } },
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, querySelector: () => null, appendChild() {}, focus() {} };
    }
    const el = id => (els[id] = els[id] || mk(id));
    const screens = ['screen-boot', 'screen-connect', 'screen-game', 'screen-future'];
    screens.forEach(el);
    const counts = { resumeInto: 0, newOverseer: 0, veilOverStation: 0 };
    let entered = false;
    const show = id => {
      screens.forEach(s => el(s).classList.remove('active')); el(id).classList.add('active'); L('show(' + id + ')');
      if (id === 'screen-boot' && entered) counts.veilOverStation++;
    };
    const veilLine = mk('boot-line');
    const document = { querySelector: q => (q === '#screen-boot .boot-line' ? veilLine : null) };
    const savedDoc = () => ({ agent: { id: 'agent', name: 'ULTRON', model: 'claude-sonnet-5-5', provider: 'claude-cli', onboarded: true }, prov: 'claude-cli' });
    const codexDoc = () => ({ agent: { id: 'agent', name: 'CYPHER', model: 'gpt-5.5', provider: 'codex', onboarded: true }, prov: 'codex' });
    let doc = savedDoc;
    let statusGate = null;
    const stubs = {
      Harness, el, document, show, setTimeout: c.setTimeout, Date: c.Date, normalizeProviderId,
      Save: { has: () => true, load: () => doc(), isFuture: () => false, loadStatus: () => ({ version: 0 }) },
      CloudSave: undefined, Dialogue: undefined, U: { esc: s => String(s) }, SFX: { click() {}, boot() {}, open() {} },
      stopCodexPoll() {}, stopStarnetLinkPoll() {}, stopStarnetBalancePoll() {}, migrateLegacyReasoning() {},
      savedStationProv: d => (d && d.agent && d.agent.provider) || (d && d.prov) || '',
      showFutureSaveGate: () => L('showFutureSaveGate'), startCreation: () => L('startCreation'),
      providerNeedsBaseUrl: () => false, isOAuthProviderId: () => false, providerSignupUrl: () => '', esc: s => s, codexConnected: false,
      refreshStarnetGenesisStatus: async () => null, defaultModelFor: () => '', updateHint() {}, refusedPageLine: () => '', warnStation() {},
      // WAKE's own GET /api/auth/claude-cli/status: a fresh `claude auth status` on the station, whose answer feeds the station
      refreshClaudeCliStatus: async () => {
        L('WAKE: claude auth status');
        if (o.statusGate) await new Promise(r => { statusGate = r; });
        st.cli = 'ready';
        return { installed: true, loggedIn: true };
      },
      saveWakeDraft() {}, clearWakeDraft() {},
      preflightWire: () => new Promise(r => c.setTimeout(() => { L('WAKE: the wire answered'); r({ ok: true }); }, o.preflightMs || 4000)),
      resumeInto: d => { counts.resumeInto++; entered = true; L('resumeInto(' + d.agent.name + ')'); show('screen-game'); },
      enterGame: () => { entered = true; L('enterGame: a NEW Overseer'); show('screen-game'); },
      persist: () => L('persist'),
      PermissionsStore: { reset: async () => { counts.newOverseer++; L('NEW-OVERSEER PATH: PermissionsStore.reset'); } },
      AutonomyStore: { reset: async () => ({ ok: true }) }, JourneyStore: { reset: async () => ({ ok: true }) }
    };
    const names = Object.keys(stubs);
    const App = new Function(...names,
      '"use strict";\n' +
      'let resumingSaved = null, waking = false, agent = null, prefilledKey = "", keyOverwriteConfirmed = false, pickedProvider = "claude-cli";\n' +
      'let doorSeq = 0, resumeWatch = 0;\n' +
      // the real initConnect's order: prefilledKey, applyRecoveryMode, the WAKE latch re-armed, then selectProviderUI picks the saved provider
      'function initConnect(n, r, a) { el("in-key").value = ""; prefilledKey = el("in-key").value || ""; el("in-model").value = (a && a.model) || ""; el("in-name").value = n || ""; applyRecoveryMode(!!r && !!a, a); waking = false; el("btn-wake").disabled = false; pickedProvider = Harness.getProv(); }\n' +
      [S.providerNeedsKey, S.providerLabel, S.resumeUnsettled, S.resumeAskLine, S.paintResumeBanner, S.watchResume, S.applyRecoveryMode,
        S.resumableSave, S.savedCanResume, S.bootVeilLine, S.reentry, S.onConnectBack, S.wakeBtnBusy, S.onWake, S.onWakeAttempt].join('\n') + '\n' +
      'return { reentry, onConnectBack, onWake, renderResume: d => { resumingSaved = d; show("screen-connect"); initConnect(d.agent.name, true, d.agent); }, pick: p => { pickedProvider = p; } };'
    )(...names.map(k => stubs[k]));
    return { App, c, st, log, counts, cache: readinessCache, el, savedDoc, useCodexBackup: () => { doc = codexDoc; }, release: () => statusGate && statusGate(),
      screen: () => screens.filter(s => el(s).classList.contains('active')).join(','), banner: () => el('cc-recovery').innerHTML };
  }
  const story = w => JSON.stringify(w.counts) + ' final ' + w.screen() + (w.c.errors.length ? ' ERRORS ' + w.c.errors.map(e => e.message).join('; ') : '') + '\n    ' + w.log.join('\n    ');
  const once = (w, what) => A.ok(w.counts.resumeInto === 1 && w.counts.newOverseer === 0 && w.counts.veilOverStation === 0 && w.screen() === 'screen-game' && !w.c.errors.length,
    what + ': the station opens exactly once, never under a new Overseer, never under a veil — ' + story(w));
  {
    // the review's case: WAKE (RESUME STATION) first, nothing visible while the station runs `claude auth status`, then RETRY
    for (const pre of ['checking', 'unavailable']) {
      const w = world({ boot: pre, cli: pre, statusGate: true });
      if (pre === 'unavailable') w.cache.offline();   // and the page's last read failed: the answer it holds is cached
      w.App.renderResume(w.savedDoc());
      w.App.onWake(); await w.c.advance(500);
      w.App.onConnectBack(); await w.c.advance(1500);
      w.release(); await w.c.advance(30000);
      once(w, 'WAKE, then RETRY while WAKE waits on the sign-in check (' + pre + ')');
    }
  }
  {
    const w = world({ boot: 'checking', cli: 'checking', statusGate: true });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); await w.c.advance(100); w.release(); await w.c.advance(900);   // WAKE's wire test is running
    w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY while WAKE tests the wire');
  }
  {
    const w = world({ boot: 'checking', cli: 'checking', statusGate: true, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); await w.c.advance(500);
    w.App.onConnectBack(); await w.c.advance(1700);
    w.release(); await w.c.advance(30000);
    once(w, 'WAKE with a fast wire test, RETRY waiting on the station');
  }
  {
    const w = world({ boot: 'checking', cli: 'checking' });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(300);
    w.App.onWake(); await w.c.advance(30000);   // WAKE pressed while RETRY's re-ask is still out
    once(w, 'RETRY, then WAKE before the veil');
  }
  {
    const w = world({ boot: 'checking', cli: 'checking', latency: 30 });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(10); w.App.onConnectBack();
    await w.c.advance(2500); w.st.cli = 'ready'; await w.c.advance(30000);
    once(w, 'RETRY pressed twice');
  }
  {
    const w = world({ boot: 'checking', cli: 'checking' });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); await w.c.advance(30000);
    once(w, '(control) WAKE alone');
    const v = world({ boot: 'checking', cli: 'checking' });
    v.App.renderResume(v.savedDoc());
    v.App.onConnectBack(); await v.c.advance(1500); v.st.cli = 'ready'; await v.c.advance(30000);
    once(v, '(control) RETRY alone');
  }
  {
    // a superseded re-entry never covers the station its successor opened: RETRY waits on Claude Code, then a restored codex backup enters
    const w = world({ boot: 'checking', cli: 'checking' });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(1200);
    A.ok(w.screen() === 'screen-boot', '(RETRY is waiting on the station behind the veil)');
    w.useCodexBackup(); w.App.reentry(); await w.c.advance(1800);
    const askedAtEntry = w.st.asked;
    w.st.cli = 'missing'; await w.c.advance(30000);
    once(w, 'RETRY waiting, then a restored backup enters');
    A.ok(w.st.asked - askedAtEntry <= 1, 'the superseded wait stops asking the station (' + (w.st.asked - askedAtEntry) + ' asks after the entry)');
  }
  {
    // RETRY re-asks, never re-reads (#76's rule): RESUME said "signed out", the Commander signed in elsewhere, then RETRY
    const w = world({ boot: 'missing', cli: 'ready' });
    w.App.renderResume(w.savedDoc());
    A.eq(w.st.asked, 0, '(a settled "signed out" RESUME asks nothing by itself)');
    w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY after the station turned ready behind a settled "signed out"');
  }
  {
    // the other order: RETRY first, WAKE pressed while RETRY's first question is still out (RESUME still on screen), and
    // WAKE enters first. The re-entry still waiting behind the veil must stand down, never open the station a second time.
    const w = world({ boot: 'checking', cli: 'checking', latency: 30, statusGate: true, preflightMs: 50 });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(10);
    A.ok(w.screen() === 'screen-connect', "(RETRY's first question is still out: RESUME is on screen) " + w.screen());
    w.App.onWake(); await w.c.advance(90);
    A.ok(w.screen() === 'screen-boot', '(RETRY waits on the station behind the veil) ' + w.screen());
    w.release(); await w.c.advance(300);
    A.ok(w.counts.resumeInto === 1, '(WAKE entered before RETRY asked again) ' + story(w));
    await w.c.advance(30000);
    once(w, 'RETRY waiting behind the veil, WAKE enters first');
  }

  // ---- RESUME keeps asking while the station has not settled ----
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable' });   // the station's first check ran past its own bound
    w.App.renderResume(w.savedDoc());
    A.ok(/CLAUDE CODE has not confirmed its connection yet/.test(w.banner()), 'RESUME opens saying the station has not confirmed — ' + w.banner());
    await w.c.advance(5000);
    A.ok(w.counts.resumeInto === 0 && w.st.asked >= 2, 'it keeps asking while the answer stays unsettled (' + w.st.asked + ' asks)');
    w.st.cli = 'ready';   // the screen's own tile check landed signed in, which feeds the station
    await w.c.advance(5000);
    once(w, 'an untouched RESUME whose station confirms later');
  }
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(3000);
    w.st.cli = 'missing'; await w.c.advance(4000);
    A.ok(w.banner().indexOf('Reconnect CLAUDE CODE below to continue.') >= 0 && w.counts.resumeInto === 0,
      'the banner follows the station: its later "signed out" answer replaces "not confirmed" — ' + w.banner());
    const asked = w.st.asked; await w.c.advance(10000);
    A.eq(w.st.asked, asked, 'a settled answer ends the asking');
  }
  for (const [what, touch] of [['a provider picked', w => w.App.pick('openrouter')], ['a key typed', w => { w.el('in-key').value = 'sk-typed'; }], ['WAKE pressed', null]]) {
    const w = world({ boot: 'unavailable', cli: 'unavailable', preflightMs: 999999 });
    w.App.renderResume(w.savedDoc());
    if (touch) touch(w); else w.App.onWake();
    await w.c.advance(1000); w.st.cli = 'ready'; await w.c.advance(20000);
    A.ok(w.counts.resumeInto === 0 && w.counts.newOverseer === 0, 'RESUME touched (' + what + ') never resumes by itself — ' + story(w));
  }
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(61000);
    const asked = w.st.asked; await w.c.advance(60000);
    A.ok(asked >= 25 && asked <= 32 && w.st.asked === asked, 'the asking is bounded: every 2s for 60s, then none (' + asked + ' asks)');
  }
  {
    const w = world({ boot: 'missing', cli: 'missing' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(20000);
    A.ok(w.st.asked === 0 && w.banner().indexOf('Reconnect CLAUDE CODE below to continue.') >= 0, 'a settled "signed out" RESUME waits for the Commander: no asking');
  }

  // ---- wiring: boot, re-entry and RESUME all go through these ----
  {
    const init = A.fnBody(app, '  async function init()');
    A.ok(init.length > 2000 && /const canResume = await savedCanResume\(\{ onPending: bootVeilLine \}\);/.test(init), 'boot decides through savedCanResume, the veil naming the wait');
    A.ok(/await Harness\.listModels\(\);\s*\n(\s*\/\/[^\n]*\n)*\s*if \(Harness\.configured && Harness\.configured\(\)\) \{ resumeInto\(saved\); return; \}/.test(init),
      'boot re-checks after the catalog load: an answer that landed READY meanwhile resumes instead of opening RESUME');
    A.ok(!/const canResume = !!\(Harness\.getKey\(\) \|\| \(Harness\.configured/.test(app), 'the one-shot boot rule is gone');
    A.ok(/const entered = await onWakeAttempt\(door\);/.test(S.onWake), 'WAKE carries its door ticket into the attempt');
    A.ok(/resumeUnsettled\(Harness\.readiness\(Harness\.getProv\(\)\)\)\) \{ const b = el\('btn-back'\); if \(b\) b\.focus\(\); \}/.test(A.fnBody(app, '  function initConnect(prefillName, isRecovery, savedAgent)')),
      'RESUME that says "press RETRY AUTO-RESUME" puts the focus on it');
    A.ok(/settleReadiness, readinessPending,/.test(hs), 'Harness exports settleReadiness');
  }

  // ---- the contract with the station ----
  {
    const pr = sidecarFunctionSource('providerReadiness');
    A.ok(/pending \? 'unknown'/.test(pr) && /pending \? 'checking local sign-in'/.test(pr), "the station's claude-cli answer while its check runs is credential 'unknown' (the word the page waits on)");
  }

  A.report('resume-verdict.test');
})().catch(e => { console.error(e); process.exitCode = 1; A.report('resume-verdict.test'); });
