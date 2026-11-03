'use strict';
/* test/helpers/voice-rig.js — boot the station's voice scripts into a vm sandbox in the order the page loads them.

   frontend/index.html loads the voice modules as classic scripts, one after another, into one global scope. A rig
   that hand-picks app/voice.js boots a module graph the page never runs, and the day voice.js reads a module loaded
   ahead of it, every such rig throws at load while the page works. So the order is read from index.html, never
   restated here.

   bootVoice(sandbox, { through, stream }) runs the shared splitter and every app/voice*.js script in page order, up to and
   including `through` (default 'voice.js'). voice-stream.js is the live audio transport: a rig fakes it as a global
   when it needs one, so it is loaded only with { stream: true }. Returns the sandbox's { Voice, VoiceLive, VoiceState }
   (undefined for a module not loaded). Each script is compiled once per process and run in every sandbox.

   chatReply(Voice) sends a run through the REAL chat.js speech closure (sliced from 'const SPEAK_MARKER' to its
   'try {'), so its spoken reply is opened at send exactly as send() opens it: { speech (the handle, or null on a build
   without reply handles), say(sentence), close(lastSentence) }.

   liveWindow({ leg }) is the window a Local Live call runs in, every voice script booted through voice-live.js and
   fakes only at the transport edge: fetch (the station's voice routes), Audio (a clip plays to its end), AudioContext
   (its script processor is the microphone frame seam), SpeechRecognition, getUserMedia and localStorage, plus the page
   modules voice-live.js reads (Chat, Workstreams, Channels) as plain state on `w`. leg 'models' (default) answers the
   offline engine ready; 'dictation' answers it absent with Windows dictation available, so start() takes that leg
   (w.leg can change between calls). opts.store is the localStorage behind the window, so a fresh window over the same
   store is a reload; every write is on w.writes with the stack that made it. w.denyMic refuses getUserMedia, a clip
   whose text is in w.failClips fails to play, and w.key(key) runs the page's document keydown handlers. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');
// Include the real splitter dependency: omitting it silently exercises a stripped-page fallback.
const VOICE_SCRIPTS = Array.from(PAGE.matchAll(/<script\b[^>]*\bsrc="app\/((?:voice(?:-[a-z]+)?|speech-split)\.js)"/g), m => m[1]);

const compiled = new Map();
function script(name) {
  if (!compiled.has(name)) {
    const src = fs.readFileSync(path.join(ROOT, 'frontend', 'app', name), 'utf8');
    compiled.set(name, new vm.Script(src, { filename: name }));
  }
  return compiled.get(name);
}
// a script's top-level const is a binding of the context's global scope, not a sandbox property: read it from inside
const GLOBALS = new vm.Script('({ Voice: typeof Voice === "undefined" ? undefined : Voice, ' +
  'VoiceLive: typeof VoiceLive === "undefined" ? undefined : VoiceLive, ' +
  'VoiceState: typeof VoiceState === "undefined" ? undefined : VoiceState, ' +
  'SpeechSplit: typeof SpeechSplit === "undefined" ? undefined : SpeechSplit })');

function bootVoice(sandbox, opts) {
  opts = opts || {};
  const through = opts.through || 'voice.js';
  const last = VOICE_SCRIPTS.indexOf(through);
  if (last < 0) throw new Error('frontend/index.html does not load app/' + through + ' (it loads ' + VOICE_SCRIPTS.join(', ') + ')');
  const voiceAt = VOICE_SCRIPTS.indexOf('voice.js');
  for (const dependency of ['speech-split.js', 'voice-state.js']) {
    const at = VOICE_SCRIPTS.indexOf(dependency);
    if (at < 0 || at > voiceAt) throw new Error('frontend/index.html must load app/' + dependency + ' before voice.js');
  }
  if (!vm.isContext(sandbox)) vm.createContext(sandbox);
  for (const name of VOICE_SCRIPTS.slice(0, last + 1)) {
    if (name === 'voice-stream.js' && !opts.stream) continue;
    script(name).runInContext(sandbox);
  }
  return GLOBALS.runInContext(sandbox);
}

let speechClosure = null;
function chatReply(Voice) {
  if (!speechClosure) {
    const chat = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'chat.js'), 'utf8');
    const from = chat.indexOf('    const SPEAK_MARKER'), to = chat.indexOf('\n    try {', from);
    if (from < 0 || to < from) throw new Error('chat.js no longer carries the speech closure from SPEAK_MARKER to its try {');
    speechClosure = new vm.Script(chat.slice(from, to) +
      '\nthis.__speech = typeof speech === "undefined" ? null : speech; this.__push = pushSpeech; this.__close = closeSpeech;', { filename: 'chat.js speech closure' });
  }
  const ctx = vm.createContext({ ws: { id: 'ws-a', agentId: 'agent' }, willSpeak: true, speechOwner: () => true, acc: '', spokenIdx: 0,
    name: 'agent', Voice, Date, setTimeout, clearTimeout });
  script('speech-split.js').runInContext(ctx); // the actual send closure sees the page's real shared rule
  speechClosure.runInContext(ctx);
  return {
    speech: ctx.__speech,
    say(text) { ctx.acc += text + ' '; ctx.__push(false); },                              // one streamed sentence
    close(text) { ctx.acc += text || ''; ctx.__push(true, ctx.acc); ctx.__close(); }      // the final flush; the run closes its reply
  };
}

const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
const FRAME = 2048, RATE = 48000;   // one ScriptProcessor buffer at the AudioContext's rate: ~43 ms
function liveWindow(opts) {
  opts = opts || {};
  const nodes = new Map(), store = opts.store || {};
  const w = {
    leg: opts.leg || 'models', skew: 0, busy: false, sendState: null, transcript: '', pending: null, chips: [],
    spoken: [], statuses: [], sent: [], runs: [], stops: [], mics: [], processors: [],
    denyMic: false, failClips: new Set(), listeners: {}, writes: []
  };
  const node = () => ({ textContent: '', value: '', title: '', innerHTML: '', hidden: false, disabled: false, dataset: {}, children: [], options: [],
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => node(), dispatchEvent() {} });
  // every id resolves, except the Live panel until voice-live.js builds it (so its real buttons get their handlers)
  const $ = id => { if (id === 'live-voice-panel' && !nodes.has(id)) return null; if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  class SR {
    constructor() { this.started = false; w.mics.push(this); }
    start() { this.started = true; } stop() { this.started = false; } abort() { this.started = false; }
    final(text) { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] }); this.started = false; if (this.onend) this.onend(); }
    fail(code) { if (this.onerror) this.onerror({ error: code }); this.started = false; if (this.onend) this.onend(); }
  }
  class AC {
    constructor() { this.state = 'running'; this.sampleRate = RATE; this.destination = {}; }
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { const processor = { connect() {}, disconnect() {}, onaudioprocess: null }; w.processors.push(processor); return processor; }
    createGain() { return { connect() {}, disconnect() {}, gain: { value: 0 } }; }
  }
  class AutoEndAudio {   // a clip that plays to its end (or, named in w.failClips, fails as a broken media file does)
    constructor(src) { this.src = src; this.onplay = this.onended = this.onerror = null; this.volume = 1; this.playbackRate = 1; this.ended = false; }
    play() {
      if (w.failClips.has(this.src)) { setTimeout(() => { this.error = { code: 4, name: 'MediaError' }; if (this.onerror) this.onerror(); }, 0); return Promise.resolve(); }
      setTimeout(() => { if (this.onplay) this.onplay(); setTimeout(() => { this.ended = true; w.spoken.push(this.src); if (this.onended) this.onended(); }, 0); }, 0); return Promise.resolve();
    }
    pause() {} load() {} addEventListener() {} removeEventListener() {}
  }
  const json = body => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  const track = { enabled: true, onended: null, stop() {}, getSettings: () => ({}) };
  let mods = null;
  const sandbox = {
    window: { SpeechRecognition: SR, AudioContext: AC, addEventListener() {} },
    document: { getElementById: $, addEventListener: (type, fn) => { (w.listeners[type] = w.listeners[type] || []).push(fn); },
      createElement: () => node(), body: { appendChild: el => { if (el && el.id) nodes.set(el.id, el); } },
      querySelectorAll: sel => (sel === '#chat-log .choice-row button.choice' ? w.chips : []) },
    navigator: { platform: 'Win32', userAgent: 'test', mediaDevices: { addEventListener() {},
      getUserMedia: async () => {
        if (w.denyMic) { const error = new Error('Permission denied'); error.name = 'NotAllowedError'; throw error; }
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      } } },
    location: { search: '' },
    localStorage: { getItem: k => (k in store ? store[k] : null), removeItem: k => { delete store[k]; },
      setItem: (k, v) => { store[k] = String(v); w.writes.push({ key: k, value: String(v), stack: new Error().stack }); } },
    SpeechRecognition: SR, MediaRecorder: undefined, AudioContext: AC, Audio: AutoEndAudio,
    performance: { now: () => Date.now() + w.skew }, Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, AbortController, queueMicrotask,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: blob => blob.text, revokeObjectURL() {} },
    Blob: class { constructor(parts, o) { this.size = 1; this.type = (o && o.type) || ''; } },
    fetch: (url, init) => {
      url = String(url);
      if (url.includes('/api/tts')) {
        const text = JSON.parse(init.body).text;
        return Promise.resolve({ ok: true, status: 200, headers: { get: k => (/content-type/i.test(k) ? 'audio/mpeg' : '') }, blob: async () => ({ size: 64, text }) });
      }
      if (url.includes('/api/local-voice/status')) return json({ available: w.leg !== 'dictation', asr: 'ready', tts: 'ready', voices: [], voice: '' });
      if (url.includes('/api/stt/native/status')) return json({ available: w.leg === 'dictation' });
      if (url.includes('/api/local-voice/transcribe')) return json({ text: w.transcript });
      return json({});
    },
    // a send that STARTS a run opens that run's reply synchronously, through the real closure, as chat.js send() does
    Chat: { isBusy: () => w.busy, status: s => { w.statuses.push(String(s)); }, send() {}, autoGrowInput() {},
      // records which replies were still live the moment the run was stopped (null: a build with no reply registry)
      stopActive: () => { w.stops.push(mods.Voice.replies ? mods.Voice.replies().map(reply => reply.id) : null); w.busy = false; },
      sendOrQueue: text => {
        w.sent.push(text);
        const state = w.sendState || (w.busy ? 'queued' : 'started');
        if (state === 'started') w.runs.push(chatReply(mods.Voice));
        return { ok: true, state };
      },
      answerConsent: () => Promise.resolve({ appliedDecision: 'once' }), consentPhrase: () => 'write a file' },
    Workstreams: { activeId: () => 'ws-a', active: () => ({ id: 'ws-a', agentId: 'agent', title: 'General' }), get: id => ({ id, agentId: 'agent', title: id }),
      list: () => [{ id: 'ws-a', agentId: 'agent', title: 'General' }], switch: id => ({ id }) },
    Channels: { isBusy: () => w.busy, statusOf: () => '', pendingOf: () => w.pending, pendingAllOf: () => (w.pending ? [w.pending] : []) },
    SFX: { open() {}, click() {}, think() {}, boot() {}, press() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => '', getProv: () => 'openrouter', getModel: () => 'model', configured: () => false }
  };
  sandbox.globalThis = sandbox;
  if (typeof opts.configure === 'function') opts.configure(sandbox); // transport constructors must exist before feature detection
  mods = bootVoice(sandbox, { through: 'voice-live.js' });
  // ---- drivers ----
  w.mic = () => w.mics[w.mics.length - 1];   // the recognizer listening now (the dictation leg's ear, or a COMMS take)
  // a key pressed on the page: every document keydown handler the voice scripts registered, in registration order
  w.key = key => { const ev = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; (w.listeners.keydown || []).forEach(fn => fn(ev)); return ev; };
  // one microphone frame at `level` into the script processor the models leg wired (its ear), on the page's clock
  w.frame = level => {
    const processor = w.processors[w.processors.length - 1];
    w.skew += FRAME / RATE * 1000;
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(FRAME).fill(level) } });
  };
  // the Commander starts speaking: past the calibration window, `voiced` loud frames (3 clear the onset while nothing
  // is audible; 8, the 300 ms rule, while the agent is). True when the call heard an onset (the panel reads HEARING).
  const panelState = () => $('lv-state').textContent;
  w.onset = (voiced = 3) => { w.skew += 1000; for (let i = 0; i < voiced; i++) w.frame(0.1); return panelState() === 'HEARING'; };
  // ...and stops: silence until the endpoint closes the turn, then the station's transcription answers `text`.
  // True when the endpoint closed the turn into the transcription (the panel read TRANSCRIBING).
  w.endTurn = async text => {
    w.transcript = text;
    let closed = false;
    for (let i = 0; i < 60; i++) { w.frame(0); closed = closed || panelState() === 'TRANSCRIBING'; }
    await tick(30);
    return closed;
  };
  return Object.assign(mods, { w, spoken: w.spoken, node: $, press: id => $(id).onclick(), sandbox });
}

module.exports = { bootVoice, VOICE_SCRIPTS, chatReply, liveWindow };
