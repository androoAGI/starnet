/* node test/qa-beginner.test.js — the BEGINNER RUN's pure logic (lane Q2), exercised with an
   INJECTED clock and zero browser/sidecar. Asserts:
     - step-budget accounting (per-step ms from the injected clock, over-budget detection, stall id),
     - the 10-minute TOTAL budget gate,
     - mode step selection (ui-only stops at the boundary + drops live-only steps; live runs all),
     - timings.json-shaped result object,
     - stall-finding construction (ledger-shaped, fingerprintable on the step, P0, evidence carried).
   No Date.now() anywhere — every timestamp comes from the controllable clock, so it is deterministic. */
'use strict';
const fs = require('fs');
const A = require('./_assert.js');
const {
  makeRunAccountant, stepsForMode, firstBootAdvanceKey, makeFirstBootAdvanceController,
  BEGINNER_PROVIDER, beginnerKeyFieldValue, uiOnlyProviderBaseEnv, isolatedOsDataEnv,
  ceremonyAdvanceKey,
  buildStallFinding, stampFor, STEP_DEFS, TOTAL_BUDGET_MS
} = require('../scripts/qa/beginner-run.mjs');
const { makeLedger, fingerprintOf } = require('../scripts/qa/ledger.mjs');

// a controllable clock: tests set `clk` and the accountant reads it via clock.now().
let clk = 0;
const clock = { now: () => clk };

// ---- A. mode step selection: ui-only stops at the boundary; live runs every step ----
{
  const ui = stepsForMode('ui-only');
  const live = stepsForMode('live');
  A.ok(ui.length < live.length, 'ui-only runs fewer steps than live');
  A.eq(ui[ui.length - 1].id, 'first-directive', 'ui-only ends AT the boundary step (first-directive)');
  A.ok(ui.every(s => !s.liveOnly), 'ui-only never includes a live-only step');
  A.eq(live[live.length - 1].id, 'first-deliverable', 'live ends at the first-deliverable step');
  A.ok(live.some(s => s.id === 'first-deliverable'), 'live includes the live-only deliverable step');
  // the boundary step is flagged in the canonical defs (so the driver + digest agree on where it is).
  const b = STEP_DEFS.find(s => s.boundary);
  A.eq(b.id, 'first-directive', 'the boundary is first-directive in the canonical defs');
  // selection never mutates the shared defs (returns copies).
  ui[0].budgetMs = -1;
  A.ok(STEP_DEFS[0].budgetMs > 0, 'stepsForMode returns copies — mutating a result never corrupts STEP_DEFS');
}

// ---- A5. production-mode lineage scanning is isolated from the operator's real OS profile ----
{
  const env = isolatedOsDataEnv('C:\\qa-profile', require('node:path').win32);
  A.eq(env.HOME, 'C:\\qa-profile\\Home', 'POSIX recovery candidates cannot escape the QA profile');
  A.eq(env.USERPROFILE, 'C:\\qa-profile\\Home', 'Windows homedir recovery candidates stay isolated too');
  A.eq(env.LOCALAPPDATA, 'C:\\qa-profile\\Local', 'local app data points inside the QA profile');
  A.eq(env.APPDATA, 'C:\\qa-profile\\Roaming', 'roaming app data points inside the QA profile');
  A.eq(env.XDG_DATA_HOME, 'C:\\qa-profile\\Xdg', 'the cross-platform data root is isolated too');
  A.eq(Object.keys(isolatedOsDataEnv('')).length, 0, 'an absent isolation root never invents ambient paths');
}

// ---- A6. the awakening read gate is advanced only when the product proves it is armed ----
{
  A.eq(ceremonyAdvanceKey(true), ' ', 'an armed narration gate receives one real Space keypress');
  A.eq(ceremonyAdvanceKey(false), '', 'ordinary dialogue receives no synthetic key');
  A.eq(ceremonyAdvanceKey('true'), '', 'truthy non-boolean detector noise cannot advance the ceremony');
}

