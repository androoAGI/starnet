'use strict';

// Durable ownership of delegated threads and their return-to-parent review queue.
// Existing conversations remain owned by the save store; newly delegated threads
// are adopted by the page using their stable IDs. No credentials are persisted.
const { makeDomainStore } = require('./domain-store.js');
// the ONE goal-step predicate every history reader shares (pure UMD module; the page loads the same file)
const GoalLoop = require('../frontend/app/goalloop.js');
const TurnKinds = require('../frontend/app/turnkinds.js');

function isCoordinatorRun(o) {
  return o.agentId === 'agent' && !o.internal && !o.floorless
    && ((o.surface === 'interactive' && o.lead === true) || o.syntheticTrigger === true);
}

function makeOverseer(deps) {
  const store = makeDomainStore({ fs: deps.fs, path: deps.path, file: deps.file, writeDurable: deps.writeDurable,
    defaults: () => ({ threads: [], reviews: [] }),
    normalize: value => {
      if (!value || !Array.isArray(value.threads) || !Array.isArray(value.reviews)
        || value.threads.some(w => !w || typeof w.id !== 'string' || typeof w.title !== 'string')
        || value.reviews.some(r => !r || typeof r.id !== 'string' || typeof r.status !== 'string')) {
        throw new Error('invalid overseer state');
      }
      return value;
    } });
  const loaded = store.load();
  const unavailable = !['ok', 'absent', 'recovered'].includes(loaded.status)
    ? 'overseer state unavailable: ' + loaded.status : '';
  let state = loaded.value;
  let emergencyPaused = false;
  const copy = value => JSON.parse(JSON.stringify(value));
  const commit = next => { if (unavailable) throw new Error(unavailable); store.save(next); state = next; };
  const update = fn => { const next = copy(state); const out = fn(next); commit(next); return copy(out); };
  const valid = value => /^[A-Za-z0-9_-]{1,80}$/.test(String(value || ''));
  const locks = new Map();

  // ONE load of the page's save: deps.sessions() parses the whole save file, so a caller that needs the rows twice
  // (resolve the parent, then check the title) reads them from one view instead of loading it again.
  // deps.sessionsRead() (optional) = { doc, stamp }: the same doc plus the save's stamp for a clean read ('' otherwise)
  function view() {
    if (unavailable) throw new Error(unavailable);
    const read = deps.sessionsRead ? deps.sessionsRead() : { doc: deps.sessions(), stamp: '' };
    const legacy = (read && read.doc) || {};
    const deleted = new Set(legacy.deletedIds || []);
    // the page's list is the newest 500 ids and a NEW AGENT clears it: the sidecar's own ledger of the Commander's deletes (deps.forgotten(id, ts),
    // session-tombstones) is the authority, so a thread filed in a deleted session never reads back as live (turn identity commit 12)
    if (typeof deps.forgotten === 'function') for (const w of state.threads) if (deps.forgotten(w.id, Number(w.createdAt) || 0)) deleted.add(w.id);
    const rows = new Map((legacy.workstreams || []).map(w => [w.id, w]));
    for (const w of state.threads) {
      if (deleted.has(w.id)) { rows.delete(w.id); continue; }
      const visible = rows.get(w.id);
      // the page's saved copy wins for what the Commander edits (title, lane…), but never blanks the project this thread
      // was filed under: a page that adopted it before learning the project saves projectRoot:null
      rows.set(w.id, Object.assign({}, w, visible || {}, { parentStreamId: w.parentStreamId, projectHome: !!w.projectHome, worker: w.worker === true,
        projectRoot: (visible && visible.projectRoot) || w.projectRoot || null }));
    }
    return { deleted, rows: Array.from(rows.values()).filter(w => !w.archived).map(w => ({ ...w,
      title: w.title || (w.id === legacy.generalId ? 'General' : 'Untitled') })), stamp: (read && read.stamp) || '' };
  }
  function threads() { return view().rows; }
  function resolve(ref) { return resolveIn(threads(), ref); }
  /* THE LISTED THREADS, MEMOIZED BY THE SAVE'S STAMP (idle-cpu piece 2, 2026-10-19). GET /api/overseer is polled every
     2.5 s per open page and parsed the whole save each time (~11 ms at a real 3.8 MB station, ~45 ms near the 16 MiB cap),
     for a list that only changes when the save or overseer.json does. The memo holds ONLY the flat projected rows (never
     view() rows, which point into the parsed doc, never the doc) and is reused only while (1) the save's stamp, taken by
     deps.sessionsStamp() before this read, still matches, and (2) `state` is the very object it was built from (state is
     replaced on every change, never edited in place: an in-place edit must clear `listed`). A build is adopted only when
     its read was clean (stamp non-empty) and the stamp did not move while it was built, so a racing save costs one more
     read, never a stale list. Callers get copies. threads()/resolve()/create()/ensure()/projectHome() stay uncached. */
  let listed = null;
  function projectThread(w) {
    return { id: w.id, title: w.title, agentId: w.agentId,
    parentStreamId: w.parentStreamId || '', projectRoot: w.projectRoot || null, projectHome: !!w.projectHome, worker: w.worker === true,
    kind: w.kind, lane: w.lane, createdAt: w.createdAt,
    // the lead run that filed this thread (requestId = '<leadRunId>:<call>:<slot>' for a dispatch worker,
    // '<leadRunId>:<title>' for a session.create thread): the page groups a lead run's threads by it
    leadRunId: String(w.requestId || '').split(':')[0],
    // the dispatch call that filed a worker thread: the page keeps each call's workers together. Workers only: a
    // session.create title may hold a colon, and that is never a call
    call: w.worker === true ? (p => p.length > 2 ? p[1] : '')(String(w.requestId || '').split(':')) : '',
    // the worker slot in that call: the page lists a call's workers in the order they were asked
    slot: Number(String(w.requestId || '').split(':').pop()) || 0 };
  }
  function listedThreads() {
    const before = deps.sessionsStamp ? deps.sessionsStamp() : '';
    if (before && listed && listed.stamp === before && listed.state === state) return listed.rows;
    const v = view();
    const rows = v.rows.map(projectThread);
    listed = (v.stamp && deps.sessionsStamp && v.stamp === deps.sessionsStamp()) ? { stamp: v.stamp, state, rows } : null;
    return rows;
  }
  // resolve() over the listed rows: the same id/title/agentId/worker, projectRoot '' read as null (both falsy). For a
  // check that only needs to know the conversation exists and its project; anything that runs a turn resolves afresh.
  function resolveListed(ref) { return { ...resolveIn(listedThreads(), ref) }; }
  function resolveIn(rows, ref) {
    const key = String(ref || '').trim().toLowerCase();
    const exact = rows.filter(w => w.id === ref);
    const named = rows.filter(w => w.title.toLowerCase() === key);
    // a name means the conversation the Commander can see, never a delegated worker's thread that shares it
    const visible = named.filter(w => w.worker !== true);
    const hits = exact.length ? exact : (visible.length ? visible : named);
    if (hits.length !== 1) throw new Error(hits.length ? 'ambiguous session title; use its id' : 'no such session');
    return hits[0];
  }
  // A free name for a repeated ask (a daily routine delegates the same first line every day): count up, then the time
  // it was asked, then count that up, so a repeat never costs a worker its thread. Suffixes fit inside 80 chars.
  function freeTitle(base, taken) {
    const fit = suffix => base.slice(0, 80 - suffix.length).trimEnd() + suffix;
    for (let n = 2; n <= 99; n++) if (!taken(fit(' (' + n + ')'))) return fit(' (' + n + ')');
    const stamp = ' · ' + new Date(Number(deps.now())).toISOString().slice(0, 19).replace('T', ' ');
    if (!taken(fit(stamp))) return fit(stamp);
    for (let n = 2; n <= 10000; n++) if (!taken(fit(stamp + ' (' + n + ')'))) return fit(stamp + ' (' + n + ')');
    throw new Error('session title already exists; use its id');
  }
  function create(args) {
    let title = String(args.title || '').trim().slice(0, 80);
    if (!title) throw new Error('a session needs a title');
    const { rows, deleted } = view();
    const parent = resolveIn(rows, args.parentStreamId);
    const duplicate = state.threads.find(w => args.requestId && w.requestId === args.requestId);
    if (duplicate) return copy(resolveIn(rows, duplicate.id));
    // a hidden worker thread never blocks a name the Commander can see; worker threads stay unique among themselves too
    const taken = name => rows.some(w => (args.worker === true || w.worker !== true) && w.title.toLowerCase() === name.toLowerCase());
    if (taken(title)) {
      // A delegated worker (or a caller passing uniqueTitle) wants a thread whatever the name, so pick a free one from
      // this same view: a repeated ask costs one save load, not one per taken name, and never loses its thread.
      if (args.uniqueTitle !== true && args.worker !== true) throw new Error('session title already exists; use its id');
      title = freeTitle(title, taken);
    }
    const agentId = args.agentId || parent.agentId || 'agent';
    if (!valid(agentId) || !deps.hasAgent(agentId)) throw new Error('unknown crew agent');
    const row = { id: deps.newId(), title, agentId, parentStreamId: parent.id,
      // a delegated worker's own thread (team.dispatch): the only kind the page folds under its parent conversation
      ...(args.worker === true ? { worker: true } : {}),
      // the parent's project, or the project the creating run was admitted under (a page-saved parent row can lag it)
      projectRoot: parent.projectRoot || (args.projectRoot ? String(args.projectRoot) : null), requestId: String(args.requestId || ''),
      kind: 'chat', lane: 'active', history: [], runIds: [], createdAt: deps.now(), lastActiveAt: deps.now() };
    return update(s => { dropDeleted(s, deleted); s.threads.push(row); return row; });
  }
  // A thread the Commander deleted is already hidden; its row is dropped from overseer.json the next time a thread is
  // filed, so the file does not keep one row per deleted worker forever. ensure() still refuses it while the save's
  // tombstone stands.
  function dropDeleted(s, deleted) { if (deleted.size) s.threads = s.threads.filter(w => !deleted.has(w.id)); }
  // A brand-new conversation whose FIRST ask delegates: its run is live before the page's debounced save lands, so the
  // overseer has never seen it and every worker lost its thread ("no such session", 2026-10-10). The run that asks proves
  // the conversation exists; it is filed from that run's identity, and the page's saved copy wins every field once it
  // lands. A conversation the Commander deleted is never brought back.
  function ensure(args) {
    const id = String(args.id || '');
    const { rows, deleted } = view();
    if (rows.some(w => w.id === id)) return resolveIn(rows, id);
    if (!valid(id) || deleted.has(id) || state.threads.some(w => w.id === id)) throw new Error('no such session');
    const agentId = args.agentId || 'agent';
    if (!valid(agentId) || !deps.hasAgent(agentId)) throw new Error('unknown crew agent');
    const row = { id, title: String(args.title || '').trim().slice(0, 80), agentId, projectRoot: args.projectRoot ? String(args.projectRoot) : null,
      parentStreamId: '', kind: 'chat', lane: 'active', history: [], runIds: [], createdAt: deps.now(), lastActiveAt: deps.now() };
    update(s => { dropDeleted(s, deleted); s.threads.push(row); return row; });
    return resolve(id);
  }
  // One durable conversation per trusted project. Opening a project is an
  // explicit user action; repeated opens reuse the same identity after restart.
  function projectHome(root, title, createIfMissing) {
    const candidates = threads().filter(w => w.projectRoot === root && w.agentId === 'agent' && !w.parentStreamId);
    const existing = candidates.find(w => w.projectHome) || candidates[0];
    if (existing) {
      if (!existing.projectHome && createIfMissing) return update(s => {
        let owned = s.threads.find(w => w.id === existing.id);
        if (!owned) { owned = copy(existing); s.threads.push(owned); }
        owned.projectHome = true; return owned;
      });
      return copy(existing);
    }
    if (!createIfMissing) return null;
    const row = { id: deps.newId(), title, titleAuto: false, agentId: 'agent', projectRoot: root, projectHome: true,
      parentStreamId: '', kind: 'chat', lane: 'active', history: [], runIds: [], createdAt: deps.now(), lastActiveAt: deps.now() };
    return update(s => { s.threads.push(row); return row; });
  }
  /* ONE REPORT PER HAND-OFF (2026-10-11, version B — a blind usability test: one report per request read clearer, and
     calmer on return, than one message per worker). The workers one lead run sent out are reviewed TOGETHER once they
     have all settled, so NOVA posts one report naming each worker's part. A worker that never settles cannot hold that
     report forever: past the ceiling NOVA reports on the finished part and names who is still working, and the straggler
     gets one follow-up report when it settles. A worker stopped BECAUSE its lead run was cancelled (subagents.js
     cancelChildren) gets no review: the Commander just pressed Stop on that conversation, and a fresh paid run
     reporting the stop would override it. */
  const SETTLED = ['done', 'error', 'refused', 'interrupted', 'stale'];
  const ceilingMs = () => (Number(deps.reportCeilingMs) > 0 ? Number(deps.reportCeilingMs) : 600000);
  // every worker generation already reported on — batch rows list theirs; a pre-batching '<runId>:review' row covers
  // its one worker (an upgrade never re-reviews history)
  function covered(exceptId) {
    const out = new Set();
    for (const r of state.reviews) {
      if (r.id === exceptId) continue;
      if (Array.isArray(r.workerRunIds)) r.workerRunIds.forEach(id => out.add(String(id)));
      else if (r.workerRunId) out.add(String(r.workerRunId));
    }
    return out;
  }
  // the order the lead asked for its workers (the thread slot in its requestId '<leadRunId>:<call>:<slot>')
  function slotOf(w) {
    const t = state.threads.find(x => x.id === w.streamId);
    return t ? Number(String(t.requestId || '').split(':').pop()) || 0 : 0;
  }
  function membersOf(review) {
    return Array.isArray(review && review.members) ? review.members
      : [{ workerId: review.workerId, workerRunId: review.workerRunId, generation: review.generation, streamId: review.childStreamId || '' }];
  }
  const groupOf = w => w.parentStreamId + '|' + (w.parentRunId || 'solo-' + w.runId);
  // a restore stamps each worker's run (station-recovery.js): a report is a full unattended lead run, and nobody asked for
  // this one. The stamp names the run, so a worker a person resumes gets its report as usual.
  const reviewable = w => w && w.leadId === 'agent' && valid(w.parentStreamId) && w.cancelledBy !== 'parent'
    && !(w.noReportRun && w.noReportRun === String(w.runId));
  const settledWorker = w => (w.completedAt || w.status === 'stale') && SETTLED.includes(w.status);
  const memberOf = w => ({ workerId: w.id, workerRunId: w.runId, generation: w.generation, streamId: w.streamId || '', agentId: w.agentId });
  const waitingMember = w => ({ workerId: w.id, workerRunId: w.runId, agentId: w.agentId });
  function freshReviews(workers, opts) {
    const done = covered();
    const groups = new Map();
    for (const w of workers) {
      if (!reviewable(w) || done.has(String(w.runId))) continue;
      // A live lead may dispatch more workers later in the same turn. Its hand-off is not closed yet.
      if (!(opts && opts.force) && w.parentRunId && deps.isRunActive && deps.isRunActive(w.parentRunId)) continue;
      const key = groupOf(w);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(w);
    }
    const out = [];
    for (const [key, members] of groups) {
      const settled = members.filter(settledWorker).sort((a, b) => slotOf(a) - slotOf(b));
      const running = members.filter(w => !settled.includes(w));
      if (!settled.length) continue;
      if (running.length && !(opts && opts.force)) {
        const first = Math.min(...settled.map(w => +w.completedAt || +w.updatedAt || +w.startedAt || deps.now()));
        if (deps.now() - first < ceilingMs()) continue;
      }
      const seq = 1 + state.reviews.filter(r => r.groupKey === key).length;
      const lead = settled[0];
      out.push({ id: key + ':report:' + seq, kind: 'batch', groupKey: key, followUp: seq > 1,
        parentStreamId: lead.parentStreamId, childStreamId: lead.streamId || '', agentId: lead.leadId,
        // the single-worker fields name the first member (older readers and the page's change signal keep working)
        workerId: lead.id, workerRunId: lead.runId, generation: lead.generation,
        members: settled.map(memberOf),
        workerRunIds: settled.map(w => String(w.runId)),
        waitingOn: running.map(waitingMember),
        status: 'pending', createdAt: deps.now(), reviewRunId: '', error: '' });
    }
    return out;
  }
  // Refresh a pending report when it can actually take the conversation lock. A worker that finished while
  // the report waited belongs in this report, not a stale "still working" line followed by a second report.
  // Completed/cancelled/reviewing reports are immutable, and another report's generations remain covered.
  function refreshReview(id, workers) {
    const current = state.reviews.find(r => r.id === id);
    if (!current || current.status !== 'pending' || current.kind !== 'batch' || !current.groupKey) return current ? copy(current) : null;
    const elsewhere = covered(id);
    const group = workers.filter(w => reviewable(w) && groupOf(w) === current.groupKey && !elsewhere.has(String(w.runId)));
    const settled = group.filter(settledWorker).sort((a, b) => slotOf(a) - slotOf(b));
    const fields = { members: settled.map(memberOf), workerRunIds: settled.map(w => String(w.runId)),
      waitingOn: group.filter(w => !settledWorker(w)).map(waitingMember) };
    if (settled.length) Object.assign(fields, { workerId: settled[0].id, workerRunId: settled[0].runId,
      generation: settled[0].generation, childStreamId: settled[0].streamId || '' });
    if (Object.keys(fields).every(k => JSON.stringify(current[k]) === JSON.stringify(fields[k]))) return copy(current);
    return patchReview(id, fields);
  }
  // A settled report is kept while the worker registry still holds any of its workers (it is what marks them reported).
  // Once all of them have left the registry and the report is old, nothing can be reported again, so it is dropped
  // instead of growing overseer.json one row per worker forever.
  const FINISHED_REVIEW = ['done', 'cancelled', 'superseded', 'interrupted'];
  const reviewKeepMs = () => (Number(deps.reviewRetentionMs) > 0 ? Number(deps.reviewRetentionMs) : 7 * 24 * 60 * 60 * 1000);
  function expiredReviews(workers) {
    const listed = new Set();
    for (const w of workers) { if (w && w.id) listed.add('w:' + w.id); if (w && w.runId) listed.add('r:' + w.runId); }
    const cutoff = deps.now() - reviewKeepMs();
    return new Set(state.reviews.filter(r => FINISHED_REVIEW.includes(r.status) && (Number(r.createdAt) || 0) < cutoff
      && !membersOf(r).some(m => listed.has('w:' + m.workerId) || listed.has('r:' + m.workerRunId))
      && !(Array.isArray(r.workerRunIds) ? r.workerRunIds : []).some(id => listed.has('r:' + id))).map(r => r.id));
  }
  function collect(workers) {
    // Pending reports can wait for credentials or another turn too. Absorb their newly settled members before
    // creating any follow-up; a follow-up is only for workers finishing after the earlier report began.
    // only a pending batch report can absorb members — settled ones are history (refreshing every review ever made
    // cost a find + a clone per review on every 2 s tick; finished ones are kept up to the retention window below)
    const open = state.reviews.filter(r => r && r.status === 'pending' && r.kind === 'batch' && r.groupKey).map(r => r.id);
    for (const id of open) refreshReview(id, workers);
    const fresh = freshReviews(workers);
    const expired = expiredReviews(workers);
    if (fresh.length || expired.size) update(s => { s.reviews = s.reviews.filter(r => !expired.has(r.id)); s.reviews.push(...fresh); return null; });
  }
  function patchReview(id, fields) {
    return update(s => { const r = s.reviews.find(row => row.id === id); if (!r) throw new Error('unknown review'); Object.assign(r, fields); return r; });
  }
  // Shared by user and review turns. A failed turn never poisons the next turn.
  async function withThread(id, fn) {
    const queued = locks.has(id);
    const previous = locks.get(id) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    // The queue stores release signals, not fn's result, so its tail never rejects.
    const tail = previous.then(() => held);
    locks.set(id, tail);
    await previous;
    try { return await fn({ queued }); }
    finally { release(); if (locks.get(id) === tail) locks.delete(id); }
  }
  function stopReviews(workers) {
    // Stop admission immediately even when the disk cannot accept a receipt.
    emergencyPaused = true;
    // Keep cancellation in RAM even if persistence fails. A later successful
    // resume must not resurrect work the Commander already stopped.
    const next = copy(state);
    next.reviews.push(...freshReviews(workers || [], { force: true }));
    next.paused = true;
    for (const r of next.reviews) if (r.status === 'pending' || r.status === 'reviewing') {
      r.status = 'cancelled'; r.error = 'Stopped by the Commander.';
    }
    state = next;
    commit(state);
  }
  /* THE TICK AND THE HALT READ NO SAVE (idle-cpu piece 2, 2026-10-19). paused and reviews come from overseer.json's
     state already held in RAM, yet the 2 s tick and GET /api/halt read them through snapshot(), which also builds every
     thread from a full parse of the page's save (3.8 MB on a real station: ~20 ms a tick, ~86k parses a day, at idle).
     These four answer from RAM with exactly the values snapshot() would carry; snapshot() stays the page's full picture. */
  function paused() { return unavailable ? true : (emergencyPaused || !!state.paused); }
  function error() { return unavailable || ''; }
  function reviews() { return unavailable ? [] : copy(state.reviews); }
  function review(id) {
    if (unavailable) return null;
    const row = state.reviews.find(r => r.id === id);
    return row ? copy(row) : null;
  }
  /* forget(match) -> number: the forget registry's purge. match({ streamIds, runIds, at }) names a delegated thread (its id and its parent
     session; the lead run that filed it) or a hand-off report (its parent and child sessions, its review run and its workers' runs) whose session
     was deleted or whose run quoted one. The thread's title and a report's error line are words of that session. Written twice: the store
     keeps the value it replaced as its .bak. */
  function forget(match) {
    if (unavailable) throw new Error(unavailable);
    const next = copy(state);
    const threads = next.threads.filter(w => !match({ streamIds: [w.id, w.parentStreamId], runIds: [String(w.requestId || '').split(':')[0]], at: Number(w.createdAt) || 0 }));
    const reviews = next.reviews.filter(r => !match({ streamIds: [r.parentStreamId, r.childStreamId], runIds: [r.reviewRunId].concat(Array.isArray(r.workerRunIds) ? r.workerRunIds : []), at: Number(r.createdAt) || 0 }));
    const n = (next.threads.length - threads.length) + (next.reviews.length - reviews.length);
    if (!n) return 0;
    next.threads = threads; next.reviews = reviews;
    commit(next); commit(next);
    return n;
  }
  function snapshot() { if (unavailable) return { threads: [], reviews: [], paused: true, error: unavailable };
    return { threads: listedThreads().map(w => ({ ...w })), reviews: copy(state.reviews), paused: paused() }; }
  function resumeReviews() {
    // A damaged optional coordination store must not prevent ordinary chat.
    // Reads/creates still refuse, and the poller remains paused; never overwrite it.
    if (unavailable) return;
    if (state.paused || emergencyPaused) update(s => { s.paused = false; return null; });
    emergencyPaused = false;
  }
  return { threads, resolve, create, ensure, projectHome, collect, patchReview, withThread, forget, snapshot, stopReviews, resumeReviews, membersOf, refreshReview,
    paused, error, reviews, review, resolveListed };
}
/* station.read_session as the OVERSEER answers it (org P29-sys review, 2026-10-14). The lead's session.peek in an interactive
   coordinator run is wired to overseerStation (sidecar/index.js), which answers read_session itself and never reaches the
   page's handler in stationcommands.js. A goal-loop step is stored as a user-role turn the Commander never typed: here it
   reads as the STATION's line naming the goal ('Goal step: <goal>', speaker 'station'), never as the Commander's words, so
   the lead cannot tell the user "you asked me to continue…". Both heads (session + the pre-org-pass standing goal) and the
   saved-history fallback go through GoalLoop.stepOfTurn. What the goal loop SENDS the model for its own continuation is
   untouched: this is only how another session's history reads. */
function readTurn(m) {
  const step = TurnKinds.classify(m).kind === 'goal-step' ? GoalLoop.stepOfTurn(m) : null;
  if (step != null) return { speaker: 'station', sys: true, text: ('Goal step: ' + step).slice(0, 3000) };
  return { speaker: m.role, text: String(m.content || '').slice(0, 3000) };
}
// Canonical callers pass only projected rows. The optional history argument is an explicit legacy-only fallback;
// never supply it after a successful projection, whose empty result must stay authoritative.
function readSessionTurns(rows, history) {
  const turns = (rows || []).filter(m => m && ['user', 'assistant'].includes(m.role)).map(readTurn);
  if (turns.length) return turns;
  return (history || []).filter(m => m && !m.hidden && !m.internal && ['user', 'assistant'].includes(m.role)).slice(-12).map(readTurn);
}
module.exports = { makeOverseer, isCoordinatorRun, readSessionTurns };
