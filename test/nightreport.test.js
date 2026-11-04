/* node test/nightreport.test.js — the PURE morning-report engine (frontend/app/nightreport.js), NS-4.

   Locks the honest digest: compose() turns { status, ledger, drafts } into a report that names the acts AND the
   declined half (which gate bound them), the "did nothing and why" sentence, LOCAL-time formatting, and the
   no-absence/no-decision → no-beat rule. Pure + deterministic — nowMs and tz-offset are always explicit. */
'use strict';
const A = require('./_assert.js');
const NR = require('../frontend/app/nightreport.js');

/* ---------- fmtLocalTime(): LOCAL clock, explicit offset, honest empties ---------- */
// 2026-01-01T06:10:00Z = 1735711800000. At UTC (offset 0) that is 6:10 AM.
const T0610Z = Date.UTC(2026, 0, 1, 6, 10, 0);
A.eq(NR.fmtLocalTime(T0610Z, 0), '6:10 AM', 'UTC render of 06:10Z is 6:10 AM');
// EST is UTC-5 → offset -300 → 1:10 AM local (the task's worked example).
A.eq(NR.fmtLocalTime(T0610Z, -300), '1:10 AM', 'offset -300 (EST) renders 06:10Z as LOCAL 1:10 AM');
// crossing midnight backward stays a valid clock (no negative/25h times).
A.eq(NR.fmtLocalTime(Date.UTC(2026, 0, 1, 2, 0, 0), -300), '9:00 PM', 'offset -300 wraps 02:00Z back to 9:00 PM prev day');
A.eq(NR.fmtLocalTime(Date.UTC(2026, 0, 1, 0, 0, 0), 0), '12:00 AM', 'midnight renders as 12:00 AM not 0:00');
A.eq(NR.fmtLocalTime(Date.UTC(2026, 0, 1, 12, 0, 0), 0), '12:00 PM', 'noon renders as 12:00 PM not 0:00');
A.eq(NR.fmtLocalTime(0, -300), '', '0 ms → empty string (no fake clock for no data)');
A.eq(NR.fmtLocalTime(null, -300), '', 'null ms → empty string');

/* ---------- bindingPhrase(): every gate has an honest sentence; unknowns stay honest ---------- */
A.ok(/not allowed to act/i.test(NR.bindingPhrase('posture')), 'posture phrase says it may not act unattended');
A.ok(/away/i.test(NR.bindingPhrase('present')), 'present phrase names your presence');
A.ok(/job limit/i.test(NR.bindingPhrase('leash')), 'leash phrase names the daily job limit');
A.ok(/gate/i.test(NR.bindingPhrase('some-future-gate')), 'an unknown binding renders honestly (names the gate), never a fabricated reason');
A.ok(/nothing is blocking/i.test(NR.bindingPhrase(null)), 'null binding → "nothing is blocking" (a job could run now)');
// EL-11: the halt phrase must name its LIFT (re-set the dial), not just the stop.
A.ok(/ON ITS OWN/.test(NR.bindingPhrase('halt')), 'halt phrase names the lift — press an ON ITS OWN button');
// EL-11: 'readiness' is a real gate the status route reports; it must have plain copy (what the gate checks —
// grounded knowledge: dossier/activity), never the raw "held back by the readiness gate" jargon.
A.ok(NR.BINDING_PHRASE.readiness, 'BINDING_PHRASE carries a readiness entry');
A.ok(!/readiness gate/i.test(NR.bindingPhrase('readiness')), 'readiness renders plain copy, not raw gate jargon');
A.ok(/know|learn|task/i.test(NR.bindingPhrase('readiness')), 'readiness copy says what feeds the gate (the station learning you through real work)');

/* ---------- compose(): the no-report rule (no absence / no decision → no beat) ---------- */
const empty = NR.compose({ status: null, ledger: [], drafts: [], awaySince: 1000, nowMs: 9999, tzOffsetMin: 0 });
A.eq(empty.hasReport, false, 'zero acts + zero declines → hasReport:false (caller shows NO beat, never a nag)');

// a ledger with only entries BEFORE the away window is out of scope → still no report.
const stale = NR.compose({
  status: null, awaySince: 5000, nowMs: 9999, tzOffsetMin: 0,
  ledger: [{ source: 'nightshift', kind: 'decline', binding: 'leash', ts: 1000 }], drafts: []
});
A.eq(stale.hasReport, false, 'a decline BEFORE awaySince is out of scope → no report');

