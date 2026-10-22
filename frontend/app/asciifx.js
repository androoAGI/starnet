/* AGENT OS — asciifx.js : the ASCII-MOTION KIT.

   A small, reusable vocabulary of terminal-flavored motion primitives — the "decode / materialize
   from static" language the CRT station has always begged for but never had. Additive over
   motion.css; every effect here is:
     · rAF-driven and self-cleaning (no dangling timers, restores any DOM it mutates),
     · phosphor/VT323-native (uses the page's existing type + colour — no hardcoded palette),
     · reduced-motion-honest (each primitive resolves INSTANTLY to its final state when the OS
       asks for reduced motion — the content never gets stuck mid-scramble),
     · structure-preserving (scramble walks LEAF TEXT NODES, so a line with tinted <span> parts —
       e.g. the celebration broadcast's agent-name chip — keeps its markup and colour),
     · hidden-tab-proof: a backgrounded tab PAUSES requestAnimationFrame outright, which would
       freeze any effect mid-flight (text stuck as glyph-static; a dissolve overlay stuck OVER
       content). Every primitive therefore carries a setTimeout backstop — timeouts still fire
       when hidden — that force-resolves to the final state. Whichever completes first wins.

   The register is EERIE, not cute: a station signal resolving out of noise, never confetti.
   Consumers: stationui.js (window-open title decode + section-swap materialize + toast decode)
   and chat.js (level-up / quest / trophy broadcast decode). The kit names its own surfaces so a
   new caller reuses the SAME language instead of inventing a one-off.

   API (all null-safe; each resolves instantly under reduced-motion):
     AsciiFX.reduced()                         -> boolean (respects prefers-reduced-motion)
     AsciiFX.scramble(rootEl, opts)            -> decode each leaf text node out of glyph-noise
     AsciiFX.dissolveIn(hostEl, opts)          -> overlay a fading ▓▒░ static field over host
     AsciiFX.typewriter(el, text, opts)        -> type `text` with a block cursor
     AsciiFX.frame(text, opts)                 -> box-drawing framed string (decorative helper)
*/
'use strict';
const AsciiFX = (() => {
  // decode alphabet: dense blocks + terminal punctuation + caps/digits. The blocks up front make
  // the unresolved frontier read as STATIC (▓▒░) before it settles into the real glyph.
  const GLYPHS = '▓▒░█▚▞#%&$@*+=<>/\\|!?:;~^0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const NOISE = '▓▒░ ▒░█▒ ░▓▒ ▚▞░▒ ▓░ ▒▓░█ ░▒▓ ▞▚▒░';   // block-static seed for dissolveIn fields

  const now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const raf = (fn) => (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(fn) : setTimeout(() => fn(now()), 16);
  const gl = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
  function reduced() {
    try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch (_) { return false; }
  }
  const isWS = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === ' ';

  /* ── SCRAMBLE : a left-to-right "decrypt" of every leaf text node under rootEl ─────────────────
     Each character has a reveal threshold along the timeline; before it, the slot flickers random
     glyphs (the static frontier); after it, the real character locks in. Whitespace is never
     scrambled (keeps word shape legible while it resolves). Markup + inline colour are untouched —
     only Text nodes are rewritten, and the originals are restored exactly on completion, so this
     can safely run over live, styled DOM. */
  function scramble(root, opts) {
    opts = opts || {};
    if (!root || !root.nodeType) return;
    const nodes = [];
    (function walk(n) {
      for (let c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) { if (c.nodeValue && c.nodeValue.replace(/\s/g, '').length) nodes.push({ node: c, final: c.nodeValue }); }
        else if (c.nodeType === 1 && c.childNodes.length) walk(c);
      }
    })(root);
    if (!nodes.length) { if (opts.onDone) opts.onDone(); return; }
    const restore = () => { for (const n of nodes) n.node.nodeValue = n.final; };
    if (reduced()) { if (opts.onDone) opts.onDone(); return; }   // final text already present — leave it
    const dur = Math.max(120, opts.duration || 620);
    const settle = 0.82;   // last char begins settling at 82% of the run; a 0.18 tail flickers ahead
    let total = 0, done = false;
    for (const n of nodes) { n.chars = Array.from(n.final); total += n.chars.length; }
    root.classList.add('afx-scrambling');
    // hidden-tab backstop (see header): guarantee the text always resolves to its final value.
    const finish = () => { if (done) return; done = true; restore(); root.classList.remove('afx-scrambling'); if (opts.onDone) opts.onDone(); };
    const guard = setTimeout(finish, dur + 240);
    const start = now();
    (function frame(t0) {
      if (done) return;
      const t = Math.min(1, (t0 - start) / dur);
      let gi = 0;
      for (const n of nodes) {
        let out = '';
        for (let i = 0; i < n.chars.length; i++, gi++) {
          const ch = n.chars[i];
          if (isWS(ch)) { out += ch; continue; }
          const revealAt = (gi / total) * settle;
          out += (t >= revealAt) ? ch : gl();
        }
        n.node.nodeValue = out;
      }
      if (t < 1) raf(frame);
      else { clearTimeout(guard); finish(); }
    })(start);
  }

  /* ── DISSOLVE-IN : content materializes out of a ▓▒░ static field ──────────────────────────────
     Overlays a pointer-events:none glyph-noise layer over `host`, churns the noise for a beat, then
     fades it out to reveal the content beneath. Self-cleaning: the overlay is removed on completion
     (backstopped for hidden tabs — a stuck overlay would cover content), and any position:static
     host is temporarily promoted to relative and restored so the absolute overlay anchors correctly
     without leaving a layout side-effect. */
  function dissolveIn(host, opts) {
    opts = opts || {};
    if (!host || !host.nodeType || typeof document === 'undefined') return;
    if (reduced()) { if (opts.onDone) opts.onDone(); return; }
    const dur = Math.max(160, opts.duration || 520);
    let priorPos = null;
    try {
      const cs = getComputedStyle(host);
      if (cs && cs.position === 'static') { priorPos = host.style.position || ''; host.style.position = 'relative'; }
    } catch (_) {}
    const ov = document.createElement('div');
    ov.className = 'afx-dissolve';
    ov.setAttribute('aria-hidden', 'true');
    host.appendChild(ov);
    // fill with a block of static sized loosely to the host; churned each frame for a live-noise feel
    const cols = Math.max(24, Math.min(120, Math.round((host.clientWidth || 320) / 9)));
    const rows = Math.max(6, Math.min(48, Math.round((host.clientHeight || 200) / 16)));
    const churn = () => {
      let s = '';
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) line += NOISE[(Math.random() * NOISE.length) | 0];
        s += line + '\n';
      }
      ov.textContent = s;
    };
    let done = false;
    const cleanup = () => {
      if (done) return; done = true;
      if (ov.parentNode) ov.parentNode.removeChild(ov);
      if (priorPos !== null) host.style.position = priorPos;
      if (opts.onDone) opts.onDone();
    };
    const guard = setTimeout(cleanup, dur + 240);   // hidden-tab backstop: the overlay is ALWAYS torn down
    const start = now();
    churn();
    let lastChurn = start;
    (function frame(t0) {
      if (done) return;
      const t = Math.min(1, (t0 - start) / dur);
      if (t0 - lastChurn > 40) { churn(); lastChurn = t0; }   // ~25fps churn is plenty for static
      ov.style.opacity = String(1 - t * t);   // ease-out fade so the reveal lands soft
      if (t < 1) raf(frame); else { clearTimeout(guard); cleanup(); }
    })(start);
  }

  /* ── TYPEWRITER : type `text` into `el` one char at a time, block cursor trailing ──────────────
     For loading / empty states that want to read as a live console line. Cursor is a CSS pseudo. */
  function typewriter(el, text, opts) {
    opts = opts || {};
    if (!el || !el.nodeType) return;
    text = String(text == null ? '' : text);
    if (reduced()) { el.textContent = text; if (opts.onDone) opts.onDone(); return; }
    const cps = Math.max(20, opts.cps || 55);   // chars per second
    el.textContent = '';
    el.classList.add('afx-typing');
    let done = false;
    const finish = () => { if (done) return; done = true; el.textContent = text; el.classList.remove('afx-typing'); if (opts.onDone) opts.onDone(); };
    const guard = setTimeout(finish, (text.length / cps) * 1000 + 300);   // hidden-tab backstop: full text always lands
    const start = now();
    (function frame(t0) {
      if (done) return;
      const shown = Math.min(text.length, Math.floor(((t0 - start) / 1000) * cps));
      el.textContent = text.slice(0, shown);
      if (shown < text.length) raf(frame);
      else { clearTimeout(guard); finish(); }
    })(start);
  }

  /* ── FRAME : wrap text in a box-drawing frame (decorative, no motion) ──────────────────────────
     Returns a multi-line string; caller drops it into a <pre>/monospace slot. Single vs double rule
     via opts.double. Centers each line to the widest. */
  function frame(text, opts) {
    opts = opts || {};
    const lines = String(text == null ? '' : text).split('\n');
    const w = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const pad = Math.max(0, opts.pad == null ? 1 : opts.pad);
    const inner = w + pad * 2;
    const B = opts.double
      ? { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' }
      : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
    const bar = B.h.repeat(inner);
    const body = lines.map(l => {
      const room = inner - l.length;
      const left = Math.floor(room / 2), right = room - left;
      return B.v + ' '.repeat(left) + l + ' '.repeat(right) + B.v;
    });
    return [B.tl + bar + B.tr, ...body, B.bl + bar + B.br].join('\n');
  }

  /* ── BAR : a text-cell progress bar — '▮▮▮▯▯▯▯▯▯▯' for frac 0..1 ───────────────────────────────
     Pure string helper (the "animation" is the caller re-rendering as the value ticks — deliberate,
     chunky, CRT-honest cells rather than a sliding fill). Honesty rounding: any nonzero fraction
     lights at least one cell (4% never reads as empty next to a "4%" numeral), and only a truly
     full fraction lights them all (96% never reads as full). opts.on / opts.off override glyphs. */
  function bar(frac, cells, opts) {
    opts = opts || {};
    const N = Math.max(1, (cells | 0) || 10);
    frac = Number(frac); if (!isFinite(frac)) frac = 0;
    if (frac < 0) frac = 0; if (frac > 1) frac = 1;
    let on = Math.round(frac * N);
    if (frac > 0 && on < 1) on = 1;
    if (frac < 1 && on > N - 1) on = N - 1;
    const ON = opts.on || '▮', OFF = opts.off || '▯';
    return ON.repeat(on) + OFF.repeat(N - on);
  }

  /* ── BAR CELLS : the same bar at DOUBLE resolution — { full, half, off } cell counts ─────────────
     bar() rounds to whole cells, which is right for a coarse readout but too blunt for a gauge over a
     big range: at ten cells on a 200k context window one cell is 20,000 tokens, so 7% and 14% paint
     identically and the bar looks frozen through most of a real session. This floors the lit cells and
     reports whether the remainder deserves a HALF cell, giving 20 steps in the same width — the caller
     renders that half as the same glyph at reduced opacity, so no new glyph can fall out of the VT323
     face and change the cell width mid-bar.

     The two honesty rules bar() enforces are kept verbatim, because they are the reason the bar can be
     trusted next to the numeral: any nonzero fraction lights SOMETHING (4% never reads as empty), and
     only a genuinely full fraction lights every cell (96% never reads as full). */
  function barCells(frac, cells) {
    const N = Math.max(1, (cells | 0) || 10);
    frac = Number(frac); if (!isFinite(frac)) frac = 0;
    if (frac < 0) frac = 0; if (frac > 1) frac = 1;
    let full = Math.floor(frac * N);
    let rem = frac * N - full;
    if (frac >= 1) { full = N; rem = 0; }
    else if (full >= N) { full = N - 1; rem = 0.99; }   // just under full can never light them all
    let half = rem >= 0.5;
    if (frac > 0 && full === 0 && !half) half = true;   // nonzero always lights at least the half cell
    return { full: full, half: half, off: Math.max(0, N - full - (half ? 1 : 0)), cells: N };
  }

  return { reduced, scramble, dissolveIn, typewriter, frame, bar, barCells };
})();