// ---- A3. first-boot splash is advanced only when the product proves that screen is active ----
{
  A.eq(firstBootAdvanceKey('screen-splash'), 'Enter', 'fresh boot receives one real Enter keypress');
  A.eq(firstBootAdvanceKey('screen-connect'), '', 'creation screen is never advanced again');
  A.eq(firstBootAdvanceKey('screen-game'), '', 'returning/in-game state is never disturbed');
  A.eq(BEGINNER_PROVIDER, 'openrouter', 'the isolated BYOK path explicitly selects OpenRouter');
  A.eq(beginnerKeyFieldValue('ui-only', 'dummy'), 'dummy', 'UI-only enters its non-secret placeholder');
  A.eq(beginnerKeyFieldValue('live', 'dummy'), '', 'live mode never writes a credential sentinel into the DOM');
  A.eq(uiOnlyProviderBaseEnv('ui-only', 'http://127.0.0.1:1234/api/v1').SKYNET_OPENROUTER_BASE,
    'http://127.0.0.1:1234/api/v1', 'UI-only routes the mandatory WAKE preflight to its local provider');
  A.eq(uiOnlyProviderBaseEnv('ui-only', 'http://127.0.0.1:1234/api/v1').STARNET_OPENROUTER_BASE,
    'http://127.0.0.1:1234/api/v1', 'both environment prefixes route to the same local provider');
  A.eq(Object.keys(uiOnlyProviderBaseEnv('live', 'http://127.0.0.1:1234/api/v1')).length, 0,
    'live mode never redirects the real provider wire');
  const runnerSource = fs.readFileSync(require.resolve('../scripts/qa/beginner-run.mjs'), 'utf8');
  A.ok(/\/auth\/key/.test(runnerSource),
    'UI-only provider models the authenticated no-spend credential probe used before key persistence');
  A.ok(/Bearer sk-or-beginner-ui-only-placeholder/.test(runnerSource),
    'the credential probe accepts only the isolated Beginner sentinel');
}

// ---- A4. boot veil -> splash is retried statefully instead of sampling the title screen once ----
// REGRESSION LOCK for STUCK@title: the static connect DOM can exist while screen-boot is active.
// The splash becomes active later, so a one-shot sample sees the boot veil, sends no key, and waits forever
// for a connect screen that cannot activate until the splash receives Enter. The controller is
// observed on every title poll: it waits through the veil, advances the later splash exactly once,
// then recognizes connect. Unexpected fresh-boot states fail loudly instead of being disturbed.
{
  const ctl = makeFirstBootAdvanceController();
  const boot = ctl.observe('screen-boot');
  A.eq(boot.status, 'waiting', 'the boot veil is a transient title state');
  A.eq(boot.key, '', 'the boot veil is never advanced');

  const splash = ctl.observe('screen-splash');
  A.eq(splash.status, 'advancing', 'a splash discovered on a later poll is advanced');
  A.eq(splash.key, 'Enter', 'the later splash receives the real Enter keypress');

  const splashAgain = ctl.observe('screen-splash');
  A.eq(splashAgain.status, 'waiting', 'the driver waits for the splash transition after Enter');
  A.eq(splashAgain.key, '', 'the splash is advanced at most once');

  const connect = ctl.observe('screen-connect');
  A.eq(connect.status, 'connect', 'the creation screen is recognized as the title-step destination');
  A.eq(connect.key, '', 'the creation screen is never advanced');

  const bad = makeFirstBootAdvanceController().observe('screen-game');
  A.eq(bad.status, 'failed', 'an unexpected in-game state fails the fresh-user title step');
  A.ok(/screen-game/.test(bad.reason), 'the failure names the observed unexpected screen');
}

// ---- A2. the boundary (first-directive) budget must cover the WHOLE awakening cinematic ----
// REGRESSION LOCK for the P0 stall STUCK@first-directive (ledger fc065df3, 2026-07-08): the fresh-user
// path was declared stalled not because anything hung — the ceremony ran clean with zero console
// errors — but because first-directive's budget (an un-measured 60000) was shorter than the deliberate
// minutes-long "witnessed birth" that must play before the first option chip renders. Measured live:
// the focused dialogue panel opens ~83s after WAKE and the first chip ~93s after WAKE, and that whole
// cinematic is counted against THIS step. Lock a floor so a future trim can't quietly re-introduce the
// too-tight budget: the boundary step must allow at least 120s (well above the ~93s-to-chip measurement,
// below the 180s we ship), and it must still leave real room under the 10-minute total gate.
{
  const boundary = STEP_DEFS.find(s => s.boundary);
  A.eq(boundary.id, 'first-directive', 'the boundary step is first-directive');
  A.ok(boundary.budgetMs >= 120000,
    'first-directive budget covers the awakening cinematic (>=120s; the birth takes ~93s to the first chip)');
  const uiBudget = stepsForMode('ui-only').reduce((n, s) => n + s.budgetMs, 0);
  A.ok(uiBudget <= TOTAL_BUDGET_MS,
    'the sum of ui-only per-step budgets still fits inside the 10-minute total gate');
}

