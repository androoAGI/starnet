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

   Pure: state in, state out ({ jobs: [...] }, newest last). The sidecar persists it (makeDomainStore → line-jobs.json). */
'use strict';
const RunOutcome = require('../../frontend/app/runoutcome.js');   // the line's stop codes and outcomes (LINE_STOPS / LINE_OUTCOMES)

const MAX_JOBS = 120;       // newest kept; an older record drops off (its runs and transcripts stay in the logbook)
const MAX_TEXT = 2000;       // the job as sent (the route reads at most 2000 characters)
const MAX_OUTPUT = 12000;    // what the line delivered
const MAX_RUNS = 40;
const MAX_NOTES = 12;
const MAX_NOTE = 2000;
const STATUSES = Object.assign(Object.create(null), { running: 1, paused: 1, delivered: 1, problem: 1, stopped: 1, failed: 1, interrupted: 1 });
const LIVE = Object.assign(Object.create(null), { running: 1, paused: 1 });   // never evict a running job or a test waiting on you
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
  return job;
}
/* FAIR RETENTION (header): over MAX_JOBS, the oldest FINISHED record of the line holding the most records goes, one at a time; a
   running or paused record never does (a store of nothing but live records keeps them all). jobs: oldest first. */
function retain(jobs) {
  const list = jobs.slice();
  while (list.length > MAX_JOBS) {
    const count = Object.create(null);
    for (const j of list) count[j.line] = (count[j.line] || 0) + 1;
    let top = 0;
    for (const j of list) if (!LIVE[j.status] && count[j.line] > top) top = count[j.line];
    if (!top) break;
    list.splice(list.findIndex(j => !LIVE[j.status] && count[j.line] === top), 1);
  }
  return list;
}
function normalizeAll(value) {
  const seen = {}, jobs = [];
  for (const j of ((value && Array.isArray(value.jobs)) ? value.jobs : [])) { const n = normJob(j); if (n && !seen[n.id]) { seen[n.id] = 1; jobs.push(n); } }
  jobs.sort((a, b) => a.startedAt - b.startedAt);
  return { jobs: retain(jobs) };
}
const idx = (state, id) => (state && Array.isArray(state.jobs) ? state.jobs.findIndex(j => j.id === id) : -1);

// a job goes out: the record exists from the moment the line is dispatched, as running (entry: the door it came in by)
function start(state, o) {
  const job = normJob({ id: o.id, line: o.line, name: o.name, text: o.text, streamId: o.streamId, status: 'running', outcome: 'running', startedAt: o.at, retryOf: o.retryOf, from: o.from, handedIn: o.handedIn, entry: o.entry, delivery: o.delivery });
  if (!job) return { state, job: null };
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).filter(j => j.id !== job.id).concat([job]);
  return { state: { jobs: retain(jobs) }, job };
}
/* the job's own end: status delivered | problem (steps ran, not all clean) | stopped | failed (nothing durable ran) | interrupted, with
   (additive) its outcome and typed stop — line-runner.js settle decides all three, once. A finish with no stop keeps none. */
function finish(state, id, o) {
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const job = normJob(Object.assign({}, state.jobs[i], { status: o.status, endedAt: o.at, usd: o.usd, output: o.output, error: o.error, runs: o.runs, unapproved: o.unapproved,
    outcome: o.outcome, stop: o.stop || null }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs: retain(jobs) }, job };
}
// a step-through test paused on you (or carrying on): a live record moves between running and paused, its outcome with it
function mark(state, id, status) {
  const i = idx(state, id);
  if (i < 0 || !LIVE[status] || !LIVE[state.jobs[i].status]) return { state, job: null };
  const job = Object.assign({}, state.jobs[i], { status, outcome: status });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs }, job };
}
// SEND TO: this job's work went on to another line's job (set as the hand-off goes out; finish() keeps it)
function link(state, id, sentTo) {
  const i = idx(state, id), e = normEnd(sentTo);
  if (i < 0 || !e) return { state, job: null };
  const job = Object.assign({}, state.jobs[i], { sentTo: e });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs }, job };
}
// a standing refusal again: the same record counts one more hand-off it refused (repeats), its end time moves to now
function again(state, id, at) {
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const cur = state.jobs[i];
  const job = normJob(Object.assign({}, cur, { repeats: Math.max(1, cur.repeats || 1) + 1, endedAt: num(at) || cur.endedAt }));
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs }, job };
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
  const i = idx(state, id), nn = normNote(n);
  if (i < 0 || !nn) return { state, job: null };
  const cur = state.jobs[i];
  const job = Object.assign({}, cur, { notes: cur.notes.concat([nn]).slice(-MAX_NOTES) });
  const jobs = state.jobs.slice(); jobs[i] = job;
  return { state: { jobs }, job };
}
/* the station (re)started: nothing is riding a line any more — a job left "running" is said as interrupted (outcome interrupted, code
   restart). A PAUSED record is a step-through test waiting on you: its session comes back paused, so its record stays as it is (the
   step test's own boot finishes one whose session is gone). */
const BOOT_WHY = 'the station stopped while this job was out — send it again';
function boot(state, at) {
  let changed = false;
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).map(j => {
    if (j.status !== 'running') return j;
    changed = true;
    return Object.assign({}, j, { status: 'interrupted', outcome: 'interrupted', stop: { code: 'restart', why: BOOT_WHY }, endedAt: num(at) || j.startedAt, error: BOOT_WHY });
  });
  return { state: { jobs }, changed };
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
  for (let i = jobs.length - 1; i >= 0 && out.length < limit; i--) {
    const j = jobs[i];
    if (line && j.line !== line) continue;
    if (stream && j.streamId !== stream) continue;
    if (hasRun && !j.runs.some(r => r.runId === runId)) continue;
    out.push(summary(j));
  }
  return out;
}
function get(state, id) { const i = idx(state, id); return i < 0 ? null : state.jobs[i]; }
const isId = id => ID_RE.test(String(id || ''));

module.exports = { start, finish, mark, note, link, again, latest, byStream, boot, list, get, isId, normalizeAll, normJob, summary, retain,
  MAX_JOBS, MAX_OUTPUT, MAX_TEXT, MAX_NOTES, ENTRIES: Object.keys(ENTRIES) };
