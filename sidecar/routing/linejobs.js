/* sidecar/routing/linejobs.js — LINE JOBS (2026-09-30, Andrew: "the easiest conveyor system we can possibly put together … clear as
   day"). Every job sent down a work line — from the WORKFLOWS window, or the Workflow panel's RUN ONE REAL JOB (one route, POST
   /api/routing/sample) — is kept as ONE record: what was asked, the line it rode, each step's run, what came out, what it cost and
   how it ended, plus what the Commander changed because of it (a suggested fix used or put back, a result kept as the example) and
   which earlier job it re-ran. The WORKFLOWS window and the OUTBOX open the same record, after a reload or a restart.

   TRUTH: a record says only what the route recorded. Its status is the route's own verdict (delivered = the route's `completed`:
   every stage ran clean and the line ships to the OUTBOX), its runs are runs.jsonl rows, its output is what the line delivered,
   and a job the station restarted under is said as interrupted — never left "running".

   SEND TO (2026-10-10): a job one line's OUTBOX handed on to another line is a record of ITS line, carrying `from` — the line
   and job it came from — and the job it came from carries `sentTo`, the line and job it went on to. Each line's result stays its
   own (the sending job's output is still what that line delivered); the two records point at each other.
   (2026-10-11 repair) A handed-on job's `text` is the job AS IT FIRST ARRIVED (never the machine frame the line was handed —
   2000 characters of it lost what the sending line delivered) and `handedIn` is what the sending line delivered (MAX_OUTPUT).
   A REFUSED hand-off links the sending job with sentTo.refused = why, so no surface says "sent on" for work that was not; a
   standing refusal (the same line, the same reason, back to back) is counted on ONE record (`repeats`), never a new record
   per job pushing every line's history out of the store.

   EVERY ENTRY IS A RECORD (line-job-runner, 2026-11-03): a chat message that rides a line, a scheduled or Run Now fire, a webhook or
   folder trigger, a SEND TO hand-off, a job you send and a step-through test each keep one (sidecar/routing/line-runner.js opens and
   settles them). Additive fields: `entry` (which door: channel | schedule | manual | trigger | sendto | sample | steptest), `outcome`
   (RunOutcome.LINE_OUTCOMES: how the job ended) and `stop` { code (RunOutcome.LINE_STOPS), why, agentId?, dockId? } (where its walk
   stopped). `status` stays the word every older reader knows (RunOutcome.lineStatus(outcome)); a record written before the codes has
   neither field and is read through its status (RunOutcome.lineOutcomeOf). Status 'paused' is a step-through test waiting on you: boot
   keeps it (an older build reads it as interrupted). Only the job's own finish rewrites a record.
   FAIR RETENTION: the store still keeps MAX_JOBS records in all, but the one that goes is the OLDEST FINISHED record of the line
   holding the most records — never a running or paused one — so one busy chat line cannot push every other line's history out.

   A JOB HELD FOR A PERSON (line-hold lane): a walk that stopped at a reviewer's gate is status 'held' with its saved walk (the version 1
   continuation). checkpoint writes it; claimDecision records ONE person's word on it (exactly-once: token + revision); refuseDecision marks a
   claimed decision refused when the station's authority changed while it waited, with the reason on the record (resumeRefused) and the job
   still held; boot turns a stage that was written down as an intent and never recorded into an UNCERTAIN attempt, which nothing runs.
   list() keeps every held row beside its limit (a hold is the one record nobody else finds: the window's page of the newest 100 used to lose it).
   Pure: state in, state out ({ jobs: [...] }, newest last). The sidecar persists it (makeDomainStore → line-jobs.json). */
'use strict';
const RunOutcome = require('../../frontend/app/runoutcome.js');   // the line's stop codes and outcomes (LINE_STOPS / LINE_OUTCOMES)
const Continuation = require('./line-continuation.js');
const Accounting = require('./line-accounting.js');
const owns = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const PRESERVED_SOURCE = Symbol('line-jobs original non-rewriteable rows');

const MAX_JOBS = 120;       // newest kept; an older record drops off (its runs and transcripts stay in the logbook)
const MAX_TEXT = 2000;       // the job as sent (the route reads at most 2000 characters)
const MAX_OUTPUT = 12000;    // what the line delivered
const MAX_RUNS = 40;
const MAX_HELD = 40;        // jobs waiting for a person at once: a held job carries its whole saved walk and is never trimmed, so the count is bounded
const MAX_NOTES = 12;
const MAX_NOTE = 2000;
const STATUSES = Object.assign(Object.create(null), { running: 1, paused: 1, held: 1, delivered: 1, problem: 1, stopped: 1, failed: 1, interrupted: 1 });
const LIVE = Object.assign(Object.create(null), { running: 1, paused: 1, held: 1 });
const ENTRIES = Object.assign(Object.create(null), { channel: 1, schedule: 1, manual: 1, trigger: 1, sendto: 1, sample: 1, steptest: 1 });
const NOTE_KINDS = { fix: 1, example: 1, putback: 1 };
const ID_RE = /^job-[a-z0-9]{8,24}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;   // a line key (its oldest machine's prop id) / a dock id / a run id / an agent id

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
const key = v => { const s = str(v, 120).trim(); return KEY_RE.test(s) ? s : ''; };

