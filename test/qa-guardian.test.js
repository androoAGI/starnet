/* node test/qa-guardian.test.js — the GREEN GUARDIAN's pure DECISION logic (lane Q1),
   fed injected io + a controllable clock (zero disk, zero child processes, zero gates).
   Asserts: stable per-defect fingerprint derivation, gate-result -> ledger-finding mapping
   (blocked -> P0 loud; per-frame / per-assertion / per-state attribution; clean exit ->
   nothing), the cycle verdict roll-up, and STATUS.md row render + splice. Pure +
   deterministic — every ts comes from the injected clock, never Date.now(). Does NOT run
   test:fast / shoot / golden / audit (those are the IO shell's job). */
'use strict';
const A = require('./_assert.js');
const {
  makeGuardianCore, guardianFingerprint,
  parseGoldenReport, parseAuditReport, parseShootManifest, parseJourneysReport,
  GUARDIAN_STEPS, isLockStale, guardianStepTimeoutMs,
} = require('../scripts/qa/guardian.mjs');
const { fingerprintOf } = require('../scripts/qa/ledger.mjs');

const clock = { now: () => 7000 };
// an injected io whose report readers return whatever we hand them; evidencePath is identity.
function io(over) {
  return Object.assign({
    readGolden() { return null; },
    readAudit() { return null; },
    readShoot() { return null; },
    readJourneys() { return null; },
    evidencePath(p) { return p; },
  }, over || {});
}
const step = (id) => GUARDIAN_STEPS.find(s => s.id === id);

// The outer watchdog must not preempt the complete HTTP child gate.
{
  const httpCommand = require('../package.json').scripts['test:http'];
  const childBudget = Number(/--timeout=(\d+)/.exec(httpCommand)[1]);
  A.ok(guardianStepTimeoutMs(step('http-e2e')) > childBudget, 'Guardian HTTP deadline includes child watchdog headroom');
  A.eq(guardianStepTimeoutMs(step('test-fast')), 900000, 'other Guardian steps retain their normal deadline');
  A.eq(guardianStepTimeoutMs(step('http-e2e'), '45000'), 45000, 'explicit operator deadline overrides HTTP default');
}

// ---- A. fingerprint is stable + agrees with the ledger's fingerprintOf (one dedup key) ----
{
  const fp1 = guardianFingerprint({ step: 'golden', subject: 'frame/ingame' });
  const fp2 = guardianFingerprint({ step: 'golden', subject: 'frame/ingame' });
  A.eq(fp1, fp2, 'same (step,subject) -> same fingerprint (stable across calls)');
  A.eq(fp1, fingerprintOf({ crew: 'Green Guardian', checkId: 'golden', subject: 'frame/ingame' }),
    'guardian fingerprint == ledger fingerprintOf with the Green Guardian crew');
  A.ok(guardianFingerprint({ step: 'golden', subject: 'frame/ingame' }) !== guardianFingerprint({ step: 'golden', subject: 'frame/crew-roster' }),
    'different subject -> different fingerprint (per-frame dedup)');
  A.ok(guardianFingerprint({ step: 'audit', subject: 'frame/ingame' }) !== guardianFingerprint({ step: 'golden', subject: 'frame/ingame' }),
    'different step -> different fingerprint (per-step dedup)');
}

// ---- B. a clean exit files NOTHING (green cycle is silent) ----
{
  const core = makeGuardianCore({ io: io(), clock });
  for (const id of ['test-fast', 'http-e2e', 'saboteur', 'shoot', 'golden', 'audit', 'journeys']) {
    A.eq(core.findingsFor(step(id), { exitCode: 0, sha: 'abc1234def' }).length, 0, id + ' clean exit -> zero findings');
  }
}

