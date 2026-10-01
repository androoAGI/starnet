/* frontend/app/avatar-call.js — VIDEO CALL with the station's lead agent, through a Simli talking face.

   WHO DOES WHAT
     Simli     the face only: it receives 16 kHz PCM and streams back lip-synced video (+ the matching audio).
     StarNet   ears and voice: the mic, voice-activity detection and /api/stt on the way in; /api/tts on the
               way out. Nothing but synthesized audio is ever sent to Simli.
     Sidecar   /api/avatar/reply — ONE streamed completion on the lead agent's own provider: the fast front.
     Harness   unchanged. Real work only reaches it through start_starnet_task → Chat.sendOrQueue, the exact
               path a typed message takes (same approvals, ledger and transcript).

   SPEED. Local Live sends every utterance through a full harness run, so small talk paid for a whole agentic
   turn. Here a spoken turn is a single streamed completion with reasoning off; the reply is cut into
   clauses/sentences while it streams, and each piece is synthesized and fed to the face as soon as it exists.
   The live station state rides in the prompt, so status questions cost no extra round-trip.

   INTERRUPTED BY WORDS, NEVER BY NOISE. A sound only opens a candidate utterance. The avatar keeps talking
   until a transcript proves the Commander said something (see AvatarCore.shouldInterrupt) — a cough, a
   keyboard, a "yeah" or the avatar's own echo does not cut it off.

   NO TOOLS UNLESS ASKED. The model has exactly two hand-off actions and the prompt forbids them unless the
   Commander explicitly asks for something to be done. Approvals are never given by voice — they are announced
   and answered on screen, where they always were.

   Self-contained: the Simli SDK bundle loads lazily on the first call, and the dock button stays hidden unless
   the sidecar reports a Simli key (Settings → KEYS), so a station without one sees no change at all. */
