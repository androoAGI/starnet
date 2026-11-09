/* STARNET — litefx.js : LITE EFFECTS. Lighter glass, and a floor that stands aside while you scroll, on the machines
   that need it. Everyone else keeps every effect exactly as it is.

   WHY (customer report 2026-11-08: "a 2014 Mac is too slow to scroll"). That is an old Intel Mac on macOS 11-ish with an
   integrated GPU, running the app in WKWebView. Measured on the seeded station in headless Chromium, scrolling COMMS with
   real wheel events (software compositing + a 4x CPU throttle as the stand-in for that machine):
     · GLASS. The four cabinet panels (#topbar, #left, #chat-panel, #bottombar) each carry backdrop-filter: blur(18px)
       saturate(1.08), and a COMMS scroll makes the compositor re-blur #chat-panel every frame. Behind those panels sits
       #screen-game's own flat gradient, so in the normal layout the blur draws nothing you can see — but it is paid for:
       the compositor thread was busy ~2.5 s of a 2.5 s scroll with it, ~0.46 s without it.
     · GLOW. Every transcript glyph inherits body's 0 0 4px phosphor text-shadow. A blurred shadow is per-text-run CPU work
       when WebKit paints the tiles a scroll uncovers.
     · THE FLOOR. The station draws on the main thread while you scroll — a wheel anywhere is "a hand on the window", which
       keeps it at the normal pace. On the throttled run a draw cost ~90 ms of a main thread the scroll needed.
   WHAT LITE DOES, and nothing else:
     · body.sn-lite-glass (css/litefx.css): no backdrop-filter anywhere, no glow on the transcript's text;
     · SCROLL HOLD: a wheel, touch or scrollbar-drag scroll anywhere OUTSIDE a canvas asks the floor to stand aside
       (World.yieldToUi, the same UI FIRST hold a window opening uses) until the scroll has been quiet for HOLD_MS. The
       simulation and every harness event keep running in real time; only the drawing waits, then resumes.
   WHO GETS IT. decide() is pure (node test: test/litefx.test.js):
     · WEAK — a software renderer (SwiftShader, llvmpipe, Microsoft Basic Render, or a context that only exists with a major
       performance caveat), no WebGL at all, an Intel GPU on a Mac (every Intel Mac is 2020 or older), an old "Intel HD
       Graphics" part anywhere, or <= 4 logical CPUs (a 2014 MacBook Air or 13" Pro reports 4). WKWebView may mask the GPU
       as "Apple GPU", which is why the CPU count is a signal too, and why the floor's own measurement is below.
     · glass — WEAK, or the OS asks for reduced transparency.
     · hold  — WEAK, or the OS asks for reduced motion; and, judged when the scroll happens, any floor whose measured draw
       already costs a whole 60 Hz frame (World.renderPace(): strained, or drawCostMs >= HEAVY_DRAW_MS). A STRAINED floor is a
       struggling machine, so it also turns the glass down for the rest of the session (sticky: the strain probe flips back
       and forth by design, the panels must not).
   Automation (navigator.webdriver — the headless QA harness and the demo recorder) keeps the shipped look, so screenshots
   stay comparable. ?fx=lite or ?fx=full forces either way (QA, perf probes), like ?glass=0.
   NETWORK: none. The GPU name is read from a throwaway 1x1 WebGL context, released at once, and never leaves the page. */