/* ---------- compose(): acts + drafts → the headline + act lines ---------- */
const acted = NR.compose({
  status: { active: true, binding: 'cooldown' },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: -300,
  ledger: [
    { source: 'nightshift', kind: 'act', ts: 2000 },
    { source: 'nightshift', kind: 'act', ts: 3000 }
  ],
  drafts: [
    { title: 'Refactor plan', at: 2000, body: 'the body', archetype: 'plan' },
    { title: 'Test outline', at: 3000, body: '', archetype: 'test' }
  ]
});
A.eq(acted.hasReport, true, 'acts present → hasReport:true');
A.eq(acted.actCount, 2, 'two acts counted');
A.ok(/2 jobs done/.test(acted.headline), 'headline names the jobs done');
A.ok(/2 drafts on your desk/.test(acted.headline), 'headline names the drafts on the desk');
A.eq(acted.actLines, ['✓ Refactor plan', '✓ Test outline'], 'one act line per draft, by real title');
A.eq(acted.idleReason, '', 'a night that ACTED has no idle sentence');
A.eq(acted.drafts.length, 2, 'drafts carried through for the "show me" reveal');

/* ---------- compose(): the honest DECLINED half — grouped by gate, LOCAL time ---------- */
const mixed = NR.compose({
  status: { active: true, binding: 'leash' },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: -300,
  ledger: [
    { source: 'nightshift', kind: 'act', ts: 2000 },
    { source: 'nightshift', kind: 'decline', binding: 'leash', ts: T0610Z },
    { source: 'nightshift', kind: 'decline', binding: 'leash', ts: T0610Z - 60000 }
  ],
  drafts: [{ title: 'Did a thing', at: 2000, body: 'x' }]
});
A.eq(mixed.declineCount, 2, 'two declines counted');
A.eq(mixed.declineLines.length, 1, 'two declines on the SAME gate collapse to one grouped line');
A.ok(/2 jobs skipped/.test(mixed.declineLines[0]), 'the decline line names the count');
A.ok(/job limit/i.test(mixed.declineLines[0]), 'the decline line names the binding gate');
A.ok(/by 1:10 AM/.test(mixed.declineLines[0]), 'the decline line names the LOCAL time of the last occurrence');

/* ---------- NS-5b: the report LEADS with the declared night FOCUS + its cited evidence ---------- */
const focused = NR.compose({
  status: { active: true, binding: null, focus: { kind: 'project', ref: 'C:/repo/alpha', label: 'alpha', source: 'evidence', why: ['you worked in alpha — last touched today (a git repo I can read + patch)'] } },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: 0,
  ledger: [{ source: 'nightshift', kind: 'act', ts: 2000 }],
  drafts: [{ title: 'patch: guard empty invoice list', at: 2000, body: 'diff' }]
});
A.ok(/^priority: alpha — because/.test(focused.priorityLine), 'the report leads with "priority: <focus> — because <evidence>"');
A.ok(focused.priorityLine.indexOf('worked in alpha') >= 0, 'the priority cites the evidence that produced it (truthful telemetry)');
const steered = NR.compose({
  status: { focus: { kind: 'project', ref: 'C:/repo/beta', label: 'beta', source: 'steer', why: ['you asked me to focus on beta'] } },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: 0,
  ledger: [{ source: 'nightshift', kind: 'decline', binding: 'leash', ts: 2000 }],
  drafts: []
});
A.ok(/you steered this/.test(steered.priorityLine), 'a steered focus says so in the lead');
const noFocus = NR.compose({ status: { active: true, binding: 'leash' }, awaySince: 1000, nowMs: 999999, ledger: [{ source: 'nightshift', kind: 'decline', binding: 'leash', ts: 2000 }], drafts: [] });
A.eq(noFocus.priorityLine, '', 'no declared focus ⇒ no fabricated priority line');

