/* node test/autopilot.test.js — the PURE idle self-direction engine (autonomy Slice A).
   Locks the two things the floor behaviour hinges on: the readiness TIER (the confidence floor, read from the
   confirmed-only dossier) and the DECISION (ceiling-vs-earned: act only when the dial permits AND the tier is hot,
   else earn context and name what's binding). Deterministic — an injected clock, no Date.now. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const Autopilot = require('../frontend/app/autopilot.js');

const t = 1700000000000;                             // a fixed "now" (realistic epoch ms — larger than the stale window)
const fresh = () => [{ text: 'x', createdAt: t, updatedAt: t }];

/* ---------- idleFor ---------- */
A.eq(Autopilot.idleFor(t + Autopilot.DEFAULT_IDLE_MS, t, Autopilot.DEFAULT_IDLE_MS), true, 'idle once the span elapsed');
A.eq(Autopilot.idleFor(t + 1000, t, 5000), false, 'not idle before the span');
A.eq(Autopilot.idleFor(NaN, t, 5000), false, 'a bad clock is never idle (fail safe)');

/* ---------- readiness tiers ---------- */
// THE ACT FLOOR IS GROUNDING, NOT BREADTH (bug 41b2d015): hot = a usable GROUNDED aim (goals, the keystone; never a
// seed) or one recent run. It used to be goals + 4 areas or 4 runs.
let rd = Autopilot.readiness({ known: [], familiarity: 0 }, {}, t, {});
A.eq(rd.tier, 'cold', 'nothing known → cold (nothing to ground a job on)');

rd = Autopilot.readiness({ known: ['stack'], familiarity: 1 / 7 }, { stack: fresh() }, t, {});
A.eq(rd.tier, 'warm', 'areas known but no goals → warm (knows something, not yet what they want — never acts)');

rd = Autopilot.readiness({ known: ['goals'], familiarity: 1 / 7 }, { goals: fresh() }, t, {});
A.eq([rd.tier, rd.groundedBy], ['hot', 'dossier'], 'a grounded goals belief alone → hot (a chosen posture acts on the aims the Commander gave)');

// ONLY CONFIRMED BELIEFS CROSS THE ACTING LINE (review of 41b2d015; AUTONOMY_DRIVER_PLAN §2 trust line; dossier.js
// WEIGHTS): a goals area held only by SEEDS — the quick-setup chip's canned purpose, a thin run, a doc copy — is known
// breadth, never grounding to act. The station's shared V3 verdict says "no direction" there; the act floor agrees.
const D_earn = (r) => { const x = Autopilot.decide({ enabled: true, idle: true, actsUnattended: true, tier: r.tier }); return [x.mode, x.binding]; };
const seedGoals = () => [{ text: 'Help me write, debug, and ship software.', weight: 'seed', createdAt: t, updatedAt: t }];
rd = Autopilot.readiness({ known: ['goals'], familiarity: 1 / 7 }, { goals: seedGoals() }, t, {});
A.eq([rd.tier, rd.goalsUsable, rd.goalsStale, rd.usableDims], ['warm', false, false, ['goals']], 'a seed-only goals area → warm, not hot (a canned line is not an aim; never reported stale)');
rd = Autopilot.readiness(
  { known: ['goals', 'identity', 'standing_orders'], familiarity: 3 / 7 },
  { goals: seedGoals(), identity: [{ text: 'solo founder', weight: 'seed' }], standing_orders: [{ text: 'never push', weight: 'seed' }] }, t, {});