// (typed-outcomes) a step's record keeps its run's OUTCOME (and finishReason) beside the reason: the WORKFLOWS window's "which step did not
// finish" reads RunOutcome.ofRow off it, and a provider-cut step ends 'done' too. A record with no reason proves no ending: 'error', never 'done'.
// Review 4.3: a failed step keeps its run's own failureCode (bounded), so its words name the real code, never the generic run_failure.
const OUTCOME_RE = /^[a-z_]{1,24}$/;
const FAILURE_CODE_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
function normRun(r) {
  if (!r || typeof r !== 'object' || !key(r.runId)) return null;
  const out = { runId: key(r.runId), agentId: key(r.agentId), dockId: key(r.dockId) || null, reason: str(r.reason, 40) || 'error', usd: num(r.usd) };
  if (OUTCOME_RE.test(str(r.outcome, 24))) out.outcome = str(r.outcome, 24);
  if (FAILURE_CODE_RE.test(str(r.failureCode, 80))) out.failureCode = str(r.failureCode, 80);
  if (r.finishReason === 'length' || r.finishReason === 'content_filter') out.finishReason = r.finishReason;
  if (r.clarifying === true) out.clarifying = true;
  return out;
}
function normNote(n) {
  if (!n || typeof n !== 'object' || !NOTE_KINDS[n.kind]) return null;
  // role: the step's NAME when it has one (setPropLabel keeps 48 characters), else its role — kept whole, never cut mid-word
  return { kind: n.kind, at: num(n.at), dockId: key(n.dockId) || null, role: str(n.role, 48), field: n.field === 'hands' ? 'hands' : 'does',
    text: str(n.text, MAX_NOTE), was: str(n.was, MAX_NOTE), why: str(n.why, 400) };
}
// (additive, line-job-runner) where the walk stopped: a typed code, its one sentence, and the stage it stopped at
function normStop(x) {
  if (!x || typeof x !== 'object' || !RunOutcome.isLineStop(x.code)) return null;
  const out = { code: x.code, why: str(x.why, 400) };
  if (key(x.agentId)) out.agentId = key(x.agentId);
  if (key(x.dockId)) out.dockId = key(x.dockId);
  return out;
}
// a hand-off end: the other line's key + its job (null when that job kept no record — a trigger's or a channel's) + its name then
function normEnd(e) {
  if (!e || typeof e !== 'object' || !key(e.line)) return null;
  const out = { line: key(e.line), jobId: ID_RE.test(String(e.jobId || '')) ? String(e.jobId) : null, name: str(e.name, 48) };
  const why = str(e.refused, 300).trim();
  if (why) out.refused = why;   // (additive) the hand-off was REFUSED: nothing was sent on — the reason
  // (additive, GitHub #122) the work handed on came out of a review loop that ran out of passes: nobody approved it — the reason
  const ua = str(e.unapproved, 300).trim();
  if (ua) out.unapproved = ua;
  return out;
}
function normJob(j) {
  if (!j || typeof j !== 'object' || !ID_RE.test(String(j.id || '')) || !key(j.line)) return null;
  const job = {
    id: String(j.id), line: key(j.line), name: str(j.name, 60), text: str(j.text, MAX_TEXT), streamId: key(j.streamId),
    status: STATUSES[j.status] ? j.status : 'interrupted', startedAt: num(j.startedAt), endedAt: num(j.endedAt) || null,
    usd: num(j.usd), output: str(j.output, MAX_OUTPUT), error: str(j.error, 400),
    runs: (Array.isArray(j.runs) ? j.runs : []).map(normRun).filter(Boolean).slice(0, MAX_RUNS),
    notes: (Array.isArray(j.notes) ? j.notes : []).map(normNote).filter(Boolean).slice(-MAX_NOTES),
    retryOf: ID_RE.test(String(j.retryOf || '')) ? String(j.retryOf) : null,
    from: normEnd(j.from), sentTo: normEnd(j.sentTo),
  };
  // (additive, SEND TO) what the sending line delivered, beside the job as it first arrived — only on a handed-on job
  if (key(j.intakeId)) job.intakeId = key(j.intakeId);   // host-proved entry INBOX at admission; later floor edits never rewrite it
  if (job.from) { const h = str(j.handedIn, MAX_OUTPUT); if (h) job.handedIn = h; }
  // Host-owned webhook receipt. Hashes bind a request reservation to this exact job without keeping its secret/key.
  const delivery = j.delivery;
  if (delivery && /^trg_[a-z0-9]{8,24}$/.test(String(delivery.triggerId || ''))
    && /^[a-f0-9]{64}$/.test(String(delivery.reservationId || '')) && /^[a-f0-9]{64}$/.test(String(delivery.fingerprint || ''))) {
    job.delivery = { triggerId: String(delivery.triggerId), reservationId: String(delivery.reservationId), fingerprint: String(delivery.fingerprint) };
  }
  /* (additive, GitHub #122) a DELIVERED job whose review loop used all its passes without approving it: the LOOP sent the work on, so
     it is delivered — and this says, in words, that nobody approved it (the route's own reason; absent on every clean job) */
  const ua = str(j.unapproved, 300).trim();
  if (ua) job.unapproved = ua;
  // (additive) a standing refusal counted on one record: how many hand-offs it stands for
  const rep = Math.floor(num(j.repeats));
  if (rep > 1) job.repeats = Math.min(rep, 1e6);
  // (additive, line-job-runner) the door it came in by, how it ended and where its walk stopped (header)
  if (ENTRIES[j.entry]) job.entry = j.entry;
  if (RunOutcome.LINE_OUTCOMES.indexOf(j.outcome) >= 0) job.outcome = j.outcome;
  const stop = normStop(j.stop);
  if (stop) job.stop = stop;
  if (owns(j, 'continuation')) {
    const c = Continuation.inspect(j.continuation, job);
    job.continuation = c.value; // includes opaque future/invalid JSON: never silently drop it
    if (!c.ok) job.continuationIssue = { code: c.issue.code, message: c.issue.message, readOnly: c.readOnly };
    if (c.ok && c.value.phase === 'held') {
      job.status = 'held'; job.outcome = 'blocked'; job.endedAt = null;
      job.stop = { code: 'blocked', why: c.value.hold.why };
      job.error = c.value.hold.why;
      /* A PARKED job still shows what it cost and which stages ran (line-hold lane, S3): the spend and the stage list are read from the
         saved continuation itself — derived, so a reload or a boot can never drift from it. It shows NO output: nothing was delivered, and
         the draft under review is the continuation's to show (a list row never carries it: test/linejobs.continuation.test.js) */
      const v = c.value;
      job.usd = num(v.accounting.entryUsd + v.accounting.hopUsd);
      job.runs = v.attempts.slice().reverse().map(a => normRun({ runId: a.runId, agentId: a.node.agentId, dockId: a.node.dockId,
        reason: RunOutcome.reasonOf({ outcome: a.outcome }), usd: a.usd, outcome: a.outcome })).filter(Boolean).slice(0, MAX_RUNS);
      job.output = '';
      /* (line-hold lane, S4) the reason the station refused the person's LAST decision on this hold (authority changed while it waited):
         kept only while that refused decision is still the last word on the hold, so a newer claim, an adoption or the end clears it */
      const last = v.decisions[v.decisions.length - 1], rr = j.resumeRefused;
      if (rr && typeof rr === 'object' && last && last.state === 'refused' && last.token === rr.token && v.activeDecision === null) {
        job.resumeRefused = { token: last.token, action: last.action, why: str(rr.why, 400), at: num(rr.at) };
      }
    } else if (job.status === 'held' || (!c.ok && job.status === 'running')) {
      job.status = 'interrupted'; job.outcome = 'interrupted'; job.endedAt = null;
      job.error = c.ok ? 'saved human hold has no held checkpoint' : c.issue.message;
    }
  } else if (job.status === 'held') {
    job.status = 'interrupted'; job.outcome = 'interrupted'; job.endedAt = null;
    job.error = 'saved human hold has no continuation';
  }
  if (owns(j, 'entryAdmission')) {
    const e = Continuation.inspectEntry(j.entryAdmission, job);
    job.entryAdmission = e.value;
    if (!e.ok) job.entryIssue = { code: e.issue.code, message: e.issue.message, readOnly: e.readOnly };
    if (!e.ok || e.value.state === 'uncertain') {
      const why = e.ok ? 'the saved entry attempt is uncertain; reconcile its original run before continuing' : e.issue.message;
      job.status = 'interrupted'; job.outcome = 'interrupted'; job.endedAt = null;
      job.error = why; job.stop = { code: 'restart', why };
    }
  }
  if (owns(j, 'entryAdmission') && owns(j, 'continuation')) {
    const p = Continuation.inspectEntryPair(job.entryAdmission, job.continuation, job);
    if (!p.ok) {
      job.entryIssue = { code: p.issue.code, message: p.issue.message, readOnly: true };
      job.status = 'interrupted'; job.outcome = 'interrupted'; job.endedAt = null;
      job.error = p.issue.message; job.stop = { code: 'restart', why: p.issue.message };
    }
  }
  return job;
}
function pendingContinuation(j) {
  if (owns(j, 'entryAdmission') && (!owns(j, 'continuation')
    || !Continuation.inspectEntryPair(j.entryAdmission, j.continuation, j).ok)) return true;
  if (!owns(j, 'continuation')) return false;
  const c = Continuation.inspect(j.continuation, j);
  return !c.ok || c.value.phase !== 'complete' || j.endedAt == null;
}
function writable(state) {
  Accounting.demand(state, 'jobs');
  if (state && (owns(state, PRESERVED_SOURCE) || (state.continuationIssue && state.continuationIssue.readOnly === true))) {
    const e = new Error('line-jobs: continuation has an invalid or duplicate enclosing record; original store must be preserved');
    e.code = 'ELINE_CONTINUATION_READONLY'; throw e;
  }
  for (const j of ((state && Array.isArray(state.jobs)) ? state.jobs : [])) {
    if (owns(j, 'entryAdmission') && (owns(j, 'continuation')
      ? !Continuation.inspectEntryPair(j.entryAdmission, j.continuation, j).ok
      : Continuation.inspectEntry(j.entryAdmission, j).readOnly)) {
      const e = new Error('line-jobs: entry authority cannot be rewritten or adopted by this operation; original store must be preserved');
      e.code = 'ELINE_ENTRY_READONLY'; throw e;
    }
    if (owns(j, 'continuation') && Continuation.inspect(j.continuation, j).readOnly) {
      const e = new Error('line-jobs: saved continuation cannot be rewritten losslessly; original store must be preserved');
      e.code = 'ELINE_CONTINUATION_READONLY'; throw e;
    }
  }
}
/* FAIR RETENTION (header): over MAX_JOBS, the oldest FINISHED record of the line holding the most records goes, one at a time; a
   running or paused record never does (a store of nothing but live records keeps them all). jobs: oldest first. */
