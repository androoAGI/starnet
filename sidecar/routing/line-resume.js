/* sidecar/routing/line-resume.js — THE ONE RESUME OWNER (line-hold lane, S4).

   A work line that stopped at a reviewer's gate is a HELD JOB (line-hold.js, S3): its walk saved on its own LineJob as a version 1
   continuation. This module is the only door out of that hold. A person decides — APPROVE, SEND BACK (with a note) or STOP — and

     resume(jobId, { action, note, token, revision }) -> { ok, code, ... , done }

   does, in this order and nothing else:

     1. a FRESH canonical read of the job (the host's verified reader), then the claim: LineJobs.claimDecision through the host's verified
        writer. The token and the checkpoint revision make it exactly-once: a replay of the same decision returns the SAVED receipt and
        buys nothing; a different decision on a checkpoint that is already claimed is refused. A lost acknowledgement, a restart between
        the claim and the rest, and two requests at once all land on the one claimed continuation.
     2. the station's authority, re-checked NOW for APPROVE and SEND BACK (the host's holdAuthority, phase 'resume'): the floor is still
        the one the job was bound to, its line and every dock it went through, E-STOP, the agents, the spend and day caps against the
        job's SAVED ceilings, and every file the work carries byte for byte. Refused: the decision is marked refused, nothing is bought, the
        job stays HELD at the same gate and its record says why. STOP buys nothing and is never refused.
     3. only then the checkpoint held -> ready with the decision adopted. APPROVE keeps the saved draft byte for byte (the validator
        refuses anything else). The walk is rebuilt from the saved cursor (chain.js seed.resume) and the person's word is the verdict of the
        stage that stopped: APPROVE leaves on the done lane with the draft that was under review, SEND BACK goes round the gate with the
        reviewer's words and the person's note, one pass further — never a reset of the pass count or the ceilings.
     4. every PAID stage after that is bracketed by the durable record this job owns (line-runner.js runResumed): the intent (with the run
        id minted first) before the provider is called, the observed result after. The resumed hops run UNTRUSTED and POWER-WITHHELD
        whatever the job ran under before: a saved trust flag is a record, never an authority.
     5. the end: ready -> terminal_pending (with its publication, for a delivered result) -> the existing LineJobs.finish -> the existing
        release closure -> publication confirmed -> complete. A walk that stops at a gate AGAIN is saved as a second hold on the same job.
        STOP goes held -> terminal_pending with the owned stop, finishes 'stopped', spends nothing.

   What a crash leaves (the job is never run twice for the same money): before the intent, nothing; after an intent and before its result,
   the attempt is UNCERTAIN (LineJobs.boot) and no run touches it until a person reconciles it; between the strict finish and the release,
   the publication stays 'uncertain' and is never replayed — the same at-most-once release an ordinary job has.
   "A person reconciles it" is STOP (closeStuck, the stop route's ask — never a second decision): any open walk a crash left behind (a record
   ready with nothing to carry out, intent, uncertain, or an accepted end the job never finished) is closed by it. A stage whose result was
   never written is written down as what is known of it, an accepted result nobody released becomes the owned stop, and the job finishes
   'stopped' with nothing bought and what ran counted, so retention can drop the record like any other.

   The pure transitions below (adopted, intent, observed, terminal, publishing, complete) take a continuation and return the next one for
   Continuation.checkpoint to judge; nothing here writes a file, reads a clock or calls a provider except through its deps.

   makeLineResume(deps):
     store    { read(id) -> job|null (fresh canonical), claim(id, req) -> { job, receipt, replayed }, refuse(id, token, why, at) -> job,
                advance(id, make(continuation, job) -> next, landed(job) -> bool) -> job }   (index.js: lineJobsRead / Claim / Refuse / Advance)
     authority({ phase, job, continuation }) -> true | { refused: why }      (sync, read-only; anything but true refuses)
     runner   the LineRunner (openResumed, runResumed, settleResumed, parkResumed, stopNote, profiles)
     profileFor(job, continuation, rec) -> the channel profile a resumed hop runs under (untrusted, power-withheld)
     hold     { receiptFor(file) } for a second hold
     halted() -> E-STOP / fault quiesce is engaged; inflight Map (id -> { abort, endReason, runId, agentId, startedAt }) E-STOP kills through
     runRow(runId) -> the run store's row; now(); */
