/* sidecar/routing/line-runner.js — THE ONE HOP EXECUTOR (line-job-runner lane, 2026-11-03).

   A work line's later stages used to run through four copies of one body: the channel hub's (every chat, and the sample, webhook
   and SEND TO hubs), the scheduled fire's and Run Now's in index.js, and the step-through test's runDock. Each kept its own sink, its
   own run options and its own idea of when a stage counts. They are profiles of this one executor now.

     makeLineRunner({ runOnce, chain?, liveRuns?, now?, newId?, jobs?, emit?, runRow? })
       -> { hopRunner, runLineJob, stopNote, chain, profiles, open, get, track, mark, settle, preview, outcomeOf, deliverCrate, stop, reap }
       hopRunner(profile)            -> runAgent(h): runs ONE stage. h is chain.js's hop call { agentId, dockId?, text, hop, from,
                                        signal, workitemId, ceilingUsd, parallel?, lineId? }; the step test's runDock adds { entry,
                                        sessionId, runId, edited, preview, fromDock, streamId }.
                                        -> { text, usd, error, stopped, stopCode, runId, workitemId, tools, denied, ms }: text is the
                                        stage's returned TERMINAL text when it counts (hopVerdict below), else ''
       runLineJob({ job?, seed, profile }) -> chain.advance(seed) with hopRunner(profile) as its runAgent — the one chain.advance call.
                                        With a job (open below) every hop it runs is kept on the job (its run id and verdict, for the
                                        settle) and the seed carries the job's id (SEND TO links the sending job by it). It never
                                        settles: only the entry knows how its job ended (a newer message, a STOP, the reply).
       stopNote(line)                -> the stop note under a line's answer (chain.js's one wording)
     deps: runOnce (the host's run), chain (the floor-bound chain.js runner), liveRuns { add(runId, rec) -> release } (the host's
     exact run-table admission; legacy injected registries may supply remove(runId)), now() and newId(). It keeps no clock and mints no ids of its own (the determinism law).
     The JOB BOOK (makeJobBook below, the same object) adds: jobs { start, finish, get, mark?, all? } (LineJobs through the host's
     store — absent: jobs are settled but no record is kept), emit (the floor's event bus: the OUTBOX crate), runRow(runId) (the run's
     durable row). open({ id?, line, entry, text, streamId, name?, retryOf?, from?, handedIn?, stopHandle? }) returns one live handle;
     settle(handle, { line?, runs?, output?, stop?, stopCode?, stopped?, stopCause?, onLine?, error?, refusedSaid? }) returns its one
     result. Only a result whose rows succeeded and whose walk reached an actual OUTBOX can deliverCrate(result, payload).
     THE HOLD (line-hold lane, S3): with jobs.hold(id, 0, continuation) (the host's verified writer) and hold { originOf(record, facts),
     planHash(), receiptFor(file) } a walk that stops AT A GATE for a person is saved as a held continuation on its own job (parkLine)
     before anyone settles it. Settling a PARKED job finishes nothing and releases nothing: its result is { held: true, delivered: false,
     outcome 'blocked' }, and only the saved record owns the job from there, across a restart. A hold that cannot be saved exactly
     leaves the old terminal blocked stop, with the reason said (line.holdFailed, in the stop's own sentence).
     THE RESUME (line-hold lane, S4): a held job is decided by a person and carried on by ONE owner, routing/line-resume.js. This module gives
     it three doors and no more: openResumed (a handle on a job whose decision is claimed — open() still refuses a held job like any settled
     one), runResumed (runLineJob for the restored walk, every PAID hop bracketed by a durable intent written first, under a run id minted
     first, and its observed result written after) and settleResumed (the saved end: terminal_pending, the strict finish, the release, the
     publication confirmed); parkResumed saves a second hold, forget lets go of a handle whose end could not be written.

   A PROFILE is what differs between entries. Only the factories below build one (profiles.channel / schedule / manual / steptest),
   so a test builds a hop exactly as the host does, with fakes only at runOnce. BY CONSTRUCTION, whatever a profile says, a hop is a
   task on the autonomous surface (isTask, surface 'autonomous', reflect), opts out of its stream's resume seed (resumeSeed false: the
   hand-off carries the upstream work), runs under what is left of the line's $ ceiling (ceilingUsd), starts tainted as upstream
   output (initialTaint; a step test's ENTRY step is stage one and starts clean), runs ungranted (unattendedGrants []: a grant names
   ONE agent and never flows down a belt), and carries its line, bay and crate on its run row. Every hop's run options are built here
   and nowhere else. A hop has NO history unless its profile carries one: only a real chat's (the channel profile on a bindChats hub)
   does, and that history is the EARLIER jobs of the chat, read once per job and dock, so a loop-back carries the draft once. */
'use strict';
const RunOutcome = require('../../frontend/app/runoutcome.js');
const TurnView = require('../turn-view.js');
const { hopError, lineStop, hopStopCode } = require('./line-fire.js');
const crypto = require('node:crypto');
const { note: failNote } = require('../failopen.js');
const { isAgentId } = require('../respond.js');
const { holdOf } = require('./saved-hold.js');   // a hop's room or brief read off a saved floor that cannot be proved right now: said as that, never swallowed
const { mergeFiles, productOf } = require('./work-product.js');
const LineHold = require('./line-hold.js');

const UPSTREAM_TAINT = 'upstream agent output';
const FAULT_SAID = 'the station hit an internal fault and stopped this run';   // index.js hopStoppedSaid's fault words
const say = (o, name, payload) => { try { o(name, payload); } catch (e) { failNote('line-runner.tap', e); } };   // a telemetry tap never fails the hop
const sha = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');   // a digest of what a stage was handed / handed back (the resumed hop's saved receipts)

