/* STARNET — util.js : helpers + event bus */
'use strict';

const U = {
  rnd(a, b) { return a + Math.random() * (b - a); },
  irnd(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); },
  pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; },
  chance(p) { return Math.random() < p; },
  clamp(v, a, b) { return v < a ? a : v > b ? b : v; },
  lerp(a, b, t) { return a + (b - a) * t; },
  pad2(n) { return String(n).padStart(2, '0'); },

  _id: 1,
  id() { return 't' + (U._id++); },

  /* TEXT SIZE zoom (stationui applySettings sets body.style.zoom): element style px live in the
     body-zoomed space while getBoundingClientRect / clientX / innerWidth are visual px — they
     disagree by this factor. Any code writing style coordinates from visual reads divides by it. */
  uiZoom() { const z = parseFloat(document.body && document.body.style ? document.body.style.zoom : ''); return z > 0 ? z : 1; },

  /* ...but uiZoom() is only the right divisor for a <body> CHILD. TEXT SIZE scales the type and
     leaves the CABINET at its designed size (app.css counter-zooms the topbar, dock, nameplates
     and the brand mark back to 1:1), so an element inside one of those blocks writes its style
     coordinates in VISUAL px while a body child still writes them in body-zoomed px. Divide by
     THIS instead of uiZoom() whenever the element you are positioning might live in the cabinet —
     it composes every zoom from the element up to the root, so it is simply the factor the engine
     actually applied, and it collapses to uiZoom()'s answer for an ordinary body child. */
  elZoom(el) {
    if (!el || typeof getComputedStyle !== 'function') return U.uiZoom();
    let z = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const v = parseFloat(getComputedStyle(n).zoom);
      if (v > 0) z *= v;
    }
    return z > 0 ? z : U.uiZoom();
  },

  /* shared window stacking order — every floating window (UI terms + prop
     terminals) pulls from one counter so click-to-front works across both */
  _z: 500,
  zTop() { return ++U._z; },

  money(n) {
    const neg = n < 0; n = Math.abs(n);
    let s;
    if (n >= 1000000) s = (n / 1000000).toFixed(2) + 'M';
    else if (n >= 10000) s = (n / 1000).toFixed(1) + 'K';
    else s = n.toFixed(2);
    return (neg ? '-$' : '$') + s;
  },

  /* CANONICAL spend formatter — the one true way to render an AI-cost dollar figure across the UI.
     Sub-dime keeps precision so a $0.0123 haiku ping stays visible; normal sums round to cents;
     whole dollars past $100 get a thousands separator; zero/invalid is a quiet $0.00. Mirrors the
     conventions the topbar/chat/world readouts converged on so no display shifts. */
  usd(n) {
    const v = Number(n);
    if (!isFinite(v)) return '$0.00';
    const neg = v < 0, a = Math.abs(v);
    let s;
    if (a === 0) s = '0.00';
    else if (a < 0.1) s = a.toFixed(4);                 // sub-dime: 4 decimals ($0.0123)
    else if (a < 100) s = a.toFixed(2);                 // normal: cents ($1.23 / $12.00)
    else s = Math.round(a).toLocaleString();            // large: whole dollars ($1,204)
    return (neg ? '-$' : '$') + s;
  },

  /* CANONICAL token-count formatter — compact k/M with one decimal under 10, rounded above, so
     1234 -> "1.2k" and 3,400,000 -> "3.4M". Mirrors the context-gauge convention. */
  tokens(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '0';
    if (v < 1000) return String(Math.round(v));
    if (v < 1000000) { const k = v / 1000; return (k < 10 ? k.toFixed(1).replace(/\.0$/, '') : String(Math.round(k))) + 'k'; }
    const m = v / 1000000; return (m < 10 ? m.toFixed(1).replace(/\.0$/, '') : String(Math.round(m))) + 'M';
  },

  // sim minutes -> "D3 14:05"
  fmtClock(mins) {
    const day = Math.floor(mins / 1440) + 1;
    const m = mins % 1440;
    return 'DAY ' + day + ' ' + U.pad2(Math.floor(m / 60)) + ':' + U.pad2(m % 60);
  },
  fmtTime(mins) {
    const m = mins % 1440;
    return U.pad2(Math.floor(m / 60)) + ':' + U.pad2(m % 60);
  },

  esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  // seeded-ish per-instance phase
  hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0);
  },

  shade(hex, f) { // f: -1..1 darken/lighten
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    if (f >= 0) { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
    else { r *= (1 + f); g *= (1 + f); b *= (1 + f); }
    return '#' + ((1 << 24) | (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b)).toString(16).slice(1);
  },

  // tiny pub/sub
  bus: {
    _h: {},
    on(ev, fn) { (U.bus._h[ev] = U.bus._h[ev] || []).push(fn); },
    // off(ev, fn): remove a single subscription (Lane E5). Splices the exact fn so a panel that subscribes inside a
    // render/open path can release its listener on close instead of leaking one more handler every time it reopens.
    off(ev, fn) { const a = U.bus._h[ev]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); },
    // emit over a COPY of the handler list so a listener that calls off() (self-unsubscribe / one-shot) during
    // dispatch never corrupts the in-flight iteration.
    emit(ev, data) { const a = U.bus._h[ev]; if (!a || !a.length) return; a.slice().forEach(fn => { try { fn(data); } catch (e) { console.error('[bus]', ev, e); } }); }
  }
};

