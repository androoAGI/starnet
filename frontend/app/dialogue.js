/* StarNet — dialogue.js : THE FOCUSED DIALOGUE MODE (Fallout-style first-run conversation).

   The first three minutes (the awakening's questions + the first-command tutorial) used to live as
   tappable chips in the COMMS scroll. That invited TYPING — and typed answers fell through or looped,
   because the flow only ever advanced on a tap. This module replaces that with a single, focused
   dialogue surface that TRANSFORMS COMMS while it's open: one short line at a time, a list of
   selectable response options (click OR number key), and an always-available "✎ say it in my own
   words" custom box. Input is captured deterministically — nothing falls through, nothing loops.

   It is pure presentation: it never writes a doc or grants a power itself. onboarding.js and tutorial.js
   drive it (Dialogue.say for narration, Dialogue.node for a choice) and do the real work. It mounts as a
   child overlay of #chat-panel so it naturally covers COMMS and follows the layout; if COMMS is absent it
   falls back to a fixed panel. Promise-based so the callers can `await` each beat in a flat, readable flow.

   Honest by construction: it shows exactly the words/options its caller passes — no invented capability
   claims live here (that's the truthful-telemetry law, enforced where the powers actually are). */
'use strict';

const Dialogue = (() => {
  let host = null, panel = null, speakerEl = null, lineEl = null, optsEl = null, moreEl = null;
  let stageEl = null, stageTitle = '', stageDetail = '';
  let inkEl = null, inkTimer = null;   // the operating-file ink stamp — shows a dossier write LANDING
  let open = false, name = 'AGENT';
  let typer = null;            // active typewriter cancel handle
  let keyHandler = null;       // active option/number keydown handler
  let skipNow = null;          // active "reveal the rest of this beat now" handle (fires onDone, unlike typer)
  let gate = null;             // armed read-gate: { resolve, onKey, onClick } — narration waits here for the Commander
  let pendingSay = null;       // the in-flight say()'s idempotent finish — teardown flushes it even MID-TYPE
                               // (cancelType drops onDone by design, so without this a close during typing
                               // would strand the awaiting flow forever)

  // GENESIS never leaves a mind nameless-yet-labelled. If the Commander wakes an overseer without typing a name,
  // the flow used to fall back to the bland literal 'AGENT' (name = n || name) with no nudge — a blank ceremony.
  // Instead, mint a station codename: eerie-not-cute, single-word, machine-designation flavour (matching the
  // seeded NOVA / VENOM / ULTRON tone), uppercased and clamped to the 18-char nameplate cap. Deterministic pool,
  // random pick — every silent awakening still gets a real name, never the generic placeholder.
  const CODENAMES = [
    'NOVA', 'VESPER', 'ONYX', 'HALCYON', 'ORACLE', 'CIPHER', 'VANTA', 'ECHO',
    'WRAITH', 'SABLE', 'QUASAR', 'OBSIDIAN', 'PHANTOM', 'ZEPHYR', 'HELIX', 'RAVEN',
    'PROXIMA', 'ATLAS', 'SPECTER', 'CINDER', 'VECTOR', 'MERIDIAN', 'UMBRA', 'PULSAR',
  ];
  // a blank/whitespace/placeholder name has no real identity behind it — treat it as "unnamed" so the caller's
  // empty WAKE input and the bland 'AGENT' sentinel both route to a minted codename, never to a dead label.
  function isUnnamed(n) { const s = String(n == null ? '' : n).trim().toUpperCase(); return !s || s === 'AGENT'; }
  function codename() { return CODENAMES[Math.floor(Math.random() * CODENAMES.length)].slice(0, 18); }
  // resolve a caller-supplied name to a real one: a typed name is honoured (trimmed, capped); a blank/placeholder
  // mints a codename ONCE and remembers it, so the speaker label stays stable for the rest of the ceremony.
  let minted = '';
  function resolveName(n) {
    const s = String(n == null ? '' : n).trim();
    if (s && !isUnnamed(s)) return s.slice(0, 18);
    if (!minted) minted = codename();
    return minted;
  }

  const sfx = n => { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} };
  const reduceMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } };
  function seg(text, cps, hold) { return { text: String(text == null ? '' : text), cps: cps || 46, holdAfter: hold || 0 }; }
  function norm(lines) {
    if (lines == null) return [];
    if (typeof lines === 'string') return [seg(lines)];
    if (!Array.isArray(lines)) return [seg(String(lines))];
    return lines.map(l => (typeof l === 'string') ? seg(l) : seg(l.text, l.cps, l.holdAfter));
  }

  // set the speaker label. A real typed name is honoured; a blank/placeholder mints (and remembers) a station
  // codename so the awakening never shows the bland generic 'AGENT'. Never hard-blocks — the flow always advances.
  function setName(n) { name = resolveName(n); if (speakerEl) speakerEl.textContent = name; }

  /* mount the panel as a child of COMMS (#chat-panel) so it covers the conversation and tracks layout. */
  function ensure() {
    if (panel) return;
    host = document.getElementById('chat-panel');
    panel = document.createElement('div');
    panel.className = 'fnv-dialogue' + (reduceMotion() ? ' no-anim' : '');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Agent conversation');
    panel.setAttribute('aria-live', 'polite');
    stageEl = document.createElement('div'); stageEl.className = 'fnv-stage';
    renderStage();
    speakerEl = document.createElement('div'); speakerEl.className = 'fnv-speaker'; speakerEl.textContent = name;
    lineEl = document.createElement('div'); lineEl.className = 'fnv-line';
    // the read-gate cue: a quiet blinking prompt under the line. Hidden until a narration beat finishes typing;
    // the beat then WAITS for the Commander (space / enter / click) instead of rolling on at machine speed.
    moreEl = document.createElement('button'); moreEl.className = 'fnv-more'; moreEl.type = 'button';
    moreEl.textContent = 'Continue →';
    moreEl.setAttribute('aria-label', 'Continue conversation');
    // the ink stamp: a quiet one-line receipt under the beat showing an answer landing in the operating
    // file. Callers (onboarding) fire it ONLY beside a real DossierStore write — truthful telemetry: the
    // stamp is a receipt for a write that happened, never theater.
    inkEl = document.createElement('div'); inkEl.className = 'fnv-ink';
    optsEl = document.createElement('div'); optsEl.className = 'fnv-opts';
    panel.appendChild(stageEl); panel.appendChild(speakerEl); panel.appendChild(lineEl); panel.appendChild(moreEl); panel.appendChild(inkEl); panel.appendChild(optsEl);
    if (host) { host.classList.add('fnv-host'); host.appendChild(panel); }
    else { panel.classList.add('fnv-floating'); document.body.appendChild(panel); }   // COMMS missing → free-floating fallback
  }

  function renderStage() {
    if (!stageEl) return;
    stageEl.textContent = stageTitle + (stageDetail ? ' · ' + stageDetail : '');
    stageEl.hidden = !stageTitle;
  }
  function setStage(title, detail) {
    stageTitle = String(title || ''); stageDetail = String(detail || ''); renderStage();
  }

  function openPanel(opts) {
    // resolve the speaker name BEFORE the panel paints so a blank/placeholder WAKE mints a codename up front
    // (never a flash of the generic 'AGENT'). resolveName honours a real typed name and mints only when unnamed.
    name = resolveName(opts && opts.name);
    ensure();
    open = true;
    if (speakerEl) speakerEl.textContent = name;
    document.body.classList.add('fnv-mode');
    if (panel) panel.classList.add('show');
  }
  function flushSay() { if (pendingSay) { const f = pendingSay; pendingSay = null; try { f(); } catch (_) {} } }

  function closePanel() {
    cancelType(); clearKeys(); clearOpts();
    clearGate(true);      // a torn-down panel FLUSHES a waiting narration beat — an awaiting caller must never hang
    flushSay();           // …including one still MID-TYPE (cancelType dropped its onDone, so the gate never armed)
    pendingPick = null;   // a torn-down panel must never leave a stale question armed for Dialogue.answer
    open = false;
    if (inkTimer) { clearTimeout(inkTimer); inkTimer = null; }
    document.body.classList.remove('fnv-mode');
    if (host) host.classList.remove('fnv-host');
    if (panel) panel.remove();
    panel = speakerEl = lineEl = optsEl = moreEl = inkEl = stageEl = host = null;
    stageTitle = stageDetail = '';
  }

  /* THE INK STAMP — show one line landing in the operating file ("» filed · pain: …"). Non-blocking:
     it rides under the current beat, holds a few seconds, and fades; a new stamp replaces the last.
     The caller owns truthfulness — fire it only beside a real dossier write, with the stored text. */
  function ink(line) {
    const t = String(line == null ? '' : line).trim();
    if (!inkEl || !t) return;
    inkEl.textContent = '» filed · ' + t;
    inkEl.classList.add('show');
    if (inkTimer) clearTimeout(inkTimer);
    inkTimer = setTimeout(() => { if (inkEl) inkEl.classList.remove('show'); inkTimer = null; }, 4600);
  }

  function cancelType() { if (typer) { try { typer(); } catch (_) {} typer = null; } skipNow = null; }
  function clearKeys() { if (keyHandler) { window.removeEventListener('keydown', keyHandler); keyHandler = null; } }
  function clearOpts() { if (optsEl) optsEl.innerHTML = ''; }

  // keys that belong to a real text field (the COMMS composer, a panel input) must never drive the dialogue —
  // the same guard the option picker uses (the awakening answer-swallow bug, 2026-07-20).
  function fromTextField(e) {
    const t = e && e.target;
    return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
  }

  /* the READ GATE — after a narration beat finishes typing, hold it on screen until the Commander advances
     (space / enter, or a click on the panel). This is the fix for the onboarding "text rolls on before I can
     read it" complaint: a beat REPLACES the previous one, so auto-advance was destroying unread words.
     clearGate(true) fires the held resolve — teardown paths use it so an awaiting flow can never hang. */
  function clearGate(fire) {
    if (!gate) return;
    const g = gate; gate = null;
    window.removeEventListener('keydown', g.onKey);
    if (panel) { panel.removeEventListener('click', g.onClick); panel.classList.remove('fnv-wait'); }
    if (moreEl) moreEl.classList.remove('show');
    if (fire) { try { g.resolve(); } catch (_) {} }
  }
  function armGate(resolve) {
    clearGate(true);
    if (!panel) { resolve(); return; }
    const fire = e => { if (e && e.preventDefault) e.preventDefault(); sfx('click'); clearGate(true); };
    const onKey = e => {
      if (fromTextField(e)) return;
      if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') fire(e);
    };
    const onClick = () => fire();
    gate = { resolve, onKey, onClick };
    if (moreEl) moreEl.classList.add('show');
    panel.classList.add('fnv-wait');
    window.addEventListener('keydown', onKey);
    panel.addEventListener('click', onClick);
  }

  /* typewriter into the single line area — REPLACES the previous beat (never accumulates a scroll). That
     "one beat at a time" is the whole anti-wall-of-text move. onDone ALWAYS fires (even if cancelled). */
  function typeInto(segs, onDone) {
    cancelType();
    if (!lineEl) { if (onDone) onDone(); return; }
    lineEl.textContent = '';
    let si = 0, ci = 0, killed = false, charN = 0;
    const timers = [];
    // impatient tap DURING typing → reveal the whole beat at once and land in the same place a full
    // type-out would (done fires, so a say() gate arms / a node()'s options render immediately).
    const onSkipKey = e => { if (fromTextField(e)) return; if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') { e.preventDefault(); if (skipNow) skipNow(); } };
    const onSkipClick = () => { if (skipNow) skipNow(); };
    function disarmSkip() {
      skipNow = null;
      window.removeEventListener('keydown', onSkipKey);
      if (panel) panel.removeEventListener('click', onSkipClick);
    }
    function done() { typer = null; disarmSkip(); if (onDone) try { onDone(); } catch (_) {} }
    function step() {
      if (killed) return;
      if (si >= segs.length) { done(); return; }
      const s = segs[si];
      const text = s.text;
      if (ci >= text.length) { si++; ci = 0; timers.push(setTimeout(step, s.holdAfter != null ? s.holdAfter : 0)); return; }
      lineEl.textContent += text[ci++];
      if ((charN++ % 2) === 0 && text[ci - 1] !== ' ') sfx('type');
      const cps = s.cps || 46;
      const base = 1000 / cps;
      const jitter = base * (0.6 + Math.random() * 0.5);
      timers.push(setTimeout(step, reduceMotion() ? 0 : jitter));
    }
    if (reduceMotion()) { lineEl.textContent = segs.map(s => s.text).join(''); done(); return; }
    typer = () => { killed = true; disarmSkip(); timers.forEach(clearTimeout); lineEl && (lineEl.textContent = segs.map(s => s.text).join('')); };
    skipNow = () => { if (killed) return; killed = true; timers.forEach(clearTimeout); if (lineEl) lineEl.textContent = segs.map(s => s.text).join(''); done(); };
    window.addEventListener('keydown', onSkipKey);
    if (panel) panel.addEventListener('click', onSkipClick);
    step();
  }

  /* NARRATION — type a short beat, no options. By default the beat then WAITS for the Commander
     (space / enter / click, cue = the blinking ▸ row) before resolving — a beat replaces the previous
     one, so rolling on at machine speed was erasing words nobody had finished reading (the onboarding
     "text moves too fast" complaint). A tap mid-type reveals the full beat first, then a tap advances.
     opts.auto = true keeps the old fixed-settle auto-advance — ONLY for transient latency-cover lines
     ("give me a second…") where the flow is about to do real async work and must not block on a click. */
  function say(lines, opts) {
    const auto = !!(opts && opts.auto);
    return new Promise(resolve => {
      ensure(); clearKeys(); clearOpts(); clearGate(true); flushSay();
      let settled = false;
      const finish = () => { if (settled) return; settled = true; if (pendingSay === finish) pendingSay = null; resolve(); };
      pendingSay = finish;   // teardown (closePanel) or a superseding beat flushes this even mid-type
      typeInto(norm(lines), () => {
        if (auto) { setTimeout(finish, 260); return; }
        armGate(finish);
      });
    });
  }

  /* A CHOICE NODE — type the prompt, then render selectable options (+ optional custom box).
     cfg: { lines, options:[{label,value,skip}], allowCustom, customPlaceholder, customLabel }
     Resolves to { value, label, skip, custom }. Exactly one resolution; all handlers torn down first. */
  function node(cfg) {
    cfg = cfg || {};
    return new Promise(resolve => {
      ensure(); clearKeys(); clearOpts(); clearGate(true); flushSay();
      let settled = false;
      const finishPick = res => { if (settled) return; settled = true; pendingPick = null; clearKeys(); sfx('click'); resolve(res); };
      typeInto(norm(cfg.lines), () => renderOptions(cfg, finishPick));
    });
  }

  // the COMMS composer path into the pending question (the awakening's "answer to wake your agent…" input).
  // While a free-text question (allowCustom) is on screen, text typed in the main composer resolves it exactly
  // like the inline ✎ input would — the Commander's words must NEVER be silently swallowed just because they
  // answered in the obvious box. Option-only nodes (the fork, the mirror picks) return false: a typed sentence
  // can't safely map onto a fixed choice, so the caller keeps its options up. No pending node → false (no-op).
  let pendingPick = null;
  function answer(text) {
    if (!pendingPick || !pendingPick.cfg || !pendingPick.cfg.allowCustom) return false;
    const v = String(text == null ? '' : text).trim();
    const p = pendingPick;
    if (!v) { if (p.cfg.skipOnEmpty) p.finishPick({ value: '', skip: true, custom: true }); return true; }
    p.finishPick({ value: v, label: v, custom: true });
    return true;
  }

  function renderOptions(cfg, finishPick) {
    if (!optsEl) { finishPick({ value: '', skip: true }); return; }
    pendingPick = { cfg, finishPick };   // arm the composer path (Dialogue.answer) for THIS question
    optsEl.innerHTML = '';
    const opts = (cfg.options || []).slice();
    const rows = [];
    opts.forEach((o, idx) => {
      const b = document.createElement('button');
      b.className = 'fnv-opt' + (o.skip ? ' skip' : '');
      b.type = 'button';
      const num = document.createElement('span'); num.className = 'fnv-num'; num.textContent = (idx + 1) + '.';
      const lbl = document.createElement('span'); lbl.className = 'fnv-opt-l'; lbl.textContent = o.label;
      b.appendChild(num); b.appendChild(lbl);
      b.onclick = () => finishPick({ value: o.value != null ? o.value : o.label, label: o.label, skip: !!o.skip });
      optsEl.appendChild(b); rows.push(b);
    });
    let customBtn = null;
    if (cfg.allowCustom) {
      customBtn = document.createElement('button');
      customBtn.className = 'fnv-opt custom'; customBtn.type = 'button';
      const num = document.createElement('span'); num.className = 'fnv-num'; num.textContent = '✎';
      const lbl = document.createElement('span'); lbl.className = 'fnv-opt-l'; lbl.textContent = cfg.customLabel || 'say it in my own words';
      customBtn.appendChild(num); customBtn.appendChild(lbl);
      customBtn.onclick = () => openCustom(cfg, finishPick);
      optsEl.appendChild(customBtn); rows.push(customBtn);
    }
    // OPT-IN escape hatch (mid-game asks, Andrew): a caller that presents a *sequence* of asks (e.g. the schedule
    // proposals) passes dismissable:true so Esc — or a quiet "✕ dismiss" row — resolves the node with dismissed:true,
    // letting the caller abandon the WHOLE flow, not just skip one. The GENESIS awakening never sets this, so its
    // ceremony is unchanged (no accidental early-exit from the birth).
    if (cfg.dismissable) {
      const d = document.createElement('button');
      d.className = 'fnv-opt skip dismiss'; d.type = 'button';
      const num = document.createElement('span'); num.className = 'fnv-num'; num.textContent = '✕';
      const lbl = document.createElement('span'); lbl.className = 'fnv-opt-l'; lbl.textContent = cfg.dismissLabel || 'dismiss — not now';
      d.appendChild(num); d.appendChild(lbl);
      d.onclick = () => finishPick({ value: '', skip: true, dismissed: true });
      optsEl.appendChild(d);
    }
    // keyboard: number keys pick an option; the trailing custom row is selectable too.
    keyHandler = e => {
      // typing that belongs to a real text field (the COMMS composer, a panel input) must NEVER drive the
      // picker — before this guard, digits typed in the composer silently clicked options and Enter hijacked
      // the flow into the ✎ box mid-sentence (the awakening answer-swallow bug, 2026-07-20).
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape' && cfg.dismissable) { e.preventDefault(); finishPick({ value: '', skip: true, dismissed: true }); return; }
      if (e.key === 'Enter' && cfg.allowCustom) { e.preventDefault(); openCustom(cfg, finishPick); return; }
      const n = parseInt(e.key, 10);
      if (!isNaN(n) && n >= 1 && n <= rows.length) { e.preventDefault(); rows[n - 1].click(); }
    };
    window.addEventListener('keydown', keyHandler);
  }

  /* the custom-speech path — swaps the option list for an input. Enter or ▸ submits; ‹ back restores
     the options. An empty submit on an optional node reads as a skip (caller decides via cfg.skipOnEmpty). */
  function openCustom(cfg, finishPick) {
    clearKeys();
    if (!optsEl) return;
    optsEl.innerHTML = '';
    const wrap = document.createElement('div'); wrap.className = 'fnv-custom';
    const inp = document.createElement('textarea'); inp.rows = 3; inp.className = 'fnv-custom-in';
    inp.placeholder = cfg.customPlaceholder || 'type your answer…';
    inp.setAttribute('aria-label', cfg.customPlaceholder || 'your answer');
    const send = document.createElement('button'); send.className = 'fnv-custom-send'; send.type = 'button'; send.textContent = 'Send →'; send.setAttribute('aria-label', 'Send answer');
    const back = document.createElement('button'); back.className = 'fnv-custom-back'; back.type = 'button'; back.textContent = '‹ back';
    wrap.appendChild(back); wrap.appendChild(inp); wrap.appendChild(send);
    optsEl.appendChild(wrap);
    const submit = () => {
      const v = inp.value.trim();
      if (!v) { if (cfg.skipOnEmpty) finishPick({ value: '', skip: true, custom: true }); else inp.focus(); return; }
      finishPick({ value: v, label: v, custom: true });
    };
    send.onclick = submit;
    back.onclick = () => { clearKeys(); renderOptions(cfg, finishPick); };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); back.onclick(); }
    });
    setTimeout(() => inp.focus(), 30);
  }

  // codename() is also exported so the WAKE funnel (app.js) can persist a real minted name instead of the bland
  // 'AGENT' when the Commander leaves the name blank — keeping the world nameplate / dossier consistent with the
  // speaker label. isUnnamed() lets a caller cheaply detect the blank/placeholder case.
  return { open: openPanel, close: closePanel, say, node, answer, setName, setStage, ink, isOpen: () => open, codename, isUnnamed };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Dialogue };
