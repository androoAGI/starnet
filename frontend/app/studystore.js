/* AGENT OS — studystore.js : the live wiring around the pure STUDY ENGINE (study.js) — the dossier's Phase B.

   Where dossierstore.js only folds the Commander's OWN onboarding docs + panel edits (Phase A), this is the
   glue that lets the station LEARN from actual work: after a salient run the sidecar studies the transcript and
   stashes belief-update proposals; this store fetches them, gates them (session cap + anti-nag), and applies the
   Commander's Keep / Edit / Discard verdict to the DOSSIER (Keep → DossierStore.upsert source:'study'; Discard →
   a PERMANENT studyDeclined denylist; ignore 2× → stop proposing that belief). It also owns the RATINGS→TASTE
   path (§4): consecutive 👍/👎 on one archetype mints ONE style-dim proposal, once per archetype ever.

   Every DECIDED proposal is consumed on BOTH sides: a persisted resolved-fingerprint set here (so the same
   belief can never re-offer from a stale batch) AND a fire-and-forget POST /api/study/resolve that drops it from
   the sidecar stash (mirroring the memory turn-in's batch consumption) and carries the current studyDeclined
   denylist so the NEXT sidecar study pass dedups against it at the source.

   Discipline mirrors curiositystore.js / suggeststore.js:
   - READ-ONLY citizen of U.bus — it NEVER emits (the frozen shared/events.js contract is owned elsewhere).
   - Self-persists its OWN key (declined denylist, resolved set, per-belief ignore tallies, per-archetype rating
     tallies + minted flags) — no save.js change. The per-session shown counter is in-memory (resets each run).
   - node-exportable for its test; all DECISION logic lives in the pure Study engine, this is the edge.

   The DOM half — rendering the study turn-in card and sharing chat.js's ONE post-run beat slot at TURN-IN
   priority (memory turn-in wins; a study proposal queues for the next task end) — lives in chat.js, which calls
   this store for the gate + the consent side-effects. */