'use strict';
const RunOutcome = require('../../frontend/app/runoutcome.js');
const Continuation = require('./line-continuation.js');
const LineHold = require('./line-hold.js');
const { note: failNote } = require('../failopen.js');
const Halt = require('../halt.js');
const crypto = require('node:crypto');

const TOKEN = /^[A-Za-z0-9_.:-]{1,120}$/, KEY = /^[A-Za-z0-9_.:-]{1,120}$/;
const ACTIONS = ['approve', 'send_back', 'stop'];
const MAX_NOTE = 2000, MAX_OUTPUT = 12000;
const clip = (x, n) => String(x == null ? '' : x).slice(0, n);
const sum = xs => xs.reduce((n, x) => n + x.usd, 0);
const key = v => (v != null && KEY.test(String(v))) ? String(v) : null;

/* ---- the pure transitions (each returns the NEXT continuation; Continuation.checkpoint is the judge) ---- */
// the decision a step carried out is COMPLETE and nothing is active any more (a held checkpoint's accepted decision, an adopted one)
function closeDecisions(c) {
  return { decisions: c.decisions.map(d => (d.token === c.activeDecision && (d.state === 'accepted' || d.state === 'adopted')) ? Object.assign({}, d, { state: 'complete' }) : d), activeDecision: null };
}
// held -> ready: the claimed decision adopted. The walk, the draft and every receipt are exactly the saved ones.
function adopted(c, token) {
  return Object.assign({}, c, { revision: c.revision + 1, phase: 'ready', hold: null,
    decisions: c.decisions.map(d => d.token === token ? Object.assign({}, d, { state: 'adopted' }) : d), activeDecision: token });
}
// ready/intent -> intent: a paid stage's durable intent, written BEFORE the provider is called
function intentOf(c, a) {
  const closed = closeDecisions(c);
  return Object.assign({}, c, { revision: c.revision + 1, phase: 'intent', decisions: closed.decisions, activeDecision: closed.activeDecision,
    attempts: c.attempts.concat([{ ordinal: c.attempts.length + 1, runId: a.runId, node: a.node, branchId: a.branchId, workitemId: a.workitemId, state: 'intent',
      inputDigest: a.inputDigest, outputDigest: null, usd: null, usageMissing: false, outcome: null, at: a.at, endedAt: null }]) });
}
// intent -> ready: what that stage cost and how it ended. The spend is re-added from the receipts, in the order the validator adds it.
function observedOf(c, runId, o) {
  const b = c.binding, closed = closeDecisions(c);
  const attempts = c.attempts.map(a => (a.runId === runId && a.state !== 'observed')
    ? Object.assign({}, a, { state: 'observed', outputDigest: o.outputDigest, usd: o.usd, usageMissing: false, outcome: o.outcome, endedAt: Math.max(a.at, o.endedAt) }) : a);
  const seen = attempts.filter(a => a.state === 'observed');
  const accounting = Object.assign({}, c.accounting, { entryUsd: sum(seen.filter(a => a.runId === b.entryRunId)), hopUsd: sum(seen.filter(a => a.runId !== b.entryRunId)),
    runIds: c.accounting.runIds.includes(runId) ? c.accounting.runIds.slice() : c.accounting.runIds.concat([runId]) });
  return Object.assign({}, c, { revision: c.revision + 1, phase: attempts.some(a => a.state !== 'observed') ? 'intent' : 'ready', attempts, accounting,
    decisions: closed.decisions, activeDecision: closed.activeDecision });
}
// ready (or held, for a STOP) -> terminal_pending: the accepted result, with its publication when it is a delivery
function terminalOf(c, result) {
  const a = c.accounting, closed = closeDecisions(c), last = c.attempts.slice().reverse().find(x => x.state === 'observed');
  const s = result.stop && typeof result.stop === 'object' ? result.stop : null;
  const stop = s ? { code: s.code, why: clip(s.why, 400) || 'the work line stopped here', agentId: key(s.agentId), dockId: key(s.dockId) } : null;
  return Object.assign({}, c, { revision: c.revision + 1, phase: 'terminal_pending', hold: null, decisions: closed.decisions, activeDecision: closed.activeDecision,
    terminal: { outcome: result.outcome, output: clip(result.output, MAX_OUTPUT), usd: a.entryUsd + a.hopUsd, runIds: a.runIds.slice(), stop },
    publication: result.delivered ? { outboxId: String(result.outboxId), entryRunId: c.binding.entryRunId, terminalRunId: last.runId, state: 'pending', shipmentId: null, sentToJobId: null } : null });
}
/* A WALK THE STATION DIED IN (line-hold lane): a crash between two verified writes of a resumed walk leaves a job that is not held (no decision
   can claim it), not finished (nothing carries it) and not trimmed (retention keeps every open walk): phase ready with no decision to carry out,
   intent (the stage was written down and its result never was; boot reads it as uncertain), uncertain, or terminal_pending with the job never
   finished. A person closes it with STOP, which buys nothing; the two transitions below are what that close writes first. */