function retain(jobs) {
  const list = jobs.slice();
  while (list.length > MAX_JOBS) {
    const count = Object.create(null);
    for (const j of list) count[j.line] = (count[j.line] || 0) + 1;
    let top = 0;
    for (const j of list) if (!LIVE[j.status] && !pendingContinuation(j) && count[j.line] > top) top = count[j.line];
    if (!top) break;
    list.splice(list.findIndex(j => !LIVE[j.status] && !pendingContinuation(j) && count[j.line] === top), 1);
  }
  return list;
}
function normalizeAll(value) {
  if (value && owns(value, PRESERVED_SOURCE)) return value;
  const seen = new Map(), jobs = [];
  let protectedRows = Accounting.owns(value, Accounting.FIELD) && !Array.isArray(value.jobs) ? 1 : 0;
  const source = (value && Array.isArray(value.jobs)) ? value.jobs : [];
  for (const j of source) {
    const hasContinuation = j && typeof j === 'object' && (owns(j, 'continuation') || owns(j, 'entryAdmission'));
    const n = normJob(j);
    if (!n) { if (hasContinuation) protectedRows++; continue; }
    if (seen.has(n.id)) {
      if (hasContinuation || seen.get(n.id)) protectedRows++;
      continue;
    }
    seen.set(n.id, !!hasContinuation); jobs.push(n);
  }
  jobs.sort((a, b) => a.startedAt - b.startedAt);
  if (protectedRows || (value && value.continuationIssue && value.continuationIssue.readOnly === true)) {
    // Keep the source objects alive without placing malformed rows into normal readers.
    // They are not a second store: all writes/boot rewrites are refused, so the original
    // existing file remains the durable authority. The strict host writer must use writable.
    const state = Accounting.preserve(value, { jobs, continuationIssue: { readOnly: true, code: 'enclosing_record',
      message: 'saved continuation has an invalid or duplicate enclosing job; original data is preserved', records: protectedRows } });
    Object.defineProperty(state, PRESERVED_SOURCE, { value: source });
    return state;
  }
  return Accounting.preserve(value, { jobs: retain(jobs) });
}
// Root enrollment outlives every completed job. All mutation helpers carry it,
// including ordinary legacy operations that know nothing about continuations.
const withJobs = (state, jobs) => Accounting.preserve(state, { jobs });
function decodeEnvelope(envelope) {
  return envelope && (envelope.version === undefined || envelope.version === 1) && Array.isArray(envelope.jobs)
    ? Accounting.preserve(envelope, { jobs: envelope.jobs }) : undefined;
}
function encodeEnvelope(state) { writable(state); return withJobs(state, state.jobs); }
function accounting(state) { return Accounting.demand(state, 'jobs'); }
function observeAccounting(previous, state) { return Accounting.observe(previous, state, 'jobs'); }
function enrollAccounting(state, ledgerId, phase) {
  writable(state);
  if (!Accounting.validId(ledgerId) || !['prepared', 'confirmed'].includes(phase)) throw new Error('line-jobs: invalid accounting enrollment');
  const prior = accounting(state);
  if (prior && prior.ledgerId !== ledgerId) throw new Error('line-jobs: accounting enrollment belongs to another ledger');
  if (!prior && phase !== 'prepared') throw new Error('line-jobs: accounting confirmation requires its prepared receipt');
  if (prior && (prior.state === 'confirmed' || prior.state === phase)) return { state, enrollment: prior, replayed: true };
  const enrollment = { version: 1, ledgerId, state: phase };
  return { state: Accounting.put(state, enrollment), enrollment, replayed: false };
}
const idx = (state, id) => (state && Array.isArray(state.jobs) ? state.jobs.findIndex(j => j.id === id) : -1);