A.eq(rd.tier, 'warm', 'three doc-seeded areas still never reach hot (seeds never add up to grounding)');
A.eq(D_earn(rd), ['earn', 'confidence'], 'an acting dial over a seed-only station EARNS (the curiosity branch still fires), CONFIDENCE binding');
rd = Autopilot.readiness({ known: ['goals'], familiarity: 1 / 7 }, { goals: seedGoals().concat([{ text: 'ship the pricing page', weight: 'synth', createdAt: t, updatedAt: t }]) }, t, {});
A.eq([rd.tier, rd.goalsUsable], ['hot', true], 'a seed beside a grounded aim → hot (the grounded belief carries it)');
['stated', 'synth', 'observed'].forEach(w => {
  A.eq(Autopilot.readiness({ known: ['goals'] }, { goals: [{ text: 'ship it', weight: w, createdAt: t, updatedAt: t }] }, t, {}).tier, 'hot', 'a ' + w + ' goals belief grounds acting');
});
A.eq(Autopilot.readiness({ known: ['goals'] }, { goals: [{ text: 'ship it', weight: null }] }, t, {}).tier, 'hot', 'a legacy belief with no weight is inferred non-seed (dossier.js weightOf), never a seed by guess');
// a fresh seed must not make stale real aims look current
const staleAt = t - (Autopilot.STALE_MS + 1);
rd = Autopilot.readiness({ known: ['goals'] }, { goals: [{ text: 'ship the beta', weight: 'stated', createdAt: staleAt, updatedAt: staleAt }].concat(seedGoals()) }, t, {});
A.eq([rd.tier, rd.goalsUsable, rd.goalsStale], ['warm', false, true], 'stale grounded aims beside a fresh seed → not hot, reported stale (the seed is no freshness)');
A.eq(Autopilot.readiness({ known: ['goals'] }, { goals: seedGoals() }, t, { activityCount: 1 }).groundedBy, 'activity', 'a seed-only dossier + one real run → hot, grounded by the RUN');

rd = Autopilot.readiness(
  { known: ['goals', 'stack', 'pain', 'identity'], familiarity: 4 / 7 },
  { goals: fresh(), stack: fresh(), pain: fresh(), identity: fresh() }, t, {});
A.eq(rd.tier, 'hot', 'goals + more areas → still hot (breadth is no longer a bar)');

// recency: a goals belief older than the stale window is no longer usable → drops back below the floor.
const old = t - (Autopilot.STALE_MS + 1);
rd = Autopilot.readiness(
  { known: ['goals', 'stack', 'pain', 'identity'], familiarity: 4 / 7 },
  { goals: [{ text: 'x', createdAt: old, updatedAt: old }], stack: fresh(), pain: fresh(), identity: fresh() }, t, {});
A.eq(rd.goalsUsable, false, 'a stale goals belief is not usable grounding');
A.eq(rd.staleDims, ['goals'], 'the stale keystone is reported as stale (the status names it)');
A.eq(rd.tier, 'warm', 'stale keystone → not hot even with breadth (recency gates acting)');

// an UNDATED belief (legacy/seeded, pre-timestamps) counts as fresh — never punish an old save.
rd = Autopilot.readiness({ known: ['goals', 'stack'], familiarity: 2 / 7 }, { goals: [{ text: 'x' }], stack: [{ text: 'y' }] }, t, {});
A.eq(rd.tier, 'hot', 'undated beliefs are treated as fresh (no staleness penalty for old saves)');
A.eq([Autopilot.HOT_MIN, Autopilot.ACTIVITY_HOT_MIN], [1, 1], 'the published hot bars are one aim / one run (the status route reports them)');

/* ---------- decide: the ceiling-vs-earned matrix ---------- */
const D = Autopilot.decide;
A.eq(D({ enabled: false, idle: true, tier: 'hot', actsUnattended: true }).mode, 'none', 'WAIT (disabled) → none, ever — regardless of confidence');
A.eq(D({ enabled: true, idle: false, tier: 'hot', actsUnattended: true }).mode, 'none', 'active (not idle) → none');
A.eq(D({ enabled: true, idle: true, tier: 'cold', actsUnattended: false }).mode, 'earn', 'enabled + idle + cold → earn (learn first)');

let d = D({ enabled: true, idle: true, tier: 'hot', actsUnattended: true });
A.eq([d.mode, d.binding], ['act', null], 'idle + hot + dial-permits-acting → ACT, nothing binding');

