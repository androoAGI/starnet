/* Agent OS — dialogue.js : THE FOCUSED DIALOGUE MODE (Fallout-style first-run conversation).

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
  let offer = null;            // a MID-GAME OFFER's own ways out { notNow(), stepAside(why) } — see armOffer
  let offerKey = null, offerUnwatch = null;   // its Esc listener + its layout watcher's teardown

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
  /* THE DOOR LAW (systems.js): a line that names a station system brings it online. COMMS lines already did; the awakening and
     the quick tour speak HERE, so on a fresh station they sent the Commander to WORK › AUTOMATE › WORKFLOWS (or CONNECT ›
     ABILITIES) while that dock button was still hidden. */
  function doorLaw(segs, extra) {
    if (typeof Systems === 'undefined' || !Systems.noticeReply) return;
    Systems.noticeReply(segs.map(x => x.text).concat(extra || []).join(' '));
  }
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
    panel.classList.toggle('fnv-tour', !!(opts && opts.tour));
    open = true;
    if (speakerEl) speakerEl.textContent = name;
    document.body.classList.add('fnv-mode');
    if (panel) panel.classList.add('show');
    armOffer(opts && opts.offer);
  }

  /* AN OFFER NEVER STANDS OVER WHAT NEEDS THE COMMANDER (soak 2026-10-15). The goal-path confirm opened over COMMS mid-
     conversation, and inset:0 covered the transcript AND the message box: a team.dispatch approval that landed under it took
     19 approve clicks that all hit .fnv-line, a new conversation's message box sat under .fnv-opts, and Esc did nothing. The
     awakening, the quick tour and the first-task hand-off still own the whole of COMMS — they ARE the conversation. A caller
     that OFFERS something mid-game passes `offer: { notNow, stepAside }`, and then:
     · the panel ends above the message box and its queued-message pills, so typing is never covered (refit as they grow);
     · Esc answers it the way its own "not now" key does (offer.notNow) — but only an Esc aimed at it: nothing focused, its own
       keys, or the message box. ONE Esc, ONE owner (review 10-15): never a station field's, never one the message box used (it
       stops a run, closes the / menu), never one on another key (the model dock's chips, Local Live, a transcript card), and
       never one a document-level owner marked used (the model dock closing, Local Live ending) — that would be a false decline;
     · Dialogue.stepAside(why) hands the moment back (offer.stepAside): COMMS calls it when an approval or question reaches the
       Commander and when they send a turn, and the caller closes the panel unanswered, as a delivery landing already does. */
  function armOffer(o) {
    disarmOffer();
    offer = (o && typeof o === 'object') ? o : null;
    if (!panel) return;
    panel.classList.toggle('fnv-offer', !!offer);
    if (!offer) { panel.style.bottom = ''; return; }
    if (host) host.classList.add('fnv-offer-host');   // app.css lifts the message box over the panel: its / menu and model dock open upward
    offerKey = e => {
      if (!open || !offer || !e || e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target;
      if (fromTextField(e) && !(t && t.id === 'chat-input')) return;   // a station field's Esc is that field's
      const aimed = !t || t.nodeType !== 1 || t === document.body || t === document.documentElement || t.id === 'chat-input' || (panel && panel.contains(t));
      if (!aimed) return;   // any other key's Esc (in COMMS or another surface) is that key's
      e.preventDefault();
      if (typeof offer.notNow === 'function') offer.notNow();
    };
    window.addEventListener('keydown', offerKey);
    fitOffer();
    if (!host) return;   // the free-floating fallback is already a small corner panel
    const refit = () => fitOffer();
    // the transcript is the stretchy row: it shrinks whenever anything under it grows (pills, the @ menu, a long draft)
    const watched = [host].concat(OFFER_WATCH.map(id => document.getElementById(id))).filter(Boolean);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(refit) : null;
    if (ro) watched.forEach(n => ro.observe(n));
    window.addEventListener('resize', refit);
    offerUnwatch = () => { if (ro) ro.disconnect(); window.removeEventListener('resize', refit); };
  }
  function disarmOffer() {
    if (offerKey) { window.removeEventListener('keydown', offerKey); offerKey = null; }
    if (offerUnwatch) { offerUnwatch(); offerUnwatch = null; }
    if (host) host.classList.remove('fnv-offer-host');
    offer = null;
  }
  // the composer stack under the transcript: the queued-message pills, the @ menu (group chat puts it above the box), the box
  const COMPOSER_STACK = ['chat-queued', 'gc-mentions', 'chat-inputrow'];
  const OFFER_WATCH = ['chat-log', 'group-chat'].concat(COMPOSER_STACK);
  // the top of the composer stack in the host's own px. Rects are VISUAL px under the TEXT SIZE body zoom while the panel's
  // style px are layout px: scale once (the uiZoom law). null = no composer laid out (COMMS hidden: the panel keeps inset 0).
  function composerTop() {
    if (!host || !host.getBoundingClientRect) return null;
    const hr = host.getBoundingClientRect();
    const k = host.offsetHeight ? (hr.height / host.offsetHeight) || 1 : 1;
    let top = null;
    for (const id of COMPOSER_STACK) {
      const n = document.getElementById(id);
      if (!n || !host.contains(n) || !n.getBoundingClientRect) continue;
      const r = n.getBoundingClientRect();
      if (!(r.height > 0)) continue;   // an empty pill strip has no box
      const y = (r.top - hr.top) / k - (host.clientTop || 0);
      if (top == null || y < top) top = y;
    }
    return top;
  }
  function fitOffer() {
    if (!panel || !offer || !host) return;
    const top = composerTop();
    panel.style.bottom = (top != null && top > 0) ? Math.max(0, Math.round(host.clientHeight - top)) + 'px' : '';
  }
  // hand the moment back to an open offer's caller (an approval / question landed, the Commander sent a turn). Returns whether
  // an offer was there to step aside; a panel with no offer (the awakening, the tour, the first-task hand-off) is never yanked.
  function stepAside(why) {
    if (!open || !offer || typeof offer.stepAside !== 'function') return false;
    offer.stepAside(String(why || ''));
    return true;
  }
  function flushSay() { if (pendingSay) { const f = pendingSay; pendingSay = null; try { f(); } catch (_) {} } }

  function closePanel() {
    const wasOpen = open;
    disarmOffer();
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
    // COMMS is uncovered again: a hint that points at COMMS (navdock's coach) waits for this (org P31 review fix).
    if (wasOpen && typeof document !== 'undefined' && typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('starnet:dialogue-closed'));
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
      const segs = norm(lines); doorLaw(segs);
      typeInto(segs, () => {
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
      panel.classList.toggle('fnv-text-first', !!(cfg.allowCustom && cfg.customFirst));
      let settled = false;
      const finishPick = res => { if (settled) return; settled = true; pendingPick = null; clearKeys(); sfx('click'); resolve(res); };
      const segs = norm(cfg.lines); doorLaw(segs, (cfg.options || []).map(o => String((o && o.label) || '')));
      typeInto(segs, () => renderOptions(cfg, finishPick));
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
    if (cfg.allowCustom && cfg.customFirst) {
      renderConversation(cfg, finishPick);
      return;
    }
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
      if (e.key === 'Escape' && cfg.dismissable && !e.defaultPrevented) { e.preventDefault(); finishPick({ value: '', skip: true, dismissed: true }); return; }   // an Esc another owner used (the model dock, Local Live) is not a dismiss
      if (e.key === 'Enter' && cfg.allowCustom) { e.preventDefault(); openCustom(cfg, finishPick); return; }
      const n = parseInt(e.key, 10);
      if (!isNaN(n) && n >= 1 && n <= rows.length) { e.preventDefault(); rows[n - 1].click(); }
    };
    window.addEventListener('keydown', keyHandler);
  }

  // Interview answers start with the user's own words. Suggestions are optional prompts,
  // never prefilled answers, and opening one preserves the draft and the original question.
  function renderConversation(cfg, finishPick) {
    const wrap = document.createElement('div'); wrap.className = 'fnv-custom fnv-conversation';
    const inp = document.createElement('textarea'); inp.rows = 3; inp.className = 'fnv-custom-in';
    inp.placeholder = cfg.customPlaceholder || 'type your answer…';
    inp.setAttribute('aria-label', 'Your answer');
    const send = document.createElement('button'); send.className = 'fnv-custom-send'; send.type = 'button';
    inp.value = cfg.customValue || '';
    send.textContent = cfg.submitLabel || 'Send →'; send.disabled = !inp.value.trim();
    const submit = () => {
      const value = inp.value.trim();
      if (value) finishPick({ value, label: value, custom: true });
    };
    inp.addEventListener('input', () => { send.disabled = !inp.value.trim(); if (cfg.onCustomInput) cfg.onCustomInput(inp.value); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    });
    send.onclick = submit;
    wrap.appendChild(inp); wrap.appendChild(send); optsEl.appendChild(wrap);
    const suggestions = (cfg.options || []).filter(o => !o.skip && !o.open && !o.help);
    if (suggestions.length) {
      const details = document.createElement('details'); details.className = 'fnv-suggestions';
      const summary = document.createElement('summary'); summary.textContent = 'Need a starting point?';
      details.appendChild(summary);
      const hint = document.createElement('div'); hint.className = 'fnv-answer-hint'; hint.setAttribute('aria-live', 'polite');
      suggestions.forEach(o => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'fnv-opt'; b.textContent = o.label;
        b.onclick = () => {
          hint.textContent = o.steer || ('Tell me what “' + o.label + '” means for you.');
          inp.focus();
        };
        details.appendChild(b);
      });
      details.appendChild(hint); optsEl.appendChild(details);
    }
    (cfg.options || []).filter(o => o.skip || o.open || o.help).forEach(o => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fnv-opt skip'; b.textContent = o.label;
      b.onclick = () => finishPick({ value: o.value == null ? '' : o.value, label: o.label, skip: !!o.skip, help: !!o.help });
      optsEl.appendChild(b);
    });
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
  /* THE TOUR YIELDS (2026-09-27 conveyor audit R3). The quick tour's panel covers the COMMS column, and it stays up until one of
     its options is picked — so a card the Commander explicitly asked for elsewhere (clicking the INBOX on the floor posts the
     ONE-REAL-JOB card into COMMS) landed hidden under it, and the click read as dead. yieldTour() answers the tour's own way
     out — its skip option, or the option it marks `yield` (the step that leaves the tour for the first task) — the same pick
     a click on that button makes, so no new state exists. Returns true when the tour stepped aside. */
  function yieldTour() {
    if (!open || !panel || !panel.classList.contains('fnv-tour') || !pendingPick || !pendingPick.cfg) return false;
    const opts = Array.isArray(pendingPick.cfg.options) ? pendingPick.cfg.options : [];
    const out = opts.find(o => o && o.skip) || opts.find(o => o && o.yield);
    if (!out) return false;
    pendingPick.finishPick({ value: out.value != null ? out.value : out.label, label: out.label, skip: !!out.skip });
    return true;
  }
  return { open: openPanel, close: closePanel, say, node, answer, setName, setStage, ink, yieldTour, stepAside, isOpen: () => open, codename, isUnnamed };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Dialogue };
