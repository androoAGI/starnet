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
  [app, 'refreshClaudeCliStatus', '  async function refreshClaudeCliStatus()'],
  [app, 'resumeReask', '  function resumeReask()'],
  // RESTORE BACKUP's two handlers (statements inside init(): the button, and the file it picks)
  [app, 'restoreClick', "    el('btn-import').onclick = () => {"],
  [app, 'restorePick', '    fileImport.onchange = async () => {'],
  [app, 'dataStatus', '    const dataStatus = m => {']
]) {
  const b = A.fnBody(src, header);
  A.ok(b.length > 40 && b.length < 40000, name + ' is sliced from its shipped source');
  S[name] = b;
}
// the keys RESUME's touch rule ignores (a one-line constant beside watchResume)
S.idleKeys = (app.match(/^  const RESUME_IDLE_KEYS = .*;$/m) || [''])[0];
A.ok(/Alt/.test(S.idleKeys), 'RESUME_IDLE_KEYS is sliced from its shipped source');

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
    // stop() turning true WHILE a question is out ends the wait as that answer lands: no further veil line, no further ask
    const p = page([], { boot: cliRow('checking'), station: () => cliRow('checking') });
    let heard = 0;
    const r = await within(p.c, p.H.settleReadiness('claude-cli', { stop: () => p.calls.refresh >= 1, onPending: () => { heard++; } }), 30000);
    A.ok(r.done && heard === 1 && p.calls.refresh === 1, 'a caller superseded mid-question hears nothing more and asks nothing more (' + heard + ' veil lines, ' + p.calls.refresh + ' asks)');
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
        'function stopClaudeCliTimer() {}\nfunction pollClaudeCli() {}\nfunction resumeReask() {}\n' + S.refreshClaudeCliStatus + '\nreturn refreshClaudeCliStatus;')(
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
    const delay = ms => new Promise(r => c.setTimeout(r, ms || 0));
    // the station: Claude Code in one of cliRow's states, codex signed in, and the managed / key / endpoint providers ready or not
    const st = { cli: o.cli || 'checking', latency: o.latency == null ? 5 : o.latency, asked: 0,
      ready: Object.assign({ starnet: false, openrouter: false, custom: false }, o.ready || {}) };
    const rows = cli => [cliRow(cli), codexRow()].concat(Object.keys(st.ready).map(id => keyRow(id, st.ready[id] === true)));
    function fetch(url, init) {
      return new Promise((resolve, reject) => {
        if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        if (!/\/api\/providers$/.test(url)) return reject(new Error('unexpected fetch ' + url));
        st.asked++;
        c.setTimeout(() => {
          if (st.cli === 'offline') return reject(new TypeError('Failed to fetch'));
          resolve({ ok: true, json: async () => ({ providers: rows(st.cli) }) });
        }, st.latency);
      });
    }
    const readinessCache = makeCache();
    if (o.boot) readinessCache.accept(rows(o.boot), readinessCache.ticket());
    // THE LIVE WIRE: what the next COMMS run goes out on (Harness.chat reads getModel()/getProv() at send time)
    let prov = o.prov || 'claude-cli', model = 'claude-sonnet-5-5';
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
      setModel: m => { model = m; }, getModel: () => model, setReasoningEffort() {}, getReasoningEffort: () => 'medium',
      memoryReset: id => L('memoryReset(' + id + ')'), listModels: async () => [], resetTotals() {},
      hasStoredCredential: p => H.readiness(p).credential.present === true,
      setBaseUrl: async p => { L('WAKE: endpoint saved'); await delay(o.endpointMs); st.ready.custom = true; return { engine: true }; },
      validateAndSetKey: async (k, p) => {
        L('WAKE: key saved for ' + p); await delay(o.keyMs);
        if (o.keyRejects) throw new Error('the key was refused');
        st.ready[p] = true; return { engine: true };
      },
      // RETRY on a StarNet station re-reads the link first (#76)
      refreshCreditsConfigured: async () => { L('RETRY: re-reading the StarNet link'); await delay(o.linkMs); await H.refreshProviderReadiness(); return H.readiness('starnet').unattendedReady === true; }
    };
    const els = {};
    function mk(id) {
      const cls = new Set(id === 'screen-boot' ? ['screen', 'active'] : /^screen-/.test(id) ? ['screen'] : []);
      const listeners = [];
      return { id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, readOnly: false, tabIndex: 0, dataset: {}, attrs: {}, open: false, listeners,
        classList: { contains: k => cls.has(k), add: k => cls.add(k), remove: k => cls.delete(k), toggle: (k, on) => { if (on === undefined ? !cls.has(k) : on) cls.add(k); else cls.delete(k); } },
        setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, querySelector: () => null, appendChild() {}, focus() {},
        addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); } };
    }
    const el = id => (els[id] = els[id] || mk(id));
    const screens = ['screen-boot', 'screen-connect', 'screen-game', 'screen-future'];
    screens.forEach(el);
    const counts = { resumeInto: 0, newOverseer: 0, veilOverStation: 0, wire: 0, imports: 0 };
    const entries = [];
    let entered = false;
    const show = id => {
      screens.forEach(s => el(s).classList.remove('active')); el(id).classList.add('active'); L('show(' + id + ')');
      if (id === 'screen-boot' && entered) counts.veilOverStation++;
    };
    const veilLine = mk('boot-line');
    const document = { querySelector: q => (q === '#screen-boot .boot-line' ? veilLine : null) };
    const saveOf = (name, provider, mdl) => ({ agent: { id: 'agent', name, model: mdl || 'claude-sonnet-5-5', provider: provider || 'claude-cli', onboarded: true }, prov: provider || 'claude-cli' });
    const savedDoc = () => saveOf('ULTRON');
    const codexDoc = () => saveOf('CYPHER', 'codex', 'gpt-5.5');
    let doc = o.doc || savedDoc;
    let statusGate = null;
    const status = { text: '' };
    // a backup file the Commander picks: RESTORE writes its save at once (applyBundle), then confirms autonomy and memories
    const backup = (name, provider, mdl) => ({ name: name.toLowerCase() + '.json', doc: () => saveOf(name, provider, mdl) });
    const fileImport = { files: [], value: '', click() { L('RESTORE: file chooser opened'); } };
    const stubs = {
      Harness, el, document, show, setTimeout: c.setTimeout, Date: c.Date, normalizeProviderId, fileImport,
      Save: { has: () => true, load: () => doc(), isFuture: () => false, loadStatus: () => ({ version: 0 }) },
      CloudSave: undefined, Dialogue: undefined, StationUI: undefined, U: { esc: s => String(s) }, SFX: { click() {}, boot() {}, open() {}, bad() {} },
      stopCodexPoll() {}, stopStarnetLinkPoll() {}, stopStarnetBalancePoll() {}, migrateLegacyReasoning() {},
      savedStationProv: d => (d && d.agent && d.agent.provider) || (d && d.prov) || '',
      showFutureSaveGate: () => L('showFutureSaveGate'), startCreation: () => L('startCreation'),
      providerNeedsBaseUrl: p => p === 'custom', isOAuthProviderId: () => false, providerSignupUrl: () => 'https://example.invalid', esc: s => s, codexConnected: false,
      defaultModelFor: () => '', updateHint() {}, refusedPageLine: () => '',
      // WAKE's StarNet credit read (GET /api/credits)
      refreshStarnetGenesisStatus: async () => {
        if (!o.credits) return null;
        L('WAKE: reading StarNet credits'); await delay(o.credits.ms);
        return { answered: true, linked: o.credits.linked !== false, balanceUsd: o.credits.balanceUsd == null ? 5 : o.credits.balanceUsd };
      },
      // WAKE's own GET /api/auth/claude-cli/status: a fresh `claude auth status` on the station, whose answer feeds the station
      refreshClaudeCliStatus: async () => {
        L('WAKE: claude auth status');
        if (o.statusGate) await new Promise(r => { statusGate = r; });
        st.cli = o.statusSays || 'ready';
        return { installed: true, loggedIn: st.cli === 'ready' };
      },
      saveWakeDraft() {}, clearWakeDraft() {},
      preflightWire: () => { counts.wire++; L('WAKE: one real call to ' + model); return new Promise(r => c.setTimeout(() => { L('WAKE: the wire answered'); r(o.wireFails ? { ok: false, why: 'the model did not answer' } : { ok: true }); }, o.preflightMs || 4000)); },
      // resumeInto writes the saved agent's wire (its provider, then its model), as the real one does
      resumeInto: d => {
        counts.resumeInto++; entered = true;
        Harness.setProv(stubs.savedStationProv(d)); Harness.setModel(d.agent.model);
        entries.push({ name: d.agent.name, prov, model }); L('resumeInto(' + d.agent.name + ' on ' + prov + ' / ' + model + ')'); show('screen-game');
      },
      enterGame: () => { entered = true; L('enterGame: a NEW Overseer'); show('screen-game'); },
      persist: () => L('persist'),
      PermissionsStore: { reset: async () => { counts.newOverseer++; L('NEW-OVERSEER PATH: PermissionsStore.reset'); } },
      AutonomyStore: { reset: async () => (o.autonomyFails ? { ok: false, error: 'the autonomy reset was not confirmed' } : { ok: true }) }, JourneyStore: { reset: async () => ({ ok: true }) },
      Backup: {
        importFile: async f => {
          counts.imports++; L('RESTORE: writing ' + f.name);
          if (!o.importFails && !o.importThrows) doc = f.doc;
          await delay(o.importMs);
          if (o.importThrows) throw new Error('the backup could not be parsed');
          return o.importFails ? { ok: false, error: 'file is not valid JSON' } : { ok: true, agentName: f.doc().agent.name, records: 3 };
        }
      },
      dataStatus: s => { status.text = s; L('data-status: ' + s); }
    };
    const names = Object.keys(stubs);
    const App = new Function(...names,
      '"use strict";\n' +
      'let resumingSaved = null, waking = false, agent = null, prefilledKey = "", keyOverwriteConfirmed = false, pickedProvider = "claude-cli", gateActive = false;\n' +
      'let doorSeq = 0, restoring = false, resumeWatch = 0, resumeTouchWired = false;\n' + S.idleKeys + '\n' +
      // the real initConnect's order: prefilledKey, applyRecoveryMode, the WAKE latch and label re-armed, then selectProviderUI picks the saved provider
      'function initConnect(n, r, a) { el("in-key").value = ""; prefilledKey = el("in-key").value || ""; el("in-model").value = (a && a.model) || ""; el("in-name").value = n || ""; applyRecoveryMode(!!r && !!a, a); waking = false; { const wb = el("btn-wake"); wb.disabled = false; delete wb.dataset.idleLabel; } pickedProvider = Harness.getProv(); }\n' +
      [S.providerNeedsKey, S.providerLabel, S.resumeUnsettled, S.resumeAskLine, S.paintResumeBanner, S.resumeReask, S.watchResume, S.applyRecoveryMode,
        S.resumableSave, S.savedCanResume, S.bootVeilLine, S.reentry, S.onConnectBack, S.wakeBtnBusy, S.onWake, S.onWakeAttempt].join('\n') + '\n' +
      S.restoreClick + ';\n' + S.restorePick + ';\n' +
      'return { reentry, onConnectBack, onWake, renderResume: d => { resumingSaved = d; show("screen-connect"); initConnect(d.agent.name, true, d.agent); },\n' +
      '  pick: p => { pickedProvider = p; }, restoreClick: () => el("btn-import").onclick(), restorePick: f => { fileImport.files = [f]; return fileImport.onchange(); },\n' +
      '  renderCreate: () => { resumingSaved = null; show("screen-connect"); initConnect("", false, null); },\n' +
      '  resumeReask, state: () => ({ waking, restoring }) };'
    )(...names.map(k => stubs[k]));
    // the Commander's own input on RESUME: a trusted event the screen hears (a script's synthetic one is untrusted)
    const touch = (type, trusted, key) => el('screen-connect').listeners.filter(l => l.type === type && l.capture).forEach(l => l.fn({ type, isTrusted: trusted !== false, key }));
    const errors = [];
    return { App, c, st, log, counts, entries, status, cache: readinessCache, el, touch, savedDoc, backup, errors, saved: () => doc(),
      useCodexBackup: () => { doc = codexDoc; }, useBackup: (n, p, m) => { doc = () => saveOf(n, p, m); }, release: () => statusGate && statusGate(),
      restore: f => { App.restorePick(f).catch(e => errors.push(e)); },
      wire: () => ({ prov, model }), wake: () => el('btn-wake'), msg: () => el('connect-msg').textContent,
      screen: () => screens.filter(s => el(s).classList.contains('active')).join(','), banner: () => el('cc-recovery').innerHTML };
  }
  const story = w => JSON.stringify(w.counts) + ' entered ' + JSON.stringify(w.entries) + ' wire ' + JSON.stringify(w.wire()) + ' final ' + w.screen()
    + ((w.c.errors.length || w.errors.length) ? ' ERRORS ' + w.c.errors.concat(w.errors).map(e => e.message).join('; ') : '') + '\n    ' + w.log.join('\n    ');
  // exactly one entry, of the expected save, never under a new Overseer or a veil, and the live wire is still the one that entry
  // set (nothing an overtaken attempt did afterwards rewrote the model or provider the next COMMS run goes out on)
  const once = (w, what, name) => {
    const e = w.entries[0] || {}, wire = w.wire();
    A.ok(w.counts.resumeInto === 1 && e.name === (name || 'ULTRON') && wire.prov === e.prov && wire.model === e.model
      && w.counts.newOverseer === 0 && w.counts.veilOverStation === 0 && w.screen() === 'screen-game' && !w.c.errors.length && !w.errors.length,
      what + ': the station opens exactly once (' + (name || 'ULTRON') + '), never under a new Overseer, never under a veil, on the wire it entered with — ' + story(w));
  };
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
    w.useCodexBackup(); w.App.reentry(); await w.c.advance(0);
    A.ok(w.counts.resumeInto === 1, '(the codex backup entered at once) ' + story(w));
    const askedAtEntry = w.st.asked;
    await w.c.advance(30000);   // the station still checking the whole time: only a wait that stopped asks nothing more
    once(w, 'RETRY waiting, then a restored backup enters', 'CYPHER');
    A.eq(w.st.asked - askedAtEntry, 0, 'the superseded wait stops asking the station the moment the backup entered');
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
  {
    // #10: two re-entries both waiting on the station, each holding a DIFFERENT save (RETRY on ULTRON, then a re-entry for a
    // restored NOVA). The station turns ready: only the newer one enters, with the newer save.
    const w = world({ boot: 'checking', cli: 'checking' });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(1200);
    w.useBackup('NOVA'); w.App.reentry(); await w.c.advance(1300);
    w.st.cli = 'ready'; await w.c.advance(30000);
    once(w, 'RETRY on ULTRON, then a re-entry for a restored NOVA, both waiting', 'NOVA');
  }
  for (const order of ['WAKE, then RETRY', 'RETRY, then WAKE']) {
    // #11: a StarNet station. RETRY re-reads the account link first (#76; ~3s here) while WAKE reads credits and tests the wire (~1s)
    const sol = () => ({ agent: { id: 'agent', name: 'SOL', model: 'starnet/claude-sonnet', provider: 'starnet', onboarded: true }, prov: 'starnet' });
    const w = world({ prov: 'starnet', boot: 'checking', cli: 'checking', ready: { starnet: true }, doc: sol, credits: { ms: 10 }, preflightMs: 1000, linkMs: 3000 });
    w.App.renderResume(w.saved());
    if (order === 'WAKE, then RETRY') { w.App.onWake(); await w.c.advance(500); w.App.onConnectBack(); }
    else { w.App.onConnectBack(); await w.c.advance(500); w.App.onWake(); }
    await w.c.advance(30000);
    once(w, 'a StarNet RESUME: ' + order + ' while the link is re-read', 'SOL');
  }
  {
    // #12: WAKE's sign-in check is quick, its readiness question to the station slow (1s); RETRY is pressed while that is out.
    // RETRY enters; the overtaken WAKE makes no wire call (one real model call) for a screen it no longer owns.
    const w = world({ boot: 'checking', cli: 'checking', latency: 1000 });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); await w.c.advance(100);
    w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY while WAKE waits on its readiness question');
    A.eq(w.counts.wire, 0, 'the overtaken WAKE made no wire call');
  }
  {
    // X5: WAKE (another model picked) waits on its sign-in check; RETRY re-asks, the station's answer is settled (it could not
    // tell), RESUME is re-rendered. The overtaken WAKE then stands down: no wire call, no WAKING… on the new screen's button,
    // nothing painted, no model written. (The re-rendered RESUME later resumes by itself once the station confirms.)
    const w = world({ boot: 'unavailable', cli: 'unavailable', statusGate: true });
    w.App.renderResume(w.savedDoc());
    w.el('in-model').value = 'claude-opus-5-5';
    w.App.onWake(); await w.c.advance(100);
    w.App.onConnectBack(); await w.c.advance(200);
    A.ok(w.screen() === 'screen-connect' && w.counts.resumeInto === 0, '(RETRY re-rendered RESUME on the settled answer) ' + story(w));
    w.release(); await w.c.advance(100);
    A.ok(w.counts.wire === 0 && !w.wake().disabled && !/WAKING/.test(w.wake().textContent) && !/testing the wire/.test(w.msg()) && w.wire().model === 'claude-sonnet-5-5',
      'an overtaken WAKE stands down as its sign-in answer lands: no wire call, the new RESUME untouched, the live model unchanged — ' + story(w));
    await w.c.advance(30000);
    once(w, 'X5, then the re-rendered RESUME resumes by itself');
  }
  {
    // #16: claude-opus-5-5 picked, RESUME STATION pressed; RETRY resumes the station (on its saved model) while WAKE's sign-in
    // check is out. WAKE's late answer must not switch the live model under the running station.
    const w = world({ boot: 'unavailable', cli: 'ready', statusGate: true });
    w.App.renderResume(w.savedDoc());
    w.el('in-model').value = 'claude-opus-5-5';
    w.App.onWake(); await w.c.advance(100);
    w.App.onConnectBack(); await w.c.advance(500);
    w.release(); await w.c.advance(30000);
    once(w, 'RETRY resumes while WAKE (another model picked) waits on its sign-in check');
  }
  {
    // #16, the provider: STARNET picked on the Claude Code RESUME, WAKE waits on the credit read; RETRY resumes Claude Code.
    // The late credit answer must not switch the live provider to StarNet (the next runs would bill managed credits).
    const w = world({ boot: 'unavailable', cli: 'ready', credits: { ms: 5700 } });
    w.App.renderResume(w.savedDoc());
    w.App.pick('starnet'); w.el('in-model').value = 'starnet/claude-sonnet';
    w.App.onWake(); await w.c.advance(1100);
    w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY resumes Claude Code while WAKE (StarNet picked) waits on the credit read');
  }
  for (const [what, o, setup] of [
    ['a custom endpoint', { endpointMs: 1000 }, w => { w.App.pick('custom'); w.el('in-base-url').value = 'http://127.0.0.1:11434/v1'; w.el('in-model').value = 'llama3'; }],
    ['a typed key', { keyMs: 1000 }, w => { w.App.pick('openrouter'); w.el('in-key').value = 'sk-or-typed'; w.el('in-model').value = 'openrouter/auto'; }]
  ]) {
    // #16, the key and endpoint saves: RETRY resumes while WAKE saves what the Commander typed; WAKE writes no model or provider after
    const w = world(Object.assign({ boot: 'unavailable', cli: 'ready' }, o));
    w.App.renderResume(w.savedDoc());
    setup(w);
    w.App.onWake(); await w.c.advance(100);
    w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY resumes while WAKE saves ' + what);
  }
  {
    // #18: WAKE #1 (StarNet picked) waits on the credit read; RETRY re-renders RESUME (Claude Code still not confirmed); WAKE #2
    // (Claude Code) tests its wire. WAKE #1's answer (not linked) lands meanwhile: it paints nothing on the new screen and leaves
    // WAKE #2's WAKING… alone (a second press would have run a second real wire call).
    const w = world({ boot: 'unavailable', cli: 'unavailable', credits: { ms: 6800, linked: false }, preflightMs: 10000 });
    w.App.renderResume(w.savedDoc());
    w.App.pick('starnet');
    w.App.onWake(); await w.c.advance(100);
    w.App.onConnectBack(); await w.c.advance(900);
    A.ok(w.screen() === 'screen-connect', '(RETRY re-rendered RESUME) ' + story(w));
    w.App.onWake(); await w.c.advance(6000);
    A.ok(/WAKING/.test(w.wake().textContent) && w.wake().disabled && !/StarNet/.test(w.msg()),
      "an overtaken WAKE's late answer paints nothing on the new RESUME and leaves the live WAKE's button alone — msg: " + w.msg() + ' / button: ' + w.wake().textContent);
    await w.c.advance(30000);
    once(w, 'an overtaken WAKE beside a live one');
    A.eq(w.counts.wire, 1, 'one wire call: the live WAKE only');
  }
  {
    // an overtaken WAKE whose typed key then fails to save says nothing on the RESUME that RETRY re-rendered
    const w = world({ boot: 'unavailable', cli: 'unavailable', keyMs: 1000, keyRejects: true });
    w.App.renderResume(w.savedDoc());
    w.App.pick('openrouter'); w.el('in-key').value = 'sk-or-typed'; w.el('in-model').value = 'openrouter/auto';
    w.App.onWake(); await w.c.advance(100);
    w.App.onConnectBack(); await w.c.advance(3000);
    A.ok(w.screen() === 'screen-connect' && !/could not start/.test(w.msg()) && w.counts.resumeInto === 0 && !w.c.errors.length,
      'an overtaken WAKE whose key save fails paints no error on the RESUME that RETRY re-rendered — msg: ' + w.msg() + ' ' + story(w));
  }

  {
    // a WAKE that ENTERED keeps the door: a bounce after its own entry (the create screen's new-Overseer path, its autonomy reset
    // unconfirmed) is still its own, and releases the latch so the Commander can WAKE again
    const w = world({ boot: 'ready', cli: 'ready', autonomyFails: true, preflightMs: 200 });
    w.App.renderCreate(); w.el('in-model').value = 'claude-sonnet-5-5';
    w.App.onWake(); await w.c.advance(5000);
    A.ok(w.counts.newOverseer === 1 && !w.App.state().waking && !w.wake().disabled && /autonomy reset was not confirmed/.test(w.msg()),
      'a bounce after the WAKE took the door releases its own latch — msg: ' + w.msg() + ' ' + story(w));
  }

  {
    // third review: RESUME STATION pressed while RETRY's question is out holds RETRY's own ticket. RETRY lands back on RESUME and
    // re-arms the button; the attempt still in flight stands down there, so a second press never runs beside it (it made two
    // real wire calls).
    const w = world({ boot: 'unavailable', cli: 'unavailable', latency: 2000, ready: { starnet: true }, credits: { ms: 5000 }, preflightMs: 10000 });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(100);
    w.App.pick('starnet'); w.el('in-model').value = 'starnet/claude-sonnet';
    w.App.onWake(); await w.c.advance(2900);
    A.ok(w.screen() === 'screen-connect' && !w.App.state().waking && !w.wake().disabled, '(RETRY landed back on RESUME and re-armed the button) ' + story(w));
    w.App.pick('starnet'); w.el('in-model').value = 'starnet/claude-sonnet';
    w.App.onWake(); await w.c.advance(60000);
    A.ok(w.counts.wire === 1 && w.entries.length === 1 && w.counts.newOverseer === 0 && !w.c.errors.length,
      'a WAKE pressed during RETRY\'s question stands down when RETRY re-renders RESUME: one wire call, one entry — ' + story(w));
  }
  {
    // a fast double press of RESUME STATION is one attempt (one real wire call)
    const w = world({ boot: 'unavailable', cli: 'ready', preflightMs: 500 });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); w.App.onWake(); await w.c.advance(100); w.App.onWake(); await w.c.advance(30000);
    once(w, 'RESUME STATION pressed three times');
    A.eq(w.counts.wire, 1, 'one wire call for a double press');
  }
  {
    // the Claude Code tile's re-ask is RESUME's only: nothing is asked on the create screen, or once the station has opened
    const w = world({ boot: 'ready', cli: 'ready' });
    w.App.renderCreate();
    const asked = w.st.asked; w.App.resumeReask(); await w.c.advance(1000);
    A.eq(w.st.asked, asked, 'the tile re-asks nothing on the create screen');
  }
  // the door's state starts closed-to-nobody: the shipped declarations, not this file's copy of them
  A.ok(/^  let doorSeq = 0, restoring = false;$/m.test(app) && /^  let resumeWatch = 0, resumeTouchWired = false;$/m.test(app),
    'doorSeq, restoring, resumeWatch and resumeTouchWired start at 0 / false in the shipped source');
  A.ok(/el\('btn-import'\)\.onclick = \(\) => \{ SFX\.click\(\); resumeWatch\+\+; fileImport\.value = ''; fileImport\.click\(\); \};/.test(app),
    'RESTORE BACKUP clears the file input before opening the chooser (the same file picked again still fires)');

  // ---- RESTORE BACKUP takes the door ----
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable', importMs: 300 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); await w.c.advance(500);
    w.st.cli = 'ready'; await w.c.advance(5000);
    A.ok(w.counts.resumeInto === 0, 'RESTORE BACKUP ends RESUME\'s own asking: the station confirming while the file chooser is open opens nothing — ' + story(w));
    w.restore(w.backup('NOVA')); await w.c.advance(30000);
    once(w, 'RESTORE BACKUP on RESUME', 'NOVA');
  }
  {
    // RETRY pressed, RESTORE BACKUP clicked while RETRY's first question is out (the chooser is modal: RETRY keeps waiting behind
    // it, under its veil). The restore takes the door as it starts writing; the station turns ready during the write.
    const w = world({ boot: 'checking', cli: 'checking', latency: 300, importMs: 2000 });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(100);
    w.App.restoreClick(); await w.c.advance(1400);
    A.ok(w.screen() === 'screen-boot', '(RETRY waits behind its veil while the chooser is open) ' + w.screen());
    w.restore(w.backup('NOVA')); await w.c.advance(500);
    w.st.cli = 'ready'; await w.c.advance(30000);
    once(w, 'RETRY waiting, then a RESTORE BACKUP that takes the door', 'NOVA');
  }
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable', importMs: 3000 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(500);
    w.App.onConnectBack(); w.st.cli = 'ready'; await w.c.advance(30000);
    once(w, 'RETRY pressed while a restore is being written', 'NOVA');
  }
  {
    const w = world({ boot: 'unavailable', cli: 'ready', importMs: 3000, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(500);
    w.App.onWake(); await w.c.advance(30000);
    once(w, 'RESUME STATION pressed while a restore is being written', 'NOVA');
    A.eq(w.counts.wire, 0, 'the held WAKE made no wire call');
  }
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable', statusGate: true, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); await w.c.advance(100);
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(100);
    A.ok(w.counts.imports === 0 && /still connecting/.test(w.status.text), 'RESTORE BACKUP beside a WAKE still connecting is refused, and says why — ' + w.status.text);
    w.release(); await w.c.advance(30000);
    once(w, 'RESTORE BACKUP refused beside a WAKE');
  }
  {
    // RETRY pressed, RESTORE BACKUP clicked while its question is out; RETRY enters while the chooser is still open. The file picked
    // afterwards restores nothing under the running station and opens nothing a second time.
    const w = world({ boot: 'checking', cli: 'ready', latency: 300 });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(100);
    w.App.restoreClick(); await w.c.advance(1000);
    A.ok(w.counts.resumeInto === 1, '(RETRY entered while the chooser was open) ' + story(w));
    w.restore(w.backup('NOVA')); await w.c.advance(30000);
    once(w, 'a file picked after the station opened');
    A.eq(w.counts.imports, 0, 'nothing is restored under a running station');
  }
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable', importFails: true, importMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.st.cli = 'ready'; await w.c.advance(100);
    const asked = w.st.asked;
    w.restore(w.backup('NOVA')); await w.c.advance(30000);
    A.ok(w.counts.resumeInto === 0 && w.screen() === 'screen-connect' && w.st.asked === asked && /import failed/.test(w.status.text) && !w.App.state().restoring,
      'a restore that fails on RESUME stays on RESUME: nothing opens by itself, nothing is re-asked — ' + w.status.text + ' ' + story(w));
    w.App.onWake(); await w.c.advance(30000);
    once(w, 'RESUME STATION after a failed restore');
  }
  {
    // the restore took the door from a RETRY waiting under its veil, then failed: the screen is settled as that RETRY would have
    const w = world({ boot: 'checking', cli: 'checking', latency: 300, importFails: true, importMs: 500 });
    w.App.renderResume(w.savedDoc());
    w.App.onConnectBack(); await w.c.advance(100);
    w.App.restoreClick(); await w.c.advance(900);
    w.restore(w.backup('NOVA')); await w.c.advance(200);
    w.st.cli = 'missing'; await w.c.advance(30000);
    A.ok(w.screen() === 'screen-connect' && w.counts.resumeInto === 0 && /Reconnect CLAUDE CODE/.test(w.banner()),
      'a failed restore that overtook a RETRY never leaves the veil up: RESUME again, on the station\'s answer — ' + w.banner() + ' ' + story(w));
  }
  {
    const w = world({ boot: 'unavailable', cli: 'ready', importThrows: true, importMs: 100, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(500);
    A.ok(/import failed — the backup could not be parsed/.test(w.status.text) && !w.App.state().restoring && !w.errors.length,
      'a restore that throws says so and releases RESUME — ' + w.status.text + ' ' + story(w));
    w.App.onWake(); await w.c.advance(30000);
    once(w, 'RESUME STATION after a restore that threw');
  }
  {
    // the prior-install gate has its own RESTORE BACKUP (the same file input): a restore that fails there stays on the gate
    const w = world({ boot: 'ready', cli: 'ready', importFails: true });
    w.el('screen-boot').classList.remove('active'); w.el('screen-future').classList.add('active');
    const asked = w.st.asked;
    w.restore(w.backup('NOVA')); await w.c.advance(30000);
    A.ok(w.screen() === 'screen-future' && w.counts.resumeInto === 0 && w.st.asked === asked, 'a restore that fails on a gate screen stays on that gate — ' + story(w));
  }
  {
    // third review: a second backup picked while the first is still being written is not started (two restores opened the
    // station twice, and the first to finish released WAKE and RETRY under the second)
    const w = world({ boot: 'unavailable', cli: 'ready', importMs: 3000 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(500);
    w.App.restoreClick(); w.restore(w.backup('CYPHER')); await w.c.advance(100);
    A.ok(w.counts.imports === 1 && /still being restored/.test(w.status.text) && w.App.state().restoring,
      'a second backup picked during a restore is not started, and says why — ' + w.status.text + ' ' + story(w));
    await w.c.advance(30000);
    once(w, 'two backups picked one after the other', 'NOVA');
    A.ok(!w.App.state().restoring, 'the restore releases WAKE and RETRY once it has re-entered');
  }
  {
    // ...and one picked while the first restore's RE-ENTRY is still asking the station (its success line already written) is
    // refused too; once that restore is done the status says what it restored again, never "still being restored"
    const w = world({ boot: 'unavailable', cli: 'ready', importMs: 200, latency: 3000 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(1000);
    A.ok(/^restored NOVA — 3 records/.test(w.status.text) && w.App.state().restoring, '(the first restore is written; its re-entry is asking) ' + w.status.text);
    w.App.restoreClick(); w.restore(w.backup('CYPHER')); await w.c.advance(100);
    A.ok(w.counts.imports === 1 && /still being restored/.test(w.status.text), 'a second backup picked during the re-entry is not started — ' + w.status.text);
    await w.c.advance(30000);
    once(w, "a second backup picked during the first restore's re-entry", 'NOVA');
    A.ok(/^restored NOVA — 3 records/.test(w.status.text) && !w.App.state().restoring,
      'once the restore is done the status says what it restored again — ' + w.status.text);
  }
  {
    // the status line of a restore: #data-status always; on the prior-install gate (where #data-status is hidden) the gate's
    // own status line too, so a refused or failed restore there is never only a beep
    const nodes = {};
    const mk = () => ({ textContent: '', on: false, classList: { contains() { return this.o.on; }, o: null } });
    const el = id => { if (!nodes[id]) { nodes[id] = mk(); nodes[id].classList.o = nodes[id]; } return nodes[id]; };
    const dataStatus = new Function('el', S.dataStatus + '; return dataStatus;')(el);
    el('lineage-status').textContent = 'inspect or restore the prior state';
    dataStatus('import failed — file is not valid JSON');
    A.ok(el('data-status').textContent === 'import failed — file is not valid JSON' && el('lineage-status').textContent === 'inspect or restore the prior state',
      'off the gate a restore line goes to #data-status only');
    el('screen-lineage').on = true;
    dataStatus('import failed — file is not valid JSON');
    A.eq(el('lineage-status').textContent, 'import failed — file is not valid JSON', 'on the prior-install gate the restore line also shows on the gate');
    dataStatus('');
    A.ok(el('data-status').textContent === '' && el('lineage-status').textContent === 'import failed — file is not valid JSON', 'a cleared line never blanks the gate');
  }
  {
    // third review: the restore holds WAKE and RETRY through its own re-entry's question to the station, not only the import.
    // RESUME STATION pressed while that question is out would have resumed the save the restore just replaced.
    const w = world({ boot: 'unavailable', cli: 'ready', importMs: 200, latency: 3000, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(1000);
    A.ok(w.counts.resumeInto === 0 && w.App.state().restoring, "(the restore's re-entry is asking the station) " + story(w));
    w.App.onWake(); w.App.onConnectBack(); await w.c.advance(30000);
    once(w, "RESUME STATION and RETRY pressed during the restore's re-entry", 'NOVA');
    A.eq(w.counts.wire, 0, 'the held WAKE made no wire call');
    A.ok(!w.App.state().restoring, 'the restore releases WAKE and RETRY once it has re-entered');
  }
  {
    // ...and a restore whose re-entry lands on RESUME (the station says signed out) releases them there
    const w = world({ boot: 'unavailable', cli: 'missing', importMs: 200, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.restoreClick(); w.restore(w.backup('NOVA')); await w.c.advance(30000);
    A.ok(w.screen() === 'screen-connect' && w.counts.resumeInto === 0 && !w.App.state().restoring && /RESUMING <b>NOVA/.test(w.banner()),
      'a restore whose re-entry lands on RESUME shows the restored agent and releases WAKE and RETRY — ' + w.banner() + ' ' + story(w));
    w.st.cli = 'ready'; w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY after a restore that landed on RESUME', 'NOVA');
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
  // #15: ANY touch of the screen is a touch — the Commander's own clicks, keys and edits (the model catalog lives inside RESUME)
  for (const [type, what] of [['pointerdown', 'a click: the model catalog opened, a tile chosen'], ['input', 'a model or key typed'], ['keydown', 'a key pressed'], ['change', 'a choice changed']]) {
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(500); w.touch(type);
    await w.c.advance(500); w.st.cli = 'ready'; await w.c.advance(70000);
    A.ok(w.counts.resumeInto === 0, 'RESUME touched (' + what + ') never resumes by itself — ' + story(w));
  }
  {
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(500); ['pointerdown', 'input', 'keydown', 'change'].forEach(t => w.touch(t, false));
    await w.c.advance(500); w.st.cli = 'ready'; await w.c.advance(20000);
    once(w, "a script's own synthetic events are no touch: an untouched RESUME still resumes");
  }
  for (const key of ['Alt', 'Meta', 'Shift', 'Control', 'OS', 'CapsLock', 'PrintScreen']) {
    // third review: a modifier key on its own (Alt on the way to another window, a screenshot chord) is not using the screen
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(500); w.touch('keydown', true, key);
    await w.c.advance(500); w.st.cli = 'ready'; await w.c.advance(20000);
    once(w, 'a lone ' + key + ' key is no touch: RESUME still resumes by itself');
  }
  for (const key of ['a', 'Tab', 'Enter', 'Escape', ' ', 'ArrowDown']) {
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(500); w.touch('keydown', true, key);
    await w.c.advance(500); w.st.cli = 'ready'; await w.c.advance(70000);
    A.ok(w.counts.resumeInto === 0, 'RESUME touched (the ' + JSON.stringify(key) + ' key) never resumes by itself — ' + story(w));
  }
  {
    // third review: a WAKE that bounced has already switched the station to the provider it tried. The banner still speaks for
    // the SAVED provider, the one RETRY AUTO-RESUME resumes (it said "OPENROUTER is ready — press RETRY AUTO-RESUME").
    const w = world({ boot: 'missing', cli: 'missing', wireFails: true, preflightMs: 200 });
    w.App.renderResume(w.savedDoc());
    w.App.pick('openrouter'); w.el('in-key').value = 'sk-or-typed'; w.el('in-model').value = 'openrouter/auto';
    w.App.onWake(); await w.c.advance(5000);
    A.ok(w.wire().prov === 'openrouter' && w.counts.wire === 1 && !w.App.state().waking && w.counts.resumeInto === 0, '(the WAKE tried OpenRouter and bounced on its wire test) ' + story(w));
    A.ok(/Reconnect CLAUDE CODE below to continue/.test(w.banner()) && !/OPENROUTER/i.test(w.banner()),
      'after a WAKE bounce the banner speaks for the saved provider (the one RETRY resumes), not the one WAKE tried — ' + w.banner());
    w.st.cli = 'ready'; w.App.resumeReask(); await w.c.advance(1000);
    A.ok(/CLAUDE CODE is ready — press RETRY AUTO-RESUME/.test(w.banner()), "and the tile's answer re-paints it for the saved provider — " + w.banner());
    w.App.onConnectBack(); await w.c.advance(30000);
    once(w, 'RETRY after a bounced WAKE on another provider');
  }
  {
    // #15: the model catalog open (a modal inside RESUME): RESUME never resumes under it
    const w = world({ boot: 'unavailable', cli: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    w.el('ov-model-dialog').open = true;
    await w.c.advance(1000); w.st.cli = 'ready'; await w.c.advance(20000);
    A.ok(w.counts.resumeInto === 0, 'RESUME never resumes by itself while the model catalog is open — ' + story(w));
  }
  {
    // #14: the touch lands while the watch's own question is out (1.5s): the READY answer it brings back resumes nothing
    const w = world({ boot: 'unavailable', cli: 'unavailable', latency: 1500 });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(2500);   // the watch asked at 2s; its answer lands at 3.5s
    w.st.cli = 'ready'; w.App.pick('openrouter');
    await w.c.advance(30000);
    A.ok(w.counts.resumeInto === 0, "a provider picked while the watch's question is out: the READY answer it brings back resumes nothing — " + story(w));
  }
  {
    // a WAKE that bounced (the station could not tell) ends RESUME's own asking too: the Commander is at the controls
    const w = world({ boot: 'unavailable', cli: 'unavailable', statusSays: 'unavailable' });
    w.App.renderResume(w.savedDoc());
    await w.c.advance(500); w.App.onWake(); await w.c.advance(1000);
    A.ok(!w.App.state().waking && /check this connection before WAKE/.test(w.msg()), '(the WAKE bounced on the unsettled answer) ' + w.msg());
    w.st.cli = 'ready'; await w.c.advance(70000);
    A.ok(w.counts.resumeInto === 0, "a WAKE that bounced ends RESUME's own asking — " + story(w));
  }
  {
    // #17: the banner follows every answer on this screen, not only the watch's: WAKE's own check lands signed OUT
    const w = world({ boot: 'unavailable', cli: 'unavailable', statusSays: 'missing' });
    w.App.renderResume(w.savedDoc());
    w.App.onWake(); await w.c.advance(1000);
    A.ok(/Reconnect CLAUDE CODE below to continue/.test(w.banner()), 'a WAKE whose own check says signed out re-paints the banner (never "has not confirmed" beside "not signed in") — ' + w.banner());
  }
  {
    // #17: the Claude Code tile's own answer (SIGN IN WITH CLAUDE completed, CHECK AGAIN) re-asks the station and re-paints the
    // banner: never "Reconnect" or "has not confirmed" beside a tile that says signed in
    const w = world({ boot: 'missing', cli: 'missing' });
    w.App.renderResume(w.savedDoc());
    A.ok(/Reconnect CLAUDE CODE/.test(w.banner()), '(RESUME opened on a settled "signed out")');
    w.st.cli = 'ready'; w.App.resumeReask(); await w.c.advance(100);
    A.ok(/CLAUDE CODE is ready — press RETRY AUTO-RESUME/.test(w.banner()) && w.counts.resumeInto === 0,
      "the tile's answer re-paints the banner from the station (and opens nothing by itself) — " + w.banner());
    A.ok(/claudeCliState = j;\s*resumeReask\(\);/.test(S.refreshClaudeCliStatus) && /resumeReask\(\);\s*\}$/.test(A.fnBody(app, '  function onClaudeCliConnected(j)')),
      'the tile re-asks after every status it reads, and after a sign-in completes');
    const v = world({ boot: 'missing', cli: 'ready' });
    const asked = v.st.asked; v.App.resumeReask(); await v.c.advance(100);
    A.eq(v.st.asked, asked, 'off RESUME the tile asks the station nothing extra');
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