d = D({ enabled: true, idle: true, tier: 'hot', actsUnattended: false });
A.eq([d.mode, d.binding], ['earn', 'dial'], 'knows them well but dial is propose-only → earn, the DIAL is binding (legible)');

d = D({ enabled: true, idle: true, tier: 'warm', actsUnattended: true });
A.eq([d.mode, d.binding], ['earn', 'confidence'], 'dial permits acting but not-yet-confident → earn, CONFIDENCE is binding (the flywheel)');

d = D({ enabled: true, idle: true, tier: 'hot', actsUnattended: true, budgetLeft: 0 });
A.eq([d.mode, d.binding], ['earn', 'budget'], "permitted + confident but today's leash spent → earn, BUDGET is binding");

/* ---------- A2: the anti-slop selection pipeline ---------- */
// eligibility follows the usable dims
const elig = Autopilot.eligibleArchetypes(['goals', 'stack']);
A.eq(elig.map(a => a.id).sort(), ['advance-goal', 'maintain-extend', 'prep-next', 'scout'], 'eligible archetypes follow usable dims (goals→advance/prep/maintain, stack→scout; no pain→no kill-pain)');
A.eq(Autopilot.eligibleArchetypes([]).length, 0, 'no usable dims → no eligible archetypes (nothing to ground a job in)');

// grounded(): the structural anti-slop floor
A.eq(Autopilot.grounded('ship the StarNet beta', ['ship the StarNet beta to 100 users']), true, 'grounds that is a substring of a belief → grounded');
A.eq(Autopilot.grounded('migrate the billing system', ['ship the StarNet beta', 'reduce churn']), false, 'grounds with no overlap → not grounded (invented)');
A.eq(Autopilot.grounded('grow the StarNet community', ['ship the StarNet beta to users']), true, 'a shared significant token (starnet) → grounded (tolerates paraphrase)');

// parseCandidates + the GROUNDING VETO
const b2 = { goals: ['ship the StarNet beta to 100 users'], pain: ['manual release notes eat my fridays'] };
const eligAll = Autopilot.eligibleArchetypes(['goals', 'pain', 'stack']);
const reply = [
  'JOB: Draft the beta launch checklist', 'KIND: advance-goal', 'GROUNDS: ship the StarNet beta to 100 users', 'CONFIDENCE: high', 'SPEC: a step-by-step pre-launch checklist', '',
  'JOB: Draft release-notes template', 'KIND: kill-pain', 'GROUNDS: manual release notes eat my fridays', 'CONFIDENCE: medium', 'SPEC: a reusable release-notes template', '',
  'JOB: Rewrite your database layer', 'KIND: advance-goal', 'GROUNDS: migrate everything to Postgres', 'CONFIDENCE: high', 'SPEC: a migration plan'
].join('\n');
const cands = Autopilot.parseCandidates(reply, { eligible: eligAll, beliefs: b2 });
A.eq(cands.length, 2, 'the grounding veto drops the candidate whose GROUNDS is invented (not in the dossier)');
A.eq(cands[0].archetype, 'advance-goal', 'a surviving candidate carries its kind');
A.eq(cands[1].confidence, 'medium', 'confidence is parsed');
A.eq(Autopilot.parseCandidates('JOB: x\nKIND: scout\nGROUNDS: ship the StarNet beta\nCONFIDENCE: high\nSPEC: y', { eligible: Autopilot.eligibleArchetypes(['goals']), beliefs: b2 }).length, 0, 'a KIND outside the eligible set is dropped (no scout without usable stack)');