'use strict';
const StudyStore = (() => {
  const KEY = 'starnet.study.v1';
  const SESSION_CAP = 1;        // at most ONE study proposal SHOWN per session (beat-fat trim 2026-07-03: was 3 —
                                // a belief-update card every few runs read as "the system guessing about me")
  const IGNORE_LIMIT = 2;       // ignore a proposed belief this many times → stop proposing it (stop-forever)
  const DECLINED_CAP = 200;     // permanent studyDeclined denylist (FIFO) fed into the engine's dedup
  const RESOLVED_CAP = 300;     // decided-proposal fingerprints (FIFO) — a kept/edited belief never re-offers

  let state = null;             // persisted: { v, declined:[text], resolved:{fp:1}, resolvedOrder:[fp], ignores:{fp:int}, ratings:{arch:{up,down,upMinted,downMinted}} }
  let sessionShown = 0;         // proposals shown THIS session (in-memory; resets each app run)
  let deps = {};                // { now } — injected by app.js (all optional; fail-open)
  let goalNotes = [];           // GROWTH Tier 2 (§5): recent goal-progress notes the study engine can weight (in-memory ring; additive/fail-open — never persisted, never blocks a study)

  const ready = () => typeof Study !== 'undefined' && state;
  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function hydrate(raw) {
    const s = { v: 1, declined: [], resolved: {}, resolvedOrder: [], ignores: {}, ratings: {} };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.declined)) s.declined = raw.declined.filter(x => typeof x === 'string' && x.trim()).slice(-DECLINED_CAP);
      if (Array.isArray(raw.resolvedOrder)) for (const fp of raw.resolvedOrder.slice(-RESOLVED_CAP)) { if (typeof fp === 'string' && fp) { s.resolved[fp] = 1; s.resolvedOrder.push(fp); } }
      if (raw.ignores && typeof raw.ignores === 'object') for (const k in raw.ignores) { const n = Math.floor(Number(raw.ignores[k])); if (Number.isFinite(n) && n > 0) s.ignores[k] = n; }
      if (raw.ratings && typeof raw.ratings === 'object') for (const k in raw.ratings) {
        const e = raw.ratings[k] || {};
        s.ratings[k] = { up: Math.max(0, Math.floor(Number(e.up)) || 0), down: Math.max(0, Math.floor(Number(e.down)) || 0), upMinted: !!e.upMinted, downMinted: !!e.downMinted };
      }
    }
    return s;
  }

  // a stable fingerprint of a proposed belief (dim + significant tokens) so an ignore/deny/resolve recognises the
  // same belief across runs even when the model rewords it slightly (mirrors suggeststore.fingerprint).
  function fingerprint(dim, text) {
    const toks = String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return String(dim || '') + '|' + Array.from(new Set(toks)).sort().join(' ');
  }
  // mark a proposal DECIDED (kept/edited/discarded) so no stale server batch can ever re-offer it. FIFO-capped.
  function markResolved(prop) {
    if (!state || !prop || !prop.text) return;
    const fp = fingerprint(prop.dim, prop.text);
    if (!state.resolved[fp]) {
      state.resolved[fp] = 1; state.resolvedOrder.push(fp);
      while (state.resolvedOrder.length > RESOLVED_CAP) { const old = state.resolvedOrder.shift(); delete state.resolved[old]; }
    }
    save();
  }

  // CONSUME the decided proposal on the sidecar too (mirrors the memory turn-in dropping its batch): drop it from
  // the server stash so the latestStudyRun fallback can never re-serve it, and carry the CURRENT studyDeclined
  // denylist so the next runStudy() pass dedups at the source. Fire-and-forget; a failure just means the client-
  // side resolved/declined filters (nextLive) carry the guarantee alone.
  function recommendationId(prop, agentId) { return 'study:' + String(agentId || 'agent') + ':' + String((prop && (prop.id || prop.sourceRunId)) || fingerprint(prop && prop.dim, prop && prop.text)).slice(0, 100); }
  function ledgerPost(body) {
    try {
      const f = (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch : (typeof fetch === 'function' ? fetch : null);
      if (f) f('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    } catch (_) {}
  }
  function resolveOnServer(prop, agentId, decision) {
    if (!prop || typeof fetch !== 'function') return;
    try {
      fetch('/api/study/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId || 'agent', runId: prop.sourceRunId || '', id: prop.id || '', decision: decision || '', declined: declinedList() })
      }).catch(() => {});
    } catch (_) {}
  }

  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0; goalNotes = [];
  }
  // a brand-new hero starts clean (mirrors the other stores' reset on commission).
  function reset() { state = hydrate(null); sessionShown = 0; goalNotes = []; try { localStorage.removeItem(KEY); } catch (_) {} }

  // ---- the gate the chat beat consults ----
  // room left in the per-session budget (anti-nag). The per-RUN "≤1 shown" cap is enforced by the caller
  // showing at most one proposal per beat.
  function canShow() { return !!state && sessionShown < SESSION_CAP; }
  // has this exact belief already been decided, ignored to the stop-forever limit, or explicitly declined?
  function isExhausted(dim, text) {
    if (!state) return true;
    const fp = fingerprint(dim, text);
    if (state.resolved[fp]) return true;                      // already kept/edited/discarded — never re-offer
    if ((state.ignores[fp] || 0) >= IGNORE_LIMIT) return true;
    return Study.isDeclined(text, state.declined);
  }
  // the existing dossier belief a RETIRE proposal would delete — NEVER a pinned one (a pin is the Commander's
  // explicit "this stays"; auto-retire must not be able to reach it). Returns { id, text } or null. Exposed so
  // the chat card can show the Commander the ACTUAL belief that will be removed, and accept() deletes that same one.
  function retireTarget(prop) {
    if (!prop || prop.kind !== 'retire' || typeof DossierStore === 'undefined' || !DossierStore.beliefs) return null;
    try {
      const beliefs = DossierStore.beliefs(prop.dim) || [];
      for (const b of beliefs) {
        if (!b || !b.text || b.pinned) continue;   // skip pinned — if the only match is pinned, the proposal drops
        if (Study.jaccard(b.text, prop.text) >= Study.SIM_THRESHOLD) return { id: b.id, text: b.text };
      }
    } catch (_) {}
    return null;
  }
  // pick the first still-live proposal from a fetched batch (drops resolved/exhausted/declined ones, and RETIRE
  // proposals whose only match is pinned or already gone). Returns it or null.
  function nextLive(proposals) {
    if (!ready() || !Array.isArray(proposals)) return null;
    for (const p of proposals) {
      if (!p || !p.text || isExhausted(p.dim, p.text)) continue;
      if (p.kind === 'retire' && !retireTarget(p)) continue;   // nothing (unpinned) to retire — not offerable
      return p;
    }
    return null;
  }
  // count one shown proposal against the session budget (the caller calls this when it actually renders a card).
  function markShown(prop, agentId) {
    sessionShown++;
    if (!prop) return;
    ledgerPost({
      id: recommendationId(prop, agentId), surface: 'study', kind: prop.kind === 'retire' ? 'belief-retire' : 'belief-update',
      title: String(prop.text || '').slice(0, 240), target: String(prop.id || fingerprint(prop.dim, prop.text)),
      traits: ['study', String(prop.dim || 'belief')], modelVersion: 'study-v1',
      evidence: prop.evidence ? [{ id: String(prop.sourceRunId || ''), type: 'run', quote: String(prop.evidence) }] : [],
      readiness: { ready: true, reasons: ['post_run_evidence'] }
    });
  }

  // fetch the server-side study proposals for a run (with text). [] on any failure (fail-open).
  async function fetchProposals(runId, agentId) {
    try {
      if (typeof Harness === 'undefined' || !Harness.studyProposals) return [];
      const list = await Harness.studyProposals(runId, agentId || 'agent');
      return Array.isArray(list) ? list : [];
    } catch (_) { return []; }
  }

  // the studyDeclined denylist. Enforced client-side in nextLive/isExhausted, AND pushed to the sidecar on every
  // /api/study/resolve call (resolveOnServer) so runStudy() dedups against it at the source.
  function declinedList() { return (state && Array.isArray(state.declined)) ? state.declined.slice() : []; }

  // ---- consent verdicts (called by the chat study card) ----
  // KEEP / EDIT: commit the belief to the DOSSIER with source:'study' + observedAt provenance. A 'retire'
  // proposal is applied by FORGETTING the matched (never-pinned) existing belief instead of adding one. `text` is
  // the (possibly edited) belief. Returns true on a successful write; EVERY outcome (incl. a failed retire whose
  // target vanished) marks the proposal resolved + consumes it server-side, so it can never loop back.
  function accept(prop, text, agentId) {
    if (!prop || typeof DossierStore === 'undefined') return false;
    const dim = prop.dim; const body = String(text != null ? text : prop.text).trim();
    if (!dim || !body) return false;
    let ok = false;
    try {
      if (prop.kind === 'retire') {
        const target = retireTarget(prop);   // pinned-safe match (re-checked at commit time — the dossier may have changed)
        if (target && DossierStore.forget) { DossierStore.forget(dim, target.id); ok = true; }
      } else if (DossierStore.upsert) {
        // double-Keep guard: if the dossier ALREADY holds this belief (exact or paraphrase — e.g. a stale batch
        // re-offered before the resolved set existed, or the Commander added it by hand), do not write a duplicate.
        const existing = (typeof DossierStore.beliefs === 'function') ? (DossierStore.beliefs(dim) || []) : [];
        let dup = false;
        for (const b of existing) { const t = b && b.text; if (t && (t.toLowerCase() === body.toLowerCase() || Study.jaccard(t, body) >= Study.SIM_THRESHOLD)) { dup = true; break; } }
        if (!dup) DossierStore.upsert(dim, { text: body, source: 'study', observedAt: now(), sourceRunId: prop.sourceRunId || null,
          evidence: prop.evidence || '', evidenceRef: prop.evidenceRef || { runId: prop.sourceRunId || null, kind: 'directive' } });
        ok = true;   // a dup-skip is still a successful Keep (the belief IS in the dossier)
      }
    } catch (_) { ok = false; }
    markResolved(prop);
    ledgerPost({ id: recommendationId(prop, agentId), state: ok ? 'completed' : 'declined', reason: ok ? 'completed' : 'bad_quality' });
    ledgerPost({ id: recommendationId(prop, agentId), outcome: { adopted: ok } });
    resolveOnServer(prop, agentId, ok ? 'accepted' : 'failed');
    return ok;
  }
  // DISCARD: add the belief to the PERMANENT studyDeclined denylist so it's never re-proposed (mirrors the
  // memory turn-in's declined list; §5.6 "discard = never again", applied to the dossier).
  function discard(prop, agentId) {
    if (!state || !prop) return;
    const t = String(prop.text || '').trim();
    if (t && state.declined.indexOf(t) < 0) { state.declined.push(t); while (state.declined.length > DECLINED_CAP) state.declined.shift(); }
    markResolved(prop);            // saves
    ledgerPost({ id: recommendationId(prop, agentId), state: 'declined', reason: 'wrong_thing' });
    resolveOnServer(prop, agentId, 'declined');   // carries the updated denylist to the sidecar
  }
  // FORGET → DENYLIST (2026-07-16 resurrect audit): the COMMANDER panel's Forget must be as durable as a
  // study discard — without this, the study loop re-proposed the exact belief the Commander just forgot
  // (forget spliced the dossier but fed no denylist). Text-only sibling of discard(): no proposal object
  // exists (the belief was already IN the dossier), so we append the text to the permanent denylist, save,
  // and mirror it to the sidecar via the same /api/study/resolve POST with no runId/id (a documented
  // harmless no-op consume that still carries the declined list). Fail-soft when the store isn't up yet.
  function declineText(text, agentId) {
    if (!state) return false;
    const t = String(text || '').trim();
    if (!t) return false;
    if (state.declined.indexOf(t) < 0) { state.declined.push(t); while (state.declined.length > DECLINED_CAP) state.declined.shift(); }
    save();
    if (typeof fetch === 'function') {
      try {
        fetch('/api/study/resolve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: agentId || 'agent', runId: '', id: '', declined: declinedList() })
        }).catch(() => {});
      } catch (_) {}
    }
    return true;
  }
  // IGNORE (the Commander left the card without deciding — it expired at the next run end / was replaced):
  // tally it; IGNORE_LIMIT ignores stops the belief for good. NOT resolved server-side — an ignored-once belief
  // may legitimately re-offer at a later task end (that is the second chance the 2× limit exists to give).
  function ignore(prop) {
    if (!state || !prop || !prop.text) return;
    const fp = fingerprint(prop.dim, prop.text);
    state.ignores[fp] = (state.ignores[fp] || 0) + 1;
    save();
  }

  // ---- RATINGS → TASTE (§4) ----
  // fold ONE work rating (verdict 'great'|'ok'|'miss') for an archetype into the persisted streak tally, then —
  // if a fresh 3-streak crossed and that direction hasn't minted before — return ONE style-dim taste proposal to
  // raise (or null). The caller (chat.rateWork) renders it via the same study beat. Once per archetype/direction
  // ever (the minted flag persists). A taste proposal already on the studyDeclined list is suppressed here.
  function noteRating(archetype, verdict) {
    if (!ready() || !archetype) return null;
    const key = String(archetype);
    const entry = state.ratings[key] = Study.foldRating(state.ratings[key], verdict);
    const t = Study.tasteProposal(key, entry, { now: now });
    save();
    if (!t) return null;
    // suppress a taste belief the Commander already declined/decided, and honour the ignore stop-forever tally.
    if (Study.isDeclined(t.proposal.text, state.declined) || isExhausted('style', t.proposal.text)) { entry[t.mintedKey] = true; save(); return null; }
    entry[t.mintedKey] = true;   // mint ONCE — never re-raise this archetype/direction
    save();
    return t.proposal;
  }

  // GROWTH Tier 2 (§5, ADDITIVE/fail-open): a goal milestone just completed — a run-context note the study engine
  // may weight when it next studies work (goal progress is a salience signal). Kept as a small in-memory ring
  // (never persisted, never gates a study, never throws). GoalStore.bumpStudySalience calls this; the read surface
  // (goalNotes) is available for a future server-context wire without touching the frozen contract.
  const GOALNOTE_CAP = 8;
  function noteGoalProgress(note) {
    try {
      const t = note && (note.milestoneText || note.goalText) ? String(note.milestoneText || note.goalText).slice(0, 160) : '';
      if (!t) return;
      goalNotes.push(t);
      while (goalNotes.length > GOALNOTE_CAP) goalNotes.shift();
    } catch (_) {}
  }
  function recentGoalNotes() { return goalNotes.slice(); }

  return {
    init, reset, canShow, isExhausted, nextLive, markShown, fetchProposals, retireTarget,
    declinedList, accept, discard, declineText, ignore, noteRating, fingerprint, noteGoalProgress, recentGoalNotes,
    SESSION_CAP, IGNORE_LIMIT,
    _state: () => state
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { StudyStore };
