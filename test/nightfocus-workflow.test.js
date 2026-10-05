/* node test/nightfocus-workflow.test.js — REPEATED WORK becomes a night-focus candidate (2026-10-05 audit item 2).

   workflow-takeover.js already proves "the Commander asked for this on ≥3 separate days and no routine covers it";
   the night focus ignored that. Proves the pure resolver's kind:'workflow' candidate:
     · scored by frequency × recency (3 asks today ≈ a project touched today; 6 asks outrank it; a stale one doesn't)
     · why-lines cite the evidence: the count on separate days + the Commander's own wording
     · evidence-or-null: count < 3, no quote, or undated → not a candidate (never an unexplained pick)
     · the focus survives the state round-trip as kind 'workflow' (not coerced to 'project')
     · a declared steer still outranks it; the host-side contract (nightFocusInputs passes `workflows`, a workflow
       focus is reconciled against the live takeover candidates) is wired in sidecar/index.js */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const F = require('../sidecar/nightfocus.js');

const DAY = 86400000, HOUR = 3600000;
const T0 = Math.floor(1700000000000 / DAY) * DAY + 8 * HOUR;
const wf = (over) => Object.assign({ id: 'workflow-aaaaaaaaaaaaaaaaaaaaaaaa', name: "Summarize today's AI news", count: 3, lastAt: T0 - HOUR,
  quotes: ['give me a rundown of the AI news', "summarize today's AI news"] }, over || {});
const project = { root: 'C:/repo/alpha', displayPath: 'C:/repo/alpha', lastTouchedAt: T0 - 2 * HOUR, isGitRepo: true };

(function workflowAloneDeclares() {
  const f = F.resolveFocus({ workflows: [wf()] }, { now: T0 });
  A.ok(f && f.kind === 'workflow', 'a repeated workflow is declared as the focus when it is the only evidence');
  A.eq(f.ref, 'workflow-aaaaaaaaaaaaaaaaaaaaaaaa', 'its ref is the takeover id');
  A.ok(/asked for this 3 times on separate days/.test(f.why[0]), 'why cites the count on separate days');
  A.ok(f.why.some(w => w.indexOf("in your words: \"summarize today's AI news\"") === 0), 'why quotes the newest wording');
  A.ok(f.why.some(w => /earlier: "give me a rundown/.test(w)), 'a reworded earlier ask is cited too');
  A.ok(/TONIGHT'S FOCUS: Summarize today's AI news — because you asked for this 3 times/.test(F.focusLine(f)), 'focusLine leads with it');
})();

(function frequencyTimesRecency() {
  const three = F.resolveFocus({ projects: [project], workflows: [wf({ count: 3 })] }, { now: T0 });
  A.eq(three.kind, 'project', '3 asks do not outrank a project touched 2h ago');
  const six = F.resolveFocus({ projects: [project], workflows: [wf({ count: 6 })] }, { now: T0 });
  A.eq(six.kind, 'workflow', '6 asks on separate days outrank a project touched 2h ago');
  const stale = F.resolveFocus({ projects: [project], workflows: [wf({ count: 6, lastAt: T0 - 25 * DAY })] }, { now: T0 });
  A.eq(stale.kind, 'project', 'a habit last asked 25 days ago does not outrank fresh work');
  const goalOnly = F.resolveFocus({ goal: { text: 'launch the beta' }, workflows: [wf({ count: 4 })] }, { now: T0 });
  A.eq(goalOnly.kind, 'workflow', '4 recent asks outrank a bare goal arc');
})();

(function evidenceOrNull() {
  A.eq(F.resolveFocus({ workflows: [wf({ count: 2 })] }, { now: T0 }), null, 'count < 3 → not a candidate');
  A.eq(F.resolveFocus({ workflows: [wf({ quotes: [] })] }, { now: T0 }), null, 'no quote of their words → not a candidate');
  A.eq(F.resolveFocus({ workflows: [wf({ lastAt: 0 })] }, { now: T0 }), null, 'undated → not a candidate');
  A.eq(F.resolveFocus({ workflows: [wf({ name: '' })] }, { now: T0 }), null, 'unnamed → not a candidate');
})();

(function roundTripAndSteer() {
  const r = F.ensureFocus(F.fresh(T0), { workflows: [wf()] }, { now: T0 });
  const back = F.loadEnvelope(JSON.stringify(F.toEnvelope(r.state, T0)), T0);
  A.eq(back.focus && back.focus.kind, 'workflow', 'kind workflow survives the persisted round-trip');
  const steered = F.resolveFocus({ workflows: [wf({ count: 6 })], steer: { ref: 'C:/repo/alpha', kind: 'project', setAt: T0 - HOUR } }, { now: T0 });
  A.eq(steered.source, 'steer', 'a fresh steer still outranks repeated-work evidence');
})();

(function hostContract() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/return \{ projects, threads, goal, quests, northStar, topics, workflows, now \};/.test(src), 'nightFocusInputs hands the resolver `workflows`');
  A.ok(/workflowTakeoverCandidates\(true\)/.test(src.slice(src.indexOf('function nightFocusWorkflows'))), 'workflows come from the takeover candidates (which exclude scheduled work)');
  A.ok(/target\.kind === 'workflow'\) return nightFocusWorkflows\(\)\.some/.test(src), 'a workflow focus retires once it is scheduled / no longer live evidence');
})();

A.report('nightfocus-workflow.test');