/* ---------- compose(): "did NOTHING and why" — one plain sentence from the dominant binding ---------- */
const idle = NR.compose({
  status: { active: true, binding: 'posture' },
  awaySince: 1000, nowMs: 999999, tzOffsetMin: 0,
  ledger: [
    { source: 'nightshift', kind: 'decline', binding: 'posture', ts: 2000 },
    { source: 'nightshift', kind: 'decline', binding: 'posture', ts: 3000 },
    { source: 'nightshift', kind: 'decline', binding: 'cooldown', ts: 4000 }
  ],
  drafts: []
});
A.eq(idle.actCount, 0, 'no acts → an idle night');
A.ok(idle.hasReport, 'an idle night with declines STILL reports (the honest "why nothing" half)');
A.ok(/Nothing landed on your desk/.test(idle.idleReason), 'idle sentence leads with nothing landing');
A.ok(/not allowed to act/i.test(idle.idleReason), 'idle sentence derives its reason from the DOMINANT binding (posture, 2×)');

// scoping: a non-nightshift ledger source (e.g. cron) never leaks into the night-shift report.
const cronOnly = NR.compose({
  status: null, awaySince: 1000, nowMs: 9999, tzOffsetMin: 0,
  ledger: [{ source: 'cron', kind: 'act', ts: 2000 }], drafts: []
});
A.eq(cronOnly.hasReport, false, 'a cron ledger entry is NOT a night-shift act (scoped by source)');

/* ---------- panelModel(): honest telemetry, no fake-zero ---------- */
const unreachable = NR.panelModel({ status: null, tzOffsetMin: 0 });
A.eq(unreachable.reachable, false, 'null status → reachable:false');
A.ok(/unreachable/i.test(unreachable.stateText), 'unreachable state says so plainly (never a fake 0/3)');

const panelOff = NR.panelModel({ status: { active: false, away: false, beatsUsedToday: 0, leashPerDay: 3, binding: 'present', lastBeatAt: 0, nextEligibleAt: 0 }, tzOffsetMin: -300 });
A.eq(panelOff.reachable, true, 'a real status → reachable:true');
A.eq(panelOff.stateText, 'OFF', 'inactive timer → OFF');
A.ok(/away/i.test(panelOff.why), 'OFF-because-present names the reason from the binding');
A.eq(panelOff.leashText, '0 of 3 jobs today', 'leash text is used of leash, honest');
A.eq(panelOff.lastBeatText, 'no job yet', 'no last job → honest "no job yet", not a fake time');

const panelActive = NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 2, leashPerDay: 3, binding: 'cooldown', lastBeatAt: T0610Z, nextEligibleAt: T0610Z + 2700000 }, tzOffsetMin: -300 });
A.ok(/ACTIVE/.test(panelActive.stateText), 'active + away → ACTIVE on watch');
A.eq(panelActive.leashText, '2 of 3 jobs today', 'leash reflects jobs used');
A.eq(panelActive.leashSpent, false, '2/3 is not spent');
A.eq(panelActive.lastBeatText, '1:10 AM', 'last beat renders in LOCAL time');
A.eq(NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 3, leashPerDay: 3 }, tzOffsetMin: 0 }).leashSpent, true, '3/3 → leashSpent:true');
// a null leashPerDay (never configured) must NOT render "used/null" — honest fallback.
A.eq(NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 1, leashPerDay: null }, tzOffsetMin: 0 }).leashText, '1 job today', 'null leash → "N jobs today" (singular-safe), never "1 of null"');

/* ---------- panelModel(): the durable E-STOP halt is VISIBLE and names its lift (EL-11 FIX 1) ----------
   Regression: status.halted landed but the panel ignored it — a durably-halted shift rendered
   "ACTIVE · standing by / NEXT ELIGIBLE <time>", affirmatively claiming a run the E-STOP guarantees won't happen. */