// a job goes out: the record exists from the moment the line is dispatched, as running (entry: the door it came in by)
function start(state, o) {
  writable(state);
  const existing = get(state, o.id);
  if (existing && (owns(existing, 'continuation') || owns(existing, 'entryAdmission'))) throw new Error('line job paid-work authority cannot be replaced by a new admission');
  const job = normJob({ id: o.id, line: o.line, name: o.name, text: o.text, streamId: o.streamId, status: 'running', outcome: 'running', startedAt: o.at, retryOf: o.retryOf, from: o.from, handedIn: o.handedIn, entry: o.entry, delivery: o.delivery, intakeId: o.intakeId });
  if (!job) return { state, job: null };
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).filter(j => j.id !== job.id).concat([job]);
  return { state: withJobs(state, retain(jobs)), job };
}
/* the job's own end: status delivered | problem (steps ran, not all clean) | stopped | failed (nothing durable ran) | interrupted, with
   (additive) its outcome and typed stop — line-runner.js settle decides all three, once. A finish with no stop keeps none. */
function finish(state, id, o) {
  writable(state);
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  if (owns(state.jobs[i], 'entryAdmission') && !owns(state.jobs[i], 'continuation')) throw new Error('line entry must settle through its private receipt owner');
  if (owns(state.jobs[i], 'continuation')) {
    const c = Continuation.inspect(state.jobs[i].continuation, state.jobs[i]);
    if (!c.ok || !['terminal_pending', 'complete'].includes(c.value.phase)) throw new Error('line continuation must finish through its checkpoint owner');
    const t = c.value.terminal, runs = Array.isArray(o.runs) ? o.runs : [];
    if (o.outcome !== t.outcome || o.status !== RunOutcome.lineStatus(t.outcome) || o.output !== t.output || o.usd !== t.usd
      || JSON.stringify(normStop(o.stop)) !== JSON.stringify(normStop(t.stop)) || runs.length !== t.runIds.length
      || new Set(runs.map(r => r.runId)).size !== runs.length || runs.some(r => !t.runIds.includes(r.runId)
        || !c.value.attempts.some(a => a.runId === r.runId && a.usd === r.usd))) throw new Error('line finish does not match its exact continuation result');
  }
  const job = normJob(Object.assign({}, state.jobs[i], { status: o.status, endedAt: o.at, usd: o.usd, output: o.output, error: o.error, runs: o.runs, unapproved: o.unapproved,
    outcome: o.outcome, stop: o.stop || null }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, retain(jobs)), job };
}
// a step-through test paused on you (or carrying on): a live record moves between running and paused, its outcome with it
function mark(state, id, status) {
  writable(state);
  const i = idx(state, id);
  if (i < 0 || !['paused', 'running'].includes(status) || !['paused', 'running'].includes(state.jobs[i].status)
    || owns(state.jobs[i], 'continuation') || owns(state.jobs[i], 'entryAdmission')) return { state, job: null };
  const job = Object.assign({}, state.jobs[i], { status, outcome: status });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job };
}
// SEND TO: this job's work went on to another line's job (set as the hand-off goes out; finish() keeps it)
function link(state, id, sentTo) {
  writable(state);
  const i = idx(state, id), e = normEnd(sentTo);
  if (i < 0 || !e) return { state, job: null };
  const job = Object.assign({}, state.jobs[i], { sentTo: e });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job };
}
// a standing refusal again: the same record counts one more hand-off it refused (repeats), its end time moves to now
function again(state, id, at) {
  writable(state);
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  if (owns(state.jobs[i], 'entryAdmission')) return { state, job: null };
  const cur = state.jobs[i];
  const job = normJob(Object.assign({}, cur, { repeats: Math.max(1, cur.repeats || 1) + 1, endedAt: num(at) || cur.endedAt }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job };
}
// the newest record on a line, or null (the handoff runner's standing-refusal check)
function latest(state, line) {
  const l = key(line), jobs = (state && Array.isArray(state.jobs)) ? state.jobs : [];
  if (!l) return null;
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].line === l) return jobs[i];
  return null;
}
// the job a stream's work belongs to (the newest record on that stream), or null
function byStream(state, streamId) {
  const s = key(streamId), jobs = (state && Array.isArray(state.jobs)) ? state.jobs : [];
  if (!s) return null;
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].streamId === s) return jobs[i];
  return null;
}
// what the Commander changed because of this job (a fix used or put back, the result kept as the example)
function note(state, id, n) {
  writable(state);
  const i = idx(state, id), nn = normNote(n);
  if (i < 0 || !nn) return { state, job: null };
  const cur = state.jobs[i];
  const job = Object.assign({}, cur, { notes: cur.notes.concat([nn]).slice(-MAX_NOTES) });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job };
}
/* the station (re)started: nothing is riding a line any more — a job left "running" is said as interrupted (outcome interrupted, code
   restart). A PAUSED record is a step-through test waiting on you: its session comes back paused, so its record stays as it is (the
   step test's own boot finishes one whose session is gone). */