/* THE ONE SUCCESS RULE. A hop counts only when runOnce's RETURN says reason 'done' with non-empty terminal text and its outcome is
   'succeeded' — the lead's outcome runOnceCore stamps on its result (a Task Brief question returns 'done' while its end says
   'clarifying'). The hop's own END on the sink only narrows it (an older station's unstamped return), and decides a run that returned
   NOTHING (stopped while queued, a throw, a refusal before it ran): a 'cancelled' end is a stop, anything else is no terminal outcome.
   An error the run raised (its own agent.run.error, a capability denial, a throw) fails it in its own words. The hand-off is the
   returned terminal text, never the streamed deltas: no narration before a tool call, steer echo or host note rides it.
   hopVerdict(ret, sinkFacts) -> { ok, text, error, stopCode }: stopCode null when ok, 'stopped' (the caller words the stop),
   'stage_incomplete' (cut short, a spending or step limit, a question, interrupted, no terminal outcome), 'stage_failed' (failed or
   refused) or 'stage_empty' (it finished with nothing to hand on). Pure. The codes are RunOutcome.LINE_STOPS; chain.js and the
   step-through test stop on them and say them in routing/line-fire.js lineStop's one sentence (hopStopCode reads a hop's result). */
const UNFINISHED = new Set(['cut_short', 'out_of_budget', 'step_limit', 'asked', 'interrupted']);

/* A job reaches its OUTBOX only with a receipt from the walk and a successful durable row for every stage. Neither a
   plausible reply nor the floor's current topology proves where this job went. Entries supply their own rows, or the book
   reads the exact run ids it tracked; a missing row is an unfinished stage. The receipt rule for SHIPPED stays separate. */
function outcomeOf(facts) {
  const f = facts || {}, line = f.line || {}, runs = Array.isArray(f.runs) ? f.runs : [];
  let stop = f.stop || line.stop || null;
  const agentId = String(line.agentId || f.agentId || ''), dockId = line.dockId || f.dockId;
  const nameOf = id => (typeof f.label === 'function' && f.label(id)) || id || undefined;
  const make = (code, extra) => Object.assign(lineStop(code, Object.assign({ agent: nameOf(agentId) }, extra)),
    agentId ? { agentId } : null, dockId ? { dockId } : null);
  // The entry can be stopped after its chain returned but before its reply settles. Its explicit fault/STOP wins over
  // the chain's earlier stop snapshot; fault containment must never turn into a claim that the Commander stopped it.
  if (f.stopCause === 'fault') stop = make('station_fault', { error: f.error });
  else if (f.stopped) stop = make('stopped');
  else if (RunOutcome.isLineStop(f.stopCode)) stop = make(f.stopCode, { error: f.error, why: f.refusedSaid });
  if (!stop || !RunOutcome.isLineStop(stop.code)) {
    if (line.halted) stop = make('stopped');
    else if (f.onLine === false) stop = make('wrong_line');
    else if (f.error) stop = make(runs.length ? 'stage_failed' : 'refused', { error: String(f.error), why: String(f.error) });
    else if (line.stopped) stop = make('stage_failed', { error: String(line.stopped) });
    else if (line.partial) stop = make('partial_join', { partial: line.partial });
    else {
      const bad = runs.find(r => !RunOutcome.ofRow(r).ok);
      if (bad) {
        const o = RunOutcome.ofRow(bad);
        const code = o.outcome === 'stopped' ? 'stopped' : o.outcome === 'empty' ? 'stage_empty'
          : UNFINISHED.has(o.outcome) || o.failureCode === RunOutcome.NO_TERMINAL ? 'stage_incomplete' : 'stage_failed';
        stop = make(code, { agent: nameOf(bad.agentId || agentId), error: RunOutcome.line(o) });
        if (bad.agentId) stop.agentId = bad.agentId;
        if (bad.dockId) stop.dockId = bad.dockId;
      } else if (!runs.length) stop = make(f.refusedSaid ? 'refused' : 'stage_incomplete', { why: f.refusedSaid });
      else if (!line.outboxId) stop = make('no_outbox');
    }
  }
  const outcome = RunOutcome.lineOutcomeOf(stop && stop.code), delivered = outcome === 'delivered';
  return { delivered, outcome, status: RunOutcome.lineStatus(outcome), stop: stop || null,
    error: stop ? String(stop.why || '') : '', outboxId: delivered ? String(line.outboxId) : null,
    unapproved: delivered ? String(line.unapproved || '') : '', runs,
    usd: runs.reduce((sum, r) => sum + (r && Number.isFinite(r.usd) && r.usd > 0 ? r.usd : 0), 0),
    output: String(f.output == null ? (line.text || '') : f.output) };
}

