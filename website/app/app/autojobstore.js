/* STARNET — autojobstore.js : the browser wiring around the pure self-initiation engine (autojobs.js). Slice 2 of
   the autonomy layer.

   It does two things, both routed through the same flow (reason-only model call → parse → approval beat → schedule):
   - PROACTIVE (fire-once): after the First Pitch, once the Commander has turned autonomy on (Initiative ≥ propose)
     and the station knows enough, it offers — ONCE — a few standing-job proposals on a clean run.end. Hard-gated +
     anti-nag; the manual entry takes over after.
   - MANUAL: the ROUTINES panel's "propose standing jobs" button calls propose() directly (an explicit ask always
     allowed, even after the one-time proactive offer is spent).

   Discipline mirrors pitchstore.js / suggeststore.js:
   - READ-ONLY citizen of U.bus — it .on()s 'agent.run.end' and NEVER .emit()s (lint-emits stays green).
   - Self-persists a single {proposed} fire-once flag to its OWN localStorage key (no save.js change).
   - All decision logic lives in the pure AutoJobs engine; this is the live glue: the gate inputs, the model call,
     the Dialogue approval loop, and the POST to /api/cron (via an injected dep so it stays node-testable).
   - The actual jobs live SERVER-side (cron); this store only remembers whether the one-time offer has happened. */
