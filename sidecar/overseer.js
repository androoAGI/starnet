'use strict';

// Durable ownership of delegated threads and their return-to-parent review queue.
// Existing conversations remain owned by the save store; newly delegated threads
// are adopted by the page using their stable IDs. No credentials are persisted.
const { makeDomainStore } = require('./domain-store.js');

function makeOverseer(deps) {
  const store = makeDomainStore({ fs: deps.fs, path: deps.path, file: deps.file,
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
  if (!['ok', 'absent', 'recovered'].includes(loaded.status)) throw new Error('overseer state unavailable: ' + loaded.status);
  let state = loaded.value;
  const copy = value => JSON.parse(JSON.stringify(value));
  const commit = next => { store.save(next); state = next; };
  const update = fn => { const next = copy(state); const out = fn(next); commit(next); return copy(out); };
  const valid = value => /^[A-Za-z0-9_-]{1,80}$/.test(String(value || ''));
  const locks = new Map();

  function threads() {
    const legacy = deps.sessions() || {};
    const deleted = new Set(legacy.deletedIds || []);
    const rows = new Map((legacy.workstreams || []).map(w => [w.id, w]));
    for (const w of state.threads) {
      if (deleted.has(w.id)) { rows.delete(w.id); continue; }
      const visible = rows.get(w.id);
      rows.set(w.id, Object.assign({}, w, visible || {}, { parentStreamId: w.parentStreamId }));
    }
    return Array.from(rows.values()).filter(w => !w.archived).map(w => ({ ...w,
      title: w.title || (w.id === legacy.generalId ? 'General' : 'Untitled') }));
  }
  function resolve(ref) {
    const rows = threads();
    const key = String(ref || '').trim().toLowerCase();
    const exact = rows.filter(w => w.id === ref);
    const named = rows.filter(w => w.title.toLowerCase() === key);
    const hits = exact.length ? exact : named;
    if (hits.length !== 1) throw new Error(hits.length ? 'ambiguous session title; use its id' : 'no such session');
    return hits[0];
  }
  function create(args) {
    const title = String(args.title || '').trim().slice(0, 80);
    if (!title) throw new Error('a session needs a title');
    const parent = resolve(args.parentStreamId);
    const duplicate = state.threads.find(w => args.requestId && w.requestId === args.requestId);
    if (duplicate) return copy(resolve(duplicate.id));
    if (threads().some(w => w.title.toLowerCase() === title.toLowerCase())) throw new Error('session title already exists; use its id');
    const agentId = args.agentId || parent.agentId || 'agent';
    if (!valid(agentId) || !deps.hasAgent(agentId)) throw new Error('unknown crew agent');
    const row = { id: deps.newId(), title, agentId, parentStreamId: parent.id,
      projectRoot: parent.projectRoot || null, requestId: String(args.requestId || ''),
      kind: 'chat', lane: 'active', history: [], runIds: [], createdAt: deps.now(), lastActiveAt: deps.now() };
    return update(s => { s.threads.push(row); return row; });
  }
  function collect(workers) {
    const fresh = workers.filter(w => valid(w.parentStreamId) && (w.completedAt || w.status === 'stale')
      && ['done', 'error', 'refused', 'interrupted', 'stale'].includes(w.status)
      && !state.reviews.some(r => r.id === w.runId + ':review'));
    if (!fresh.length) return;
    update(s => { for (const w of fresh) s.reviews.push({ id: w.runId + ':review',
      parentStreamId: w.parentStreamId, childStreamId: w.streamId || '', agentId: w.leadId,
      workerId: w.id, workerRunId: w.runId, generation: w.generation, status: 'pending',
      createdAt: deps.now(), reviewRunId: '', error: '' }); return null; });
  }
  function patchReview(id, fields) {
    return update(s => { const r = s.reviews.find(row => row.id === id); if (!r) throw new Error('unknown review'); Object.assign(r, fields); return r; });
  }
  // Shared by user and review turns. A failed turn never poisons the next turn.
  async function withThread(id, fn) {
    const previous = locks.get(id) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => held);
    locks.set(id, tail);
    await previous.catch(() => {});
    try { return await fn(); }
    finally { release(); if (locks.get(id) === tail) locks.delete(id); }
  }
  function stopReviews() {
    update(s => { s.paused = true; for (const r of s.reviews) if (r.status === 'pending' || r.status === 'reviewing') {
      r.status = 'cancelled'; r.error = 'Stopped by the Commander.';
    } return null; });
  }
  function snapshot() { return { threads: threads().map(w => ({ id: w.id, title: w.title, agentId: w.agentId,
    parentStreamId: w.parentStreamId || '', projectRoot: w.projectRoot || null,
    kind: w.kind, lane: w.lane, createdAt: w.createdAt })), reviews: copy(state.reviews), paused: !!state.paused }; }
  function resumeReviews() { if (state.paused) update(s => { s.paused = false; return null; }); }
  return { threads, resolve, create, collect, patchReview, withThread, snapshot, stopReviews, resumeReviews };
}
module.exports = { makeOverseer };