const panelHalted = NR.panelModel({ status: { active: true, away: false, halted: true, beatsUsedToday: 1, leashPerDay: 3, binding: 'halt', lastBeatAt: T0610Z, nextEligibleAt: T0610Z + 2700000 }, tzOffsetMin: -300 });
A.eq(panelHalted.reachable, true, 'a halted status is still reachable telemetry');
A.eq(panelHalted.halted, true, 'panelModel exposes the durable halt');
A.ok(/E-STOP/i.test(panelHalted.stateText) && /halted/i.test(panelHalted.stateText), 'the state names the halt (E-STOP), prominently');
A.ok(!/standing by|on watch/i.test(panelHalted.stateText), 'a halted shift NEVER claims "standing by"/"on watch"');
A.ok(/ON ITS OWN rung/.test(panelHalted.why) && /RESUME AUTOMATION in the top bar/.test(panelHalted.why), 'the halted why names WHICH controls lift it (an ON ITS OWN rung, or RESUME AUTOMATION — org P06)');
A.ok(/stopped|will not|won.t/i.test(panelHalted.why), 'the halted why says plainly the shift is stopped');
A.ok(!/\d{1,2}:\d{2}\s*(AM|PM)/.test(panelHalted.nextEligibleText), 'no NEXT ELIGIBLE clock while halted — the shift will NOT run at that time');
A.ok(/E-STOP|halt/i.test(panelHalted.nextEligibleText), 'the next-eligible slot says WHY there is no next time');
// the halt wins even when the timer is armed-and-away (the exact "ACTIVE · on watch" lie).
A.ok(!/standing by|on watch/i.test(NR.panelModel({ status: { active: true, away: true, halted: true, beatsUsedToday: 0, leashPerDay: 3 }, tzOffsetMin: 0 }).stateText), 'halted + away still renders the halt, never "on watch"');
// non-halted statuses stay exactly as before, and expose halted:false.
A.eq(panelActive.halted, false, 'a live status carries halted:false');
A.eq(panelOff.halted, false, 'an OFF status carries halted:false');
// org pass P09-a: binding 'posture' (dial on WAIT / SUGGEST) means no job runs at any time — NEXT JOB EARLIEST never names a clock
const panelPosture = NR.panelModel({ status: { active: false, away: false, beatsUsedToday: 0, leashPerDay: 3, binding: 'posture', lastBeatAt: 0, nextEligibleAt: T0610Z + 2700000 }, tzOffsetMin: -300 });
A.ok(!/\d{1,2}:\d{2}\s*(AM|PM)/.test(panelPosture.nextEligibleText) && /not scheduled/.test(panelPosture.nextEligibleText) && /WAIT or SUGGEST/.test(panelPosture.nextEligibleText), 'a posture-bound shift shows no next-job clock and names the dial as the reason');
A.ok(/\d{1,2}:\d{2}\s*(AM|PM)/.test(panelActive.nextEligibleText), 'a cooldown-bound shift still shows its real next-job clock');
// sweep/autonomy 2026-10-20: a SPENT LEASH is not cleared by the cooldown clock — it refills at the local midnight the
// status carries (leashResetsAt). And a gate no clock clears (budget, no provider, readiness…) has no next-job time.
const resetAt = T0610Z + 18 * 3600000;
const panelLeash = NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 3, leashPerDay: 3, binding: 'leash', lastBeatAt: T0610Z, nextEligibleAt: T0610Z + 2700000, leashResetsAt: resetAt }, tzOffsetMin: -300 });
A.ok(panelLeash.nextEligibleText.indexOf(NR.fmtLocalTime(T0610Z + 2700000, -300)) < 0, 'a leash-bound shift never names the cooldown clock as its next job');
A.ok(panelLeash.nextEligibleText.indexOf(NR.fmtLocalTime(resetAt, -300)) >= 0 && /limit/.test(panelLeash.nextEligibleText), 'it names the leash refill time and why: ' + panelLeash.nextEligibleText);
// a saved floor that cannot be proved right now holds an unattended BUILD before the leash is spent (saved-floor routing authority): plain words, and no clock clears it
A.ok(/saved floor/.test(NR.bindingPhrase('routing-held')) && !/routing-held gate/.test(NR.bindingPhrase('routing-held')), 'routing-held renders plain copy naming the saved floor, not raw gate jargon: ' + NR.bindingPhrase('routing-held'));
for (const binding of ['budget', 'spend-unknown', 'no-provider', 'readiness', 'precheck-error', 'routing-held', 'persist-failed']) {
  const p = NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 1, leashPerDay: 3, binding, lastBeatAt: T0610Z, nextEligibleAt: T0610Z + 2700000 }, tzOffsetMin: -300 });
  A.ok(!/\d{1,2}:\d{2}\s*(AM|PM)/.test(p.nextEligibleText) && /not scheduled/.test(p.nextEligibleText), binding + '-bound: no next-job clock a clock cannot clear (' + p.nextEligibleText + ')');
}

