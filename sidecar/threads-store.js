/* sidecar/threads-store.js — the durable THREAD LEDGER (NS-6): a server-side backlog of ideas the Commander
   floated but never acted on, so night-shift autonomy PROPOSES from real unfinished threads instead of
   re-improvising a fresh idea every beat.

   WHY THIS EXISTS — NS-0..NS-5 made the night shift reliable, safe, and (with the context pack) grounded in what
   the Commander RECENTLY did. What it still lacked is DURABLE idea memory: "you mentioned X two weeks ago, here's
   a prototype." Candidates were regenerated from scratch every beat and rejected-idea history lived only in the
   browser (suggeststore/curiositystore localStorage), invisible to autonomy. This store fixes that:

     thread = { id, title, spec, sourceRef, state, declineReason?, createdAt, updatedAt }
       · title   — the idea, one line.
       · spec    — the verbatim evidence quote the mining pass extracted (grounds the idea in something REAL).
       · sourceRef — { streamId, runId, date } provenance of the conversation it was mined from.
       · state   — open | picked | delivered | declined  (the lifecycle).
       · declineReason — why the Commander (or the beat) declined it; only set when state === 'declined'.

   DECLINED IS PERMANENT (denylist semantics, ported from workshop-store's discard + the memory-question
   "discard = never again" law): a declined thread is NEVER re-proposed AND a near-duplicate idea can never be
   re-minted under a fresh id. Dedup is by FINGERPRINT (the suggeststore token-set: lowercase alphanumeric tokens
   >= 3 chars, unique, sorted) so a reordered / padded restatement of a declined idea still matches. The `declined`
   set also holds fingerprints of PROPOSALS the Commander discarded at turn-in that never became a thread.

   Pure over an injected durable store (makeDurableJsonStore) — crash-safe (fsync + .bak last-known-good),
   concurrency-safe (per-key async mutex + re-read-under-lock in update()), unit-testable against an in-memory fs.
   The Node host (index.js) injects the real fs/path + the WORKSPACES root. No ambient clock/rng: `now` is passed
   in by the caller, matching the workshop-store / memory-store discipline. Station-GLOBAL (one key, one file):
   threads are the Commander's ideas, consumed by the single night-shift persona — the same scope as the dossier
   and goal arc, not per-agent. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');
const { scrubStored } = require('./prompt-scrub.js');

const STORE_KEY = 'threads';
const THREADS_CAP = 500;    // FIFO cap on live threads (oldest drop off if the ledger floods)
const DECLINED_CAP = 1000;  // FIFO cap on the permanent declined-fingerprint denylist
// Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
// silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
const STATES = new Set(['open', 'picked', 'delivered', 'declined']);

// a stable FINGERPRINT of an idea title — ported verbatim from suggeststore.js so reordered / padded restatements
// of the same idea collapse to one key: lowercase, keep alphanumeric tokens >= 3 chars, unique, sorted, joined.
function fingerprint(title) {
  const toks = String(title == null ? '' : title).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  return Array.from(new Set(toks)).sort().join(' ');
}

// normalize a stored/legacy/absent record into a full, safe shape (never throws on a partial file).
function normalizeThread(t) {
  const s = (t && typeof t === 'object') ? t : {};
  const state = STATES.has(s.state) ? s.state : 'open';
  return {
    id: String(s.id || ''),
    title: String(s.title == null ? '' : s.title).slice(0, 200),
    spec: String(s.spec == null ? '' : s.spec).slice(0, 2000),
    sourceRef: (s.sourceRef && typeof s.sourceRef === 'object') ? s.sourceRef : null,
    state: state,
    declineReason: (state === 'declined' && s.declineReason) ? String(s.declineReason).slice(0, 200) : undefined,
    createdAt: Number(s.createdAt) || 0,
    updatedAt: Number(s.updatedAt) || Number(s.createdAt) || 0
  };
}

function normalize(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  return {
    threads: Array.isArray(s.threads) ? s.threads.filter(t => t && t.id).map(normalizeThread) : [],
    // the PERMANENT denylist of declined idea fingerprints — a declined idea (or a discarded turn-in proposal that
    // never became a thread) is never re-minted / re-proposed, even under a fresh id.
    declined: Array.isArray(s.declined) ? s.declined.filter(x => x != null).map(String).filter(Boolean) : []
  };
}

function makeThreadsStore(deps) {
  deps = deps || {};
  const pathMod = deps.path;
  const workspaces = deps.workspaces;
  if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeThreadsStore: path module required');
  if (!workspaces) throw new Error('makeThreadsStore: workspaces path required');

  const durable = makeDurableJsonStore({
    fs: deps.fs,
    path: pathMod,
    fileFor: () => pathMod.join(workspaces, 'threads.json'),
    writeDurable: deps.writeDurable,
    onRecover: deps.onRecover,
    onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};

  // ---- reads (sync, recovery-aware) ----
  function read() {
    try { return normalize(durable.get(STORE_KEY)); }
    catch (e) { warn('[threads] read failed:', (e && e.message) || e); return normalize(null); }
  }

  // list threads, optionally filtered by state; newest-updated first (recency-ranked — the night-shift propose
  // step wants the freshest open threads first). state:'open'|'picked'|... | 'all' (default 'all').
  function list(opts) {
    opts = opts || {};
    const want = opts.state && opts.state !== 'all' ? String(opts.state) : null;
    const rows = read().threads.filter(t => !want || t.state === want);
    rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (Number.isFinite(opts.limit) && opts.limit >= 0) return rows.slice(0, opts.limit);
    return rows;
  }
  // the night-shift propose surface: the top-N OPEN threads, recency-ranked, as compact { id, title, spec } rows.
  // Its only callers project these rows into prompts (the night-shift directive + its veto, the evidence composer), so
  // title and spec are scrubbed here (prompt-scrub): an edit at turn-in stores them raw. list() stays raw.
  function openThreads(limit) {
    const n = Number.isFinite(limit) ? limit : 6;
    return list({ state: 'open', limit: n }).map(t => ({ id: t.id, title: scrubStored(t.title), spec: scrubStored(t.spec) }));
  }
  // is this idea permanently declined? true iff its fingerprint is on the denylist OR matches a declined thread.
  function isDeclined(title) {
    const fp = fingerprint(title);
    if (!fp) return false;
    const rec = read();
    if (rec.declined.indexOf(fp) >= 0) return true;
    return rec.threads.some(t => t.state === 'declined' && fingerprint(t.title) === fp);
  }
  // the fingerprints an incoming candidate must NOT collide with: every live (non-declined) thread + the denylist.
  // Consumed by the mining pass to drop a duplicate BEFORE it is ever stashed (dedup at the source, like study).
  function knownFingerprints() {
    const rec = read();
    const out = {};
    for (const fp of rec.declined) if (fp) out[fp] = 'declined';
    for (const t of rec.threads) { const fp = fingerprint(t.title); if (fp) out[fp] = (t.state === 'declined' ? 'declined' : 'thread'); }
    return out;
  }

  // ---- writes (serialized via the durable mutex) ----

  // ADD a mined idea as an OPEN thread. Dedup doctrine (mirrors workshop-store.queue):
  //   • fingerprint on the declined denylist / a declined thread → refused ('declined'), no thread created.
  //   • fingerprint of a LIVE thread (open/picked/delivered) → refused ('duplicate', returns the existing thread).
  //   • else → a new open thread. Returns { thread, reason } with reason ∈ 'added'|'duplicate'|'declined'.
  // thread: { id, title, spec?, sourceRef? }. now = injected ms.
  function add(thread, now) {
    const it = thread || {};
    const id = String(it.id || '').trim();
    if (!id) throw new Error('threads.add: thread.id required');
    const title = String(it.title || '').slice(0, 200);
    const fp = fingerprint(title);
    let out = { thread: null, reason: 'added' };
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      if (fp && rec.declined.indexOf(fp) >= 0) { out = { thread: null, reason: 'declined' }; return undefined; }
      if (fp) {
        const dupDeclined = rec.threads.find(t => t.state === 'declined' && fingerprint(t.title) === fp);
        if (dupDeclined) { out = { thread: null, reason: 'declined' }; return undefined; }
        const dupLive = rec.threads.find(t => t.state !== 'declined' && fingerprint(t.title) === fp);
        if (dupLive) { out = { thread: dupLive, reason: 'duplicate' }; return undefined; }
      }
      const ts = Number(now) || 0;
      const stored = normalizeThread({
        id: id, title: title, spec: String(it.spec || '').slice(0, 2000),
        sourceRef: (it.sourceRef && typeof it.sourceRef === 'object') ? it.sourceRef : null,
        state: 'open', createdAt: ts, updatedAt: ts
      });
      rec.threads.push(stored);
      while (rec.threads.length > THREADS_CAP) rec.threads.shift();
      out = { thread: stored, reason: 'added' };
      return rec;
    }).then(() => out);
  }

  // TRANSITION a thread's state (open→picked→delivered). Never resurrects a declined thread. now stamps updatedAt.
  function setState(id, state, now) {
    const key = String(id || '');
    if (!key || !STATES.has(state) || state === 'declined') return Promise.resolve(null);
    let changed = null;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const t = rec.threads.find(x => x.id === key);
      if (!t || t.state === 'declined' || t.state === state) return undefined;   // no-op on unknown / declined / same
      t.state = state; t.updatedAt = Number(now) || t.updatedAt;
      changed = t;
      return rec;
    }).then(() => changed);
  }
  function pick(id, now) { return setState(id, 'picked', now); }
  function deliver(id, now) { return setState(id, 'delivered', now); }

  // DECLINE a thread PERMANENTLY: state→declined, stamp the reason, and add its fingerprint to the denylist so the
  // same idea can never be re-minted / re-proposed (the "discard = never again" law). Idempotent.
  function decline(id, reason, now) {
    const key = String(id || '');
    if (!key) return Promise.resolve(null);
    let changed = null;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const t = rec.threads.find(x => x.id === key);
      if (!t) return undefined;
      const fp = fingerprint(t.title);
      t.state = 'declined'; t.declineReason = String(reason || '').slice(0, 200); t.updatedAt = Number(now) || t.updatedAt;
      if (fp && rec.declined.indexOf(fp) < 0) { rec.declined.push(fp); while (rec.declined.length > DECLINED_CAP) rec.declined.shift(); }
      changed = t;
      return rec;
    }).then(() => changed);
  }

  // DENYLIST a fingerprint directly (a mining proposal the Commander DISCARDED at turn-in that never became a
  // thread). Permanent — the same idea is never re-mined. title may be the idea title OR a precomputed fingerprint;
  // we fingerprint it either way (fingerprint is IDEMPOTENT over its own output: the tokens are already
  // lowercase/unique/sorted, so re-fingerprinting a fingerprint returns it unchanged).
  function declineFingerprint(titleOrFp) {
    const use = fingerprint(titleOrFp);
    if (!use) return Promise.resolve();
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      if (rec.declined.indexOf(use) >= 0) return undefined;
      rec.declined.push(use); while (rec.declined.length > DECLINED_CAP) rec.declined.shift();
      return rec;
    });
  }

  // FORGET the threads mined from conversations that no longer exist (qa/bugs/3e926b6a: a deleted session's ideas
  // must not keep riding night-shift proposals and the evidence pack). match(sourceRef) -> true removes that thread,
  // whatever its state. The denylist keeps its fingerprints, so a declined idea stays declined. Resolves the count.
  function forgetSources(match) {
    if (typeof match !== 'function') return Promise.resolve(0);
    let removed = 0;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const kept = rec.threads.filter(t => !(t.sourceRef && match(t.sourceRef)));
      removed = rec.threads.length - kept.length;
      if (!removed) return undefined;
      rec.threads = kept;
      return rec;
    }).then(() => removed);
  }

  return {
    read, list, openThreads, isDeclined, knownFingerprints,
    add, pick, deliver, decline, setState, declineFingerprint, forgetSources,
    fingerprint,
    _durable: durable
  };
}

module.exports = { makeThreadsStore, normalize, normalizeThread, fingerprint };