const sha = x => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
// intent/uncertain -> ready: a stage whose result the station never wrote down is written as what is KNOWN of it — the run store's own row when the
// run left one (what it cost, how it ended), else nothing: it reached no provider as far as any record shows, so it is an interrupted stage with no
// spend and `usageMissing`, which says plainly that its cost is not known. Nothing is bought and no stage runs again.
function reconciledOf(c, runRow) {
  const b = c.binding, closed = closeDecisions(c);
  const attempts = c.attempts.map(a => {
    if (a.state === 'observed') return a;
    let row = null;
    try { row = typeof runRow === 'function' ? runRow(a.runId) : null; } catch (e) { failNote('line-resume.runRow', e); }
    const usd = row && typeof row.usd === 'number' && isFinite(row.usd) && row.usd > 0 ? row.usd : 0;
    return Object.assign({}, a, { state: 'observed', outputDigest: sha(['', '', [], a.runId]), usd, usageMissing: !row,
      outcome: row && RunOutcome.isOutcome(row.outcome) ? row.outcome : 'interrupted', endedAt: a.at });
  });
  const seen = attempts.filter(a => a.state === 'observed');
  const accounting = Object.assign({}, c.accounting, { entryUsd: sum(seen.filter(a => a.runId === b.entryRunId)), hopUsd: sum(seen.filter(a => a.runId !== b.entryRunId)),
    runIds: c.accounting.runIds.concat(seen.map(a => a.runId).filter(id => !c.accounting.runIds.includes(id))) });
  return Object.assign({}, c, { revision: c.revision + 1, phase: 'ready', attempts, accounting, decisions: closed.decisions, activeDecision: closed.activeDecision });
}
// terminal_pending: a result the walk accepted and the station died before finishing the job. A delivery nobody released becomes the owned STOP
// (its publication suppressed, its output and spend as they were); a result that is already an owned stop only reopens for its end
const ownedStop = t => !!(t && t.stop && (t.stop.code === 'stopped' || t.stop.code === 'station_fault'));
function stoppedPendingOf(c, stop) {
  if (ownedStop(c.terminal)) return Object.assign({}, c, { revision: c.revision + 1 });
  return Object.assign({}, c, { revision: c.revision + 1, terminal: Object.assign({}, c.terminal, { outcome: 'stopped', stop }),
    publication: c.publication ? Object.assign({}, c.publication, { state: 'suppressed' }) : null });
}
/* is this job a walk the station died in? A saved open walk (a continuation that is neither held nor complete) of a job that never finished.
   Whether something still carries it is the owner's to say (its live handle, its inflight record). */
function stuck(job) {
  const c = job && job.continuation;
  return !!c && !job.continuationIssue && job.endedAt == null && (job.status === 'interrupted' || job.status === 'running') && c.phase !== 'held' && c.phase !== 'complete';
}
// terminal_pending: the release is about to run — whether it ran is not known from here on, and it is never replayed
function publishingOf(c) {
  return Object.assign({}, c, { revision: c.revision + 1, publication: c.publication ? Object.assign({}, c.publication, { state: 'uncertain' }) : null });
}
// terminal_pending -> complete: the release ran (confirmed) or there was nothing to publish
function completeOf(c, delivered) {
  return Object.assign({}, c, { revision: c.revision + 1, phase: 'complete', publication: c.publication ? Object.assign({}, c.publication, { state: delivered ? 'confirmed' : 'suppressed' }) : null });
}

/* The job's step rows as LineJobs.finish reads them: one per recorded run, newest first, with the SAVED spend. The run store's own row adds
   only the facts an attempt does not carry (a failed run's code, a cut reply, a question). */