/* ---------- panelModel(): BUILD-vs-DRAFT mode + cold-start readiness honesty (2026-07-13) ----------
   Regression: at dial=free/sandbox with no away-workshop grant every beat silently degraded to a reason-only
   draft, and a cold dossier declined every beat for hours — with NOTHING on the panel saying so. */
const stBase = { active: true, away: true, beatsUsedToday: 0, leashPerDay: 3, binding: null, lastBeatAt: 0, nextEligibleAt: 0 };
const pmBuild = NR.panelModel({ status: Object.assign({}, stBase, { buildMode: 'build', draftReason: null, workshopGranted: true }), tzOffsetMin: 0 });
A.ok(/build/i.test(pmBuild.modeText), 'buildMode:build names real building');
A.eq(pmBuild.modeWarn, false, 'build mode is not a warning');
const pmNoGrant = NR.panelModel({ status: Object.assign({}, stBase, { buildMode: 'draft', draftReason: 'no-workshop-grant', workshopGranted: false }), tzOffsetMin: 0 });
A.ok(/drafts only/i.test(pmNoGrant.modeText) && /grant/i.test(pmNoGrant.modeText), 'the no-grant degrade says drafts-only AND names the missing grant');
A.eq(pmNoGrant.modeWarn, true, 'dial-promises-building-but-degraded IS a warning');
const pmReach = NR.panelModel({ status: Object.assign({}, stBase, { buildMode: 'draft', draftReason: 'reach' }), tzOffsetMin: 0 });
A.ok(/reach/i.test(pmReach.modeText), 'reach-gated draft mode names the REACH dial as the unlock');
A.eq(pmReach.modeWarn, false, 'reach-gated drafting is the Commander’s setting, not a warning');
A.eq(NR.panelModel({ status: stBase, tzOffsetMin: 0 }).modeText, '', 'an older sidecar without buildMode → empty modeText (never a guess)');
// readiness: cold/warm tiers explain BOTH grounding paths (current aims, or a recent run); hot / absent → no line.
// (bug 41b2d015) the bars are one aim / one run — the line names those, never an area count that no longer gates.
const rdWarm = { tier: 'warm', usableDims: ['pain', 'ambition'], goalsUsable: false, goalsStale: false, activityCount: 0, hotDimsMin: 1, hotRunsMin: 1 };
const pmWarm = NR.panelModel({ status: Object.assign({}, stBase, { binding: 'readiness', readiness: rdWarm }), tzOffsetMin: 0 });
A.ok(/has no aim it can act on yet/.test(pmWarm.readinessText) && /0 of 1 recent run;/.test(pmWarm.readinessText) && !/areas/.test(pmWarm.readinessText), 'readinessText shows the aims and runs against the grounding bars, no area count');
A.ok(/too old to act on/.test(NR.readinessText(Object.assign({}, rdWarm, { goalsStale: true }))), 'stale aims are named as too old, not as unknown');
// (41b2d015 review) the panel shows the stand-down WHY (the readiness binding phrase) right beside readinessText, and
// the morning report reuses the same phrase. It must be true in EVERY non-hot state, so it can never contradict the line
// beside it: nothing known (cold), a seed-only aim (a quick-setup chip), aims past the recency window, other areas only.
for (const [label, rd] of [
  ['cold', { tier: 'cold', usableDims: [], goalsUsable: false, goalsStale: false, activityCount: 0, hotDimsMin: 1, hotRunsMin: 1 }],
  ['seed-only aim', { tier: 'warm', usableDims: ['goals'], goalsUsable: false, goalsStale: false, activityCount: 0, hotDimsMin: 1, hotRunsMin: 1 }],
  ['stale aims', Object.assign({}, rdWarm, { goalsStale: true })],
  ['other areas only', rdWarm]
]) {
  const pm = NR.panelModel({ status: Object.assign({}, stBase, { binding: 'readiness', readiness: rd }), tzOffsetMin: 0 });
  A.eq(pm.why, NR.bindingPhrase('readiness'), label + ': the panel WHY is the readiness binding phrase');
  A.ok(/no current aim or recent run/.test(pm.why) && !/nothing of yours|doesn’t know/.test(pm.why), label + ': the WHY says no CURRENT aim or recent run — never "nothing of yours" or "doesn’t know"');
  A.ok(!/doesn’t know/.test(pm.readinessText) && !/I know what you want/.test(NR.readinessPlain(rd)), label + ': neither readiness line claims the station does not know what they want');
}
{
  const pmStale = NR.panelModel({ status: Object.assign({}, stBase, { binding: 'readiness', readiness: Object.assign({}, rdWarm, { goalsStale: true }) }), tzOffsetMin: 0 });
  A.ok(/too old to act on/.test(pmStale.readinessText) && /no current aim/.test(pmStale.why), 'stale panel: "aims too old" sits beside "no current aim" (they agree)');
}
A.eq(NR.panelModel({ status: Object.assign({}, stBase, { readiness: { tier: 'hot' } }), tzOffsetMin: 0 }).readinessText, '', 'hot readiness → no still-learning line');
A.eq(NR.panelModel({ status: stBase, tzOffsetMin: 0 }).readinessText, '', 'absent readiness detail → no line (never invented)');
// the new binding phrases are real sentences, not the forward-compat fallback.
A.ok(!/held back by/.test(NR.bindingPhrase('budget')), 'budget binding has a plain phrase');
A.ok(!/held back by/.test(NR.bindingPhrase('no-provider')), 'no-provider binding has a plain phrase');
// unknown spend history is NOT an exhausted budget: no resume or cap change clears it, so the phrase never offers one
A.ok(!/held back by|exhausted|raise the cap|resume/i.test(NR.bindingPhrase('spend-unknown')) && /SPENDING LIMITS/.test(NR.bindingPhrase('spend-unknown'))
  && NR.bindingPhrase('spend-unknown') !== NR.bindingPhrase('budget'), 'spend-unknown says history is unverifiable and points at SPENDING LIMITS');