// ---- B. step-budget accounting: per-step ms come from the clock; under budget = ok ----
{
  clk = 100000;   // arbitrary non-zero start
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  acct.startStep('boot');
  clk += 5000;    // boot took 5s (well under its 90s budget)
  const rec = acct.endStep();
  A.eq(rec.id, 'boot', 'record carries the step id');
  A.eq(rec.ms, 5000, 'per-step ms measured from the injected clock');
  A.eq(rec.ok, true, 'a fast step is ok');
  A.eq(rec.overBudget, false, 'a fast step is not over budget');
  const res = acct.result();
  A.eq(res.steps.length, 1, 'one step recorded');
  A.eq(res.totalMs, 5000, 'total is end-of-last-step minus start');
  A.eq(res.ok, true, 'a single fast step -> run ok');
  A.eq(res.stalledStep, null, 'no stall');
}

// ---- C. an over-budget step marks the run failed and names the stalled step ----
{
  clk = 0;
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  acct.startStep('title');                       // title budget is 30s
  clk += 45000;                                  // blow it: 45s > 30s
  const rec = acct.endStep();
  A.eq(rec.overBudget, true, 'title over its 30s budget flagged');
  A.eq(rec.ok, false, 'over-budget step is not ok');
  const res = acct.result();
  A.eq(res.ok, false, 'run is not ok when a step blew its budget');
  A.eq(res.stalledStep, 'title', 'the stalled step is named');
}

// ---- C2. a step failed EVEN IF under budget (a control was NOTFOUND) is a stall ----
{
  clk = 0;
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  acct.startStep('create-agent');
  clk += 1000;                                   // fast, but…
  const rec = acct.endStep(true);                // …driver marks it failed (e.g. WAKE not clickable)
  A.eq(rec.ok, false, 'an explicitly-failed step is not ok even under budget');
  A.eq(rec.overBudget, false, 'it was not over budget — the failure is the check, not the clock');
  A.eq(acct.result().stalledStep, 'create-agent', 'the failed step is the stall');
}

// ---- D. the 10-minute TOTAL budget gate ----
{
  clk = 0;
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  A.eq(acct.overTotal(), false, 'not over total at t=0');
  clk = TOTAL_BUDGET_MS - 1;
  A.eq(acct.overTotal(), false, 'not over total just under 10 minutes');
  clk = TOTAL_BUDGET_MS + 1;
  A.eq(acct.overTotal(), true, 'over total just past 10 minutes');
  A.eq(TOTAL_BUDGET_MS, 600000, 'the thesis number is 10 minutes = 600000ms');
}

// ---- D2. a run whose TOTAL exceeds 10 minutes is failed even if every step was under its own budget ----
{
  clk = 0;
  const acct = makeRunAccountant({ clock, mode: 'live' });
  // five steps, each just under its own budget, but they sum past 10 minutes.
  for (const id of ['boot', 'title', 'connect', 'create-agent', 'awakening']) {
    acct.startStep(id); clk += 130000; acct.endStep();   // 130s each × 5 = 650s > 600s
  }
  const res = acct.result();
  A.eq(res.overTotal, true, 'total over 10 minutes');
  A.eq(res.ok, false, 'run failed on the total gate even with per-step-ok steps');
}

// ---- E. result() has a stable timings.json shape ----
{
  clk = 1000;
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  acct.startStep('boot'); clk += 2000; acct.endStep();
  const res = acct.result();
  A.ok('mode' in res && 'totalMs' in res && 'budgetMs' in res && 'ok' in res && 'overTotal' in res && 'stalledStep' in res && Array.isArray(res.steps), 'result has the timings.json top-level shape');
  const s = res.steps[0];
  A.ok('id' in s && 'label' in s && 'ms' in s && 'budgetMs' in s && 'ok' in s && 'overBudget' in s && 'boundary' in s, 'each step record has the timings shape');
  A.eq(res.mode, 'ui-only', 'mode echoed');
  A.eq(res.budgetMs, TOTAL_BUDGET_MS, 'budget echoed');
}

// ---- E2. a still-open step at result() time folds in as a stall (driver hit a fatal mid-step) ----
{
  clk = 0;
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  acct.startStep('awakening');
  clk += 3000;
  const res = acct.result();                     // never called endStep — simulates a fatal mid-step
  A.eq(res.steps.length, 1, 'the open step is folded into the record');
  A.eq(res.steps[0].ok, false, 'the folded step is a failure');
  A.eq(res.stalledStep, 'awakening', 'the open step becomes the stall');
}

