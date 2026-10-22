/* sidecar/goal-advance.js — the PURE engine that lets the SIDECAR move the Commander's plan forward.

   WHY THIS EXISTS — the goal tree lives in the webview (frontend/app/goalstore.js) and the sidecar only held a
   one-line summary of it (goal text, done/total, the next step). Quest refresh mints quests bound to that next
   step (goalId + milestoneId), and the contract sweeps complete them with the window closed — but nothing ever
   told the plan the step was finished. The mirror kept naming the same step, the next refresh planned it
   again, and the progress bar never moved. This module closes that loop with two pure reads:

     · slateFinished(goal, quests) — every quest planned for the CURRENT step is resolved (none open) and at
       least one of them was actually completed by its contract. That is the step's evidence: the station
       planned the step as a set of verifiable quests and every one of them is settled. A slate that was only
       dismissed proves nothing and never advances.
     · overlay(goal, doneKeys) — fold the durable journey's recorded milestone completions onto the mirrored
       tree and recompute done/total/pct and the next open step. The journey ledger is the monotonic truth, so
       a stale push from a webview that has not seen the completion yet can never walk the plan backwards.

   A finished plan step is evidence of work, never proof the life goal happened (journey-store's rule): the
   goal stays active until the Commander confirms its success condition. No Date.now / fs / network here — the
   host (sidecar/index.js) injects the stores and the clock. */
'use strict';

const MILESTONE_CAP = 100;
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// the mirrored milestone list: [{ id, text, status:'open'|'done' }], junk dropped, bounded.
function normMilestones(arr) {
  return (Array.isArray(arr) ? arr : []).map(m => {
    const id = clip(m && m.id, 80);
    return id ? { id, text: clip(m.text, 140), status: m.status === 'done' ? 'done' : 'open' } : null;
  }).filter(Boolean).slice(0, MILESTONE_CAP);
}

// the journey key a completed milestone is recorded under (journey-store: 'milestone:' + goalId + ':' + milestoneId).
function milestoneKey(goalId, milestoneId) { return clip(goalId, 64) + ':' + clip(milestoneId, 80); }

// fold recorded completions onto the tree and recompute the summary fields the refresh + cron personas read.
// A goal without a mirrored milestone list (an older webview's summary-only push) is returned unchanged.
function overlay(goal, doneKeys) {
  if (!goal || typeof goal !== 'object' || !Array.isArray(goal.milestones) || !goal.milestones.length) return goal;
  const keys = doneKeys instanceof Set ? doneKeys : new Set(doneKeys || []);
  const milestones = goal.milestones.map(m => Object.assign({}, m, {
    status: (m.status === 'done' || keys.has(milestoneKey(goal.id, m.id))) ? 'done' : 'open'
  }));
  const done = milestones.filter(m => m.status === 'done').length;
  // honour the Commander's chosen next step while it is still open; otherwise the first open step in order.
  const next = milestones.find(m => m.id === goal.milestoneId && m.status === 'open') || milestones.find(m => m.status === 'open') || null;
  return Object.assign({}, goal, {
    milestones, done, total: milestones.length, pct: Math.round(done * 100 / milestones.length),
    next: next ? next.text : null, milestoneId: next ? next.id : null
  });
}

// is the current step's quest slate finished? Returns the evidence to record, or null.
function slateFinished(goal, quests) {
  if (!goal || !goal.id || !goal.milestoneId || !Array.isArray(goal.milestones)) return null;
  const step = goal.milestones.find(m => m.id === goal.milestoneId && m.status === 'open');
  if (!step) return null;
  const slate = (Array.isArray(quests) ? quests : []).filter(q => q && q.goalId === goal.id && q.milestoneId === step.id);
  if (!slate.length || slate.some(q => q.status === 'open')) return null;
  const done = slate.filter(q => q.status === 'done');
  if (!done.length) return null;   // an all-dismissed slate is a rejected plan, not a finished step
  // WHO settled it, honestly: a slate completed only by quests the Commander reported (attest) is their word, not
  // a harness proof — the journey renders that as "You confirmed", a mechanical contract as "Agent OS recorded".
  const byCommander = done.every(q => q.contract && q.contract.type === 'attest');
  return {
    goalId: goal.id, milestoneId: step.id, milestoneText: step.text,
    authority: byCommander ? 'commander-confirmed' : 'harness-contract',
    questIds: done.map(q => q.id),
    evidence: clip('Every quest planned for this step is settled; completed by contract: ' + done.map(q => q.title).join('; '), 1000)
  };
}

module.exports = { overlay, slateFinished, normMilestones, milestoneKey, MILESTONE_CAP };