A.ok(/verify|check/i.test(NR.bindingPhrase('precheck-error')) && /stood down safely/i.test(NR.bindingPhrase('precheck-error')), 'precheck-error explains the unproven safety read and safe stand-down in plain language');

/* ---------- trailLine(): one honest ledger row for the panel ---------- */
A.eq(NR.trailLine({ ts: T0610Z, kind: 'decline', binding: 'leash' }, -300), '1:10 AM · declined · today’s job limit was already used', 'a decline row: local time · declined · gate reason');
A.eq(NR.trailLine({ ts: T0610Z, kind: 'act', detail: { title: 'Wrote X' } }, -300), '1:10 AM · acted · Wrote X', 'an act row names the title from detail');
A.ok(/noted/.test(NR.trailLine({ ts: T0610Z, kind: 'note', reason: 'delivered' }, -300)), 'a note row renders its reason');

/* ---------- collapseTrail()/trailLines(): the per-tick decline spam collapses to one honest span (2026-07-15) ----------
   The driver records a decision every ~minute; the panel used to print 12 identical "declined · you were here"
   rows, which read as broken. Consecutive same-kind+binding rows collapse; acts NEVER collapse (each is real work). */
const M = 60000;
const spamTrail = [];   // newest-first: 12 present-declines a minute apart, then an act, then 2 leash-declines
for (let i = 0; i < 12; i++) spamTrail.push({ ts: T0610Z - i * M, kind: 'decline', binding: 'present' });
spamTrail.push({ ts: T0610Z - 12 * M, kind: 'act', detail: { title: 'Wrote X' } });
spamTrail.push({ ts: T0610Z - 13 * M, kind: 'decline', binding: 'leash' });
spamTrail.push({ ts: T0610Z - 14 * M, kind: 'decline', binding: 'leash' });
const collapsed = NR.collapseTrail(spamTrail);
A.eq(collapsed.length, 3, '12 present-declines + 1 act + 2 leash-declines → 3 rows');
A.eq(collapsed[0].count, 12, 'the present-decline span carries its true count');
A.eq(collapsed[0].ts, T0610Z, 'a span keeps the NEWEST ts');
A.eq(collapsed[0].spanFromTs, T0610Z - 11 * M, 'a span keeps the OLDEST ts as its start');
A.eq(collapsed[2].count, 2, 'the leash-decline pair collapses too');
const spamLines = NR.trailLines(spamTrail, -300);
A.ok(/×12/.test(spamLines[0]) && /–/.test(spamLines[0]), 'a span line shows a time RANGE and ×count');
A.eq(NR.trailLines([{ ts: T0610Z, kind: 'decline', binding: 'leash' }], -300)[0], NR.trailLine({ ts: T0610Z, kind: 'decline', binding: 'leash' }, -300), 'a single row renders exactly like trailLine (locked format)');
A.eq(NR.collapseTrail([{ ts: 1, kind: 'act', detail: { title: 'a' } }, { ts: 2, kind: 'act', detail: { title: 'b' } }]).length, 2, 'acts never collapse — each is a real piece of work');
A.eq(NR.collapseTrail(null).length, 0, 'a non-array trail → [] (fail-open)');

