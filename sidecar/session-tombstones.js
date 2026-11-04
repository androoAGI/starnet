/* sidecar/session-tombstones.js — THE SIDECAR'S OWN RECORD OF DELETED SESSIONS (qa/bugs/3e926b6a, P1 privacy).

   The Commander deletes a session from the rail (⋯ › Delete › Confirm delete). The page drops the row and keeps its
   id in the save's `deletedIds`, so the row never re-forms. The sidecar kept every word of it: the durable transcript
   still served it to resume, recall_conversation still searched it, the evidence pack still quoted its first line as
   RECENT ACTIVITY in unrelated runs, and memories written in it still rode later prompts. Delete is armed, toasts
   "deleted", and is a separate control from Archive, so the reading is plain: that conversation is not fed back to a
   model again.

   ONLY THE COMMANDER'S DELETE OF A CONVERSATION FORGETS. The save carries two lists: `deletedIds` (every row the page
   removed, so it never re-forms) and `forgetIds`, the subset the Commander deleted as a conversation (the rail's
   Delete, station.control session.delete — Workstreams.del(id, { forget: true })). A row removed as a side effect is
   in deletedIds only and is NOT forgotten: DELETE AGENT's removeByAgent archives the agent's record (the route adopts
   its ratings into the hero's notebook, and deleting an agent must not erase the record of what it did), and a task
   card's remove (task.manage) is board housekeeping. Those only hide rows, as they always did.

   The page's list cannot be the authority on its own: it holds the newest 500 ids, NEW AGENT clears it, and a
   deliberate re-open (Workstreams.adopt revive:true) takes an id back out. So this ledger learns each deletion from
   the save the page writes (POST /api/save, and the save on disk at boot), stamps WHEN it learned it, and keeps it:

     since:   when this ledger first read the page's lists (ms; 0 = never yet)
     streams: { [streamId]: { at, live, purged, adopted? } }
       at     — when the sidecar first saw the id in the save's forgetIds (ms). Everything that session held at or
                before `at` is FORGOTTEN: every reader that hands conversation to a model answers as if it were gone.
       live   — the id is in the save's forgetIds right now. An id that left the list (a re-open, the 500 cap, a NEW
                AGENT reset) keeps its `at`: what was deleted stays deleted. A re-opened session starts clean — only
                what is said after the delete is heard — and if it is deleted again (back in the list after leaving
                it), that is a fresh delete and `at` moves to then.
       adopted — true when the stamp came from the first read (below): its memory was kept, never purged
       purged — the `at` whose derived memory (notebook records, open threads, pending proposals) has been removed;
                a crash between the stamp and the purge is retried on the next boot.

   THE FIRST READ IS ADOPTED, NOT PURGED. The deletes already in the save the first time this ledger reads it were made
   while Delete only hid the rail row, before anyone said it would forget memory, and before the page told a
   conversation delete from a side-effect one — so every id in either list is stamped (their transcript, recall and run
   titles are forgotten from then on) and recorded as purged: the memories those sessions wrote are never wiped
   retroactively at the first boot of this build. Only a forgetIds delete made after that is a fresh delete.

   forgotten(streamId, ts) is the one predicate every reader shares. deletedAt(streamId) answers 0 for a session that
   was never deleted. Pure over an injected fs (makeDomainStore: durable write + read-back proof), no ambient clock.

   forgetSessionMemory() is the purge of what a deleted session left in memory, pure over the injected stores. Only
   what the session wrote goes: a record CREATED in it (by one of its runs, or filed under its stream) is removed; a
   record created elsewhere loses only the versions the session's runs wrote (rolled back to its newest version from
   elsewhere) and the proof quoted from it. A rating verdict on one of its runs keeps the verdict and the Commander's
   words, minus what quoted the deleted work (feedbackmemory.js forgetRatedWork). */
'use strict';

const { makeDomainStore } = require('./domain-store.js');
const FeedbackMemory = require('./feedbackmemory.js');

