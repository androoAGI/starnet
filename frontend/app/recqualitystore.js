/* AGENT OS — recqualitystore.js : THE OUTCOME LOOP (the live half of the recommendation quality loop).

   The spine picks the best-grounded offer it can cite. This store answers the question nobody was asking before
   it existed: DID THAT OFFER ACTUALLY HELP? A channel whose accepted offers produce work the Commander rates 👎
   — or work that never finishes — gets structurally quieter. A channel whose offers produce 👍 work earns a
   small, bounded edge. Nobody hand-tunes anything; the same earned-trust philosophy the autonomy dial already
   uses, applied to the station's own suggestions.

   HOW AN OUTCOME IS ATTRIBUTED (and why it can't be faked):
     1. The Commander ACCEPTS an offer, AND the launch that accept triggers really starts. Only then does the
        channel arm a PENDING stamp ({ channel, dim, id, at }) — an accept whose launch no-opped (a busy stream)
        arms nothing, because there is no work to attribute. It is not silent either: the caller settles that
        refusal as `deferred` on the spot (right idea, wrong moment) and tells the Commander why.
     2. The very next hero run START claims it (chat.js, at the same point it writes RUN_META) — so the stamp is
        visible on the run's own meta, and the run is the provable link between "the offer" and "the work". The
        stamp EXPIRES after PENDING_TTL_MS: past that window the next run is not this offer's work, and saying it
        was would be the app asserting a causal link the harness cannot prove.
     3. The run's real outcome folds back: a clean finish is a weak positive; the Commander's own 👍/👌/👎 on that
        run (the direct rateWork hand-off, never the bus) is the strong one.
     Where an accept spawns NO trackable work (a kept belief, an answered question, a re-confirm), the accept
     itself IS the outcome — a small positive, recorded once.

   TRUTHFUL TELEMETRY, the version that matters here:
     · Weights start NEUTRAL and move ONLY on outcomes the harness can actually name and attribute. A run that
       ended in a stop / an error / a budget limit folds NOTHING — the station cannot honestly blame the offer
       for that, so it says nothing about it.
     · The floor (recquality.js Q_FLOOR ≥ 0.5) means quality alone can never silence a channel. Silencing is the
       job of the per-channel caps and the Commander's own declines — never of a number the station computed.
     · Nothing user-facing ever asserts a quality score. It orders offers; it does not narrate them.
     · TWO CHANNELS ARE EXEMPT BY DESIGN and record no outcomes: `memory` (the run's own reflection deck) and
       `rate` (the rating of work just done). Neither is a suggestion the station CHOSE to make — the run earns
       them — which is the same reason recommend.js exempts both from the session ask budget. They sit permanently
       neutral, and that is correct: there is no "was this offer worth making?" to answer about them. Every
       channel that DOES choose to interrupt records both directions (accept and decline), so no recording
       channel can drift down merely for being measured.

   Discipline mirrors curiositystore / suggeststore: a READ-ONLY citizen of the event spine (subscribes to
   agent.run.end, NEVER emits — the frozen shared/events.js contract is owned elsewhere), self-persists its own
   key (no save.js change), node-exportable for its test. The pure arithmetic lives in recquality.js. */
