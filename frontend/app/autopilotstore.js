/* AGENT OS — autopilotstore.js : the thin live wiring around the pure idle self-direction engine (autopilot.js).
   Slice A of the autonomy layer — the thing that makes the posture dial actually drive the floor.

   It is the EDGE the pure engine isn't allowed to be: it owns the live clock, the "Commander is interacting"
   stamping, the periodic idle check, the model runs, and the desk hand-off. Mirrors autonomystore.js /
   autojobstore.js discipline:
   - READ-ONLY citizen of the app — it takes NO U.bus dependency and NEVER emits (lint-emits stays green).
   - All DECISION logic lives in the pure Autopilot engine; this is glue: stamp activity, tick, dispatch, deliver.
   - node-exportable for its test (inject now + fakes for chat/present; install:false skips the DOM).

   TWO branches, by readiness (the flywheel):
   - EARN (Slice A1): idle + autonomy enabled but not yet act-ready → ask ONE gentle get-to-know-you question
     (reuses the curiosity nudge + its per-session anti-nag cap). Learn first.
   - ACT (Slice A2): idle + the dial permits acting + the dossier is hot + today's leash has budget → run the pure
     anti-slop pipeline (propose grounded candidates → score-and-pick-best with the confidence gate → do the one
     job) as SILENT reason-only runs (internal:true, no tools — safe by construction). It then leaves a desk draft —
     OR (B2) writes a REAL local file when the Commander has GRANTED cabinet:write AND placed a cabinet (server-side:
     consent-gated, jailed, checkpointed/reversible). Still nothing is sent, published, or spent — writes stay local.

   Persists a small own-key slice (leash-per-day accounting + a capped draft log for the "while you were away"
   digest). lastActivity/armed/acting are ephemeral session state. */