const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // the workstream grammar transcriptstore.js and index.js validate
const MAX_STREAMS = 20000;                 // a long-lived station's deletes; the oldest stamps drop first past this

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizeState(value) {
  const src = value && typeof value === 'object' && value.streams && typeof value.streams === 'object' ? value.streams : {};
  const rows = [];
  for (const id of Object.keys(src)) {
    const e = src[id];
    if (!SID_RE.test(id) || !e || typeof e !== 'object' || !(num(e.at) > 0)) continue;
    const row = { at: num(e.at), live: e.live === true, purged: num(e.purged) };
    if (e.adopted === true) row.adopted = true;
    rows.push([id, row]);
  }
  rows.sort((a, b) => a[1].at - b[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const streams = {};
  for (const [id, e] of rows.slice(-MAX_STREAMS)) streams[id] = e;
  const out = { since: value && num(value.since) > 0 ? num(value.since) : 0, streams };
  if (value && num(value.purgedV) > 0) out.purgedV = Math.floor(num(value.purgedV));
  return out;
}

function makeSessionTombstones(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : () => 0;
  const store = makeDomainStore({ fs: d.fs, path: d.path, file: d.file, writeDurable: d.writeDurable,
    defaults: () => ({ since: 0, streams: {} }), normalize: normalizeState, onIssue: d.onIssue });
  const loaded = store.load();
  let state = loaded.value;
  const status = loaded.status;

  function commit(next) {
    const saved = store.save(next);
    state = saved.value;
  }

  /* observe(forgetIds, deletedIds?) — fold the save's current lists in. Returns the ids this call stamped (fresh
     deletes), oldest first. Only forgetIds (the Commander's deletes of a conversation) stamps a fresh delete; a value
     that is not an array teaches nothing: an older page that never wrote the list must not read as "every deletion was
     undone". The FIRST read is ADOPTED (see the header): every id in either list is stamped and recorded as purged,
     and none is returned as fresh; adopted() lists them. It needs one of the two lists (an older save holds only
     deletedIds). The new state is held in memory even when the durable write fails, so this process never serves a
     deleted session; the throw tells the caller the stamp is not on disk yet. */
  const validIds = list => (Array.isArray(list) ? list : []).map(x => String(x == null ? '' : x)).filter(id => SID_RE.test(id));
  function observe(forgetIds, deletedIds) {
    const adopting = !(state.since > 0);
    if (!Array.isArray(forgetIds) && !(adopting && Array.isArray(deletedIds))) return [];
    const want = new Set(validIds(forgetIds));
    const at = Math.max(1, num(now()));
    const next = { since: adopting ? at : state.since, streams: Object.assign({}, state.streams) };
    if (state.purgedV) next.purgedV = state.purgedV;
    const fresh = [];
    let changed = adopting;
    for (const id of adopting ? new Set(validIds(forgetIds).concat(validIds(deletedIds))) : want) {
      const e = next.streams[id];
      if (e && e.live) continue;
      next.streams[id] = adopting ? { at, live: want.has(id), purged: at, adopted: true } : { at, live: true, purged: 0 };
      if (!adopting) fresh.push(id);
      changed = true;
    }
    for (const id of Object.keys(next.streams)) {
      const e = next.streams[id];
      if (e.live && !want.has(id)) { next.streams[id] = Object.assign({}, e, { live: false }); changed = true; }
    }
    if (!changed) return fresh;
    state = normalizeState(next);
    commit(state);
    return fresh;
  }
  // observeSave(doc) — the station save the page wrote (Workstreams.serialize() rides it): its forgetIds and deletedIds
  function observeSave(doc) {
    return doc && typeof doc === 'object' ? observe(doc.forgetIds, doc.deletedIds) : [];
  }

  function deletedAt(streamId) {
    const id = String(streamId == null ? '' : streamId);
    const e = Object.prototype.hasOwnProperty.call(state.streams, id) ? state.streams[id] : null;
    return e ? e.at : 0;
  }
  // the deletes the first list held (stamped when this ledger first read it, memory kept): [{ id, at }]
  function adopted() {
    return Object.keys(state.streams).filter(id => state.streams[id].adopted === true).map(id => ({ id, at: state.streams[id].at }));
  }
  // true for a row (or record, or run) of a deleted session stamped at or before its delete; a missing stamp is old
  function forgotten(streamId, ts) {
    const at = deletedAt(streamId);
    return at > 0 && num(ts) <= at;
  }
  /* latestAt() -> ms: the newest stamp of a delete the Commander MADE after this ledger first read the save (0 = none). An adopted
     stamp (the first read's) is skipped: it records when the ledger learned of an old delete, not when a delete happened, so it
     must not read as "a delete since" to a run whose rows say they may have read any session (the saturated quote stamp, commit
     11: latestDeleteAt() >= the run's saturation time). unpurged() skips adopted stamps for the same reason (they are born purged). */
  function latestAt() {
    let latest = 0;
    for (const id of Object.keys(state.streams)) {
      const e = state.streams[id];
      if (e.adopted !== true && e.at > latest) latest = e.at;
    }
    return latest;
  }
  /* freshAt(streamId) -> ms: the stamp of a delete the Commander MADE (0 = never deleted, or deleted before this ledger's first read).
     deletedAt answers every stamp; the read-time belt over a derived record must not drop what I7's limit (d) keeps, so it asks this. */
  function freshAt(streamId) {
    const id = String(streamId == null ? '' : streamId);
    const e = Object.prototype.hasOwnProperty.call(state.streams, id) ? state.streams[id] : null;
    return e && e.adopted !== true ? e.at : 0;
  }
  /* repurge(version) -> number of stamps made pending again. The forget registry carries a VERSION; a ledger that was last purged
     under an older one (purgedV, absent = before the registry) re-opens every non-adopted stamp that was already purged, once, so
     the stores the newer registry covers are purged for deletes made before the upgrade too. Adopted stamps are never re-run (they
     are born purged and their memory is kept, I7 limit d). The version is stored first, so a crash after it leaves the stamps
     pending (purged = 0) and the next boot retries the pass. */
  function repurge(version) {
    const v = Math.max(0, Math.floor(num(version)));
    if (!(v > num(state.purgedV))) return 0;
    const next = { since: state.since, purgedV: v, streams: Object.assign({}, state.streams) };
    let again = 0;
    for (const id of Object.keys(next.streams)) {
      const e = next.streams[id];
      if (e.adopted === true || e.purged !== e.at) continue;
      next.streams[id] = Object.assign({}, e, { purged: 0 });
      again++;
    }
    state = normalizeState(next);
    commit(state);
    return again;
  }
  // the deletions whose derived memory has not been purged for their current stamp: [{ id, at }], oldest first
  function unpurged() {
    return Object.keys(state.streams).map(id => ({ id, at: state.streams[id].at, purged: state.streams[id].purged }))
      .filter(e => e.purged !== e.at).sort((a, b) => a.at - b.at).map(e => ({ id: e.id, at: e.at }));
  }
  function markPurged(list) {
    const next = { since: state.since, streams: Object.assign({}, state.streams) };
    if (state.purgedV) next.purgedV = state.purgedV;
    let changed = false;
    for (const it of Array.isArray(list) ? list : []) {
      const e = it && next.streams[it.id];
      if (!e || e.at !== it.at || e.purged === it.at) continue;
      next.streams[it.id] = Object.assign({}, e, { purged: it.at });
      changed = true;
    }
    if (changed) commit(normalizeState(next));
    return changed;
  }
  function list() {
    return Object.keys(state.streams).map(id => Object.assign({ id }, state.streams[id]));
  }
  return { observe, observeSave, deletedAt, freshAt, forgotten, latestAt, unpurged, markPurged, repurge, adopted, list, since: () => state.since, purgedV: () => num(state.purgedV), status: () => status, file: store.file };
}

/* ---- what a deleted session left in memory ---- */

/* deleted: [{ id, at }]; runs: the run history rows ({ runId, streamId, ts, quotes?, quotesAt?, quotesSaturatedAt? }).
   scope = { at, streams, runIds, rowIds }:
     streams  the deleted sessions and the moment each was deleted (at is the same Map: the name the older readers use)
     runIds   every run that is forgotten with them: the runs a deleted session held (filed under its stream at or before its
              delete) AND the runs that QUOTE one (turn identity commit 11: a run whose quote stamp names a deleted stream read at or
              before its delete, or that is saturated and a delete is stamped at or after its saturation). The reading run's own
              derived records (its verdict packet, golden, study, notebook entries) go with the session it read
     rowIds   rows named individually (none from the run list; a caller that already knows forgotten rows adds them) */
function quoteBound(r, at, latest) {
  if (!r || typeof r !== 'object') return false;
  if (num(r.quotesSaturatedAt) > 0 && latest > 0 && latest >= num(r.quotesSaturatedAt)) return true;
  const quotes = Array.isArray(r.quotes) ? r.quotes : [];
  const times = Array.isArray(r.quotesAt) ? r.quotesAt : [];
  for (let i = 0; i < quotes.length; i++) {
    const when = quotes[i] === '*' ? latest : at.get(String(quotes[i]));
    if (when && when >= num(times[i])) return true;
  }
  return false;
}
function deletedScope(deleted, runs) {
  const at = new Map();
  for (const e of Array.isArray(deleted) ? deleted : []) if (e && SID_RE.test(String(e.id)) && num(e.at) > 0) at.set(String(e.id), num(e.at));
  let latest = 0;
  for (const w of at.values()) if (w > latest) latest = w;
  const runIds = new Set();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !r.runId) continue;
    const when = at.get(String(r.streamId || ''));
    if ((when && num(r.ts) <= when) || (at.size && quoteBound(r, at, latest))) runIds.add(String(r.runId));
  }
  return { at, streams: at, runIds, rowIds: new Set() };
}
function streamBound(scope, streamId, ts) {
  const when = streamId ? scope.at.get(String(streamId)) : 0;
  return !!when && num(ts) <= when;
}
function runBound(scope, runId) { return !!runId && scope.runIds.has(String(runId)); }