function rowsOf(c, runRow) {
  return c.attempts.filter(a => a.state === 'observed').slice().reverse().map(a => {
    let real = null;
    try { real = typeof runRow === 'function' ? runRow(a.runId) : null; } catch (e) { failNote('line-resume.runRow', e); }
    const row = { runId: a.runId, agentId: a.node.agentId, dockId: a.node.dockId, reason: RunOutcome.reasonOf({ outcome: a.outcome }), outcome: a.outcome };
    if (real && real.failureCode) row.failureCode = real.failureCode;
    if (real && (real.finishReason === 'length' || real.finishReason === 'content_filter')) row.finishReason = real.finishReason;
    if (real && real.clarifying === true) row.clarifying = true;
    row.usd = a.usd;
    return row;
  });
}

/* what a refused store call means to the caller: a decision the pure owners refuse (409/400) is not a storage fault (503) */
function classify(e) {
  const m = String((e && e.message) || e);
  if (/^invalid line decision/.test(m)) return { code: 400, error: 'that is not a decision this job can take' };
  if (/token conflict/.test(m)) return { code: 409, error: 'that token was already used for a different decision — read the job again' };
  if (/cannot claim this checkpoint|revision conflict|phase cannot advance|no adopted human decision|has no saved review checkpoint|only the claimed decision|no such line decision/.test(m)) {
    return { code: 409, error: 'this job is no longer waiting on that checkpoint — another decision may already hold it. Read the job again.' };
  }
  return { code: 503, error: 'The decision could not be confirmed durably. Read the job before retrying.' };
}

