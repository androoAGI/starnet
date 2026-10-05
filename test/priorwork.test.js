/* node test/priorwork.test.js — the night shift REMEMBERS its earlier builds (2026-10-05 audit item 1).

   Live data showed "Playable parkour prototype" built 3x and a speedrun timer 3x (12 backlog items, 9 built, 0
   decided) because each night saw only tonight's drafts. Proves the pure priorwork.js:
     · collect(): 14-day window, statuses (undecided/kept/discarded/queued/failed/drafted), where the files live,
       focus scoping (a recorded other-focus item is excluded; legacy un-scoped items are kept), pending wins over a
       stale lifecycle row for the same run, a build's desk copy is not double-listed
     · similarity(): normalized-token Jaccard; iteration words ("continue", "v2", "improved") don't make work different
     · veto(): a near-duplicate (≥0.6) of an UNDECIDED build is converted to "Continue: <it>" with continueOf → the
       NEWEST such build; a near-duplicate of kept/discarded/queued/failed work is DROPPED; unrelated work passes;
       two candidates continuing one build collapse to one; a continuation of a continuation stays one level deep
     · the directives render the block + the no-rebuild rule; the do directive carries the continue block
     · the host wiring (index.js) feeds both paths and enforces the veto before selection */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const PW = require('../sidecar/priorwork.js');
const AP = require('../frontend/app/autopilot.js');

const DAY = 86400000, NOW = 1760000000000;

const backlog = [
  { id: 'ns-act-r1', title: 'Playable parkour prototype', ts: NOW - 5 * DAY, builtRunId: 'r1', builtAt: NOW - 5 * DAY, focusRef: 'C:/code/parkour' },
  { id: 'ns-act-r2', title: 'Playable parkour prototype v2', ts: NOW - 3 * DAY, builtRunId: 'r2', builtAt: NOW - 3 * DAY },          // legacy: no focusRef
  { id: 'ns-act-r3', title: 'Speedrun timer overlay', ts: NOW - 2 * DAY },                                                          // queued
  { id: 'ns-act-r4', title: 'Tax spreadsheet', ts: NOW - 1 * DAY, builtRunId: 'r4', builtAt: NOW - DAY, focusRef: 'C:/code/taxes' },  // other focus
  { id: 'ns-act-r5', title: 'Ancient thing', ts: NOW - 30 * DAY, builtRunId: 'r5', builtAt: NOW - 30 * DAY },                      // out of window
  { id: 'ns-act-r6', title: 'Level select menu', ts: NOW - DAY, attempts: 2 }                                                       // failed
];
const deliverables = [
  { agentId: 'agent', runId: 'r7', title: 'Ghost replay recorder', status: 'kept', createdAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY, summary: 'records runs' },
  { agentId: 'agent', runId: 'r8', title: 'Wall-run physics', status: 'discarded', createdAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY },
  { agentId: 'agent', runId: 'r1', title: 'Playable parkour prototype', status: 'kept', createdAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY },   // stale row; r1 is pending again
  { agentId: 'other', runId: 'r9', title: 'Other agent work', status: 'kept', createdAt: NOW - DAY, updatedAt: NOW - DAY }
];
const drafts = [
  { title: 'Level design notes', at: NOW - 2 * DAY },
  { title: 'Playable parkour prototype v2', at: NOW - 3 * DAY, wrote: { path: 'workshop/r2/index.html' } }   // a build's desk copy
];