function makeJobBook(d, now, newId) {
  const jobs = d.jobs || {}, active = new Map(), crates = new WeakMap();
  function open(opts) {
    const o = opts || {};
    if (!o.line) return null;
    const id = String(o.id || ('job-' + String(newId()).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 24).padStart(8, '0')));
    if (active.has(id)) {
      const current = active.get(id);
      if (current.line !== o.line || current.streamId !== String(o.streamId || '')) throw new Error('line job id belongs to another dispatch');
      return current;
    }
    const existing = typeof jobs.get === 'function' ? jobs.get(id) : null;
    if (existing && (existing.line !== o.line || existing.streamId !== String(o.streamId || ''))) throw new Error('line job id belongs to another dispatch');
    if (existing && existing.status !== 'running' && existing.status !== 'paused') throw new Error('line job is already settled');
    const intake = typeof d.intakeReceiptFor === 'function' ? d.intakeReceiptFor({ lineId: o.line, intakeId: o.entryIntakeId }) : null;
    const record = existing || (typeof jobs.start === 'function' ? jobs.start(Object.assign({}, o, { id, at: o.at == null ? now() : o.at,
      intakeId: intake && intake.mode === 'line' && intake.lineId === o.line ? intake.intakeId : undefined })) : null);
    if (typeof jobs.start === 'function' && !record) throw new Error('line job could not be recorded');
    const job = { id, line: o.line, streamId: String(o.streamId || ''), record, runs: new Map(), result: null, stopHandle: o.stopHandle };
    active.set(id, job);
    return job;
  }
  function track(job, runId, verdict) {
    if (job && !job.result && runId) job.runs.set(String(runId), verdict || null);
  }
  function preview(job, facts) {
    const f = Object.assign({ label: d.label }, facts);
    if (job && job.stopRequested) {
      f.stopped = true;
      if (job.stopRequested === 'fault') f.stopCause = 'fault';
    }
    if (!Array.isArray(f.runs) && job) f.runs = Array.from(job.runs, ([id, v]) => {
      const row = typeof d.runRow === 'function' ? d.runRow(id) : null;
      if (row) return row;
      // The host's known preflight refusal bought no run; every other missing row still fails closed.
      if (v && v.lineStop && v.lineStop.code === 'day_limit') return null;
      return { runId: id, agentId: v && v.agentId, reason: 'error', failureCode: RunOutcome.NO_TERMINAL };
    }).filter(Boolean).reverse();   // LineJobs/readers keep the final stage first, matching runStore's newest-first rows.
    return outcomeOf(f);
  }
  /* A JOB PARKED ON ITS SAVED HOLD (line-hold lane, S3). runLineJob saved the walk's stop at a reviewer's gate as a held continuation on
     this very LineJob (parkLine below). The durable record is the authority, never the attempt: a hold write whose acknowledgement was
     lost may still have landed, so a job whose hold was attempted is also read back, and found held, from the canonical record. */
  function heldOf(job) {
    if (job.held) return job.held;
    if (!job.holdAttempt || typeof jobs.get !== 'function') return null;
    const rec = jobs.get(job.id);
    return rec && rec.status === 'held' && rec.stop ? (job.held = { jobId: job.id, stop: rec.stop }) : null;
  }
  /* The result of a parked job: NOT delivered, NOT finished, nothing released. It tells the entry that asked (the hub, a routine fire,
     a trigger, SEND TO, the sample route) what happened; the saved record is what a person decides on. The finish and the terminal release
     (the line-output authority, the shipment receipt, SEND TO) belong to the end of a decided job, so neither runs here, and the live
     handle is forgotten: from here on only the saved record owns this job, across a restart too. */
  function parked(job, result, held) {
    const stop = held.stop;
    Object.assign(result, { delivered: false, held: true, status: 'held', outcome: 'blocked', stop, error: String(stop.why || ''), outboxId: null, unapproved: '' });
    delete job.pendingFinish;
    if (typeof jobs.get === 'function') job.record = jobs.get(job.id) || job.record;
    job.result = result;
    active.delete(job.id);
    delete job.terminalRelease;
    return result;
  }
  function settle(job, facts) {
    if (job && job.result) return job.result;
    const result = preview(job, facts);
    if (job) {
      result.jobId = job.id;
      const held = heldOf(job);
      if (held) return parked(job, result, held);
      // Finish before forgetting the handle. If persistence throws the caller may retry; no delivery was published yet.
      if (typeof jobs.finish === 'function') {
        try {
          const record = jobs.finish(job.id, Object.assign({ at: now() }, result));
          if (!record) throw new Error('line job could not be settled');
          job.record = record;
        } catch (error) {
          const landed = heldOf(job);   // the refused finish re-read the saved record: a hold that landed beside a lost acknowledgement
          if (landed) return parked(job, result, landed);
          // Keep the first terminal facts and their resolved run rows for the entry's retry owner.
          // A later catch reporting this write error must not erase the completed work's spend.
          if (!job.pendingFinish) job.pendingFinish = Object.assign({}, facts, {
            line: facts && facts.line ? Object.assign({}, facts.line) : undefined,
            runs: result.runs.map(row => Object.assign({}, row))
          });
          throw error;
        }
      }
      delete job.pendingFinish;
      job.result = result;
      active.delete(job.id);
      // Terminal floor authority and SEND TO are side effects of the durable job result, not of the walk alone.
      // Forget the closure before invoking it: a post-persist callback error must not replay publication on retry.
      const release = job.terminalRelease;
      delete job.terminalRelease;
      if (typeof release === 'function') {
        try { release(result); } catch (e) { failNote('line-runner.terminalRelease', e); }
      }
    }
    return result;
  }
  function deliverCrate(result, payload) {
    if (!result || !result.delivered || !payload || !payload.workitemId || typeof d.emit !== 'function') return false;
    let sent = crates.get(result);
    if (!sent) { sent = new Set(); crates.set(result, sent); }
    if (sent.has(payload.workitemId)) return false;
    sent.add(payload.workitemId);
    say(d.emit, 'workitem.delivered', Object.assign({}, payload, { finalQueueId: 'outbox', box: '' }, result.unapproved ? { unapproved: result.unapproved } : null));
    return true;
  }
  function mark(job, status) {
    if (!job || job.result || (status !== 'paused' && status !== 'running')) return null;
    return typeof jobs.mark === 'function' ? jobs.mark(job.id, status) : null;
  }
  function stop(id, cause) {
    const job = active.get(String(id));
    if (!job || typeof job.stopHandle !== 'function') return false;
    // Remember an owned stop across the queued-to-hub handoff and any later settlement retry.
    // The exact owner still aborts its current adapter; this receipt cannot stop an unrelated run.
    if (job.stopRequested !== 'fault') job.stopRequested = cause === 'fault' ? 'fault' : 'user';
    job.stopHandle(job.stopRequested);
    return true;
  }
  function reap(liveIds) {
    if (typeof jobs.all !== 'function') return;
    const keep = new Set(liveIds || []);
    for (const r of jobs.all()) if (r.status === 'paused' && !keep.has(r.id) && !active.has(r.id)) {
      settle(open({ id: r.id, line: r.line, streamId: r.streamId }), { stopCode: 'restart', output: r.output, runs: r.runs });
    }
  }
  /* A HELD JOB A PERSON DECIDED (line-hold lane, S4) — the RESUME OWNER's door (line-resume.js) and nobody else's. open() above refuses a
     held job like any settled one: an entry that dispatches work can never take a handle on a job waiting for a person. This door takes
     one only while a DECISION on it is claimed (the held job's continuation names its active decision) or once that decision was adopted
     and the job runs again; the handle then serves the resumed walk exactly as open()'s serves a fresh one. */
  function openResumed(o) {
    const opts = o || {}, id = String(opts.id || '');
    const existing = typeof jobs.get === 'function' ? jobs.get(id) : null;
    if (!existing || existing.line !== opts.line || existing.streamId !== String(opts.streamId || '')) throw new Error('line job id belongs to another dispatch');
    const claimed = existing.status === 'held' && existing.continuation && existing.continuation.activeDecision;
    if (existing.status !== 'running' && !claimed) throw new Error('line job is not waiting on a decision');
    if (active.has(id)) throw new Error('line job is already being resumed');
    const job = { id, line: existing.line, streamId: existing.streamId, record: existing, runs: new Map(), result: null, stopHandle: opts.stopHandle, resumed: true };
    active.set(id, job);
    return job;
  }
  /* The end of a resumed job, in the order the saved record owns it (line-hold lane, S4): the accepted result first (port.terminal: the
     continuation goes ready/held -> terminal_pending, with its publication for a delivered result), then the job's own strict finish (the
     existing LineJobs.finish, which refuses anything but that exact result), then the publication: marked uncertain BEFORE the existing
     release closure runs (a crash in between leaves 'uncertain', never replayed: the same at-most-once release an ordinary job has) and
     confirmed after it. A write that cannot be confirmed throws before anything is released; the handle stays for the owner's retry. */
  function settleResumed(job, facts, port) {
    if (job && job.result) return job.result;
    const result = preview(job, facts);
    result.jobId = job.id;
    const exact = port.terminal(result);   // { usd, output, runs }: the numbers the continuation holds, which the finish must repeat
    Object.assign(result, { usd: exact.usd, output: exact.output, runs: exact.runs });
    const record = typeof jobs.finish === 'function' ? jobs.finish(job.id, Object.assign({ at: now() }, result)) : null;
    if (!record) throw new Error('line job could not be settled');
    job.record = record;
    job.result = result;
    active.delete(job.id);
    const release = job.terminalRelease;
    delete job.terminalRelease;
    if (result.delivered) { try { port.publishing(); } catch (e) { failNote('line-runner.resumePublishing', e); } }   // (unsaved: it stays 'pending', and the release below still runs once)
    let released = true;
    if (typeof release === 'function') { try { release(result); } catch (e) { released = false; failNote('line-runner.terminalRelease', e); } }
    // a delivery whose release failed or whose confirmation could not be written stays 'uncertain' on the saved record: honest, and never replayed
    if (!result.delivered || released) { try { port.complete(result.delivered); } catch (e) { failNote('line-runner.resumeComplete', e); } }
    return result;
  }
  /* A resumed job that stopped at a gate AGAIN (the person sent it back and the reviewer held it once more) and was saved as a hold again
     by the resume owner: forgotten here exactly as parked() forgets a first hold. */
  function parkResumed(job, facts, stop) {
    if (job && job.result) return job.result;
    const result = preview(job, facts);
    result.jobId = job.id;
    return parked(job, result, { stop });
  }
  // a resumed handle whose end could not be written: let go of it, so the owner's retry (the same decision again) can open a fresh one
  function forget(job) { if (job && !job.result && active.get(job.id) === job) active.delete(job.id); }
  return { open, openResumed, get: id => active.get(String(id)) || null, track, preview, settle, settleResumed, parkResumed, forget, outcomeOf, deliverCrate, mark, stop, reap };
}

