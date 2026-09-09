/* voice-live.js — persistent local speech session over whichever provider powers the active Starnet agent. */
'use strict';

const VoiceLive = (() => {
  let active = false, ending = false, failed = false, taskTimer = null, modelTimer = null;
  // true while running on the keyless dictation ladder instead of the offline models (see startDictation).
  let dictation = false;
  // ---- NATIVE LIVE CALL (see startRealtime) ----
  // `realtime` is the mode flag; the rest is the live peer connection and its plumbing.
  let realtime = false, pc = null, dataChannel = null, remoteAudio = null, callProvider = '';
  // keeps the live session's picture of the station current without spamming an update every tick
  let contextTimer = null, lastContextFingerprint = '';
  let sessionSeq = 0;
  let stream = null, context = null, source = null, processor = null, sink = null;
  let calibratedUntil = 0, noiseFloor = 0.006, speechFrames = 0, silenceMs = 0;
  let recording = false, utterance = [], utteranceSamples = 0, preRoll = [], transcriptionPending = false, queuedAudio = [];
  let finalTurn = null, paused = false;
  let lastVoicedSamples = 0, partialSnapshot = null;
  let liveStream = null, streamAvailable = false;
  let utteranceSeq = 0, partialPending = false, partialAbort = null, lastPartialAt = 0, partialText = '';
  let finalAbort = null;
  // Dictation-leg meter tap: a levels-only capture (see openMeterTap) plus the clock that scrolls it.
  let tapStream = null, tapContext = null, tapSource = null, tapProcessor = null, tapSink = null;
  let tapLevel = 0, meterClock = null;
  let reconnectTimer = null, reconnectAttempt = 0, transientErrorTimer = null;
  let warmupNotice = false;
  const $ = id => document.getElementById(id);
  const POSITION_KEY = 'starnet.liveVoice.position.v1';
  // Which of the provider's voices speaks. Empty = the provider descriptor's default.
  const LOCAL_VOICE_KEY = 'starnet.liveVoice.localVoice.v1';
  const TURN_END_KEY = 'starnet.liveVoice.turnEndMs.v1';
  // Start complete turns on the proven QUICK boundary. A partial that visibly trails off still gets the
  // existing +600ms continuation grace below, and NORMAL/PATIENT remain explicit Commander choices.
  const DEFAULT_TURN_END_MS = 1200;
  const TURN_END_CHOICES = [0, DEFAULT_TURN_END_MS, 1800, 2600];
  let timing = {}, lastAudioStartMs = null;
  function markTiming(key, measured = timing) {
    if (key && measured[key] == null) measured[key] = performance.now();
    if (measured !== timing) return;
    const delta = (a, b) => timing[a] != null && timing[b] != null ? Math.max(0, Math.round(timing[b] - timing[a])) + ' ms' : '—';
    if ($('lv-timing')) $('lv-timing').textContent = 'First words ' + delta('speech', 'words') + ' · Send ' + delta('lastVoice', 'send') + ' · Speech start ' + (lastAudioStartMs == null ? '—' : lastAudioStartMs + ' ms');
  }
  const PRE_ROLL_MS = 900;
  const MAX_UTTERANCE_MS = 60000;
  const CALIBRATION_FLOOR_CEILING = 0.016;
  // SETTLED (Andrew, 2026-07-29): a small pop-up module with NO icon — a state line, the volume
  // indicator, and the transcript. The four-shape and four-icon switchers that got us here are
  // deleted; shipping the candidates was never the goal, choosing one was.
  // Level readout: a rolling window of mic RMS, oldest at the left. The columns ARE the microphone
  // — never animate them off a timer, or the module would claim to hear a room it cannot hear.
  // (The dictation leg scrolls on a timer for cadence, but every push is a MEASURED value — its own
  // meter tap or the agent's playback tap — and with no live source it pushes nothing. See
  // dictationMeterTick: the law is about inventing values, and no value is ever invented.)
  // TYPED, not drawn: one block glyph per column, from the same ▁▂▃ ramp the link-status bars in
  // app.js already speak, so the meter belongs to the CRT instead of sitting on top of it.
  const WAVE_BARS = 17;
  const RAMP = '▁▂▃▄▅▆▇█';
  const glyphFor = level => RAMP[Math.min(RAMP.length - 1, Math.round(level * (RAMP.length - 1)))];
  // TWO VOICES, ONE METER (a phone call shows you both sides): every column remembers WHOSE level it
  // is, so the strip changes colour as the turn changes hands instead of needing a second widget.
  // `agentLevel` is the newest RMS of the agent's own playback, pushed in by Voice's output tap.
  const SELF = 'self', AGENT = 'agent';
  const AGENT_GAIN = 6;    // playback RMS is normalized and hotter than a room mic — matched by ear, see below
  let waveBars = null;
  let waveHistory = new Array(WAVE_BARS).fill(null).map(() => ({ v: 0, src: SELF }));
  let agentLevel = 0;

  function clampPanel(panel) {
    if (!panel || panel.hidden || !panel.style.left) return;
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, rect.left));
    const top = Math.max(8, Math.min(window.innerHeight - rect.height - 8, rect.top));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function savePosition(panel) {
    try {
      const rect = panel.getBoundingClientRect();
      localStorage.setItem(POSITION_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
    } catch (_) {}
  }

  function restorePosition(panel) {
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
      if (!saved || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return;
      panel.style.left = `${saved.left}px`;
      panel.style.top = `${saved.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      requestAnimationFrame(() => clampPanel(panel));
    } catch (_) {}
  }

  function makeDraggable(panel) {
    const handle = panel.querySelector('.lv-head');
    if (!handle) return;
    let drag = null;
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      drag = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      panel.dataset.dragging = 'true';
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!drag) return;
      const left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, event.clientX - drag.x));
      const top = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, event.clientY - drag.y));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    });
    const release = event => {
      if (!drag) return;
      drag = null;
      delete panel.dataset.dragging;
      try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
      savePosition(panel);
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
  }

  function ensurePanel() {
    if ($('live-voice-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'live-voice-panel';
    panel.className = 'live-voice-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Starnet local live voice');
    panel.innerHTML = [
      '<header class="lv-head">',
        '<span class="lv-brand">LOCAL LIVE</span>',
        '<span class="lv-pip" aria-hidden="true"></span>',
        '<span id="lv-state" class="lv-state" aria-live="polite">CONNECTING</span>',
        '<button id="lv-close" class="x-btn lv-x" type="button" aria-label="End live voice" title="End live voice">✕</button>',
      '</header>',
      // The LEVEL IS THE CONTROL. There is no icon: an orb, a mic glyph, a lamp — anything sitting
      // beside the meter was a second thing to look at, and the meter already says everything this
      // module knows. So the button IS the meter: press anywhere on your own voice to cut in.
      '<div class="lv-stage">',
        '<button id="lv-barge" class="lv-meter" type="button" aria-label="Interrupt and speak" title="Interrupt — speak now">',
          '<div id="lv-wave" class="lv-wave" aria-hidden="true"></div>',
        '</button>',
      '</div>',
      '<div class="lv-controls">',
        '<button id="lv-pause" class="bb" type="button" aria-pressed="false">PAUSE MIC</button>',
        '<button id="lv-send" class="bb" type="button" disabled>SEND NOW</button>',
      '</div>',
      '<p id="lv-heard" class="lv-heard" aria-live="polite">Speak naturally — the transcript lands in COMMS.</p>',
      '<p id="lv-agent" class="lv-say"></p>',
      '<label class="lv-end-control"><span>TURN END</span><select id="lv-endpoint" class="lv-endpoint" aria-label="Pause before sending your turn">',
        '<option value="0">AUTO · ADAPTIVE</option>',
        '<option value="1200">QUICK · 1.2S</option>',
        '<option value="1800">NORMAL · 1.8S</option>',
        '<option value="2600">PATIENT · 2.6S</option>',
      '</select></label>',
      '<details class="lv-details"><summary>VOICE DETAILS</summary><dl class="lv-rail">',
        '<div class="lv-row"><dt>ROUTE</dt><dd id="lv-route">LOCAL SPEECH · ACTIVE STARNET AGENT</dd></div>',
        '<div class="lv-row lv-row-dl"><dt>SPEECH</dt><dd id="lv-model">LOCAL MODELS: CHECKING</dd></div>',
        '<div class="lv-row"><dt>LATENCY</dt><dd id="lv-timing" title="First words: detected speech to transcript. Send: last voiced frame to submission. Speech start: latest spoken chunk queued to actual playback.">Speak to measure this turn.</dd></div>',
        '<div class="lv-row"><dt>TASK</dt><dd id="lv-task" class="lv-task">No active task detected.</dd></div>',
      '</dl></details>',
      '<div id="lv-error" class="lv-error" hidden></div>',
      '<button id="lv-retry" class="lv-retry" type="button" hidden>TRY AGAIN</button>'
    ].join('');
    const wave = panel.querySelector('#lv-wave');
    for (let i = 0; i < WAVE_BARS; i++) {
      const col = document.createElement('i');
      col.textContent = RAMP[0];   // a silent room is a flat line, never an empty row
      col.dataset.src = SELF;
      wave.appendChild(col);
    }
    document.body.appendChild(panel);
    waveBars = Array.from(wave.children);
    restorePosition(panel);
    makeDraggable(panel);
    $('lv-close').onclick = end;
    $('lv-retry').onclick = () => start(true);
    $('lv-barge').onclick = bargeIn;
    $('lv-pause').onclick = togglePause;
    $('lv-send').onclick = () => finishUtterance(false);
    const endpoint = $('lv-endpoint');
    if (endpoint) {
      endpoint.value = String(savedTurnEndDelayMs());
      endpoint.onchange = () => {
        const selected = normalizeTurnEndMs(endpoint.value);
        endpoint.value = String(selected);
        try { localStorage.setItem(TURN_END_KEY, String(selected)); } catch (_) {}
      };
    }
  }

  // Amplitude drives the meter AND the module's own bloom, so the whole light level of the thing is
  // the real mic level — one signal, never a decorative loop pretending to be one.
  //
  function pushLevel(value, source) {
    const level = Math.max(0, Math.min(1, value));
    const src = source === AGENT ? AGENT : SELF;
    waveHistory.push({ v: level, src: src });
    waveHistory.shift();
    if (waveBars) for (let i = 0; i < waveBars.length; i++) {
      const cell = waveHistory[i], bar = waveBars[i];
      const glyph = glyphFor(cell.v);
      if (bar.textContent !== glyph) bar.textContent = glyph;
      if (bar.dataset.src !== cell.src) bar.dataset.src = cell.src;   // CSS colours the column by whose voice it is
    }
    const panel = $('live-voice-panel');
    if (panel) {
      panel.style.setProperty('--lv-amp', level.toFixed(3));
      // the bloom belongs to whoever is talking, so the module's own light changes hands too
      if (panel.dataset.talker !== src) panel.dataset.talker = src;
    }
  }

  function resetLevel() {
    waveHistory = new Array(WAVE_BARS).fill(null).map(() => ({ v: 0, src: SELF }));
    agentLevel = 0;
    tapLevel = 0;
    if (waveBars) waveBars.forEach(bar => { bar.textContent = RAMP[0]; bar.dataset.src = SELF; });
    const panel = $('live-voice-panel');
    if (panel) { panel.style.setProperty('--lv-amp', '0'); panel.dataset.talker = SELF; }
  }

  function setState(value) {
    const normalized = paused ? 'paused' : recording ? 'hearing' : String(value || 'ready').toLowerCase();
    if ($('lv-state')) $('lv-state').textContent = normalized.toUpperCase();
    const panel = $('live-voice-panel');
    const meter = $('lv-barge');
    const working = /^(?:connecting|warming|thinking|transcribing|reconnecting)$/.test(normalized);
    if ($('lv-send')) $('lv-send').disabled = !recording || paused || dictation;
    if ($('lv-send')) $('lv-send').hidden = dictation || realtime;
    if ($('lv-endpoint')) $('lv-endpoint').disabled = dictation || realtime;
    if ($('lv-pause')) {
      $('lv-pause').textContent = paused ? 'RESUME MIC' : 'PAUSE MIC';
      $('lv-pause').setAttribute('aria-pressed', String(paused));
    }
    if (panel) {
      panel.dataset.state = normalized;
      panel.setAttribute('aria-busy', working ? 'true' : 'false');
    }
    if (meter) {
      const label = normalized === 'paused' ? 'Microphone paused — press to resume'
        : normalized === 'speaking'
        ? 'Agent speaking — press to interrupt and speak'
        : normalized === 'hearing'
          ? 'Listening to you — press to interrupt'
          : working
            ? `${normalized} — press to interrupt and speak`
            : 'Voice is listening — press to interrupt and speak';
      meter.setAttribute('aria-label', label);
      meter.title = label;
    }
  }
  function setError(message) {
    const el = $('lv-error');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
    if ($('lv-retry')) $('lv-retry').hidden = !message;
  }
  // A failure the user cannot retry away: same visible message, but no RETRY affordance — offering one
  // for a capability this build does not carry would just loop them through the same refusal.
  function setUnrecoverableError(message) {
    setError(message);
    if ($('lv-retry')) $('lv-retry').hidden = true;
  }
  function setTransientError(message, ms = 4500) {
    setError(message);
    clearTimeout(transientErrorTimer);
    transientErrorTimer = setTimeout(() => { if (active) setError(''); }, ms);
  }
  // 'user' writes the heard line, 'agent' the reply line. These IDs must exist in ensurePanel —
  // the first draft addressed a #lv-user that was never built, so every reply the controller
  // spoke ("Approved once.", "Queued behind the current task.") was painted into nothing.
  function caption(who, text, append) {
    const el = $(who === 'user' ? 'lv-heard' : 'lv-agent');
    if (!el || text == null) return;
    el.textContent = append ? el.textContent + String(text) : String(text);
    if (el.id === 'lv-agent') el.classList.toggle('on', !!el.textContent.trim());
  }

  function statusSnapshot() {
    if (typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return { active: null, workstreams: [] };
    const current = Workstreams.active();
    return {
      active: current ? current.id : null,
      workstreams: Workstreams.list().slice(0, 12).map(ws => ({
        id: ws.id, title: ws.title || 'General', lane: ws.lane || null,
        busy: Channels.isBusy(ws.id), status: Channels.statusOf(ws.id),
        approvalRequired: !!Channels.pendingOf(ws.id)
      }))
    };
  }

  function providerName(value) {
    const id = String(value || '').trim().toLowerCase();
    const names = { codex: 'CODEX', openai: 'OPENAI', openrouter: 'OPENROUTER', gemini: 'GEMINI', anthropic: 'ANTHROPIC', grok: 'GROK', kimi: 'KIMI' };
    return names[id] || (id ? id.replace(/[-_]+/g, ' ').toUpperCase() : 'MODEL NOT CONNECTED');
  }

  function refreshRoute() {
    const el = $('lv-route');
    if (!el) return;
    let provider = '', model = '', agent = '';
    try {
      if (typeof Harness !== 'undefined') {
        provider = Harness.getProv ? Harness.getProv() : '';
        model = Harness.getModel ? Harness.getModel() : '';
      }
      const select = $('comms-agent-select');
      if (select) agent = select.options && select.selectedIndex >= 0
        ? select.options[select.selectedIndex].textContent : select.value;
    } catch (_) {}
    const route = [providerName(provider), String(agent || '').trim().toUpperCase()].filter(Boolean).join(' · ');
    el.textContent = `LOCAL SPEECH · ${route}`;
    el.title = model ? `${providerName(provider)} · ${model}` : providerName(provider);
  }

  function refreshTask() {
    const el = $('lv-task');
    refreshRoute();
    if (!el || typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return;
    // the panel reports the session the CALL is bound to — not whatever the Commander is browsing, which
    // would misreport whose work the strip is showing the moment they click around mid-call.
    const ws = boundSession() || Workstreams.active();
    if (!ws) { el.textContent = 'No active workstream.'; return; }
    const busy = Channels.isBusy(ws.id), pending = Channels.pendingOf(ws.id);
    el.textContent = (pending ? 'APPROVAL NEEDED · ' : busy ? 'WORKING · ' : 'READY · ') + (ws.title || 'GENERAL');
    el.title = pending ? `${pending.tool || 'Action'} needs approval${pending.argsSummary ? `: ${pending.argsSummary}` : ''}` : (Channels.statusOf(ws.id) || ws.title || 'Ready');
    el.classList.toggle('busy', busy);
    el.classList.toggle('pending', !!pending);
    // hands-free: anything now WAITING on a click gets said aloud, once (see announceWaits)
    announceWaits();
  }

  function availabilityFailure(response) {
    if (!response || response.ok !== false) return null;
    return {
      probeFailed: true,
      staleSession: response.status === 403,
      status: Number(response.status) || 0
    };
  }

  // One read of the sidecar's installation verdict. A failed probe is a first-class result: every Live
  // Voice engine needs the sidecar, so opening the microphone after a 403/5xx only creates a convincing
  // but silent session. In particular, 403 means this page still carries the token from before a restart.
  async function probeAvailability() {
    try {
      const response = await fetch('/api/local-voice/status', { cache: 'no-store' });
      const failure = availabilityFailure(response);
      if (failure) return failure;
      return await response.json();
    } catch (_) {
      return { probeFailed: true, staleSession: false, status: 0 };
    }
  }

  // The keyless listening ladder: Windows System.Speech, driven by the sidecar, needing no npm package and
  // no transcription credential. It ships inside the bundle where the offline models cannot.
  async function probeNativeStt() {
    try {
      const response = await fetch('/api/stt/native/status', { cache: 'no-store' });
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  async function pollModels() {
    try {
      const response = await fetch('/api/local-voice/status', { cache: 'no-store' });
      const data = await response.json();
      const percent = data.progress && data.progress.percent != null ? data.progress.percent : null;
      const progress = percent != null ? ` ${percent}%` : '';
      if ($('lv-model')) $('lv-model').textContent = `ASR ${String(data.asr).toUpperCase()} · VOICE ${String(data.tts).toUpperCase()}${progress}`;
      // A download that reports a percent gets a real fill behind the row; no percent, no fill.
      const shell = $('live-voice-panel');
      if (shell) shell.style.setProperty('--lv-dl', percent != null ? `${percent}%` : '0%');
      const currentState = $('live-voice-panel') && $('live-voice-panel').dataset.state;
      if (data.asr === 'ready' && active && !recording && !transcriptionPending &&
          /^(?:connecting|warming|reconnecting)$/.test(currentState || '')) {
        setState('listening');
        // The warm-up notice claimed models were still downloading long after they were ready —
        // it is the ONLY line we are allowed to retract, and only once its claim stops being true.
        if (warmupNotice) { warmupNotice = false; caption('agent', ''); }
      }
      if (data.error && (data.asr === 'error' || data.tts === 'error')) setError(`Local speech model failed: ${data.error}`);
      return data;
    } catch (_) {
      if ($('lv-model')) $('lv-model').textContent = 'LOCAL MODELS: SIDECAR OFFLINE';
      return null;
    }
  }

  function speakLocal(text) {
    caption('agent', text);
    if (typeof Voice !== 'undefined' && Voice.speak) Voice.speak(text);
  }

  function answerStatusQuestion() {
    const snap = statusSnapshot();
    const current = snap.workstreams.find(item => item.id === snap.active);
    const busy = snap.workstreams.filter(item => item.busy);
    const approvals = snap.workstreams.filter(item => item.approvalRequired);
    let lead = !current ? 'There is no active task.'
      : current.approvalRequired ? `${current.title} is waiting for your approval.`
      : current.busy ? `${current.title} is still working. ${current.status || ''}`.trim()
      : `${current.title} is ready.`;
    const otherBusy = busy.filter(item => !current || item.id !== current.id).length;
    const otherApprovals = approvals.filter(item => !current || item.id !== current.id).length;
    if (otherBusy) lead += ` ${otherBusy} other ${otherBusy === 1 ? 'task is' : 'tasks are'} running.`;
    if (otherApprovals) lead += ` ${otherApprovals} other ${otherApprovals === 1 ? 'task needs' : 'tasks need'} approval.`;
    return lead;
  }

  function agentCommand(value, lower) {
    const select = $('comms-agent-select');
    if (!select) return false;
    if (/^(?:list|who are) (?:my )?agents$/.test(lower)) {
      const names = Array.from(select.options || []).map(option => String(option.textContent || option.value).trim()).filter(Boolean);
      speakLocal(names.length ? `Your agents are ${names.join(', ')}.` : 'There are no agents available.');
      return true;
    }
    const match = /^(?:switch|talk|speak) to (?:agent )?(.+)$/i.exec(value);
    if (!match) return false;
    const wanted = match[1].trim().toLowerCase();
    const option = Array.from(select.options || []).find(item =>
      String(item.value || '').toLowerCase() === wanted ||
      String(item.textContent || '').trim().toLowerCase() === wanted);
    if (!option) {
      speakLocal(`I could not find an agent named ${match[1].trim()}.`);
      return true;
    }
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refreshRoute();
    speakLocal(`Now talking to ${String(option.textContent || option.value).trim()}.`);
    return true;
  }

  /* HANDS-FREE MEANS NOTHING WAITS ON A CLICK (2026-07-30, Andrew: "it's constantly giving pop ups the
     user needs to click… in live mode it should just directly ask"). Two things wait silently for a mouse
     during a run: the APPROVAL card and CHOICE CHIPS. In a live call both are now SPOKEN the moment they
     appear (once each — announceWaits below, driven by the panel's existing 500ms tick) and ANSWERED by
     voice: approvals via approvalCommand, chips via chipCommand, which clicks the REAL button so every
     downstream effect is identical to a mouse pick. The visual cards stay — they are the truthful record —
     but the ASK happens aloud, and the call never depends on the Commander looking at the screen. */
  let spokenApprovalId = null;
  function chipButtons() {
    return Array.from(document.querySelectorAll('#chat-log .choice-row button.choice')).filter(b => !b.disabled);
  }
  function chipLabel(b) {
    // strip the leading glyph (▤, ◈, …) chips carry — nobody SAYS the icon
    return String(b.textContent || '').replace(/^[^A-Za-z0-9]+/, '').trim();
  }
  /* ⛔ THE ONLY WAIT THAT SPEAKS IS AN APPROVAL. Chips are not announced, because in a live call they are
     not even RENDERED any more (chat.js suppresses choice rows and the tap-to-correct brief card while a
     call is active — Andrew: "it should not give the same clickable popups, it should just directly ask").
     The first version of this narrated whatever chip row happened to be on screen, so opening a call over a
     re-rendered old beat blurted "say one: confirm, or not quite…" out of nowhere. Rows that pre-date the
     call can still be answered by voice (chipCommand) — they are just never read at anyone. */
  function announceWaits() {
    if (!active) return;
    // only when the DISPLAYED session is the call's own — cards in a browsed session are not ours to read
    if (typeof Workstreams === 'undefined' || (boundWsId && Workstreams.activeId && Workstreams.activeId() !== boundWsId)) return;
    const ws = boundSession() || (Workstreams.active && Workstreams.active());
    const pending = ws && typeof Channels !== 'undefined' && Channels.pendingOf ? Channels.pendingOf(ws.id) : null;
    if (pending) {
      const id = String(pending.promptId || pending.tool || 'prompt');
      if (id !== spokenApprovalId) {
        spokenApprovalId = id;
        speakLocal('Approval needed: ' + (pending.tool || 'an action') + (pending.argsSummary ? ' — ' + String(pending.argsSummary).slice(0, 120) : '') + '. Say approve, always allow, or deny.');
      }
    } else spokenApprovalId = null;
  }
  /* Answer visible chips by voice. Clicks the REAL button (chat.js binds the pick to it), so this is the
     mouse path with a different finger. Matching is deliberately conservative — exact, then prefix/containment
     with length floors, then ordinals ("the second one") — because a wrong pick ACTS, and acting wrongly is
     worse than falling through to the model, which sees the words and can ask. */
  /* matchChoice(saidText, labels) -> index | -1. PURE (unit-tested by extraction) and deliberately
     conservative: exact, then spoken-prefix-of-label, then label-inside-sentence with length floors, then
     bare ordinals. A wrong pick ACTS, and acting wrongly is worse than falling through to the model, which
     sees the words and can ask. The length floors are the guard: without them a chip labeled "ok" would
     swallow every sentence containing those two letters. */
  function matchChoice(said, labels) {
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const want = norm(said);
    if (!want) return -1;
    const ls = (labels || []).map(norm);
    let idx = ls.findIndex(l => l && l === want);
    if (idx < 0 && want.length >= 3) idx = ls.findIndex(l => l.length >= 3 && l.indexOf(want) === 0);   // spoken prefix of a label
    if (idx < 0) idx = ls.findIndex(l => l.length >= 4 && want.indexOf(l) >= 0);                        // label inside the sentence
    if (idx < 0) {
      const bare = want.replace(/\b(the|one|option|pick|choose|take)\b/g, ' ').replace(/\s+/g, ' ').trim();
      const ord = ['first', 'second', 'third', 'fourth'].indexOf(bare);
      if (ord >= 0 && ord < ls.length) idx = ord;
      else if (bare === 'last' && ls.length) idx = ls.length - 1;
    }
    return idx;
  }
  function chipCommand(lower) {
    const buttons = chipButtons();
    if (!buttons.length) return false;
    const idx = matchChoice(lower, buttons.map(chipLabel));
    if (idx < 0) return false;
    const picked = chipLabel(buttons[idx]);
    buttons[idx].click();
    speakLocal(picked + '.');
    refreshTask();
    return true;
  }

  function approvalCommand(lower) {
    if (typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return false;
    const ws = Workstreams.active();
    const pending = ws && Channels.pendingOf(ws.id);
    if (!pending) return false;
    let decision = '';
    if (/^(?:approve|approve once|yes[, ]+approve|allow it|go ahead)$/.test(lower)) decision = 'once';
    else if (/^(?:always allow|approve always|always approve)$/.test(lower)) decision = 'always';
    else if (/^(?:deny|deny it|do not allow|don't allow|reject)$/.test(lower)) decision = 'deny';
    if (!decision) return false;

    // The visible card owns specialized approval effects and settlement. The run-scoped fallback covers the
    // short interval where Channels knows about a prompt before COMMS has painted its buttons.
    const buttons = Array.from(document.querySelectorAll('#chat-log .cmsg.consent .consent-btn'));
    const wanted = decision === 'deny' ? /deny|cancel/i : decision === 'always' ? /^always$/i : /approve once|open login|done/i;
    const button = buttons.reverse().find(item => wanted.test(String(item.textContent || '').trim()) && !item.disabled);
    if (button) button.click();
    else {
      const runId = Channels.runIdOf(ws.id) || pending.runId;
      if (typeof Harness !== 'undefined' && Harness.consent) Harness.consent(runId, pending.promptId, decision);
      Channels.clearPending(ws.id, Date.now());
      try { if (typeof U !== 'undefined' && U.bus) U.bus.emit('permission.response', { promptId: pending.promptId, decision }); } catch (_) {}
    }
    speakLocal(decision === 'deny' ? 'Denied.' : decision === 'always' ? 'Always allowed.' : 'Approved once.');
    refreshTask();
    return true;
  }

  /* THE CALL IS BOUND TO ONE SESSION (2026-07-30, Andrew: "if you open live voice in a session it should
     ONLY be for that session — clicking another session must not rebind the live mode"). Everything routed
     through Chat lands on the ACTIVE workstream, so before this binding existed, browsing the rail mid-call
     silently re-targeted the conversation: the next utterance ran in whatever session was open, under that
     session's agent. The call now remembers the session it was OPENED in and pins focus back to it before
     every utterance — browsing while silent is free, but spoken words always reach the session the call
     belongs to. The ONE legitimate rebind is the Commander steering the call BY VOICE ("open the research
     session"): station.switch_session calls rebind() when a live call is up, because that switch came
     through the call itself. A UI click never routes through that verb. */
  let boundWsId = null;
  function bindSession() {
    boundWsId = (typeof Workstreams !== 'undefined' && Workstreams.activeId) ? Workstreams.activeId() : null;
    spokenApprovalId = null;   // a NEW call announces a genuinely-pending approval once, never a prior call's
  }
  function rebind(id) {
    if (id) {
      const next = String(id);
      // A voice-commanded session switch transfers ownership of the call. Cut any queued audio
      // from the old owner before changing the id, so a late old-session sentence can never play
      // into the newly-bound conversation.
      if (boundWsId && boundWsId !== next && typeof Voice !== 'undefined' && Voice.stopSpeaking) Voice.stopSpeaking();
      boundWsId = next;
      refreshTask();
    }
  }
  function boundSession() {
    if (!boundWsId || typeof Workstreams === 'undefined' || !Workstreams.get) return null;
    return Workstreams.get(boundWsId);
  }
  function ensureBoundFocus() {
    if (typeof Workstreams === 'undefined') return;
    const bound = boundSession();
    if (!bound || bound.archived) {
      // the bound session was deleted/archived mid-call — rebind to the live one and SAY so, never guess on
      if (boundWsId) caption('agent', '— that session is gone; the call now follows the open one —');
      boundWsId = Workstreams.activeId ? Workstreams.activeId() : null;
      return;
    }
    if (Workstreams.activeId && Workstreams.activeId() !== bound.id) {
      const ws = Workstreams.switch(bound.id);
      if (ws && typeof Chat !== 'undefined' && Chat.load) { try { Chat.load(ws); } catch (_) {} }
      try { if (typeof App !== 'undefined' && App.refreshRail) App.refreshRail(); } catch (_) {}
    }
  }

  function handleTranscript(text, measured = timing) {
    const value = String(text || '').trim();
    if (!value) { setState('listening'); return true; }
    // spoken words go to the session this call was opened in, wherever the Commander happens to be browsing
    ensureBoundFocus();
    markTiming('send', measured);
    caption('user', value);
    caption('agent', '');
    setState('thinking');
    refreshTask();
    const lower = value.toLowerCase().replace(/[.!?]+$/, '').trim();
    if (/^(?:end|stop|exit|leave)(?: the)? (?:voice(?: mode| chat)?|call)$/.test(lower)) { end(); return true; }
    if (/^(?:pause|mute)(?: the| my)? (?:mic|microphone)$/.test(lower)) { togglePause(); return true; }
    if (approvalCommand(lower)) return true;   // the blocking wait answers first
    if (chipCommand(lower)) return true;       // then a visible chip row — spoken pick clicks the real button
    if (agentCommand(value, lower)) return true;
    if (/^(?:what(?:'s| is) (?:the )?status|status update|task status|what are (?:my )?agents doing|how(?:'s| is) (?:it|the task) going)$/.test(lower)) {
      speakLocal(answerStatusQuestion());
      return true;
    }
    if (/^(?:stop (?:speaking|talking|reading)|quiet|be quiet|mute (?:your )?voice)$/.test(lower)) {
      if (typeof Voice !== 'undefined' && Voice.stopSpeaking) Voice.stopSpeaking();
      caption('agent', typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy()
        ? 'Speech stopped. The task is still running.' : 'Speech stopped.');
      setState('listening');
      return true;
    }
    const stopOnly = /^(?:stop|cancel|interrupt|hold on|wait|never ?mind)(?: the task| that)?$/.test(lower);
    const redirect = /^(?:stop|cancel|interrupt|hold on|wait)[,;:\s]+(.{3,})$/i.exec(value);
    if (stopOnly) {
      const wasBusy = !!(typeof Chat !== 'undefined' && Chat.isBusy && Chat.isBusy());
      if (wasBusy && Chat.stopActive) Chat.stopActive();
      speakLocal(wasBusy ? 'Stopped.' : 'Nothing is running.');
      return true;
    }
    if (redirect && typeof Chat !== 'undefined') {
      if (Chat.isBusy && Chat.isBusy() && Chat.stopActive) Chat.stopActive();
      const next = redirect[1].trim();
      if (Chat.sendOrQueue) Chat.sendOrQueue(next);
      caption('agent', 'Changing direction.');
      refreshTask();
      return true;
    }
    if (typeof Chat === 'undefined' || !Chat.sendOrQueue) {
      setError('The signed-in Starnet agent is not ready yet.');
      return true;
    }
    const result = Chat.sendOrQueue(value);
    caption('agent', result && result.state === 'queued' ? 'Queued behind the current task.' : 'Working on it.');
    refreshTask();
    return true;
  }

  function onAssistant(part) {
    part = part || {};
    // Speech updates the call panel only. A delayed reply must never navigate away from
    // the session the Commander selected or replace its composer draft. Call ownership stays bound.
    caption('agent', part.text || '', !part.opening);
  }
  // the agent's live output RMS, straight off the tap on its playback chain. Stored, not drawn: the mic
  // frame is the only thing that scrolls the strip (see processFrame), so this just supplies the value.
  function onTiming(value) {
    if (!active || !value || !Number.isFinite(value.audioStartMs)) return;
    lastAudioStartMs = Math.round(value.audioStartMs); markTiming(null);
  }
  function onOutputLevel(rms) { agentLevel = Math.max(0, +rms || 0); }
  function onState(state) {
    if (!active || state === 'ended') return;
    setState(state === 'ready' ? 'listening' : state);
    refreshTask();
  }

  function downsample(frames, fromRate) {
    let total = 0;
    for (const frame of frames) total += frame.length;
    const input = new Float32Array(total);
    let offset = 0;
    for (const frame of frames) { input.set(frame, offset); offset += frame.length; }
    if (fromRate === 16000) return input;
    const ratio = fromRate / 16000;
    const output = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < output.length; i++) {
      const start = Math.floor(i * ratio), endAt = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < endAt; j++) sum += input[j];
      output[i] = sum / Math.max(1, endAt - start);
    }
    return output;
  }

  async function postPcm(pcm, signal) {
    const response = await fetch('/api/local-voice/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: pcm.buffer,
      signal
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    return String(result.text || '').trim();
  }

  function requestPartial(frames, id) {
    if (liveStream && !liveStream.failed) return;
    if (!active || partialPending || transcriptionPending || !context || frames.length < 8) return;
    const now = performance.now();
    if (now - lastPartialAt < 650) return;
    const snapshot = speechSnapshot(frames);
    if (partialSnapshot && partialSnapshot.id === id && partialSnapshot.samples === snapshot.samples) return;
    lastPartialAt = now;
    partialPending = true;
    const pcm = downsample(snapshot.frames, context.sampleRate);
    const ac = new AbortController();
    partialAbort = ac;
    postPcm(pcm, ac.signal).then(text => {
      if (!active || partialAbort !== ac || id !== utteranceSeq || !recording || !text) return;
      markTiming('words');
      partialText = text;
      partialSnapshot = { id, samples: snapshot.samples, text };
      if ($('lv-heard')) $('lv-heard').textContent = text;
    }).catch(error => {
      if (!error || error.name !== 'AbortError') console.warn('[voice-live] partial transcription:', error && error.message || error);
    }).finally(() => {
      if (partialAbort === ac) { partialAbort = null; partialPending = false; }
    });
  }

  function speechSnapshot(frames) {
    // Keep a short acoustic tail, not the entire endpoint wait. A preview of these exact samples can
    // become the final transcript without making the user wait for the same recognition twice.
    let remaining = lastVoicedSamples + Math.round(context.sampleRate * 0.2);
    const captured = [];
    let samples = 0;
    for (const frame of frames) {
      if (remaining <= 0) break;
      const part = frame.length <= remaining ? frame : frame.slice(0, remaining);
      captured.push(part); samples += part.length; remaining -= part.length;
    }
    return { frames: captured, samples };
  }

  function normalizeTurnEndMs(value) {
    const parsed = Math.round(Number(value));
    return TURN_END_CHOICES.indexOf(parsed) >= 0 ? parsed : DEFAULT_TURN_END_MS;
  }

  function savedTurnEndDelayMs() {
    try { return normalizeTurnEndMs(localStorage.getItem(TURN_END_KEY)); } catch (_) { return DEFAULT_TURN_END_MS; }
  }

  function turnEndDelayMs() {
    const control = $('lv-endpoint');
    if (control && control.value) return normalizeTurnEndMs(control.value);
    return savedTurnEndDelayMs();
  }

  function endpointSilenceMs(text, baseMs) {
    // Auto uses bounded text cues, not a claim that we know the speaker's intent. Explicit pause choices retain their timing.
    let wait = Number.isFinite(baseMs) ? baseMs : DEFAULT_TURN_END_MS;
    const partial = String(text || '').trim().toLowerCase();
    const continues = /[,;:—-]\s*$/.test(partial)
      || /\b(?:and|but|or|so|because|then|like|well|actually|basically|uh|um|hmm|i|i'm|we|to|the|a|an|my|your|that|which|if|when|while|with|for|of)\s*[.!?]?$/.test(partial);
    if (wait === 0) {
      if (continues) return 1800;
      if (/^(yes|no|okay|thanks|stop|cancel)[.!?]?$/.test(partial)) return 650;
      return /[.!?]$/.test(partial) && partial.split(/\s+/).length >= 3 ? 800 : 1200;
    }
    if (continues) wait = Math.min(3600, wait + 600);
    return wait;
  }

  function keepPreRoll(frame, frameMs) {
    preRoll.push(frame);
    const limit = Math.max(8, Math.ceil(PRE_ROLL_MS / Math.max(1, frameMs)));
    while (preRoll.length > limit) preRoll.shift();
  }

  async function transcribe(frames, seq = sessionSeq, allowContinue = true, recognizer = null, measured = timing) {
    if (!context || !active || seq !== sessionSeq) return;
    if (transcriptionPending) {
      if (queuedAudio.length >= 4) {
        if (recognizer) recognizer.cancel();
        setTransientError('Speech is arriving faster than it can be transcribed. Please repeat the last turn after the pending turns finish.');
        return;
      }
      queuedAudio.push({ frames, seq, allowContinue, recognizer, measured });
      return;
    }
    if (partialAbort) { partialAbort.abort(); partialAbort = null; partialPending = false; }
    const pcm = downsample(frames, context.sampleRate);
    if (pcm.length < 3200) { if (recognizer) recognizer.cancel(); setState('listening'); return; }
    transcriptionPending = true;
    const ac = new AbortController();
    finalAbort = ac;
    finalTurn = { frames, seq, allowContinue, recognizer, measured };
    setState('transcribing');
    if (!recording && $('lv-heard')) $('lv-heard').textContent = partialText || 'Finalizing your turn…';
    try {
      let text;
      if (recognizer && !recognizer.failed) {
        try { const result = await recognizer.finish(); text = result.text; }
        catch (error) {
          recognizer.cancel();
          if (ac.signal.aborted || !active || seq !== sessionSeq || finalAbort !== ac) return;
          text = await postPcm(pcm, ac.signal);
        }
      } else { if (recognizer) recognizer.cancel(); text = await postPcm(pcm, ac.signal); }
      if (!active || seq !== sessionSeq || finalAbort !== ac) return;
      if (!text && !recording && $('lv-heard')) $('lv-heard').textContent = 'No speech detected — still listening.';
      const liveCaption = recording && $('lv-heard') ? $('lv-heard').textContent : null;
      handleTranscript(text, measured);
      if (liveCaption !== null && $('lv-heard')) $('lv-heard').textContent = liveCaption;
    } catch (error) {
      if (active && seq === sessionSeq && finalAbort === ac && (!error || error.name !== 'AbortError')) {
        setTransientError(`Transcription hiccup: ${error && error.message || error}`);
        setState('listening');
      }
    } finally {
      if (finalAbort === ac) {
        finalAbort = null; finalTurn = null; transcriptionPending = false;
        const next = queuedAudio.shift();
        if (next) transcribe(next.frames, next.seq, next.allowContinue, next.recognizer, next.measured);
        else if (active && !(typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking())) setState('listening');
      }
    }
  }

  function finishUtterance(allowContinue = true) {
    if (!recording || !context) return;
    const snapshot = speechSnapshot(utterance);
    const captured = snapshot.frames;
    const recognizer = liveStream; liveStream = null;
    const ready = !recognizer && !transcriptionPending && !queuedAudio.length && partialSnapshot &&
      partialSnapshot.id === utteranceSeq && partialSnapshot.samples === snapshot.samples ? partialSnapshot.text : '';
    recording = false;
    utterance = []; utteranceSamples = 0; preRoll = []; speechFrames = 0; silenceMs = 0;
    if (ready) {
      if (partialAbort) partialAbort.abort();
      partialAbort = null; partialPending = false;
      handleTranscript(ready);
      setState('listening');
    } else transcribe(captured, sessionSeq, allowContinue, recognizer);
  }

  function beginStream(frames, id, retainedText = '') {
    if (!streamAvailable || typeof VoiceStream === 'undefined' || !context) return;
    liveStream = VoiceStream.open({ rate: context.sampleRate,
      onUpdate: update => {
        if (!active || paused || id !== utteranceSeq || !recording) return;
        if (update.text) {
          if (retainedText && update.text.length < retainedText.length) return;
          retainedText = '';
          markTiming('words');
          partialText = update.text;
          const el = $('lv-heard');
          if (el) {
            el.textContent = '';
            const stable = document.createElement('span'); stable.textContent = update.stable || '';
            const partial = document.createElement('span'); partial.className = 'lv-provisional';
            partial.textContent = (update.stable && update.partial ? ' ' : '') + (update.partial || '');
            el.appendChild(stable); el.appendChild(partial);
          }
        }
      },
      onError: () => { if (active && id === utteranceSeq) setTransientError('Continuous recognition paused — using recorded transcription for this turn.'); }
    });
    for (const frame of frames) liveStream.push(frame);
  }

  function processFrame(event) {
    if (!active) return;
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    const rms = Math.sqrt(energy / frame.length);
    const agentTalking = typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    // ONE CLOCK for the strip. The mic frame is what scrolls it — always, even while the agent holds the
    // turn — so the meter keeps a single steady rate instead of speeding up when a second source (the
    // agent's ~60fps output tap) starts pushing. Whoever holds the turn supplies the VALUE and the colour;
    // the mic keeps feeding the VAD below either way, so barge-in detection is untouched.
    if (agentTalking) pushLevel(agentLevel * AGENT_GAIN, AGENT);
    else pushLevel(rms * 14, SELF);
    // NATIVE LIVE CALL: the provider does its own turn detection (semantic_vad) on the audio we stream to it,
    // so everything below — our VAD, utterance capture, partial transcription — would be a second, competing
    // brain cutting the same speech. The meter above still runs, because that is OUR strip and the frame that
    // scrolls it is this one.
    if (realtime) return;
    if (paused) return;
    const frameMs = frame.length / context.sampleRate * 1000;
    if (performance.now() < calibratedUntil) {
      // Starting to speak immediately must not teach the calibrator that the Commander's voice is room noise.
      // Cap the learned floor while the complete calibration window remains in pre-roll below.
      noiseFloor = Math.min(CALIBRATION_FLOOR_CEILING, noiseFloor * 0.92 + rms * 0.08);
      keepPreRoll(frame, frameMs);
      return;
    }
    // An additive margin remains usable for a distant microphone; multiplying a slightly noisy floor by 2.8
    // classified quiet syllables as silence and closed the turn while the Commander was still speaking.
    const replyPending = typeof Voice !== 'undefined' && Voice.isReplyPending && Voice.isReplyPending();
    const outputActive = agentTalking || replyPending;
    const threshold = Math.max(0.008, noiseFloor + (outputActive ? 0.025 : 0.006));
    const voiced = rms > threshold;
    if (!recording) {
      if (!voiced) noiseFloor = noiseFloor * 0.995 + rms * 0.005;
      keepPreRoll(frame, frameMs);
      speechFrames = voiced ? speechFrames + 1 : 0;
      const speechOnsetMs = speechFrames * frameMs;
      // A short speaker/noise burst is not enough evidence to cut off a playing sentence.
      // Sustained energy still cannot prove human speech; retain measurements for acoustic diagnosis.
      if (speechFrames >= 3 && (!outputActive || speechOnsetMs >= 300)) {
        // Speech resumed before the final transcript returned: this was a thinking pause, not a new
        // request. Cancel the stale result and extend the original audio instead of submitting half a thought.
        let continuation = [], resumedText = '', resumedTiming = null;
        if (finalTurn && finalTurn.allowContinue && !queuedAudio.length &&
            finalTurn.seq === sessionSeq && finalTurn.frames.reduce((n, f) => n + f.length, 0) / context.sampleRate * 1000 < MAX_UTTERANCE_MS) {
          continuation = finalTurn.frames;
          resumedText = partialText; resumedTiming = finalTurn.measured;
          if (finalTurn.recognizer) finalTurn.recognizer.cancel();
          if (finalAbort) finalAbort.abort();
          finalAbort = null; finalTurn = null; transcriptionPending = false;
        }
        recording = true;
        timing = resumedTiming || { speech: performance.now() };
        timing.lastVoice = performance.now();
        markTiming('speech');
        utteranceSeq++;
        partialText = resumedText;
        partialSnapshot = null;
        utterance = continuation.concat(preRoll);
        utteranceSamples = utterance.reduce((sum, item) => sum + item.length, 0);
        lastVoicedSamples = utteranceSamples;
        beginStream(utterance, utteranceSeq, resumedText);
        lastPartialAt = performance.now();
        silenceMs = 0;
        // Invalidate the old reply even if its first audio is still being generated.
        if (typeof Voice !== 'undefined' && Voice.stopSpeaking) Voice.stopSpeaking('microphone_activity', {
          rms, threshold, noiseFloor, agentTalking, replyPending: !!replyPending, outputRms: agentLevel, onsetMs: speechOnsetMs, sampleRate: context.sampleRate
        });
        setState('hearing');
        if ($('lv-heard')) $('lv-heard').textContent = resumedText || 'Listening…';
      }
      return;
    }
    utterance.push(frame);
    if (liveStream) liveStream.push(frame);
    utteranceSamples += frame.length;
    if (voiced) { lastVoicedSamples = utteranceSamples; timing.lastVoice = performance.now(); }
    silenceMs = voiced ? 0 : silenceMs + frameMs;
    const durationMs = utteranceSamples / context.sampleRate * 1000;
    if (durationMs >= 400) requestPartial(utterance, utteranceSeq);
    const endSilenceMs = endpointSilenceMs(partialText, turnEndDelayMs());
    if (silenceMs >= endSilenceMs || durationMs >= MAX_UTTERANCE_MS) {
      finishUtterance(durationMs < MAX_UTTERANCE_MS);
    }
  }

  async function openMicrophone(seq) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open a microphone.');
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
    // Permission prompts can outlive a quick on→off click. Never let that late result resurrect a closed
    // session or tear down a newer one.
    if (!active || seq !== sessionSeq) {
      acquired.getTracks().forEach(track => track.stop());
      return false;
    }
    stream = acquired;
    if (typeof Voice !== 'undefined' && Voice.recordSpeechEvent) {
      const track = acquired.getAudioTracks && acquired.getAudioTracks()[0];
      const settings = track && track.getSettings ? track.getSettings() : {};
      Voice.recordSpeechEvent('microphone_settings', { echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl, sampleRate: settings.sampleRate });
    }
    stream.getAudioTracks().forEach(track => { track.enabled = !paused; });
    const track = stream.getAudioTracks()[0];
    if (track) track.onended = () => { if (active && seq === sessionSeq) scheduleReconnect('Microphone disconnected.'); };
    context = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await context.resume();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    sink = context.createGain();
    sink.gain.value = 0;
    processor.onaudioprocess = processFrame;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    calibratedUntil = performance.now() + 700;
    return true;
  }

  function closeMicrophone() {
    if (liveStream) { liveStream.cancel(); liveStream = null; }
    if (finalTurn && finalTurn.recognizer) finalTurn.recognizer.cancel();
    for (const turn of queuedAudio) if (turn.recognizer) turn.recognizer.cancel();
    if (partialAbort) { partialAbort.abort(); partialAbort = null; }
    if (finalAbort) { finalAbort.abort(); finalAbort = null; }
    partialPending = false; transcriptionPending = false; finalTurn = null; queuedAudio = [];
    utteranceSeq++; speechFrames = 0; silenceMs = 0;
    try { if (processor) processor.disconnect(); } catch (_) {}
    try { if (source) source.disconnect(); } catch (_) {}
    try { if (sink) sink.disconnect(); } catch (_) {}
    try { if (stream) stream.getTracks().forEach(track => { track.onended = null; track.stop(); }); } catch (_) {}
    try { if (context) context.close(); } catch (_) {}
    stream = context = source = processor = sink = null;
    recording = false;
    utterance = [];
    utteranceSamples = 0;
    partialText = '';
    partialSnapshot = null; lastVoicedSamples = 0;
    preRoll = [];
    resetLevel();
  }

  /* DICTATION-LEG METER TAP — levels only, never audio for transcription.
     The engine that LISTENS in dictation mode (System.Speech inside the sidecar, or the browser's own
     SpeechRecognition) exposes no live signal, so whenever that fallback ran the strip froze while the
     models leg — which owns a real mic frame — scrolled. Proven on the target machine (2026-07-31):
     Windows shares one microphone between a SAPI recognizer and a shared-mode WASAPI capture with zero
     interference in either direction (recognizer heard audio and exited clean; the capture held a
     steady frame rate throughout), so the "two consumers on one microphone fight" assumption this leg
     was built on does not hold. A second, meter-only capture is safe — and if it cannot open (denied,
     dismissed, no device), your half of the strip simply stays flat while listening itself continues
     untouched, because the dictation engine still owns its own capture. */
  async function openMeterTap(seq) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    let acquired = null;
    try {
      // A DISMISSED WebView2 permission prompt never settles getUserMedia (voice.js learned this as a
      // wedged mic button) — race it so an unanswered prompt degrades to a flat half, not a hung tap.
      acquired = await Promise.race([
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
        }),
        new Promise((_, reject) => setTimeout(() => {
          const err = new Error('meter tap prompt timed out'); err.name = 'TimeoutError'; reject(err);
        }, 12000))
      ]);
    } catch (error) {
      console.warn('[voice-live] level meter tap unavailable:', (error && error.name) || error);
      return;
    }
    // The permission prompt can outlive the call — never let a late grant hold an orphaned device.
    if (!active || !dictation || seq !== sessionSeq) {
      try { acquired.getTracks().forEach(track => track.stop()); } catch (_) {}
      return;
    }
    try {
      tapStream = acquired;
      tapStream.getAudioTracks().forEach(track => { track.enabled = !paused; });
      tapContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      await tapContext.resume();
      tapSource = tapContext.createMediaStreamSource(tapStream);
      tapProcessor = tapContext.createScriptProcessor(2048, 1, 1);
      tapSink = tapContext.createGain();
      tapSink.gain.value = 0;
      tapProcessor.onaudioprocess = event => {
        const frame = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
        tapLevel = Math.sqrt(energy / frame.length);
      };
      tapSource.connect(tapProcessor);
      tapProcessor.connect(tapSink);
      tapSink.connect(tapContext.destination);
    } catch (error) {
      console.warn('[voice-live] level meter tap failed to wire:', (error && error.message) || error);
      closeMeterTap();
    }
  }

  function tapAlive() {
    const track = tapStream && tapStream.getAudioTracks()[0];
    return !!(track && track.readyState === 'live' && tapContext && tapContext.state === 'running');
  }

  function closeMeterTap() {
    try { if (tapProcessor) tapProcessor.disconnect(); } catch (_) {}
    try { if (tapSource) tapSource.disconnect(); } catch (_) {}
    try { if (tapSink) tapSink.disconnect(); } catch (_) {}
    try { if (tapStream) tapStream.getTracks().forEach(track => track.stop()); } catch (_) {}
    try { if (tapContext) tapContext.close(); } catch (_) {}
    tapStream = tapContext = tapSource = tapProcessor = tapSink = null;
    tapLevel = 0;
  }

  /* ONE CLOCK, same cadence as a 2048-sample mic frame (~43ms — the models leg's own scroll rate).
     Each tick pushes a MEASURED value or nothing: the agent's half from Voice's playback tap whenever
     the agent holds the turn, your half from the meter tap while it is alive. With no live source
     there is no push — a frozen strip is the truthful rendering of "no signal to show". */
  function dictationMeterTick() {
    if (!active || !dictation) return;
    const agentTalking = typeof Voice !== 'undefined' && Voice.isSpeaking && Voice.isSpeaking();
    if (agentTalking) pushLevel(agentLevel * AGENT_GAIN, AGENT);
    else if (tapAlive()) pushLevel(tapLevel * 14, SELF);
  }

  function scheduleReconnect(reason) {
    if (!active || reconnectTimer) return;
    closeMicrophone();
    reconnectAttempt++;
    setState('reconnecting');
    setTransientError(`${reason} Reconnecting…`, 8000);
    const seq = sessionSeq;
    const delay = Math.min(6000, 600 * Math.pow(2, Math.min(4, reconnectAttempt - 1)));
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (!active || seq !== sessionSeq) return;
      try {
        const opened = await openMicrophone(seq);
        if (!opened) return;
        reconnectAttempt = 0;
        setError('');
        setState('listening');
        if ($('lv-heard')) $('lv-heard').textContent = 'Microphone reconnected — listening.';
      } catch (error) {
        scheduleReconnect(`Could not reopen the microphone: ${error && error.message || error}.`);
      }
    }, delay);
  }

  function bargeIn() {
    if (!active) return;
    if (paused) { togglePause(); return; }
    if (typeof Voice !== 'undefined' && Voice.stopSpeaking) Voice.stopSpeaking('microphone_button');
    if (dictation && Voice.resumeCoordinator) Voice.resumeCoordinator();
    setState('listening');
    caption('user', 'Listening…');
  }

  function togglePause() {
    if (!active) return;
    paused = !paused;
    if (paused) {
      if (liveStream) { liveStream.cancel(); liveStream = null; }
      if (finalTurn && finalTurn.recognizer) finalTurn.recognizer.cancel();
      for (const turn of queuedAudio) if (turn.recognizer) turn.recognizer.cancel();
      // Pause discards the unfinished take and pending recognition, never sends it accidentally.
      if (partialAbort) partialAbort.abort();
      if (finalAbort) finalAbort.abort();
      partialAbort = finalAbort = null; finalTurn = null;
      partialPending = transcriptionPending = recording = false;
      queuedAudio = []; utterance = []; preRoll = []; utteranceSamples = speechFrames = silenceMs = 0;
      utteranceSeq++;
      if (dictation && typeof Voice !== 'undefined' && Voice.pauseCoordinator) Voice.pauseCoordinator();
    } else if (dictation && typeof Voice !== 'undefined' && Voice.resumeCoordinator) Voice.resumeCoordinator();
    if (stream) stream.getAudioTracks().forEach(track => { track.enabled = !paused; });
    if (tapStream) tapStream.getAudioTracks().forEach(track => { track.enabled = !paused; });
    resetLevel();
    setState(paused ? 'paused' : 'listening');
    caption('user', paused ? 'Microphone paused. Unsent speech discarded.' : 'Listening…');
  }

  function reflectButton(on) {
    const button = $('voice-live');
    if (!button) return;
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Stop Local Live hands-free voice' : 'Start Local Live hands-free voice');
    button.title = on
      ? 'Stop Local Live hands-free voice'
      : 'Local Live hands-free voice — local speech with your active Starnet agent';
  }

  async function start(retry) {
    ensurePanel();
    if (active && !retry) { $('live-voice-panel').hidden = false; return; }
    if (retry) finish(true);
    paused = false; timing = {}; lastAudioStartMs = null;
    // Local Live rides on staged offline speech packages, so ASK the sidecar instead of assuming this particular
    // install is intact before opening the microphone. Going live first and failing on the first model import is
    // how this panel used to show users a raw "Cannot find module" string.
    // A failed sidecar probe refuses before touching the microphone. Every engine below still depends on
    // that sidecar, so "try anyway" can only produce a live-looking session that cannot hear or speak.
    /* ONE ENGINE FOR EVERY STATION (Andrew, 2026-07-30). The provider-native realtime path is deliberately NOT
       taken any more, even where it is available. It gave the smoothest turns but tied the feature to one
       vendor, capped the personality behind that vendor's guardrails, and made the behaviour differ between
       stations depending on who the Commander happened to connect. The built-in engine is slower per turn and
       wins everything else: identical on every provider, no credential at all, and the persona speaks in its
       own words with no third-party ceiling. `realtimeCapability()` and startRealtime() are kept, unreferenced
       from here, so the choice is reversible without rebuilding it — but nothing routes to them.
       ⛔ Do not "restore" the native branch as an optimisation: the divergence it caused IS the bug it looks
       like a fix for. */

    const readiness = await probeAvailability();
    streamAvailable = !!(readiness && readiness.streaming);
    if (readiness && readiness.probeFailed) {
      $('live-voice-panel').hidden = false;
      setState('offline');
      caption('user', readiness.staleSession
        ? 'This page lost its connection when the station restarted.'
        : 'Local Live could not reach the station.');
      caption('agent', readiness.staleSession
        ? 'Reload this page to reconnect, then start Local Live again.'
        : 'Confirm the station is running, then try again.');
      if (readiness.staleSession) {
        setUnrecoverableError('The station restarted — reload this page to reconnect voice.');
      } else {
        setError('Local voice could not reach the station.');
      }
      reflectButton(false);
      return;
    }
    if (readiness && readiness.available === false) {
      // The offline engine is unavailable (explicit opt-out, damaged/custom bundle, or failed probe).
      // That is NOT a reason to refuse: listening has a keyless ladder (Windows dictation through the
      // sidecar) and speaking already works through the Edge floor. Only refuse when neither exists.
      const native = await probeNativeStt();
      if (native && native.available) return startDictation();
      $('live-voice-panel').hidden = false;
      setState('unavailable');
      if ($('lv-model')) $('lv-model').textContent = 'LOCAL MODELS: NOT INSTALLED';
      caption('user', 'Local Live is unavailable in this build.');
      caption('agent', 'The offline speech engine is unavailable in this build, and this platform has no keyless dictation engine, so hands-free listening cannot start. The standard voice controls are unaffected.');
      // The sidecar's `reason` carries a source-checkout hint ("run npm install") that is noise to a user
      // of the installer — it stays in the API and the log, not in the panel's error row.
      setUnrecoverableError('Offline speech models are not installed in this build.');
      reflectButton(false);
      return;
    }
    const seq = ++sessionSeq;
    setError('');
    setState('connecting');
    resetLevel();
    warmupNotice = false;
    caption('agent', '');
    if ($('lv-heard')) $('lv-heard').textContent = 'Opening the microphone…';
    $('live-voice-panel').hidden = false;
    active = true;
    ending = false;
    failed = false;
    bindSession();   // the call belongs to the session it was OPENED in (see the binding note above)
    reflectButton(true);
    if (typeof Voice !== 'undefined') {
      // Entering hands-free means you expect to HEAR the reply. If the speaker is muted, turn it on for the
      // session (restored on exit if we were the ones who flipped it) — otherwise live voice opens silent and
      // looks broken until the Commander hunts down a toggle.
      if (Voice.forceSpeakOn) Voice.forceSpeakOn();
      // Local Live is now Starnet's one hands-free surface. A legacy loop can still exist through
      // older saved state or API callers; close it before attaching this persistent microphone.
      if (Voice.inVoiceMode && Voice.inVoiceMode() && Voice.stopConvo) Voice.stopConvo();
      if (Voice.setLocalTts) Voice.setLocalTts(true);
      if (Voice.attachCoordinator) Voice.attachCoordinator({ onState, onAssistant, onOutputLevel, onTiming, onSpeechInterrupted: value => setTransientError(value.message, 10000) });
    }
    try {
      fetch('/api/local-voice/warm', { method: 'POST' }).catch(() => {});
      const opened = await openMicrophone(seq);
      if (!opened || !active || seq !== sessionSeq) return;
      setState('warming');
      // The hero line is "what you said" — once the mic is genuinely open it goes back to the
      // invitation instead of stalling on the opening message the whole warm-up.
      if ($('lv-heard')) $('lv-heard').textContent = 'Speak naturally — the transcript lands in COMMS.';
      warmupNotice = true;
      caption('agent', 'Microphone is live. Downloading or loading local speech models; this first start can take a few minutes.');
      await pollModels();
      if (!active || seq !== sessionSeq) return;
      clearInterval(modelTimer);
      modelTimer = setInterval(pollModels, 800);
      refreshTask();
      clearInterval(taskTimer);
      taskTimer = setInterval(refreshTask, 500);
    } catch (error) {
      active = false;
      sessionSeq++;
      failed = true;
      setState('offline');
      setError(/permission|denied|allowed/i.test(String(error && error.message || error))
        ? Voice.microphoneHelp()
        : String(error && error.message || error));
      closeMicrophone();
      reflectButton(false);
      if (typeof Voice !== 'undefined') {
        if (Voice.detachCoordinator) Voice.detachCoordinator();
        if (Voice.setLocalTts) Voice.setLocalTts(false);
        // start() may have lifted a user mute before the microphone permission request failed. A failed
        // session must restore that preference just like a normal finish does.
        if (Voice.restoreSpeak) Voice.restoreSpeak();
      }
    }
  }

  /* ===================================================================================================
     THE NATIVE LIVE CALL — the provider itself listens and speaks, over WebRTC.

     This is what Local Live was always meant to be: connect a provider once, then hold a real conversation
     with your agent in that provider's own voice. No second key, no transcription layer of ours, and real
     interruption — the provider runs semantic turn detection on the audio we stream it, so talking over the
     agent cuts it off the way it does with a person.

     The audio path is deliberately OUR microphone stream: the same one that scrolls the level strip. That is
     why the meter and barge-in work here and were dead on the dictation leg — nothing was opening a mic.

     Tool calls arrive on the data channel and are answered against the live station, so "what's running?"
     and "start X" move real workstreams instead of being described. Anything we cannot answer truthfully is
     returned as an error to the model rather than invented.
     =================================================================================================== */

  function activeProvider() {
    try {
      if (typeof Harness !== 'undefined' && Harness.getProv) return String(Harness.getProv() || '');
    } catch (_) {}
    return '';
  }

  async function realtimeCapability() {
    try {
      const q = activeProvider() ? ('?provider=' + encodeURIComponent(activeProvider())) : '';
      const response = await fetch('/api/realtime/status' + q, { cache: 'no-store' });
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  /* WHO IS SPEAKING, AND WHAT DO THEY KNOW.
     The live call must BE the selected agent — same name, same persona, same composed system prompt the typed
     chat uses — not a separate "voice assistant" bolted on beside it. It also has to know the station it is
     standing in: which crew exist, which sessions are open, which one is active, what is running. The server's
     starting instructions are deliberately generic because only the page knows any of this, so the moment the
     channel opens we replace them with the real thing, and refresh whenever the station changes underneath. */
  function stationContext() {
    const agent = (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
    const crew = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
    const streams = (typeof Workstreams !== 'undefined' && Workstreams.list) ? (Workstreams.list() || []) : [];
    const activeWs = (typeof Workstreams !== 'undefined' && Workstreams.active) ? Workstreams.active() : null;
    return { agent, crew, streams, activeWs };
  }

  function voiceInstructions() {
    const ctx = stationContext();
    const agent = ctx.agent;
    const name = (agent && agent.name) || 'the station agent';
    const lines = [];
    // 1) IDENTITY — the agent's own composed prompt, verbatim. It already carries persona, role, dossier and
    //    crew clause, so the spoken agent and the typed agent are the same character rather than two.
    if (agent && agent.systemPrompt) lines.push(String(agent.systemPrompt));
    lines.push('You are ' + name + ', speaking aloud to the Commander in StarNet. You are the SAME agent they type to — same memory, same work, same voice of character. Never describe yourself as a separate voice assistant or a control layer.');
    /* 2) THE PERSONALITY IS THE POINT, AND SPEAKING IT ALOUD MUST NOT SAND IT DOWN.
       This block used to say "speak naturally and briefly, a sentence or two at a time", which quietly
       overrode the persona above and produced a flat, careful assistant no matter which archetype was
       chosen. The Commander picked that personality deliberately — UNHINGED even arms a two-press confirm
       because it swears for real — so the spoken register has to match the typed one exactly. State it
       explicitly, because a realtime model defaults to a polite house style unless told otherwise. */
    const persona = (typeof Personas !== 'undefined' && Personas.get && agent && agent.personaId) ? Personas.get(agent.personaId) : null;
    if (persona) {
      if (persona.promptInjection) lines.push(String(persona.promptInjection));
      lines.push('That personality — ' + (persona.name || agent.personaId) + ' — is your ACTUAL speaking voice here, not a description of one. Deliver it out loud with the same register, vocabulary and attitude you would use in writing. Do not soften it, sanitise it, or default to a neutral assistant tone because this is speech.');
      lines.push('Swearing: if your personality swears, swear — naturally and uncensored, never bleeped, never spelled around, never replaced with a milder word. If it does not, do not.');
    }
    lines.push('Speak in a natural spoken rhythm — the length a person would actually say out loud rather than a written paragraph. Let the Commander interrupt you at any moment and stop immediately when they do.');
    // 3) THE STATION, as it is right now.
    if (ctx.crew.length) {
      lines.push('The crew on this station: ' + ctx.crew.map(a => (a.name || a.id) + (a.role ? ' (' + a.role + ')' : '')).join('; ') + '.');
    }
    if (ctx.streams.length) {
      lines.push('Open sessions: ' + ctx.streams.slice(0, 12).map(w => (w.title || 'General')).join('; ') + '.');
    }
    if (ctx.activeWs) lines.push('The active session is "' + (ctx.activeWs.title || 'General') + '".');
    lines.push('Call get_starnet_status before answering any question about what is running, what is waiting for approval, or what the crew is doing — never guess or invent task state, tool results, approvals or files.');
    lines.push('For anything requiring research, code, file changes, tools or sustained work, call start_starnet_task rather than claiming you did it yourself. Afterwards confirm in one short sentence and note that the work is visible in the session.');
    lines.push('Use interrupt_starnet_task only when the Commander clearly asks to stop or change direction.');
    lines.push('Do not ask for credentials or read secrets aloud.');
    return lines.join('\n\n');
  }

  function pushSessionContext() {
    return sendEvent({ type: 'session.update', session: { type: 'realtime', instructions: voiceInstructions() } });
  }

  /* THE CONVERSATION IS A SESSION, NOT A SEPARATE LAYER.
     Everything said aloud is written into the active session's transcript, so voice history is the same
     history — scrollable afterwards, and part of the record the agent itself reads back. Without this the
     panel is a room you talk into that keeps nothing. */
  function recordUserTurn(text) {
    const said = String(text || '').trim();
    if (!said) return;
    try { if (typeof Chat !== 'undefined' && Chat.echoUser) Chat.echoUser(said); } catch (_) {}
  }
  let spokenBuffer = '';
  function recordAgentTurn(text, done) {
    const chunk = String(text || '');
    if (!done) { spokenBuffer += chunk; return; }
    const said = (chunk || spokenBuffer).trim();
    spokenBuffer = '';
    if (!said) return;
    // Silent, and effectively instant: the voice IS the delivery, so the transcript should simply BE there
    // rather than typing itself out under speech that has already finished saying it.
    try { if (typeof Chat !== 'undefined' && Chat.typeLine) Chat.typeLine([{ text: said, cps: 1200 }], null, { silent: true }); } catch (_) {}
  }

  // ---- the three tools the session config declares, answered from live station state ----
  async function runVoiceTool(name, args) {
    if (name === 'get_starnet_status') {
      const snap = statusSnapshot();
      if (!snap || snap.active === null && !(snap.workstreams || []).length) {
        return { ok: false, error: 'the station is still starting up — no workstreams are readable yet' };
      }
      return { ok: true, ...snap };
    }
    if (name === 'start_starnet_task') {
      const instruction = String((args && args.instruction) || '').trim();
      if (!instruction) return { ok: false, error: 'no instruction was given' };
      const dispatch = (typeof Chat !== 'undefined') && (Chat.sendOrQueue || Chat.send);
      if (!dispatch) return { ok: false, error: 'the chat surface is not ready' };
      try {
        // sendOrQueue, not send: the tool's own description promises "queued as a follow-up if busy", and this
        // is the call that actually does that. It is the SAME path a typed message takes, so a spoken task is
        // indistinguishable downstream — same approvals, same ledger, same visible transcript.
        const queued = !!(typeof Chat.isBusy === 'function' && Chat.isBusy());
        await dispatch.call(Chat, instruction);
        return { ok: true, started: !queued, queued, instruction };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    }
    if (name === 'interrupt_starnet_task') {
      const stop = (typeof Chat !== 'undefined') && (Chat.stopActive || Chat.abort);
      if (!stop) return { ok: false, error: 'nothing to interrupt' };
      if (typeof Chat.isBusy === 'function' && !Chat.isBusy()) return { ok: true, interrupted: false, note: 'nothing was running' };
      try { await stop.call(Chat); return { ok: true, interrupted: true }; }
      catch (error) { return { ok: false, error: String((error && error.message) || error) }; }
    }
    return { ok: false, error: 'unknown tool: ' + name };
  }

  function sendEvent(payload) {
    if (!dataChannel || dataChannel.readyState !== 'open') return false;
    try { dataChannel.send(JSON.stringify(payload)); return true; } catch (_) { return false; }
  }

  async function onRealtimeEvent(raw) {
    let event;
    try { event = JSON.parse(raw); } catch (_) { return; }
    const type = String(event.type || '');

    // what the Commander said (the provider transcribes its own input)
    if (/input_audio_transcription\.completed$/.test(type) && event.transcript) {
      const said = String(event.transcript).trim();
      caption('user', said);
      recordUserTurn(said);        // …and into the session, so voice history IS chat history
      return;
    }
    // what the agent is saying
    if (/output_audio_transcript\.(delta|done)$/.test(type)) {
      const text = String(event.delta || event.transcript || '');
      const done = /done$/.test(type);
      if (text || done) caption('agent', text, !done);
      recordAgentTurn(text, done);
      return;
    }
    if (type === 'input_audio_buffer.speech_started') {
      if (typeof Voice !== 'undefined' && Voice.recordSpeechEvent) Voice.recordSpeechEvent('provider_speech_started', { mode: 'realtime' });
      setState('hearing'); return;
    }
    if (type === 'response.created') { setState('thinking'); return; }
    if (type === 'output_audio_buffer.started' || type === 'response.output_audio.delta') { setState('speaking'); return; }
    if (type === 'response.done' || type === 'output_audio_buffer.stopped') { if (active) setState('listening'); return; }

    // a tool the model wants run. Answer it, hand the result back, and ask for the spoken follow-up.
    if (type === 'response.function_call_arguments.done') {
      let args = {};
      try { args = JSON.parse(event.arguments || '{}'); } catch (_) {}
      const result = await runVoiceTool(String(event.name || ''), args);
      sendEvent({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) }
      });
      sendEvent({ type: 'response.create' });
      return;
    }
    if (type === 'error') {
      const message = (event.error && (event.error.message || event.error.code)) || 'the live session reported an error';
      setTransientError(String(message));
    }
  }

  async function startRealtime(capability) {
    const seq = ++sessionSeq;
    setError('');
    setState('connecting');
    resetLevel();
    warmupNotice = false;
    caption('agent', '');
    if ($('lv-heard')) $('lv-heard').textContent = 'Opening the microphone…';
    $('live-voice-panel').hidden = false;
    active = true;
    realtime = true;
    ending = false;
    failed = false;
    callProvider = capability && capability.provider ? String(capability.provider) : activeProvider();
    reflectButton(true);
    if (typeof Voice !== 'undefined') {
      // The provider speaks for itself here, so OUR text-to-speech must stay silent or the reply is doubled.
      if (Voice.inVoiceMode && Voice.inVoiceMode() && Voice.stopConvo) Voice.stopConvo();
      if (Voice.setLocalTts) Voice.setLocalTts(false);
      if (Voice.stopSpeaking) Voice.stopSpeaking();
      if (Voice.attachCoordinator) Voice.attachCoordinator({ onState, onAssistant, onOutputLevel, onTiming });
    }
    try {
      const opened = await openMicrophone(seq);
      if (!opened || !active || seq !== sessionSeq) return;

      pc = new RTCPeerConnection();
      remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.style.display = 'none';
      document.body.appendChild(remoteAudio);
      pc.ontrack = event => { if (event.streams && event.streams[0]) remoteAudio.srcObject = event.streams[0]; };
      pc.onconnectionstatechange = () => {
        if (!active || seq !== sessionSeq || !pc) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          scheduleReconnect('The live voice connection dropped.');
        }
      };
      const micTrack = stream && stream.getAudioTracks()[0];
      if (micTrack) pc.addTrack(micTrack, stream);

      dataChannel = pc.createDataChannel('oai-events');
      dataChannel.onmessage = event => { onRealtimeEvent(event.data); };
      // The server can only send generic instructions — it does not know which agent is selected or what is
      // open. The instant the channel is live, replace them with THIS agent's identity and the real station
      // state, then keep them current: switching agent or session mid-call must not leave the voice talking
      // as whoever was selected when it started.
      dataChannel.onopen = () => {
        pushSessionContext();
        clearInterval(contextTimer);
        contextTimer = setInterval(() => {
          if (!active || !realtime) return;
          const fingerprint = JSON.stringify([
            (stationContext().agent || {}).id || '',
            ((stationContext().activeWs || {}).id) || '',
            (stationContext().streams || []).length
          ]);
          if (fingerprint === lastContextFingerprint) return;
          lastContextFingerprint = fingerprint;
          pushSessionContext();
        }, 2000);
      };

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      // The call is created from a COMPLETE offer, so wait for ICE gathering rather than trickling — there is
      // no signalling channel back to the provider to trickle on.
      await new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const done = () => { if (pc && pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
        pc.addEventListener('icegatheringstatechange', done);
        setTimeout(resolve, 2000);   // never hang the panel on a stalled gather
      });
      if (!active || seq !== sessionSeq) return;

      setState('warming');
      // The spoken voice is a CHOICE, not a constant. Stored per station; the server validates it against the
      // provider's real voice list (status().voices) and falls back to the descriptor default.
      let wantVoice = '';
      try { wantVoice = String(localStorage.getItem(LOCAL_VOICE_KEY) || '').trim(); } catch (_) {}
      const q = '?' + [
        callProvider ? 'provider=' + encodeURIComponent(callProvider) : '',
        wantVoice ? 'voice=' + encodeURIComponent(wantVoice) : ''
      ].filter(Boolean).join('&');
      const response = await fetch('/api/realtime/session' + q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp
      });
      const answer = await response.text();
      if (!response.ok) {
        let message = answer;
        try { message = JSON.parse(answer).error || answer; } catch (_) {}
        throw new Error(String(message).slice(0, 300));
      }
      if (!active || seq !== sessionSeq) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });

      setState('listening');
      if ($('lv-model')) $('lv-model').textContent =
        ('LIVE · ' + (capability && capability.model ? capability.model : 'provider voice')).toUpperCase();
      if ($('lv-heard')) $('lv-heard').textContent = 'Speak naturally — interrupt any time.';
      refreshTask();
      clearInterval(taskTimer);
      taskTimer = setInterval(refreshTask, 500);
    } catch (error) {
      active = false;
      realtime = false;
      sessionSeq++;
      failed = true;
      setState('offline');
      setError(/permission|denied|allowed/i.test(String(error && error.message || error))
        ? Voice.microphoneHelp()
        : String(error && error.message || error));
      teardownRealtime();
      closeMicrophone();
      reflectButton(false);
      if (typeof Voice !== 'undefined' && Voice.detachCoordinator) Voice.detachCoordinator();
    }
  }

  function teardownRealtime() {
    try { if (dataChannel) dataChannel.close(); } catch (_) {}
    try { if (pc) { pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); } } catch (_) {}
    try {
      if (remoteAudio) {
        remoteAudio.srcObject = null;
        if (remoteAudio.parentNode) remoteAudio.parentNode.removeChild(remoteAudio);
      }
    } catch (_) {}
    clearInterval(contextTimer); contextTimer = null; lastContextFingerprint = ''; spokenBuffer = '';
    dataChannel = null; pc = null; remoteAudio = null; realtime = false; callProvider = '';
  }

  /* DICTATION MODE — Local Live without the offline models.
     Differences from the model path, all deliberate:
       - THIS side never opens a microphone FOR AUDIO. On the native leg System.Speech captures from
         inside the sidecar; on the browser-speech leg the browser engine owns the capture. What this
         side does open is a levels-only meter tap (openMeterTap) — mic sharing is measured-safe on
         Windows, see the note there — so the strip shows the same two-voice meter as the models leg.
         The native leg still has no interim partials: it returns one finished utterance per call.
       - local TTS stays OFF (Kokoro is absent too), so speech goes down the normal ladder and lands
         on the keyless Edge floor.
       - `startCoordinator`, not `attachCoordinator`: only the former SELECTS an stt provider, and with
         no browser SpeechRecognition (the WebView2 case) it picks the native dictation provider. This is
         the ladder that already existed and that nothing was calling. */
  function startDictation() {
    const seq = ++sessionSeq;
    setError('');
    resetLevel();
    warmupNotice = false;
    caption('agent', '');
    $('live-voice-panel').hidden = false;
    active = true;
    dictation = true;
    ending = false;
    failed = false;
    bindSession();   // the shipped path binds too — the call belongs to the session it was opened in
    reflectButton(true);
    if (typeof Voice !== 'undefined') {
      /* ⛔ THE SAME LEVER start() PULLS, INCLUDING THE DEGRADE PATH. An explicit opt-out or damaged/custom
         bundle lands here even in an installed station. Wiring the speaker auto-enable only into the models
         path left that room muted: the Commander could talk, but never hear an answer. */
      if (Voice.forceSpeakOn) Voice.forceSpeakOn();
      if (Voice.inVoiceMode && Voice.inVoiceMode() && Voice.stopConvo) Voice.stopConvo();
      /* setLocalTts(TRUE) on the dictation leg too (2026-07-30). This flag means "speak with the BUILT-IN
         live-voice identity", not "the Kokoro engine is installed": the sidecar now maps the picked voice
         onto the keyless Edge floor when the engine is absent, so the picker keeps working on an installed
         build. Passing false here is what disconnected the picker and let the keyed provider voice speak —
         the identity bug Andrew heard. */
      if (Voice.setLocalTts) Voice.setLocalTts(true);
      if (Voice.startCoordinator) Voice.startCoordinator({ onState, onAssistant, onOutputLevel, onTiming, onTranscript: handleTranscript,
        onInterim: text => { if (!paused && text) { caption('user', text); setState('hearing'); } } });
    }
    if (!active || seq !== sessionSeq) return;
    // The meter is real on this leg too (see openMeterTap): the tap arrives whenever the permission
    // settles; until then — and if it never opens — only the agent's half moves, off its playback tap.
    openMeterTap(seq);
    clearInterval(meterClock);
    meterClock = setInterval(dictationMeterTick, 43);
    setState('listening');
    // Name the engine the ladder ACTUALLY chose, read back from Voice rather than re-derived here. In the
    // packaged WebView2 shell there is no SpeechRecognition so this is the sidecar's Windows dictation; in a
    // plain browser the same ladder picks the browser engine, and calling that "Windows dictation" would be
    // a lie of exactly the kind this panel is not allowed to tell.
    const engine = (typeof Voice !== 'undefined' && Voice.sttEngine) ? Voice.sttEngine() : '';
    // Names are voice.js's own provider ids — 'native' | 'web-speech' | 'recorder'. Verified by reading them
    // back live, not assumed: guessing 'web' here rendered "ASR UNKNOWN" in a browser.
    const engineLabel = engine === 'native' ? 'WINDOWS DICTATION'
      : engine === 'web-speech' ? 'BROWSER SPEECH'
      : engine === 'recorder' ? 'SERVER WHISPER'
      : 'UNKNOWN';
    if ($('lv-model')) $('lv-model').textContent = `ASR ${engineLabel} · VOICE EDGE`;
    // …then name the PICKED voice once the catalogue answers, so the label shows the choice is live on this
    // build too (the sidecar maps it onto the nearest Edge neural when the offline engine is absent).
    voices().then(v => {
      if (!active || seq !== sessionSeq || !$('lv-model')) return;
      const row = (v.available || []).find(x => x && x.id === v.current);
      if (row && row.label) $('lv-model').textContent = `ASR ${engineLabel} · VOICE ${row.label} (EDGE)`;
    }).catch(() => {});
    if ($('lv-heard')) $('lv-heard').textContent = 'Speak naturally — the transcript lands in COMMS.';
    caption('agent', engine === 'web-speech'
      ? 'Listening with browser speech recognition. Your words appear as they are recognized.'
      : 'Listening with Windows dictation. This fallback returns words after each utterance; live previews require the local speech models.');
    refreshTask();
    clearInterval(taskTimer);
    taskTimer = setInterval(refreshTask, 500);
  }

  function finish(stopVoice) {
    if (ending) return;
    ending = true;
    active = false;
    sessionSeq++;
    clearInterval(taskTimer); taskTimer = null;
    clearInterval(modelTimer); modelTimer = null;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    clearTimeout(transientErrorTimer); transientErrorTimer = null;
    reconnectAttempt = 0;
    queuedAudio = []; paused = false;
    teardownRealtime();   // close the peer connection BEFORE the mic, so no track is yanked mid-send
    closeMicrophone();
    clearInterval(meterClock); meterClock = null;
    closeMeterTap();
    if (typeof Voice !== 'undefined') {
      if (stopVoice && Voice.stopSpeaking) Voice.stopSpeaking();
      if (Voice.restoreSpeak) Voice.restoreSpeak();   // only undoes a mute WE lifted; a hand-set speaker stays
      // Dictation mode STARTED the coordinator (which armed a listen loop), so detaching the hooks is not
      // enough — that loop has to be stopped or the sidecar keeps being asked to dictate after the panel closes.
      if (dictation && Voice.stopCoordinator) Voice.stopCoordinator();
      if (Voice.detachCoordinator) Voice.detachCoordinator();
      if (Voice.setLocalTts) Voice.setLocalTts(false);
    }
    dictation = false;
    boundWsId = null;   // the binding dies with the call — a later call binds to wherever it is opened
    if ($('live-voice-panel')) $('live-voice-panel').hidden = true;
    reflectButton(false);
    ending = false;
  }
  function end() { finish(true); }

  function init() {
    ensurePanel();
    const button = $('voice-live');
    if (button) button.onclick = () => active ? end() : start(false);
    window.addEventListener('resize', () => clampPanel($('live-voice-panel')));
    document.addEventListener('visibilitychange', () => {
      // The dictation leg's meter tap is cosmetic: resume its context if the platform suspended it while
      // hidden, and on failure just leave the half flat — never a reconnect, never session state.
      if (active && dictation && !document.hidden && tapContext && tapContext.state === 'suspended') {
        tapContext.resume().catch(() => {});
      }
      // Dictation mode holds no transcription mic, so `stream`/`context` are null by design — the checks
      // below would read that as "microphone lost" and fire a reconnect that opens a device we must not touch.
      if (!active || dictation || document.hidden) return;
      if (context && context.state === 'suspended') context.resume().catch(() => scheduleReconnect('Audio session was suspended.'));
      const track = stream && stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') scheduleReconnect('Microphone connection was lost.');
    });
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        if (!active || dictation) return;   // no browser mic in dictation mode — see visibilitychange above
        const track = stream && stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') scheduleReconnect('Audio device changed.');
      });
    }
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && active) end(); });
  }

  // The built-in catalogue is sidecar-owned. Agent assignments share Voice's persistent
  // selection path; an ongoing call keeps each speaker pinned until a new session.
  async function voices(agentId) {
    const assigned = Voice.voiceChoice(agentId);
    const cur = Voice.localVoiceId(agentId);
    try {
      const r = await fetch('/api/local-voice/status', { cache: 'no-store' });
      const j = await r.json();
      return { available: j.voices || [], current: cur || j.voice || '', assigned, engine: 'built-in', appliesOn: 'the next spoken reply or new Live Voice session' };
    } catch (_) {
      return { available: [], current: cur, assigned, engine: 'built-in', appliesOn: 'the next spoken reply or new Live Voice session' };
    }
  }
  function setVoice(id, agentId) {
    return Voice.setVoiceChoice(id, agentId);
  }

  return { init, start, end, isActive: () => active, statusSnapshot, voices, setVoice, rebind, boundSessionId: () => boundWsId };
})();

document.addEventListener('DOMContentLoaded', () => VoiceLive.init());