// ---- C. BLOCKED (spawn error / timeout / explicit block) -> ONE loud P0, whatever the step ----
{
  const core = makeGuardianCore({ io: io(), clock });
  const spawnF = core.findingsFor(step('test-fast'), { spawnError: 'ENOENT npm', sha: 'deadbeef', logFile: 'x.log' });
  A.eq(spawnF.length, 1, 'spawn error -> one finding');
  A.eq(spawnF[0].severity, 'P0', 'BLOCKED is always P0 (no-fake-green)');
  A.ok(/BLOCKED/.test(spawnF[0].title), 'title says BLOCKED');
  A.eq(spawnF[0].crew, 'Green Guardian', 'crew is Green Guardian');
  A.eq(spawnF[0].ts, 7000, 'ts stamped from the injected clock (not Date.now)');
  A.eq(spawnF[0].evidence.length, 1, 'BLOCKED finding carries the log evidence path');

  const timeoutF = core.findingsFor(step('audit'), { timedOut: true, durationMs: 900000, sha: 'deadbeef', logFile: 'a.log' });
  A.eq(timeoutF[0].severity, 'P0', 'a timeout is a P0 BLOCKED even for a normally-P1 visual gate');
  A.ok(/timed out/.test(timeoutF[0].detail), 'timeout detail names the timeout');

  const explicit = core.findingsFor({ id: 'pin', title: 'Pin trunk', severity: 'P0' }, { blocked: true, blockReason: 'git reset failed', sha: 'deadbeef', logFile: 'p.log' });
  A.eq(explicit[0].severity, 'P0', 'explicit block -> P0');
  A.ok(/git reset failed/.test(explicit[0].detail), 'block reason carried into the detail');
}

// ---- D. GOLDEN red -> one P1 finding PER flagged frame, with the frame as evidence ----
{
  const goldenReport = { threshold: 1.5, flaggedCount: 2, flagged: [
    { name: 'ingame', diff: 12.4, frame: '/pin/.uigolden/ingame.png' },
    { name: 'crew-roster', diff: null, reason: 'new state (no golden)', frame: '/pin/.uigolden/crew-roster.png' },
  ] };
  const core = makeGuardianCore({ io: io({ readGolden: () => goldenReport, evidencePath: (p) => '/cycle/' + p.split('/').pop() }), clock });
  const fs = core.findingsFor(step('golden'), { exitCode: 3, sha: 'abc1234def', logFile: '/cycle/golden.log' });
  A.eq(fs.length, 2, 'two flagged frames -> two findings');
  A.ok(fs.every(f => f.severity === 'P1'), 'visual regressions are P1');
  A.ok(/ingame/.test(fs[0].title), 'first finding names the changed frame');
  A.ok(fs[0].evidence.some(e => /ingame\.png/.test(e)), 'flagged frame PNG is evidence (via evidencePath)');
  A.ok(fs[0].evidence.some(e => /golden\.log/.test(e)), 'the step log is also evidence');
  // fingerprint is per-frame so the SAME changed frame next cycle dedups.
  A.eq(fs[0].fingerprint, guardianFingerprint({ step: 'golden', subject: 'frame/ingame' }), 'golden fingerprint is per-frame');
  A.ok(fs[0].fingerprint !== fs[1].fingerprint, 'two different frames -> two fingerprints');
}

// ---- D2. golden nonzero exit but NO parseable flagged frames -> one P0 step-level (never silent) ----
{
  const core = makeGuardianCore({ io: io({ readGolden: () => ({ flagged: [] }) }), clock });
  const fs = core.findingsFor(step('golden'), { exitCode: 2, sha: 'abc1234def', logFile: 'g.log' });
  A.eq(fs.length, 1, 'unparseable golden red -> one finding, not zero (no-fake-green)');
  A.eq(fs[0].severity, 'P0', 'missing baseline / capture failure is a P0');
}

// ---- E. AUDIT red -> one P1 finding per HARD-failing assertion (soft fails ignored) ----
{
  const auditReport = { scenarios: [
    { name: 'floor-rest', passed: true, assertions: [{ name: 'testapi/present', pass: true }] },
    { name: 'task', passed: false, assertions: [
      { name: 'task/run-lifecycle', pass: false, soft: false, detail: 'start=1 end=0' },
      { name: 'task/work-pose-engaged', pass: false, soft: true, detail: 'too brief' }, // SOFT -> ignored
    ] },
    { name: 'moat', passed: false, assertions: [{ name: 'moat/capability-online', pass: false, soft: false, detail: 'no workbench' }] },
  ] };
  const core = makeGuardianCore({ io: io({ readAudit: () => auditReport }), clock });
  const fs = core.findingsFor(step('audit'), { exitCode: 3, sha: 'abc1234def', logFile: 'audit.log' });
  A.eq(fs.length, 2, 'two hard-failing assertions -> two findings (soft failure excluded)');
  A.ok(fs.every(f => f.severity === 'P1'), 'audit regressions are P1');
  A.ok(fs.some(f => /run-lifecycle/.test(f.title)), 'a failing assertion is named in the title');
  A.ok(fs.some(f => /capability-online/.test(f.title)), 'the moat assertion is captured');
  A.ok(!fs.some(f => /work-pose/.test(f.title)), 'the SOFT assertion did NOT file');
  // per-assertion fingerprint so a persistent assertion failure dedups.
  A.eq(fs[0].fingerprint, guardianFingerprint({ step: 'audit', subject: 'assert/task/task/run-lifecycle' }), 'audit fingerprint is per (scenario+assertion)');
}