function hopVerdict(ret, sinkFacts) {
  const s = sinkFacts || {};
  const r = ret && typeof ret === 'object' ? ret : null;
  if (r && r.lineStop && r.lineStop.code === 'day_limit') {
    if (s.stopped) return { ok: false, text: '', error: null, stopCode: 'stopped' };
    return { ok: false, text: '', error: String(r.lineStop.why || ''), stopCode: 'day_limit', stop: r.lineStop };
  }
  if (s.errMsg) return { ok: false, text: '', error: String(s.errMsg), stopCode: 'stage_failed' };
  if (s.stopped) return { ok: false, text: '', error: null, stopCode: 'stopped' };
  if (!r) return { ok: false, text: '', error: hopError({ end: null }), stopCode: 'stage_incomplete' };
  let o = RunOutcome.isOutcome(r.outcome) ? { outcome: r.outcome, failureCode: String(r.failureCode || ''), ok: r.outcome === 'succeeded' }
    : RunOutcome.resolve({ reason: r.reason, failureCode: r.failureCode, finishReason: r.finishReason, clarifying: r.clarifying === true });
  if (o.ok && s.end) { const e = RunOutcome.ofEnd(s.end, null); if (!e.ok) o = e; }
  const text = String(r.text == null ? '' : r.text);
  // reason 'done' with outcome 'succeeded' (RunOutcome.reasonOf: 'done' only for a run that succeeded), and words to hand on
  if (o.ok) return (RunOutcome.reasonOf(r) === 'done' && text.trim()) ? { ok: true, text, error: null, stopCode: null } : { ok: false, text: '', error: null, stopCode: 'stage_empty' };
  if (o.outcome === 'stopped') return { ok: false, text: '', error: null, stopCode: 'stopped' };
  const error = hopError({ end: { reason: String(r.reason || ''), finishReason: r.finishReason, outcome: o.outcome, failureCode: o.failureCode } });
  const stopCode = o.outcome === 'empty' ? 'stage_empty'
    : (UNFINISHED.has(o.outcome) || o.failureCode === RunOutcome.NO_TERMINAL) ? 'stage_incomplete' : 'stage_failed';
  return { ok: false, text: '', error, stopCode };
}

