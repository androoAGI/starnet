/* node test/updatecore.test.js
   Locks the autonomous desktop update goal/loop planner: due checks, no busy
   overlap, retry backoff, notification de-dupe, remind-later, skip-version, and
   progress math. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const U = require('../frontend/app/updatecore.js');
const fs = require('fs');
const path = require('path');

const HOUR = 60 * 60 * 1000;
const now = 1_000_000;

// ---- hydrate: safe defaults, malformed input tolerated ----
{
  const s = U.hydrateSettings(null);
  A.eq(s.autoCheck, true, 'auto-check defaults on');
  A.eq(s.nextCheckAt, 0, 'fresh loop is due immediately');
  const bad = U.hydrateSettings({ autoCheck: false, lastCheckAt: -1, failureCount: -8, ignoredVersion: 9 });
  A.eq(bad.autoCheck, false, 'explicit auto-check off is preserved');
  A.eq(bad.lastCheckAt, 0, 'negative timestamps clamp to zero');
  A.eq(bad.failureCount, 0, 'negative failure counts clamp to zero');
  A.eq(bad.ignoredVersion, '', 'non-string ignored version is dropped');
}

// ---- nextAction: desktop/due/busy gates ----
{
  A.eq(U.nextAction({ settings: {}, runtime: { desktop: false }, now }).reason, 'not-desktop', 'browser preview does not check');
  A.eq(U.nextAction({ settings: { autoCheck: false }, runtime: { desktop: true }, now }).reason, 'auto-disabled', 'disabled auto-check stays quiet');
  A.eq(U.nextAction({ settings: {}, runtime: { desktop: true, phase: 'checking' }, now }).reason, 'busy', 'checking never overlaps');
  A.eq(U.nextAction({ settings: { nextCheckAt: now + HOUR }, runtime: { desktop: true, phase: 'idle' }, now }).reason, 'waiting-interval', 'future check waits');
  A.eq(U.nextAction({ settings: { nextCheckAt: now }, runtime: { desktop: true, phase: 'idle' }, now }).action, 'check', 'due desktop loop checks');
}

// ---- successful checks schedule the next steady-state check ----
{
  const s = U.recordCheckResult({}, { checkedAt: now, update: null }, now);
  A.eq(s.lastCheckAt, now, 'success records last check');
  A.eq(s.nextCheckAt, now + U.CHECK_INTERVAL_MS, 'success schedules the steady check interval');
  A.eq(s.failureCount, 0, 'success clears failures');
}

// ---- errors back off exponentially but cap ----
{
  let s = U.recordCheckError({}, now);
  A.eq(s.nextCheckAt, now + U.RETRY_BASE_MS, 'first failure retries at base delay');
  s = U.recordCheckError(s, now);
  A.eq(s.nextCheckAt, now + U.RETRY_BASE_MS * 2, 'second failure doubles delay');
  for (let i = 0; i < 20; i++) s = U.recordCheckError(s, now);
  A.eq(s.nextCheckAt, now + U.RETRY_MAX_MS, 'retry delay caps');
}

// A remembered update may bypass the steady interval, never a failed-check retry deadline.
{
  let s = U.recordCheckResult({}, { update: { version: '0.13.2' } }, now);
  const runtime = { desktop: true, phase: 'error', hasUpdate: false, currentVersion: '0.13.1' };
  for (let attempt = 1; attempt <= 7; attempt++) {
    s = U.recordCheckError(s, now);
    const waiting = U.nextAction({ settings: s, runtime, now: s.nextCheckAt - 1 });
    A.eq(waiting.action, 'noop', 'known update respects retry deadline on failure ' + attempt);
    A.eq(waiting.nextAt, s.nextCheckAt, 'retry preserves exponential deadline ' + attempt);
    A.eq(U.nextAction({ settings: s, runtime, now: s.nextCheckAt }).action, 'check', 'retry resumes exactly at deadline ' + attempt);
  }
  A.eq(U.nextAction({ settings: U.hydrateSettings(JSON.parse(JSON.stringify(s))), runtime: { ...runtime, phase: 'idle' }, now }).action,
    'noop', 'restart preserves failed-check backoff');
  s = U.recordCheckResult(s, { update: { version: '0.13.2' } }, now);
  A.eq(U.nextAction({ settings: s, runtime, now }).reason, 'known-update', 'successful checks permit immediate rearming again');
}

// ---- notification loop: once per version, critical bypasses skips/reminders ----
{
  let s = U.hydrateSettings(null);
  A.ok(U.shouldNotify(s, '0.2.0', now), 'new version notifies');
  s = U.recordNotified(s, '0.2.0');
  A.ok(!U.shouldNotify(s, '0.2.0', now), 'same version does not notify twice');
  A.ok(U.shouldNotify(s, '0.2.1', now), 'a newer version notifies');
  s = U.ignoreVersion(s, '0.2.1');
  A.ok(!U.shouldNotify(s, '0.2.1', now), 'ignored version stays quiet');
  A.ok(U.shouldNotify(s, '0.2.1', now, true), 'critical update bypasses a skip');
}

// ---- remind-later suppresses until its deadline, then permits a fresh nudge ----
{
  let s = U.remindLater({}, '0.3.0', now, HOUR);
  A.ok(!U.shouldNotify(s, '0.3.0', now + HOUR - 1), 'remind-later suppresses before deadline');
  A.ok(U.shouldNotify(s, '0.3.0', now + HOUR + 1), 'same version can remind again after the deadline');
  A.ok(U.shouldNotify(s, '0.3.1', now + HOUR + 1), 'new version still notifies after reminder');
}

// ---- progress: unknown length and clamps ----
{
  A.eq(U.progress(50, 0), 0, 'unknown content length reports 0 percent');
  A.eq(U.progress(50, 200), 25, 'progress computes percent');
  A.eq(U.progress(250, 200), 100, 'progress clamps at 100');
}

// ---- GB-4 install guard: never kill live runs as a click side effect ----
{
  A.eq(U.installBlockReason(0, false), null, 'no live runs installs freely');
  A.ok(/1 agent is still working/.test(U.installBlockReason(1, false)), 'one live run blocks with the singular reason');
  A.ok(/3 agents are still working/.test(U.installBlockReason(3, false)), 'many live runs block with the count');
  A.eq(U.installBlockReason(3, true), null, 'force (the explicit INSTALL ANYWAY click) bypasses the guard');
  A.eq(U.installBlockReason(-2, false), null, 'negative/garbage count never blocks');
  A.ok(/2 agents/.test(U.installBlockReason('2', false) || ''), 'numeric-string count still guards');
}

// ---- a found update survives a restart: the next launch re-arms it instead of waiting out the interval ----
// (0.13.1 → 0.13.2 report: the toast fires once per version and the native pending update lives only in memory,
//  so a restart inside CHECK_INTERVAL_MS showed "no update" while the station already knew one existed.)
{
  let s = U.recordCheckResult({}, { checkedAt: now, update: { version: '0.13.2' } }, now);
  A.eq(s.availableVersion, '0.13.2', 'a check that finds an update remembers its version');
  s = U.recordNotified(s, '0.13.2');
  const later = now + HOUR;   // well inside the 6h interval
  const a = U.nextAction({ settings: s, runtime: { desktop: true, phase: 'idle', hasUpdate: false, currentVersion: '0.13.1' }, now: later });
  A.eq(a.action, 'check', 'a relaunch that knows of a newer version checks at once');
  A.eq(a.reason, 'known-update', 'the reason names the remembered update');
  A.eq(U.nextAction({ settings: s, runtime: { desktop: true, phase: 'available', hasUpdate: true, currentVersion: '0.13.1' }, now: later }).reason,
    'waiting-interval', 'once re-armed, the steady interval resumes');
  A.eq(U.nextAction({ settings: s, runtime: { desktop: true, phase: 'idle', hasUpdate: false, currentVersion: '0.13.2' }, now: later }).reason,
    'waiting-interval', 'after the update landed, the remembered version is the running one: no forced check');
  A.eq(U.nextAction({ settings: U.ignoreVersion(s, '0.13.2'), runtime: { desktop: true, phase: 'idle', currentVersion: '0.13.1' }, now: later }).reason,
    'waiting-interval', 'a skipped version never forces a check');
  A.eq(U.nextAction({ settings: Object.assign({}, s, { autoCheck: false }), runtime: { desktop: true, phase: 'idle', currentVersion: '0.13.1' }, now: later }).reason,
    'auto-disabled', 'AUTO-CHECK off still means no automatic request');
  s = U.recordCheckResult(s, { checkedAt: later, update: null }, later);
  A.eq(s.availableVersion, '', 'a check that finds nothing forgets the version');
  A.eq(U.hydrateSettings({ availableVersion: 7 }).availableVersion, '', 'a non-string remembered version is dropped');
}

// ---- opening the Update Center re-checks unless this launch checked recently ----
{
  A.ok(U.shouldCheckOnOpen(0, now), 'no check yet this launch: opening checks');
  A.ok(!U.shouldCheckOnOpen(now, now + U.OPEN_RECHECK_MS - 1), 'a fresh check this launch is reused');
  A.ok(U.shouldCheckOnOpen(now, now + U.OPEN_RECHECK_MS), 'a stale answer is re-checked');
}

// ---- public privacy claims follow the real first-run default and plaintext OAuth inventory ----
{
  const ROOT = path.resolve(__dirname, '..');
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const docs = [
    ['PRIVACY.md', read('PRIVACY.md')],
    ['website privacy', read('website/legal/privacy.html')],
    ['website no-credits privacy', read('website/legal/_privacy.nocredits.html')]
  ];
  const sidecar = readSidecarSource();

  A.ok(/const OAUTH_PROVIDER_IDS = \['grok', 'kimi'\]/.test(sidecar), 'runtime owns Grok and Kimi OAuth stores');
  A.ok(/path\.join\(WORKSPACES, id, 'tokens\.json'\)/.test(sidecar), 'runtime persists each device-OAuth token under its provider directory');

  for (const [label, doc] of docs) {
    A.ok(/The app does not track you/i.test(doc), label + ' preserves the accurate no-tracking claim');
    A.ok(/Automatic update checks are on by default/i.test(doc), label + ' discloses the default');
    A.ok(/On first run and at the configured interval/i.test(doc), label + ' discloses first-run timing');
    A.ok(/AUTO-CHECK FOR UPDATES/i.test(doc), label + ' names the opt-out control');
    A.ok(/SYSTEM (?:>|&gt;) SETTINGS (?:>|&gt;) APP (?:&|&amp;) BACKUP/i.test(doc), label + ' names the opt-out location (the AUTO-CHECK toggle lives in SETTINGS › APP & BACKUP)');
    A.ok(!/no ["&quot;]*phone home["&quot;]* of any kind/i.test(doc), label + ' omits the retired absolute phone-home claim');
    A.ok(!/talks to the network[^\n<]*only[^\n<]*work you asked for/i.test(doc), label + ' does not hide the automatic update request');
    for (const provider of ['codex', 'grok', 'kimi']) {
      const row = new RegExp(provider + '\\/tokens\\.json[\\s\\S]{0,120}Plaintext', 'i');
      A.ok(row.test(doc), label + ' identifies ' + provider + '/tokens.json as plaintext');
    }
    A.ok(/\.secrets\/spotify\.json[\s\S]{0,120}Plaintext/i.test(doc), label + ' retains the Spotify plaintext disclosure');
    A.ok(!/Two secret types are/i.test(doc), label + ' omits the incomplete secret count');
  }
}

A.report('updatecore');