'use strict';
const AutoJobStore = (() => {
  const KEY = 'starnet.autojobs.v1';
  let state = null;            // { v:1, proposed:bool } — the proactive fire-once flag (self-persisted)
  let deps = {};               // accessors/actions injected by app.js
  let firing = false;          // re-entrancy guard while a proposal flow is mid-air

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof AutoJobs !== 'undefined' && state;
  function ledgerPost(body) {
    try {
      const f = (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch : (typeof fetch === 'function' ? fetch : null);
      if (f) f('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    } catch (_) {}
  }

  // W6 DEDUP (frontend UX layer — the SERVER gate is the real authority, this just avoids a doomed POST + a
  // ghost proposal). A normalized-name fingerprint (mirrors suggeststore.fingerprint): lowercase, alnum tokens
  // >=3 chars, sorted+unique — so a reordered/padded restatement of an existing routine name still matches.
  function nameFp(s) {
    const toks = String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }
  // fetch the LIVE routine names (never the stale propose-time list) so the check reflects what actually exists now.
  async function liveJobNames() {
    try { return deps.getExistingJobs ? ((await deps.getExistingJobs()) || []) : []; } catch (_) { return []; }
  }
  // is the SIDECAR SCHEDULER armed right now? (GET /api/cron `.enabled` = the live cronArmed). This is the REAL gate
  // on whether a just-scheduled routine will actually fire — the done-line must not promise a run the scheduler
  // won't make. Injected accessor wins; else force the shared cron resource fresh. Undefined
  // on any failure so the caller can degrade to the neutral copy rather than assert a scheduler state it can't read.
  function cronRunnable(j) {
    return j && typeof j.enabled === 'boolean' ? !!(j.enabled && !j.halted) : undefined;
  }
  async function schedulerArmed() {
    try { if (deps.schedulerArmed) return !!(await deps.schedulerArmed()); } catch (_) {}
    try {
      if (typeof QuerySpine === 'undefined' || !QuerySpine.refresh) return undefined;
      const q = await QuerySpine.refresh('cron');
      return cronRunnable(q && q.hasData ? q.data : null);
    } catch (_) { return undefined; }
  }

  // does a live routine already carry this proposal's name? (exact normalized-name match against the live list).
  function existsAmong(title, liveNames) {
    const fp = nameFp(title);
    if (!fp) return false;
    return (liveNames || []).some(n => nameFp(n) === fp);
  }

  // G4 feature 2 — PIN-TO-BOARD. When a MISSION BOARD is placed, a parsed proposal gets a BODY: instead of the
  // inline Dialogue approval, the agent walks to the board and pins an amber PROPOSAL card. The pending ledger
  // below is the source of truth the board pin-feed projects and the quest log renders (approve → the real POST
  // /api/cron via deps.scheduleJob; decline → drop it, dismissed-forever). Self-persisted under the same KEY so a
  // pending proposal survives a reload (a real "waiting for you" state, honest across sessions). No board placed →
  // this ledger stays empty and the existing Dialogue flow runs untouched (the pin is a projection, never a gate).
  let pinSeq = 0;
  function hydrate(raw) {
    const s = { v: 1, proposed: false, pending: [] };
    if (raw && typeof raw === 'object') {
      if (raw.proposed) s.proposed = true;
      if (Array.isArray(raw.pending)) s.pending = raw.pending.filter(p => p && p.id && p.title);
    }
    return s;
  }
  // is a MISSION BOARD placed on the live floor? (injected so the store stays node-testable). Default: no board.
  const boardPlaced = () => { try { return !!(deps.boardPlaced && deps.boardPlaced()); } catch (_) { return false; } };

  // opts: { getSystem(), getName(), getBeliefs(), getExistingJobs(), scheduleJob(body) }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    firing = false;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) U.bus.on('agent.run.end', onRunEnd);
  }

  const pitchDone = () => (typeof PitchStore !== 'undefined' && PitchStore.done) ? PitchStore.done() : false;
  const autonomyOn = () => (typeof AutonomyStore !== 'undefined' && AutonomyStore.summary && AutonomyStore.summary()) ? !!AutonomyStore.summary().enabled : false;

  // the PROACTIVE gate (live inputs → the pure engine). Side-effect free so the test can assert it. The fire-once
  // proactive offer only; the manual button bypasses this entirely.
  function decide(p) {
    if (!ready()) return { go: false, reason: 'not-ready' };
    if (firing) return { go: false, reason: 'firing' };
    if (state.proposed) return { go: false, reason: 'already-proposed' };
    p = p || {};
    if (p.reason !== 'done') return { go: false, reason: 'not-done' };
    if ((p.agentId || 'agent') !== 'agent') return { go: false, reason: 'not-hero' };
    if (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning()) return { go: false, reason: 'onboarding' };
    if (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning()) return { go: false, reason: 'intake' };
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) return { go: false, reason: 'dialogue-open' };
    const sum = (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null;
    const known = sum ? sum.known : [];
    const base = AutoJobs.shouldPropose({ enabled: autonomyOn(), alreadyProposed: state.proposed, firstPitchDone: pitchDone(), knownDims: known });
    if (!base.go) return base;
    let rd = null;
    try { rd = deps.readiness ? deps.readiness() : ((typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) ? UnderstandingStore.readiness() : null); } catch (_) {}
    return (rd && rd.ready) ? base : { go: false, reason: 'shared-readiness' };
  }

  function onRunEnd(p) { if (decide(p).go) propose({ proactive: true }); }

  // collect the grounding beliefs the engine wants ({ dim: [texts] }) from the injected accessor.
  function beliefs() { try { return deps.getBeliefs ? (deps.getBeliefs() || {}) : {}; } catch (_) { return {}; } }

  // THE FLOW (awaitable for the test): reason out proposals → present them one at a time → schedule the approved
  // ones via /api/cron. Used by BOTH the proactive offer and the manual button. `proactive` only controls the
  // fire-once bookkeeping (a manual run never burns or needs the flag).
  async function propose(opts) {
    opts = opts || {};
    if (firing || !ready()) return { scheduled: 0 };
    if (typeof Harness === 'undefined' || !Harness.chat || typeof Dialogue === 'undefined') return { scheduled: 0 };
    firing = true;
    let scheduled = 0;
    try {
      let existing = [];
      try { existing = deps.getExistingJobs ? (await deps.getExistingJobs()) || [] : []; } catch (_) { existing = []; }
      // ONE read of the beliefs, used TWICE: it grounds the directive, and it is the evidence pool the parse
      // vetoes against. Reading it once is what makes those two the same set — a second read could drift.
      const known = beliefs();
      const directive = AutoJobs.buildProposalDirective({ beliefs: known, existingJobs: existing });
      const system = deps.getSystem ? deps.getSystem() : '';
      const name = deps.getName ? deps.getName() : 'AGENT';

      if (typeof Chat !== 'undefined' && Chat.clearNudge) Chat.clearNudge();   // retire any stale gentle nudge before the focused panel opens
      Dialogue.open({ name });
      await Dialogue.say('give me a second — let me think about what would be worth running for you on a schedule…', { auto: true });   // latency patter — never gate a wait on a click
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true });
      // THE GROUNDING VETO runs here: a proposal whose GROUNDS shares nothing with `known` is dropped, so an
      // invented rationale can never become a cron job the station wakes to forever.
      const proposals = (res && !res.error) ? AutoJobs.parseProposals(res.text, { beliefs: known }) : [];
      if (!proposals.length) {   // model hiccup / nothing groundable → say nothing useful, leave the flag UNSET so a later run can retry
        if (Dialogue.isOpen()) Dialogue.close();
        return { scheduled: 0 };
      }

      // G4 feature 2: a MISSION BOARD is placed → the proposals get a BODY. Park them in the pending ledger (the
      // board pin-feed + quest log project them), close the panel, and let the agent walk-and-pin. No inline
      // Dialogue approval — the Commander decides at the board / quest log (approve → the real cron POST). The
      // fire-once flag is still spent (the offer was delivered — it now lives on the board, not in a settings toggle).
      if (boardPlaced()) {
        if (Dialogue.isOpen()) Dialogue.close();
        const added = pinProposals(proposals);
        if (opts.proactive) { state.proposed = true; }
        save();
        return { scheduled: 0, pinned: added };
      }

      await Dialogue.say(AutoJobs.introLine(proposals.length));
      // W6: the live routine names, re-read once here, so an approve for a name that already exists is skipped
      // (the server would reject it anyway — this keeps the count honest and avoids a doomed POST).
      const live = await liveJobNames();
      for (const pr of proposals) {
        if (!Dialogue.isOpen()) break;
        if (existsAmong(pr.title, live)) continue;   // already a live routine with this name — don't offer a dup
        const rid = 'routine:' + nameFp(pr.title) + ':' + Date.now();
        /* GROUNDS IS THE MODEL'S OWN PROSE, NOT A QUOTE (2026-08-05). It went to the ledger as
           `type:'dossier', quote:` — the evidence type that means "this is a verbatim thing the Commander's
           own record says". autojobs.js parses GROUNDS out of the aux reply and V.grounded only checks that it
           OVERLAPS what the station knows; the words are still the model's. Same mis-typing the suggest ledger
           carried one file over, same fix: rationale/text. Both ledgerPosts in this file (here and pinProposals). */
        ledgerPost({ id: rid, surface: 'routine', kind: 'routine', title: pr.title, target: nameFp(pr.title), traits: ['routine', 'cadence:' + (pr.cadenceId || 'unknown')], evidence: [{ id: 'routine-grounds', type: 'rationale', text: pr.grounds || pr.why || '' }], readiness: { ready: true, reasons: [] }, modelVersion: 'autojobs-v2' });
        const choice = await Dialogue.node({ lines: AutoJobs.proposalLines(pr), options: AutoJobs.approveChoices(), dismissable: true, dismissLabel: 'leave it — not now' });
        if (choice && choice.dismissed) { ledgerPost({ id: rid, state: 'deferred', reason: 'wrong_time' }); break; }
        if (choice && choice.value === 'yes' && deps.scheduleJob) {
          try { const r = await deps.scheduleJob(AutoJobs.toCronBody(pr)); if (r && r.ok === true && !r.duplicate) { scheduled++; live.push(pr.title); ledgerPost({ id: rid, state: 'completed', reason: 'completed' }); } } catch (_) {}
        } else if (choice) ledgerPost({ id: rid, state: 'declined', reason: 'wrong_thing' });
      }
      if (Dialogue.isOpen()) {
        // HONEST done-line: if we actually scheduled something, name whether the scheduler that fires it is armed
        // (so we never promise a run the disarmed scheduler won't make). undefined armed-state → neutral copy.
        const armed = scheduled > 0 ? await schedulerArmed() : undefined;
        await Dialogue.say(AutoJobs.doneLine(scheduled, armed));
        Dialogue.close();
      }
      if (opts.proactive) { state.proposed = true; save(); }   // the one-time proactive offer is spent (delivered)
    } catch (_) {
      try { if (Dialogue.isOpen()) Dialogue.close(); } catch (__) {}
    } finally {
      firing = false;
    }
    return { scheduled };
  }

  // ── G4 feature 2 — THE PENDING-PROPOSAL LEDGER (the board body) ─────────────────────────────────────────
  // park parsed proposals as amber PROPOSAL cards on the board. De-duped by title (a re-propose of the same job
  // doesn't stack), so the walk-and-pin plays once per distinct proposal (anti-nag). Returns how many were added.
  function pinProposals(proposals) {
    if (!state) return 0;
    if (!Array.isArray(state.pending)) state.pending = [];
    let added = 0;
    for (const pr of (proposals || [])) {
      if (!pr || !pr.title) continue;
      if (state.pending.some(x => x && x.title === pr.title)) continue;   // already pinned — don't re-pin (once per proposal)
      const rid = 'routine:' + nameFp(pr.title) + ':' + Date.now() + ':' + (++pinSeq);
      state.pending.push({
        id: 'ajp_' + (Date.now().toString(36)) + '_' + (++pinSeq),
        recommendationId: rid, title: pr.title, why: pr.why || '', grounds: pr.grounds || '', cadenceId: pr.cadenceId, prompt: pr.prompt || '', at: Date.now()
      });
      ledgerPost({ id: rid, surface: 'routine', kind: 'routine', title: pr.title, target: nameFp(pr.title), traits: ['routine', 'cadence:' + (pr.cadenceId || 'unknown')], evidence: [{ id: 'routine-grounds', type: 'rationale', text: pr.grounds || pr.why || '' }], readiness: { ready: true, reasons: [] }, modelVersion: 'autojobs-v2' });
      added++;
    }
    return added;
  }
  // the live pending proposals (read by the board pin-feed + the quest log). A fresh copy — callers never mutate ours.
  function pendingList() { return (state && Array.isArray(state.pending)) ? state.pending.map(p => Object.assign({}, p)) : []; }
  function pendingCount() { return (state && Array.isArray(state.pending)) ? state.pending.length : 0; }
  function findPending(id) { return (state && Array.isArray(state.pending)) ? state.pending.find(p => p && p.id === id) : null; }
  // APPROVE: schedule the real cron routine (the SAME POST /api/cron path the Dialogue flow uses), then drop the
  // card. Returns { ok }. A failed POST leaves the card pinned so the Commander can retry — never a silent loss.
  async function acceptPending(id) {
    const pr = findPending(id);
    if (!pr || !ready()) return { ok: false };
    // W6: if a live routine already carries this name, DON'T mint a second — mark the proposal decided so the
    // amber card vanishes (COMMS rule: a decided card is removed, never left ghosting). The server gate would
    // reject the POST anyway; this keeps the board honest without a doomed round-trip.
    const live = await liveJobNames();
    if (existsAmong(pr.title, live)) { state.pending = state.pending.filter(p => p && p.id !== id); save(); ledgerPost({ id: pr.recommendationId, state: 'completed', reason: 'already_done' }); return { ok: true, duplicate: true }; }
    let ok = false, duplicate = false;
    if (deps.scheduleJob) { try { const r = await deps.scheduleJob(AutoJobs.toCronBody(pr)); ok = !!(r && r.ok === true); duplicate = ok && r.duplicate === true; } catch (_) { ok = false; } }
    // a real success OR a server-reported duplicate both retire the card (a dup is "already handled", not a failure).
    if (ok || duplicate) { state.pending = state.pending.filter(p => p && p.id !== id); save(); ledgerPost({ id: pr.recommendationId, state: 'completed', reason: duplicate ? 'already_done' : 'completed' }); }
    // Only a newly scheduled, explicitly approved routine proves adoption; dedup retirement does not.
    if (ok && !duplicate) ledgerPost({ id: pr.recommendationId, outcome: { adopted: true } });
    // ARM-STATE (item #1): on a genuine schedule, tell the render site whether the scheduler that fires it is armed,
    // so the board/quest-log can surface AutoJobs.armStateLine() honestly ("saved, but the scheduler is off …").
    // Only probed on a real success (a dup/failure needs no arm hint). undefined → the render site shows no line.
    let disarmed = null;
    if (ok && !duplicate) { const armed = await schedulerArmed(); disarmed = AutoJobs.armStateLine(armed); }
    return { ok, duplicate, disarmed };
  }
  // DECLINE: drop the card (dismissed → gone; the walk-and-pin already played once, it never re-nags for this one).
  function declinePending(id) {
    if (!state || !Array.isArray(state.pending)) return false;
    const pr = findPending(id);
    const before = state.pending.length;
    state.pending = state.pending.filter(p => p && p.id !== id);
    if (state.pending.length !== before) { save(); if (pr) ledgerPost({ id: pr.recommendationId, state: 'declined', reason: 'wrong_thing' }); return true; }
    return false;
  }

  // S2: a brand-new hero re-earns the proactive offer (own key, like the other proactive stores).
  function reset() { state = { v: 1, proposed: false, pending: [] }; firing = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  // has the one-time proactive offer already happened? (read by the ROUTINES button to label itself).
  function proposed() { return !!(state && state.proposed); }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, propose, proposed, pinProposals, pendingList, pendingCount, acceptPending, declinePending, _decide: decide, _state: () => state, _cronRunnable: cronRunnable };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutoJobStore };
