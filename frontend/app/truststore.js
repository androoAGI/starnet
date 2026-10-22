/* AGENT OS — truststore.js : the live wiring around the pure EARNED-AUTONOMY engine (trust.js) — Growth Tier 3.

   Where xpstore.js folds real run outcomes into DESCRIPTIVE meters (level/confidence), this store folds the SAME
   events into a track record that, once earned, MINTS a consent-gated OFFER to raise the autonomy dial — and,
   on a sustained bad streak, DEMOTES the earned rung back. It is the mechanical teeth Growth Tier 3 gives to
   level + confidence, always through the Commander's tap (never a silent escalation).

   Discipline mirrors studystore.js / autonomystore.js:
   - READ-ONLY citizen of U.bus — subscribes to the SAME feed xpstore folds (agent.run.end + memory.feedback) but
     NEVER emits (the frozen shared/events.js contract is owned elsewhere; the schema emitter silently drops
     unknown events anyway — so applying an offer is a DIRECT store call, exactly like xpstore's celebrations).
   - Self-persists its OWN localStorage key (starnet.trust.v1): the folded track record, the EARNED rung records
     with provenance, the declined/ignored negative state, all FIFO-capped + sanitized on hydrate.
   - node-exportable for its test; all DECISION logic lives in the pure Trust engine — this is the edge.

   THE OFFER lands as a beat card (chat.js, priority AFTER arc). Accept → apply + record provenance; Decline or
   ignore-2× → the memory-overhaul negative-state rules (a refused rung stops offering in that level band). The
   DOM half (the trust beat card + sharing chat.js's one post-run beat slot) lives in chat.js, which calls this
   store for the gate + the consent side-effects. */