'use strict';
const RecQualityStore = (() => {
  const KEY = 'starnet.recquality.v1';
  const STAMP_CAP = 60;      // in-memory run→stamp memory, FIFO, mirroring chat.js's RUN_META ledger size
  const DENY_CAP = 100;      // re-confirm denial memory (FIFO) — bounded exactly like goalstore's offered set
  /* HOW LONG AN ARMED ACCEPT MAY WAIT FOR ITS RUN. The accept→run link is only honest while the two are the same
     moment: a "build it" whose launch is slow is still this offer's work; a stamp still sitting there minutes
     later belongs to nothing the offer caused, and the Commander's next unrelated run must NOT inherit it. */
  const PENDING_TTL_MS = 3 * 60 * 1000;
  let state = null;          // { v:1, ch:{ channel: weight }, dim:{ dim: weight }, denied:{ fp:1 }, deniedOrder:[fp] }
  let deps = {};
  let pending = null;        // { channel, dim, id, at } — an accept waiting for the run it spawns to start
  let stamps = new Map();    // runId → { channel, dim, id }  (in-memory: a reload honestly forgets, like RUN_META)
  let settled = new Set();   // runIds whose COMPLETION has already folded (a run completes once)
  let bound = false;

  const engine = () => (typeof RecQuality !== 'undefined' && RecQuality && RecQuality.fold) ? RecQuality : null;
  const ready = () => !!(state && engine());
  /* THE OUTCOME FORWARD (dead-wires lane, 2026-08-28). This store was the ONLY place that ever learned what an
     accepted spine offer's work actually produced — and it kept that knowledge in localStorage, so the durable
     ledger's replay() quality term was structurally zero for surface `spine` and the whole earned record died
     with the browser profile. Each attributed outcome is now ALSO handed to RecLedger.settle(), which owns the
     translation into ledger vocabulary (and refuses what the ledger has no place for). Forwarded from the
     specific attribution sites below — never from the generic fold — so a channel's unrelated card verdicts can
     never touch a previous accept's awaiting row. Injectable for the node test (deps.recLedger; pass null to
     silence), global RecLedger by default in the browser so there is no wiring step to forget. Fail-open. */
  function forward(channel, outcome, runId) {
    try {
      const rl = (deps && deps.recLedger !== undefined) ? deps.recLedger : (typeof RecLedger !== 'undefined' ? RecLedger : null);
      if (rl && rl.settle) rl.settle(channel, outcome, runId);
    } catch (_) {}
  }
  // the INJECTED clock (deps.now), exactly like the sibling growth stores — so the node test can fast-forward the
  // pending stamp's expiry instead of sleeping through it. Falls back to the wall clock in the browser.
  function nowMs() { const n = deps && typeof deps.now === 'function' ? Number(deps.now()) : NaN; return Number.isFinite(n) ? n : Date.now(); }

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  function hydrate(raw) {
    const s = { v: 1, ch: {}, dim: {}, denied: {}, deniedOrder: [] };
    const rq = engine();
    for (const bag of ['ch', 'dim']) {
      const src = raw && raw[bag];
      if (!src || typeof src !== 'object') continue;
      for (const k of Object.keys(src)) {
        const n = Number(src[k]);
        if (!Number.isFinite(n)) continue;                       // a corrupted entry is DROPPED, never guessed
        const w = rq ? rq.clampQuality(n) : n;
        if (w !== (rq ? rq.Q_START : 1)) s[bag][String(k).slice(0, 40)] = w;   // neutral needs no storage
      }
    }
    // the re-confirm denials, rebuilt from their FIFO order (bounded, like goalstore's offered set).
    const order = raw && Array.isArray(raw.deniedOrder) ? raw.deniedOrder
      : (raw && raw.denied && typeof raw.denied === 'object') ? Object.keys(raw.denied) : [];
    for (const fp of order.slice(-DENY_CAP)) {
      const k = String(fp || '').slice(0, 200);
      if (k && !s.denied[k]) { s.denied[k] = 1; s.deniedOrder.push(k); }
    }
    return s;
  }

  /* ── THE RE-CONFIRM DENIAL SET (Q3) ─────────────────────────────────────────────────────────────────────
     "Still true that X?" — answered NO. That question must never be asked again until the belief itself
     CHANGES, which is exactly what the fingerprint encodes (recquality.js beliefFingerprint: the dimension +
     the belief id + its significant tokens). Same discipline, and the same bounded FIFO, as goalstore.js's
     offered set. It is a memory of a QUESTION already answered — never a record of the belief itself. */
  function denyBelief(fp) {
    const k = String(fp || '').slice(0, 200);
    if (!ready() || !k || state.denied[k]) return false;
    state.denied[k] = 1; state.deniedOrder.push(k);
    while (state.deniedOrder.length > DENY_CAP) { const old = state.deniedOrder.shift(); delete state.denied[old]; }
    save();
    return true;
  }
  function isBeliefDenied(fp) {
    const k = String(fp || '');
    return !!(ready() && k && state.denied[k]);
  }

  /* ---------- the read the spine scores against ---------- */
  /* the quality multiplier for a candidate. Absent module / absent store / never-rated channel → NEUTRAL (the
     engine's Q_START), so a cold station ranks exactly as the pre-quality spine did.
     THE DIMENSION BAG IS SHARED, AND IT IS WEIGHTED ACCORDINGLY (2026-08-04). Several channels target the same
     dimension, so a dimension's weight carries other channels' outcomes into this one — that sharing is
     deliberate (a dimension nobody wants to be asked about should quieten every ask aimed at it) but it is not
     evidence about THIS channel, and a 50/50 average let one channel's declines drag an unrelated one down by
     half. Now the channel's own record is the reading (0.75) and the shared dimension only tilts it (0.25).
     A channel with no record of its own still reads its dimension alone — that is the only signal there is. */
  const DIM_SHARE = 0.25;
  function weightFor(channel, dim) {
    const rq = engine();
    const neutral = rq ? rq.Q_START : 1;
    if (!ready()) return neutral;
    const c = state.ch[String(channel || '')];
    const d = dim ? state.dim[String(dim)] : undefined;
    const hasC = Number.isFinite(c), hasD = Number.isFinite(d);
    if (!hasC && !hasD) return neutral;
    if (!hasD) return rq.clampQuality(c);
    if (!hasC) return rq.clampQuality(d);
    return rq.clampQuality(c * (1 - DIM_SHARE) + d * DIM_SHARE);
  }

  /* ---------- folding a real outcome ---------- */
  // fold ONE named outcome onto a channel (and the dimension it targeted, when it targeted one). Unknown verdicts
  // and unknown channels move nothing — the loop only ever records what it can name.
  function noteOutcome(stamp, verdict) {
    if (!ready() || !stamp) return null;
    const rq = engine();
    if (!rq.isOutcome(verdict)) return null;
    const channel = String(stamp.channel || '').slice(0, 40);
    if (!channel) return null;
    state.ch[channel] = rq.fold(Number.isFinite(state.ch[channel]) ? state.ch[channel] : rq.Q_START, verdict);
    const dim = stamp.dim ? String(stamp.dim).slice(0, 40) : '';
    if (dim) state.dim[dim] = rq.fold(Number.isFinite(state.dim[dim]) ? state.dim[dim] : rq.Q_START, verdict);
    save();
    return state.ch[channel];
  }

  /* an offer was ACCEPTED.
       spawnsWork:true  → the accept launches a run; arm the pending stamp and wait for the REAL outcome. Nothing
                          is credited yet: accepting is not the same as being helped, and the whole point of this
                          loop is to stop treating a click as a result.
       spawnsWork:false → the accept IS the outcome (a kept belief, an answered question) — one small positive. */
  function noteAccept(stamp) {
    if (!ready() || !stamp || !stamp.channel) return null;
    if (stamp.spawnsWork) {
      /* A NEW ACCEPT MUST NOT SILENTLY SWALLOW THE OLD ONE. Overwriting left the first offer with no record at
         all — it was accepted, and the loop learned nothing from it. It waited for a run that never came, which
         is the same evidence a "not now" carries: right idea, wrong moment. Settle it as `deferred` and move on. */
      if (pending) { try { noteOutcome(pending, 'deferred'); } catch (_) {} if (pending) forward(pending.channel, 'deferred', ''); }
      pending = { channel: String(stamp.channel).slice(0, 40), dim: stamp.dim ? String(stamp.dim).slice(0, 40) : '', id: String(stamp.id || '').slice(0, 80), at: nowMs() };
      return pending;
    }
    return noteOutcome(stamp, 'engaged');
  }
  // an offer was refused. "not now" is a signal about TIMING (the mildest thing we record); "no"/"never" is a
  // signal about the offer itself. Both are real, both are the Commander's own words about this channel.
  function noteDecline(stamp, deferred) { return noteOutcome(stamp, deferred ? 'deferred' : 'declined'); }

  /* ---------- the attribution stamp ---------- */
  /* called by chat.js at the exact point it writes RUN_META, for every run it starts. Returns the pending stamp
     (and binds it to this run) or null. HERO ONLY: a summoned worker's run is not the work an offer to the
     Commander spawned.
     THE STAMP EXPIRES (fixed 2026-08-04). It is claimed by the first hero run WITHIN PENDING_TTL_MS of the accept,
     and by nothing after that. Without the clock the stamp simply waited — so an accept whose launch never
     happened stayed armed indefinitely and the Commander's next unrelated manual run, minutes or hours later,
     was recorded as the work that offer produced. An expired stamp settles as `deferred`: the offer was accepted
     and no work followed it, which is a real, mild signal about this channel — and it is the ONLY thing the
     harness can honestly say about it.
     EXPIRY IS LAZY, AND THAT IS THE HONEST SCOPE OF IT. Nothing runs on a timer: an armed stamp is only ever
     examined here, so it folds its `deferred` when (and only when) a LATER HERO RUN STARTS. A session where the
     Commander accepts an offer, the launch never happens, and they then start no further run records nothing —
     and `pending` is memory-only, so a reload drops it entirely. Both are deliberate: the alternative is a timer
     that writes a verdict about an offer while the Commander is away from the keyboard, on no new evidence.
     A run REFUSED at the moment of accept is a different case and is settled eagerly at the call site
     (suggeststore.js), because there the refusal is observed rather than merely un-observed. */
  function claimForRun(runId, agentId) {
    if (!ready() || !pending || !runId) return null;
    if ((agentId || 'agent') !== 'agent') return null;
    const armedAt = Number(pending.at);
    if (Number.isFinite(armedAt) && (nowMs() - armedAt) > PENDING_TTL_MS) {
      const expired = pending; pending = null;
      try { noteOutcome(expired, 'deferred'); } catch (_) {}
      forward(expired.channel, 'deferred', '');
      return null;
    }
    const stamp = { channel: pending.channel, dim: pending.dim, id: pending.id };
    pending = null;
    stamps.set(String(runId), stamp);
    while (stamps.size > STAMP_CAP) { const k = stamps.keys().next().value; stamps.delete(k); settled.delete(k); }
    return stamp;
  }
  function stampFor(runId) { return (runId && stamps.has(String(runId))) ? stamps.get(String(runId)) : null; }

  // the Commander's own 👍/👌/👎 on a run an offer spawned — the strongest honest signal in the loop. Called
  // DIRECTLY from chat.js rateWork (this verdict never rides the bus), like the sibling growth stores.
  function noteVerdict(runId, verdict) {
    const stamp = stampFor(runId);
    if (!stamp) return null;      // an unattributed run says nothing about any channel
    const v = verdict === 'great' ? 'great' : verdict === 'miss' ? 'miss' : verdict === 'ok' ? 'ok' : null;
    if (!v) return null;
    const out = noteOutcome(stamp, v);
    forward(stamp.channel, v, String(runId || ''));
    return out;
  }

  /* the run an accepted offer spawned finished. A CLEAN finish is a weak positive — the work the offer proposed
     actually got done. Anything else (stop / error / budget limit) folds NOTHING: the harness cannot honestly
     attribute an interrupted run to the quality of the suggestion that started it, so it stays quiet about it.
     A later 👍/👌/👎 on the same run folds SEPARATELY and deliberately: "it finished" and "it was any good" are
     two different pieces of evidence, and the Commander's verdict is the one that carries weight. */
  function onRunEnd(p) {
    if (!ready() || !p) return;
    const runId = String(p.runId || p.id || '');
    if (!runId || settled.has(runId)) return;
    const stamp = stampFor(runId);
    if (!stamp) return;
    if (p.reason !== 'done') return;
    settled.add(runId);
    noteOutcome(stamp, 'completed');
    forward(stamp.channel, 'completed', runId);
  }
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) { U.bus.on('agent.run.end', onRunEnd); bound = true; }
  }

  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    pending = null; stamps = new Map(); settled = new Set();
    bind();
  }
  // a brand-new hero starts with NO inherited channel history (own key; mirrors the sibling growth stores).
  function reset() { state = { v: 1, ch: {}, dim: {}, denied: {}, deniedOrder: [] }; pending = null; stamps = new Map(); settled = new Set(); try { localStorage.removeItem(KEY); } catch (_) {} }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, weightFor, noteOutcome, noteAccept, noteDecline, claimForRun, stampFor, noteVerdict, onRunEnd, denyBelief, isBeliefDenied,
    KEY, _state: () => state, _pending: () => pending, _deps: () => deps };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RecQualityStore };