(function collects() {
  const list = PW.collect({ backlog, deliverables, drafts, agentId: 'agent', focusRef: 'C:\\code\\parkour', now: NOW });
  const titles = list.map(p => p.title + ':' + p.status);
  A.ok(titles.indexOf('Playable parkour prototype:undecided') >= 0, 'an undecided build on this focus is listed');
  A.ok(titles.indexOf('Playable parkour prototype v2:undecided') >= 0, 'a legacy un-scoped build is listed (over-include, never miss)');
  A.ok(titles.indexOf('Speedrun timer overlay:queued') >= 0, 'a queued item is listed');
  A.ok(titles.indexOf('Level select menu:failed') >= 0, 'a twice-failed item is listed');
  A.ok(titles.indexOf('Ghost replay recorder:kept') >= 0, 'a kept build is listed');
  A.ok(titles.indexOf('Wall-run physics:discarded') >= 0, 'a discarded build is listed');
  A.ok(titles.indexOf('Level design notes:drafted') >= 0, 'a reason-only desk draft is listed');
  A.ok(!titles.some(t => /Tax spreadsheet/.test(t)), 'a build recorded under ANOTHER focus is excluded');
  A.ok(!titles.some(t => /Ancient thing/.test(t)), 'builds older than 14 days are excluded');
  A.ok(!titles.some(t => /Other agent work/.test(t)), "another agent's deliverables are excluded");
  A.eq(list.filter(p => p.runId === 'r1').length, 1, 'a live pending item supersedes a stale lifecycle row for the same run');
  A.eq(list.filter(p => /parkour prototype v2/.test(p.title)).length, 1, "a build's desk copy is not double-listed");
  A.eq(list.find(p => p.runId === 'r2').where, 'workshop/r2/', 'where the files live is named');
  A.ok(list.every((p, i) => i === 0 || list[i - 1].at >= p.at), 'newest first');
  const lines = PW.promptLines(list, NOW);
  A.ok(lines.some(l => /^"Playable parkour prototype v2" — UNDECIDED — built, waiting on your review \(3d ago\) — files: workshop\/r2\/$/.test(l)), 'prompt line: title, status, when, where');
})();

(function similarityRules() {
  A.ok(PW.similarity('Playable parkour prototype', 'Playable parkour prototype v2') === 1, 'version markers do not make work different');
  A.ok(PW.similarity('Continue: Playable parkour prototype', 'Playable parkour prototype') === 1, '"Continue:" does not make work different');
  A.ok(PW.similarity('Parkour prototype — playable demo', 'Playable parkour prototype') >= 0.6, 'reworded near-duplicate ≥ 0.6');
  A.ok(PW.similarity('Speedrun timer', 'Ghost replay recorder') === 0, 'unrelated titles score 0');
  A.eq(PW.similarity('', ''), 0, 'empty titles never match');
})();

