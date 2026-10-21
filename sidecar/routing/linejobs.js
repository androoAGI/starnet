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

   Pure: state in, state out ({ jobs: [...] }, newest last). The sidecar persists it (makeDomainStore → line-jobs.json). */
'use strict';

const MAX_JOBS = 120;        // newest kept; an older record drops off (its runs and transcripts stay in the logbook)
const MAX_TEXT = 2000;       // the job as sent (the route reads at most 2000 characters)
const MAX_OUTPUT = 12000;    // what the line delivered
const MAX_RUNS = 40;
const MAX_NOTES = 12;
const MAX_NOTE = 2000;
const STATUSES = { running: 1, delivered: 1, problem: 1, stopped: 1, failed: 1, interrupted: 1 };
const NOTE_KINDS = { fix: 1, example: 1, putback: 1 };
const ID_RE = /^job-[a-z0-9]{8,24}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,120}$/;   // a line key (its oldest machine's prop id) / a dock id / a run id / an agent id

const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = v => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0);
const key = v => { const s = str(v, 120).trim(); return KEY_RE.test(s) ? s : ''; };

function normRun(r) {
  if (!r || typeof r !== 'object' || !key(r.runId)) return null;
  return { runId: key(r.runId), agentId: key(r.agentId), dockId: key(r.dockId) || null, reason: str(r.reason, 40) || 'done', usd: num(r.usd) };
}
function normNote(n) {
  if (!n || typeof n !== 'object' || !NOTE_KINDS[n.kind]) return null;
  // role: the step's NAME when it has one (setPropLabel keeps 48 characters), else its role — kept whole, never cut mid-word
  return { kind: n.kind, at: num(n.at), dockId: key(n.dockId) || null, role: str(n.role, 48), field: n.field === 'hands' ? 'hands' : 'does',
    text: str(n.text, MAX_NOTE), was: str(n.was, MAX_NOTE), why: str(n.why, 400) };
}
// a hand-off end: the other line's key + its job (null when that job kept no record — a trigger's or a channel's) + its name then
function normEnd(e) {
  if (!e || typeof e !== 'object' || !key(e.line)) return null;
  const out = { line: key(e.line), jobId: ID_RE.test(String(e.jobId || '')) ? String(e.jobId) : null, name: str(e.name, 48) };
  const why = str(e.refused, 300).trim();
  if (why) out.refused = why;   // (additive) the hand-off was REFUSED: nothing was sent on — the reason
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
  // (additive) a standing refusal counted on one record: how many hand-offs it stands for
  const rep = Math.floor(num(j.repeats));
  if (rep > 1) job.repeats = Math.min(rep, 1e6);
  if (j.editorial && j.editorial.version === 1 && ['ready_for_owner', 'needs_revision', 'blocked'].includes(j.editorial.status)) {
    job.editorial = { version: 1, status: j.editorial.status, packetId: str(j.editorial.packetId, 64), draftHash: str(j.editorial.draftHash, 64),
      checkedAt: num(j.editorial.checkedAt), sourceCount: num(j.editorial.sourceCount), findings: num(j.editorial.findings), summary: str(j.editorial.summary, 1500),
      costKnown: j.editorial.costKnown === true, operatorApproved: false };
  }
  return job;
}
function normalizeAll(value) {
  const seen = {}, jobs = [];
  for (const j of ((value && Array.isArray(value.jobs)) ? value.jobs : [])) { const n = normJob(j); if (n && !seen[n.id]) { seen[n.id] = 1; jobs.push(n); } }
  jobs.sort((a, b) => a.startedAt - b.startedAt);
  return { jobs: jobs.slice(-MAX_JOBS) };
}
const idx = (state, id) => (state && Array.isArray(state.jobs) ? state.jobs.findIndex(j => j.id === id) : -1);

// a job goes out: the record exists from the moment the line is dispatched, as running
function start(state, o) {
  const job = normJob({ id: o.id, line: o.line, name: o.name, text: o.text, streamId: o.streamId, status: 'running', startedAt: o.at, retryOf: o.retryOf, from: o.from, handedIn: o.handedIn });
  if (!job) return { state, job: null };
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).filter(j => j.id !== job.id).concat([job]);
  return { state: { jobs: jobs.slice(-MAX_JOBS) }, job };
}
// the route's own verdict: delivered | problem (steps ran, not all clean) | stopped | failed (nothing durable ran)
function finish(state, id, o) {
  const i = idx(state, id);
  if (i < 0) return { state, job: null };
  const job = normJob(Object.assign({}, state.jobs[i], { status: o.status, endedAt: o.at, usd: o.usd, output: o.output, error: o.error, runs: o.runs, editorial: o.editorial || state.jobs[i].editorial }));
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
// the station (re)started: nothing is riding a line any more — a job left "running" is said as interrupted
function boot(state, at) {
  let changed = false;
  const jobs = (state && Array.isArray(state.jobs) ? state.jobs : []).map(j => {
    if (j.status !== 'running') return j;
    changed = true;
    return Object.assign({}, j, { status: 'interrupted', endedAt: num(at) || j.startedAt, error: 'the station stopped while this job was out — send it again' });
  });
  return { state: { jobs }, changed };
}
// the window's list: newest first, the heavy output cut to a glance (the full record is one GET away)
function summary(j) {
  const s = { id: j.id, line: j.line, name: j.name, text: j.text.slice(0, 240), status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    usd: j.usd, steps: j.runs.length, preview: j.output.replace(/\s+/g, ' ').trim().slice(0, 240), error: j.error, retryOf: j.retryOf,
    streamId: j.streamId, notes: j.notes.length, from: j.from || null, sentTo: j.sentTo || null };
  if (j.repeats > 1) s.repeats = j.repeats;
  if (j.editorial) s.editorial = j.editorial;
  return s;
}
function list(state, o) {
  o = o || {};
  const line = o.line ? key(o.line) : '', stream = o.stream ? key(o.stream) : '';
  const limit = Math.max(1, Math.min(100, Number(o.limit) || 30));
  const out = [];
  const jobs = (state && Array.isArray(state.jobs)) ? state.jobs : [];
  for (let i = jobs.length - 1; i >= 0 && out.length < limit; i--) {
    const j = jobs[i];
    if (line && j.line !== line) continue;
    if (stream && j.streamId !== stream) continue;
    out.push(summary(j));
  }
  return out;
}
function get(state, id) { const i = idx(state, id); return i < 0 ? null : state.jobs[i]; }
const isId = id => ID_RE.test(String(id || ''));

module.exports = { start, finish, note, link, again, latest, byStream, boot, list, get, isId, normalizeAll, normJob, summary, MAX_JOBS, MAX_OUTPUT, MAX_TEXT, MAX_NOTES };
