/* AGENT OS — confbeats.js : the CONFIDENCE NARRATIVE beats (Game session, Phase G3a / Layer 3+6).

   Two one-shot spoken moments in the hero's reliability arc — the meter (xp.js EWMA confidence) already
   moves honestly; these give its two threshold crossings a VOICE, once each, ever:
     • CALIBRATED — the first time confidence becomes SHOWN (Xp.MIN_SAMPLES real feedback verdicts exist,
       comp.known flips true): the agent notes it has started keeping score of itself.
     • TRUSTED — confidence first reaches 85% (the same band the TRUSTED milestone lights): one line marking
       it, pointing at the GROWTH readout where the badge lives.

   Discipline (the COMMS beat contract, cloned from the G2 fire-once digest + pitchstore's {pitched} flag):
     • FIRE-ONCE PERSISTED — each moment latches into its OWN localStorage key; a later session, a
       confidence dip below 85, or a re-climb NEVER re-fires a spoken beat. TRUSTED outranks CALIBRATED:
       if both come due on the same verdict, only the bigger moment speaks and both latch (anti-nag).
     • ONE BEAT AT A TIME — rides Chat.nudge (the shared gentle-aside family): a live run, the awakening,
       a focused panel, or an open rate/turn-in control DEFERS the beat (bounded retry, awayDigest-style);
       the nudge's own lifecycle keeps it from ever stacking with a suggestion/seed/curiosity ask.
     • NO XP, NO ASKS — a notice with a single 'noted' dismiss chip; it mints nothing and asks nothing.
     • READ-ONLY citizen of U.bus — .on()s memory.feedback (registered AFTER XpStore in app.js, so the
       meter has already folded the verdict), NEVER emits. node-exportable for its test. */
'use strict';
const ConfBeats = (() => {
  const KEY = 'starnet.confbeats.v1';
  const TRUSTED_AT = 85;      // the same band xp.js compute() calls 'trusted' + the TRUSTED milestone uses
  const RETRY_MS = 7000;      // blocked-moment retry cadence (bounded), cloned from the away-digest defer
  const SETTLE_MS = 900;      // let XpStore fold + the rate control vanish before the beat slots in
  let state = null;           // { v:1, calibrated:bool, trusted:bool } — the fire-once ledger (self-persisted)
  let deps = {};              // { getStats() } injected by app.js (the hero's live stats blob)
  let wired = false;

  const LINES = {
    calibrated: '✦ i’ve started keeping score of myself — GROWTH in my dossier shows how reliable i’ve been. three verdicts in; the number is real now.',
    trusted: '✦ my reliability crossed ' + TRUSTED_AT + '% — the station calls that TRUSTED. the badge is lit in GROWTH, in my dossier. i intend to keep it.'
  };

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  function hydrate(raw) {
    const s = { v: 1, calibrated: false, trusted: false };
    if (raw && typeof raw === 'object') { s.calibrated = !!raw.calibrated; s.trusted = !!raw.trusted; }
    return s;
  }

  // PURE decide: given the fire-once ledger + a computed meter (Xp.compute shape), which beat speaks now?
  // Nothing before calibration (comp.known honors the no-fabricated-number law). TRUSTED outranks CALIBRATED —
  // when both come due at once only the bigger moment speaks (latch() then latches both). Exported for the test.
  function decide(s, comp) {
    if (!s || !comp || !comp.known) return null;
    if (!s.trusted && typeof comp.confidence === 'number' && comp.confidence >= TRUSTED_AT) return 'trusted';
    if (!s.calibrated) return 'calibrated';
    return null;
  }

  // latch the fire-once ledger. TRUSTED also latches CALIBRATED: the smaller moment must never speak after
  // the bigger one already has (it would read as regression). Exported for the test.
  function latch(s, kind) {
    if (!s) return s;
    if (kind === 'calibrated') s.calibrated = true;
    else if (kind === 'trusted') { s.trusted = true; s.calibrated = true; }
    return s;
  }

  // the hero's live computed meter (or null — absent stats mean nothing to say).
  function meter() {
    try {
      if (typeof Xp === 'undefined' || !Xp.compute || !deps.getStats) return null;
      const stats = deps.getStats();
      return stats ? Xp.compute(stats) : null;
    } catch (_) { return null; }
  }

  // is a rate/turn-in control (or deck) live in the feed? One ask at a time — the beat defers behind it.
  function rateLive() {
    try {
      const log = document.getElementById('chat-log');
      return !!(log && log.querySelector('.cmsg.work-rate, .turnin-rate, .turnin-item'));
    } catch (_) { return false; }
  }

  // one bounded attempt at speaking `kind`; a blocked moment retries (the beat can be DELAYED, and — unlike
  // a rating — a pride notice is allowed to quietly expire when the moment never frees: it asks for nothing).
  function attempt(kind, tries) {
    if (!state || !LINES[kind]) return;
    if ((kind === 'trusted' && state.trusted) || (kind === 'calibrated' && state.calibrated)) return;   // already spoken (or outranked)
    const blocked = (typeof Chat === 'undefined' || !Chat.nudge)
      || (Chat.isBusy && Chat.isBusy())
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen())
      || rateLive();
    if (blocked) { if (tries > 0) setTimeout(() => attempt(kind, tries - 1), RETRY_MS); return; }
    latch(state, kind); save();   // latch BEFORE render: fire-once is the stronger law than never-lost
    try {
      Chat.nudge(LINES[kind], [{ label: 'noted', value: 'ok', skip: true }], () => {});
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // the soft notice chime (shared with ideas)
    } catch (_) {}
  }

  // a real satisfaction verdict on the HERO's work landed (the same quality gate xp.js uses). TWO callers,
  // mirroring how the meter itself is fed: the U.bus memory.feedback subscription (turn-in Keep/Edit — the
  // sidecar emits those) AND a DIRECT call from chat.js rateWork (the 👍/👌/👎 verdict never rides the bus).
  // Defer past XpStore's fold + the rate control's vanish, then decide off the LIVE meter.
  function onFeedback(p) {
    if (!state) return;
    if (((p && p.agentId) || 'agent') !== 'agent') return;   // hero-only: these beats are the hero's own voice
    if (typeof Xp === 'undefined' || !Xp.scoreEvent) return;
    const sc = Xp.scoreEvent('memory.feedback', p || {});
    if (!sc || sc.quality === null || sc.quality === undefined) return;   // not a satisfaction sample (pin/forget/etc.)
    setTimeout(() => {
      const kind = decide(state, meter());
      if (kind) attempt(kind, 25);
    }, SETTLE_MS);
  }

  // opts: { getStats() } — the hero's live stats blob (app.js closes over its agents registry).
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    if (!wired && typeof U !== 'undefined' && U.bus && U.bus.on) {
      wired = true;
      U.bus.on('memory.feedback', onFeedback);
    }
  }

  // S2/new-hero: a fresh agent re-earns both spoken moments (its meter starts over too). Own key.
  function reset() { state = hydrate(null); try { localStorage.removeItem(KEY); } catch (_) {} }

  // onFeedback is public: chat.js rateWork hands its direct (never-on-the-bus) verdict here.
  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, decide, latch, onFeedback, TRUSTED_AT, _state: () => state, _hydrate: hydrate, _lines: LINES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ConfBeats };