(function vetoes() {
  const prior = PW.collect({ backlog, deliverables, drafts, agentId: 'agent', focusRef: 'C:/code/parkour', now: NOW });
  const cands = [
    { title: 'Playable parkour prototype', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' },
    { title: 'Parkour prototype, playable', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' },
    { title: 'Ghost replay recorder', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' },
    { title: 'Wall-run physics', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' },
    { title: 'Speedrun timer overlay', archetype: 'advance-goal', grounds: 'g', confidence: 'high', spec: 's' },
    { title: 'Checkpoint system', archetype: 'advance-goal', grounds: 'g', confidence: 'medium', spec: 's' }
  ];
  const v = PW.veto(cands, prior);
  const out = v.candidates.map(c => c.title);
  A.eq(out, ['Continue: Playable parkour prototype v2', 'Checkpoint system'], 'dup of undecided → continue (once); dups of kept/discarded/queued dropped; new work passes');
  const cont = v.candidates[0].continueOf;
  A.eq(cont.runId, 'r2', 'the continuation targets the NEWEST matching undecided build');
  A.eq(cont.where, 'workshop/r2/', 'and names where its files live');
  A.eq(v.continued.length, 2, 'both re-proposals of the prototype were converted (then collapsed to one)');
  A.eq(v.dropped.map(d => d.status).sort(), ['discarded', 'kept', 'queued'], 'drops name what they duplicated');
  A.eq(cands[0].title, 'Playable parkour prototype', 'input candidates are not mutated');
  const again = PW.veto([{ title: 'Continue: Continue: Playable parkour prototype v2' }], prior);
  A.eq(again.candidates[0].title, 'Continue: Playable parkour prototype v2', 'a continuation of a continuation stays one level deep');
  A.eq(PW.veto(cands, []).candidates.length, cands.length, 'no prior work → nothing vetoed');
  // modes: a text draft is not a build; kept work may be EXPLICITLY continued, never plainly rebuilt.
  const draftPrior = [{ title: 'Level design notes', status: 'drafted', at: NOW - DAY, runId: '', where: 'desk draft' }];
  A.eq(PW.veto([{ title: 'Level design notes' }], draftPrior).candidates[0].title, 'Level design notes', 'build path: building what a draft described is not vetoed');
  const dv = PW.veto([{ title: 'Level design notes' }, { title: 'Level-design notes' }], draftPrior, { mode: 'draft' });
  A.eq(dv.candidates.map(c => c.title), ['Continue: Level design notes'], 'draft path: a re-proposed draft becomes one continuation of it');
  const keptPrior = [{ title: 'Ghost replay recorder', status: 'kept', at: NOW - DAY, runId: 'r7', where: 'workshop/r7/' }];
  A.eq(PW.veto([{ title: 'Ghost replay recorder' }], keptPrior).candidates.length, 0, 'a plain rebuild of kept work is dropped');
  const kc = PW.veto([{ title: 'Continue: Ghost replay recorder' }], keptPrior).candidates;
  A.ok(kc.length === 1 && kc[0].continueOf && kc[0].continueOf.runId === 'r7', 'an explicit "Continue:" of kept work is honored as a continuation');
})();

(function directives() {
  const eligible = AP.ARCHETYPES.slice(0, 2);
  const priorBuilds = ['"Playable parkour prototype v2" — UNDECIDED — built, waiting on your review (3d ago) — files: workshop/r2/'];
  for (const fn of ['buildCandidateDirective', 'buildCandidateDirectiveV2']) {
    const d = AP[fn]({ beliefs: {}, activity: ['a'], eligible, focusHeader: "TONIGHT'S FOCUS: parkour", priorBuilds });
    A.ok(/ALREADY BUILT ON EARLIER NIGHTS/.test(d) && d.indexOf(priorBuilds[0]) >= 0, fn + ' lists earlier nights\' builds');
    A.ok(/NO REBUILDS/.test(d) && /Prefer continuing the newest UNDECIDED build/.test(d), fn + ' adds the no-rebuild rule');
    A.ok(!/NO REBUILDS/.test(AP[fn]({ beliefs: {}, activity: ['a'], eligible })), fn + ': no prior builds → no rule');
  }
  const dd = AP.buildDoDirectiveV2({ title: 'Continue: Playable parkour prototype v2' }, { runId: 'r10', dir: 'workshop/r10',
    continueFrom: { title: 'Playable parkour prototype v2', where: 'workshop/r2/', files: ['index.html', 'game.js'], summary: 'a one-level demo', seeded: true } });
  A.ok(/CONTINUE, DO NOT RESTART/.test(dd) && /ALREADY COPIED into "workshop\/r10\/"/.test(dd), 'the build directive says the files are seeded into the new dir');
  A.ok(/its files: index\.html, game\.js/.test(dd) && /a one-level demo/.test(dd), 'and lists the files + summary');
  const d1 = AP.buildDoDirective({ title: 'Continue: notes' }, { continueFrom: { title: 'Level design notes', where: 'desk draft' } });
  A.ok(/Extend and improve that earlier draft/.test(d1), 'the reason-only do directive continues a draft too');
})();

(function hostWiring() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/const priorVeto = PriorWork\.veto\(candidates, priorWork, \{ mode: 'draft' \}\);/.test(src), 'the reason-only path runs the veto in draft mode');
  A.ok(/const priorVeto = PriorWork\.veto\(candidates, priorWork\);/.test(src), 'the build path runs the veto in build mode');
  A.eq((src.match(/Autopilot\.scoreAndSelect\(priorVeto\.candidates/g) || []).length, 2, 'selection only sees vetoed candidates');
  A.ok(/priorTonight, priorBuilds \}\)/.test(src) && /priorTonight, priorBuilds, projectSnapshot/.test(src), 'both propose directives get the prior-builds block');
  A.ok(/if \(!queued \|\| queued\.reason !== 'added'\) return \{ delivered: false, reason: 'duplicate-backlog' \};/.test(src), 'an already-queued title stands down instead of building an orphan');
  A.ok(/seedContinueDir\(agentId, continueOf\.runId, runId\)/.test(src), 'a continuation seeds its dir from the earlier build');
  A.ok(/out\.priorWork = /.test(src), 'status exposes the prior-work view');
})();

A.report('priorwork.test');