const BOOT_WHY = 'the station stopped while this job was out — send it again';
function boot(state, at, ownedIds) {
  // Do not replace original bytes while boot-normalizing another row beside an
  // oversized/uncapturable payload. Every public mutation helper refuses it too.
  try { writable(state); } catch (error) { return { state, changed: false, issue: error.message }; }
  let changed = false;
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).map(j => {
    if (ownedIds && !ownedIds.has(j.id)) return j;
    if (owns(j, 'entryAdmission') && !owns(j, 'continuation')) {
      const e = Continuation.inspectEntry(j.entryAdmission, j);
      if (!e.ok || e.value.state === 'uncertain') return j;
      entryEnrollment(state, e.value);
      if (e.value.state === 'observed') {
        if (j.status !== 'running') return j;
        const why = 'the saved entry result is retained; the line has not resumed after restart';
        changed = true;
        return Object.assign({}, j, { status: 'interrupted', outcome: 'interrupted', endedAt: null,
          stop: { code: 'restart', why }, error: why });
      }
      const next = Object.assign({}, e.value, { revision: e.value.revision + 1, state: 'uncertain' });
      const r = Continuation.checkpointEntry(e.value, j, e.value.revision, next);
      changed = true;
      return normJob(Object.assign({}, j, { entryAdmission: r.receipt }));
    }
    if (j.status !== 'running') return j;
    changed = true;
    const continued = owns(j, 'continuation');
    const why = continued ? 'the station stopped during this saved walk; its exact run receipts must be reconciled before continuing' : BOOT_WHY;
    /* (line-hold lane, S4) a resumed job's stage was written down as an INTENT before it was bought. If the station died before its result
       was written, whether it was bought is not known: the saved attempt turns UNCERTAIN, the one phase nothing runs from (a person
       reconciles it), so the same stage is never paid for twice. An invalid or any other saved walk is left exactly as it is. */
    let carried = null;
    if (continued) {
      const c = Continuation.inspect(j.continuation, j);
      if (c.ok && c.value.phase === 'intent') {
        try { carried = Continuation.checkpoint(c.value, j, c.value.revision, Object.assign({}, c.value, { revision: c.value.revision + 1, phase: 'uncertain' })); }
        catch (e) { carried = null; }
      }
    }
    return Object.assign({}, j, { status: 'interrupted', outcome: 'interrupted', stop: { code: 'restart', why }, endedAt: continued ? null : num(at) || j.startedAt, error: why }, carried ? { continuation: carried } : null);
  });
  return { state: withJobs(state, jobs), changed };
}
// the window's list: newest first, the heavy output cut to a glance (the full record is one GET away)
function summary(j) {
  const s = { id: j.id, line: j.line, name: j.name, text: j.text.slice(0, 240), status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    usd: j.usd, steps: j.runs.length, preview: j.output.replace(/\s+/g, ' ').trim().slice(0, 240), error: j.error, retryOf: j.retryOf,
    streamId: j.streamId, notes: j.notes.length, from: j.from || null, sentTo: j.sentTo || null };
  if (j.repeats > 1) s.repeats = j.repeats;
  if (j.unapproved) s.unapproved = j.unapproved;
  // (additive, line-job-runner) the door, the job's end and where it stopped — the WORKFLOWS rows and card read them
  if (j.entry) s.entry = j.entry;
  if (j.outcome) s.outcome = j.outcome;
  if (j.stop) s.stop = j.stop;
  if (owns(j, 'continuation')) {
    const c = Continuation.inspect(j.continuation, j);
    s.continuation = c.ok ? { version: c.value.version, revision: c.value.revision, phase: c.value.phase }
      : { issue: c.issue.code, message: c.issue.message, readOnly: c.readOnly };
    // (line-hold lane) a parked job tells the window why it is held, where, and what a person may decide — bounded, never the work itself
    if (c.ok && c.value.phase === 'held') {
      const h = c.value.hold;
      s.hold = { reason: h.reason, why: h.why, gateId: h.gateId, pass: h.pass, allowed: h.allowed.slice(), revision: c.value.revision };
      if (j.resumeRefused) s.hold.refused = { action: j.resumeRefused.action, why: j.resumeRefused.why, at: j.resumeRefused.at };
      const live = c.value.decisions.find(d => d.token === c.value.activeDecision);
      if (live) s.hold.deciding = { action: live.action, state: live.state };   // a decision was recorded and is not carried out yet
    }
  }
  return s;
}
function list(state, o) {
  o = o || {};
  const line = o.line ? key(o.line) : '', stream = o.stream ? key(o.stream) : '';
  const hasRun = o.runId != null, runId = hasRun ? String(o.runId) : '';
  if (hasRun && !KEY_RE.test(runId)) return []; // an invalid exact identity never widens to newest-in-stream
  if (hasRun && ((o.stream && !stream) || (o.line && !line))) return [];
  const limit = Math.max(1, Math.min(100, Number(o.limit) || 30));
  const out = [];
  const jobs = (state && Array.isArray(state.jobs)) ? state.jobs : [];
  /* A JOB WAITING FOR A PERSON IS NEVER CUT FROM A PAGE (line-hold lane). A hold is kept until somebody decides it, and this list is the
     only place a person finds it (the WORKFLOWS window reads GET /api/line-jobs?limit=100): the newest `limit` rows dropped it after that
     many later jobs, and the work was stranded with nobody able to approve, send back or stop it. Held rows ride BESIDE the limit —
     every one that matches the filters, newest first among the rest — and ordinary rows are bounded exactly as they were. The filters
     still apply: an exact identity read (a stream, a run) never gains a hold that is not that identity. */
  let ordinary = 0;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i], held = j.status === 'held';
    if (!held && ordinary >= limit) continue;
    if (line && j.line !== line) continue;
    if (stream && j.streamId !== stream) continue;
    if (hasRun && !j.runs.some(r => r.runId === runId)) continue;
    if (!held) ordinary++;
    out.push(summary(j));
  }
  return out;
}
function get(state, id) { const i = idx(state, id); return i < 0 ? null : state.jobs[i]; }
const isId = id => ID_RE.test(String(id || ''));