function makeLineRunner(deps) {
  const d = deps || {};
  if (typeof d.runOnce !== 'function') throw new Error('makeLineRunner: runOnce is required');
  const runOnce = d.runOnce;
  const chain = (d.chain && typeof d.chain.advance === 'function') ? d.chain : null;
  const liveRuns = (d.liveRuns && typeof d.liveRuns.add === 'function') ? d.liveRuns : null;
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };
  let seq = 0;
  const newId = typeof d.newId === 'function' ? d.newId : function () { return 'hop' + (++seq); };
  const book = makeJobBook(d, now, newId);

  async function workProduct(ret, h) {
    const r = ret || {}, at = h || {}, runId = r.runId || at.runId;
    const row = runId && typeof d.runRow === 'function' ? d.runRow(runId) : null;
    const artifacts = (Array.isArray(r.artifacts) ? r.artifacts : row && Array.isArray(row.artifacts) ? row.artifacts : [])
      .filter(a => a && (a.kind === 'file' || a.kind === 'image'));
    let files = [];
    if (artifacts.length && typeof d.handoffFiles === 'function') {
      try { files = (await d.handoffFiles(at.agentId, artifacts, { projectRoot: (row && row.projectRoot) || '' }) || []).map(f => f.abs); }
      catch (e) { failNote('line-runner.producedFiles', e); }
    }
    // projectRoot rides beside the product (the run's own base the files were located against): a held job saves exact receipts for them
    return Object.assign(productOf(Object.assign({}, row || {}, r, { runId, files: mergeFiles(files) }), { draft: at.draft }),
      { projectRoot: row && typeof row.projectRoot === 'string' ? row.projectRoot : '' });
  }

  function hopRunner(profile) {
    const p = profile || {};
    const stoppedSaid = typeof p.stoppedSaid === 'function' ? p.stoppedSaid : function () { return 'stopped by you'; };
    const stoppedByYou = typeof p.stoppedByYou === 'function' ? p.stoppedByYou : function (hs) { return !!(hs.stopped && !hs.errMsg); };
    return async function runHop(h) {
      if (typeof p.beforeHop === 'function') { try { p.beforeHop(h); } catch (e) { failNote('line-runner.beforeHop', e); } }   // a lease renewal never stops the hop
      const runId = String((typeof p.runId === 'function' && p.runId(h)) || newId());
      if (typeof p.onRun === 'function') p.onRun(runId, h);
      let cfg = {};
      if (typeof p.config === 'function') {
        try { cfg = p.config(h); }
        catch (e) { return { text: '', usd: 0, error: 'target agent configuration failed: ' + ((e && e.message) || e), stopCode: 'stage_failed' }; }
        if (!cfg || cfg.ok === false) return { text: '', usd: 0, error: (cfg && cfg.error) || ('target agent ' + h.agentId + ' is not configured'), stopCode: 'stage_failed' };
      }
      // the hop's OWN run settles the hop: a worker it delegated to forwards its error / end here under its own runId. The sink keeps
      // what only the stream says (an error the run raised, its own end, its spend, its tool steps); the hand-off is never read from it
      const hs = { errMsg: null, usd: 0, end: null, stopped: false, tools: 0, calls: {}, denied: [] };
      const sink = (name, payload) => {
        if (typeof p.tap === 'function') say(p.tap, name, payload);
        let x = payload;
        if (typeof p.redact === 'function') { try { x = p.redact(payload); } catch (_) { x = payload; } }
        x = x || {};
        const lead = !x.runId || String(x.runId) === String(runId);
        if (name === 'agent.run.end' && lead && x.reason === 'cancelled') hs.stopped = true;   // STOP on this step: the line stops here
        if (name === 'agent.run.end' && lead) hs.end = x;
        if (name === 'agent.token') return;
        if (name === 'agent.tool_call') {
          hs.tools++;
          if (x.callId) hs.calls[x.callId] = String(x.name || 'a tool');
          if (typeof p.onToolStep === 'function') p.onToolStep();
        } else if (name === 'agent.tool_result' && x.summary === 'denied') {
          const t = hs.calls[x.callId] || 'a tool';
          if (hs.denied.indexOf(t) < 0 && hs.denied.length < 6) hs.denied.push(t);
        } else if (name === 'agent.run.error') { if (lead) hs.errMsg = x.message || 'run error'; }
        else if (name === 'capdenied') hs.errMsg = hs.errMsg || ('no ' + (x.need || 'capability') + ' — ' + (x.reason || ''));
        else if (name === 'agent.run.end' && typeof x.usd === 'number' && isFinite(x.usd)) hs.usd = Math.max(hs.usd, x.usd);
        if (typeof p.tee === 'function') say(p.tee, name, x);
      };
      const live = !!(liveRuns && p.liveSource);
      const release = live ? liveRuns.add(runId, { agentId: String(h.agentId || 'agent'), startedAt: now(), source: p.liveSource }) : null;
      const t0 = now();
      let crateId = null;
      const history = p.history && typeof p.history.load === 'function' ? p.history : null;
      let hist = [];
      let ret;
      try {
        if (p.crate && typeof p.crate.place === 'function') crateId = p.crate.place(h, { t0, newId }) || null;
        if (history) {
          try {
            hist = await history.load(h);
            if (!Array.isArray(hist)) throw new Error('The line history owner returned no replay');
          } catch (e) {
            failNote('channels.hub.hop-history', e);
            hs.errMsg = "this line's history could not be read";
            throw e;
          }
          if (typeof history.append === 'function') await history.append(h, 'user', h.text);
        }
        const own = typeof p.options === 'function' ? (p.options(h, cfg) || {}) : {};
        ret = await runOnce(Object.assign({}, own, {
          key: cfg.key, model: cfg.model, provider: cfg.provider, wireSource: cfg.wireSource || undefined,
          baseUrl: cfg.baseUrl || cfg.base_url || '', reasoningEffort: cfg.reasoningEffort || cfg.reasoning_effort,
          system: typeof p.system === 'function' ? p.system(h, cfg) : undefined,
          messages: TurnView.concat(hist, [{ role: 'user', content: h.text }]),
          agentId: h.agentId, isTask: true, emit: sink, signal: h.signal, runId, trigger: p.trigger || 'event',
          streamId: (typeof p.streamId === 'function' ? p.streamId(h) : undefined) || undefined, parallelBranch: !!h.parallel,
          ceilingUsd: h.ceilingUsd,   // what is left of the line's $ ceiling (lower-only)
          handoffReads: mergeFiles(h.handoffReads),   // only this job's proved upstream files, read-only at the tool boundary
          resumeSeed: false,          // the hand-off carries the upstream work: never the stream's earlier turns (runOnceCore seed)
          initialTaint: h.entry ? null : UPSTREAM_TAINT,
          surface: 'autonomous', reflect: true, unattendedGrants: [],
          station: (typeof p.station === 'function' ? p.station(h) : null) || undefined,   // the hop's OWN bay room (multi-bay)
          lineId: h.lineId || undefined, dockId: h.dockId || undefined, workitemId: h.workitemId || crateId || undefined,
          lineHop: !h.entry || undefined
        }));
      } catch (e) {
        // the hop's room (or brief) was asked of a saved floor that cannot be proved right now: nothing ran, and the stage fails in the hold's own words
        const held = holdOf(e);
        hs.errMsg = hs.errMsg || (held ? held.why : 'run failed: ' + ((e && e.message) || e));
      }
      finally {
        if (typeof release === 'function') release();
        else if (live && typeof liveRuns.remove === 'function') liveRuns.remove(runId);
      }
      const v = hopVerdict(ret, hs);
      const stopped = v.stopCode === 'stopped' && stoppedByYou(Object.assign({}, hs, { stopped: true }));
      const stopCode = v.stopCode === 'stopped' && !stopped ? 'station_fault' : v.stopCode;
      // a stop the profile says nobody made (its fault containment) is never "stopped by you": a profile with no words of its own says the fault
      const error = v.stopCode !== 'stopped' ? v.error : (stopped || typeof p.stoppedSaid === 'function') ? stoppedSaid(hs) : FAULT_SAID;
      if (crateId && typeof p.crate.settle === 'function') p.crate.settle(h, crateId, v.ok, { t0, now });
      if (history && v.ok && typeof history.append === 'function') await history.append(h, 'assistant', v.text);
      const product = await workProduct(Object.assign({}, ret || {}, { text: v.text, runId }), h);
      return Object.assign(product, { usd: hs.usd, error, stopped, stopCode, stop: v.stop || null, lineStop: ret && ret.lineStop || null, workitemId: h.workitemId || crateId || null, tools: hs.tools, denied: hs.denied, ms: Math.max(0, now() - t0) });
    };
  }

  /* THE HOLD, PARKED (line-hold lane, S3). A walk that stopped AT A GATE for a person (line.hold, chain.js) is saved as a held
     continuation on its own LineJob BEFORE anyone settles the job: line-hold.js builds it from the walk's snapshot and the job's admission
     and the existing validator accepts it, then the host's verified writer (jobs.hold -> index.js lineJobsHold) saves it and reads it back.
     Only a job read back as held is parked (job.held; line.held, which the stop note reads). Any refusal — no hold owner on this host, an
     origin that cannot be named, a split still running, a file that cannot be read, a storage fault — leaves the walk ending as it always
     did, the terminal blocked stop, with the reason said in its own sentence. Never throws: the walk's result is already in hand. */
  function parkLine(job, seed, line, planHash) {
    const jp = d.jobs || {}, hold = d.hold;
    if (!job || !line || !line.hold || typeof jp.hold !== 'function' || !hold || typeof hold.originOf !== 'function') return;
    job.holdAttempt = true;
    const park = saved => {
      const c = saved && saved.continuation;
      if (!saved || saved.status !== 'held' || !c || c.phase !== 'held') return false;
      job.held = { jobId: job.id, revision: c.revision, reason: line.hold.reason, gateId: line.hold.gateId, pass: line.hold.pass, stop: { code: 'blocked', why: line.hold.why } };
      line.held = { jobId: job.id, revision: c.revision, reason: line.hold.reason, gateId: line.hold.gateId, pass: line.hold.pass };
      return true;
    };
    let why = '';
    try {
      const record = (typeof jp.get === 'function' && jp.get(job.id)) || job.record;
      const built = LineHold.buildHeld(seed, line, record, record ? hold.originOf(record, seed.origin) : null,
        { planHash, receiptFor: hold.receiptFor });
      if (built.ok) {
        // the station vouches for the hold before it is written: the floor is still the one the walk ran on, its line and docks still
        // compile, E-STOP is not engaged (index.js holdAuthority, synchronous and read-only; anything but true refuses)
        const vouch = typeof hold.authority === 'function' ? hold.authority({ phase: 'hold', job: record, continuation: built.continuation }) : true;
        if (vouch !== true) why = (vouch && vouch.refused) || 'the station did not vouch for the hold';
        else if (park(jp.hold(job.id, 0, built.continuation))) return;
        else why = 'the saved hold could not be read back as held';
      } else why = built.reason;
    } catch (e) {
      failNote('line-runner.hold', e);
      if (typeof jp.get === 'function' && park(jp.get(job.id))) return;   // the write landed beside a lost acknowledgement: the record says held
      why = 'the hold could not be saved: ' + ((e && e.message) || e);
    }
    // the old terminal blocked stop, now saying why it was not parked (the stop's own sentence, the legacy words and the record's error)
    const said = LineHold.notHeld(why);
    line.holdFailed = said;
    for (const k of ['stopped', 'blocked']) if (typeof line[k] === 'string') line[k] = (line[k] + '; ' + said).slice(0, 400);
    if (line.stop && typeof line.stop === 'object') line.stop = Object.assign({}, line.stop, { why: (String(line.stop.why || '') + '; ' + said).slice(0, 400) });
  }

  async function runLineJob(job) {
    const j = job || {};
    if (!chain) throw new Error('makeLineRunner: a chain is required to run a line');
    const runHop = hopRunner(j.profile);
    if (j.job && j.seed) book.track(j.job, j.seed.runId);
    const seed = j.seed || {};
    // the floor plan this walk STARTS on: a hold is bound to it, and the station vouches (hold.authority) that the floor is still that one
    // when the walk parks — a floor edited mid-walk refuses the hold, since the gate it stopped at was read from the old floor
    let startedOn = null;
    if (j.job && !j.resumed && d.hold && typeof d.hold.planHash === 'function') { try { startedOn = d.hold.planHash(); } catch (e) { failNote('line-runner.holdPlan', e); } }
    // (a RESUMED walk restores its entry work from the saved continuation, seed.resume: there is no entry run to read a product from)
    let product = null;
    if (!j.resumed) {
      product = await workProduct(seed, { agentId: seed.agentId, runId: seed.runId, draft: seed.originalText == null ? seed.text : seed.originalText });
      product.files = mergeFiles(seed.handoffReads, product.files);
    }
    const line = await chain.advance(Object.assign({}, seed, product ? { product } : null, j.job ? {
      jobId: j.job.id, deferTerminal: release => { j.job.terminalRelease = release; }
    } : null, { runAgent: async h => {
      const r = await (typeof j.hop === 'function' ? j.hop(h, runHop) : runHop(h));
      book.track(j.job, r.runId, Object.assign({ agentId: h.agentId, dockId: h.dockId }, r));
      return r;
    } }));
    if (j.job) { j.job.lastLine = line; if (!j.resumed) parkLine(j.job, seed, line, startedOn); }
    return line;
  }
  /* THE RESUMED WALK (line-hold lane, S4): runLineJob for a held job a person decided. It is the same one chain advance, with
     the walk restored from the saved continuation (seed.resume) and every PAID hop bracketed by the durable record the saved job owns:

        1. the run id is minted HERE and written down first, with the stage and a digest of what it will be handed (durable.intent —
           the continuation goes to 'intent'): nothing is bought for a stage whose intent could not be saved;
        2. the stage runs through the one hop executor (hopRunner) under that same run id (the profile's runId hook);
        3. what it cost and how it ended is written down (durable.observed — the continuation is 'ready' again). If THAT cannot be saved
           the job stops right there with no further spend: the saved attempt stays an unresolved intent, which the next boot reads as
           'uncertain' and no run will touch until a person reconciles it — a stage is never bought twice.

     A STOP or E-STOP between stages (halted()) buys nothing: the hop is answered as stopped before any intent is written.
     o: { job (openResumed's handle), seed (with seed.resume), profile (channel profile), durable { intent(att), observed(att, obs) },
          halted() } -> the chain's result. Never settles: the owner decides how the job ends. */
  async function runResumed(o) {
    const j = o || {};
    if (!chain) throw new Error('makeLineRunner: a chain is required to run a line');
    const durable = j.durable || {};
    const stoppedHop = h => ({ text: '', usd: 0, error: null, stopped: true, stopCode: 'stopped', stop: null, lineStop: null, tools: 0, denied: [], ms: 0, runId: null, workitemId: h.workitemId || null });
    const refusedHop = (h, why) => ({ text: '', usd: 0, error: why, stopped: false, stopCode: 'station_fault', stop: null, lineStop: null, tools: 0, denied: [], ms: 0, runId: null, workitemId: h.workitemId || null });
    async function bracketed(h, runHop) {
      if ((typeof j.halted === 'function' && j.halted()) || (h.signal && h.signal.aborted)) return stoppedHop(h);
      const runId = String(newId());
      h.runId = runId;
      // (a stage inside a split names its branch, S5: a second hold inside the split ties each parked part to the observed run that made it)
      const att = { runId, node: { agentId: String(h.agentId || ''), dockId: h.dockId ? String(h.dockId) : null }, branchId: h.branchId ? String(h.branchId) : null, workitemId: String(h.workitemId || ''),
        inputDigest: sha([String(h.text == null ? '' : h.text), Array.isArray(h.handoffReads) ? h.handoffReads : []]), at: now() };
      try { durable.intent(att); }
      catch (e) { failNote('line-runner.intent', e); return refusedHop(h, 'the station could not save this stage before it ran, so nothing was bought for it'); }
      let r = null;
      try { r = await runHop(h); }
      catch (e) { r = { text: '', usd: 0, error: 'run failed: ' + ((e && e.message) || e), stopCode: 'stage_failed', runId }; }
      r = r || {};
      const usd = (typeof r.usd === 'number' && isFinite(r.usd) && r.usd > 0) ? r.usd : 0, code = hopStopCode(r);
      const outcome = RunOutcome.isOutcome(r.outcome) ? r.outcome : (code ? (code === 'stopped' ? 'stopped' : 'failed') : 'succeeded');
      try { durable.observed(att, { usd, outcome, outputDigest: sha([String(r.text == null ? '' : r.text), String(h.draft == null ? '' : h.draft), Array.isArray(r.files) ? r.files : [], runId]), endedAt: now() }); }
      catch (e) {
        failNote('line-runner.observed', e);
        return Object.assign({}, r, { text: '', error: 'the station could not save what this stage cost, so the job stopped here', stopped: false, stopCode: 'station_fault', runId });
      }
      return r;
    }
    // the profile's runId hook is the one this wrapper minted and wrote down first (h.runId)
    return runLineJob({ job: j.job, seed: j.seed, profile: Object.assign({}, j.profile, { runId: h => (h && h.runId) || null }), hop: bracketed, resumed: true });
  }
  function stopNote(line) { return chain ? chain.stopNote(line) : ''; }

  return Object.assign({ hopRunner, runLineJob, runResumed, workProduct, stopNote, chain, profiles: PROFILES }, book);
}