// a notebook record was CREATED in a deleted session when one of its runs wrote it, or it was filed under its stream
function notebookRecordBound(r, scope) {
  if (!r || typeof r !== 'object') return false;
  return streamBound(scope, r.streamId, r.createdAt || r.ts) || runBound(scope, r.sourceRunId);
}

/* forgetRecord(r, scope) -> { record, kind, versions } — what the deleted sessions wrote into ONE notebook record, taken
   out of it. record === r: nothing of theirs is in it. record null: remove it.
     CREATED in a deleted session: removed (kind 'removed'). A rating verdict on one of its runs (origin 'feedback',
       not filed under the stream) is the exception: the verdict and the Commander's rating words stay, without the
       directive and the reference that quoted the deleted work (FeedbackMemory.forgetRatedWork, kind 'verdict');
       one with no words of its own is removed.
     CREATED elsewhere: when its current version is a deleted run's revision, it ROLLS BACK to its newest version from
       elsewhere (record.history, which reviseRecord keeps oldest-first; kind 'restored'). The proof (statedBy) and the
       authority that came with the deleted version go: the restored text's own confirmation was never recorded, so
       it is not claimed. A record with no version from elsewhere left is removed. Otherwise the versions a deleted run
       wrote leave its history, and a proof quoting a deleted session goes (kind 'trimmed').
   versions = how many versions a deleted run wrote were dropped (a rolled-back current version included). */