/* Pure mutations only. No host route calls these yet; the next slice must persist and
   read back before publishing their state or using an accepted decision. */
function checkpoint(state, id, expectedRevision, next) {
  writable(state);
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const prior = state.jobs[i];
  if (owns(prior, 'entryAdmission') && !owns(prior, 'continuation')) throw new Error('entry adoption belongs to its private receipt owner');
  if (!owns(prior, 'continuation') && prior.status !== 'running') throw new Error('a settled or paused job cannot acquire a review continuation');
  const c = Continuation.checkpoint(owns(prior, 'continuation') ? prior.continuation : undefined, prior, expectedRevision, next);
  if (owns(prior, 'entryAdmission')) Continuation.demandEntryPair(prior.entryAdmission, c, prior);
  if (prior.endedAt == null && (c.phase === 'complete' || (c.publication && c.publication.state === 'confirmed'))) throw new Error('line publication requires an accepted terminal job first');
  // a job that parks for a person is kept until someone decides it (retain never trims it): past MAX_HELD the next one is refused here and
  // its line ends the way it always did, the reason said — a flaky reviewer cannot grow the saved store without bound
  if (!owns(prior, 'continuation') && c.phase === 'held' && state.jobs.filter(j => j.status === 'held').length >= MAX_HELD) {
    throw new Error('line-jobs: ' + MAX_HELD + ' jobs are already waiting for a decision, so this one cannot be held');
  }
  const uncertain = c.phase === 'uncertain';
  const why = uncertain ? 'a saved attempt has no confirmed terminal receipt; reconcile it before continuing' : '';
  const projection = prior.endedAt != null ? {} : { endedAt: null,
    status: uncertain ? 'interrupted' : 'running', outcome: uncertain ? 'interrupted' : 'running',
    stop: uncertain ? { code: 'restart', why } : null, error: why };
  // A verified terminal job may still await publication receipts. Confirming those
  // receipts must never reopen the job, and publication must not precede strict finish.
  const job = normJob(Object.assign({}, prior, projection, { continuation: c }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job };
}
function claimDecision(state, id, request) {
  writable(state);
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const prior = state.jobs[i];
  if (!owns(prior, 'continuation')) throw new Error('job has no saved review checkpoint');
  const r = Continuation.claimDecision(prior.continuation, prior, request);
  if (r.replayed) return { state, job: prior, receipt: r.receipt, replayed: true };
  const job = normJob(Object.assign({}, prior, { continuation: r.continuation }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job, receipt: r.receipt, replayed: false };
}
/* The station REFUSED a person's decision after claiming it (line-hold lane, S4): the floor, E-STOP, a cap or a file the work carries
   changed while the job waited. The claimed decision is marked refused (nothing was bought, the job stays HELD at the same gate) and the
   reason rides on the record, so the window says why and a LATER, new decision is the only way on: clearing the cause never approves
   anything. request: { token, why, at }. A refusal already recorded for that token is a replay and writes nothing. */
function refuseDecision(state, id, request) {
  writable(state);
  const i = idx(state, id), r = request || {};
  if (i < 0) return { state, job: null };
  const prior = state.jobs[i];
  if (!owns(prior, 'continuation')) throw new Error('job has no saved review checkpoint');
  const before = Continuation.demand(prior.continuation, prior), d = before.decisions.find(x => x.token === r.token);
  if (!d) throw new Error('no such line decision');
  if (d.state === 'refused') return { state, job: prior, receipt: d, replayed: true };
  if (before.phase !== 'held' || before.activeDecision !== d.token || d.state !== 'accepted') throw new Error('only the claimed decision on a held job can be refused');
  const c = Continuation.refuseDecision(before, prior, d.token);
  const job = normJob(Object.assign({}, prior, { continuation: c, resumeRefused: { token: d.token, action: d.action, why: str(r.why, 400), at: num(r.at) } }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job, receipt: c.decisions.find(x => x.token === d.token), replayed: false };
}

function entryEnrollment(state, receipt) {
  const enrolled = Accounting.demand(state, 'jobs');
  if (!enrolled || enrolled.state !== 'confirmed' || enrolled.ledgerId !== receipt.ledgerId) throw new Error('line entry requires its exact confirmed accounting enrollment');
}
function entryMutation(state, id, change) {
  writable(state);
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const prior = state.jobs[i];
  if (owns(prior, 'continuation')) throw new Error('a saved continuation cannot acquire another entry');
  const r = change(prior);
  entryEnrollment(state, r.receipt);
  if (r.replayed) return { state, job: prior, receipt: r.receipt, replayed: true };
  const job = normJob(Object.assign({}, prior, { entryAdmission: r.receipt, status: 'running', outcome: 'running',
    endedAt: null, stop: null, error: '' }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job, receipt: job.entryAdmission, replayed: false };
}
function prepareEntry(state, id, request) {
  return entryMutation(state, id, prior => {
    if (!owns(prior, 'entryAdmission') && (prior.status !== 'running' || prior.endedAt != null)) throw new Error('only an existing running job may prepare its first entry');
    return Continuation.prepareEntry(owns(prior, 'entryAdmission') ? prior.entryAdmission : undefined, prior, request);
  });
}
function checkpointEntry(state, id, expectedRevision, next) {
  return entryMutation(state, id, prior => {
    if (!owns(prior, 'entryAdmission')) throw new Error('job has no prepared entry');
    return Continuation.checkpointEntry(prior.entryAdmission, prior, expectedRevision, next);
  });
}
function adoptEntry(state, id, expectedRevision, continuation) {
  writable(state);
  const i = idx(state, id), prior = i < 0 ? null : state.jobs[i];
  if (!prior || !owns(prior, 'entryAdmission')) throw new Error('line adoption has no existing entry receipt');
  const entry = Continuation.adoptableEntry(prior.entryAdmission, prior);
  entryEnrollment(state, entry);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== entry.revision) throw new Error('line adoption entry revision conflict');
  const c = Continuation.demandEntryPair(entry, continuation, prior).continuation;
  const initial = Continuation.seedEntryContinuation(entry, prior, c.walk);
  if (JSON.stringify(c) !== JSON.stringify(initial)) throw new Error('line adoption requires the exact original initial continuation');
  if (owns(prior, 'continuation')) {
    if (JSON.stringify(prior.continuation) !== JSON.stringify(c)) throw new Error('line adoption cannot replace its saved continuation');
    return { state, job: prior, replayed: true };
  }
  if (prior.endedAt != null || !['running', 'interrupted'].includes(prior.status)
    || c.revision !== 1 || c.phase !== 'ready') throw new Error('line adoption cannot reopen a settled job or invent a progressed cursor');
  const job = normJob(Object.assign({}, prior, { continuation: c, status: 'running', outcome: 'running', endedAt: null, stop: null, error: '' }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: withJobs(state, jobs), job, replayed: false };
}
function entryBootPending(job) {
  if (!owns(job, 'entryAdmission')) return false;
  const e = Continuation.inspectEntry(job.entryAdmission, job);
  return e.ok && e.value.state === 'intent';
}

/* FORGET (turn identity registry, entry 'line-jobs'): a job that is still waiting carries words of the chat that started it - the ask, the
   draft under review and every product on its saved walk (the continuation), or the entry receipt of a walk that has not started. When
   that chat is deleted, or the job's run read a deleted one, the unfinished record is ENDED with the station's existing refusal and the words
   go: no continuation, no entry receipt, no text, no output, no hand-in. A decision on it then finds nothing waiting (line-resume.js: 'this
   job has nothing waiting for a decision'). A running or paused record is a live walk, which the station stops by itself (stopLive) and its own
   end writes; a FINISHED record is filed under the line and keeps what it delivered (the store's exemption for finished jobs), including a
   complete continuation, whose publication receipts are accounting. bound(job) -> true for a job in the delete's scope.
   Returns { state, ids }: the state with those jobs ended, and their ids. */
function forgetUnfinished(state, bound, why, at) {
  writable(state);
  const ids = [], jobs = state.jobs.slice();
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (!j || LIVE[j.status] && j.status !== 'held') continue;
    const waiting = owns(j, 'entryAdmission') || (owns(j, 'continuation') && (j.status === 'held' || j.endedAt == null));
    if (!waiting || !bound(j)) continue;
    const next = Object.assign({}, j, { status: 'failed', outcome: 'failed', endedAt: num(j.endedAt) || num(at) || 1, text: '', output: '', error: str(why, 400),
      stop: { code: 'refused', why: str(why, 400) } });
    for (const k of ['continuation', 'continuationIssue', 'entryAdmission', 'entryIssue', 'resumeRefused', 'handedIn', 'unapproved']) delete next[k];
    jobs[i] = normJob(next);
    ids.push(j.id);
  }
  return ids.length ? { state: withJobs(state, jobs), ids } : { state, ids };
}
// the same, through the host's one mutator (index.js lineJobsSet): the change is computed against the fresh saved state, written and read back
function forgetVia(mutate, bound, why, at) {
  let ids = [];
  mutate(cur => { const out = forgetUnfinished(cur, bound, why, at); ids = out.ids; return ids.length ? { state: out.state, job: get(out.state, ids[0]) } : null; });
  return ids.length;
}

module.exports = { start, finish, mark, note, link, again, latest, byStream, boot, list, get, isId, normalizeAll, normJob, summary, retain, checkpoint, claimDecision, refuseDecision, assertWritable: writable, forgetUnfinished, forgetVia,
  accounting, observeAccounting, enrollAccounting, decodeEnvelope, encodeEnvelope, prepareEntry, checkpointEntry, entryBootPending, adoptEntry,
  MAX_JOBS, MAX_HELD, MAX_OUTPUT, MAX_TEXT, MAX_NOTES, ENTRIES: Object.keys(ENTRIES) };