/* ---- THE PROFILES: what each entry's hop carries beyond the shared body ---- */
const station2 = (fn, h) => typeof fn !== 'function' ? null : (h.dockId ? fn(h.agentId, h.dockId) : fn(h.agentId));

/* channel(o) — a hop of a job a CHANNEL HUB runs: every chat, and the sample, webhook and SEND TO hubs. The hop runs as the
   receiving agent on its own roster config (config: resolveRunConfig), with its own composed persona, never the channel's
   configured system prompt, and keeps the entry sender's verdicts: owner trust, sender, untrusted entry. Only narrowing. A real
   chat's hub hands it the chat's lineage (history: { load(h), append(h, role, text) }, the hub's hopLineage); a one-job hub none.
   o: { channel, chatId, streamId, config(agentId), persona(agentId), station(agentId, dockId?), ownerTrusted, channelSender,
        channelSenderOwner, untrustedEntry, history?, redact?, onToolStep?, onRun? } */
function channel(o) {
  o = o || {};
  const ch = String(o.channel || '');
  return {
    trigger: 'event',
    streamId: () => o.streamId || undefined,
    config: typeof o.config === 'function' ? (h) => o.config(h.agentId) : null,
    system: (h, cfg) => (cfg && cfg.system) || (typeof o.persona === 'function' ? o.persona(h.agentId) : undefined),
    station: (h) => station2(o.station, h),
    options: (h) => ({
      untrustedEntry: o.untrustedEntry || undefined,   // a hop of a payload-started line stays under the taint lock
      ownerTrusted: o.ownerTrusted, broadcast: true,
      channelSender: o.channelSender, channelSenderOwner: o.channelSenderOwner,   // a hop keeps the entry sender's Full Power verdict
      taskKey: 'chain:' + ch + ':' + o.chatId + ':' + h.agentId + (h.dockId ? '@' + h.dockId : ''), taskSource: ch
    }),
    history: o.history || null,
    redact: o.redact, onToolStep: o.onToolStep, onRun: o.onRun
  };
}