/* ---------- awayRuleText(): the plain-words away rule, with the REAL enforced threshold ---------- */
A.ok(/15 min/.test(NR.awayRuleText({ awayAfterMs: 900000 })), 'the rule states the sidecar-enforced threshold (15 min)');
A.ok(/clicks or keys/i.test(NR.awayRuleText({})), 'an older sidecar without the field still states the rule (no number, never a guess)');
A.ok(/leave the app running/i.test(NR.awayRuleText({ awayAfterMs: 900000 })), 'the rule kills the "app must be closed" misread head-on');
A.ok(NR.panelModel({ status: { active: true, away: false, beatsUsedToday: 0, leashPerDay: 3, awayAfterMs: 900000 }, tzOffsetMin: 0 }).awayRuleText.indexOf('15 min') >= 0, 'panelModel surfaces the away rule');

/* ---------- postureOutlook(): the honest dial-raise feedback (NS visibility 2026-07-13) ----------
   The instant the Commander raises the autonomy dial (awakening cadence beat / station panel), one honest line
   from the LIVE status says what a beat will actually do while they're away + how far the station is from acting. */
A.eq(NR.postureOutlook(null), '', 'unreachable status → no outlook (never a fabricated promise)');
A.eq(NR.postureOutlook({}), '', 'a status with no buildMode/readiness detail → no outlook');
// cold-start build pick with no away-workshop grant: it will only DRAFT, and it's still learning — say BOTH.
const outCold = NR.postureOutlook(Object.assign({}, stBase, { buildMode: 'draft', draftReason: 'no-workshop-grant', readiness: rdWarm }));
A.ok(/while you.re away/i.test(outCold), 'the outlook is framed as what happens WHILE AWAY');
A.ok(/draft small jobs, not build them/i.test(outCold) && /grant/i.test(outCold), 'a build pick that can only draft says so + names the missing grant');
A.ok(/LAST REPORT in SETTINGS › AUTONOMY/.test(outCold), 'draft mode names where the drafts really surface (LAST REPORT), not a desk');
// call #57 (org pass 10-14): a readiness hold reads as ONE plain reason, never a counter or an unlock ladder…
// (bug 41b2d015) …and it names the one thing that grounds a job, never "a few of your runs".
A.ok(/I’ll start once you tell me in your own words what you want help with, or I’ve seen one of your runs\./.test(outCold), 'the cold-start hold is one plain present-tense reason that names the requirement');
A.ok(!/a few/.test(outCold), 'the hold never asks for "a few" runs (no usage ladder)');
A.ok(!/\d+ of \d+/.test(outCold) && !/reaching either|lets it act|set REACH/i.test(outCold), 'the readout carries no N-of-M counter and no unlock instruction');
// …and the exact counts are never dropped: readinessText keeps them for SETTINGS › AUTONOMY and LAST REPORT.
A.ok(/still learning you/i.test(NR.readinessText(rdWarm)) && /0 of 1 recent run/.test(NR.readinessText(rdWarm)), 'readinessText still carries the exact N-of-M run count');
// P09 review fix: the counts line names a NECESSARY condition, never a promise — with the dial on WAIT / SUGGEST, clearing a
// bar does not make it act, and LAST REPORT shows this line with no dial context at all.
A.ok(/; to act on its own it needs either your current aims or 1 recent run$/.test(NR.readinessText(rdWarm)) && !/starts acting|once either|lets it act|one of those is complete|won’t act on its own before/i.test(NR.readinessText(rdWarm)), 'readinessText names the bar it needs — EITHER current aims or 1 recent run, never read as both (g1 P09 final round) — and never promises it will act once a bar clears');
A.eq(NR.readinessPlain({ tier: 'hot' }), '', 'a hot station has no hold-back reason');
// a fully-hot, granted build station: present tense, the real pace from leashPerDay, each job a new session in the rail.
const outBuild = NR.postureOutlook(Object.assign({}, stBase, { buildMode: 'build', draftReason: null, workshopGranted: true, readiness: { tier: 'hot' } }));
A.eq(outBuild, 'While you’re away I’ll do up to 3 small jobs a day; each arrives as a new session in your rail.', 'a granted, hot station says what it will do, at the status pace');
// (org P09/P31 wire) onboarding speaks postureOutlook in the Dialogue panel (VT323): no symbol glyph that falls back to another font
for (const st of [outBuild, outCold, NR.postureOutlook({ buildMode: 'build', leashPerDay: 7 }), NR.postureOutlook({ buildMode: 'draft', draftReason: 'no-workshop-grant' })]) {
  A.ok(!/[\u2600-\u27BF\u2B00-\u2BFF]/.test(st), 'the posture outlook carries no fallback-font symbol glyph: ' + JSON.stringify(st));
}
A.ok(/up to 7 small jobs a day/.test(NR.postureOutlook({ buildMode: 'build', leashPerDay: 7 })), 'the job count follows status.leashPerDay, never a fixed number');
A.ok(!/\d/.test(NR.postureOutlook({ buildMode: 'build', leashPerDay: null })), 'an unknown leashPerDay drops the number instead of inventing one');
A.ok(!/still learning|I’ll start once/i.test(outBuild), 'a hot station adds no still-learning caveat');
A.ok(/set REACH to LOCAL ONLY/.test(NR.modeText({ buildMode: 'draft', draftReason: 'reach' })), 'the panel MODE line names the REACH rung by its rendered label, LOCAL ONLY');
// a SUGGEST/WAIT pick (initiative below leash): the driver binds on 'posture', nothing ever runs unattended, so the
// readout promises nothing — even though buildMode reads 'draft'/'reach' and a cold station has readiness detail.
A.eq(NR.postureOutlook(Object.assign({}, stBase, { binding: 'posture', active: false, buildMode: 'draft', draftReason: 'reach', readiness: rdWarm })), '', 'a posture-bound (SUGGEST) status says nothing — no draft promise, no "I’ll start once"');
A.eq(NR.postureOutlook(outBuild) === outBuild, false, 'postureOutlook takes a status object, not its own string (sanity)');

