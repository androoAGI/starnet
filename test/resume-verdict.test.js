/* node test/resume-verdict.test.js — a verdict the station is still working out is no "no" (11-17).
   A cold boot of the installed 0.15.2 opened a signed-in Claude Code station on RESUME, "Enter your key to continue":
   the page decided ONCE from Harness.configured() while the station still answered claude-cli with credential
   'unknown' ("checking local sign-in" — its first `claude auth status` had not returned). A minute later the same
   station said ready and RETRY AUTO-RESUME went straight in.
   Locks: Harness.settleReadiness waits out a pending answer (bounded, past the station's own bound) and returns a
   settled one at once; boot and every re-entry decide through ONE savedCanResume; the boot veil names only the check
   the station reports running; RESUME never asks a keyless provider for a key. The harness and page functions run
   from their shipped source against the real readiness cache and the station's real readiness projection. */
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

const pendingSrc = A.fnBody(hs, '  function readinessPending(provider)');
const settleSrc = A.fnBody(hs, '  async function settleReadiness(provider, opts)');
const canResumeSrc = A.fnBody(app, '  async function savedCanResume(opts)');
const veilSrc = A.fnBody(app, '  function bootVeilLine(row)');
const askSrc = A.fnBody(app, '  function resumeAskLine(provider)');
const needsKeySrc = A.fnBody(app, '  function providerNeedsKey(provider)');
const labelSrc = A.fnBody(app, '  function providerLabel(provider)');
const reentrySrc = A.fnBody(app, '  async function reentry()');
for (const [name, s] of Object.entries({ pendingSrc, settleSrc, canResumeSrc, veilSrc, askSrc, needsKeySrc, labelSrc, reentrySrc })) {
  A.ok(s.length > 40 && s.length < 4000, name + ' is sliced from its shipped source');
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

// One page: the real cache, the shipped readinessPending + settleReadiness, and a station that answers from a script.
function page(script, opts) {
  const o = opts || {};
  const cache = makeCache();
  const calls = { refresh: 0 };
  const answer = step => {
    if (step === 'offline') cache.offline();
    else cache.accept(Array.isArray(step) ? step : [step], cache.ticket());
  };
  if (o.boot !== undefined) answer(o.boot);   // what Harness.init()'s own read left in the cache
  const refreshProviderReadiness = async () => { calls.refresh++; answer(script.length ? script.shift() : 'offline'); };
  const readiness = id => cache.read(id);
  const H = new Function('readiness', 'refreshProviderReadiness', pendingSrc + '\n' + settleSrc + '\nreturn { readinessPending, settleReadiness };')(readiness, refreshProviderReadiness);
  return { cache, calls, readiness, H };
}

(async () => {
  // ---- the harness: settleReadiness ----
  {
    const p = page([cliRow('checking'), cliRow('ready')], { boot: cliRow('checking') });
    A.ok(p.H.readinessPending('claude-cli'), 'the station still checking Claude Code sign-in is PENDING, not a no');
    const seen = [];
    const row = await p.H.settleReadiness('claude-cli', { everyMs: 1, onPending: r => seen.push(r.credential.status + '/' + r.reason) });
    A.ok(row.unattendedReady === true, 'a check that lands signed in settles READY: the boot goes straight into the station');
    A.eq(p.calls.refresh, 2, 'it re-asked the station until the answer settled, and no more');
    A.eq(seen, ['unknown/checking local sign-in', 'unknown/checking local sign-in'], 'each wait names the check the station reports running');
  }
  {
    const p = page([cliRow('signedout'), cliRow('ready')], { boot: cliRow('checking') });
    const row = await p.H.settleReadiness('claude-cli', { everyMs: 1 });
    A.ok(row.unattendedReady === false && row.credential.status === 'missing', 'a check that lands signed OUT settles not-ready (RESUME is then the truth)');
    A.eq(p.calls.refresh, 1, 'a settled no stops the asking at once');
  }
  {
    const p = page([], { boot: cliRow('checking') });
    const script = []; for (let i = 0; i < 400; i++) script.push(cliRow('checking'));
    const q = page(script, { boot: cliRow('checking') });
    const t0 = Date.now();
    const row = await q.H.settleReadiness('claude-cli', { everyMs: 5, waitMs: 80 });
    A.ok(row.unattendedReady === false && row.credential.status === 'unknown', 'a check that never answers ends the wait still pending (bounded)');
    A.ok(Date.now() - t0 < 2000 && q.calls.refresh >= 2 && q.calls.refresh <= 20, 'the wait is bounded by waitMs (' + q.calls.refresh + ' asks)');
    A.eq(p.calls.refresh, 0, '(control) nothing asks the station before settleReadiness runs');
  }
  {
    const p = page([cliRow('ready')], { boot: cliRow('ready') });
    await p.H.settleReadiness('claude-cli', { everyMs: 1 });
    A.eq(p.calls.refresh, 0, 'a settled READY answer resolves at once, with no extra question');
    await p.H.settleReadiness('claude-cli', { everyMs: 1, reask: true });
    A.eq(p.calls.refresh, 1, 'reask: exactly one fresh question first (RETRY re-asks, never re-reads)');
  }
  {
    const p = page([cliRow('ready')]);   // the station has not answered at all yet
    A.ok(p.cache.read('claude-cli').cached === true && p.H.readinessPending('claude-cli'), 'no answer from the station yet is PENDING');
    const row = await p.H.settleReadiness('claude-cli', { everyMs: 1 });
    A.ok(row.unattendedReady === true && p.calls.refresh === 1, 'the first answer settles it');
  }
  {
    const p = page(['offline'], { boot: cliRow('ready') });
    await p.H.settleReadiness('claude-cli', { everyMs: 1, reask: true });
    A.ok(p.cache.read('claude-cli').cached === true && !p.H.readinessPending('claude-cli'),
      'an offline read keeps the last READY answer (cached) and does not wait on it');
  }
  {
    const p = page([], { boot: cliRow('unavailable') });
    const row = await p.H.settleReadiness('claude-cli', { everyMs: 1 });
    A.ok(row.credential.status === 'unavailable' && p.calls.refresh === 0, "the station's settled \"could not tell\" (its own bound ran out) returns at once");
  }
  {
    const p = page([keyRow('openai', false)], { boot: keyRow('openai', false) });
    const row = await p.H.settleReadiness('openai', { everyMs: 1 });
    A.ok(row.unattendedReady === false && p.calls.refresh === 0, 'a key provider with no key is a settled no: no wait');
  }

  // ---- the page: ONE resume decision for boot and re-entry ----
  function decide(p, prov, key) {
    let settled = 0;
    const Harness = {
      getKey: () => key || '', getProv: () => prov,
      configured: () => p.readiness(prov).unattendedReady === true,
      settleReadiness: (id, o) => { settled++; return p.H.settleReadiness(id, Object.assign({ everyMs: 1 }, o)); }
    };
    const fn = new Function('Harness', canResumeSrc + '\nreturn savedCanResume;')(Harness);
    return { run: o => fn(o), settled: () => settled, oldRule: () => !!(Harness.getKey() || Harness.configured() || Harness.getProv() === 'codex') };
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
    const p = page([], { boot: cliRow('checking') });
    const d = decide(p, 'openrouter', 'sk-or-key');
    A.ok(await d.run({}) === true && d.settled() === 0 && p.calls.refresh === 0, 'a key in hand resumes without asking the station');
    const c = decide(p, 'codex');
    A.ok(await c.run({}) === true && c.settled() === 0, 'codex resumes without asking (its tokens live on the station)');
  }

  // ---- the boot veil: only the station's own words ----
  {
    const dots = { cls: 'boot-dots' };
    const line = { textContent: 'establishing local uplink', kids: [dots], querySelector: () => dots, appendChild(n) { this.kids = [n]; } };
    Object.defineProperty(line, 'textContent', { get() { return this._t; }, set(v) { this._t = v; this.kids = []; }, configurable: true });
    line.textContent = 'establishing local uplink'; line.kids = [dots];
    const document = { querySelector: s => (s === '#screen-boot .boot-line' ? line : null) };
    const normalizeProviderId = p => String(p || 'openrouter');
    const veil = new Function('document', 'normalizeProviderId', labelSrc + '\n' + veilSrc + '\nreturn bootVeilLine;')(document, normalizeProviderId);
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

  // ---- RESUME asks for what the station reports missing ----
  {
    const p = page([], { boot: [cliRow('signedout'), keyRow('openai', false)] });
    const normalizeProviderId = x => String(x || 'openrouter');
    const Harness = { readiness: id => p.readiness(id) };
    const ask = new Function('Harness', 'normalizeProviderId', needsKeySrc + '\n' + labelSrc + '\n' + askSrc + '\nreturn resumeAskLine;')(Harness, normalizeProviderId);
    A.eq(ask('openai'), 'Enter your key to continue.', 'a key provider is still asked for its key');
    A.eq(ask('claude-cli'), 'Reconnect CLAUDE CODE below to continue.', 'a signed-out Claude Code station is asked to reconnect Claude Code, never for a key');
    for (const id of ['claude-cli', 'grok', 'kimi', 'ollama', 'custom', 'starnet']) A.ok(!/key/i.test(ask(id)), id + ': RESUME never asks a keyless provider for a key');
    const q = page([], { boot: cliRow('unavailable') });
    const ask2 = new Function('Harness', 'normalizeProviderId', needsKeySrc + '\n' + labelSrc + '\n' + askSrc + '\nreturn resumeAskLine;')({ readiness: id => q.readiness(id) }, normalizeProviderId);
    A.eq(ask2('claude-cli'), 'CLAUDE CODE has not confirmed its connection yet — press RETRY AUTO-RESUME.', 'an unsettled answer is said as unsettled, with the key that re-asks');
  }

  // ---- wiring: boot, re-entry and RESUME all go through these ----
  {
    const init = A.fnBody(app, '  async function init()');
    A.ok(init.length > 2000 && /const canResume = await savedCanResume\(\{ onPending: bootVeilLine \}\);/.test(init), 'boot decides through savedCanResume, the veil naming the wait');
    A.ok(!/const canResume = !!\(Harness\.getKey\(\) \|\| \(Harness\.configured/.test(app), 'the one-shot boot rule is gone');
    A.ok(/const ready = await savedCanResume\(\{ reask: true,/.test(reentrySrc) && /if \(seq !== reentrySeq\) return;/.test(reentrySrc) && !/Harness\.configured/.test(reentrySrc),
      're-entry (RETRY AUTO-RESUME, import, a kept station) re-asks through the same decision, and a newer re-entry wins');
    A.ok(/U\.esc\(resumeAskLine\(Harness\.getProv\(\)\)\)/.test(A.fnBody(app, '  function applyRecoveryMode(recovery, savedAgent)')), 'the RESUME banner says resumeAskLine');
    A.eq(app.split('Enter your key to continue.').length - 1, 1, '"Enter your key to continue." lives only in resumeAskLine, behind providerNeedsKey');
    A.ok(/settleReadiness, readinessPending,/.test(hs), 'Harness exports settleReadiness');
  }

  // ---- the contract with the station ----
  {
    const pr = sidecarFunctionSource('providerReadiness');
    A.ok(/pending \? 'unknown'/.test(pr) && /pending \? 'checking local sign-in'/.test(pr), "the station's claude-cli answer while its check runs is credential 'unknown' (the word the page waits on)");
    const auth = A.fnBody(cliHost, '    function authStatus()');
    const stationBound = Number((/\}, (\d+)\);\s*\n\s*try \{\s*\n\s*child = spawn\(cmd\.file, cmd\.pre\.concat\(\['auth', 'status'\]\)/.exec(auth) || [])[1]);
    const pageBound = Number((/o\.waitMs == null \? (\d+) :/.exec(settleSrc) || [])[1]);
    A.ok(stationBound > 0 && pageBound > stationBound, 'the page outwaits the station\'s own sign-in check bound (' + pageBound + ' ms > ' + stationBound + ' ms)');
  }

  A.report('resume-verdict.test');
})().catch(e => { console.error(e); process.exitCode = 1; A.report('resume-verdict.test'); });