/* the two ROUTINE entries. A hop runs as the TARGET agent on the target's own roster config (cronHopConfigFor, 2026-08-10 audit
   #3), on the routine persona, with the routine's skills, workdir and toolsets (kept on hops on purpose: multi-stage routines rely
   on them, flagged 2026-08-04 to revisit), live in the host's run registry for the reconnect snapshot.
   o: { streamId, config(agentId), system(agentId), station(agentId, dockId), routine: { preloadSkills, requiredPreloads, workdir,
        enabledToolsets }, stoppedSaid?, stoppedByYou?, beforeHop? (schedule), tee? (schedule), emit? (manual: the HTTP stream) } */
function routineProfile(o, trigger) {
  o = o || {};
  const r = o.routine || {};
  return {
    trigger, liveSource: 'cron',
    streamId: () => o.streamId || undefined,
    config: (h) => o.config(h.agentId),
    system: (h) => o.system(h.agentId),
    station: (h) => o.station(h.agentId, h.dockId),
    options: () => Object.assign({ stationEvidence: true,   // the persona's observed half rides the run context (dossierWithGoals)
      preloadSkills: r.preloadSkills, requiredPreloads: r.requiredPreloads, workdir: r.workdir, enabledToolsets: r.enabledToolsets },
    trigger === 'manual' ? { broadcast: true } : null),
    beforeHop: o.beforeHop, tee: o.tee, tap: o.emit,
    stoppedSaid: o.stoppedSaid, stoppedByYou: o.stoppedByYou
  };
}
// schedule(o) — a hop of a scheduled routine fire (the cron driver's advanceChain seam)
function schedule(o) { return routineProfile(o, 'schedule'); }
// manual(o) — a hop of a routine the Commander pressed RUN NOW on (its events stream to the watching browser: o.emit)
function manual(o) { return routineProfile(Object.assign({}, o, { beforeHop: null, tee: null }), 'manual'); }