/* ---------- unseenDrafts(): the live-session nudge predicate (NS visibility 2026-07-13) ----------
   "unseen" = a draft stamped strictly AFTER the durable lastSeenDraftAt mark; pure (no now), guards bad rows. */
const draftsFix = [
  { title: 'B', at: 3000, body: '' },
  { title: 'A', at: 2000, body: '' },
  { title: 'old', at: 1000, body: '' }
];
A.eq(NR.unseenDrafts(draftsFix, 1500).length, 2, 'drafts stamped after lastSeen are unseen; the older one is seen');
A.eq(NR.unseenDrafts(draftsFix, 1500)[0].title, 'B', 'unseen preserves the drafts route order (newest-first)');
A.eq(NR.unseenDrafts(draftsFix, 0).length, 3, 'a 0/absent stamp → every real draft is unseen (nothing surfaced yet)');
A.eq(NR.unseenDrafts(draftsFix, 3000).length, 0, 'a stamp at/after the newest draft → nothing unseen (strictly greater-than)');
A.eq(NR.unseenDrafts([{ at: 9000 }, { title: '', at: 9000 }, null], 0).length, 0, 'rows without a title (or null) are never counted as an unseen draft');
A.eq(NR.unseenDrafts(null, 0).length, 0, 'a non-array drafts payload → [] (fail-open, never throws)');

/* ---------- purity / determinism ---------- */
const args = { status: { active: true, binding: 'leash' }, awaySince: 1000, nowMs: 5, tzOffsetMin: 0, ledger: [{ source: 'nightshift', kind: 'decline', binding: 'leash', ts: 2000 }], drafts: [] };
A.eq(NR.compose(args), NR.compose(args), 'compose() is deterministic for the same input');

A.report('nightreport.test');