// scoreAndSelect + the CONFIDENCE GATE
const pick = Autopilot.scoreAndSelect(cands);
A.eq([pick.selected.archetype, pick.reason], ['advance-goal', 'selected'], 'the highest-confidence candidate is selected');
const tie = [{ title: 'a', archetype: 'kill-pain', grounds: 'g', confidence: 'high', spec: 's' }, { title: 'b', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' }];
A.eq(Autopilot.scoreAndSelect(tie).selected.archetype, 'advance-goal', 'a confidence tie breaks by the fixed order (advance › kill-pain)');
A.eq(Autopilot.scoreAndSelect([{ title: 'a', archetype: 'scout', grounds: 'g', confidence: 'low', spec: 's' }]).selected, null, 'all-low candidates → selected null (the confidence gate: idle-doing-nothing beats slop)');
A.eq(Autopilot.scoreAndSelect([]).reason, 'no-candidates', 'no candidates → no-candidates');

// the directives carry the constraints; parseDeliverable reads the run output
const cd = Autopilot.buildCandidateDirective({ beliefs: b2, eligible: eligAll });
A.ok(/no tools/i.test(cd) && /GROUNDED/i.test(cd) && /CONFIDENCE/i.test(cd), 'the candidate directive constrains to grounded, reason/draft-only, confidence-rated output');
const dd = Autopilot.buildDoDirective(cands[0], { name: 'NOVA' });
A.ok(/TITLE:/i.test(dd) && /no tools/i.test(dd), 'the do directive demands a titled draft, reason/draft only');
const del = Autopilot.parseDeliverable('TITLE: Beta launch checklist\n1. Freeze the build\n2. Tag the release', { fallbackTitle: 'x' });
A.eq(del.title, 'Beta launch checklist', 'deliverable title is parsed from the TITLE line');
A.ok(/Freeze the build/.test(del.body), 'deliverable body is the rest after the title');
A.eq(Autopilot.parseDeliverable('', { fallbackTitle: 'x' }), null, 'an empty run output yields no deliverable');
A.eq(Autopilot.parseDeliverable('just a draft, no title line', { fallbackTitle: 'Fallback' }).title, 'Fallback', 'a missing TITLE falls back to the selected job title');

/* ---------- A3: self-critique + digest + the learn bias ---------- */
A.eq(Autopilot.parseCritique('VERDICT: ship\nNOTE: good').verdict, 'ship', 'critique ship is parsed');
A.eq(Autopilot.parseCritique('VERDICT: drop\nNOTE: not worth it').verdict, 'drop', 'critique drop is parsed');
A.eq(Autopilot.parseCritique('garbage, no verdict line').verdict, 'ship', 'a format miss fails OPEN to ship (never lose good work over a parse)');
const cr = Autopilot.parseCritique('VERDICT: revise\nNOTE: tightened it\nTITLE: Tighter checklist\n1. do x\n2. do y', { fallbackTitle: 'x' });
A.eq([cr.verdict, cr.revised.title], ['revise', 'Tighter checklist'], 'a revise verdict carries the corrected draft');
A.ok(/do x/.test(cr.revised.body), 'the revised body is parsed');
const qd = Autopilot.buildCritiqueDirective({ title: 'T', body: 'B' }, { title: 'Job', spec: 'a checklist' }, { style: 'terse', standingOrders: 'cite sources' });
A.ok(/VERDICT/.test(qd) && /terse/.test(qd) && /cite sources/.test(qd) && /a checklist/.test(qd), 'the critique directive carries the spec + style + standing orders + the verdict format');
A.eq(Autopilot.digestLines([{ title: 'A' }, { title: 'B' }, { nope: 1 }]), ['▸ A', '▸ B'], 'digestLines is one line per titled draft (composed from the log)');
// the LEARN bias sways a tie but never the gate
const tieLearn = [{ title: 'a', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' }, { title: 'b', archetype: 'kill-pain', grounds: 'g', confidence: 'high', spec: 's' }];
A.eq(Autopilot.scoreAndSelect(tieLearn).selected.archetype, 'advance-goal', 'without learning, a tie breaks by fixed order (advance)');
A.eq(Autopilot.scoreAndSelect(tieLearn, { weights: { 'kill-pain': 0.5 } }).selected.archetype, 'kill-pain', 'a learned preference (within the cap) wins a confidence tie');
A.eq(Autopilot.scoreAndSelect([{ title: 'a', archetype: 'scout', grounds: 'g', confidence: 'low', spec: 's' }], { weights: { scout: 0.5 } }).selected, null, 'a learn bias never promotes a low-confidence idea through the gate (gate reads RAW confidence)');

/* ---------- B2: write path / gate / file body ---------- */
A.eq(Autopilot.writePath('Beta Launch Checklist!'), 'drafts/beta-launch-checklist.md', 'writePath slugs the title deterministically under drafts/');
A.eq(Autopilot.writePath(''), 'drafts/draft.md', 'writePath falls back to draft.md on an empty title');
A.eq(Autopilot.writePath('   ***   '), 'drafts/draft.md', 'writePath falls back when the title has no alnum');
A.eq(/^drafts\/[a-z0-9-]+\.md$/.test(Autopilot.writePath('A '.repeat(60))), true, 'writePath is always a safe relative drafts/*.md path (clamped, no escape)');
A.eq(Autopilot.canWrite({ granted: true, cabinetPlaced: true }), true, 'canWrite needs BOTH the grant + a placed cabinet');
A.eq(Autopilot.canWrite({ granted: true, cabinetPlaced: false }), false, 'granted but no cabinet → no write (object=capability; draft-only)');
A.eq(Autopilot.canWrite({ granted: false, cabinetPlaced: true }), false, 'cabinet but no grant → no write (consent missing)');
A.eq(Autopilot.canWrite({}), false, 'canWrite defaults closed');
A.eq(Autopilot.fileBody({ title: 'Hi', body: 'line one' }), '# Hi\n\nline one\n', 'fileBody = H1 title + body');
A.eq(Autopilot.fileBody({ body: '  x  ' }), '# Draft\n\nx\n', 'fileBody defaults the title + trims');
A.eq(Autopilot.digestLines([{ title: 'W', wrote: { path: 'drafts/w.md' } }]), ['✎ W'], 'digestLines marks a WRITTEN deliverable distinctly (✎)');

/* ---------- B3: digest summary (files written + undo target) ---------- */
{
  const batch = [
    { title: 'Beta checklist', at: 10, wrote: { path: 'drafts/beta-checklist.md', snapshot: 'S1' } },
    { title: 'Some notes', at: 20 },                                                   // a desk draft (no file)
    { title: 'Release plan', at: 30, wrote: { path: 'drafts/release-plan.md', snapshot: 'S2' } }
  ];
  const sum = Autopilot.digestSummary(batch);
  A.eq([sum.wroteCount, sum.draftCount], [2, 1], 'digestSummary splits written files from desk drafts');
  A.eq(sum.wrote.map(w => w.path), ['drafts/beta-checklist.md', 'drafts/release-plan.md'], 'written entries carry their paths');
  A.eq(sum.undoSnapshot, 'S1', 'undoSnapshot is the EARLIEST write pre-snapshot (reverts ALL away-writes)');
  A.eq(sum.drafted.map(d => d.title), ['Some notes'], 'drafts (no file) are listed separately');
}
A.eq(Autopilot.digestSummary([]).undoSnapshot, null, 'no writes → no undo target');
A.eq(Autopilot.digestSummary([{ title: 'x', wrote: { path: 'p' } }]).undoSnapshot, null, 'a write with no snapshot id yields no undo target (honest)');
A.eq(Autopilot.digestHeadline({ wroteCount: 2, draftCount: 1 }), '2 files written + 1 draft on your desk', 'headline reads files + drafts');
A.eq(Autopilot.digestHeadline({ wroteCount: 1, draftCount: 0 }), '1 file written', 'headline singular file, no drafts');
A.eq(Autopilot.digestHeadline({ wroteCount: 0, draftCount: 1 }), '1 draft on your desk', 'headline draft-only');
A.eq(Autopilot.digestHeadline({}), 'nothing to report', 'empty headline is honest');

/* ---------- NS-3: the tool-capable V2 directives + the shared LEARN transform ---------- */
// the V2 candidate directive: same tagged output contract (so parseCandidates works verbatim) but BUILD-shaped —
// asks for a real artifact, allows tools/research, forbids send/publish/spend.
const cd2 = Autopilot.buildCandidateDirectiveV2({ beliefs: b2, eligible: eligAll });
A.ok(/GROUNDED/i.test(cd2) && /CONFIDENCE/i.test(cd2) && /JOB:/.test(cd2), 'V2 candidate keeps the grounded, confidence-rated, tagged contract (parseCandidates-compatible)');
A.ok(/artifact/i.test(cd2) && /(sandbox|workshop|local)/i.test(cd2), 'V2 candidate asks for a REAL artifact built locally in the sandbox');
A.ok(!/NO tools/i.test(cd2) && /(send|publish|spend)/i.test(cd2), 'V2 candidate does NOT forbid tools, but DOES forbid send/publish/spend');
// parseCandidates + the grounding veto work UNCHANGED on a V2-style reply (proof the contract is reused).
const cands2 = Autopilot.parseCandidates(reply, { eligible: eligAll, beliefs: b2 });
A.eq(cands2.length, 2, 'the grounding veto still drops the invented candidate on the V2 path (same parser)');

// the V2 do directive: instructs a real jailed BUILD under the run dir + a deliverable.json manifest (workshop schema).
const dd2 = Autopilot.buildDoDirectiveV2(cands2[0], { runId: 'run-xyz', dir: 'workshop/run-xyz', backlogId: 'ns-act-run-xyz' });
A.ok(/deliverable\.json/.test(dd2) && /workshop\/run-xyz\//.test(dd2), 'V2 do directive demands a manifest + writes under the run dir');
A.ok(/"backlogId":\s*"ns-act-run-xyz"/.test(dd2), 'V2 do directive threads the backlogId into the manifest shape');
A.ok(/(never send|LOCAL ONLY|not.*publish|spend)/i.test(dd2), 'V2 do directive keeps the local-only (no send/publish/spend) rule');
// FORMAT-FIT LAW (2026-07-17, root cause of dashboard-for-everything): the deliverable format must
// match the ask — the HTML tool is the exception, never the default. Locked in BOTH away-work
// personas: the V2 directive (executed here) and the sidecar workshop prompt (source-locked below).
A.ok(/MATCH THE FORMAT TO THE ASK/.test(dd2), 'V2 do directive carries the format-fit ladder');
A.ok(/NEVER default to a dashboard/.test(dd2), 'V2 do directive forbids the dashboard default');
A.ok(!/Prefer a SELF-CONTAINED/.test(dd2), 'the old prefer-HTML-tool line is gone from the V2 directive');
A.ok(/ZERO SETUP/.test(dd2), 'the zero-setup / one-click-Open law survives the format-fit rewrite');
{
  const sidecarSrc = readSidecarSource();
  const wp = sidecarSrc.slice(sidecarSrc.indexOf('function workshopPrompt'), sidecarSrc.indexOf('function workshopPrompt') + 4000);
  A.ok(/MATCH THE FORMAT TO THE ASK/.test(wp) && /NEVER default to a dashboard/.test(wp) && !/Prefer a SELF-CONTAINED/.test(wp),
    'the workshop-shift persona carries the same format-fit ladder (and dropped the prefer-HTML default)');
}

// the shared LEARN transform: fold verdicts, derive the capped bias — the SAME math the frontend AutopilotStore uses.
let L = {};
L = Autopilot.learnFold(L, 'advance-goal', true);
L = Autopilot.learnFold(L, 'advance-goal', true);
L = Autopilot.learnFold(L, 'scout', false);
A.eq([L['advance-goal'].up, L['advance-goal'].down], [2, 0], 'learnFold tallies approvals (up)');
A.eq([L.scout.up, L.scout.down], [0, 1], 'learnFold tallies denials (down)');
const W = Autopilot.learnWeightsFrom(L);
A.eq(W['advance-goal'], 0.5, 'a net +2 up-weights to the cap (+0.5)');
A.eq(W.scout, -0.25, 'a net -1 down-weights (-0.25)');
// the cap holds even at extreme tallies (learning sways ties, never the confidence gate).
let Lx = {}; for (let i = 0; i < 20; i++) Lx = Autopilot.learnFold(Lx, 'kill-pain', true);
A.eq(Autopilot.learnWeightsFrom(Lx)['kill-pain'], 0.5, 'the up-weight is capped at +0.5 no matter how many approvals');
A.eq(Autopilot.learnWeightsFrom(null).constructor, Object, 'learnWeightsFrom is tolerant of a null/absent store');
// the learned weight actually flips a confidence tie via scoreAndSelect (deny→down, approve→up move selection).
const tie2 = [{ title: 'a', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' }, { title: 'b', archetype: 'scout', grounds: 'g', confidence: 'high', spec: 's' }];
A.eq(Autopilot.scoreAndSelect(tie2, { weights: Autopilot.learnWeightsFrom(Autopilot.learnFold(Autopilot.learnFold({}, 'scout', true), 'scout', true)) }).selected.archetype, 'scout', 'approvals of scout up-weight it enough to win a tie against the default-order winner');

/* ---------- NS-2: activity-as-grounding readiness + the extended grounding veto + the activity directive block ---------- */

// (a) READINESS folds a SECOND grounding path: recent user-run activity. A brand-new (empty) dossier with a real
//     recent run reaches hot — the run is citable evidence of their work (bug 41b2d015: one run, not four).
let rdA = Autopilot.readiness({ known: [], familiarity: 0 }, {}, t, { activityCount: 0 });
A.eq(rdA.tier, 'cold', 'empty dossier + no activity → cold (nothing to ground on)');
rdA = Autopilot.readiness({ known: [], familiarity: 0 }, {}, t, { activityCount: 1 });
A.eq([rdA.tier, rdA.groundedBy], ['hot', 'activity'], 'empty dossier + ONE recent run → HOT on activity alone (no usage bar)');
rdA = Autopilot.readiness({ known: ['stack'], familiarity: 1 / 7 }, { stack: fresh() }, t, { activityCount: 1 });
A.eq([rdA.tier, rdA.groundedBy], ['hot', 'activity'], 'a warm (no-goals) dossier + one run → hot, grounded BY the run');
// the dossier path stands alone when there is no activity (activity never DISCOUNTS the dossier).
rdA = Autopilot.readiness({ known: ['goals', 'stack', 'pain', 'identity'], familiarity: 4 / 7 }, { goals: fresh(), stack: fresh(), pain: fresh(), identity: fresh() }, t, { activityCount: 0 });
A.eq([rdA.tier, rdA.groundedBy], ['hot', 'dossier'], 'a dossier with aims is hot on its own; groundedBy names dossier');
// a tie with real activity names activity, so a goals-only dossier beside a recent run keeps every archetype the run
// can ground (the old goals-only + 4-run station was activity-grounded; dropping the bars must not narrow it).
rdA = Autopilot.readiness({ known: ['goals'], familiarity: 1 / 7 }, { goals: fresh() }, t, { activityCount: 3 });
A.eq([rdA.tier, rdA.groundedBy], ['hot', 'activity'], 'aims + recent runs → hot, grounded by activity (all archetypes stay open to the veto)');
A.eq(Autopilot.readiness({ known: [] }, {}, t, {}).tier, 'cold', 'no activityCount at all → pure dossier path (unchanged)');

// (b) ELIGIBILITY opens to ALL archetypes when the grounding is activity (candidates cite a run/chat line, not a dim).
A.eq(Autopilot.eligibleArchetypes([], { activityGrounded: true }).length, Autopilot.ARCHETYPES.length, 'activity-grounded → all archetypes eligible (the veto, not the dim map, keeps it honest)');
A.eq(Autopilot.eligibleArchetypes([]).length, 0, 'without the flag, empty dims → no eligible archetypes (unchanged)');

// (c) the GROUNDING VETO evidence pool extends to activity lines: an activity-grounded candidate SURVIVES, invented dies.
const activityLines = ['Ship the StarNet beta (yesterday)', '"help me automate release notes" (2d ago)'];
const vetoReply = [
  'JOB: Continue the beta ship',
  'KIND: advance-goal',
  'GROUNDS: Ship the StarNet beta',            // cites a RECENT RUN line, NOT a dossier belief
  'CONFIDENCE: high',
  'SPEC: a checklist',
  '',
  'JOB: Invented busywork',
  'KIND: advance-goal',
  'GROUNDS: reorganize the quarterly taxonomy widgets',   // grounded in NOTHING (not belief, not activity)
  'CONFIDENCE: high',
  'SPEC: nope'
].join('\n');
// with EMPTY beliefs, the only evidence is the activity pool:
const vetoCands = Autopilot.parseCandidates(vetoReply, { eligible: Autopilot.ARCHETYPES, beliefs: {}, activity: activityLines });
A.eq(vetoCands.length, 1, 'the activity-grounded candidate survives; the invented one dies (veto over beliefs+activity)');
A.eq(vetoCands[0].title, 'Continue the beta ship', 'the surviving candidate is the one grounded in a real recent run');
// without the activity pool, the same real candidate would have NO evidence and also die (proves activity is what saved it):
A.eq(Autopilot.parseCandidates(vetoReply, { eligible: Autopilot.ARCHETYPES, beliefs: {} }).length, 0, 'with no beliefs AND no activity, even the real candidate dies (activity is the load-bearing evidence)');

// (d) the DIRECTIVE carries the recent-activity block + the "continue their work" rule, only when there IS activity.
const cdAct = Autopilot.buildCandidateDirective({ beliefs: b2, activity: activityLines, eligible: eligAll });
A.ok(/worked on recently/i.test(cdAct) && /Ship the StarNet beta/.test(cdAct), 'the candidate directive renders the recent-activity block with dated lines');
A.ok(/CONTINUE THEIR WORK/i.test(cdAct), 'with activity present, the directive adds the continue/unblock/extend rule');
const cdNoAct = Autopilot.buildCandidateDirective({ beliefs: b2, eligible: eligAll });
A.ok(!/worked on recently/i.test(cdNoAct) && !/CONTINUE THEIR WORK/i.test(cdNoAct), 'with NO activity, no activity block + no continue rule (never invites fabrication)');
// the V2 (build) directive carries it too.
const cd2Act = Autopilot.buildCandidateDirectiveV2({ beliefs: b2, activity: activityLines, eligible: eligAll });
A.ok(/worked on recently/i.test(cd2Act) && /CONTINUE THEIR WORK/i.test(cd2Act), 'the V2 build directive also carries the recent-activity block + continue rule');

// token-burn audit 2026-10-17: no night-shift build prompt claims the act CANNOT run commands (false whenever the bay has a
// terminal: the act wrote its report first and verify-on-stop bought a second pass). All three say: if you have a shell, check first.
{
  const src = readSidecarSource();
  const body = name => src.slice(src.indexOf('function ' + name), src.indexOf('function ' + name) + 6000);
  for (const [label, text] of [['buildDoDirectiveV2', Autopilot.buildDoDirectiveV2({ title: 't' }, { runId: 'r' })], ['workshopPrompt', body('workshopPrompt')], ['implementPrompt', body('implementPrompt')]]) {
    const prompt = text.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');   // source comments may quote the old line
    A.ok(!/CANNOT run commands|cannot run commands/.test(prompt), label + ' never claims the act cannot run commands');
    A.ok(/If you have a shell, CHECK the work BEFORE you write the manifest/.test(text), label + ' tells a shell-holding act to check before the manifest');
  }
}

A.report('autopilot.test');
