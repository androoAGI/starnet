/* node test/codex-configured.test.js — the desktop codex "configured" truth (source-locks).

   THE BUG THIS LOCKS OUT (found on Andrew's 3-machine 0.6.0 test, 2026-07-19): codex is NOT a keychain
   provider (its OAuth tokens live sidecar-side in workspaces/codex/), so the boot-time keychain status
   sweep could never report it — `Harness.configured('codex')` stayed FALSE forever on desktop. Everything
   gated on brainReady()/configured() silently died for every ChatGPT-sign-in install: the live awakening
   beats, the whole V3 guided-discovery interview (degraded to the keyless holding path), the deferred
   interview offer, the generated starter. Dev harnesses use synchronous keys, so no dev test ever saw it.

   Two halves, both locked here:
     1. harness.js init() probes /api/auth/codex/status and marks codex configured at boot (returning
        sessions), fail-open.
     2. app.js refreshCodexStatus() flips Harness.setDesktopConfigured('codex', …) the moment sign-in
        state is known (first-run: the wake that follows sees a live brain).
   Plus: the rust keychain list must still exclude codex (if codex is ever ADDED there, the probe becomes
   redundant and this lock should be revisited — but silently double-reporting would be harmless). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const harnessSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');

/* ---------- 1. boot-time: init() asks the sidecar about codex ---------- */
const initStart = harnessSrc.indexOf('async function init()');
A.ok(initStart > 0, 'harness.js still has the async init()');
const initBody = harnessSrc.slice(initStart, harnessSrc.indexOf('function normalizeProviderId'));
A.ok(initBody.includes('await refreshProviderReadiness()'), 'boot reads the sidecar provider readiness rows, including Codex');
A.ok(!initBody.includes('_configuredByProvider'), 'keychain status cannot overwrite the sidecar readiness verdict');
A.ok(harnessSrc.includes('readinessCache.offline()'), 'a failed fetch preserves cached state with an explicit stale label');

/* ---------- 2. sign-in time: the status poll flips the map immediately ---------- */
const refreshStart = appSrc.indexOf('async function refreshCodexStatus');
A.ok(refreshStart > 0, 'app.js still has refreshCodexStatus');
const refreshBody = appSrc.slice(refreshStart, refreshStart + 2200);
A.ok(/Harness\.setDesktopConfigured\)\s*Harness\.setDesktopConfigured\('codex',\s*codexConnected\)/.test(refreshBody),
  'refreshCodexStatus mirrors sign-in state into Harness.setDesktopConfigured (first-run wake sees a live brain)');

/* ---------- 3. the export exists (app.js depends on it) ---------- */
A.ok(/setDesktopConfigured,/.test(harnessSrc), 'Harness exports setDesktopConfigured');

/* ---------- 3b. THE WIRE IS PROVEN AT THE DOOR (Andrew's law, 2026-07-19): no wake on an unproven wire ---------- */
// The full onboarding is MANDATORY and it is authored by live-model beats — so onWakeAttempt must run ONE
// real round-trip (preflightWire) through the exact path the awakening uses, and bounce honestly on failure.
A.ok(/async function preflightWire\(\)/.test(appSrc), 'the wire preflight exists');
A.ok(/preflightWire[\s\S]{0,900}Reply with exactly: OK/.test(appSrc), 'the preflight is a REAL chat round-trip, not a status read');
A.ok(/Promise\.race\(\[call,\s*new Promise\(r => setTimeout\(\(\) => r\(null\), 30000\)\)\]\)/.test(appSrc),
  'the preflight is bounded (30s) — a stalled provider can never hang the wake button');
{
  const attemptStart = appSrc.indexOf('async function onWakeAttempt');
  const attemptBody = appSrc.slice(attemptStart, appSrc.indexOf('enterGame({ awaitingPurpose: true, wake: true })'));
  A.ok(attemptStart > 0 && /const wire = await preflightWire\(\);[\s\S]{0,400}if \(!wire\.ok\) \{[\s\S]{0,1200}return false;/.test(attemptBody),
    'onWakeAttempt proves the wire BEFORE entering the game and bounces honestly on a dead one');
}

/* ---------- 4. the rust keychain list still excludes codex (the reason the probe exists) ---------- */
const rustSrc = fs.readFileSync(path.join(__dirname, '../src-tauri/src/credentials.rs'), 'utf8');
const m = /const KEYCHAIN_PROVIDERS[^;]+;/s.exec(rustSrc);
A.ok(m && m[0].indexOf('"codex"') < 0,
  'codex stays out of KEYCHAIN_PROVIDERS (tokens are sidecar-side; if this ever changes, revisit this lock)');

A.report('codex-configured.test');