function makeLineResume(deps) {
  const d = deps || {};
  for (const k of ['store', 'authority', 'runner', 'profileFor']) if (!d[k]) throw new Error('makeLineResume: ' + k + ' is required');
  const store = d.store, runner = d.runner, now = typeof d.now === 'function' ? d.now : () => 0;
  const inflight = d.inflight || new Map();
  const answer = (code, body, done) => Object.assign({ ok: code >= 200 && code < 300, code, done: done || null }, body);

  function parse(req) {
    const r = req && typeof req === 'object' ? req : {};
    if (ACTIONS.indexOf(r.action) < 0) return { error: 'a decision is approve, send_back or stop' };
    if (!TOKEN.test(String(r.token == null ? '' : r.token))) return { error: 'a decision needs a token of its own (letters, digits and - _ . :)' };
    if (!Number.isSafeInteger(r.revision) || r.revision < 1) return { error: 'a decision names the checkpoint revision it was made on' };
    const note = r.note == null ? '' : r.note;
    if (typeof note !== 'string' || note.length > MAX_NOTE) return { error: 'a note is text of at most ' + MAX_NOTE + ' characters' };
    return { req: { token: String(r.token), revision: r.revision, action: r.action, note } };
  }

  function authorityOf(job, c) {
    let v;
    try { v = d.authority({ phase: 'resume', job, continuation: c }); }
    catch (e) { failNote('line-resume.authority', e); v = { refused: 'the station could not check this job (' + clip((e && e.message) || e, 120) + ')' }; }
    return v === true ? true : clip((v && v.refused) || 'the station did not vouch for this decision', 400);
  }

  /* ---- STOP: held -> terminal_pending with the owned stop, finished 'stopped', zero spend ---- */
  function stopHeld(job, receipt) {
    const id = job.id, c = job.continuation, gate = c.hold ? c.hold.gateId : '';
    const handle = runner.openResumed({ id, line: job.line, streamId: job.streamId });
    const node = c.walk.current;
    const stop = { code: 'stopped', why: 'a person stopped this job at the gate ' + gate + ', so the work was not sent on', agentId: node.agentId, dockId: node.dockId };
    const facts = { stop, runs: rowsOf(c, d.runRow), output: '' };
    try { return runner.settleResumed(handle, facts, portFor(id)); }
    catch (e) { failNote('line-resume.stop', e); runner.forget(handle); throw e; }
  }

  /* The host-side steps a resumed job's end goes through (line-runner.js settleResumed): each one is a verified continuation write. */
  function portFor(id) {
    return {
      terminal(result) {
        const fresh = store.read(id);
        let c = fresh && fresh.continuation;
        if (!c) throw new Error('line job has no saved walk to finish');
        if (c.phase !== 'terminal_pending') c = store.advance(id, x => terminalOf(x, result), j => !!(j.continuation && j.continuation.phase === 'terminal_pending')).continuation;
        return { usd: c.terminal.usd, output: c.terminal.output, runs: rowsOf(c, d.runRow) };
      },
      publishing() { store.advance(id, publishingOf, j => !!(j.continuation && j.continuation.publication && j.continuation.publication.state === 'uncertain')); },
      complete(delivered) { store.advance(id, x => completeOf(x, delivered), j => !!(j.continuation && j.continuation.phase === 'complete')); }
    };
  }

  /* ---- APPROVE / SEND BACK: adopt, then walk on from the saved cursor ----
     `unstarted`: the decision was adopted and nothing has been bought since (an acknowledgement was lost, or the station restarted before the
     first stage was written down): the same decision again starts the walk it never started — the saved record is 'ready' with every
     stage recorded, so there is nothing to pay for twice. The job is reopened by a checkpoint of the same cursor, then walks on as below. */
  function carryOn(job, receipt, unstarted) {
    const id = job.id;
    let ready;
    try {
      ready = !unstarted ? store.advance(id, x => adopted(x, receipt.token), j => !!(j.continuation && j.continuation.phase === 'ready' && j.continuation.activeDecision === receipt.token))
        : job.status === 'running' ? job
        : store.advance(id, x => Object.assign({}, x, { revision: x.revision + 1 }), j => j.status === 'running' && !!j.continuation && j.continuation.phase === 'ready');
    } catch (e) { const f = classify(e); return answer(f.code, { error: f.error, job: safeRead(id) }); }
    const c = ready.continuation, w = c.walk, b = c.binding, a = c.accounting;
    const rec = { runId: '', abort: new AbortController(), endReason: null, agentId: w.current.agentId, startedAt: now() };
    let handle;
    try {
      handle = runner.openResumed({ id, line: ready.line, streamId: ready.streamId, stopHandle: cause => { Halt.markEnd(rec, cause === 'fault' ? 'faulted' : 'stopped'); rec.abort.abort(); } });
    } catch (e) { failNote('line-resume.open', e); return answer(409, { error: 'this job is already being carried out', job: ready }); }
    inflight.set(id, rec);
    const seed = { agentId: w.current.agentId, dockId: w.current.dockId || undefined, text: w.product.text, originalText: w.originalText, runId: b.entryRunId,
      entryUsd: a.entryUsd + a.hopUsd, lineId: b.lineId, streamId: ready.streamId || undefined, since: c.attempts.length ? c.attempts[0].at : undefined,
      signal: rec.abort.signal, taints: c.restriction.taints.slice(),
      // (a hold inside a split, S5: the barrier with its parts and the attempts they trace to come back with the walk, and the entry node the dead-branch rule needs)
      resume: { walk: w, files: c.files, accounting: a, dockMode: b.dockMode, barriers: c.barriers, attempts: c.attempts, entryNode: b.entryNode, decision: { action: receipt.action, note: receipt.note } } };
    const durable = {
      intent: att => store.advance(id, x => intentOf(x, att), j => !!(j.continuation && j.continuation.attempts.some(y => y.runId === att.runId))),
      observed: (att, o) => store.advance(id, x => observedOf(x, att.runId, o), j => !!(j.continuation && j.continuation.attempts.some(y => y.runId === att.runId && y.state === 'observed')))
    };
    const done = (async () => {
      let line = null;
      try {
        line = await runner.runResumed({ job: handle, seed, profile: d.profileFor(ready, c, rec), durable, halted: () => !!(typeof d.halted === 'function' && d.halted()) });
        return endOf(handle, line, seed, rec);
      } catch (e) {
        failNote('line-resume.run', e);
        try { return endOf(handle, line || { text: '', hops: [], usd: 0, stopped: 'the station hit an internal fault and stopped this job', stop: { code: 'station_fault', why: 'the station hit an internal fault and stopped this job' } }, seed, rec); }
        catch (e2) { failNote('line-resume.end', e2); runner.forget(handle); return null; }
      } finally { if (inflight.get(id) === rec) inflight.delete(id); }
    })();
    return answer(202, { running: true, job: ready, receipt: ready.continuation.decisions.find(x => x.token === receipt.token) }, done);
  }

  /* how the resumed walk ended: stopped at a gate again (a second hold), or a typed end the job finishes with */
  function endOf(handle, line, seed, rec) {
    const id = handle.id, fresh = store.read(id), c = fresh && fresh.continuation;
    if (!c) throw new Error('line job lost its saved walk');
    const base = { line, runs: rowsOf(c, d.runRow), output: String(line.text || '') + runner.stopNote(line) };
    if (Halt.endOf(rec) === 'faulted') base.stopCause = 'fault';
    if (line.hold && line.holdState && c.phase === 'ready') {
      const why = holdAgain(fresh, c, line, seed);
      if (!why) return runner.parkResumed(handle, Object.assign({}, base, { line }), { code: 'blocked', why: line.hold.why });
      // the old way, now saying why it was not held: the terminal blocked stop
      const said = LineHold.notHeld(why);
      line.holdFailed = said;
      for (const k of ['stopped', 'blocked']) if (typeof line[k] === 'string') line[k] = (line[k] + '; ' + said).slice(0, 400);
      if (line.stop && typeof line.stop === 'object') line.stop = Object.assign({}, line.stop, { why: (String(line.stop.why || '') + '; ' + said).slice(0, 400) });
      base.output = String(line.text || '') + runner.stopNote(line);
    }
    return runner.settleResumed(handle, base, portFor(id));
  }
  // save the second hold on the same job; '' when it is saved, else why it could not be
  function holdAgain(job, prior, line, seed) {
    let why = '';
    try {
      const built = LineHold.buildHeld(seed, line, job, null, { receiptFor: d.hold && d.hold.receiptFor }, prior);
      if (!built.ok) return built.reason;
      const vouch = d.authority({ phase: 'hold', job, continuation: built.continuation });
      if (vouch !== true) return (vouch && vouch.refused) || 'the station did not vouch for the hold';
      const wanted = JSON.stringify(built.continuation);
      const kept = store.advance(job.id, x => { if (x.revision + 1 !== built.continuation.revision) throw new Error('line continuation revision conflict'); return built.continuation; },
        j => !!(j.status === 'held' && j.continuation && JSON.stringify(j.continuation) === wanted));
      if (!(kept && kept.status === 'held')) why = 'the saved hold could not be read back as held';
    } catch (e) { failNote('line-resume.holdAgain', e); why = 'the hold could not be saved: ' + clip((e && e.message) || e, 120); }
    return why;
  }

  /* ---- STOP on a walk the station died in: the way out of a job nothing carries any more (line-hold lane) ----
     No decision claims it (a decision claims a held checkpoint, once), so STOP is the stop route's ask, never a second decision: the record is
     brought to a state the end can be written from — a stage whose result was never written is written down as what is known of it (reconciledOf),
     an accepted result nobody released becomes the owned stop (stoppedPendingOf), a record with nothing to write is opened for its end — and then it
     ends exactly as a held job's STOP does: terminal_pending with the owned stop, the job's own strict finish, complete. Nothing is bought, nothing
     is delivered, what already ran is counted, and the finished record is an ordinary one that retention can drop. A job something still
     carries (a live handle, an inflight walk) is never touched. */
  function closeStuck(jobId) {
    const id = String(jobId || '');
    let job;
    try { job = store.read(id); } catch (e) { failNote('line-resume.read', e); return answer(503, { error: 'Line job storage could not be verified.' }); }
    if (!job) return answer(404, { error: 'no such job' });
    if (!stuck(job) || runner.get(id) || inflight.has(id)) return answer(409, { error: 'this job is not a walk the station stopped in', job });
    try {
      let c = job.continuation;
      const node = c.walk.current;
      const stop = { code: 'stopped', why: 'a person stopped this job after the station stopped while it was out, so nothing more was bought and nothing was sent on', agentId: key(node.agentId), dockId: key(node.dockId) };
      if (c.attempts.some(a => a.state !== 'observed')) {
        job = store.advance(id, x => reconciledOf(x, d.runRow), j => !!(j.continuation && j.continuation.attempts.every(a => a.state === 'observed')));
        c = job.continuation;
      }
      const rev = c.revision;
      if (c.phase === 'terminal_pending') job = store.advance(id, x => stoppedPendingOf(x, stop), j => !!(j.continuation && ownedStop(j.continuation.terminal)));
      else if (job.status !== 'running') job = store.advance(id, x => Object.assign({}, x, { revision: x.revision + 1 }), j => j.status === 'running' && !!j.continuation && j.continuation.revision > rev);
      const now2 = job.continuation;
      const handle = runner.openResumed({ id, line: job.line, streamId: job.streamId });
      try { runner.settleResumed(handle, { stop, runs: rowsOf(now2, d.runRow), output: '' }, portFor(id)); }
      catch (e) { failNote('line-resume.closeStuck', e); runner.forget(handle); throw e; }
    } catch (e) { const f = classify(e); failNote('line-resume.closeStuck', e); return answer(f.code, { error: f.error, job: safeRead(id) }); }
    return answer(200, { stopped: true, job: safeRead(id) });
  }

  /* ---- the one door ---- */
  function resume(jobId, request) {
    const parsed = parse(request);
    if (parsed.error) return answer(400, { error: parsed.error });
    const req = parsed.req, id = String(jobId || '');
    let job;
    try { job = store.read(id); } catch (e) { failNote('line-resume.read', e); return answer(503, { error: 'Line job storage could not be verified.' }); }
    if (!job) return answer(404, { error: 'no such job' });
    if (!job.continuation || job.continuationIssue) return answer(409, { error: 'this job has nothing waiting for a decision' });
    // the claim (a replay of the same decision returns the SAVED receipt: nothing is claimed twice, nothing is bought twice)
    let claimed;
    try { claimed = store.claim(id, Object.assign({}, req, { at: now() })); }
    catch (e) { const f = classify(e); if (f.code === 503) failNote('line-resume.claim', e); return answer(f.code, { error: f.error, job: safeRead(id) }); }
    if (!claimed || !claimed.receipt) return answer(409, { error: 'this job is no longer waiting on that checkpoint. Read the job again.', job: safeRead(id) });
    const receipt = claimed.receipt, current = claimed.job || safeRead(id);
    let unstarted = false;
    if (claimed.replayed) {
      const c = current && current.continuation;
      // only a claim that landed and was never carried out is carried on (the lost acknowledgement, the restart between claim and adopt)
      const pending = receipt.state === 'accepted' && current && current.status === 'held' && c && c.activeDecision === receipt.token;
      // …or one adopted whose walk never started: no live walk, the saved record 'ready' with this decision still active (no stage was written down since)
      unstarted = !pending && receipt.state === 'adopted' && !!c && c.phase === 'ready' && c.activeDecision === receipt.token && !runner.get(id) && !inflight.has(id)
        && (current.status === 'running' || current.status === 'interrupted');
      if (!pending && !unstarted) {
        if (receipt.state === 'refused') {
          const why = (current && current.resumeRefused && current.resumeRefused.token === receipt.token && current.resumeRefused.why) || 'the station refused this decision';
          return answer(409, { error: why, refused: true, replayed: true, receipt, job: current });
        }
        return answer(200, { replayed: true, receipt, job: current });
      }
    }
    // STOP buys nothing and is never refused
    if (receipt.action === 'stop') {
      try { stopHeld(current, receipt); }
      catch (e) { const f = classify(e); failNote('line-resume.stopHeld', e); return answer(f.code === 503 ? 503 : f.code, { error: f.error, job: safeRead(id) }); }
      const ended = safeRead(id), done = ended && ended.continuation && ended.continuation.decisions.find(x => x.token === receipt.token);
      return answer(200, { stopped: true, replayed: !!claimed.replayed, receipt: done || receipt, job: ended });
    }
    const verdict = authorityOf(current, current.continuation);
    // (an adopted decision whose walk never started is no held checkpoint any more: a refusal leaves it as it is, to be asked for again)
    if (verdict !== true && unstarted) return answer(409, { error: verdict, refused: true, replayed: true, receipt, job: current });
    if (verdict !== true) {
      let kept;
      try { kept = store.refuse(id, receipt.token, verdict, now()); }
      catch (e) { const f = classify(e); failNote('line-resume.refuse', e); return answer(f.code, { error: f.error + ' (' + verdict + ')', job: safeRead(id) }); }
      return answer(409, { error: verdict, refused: true, receipt: kept && kept.continuation ? kept.continuation.decisions.find(x => x.token === receipt.token) : receipt, job: kept });
    }
    return carryOn(current, receipt, unstarted);
  }
  function safeRead(id) { try { return store.read(id); } catch (e) { failNote('line-resume.reread', e); return null; } }

  return { resume, closeStuck, inflight };
}

module.exports = { makeLineResume, adopted, intentOf, observedOf, terminalOf, publishingOf, completeOf, closeDecisions, rowsOf, classify, stuck, reconciledOf, stoppedPendingOf, ACTIONS, MAX_NOTE };