// ---- E2. audit red but unparseable report -> one P1 step-level (never silent) ----
{
  const core = makeGuardianCore({ io: io({ readAudit: () => null }), clock });
  const fs = core.findingsFor(step('audit'), { exitCode: 3, sha: 'x', logFile: 'a.log' });
  A.eq(fs.length, 1, 'unparseable audit red still files one finding');
  A.ok(/no parseable assertion report/.test(fs[0].title) || /no hard-failing assertions/.test(fs[0].detail), 'names the unparseable case');
}

// ---- E3. JOURNEYS red -> one P1 finding per HARD-failing journey step (soft fails ignored) ----
{
  const journeysReport = { journeys: [
    { name: 'J1 task-lifecycle', passed: true, assertions: [{ name: 'J1/task-created', pass: true }] },
    { name: 'J2a interrupt: E-STOP', passed: false, assertions: [
      { name: 'J2/estop/settles-idle', pass: false, soft: false, detail: 'a channel stayed busy' },
      { name: 'J2.estop::topbar/spend', pass: false, soft: true, detail: 'env' }, // SOFT -> ignored
    ] },
    { name: 'J4 deliverable', passed: false, assertions: [{ name: 'J4/workshop-run-200', pass: false, soft: false, detail: 'got 404' }] },
  ] };
  const core = makeGuardianCore({ io: io({ readJourneys: () => journeysReport }), clock });
  const fs = core.findingsFor(step('journeys'), { exitCode: 3, sha: 'abc1234def', logFile: 'journeys.log' });
  A.eq(fs.length, 2, 'two hard-failing journey assertions -> two findings (soft excluded)');
  A.ok(fs.every(f => f.severity === 'P1'), 'journey regressions are P1');
  A.ok(fs.some(f => /settles-idle/.test(f.title)), 'a failing journey assertion is named in the title');
  A.ok(fs.some(f => /workshop-run-200/.test(f.title)), 'the deliverable assertion is captured');
  A.ok(!fs.some(f => /spend/.test(f.title)), 'the SOFT journey assertion did NOT file');
  A.eq(fs[0].fingerprint, guardianFingerprint({ step: 'journeys', subject: 'journey/J2a interrupt: E-STOP/J2/estop/settles-idle' }), 'journey fingerprint is per (journey+assertion)');
}

// ---- E4. journeys red but unparseable report -> one P1 step-level (never silent) ----
{
  const core = makeGuardianCore({ io: io({ readJourneys: () => null }), clock });
  const fs = core.findingsFor(step('journeys'), { exitCode: 3, sha: 'x', logFile: 'j.log' });
  A.eq(fs.length, 1, 'unparseable journeys red still files one finding');
  A.ok(/no parseable journey report/.test(fs[0].title), 'names the unparseable journeys case');
}

// ---- E5. journeys BLOCKED (exit 2 / spawn / timeout) -> ONE loud P0 (no-fake-green) ----
{
  const core = makeGuardianCore({ io: io(), clock });
  const fs = core.findingsFor(step('journeys'), { timedOut: true, durationMs: 900000, sha: 'deadbeef', logFile: 'j.log' });
  A.eq(fs.length, 1, 'a BLOCKED journeys step files exactly one finding');
  A.eq(fs[0].severity, 'P0', 'a journeys detector that cannot run is a P0');
  A.ok(/BLOCKED/.test(fs[0].title), 'the blocked title is loud');
}

