/* AGENT OS — threadstore.js : the live wiring around the NS-6 THREAD turn-in (the frontend hop that makes the
   thread ledger real).

   The sidecar MINES a finished task run for "threads" — ideas the Commander floated but never acted on, each
   grounded by a verbatim quote — and STASHES the candidates (never auto-commits; the memory/study law). This
   store fetches that stash on agent.run.end (via chat.js's beat wiring), gates it (session cap + anti-nag), and
   routes the Commander's Keep / Edit / Discard verdict to POST /api/threads/turnin — the click IS the consent:
   keep/edit commits an OPEN thread on the durable ledger (night-shift propose draws from it), discard PERMANENTLY
   denylists the idea's fingerprint server-side (the "discard = never again" law).

   Discipline mirrors studystore.js exactly:
   - READ-ONLY citizen of U.bus — it NEVER emits (the frozen shared/events.js contract is owned elsewhere).
   - Self-persists its OWN key (decided-proposal fingerprints + per-idea ignore tallies) — no save.js change. The
     permanent denylist lives SERVER-side (threads-store declined fingerprints; the mine dedups at the source),
     so unlike studystore there is no client declined list. The per-session shown counter is in-memory.
   - node-exportable for its test; the DOM half (the gold-inset turn-in card sharing chat.js's ONE post-run beat
     slot at the LOWEST priority — memory > study > arc > trust > thread) lives in chat.js. */