'use strict';
const LiteFx = (() => {
  const HOLD_MS = 160;          // a scroll quiet this long lets the floor draw again (wheel events arrive every ~16 ms; < World's 250 ms cap)
  const GESTURE_MS = 250;       // a scroll event this soon after a wheel/touch is the reader's, not the auto-follow's
  const HEAVY_DRAW_MS = 16;     // a floor draw that costs a whole 60 Hz frame
  const HEAVY_MEMO_MS = 1000;   // renderPace() is read at most once a second
  const SOFTWARE_RE = /SwiftShader|llvmpipe|softpipe|Software Rasterizer|Microsoft Basic Render|\bSoftware\b/i;
  const INTEL_RE = /\bIntel\b/i;
  const OLD_INTEL_HD_RE = /\bIntel(?:\(R\))?\s+HD\s+Graphics\b/i;   // the pre-2017 naming; "UHD" / "Iris Xe" / "Arc" do not match

  /** Pure: the browser's signals → what to turn down, and why. */
  function decide(sig) {
    const s = sig || {};
    if (s.override === 'full') return { glass: false, hold: false, weak: false, why: ['override:full'] };
    if (s.override === 'lite') return { glass: true, hold: true, weak: true, why: ['override:lite'] };
    if (s.automation) return { glass: false, hold: false, weak: false, why: ['automation'] };
    const r = String(s.renderer || ''), why = [];
    if (s.webgl === false) why.push('no-webgl');
    else if (s.caveat || SOFTWARE_RE.test(r)) why.push('software-renderer');
    if (s.mac && INTEL_RE.test(r)) why.push('intel-mac-gpu');
    else if (OLD_INTEL_HD_RE.test(r)) why.push('old-intel-gpu');
    if (s.cores > 0 && s.cores <= 4) why.push('cores<=4');
    if (s.strained) why.push('strained-floor');
    const weak = why.length > 0;
    if (s.reducedTransparency) why.push('reduced-transparency');
    if (s.reducedMotion) why.push('reduced-motion');
    return { glass: weak || !!s.reducedTransparency, hold: weak || !!s.reducedMotion, weak, why };
  }

  /** Pure: does a floor readout (World.renderPace()) say a draw already costs a whole frame? */
  function heavyPace(p) { return !!(p && (p.strained || p.drawCostMs >= HEAVY_DRAW_MS)); }

  function media(q) { try { return typeof matchMedia === 'function' && matchMedia(q).matches; } catch (_) { return false; } }
  function override() {
    try { const v = new URLSearchParams(location.search).get('fx'); return v === 'lite' || v === 'full' ? v : ''; } catch (_) { return ''; }
  }
  function isMac() {
    try {
      const nav = navigator, p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '';
      return /Mac/i.test(p) || /Macintosh|Mac OS X/i.test(nav.userAgent || '');
    } catch (_) { return false; }
  }
  // the cheap signals, read synchronously at boot
  function signals() {
    let cores = 0, automation = false;
    try { cores = +navigator.hardwareConcurrency || 0; automation = navigator.webdriver === true; } catch (_) {}
    return { override: override(), automation, cores, mac: isMac(),
      reducedTransparency: media('(prefers-reduced-transparency: reduce)'), reducedMotion: media('(prefers-reduced-motion: reduce)') };
  }
  // the GPU: a throwaway 1x1 context, asked for the low-power GPU (never wakes a MacBook Pro's discrete one), released at once
  function probeGpu() {
    const out = { webgl: false, caveat: false, renderer: '' };
    const make = strict => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 1;
        return c.getContext('webgl', { powerPreference: 'low-power', failIfMajorPerformanceCaveat: strict, antialias: false, depth: false });
      } catch (_) { return null; }
    };
    const release = gl => { try { const x = gl && gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch (_) {} };
    let gl = make(true);
    if (!gl) { gl = make(false); out.caveat = !!gl; }
    if (!gl) return out;
    out.webgl = true;
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (_) {}
    release(gl);
    return out;
  }

  let sig = {}, state = { glass: false, hold: false, weak: false, why: [] }, holds = 0, probed = false;
  let heavyAt = -Infinity, heavyMemo = false, gestureAt = -Infinity, pressed = false;
  function apply() {
    state = decide(sig);
    try { document.body.classList.toggle('sn-lite-glass', state.glass); } catch (_) {}
  }
  function now() { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
  // the floor's own measurement, read when a scroll happens (a struggling floor counts whatever the hardware looked like)
  function heavyFloor() {
    const t = now();
    if (t - heavyAt < HEAVY_MEMO_MS) return heavyMemo;
    heavyAt = t;
    let p = null;
    try { p = typeof World !== 'undefined' && World.renderPace ? World.renderPace() : null; } catch (_) { p = null; }
    heavyMemo = heavyPace(p);
    if (p && p.strained && !sig.strained && !sig.override && !sig.automation) { sig.strained = true; apply(); }   // sticky for the session
    return heavyMemo;
  }
  function hold() {
    if (typeof World === 'undefined' || typeof World.yieldToUi !== 'function') return;
    if (sig.override === 'full' || (sig.automation && !sig.override)) return;
    if (!(state.hold || heavyFloor())) return;
    try { World.yieldToUi(HOLD_MS); holds++; } catch (_) {}
  }
  // a canvas is the station (or BUILD MODE's floor): its wheel zooms the camera, never a scroll to stand aside for
  function onCanvas(t) { return !!(t && (t.tagName === 'CANVAS' || (t.closest && t.closest('#stage-wrap')))); }
  function onGesture(ev) { if (!onCanvas(ev.target)) { gestureAt = now(); hold(); } }
  function onScroll(ev) { if (!onCanvas(ev.target) && (pressed || now() - gestureAt < GESTURE_MS)) hold(); }
  function onPress(ev) { pressed = !onCanvas(ev.target); }
  function onRelease() { pressed = false; }

  function init() {
    sig = signals();
    apply();
    try {
      const opt = { capture: true, passive: true };
      window.addEventListener('wheel', onGesture, opt);
      window.addEventListener('touchmove', onGesture, opt);
      document.addEventListener('scroll', onScroll, opt);   // element scrolls do not bubble; capture sees them (a scrollbar drag)
      window.addEventListener('pointerdown', onPress, opt);
      for (const t of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(t, onRelease, opt);
    } catch (_) {}
    // the GPU probe waits for the boot to settle; a decision it cannot change (forced, automation, already weak) skips it
    if (sig.override || sig.automation || state.weak) return;
    const run = () => { if (probed) return; probed = true; Object.assign(sig, probeGpu()); apply(); };
    try { if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 }); else setTimeout(run, 1500); } catch (_) {}
  }
  /** diagnostics readout */
  function readout() { return Object.assign({ holds, renderer: sig.renderer || '', cores: sig.cores || 0 }, state, { why: state.why.slice() }); }

  if (typeof document !== 'undefined' && document.body && typeof window !== 'undefined') init();
  return { decide, heavyPace, state: readout, HOLD_MS, HEAVY_DRAW_MS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LiteFx;