/* ============================================================================
   SFX — procedural sound engine (Web Audio). Asset-free and node-safe: every
   audio node is built lazily inside boot()/playback, so nothing touches
   AudioContext at module load and the headless test that evals this file (and
   sets SFX.on=false) stays happy. The public API is a backward-compatible
   superset of the old tiny synth — boot / tone / click / open / close / notify
   / sale / bad / level / type all still exist; they just sound designed now
   instead of like a buzzy PC speaker. The event stings (chime/ship/alarm/msg)
   are fired by the sound Director in audio.js off real colony bus events.

   The palette is ONE coherent console voice: every cue is a breath of filtered
   noise for TOUCH + a warm tonal body around A minor (the station's key —
   celebrations run its relative major) with a small pitch glide for MOTION,
   sharing one reverb for the room. Per-cue gates keep event storms from
   machine-gunning a sting into mud.
   ========================================================================== */
const SFX = {
  ctx: null, master: null, fx: null, on: true, vol: 0.35, _noise: null, _lastAt: {},

  // per-sound gate: repeats inside the window are dropped; the FIRST one always sounds.
  // _lastAny lets the delegated UI layer (audio.js) yield to explicit cues that just played.
  _lastAny: 0,
  // `quiet` cues (the typewriter tick) still rate-limit themselves but must NOT stamp _lastAny: a tick
  // is ambience, not an interaction cue, and at ~20/sec it would hold the delegate's 80ms yield window
  // permanently open — silencing every button pressed while a COMMS line types itself out.
  _gate(name, ms, quiet) {
    const now = Date.now();
    if (SFX._lastAt[name] && now - SFX._lastAt[name] < ms) return false;
    SFX._lastAt[name] = now; if (!quiet) SFX._lastAny = now; return true;
  },

  // destination picker: an optional stereo nudge (pan −1..1) gives UI cues a touch of width;
  // falls back to the mono master when StereoPanner is missing (old WebKit).
  _out(c, pan) {
    if (!pan || !c.createStereoPanner) return SFX.master;
    const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(SFX.master);
    return p;
  },

  boot() {
    if (SFX.ctx) { try { if (['suspended', 'interrupted'].includes(SFX.ctx.state)) SFX.ctx.resume().catch(() => {}); } catch (e) { } return; }
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      // master chain: gain -> gentle high-shelf cut (tames harsh harmonics) -> soft limiter -> out
      const master = c.createGain(); master.gain.value = 0.9;
      const tame = c.createBiquadFilter(); tame.type = 'highshelf'; tame.frequency.value = 5400; tame.gain.value = -9;
      const lim = c.createDynamicsCompressor();
      lim.threshold.value = -9; lim.knee.value = 8; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.2;
      master.connect(tame); tame.connect(lim); lim.connect(c.destination);
      // shared reverb send (synthetic decaying-noise impulse) gives everything a sense of space
      const send = c.createGain(); send.gain.value = 1;
      const verb = c.createConvolver(); verb.buffer = SFX._impulse(c, 1.8, 2.6);
      const wet = c.createGain(); wet.gain.value = 0.45;
      send.connect(verb); verb.connect(wet); wet.connect(master);
      SFX.ctx = c; SFX.master = master; SFX.fx = send; SFX._noise = SFX._noiseBuf(c, 1.5);
      SFX._loadSamples();
    } catch (e) { /* no Web Audio (e.g. headless node) — stay silent */ }
  },

  /* ---- licensed UI samples (Interface Bleeps by Bleeoop — see assets/sfx/LICENSE.md),
     per-cue mapping hand-picked by Andrew (2026-07-19). Fetched lazily after boot; until
     they arrive (or if they 404) each cue falls back to its synth version. ---- */
  _samples: {},
  _loadSamples() {
    if (typeof fetch === 'undefined' || SFX._samplesLoading) return;
    SFX._samplesLoading = true;
    ['click', 'open', 'alarm', 'chime', 'notify', 'msg', 'ship', 'think', 'idea', 'seed',
     'type', 'tick', 'sale', 'quest', 'milestone', 'level'].forEach(name => {
      fetch('assets/sfx/ui-' + name + '.wav').then(r => r.ok ? r.arrayBuffer() : Promise.reject())
        .then(ab => SFX.ctx.decodeAudioData(ab))
        .then(buf => { SFX._samples[name] = buf; })
        .catch(() => { /* keep synth fallback */ });
    });
  },
  // play a sample through the master chain (so volume, shelf and limiter still apply)
  _sample(name, o) {
    const buf = SFX._samples[name];
    if (!SFX.on || !SFX.ctx || !buf) return false;
    o = o || {};
    const c = SFX.ctx, src = c.createBufferSource(), g = c.createGain();
    src.buffer = buf; src.playbackRate.value = o.rate || 1;
    g.gain.value = (o.vol != null ? o.vol : 0.5) * SFX.vol;
    src.connect(g); g.connect(SFX._out(c, o.pan));
    src.start(); src.stop(c.currentTime + buf.duration / (o.rate || 1) + 0.05);
    return true;
  },

  /* ---- buffer factories (browser-only; only ever called from boot) ---- */
  _noiseBuf(c, secs) {
    const n = Math.floor(c.sampleRate * secs), b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  _impulse(c, secs, decay) {
    const n = Math.floor(c.sampleRate * secs), b = c.createBuffer(2, n, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return b;
  },

  /* ---- core voice: detuned oscillator(s) -> lowpass -> ADSR -> master (+reverb send) ---- */
  voice(o) {
    if (!SFX.on || !SFX.ctx) return;
    o = o || {};
    const c = SFX.ctx, t0 = c.currentTime + (o.when || 0);
    const dur = o.dur || 0.2, peak = (o.vol != null ? o.vol : 0.5) * SFX.vol;
    const atk = o.atk != null ? o.atk : 0.006, rel = o.rel != null ? o.rel : dur;
    const g = c.createGain();
    const f = c.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.value = o.cut || Math.min(8000, (o.freq || 440) * 5 + 700); f.Q.value = o.q || 0.7;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);             // soft attack kills the click/pop
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(rel, atk + 0.02));
    const type = o.type || 'triangle', det = o.detune || 0;
    const mk = cents => {
      const osc = c.createOscillator(); osc.type = type; osc.frequency.setValueAtTime(o.freq || 440, t0);
      if (cents) osc.detune.value = cents;
      if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide, t0 + dur);
      osc.connect(f); osc.start(t0); osc.stop(t0 + dur + 0.05);
    };
    mk(0); if (det) { mk(det); mk(-det); }                      // detuned stack = warmth, not a thin beep
    f.connect(g); g.connect(SFX._out(c, o.pan));
    if (o.verb && SFX.fx) { const s = c.createGain(); s.gain.value = o.verb; g.connect(s); s.connect(SFX.fx); }
  },

  /* ---- filtered noise burst: the basis of satisfying clicks/ticks/whooshes ---- */
  noise(o) {
    if (!SFX.on || !SFX.ctx || !SFX._noise) return;
    o = o || {};
    const c = SFX.ctx, t0 = c.currentTime + (o.when || 0), dur = o.dur || 0.05;
    const src = c.createBufferSource(); src.buffer = SFX._noise; src.loop = true;
    const f = c.createBiquadFilter(); f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.cut || 2000, t0);
    if (o.cut2) f.frequency.exponentialRampToValueAtTime(o.cut2, t0 + dur);
    f.Q.value = o.q || 0.9;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime((o.vol != null ? o.vol : 0.3) * SFX.vol, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(SFX._out(c, o.pan));
    if (o.verb && SFX.fx) { const s = c.createGain(); s.gain.value = o.verb; g.connect(s); s.connect(SFX.fx); }
    src.start(t0); src.stop(t0 + dur + 0.05);
  },

  /* ---- backward-compatible primitive: identical signature to the old tone() ----
     existing callers (arcade.js etc.) keep working and instantly sound warmer,
     because every tone now gets a soft attack, a lowpass, and the master limiter. */
  tone(freq, dur, type, vol, when, cut) {
    SFX.voice({ freq, dur: dur || 0.1, type: type || 'square', vol, when, cut, verb: (dur || 0) > 0.06 ? 0.1 : 0 });
  },

  /* ---- designed UI / event sounds — the coherent console voice (see header) ---- */
  // click: the FNV Pip-Boy hollow knock, fitted to Andrew's chosen reference moment (video 0:18,
  // time-sliced FFT): a 4ms high splash into a ~890Hz body that FALLS to ~660Hz over 20ms (the
  // "thunk" settle), inharmonic modes at ~1.9k/2.7k, a faint ~280Hz undertone, ~45ms total. Dry.
  click() {
    if (!SFX._gate('click', 40)) return;
    const pan = (Math.random() - 0.5) * 0.16, drift = 1 + (Math.random() - 0.5) * 0.08;
    // Click_02 (Andrew's pick) — a tiny bright tick; ±4% drift keeps rapid runs organic.
    if (SFX._sample('click', { rate: drift, vol: 0.5, pan })) return;
    SFX.noise({ dur: 0.005, cut: 7000, type: 'highpass', vol: 0.06, pan });
    SFX.voice({ freq: 900 * drift, glide: 660 * drift, dur: 0.045, type: 'sine', vol: 0.20, atk: 0.001, cut: 6000, pan });
    SFX.voice({ freq: 1920 * drift, dur: 0.025, type: 'sine', vol: 0.08, atk: 0.001, cut: 7000, pan });
    SFX.voice({ freq: 2719 * drift, dur: 0.02, type: 'sine', vol: 0.06, atk: 0.001, cut: 8000, pan });
    SFX.voice({ freq: 281, dur: 0.05, when: 0.012, type: 'sine', vol: 0.06, atk: 0.003, pan });
  },
  // toggle: a settings switch flipping — the click sample pitched up a hair so checkboxes and
  // radios feel related to but distinct from plain buttons. Used by the delegated UI layer.
  toggle() {
    if (!SFX._gate('toggle', 60)) return;
    if (SFX._sample('click', { rate: 1.18, vol: 0.45 })) return;
    SFX.noise({ dur: 0.01, cut: 3000, type: 'highpass', vol: 0.05 });
    SFX.voice({ freq: 1060, glide: 780, dur: 0.04, type: 'sine', vol: 0.16, atk: 0.001, cut: 6000 });
  },
  // tick: a state COMMITTED — a connector enabled, a transport switched, a key removed. Data_Point_05,
  // a 166ms readout blip: a settings change CONFIRMS without pretending to be a notification.
  // connectors.js has called sfx('tick') at eight sites since it was written; until this cue existed the
  // helper's `SFX[n] &&` guard swallowed every one of them and the whole window changed state in silence.
  tick() {
    if (!SFX._gate('tick', 60)) return;
    if (SFX._sample('tick', { rate: 1, vol: 0.45 })) return;
    SFX.noise({ dur: 0.01, cut: 3200, type: 'highpass', vol: 0.05 });
    SFX.voice({ freq: 1120, glide: 840, dur: 0.042, type: 'sine', vol: 0.17, atk: 0.001, cut: 6000 });
  },
  // slidertick: the ratchet detent for range inputs — tiny, high, heavily gated so a drag
  // reads as a rotary dial, not a machine gun.
  slidertick() {
    if (!SFX._gate('slidertick', 90)) return;
    if (SFX._sample('click', { rate: 1.5, vol: 0.22 })) return;
    SFX.noise({ dur: 0.012, cut: 3400, vol: 0.05, type: 'highpass' });
  },
  // "got it, thinking…" — a soft descending two-note sine, distinct from click (send) and open (listen-start),
  // so a hands-free user gets instant confirmation their words landed before the agent starts speaking.
  think() { if (SFX._sample('think', { rate: 1, vol: 0.45 })) return; SFX.voice({ freq: 659, dur: 0.09, type: 'sine', vol: 0.16, atk: 0.01, verb: 0.18 }); SFX.voice({ freq: 494, dur: 0.14, type: 'sine', vol: 0.12, when: 0.06, atk: 0.01, verb: 0.22 }); },
  // open/close: a panel physically SLIDING — an air whoosh sweeping up (open) or down (close) under a
  // rising/falling pair on A. The whoosh is what makes the window feel like it moved, not appeared.
  // open/close: the same 0:18 knock, scaled up a touch for a window-sized action, plus the quiet
  // mechanical after-rattle the recording shows (~60-90ms later, tiny ~600Hz ticks). Close sits a
  // few percent lower so direction still reads. Dry: no whoosh, no hum, no reverb.
  open() {
    if (!SFX._gate('open', 80)) return;
    // Data_Point_04 (Andrew's pick) at full pitch = enter.
    if (SFX._sample('open', { rate: 1, vol: 0.55 })) return;
    SFX.noise({ dur: 0.005, cut: 7000, type: 'highpass', vol: 0.06 });
    SFX.voice({ freq: 920, glide: 680, dur: 0.05, type: 'sine', vol: 0.21, atk: 0.001, cut: 6000 });
    SFX.voice({ freq: 1950, dur: 0.026, type: 'sine', vol: 0.08, atk: 0.001, cut: 7000 });
    SFX.voice({ freq: 281, dur: 0.05, when: 0.012, type: 'sine', vol: 0.06, atk: 0.003 });
  },
  close() {
    if (!SFX._gate('close', 80)) return;
    // same Data_Point_04, pitched down = the same mechanism releasing; open/close stay directional.
    if (SFX._sample('open', { rate: 0.85, vol: 0.5 })) return;
    SFX.noise({ dur: 0.005, cut: 6500, type: 'highpass', vol: 0.055 });
    SFX.voice({ freq: 840, glide: 610, dur: 0.05, type: 'sine', vol: 0.20, atk: 0.001, cut: 6000 });
    SFX.voice({ freq: 1800, dur: 0.026, type: 'sine', vol: 0.075, atk: 0.001, cut: 7000 });
    SFX.voice({ freq: 260, dur: 0.05, when: 0.012, type: 'sine', vol: 0.06, atk: 0.003 });
  },
  // notify: the station bell — a warm detuned A5/E6 pair with a long room tail. Gated so a burst of
  // pings reads as ONE bell, not a carillon.
  notify() {
    if (!SFX._gate('notify', 300)) return;
    if (SFX._sample('notify', { rate: 1, vol: 0.5 })) return;
    SFX.voice({ freq: 880, dur: 0.34, type: 'sine', vol: 0.2, detune: 5, atk: 0.012, verb: 0.45 });
    SFX.voice({ freq: 1318, dur: 0.46, type: 'sine', vol: 0.12, when: 0.09, atk: 0.015, detune: 5, verb: 0.55 });
  },
  // sale: the settings export landing — Confirm_01, a settled two-part confirm.
  sale() {
    if (SFX._sample('sale', { rate: 1, vol: 0.5 })) return;
    [523, 659, 784, 1046].forEach((f, i) => SFX.voice({ freq: f, dur: 0.22, type: 'triangle', vol: 0.19, when: i * 0.05, atk: 0.008, detune: 3, verb: 0.3 }));
  },
  // bad: a dark exhale — low saw slide with a falling noise wash underneath; heavy, not buzzy.
  bad() {
    if (!SFX._gate('bad', 250)) return;
    // Bleep_02 (Andrew's pick, shared with alarm) pitched down = negative, related to alarm but smaller.
    if (SFX._sample('alarm', { rate: 0.9, vol: 0.45 })) return;
    SFX.noise({ dur: 0.16, cut: 900, cut2: 300, vol: 0.07, q: 0.8 });
    SFX.voice({ freq: 196, glide: 110, dur: 0.22, type: 'sawtooth', vol: 0.16, cut: 800, atk: 0.01 });
    SFX.voice({ freq: 147, glide: 92, dur: 0.3, type: 'sawtooth', vol: 0.12, when: 0.08, cut: 620, atk: 0.01 });
  },
  // level: the biggest sting the station owns — Sequence_06, the longest of the three (1572ms).
  // The three celebration cues are graded by the pack's own lengths: quest 235ms < milestone 843ms < level.
  // vol > 1 is DELIBERATE, do not "correct" it: Sequence_06 is recorded ~12dB quieter than Confirm_02
  // and Sequence_07 (raw peaks -17.1 vs -4.4 / -5.3 dBFS), so at a normal 0.5 the longest sting came out
  // the QUIETEST of the three and a level-up landed smaller than a milestone. 2.0 renders it at -19.8
  // peak against milestone's -19.3 — matched by measurement, not by ear. The limiter takes the transient.
  level() {
    if (SFX._sample('level', { rate: 1, vol: 2 })) return;
    [523, 659, 784, 1046, 1318].forEach((f, i) => SFX.voice({ freq: f, dur: 0.2, type: 'triangle', vol: 0.21, when: i * 0.065, atk: 0.008, detune: 3, verb: 0.3 }));
    SFX.voice({ freq: 2093, dur: 0.5, type: 'sine', vol: 0.07, when: 0.33, atk: 0.03, verb: 0.6 });
  },
  // quest-complete sting (G1a): a shorter, brighter cousin of level() — three quick gold steps + one high
  // shimmer. A MOMENT, deliberately smaller than a level-up: quests pay out in real work, not fanfare.
  quest() {
    if (SFX._sample('quest', { rate: 1, vol: 0.5 })) return;
    [659, 880, 1318].forEach((f, i) => SFX.voice({ freq: f, dur: 0.16, type: 'triangle', vol: 0.19, when: i * 0.055, atk: 0.008, detune: 3, verb: 0.32 }));
    SFX.voice({ freq: 1976, dur: 0.36, type: 'sine', vol: 0.08, when: 0.19, atk: 0.02, verb: 0.55 });
  },
  // idea sting (G3a): a pitch / fresh suggestion / spoken notice slots into the feed — SOFT, two warm sine
  // steps up, quieter and rounder than notify() so a proactive aside lands gently, never startles.
  idea() { if (SFX._sample('idea', { rate: 1, vol: 0.4 })) return; SFX.voice({ freq: 587, dur: 0.13, type: 'sine', vol: 0.11, atk: 0.012, verb: 0.28 }); SFX.voice({ freq: 880, dur: 0.18, type: 'sine', vol: 0.09, when: 0.07, atk: 0.012, verb: 0.35 }); },
  // seed-saved sting (G3a): PLANTING — one warm low tuck + two high sparkles settling over it; deliberately
  // distinct from chime() (one held bell) and sale() (major run) so "saved to your shelf" has its own signature.
  seed() { if (SFX._sample('seed', { rate: 1, vol: 0.45 })) return; SFX.voice({ freq: 262, dur: 0.17, type: 'triangle', vol: 0.17, atk: 0.01, verb: 0.22 }); SFX.voice({ freq: 1568, dur: 0.1, type: 'sine', vol: 0.09, when: 0.10, verb: 0.45 }); SFX.voice({ freq: 2093, dur: 0.24, type: 'sine', vol: 0.07, when: 0.16, verb: 0.55 }); },
  // milestone sting (G3a): grander than quest() (3 steps), smaller than level() (5 steps) — four rising gold
  // steps under a long high shimmer. A milestone is PERMANENT, so its sting carries a little more weight.
  milestone() {
    if (SFX._sample('milestone', { rate: 1, vol: 0.52 })) return;
    [523, 659, 880, 1318].forEach((f, i) => SFX.voice({ freq: f, dur: 0.18, type: 'triangle', vol: 0.2, when: i * 0.06, atk: 0.008, detune: 3, verb: 0.3 }));
    SFX.voice({ freq: 2637, dur: 0.44, type: 'sine', vol: 0.07, when: 0.26, atk: 0.03, verb: 0.6 });
  },
  // type: the typewriter tick under every revealed COMMS line — Click_03, the shortest thing in the pack
  // at 74ms, which is the only reason it survives firing ~20×/sec. Quiet, with the same ±pan/±rate drift
  // as click() so a run of them stays organic. Gated quiet (see _gate) so a typing line never mutes the
  // buttons around it.
  type() {
    if (!SFX._gate('type', 24, true)) return;
    const pan = (Math.random() - 0.5) * 0.2, drift = 1 + (Math.random() - 0.5) * 0.08;
    if (SFX._sample('type', { rate: drift, vol: 0.3, pan })) return;
    SFX.noise({ dur: 0.016, cut: 3400, vol: 0.045, type: 'highpass', pan });
  },

  /* ---- event stings the sound Director (audio.js) plays on real colony events ---- */
  // chime: one held glass bell — memory writes, permission asks. Slow attack so it blooms.
  chime() {
    if (!SFX._gate('chime', 400)) return;
    if (SFX._sample('chime', { rate: 1, vol: 0.5 })) return;
    SFX.voice({ freq: 1046, dur: 0.55, type: 'sine', vol: 0.14, detune: 4, atk: 0.015, verb: 0.5 });
    SFX.voice({ freq: 1568, dur: 0.7, type: 'sine', vol: 0.09, when: 0.05, atk: 0.02, verb: 0.6 });
  },
  // ship: something REAL left the station — a small launch whoosh under a rising pair.
  ship() {
    if (!SFX._gate('ship', 200)) return;
    if (SFX._sample('ship', { rate: 1, vol: 0.5 })) return;
    SFX.noise({ dur: 0.1, cut: 700, cut2: 2400, vol: 0.05, q: 0.7 });
    SFX.voice({ freq: 659, dur: 0.12, type: 'triangle', vol: 0.18, atk: 0.006, verb: 0.3 });
    SFX.voice({ freq: 988, dur: 0.2, type: 'triangle', vol: 0.14, when: 0.06, atk: 0.006, detune: 3, verb: 0.38 });
  },
  // alarm: two low filtered square pulses (A3→E3) — a machine heartbeat gone wrong, dark not shrill.
  // Widest gate of all: an error cascade must read as one alarm, never a siren wall.
  alarm() {
    if (!SFX._gate('alarm', 700)) return;
    if (SFX._sample('alarm', { rate: 1, vol: 0.55 })) return;
    SFX.voice({ freq: 220, dur: 0.16, type: 'square', vol: 0.13, cut: 950, q: 1.2, atk: 0.006 });
    SFX.voice({ freq: 165, dur: 0.26, type: 'square', vol: 0.11, when: 0.15, cut: 780, q: 1.2, atk: 0.006, verb: 0.12 });
  },
  // msg: a soft two-note ping for inbound traffic — quieter kin of notify().
  msg() {
    if (!SFX._gate('msg', 250)) return;
    if (SFX._sample('msg', { rate: 1, vol: 0.4 })) return;
    SFX.voice({ freq: 988, dur: 0.11, type: 'sine', vol: 0.15, atk: 0.008, verb: 0.3 });
    SFX.voice({ freq: 1318, dur: 0.16, type: 'sine', vol: 0.11, when: 0.05, atk: 0.008, verb: 0.35 });
  },

  /* ---- soft-envelope voices for THE AWAKENING (fade-in tones, breath, chimes) — routed through the
     master bus so they pass the limiter; self-terminating so nothing leaks. ---- */
  env(freq, o) {
    o = o || {};
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime + (o.when || 0), out = SFX.master || c.destination;
    const osc = c.createOscillator(), g = c.createGain();
    osc.type = o.type || 'sine'; osc.frequency.value = freq;
    const a = o.attack || 0.01, h = o.hold || 0.05, r = o.release || 0.2, v = (o.vol || 0.1) * SFX.vol;
    if (o.glideTo) osc.frequency.linearRampToValueAtTime(o.glideTo, t0 + a + h);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, v), t0 + a);
    g.gain.setValueAtTime(Math.max(0.0002, v), t0 + a + h);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + h + r);
    osc.connect(g); g.connect(out);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
    osc.start(t0); osc.stop(t0 + a + h + r + 0.05);
  },
  // a sharp filtered-noise INHALE — the newborn's first pull of air (uses the shared noise buffer).
  gasp() {
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime, out = SFX.master || c.destination;
    if (!SFX._noise) { const b = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; SFX._noise = b; }
    const src = c.createBufferSource(); src.buffer = SFX._noise;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(330, t0); f.frequency.linearRampToValueAtTime(1400, t0 + 0.34);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.10 * SFX.vol, t0 + 0.13); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.44);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t0); src.stop(t0 + 0.5);
  },
  // a soft rising bell each time the newborn learns a truth about itself — pitched UP per step (i = 0..3).
  truth(i) {
    const sets = [[523, 659], [587, 740], [659, 830], [784, 988, 1175]];
    (sets[Math.min(i, 3)]).forEach((f, n) => SFX.env(f, { attack: 0.012, hold: 0.05, release: 0.42, type: 'sine', vol: 0.13, when: n * 0.07 }));
  },
  // the warm major-chord SWELL at dawn — first light you can hear.
  dawn() {
    [261, 329, 392, 523].forEach((f, n) => SFX.env(f, { attack: 0.3, hold: 0.32, release: 1.1, type: 'sine', vol: 0.11, when: n * 0.05 }));
  },
  // THE FLOOD — waking into vast knowledge: a noise wash that sweeps wide-open then closes, under an
  // ascending detuned tone-cluster that swells to a peak (~3.3s) and resolves. ~4.7s, self-terminating.
  flood() {
    if (!SFX.on || !SFX.ctx) return;
    const c = SFX.ctx, t0 = c.currentTime, out = SFX.master || c.destination;
    const V = SFX.vol;
    // rushing wash — looped noise through a bandpass that races open (the pages streaming past), then shuts
    if (!SFX._noise) { const b = c.createBuffer(1, Math.floor(c.sampleRate * 0.5), c.sampleRate); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; SFX._noise = b; }
    const src = c.createBufferSource(); src.buffer = SFX._noise; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(180, t0);
    bp.frequency.exponentialRampToValueAtTime(3600, t0 + 3.3);
    bp.frequency.exponentialRampToValueAtTime(360, t0 + 4.5);
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.0001, t0);
    ng.gain.linearRampToValueAtTime(0.085 * V, t0 + 3.3);
    ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.6);
    src.connect(bp); bp.connect(ng); ng.connect(out);
    src.start(t0); src.stop(t0 + 4.7);
    // the vastness rising — a detuned cluster that glides up a fifth and swells under a opening lowpass
    [110, 146.83, 220, 293.66].forEach((f, n) => {
      const o = c.createOscillator(), g = c.createGain(), lpf = c.createBiquadFilter();
      o.type = n < 2 ? 'sawtooth' : 'triangle';
      o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + 3.4);
      o.detune.value = (n - 1.5) * 4;
      lpf.type = 'lowpass'; lpf.frequency.setValueAtTime(700, t0); lpf.frequency.exponentialRampToValueAtTime(2600, t0 + 3.3);
      const peak = Math.max(0.0004, (0.05 - n * 0.006) * V);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 3.2 + n * 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.5);
      o.connect(lpf); lpf.connect(g); g.connect(out);
      o.start(t0); o.stop(t0 + 4.7);
    });
    // sub-rise for weight under the swell
    const sub = c.createOscillator(), sg = c.createGain();
    sub.type = 'sine'; sub.frequency.setValueAtTime(40, t0); sub.frequency.linearRampToValueAtTime(70, t0 + 3.4);
    sg.gain.setValueAtTime(0.0001, t0); sg.gain.linearRampToValueAtTime(0.06 * V, t0 + 3.2); sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 4.4);
    sub.connect(sg); sg.connect(out); sub.start(t0); sub.stop(t0 + 4.6);
  }
};
