/* STARNET — keycta.js : the honest "your agent is awake but has no working brain" call-to-action.

   THE ASYMMETRY THIS CLOSES: a Commander can complete the ENTIRE awakening with no key configured — the
   ceremony degrades to its scripted spine (no live model), the agent ends up "ready" on screen, yet the
   first real task would fail with harness.js's honest 'no API key set'. This surfaces that gap the moment
   the awakening lands, in the world, as ONE standing banner pointing at SETTINGS.

   TRUTHFUL TELEMETRY (the product's core law): the banner is a PURE PROJECTION of backend state. It shows
   IFF the active provider genuinely needs a key AND `Harness.hasStoredCredential` reports none is stored
   (never fabricated by DEVMODE, unlike configured()). The instant a key lands it re-evaluates and vanishes —
   it can never assert a missing connection that actually exists, nor linger once one does. A Codex (OAuth)
   or ollama/custom (keyless-by-design) station never trips it. */
'use strict';

const KeyCTA = (() => {
  const el = id => document.getElementById(id);
  let armed = false;      // only after an awakening lands (arm()) — never on the connect screen / mid-ceremony
  let timer = null;
  let spoke = false;      // the diegetic "i'm awake but no brain is wired" COMMS line fires at most ONCE per arm cycle
  let spokenState = '', spokenLine = null, spokenChoices = null;

  function normProv(p) {
    p = String(p || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'grok' || p === 'grok-oauth' || p === 'supergrok') return 'grok';
    if (p === 'kimi' || p === 'moonshot' || p === 'kimi-for-coding') return 'kimi';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return p;
  }
  function providerNeedsKey(p) {
    p = normProv(p);
    // codex/grok/kimi are keyless OAuth sign-ins; ollama/custom are keyless-by-design endpoints.
    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom';
  }
  function activeProvider() {
    return normProv((typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter');
  }
  // Setup gaps only: a missing credential/link or an empty model selection. A null result does not prove
  // endpoint reachability, catalog availability, account balance or a successful inference call.
  // Answers WHAT is missing, not just whether: { kind: 'unlinked' } for the STARNET managed provider on a
  // station with no linked account (its bearer is the device token, never a key the user can paste — issue #6:
  // an unlinked station kept asking for a "STARNET key" that does not exist), or { kind: 'nokey', provider }
  // for a keyed provider with nothing stored; 'nomodel' means the selection is empty.
  function gapOf() {
    // only once the awakening has actually landed (a fully onboarded hero on the floor)
    if (typeof App === 'undefined' || !App.currentAgent) return null;
    const a = App.currentAgent();
    if (!a || !a.onboarded) return null;
    const p = activeProvider();
    const modelGap = () => (typeof Harness !== 'undefined' && Harness.getModel && !String(Harness.getModel() || '').trim())
      ? { kind: 'nomodel', provider: p } : null;
    if (p === 'starnet') {
      // managed credits are configured IFF the sidecar reports a linked account (Harness.configured mirrors
      // /api/credits) — no localStorage key can ever stand in for that.
      try {
        if (typeof Harness !== 'undefined' && Harness.configured) return Harness.configured('starnet') ? modelGap() : { kind: 'unlinked', provider: p };
      } catch (_) {}
      return null;
    }
    if (!providerNeedsKey(p)) return modelGap();
    try {
      if (typeof Harness !== 'undefined' && Harness.hasStoredCredential) return Harness.hasStoredCredential(p) ? modelGap() : { kind: 'nokey', provider: p };
    } catch (_) {}
    return null;
  }
  function missingKey() { return !!gapOf(); }

  // every door out of this banner lands on SETTINGS ▸ PROVIDERS — the one surface that owns keys, the STARNET
  // link, the provider switch and the Ollama endpoint. openTerm's section arg is the console-rail deep link.
  function openSettings() {
    if (typeof StationUI !== 'undefined' && StationUI.openTerm) { StationUI.openTerm('settings', 'providers'); return; }
    const b = document.querySelector('.bb[data-term="settings"]'); if (b) b.click();
  }

  function fixGap() {
    const gap = gapOf();
    if (gap && gap.kind === 'nomodel' && typeof ModelDock !== 'undefined' && ModelDock.open) { ModelDock.open(); return; }
    openSettings();
  }

  function retireObsoletePrompt(gap) {
    const a = typeof App !== 'undefined' && App.currentAgent ? App.currentAgent() : null;
    const state = gap ? [a && a.id, gap.provider, gap.kind].join(':') : '';
    if (state === spokenState) return;
    if (spokenLine && spokenLine.remove) spokenLine.remove();
    if (spokenChoices && spokenChoices.dismiss) spokenChoices.dismiss();
    else if (spokenChoices && spokenChoices.remove) spokenChoices.remove();
    spokenLine = spokenChoices = null;
    spoke = false;
    spokenState = state;
  }

  /* THE FREE LOCAL DOOR — Ollama. TRUTHFUL TELEMETRY: the station may only say "run free locally" once the
     SIDECAR has proven Ollama answers on this machine (Harness.probeProvider → POST /api/providers/probe →
     a live model list from 127.0.0.1:11434). Until then the same button honestly reads "set up ollama" and
     opens the settings entry — it never claims a brain that isn't there. ollamaReady: null = not probed yet. */
  let ollamaReady = null;
  let ollamaProbing = false;
  let ollamaProbedAt = 0;
  const OLLAMA_REPROBE_MS = 30000;
  function probeOllama(force) {
    if (ollamaProbing) return Promise.resolve(ollamaReady);
    if (!force && ollamaReady !== null && (Date.now() - ollamaProbedAt) < OLLAMA_REPROBE_MS) return Promise.resolve(ollamaReady);
    if (typeof Harness === 'undefined' || !Harness.probeProvider) return Promise.resolve(false);
    ollamaProbing = true;
    return Promise.resolve().then(() => Harness.probeProvider('ollama')).then(r => !!(r && r.reachable)).catch(() => false).then(ok => {
      ollamaProbing = false; ollamaReady = ok; ollamaProbedAt = Date.now();
      paintFreeLabel();
      return ok;
    });
  }
  function freeLabel() { return ollamaReady ? '◇ RUN FREE LOCALLY (OLLAMA)' : '◇ SET UP OLLAMA (FREE · LOCAL)'; }
  function paintFreeLabel() {
    const b = el('key-cta'); if (!b) return;
    const f = b.querySelector('.key-cta-free'); if (f) f.textContent = freeLabel();
  }
  // Switch the station's brain to Ollama — but only on a FRESH proof, never on a cached one. An offline
  // Ollama routes to the settings entry with the honest reason instead of silently selecting a dead endpoint.
  function useOllama() {
    return probeOllama(true).then(ok => {
      if (!ok) {
        try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('ollama isn’t answering on this machine yet — install it from ollama.com, pull a model, then pick OLLAMA here', 'bad'); } catch (_) {}
        openSettings();
        return false;
      }
      try { if (typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv('ollama'); } catch (_) {}
      // same reconcile the SETTINGS provider switch runs: a foreign model slug must not ride into the new endpoint
      try {
        if (typeof ModelDock !== 'undefined' && ModelDock.reconcile) ModelDock.reconcile().catch(() => ModelDock.reflect && ModelDock.reflect());
        else if (typeof ModelDock !== 'undefined' && ModelDock.reflect) ModelDock.reflect();
      } catch (_) {}
      try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('brain → OLLAMA (local, free) — no key, no bill. local models run smaller than cloud ones; expect slower, rougher work.', 'good'); } catch (_) {}
      try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('settings'); } catch (_) {}
      render();
      return true;
    });
  }

  // THE DIEGETIC PATH: instead of only a disembodied banner, the AGENT itself says it once in COMMS — the whole
  // rest of the first-run is the agent speaking, so a bare banner breaks the frame (audit A-3). One agent line +
  // one tappable chip that opens the key-entry surface (same route as the banner button — the standardized target
  // KeyCTA already uses; Lane A owns the deeper focus-the-key-field routing, this matches what exists here). The
  // banner stays as the STANDING projection (fires from render()), so if this diegetic hook can't fire (no Chat,
  // or the input is busy) the honest state is never lost. Speaks at most once per arm cycle and only while the
  // key is genuinely still missing at delivery time (pure projection — never asserts a gap that got filled).
  function speakOnce() {
    if (spoke) return;
    if (typeof Chat === 'undefined' || !Chat.localLine || !Chat.choices) return;   // no COMMS surface → banner carries it alone
    if (typeof Chat.isBusy === 'function' && Chat.isBusy()) return;                 // a run is streaming — don't cut a beat in; the 2s tick retries
    const gap = gapOf();
    if (!gap) return;                                                               // re-check at delivery: a key may have landed between arm() and here
    spoke = true;
    let nm = ''; try { if (typeof App !== 'undefined' && App.currentAgent) { const a = App.currentAgent(); nm = (a && a.name) || ''; } } catch (_) {}
    const label = gap.provider.toUpperCase();
    const who = nm ? nm.toLowerCase() + ' — ' : '';
    if (gap.kind === 'nomodel') {
      spokenLine = Chat.localLine(who + 'no model is selected for ' + label + '. choose a model to send a message.');
    } else if (gap.kind === 'unlinked') {
      spokenLine = Chat.localLine(who + 'i’m awake, but no brain is wired: this station isn’t linked to a STARNET account, so i can’t actually run anything yet. link one, wire a different provider, or run me free on a local model.');
    } else {
      spokenLine = Chat.localLine(who + 'i’m awake, but no brain is wired: there’s no ' + label + ' key on the station, so i can’t actually run anything yet. add one, wire a different provider, or run me free on a local model.');
    }
    spokenChoices = Chat.choices([
      { label: primaryLabel(gap), value: 'primary' },
      { label: '⇄ USE A DIFFERENT PROVIDER', value: 'switch', quiet: true },
      { label: freeLabel(), value: 'free', quiet: true }
    ], it => { if (it && it.value === 'free') useOllama(); else if (it && it.value === 'primary') fixGap(); else openSettings(); });   // onPick hands back the chip item
    // Opening the model picker from this external prompt must not also count as its outside click.
    if (spokenChoices && spokenChoices.addEventListener) spokenChoices.addEventListener('click', ev => ev.stopPropagation());
  }

  // ONE label per anchor: the primary door names exactly the thing that is missing.
  function primaryLabel(gap) {
    if (gap && gap.kind === 'nomodel') return '◇ CHOOSE MODEL';
    if (gap && gap.kind === 'unlinked') return '🔗 LINK STARNET';
    return '⚙ ADD ' + ((gap && gap.provider) || activeProvider()).toUpperCase() + ' KEY';
  }
  function bannerText(gap) {
    if (gap.kind === 'nomodel') return 'no model selected for ' + gap.provider.toUpperCase() + ' — choose a model to send a message.';
    if (gap.kind === 'unlinked') return 'your agent is awake — but this station isn’t linked to a STARNET account, so it can’t run a task yet.';
    return 'your agent is awake — but it has no ' + gap.provider.toUpperCase() + ' key, so it can’t run a task yet.';
  }

  function ensureBanner() {
    let b = el('key-cta');
    if (b) return b;
    const wrap = el('stage-wrap');
    if (!wrap) return null;
    b = document.createElement('div');
    b.id = 'key-cta';
    b.className = 'key-cta';
    b.setAttribute('role', 'status');
    b.hidden = true;
    b.innerHTML =
      '<span class="key-cta-glyph" aria-hidden="true">⚠</span>' +
      '<span class="key-cta-txt"></span>' +
      // THREE DOORS, not one: name the missing thing (key / link), offer any other provider, offer the free
      // local path. Issue #6: a single "ADD IN SETTINGS" left an unlinked STARNET pick with no way out.
      '<span class="key-cta-acts">' +
        '<button type="button" class="key-cta-act">⚙ ADD IN SETTINGS</button>' +
        '<button type="button" class="key-cta-alt">⇄ USE A DIFFERENT PROVIDER</button>' +
        '<button type="button" class="key-cta-free">◇ SET UP OLLAMA (FREE · LOCAL)</button>' +
      '</span>';
    b.querySelector('.key-cta-act').addEventListener('click', ev => { ev.stopPropagation(); fixGap(); });
    b.querySelector('.key-cta-alt').addEventListener('click', openSettings);
    b.querySelector('.key-cta-free').addEventListener('click', () => { useOllama(); });
    wrap.appendChild(b);
    return b;
  }

  // pure render off live state — safe to call from a tick, from settings key edits, or from arm()
  function render() {
    const gap = armed ? gapOf() : null;
    retireObsoletePrompt(gap);
    const b = ensureBanner();
    if (!b) return;
    if (!gap) { b.hidden = true; return; }
    b.dataset.gap = gap.kind;
    b.querySelector('.key-cta-txt').textContent = bannerText(gap);
    b.querySelector('.key-cta-act').textContent = primaryLabel(gap);
    paintFreeLabel();
    b.hidden = false;
    probeOllama(false);   // keep the free-door label honest (cached 30s; repaints itself when the answer lands)
    speakOnce();   // deliver the diegetic agent line once COMMS is free (no-op after it fires or once a key lands)
  }

  // begin watching AFTER the awakening lands. Idempotent. A light 2s re-eval is the backstop; settings/key
  // paths also call refresh() for an instant clear, so this never feels laggy.
  function arm() {
    armed = true;
    render();
    if (timer) return;
    timer = setInterval(render, 2000);
  }

  // gapOf / useOllama / providerNeedsKey are exposed for the fast-gate functional test (test/free-path-ollama.test.js)
  return { arm, refresh: render, gapOf, useOllama, providerNeedsKey };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = KeyCTA;