// ---- F. an unknown step id throws (a driver typo must be loud, not silently mis-timed) ----
{
  clk = 0;
  const acct = makeRunAccountant({ clock, mode: 'ui-only' });
  A.throws(() => acct.startStep('not-a-real-step'), 'starting an unknown step id throws');
  // a live-only step is unknown to a ui-only run (so the driver can't accidentally time it).
  A.throws(() => acct.startStep('first-deliverable'), 'a live-only step is unknown to a ui-only accountant');
}

// ---- G. stall finding is ledger-shaped, P0, carries evidence, fingerprints on the STEP ----
{
  const f = buildStallFinding({
    step: 'create-agent', label: 'WAKE OVERSEER accepted', mode: 'ui-only',
    reason: 'WAKE did not advance off the connect screen', ms: 31000, totalMs: 120000,
    evidence: ['.bugloops/beginner-x/timings.json', '.bugloops/beginner-x/04-create-agent.png']
  });
  A.eq(f.crew, 'Beginner Run', 'crew is Beginner Run');
  A.eq(f.severity, 'P0', 'a broken fresh-user path is P0');
  A.eq(f.checkId, 'beginner-step', 'stable check id');
  A.eq(f.subject, 'create-agent', 'subject is the step (fingerprint key)');
  A.ok(/stuck at create-agent/.test(f.title), 'title names the stuck step');
  A.ok(/WAKE did not advance/.test(f.detail), 'detail carries the reason');
  A.ok(/31000ms/.test(f.detail), 'detail carries the step ms');
  A.eq(f.evidence.length, 2, 'evidence paths carried');

  // it survives the ledger's evidence law + is fingerprintable per-step (two different steps -> two files).
  let clk2 = 500; const led = makeLedger({ clock: { now: () => clk2 }, io: memIo() });
  const r1 = led.add(f);
  A.eq(r1.ok, true, 'stall finding passes the ledger (has evidence + title)');
  A.eq(r1.status, 'added', 'first stall filed');
  // the SAME step stall re-files as a duplicate (anti-nag) — one file per step.
  const r1b = led.add(buildStallFinding({ step: 'create-agent', mode: 'ui-only', reason: 'again', evidence: ['x'] }));
  A.eq(r1b.status, 'duplicate', 'the same step stall dedups to one file');
  // a DIFFERENT stuck step files separately.
  const r2 = led.add(buildStallFinding({ step: 'awakening', mode: 'ui-only', reason: 'no floor', evidence: ['y'] }));
  A.eq(r2.status, 'added', 'a different stuck step files separately');
  A.ok(r1.finding.fingerprint !== r2.finding.fingerprint, 'different steps -> different fingerprints');

  // fingerprint is derivable from (crew, checkId, subject) so the ledger + a session agree on it.
  const fp = fingerprintOf({ crew: 'Beginner Run', checkId: 'beginner-step', subject: 'create-agent' });
  A.eq(r1.finding.fingerprint, fp, 'stall fingerprint matches the pure fingerprintOf(step)');
}

// ---- G2. a stall finding with NO evidence is refused by the ledger (evidence law holds end-to-end) ----
{
  const f = buildStallFinding({ step: 'boot', mode: 'ui-only', reason: 'no sidecar', evidence: [] });
  A.eq(f.evidence.length, 0, 'construction does not invent evidence');
  let clk3 = 0; const led = makeLedger({ clock: { now: () => clk3 }, io: memIo() });
  A.eq(led.add(f).status, 'rejected', 'an evidence-less stall is rejected by the ledger (no vibes-findings)');
}

// ---- H. stampFor is deterministic + filesystem-safe (no colons) ----
{
  const s = stampFor(0);
  A.eq(s, '1970-01-01T00-00-00', 'epoch stamps to the UTC zero string');
  A.ok(!/:/.test(s), 'stamp has no colons (filesystem-safe on Windows)');
  A.eq(stampFor(0), stampFor(0), 'same ms -> same stamp (deterministic)');
}

// a tiny in-memory io for the ledger asserts above.
function memIo() {
  const rows = [];
  return { listFindings() { return rows.map(r => Object.assign({}, r)); }, writeFinding(f) { rows.push(Object.assign({}, f)); }, knownFingerprints() { return new Set(); } };
}

A.report('qa-beginner.test');