// ---- F. SHOOT red -> one P1 finding per failed state; whole-boot failure -> one P0 ----
{
  const manifest = { states: [
    { name: 'ingame', ok: true },
    { name: 'crew-roster', ok: false, driveResult: 'NOTFOUND #bb-crew' },
    { name: 'sys-settings', ok: false, driveResult: 'CLICK_ERR' },
  ] };
  const core = makeGuardianCore({ io: io({ readShoot: () => manifest }), clock });
  const fs = core.findingsFor(step('shoot'), { exitCode: 3, sha: 'abc1234def', logFile: 's.log' });
  A.eq(fs.length, 2, 'two failed states -> two findings (the ok state is not filed)');
  A.ok(fs.every(f => f.severity === 'P1'), 'per-state failures are P1');
  A.ok(fs.some(f => /crew-roster/.test(f.title)), 'the failing state is named');
  A.eq(fs[0].fingerprint, guardianFingerprint({ step: 'shoot', subject: 'state/crew-roster' }), 'shoot fingerprint is per-state');

  // exit 2 = never reached the floor; no per-state attribution -> ONE P0.
  const core2 = makeGuardianCore({ io: io({ readShoot: () => ({ states: [] }) }), clock });
  const boot = core2.findingsFor(step('shoot'), { exitCode: 2, sha: 'x', logFile: 's.log' });
  A.eq(boot.length, 1, 'never-reached-floor -> one finding');
  A.eq(boot[0].severity, 'P0', 'the app not booting is a P0');
}

// ---- G. TEST-FAST red -> one P0 step-level finding (default path) ----
{
  const core = makeGuardianCore({ io: io(), clock });
  const fs = core.findingsFor(step('test-fast'), { exitCode: 1, sha: 'abc1234def', logFile: 't.log' });
  A.eq(fs.length, 1, 'test:fast red -> one finding');
  A.eq(fs[0].severity, 'P0', 'a red merge gate is a P0');
  A.ok(/test:fast/.test(fs[0].title), 'title names the failing gate');
  A.eq(fs[0].fingerprint, guardianFingerprint({ step: 'test-fast', subject: 'test-fast/step' }), 'test-fast fingerprint is step-level (stable across runs)');
}

// ---- H. summarize(): verdict = red if any step failed/blocked; golden-review-clean is green ----
{
  const core = makeGuardianCore({ io: io(), clock });
  A.eq(core.summarize([
    { id: 'test-fast', exitCode: 0 }, { id: 'shoot', exitCode: 0 },
    { id: 'golden', exitCode: 3, flaggedCount: 0 }, { id: 'audit', exitCode: 0 },
  ]).verdict, 'green', 'golden exit 3 with ZERO flagged frames is green (review-clean)');
  const red = core.summarize([{ id: 'test-fast', exitCode: 1 }, { id: 'audit', exitCode: 0 }]);
  A.eq(red.verdict, 'red', 'any failing gate -> red');
  A.eq(JSON.stringify(red.red), JSON.stringify(['test-fast']), 'the red step is named');
  const blocked = core.summarize([{ id: 'shoot', blocked: true }]);
  A.eq(blocked.verdict, 'red', 'a BLOCKED step -> red');
  A.eq(JSON.stringify(blocked.blocked), JSON.stringify(['shoot']), 'the blocked step is named');
  const goldenReal = core.summarize([{ id: 'golden', exitCode: 3, flaggedCount: 2 }]);
  A.eq(goldenReal.verdict, 'red', 'golden exit 3 WITH flagged frames -> red');
}

// ---- I. statusRow() + renderStatus() render + splice, preserving every other row ----
{
  const core = makeGuardianCore({ io: io(), clock });
  const row = core.statusRow({ isoTime: '2026-07-01 12:00Z', sha: 'abc1234def567', verdict: 'green', findings: 0 });
  A.ok(/\| Green Guardian \|/.test(row), 'row starts with the Green Guardian cell');
  A.ok(/GREEN/.test(row), 'a green cycle renders GREEN');
  A.ok(/abc1234d/.test(row), 'the row carries the short trunk sha');
  A.ok(!/abc1234def567/.test(row), 'sha is shortened to 8 chars');

  const redRow = core.statusRow({ isoTime: '2026-07-01 13:00Z', sha: 'deadbeef00', verdict: 'red', findings: 3 });
  A.ok(/RED/.test(redRow), 'a red cycle renders RED');
  A.ok(/\| 3 \|$/.test(redRow), 'open-findings count is rendered in the last cell');

  const status = [
    '| Crew member | Question | Last run | Result | Open findings |',
    '| --- | --- | --- | --- | --- |',
    '| Green Guardian | old q | — | — | 0 |',
    '| Beginner Run | can a user reach value? | — | — | 0 |',
    '| Janitor | rot? | 2026-06-30 | GREEN | 1 |',
  ].join('\n');
  const { markdown, replaced } = core.renderStatus(status, redRow);
  A.eq(replaced, true, 'the Green Guardian row was found + replaced');
  A.ok(markdown.includes(redRow), 'the new row is spliced in');
  A.ok(!markdown.includes('old q'), 'the stale Green Guardian row is gone');
  A.ok(markdown.includes('| Beginner Run | can a user reach value? | — | — | 0 |'), 'the Beginner Run row is untouched');
  A.ok(markdown.includes('| Janitor | rot? | 2026-06-30 | GREEN | 1 |'), 'the Janitor row is untouched');
  A.eq(markdown.split('\n').length, status.split('\n').length, 'no rows added or dropped');

  // fail-safe: a STATUS with no Green Guardian row is returned unchanged + replaced:false.
  const noRow = core.renderStatus('| Beginner Run | x | — | — | 0 |', redRow);
  A.eq(noRow.replaced, false, 'a missing Green Guardian row reports replaced:false');
  A.eq(noRow.markdown, '| Beginner Run | x | — | — | 0 |', 'STATUS unchanged when the row is absent');
}