'use strict';
const TrustStore = (() => {
  const KEY = 'starnet.trust.v1';
  const IGNORE_LIMIT = 2;        // ignore an offered rung this many times → stop offering it in this level band (stop-forever, per band)
  const SESSION_OFFER_CAP = 1;   // at most ONE trust offer shown per session (anti-nag; rung offers are rare by construction)
  const MAP_CAP = 40;            // FIFO cap for every persisted keyed map (declined / ignores / earned.grant) — rungs
                                 // and grantable keys are few by construction, so 40 is generous headroom, never growth

  let state = null;              // persisted: { v, track (trust.fold state), earned:{initiative:{to,floor,provenance}}, declined:{'kind:to':band}, ignores:{'kind:to':n} }
  let sessionShown = 0;          // trust offers shown THIS session (in-memory; resets each app run)
  let deps = {};                 // { now, getStats, getPosture, setInitiative, grantable, getGrants, grant, notify } — all optional; fail-open
  let wired = false;

  const ready = () => typeof Trust !== 'undefined' && state;
  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  // tolerant hydrate: the folded track goes through the engine's sanitize; earned/declined/ignores are clamped so
  // a corrupt/old key degrades to a clean, un-earned record — never throws, never yields an out-of-enum rung.
  function hydrate(raw) {
    const s = { v: 1, track: (typeof Trust !== 'undefined' ? Trust.fresh() : {}), earned: {}, declined: {}, ignores: {} };
    if (raw && typeof raw === 'object') {
      if (typeof Trust !== 'undefined') s.track = Trust.sanitize(raw.track);
      const INIT = (typeof Trust !== 'undefined' ? Trust.INITIATIVE : ['wait', 'propose', 'leash', 'free']);
      // the EARNED initiative record: the rung we raised (to), the manual floor to never demote below, provenance.
      const e = raw.earned && raw.earned.initiative;
      if (e && INIT.indexOf(e.to) >= 0 && INIT.indexOf(e.floor) >= 0) {
        s.earned.initiative = {
          to: e.to, floor: e.floor,
          provenance: (e.provenance && typeof e.provenance === 'object') ? sanitizeProv(e.provenance) : null
        };
      }
      // the EARNED grant records (provenance for the ledger badge): keep only well-formed rows in a PLAIN object
      // (an array would pass a bare typeof check via its indices), FIFO-capped like every persisted map here.
      const eg = raw.earned && raw.earned.grant;
      if (eg && typeof eg === 'object' && !Array.isArray(eg)) {
        for (const k of Object.keys(eg).slice(-MAP_CAP)) {
          const g = eg[k];
          if (!g || typeof g !== 'object' || Array.isArray(g)) continue;
          if (!s.earned.grant) s.earned.grant = {};
          s.earned.grant[k] = { provenance: (g.provenance && typeof g.provenance === 'object') ? sanitizeProv(g.provenance) : null, earnedAt: (typeof g.earnedAt === 'number' && isFinite(g.earnedAt)) ? g.earnedAt : null };
        }
      }
      if (raw.declined && typeof raw.declined === 'object' && !Array.isArray(raw.declined)) {
        for (const k of Object.keys(raw.declined).slice(-MAP_CAP)) { const b = Math.floor(Number(raw.declined[k])); if (Number.isFinite(b) && b > 0) s.declined[k] = b; }
      }
      // ignore tallies are { band, n } records (band-scoped stop-forever) — keep only well-formed ones, capped.
      if (raw.ignores && typeof raw.ignores === 'object' && !Array.isArray(raw.ignores)) {
        for (const k of Object.keys(raw.ignores).slice(-MAP_CAP)) {
          const ig = raw.ignores[k];
          if (!ig || typeof ig !== 'object' || Array.isArray(ig)) continue;
          const band = Math.floor(Number(ig.band)), n = Math.floor(Number(ig.n));
          if (Number.isFinite(band) && band > 0 && Number.isFinite(n) && n > 0) s.ignores[k] = { band: band, n: n };
        }
      }
    }
    return s;
  }
  // FIFO-cap a persisted keyed map in place (string-key insertion order is spec-preserved): drop the oldest rows.
  function capMap(m) { const ks = Object.keys(m); while (ks.length > MAP_CAP) delete m[ks.shift()]; }
  // provenance is DATA the dial renders — keep only well-formed numeric fields (never a secret; the offer's `why`
  // is composed from task counts + %, never from any run content). Belt-and-suspenders against a hand-edited save.
  function sanitizeProv(p) {
    const n = (v) => (typeof v === 'number' && isFinite(v)) ? v : 0;
    return { earnedAt: (typeof p.earnedAt === 'number' && isFinite(p.earnedAt)) ? p.earnedAt : null, runs: Math.max(0, Math.floor(n(p.runs))), confidence: Math.max(0, Math.min(100, Math.round(n(p.confidence)))), streak: Math.max(0, Math.floor(n(p.streak))) };
  }

  // the live XP snapshot the engine reads (level/confidence/tasksDone/samples). Fail-open to a fresh-ish shape.
  function xp() { try { return (typeof deps.getStats === 'function') ? (deps.getStats() || {}) : {}; } catch (_) { return {}; } }
  // the live posture summary (initiative rung + the reach ceiling). Fail-open.
  function posture() { try { return (typeof deps.getPosture === 'function') ? (deps.getPosture() || {}) : {}; } catch (_) { return {}; } }
  function grantsHeld() { try { return (typeof deps.getGrants === 'function') ? (deps.getGrants() || []) : []; } catch (_) { return []; } }

  // ---- the one transform: fold a real event into the persisted track (pure engine). Also runs a DEMOTION check
  // on every fold (a bad streak / confidence collapse must retire an earned rung promptly, never at offer time). ----
  function onEvent(name, payload) {
    if (!ready()) return;
    state.track = Trust.fold(state.track, { name: name, payload: payload || {} });
    // DEMOTION is bidirectional + prompt: check it on the same feed. Only an earned rung can demote, never below floor.
    maybeDemote();
    if (name === 'agent.run.end' || name === 'memory.feedback') save();
  }

  // apply a demotion the moment the engine sees a bad-enough streak. Lowers ONLY the earned rung (never the
  // Commander's manual floor), records the new earned floor (or clears it), and surfaces an EXPLICIT notice.
  let demotionPending = false;
  function applyInitiative(to, confirmed) {
    let result;
    try { if (typeof deps.setInitiative !== 'function') return false; result = deps.setInitiative(to); } catch (_) { return false; }
    const finish = value => {
      if (value === false || (value && value.ok === false) || posture().initiative !== to) return false;
      confirmed(); return true;
    };
    return result && typeof result.then === 'function' ? result.then(finish).catch(() => false) : finish(result);
  }
  function maybeDemote() {
    if (demotionPending) return;
    if (!ready() || !state.earned.initiative) return;
    // STALENESS GUARD (review blocker): the earned record is only actionable while the LIVE dial rung still IS the
    // earned rung. A non-dial writer (settings-backup import, permissions-level preset) can move the posture without
    // passing onManualInitiative — demoting from a stale record could then RAISE the dial (stale-high: earned 'free'
    // over a posture already at 'wait' would setInitiative('leash') — a silent two-rung escalation dressed as a
    // step-back) or slash a rung the user deliberately raised (stale-low). Divergence = the user override wins:
    // retire the record, touch nothing, say nothing (the same rule the dial's onManualInitiative applies).
    const live = (posture().initiative) || 'wait';
    if (live !== state.earned.initiative.to) { delete state.earned.initiative; save(); return; }
    const res = Trust.demote(state.track, { earned: state.earned, xp: xp() });
    if (!res || !res.demote) return;
    const d = res.demote;
    // apply to the dial FIRST, through the SAME writer the panel uses (no parallel plumbing) — and only mutate the
    // record + notify if the write actually landed (a thrown/missing writer must not strand a lying earned record).
    const record = state.earned.initiative;
    const result = applyInitiative(d.to, () => {
    if (state.earned.initiative !== record) return;
    // update / clear the earned record: if we've stepped back to the manual floor, the rung is no longer "earned".
    if (d.to === state.earned.initiative.floor) delete state.earned.initiative;
    else state.earned.initiative = { to: d.to, floor: state.earned.initiative.floor, provenance: state.earned.initiative.provenance };
    save();
    try { if (typeof deps.notify === 'function') deps.notify('◈ ' + d.why, 'warn'); } catch (_) {}
    });
    if (result && typeof result.then === 'function') { demotionPending = true; result.finally(() => { demotionPending = false; }); }
  }

  // the event's agent, exactly as xpstore reads it (eventAgentId: typed + trimmed, '' → 'agent') so the two
  // stores count the SAME events — a payload with a non-string / padded agentId folds identically in both.
  function eventAgentId(payload) {
    const id = payload && typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    return id || 'agent';
  }

  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0;
    if (!wired && typeof U !== 'undefined' && U.bus) {
      for (const n of ['agent.run.end', 'memory.feedback']) U.bus.on(n, p => { try { if (eventAgentId(p) === 'agent') onEvent(n, p); } catch (e) { /* fail-open */ } });
      wired = true;
    }
  }
  // a brand-new hero starts with a clean, un-earned track record (mirrors the other stores' reset on commission).
  function reset() { state = hydrate(null); sessionShown = 0; try { localStorage.removeItem(KEY); } catch (_) {} }

  // ---- the gate the chat beat consults ----
  function canShow() { return !!state && sessionShown < SESSION_OFFER_CAP; }
  // count one shown offer against the session cap (the caller calls this when it actually renders the card).
  function markShown() { sessionShown++; }

  // is this exact rung offer exhausted (declined in this band, or ignored to the stop-forever limit in this band)?
  function isExhausted(kind, to) {
    if (!ready()) return true;
    const snap = Trust.xpSnapshot(xp());
    if (Trust.isRungDeclined(state.declined, kind, to, snap.level)) return true;
    const key = kind + ':' + to;
    // ignore tally is band-scoped: it only stops the offer while we're still in the band it was ignored at.
    const ig = state.ignores[key];
    if (ig && ig.band != null && Trust.bandOf(snap.level) <= Trust.bandOf(ig.band) && (ig.n || 0) >= IGNORE_LIMIT) return true;
    return false;
  }

  // compute the current live offer (or null). The engine reads xp + posture + grantable + the persisted negative
  // state; the store supplies the hard ceiling: INITIATIVE never past the DIAL's reach-independent cap ('free'),
  // and REACH is NEVER offered (the store never proposes reach — grants are the only non-initiative offer).
  function currentOffer() {
    if (!ready()) return null;
    const p = posture();
    const res = Trust.assess(state.track, {
      xp: xp(),
      currentInitiative: p.initiative || 'wait',
      ceilingInitiative: 'free',                         // hard cap: never offer past free-range initiative; reach is out of scope
      grants: grantsHeld(),
      grantable: Array.isArray(deps.grantable) ? deps.grantable : [],
      declined: state.declined,
      earnedAt: now()
    });
    const offer = res && res.offer;
    if (!offer) return null;
    if (isExhausted(offer.kind, offer.to)) return null;   // declined / ignored-out in this band
    return offer;
  }

  // ---- consent verdicts (called by the chat trust card) ----
  // ACCEPT: apply the earned rung THROUGH the existing plumbing (AutonomyStore.setInitiative for initiative;
  // PermissionsStore.grant for a grant — never a parallel path), record provenance, and (initiative) remember the
  // manual FLOOR we raised from so a later demotion can never step below the Commander's own setting.
  // RETURN SHAPE: boolean for initiative (a sync dial write); a Promise<boolean> for a grant — the server grant is
  // async and can FAIL while resolving (PermissionsStore.grant swallows errors and always resolves), so success is
  // only claimed after re-reading the authoritative held-grants state and finding the key actually blessed
  // (review fix 2 — never a "✓ granted" on a grant that didn't land). Callers wrap in Promise.resolve().
  function accept(offer) {
    if (!ready() || !offer) return false;
    if (offer.kind === 'initiative') {
      const from = (posture().initiative) || 'wait';    // the Commander's current (manual) rung = the demotion floor
      return applyInitiative(offer.to, () => {
        // if a lower rung was already earned, keep the ORIGINAL manual floor (don't move the floor up to an earned rung).
        const prevFloor = (state.earned.initiative && state.earned.initiative.floor) || from;
        state.earned.initiative = { to: offer.to, floor: prevFloor, provenance: offer.provenance || null };
        save();
      });
    }
    if (offer.kind === 'grant') {
      let p;
      try { p = (typeof deps.grant === 'function') ? deps.grant(offer.to) : null; } catch (_) { return Promise.resolve(false); }
      if (p == null || p === false) return Promise.resolve(false);
      return Promise.resolve(p).then(() => {
        // VERIFY: the grant only "took" if the authoritative held-grants state now carries the key. A swallowed
        // server failure leaves it absent → resolve false, record nothing (the card settles its ✕ path).
        const ok = grantsHeld().indexOf(offer.to) >= 0;
        if (ok) {
          // a grant's provenance is recorded on the earned record too (for the ledger badge), but grants have no
          // "floor" to demote toward — revoking is the Commander's, and a grant demotion is out of scope this tier.
          state.earned.grant = state.earned.grant || {};
          state.earned.grant[offer.to] = { provenance: offer.provenance || null, earnedAt: now() };
          capMap(state.earned.grant);
          save();
        }
        return ok;
      }).catch(() => false);
    }
    return false;
  }

  // DECLINE: the Commander tapped "Not yet" — stop offering THIS rung in this level band for good (a NEW level
  // band re-opens it: earning a level is a fresh mandate). Mirrors the memory-overhaul "discard = never again",
  // scoped to the band so growth can re-earn the ask.
  function decline(offer) {
    if (!ready() || !offer) return;
    const snap = Trust.xpSnapshot(xp());
    state.declined[offer.kind + ':' + offer.to] = Trust.bandOf(snap.level);
    capMap(state.declined);
    save();
  }

  // IGNORE (the card expired undecided): tally it in THIS band; IGNORE_LIMIT ignores in the same band stops it
  // (stop-forever per band). A NEW band resets the tally (a fresh mandate deserves a fresh chance).
  function ignore(offer) {
    if (!ready() || !offer) return;
    const snap = Trust.xpSnapshot(xp());
    const key = offer.kind + ':' + offer.to;
    const cur = state.ignores[key];
    if (cur && cur.band != null && Trust.bandOf(snap.level) <= Trust.bandOf(cur.band)) { cur.n = (cur.n || 0) + 1; }
    else state.ignores[key] = { band: Trust.bandOf(snap.level), n: 1 };
    capMap(state.ignores);
    save();
  }

  // ---- the earned-rung read surface (for the dial UI's EARNED badge + provenance history) ----
  // is the current dial initiative rung an EARNED one (raised by an accepted offer, not a manual set)? The dial
  // uses this to show the badge only when the live rung MATCHES the earned record (a manual set above/below drops it).
  function earnedInitiative() {
    if (!ready() || !state.earned.initiative) return null;
    const live = (posture().initiative) || 'wait';
    return live === state.earned.initiative.to ? { to: state.earned.initiative.to, floor: state.earned.initiative.floor, provenance: state.earned.initiative.provenance } : null;
  }
  // the Commander manually moved the dial: reconcile the earned record. A set AT the earned rung keeps it; a set
  // ABOVE it (a user grant beyond what was earned) or BELOW it (a user override) RETIRES the earned record — the
  // manual setting wins and is recorded as such (no badge on a user-set rung). Called by the dial's setInitiative.
  function onManualInitiative(level) {
    if (!ready() || !state.earned.initiative) return;
    if (level !== state.earned.initiative.to) { delete state.earned.initiative; save(); }
  }
  // provenance of any earned grant (for the standing-approval ledger badge). Returns { provenance, earnedAt } or null.
  function earnedGrant(key) { return (ready() && state.earned.grant && state.earned.grant[key]) ? state.earned.grant[key] : null; }

  return {
    init, reset, canShow, markShown, isExhausted, currentOffer, accept, decline, ignore,
    earnedInitiative, onManualInitiative, earnedGrant,
    IGNORE_LIMIT, SESSION_OFFER_CAP,
    _state: () => state
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { TrustStore };
