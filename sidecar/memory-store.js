/* sidecar/memory-store.js - durable per-agent memory KV routing.

   The notebook, todo, declined, minted, and pending stores intentionally share one injected store contract, but
   they do not share the same on-disk file: notebook:<agent> is durable long-term memory, todo:<agent> is the active
   task plan that must survive restarts/compaction, declined:<agent> is the permanent reject-list of memory
   proposals the Commander Discarded (so reflection never re-proposes them — §5.6 "discard = never again"), and
   pending:<agent> holds high-stakes proposals still awaiting a Keep/Edit/Discard verdict.
   Unknown keys are rejected instead of being accidentally mapped into a notebook filename. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');
const { note: failNote } = require('./failopen.js');   // tagged SYNC swallow: a fail-open catch must never be invisible

function agentIdFromKey(key, prefix) {
  const raw = String(key || '').replace(prefix, '') || 'agent';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(raw)) throw new Error('bad memory agentId');
  return raw;
}

function memoryFileFor(workspaces, pathMod, key) {
  const k = String(key || '');
  if (k.indexOf('notebook:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^notebook:/) + '.notebook.json');
  if (k.indexOf('todo:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^todo:/) + '.todo.json');
  if (k.indexOf('declined:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^declined:/) + '.declined.json');
  if (k.indexOf('minted:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^minted:/) + '.minted.json');
  if (k.indexOf('pending:') === 0) return pathMod.join(workspaces, agentIdFromKey(k, /^pending:/) + '.pending.json');
  throw new Error('unsupported memory store key: ' + k);
}

function makeMemoryStore(deps) {
  deps = deps || {};
  const pathMod = deps.path;
  const workspaces = deps.workspaces;
  if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeMemoryStore: path module required');
  if (!workspaces) throw new Error('makeMemoryStore: workspaces path required');

  const durable = makeDurableJsonStore({
    fs: deps.fs,
    path: pathMod,
    fileFor: key => memoryFileFor(workspaces, pathMod, key),
    writeDurable: deps.writeDurable,
    onRecover: deps.onRecover,
    onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};

  return {
    get(key) {
      try { return durable.get(key); }
      catch (e) { return undefined; }
    },
    set(key, value) {
      try { durable.set(key, value); }
      catch (e) { warn('[memory] persist failed:', (e && e.message) || e); }
    },
    update(key, mutator) {
      return durable.update(key, mutator);
    },
    readKey(key) {
      return durable.readKey(key);
    },
    _durable: durable
  };
}

// Wipe all of ONE agent's per-store memory — its kept notebook, its permanent declined reject-list, its active
// todo plan, and any proposals still awaiting a verdict — so a re-commissioned hero starts clean (no prior
// Commander's beliefs bleed in, and no prior Commander's un-answered confirm deck greets the new one). Best-effort
// per key: a single unwritable file never blocks the others. Pure over the injected store, so it is unit-testable
// without booting the server (the new-hero clean-slate is a named hard rule, not just a source-grep).
async function resetAgentMemory(store, agentId) {
  const id = String(agentId || 'agent');
  for (const key of ['notebook:' + id, 'declined:' + id, 'todo:' + id, 'minted:' + id, 'pending:' + id]) {
    try { await store.update(key, () => []); } catch (e) { failNote('memory.clear', e); }
  }
}

// Remove ONE entry from an agent's permanent declined reject-list (the undo-a-discard escape hatch), so a belief
// the Commander discarded by mistake can be proposed again. Returns whether anything was actually removed. Pure
// over the injected store → unit-testable without booting the server.
async function restoreDeclined(store, agentId, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  let removed = false;
  await store.update('declined:' + String(agentId || 'agent'), (stored) => {
    const list = Array.isArray(stored) ? stored.slice() : [];
    const i = list.indexOf(t);
    if (i >= 0) { list.splice(i, 1); removed = true; }
    return list;
  });
  return removed;
}

/* ---- the durable PENDING queue (pending:<agent>) ----

   High-stakes memory proposals (credential/PII/standing-instruction shaped) are not auto-saved — they wait for a
   Keep/Edit/Discard verdict. That wait used to live in an in-memory Map keyed by runId, which was fine while only
   the watched browser run could raise one. Unattended runs reflect now, so a deck can be raised with nobody at the
   station, and an un-answered proposal that evaporates on the next restart is a belief the Commander never got to
   rule on. These three helpers are the durable half; the composite key is runId+':'+id because proposal ids are
   per-batch (every batch mints a prop_1).

   Pure over the injected store with an INJECTED `now` (memory-store.js is inside the determinism scan), so the
   queue is unit-testable without booting the server — the same reason restoreDeclined was factored out. */
const PENDING_CAP = 50;   // FIFO bound: a runaway backlog must never grow without limit
function pendingKey(runId, id) { return String(runId == null ? '' : runId) + ':' + String(id == null ? '' : id); }

// Queue high-stakes proposals for later review. Idempotent per (runId, id): re-stashing the same batch — which a
// retried run or a double-fired beat will do — never doubles the deck. Oldest entries fall off at the cap.
async function appendPending(store, agentId, runId, items, now) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return 0;
  const stamp = Number(now) || 0;
  let added = 0;
  await store.update('pending:' + String(agentId || 'agent'), (stored) => {
    const cur = Array.isArray(stored) ? stored.slice() : [];
    for (const p of list) {
      const key = pendingKey(runId, p.id);
      if (cur.some(e => e && e.key === key)) continue;
      cur.push({
        key: key, runId: String(runId == null ? '' : runId), id: String(p.id == null ? '' : p.id),
        kind: p.kind || 'note', content: String(p.content == null ? '' : p.content),
        scope: p.scope || 'global', origin: p.origin || 'commander', createdAt: stamp,
        ...(p.replaceId ? { replaceId: p.replaceId, previousBody: p.previousBody, streamId: p.streamId || null } : {})
      });
      added++;
    }
    if (!added) return undefined;   // nothing new — skip the write
    while (cur.length > PENDING_CAP) cur.shift();
    return cur;
  });
  return added;
}

// Remove ONE decided proposal and return it, so a verdict arriving after a restart (when the in-memory batch is
// long gone) can still be resolved against the real proposal body instead of 404-ing the Commander's decision.
// Returns null when it was never queued — callers treat that as "not ours", never as an error.
async function takePending(store, agentId, runId, id) {
  const key = pendingKey(runId, id);
  let taken = null;
  await store.update('pending:' + String(agentId || 'agent'), (stored) => {
    const cur = Array.isArray(stored) ? stored : [];
    const i = cur.findIndex(e => e && e.key === key);
    if (i < 0) return undefined;   // nothing to write
    taken = cur[i];
    const next = cur.slice(); next.splice(i, 1);
    return next;
  });
  return taken;
}

function listPending(store, agentId) {
  const v = store.get('pending:' + String(agentId || 'agent'));
  return Array.isArray(v) ? v.filter(Boolean) : [];
}

// Non-consuming lookup for two-phase turn-in: KEEP/EDIT must prove the destination write before the proposal is
// removed. Consuming first loses the Commander's decision forever when the notebook/skill disk write fails.
function findPending(store, agentId, runId, id) {
  const key = pendingKey(runId, id);
  return listPending(store, agentId).find(e => e && e.key === key) || null;
}

module.exports = { makeMemoryStore, memoryFileFor, resetAgentMemory, restoreDeclined, appendPending, takePending, listPending, findPending, PENDING_CAP };
