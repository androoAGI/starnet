/* node test/voice.button.test.js — behavioral guard for the voice mic BUTTON state machine.

   Andrew reported "the voice button does not always work reliably." The intermittent failures were
   button states that could WEDGE (stuck 'rec' / listening=true with no way back) rather than always
   recovering to a usable state. This test boots the real frontend/app/voice.js in a fabricated window
   (no DOM/jsdom needed — voice.js only touches a handful of globals) and drives the recovery paths:

     • webSpeech: recognition.start() throws (double-start / InvalidStateError) → button recovers.
     • webSpeech: a STALE errored recognition fires onend LATE, after a fresh listen started — it must
       NOT null/clear the new listen (the orphan-instance wedge).
     • recorder (desktop): getUserMedia HANGS (dismissed permission prompt) → a timeout returns the
       button to usable instead of a permanent dead 'rec' button.
     • recorder: getUserMedia denied then re-granted → mic works again.

   Every path asserts the button ends in a usable, non-listening state — the task's core law:
   "every error path returns the button to a usable state; never a dead/stuck button." */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'voice.js'), 'utf8');
// The page's ONE reading of a refused /api/* reply (harness.js classifyApiFailure), lifted by source so the rig's stub
// Harness classifies a 403 exactly as the real one does, bound to whatever recovery state a case stubs.
const HARNESS_SRC = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
const CLASSIFY_API_FAILURE = (() => {
  const m = /(  function classifyApiFailure\([\s\S]*?\n  \})/.exec(HARNESS_SRC);
  if (!m) throw new Error('harness.js no longer defines classifyApiFailure');
  return new Function(m[1] + '\nreturn classifyApiFailure;')();   // eslint-disable-line no-new-func
})();

// ---- controllable browser mocks --------------------------------------------------------------
let liveRecs = 0, srStartMode = 'ok', srInstances = [];
class MockSR {
  constructor() { this.started = false; this.onresult = this.onerror = this.onend = null; srInstances.push(this); }
  start() { if (srStartMode === 'throw' || this.started) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; } this.started = true; liveRecs++; }
  stop() { if (this.started) { this.started = false; liveRecs--; const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); } }
  abort() { if (this.started) { this.started = false; liveRecs--; } const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); }
  fireError(err) { this.onerror && this.onerror({ error: err }); }
  fireFinal(t) { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] }); if (this.started) { this.started = false; liveRecs--; } this.onend && this.onend(); }
}

let gumMode = 'ok', gumPending = [], gumCalls = 0;
function fakeStream() { return { getTracks: () => [{ stop() {} }] }; }
function makeGum() {
  return () => new Promise((res, rej) => {
    gumCalls++;
    if (gumMode === 'ok') res(fakeStream());
    else if (gumMode === 'deny') { const e = new Error('denied'); e.name = 'NotAllowedError'; rej(e); }
    else gumPending.push({ res, rej });   // 'hang'
  });
}
let mrInstances = [], processorInstances = [];
class MockMR {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; this.state = 'inactive'; this.ondataavailable = this.onstop = this.onerror = null; mrInstances.push(this); }
  start() { this.state = 'recording'; }
  stop() { if (this.state !== 'inactive') { this.state = 'inactive'; const s = this; setTimeout(() => { s.onstop && s.onstop(); }, 0); } }
}
class MockAnalyser { constructor() { this.fftSize = 2048; } getFloatTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = 0; } }
class MockProcessor {
  constructor() { this.onaudioprocess = null; processorInstances.push(this); }
  connect() {} disconnect() {}
  fire(samples) {
    const data = Float32Array.from(samples || [0.25, -0.25, 0.1, -0.1]);
    if (this.onaudioprocess) this.onaudioprocess({ inputBuffer: { getChannelData: () => data } });
  }
}
/* canSpeak() is `typeof Audio !== 'undefined' && typeof fetch !== 'undefined'`, and without it init() HIDES
   the speaker toggle and never calls reflectToggle — so any test of the tooltip's reflect path is vacuous.
   Opt in with boot({ audio: true }). Only ever constructed on a SUCCESSFUL synth, so a degrade test never
   reaches it. */
class MockAudio {
  constructor(src) { this.src = src || ''; this.onended = this.onerror = this.onpause = null; this.currentTime = 0; this.playbackRate = 1; this.preload = ''; }
  play() { return Promise.resolve(); }
  pause() {} load() {} addEventListener() {} removeEventListener() {}
}
class AutoEndAudio extends MockAudio {
  play() {
    setTimeout(() => {
      if (this.onplay) this.onplay();
      setTimeout(() => { if (this.onended) this.onended(); }, 0);
    }, 0);
    return Promise.resolve();
  }
}
class MockAC {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return new MockAnalyser(); }
  createScriptProcessor() { return new MockProcessor(); }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 0 } }; }
  close() {} resume() {}
}

function mkEl(id) {
  const cls = new Set();
  const e = {
    id, value: '', textContent: '', title: '', innerHTML: '', style: {}, _attrs: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else { on ? cls.add(c) : cls.delete(c); } }, contains: c => cls.has(c) },
    setAttribute(k, v) { e._attrs[k] = v; }, getAttribute(k) { return e._attrs[k]; }, addEventListener() {}, onclick: null
  };
  return e;
}

// Build a fresh voice.js instance in its own sandbox. `recorder` force-selects the recorder path;
// `desktop` exposes the same mic/MediaRecorder surface without overriding production provider selection.
function boot(opts) {
  opts = opts || {};
  liveRecs = 0; srInstances = []; gumMode = 'ok'; gumPending = []; gumCalls = 0; mrInstances = []; processorInstances = [];
  const hasRecorder = !!(opts.recorder || opts.desktop);
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => nodes[id] = mkEl(id));
  const statusLog = [];
  const win = {};
  // TIME-COMPRESS the long ceilings (12s gUM, 30s hard cap) so the test runs fast; short timers unchanged.
  // Keep the compressed ceiling above the test's successful-audio injection AND its async live-preview
  // round-trip. An aggressively tiny cap can abort a healthy preview before its promise settles on a busy gate.
  const st = (fn, ms, ...a) => {
    // Permission-order tests exercise late grants, not expiry. Keep the real 12s ceiling
    // there: a 50ms simulated prompt can expire between the two grants on a busy gate.
    if (opts.realPermissionTimeout && ms === 12000) return setTimeout(fn, ms, ...a).unref();
    return setTimeout(fn, ms >= 30000 ? 200 : (ms >= 1000 ? 50 : ms), ...a);
  };
  const sandbox = {
    window: win,
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    navigator: hasRecorder ? { mediaDevices: { getUserMedia: makeGum() } } : { mediaDevices: undefined },
    location: { search: opts.recorder ? '?stt=recorder' : '' },
    localStorage: opts.localStorage || (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })(),
    SpeechRecognition: hasRecorder ? undefined : MockSR,
    MediaRecorder: hasRecorder ? MockMR : undefined,
    AudioContext: MockAC,
    Audio: opts.Audio || (opts.audio ? MockAudio : undefined),
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: url => { if (opts.onRevoke) opts.onRevoke(url); } },
    AbortController,   // neural-TTS synth uses one per request to allow barge-in cancel
    Blob: class { constructor(parts, o) { this.size = (parts && parts.length) ? 1 : 0; this.type = (o && o.type) || ''; } },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) })),
    Chat: { isBusy: () => sandbox.__busy, status: s => { statusLog.push(s); nodes['chat-status'].textContent = s; }, send: t => sandbox.__sent.push(t), autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: Object.assign({ getKey: () => (opts.ttsKey ? 'k' : ''), configured: () => false }, opts.harness || {}),
    __busy: false, __sent: []
  };
  if (opts.now) sandbox.Date = class extends Date { static now() { return opts.now(); } };
  {
    const H = sandbox.Harness;
    if (!H.classifyApiFailure) H.classifyApiFailure = r => CLASSIFY_API_FAILURE(r, {
      sessionStale: typeof H.sessionStale === 'function' ? H.sessionStale() : undefined,
      tokenWithheld: typeof H.tokenWithheld === 'function' ? H.tokenWithheld() : '',
      withheldNotice: typeof H.tokenWithheldNotice === 'function' ? H.tokenWithheldNotice() : ''
    });
  }
  // speechSynthesis is DELETED from the speak path; a test may inject a spy to prove it's never invoked.
  sandbox.globalThis = sandbox;
  win.SpeechRecognition = hasRecorder ? undefined : MockSR;
  win.AudioContext = opts.AudioContext || MockAC;
  win.speechSynthesis = opts.speechSynthesis || undefined;
  vm.createContext(sandbox);
  vm.runInContext(SRC + '\nthis.__Voice = Voice;', sandbox, { filename: 'voice.js' });
  const Voice = sandbox.__Voice;
  Voice.init({ name: 'Tester' });
  return {
    Voice, nodes, statusLog, sandbox,
    micRec: () => nodes['chat-mic'].classList.contains('rec'),
    gumCalls: () => gumCalls
  };
}

// a /api/tts endpoint that always FAILS with a given reason (→ neural voice degrades to the browser
// voice). Any non-TTS call (e.g. STT transcribe) keeps the normal success shape.
function ttsFailFetch(reason) {
  return (url) => (String(url).indexOf('/api/tts') >= 0)
    ? Promise.resolve({ ok: false, status: 402, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ reason }) })
    : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
}

// a /api/tts endpoint that always returns a {fallback,reason} (NON-audio) response and COUNTS how many
// times it was actually hit — so a test can prove the client re-probes (fetches) vs. stays latched off.
function countingFetch(state, reason) {
  return (url) => {
    if (String(url).indexOf('/api/tts') >= 0) {
      state.tts++;
      return Promise.resolve({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ fallback: true, reason }) });
    }
    return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
  };
}

const tick = (n = 12) => new Promise(r => setTimeout(r, n));
// Wait for an OUTCOME, never a fixed sleep. The recorder's stop -> onstop -> finish -> transcribe().then
// chain is several await hops deep, and inside the full gate it competes with hundreds of other node
// processes for the event loop — a fixed budget that passes alone becomes a coin flip under load. This
// exits the instant the condition holds, so the ceiling is free on a green run.
async function until(pred, ms) {
  for (let waited = 0; waited < ms; waited += 10) { if (pred()) return true; await tick(10); }
  return pred();
}
// Did the mic open at ANY point inside the window? The rig compresses the listen hard cap to 20ms, so a
// healthy hands-free loop is a rapid open/close cycle — a single sample lands in a gap half the time.
async function opensWithin(t, ms) {
  for (let waited = 0; waited < ms; waited += 10) {
    if (t.Voice.isListening()) return true;
    await tick(10);
  }
  return t.Voice.isListening();
}