'use strict';
const ThreadStore = (() => {
  const KEY = 'starnet.threadturnin.v1';
  const SESSION_CAP = 1;        // at most ONE thread turn-in card SHOWN per session (anti-nag; mirrors study's trim)
  const IGNORE_LIMIT = 2;       // ignore a mined idea this many times → stop offering it (stop-forever, client-side)
  const RESOLVED_CAP = 300;     // decided-proposal fingerprints (FIFO) — a kept/discarded idea never re-offers here

  let state = null;             // persisted: { v, resolved:{fp:1}, resolvedOrder:[fp], ignores:{fp:int} }
  let sessionShown = 0;         // cards shown THIS session (in-memory; resets each app run)
  let deps = {};                // { now } — injected by app.js (optional; fail-open)

  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function hydrate(raw) {
    const s = { v: 1, resolved: {}, resolvedOrder: [], ignores: {} };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.resolvedOrder)) for (const fp of raw.resolvedOrder.slice(-RESOLVED_CAP)) { if (typeof fp === 'string' && fp) { s.resolved[fp] = 1; s.resolvedOrder.push(fp); } }
      if (raw.ignores && typeof raw.ignores === 'object') for (const k in raw.ignores) { const n = Math.floor(Number(raw.ignores[k])); if (Number.isFinite(n) && n > 0) s.ignores[k] = n; }
    }
    return s;
  }

  // a stable fingerprint of a mined idea's title — the SAME token-sort scheme as sidecar/threadmine.fingerprint /
  // threads-store.fingerprint, so client-side resolve/ignore recognises the same idea across reworded mines.
  function fingerprint(title) {
    const toks = String(title == null ? '' : title).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }
  // mark a proposal DECIDED (kept/edited/discarded) so no stale stash batch can ever re-offer it. FIFO-capped.
  function markResolved(prop) {
    if (!state || !prop || !prop.title) return;
    const fp = prop.fingerprint || fingerprint(prop.title);
    if (!state.resolved[fp]) {
      state.resolved[fp] = 1; state.resolvedOrder.push(fp);
      while (state.resolvedOrder.length > RESOLVED_CAP) { const old = state.resolvedOrder.shift(); delete state.resolved[old]; }
    }
    save();
  }

  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0;
  }
  // a brand-new hero starts clean (mirrors the other stores' reset on commission). The server-side ledger +
  // denylist are station-wide and owned there; only the client gate state resets here.
  function reset() { state = hydrate(null); sessionShown = 0; try { localStorage.removeItem(KEY); } catch (_) {} }

  // ---- the gate the chat beat consults ----
  function canShow() { return !!state && sessionShown < SESSION_CAP; }
  // has this idea already been decided here, or ignored to the stop-forever limit? (The PERMANENT denylist is
  // server-side — a discarded idea is never even mined again — this is the stale-batch / anti-nag layer.)
  function isExhausted(title) {
    if (!state) return true;
    const fp = fingerprint(title);
    if (state.resolved[fp]) return true;
    if ((state.ignores[fp] || 0) >= IGNORE_LIMIT) return true;
    return false;
  }
  // pick the first still-live proposal from a fetched batch (drops resolved/ignored ones). Returns it or null.
  function nextLive(proposals) {
    if (!state || !Array.isArray(proposals)) return null;
    for (const p of proposals) {
      if (!p || !p.title || !p.id) continue;
      if (isExhausted(p.title)) continue;
      return p;
    }
    return null;
  }
  // count one shown card against the session budget (the caller calls this when it actually renders).
  function markShown() { sessionShown++; }

  // fetch the pending mined thread candidates for a run. Returns { runId, proposals } — runId is the STASH BATCH
  // id the turn-in verdict must reference (the server may fall back to the agent's latest pending batch).
  // { runId:null, proposals:[] } on any failure (fail-open).
  async function fetchProposals(runId, agentId) {
    try {
      if (typeof Harness === 'undefined' || !Harness.threadProposals) return { runId: null, proposals: [] };
      const out = await Harness.threadProposals(runId, agentId || 'agent');
      if (!out || !Array.isArray(out.proposals)) return { runId: null, proposals: [] };
      return { runId: out.runId || null, proposals: out.proposals };
    } catch (_) { return { runId: null, proposals: [] }; }
  }

  // ---- consent verdicts (called by the chat thread card) ----
  // KEEP / EDIT: commit the idea as an OPEN thread on the server ledger. `edits` = { title?, spec? } (present ⇒
  // verdict 'edit'). Awaited + honest: returns the server's { ok, reason } ('added' | 'duplicate' | 'declined')
  // so the card never flashes "kept" on a refused write. EVERY outcome marks the proposal resolved client-side
  // (the server drops it from the stash itself), so it can never loop back from a stale batch.
  async function keep(prop, batchRunId, agentId, edits) {
    if (!prop || typeof Harness === 'undefined' || !Harness.threadTurnin) return { ok: false };
    const o = { agentId: agentId || 'agent', runId: batchRunId || '', id: prop.id || '', verdict: edits ? 'edit' : 'keep' };
    if (edits && typeof edits.title === 'string' && edits.title.trim()) o.title = edits.title.trim();
    if (edits && typeof edits.spec === 'string' && edits.spec.trim()) o.spec = edits.spec.trim();
    let r;
    try { r = await Harness.threadTurnin(o); } catch (_) { r = { ok: false }; }
    markResolved(prop);
    return (r && typeof r === 'object') ? r : { ok: false };
  }
  // DISCARD: permanently denylist the idea's fingerprint SERVER-side (never re-mined, never re-offered) and
  // resolve it here. Awaited for the same honesty (the card reports what actually happened).
  async function discard(prop, batchRunId, agentId) {
    if (!prop || typeof Harness === 'undefined' || !Harness.threadTurnin) return { ok: false };
    let r;
    try { r = await Harness.threadTurnin({ agentId: agentId || 'agent', runId: batchRunId || '', id: prop.id || '', verdict: 'discard' }); } catch (_) { r = { ok: false }; }
    markResolved(prop);
    return (r && typeof r === 'object') ? r : { ok: false };
  }
  // IGNORE (the Commander left the card without deciding — it expired at the next run end): tally it;
  // IGNORE_LIMIT ignores stops the idea for good client-side. NOT resolved server-side — an ignored-once idea
  // may legitimately re-offer later (the second chance the 2× limit exists to give).
  function ignore(prop) {
    if (!state || !prop || !prop.title) return;
    const fp = prop.fingerprint || fingerprint(prop.title);
    state.ignores[fp] = (state.ignores[fp] || 0) + 1;
    save();
  }

  return {
    init, reset, canShow, isExhausted, nextLive, markShown, fetchProposals,
    keep, discard, ignore, fingerprint,
    SESSION_CAP, IGNORE_LIMIT,
    _state: () => state
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ThreadStore };
