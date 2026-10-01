'use strict';

/* Shared VM harness for the video-call module tests (frontend/app/avatar-call.js).
   Runs the real module with stand-ins for the DOM, the microphone (a ScriptProcessor we feed frames into), the
   Simli face, the chat voice (Voice) and the sidecar routes.
     harness({ storage, session, elevenlabsFails }) -> { ctx, voice, log, mic, speak, call }
   storage: preset localStorage (call settings); session: extra /api/avatar/session fields;
   elevenlabsFails: /api/tts refuses ElevenLabs requests the way the sidecar does. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeElement() {
  const el = {
    dataset: {}, style: {}, hidden: false, textContent: '', value: '', options: [], title: '',
    appendChild() {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute() { return ''; },
    classList: { toggle() {}, add() {}, remove() {} },
    getBoundingClientRect() { return { left: 0, top: 0, width: 340, height: 480 }; },
    querySelector() { return makeElement(); }, closest() { return null; },
    play() { return Promise.resolve(); }
  };
  return el;
}

function harness(opts) {
  opts = opts || {};
  const elements = new Map();
  const log = { reply: [], tts: [], ttsBodies: [], stt: [], sent: 0, crewStops: 0 };
  let nextTranscript = '';
  let proc = null;

  const voice = {
    speaking: false, pending: false, text: '',
    isSpeaking() { return this.speaking; },
    hasPendingSpeech() { return this.pending; },
    pendingSpeechText() { return this.text; },
    stopSpeaking() { this.speaking = false; this.pending = false; log.crewStops++; }
  };

  class FakeSimli {
    constructor() { this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    async start() {}
    stop() {}
    sendAudioData() { log.sent++; }
    ClearBuffer() {}
  }

  class FakeAudioContext {
    constructor() { this.sampleRate = 16000; this.destination = {}; }
    async resume() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { proc = { connect() {}, disconnect() {}, onaudioprocess: null }; return proc; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async decodeAudioData() { return { sampleRate: 16000, getChannelData: () => new Float32Array(1600) }; }   // 0.1 s per sentence
    close() {}
  }

  const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 500, headers: { get: () => 'application/json' }, json: async () => obj });
  async function fetch(url, init) {
    url = String(url);
    if (url === '/api/avatar/status') return json({ configured: true, voiceEngine: 'edge', brain: { ok: true } });
    if (url === '/api/avatar/session') return json(Object.assign({ sessionToken: 'tok', voiceEngine: 'edge', voiceId: 'af_heart' }, opts.session || {}));
    if (url === '/api/stt/status') return json({ available: true, local: true, cloud: false, native: false });
    if (url === '/api/local-voice/warm') return json({ ok: true });
    if (url === '/api/local-voice/transcribe') { log.stt.push(nextTranscript); return json({ ok: true, text: nextTranscript }); }
    if (url === '/api/tts') {
      const req = JSON.parse(init.body);
      log.tts.push(req.text); log.ttsBodies.push(req);
      // /api/tts answers a refused ElevenLabs call with 200 + JSON { fallback, reason } (media-service.js).
      if (req.provider === 'elevenlabs' && opts.elevenlabsFails) return json({ fallback: true, reason: typeof opts.elevenlabsFails === 'string' ? opts.elevenlabsFails : 'elevenlabs 401 — invalid api key' });
      return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => new ArrayBuffer(8) };
    }
    if (url === '/api/avatar/reply') {
      log.reply.push(JSON.parse(init.body));
      const lines = [JSON.stringify({ type: 'text', delta: 'Sure thing. ' }), JSON.stringify({ type: 'done' })].join('\n') + '\n';
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new TextEncoder().encode(lines) })) }) } };
    }
    return json({});
  }

  const ctx = {
    console: { log() {}, warn() {}, error: console.error },
    setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, TextEncoder, AbortController, Promise, Date, Math, JSON,
    Float32Array, Uint8Array, DataView, ArrayBuffer, Error, Map, Set, String, Number, Array, Object,
    fetch,
    localStorage: { _s: Object.assign({}, opts.storage || {}), getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [] }) } },
    requestAnimationFrame: () => 0,
    getComputedStyle: () => ({ zoom: '1', display: 'block' }),
    document: {
      readyState: 'complete', body: makeElement(), head: makeElement(),
      getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
      createElement: () => makeElement(), addEventListener() {}
    },
    Voice: voice,
    Chat: { echoUser() {}, typeLine() {}, getHistory: () => [], isBusy: () => false },
    SimliSDK: { SimliClient: FakeSimli, LogLevel: { ERROR: 2 } }
  };
  ctx.window = ctx;
  ctx.AudioContext = FakeAudioContext;
  ctx.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/app/avatar-core.js'), 'utf8'), ctx, { filename: 'avatar-core.js' });
  vm.runInContext(fs.readFileSync(path.join(root, 'frontend/app/avatar-call.js'), 'utf8') + '\nthis.AvatarCall = AvatarCall;', ctx, { filename: 'avatar-call.js' });

  // Feed the microphone: `ms` of frames at a constant level (rms == level for a constant signal).
  function mic(level, ms) {
    for (let t = 0; t < ms; t += 40) {
      const frame = new Float32Array(640).fill(level);
      proc.onaudioprocess({ inputBuffer: { getChannelData: () => frame } });
    }
  }
  // One spoken utterance: speech, then enough silence for the VAD to close it; transcribed as `text`.
  async function speak(text) {
    nextTranscript = text;
    mic(0.2, 800);
    mic(0.002, 900);
    await sleep(60);   // transcription + turn dispatch are async
  }
  return { ctx, voice, log, mic, speak, call: () => ctx.AvatarCall };
}


module.exports = { harness, sleep };
