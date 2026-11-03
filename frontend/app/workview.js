/* One presentation of existing work. No task store, counters, or inferred success. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const rows = v => Array.isArray(v) ? v : [];
  const text = v => typeof v === 'string' ? v : '';
  // a run with no verdict, in its outcome's own words (RunOutcome.look: a question waits on you, a stop was someone's, the rest did not finish)
  function endStatus(oc) {
    const look = RunOutcome.look(oc);
    if (look.tone === 'ask') return 'Asked you a question — answer it in the conversation';
    if (look.tone === 'stop') return 'Stopped before it finished — review the conversation';
    if (look.tone === 'bad') return 'Run failed — review the conversation';
    return 'Did not finish (' + look.word + ') — review the conversation';
  }
  function project(input) {
    input = input || {};
    const artifacts = rows(input.deliverables).filter(r => r && r.status !== 'discarded');
    const linked = new Set();
    const items = rows(input.streams).filter(s => s && !s.archived && (s.kind === 'task' || rows(s.runIds).length)).map(s => {
      const channel = input.channels && input.channels[s.id];
      const files = artifacts.filter(a => a.streamId === s.id || (a.runId && rows(s.runIds).includes(a.runId)));
      files.forEach(a => linked.add(a.id));
      let bucket = 'planned', status = 'Not started';
      if (channel && channel.busy) {
        bucket = channel.pending ? 'needs-you' : 'doing';
        status = channel.pending ? 'Waiting for your decision' : channel.runId ? 'Working' : 'Connecting';
      } else if (s.lastRunOk === false) {
        // review 9: lastRunOk false is a FAILED run's alone (a stop is no verdict): it read "Run stopped or failed"
        bucket = 'needs-you'; status = 'Run failed — review the conversation';
      } else if (files.some(a => a.status === 'failed' || a.status === 'pending')) {
        bucket = 'needs-you'; status = files.some(a => a.status === 'failed') ? 'Output failed — review details' : 'Output waiting for your review';
      } else if (s.lane === 'shipped') {
        bucket = 'finished'; status = 'Marked shipped by you';
      } else if (s.lastRunOk === true) {
        bucket = 'finished'; status = 'Run completed — review result';
      } else if (s.lastRunReason && typeof RunOutcome !== 'undefined') {
        // review 9: a run that neither succeeded nor failed (no verdict, its OUTCOME the word the board files) says itself — a question, a stop
        // and a run that did not finish each read "Run outcome is unconfirmed"
        bucket = 'needs-you'; status = endStatus(RunOutcome.ofWord(s.lastRunReason).outcome);
      } else if (rows(s.runIds).length) {
        bucket = 'needs-you'; status = 'Run outcome is unconfirmed';
      }
      return { id: 'stream:' + s.id, streamId: s.id, title: text(s.title) || 'Untitled work', agentId: s.agentId,
        bucket, status, at: Number(s.lastActiveAt) || 0, projectRoot: text(s.projectRoot), artifacts: files, stream: s };
    });
    for (const a of artifacts) {
      if (linked.has(a.id)) continue;
      const needs = a.status === 'pending' || a.status === 'failed';
      items.push({ id: 'artifact:' + a.id, streamId: a.streamId || null, title: text(a.title) || 'Saved output',
        agentId: a.agentId, bucket: needs ? 'needs-you' : 'finished',
        status: a.status === 'failed' ? 'Build failed — review details' : a.status === 'pending' ? 'Output waiting for review' : 'Saved output',
        at: Number(a.updatedAt || a.createdAt || a.at) || 0, artifacts: [a] });
    }
    items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return { items, suggestions: rows(input.discovery).filter(r => r && r.id && r.quote),
      doing: items.filter(x => x.bucket === 'doing'), planned: items.filter(x => x.bucket === 'planned'),
      needsYou: items.filter(x => x.bucket === 'needs-you'), finished: items.filter(x => x.bucket === 'finished') };
  }
  // a routine's failed last run reads as the outcome the station recorded (RunOutcome.line: "the reply was cut short"), never its bare
  // end word (review 5.1: a cut fire's record read "Last run: done"); a record with no outcome keeps its own reason
  function lastRunSaid(job) {
    const RO = typeof RunOutcome !== 'undefined' ? RunOutcome : null;
    if (RO && RO.isOutcome(job.lastOutcome) && job.lastOutcome !== 'succeeded') return RO.line({ outcome: job.lastOutcome, failureCode: text(job.lastFailureCode) });
    return text(job.lastReason) || 'failed';
  }
  function routineView(job, scheduler) {
    job = job || {};
    const state = typeof scheduler === 'object' && scheduler ? scheduler : {enabled:scheduler};
    const shared = state.scheduler;
    const eligible = shared ? !shared.held : state.enabled === true && !state.halted && !state.degraded;
    const healthy = eligible && (!state.health || state.health.healthy === true);
    const held = shared ? shared.held : state.halted ? 'halted' : state.degraded ? 'degraded' : !state.enabled ? 'off' : null;
    return { id: text(job.id), title: text(job.name) || 'Recurring work',
      status: job.inFlight === true ? 'Working' : held === 'halted' ? 'Stopped by E-STOP' : held === 'degraded' ? 'Scheduler storage needs recovery' : job.enabled === false ? 'Paused' : healthy ? 'Scheduled' : (shared ? shared.enabled : state.enabled) ? 'Scheduler health unconfirmed' : 'Scheduler paused',
      next: Object.prototype.hasOwnProperty.call(job, 'nextFireAt') ? text(job.nextFireAt) : job.enabled !== false && healthy ? text(job.nextRunAt) : '',
      last: job.lastRunAt ? (job.lastStatus === 'ok' ? 'Last run completed' : 'Last run: ' + lastRunSaid(job)) : 'Has not run yet',
      agentId: job.agentId, recipeId: job.meta && job.meta.recipeId || null };
  }
  function stationView(journey) {
    if (!journey || !journey.evolution) return { known: false, name: 'YOUR STATION', reason: 'Waiting for verified progress', outcomes: [], receipts: [] };
    const outcomes = rows(journey.outcomes).filter(o => o && o.sourceId && o.evidence && o.verifiedBy);
    const latest = outcomes.slice().sort((a, b) => b.at - a.at)[0];
    return { known: true, name: text(journey.evolution.name) || 'YOUR STATION',
      goalsReached: Number(journey.evolution.goalsReached) || 0,
      reason: latest ? text(latest.title) : 'Real outcomes will leave their mark here',
      outcomes: outcomes.slice().reverse(), receipts: rows(journey.receipts).filter(r => r && !r.dismissedAt) };
  }
  return { project, routineView, stationView };
});