// ---- J. the report parsers are defensive against junk (never throw, return []) ----
{
  A.eq(parseGoldenReport(null).length, 0, 'null golden report -> []');
  A.eq(parseGoldenReport({ flagged: 'nope' }).length, 0, 'non-array flagged -> []');
  A.eq(parseGoldenReport({ flagged: [{ diff: 1 }] }).length, 0, 'a flagged entry with no name is dropped');
  A.eq(parseAuditReport(null).length, 0, 'null audit report -> []');
  A.eq(parseAuditReport({ scenarios: [{ assertions: [{ pass: false, soft: true }] }] }).length, 0, 'soft-only audit -> []');
  A.eq(parseShootManifest(null).length, 0, 'null shoot manifest -> []');
  A.eq(parseShootManifest({ states: [{ name: 'x', ok: true }] }).length, 0, 'all-ok manifest -> []');
  A.eq(parseJourneysReport(null).length, 0, 'null journeys report -> []');
  A.eq(parseJourneysReport({ journeys: 'nope' }).length, 0, 'non-array journeys -> []');
  A.eq(parseJourneysReport({ journeys: [{ name: 'J1', assertions: [{ name: 'a', pass: false, soft: true }] }] }).length, 0, 'soft-only journeys -> []');
  A.eq(parseJourneysReport({ journeys: [{ name: 'J1', assertions: [{ name: 'a', pass: true }] }] }).length, 0, 'all-pass journeys -> []');
}

// ---- K. isLockStale(): a dead holder's heartbeat goes stale; a fresh one is live ----
{
  const NOW = 1000000, STALE = 120000;
  A.eq(isLockStale({ heartbeatAt: NOW - 10000 }, NOW, STALE), false, 'a 10s-old heartbeat is NOT stale (live holder)');
  A.eq(isLockStale({ heartbeatAt: NOW - 130000 }, NOW, STALE), true, 'a heartbeat older than the stale window is reclaimable');
  A.eq(isLockStale(null, NOW, STALE), true, 'a missing record is treated as stale (reclaimable)');
  A.eq(isLockStale({}, NOW, STALE), true, 'a record with no heartbeat is stale');
  A.eq(isLockStale({ heartbeatAt: 'nope' }, NOW, STALE), true, 'a garbled heartbeat is stale');
  A.eq(isLockStale({ heartbeatAt: NOW }, NOW, STALE), false, 'a just-refreshed heartbeat is live');
}

// ---- L. summarize(): a red gate marked reviewClean (all findings dismissed/known) is NOT red ----
{
  const core = makeGuardianCore({ io: io(), clock });
  // journeys exit 3 whose only hard-fail is a dismissed flake -> the shell marks reviewClean -> green.
  A.eq(core.summarize([
    { id: 'test-fast', exitCode: 0 }, { id: 'shoot', exitCode: 0 }, { id: 'golden', exitCode: 0 },
    { id: 'audit', exitCode: 0 }, { id: 'journeys', exitCode: 3, reviewClean: true },
  ]).verdict, 'green', 'a red gate whose findings are all dismissed/known (reviewClean) is not counted red');
  // WITHOUT reviewClean the same journeys exit 3 is red (the flag is what excuses it).
  A.eq(core.summarize([{ id: 'journeys', exitCode: 3 }]).verdict, 'red', 'journeys exit 3 with no reviewClean flag -> red');
  // reviewClean must NOT excuse a genuinely BLOCKED detector (a step that could not run stays red).
  A.eq(core.summarize([{ id: 'golden', blocked: true, reviewClean: true }]).verdict, 'red', 'reviewClean cannot excuse a BLOCKED step (no-fake-green holds)');
}

A.report('qa-guardian.test');