const AvatarCall = (() => {
  'use strict';

  const Core = (typeof AvatarCore !== 'undefined') ? AvatarCore : null;
  const SDK_SRC = 'vendor/simli-sdk.js';
  const RATE = 16000;                    // Simli and every STT route take 16 kHz mono
  const SEND_BYTES = 6000;               // PCM chunk per websocket frame (~190 ms)
  const HISTORY_TURNS = 24;              // messages of call history sent per turn
  const WATCH_MS = 1500;                 // station poll for finished tasks / new approvals
  const RECENT_LINES = 6, RECENT_CHARS = 500;
  const PREROLL_MS = 400;                // audio kept from before speech was detected, so first syllables survive
  const BARGE_CHECKS_MS = [700, 1500];   // voiced-time marks at which an overlapping utterance is transcribed early
  const FACE_KEY = 'starnet.avatarCall.faceId.v1';
  const GEOM_KEY = 'starnet.avatarCall.geometry.v1';
  const CAPTIONS_KEY = 'starnet.avatarCall.captions.v1';   // 'off' (default: the voice is enough) | 'on'
  const MIN_WIDTH = 220, MAX_WIDTH = 960, EDGE = 8;
  const MODE_KEY = 'starnet.avatarCall.interrupt.v1';
  const HEAR_KEY = 'starnet.avatarCall.hearing.v1';
  const VOICE_KEY = 'starnet.avatarCall.voice.v1';
  const EL_VOICE_KEY = 'starnet.avatarCall.elevenlabsVoice.v1';
  const EL_VOICE_RE = /^[A-Za-z0-9]{8,48}$/;

  let sdkPromise = null;
  let faceVoice = '';                    // the voice the sidecar matched to this call's face (session response)
  // ElevenLabs as the call voice (VOICE → ELEVENLABS). The key lives in the sidecar (Settings → KEYS).
  // configured: true/false once the sidecar reports it; null = unknown (a sidecar started before this feature
  // existed says nothing) — then ElevenLabs is simply tried when picked, and /api/tts answers either way.
  let elevenlabs = { configured: null, voiceId: '', model: 'eleven_flash_v2_5' };
  let elFallbackNoted = false;
  let elOffForCall = false;              // ElevenLabs said "no key" this call: stop asking it until the next call
  let simli = null;
  let active = false, starting = false;
  let status = null;                     // /api/avatar/status
  let stt = { local: false, cloud: false, native: false };   // /api/stt/status
  let history = [];                      // the call's own conversation, [{ role, content }]
  let replyCtl = null;                   // AbortController of the in-flight /api/avatar/reply
  let replySpoken = '';                  // what the in-flight reply has streamed so far
  let turnSeq = 0;
  let watchTimer = null, statusTimer = null;
  let watchState = new Map();            // workstream id -> { busy, pending }
  const notices = Core ? Core.makeNoticeQueue() : null;   // announcements held until the floor is free
  // The crew has the floor: another agent is being spoken by the chat voice (Voice). See crewTick().
  const crewGate = Core ? Core.makeCrewGate({ graceMs: 700 }) : null;
  const CREW_TICK_MS = 150;
  let crewTimer = null;
  let crewTextSeen = '';
  const echoed = new Set();              // lines this call wrote into the session transcript

  // speaking
  let speakGen = 0;
  let speakQueue = [];                   // [{ gen, text, ctl, pcm: Promise<Uint8Array|null> }]
  let pumping = false;
  let speakingUntil = 0;                 // wall-clock estimate of when queued audio finishes
  let faceSpeaking = false;              // Simli's own speaking/silent events
  let recentSpoken = [];                 // last few spoken lines, for echo rejection

  // hearing
  let mic = null;                        // { stream, ctx, source, proc, sink }
  let micMuted = false;
  let vad = null;
  let preroll = [], prerollMs = 0;
  let utter = null;                      // { frames, overlapped, checks, interrupted, seq }
  let utterSeq = 0;

  const $ = id => document.getElementById(id);

  // ---- plumbing ------------------------------------------------------------------------------------------
  function apiToken() {
    try { if (typeof Harness !== 'undefined' && Harness.apiToken) { const t = Harness.apiToken(); if (t) return String(t); } } catch (_) {}
    try { return String(window.__STARNET_API_TOKEN__ || ''); } catch (_) { return ''; }
  }
  function headers(type) {
    const h = {};
    if (type) h['Content-Type'] = type;
    const t = apiToken(); if (t) h['X-StarNet-Token'] = t;
    return h;
  }
  function loadSdk() {
    if (window.SimliSDK) return Promise.resolve(window.SimliSDK);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SDK_SRC; s.async = true;
      s.onload = () => window.SimliSDK ? resolve(window.SimliSDK) : reject(new Error('video SDK failed to initialise'));
      s.onerror = () => { sdkPromise = null; reject(new Error('video SDK could not be loaded')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }
  function pref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; } }
  function setPref(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
  function interruptMode() { return pref(MODE_KEY, 'words') === 'stop' ? 'stop' : 'words'; }
  /* Hearing. 'fast' = on-device Whisper first: measured ~0.45 s per utterance against ~0.7-1.1 s warm (3 s cold)
     for the cloud route, and nothing leaves the machine — but the on-device model is English-only.
     'accurate' = cloud first (Groq/OpenAI via the sidecar): any language, better on accents and noisy rooms. */
  function hearingMode() { return pref(HEAR_KEY, 'fast') === 'accurate' ? 'accurate' : 'fast'; }

  // ---- who is on the call --------------------------------------------------------------------------------
  function leadAgent() {
    try {
      const crew = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
      const lead = crew.find(a => a.role === 'orchestrator') || crew.find(a => a.id === 'agent');
      if (lead) return lead;
      return (typeof App !== 'undefined' && App.currentAgent) ? App.currentAgent() : null;
    } catch (_) { return null; }
  }
  function leadName() { const a = leadAgent(); return (a && (a.name || a.id)) || 'your lead agent'; }

  /* The live station, read fresh every turn so the agent answers from what is true NOW. Volatile, so it goes
     LAST in the prompt: the stable identity above it stays a cacheable prefix. */
  function stationBlock() {
    const lines = [];
    try {
      const crew = (typeof App !== 'undefined' && App.agents) ? (App.agents() || []) : [];
      if (crew.length) lines.push('Crew: ' + crew.map(a => (a.name || a.id) + (a.role ? ' (' + a.role + ')' : '')).join('; ') + '.');
    } catch (_) {}
    try {
      if (typeof Workstreams !== 'undefined' && typeof Channels !== 'undefined') {
        const act = Workstreams.active();
        const rows = (Workstreams.list() || []).slice(0, 12).map(ws => {
          const pending = Channels.pendingOf(ws.id);
          const state = pending ? 'WAITING FOR APPROVAL' + (pending.tool ? ' (' + pending.tool + ')' : '') : Channels.isBusy(ws.id) ? 'WORKING' : 'idle';
          const st = Channels.statusOf(ws.id);
          return '- "' + (ws.title || 'General') + '"' + (act && act.id === ws.id ? ' [active]' : '') + ': ' + state + (st && state !== 'idle' ? ' — ' + String(st).slice(0, 160) : '');
        });
        if (rows.length) lines.push('Sessions right now:\n' + rows.join('\n'));
      }
    } catch (_) {}
    try {
      if (typeof Chat !== 'undefined' && Chat.getHistory) {
        // The call's own lines are already in the conversation; this block is for the WORK around it.
        const recent = (Chat.getHistory() || []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim() && !echoed.has(m.content.trim())).slice(-RECENT_LINES);
        if (recent.length) {
          lines.push('Latest in the active session (oldest first):\n' + recent.map(m => (m.role === 'user' ? 'Commander: ' : 'Agent: ') + m.content.replace(/\s+/g, ' ').slice(0, RECENT_CHARS)).join('\n'));
        }
      }
    } catch (_) {}
    return lines.join('\n\n');
  }

  function instructions() {
    const agent = leadAgent();
    const name = leadName();
    const out = [];
    let composed = '';
    try { if (agent && typeof App !== 'undefined' && App.systemFor) composed = App.systemFor(agent.id) || ''; } catch (_) {}
    if (!composed && agent && agent.systemPrompt) composed = agent.systemPrompt;
    if (composed) out.push(String(composed));   // identity, persona, dossier, standing orders — the same agent as in COMMS
    out.push([
      '# LIVE VIDEO CALL',
      'You are ' + name + ', on a live video call with the Commander. You are the same agent they type to in StarNet — same memory, same work, same character. Never describe yourself as a separate assistant or avatar.',
      'Everything you write is spoken aloud by your video avatar the moment you write it. Talk like a person on a call: usually one to three short sentences, the most important thing first. Go longer only when the Commander asks for detail.',
      'No markdown, bullet lists, headings, code, tables, emoji or URLs — none of it can be spoken. Say numbers and names the way a person would.',
      'What you hear is a live speech transcript and may contain recognition mistakes; if something sounds garbled, ask a short clarifying question instead of guessing.',
      'Keep your established personality and register; being spoken does not reset it.'
    ].join('\n'));
    out.push([
      '# ACTIONS — ONLY WHEN EXPLICITLY ASKED',
      'You have two actions: start_starnet_task (hands work to the StarNet crew, who run it with their full tools) and interrupt_starnet_task (stops running work).',
      'Call start_starnet_task ONLY when the Commander explicitly asks you to do something now: run, build, create, write, change, send, research, look up, fix, schedule. Discussion, brainstorming, opinions, plans, "what do you think" and status questions are NOT requests — answer them from what you know and the station state below.',
      'If you are unsure whether they want action, ask one short question ("Want me to put the crew on that?") instead of acting.',
      'When you do start a task, first say one short sentence (for example "On it, I\'ll have the crew pull that together."), then call the action with a complete, self-contained instruction.',
      'Call interrupt_starnet_task only when the Commander clearly asks to stop, cancel or change course on running work.',
      'Never claim you did work, ran tools or know results that are not in the station state below. Approvals are given on screen, never by voice: if something is waiting for approval, tell them it is on screen.',
      'Never ask for or read out credentials or secrets.'
    ].join('\n'));
    const station = stationBlock();
    if (station) out.push('# STATION STATE (live, as of this turn)\n' + station);
    return out.join('\n\n');
  }

  // ---- panel ---------------------------------------------------------------------------------------------
  function ensurePanel() {
    if ($('avatar-call-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'avatar-call-panel';
    panel.className = 'avatar-call-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Video call with your lead agent');
    panel.innerHTML = [
      '<header class="ac-head">',
        '<span class="ac-pip" aria-hidden="true"></span>',
        '<span id="ac-title" class="ac-title">VIDEO CALL</span>',
        '<span id="ac-state" class="ac-state" aria-live="polite">CONNECTING</span>',
      '</header>',
      '<div class="ac-stage"><video id="ac-video" class="ac-video" autoplay playsinline muted></video><audio id="ac-audio" autoplay></audio></div>',
      '<p id="ac-heard" class="ac-line ac-heard" aria-live="polite"></p>',
      '<p id="ac-said" class="ac-line ac-said"></p>',
      '<p id="ac-task" class="ac-task"></p>',
      '<div id="ac-error" class="ac-error" hidden></div>',
      '<div class="ac-controls">',
        '<button id="ac-mute" class="bb" type="button" aria-pressed="false">MUTE MIC</button>',
        '<button id="ac-hush" class="bb" type="button" title="Stop the avatar talking">HUSH</button>',
        '<button id="ac-end" class="bb ac-end" type="button">END CALL</button>',
      '</div>',
      '<details class="ac-details"><summary>CALL SETTINGS</summary>',
        '<label class="ac-field"><span>CAPTIONS</span><select id="ac-captions">',
          '<option value="off">HIDDEN · VOICE ONLY</option>',
          '<option value="on">SHOWN · WHAT WAS SAID</option>',
        '</select></label>',
        '<label class="ac-field"><span>INTERRUPT ME</span><select id="ac-mode">',
          '<option value="words">WHEN I SAY SOMETHING</option>',
          '<option value="stop">ONLY WHEN I SAY STOP</option>',
        '</select></label>',
        '<label class="ac-field"><span>HEARING</span><select id="ac-hear">',
          '<option value="fast">FAST · ON-DEVICE (ENGLISH)</option>',
          '<option value="accurate">ACCURATE · CLOUD (ANY LANGUAGE)</option>',
        '</select></label>',
        '<label class="ac-field"><span>VOICE</span><select id="ac-voice"><option value="">AUTO · MATCH THE FACE</option><option value="elevenlabs">ELEVENLABS · YOUR OWN VOICE</option></select></label>',
        '<label class="ac-field" id="ac-el-row"><span>ELEVENLABS ID</span><input id="ac-el-voice" type="text" spellcheck="false" autocomplete="off" placeholder="voice id from ElevenLabs → Voices"></label>',
        '<p id="ac-voice-now" class="ac-voice-now"></p>',
        '<label class="ac-field"><span>FACE ID</span><input id="ac-face" type="text" spellcheck="false" autocomplete="off" placeholder="Simli face id (applies next call)"></label>',
      '</details>',
      '<div class="ac-grip" title="Drag to resize" aria-hidden="true"></div>'
    ].join('');
    document.body.appendChild(panel);
    restoreGeometry(panel);
    makeMovable(panel);
    $('ac-end').onclick = end;
    $('ac-mute').onclick = toggleMute;
    $('ac-hush').onclick = () => { abandonReply(); setState('listening'); };
    // Captions: the transcript lines under the video. Hidden unless asked for — the call is heard, not read.
    const captions = $('ac-captions');
    captions.value = pref(CAPTIONS_KEY, 'off') === 'on' ? 'on' : 'off';
    panel.dataset.captions = captions.value;
    captions.onchange = () => { panel.dataset.captions = captions.value; setPref(CAPTIONS_KEY, captions.value); };
    const mode = $('ac-mode');
    mode.value = interruptMode();
    mode.onchange = () => setPref(MODE_KEY, mode.value === 'stop' ? 'stop' : 'words');
    const hear = $('ac-hear');
    hear.value = hearingMode();
    hear.onchange = () => setPref(HEAR_KEY, hear.value === 'accurate' ? 'accurate' : 'fast');
    const voiceSel = $('ac-voice');
    const elRow = $('ac-el-row'), elInput = $('ac-el-voice');
    const reflectVoice = () => {
      // The ID applies under AUTO and ELEVENLABS alike; only picking a built-in voice sets it aside.
      elRow.hidden = !!voiceSel.value && voiceSel.value !== 'elevenlabs';
      elInput.placeholder = elevenlabs.voiceId ? 'station default: ' + elevenlabs.voiceId : 'voice id from ElevenLabs → Voices';
      if (voiceSel.value !== '' && voiceSel.value !== 'elevenlabs') return;
      if (elevenlabs.configured === false) setError('Add your ElevenLabs key in Settings → KEYS; until then the built-in voice speaks.');
    };
    voiceSel.onchange = () => { setPref(VOICE_KEY, voiceSel.value); elFallbackNoted = false; elOffForCall = false; reflectVoice(); };
    elInput.value = pref(EL_VOICE_KEY, '');
    // Saved on every keystroke (not only on blur): an ID typed just before closing the call must not be lost,
    // and the next sentence already speaks with it.
    const saveElVoice = final => {
      const v = elInput.value.trim();
      if (!v || EL_VOICE_RE.test(v)) { setPref(EL_VOICE_KEY, v); elFallbackNoted = false; elOffForCall = false; if (final) setError(''); }
      else if (final) setError('That does not look like an ElevenLabs voice id (letters and digits, from Voices → your voice → ID).');
    };
    elInput.oninput = () => saveElVoice(false);
    elInput.onchange = () => saveElVoice(true);
    panel._reflectVoice = reflectVoice;
    // The station's voice catalogue (same list Local Live offers), each with its sex so a face can be matched.
    fetch('/api/local-voice/status', { headers: headers(), cache: 'no-store' })
      .then(r => r.ok ? r.json() : {})
      .then(j => {
        for (const v of (j && Array.isArray(j.voices) ? j.voices : [])) {
          const o = document.createElement('option');
          o.value = v.id;
          o.textContent = [v.label || v.id, v.sex, v.accent].filter(Boolean).join(' · ').toUpperCase();
          voiceSel.appendChild(o);
        }
        voiceSel.value = pref(VOICE_KEY, '');
        reflectVoice();
      })
      .catch(e => console.warn('[avatar] voice list unavailable', e));
    const faceInput = $('ac-face');
    faceInput.value = pref(FACE_KEY, '');
    faceInput.onchange = () => {
      const v = faceInput.value.trim();
      if (!v || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) { setPref(FACE_KEY, v); setError(''); }
      else setError('That does not look like a Simli face id (a UUID from app.simli.com).');
    };
  }
  /* ---- place it anywhere: drag by the header or the video, resize from the corner grip ----
     Same contract as the Local Live module (voice-live.js): pointer-captured drag, always clamped inside the
     window, geometry remembered per station. Width is the only size: the stage is square, so the height
     follows and the face never letterboxes. Double-click the header to put it back where it started.

     ZOOM: StarNet scales the whole UI with CSS zoom on <body> (the TEXT SIZE setting). Pointer coordinates and
     getBoundingClientRect() are in screen pixels, but the panel's left/top/width are in the body's zoomed CSS
     pixels — so every screen value is divided by the zoom before it is written, or the panel drifts away from
     the pointer by the zoom factor on every move. Saved geometry is in CSS pixels, so it survives a zoom change. */
  function uiZoom() {
    const z = parseFloat(getComputedStyle(document.body).zoom);
    return Number.isFinite(z) && z > 0 ? z : 1;
  }
  function clampGeometry(panel) {
    if (!panel || panel.hidden) return;
    const z = uiZoom(), vw = window.innerWidth / z, vh = window.innerHeight / z;
    const maxW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, vw - EDGE * 2));
    if (panel.style.width) panel.style.width = Math.max(MIN_WIDTH, Math.min(maxW, panel.offsetWidth)) + 'px';
    if (!panel.style.left) return;
    const rect = panel.getBoundingClientRect();
    panel.style.left = Math.max(EDGE, Math.min(vw - panel.offsetWidth - EDGE, rect.left / z)) + 'px';
    panel.style.top = Math.max(EDGE, Math.min(vh - panel.offsetHeight - EDGE, rect.top / z)) + 'px';
  }
  function saveGeometry(panel) {
    const z = uiZoom(), rect = panel.getBoundingClientRect();
    setPref(GEOM_KEY, JSON.stringify({ left: Math.round(rect.left / z), top: Math.round(rect.top / z), width: Math.round(panel.offsetWidth) }));
  }
  function restoreGeometry(panel) {
    let g = null;
    try { g = JSON.parse(pref(GEOM_KEY, 'null')); } catch (_) {}
    if (!g) return;
    if (Number.isFinite(g.width)) panel.style.width = g.width + 'px';
    if (Number.isFinite(g.left) && Number.isFinite(g.top)) {
      panel.style.left = g.left + 'px'; panel.style.top = g.top + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    }
  }
  function resetGeometry(panel) {
    try { localStorage.removeItem(GEOM_KEY); } catch (_) {}
    for (const k of ['left', 'top', 'right', 'bottom', 'width']) panel.style[k] = '';
  }
  // Pin the panel by its top-left corner (it opens anchored bottom-right) so moves and resizes are absolute.
  function anchorTopLeft(panel) {
    const z = uiZoom(), rect = panel.getBoundingClientRect();
    panel.style.left = (rect.left / z) + 'px'; panel.style.top = (rect.top / z) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    return { left: rect.left / z, top: rect.top / z, z };
  }
  function makeMovable(panel) {
    let drag = null, size = null;
    const onDown = (event, mode) => {
      if (event.button !== 0 || event.target.closest('button, select, input, summary, a')) return;
      const at = anchorTopLeft(panel);
      // Everything below is kept in CSS pixels: pointer positions are divided by the zoom once, here and on move.
      if (mode === 'drag') drag = { dx: event.clientX / at.z - at.left, dy: event.clientY / at.z - at.top };
      else size = { x: event.clientX / at.z, y: event.clientY / at.z, w: panel.offsetWidth, left: at.left };
      panel.dataset.dragging = mode;
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) {}
      event.preventDefault();
    };
    const onMove = event => {
      if (!drag && !size) return;
      const z = uiZoom(), x = event.clientX / z, y = event.clientY / z, vw = window.innerWidth / z, vh = window.innerHeight / z;
      if (drag) {
        panel.style.left = Math.max(EDGE, Math.min(vw - panel.offsetWidth - EDGE, x - drag.dx)) + 'px';
        panel.style.top = Math.max(EDGE, Math.min(vh - panel.offsetHeight - EDGE, y - drag.dy)) + 'px';
      } else {
        // Diagonal drag: follow whichever axis moved further, so the corner tracks the pointer naturally.
        const gx = x - size.x, gy = y - size.y;
        const grow = Math.abs(gx) >= Math.abs(gy) ? gx : gy;
        const maxW = Math.min(MAX_WIDTH, vw - size.left - EDGE);
        panel.style.width = Math.max(MIN_WIDTH, Math.min(maxW, size.w + grow)) + 'px';
      }
    };
    const onUp = event => {
      if (!drag && !size) return;
      drag = size = null;
      delete panel.dataset.dragging;
      try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (_) {}
      clampGeometry(panel);
      saveGeometry(panel);
    };
    for (const [el, mode] of [[panel.querySelector('.ac-head'), 'drag'], [panel.querySelector('.ac-stage'), 'drag'], [panel.querySelector('.ac-grip'), 'resize']]) {
      if (!el) continue;
      el.addEventListener('pointerdown', e => onDown(e, mode));
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    }
    const head = panel.querySelector('.ac-head');
    if (head) head.addEventListener('dblclick', () => resetGeometry(panel));
    window.addEventListener('resize', () => clampGeometry(panel));
  }

  function setState(s) {
    // While another agent has the floor the call is not listening for the Commander: say so.
    if ((s === 'listening' || s === 'hearing') && crewSpeaking()) s = 'crew speaking';
    const panel = $('avatar-call-panel'), el = $('ac-state');
    if (panel) panel.dataset.state = s;
    if (el) el.textContent = String(s).toUpperCase();
  }
  function setError(msg) {
    const el = $('ac-error');
    if (!el) return;
    el.hidden = !msg; el.textContent = msg || '';
  }
  function setLine(id, text) { const el = $(id); if (el) el.textContent = text || ''; }
  function refreshTaskLine() {
    const el = $('ac-task');
    if (!el) return;
    try {
      const ws = (typeof Workstreams !== 'undefined') ? Workstreams.active() : null;
      if (!ws || typeof Channels === 'undefined') { el.textContent = ''; return; }
      const pending = Channels.pendingOf(ws.id), busy = Channels.isBusy(ws.id);
      el.textContent = (pending ? 'APPROVAL NEEDED ON SCREEN · ' : busy ? 'CREW WORKING · ' : 'READY · ') + (ws.title || 'GENERAL');
      el.dataset.kind = pending ? 'pending' : busy ? 'busy' : 'ready';
    } catch (_) {}
  }
  function reflectButton(on) {
    const b = $('avatar-call');
    if (!b) return;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.classList.toggle('on', !!on);
    b.setAttribute('aria-label', on ? 'End video call' : 'Start video call');
  }

  // ---- speaking: text → /api/tts → 16 kHz PCM → Simli ----------------------------------------------------
  // ElevenLabs is the voice when picked AND a voice id is known (panel field, else STARNET_AVATAR_ELEVENLABS_VOICE_ID).
  /* Which ElevenLabs voice speaks, if any:
       VOICE → ELEVENLABS          the panel's voice id, else the station's STARNET_AVATAR_ELEVENLABS_VOICE_ID;
       VOICE → AUTO (the default)  the station's voice id when the station has one AND a key — so a station
                                   that set both needs no panel setup at all;
       any built-in voice          never. */
  function elevenLabsVoiceId() {
    const picked = pref(VOICE_KEY, '');
    if (picked && picked !== 'elevenlabs') return '';          // a built-in voice was chosen on purpose
    const mine = pref(EL_VOICE_KEY, '');
    if (EL_VOICE_RE.test(mine)) return mine;                    // the panel's ID wins, under AUTO or ELEVENLABS
    const station = EL_VOICE_RE.test(elevenlabs.voiceId || '') ? elevenlabs.voiceId : '';
    if (picked === 'elevenlabs') return station;
    return elevenlabs.configured === true ? station : '';       // AUTO: the station voice only with a known key
  }
  // Tell the Commander which voice is actually speaking (updated per sentence).
  function showVoice(body) {
    const el = $('ac-voice-now');
    if (!el) return;
    el.textContent = body && body.provider === 'elevenlabs'
      ? 'SPEAKING WITH · ELEVENLABS ' + body.voiceId
      : 'SPEAKING WITH · BUILT-IN ' + String((body && (body.localVoice || body.voice)) || 'STATION VOICE').toUpperCase();
  }
  function ttsBody(text) {
    const el = elevenLabsVoiceId();
    if (el && elevenlabs.configured !== false && !elOffForCall) return { text, provider: 'elevenlabs', voiceId: el, modelId: elevenlabs.model || 'eleven_flash_v2_5' };
    return builtinTtsBody(text);
  }
  function builtinTtsBody(text) {
    const engine = (status && status.voiceEngine) || 'edge';
    const agent = leadAgent();
    // The Commander's pick in CALL SETTINGS, else the voice matched to the face, else the station's own voice.
    const picked = pref(VOICE_KEY, '');
    let localVoice = (picked && picked !== 'elevenlabs' ? picked : '') || faceVoice;
    try { if (!localVoice && typeof Voice !== 'undefined' && Voice.localVoiceId) localVoice = Voice.localVoiceId(agent && agent.id) || ''; } catch (_) {}
    if (engine === 'edge') return { text, local: true, localEngine: 'edge', localVoice: localVoice || undefined };
    if (engine === 'kokoro') return { text, local: true, localVoice: localVoice || undefined, speed: 1 };
    const v = (typeof Personas !== 'undefined' && Personas.STATION_VOICE) || {};
    let provider = '';
    try { provider = (typeof Harness !== 'undefined' && Harness.getProv) ? String(Harness.getProv() || '') : ''; } catch (_) {}
    return { text, preferProvider: provider, voice: v.ttsVoice || 'Algenib', style: v.ttsStyle || '' };
  }

  async function synthWith(job, body) {
    const r = await fetch('/api/tts', { method: 'POST', signal: job.ctl.signal, headers: headers('application/json'), body: JSON.stringify(body) });
    const ct = r.headers.get('Content-Type') || '';
    if (!r.ok || ct.indexOf('audio') !== 0) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.reason || j.error || ('voice failed (' + r.status + ')'));
    }
    const buf = await r.arrayBuffer();
    const ctx = mic && mic.ctx;
    if (!ctx) return null;
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    return Core.toPcm16(Core.resample(ch, audio.sampleRate, RATE));
  }
  async function synth(job) {
    const body = ttsBody(job.text);
    try { const pcm = await synthWith(job, body); showVoice(body); return pcm; }
    catch (e) {
      if (job.ctl.signal.aborted) return null;
      // ElevenLabs refused (no key, quota, bad voice id, network): this sentence falls back to the built-in
      // voice instead of going silent, and the panel says why, once.
      if (body.provider === 'elevenlabs') {
        if (/no elevenlabs key/i.test(String((e && e.message) || ''))) elOffForCall = true;   // no point asking again this call
        if (!elFallbackNoted) { elFallbackNoted = true; setError('ElevenLabs: ' + String((e && e.message) || e).slice(0, 160) + ' (using the built-in voice)'); }
        try { const fb = builtinTtsBody(job.text); const pcm = await synthWith(job, fb); showVoice(fb); return pcm; }
        catch (e2) { if (job.ctl.signal.aborted) return null; e = e2; }
      }
      console.warn('[avatar] voice failed', e);
      setError('Voice: ' + String((e && e.message) || e));
      return null;
    }
  }

  function say(text) {
    const t = Core ? Core.speakable(text) : String(text || '');
    if (!t || !simli) return false;
    const job = { gen: speakGen, text: t, ctl: new AbortController(), pcm: null };
    speakQueue.push(job);
    rememberSpoken(t);
    pump();
    return true;
  }

  // Synthesize up to two pieces ahead of the one being fed; feed strictly in order.
  async function pump() {
    for (let i = 0; i < Math.min(2, speakQueue.length); i++) { if (!speakQueue[i].pcm) speakQueue[i].pcm = synth(speakQueue[i]); }
    if (pumping) return;
    pumping = true;
    try {
      while (speakQueue.length) {
        const job = speakQueue[0];
        if (!job.pcm) job.pcm = synth(job);
        const pcm = await job.pcm;
        // Another agent has the floor: hold this sentence (synthesized and ready) until the crew is done.
        // Held, never dropped: the reply resumes where it was the moment the floor frees.
        while (job.gen === speakGen && active && crewSpeaking()) { setState('crew speaking'); await new Promise(r => setTimeout(r, 120)); }
        // Cancelled while synthesizing: cancelSpeech already replaced the queue, so carry on with whatever a
        // newer reply has queued since — never drop its first sentence.
        if (job.gen !== speakGen) continue;
        speakQueue.shift();
        for (let i = 0; i < Math.min(2, speakQueue.length); i++) { if (!speakQueue[i].pcm) speakQueue[i].pcm = synth(speakQueue[i]); }
        if (!pcm || !pcm.length || !simli) continue;
        for (let at = 0; at < pcm.length; at += SEND_BYTES) {
          try { simli.sendAudioData(pcm.subarray(at, Math.min(pcm.length, at + SEND_BYTES))); } catch (_) {}
        }
        const ms = pcm.length / 2 / RATE * 1000;
        speakingUntil = Math.max(Date.now(), speakingUntil) + ms;
        setState('speaking');
      }
    } finally {
      pumping = false;
      if (speakQueue.length) pump();
    }
  }

  function cancelSpeech() {
    speakGen++;
    for (const j of speakQueue) { try { j.ctl.abort(); } catch (_) {} }
    speakQueue = [];
    if (notices) notices.clear();
    speakingUntil = 0;
    try { if (simli) simli.ClearBuffer(); } catch (_) {}
  }
  function cancelReply() {
    if (replyCtl) { try { replyCtl.abort(); } catch (_) {} replyCtl = null; }
    turnSeq++;
  }
  /* Stop the current reply AND remember how far it got. Without this, the next turn's history simply lacks
     what the avatar already said before being cut off, and the agent repeats itself or loses the thread.
     Recorded synchronously, before the caller pushes the Commander's next line, so the order stays true. */
  function abandonReply() {
    const partial = replyCtl ? replySpoken.trim() : '';
    cancelReply();
    cancelSpeech();
    replySpoken = '';
    if (partial) history.push({ role: 'assistant', content: partial + ' [cut off by the Commander]' });
  }
  // Is the avatar talking, or about to? (queued speech, audio still playing, or a reply streaming)
  function avatarBusy() {
    return !!(faceSpeaking || speakQueue.length || Date.now() < speakingUntil + 250 || replyCtl);
  }

  // Echo memory: what the avatar AND the crew said recently. Anything the mic hears that matches is echo.
  function rememberSpoken(t) {
    const line = String(t || '').trim().slice(0, 600);
    if (!line) return;
    recentSpoken.push(line);
    while (recentSpoken.length > 12) recentSpoken.shift();
  }

  /* ---- the crew has the floor ----------------------------------------------------------------------------
     Other agents' replies are spoken aloud by the chat voice while the call is open. While that voice is
     playing (or has chunks still to play, or ended less than the grace period ago) the call:
       - ignores the microphone completely (it is hearing that agent, not the Commander): no turn, no
         history, no barge-in. The one exception is a clear stop command, which silences the crew voice;
       - holds its own speech and announcements until the crew is done, then carries on.
     Voice.hasPendingSpeech() covers the gaps between chunks; Core.makeCrewGate adds the grace period and a
     stale guard. */
  function crewSpeaking() { return !!(crewGate && crewGate.isSpeaking()); }
  function crewTick() {
    if (!crewGate) return false;
    let speaking = false, pending = false;
    try {
      if (typeof Voice !== 'undefined') {
        speaking = !!(Voice.isSpeaking && Voice.isSpeaking());
        pending = !!(Voice.hasPendingSpeech && Voice.hasPendingSpeech());
      }
    } catch (e) { console.warn('[avatar] crew voice state unreadable', e); }
    const r = crewGate.update({ now: Date.now(), speaking, pending });
    if (r.crewSpeaking) {
      // Second safety net: whatever the crew is saying joins the echo list.
      let text = '';
      try { text = (typeof Voice !== 'undefined' && Voice.pendingSpeechText) ? String(Voice.pendingSpeechText() || '') : ''; } catch (_) {}
      if (text && text !== crewTextSeen) { crewTextSeen = text; rememberSpoken(text); }
      const panel = $('avatar-call-panel');
      const st = panel && panel.dataset && panel.dataset.state;
      if (active && (st === 'listening' || st === 'hearing')) setState('crew speaking');
    }
    if (r.ended) onCrewEnded();
    return r.crewSpeaking;
  }
  function onCrewEnded() {
    crewTextSeen = '';
    // Whatever the mic collected while the crew talked is their audio's tail, not a turn: start clean.
    if (vad) vad.reset();
    utter = null; preroll = []; prerollMs = 0;
    if (!active) return;
    setState(avatarBusy() ? 'speaking' : 'listening');
    if (speakQueue.length) pump();
    flushNotices();
  }
  // Something the mic heard while the crew had the floor: never a turn. Only a clear stop command acts.
  async function crewUtterance(u, voicedMs) {
    if (voicedMs > 2500) return;   // a stop command is short; a long utterance here is the crew itself
    const text = (await transcribe(Core.concat(u.frames)).catch(() => '')).trim();
    if (!active) return;
    const verdict = Core.shouldIgnoreMic({ crewSpeaking: true, text, recentSpoken });
    if (verdict.stopCrew) {
      try { if (typeof Voice !== 'undefined' && Voice.stopSpeaking) Voice.stopSpeaking('commander_stop'); } catch (e) { console.warn('[avatar] crew stop failed', e); }
      setState('listening');
    }
  }

  // ---- hearing: mic → VAD → /api/stt ---------------------------------------------------------------------
  async function openMic() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const sink = ctx.createGain(); sink.gain.value = 0;
    proc.onaudioprocess = onFrame;
    source.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    mic = { stream, ctx, source, proc, sink };
    vad = Core.makeVad();
    preroll = []; prerollMs = 0; utter = null;
  }
  function closeMic() {
    const m = mic; mic = null;
    if (!m) return;
    try { m.proc.onaudioprocess = null; m.proc.disconnect(); m.source.disconnect(); m.sink.disconnect(); } catch (_) {}
    try { m.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    try { m.ctx.close(); } catch (_) {}
    utter = null;
  }

  function onFrame(ev) {
    if (!active || !mic || micMuted) return;
    const raw = ev.inputBuffer.getChannelData(0);
    const frame = Core.resample(raw, mic.ctx.sampleRate, RATE);
    const ms = raw.length / mic.ctx.sampleRate * 1000;
    const crew = crewTick();
    const busy = avatarBusy();
    const e = vad.frame({ rms: Core.rms(raw), ms, strict: busy || crew });
    if (utter) utter.frames.push(frame);
    else {
      preroll.push(frame); prerollMs += ms;
      while (prerollMs > PREROLL_MS && preroll.length > 1) { prerollMs -= preroll.shift().length / RATE * 1000; }
    }
    if (e && e.type === 'start') {
      utter = { frames: preroll.slice(), overlapped: busy, crew, checks: 0, interrupted: false, seq: ++utterSeq };
      preroll = []; prerollMs = 0;
      if (!busy && !crew) setState('hearing');   // over the avatar, only WORDS change the state (see earlyCheck)
    } else if (e && (e.type === 'end' || e.type === 'abort')) {
      const u = utter; utter = null;
      if (e.type === 'end' && u) finishUtterance(u, e.voicedMs);
      else setState(avatarBusy() ? 'speaking' : 'listening');
    } else if (utter) {
      if (busy) utter.overlapped = true;
      if (crew) utter.crew = true;          // touched the crew's speech: never a turn, never a barge-in
      const voiced = vad.state().voicedMs;
      // Talking over the avatar: transcribe what we have so far at fixed marks and interrupt only on WORDS.
      if (utter.overlapped && !utter.crew && !utter.interrupted && utter.checks < BARGE_CHECKS_MS.length && voiced >= BARGE_CHECKS_MS[utter.checks]) {
        utter.checks++;
        earlyCheck(utter);
      }
    }
  }

  async function earlyCheck(u) {
    const text = await transcribe(Core.concat(u.frames)).catch(() => '');
    if (!active || u.interrupted || u.crew || crewSpeaking() || !avatarBusy()) return;
    if (Core.shouldInterrupt(text, { mode: interruptMode(), recentSpoken })) {
      u.interrupted = true;
      abandonReply();
      setLine('ac-heard', text);
      setState('hearing');
    }
  }

  async function finishUtterance(u, voicedMs) {
    if (u.crew || crewSpeaking()) return crewUtterance(u, voicedMs);
    setState(avatarBusy() ? 'speaking' : 'thinking');
    const text = (await transcribe(Core.concat(u.frames)).catch(() => '')).trim();
    if (!active) return;
    if (crewSpeaking()) return;           // the crew took the floor while this was being transcribed
    const busy = avatarBusy() && !u.interrupted;
    if (!Core.isTurn(text, { avatarBusy: busy, mode: interruptMode(), recentSpoken, voicedMs })) {
      if (!avatarBusy()) setState('listening');
      return;
    }
    onUserTurn(text);
  }

  // The engine ladder for the chosen hearing mode, restricted to what this station actually has.
  function sttOrder() {
    const want = hearingMode() === 'accurate' ? ['cloud', 'local', 'native'] : ['local', 'cloud', 'native'];
    const have = want.filter(e => stt[e]);
    return have.length ? have : want;
  }
  async function transcribe(f32) {
    if (!f32 || f32.length < RATE * 0.2) return '';
    for (const engine of sttOrder()) {
      try {
        let r;
        if (engine === 'cloud') r = await fetch('/api/stt', { method: 'POST', headers: headers('audio/wav'), body: Core.wav(Core.toPcm16(f32), RATE) });
        else r = await fetch(engine === 'local' ? '/api/local-voice/transcribe' : '/api/stt/native', { method: 'POST', headers: headers('application/octet-stream'), body: f32.buffer.slice(0) });
        const j = await r.json().catch(() => ({}));
        const text = String((j && j.text) || '').trim();
        if (r.ok && (text || j.ok === true || (engine === 'cloud' && !j.reason))) return text;
      } catch (_) {}
    }
    return '';
  }

  // ---- a conversational turn -----------------------------------------------------------------------------
  function recordUser(text) {
    echoed.add(String(text).trim());
    try { if (typeof Chat !== 'undefined' && Chat.echoUser) Chat.echoUser(text); } catch (_) {}
  }
  function recordAgent(text) {
    const said = String(text || '').trim();
    if (!said) return;
    echoed.add(said);
    try { if (typeof Chat !== 'undefined' && Chat.typeLine) Chat.typeLine([{ text: said, cps: 1200 }], null, { silent: true }); } catch (_) {}
  }

  async function onUserTurn(raw) {
    const text = String(raw || '').trim();
    if (!text || !active) return;
    const lower = text.toLowerCase().replace(/[.!?]+$/, '').trim();
    if (/^(?:end|hang up|stop|close|leave)(?: the)?(?: video)? call$|^hang up$|^(?:bye|goodbye)(?: for now)?$/.test(lower)) {
      abandonReply();
      say('Talk soon.');
      setTimeout(end, 1800);
      return;
    }
    abandonReply();
    const mine = turnSeq;
    history.push({ role: 'user', content: text });
    recordUser(text);
    setLine('ac-heard', text);
    setLine('ac-said', '');
    setError('');
    setState('thinking');

    const ctl = new AbortController();
    replyCtl = ctl;
    const lead = leadAgent();
    let spoken = '', buf = '', first = true;
    replySpoken = '';
    const tools = [];
    try {
      const res = await fetch('/api/avatar/reply', {
        method: 'POST', signal: ctl.signal, headers: headers('application/json'),
        body: JSON.stringify({ agentId: (lead && lead.id) || 'agent', system: instructions(), messages: history.slice(-HISTORY_TURNS) })
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('reply failed (' + res.status + ')'));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let nd = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (mine !== turnSeq) return;
        nd += dec.decode(value, { stream: true });
        let nl;
        while ((nl = nd.indexOf('\n')) >= 0) {
          const line = nd.slice(0, nl).trim(); nd = nd.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.type === 'text') {
            spoken += ev.delta; buf += ev.delta; replySpoken = spoken;
            const d = Core.drain(buf, first);
            buf = d.rest;
            for (const p of d.pieces) { if (say(p)) first = false; }
            setLine('ac-said', spoken);
          } else if (ev.type === 'tool') {
            tools.push(ev);
          } else if (ev.type === 'error') {
            throw new Error(ev.message || 'reply failed');
          }
        }
      }
    } catch (e) {
      if (ctl.signal.aborted || mine !== turnSeq) return;
      console.warn('[avatar] reply failed', e);
      setError(String((e && e.message) || e));
      say('Sorry, I lost my train of thought for a second. Say that again?');
      return;
    } finally {
      if (replyCtl === ctl) replyCtl = null;
    }
    if (mine !== turnSeq) return;
    if (buf.trim()) say(buf);

    const notes = [];
    for (const t of tools) {
      const result = await runTool(t.name, t.args || {});
      notes.push(result.note);
      if (!spoken.trim() && result.speech) say(result.speech);
    }
    const record = [spoken.trim()].concat(notes).filter(Boolean).join('\n');
    if (record) history.push({ role: 'assistant', content: record });
    recordAgent(spoken);
    refreshTaskLine();
    if (!avatarBusy()) setState('listening');
  }

  /* The two hand-off actions, executed exactly as Local Live executes them: the SAME Chat path a typed message
     takes, so everything downstream (task brief, approvals, ledger, transcript) is identical. */
  async function runTool(name, args) {
    if (name === 'start_starnet_task') {
      const instruction = String(args.instruction || '').trim();
      if (!instruction) return { note: '[No task started: the instruction was empty.]', speech: 'I didn\'t catch what you want done. Say it again?' };
      const dispatch = (typeof Chat !== 'undefined') && (Chat.sendOrQueue || Chat.send);
      if (!dispatch) return { note: '[No task started: StarNet chat is not ready.]', speech: 'StarNet isn\'t ready to take work yet.' };
      try {
        const queued = !!(typeof Chat.isBusy === 'function' && Chat.isBusy());
        await dispatch.call(Chat, instruction);
        refreshTaskLine();
        return {
          note: '[' + (queued ? 'Queued' : 'Started') + ' StarNet task: ' + instruction + ']',
          speech: queued ? 'Queued that behind the current task.' : 'On it. The crew has it, and you can follow along in the session.'
        };
      } catch (e) {
        return { note: '[Task could not be started: ' + String((e && e.message) || e) + ']', speech: 'That didn\'t go through. ' + String((e && e.message) || '') };
      }
    }
    if (name === 'interrupt_starnet_task') {
      const stop = (typeof Chat !== 'undefined') && (Chat.stopActive || Chat.abort);
      const busy = !!(typeof Chat !== 'undefined' && typeof Chat.isBusy === 'function' && Chat.isBusy());
      if (!stop || !busy) return { note: '[Nothing was running to stop.]', speech: 'Nothing is running right now.' };
      try { await stop.call(Chat); refreshTaskLine(); return { note: '[Stopped the running StarNet task.]', speech: 'Stopped.' }; }
      catch (e) { return { note: '[Stop failed: ' + String((e && e.message) || e) + ']', speech: 'I couldn\'t stop it.' }; }
    }
    return { note: '', speech: '' };
  }

  // ---- the station talks back: finished work and waiting approvals are said aloud, once ----------------
  // The floor is free only when neither the crew nor the avatar is talking and the Commander is not mid-sentence.
  function floor() { return { crewSpeaking: crewSpeaking(), avatarBusy: avatarBusy(), hearing: !!utter }; }
  function announce(text) {
    const now = notices ? notices.offer(text, floor()) : text;
    if (!now) return;                     // held: spoken by flushNotices() once the floor frees
    say(now);
    history.push({ role: 'assistant', content: now });
  }
  function flushNotices() {
    const next = notices ? notices.release(floor()) : null;
    if (!next) return;
    say(next);
    history.push({ role: 'assistant', content: next });
  }
  function watchStation() {
    if (!active || typeof Workstreams === 'undefined' || typeof Channels === 'undefined') return;
    try {
      for (const ws of (Workstreams.list() || []).slice(0, 24)) {
        const busy = !!Channels.isBusy(ws.id);
        const pending = Channels.pendingOf(ws.id);
        const was = watchState.get(ws.id);
        const title = ws.title || 'General';
        if (was) {
          if (pending && !was.pending) announce('Heads up: "' + title + '" needs your approval' + (pending.tool ? ' for ' + String(pending.tool).replace(/[._]/g, ' ') : '') + '. It\'s on screen.');
          else if (was.busy && !busy && !pending) announce('The work in "' + title + '" just finished. Ask me and I\'ll walk you through it.');
        }
        watchState.set(ws.id, { busy, pending: !!pending });
      }
    } catch (_) {}
    refreshTaskLine();
    flushNotices();
    if (!avatarBusy() && !utter && !replyCtl) setState('listening');
  }

  // ---- call lifecycle ------------------------------------------------------------------------------------
  async function start() {
    if (active || starting) return;
    if (!Core) { console.warn('[avatar] avatar-core.js is not loaded'); return; }
    starting = true;
    ensurePanel();
    $('avatar-call-panel').hidden = false;
    requestAnimationFrame(() => clampGeometry($('avatar-call-panel')));
    setError(''); setLine('ac-heard', ''); setLine('ac-said', '');
    setLine('ac-title', 'VIDEO CALL · ' + String(leadName()).toUpperCase());
    setState('connecting');
    reflectButton(true);
    try {
      // Mic permission, the SDK bundle, the session token and the STT route are independent — fetch in parallel.
      const [SDK, token, sttStatus] = await Promise.all([
        loadSdk(),
        fetch('/api/avatar/session', { method: 'POST', headers: headers('application/json'), body: JSON.stringify({ faceId: pref(FACE_KEY, '') || undefined }) }).then(async r => {
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.sessionToken) throw new Error(j.error || ('could not start the call (' + r.status + ')'));
          return j;
        }),
        fetch('/api/stt/status', { headers: headers(), cache: 'no-store' }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
        fetch('/api/local-voice/warm', { method: 'POST', headers: headers() }).catch(() => {}),   // load Whisper before the first word
        openMic()
      ]);
      faceVoice = String(token.voiceId || '');
      if (token.elevenlabs) elevenlabs = token.elevenlabs;
      elFallbackNoted = false; elOffForCall = false;
      { const pnl = $('avatar-call-panel'); if (pnl && typeof pnl._reflectVoice === 'function') pnl._reflectVoice(); }
      if (elevenLabsVoiceId() === '' && pref(VOICE_KEY, '') === 'elevenlabs') setError('Enter your ElevenLabs voice ID in CALL SETTINGS; until then the built-in voice speaks.');
      else if (pref(VOICE_KEY, '') === 'elevenlabs' && elevenlabs.configured === false) setError('Add your ElevenLabs key in Settings → KEYS; until then the built-in voice speaks.');
      if (status) status.voiceEngine = token.voiceEngine || status.voiceEngine;
      else status = { voiceEngine: token.voiceEngine || 'edge' };
      stt = { local: !!(sttStatus && sttStatus.local), cloud: !!(sttStatus && sttStatus.cloud), native: !!(sttStatus && sttStatus.native) };
      if (sttStatus && sttStatus.available === false) setError('No speech recognition is available: connect a Groq or OpenAI key, or enable local voice.');
      // LiveKit transport, not peer-to-peer: Simli's own guidance for reliability behind firewalls.
      simli = new SDK.SimliClient(token.sessionToken, $('ac-video'), $('ac-audio'), null, SDK.LogLevel.ERROR, 'livekit');
      simli.on('speaking', () => { faceSpeaking = true; setState('speaking'); });
      simli.on('silent', () => { faceSpeaking = false; if (!avatarBusy() && !utter) setState('listening'); flushNotices(); });
      simli.on('stop', () => { if (active) { setError('The call ended (idle or time limit reached).'); teardown(true); } });
      simli.on('error', (d) => { if (active) { setError('Video connection lost: ' + String(d || '')); teardown(true); } });
      simli.on('startup_error', (m) => setError('Simli: ' + String(m || 'could not start')));
      await simli.start();
      active = true;
      history = [];
      watchState = new Map();
      watchStation();                       // baseline, so pre-existing state is not announced as news
      watchTimer = setInterval(watchStation, WATCH_MS);
      crewTimer = setInterval(crewTick, CREW_TICK_MS);   // also runs while the mic is muted
      setState('listening');
      say('Hey Commander, ' + leadName() + ' here. What\'s on your mind?');
    } catch (e) {
      console.warn('[avatar] start failed', e);
      setError(String((e && e.message) || e));
      setState('failed');
      teardown(false);
    } finally {
      starting = false;
    }
  }

  function teardown(keepPanelMessage) {
    active = false;
    cancelReply();
    cancelSpeech();
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (crewTimer) { clearInterval(crewTimer); crewTimer = null; }
    if (notices) notices.clear();
    faceSpeaking = false;
    const s = simli; simli = null;
    if (s) { try { s.stop(); } catch (_) {} }
    closeMic();
    reflectButton(false);
    if (keepPanelMessage) setState('ended');
  }

  function end() {
    teardown(false);
    const panel = $('avatar-call-panel');
    if (panel) panel.hidden = true;
  }

  function toggleMute() {
    micMuted = !micMuted;
    try { if (mic) mic.stream.getAudioTracks().forEach(t => { t.enabled = !micMuted; }); } catch (_) {}
    if (micMuted) { utter = null; if (vad) vad.reset(); }
    const b = $('ac-mute');
    if (b) { b.textContent = micMuted ? 'UNMUTE' : 'MUTE MIC'; b.setAttribute('aria-pressed', micMuted ? 'true' : 'false'); }
  }

  function toggle() { if (active || starting) end(); else start(); }

  // The dock button appears only when the sidecar has a Simli key. Re-checked while hidden, so a key added in
  // Settings → KEYS shows the button without a reload.
  async function refreshAvailability() {
    const b = $('avatar-call');
    if (!b) return;
    try {
      const r = await fetch('/api/avatar/status', { headers: headers(), cache: 'no-store' });
      status = await r.json();
      if (status && status.elevenlabs) elevenlabs = status.elevenlabs;
      b.hidden = !(status && status.configured);
      b.title = status && status.brain && !status.brain.ok ? 'Video call unavailable: ' + status.brain.error : 'Video call with your lead agent';
    } catch (_) { b.hidden = true; }
  }
  function init() {
    const b = $('avatar-call');
    if (!b) return;
    b.onclick = toggle;
    refreshAvailability();
    statusTimer = setInterval(() => { if (b.hidden) refreshAvailability(); }, 20000);
    window.addEventListener('beforeunload', () => { if (simli) { try { simli.stop(); } catch (_) {} } });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  return {
    start, end, toggle, isActive: () => active, _instructions: instructions,
    // Test-only handles (test/avatar-call-crew.test.js). Read-only views plus the announce entry point.
    _test: { history: () => history.slice(), announce, noticeCount: () => (notices ? notices.size() : 0), crewSpeaking }
  };
})();