function forgetRecord(r, scope) {
  const same = { record: r, kind: '', versions: 0 };
  if (!r || typeof r !== 'object') return same;
  const fromDeleted = h => !!(h && runBound(scope, h.sourceRunId));
  const history = Array.isArray(r.history) ? r.history : [];
  if (notebookRecordBound(r, scope)) {
    if (r.origin !== FeedbackMemory.ORIGIN || streamBound(scope, r.streamId, r.createdAt || r.ts)) return { record: null, kind: 'removed', versions: 0 };
    const kept = history.filter(h => !fromDeleted(h));
    const stripped = FeedbackMemory.forgetRatedWork(r);
    if (!stripped) return { record: null, kind: 'removed', versions: 0 };
    if (stripped === r && kept.length === history.length) return same;
    return { record: r.history ? Object.assign({}, stripped, { history: kept }) : stripped, kind: 'verdict', versions: history.length - kept.length };
  }
  if (runBound(scope, r.updatedSourceRunId)) {
    let i = history.length - 1;
    while (i >= 0 && (!history[i] || fromDeleted(history[i]))) i--;
    if (i < 0) return { record: null, kind: 'removed', versions: 0 };
    const h = history[i];
    const older = history.slice(0, i).filter(x => !fromDeleted(x));
    const body = String(h.body == null ? '' : h.body);
    const out = Object.assign({}, r, { title: h.title != null ? h.title : r.title, body, content: body, revision: num(h.revision), history: older,
      updatedAt: (i > 0 && num(history[i - 1].replacedAt)) || num(r.createdAt || r.ts) });
    if (num(h.revision) > 0 && h.sourceRunId) out.updatedSourceRunId = String(h.sourceRunId); else delete out.updatedSourceRunId;
    delete out.statedBy; delete out.distrust;
    if (out.confirmation === 'user-stated' || out.confirmation === 'user-confirmed') out.confirmation = 'inferred';
    // taintedBy stays as it is: a rollback never takes a taint off (the archived version's own taint was not recorded,
    // and the run that revised it had read it)
    // dropped: every history entry but h and the older ones kept, plus the deleted run's current version (h replaces it)
    return { record: out, kind: 'restored', versions: history.length - older.length };
  }
  const proofGone = !!(r.statedBy && runBound(scope, r.statedBy.runId));
  if (!proofGone && !history.some(fromDeleted)) return same;
  const out = Object.assign({}, r);
  if (Array.isArray(r.history)) out.history = history.filter(h => !fromDeleted(h));
  if (proofGone) { delete out.statedBy; if (out.confirmation === 'user-stated') out.confirmation = 'inferred'; }
  return { record: out, kind: 'trimmed', versions: history.length - (out.history ? out.history.length : 0) };
}
function pendingBound(p, scope) {
  if (!p || typeof p !== 'object') return false;
  return runBound(scope, p.runId) || runBound(scope, p.sourceRunId) || streamBound(scope, p.streamId, p.createdAt || p.at);
}
function threadBound(ref, scope) {
  if (!ref || typeof ref !== 'object') return false;
  return runBound(scope, ref.runId) || streamBound(scope, ref.streamId, ref.date);
}