'use strict';
const AutopilotStore = (() => {
  const KEY = 'starnet.autopilot.v1';
  let deps = {};
  let state = null;         // persisted: { v, day, acted, drafts:[{title,archetype,at,body}] }
  let lastActivity = 0;     // wall-clock of the Commander's last interaction (set by noteActivity)
  let armed = false;        // false = this idle EPISODE still has its one autopilot beat; true = spent until next activity
  let acting = false;       // an async ACT run is in flight (guards re-entry across ticks)
  let installed = false;    // the DOM listeners + interval are installed exactly once
  let timer = null;
  // NS-1: the server-owned NIGHT-SHIFT driver now owns the ACT branch (restart-safe, leash-enforced). When it is
  // ACTIVE, this frontend loop must NOT double-act — it defers ACT to the sidecar and keeps only EARN (curiosity
  // while the Commander is present) + activity stamping/beaconing. serverActs is a cached capability flag, refreshed
  // lazily from GET /api/nightshift/status; null = unknown (fail toward the OLD behavior so a missing route or a
  // node test is unaffected — the server no-ops its own beat when its posture gate is unmet, so a brief overlap on
  // first load is harmless). lastBeacon throttles the /api/activity beacon to ≥60s.
  let serverActs = null;    // null=unknown, true=sidecar night-shift active (defer ACT), false=inactive (act locally)
  let lastBeacon = 0;       // wall-clock of the last activity beacon (throttle floor)
  let statusChecked = 0;    // wall-clock of the last night-shift status poll (refresh floor)

  const ready = () => typeof Autopilot !== 'undefined';
  const now = () => {
    try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {}
    return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0;
  };
  const dayOf = (t) => Math.floor((Number(t) || 0) / 86400000);   // a UTC day bucket — deterministic, no Date needed

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function hydrate(raw) {
    const s = { v: 1, day: dayOf(now()), acted: 0, drafts: [], learn: {} };
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.day)) s.day = raw.day;
      if (Number.isFinite(raw.acted) && raw.acted >= 0) s.acted = Math.floor(raw.acted);
      if (Array.isArray(raw.drafts)) s.drafts = raw.drafts.filter(x => x && x.title).slice(-10);
      if (raw.learn && typeof raw.learn === 'object') for (const k in raw.learn) { const e = raw.learn[k] || {}; s.learn[k] = { up: Math.max(0, Math.floor(Number(e.up)) || 0), down: Math.max(0, Math.floor(Number(e.down)) || 0) }; }
    }
    return s;
  }
  // a new day rolls the leash budget back to full.
  function rolloverDay() { if (!state) return; const t = dayOf(now()); if (state.day !== t) { state.day = t; state.acted = 0; save(); } }
  // remaining leash actions today (caps BOTH leash and free — free runs toward goals, but within the daily leash).
  function budgetLeft() {
    if (!state) return Infinity;
    rolloverDay();
    let cap = 3;
    try { const p = deps.getPosture ? deps.getPosture() : null; if (p && Number.isFinite(p.leashPerDay)) cap = p.leashPerDay; } catch (_) {}
    return Math.max(0, cap - (state.acted || 0));
  }

  // gather the live inputs the pure engine needs (posture booleans, the readiness tier + usable dims, idleness).
  function gather() {
    const posture = (() => { try { return (deps.getPosture ? deps.getPosture() : null) || {}; } catch (_) { return {}; } })();
    const summary = (() => { try { return (deps.getDossier ? deps.getDossier() : null) || {}; } catch (_) { return {}; } })();
    const beliefs = (dim) => { try { return deps.getBeliefs ? (deps.getBeliefs(dim) || []) : []; } catch (_) { return []; } };
    const t = now();
    const rd = ready() ? Autopilot.readiness(summary, beliefs, t, {}) : { tier: 'cold', usableDims: [] };
    const idle = ready() ? Autopilot.idleFor(t, lastActivity, deps.idleMs) : false;
    return { posture, rd, idle, t };
  }

  // the pure decision over the live inputs (side-effect free — the test asserts it directly).
  function decideNow() {
    if (!ready()) return { go: false, mode: 'none', reason: 'not-ready', binding: null };
    const g = gather();
    return Autopilot.decide({
      enabled: !!g.posture.enabled,
      actsUnattended: !!g.posture.actsUnattended,
      idle: g.idle,
      tier: g.rd.tier,
      budgetLeft: budgetLeft()
    });
  }

  // NS-1: is the SERVER-owned night-shift driver active (and thus owning the ACT branch)? Returns the cached flag
  // and kicks a lazy, throttled refresh (GET /api/nightshift/status). Node/test + no-fetch envs read null forever
  // (never defer — the old local behavior is preserved for the pure test). A refresh failure leaves the last known
  // value. This is the one seam that prevents the frontend and the sidecar from BOTH acting on the same idle window.
  function refreshServerActs() {
    if (typeof fetch !== 'function') return;
    const t = now();
    if (t - statusChecked < 30000) return;   // at most every 30s
    statusChecked = t;
    try { fetch('/api/nightshift/status').then(r => r.ok ? r.json() : null).then(j => { if (j && typeof j.active === 'boolean') serverActs = j.active; }).catch(() => {}); } catch (_) {}
  }

  // ONE autopilot beat per idle episode. Re-arms when the Commander next interacts (noteActivity).
  function tick() {
    if (!ready() || armed || acting) return null;
    refreshServerActs();
    const d = decideNow();
    if (!d.go) return d;
    // NS-1: when the sidecar night-shift driver is ACTIVE, the ACT branch is its job (restart-safe, leash-enforced)
    // — this frontend loop DEFERS: it does not act, and it does NOT spend the idle episode's beat (so EARN can still
    // fire this episode if the decision later resolves to earn). EARN (curiosity while present) stays local.
    if (d.mode === 'act' && serverActs === true) return { go: false, mode: 'deferred', reason: 'server-owns-act', binding: d.binding };
    armed = true;   // spend this idle episode's single beat (re-armed by activity)
    if (d.mode === 'act') { act(); }   // async, fire-and-forget; `acting` guards overlap
    else { earn(); }
    return d;
  }

  // the EARN branch (A1): hand off to the chat curiosity nudge (picks a still-blank dim, shows the gentle ask,
  // shares the per-session anti-nag cap — so it can never stack with or double-ask the post-run nudge).
  function earn() { try { if (typeof deps.offerCuriosity === 'function') deps.offerCuriosity(); } catch (_) {} }

  // build the { dim:[texts] } grounding map the directives want, from the injected belief accessor.
  function beliefMap() {
    const out = {};
    for (const k of ['goals', 'pain', 'ambition', 'stack', 'standing_orders', 'style', 'people', 'schedule']) {
      try { const arr = (deps.getBeliefs ? (deps.getBeliefs(k) || []) : []).map(b => b && b.text).filter(Boolean); if (arr.length) out[k] = arr; } catch (_) {}
    }
    return out;
  }

  // THE LEARN HOOK (A3): the Commander's per-draft useful/not feedback, tallied per archetype. learnWeights() turns
  // it into a small selection bias (capped below a confidence step) so scoreAndSelect gets better at picking FOR
  // THIS Commander over time — the compounding, uncopyable moat. Wired now; the weighting stays deliberately gentle.
  function rate(archetype, useful) {
    if (!state || !archetype) return;
    state.learn = state.learn || {};
    const e = state.learn[archetype] = state.learn[archetype] || { up: 0, down: 0 };
    if (useful) e.up++; else e.down++;
    save();
  }
  function learnWeights() {
    const w = {}; const L = (state && state.learn) || {};
    for (const k in L) { const e = L[k] || {}; const net = (e.up || 0) - (e.down || 0); w[k] = Math.max(-0.5, Math.min(0.5, net * 0.25)); }
    return w;
  }

  // record a delivered draft: consume one leash unit + append to the capped draft log (the A3 digest reads these).
  function recordDraft(sel, deliverable, wrote) {
    rolloverDay();
    state.acted = (state.acted || 0) + 1;
    state.drafts = state.drafts || [];
    const entry = { title: deliverable.title, archetype: sel.archetype, at: now(), body: String(deliverable.body || '').slice(0, 4000) };
    if (wrote && wrote.path) entry.wrote = { path: String(wrote.path), snapshot: wrote.snapshot || null };   // B2: a real file landed (digest ✎ marker + B3 undo)
    state.drafts.push(entry);
    if (state.drafts.length > 10) state.drafts = state.drafts.slice(-10);
    save();
  }

  // THE ACT BRANCH (A2): two SILENT reason-only runs (no tools, internal — safe + uncounted) through the pure
  // anti-slop pipeline, then leave the draft on the desk. Awaitable for the test. Stands down honestly (no draft,
  // no leash spent) when nothing grounds out or nothing clears the confidence gate — idle-doing-nothing beats slop.
  async function act() {
    if (acting || !ready() || typeof deps.chat !== 'function') return { delivered: false, reason: 'unavailable' };
    acting = true;
    try {
      const g = gather();
      const eligible = Autopilot.eligibleArchetypes(g.rd.usableDims);
      if (!eligible.length) return { delivered: false, reason: 'no-archetype' };
      const beliefs = beliefMap();
      const system = (() => { try { return deps.getSystem ? deps.getSystem() : ''; } catch (_) { return ''; } })();
      const name = (() => { try { return deps.getName ? deps.getName() : 'AGENT'; } catch (_) { return 'AGENT'; } })();

      // 1) PROPOSE — a few grounded, achievable-now candidates (silent reasoning).
      const cRes = await deps.chat({ system, messages: [{ role: 'user', content: Autopilot.buildCandidateDirective({ beliefs, eligible }) }], agentId: 'agent', isTask: false, placed: [], internal: true });
      const candidates = (cRes && !cRes.error) ? Autopilot.parseCandidates(cRes.text, { eligible, beliefs }) : [];
      // 2) SELECT — score-and-pick-best (+ the per-user LEARN bias) + the confidence gate.
      const sel = Autopilot.scoreAndSelect(candidates, { weights: learnWeights() });
      if (!sel.selected) return { delivered: false, reason: sel.reason };

      // 3) DO — produce the finished draft (silent reasoning).
      const dRes = await deps.chat({ system, messages: [{ role: 'user', content: Autopilot.buildDoDirective(sel.selected, { name }) }], agentId: 'agent', isTask: false, placed: [], internal: true, keepEffort: true });   // the draft IS work: the Commander's effort, not the aux effort
      let deliverable = (dRes && !dRes.error) ? Autopilot.parseDeliverable(dRes.text, { fallbackTitle: sel.selected.title }) : null;
      if (!deliverable) return { delivered: false, reason: 'no-deliverable' };

      // 3b) SELF-CRITIQUE — review the draft against the spec + their style/orders before it hits the desk
      // ("verify before done", turned inward). It can drop its own work (not worth their time) or ship a revision.
      const style = (beliefs.style || []).join('; ');
      const standingOrders = (beliefs.standing_orders || []).join('; ');
      const qRes = await deps.chat({ system, messages: [{ role: 'user', content: Autopilot.buildCritiqueDirective(deliverable, sel.selected, { style, standingOrders }) }], agentId: 'agent', isTask: false, placed: [], internal: true, keepEffort: true });
      const crit = (qRes && !qRes.error) ? Autopilot.parseCritique(qRes.text, { fallbackTitle: deliverable.title }) : { verdict: 'ship', note: '' };
      if (crit.verdict === 'drop') return { delivered: false, reason: 'self-rejected' };
      if (crit.verdict === 'revise' && crit.revised) deliverable = crit.revised;

      // 4) WRITE (B2) — if the Commander GRANTED cabinet:write AND placed a cabinet (object=capability), persist the
      // finished, self-critiqued deliverable as a REAL local file (server-side: consent-gated + jailed +
      // checkpointed/reversible). Otherwise it stays a desk draft (Stage A). The write never sends/publishes/spends.
      let wrote = null;
      try {
        const granted = (typeof deps.canWriteFiles === 'function') ? !!deps.canWriteFiles() : false;
        const cabinet = (typeof deps.hasCabinet === 'function') ? !!deps.hasCabinet() : false;
        if (Autopilot.canWrite({ granted: granted, cabinetPlaced: cabinet }) && typeof deps.writeFile === 'function') {
          const rel = Autopilot.writePath(deliverable.title);
          const wr = await deps.writeFile({ path: rel, content: Autopilot.fileBody(deliverable) });
          if (wr && wr.ok) wrote = { path: wr.path || rel, snapshot: wr.snapshot || null };
        }
      } catch (_) {}

      // 5) DELIVER — record (leash + draft log, incl. the write outcome) and surface to the desk.
      recordDraft(sel.selected, deliverable, wrote);
      try { if (typeof deps.present === 'function') deps.present({ title: deliverable.title, body: deliverable.body, archetype: sel.selected.archetype, grounds: sel.selected.grounds, note: crit.note, wrote: wrote }); } catch (_) {}
      return { delivered: true, title: deliverable.title, archetype: sel.selected.archetype, verdict: crit.verdict, wrote: !!wrote };
    } catch (_) {
      return { delivered: false, reason: 'error' };
    } finally {
      acting = false;
    }
  }

  // NS-1: the throttled PRESENCE beacon. A watching-but-not-running-a-task Commander still stamps the server-owned
  // away-clock (POST /api/activity) so the night-shift driver doesn't mistake "reading" for "gone". Throttled to
  // ≥60s between beacons (interactions fire far more often than that). Guarded for node/test (no fetch → no-op).
  function beacon() {
    if (typeof fetch !== 'function') return;
    const t = now();
    if (t - lastBeacon < 60000) return;
    lastBeacon = t;
    try { fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}); } catch (_) {}
  }

  // the Commander interacted — reset the idle clock, re-arm the next idle beat, and (if they were really away and
  // the autopilot worked) show the welcome-back digest.
  function noteActivity() {
    const prev = lastActivity;
    lastActivity = now();
    armed = false;
    beacon();   // NS-1: tell the sidecar the Commander is PRESENT (throttled) so the server-owned away-clock is truthful
    // GENUINE-RETURN HOOK (2026-07-14): fires on the first interaction after a real absence REGARDLESS of
    // the local draft log — the server-owned night-shift act path leaves NO local draft, so the digest
    // below is structurally blind to it. app.js uses this to re-offer undecided workshop deliverables
    // that landed (and were announced to an empty room) while the Commander was away.
    const thr = Number.isFinite(deps.digestAwayMs) ? deps.digestAwayMs : 300000;
    if (Number.isFinite(prev) && (lastActivity - prev) >= thr) {
      try { if (typeof deps.onReturn === 'function') deps.onReturn({ awaySince: prev, backAt: lastActivity, awayMs: lastActivity - prev }); } catch (_) {}
    }
    maybeDigest(prev, lastActivity);
  }
  // WELCOME-BACK DIGEST: on the first interaction after a real absence, recap the drafts the autopilot left while
  // they were away — composed PURELY from the draft log (no new events; legibility law upheld). Fires once per
  // return (the next noteActivity has a near-zero gap), gated on a minimum away span so a brief glance never triggers it.
  function maybeDigest(awaySince, backAt) {
    if (!state || !ready() || typeof deps.digest !== 'function') return;
    const thr = Number.isFinite(deps.digestAwayMs) ? deps.digestAwayMs : 300000;   // ~5 min "actually away"
    if (!(Number.isFinite(awaySince) && (backAt - awaySince) >= thr)) return;
    const fresh = (state.drafts || []).filter(d => d && Number(d.at) > awaySince);
    if (!fresh.length) return;
    try { deps.digest({ awayMs: backAt - awaySince, drafts: fresh, lines: Autopilot.digestLines(fresh) }); } catch (_) {}
  }

  // install the edge ONCE: stamp activity on real input, and re-check idleness on an interval. Guarded so a
  // resume/re-enter never double-installs, and skipped under node (no document/setInterval) + when install:false.
  function install() {
    if (installed) return;
    installed = true;
    if (typeof document !== 'undefined' && document.addEventListener) {
      const mark = () => noteActivity();
      document.addEventListener('pointerdown', mark, true);
      document.addEventListener('keydown', mark, true);
    }
    if (typeof setInterval === 'function') {
      const every = Number.isFinite(deps.tickMs) ? deps.tickMs : (ready() ? Autopilot.DEFAULT_TICK_MS : 20000);
      timer = setInterval(() => { try { tick(); } catch (_) {} }, every);
    }
  }

  // opts: { now(), getPosture(), getDossier(), getBeliefs(dim), getSystem(), getName(), offerCuriosity(), chat(opts),
  //         present(draft), digest(info), onReturn(info), digestAwayMs, idleMs, tickMs, install:bool }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    lastActivity = now();   // a freshly-entered station starts ACTIVE (no instant idle fire on load)
    armed = false; acting = false;
    if (!deps || deps.install !== false) install();
  }

  // a brand-new hero starts clean: drop the own key + the in-memory idle state.
  function reset() { state = hydrate(null); lastActivity = now(); armed = false; acting = false; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, tick, act, noteActivity, decideNow, reset, rate, _state: () => ({ lastActivity, armed, acting, installed }), _draftState: () => state };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { AutopilotStore };