/* steptest(o) — a step of the STEP-THROUGH TEST (routing/steptest.js), its entry step included: the dock's sample run config
   (config: sampleRunConfigFor), its roster system or the step-test persona (an ENTRY step: dockSystem with the dock's brief), the
   run id the test persisted before the run, and a crate per step (kind 'sample' for the entry, 'chain' after). The run row says it
   was a TEST step (stepTest) and whether the owner edited what it was handed (handoffEdited).
   o: { config(agentId), persona, brief(agentId, dockId), dockSystem(persona, brief, isTask), station(agentId, dockId), emit, redact?,
        stoppedByYou? } */
function steptest(o) {
  o = o || {};
  const crateEmit = (n, payload) => { try { o.emit(n, payload); } catch (e) { failNote('steptest.crate', e); } };
  return {
    trigger: 'event',
    streamId: (h) => h.streamId,
    runId: (h) => (typeof h.runId === 'string' && /^[0-9a-f-]{36}$/i.test(h.runId)) ? h.runId : null,   // the step test chose + persisted it
    config: (h) => {
      const cfg = o.config(h.agentId);
      if (cfg && cfg.ok !== false && (!cfg.model || (!cfg.configured && !cfg.key))) return { ok: false, error: 'no provider/model is configured for ' + h.agentId + ' — connect a provider and set a model first' };
      return cfg;
    },
    system: (h, cfg) => {
      const persona = (cfg && cfg.system) || o.persona;
      if (!h.entry) return persona;
      let brief = null;
      // a hold is not "no brief": it goes up to the hop, which then fails in the hold's words, as the hub refuses a message whose dock brief it cannot read
      try { brief = o.brief(h.agentId, h.dockId); } catch (e) { if (holdOf(e)) throw e; failNote('steptest.brief', e); brief = null; }
      return o.dockSystem(persona, brief, true);
    },
    /* NO swallow on the room, like every other profile: a null room is the WHOLE default office (the 2026-08-10 audit #1 class), so a read that
       fails (a hold above all) fails the hop, and runOnce is never called. */
    station: (h) => o.station(h.agentId, h.dockId),
    options: (h) => ({ broadcast: true,
      taskKey: 'steptest:' + h.sessionId + ':' + h.agentId + (h.dockId ? '@' + h.dockId : ''), taskSource: 'sample',
      handoffEdited: h.edited === true,   // the run row says the owner edited what this dock was handed
      stepTest: true   // the run row says it was a TEST hop: the line's RUNS/SHIPPED/FAILED count it apart
    }),
    /* EVERY STEP IS A CRATE (line watch, 2026-09-23): the same workitem.placed/delivered/superseded plumbing chain.js uses (`steptest`
       names the session so the crate's card can jump to the Workflow panel). The entry step rides in from the line's INBOX; a later
       step rides from the bay that handed it the crate (from/fromDock). */
    crate: {
      place(h, c) {
        const workitemId = c.newId();
        const placed = { workitemId, queueId: h.agentId, agentId: h.agentId, kind: h.entry ? 'sample' : 'chain', steptest: String(h.sessionId || ''),
          preview: String(h.preview != null ? h.preview : (h.text || '')).replace(/\s+/g, ' ').slice(0, 40), ts: c.t0 };   // what the dock was HANDED
        if (h.lineId) placed.lineId = h.lineId;
        if (h.dockId) placed.dockId = h.dockId;
        if (!h.entry && h.from && isAgentId(String(h.from))) placed.from = String(h.from);
        if (!h.entry && h.fromDock) placed.fromDock = h.fromDock;
        crateEmit('workitem.placed', placed);
        return workitemId;
      },
      settle(h, workitemId, done, c) {
        if (done) crateEmit('workitem.delivered', { workitemId, finalQueueId: h.agentId, agentId: h.agentId, box: '', ms: c.now() - c.t0, ts: c.now(), dockId: h.dockId || undefined });
        else crateEmit('workitem.superseded', { workitemId, agentId: h.agentId, ts: c.now(), dockId: h.dockId || undefined });
      }
    },
    redact: o.redact, stoppedByYou: o.stoppedByYou
  };
}

const PROFILES = Object.freeze({ channel, schedule, manual, steptest });

module.exports = { makeLineRunner, hopVerdict, outcomeOf, profiles: PROFILES, UPSTREAM_TAINT };