(async () => {
  // Both production effects graphs must survive output-device closure. Never capture a
  // fresh media element into a graph that cannot render (including rejected resume).
  for (const shell of [true, false]) {
    const contexts = [], captured = [], resumes = [];
    let deviceState = 'running';
    const node = () => new Proxy({ connect() {}, disconnect() {}, start() {} }, {
      get(target, key) { return key in target ? target[key] : (target[key] = { value: 0 }); }
    });
    class DeviceAC extends MockAC {
      constructor() { super(); this.state = deviceState; contexts.push(this); }
      createGain() { return node(); }
      createBiquadFilter() { return node(); }
      createWaveShaper() { return node(); }
      createDelay() { return node(); }
      createDynamicsCompressor() { if (!shell) throw new Error('no shell'); return node(); }
      createOscillator() { return node(); }
      createConvolver() { return node(); }
      createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
      createMediaElementSource() { captured.push(this); return node(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
      resume() { resumes.push(this.state); return Promise.reject(new Error('device unavailable')); }
    }
    const t = boot({ Audio: AutoEndAudio, AudioContext: DeviceAC,
      fetch: async () => ({ ok: true, headers: { get: () => 'audio/wav' }, blob: async () => ({ size: 1 }) }) });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('Before device change.', 'agent');
    await until(() => captured.length === 1 && !t.Voice.isReplyPending(), 1000);
    const first = captured[0];
    A.ok(!!first, 'device recovery: initial graph captures audio');
    await first.close();
    t.Voice.speak('After device change.', 'agent');
    await until(() => captured.length === 2 && !t.Voice.isReplyPending(), 1000);
    A.ok(captured[1] !== first && captured[1].state === 'running', 'device recovery: closed graph replaced for ' + (shell ? 'shell' : 'transmission'));
    for (const state of ['suspended', 'interrupted']) {
      deviceState = state;
      for (const ctx of contexts) if (ctx.state !== 'closed') ctx.state = state;
      const count = captured.length;
      t.Voice.speak('Use native playback while recovery is unavailable.', 'agent');
      await until(() => !t.Voice.isReplyPending(), 1000);
      A.eq(captured.length, count, 'device recovery: ' + state + ' graph cannot steal native output');
      A.ok(resumes.includes(state), 'device recovery: ' + state + ' resume attempted without unhandled rejection');
    }
    t.Voice.stopSpeaking();
  }
  // --- standard voice is one click to record, a second click to finish; Local Live stays automatic ----
  {
    const calls = [];
    const fetch = (url) => {
      calls.push(String(url));
      if (url === '/api/stt/status') return Promise.resolve({ ok: true, json: () => Promise.resolve({ available: true, preferred: 'native' }) });
      if (url === '/api/stt/native') return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, text: 'windows dictation' }) });
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };
    const t = boot({ desktop: true, fetch });
    await tick();
    t.nodes['chat-mic'].onclick();
    await until(() => processorInstances.length > 0, 500);
    const processor = processorInstances[processorInstances.length - 1];
    const voiced = new Float32Array(2048); voiced.fill(0.18); processor.fire(voiced);
    await tick(80); // longer than the former compressed silence endpoint: the take must remain open
    A.eq(t.Voice.isListening(), true, 'Windows standard voice remains recording across a pause');
    A.eq(t.sandbox.__sent.length, 0, 'the first click never auto-submits a standard voice take');
    A.ok(/click again to finish and send/i.test(t.nodes['chat-mic'].title), 'the active mic names the second-click action');
    t.nodes['chat-mic'].onclick();
    await until(() => t.sandbox.__sent.length === 1, 1000);
    A.eq(t.Voice.sttEngine(), 'recorder', 'Windows standard voice captures the bounded take before native transcription');
    A.eq(t.sandbox.__sent[0], 'windows dictation', 'the second click sends the Windows-native transcript as a regular message');
    A.eq(t.gumCalls(), 1, 'Windows standard voice opens one browser-owned microphone take');
    A.ok(calls.includes('/api/stt/native') && !calls.includes('/api/local-voice/transcribe'), 'standard dictation stays separate from Local Live transcription');
    A.ok(t.Voice.inVoiceMode() === false, 'regular dictation does not enable hands-free/live voice mode');
  }

  {
    const calls = [];
    let pcmBody = null;
    let localTranscribes = 0;
    const fetch = (url, init) => {
      calls.push(String(url));
      if (url === '/api/stt/status') return Promise.resolve({ ok: true, json: () => Promise.resolve({ available: true, preferred: 'local' }) });
      if (url === '/api/local-voice/transcribe') {
        pcmBody = init && init.body;
        localTranscribes++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve({
          ok: true,
          text: localTranscribes === 1 ? 'Acme Corporation' : 'Acme Corporation, A C M E'
        }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    };
    const t = boot({ desktop: true, fetch });
    await tick();
    t.Voice.startListening();
    await until(() => processorInstances.length > 0, 500);
    A.ok(processorInstances.length > 0, 'local push-to-talk captures PCM alongside the level meter');
    const processor = processorInstances[processorInstances.length - 1];
    const voiced = new Float32Array(2048); voiced.fill(0.18);
    for (let i = 0; i < 18; i++) processor.fire(voiced);
    await until(() => t.nodes['chat-input'].value === 'Acme Corporation', 1000);
    A.eq(t.nodes['chat-input'].value, 'Acme Corporation', 'local push-to-talk renders real recognized words in the composer before finalize');
    A.ok(!/^[·•]+$/.test(t.nodes['chat-input'].value), 'the composer never substitutes bullet progress for the words being recognized');
    t.Voice.stopListening();
    await until(() => t.sandbox.__sent.length === 1, 1000);
    A.eq(t.Voice.sttEngine(), 'recorder', 'macOS/local push-to-talk keeps the one-shot recorder UI');
    A.eq(t.sandbox.__sent[0], 'Acme Corporation, A C M E', 'the final local dictation is sent as a regular typed message');
    A.eq(t.nodes['chat-input'].value, '', 'finalize clears only the live preview that dictation itself wrote');
    A.ok(pcmBody && typeof pcmBody.byteLength === 'number' && pcmBody.byteLength > 0 && pcmBody.byteLength % 4 === 0,
      'local push-to-talk posts decoded Float32 PCM, never WebM/MP4 bytes');
    A.ok(calls.includes('/api/local-voice/transcribe') && !calls.includes('/api/stt/native'), 'local dictation does not invoke the native/live provider');
    A.ok(t.Voice.inVoiceMode() === false, 'local push-to-talk remains separate from hands-free/live voice mode');
  }

  A.ok(!/cb\.onInterim\([\s\S]{0,100}repeat\(/.test(SRC), 'recorder progress never writes fake dot or bullet text into the composer');

  // Final recognition and live previews are independent: having a cloud credential must not disable
  // the installed local preview engine. Windows-only stations preview their captured PCM as well.
  for (const preferred of ['cloud', 'native']) {
    const t = boot({ desktop: true, fetch: (url) => {
      if (url === '/api/stt/status') return Promise.resolve({ ok: true, json: async () => ({
        available: true, preferred, local: preferred === 'cloud', native: true
      }) });
      if (url === (preferred === 'cloud' ? '/api/local-voice/transcribe' : '/api/stt/native')) {
        return Promise.resolve({ ok: true, json: async () => ({ok: true, text: 'visible before I finish'}) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    } });
    await tick(); t.Voice.startListening();
    await until(() => processorInstances.length > 0, 500);
    const processor = processorInstances[processorInstances.length - 1];
    const speech = new Float32Array(2048).fill(.18);
    for (let i=0;i<18;i++) processor.fire(speech);
    await until(() => t.nodes['chat-input'].value === 'visible before I finish', 1000);
    A.eq(t.nodes['chat-input'].value, 'visible before I finish', preferred + ' voice exposes interim words before the second click');
    A.eq(t.sandbox.__sent.length, 0, preferred + ' preview does not send a task');
    t.Voice.stopConvo(); await tick();
  }

  // Browser recognition may end its own instance after a pause even in continuous mode. Standard voice
  // keeps the take open, retains those words, and sends them only when the Commander clicks again.
  {
    const pending = [], heard = [];
    const t = boot({ desktop: true, fetch: url => {
      if (url === '/api/stt/native') return new Promise(resolve => pending.push(text => resolve({ok:true,json:async()=>({ok:true,text})})));
      return Promise.resolve({ok:true,json:async()=>({available:true,preferred:'native'})});
    } });
    await tick();
    t.Voice.startCoordinator({onTranscript:text=>{heard.push(text);return true;}});
    await tick();
    t.Voice.pauseCoordinator(); t.Voice.resumeCoordinator(); await tick();
    A.eq(pending.length, 2, 'resume starts a new Windows recognition');
    pending[0]('discarded before pause'); await tick();
    A.eq(heard.length, 0, 'a late native result cannot submit speech discarded by pause');
    A.ok(t.Voice.isListening(), 'old native completion cannot clear the resumed listener');
    pending[1]('fresh after resume'); await tick();
    A.eq(heard[0], 'fresh after resume', 'the resumed recognition still delivers');
    t.Voice.stopCoordinator(); await tick();
  }
  {
    const t = boot();
    t.nodes['chat-mic'].onclick(); await tick();
    srInstances[srInstances.length - 1].fireFinal('first half');
    await until(() => srInstances.length >= 2, 1000);
    A.eq(t.Voice.isListening(), true, 'browser endpointing does not close a standard two-click take');
    A.eq(t.sandbox.__sent.length, 0, 'a browser-final phrase remains buffered until the second click');
    t.nodes['chat-mic'].onclick();
    await until(() => t.sandbox.__sent.length === 1, 1000);
    A.eq(t.sandbox.__sent[0], 'first half', 'the second click sends the transcript accumulated across browser instances');
  }

  // --- webSpeech: recognition.start() throws (double-start / InvalidStateError) -----------------
  {
    const t = boot(); srStartMode = 'throw';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === false, 'webSpeech: start() throw → listening recovers to false (no wedge)');
    A.ok(!t.micRec(), 'webSpeech: start() throw → mic button not stuck in rec state');
    srStartMode = 'ok';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === true, 'webSpeech: mic works again after a start-failure');
    if (srInstances.length) srInstances[srInstances.length - 1].fireFinal('hi'); await tick();
  }

  // --- webSpeech: STALE errored recognition fires onend LATE (orphan-instance wedge) ------------
  {
    const t = boot();
    t.Voice.startListening(); await tick();                 // listen A
    const recA = srInstances[srInstances.length - 1];
    recA.fireError('network'); await tick();                 // A errors; listening cleared
    A.ok(t.Voice.isListening() === false, 'webSpeech: listening cleared after A errors');
    t.Voice.startListening(); await tick();                 // listen B
    const recB = srInstances[srInstances.length - 1];
    A.ok(t.Voice.isListening() === true && recB !== recA, 'webSpeech: fresh listen B started after A errored');
    recA.onend && recA.onend(); await tick();                // A's late onend — must NOT touch B
    A.ok(t.Voice.isListening() === true, 'webSpeech: B survives A late onend (stale instance does not null the live one)');
    t.Voice.stopListening(); await tick();
    A.ok(t.Voice.isListening() === false, 'webSpeech: B is still stoppable after A late onend (not wedged)');
  }

  // --- recorder (desktop): getUserMedia HANGS (dismissed prompt) → recover, not a dead button ---
  {
    const t = boot({ recorder: true });
    A.ok(t.Voice.canListen() === true, 'recorder path is active when SR is absent');
    gumMode = 'hang';
    t.Voice.startListening(); await tick(60);                // wait past the compressed gUM ceiling
    A.ok(t.Voice.isListening() === false, 'recorder: gUM hang times out → button recovers (NOT a dead mic)');
    A.ok(!t.micRec(), 'recorder: gUM hang → mic button cleared out of rec state');
    A.ok(t.statusLog.some(s => /mic|allow|blocked|try again/i.test(s)), 'recorder: gUM hang → a visible cue is shown');
  }

  // --- recorder: getUserMedia denied then re-granted -------------------------------------------
  {
    const t = boot({ recorder: true });
    gumMode = 'deny';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === false, 'recorder: denial → listening false');
    A.ok(t.statusLog.some(s => /blocked|allow/i.test(s)), 'recorder: denial → actionable cue shown');
    gumMode = 'ok';
    t.Voice.startListening(); await tick();
    A.ok(t.Voice.isListening() === true, 'recorder: mic works after re-grant');
  }

  // --- Live re-arm must not cancel the reply it is waiting for ----------------------------------
  // 2026-10-01 ("the fun voice of Onyx has been completely absent since I upgraded from 0.10.0"): Live
  // dictation re-opens the mic while the run thinks; startListening() called stopSpeaking() unconditionally,
  // bumping the reply token chat.js captured at send — every chunk of the coming reply was dropped. And once
  // audio starts, a still-open dictation take must be discarded so the agent never hears itself.
  {
    const requests = [];
    const t = boot({ Audio: AutoEndAudio, fetch: (url, o) => {
      if (String(url).includes('/api/tts')) { requests.push(JSON.parse(o.body).text); return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 128 }) }); }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    } });
    t.Voice.setSpeakReplies(true);
    t.Voice.startCoordinator({ onState() {}, onTranscript: () => false }); await tick();
    srInstances[srInstances.length - 1].fireFinal('what is the weather on deck'); await tick();
    A.eq(t.sandbox.__sent.length, 1, 'live re-arm: the spoken turn was sent');
    const token = t.Voice.replyToken();          // chat.js captures this the moment the run starts
    t.sandbox.__busy = true;
    await until(() => t.Voice.isListening(), 1000);
    A.ok(t.Voice.isListening(), 'live re-arm: the mic re-opens while the run thinks (steering)');
    t.Voice.speakChunk('Clear skies over the station tonight.', 'agent', { replyToken: token });
    await until(() => requests.length > 0, 1000);
    A.eq(requests.length, 1, 'live re-arm: the re-armed mic did NOT cancel the reply — it is synthesized');
    await until(() => !t.Voice.isListening(), 1000);
    A.ok(!t.Voice.isListening(), 'live re-arm: the open take is discarded once the agent starts talking (no echo)');
    t.sandbox.__busy = false; t.Voice.endReply(); await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(t.sandbox.__sent.length, 1, 'live re-arm: the agent’s own voice is never sent back as a message');
    t.Voice.stopCoordinator();
  }

  // --- click, stop, click during the permission prompt: the first take never comes alive -------------
  {
    const t = boot({ recorder: true, realPermissionTimeout: true });
    gumMode = 'hang';
    t.Voice.startListening(); await until(() => gumPending.length === 1, 2000);   // take A waits on the prompt
    t.Voice.stopListening(); await tick();           // stop before it ever opened
    t.Voice.startListening(); await until(() => gumPending.length === 2, 2000);   // take B
    A.eq(gumPending.length, 2, 'race: two permission requests are pending');
    let stoppedA = 0;
    gumPending[0].res({ getTracks: () => [{ stop() { stoppedA++; } }] }); await until(() => stoppedA > 0, 2000);   // A's grant lands late
    A.eq(stoppedA, 1, 'race: the late grant for the abandoned take is released (mic not left hot)');
    A.eq(mrInstances.length, 0, 'race: no recorder is built for the abandoned take');
    gumPending[1].res(fakeStream()); await until(() => mrInstances.length > 0, 2000); await tick(30);
    A.eq(mrInstances.length, 1, 'race: exactly one recorder — the live take’s');
    gumMode = 'ok';
  }

  // --- a dead provider costs a reply two sentences of attempts, not every sentence ----------------
  // After MID_REPLY_GIVEUP failed chunks the rest of THIS reply stays quiet (a dead provider was re-asked every
  // sentence once the 4s cold-off lapsed: 3 attempts each, up to 30s apiece). The next reply starts fresh.
  {
    const requests = [];
    let now = Date.now();   // every clock read moves 5s on, so the 4s cold-off has ALWAYS lapsed by the next chunk
    const t = boot({ Audio: AutoEndAudio, now: () => (now += 5000), fetch: (url, o) => {
      if (!String(url).includes('/api/tts')) return Promise.resolve({ ok: true, json: async () => ({}) });
      requests.push(JSON.parse(o.body).text);
      return Promise.resolve({ ok: false, status: 503, headers: { get: () => 'application/json' }, json: async () => ({ fallback: true, reason: 'edge: edge timeout' }) });
    } });
    t.Voice.setSpeakReplies(true);
    for (let i = 1; i <= 6; i++) t.Voice.speakChunk('Sentence number ' + i + ' of a long reply.', 'agent');
    t.Voice.endReply();
    await until(() => !t.Voice.isReplyPending(), 2000);
    A.eq(requests.length, 6, 'dead provider: two sentences get their bounded attempts, the other four are not re-asked');
    A.ok(/rest of this reply/.test(t.nodes['voice-toggle'].title), 'dead provider: the notice says the rest of the reply is text-only');
    const before = requests.length;
    t.Voice.speakChunk('A brand new reply.', 'agent'); t.Voice.endReply();
    await until(() => requests.length > before, 1000);
    A.ok(requests.length > before, 'dead provider: the NEXT reply asks again');
  }

  // --- a SHORT outage must not spend every in-flight chunk's whole retry budget ------------------
  // sweep/voice 2026-10-20, live in the seeded station: the two retries fired INSTANTLY, so all three attempts of
  // every chunk in flight landed inside the same blip. A 300 ms 429 window failed the opening two chunks (prefetch
  // runs them together), MID_REPLY_GIVEUP then marked the remaining three 'cooldown' without a single request,
  // and a five-sentence reply played NOTHING although the provider was healthy again 300 ms in.
  {
    const spoken = []; let requests = 0;
    const t0 = Date.now();
    const t = boot({ Audio: AutoEndAudio, fetch: (url, o) => {
      if (!String(url).includes('/api/tts')) return Promise.resolve({ ok: true, json: async () => ({}) });
      requests++;
      if (Date.now() - t0 < 300) return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ fallback: true, reason: 'edge: edge upgrade refused: HTTP 429' }) });
      spoken.push(JSON.parse(o.body).text);
      return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 128 }) });
    } });
    t.Voice.setSpeakReplies(true);
    for (let i = 1; i <= 5; i++) t.Voice.speakChunk('Blip sentence number ' + i + ' of the reply.', 'agent');
    t.Voice.endReply();
    await until(() => !t.Voice.isReplyPending(), 6000);
    A.eq(spoken.length, 5, 'short blip: every sentence of the reply is still spoken (' + requests + ' requests, spoken ' + spoken.length + ')');
    A.ok(!/rest of this reply/.test(t.nodes['voice-toggle'].title), 'short blip: the reply is never declared voice-dead');
  }

  // --- a recognizer that fails every time PAUSES the Live mic and says why ----------------------
  // Live dictation re-armed a failing engine forever (~every 150ms) while the panel read LISTENING and the
  // status showed a raw 'mic: network'. Three hard errors in a row pause the mic with plain words — and the
  // reply the Commander is waiting for still speaks (stopConvo's stopSpeaking would have staled its token).
  {
    const requests = [];
    const t = boot({ Audio: AutoEndAudio, fetch: (url, o) => {
      if (String(url).includes('/api/tts')) { requests.push(JSON.parse(o.body).text); return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 128 }) }); }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    } });
    t.Voice.setSpeakReplies(true);
    const fatal = [];
    t.Voice.startCoordinator({ onState() {}, onTranscript: () => false, onFatal: v => fatal.push(v) }); await tick();
    const token = t.Voice.replyToken();   // a run is thinking while the mic keeps failing
    for (let i = 0; i < 3; i++) {
      const before = srInstances.length;
      srInstances[srInstances.length - 1].fireError('network');
      if (i < 2) await until(() => srInstances.length > before, 1000);
    }
    await tick(300);
    const instances = srInstances.length;
    await tick(300);
    A.eq(fatal.length, 1, 'mic errors: the loop reports ONE fatal stop to the Live panel');
    A.ok(/can.t be reached/.test(fatal[0] && fatal[0].message || ''), 'mic errors: the reason is in plain words');
    A.eq(srInstances.length, instances, 'mic errors: no further recognizer is spawned (the loop is paused)');
    A.ok(!t.statusLog.some(s => /^mic: /.test(String(s))), 'mic errors: no raw engine code reaches the status line');
    t.Voice.speakChunk('Here is the answer you asked for.', 'agent', { replyToken: token }); t.Voice.endReply();
    await until(() => requests.length > 0, 1000);
    A.eq(requests.length, 1, 'mic errors: the pause never cancels the reply the Commander is waiting for');
    await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(srInstances.length, instances, 'mic errors: the reply ending does not re-arm a paused mic');
    t.Voice.resumeCoordinator(); await until(() => srInstances.length > instances, 1000);
    A.ok(srInstances.length > instances, 'mic errors: RESUME tries the engine again');
    t.Voice.stopCoordinator();
  }

  // --- a reply closes only for the producer that owns it ---------------------------------------
  // Switching sessions mid-reply: the old run must still close its reply (else draining forever), but a run that
  // finishes minutes later must not close a reply ANOTHER session is now streaming.
  {
    const t = boot({ Audio: AutoEndAudio, fetch: (url) => String(url).includes('/api/tts')
      ? Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 128 }) })
      : Promise.resolve({ ok: true, json: async () => ({}) }) });
    t.Voice.setSpeakReplies(true);
    const a = {}; a.owner = a; const b = {}; b.owner = b;
    t.Voice.speakChunk('Session A opening line.', 'agent', a);
    t.Voice.endReply(undefined, a);
    await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(t.Voice.isReplyPending(), false, 'owner: the run that opened a reply closes it (no stuck speaking)');
    t.Voice.speakChunk('Session A again.', 'agent', a);
    t.Voice.speakChunk('Session B takes over.', 'agent', b);
    t.Voice.endReply(undefined, a); await tick(30);
    A.eq(t.Voice.isReplyPending(), true, 'owner: a backgrounded run cannot close the reply another session is streaming');
    t.Voice.endReply(undefined, b);
    await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(t.Voice.isReplyPending(), false, 'owner: the new owner closes it');
  }

  // --- OAuth Live coordinator: keyless speech stays open while a task is busy ------------------
  {
    const t = boot();
    const heard = [], states = [];
    t.sandbox.__busy = true;
    const started = t.Voice.startCoordinator({
      onState: state => states.push(state),
      onTranscript: text => { heard.push(text); return true; }
    });
    await tick();
    A.ok(started === true, 'oauth live: coordinator starts when browser speech recognition is available');
    A.ok(t.Voice.isListening() === true, 'oauth live: mic opens while the active task is busy (steer/barge-in path)');
    A.ok(states.includes('listening'), 'oauth live: listening state is surfaced to the live panel');
    srInstances[srInstances.length - 1].fireFinal('change direction'); await tick();
    A.ok(heard[0] === 'change direction', 'oauth live: final transcript reaches the coordinator');
    A.ok(t.sandbox.__sent.length === 0, 'oauth live: a claimed transcript is not double-sent through classic Chat.send');
    t.Voice.stopCoordinator(); await tick();
    A.ok(t.Voice.inVoiceMode() === false, 'oauth live: coordinator teardown closes hands-free mode');
  }

  // --- voice degrade NEVER writes to the COMMS status bar (#chat-status) ------------------------
  // When neural TTS fails, the honest "backup voice active" reason must ride the speaker toggle's
  // TOOLTIP only — never the run-state header bar (Andrew 2026-07-13: "there should never be text on
  // the comms panel on that bar"). Truthful telemetry is preserved (the reason stays inspectable on
  // hover); the header stays clean of voice-outage banners.
  {
    const t = boot({ ttsKey: true, fetch: ttsFailFetch('insufficient credits') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('hello commander, systems are nominal', 'agent'); await tick(40);
    const title = String(t.nodes['voice-toggle'].title || '');
    A.ok(/Speech interrupted|real voice|backup voice/i.test(title), 'voice degrade: honest reason pinned on the speaker-toggle tooltip (telemetry preserved)');
    A.ok(!t.statusLog.some(s => /real voice|backup voice|voice provider/i.test(String(s))), 'voice degrade: outage banner is NEVER pushed to the COMMS status bar');
    A.ok(!/real voice|backup voice/i.test(String(t.nodes['chat-status'].textContent || '')), 'voice degrade: #chat-status text carries no voice-outage banner');
  }

  // --- a 'no key' TTS response does NOT permanently disable neural (un-latched cold-off) --------
  // Previously a single {fallback,reason:'no key'} latched ttsDisabled for the whole session — robotic
  // (now silent) until reload. New contract: 'no key' is a 60s cold-off that ANY speaker toggle clears,
  // after which the very next speak attempts the sidecar fetch again.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'no key') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('first line to the commander', 'agent'); await tick(40);
    const afterFirst = state.tts;
    A.ok(afterFirst >= 1, 'no-key: the first speak actually hits /api/tts (always asks the sidecar)');
    t.Voice.speak('second line while still cold', 'agent'); await tick(40);
    A.ok(state.tts === afterFirst, 'no-key: while the cold-off is active the neural path is skipped, not re-fetched');
    // toggle the speaker (off, then on) — this must clear the cold-off and re-probe fresh.
    t.Voice.setSpeakReplies(false);
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('third line after re-toggle', 'agent'); await tick(40);
    A.ok(state.tts > afterFirst, 'no-key: a speaker toggle clears the cold-off → the next speak fetches again (NOT permanently disabled)');
  }

  // --- media decode failure AFTER playback starts clears speaking + the live output meter -------
  // This is the dangerous ordering: `onplay` turns speaking on, then the media element fails. The
  // queue may advance, but the shared live panel must not remain pinned to the agent forever.
  {
    class FailingAudio {
      constructor() { this.volume = 1; this.playbackRate = 1; this.onplay = this.onended = this.onerror = null; }
      play() {
        if (this.onplay) this.onplay();
        setTimeout(() => { if (this.onerror) this.onerror(new Error('decode failed')); }, 25);
        return Promise.resolve();
      }
      pause() { failedPauses++; }
    }
    let failedPauses = 0;
    let revoked = 0;
    const audioFetch = () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'audio/wav' },
      blob: () => Promise.resolve({ size: 128 })
    });
    const t = boot({ ttsKey: true, fetch: audioFetch, Audio: FailingAudio, onRevoke: () => { revoked++; } });
    const states = [], levels = [];
    t.Voice.attachCoordinator({ onState: state => states.push(state), onOutputLevel: level => levels.push(level) });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('this chunk begins and then fails to decode', 'agent');
    await until(() => revoked === 2 && !t.Voice.isSpeaking(), 1000);
    A.ok(states.includes('speaking'), 'post-play failure: speaking state was genuinely entered');
    A.ok(t.Voice.isSpeaking() === false, 'post-play failure: speaking state is cleared (no stuck agent turn)');
    A.ok(states.includes('ready'), 'post-play failure: coordinator returns to ready');
    A.ok(levels.some(level => level === 0), 'post-play failure: live output meter receives its terminal zero');
    A.ok(revoked === 2, 'post-play failure: both bounded playback attempts release their blob URL');
    A.ok(failedPauses >= 2, 'post-play failure: each failed element is silenced before its retry (no clip resumes over its own replay)');
  }

  // --- a FAILED neural chunk NEVER invokes speechSynthesis.speak (robotic path deleted) ---------
  // The browser speechSynthesis speak path is gone: a neural failure degrades to SILENCE (skip the chunk)
  // + the tooltip reason, never the robotic voice. Inject a speechSynthesis spy and prove it stays untouched.
  {
    const synthSpy = { speakCalls: 0, speak() { this.speakCalls++; }, cancel() {}, resume() {}, getVoices: () => [], speaking: false, pending: false, paused: false };
    const t = boot({ ttsKey: true, fetch: ttsFailFetch('insufficient credits'), speechSynthesis: synthSpy });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('this reply cannot be synthesized', 'agent'); await tick(40);
    A.ok(synthSpy.speakCalls === 0, 'failed neural chunk NEVER calls speechSynthesis.speak (no robotic fallback)');
  }

  // --- ONE transient blip must NOT silence the rest of a reply ("it only says the first word") ---
  // 2026-07-28 user report: with the agent voice on, the agent spoke its opening words and then went quiet
  // for the whole rest of the reply. Mechanism: any failed chunk armed a 4s neural cold-off, and every LATER
  // chunk of the SAME reply then short-circuited to silence without even attempting its round-trip — one blip
  // on sentence 2 guillotined sentences 3..N. Contract now: a reply already speaking keeps asking (with one
  // immediate retry for a transient class), so a single blip costs at most a beat, never the rest of the reply.
  {
    const state = { tts: 0, spoken: [] };
    // Fail the 2nd request AND its retry (a blip that outlives one retry — otherwise the retry alone rescues
    // the chunk and the cold-off gate is never exercised). Everything after returns real audio, so the ONLY
    // thing that can keep sentences 3..N silent is the cold-off leaking across the rest of the reply.
    const blipFetch = (url, o) => {
      if (String(url).indexOf('/api/tts') >= 0) {
        state.tts++;
        if (state.tts === 2 || state.tts === 3) return Promise.resolve({ ok: false, status: 429, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ fallback: true, reason: 'openrouter 429 — rate limited' }) });
        try { state.spoken.push(JSON.parse(o.body).text); } catch (_) {}
        return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: () => Promise.resolve({ size: 128 }) });
      }
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ ttsKey: true, fetch: blipFetch });
    t.Voice.setSpeakReplies(true);
    // stream a reply the way chat.js does: chunk by chunk, then close it.
    t.Voice.speakChunk('Right, ', 'agent'); await tick(20);
    t.Voice.speakChunk('here is the first full sentence. ', 'agent'); await tick(20);
    t.Voice.speakChunk('This is the second sentence. ', 'agent'); await tick(20);
    t.Voice.speakChunk('Third sentence lands here. ', 'agent'); await tick(20);
    t.Voice.speakChunk('And a fourth to close it out. ', 'agent'); await tick(20);
    t.Voice.endReply(); await until(() => state.spoken.some(s => /fourth to close/.test(s)), 5000);   // retries are spaced (RETRY_GAP_MS)
    A.ok(state.tts > 3, 'blip: a failed chunk does NOT stop the reply — later chunks still attempt their round-trip');
    A.ok(state.spoken.some(s => /fourth to close/.test(s)), 'blip: the LAST sentence of the reply is still synthesized (reply spoken through to the end)');
    A.ok(state.spoken.some(s => /second sentence/.test(s)), 'blip: the sentence after the failure is spoken (cold-off never guillotines a live reply)');
    A.ok(state.spoken.some(s => /Third sentence/.test(s)), 'blip: every remaining sentence is spoken, not just the one after the failure');
  }

  {
    const received=[];const t=boot({Audio:AutoEndAudio,fetch:(url,o)=>{
      if (String(url).includes('/api/tts')) received.push(JSON.parse(o.body).text);
      return Promise.resolve({ok:true,headers:{get:()=> 'audio/wav'},blob:async()=>({size:128}),json:async()=>({})});
    }});
    t.Voice.setSpeakReplies(true);
    const sentence='This opening clause, followed by enough context to make the whole sentence comfortably longer than one hundred and forty characters, must remain one synthesis request.';
    t.Voice.speak(sentence,'agent');await tick(30);
    A.eq(received.join('|'),sentence,'continuity: no second comma splitter inside voice queue');
  }
  // Continuity: prefetch completes out of order, playback retries remain in order, no missing tail.
  {
    const pending = [], played = []; let failFirst = true;
    class OrderedAudio extends MockAudio {
      play() { const text = this.src; played.push(text);
        // Model asynchronous media events without racing three host timers against a 40ms wait.
        queueMicrotask(() => { if (this.onplay) this.onplay();
          if (failFirst) { failFirst = false; this.error = {code: 3}; if (this.onerror) this.onerror(); }
          else if (this.onended) this.onended(); });
        return Promise.resolve();
      }
    }
    const t = boot({ Audio: OrderedAudio, fetch: (url,o) => String(url).includes('/api/tts')
      ? new Promise(resolve=>pending.push({text:JSON.parse(o.body).text, resolve}))
      : Promise.resolve({ok:true,json:async()=>({})}) });
    t.sandbox.URL.createObjectURL = blob => blob.text;
    t.Voice.setSpeakReplies(true);
    t.Voice.speakChunk('First complete sentence.', 'agent');
    t.Voice.speakChunk('Second complete sentence.', 'agent');
    t.Voice.endReply();
    A.eq(pending.length, 2, 'continuity: next sentence synthesizes ahead of playback');
    pending[1].resolve({ok:true,headers:{get:()=> 'audio/wav'},blob:async()=>({size:128,text:pending[1].text})});
    await tick(10); A.eq(played.length,0,'continuity: ready second sentence cannot overtake first');
    pending[0].resolve({ok:true,headers:{get:()=> 'audio/wav'},blob:async()=>({size:128,text:pending[0].text})});
    // Three asynchronous playback events (including retry) must finish. A 40ms sample can observe
    // the last play() before its onended callback on a busy host; wait for the bounded outcome.
    await until(() => played.length === 3 && !t.Voice.isReplyPending(), 1000);
    A.eq(played.join('|'),'First complete sentence.|First complete sentence.|Second complete sentence.', 'continuity: failed playback retries same audio before later sentence');
    A.eq(t.Voice.isReplyPending(),false,'continuity: successful retry drains final tail');
  }
  {
    const requests=[];
    const t=boot({Audio:AutoEndAudio,fetch:(url,o)=> {
      if (!String(url).includes('/api/tts')) return Promise.resolve({ok:true,json:async()=>({})});
      requests.push(JSON.parse(o.body).text);
      return Promise.resolve({ok:false,status:503,headers:{get:()=> 'application/json'},json:async()=>({reason:'unavailable'})});
    }});
    t.Voice.setSpeakReplies(true);const token=t.Voice.replyToken();
    t.Voice.speakChunk('The failed sentence.', 'agent', {replyToken:token});
    t.Voice.endReply();await until(()=>requests.length===3&&/couldn.t be spoken/.test(t.nodes['voice-toggle'].title),5000);   // retries are spaced (RETRY_GAP_MS)
    A.eq(requests.length,3,'continuity: synthesis exhaustion bounded to three attempts');
    A.ok(/couldn.t be spoken/.test(t.nodes['voice-toggle'].title),'continuity: exhaustion is visible immediately');
    t.Voice.speakChunk('Late text from the same failed reply.', 'agent', {replyToken:token});
    A.ok(requests.length>3,'continuity: a skipped sentence does not silence the rest of its reply');
    A.ok(t.Voice.speechDiagnostics().some(e=>e.reason==='synthesis_failure'),'continuity: synthesis cutoff is attributed');
    A.ok(!t.Voice.speechDiagnostics().some(e=>JSON.stringify(e).includes('The failed sentence')),'continuity: diagnostics omit reply text');
  }

  // --- ONE unspeakable sentence must not CUT the rest of the reply, nor the NEXT reply ----------
  // 2026-10-01 customer report ("the voice has been completely absent since I upgraded from 0.10.0 …
  // voice cutting"). Since 0.11.1 an exhausted chunk stopped the WHOLE reply (stopSpeaking bumps the
  // reply token, so chat.js's later sentences were dropped), and the 4s cold-off it armed made the NEXT
  // reply's opening sentence fail without even asking — that reply was cut before it began. 0.10.0
  // skipped the bad sentence and kept talking. Contract: skip the sentence (honest notice), keep the
  // reply, and let a fresh reply try again after a transient failure.
  {
    const requests=[], played=[];
    class PlayedAudio extends AutoEndAudio { play() { played.push(this.src); return super.play(); } }
    const t=boot({Audio:PlayedAudio,fetch:(url,o)=> {
      if (!String(url).includes('/api/tts')) return Promise.resolve({ok:true,json:async()=>({})});
      const text=JSON.parse(o.body).text; requests.push(text);
      if (/Bad sentence/.test(text)) return Promise.resolve({ok:false,status:503,headers:{get:()=> 'application/json'},json:async()=>({fallback:true,reason:'edge: edge timeout'})});
      return Promise.resolve({ok:true,headers:{get:()=> 'audio/mpeg'},blob:async()=>({size:128,text})});
    }});
    t.sandbox.URL.createObjectURL = blob => blob.text;
    t.Voice.setSpeakReplies(true);const token=t.Voice.replyToken();
    t.Voice.speakChunk('Bad sentence that cannot be voiced.', 'agent', {replyToken:token});
    t.Voice.speakChunk('Second sentence still speaks.', 'agent', {replyToken:token});
    await tick(30);
    t.Voice.speakChunk('Third sentence arrives late.', 'agent', {replyToken:token});
    t.Voice.endReply();
    await until(()=>!t.Voice.isReplyPending(),1000);
    A.eq(requests.filter(s=>/Bad sentence/.test(s)).length,3,'cut: the failed sentence still gets its bounded retries');
    A.eq(played.join('|'),'Second sentence still speaks.|Third sentence arrives late.','cut: one unspeakable sentence is skipped and the REST of the reply is spoken');
    A.ok(/couldn.t be spoken/i.test(t.nodes['voice-toggle'].title),'cut: the skipped sentence is reported honestly on the speaker');
    // the very next reply (inside the old 4s cold-off) must ask the sidecar, not die before it begins
    const before=requests.length;
    const next=t.Voice.replyToken();
    t.Voice.speakChunk('Next reply opens normally.', 'agent', {replyToken:next});
    t.Voice.endReply();
    await until(()=>!t.Voice.isReplyPending(),1000);
    A.ok(requests.length>before,'cut: a transient failure never pre-fails the NEXT reply');
    A.eq(played[played.length-1],'Next reply opens normally.','cut: the next reply is spoken');
  }

  // --- EVERY speaker-off path puts the speech note away -----------------------------------------
  // 2026-10-15 report: "this warning pops up and never goes away once you turn off voice whilst the agent is
  // chatting". Only a new SPOKEN reply (or a click) cleared the note, and a muted station opens none — the
  // speaker key cleared it, but ending Local Live / hands-free (the restore of a mute voice mode lifted) and
  // `/voice off` after it did not, so the note sat under the COMMS keys for good.
  {
    const fail503 = url => String(url).includes('/api/tts')
      ? Promise.resolve({ok:false,status:503,headers:{get:()=> 'application/json'},json:async()=>({reason:'unavailable'})})
      : Promise.resolve({ok:true,json:async()=>({})});
    const noted = t => /couldn.t be spoken/.test(t.nodes['voice-toggle'].title);
    const raiseNote = async t => {
      t.Voice.setSpeakReplies(false); A.ok(t.Voice.forceSpeakOn(), 'note: voice mode lifts a hand-set mute');
      t.Voice.speakChunk('A sentence the engine drops.', 'agent', {replyToken:t.Voice.replyToken()});
      await until(() => noted(t), 1000);
      A.ok(noted(t), 'note: a dropped sentence raises the note while the speaker is on');
    };
    const paths = {
      'Local Live ends (restoreSpeak)': t => { t.Voice.stopSpeaking(); t.Voice.restoreSpeak(); },
      // delta review 10-15: a Local Live start that fails (mic permission denied) restores the mute with NO stop first
      'a failed Local Live start (restoreSpeak alone)': t => t.Voice.restoreSpeak(),
      'hands-free ends (stopConvo)': t => t.Voice.stopConvo(),
      '/voice off (stopConvo, then setSpeakReplies off)': t => { t.Voice.stopConvo(); t.Voice.setSpeakReplies(false); },
      'the speaker key': t => t.nodes['voice-toggle'].onclick()
    };
    for (const [name, mute] of Object.entries(paths)) {
      const t = boot({Audio:AutoEndAudio, fetch:fail503});
      await raiseNote(t);
      mute(t);
      A.eq(t.Voice.isOn(), false, 'note: ' + name + ' leaves the speaker off');
      A.ok(!noted(t), 'note: ' + name + ' puts the speech note away');
      A.ok(!t.Voice.isSpeaking() && !t.Voice.isReplyPending(), 'note: ' + name + ' leaves nothing speaking or queued');
      // the agent keeps talking while muted — nothing may bring the note back
      t.Voice.speakChunk('More words while muted.', 'agent', {replyToken:t.Voice.replyToken()}); t.Voice.endReply();
      await tick(30);
      A.ok(!noted(t), 'note: ' + name + ' — a muted reply never re-raises the note');
    }
  }

  // --- a speaker restored to its mute goes SILENT, even with a sentence mid-play ---------------
  // delta review 10-15: a failed Local Live start (mic permission denied) re-mutes through Voice.restoreSpeak() with no
  // stopSpeaking() of its own, so the sentence already playing — and every one queued behind it — went on with the
  // speaker key OFF. The audio here plays until something stops it (the playback watchdog is held off), so the outcome
  // never depends on timing.
  {
    const played = [], paused = [];
    class HeldAudio extends MockAudio {
      play() { played.push(this.src); queueMicrotask(() => { if (this.onplay) this.onplay(); }); return Promise.resolve(); }
      pause() { paused.push(this.src); }
    }
    const t = boot({ Audio: HeldAudio, fetch: (url, o) => String(url).includes('/api/tts')
      ? Promise.resolve({ ok: true, headers: { get: () => 'audio/wav' }, blob: async () => ({ size: 128, text: JSON.parse(o.body).text }) })
      : Promise.resolve({ ok: true, json: async () => ({}) }) });
    t.sandbox.URL.createObjectURL = blob => blob.text;
    const compressed = t.sandbox.setTimeout;   // the rig compresses long timers; keep the 2-minute playback watchdog real
    t.sandbox.setTimeout = (fn, ms, ...a) => ms >= 100000 ? setTimeout(fn, ms, ...a).unref() : compressed(fn, ms, ...a);
    t.Voice.setSpeakReplies(false);
    A.ok(t.Voice.forceSpeakOn(), 'held: Local Live lifts the hand-set mute as it starts');
    const token = t.Voice.replyToken();
    t.Voice.speakChunk('The first sentence is playing.', 'agent', { replyToken: token });
    t.Voice.speakChunk('The second sentence waits its turn.', 'agent', { replyToken: token });
    t.Voice.endReply();
    await until(() => t.Voice.isSpeaking(), 1000);
    A.ok(t.Voice.isSpeaking() && played.length === 1, 'held: the first sentence is playing, the second queued behind it');
    t.Voice.restoreSpeak();   // the failed start's catch: nothing stopped the voice before it
    A.eq(t.Voice.isOn(), false, 'held: the restore leaves the speaker off');
    A.ok(!t.Voice.isSpeaking(), 'held: the sentence that was playing stops with it');
    A.ok(paused.length > 0 && paused.every(src => src === 'The first sentence is playing.'), 'held: its audio is paused: ' + paused.join('|'));
    A.ok(!t.Voice.isReplyPending(), 'held: nothing is left queued');
    await tick(30);
    A.eq(played.join('|'), 'The first sentence is playing.', 'held: the queued sentence never plays on a muted speaker');
  }

  // --- Local Live pins one voice AND one serving engine for the whole conversation ------------
  // Without this pin, every streamed sentence reread localStorage and independently chose Kokoro vs Edge.
  // A settings click or one transient local-engine failure could therefore change speaker mid-conversation.
  {
    const requests = [];
    const stableVoiceFetch = (url, o) => {
      if (String(url).indexOf('/api/tts') >= 0) {
        const body = JSON.parse(o.body); requests.push(body);
        const provider = body.localEngine === 'edge' ? 'edge:en-US-MichelleNeural' : 'local-kokoro';
        return Promise.resolve({
          ok: true, status: 200,
          headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'audio/wav' : (String(name).toLowerCase() === 'x-voice-provider' ? provider : '') },
          blob: () => Promise.resolve({ size: 128 })
        });
      }
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ audio: true, Audio: AutoEndAudio, fetch: stableVoiceFetch });
    const timings=[];t.Voice.attachCoordinator({onTiming:value=>timings.push(value)});
    t.sandbox.localStorage.setItem('starnet.liveVoice.localVoice.v1', 'am_onyx');
    t.Voice.setSpeakReplies(true);
    t.Voice.setLocalTts(true);
    t.Voice.speak('First sentence establishes the speaker.', 'agent');
    await until(() => requests.length >= 1 && !t.Voice.isSpeaking(), 1000);
    t.sandbox.localStorage.setItem('starnet.liveVoice.localVoice.v1', 'af_nova');
    t.Voice.speak('Second sentence must keep that same speaker.', 'agent');
    await until(() => requests.length >= 2, 1000);
    A.eq(requests[0].localVoice, 'am_onyx', 'Local Live snapshots the selected voice when the session begins');
    A.eq(requests[1].localVoice, 'am_onyx', 'a mid-session picker change cannot switch the conversation voice');
    A.eq(requests[1].localEngine, 'local-kokoro', 'the first serving engine is pinned on later turns');
    await until(()=>timings.length > 0,1000);
    A.ok(timings.length > 0 && timings.every(v=>Number.isFinite(v.audioStartMs) && v.audioStartMs >= 0), 'latency is emitted only when actual audio playback starts');
    A.ok(requests.every(r => r.local === true), 'the stable-voice requests remain on the built-in Live Voice path');
  }

  // Stable agent IDs own assignments; queued speech and live calls keep their selected identity.
  {
    const requests = [];
    const fetch = (url, o) => {
      if (url !== '/api/tts') return Promise.resolve({ok:true, json:async()=>({})});
      requests.push(JSON.parse(o.body));
      return Promise.resolve({ok:true, status:200,
        headers:{get:n=>n.toLowerCase()==='content-type' ? 'audio/wav' : 'local-kokoro'},
        blob:async()=>({size:128})});
    };
    const t = boot({audio:true, Audio:AutoEndAudio, fetch});
    t.Voice.setVoiceChoice('am_onyx');
    t.Voice.setVoiceChoice('af_nova', 'scout');
    t.Voice.setVoiceChoice('bm_george', 'builder');
    t.Voice.setSpeakReplies(true);
    const say = async (agentId, name) => {
      const count = requests.length;
      t.Voice.speakChunk('This is a short reply.', name, {agentId});
      t.Voice.endReply();
      await until(()=>requests.length > count && !t.Voice.isReplyPending(), 1000);
      return requests[count];
    };
    A.eq((await say('scout', 'SCOUT')).localVoice, 'af_nova', 'scout speaks with its assigned voice');
    A.eq((await say('builder', 'BUILDER')).localVoice, 'bm_george', 'builder has a distinct assigned voice');
    A.eq((await say('scout', 'RENAMED')).localVoice, 'af_nova', 'renaming cannot change the stable agent voice');
    A.ok(requests.every(r=>r.local), 'assigned voices use the built-in engine even outside hands-free');
    const reloaded = boot({localStorage:t.sandbox.localStorage});
    A.eq(reloaded.Voice.localVoiceId('scout'), 'af_nova', 'assignment survives frontend reinitialization');
    t.Voice.setLocalTts(true);
    await say('scout', 'SCOUT');
    t.Voice.setVoiceChoice('af_heart', 'scout');
    A.eq((await say('scout', 'SCOUT')).localVoice, 'af_nova', 'live agent voice remains pinned after a settings change');
    A.eq((await say('builder', 'BUILDER')).localVoice, 'bm_george', 'switching live agents uses the new speaker assignment');
    t.Voice.setLocalTts(false); t.Voice.setLocalTts(true);
    A.eq((await say('scout', 'SCOUT')).localVoice, 'af_heart', 'new live call adopts the saved change');
    t.Voice.setLocalTts(false);
    t.Voice.setVoiceChoice('', 'scout');
    A.eq(t.Voice.localVoiceId('scout'), 'am_onyx', 'clearing an assignment restores station inheritance');
    t.sandbox.Workstreams = {active:()=>({agentId:'builder'}),get:()=>({agentId:'scout'})};
    A.eq(t.Voice.currentAgentId(), 'builder', 'ordinary voice follows the active session agent');
    t.sandbox.VoiceLive = {boundSessionId:()=> 'bound'};
    A.eq(t.Voice.currentAgentId(), 'scout', 'live voice follows its bound session despite browsing elsewhere');
    t.sandbox.window.__TAURI__ = {}; t.sandbox.navigator.platform = 'MacIntel';
    A.ok(t.Voice.microphoneHelp().includes('Privacy & Security'), 'desktop Mac recovery directs to system microphone settings');
    t.sandbox.localStorage.setItem = () => { throw new Error('storage full'); };
    let refused = false;
    try { t.Voice.setVoiceChoice('af_nova', 'scout'); } catch (_) { refused = true; }
    A.ok(refused, 'failed storage never returns a false saved acknowledgement');
  }

  // --- a transient failure is RETRIED once, so a one-shot blip loses NOTHING -------------------
  // Narrower guard on the retry itself: fail exactly one request and prove the same chunk's text is
  // re-requested and spoken (a single 429 must cost a beat of latency, never a whole sentence).
  {
    const state = { tts: 0, spoken: [] };
    const oneBlip = (url, o) => {
      if (String(url).indexOf('/api/tts') >= 0) {
        state.tts++;
        if (state.tts === 2) return Promise.resolve({ ok: false, status: 429, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ fallback: true, reason: 'openrouter 429 — rate limited' }) });
        try { state.spoken.push(JSON.parse(o.body).text); } catch (_) {}
        return Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: () => Promise.resolve({ size: 128 }) });
      }
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ ttsKey: true, fetch: oneBlip });
    t.Voice.setSpeakReplies(true);
    t.Voice.speakChunk('Right, ', 'agent'); await tick(20);
    t.Voice.speakChunk('here is the first full sentence. ', 'agent'); await tick(20);
    t.Voice.endReply(); await until(() => state.spoken.some(s => /first full sentence/.test(s)), 5000);   // retries are spaced (RETRY_GAP_MS)
    A.ok(state.spoken.some(s => /first full sentence/.test(s)), 'retry: a transient failure is retried once, so the blipped sentence is still spoken');
    A.ok(!/real voice/i.test(String(t.nodes['voice-toggle'].title || '')), 'retry: a blip that the retry rescued does NOT pin an outage banner on the toggle');
  }

  // --- a KEYLESS station: an Edge blip is a BLIP, not a missing credential -----------------------
  // The sidecar prefixes 'no key' structurally whenever the keyed tier has no credential, so on the exact
  // station the free keyless Edge floor exists for, every transient Edge failure arrived as
  // 'no key; edge: <transient>'. The client tested the terminal class FIRST, so: no retry, a 60s
  // dead-voice cold-off instead of 4s, and a tooltip telling the user to buy an API key to fix a network
  // hiccup. The whole transient-failure path was unreachable code on a keyless station.
  {
    const state = { tts: 0 };
    let now = Date.now();
    const t = boot({ now: () => now, fetch: countingFetch(state, 'no key; edge: edge timeout') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('first line on a keyless station', 'agent'); await until(() => state.tts >= 3 && !t.Voice.isReplyPending(), 5000);   // retries are spaced (RETRY_GAP_MS)
    A.eq(state.tts, 3, 'keyless + edge blip: two bounded retries retain the chunk');
    A.ok(!/needs an OpenRouter, Gemini, or OpenAI credential/.test(String(t.nodes['voice-toggle'].title || '')),
      'keyless + edge blip: the tooltip does NOT demand a credential for a network blip');
    // the SHORT (4s) transient cold-off never pre-fails a NEW reply: the very next reply asks again
    // (2026-10-01: pre-failing it cut the next reply before it began — "voice completely absent").
    const afterFirst = state.tts;
    t.Voice.speak('second line while still cold', 'agent'); await tick(40);
    A.ok(state.tts > afterFirst, 'keyless + edge blip: a transient cool-off never silences the next reply before it asks');
  }
  // ...while a station that genuinely holds no credential AND no floor still gets the honest terminal copy.
  {
    const state = { tts: 0 };
    const t = boot({ fetch: countingFetch(state, 'no key') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line with no key and no floor', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'bare no-key: NOT retried — a missing credential will not fix itself');
    A.ok(/needs an OpenRouter, Gemini, or OpenAI credential/.test(String(t.nodes['voice-toggle'].title || '')),
      'bare no-key: the tooltip names the missing credential');
    t.Voice.speak('a second line while cold', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'bare no-key: the 60s cold-off holds');
  }
  // A per-minute rate limit is not an empty wallet. Gemini answers a 429 with "Quota exceeded for quota
  // metric", which the old /quota/ test read as 'credits' → "out of credits" + 60s of silence.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'gemini 429 — {"message":"Quota exceeded for quota metric"}') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line during a rate limit', 'agent'); await until(() => state.tts >= 3 && !t.Voice.isReplyPending(), 5000);   // retries are spaced (RETRY_GAP_MS)
    A.ok(!/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'a per-minute 429 is NOT reported as "out of credits"');
    A.eq(state.tts, 3, 'a per-minute 429 is retried twice');
  }
  // ...but OpenAI's terminal insufficient_quota (also a 429) must stay in the billing class.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'openai 429 — {"code":"insufficient_quota"}') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line with a spent account', 'agent'); await until(() => !t.Voice.isReplyPending(), 5000);
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'insufficient_quota IS the billing class, 429 or not');
  }

  // sweep/voice 2026-10-20: the two questions were asked of the WHOLE ladder string, so (a) the HTTP 429 OpenAI
  // sends with insufficient_quota bought two retries and only the 4s cold-off for an empty wallet, and (b) Gemini's
  // standard per-minute 429 text ("...check your plan and billing details... Please retry in 23s") read 'billing'
  // and pinned "voice provider out of credits" on a rate limit. Each ';'-joined leg is judged on its own now.
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'openai 429 — {"error":{"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line with an empty openai wallet', 'agent'); await until(() => !t.Voice.isReplyPending(), 5000);
    A.eq(state.tts, 1, 'insufficient_quota at HTTP 429 is NOT retried — an empty wallet will not refill in 1.6s');
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'and it still reads out of credits');
    t.Voice.speak('the next reply while the wallet is empty', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'insufficient_quota arms the long cold-off — the next reply does not re-ask');
  }
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'gemini 429 — {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10 Please retry in 23s.","status":"RESOURCE_EXHAUSTED"}}; edge: edge timeout') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line during a gemini rate limit', 'agent'); await until(() => state.tts >= 3 && !t.Voice.isReplyPending(), 5000);
    A.eq(state.tts, 3, 'a Gemini per-minute 429 is retried (it clears in seconds)');
    A.ok(!/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'a rate-limit body that merely MENTIONS billing is not "out of credits"');
  }
  {
    const state = { tts: 0 };
    const t = boot({ ttsKey: true, fetch: countingFetch(state, 'openai 400 — {"error":{"message":"Billing hard limit has been reached","code":"billing_hard_limit_reached"}}') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line past the billing hard limit', 'agent'); await until(() => !t.Voice.isReplyPending(), 5000);
    A.eq(state.tts, 1, 'a billing leg with no rate-limit signal stays terminal (not retried)');
  }

  // --- a failure the desk cannot classify is TERMINAL and NAMED, never retried as a blip --------------------------
  // 2026-10-26: Microsoft began refusing the Edge token with HTTP 403. 'edge: edge upgrade refused: HTTP 403' matched no
  // class, and an unclassified reason was treated as transient: every keyless station retried a permanent refusal
  // twice per sentence, re-asked every reply after a 4s cold-off, and the tooltip said only "unreachable".
  {
    const state = { tts: 0 };
    const t = boot({ fetch: countingFetch(state, 'edge: edge upgrade refused: HTTP 403') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line the free floor refuses', 'agent'); await until(() => !t.Voice.isReplyPending(), 5000);
    A.eq(state.tts, 1, 'unclassified failure: NOT retried as a blip (one request)');
    A.ok(/real voice failed — edge: edge upgrade refused: HTTP 403/.test(String(t.nodes['voice-toggle'].title || '')),
      'unclassified failure: the tooltip NAMES it: ' + t.nodes['voice-toggle'].title);
    t.Voice.speak('the next reply while the refusal stands', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'unclassified failure: the long cold-off holds — the next reply does not re-ask');
  }
  // a crashed /api/tts handler answers {fallback:true, reason:'tts failure: …'} (ttsFailOpenPolicy) — terminal and named
  {
    const state = { tts: 0 };
    const t = boot({ fetch: countingFetch(state, 'tts failure: Cannot read properties of undefined (reading \'voice\')') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line when the handler throws', 'agent'); await until(() => !t.Voice.isReplyPending(), 5000);
    A.eq(state.tts, 1, 'handler crash: not retried');
    A.ok(/real voice failed — tts failure: Cannot read properties/.test(String(t.nodes['voice-toggle'].title || '')),
      'handler crash: the tooltip carries the crash reason: ' + t.nodes['voice-toggle'].title);
  }
  // a stale-token 403 (rejectBadApiToken's plain 'forbidden token') is read through Harness.classifyApiFailure, which
  // consults Harness.sessionStale: "reload this page", never retried, and the cold-off lifts once the page reconnects
  {
    const state = { tts: 0 };
    let stale = true;
    const fetch403 = (url) => {
      if (String(url).indexOf('/api/tts') >= 0) {
        state.tts++;
        return Promise.resolve({ ok: false, status: 403, headers: { get: () => 'text/plain' }, json: () => Promise.reject(new SyntaxError('Unexpected token f')) });
      }
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ fetch: fetch403, harness: { sessionStale: () => stale } });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line from a page with an old token', 'agent'); await until(() => !t.Voice.isReplyPending(), 5000);
    A.eq(state.tts, 1, 'stale-token 403: not retried (a reload, not a retry, is the way back)');
    A.ok(/the station restarted; reload this page/.test(String(t.nodes['voice-toggle'].title || '')),
      'stale-token 403: the tooltip says the station restarted and to reload: ' + t.nodes['voice-toggle'].title);
    t.Voice.speak('still stale', 'agent'); await tick(40);
    A.eq(state.tts, 1, 'stale-token 403: while the session is stale, the next reply does not re-ask');
    stale = false;   // the page's recovery adopted the new key on some other call
    t.Voice.speak('reconnected now', 'agent'); await tick(40);
    A.eq(state.tts, 2, 'stale-token 403: once Harness.sessionStale() clears, the next reply asks again');
  }

  // --- the pinned degrade reason survives Voice.init (agent focus / persona / dossier apply) -----
  // init() calls reflectToggle() without clearing fbNotified, and reflectToggle wrote the plain on/off copy
  // over the pinned reason. noteFallback then early-returns for the rest of the outage class, so the station
  // sat silent asserting 'agent voice: ON' with no way to find out why — the 2026-07-07 escape exactly.
  {
    const t = boot({ ttsKey: true, audio: true, fetch: ttsFailFetch('openrouter 402 — insufficient credits') });
    t.Voice.setSpeakReplies(true);
    t.Voice.speak('a line that cannot be spoken', 'agent'); await tick(40);
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'the degrade reason is pinned on the toggle');
    t.Voice.init({ name: 'Tester', personaId: 'professional' });      // app.js does this on agent focus
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'Voice.init does NOT wipe the pinned reason');
    t.Voice.speak('another line, still failing', 'agent'); await tick(40);
    A.ok(/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'and it is still there after further failures');
    // a deliberate speaker toggle still clears it (no latch) — that path calls clearNeuralCold() first
    t.Voice.setSpeakReplies(false); t.Voice.setSpeakReplies(true);
    A.ok(!/out of credits/.test(String(t.nodes['voice-toggle'].title || '')), 'a deliberate speaker toggle still clears the reason (no latch)');
  }

  // --- /api/stt: an UNREACHABLE endpoint is not a CONFIRMED-EMPTY transcript --------------------
  // transcribe() never checked r.ok. rejectBadApiToken answers 403 with plain text BEFORE routing (the
  // documented state after a sidecar respawn), so r.json() threw, the catch yielded {}, and the user's
  // spoken sentence was laundered into '' with NO diagnostic — identical to having said nothing.
  {
    const sttFail = (url) => (String(url).indexOf('/api/stt') >= 0)
      ? Promise.resolve({ ok: false, status: 403, headers: { get: () => 'text/plain' }, json: () => Promise.reject(new SyntaxError('Unexpected token f')) })
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}), blob: () => Promise.resolve({ size: 1 }) });
    const t = boot({ recorder: true, fetch: sttFail });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });   // some audio got recorded
    t.Voice.stopListening();
    await until(() => /restarted|reload/i.test(String(t.nodes['chat-status'].textContent || '')), 5000);
    A.eq(t.sandbox.__sent.length, 0, 'stt 403: nothing is sent (there is no transcript)');
    A.ok(t.statusLog.some(s => /restarted|reload/i.test(String(s))), 'stt 403: the failure is NAMED, not silently dropped');
    A.ok(/restarted|reload/i.test(String(t.nodes['chat-status'].textContent || '')),
      'stt 403: and the diagnostic SURVIVES endListening\'s same-tick restore (it is actually painted)');
  }
  // a page the station KEPT its key from (Harness.tokenWithheld) gets the same 403, but it is not a restart: a reload
  // only re-runs the same ownership check, so the STT failure points at the station notice instead (threads-backend-05)
  {
    const sttFail = (url) => (String(url).indexOf('/api/stt') >= 0)
      ? Promise.resolve({ ok: false, status: 403, headers: { get: () => 'text/plain' }, json: () => Promise.reject(new SyntaxError('Unexpected token f')) })
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}), blob: () => Promise.resolve({ size: 1 }) });
    const t = boot({ recorder: true, fetch: sttFail, harness: { tokenWithheld: () => 'other-user' } });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening();
    await until(() => t.statusLog.some(s => /not verified|restarted/i.test(String(s))), 5000);
    A.eq(t.sandbox.__sent.length, 0, 'stt 403 on a withheld page: nothing is sent');
    A.ok(t.statusLog.some(s => /not verified as your own account/.test(String(s)) && /station notice/.test(String(s))),
      'stt 403 on a withheld page: names the ownership check and the notice: ' + JSON.stringify(t.statusLog));
    A.ok(!t.statusLog.some(s => /restarted/i.test(String(s))), 'stt 403 on a withheld page: never says the station restarted');
  }
  // the documented 200-degrade envelope keeps working, and its reason is painted too
  {
    const sttDegrade = (url) => (String(url).indexOf('/api/stt') >= 0)
      ? Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: '', reason: 'groq: whisper-large-v3-turbo 500' }) })
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({}), blob: () => Promise.resolve({ size: 1 }) });
    const t = boot({ recorder: true, fetch: sttDegrade });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening();
    await until(() => /whisper-large-v3-turbo 500/.test(String(t.nodes['chat-status'].textContent || '')), 5000);
    A.ok(/whisper-large-v3-turbo 500/.test(String(t.nodes['chat-status'].textContent || '')),
      'stt degrade: the reason is the status the user is left looking at, not a zero-frame flash');
  }
  // a SUCCESSFUL listen is unaffected — no diagnostic, and the transcript is sent
  {
    const t = boot({ recorder: true });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening();
    await until(() => t.sandbox.__sent.length === 1, 5000);
    A.eq(t.sandbox.__sent.length, 1, 'a successful listen still sends the transcript');
    A.ok(!/unreachable|restarted/i.test(String(t.nodes['chat-status'].textContent || '')), 'and leaves no diagnostic behind');
  }
  // --- push-to-talk never hands the RUN provider's key to the OpenRouter STT leg ---------------------------------
  // transcribe() sent Harness.getKey() — the key of whatever provider the page runs on — as X-OpenRouter-Key, and the
  // sidecar used it as a Bearer token on openrouter.ai. The page now sends only its OpenRouter key, named as one.
  for (const c of [
    { name: 'an Anthropic station with no OpenRouter key', keys: { '': 'sk-ant-api03-SECRET', anthropic: 'sk-ant-api03-SECRET' }, want: null },
    { name: 'an OpenAI station that also holds an OpenRouter key', keys: { '': 'sk-proj-SECRET', openai: 'sk-proj-SECRET', openrouter: 'sk-or-v1-GOOD' }, want: 'sk-or-v1-GOOD' }
  ]) {
    const seen = [];
    const sttSpy = (url, o) => {
      if (String(url).indexOf('/api/stt') >= 0) seen.push((o && o.headers) || {});
      return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    };
    const t = boot({ recorder: true, fetch: sttSpy, harness: { getKey: p => c.keys[p || ''] || '' } });
    t.Voice.startListening(); await tick(30);
    mrInstances[mrInstances.length - 1].ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening();
    await until(() => seen.length === 1, 5000);
    const h = seen[0] || {};
    A.eq(seen.length, 1, c.name + ': one /api/stt request');
    if (c.want) {
      A.eq(h['X-OpenRouter-Key'], c.want, c.name + ': only the OpenRouter key rides the request');
      A.eq(h['X-Speech-Key-Provider'], 'openrouter', c.name + ': and it is named as an OpenRouter key');
    } else {
      A.ok(!('X-OpenRouter-Key' in h), c.name + ': no key header at all (got ' + JSON.stringify(h) + ')');
    }
    A.ok(!JSON.stringify(h).includes('SECRET'), c.name + ': the run provider\'s secret is never sent to the STT route');
  }

  // --- muting the speaker MID-REPLY in hands-free must not wedge the mic shut --------------------
  // stopSpeaking() nulls onReplyDone, and after chat.js's onTurnEnd() has already bailed (audio still
  // draining) that callback is the ONLY surviving rearm trigger. Muting mid-reply discarded it, so the mic
  // never re-opened while the mode button still read 'hands-free ON'.
  {
    // A reply is DRAINING for as long as a queued chunk has not resolved, so a /api/tts that never answers
    // holds the exact state the bug needs: onTurnEnd lands, sees talking(), and correctly bails.
    const hangTts = (url) => (String(url).indexOf('/api/tts') >= 0)
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }), blob: () => Promise.resolve({ size: 1 }) });
    const drive = async (mute) => {
      const t = boot({ recorder: true, ttsKey: true, fetch: hangTts });
      t.sandbox.__busy = true;                                   // the agent's turn is running → the loop is parked
      t.Voice.toggleVoiceMode(); await tick(60);
      A.ok(t.Voice.inVoiceMode(), 'hands-free is on');
      A.ok(!t.Voice.isListening(), 'the mic is parked while the agent works');
      t.Voice.speakChunk('The answer is ', 'agent'); await tick(20);   // draining = true; the synth never resolves
      t.Voice.endReply();
      t.sandbox.__busy = false;                                  // run teardown...
      t.Voice.onTurnEnd();                                       // ...and chat.js's rearm trigger fires HERE,
      await tick(200);                                           //    while audio is still draining, so it bails
      A.ok(!t.Voice.isListening(), 'onTurnEnd alone does NOT re-open the mic mid-reply (by design)');
      if (mute) t.Voice.setSpeakReplies(false);                   // the user mutes 🔊 mid-reply
      // The rig time-compresses the 30s hard cap to 20ms, so a re-opened listen closes again almost at once.
      // Poll for the OPEN rather than sampling one instant, or the assertion measures scheduling luck.
      const opened = await opensWithin(t, 4000);
      return { t, opened };
    };
    // Control: with no mute the reply is still draining, so the mic legitimately stays shut — this is what
    // proves the assertion below is measuring the MUTE and not some other rearm path.
    const baseline = await drive(false);
    A.eq(baseline.opened, false, 'control: with the reply still draining the mic NEVER re-opens');
    const muted = await drive(true);
    A.ok(muted.t.Voice.inVoiceMode(), 'still in hands-free after the mute');
    A.eq(muted.opened, true, 'the mic RE-OPENS after muting mid-reply (no wedge)');
  }

  // --- VOICE EFFECT: a clip plays through the chain its ENGINE and the setting call for ------------------
  // The Ultron machine shell (bit-crusher, ring-mod, comb resonators) was tuned for the keyed Algenib recipe
  // and used to wrap EVERY voice — it is what made the built-in voices robotic (2026-10-10). AUTO: built-in
  // engines (Kokoro, the Edge floor) play natural; the keyed recipe keeps its locked shell.
  {
    const node = () => new Proxy({ connect() {}, disconnect() {}, start() {} }, {
      get(target, key) { return key in target ? target[key] : (target[key] = { value: 0 }); }
    });
    class FxAC extends MockAC {
      createGain() { return node(); } createBiquadFilter() { return node(); } createWaveShaper() { return node(); }
      createDelay() { return node(); } createDynamicsCompressor() { return node(); } createOscillator() { return node(); }
      createConvolver() { return node(); } createBuffer(_c, length) { return { getChannelData: () => new Float32Array(length) }; }
      createMediaElementSource() { return node(); }
      resume() { return Promise.resolve(); }
    }
    let served = 'local-kokoro';
    const bodies = [], audios = [];
    class RateAudio extends AutoEndAudio { constructor(src) { super(src); audios.push(this); } }
    const fetch = (url, o) => {
      if (url !== '/api/tts') return Promise.resolve({ ok: true, json: async () => ({}) });
      bodies.push(JSON.parse(o.body));
      const by = served;   // the engine that answers THIS request
      return Promise.resolve({ ok: true, status: 200, blob: async () => ({ size: 64 }),
        headers: { get: n => n.toLowerCase() === 'content-type' ? 'audio/wav' : (n.toLowerCase() === 'x-voice-provider' ? by : '') } });
    };
    const t = boot({ audio: true, Audio: RateAudio, AudioContext: FxAC, fetch });
    t.Voice.setSpeakReplies(true);
    const say = async (text, opts) => {
      const n = bodies.length;
      t.Voice.speakChunk(text, 'agent', opts || {}); t.Voice.endReply();
      await until(() => bodies.length > n && !t.Voice.isReplyPending(), 1000);
      return { chain: t.Voice.playbackChain(), body: bodies[bodies.length - 1], audio: audios[audios.length - 1] };
    };
    A.eq(t.Voice.voiceEffect(), '', 'effect: unset by default (AUTO)');
    t.Voice.setVoiceChoice('am_michael', 'agent');
    A.eq((await say('A built-in voice speaks.')).chain, 'natural', 'AUTO: a Kokoro clip plays NATURAL, never through the machine shell');
    served = 'edge:en-US-GuyNeural';
    A.eq((await say('The mapped Edge floor speaks.')).chain, 'natural', 'AUTO: the built-in Edge floor plays natural too');
    t.Voice.setVoiceChoice('', 'agent');
    served = '';
    A.eq((await say('The keyed station voice speaks.')).chain, 'machine', 'AUTO: the keyed station recipe keeps its locked machine shell');
    A.eq(t.Voice.setVoiceEffect('natural').effect, 'natural', 'effect: a choice is saved');
    A.eq(t.sandbox.localStorage.getItem('starnet.voice.effect.v1'), 'natural', 'effect: the choice persists in app storage');
    A.eq((await say('Natural for every voice now.')).chain, 'natural', 'a chosen effect applies to the keyed voice too');
    t.Voice.setVoiceEffect('comms');
    A.eq((await say('Over the comms channel.')).chain, 'comms', 'COMMS routes through the transmission chain');
    t.Voice.setVoiceEffect('machine'); served = 'local-kokoro'; t.Voice.setVoiceChoice('am_michael', 'agent');
    A.eq((await say('A built-in voice as a machine.')).chain, 'machine', 'MACHINE wraps a built-in voice in the shell when asked');
    t.Voice.setVoiceEffect('');
    A.eq(t.sandbox.localStorage.getItem('starnet.voice.effect.v1'), null, 'effect: AUTO clears the stored choice');

    // pacing: a built-in voice is slowed BY THE ENGINE, never time-stretched in the browser
    const slow = await say('A quiet aside.', { speedMul: 0.88 });
    A.ok(Math.abs(slow.body.speed - 0.88) < 1e-9, 'a built-in voice asks the engine for the slower pace');
    A.eq(slow.audio.playbackRate, 1, 'a Kokoro clip plays at 1x — no browser time-stretch smear');
    t.Voice.setVoiceChoice('', 'agent'); served = '';
    const keyed = await say('A keyed aside.', { speedMul: 0.88 });
    A.eq(keyed.body.speed, 1, 'a keyed voice is not asked for a speed it cannot take');
    A.ok(Math.abs(keyed.audio.playbackRate - 0.88) < 1e-9, 'a keyed clip is still paced on playback');

    // a reply is pinned to one chain: a blip onto the Edge floor mid-reply must not change the effect
    served = '';
    const played = audios.length;
    t.Voice.speakChunk('Keyed first sentence.', 'agent', {});
    await until(() => audios.length > played, 1000);
    A.eq(t.Voice.playbackChain(), 'machine', 'the reply opens on the keyed engine (machine shell)');
    served = 'edge:en-US-ChristopherNeural';
    t.Voice.speakChunk('Floor second sentence.', 'agent', {}); t.Voice.endReply();
    await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(t.Voice.playbackChain(), 'machine', 'one reply keeps one effect across an engine blip');

    // a later sentence whose X-Voice-Provider is unreadable (a cross-origin desktop page sees no unexposed header)
    // still came from the engine this reply pinned: a Kokoro clip is never re-paced as keyed on top of the engine
    t.Voice.setVoiceChoice('am_michael', 'agent'); served = 'local-kokoro';
    const pinnedAt = audios.length;
    t.Voice.speakChunk('Kokoro opens this reply.', 'agent', { speedMul: 0.88 });
    await until(() => audios.length > pinnedAt, 1000);
    served = '';
    t.Voice.speakChunk('This sentence lost its provider header.', 'agent', { speedMul: 0.88 }); t.Voice.endReply();
    await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(bodies[bodies.length - 1].localEngine, 'local-kokoro', 'the later sentence asked the pinned Kokoro engine');
    A.eq(audios.length - pinnedAt, 2, 'both sentences played');
    A.eq(audios[audios.length - 1].playbackRate, 1, 'a header-less clip from pinned Kokoro plays at 1x — the engine already paced it');
    A.eq(t.Voice.playbackChain(), 'natural', 'the Kokoro reply stays on the natural chain');

    // read-aloud prosody: a bulleted line ends a sentence instead of running into the next
    await say('Here is what changed:\n- fixed the voice\n- added tests');
    A.eq(bodies[bodies.length - 1].text, 'Here is what changed: fixed the voice. added tests', 'a line with no punctuation ends a spoken sentence');
  }
  {
    // natural playback whose chain cannot wire plays DRY — never through a harsher chain it did not ask for
    const t = boot({ audio: true, Audio: AutoEndAudio, fetch: (url, o) => Promise.resolve({ ok: true, status: 200, blob: async () => ({ size: 64 }),
      headers: { get: n => n.toLowerCase() === 'content-type' ? 'audio/wav' : 'local-kokoro' } }) });
    t.Voice.setSpeakReplies(true);
    t.Voice.setVoiceChoice('am_michael', 'agent');
    t.Voice.speak('No audio graph here.', 'agent');
    await until(() => !t.Voice.isReplyPending(), 1000);
    A.eq(t.Voice.playbackChain(), 'dry', 'natural falls back to dry playback when WebAudio cannot route');
  }
  {
    const t = boot({recorder:true, ttsKey:true});
    const token = t.Voice.replyToken();
    t.Voice.stopSpeaking();
    t.Voice.speakChunk('A late chunk must stay silent.', 'agent', {replyToken:token});
    A.eq(t.Voice.isReplyPending(), false, 'interrupted reply cannot restart from a late model chunk');
  }
  {
    const pending=[];let cancelled=0;
    const t=boot({desktop:true,fetch:url=>Promise.resolve({ok:true,json:async()=>({available:true,preferred:'local',local:true})})});
    t.sandbox.VoiceStream={open:()=>({failed:false,push(){},cancel(){cancelled++;},finish:()=>new Promise(resolve=>pending.push(resolve))})};
    await tick();t.Voice.startListening();await until(()=>processorInstances.length>0,1000);
    processorInstances[processorInstances.length-1].fire(new Float32Array(2048).fill(.2));
    t.Voice.stopListening();await until(()=>pending.length===1,1000);
    t.Voice.pauseCoordinator();t.Voice.resumeCoordinator();t.Voice.startListening();
    await until(()=>t.Voice.isListening(),1000);
    A.ok(cancelled>0,'pause cancels a stream whose final recognition is still pending');
    pending[0]({text:'old interrupted take'});await tick();
    A.eq(t.sandbox.__sent.length,0,'late recorder result cannot submit into a resumed take');
    A.ok(t.Voice.isListening(),'late recorder result cannot end the resumed listener');
    t.Voice.stopConvo();
  }
  A.report('voice.button.test');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