/* forgetSessionMemory({ store, threads?, agentIds, deleted, runs }) — remove what the deleted sessions left in memory.
     store    — the memory KV (memory-store.js: update(key, mutator) under its per-key lock)
     threads  — the thread ledger (threads-store.js: forgetSources(match))
     agentIds — every agent whose notebook / pending queue may hold one
   Returns { notes, revisions, restored, verdicts, pending, threads, forgot }: notebook records removed, versions a
   deleted run wrote dropped, records rolled back to an earlier version, rating verdicts kept without the deleted work,
   pending proposals and threads removed, and forgot = [{ agentId, id }] of every removed record (the host announces
   each one as memory.forget). A store that fails throws after the others ran, so the caller records nothing as purged
   and retries. */
async function forgetSessionMemory(deps) {
  const d = deps || {};
  const scope = d.scope && d.scope.at instanceof Map ? d.scope : deletedScope(d.deleted, d.runs);
  const out = { notes: 0, revisions: 0, restored: 0, verdicts: 0, pending: 0, threads: 0, forgot: [] };
  if (!scope.at.size) return out;
  let failure = null;
  for (const agentId of Array.isArray(d.agentIds) ? d.agentIds : []) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(agentId))) continue;
    let done = null;   // what this notebook's write took out: counted only once the write landed
    try {
      await d.store.update('notebook:' + agentId, (stored) => {
        done = null;
        if (!Array.isArray(stored)) return undefined;
        let changed = false;
        const next = [];
        const forgot = [];
        const tally = { notes: 0, revisions: 0, restored: 0, verdicts: 0 };
        for (const r of stored) {
          const f = forgetRecord(r, scope);
          if (f.record === r) { next.push(r); continue; }
          changed = true;
          tally.revisions += f.versions;
          if (f.kind === 'removed') { tally.notes++; if (r && r.id) forgot.push({ agentId: String(agentId), id: String(r.id) }); continue; }
          if (f.kind === 'restored') tally.restored++;
          if (f.kind === 'verdict') tally.verdicts++;
          next.push(f.record);
        }
        if (changed) done = { tally, forgot };
        return changed ? next : undefined;
      });
      if (done) {
        for (const k of Object.keys(done.tally)) out[k] += done.tally[k];
        out.forgot.push(...done.forgot);
      }
    } catch (e) { failure = failure || e; }
    try {
      await d.store.update('pending:' + agentId, (stored) => {
        if (!Array.isArray(stored)) return undefined;
        const next = stored.filter(p => !pendingBound(p, scope));
        out.pending += stored.length - next.length;
        return next.length === stored.length ? undefined : next;
      });
    } catch (e) { failure = failure || e; }
  }
  if (d.threads && typeof d.threads.forgetSources === 'function') {
    try { out.threads = await d.threads.forgetSources(ref => threadBound(ref, scope)); }
    catch (e) { failure = failure || e; }
  }
  if (failure) throw failure;
  return out;
}

module.exports = { makeSessionTombstones, forgetSessionMemory, deletedScope, _internals: { normalizeState, deletedScope, notebookRecordBound, forgetRecord, pendingBound, threadBound, SID_RE, MAX_STREAMS } };
