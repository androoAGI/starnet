/* node test/voice.draftguard.test.js — behavioral guard for COMPOSER DRAFT PROTECTION vs dictation.

   Andrew's "random text deletion" bug (2026-07-19): with the mic live, voice.js treated the composer
   as dictation's own surface — onInterim REPLACED the entire box with each interim transcript, and
   submitTranscript CLEARED it unconditionally on every finalize (even an empty/noise one). In
   hands-free mode the listen loop re-arms continuously, so anything the Commander TYPED was erased
   within seconds, over and over, with a chime each cycle.

   The law under test: dictation may only overwrite or clear text IT wrote (dictShown). A typed
   draft is untouchable — while normal dictation into an empty composer keeps its full UX:
   interim preview renders, finalize clears the preview and sends the transcript.

   Boots the real frontend/app/voice.js in a fabricated window (same harness pattern as
   voice.button.test.js) and drives both providers: webSpeech (interims + finals) and the desktop
   recorder (finals via the /api/stt fetch). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootVoice } = require('./helpers/voice-rig.js');

// ---- controllable browser mocks (mirrors voice.button.test.js) -------------------------------
let srInstances = [];
class MockSR {
  constructor() { this.started = false; this.onresult = this.onerror = this.onend = null; srInstances.push(this); }
  start() { if (this.started) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; } this.started = true; }
  stop() { if (this.started) { this.started = false; const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); } }
  abort() { this.started = false; const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); }
  fireInterim(t) { this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: false })] }); }
  fireError(err) { this.started = false; this.onerror && this.onerror({ error: err }); const s = this; setTimeout(() => { s.onend && s.onend(); }, 0); }
  fireFinal(t) { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: t }], { isFinal: true })] }); this.started = false; this.onend && this.onend(); }
  fireEmptyEnd() { this.started = false; this.onend && this.onend(); }   // heard nothing: onend with no results → onFinal('')
}

let mrInstances = [];
function fakeStream() { return { getTracks: () => [{ stop() {} }] }; }
class MockMR {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; this.state = 'inactive'; this.ondataavailable = this.onstop = this.onerror = null; mrInstances.push(this); }
  start() { this.state = 'recording'; }
  stop() { if (this.state !== 'inactive') { this.state = 'inactive'; const s = this; setTimeout(() => { s.onstop && s.onstop(); }, 0); } }
}
class MockAnalyser { constructor() { this.fftSize = 2048; } getFloatTimeDomainData(b) { for (let i = 0; i < b.length; i++) b[i] = 0; } }
class MockAC { constructor() { this.state = 'running'; this.sampleRate = 48000; } createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return new MockAnalyser(); } createGain() { return { connect() {}, gain: { value: 0 } }; } close() {} resume() {} }

function mkEl(id) {
  const cls = new Set();
  const e = {
    id, value: '', textContent: '', title: '', innerHTML: '', style: {}, _attrs: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else { on ? cls.add(c) : cls.delete(c); } }, contains: c => cls.has(c) },
    setAttribute(k, v) { e._attrs[k] = v; }, getAttribute(k) { return e._attrs[k]; }, addEventListener() {}, onclick: null
  };
  return e;
}

// Build a fresh voice.js instance. opts.recorder forces the desktop recorder path; opts.sttText is
// what the stubbed /api STT endpoint transcribes.
function boot(opts) {
  opts = opts || {};
  srInstances = []; mrInstances = [];
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => nodes[id] = mkEl(id));
  const win = {};
  const st = (fn, ms, ...a) => setTimeout(fn, ms >= 1000 ? Math.min(ms, 20) : ms, ...a);
  const sandbox = {
    window: win,
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    navigator: opts.recorder ? { mediaDevices: { getUserMedia: () => Promise.resolve(fakeStream()) } } : { mediaDevices: undefined },
    location: { search: opts.recorder ? '?stt=recorder' : '' },
    localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })(),
    SpeechRecognition: opts.recorder ? undefined : MockSR,
    MediaRecorder: opts.recorder ? MockMR : undefined,
    AudioContext: MockAC,
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    AbortController,
    Blob: class { constructor(parts, o) { this.size = (parts && parts.length) ? 1 : 0; this.type = (o && o.type) || ''; } },
    fetch: () => Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: opts.sttText == null ? '' : opts.sttText }), blob: () => Promise.resolve({ size: 1 }) }),
    Chat: { isBusy: () => false, status: s => { nodes['chat-status'].textContent = s; }, send: t => sandbox.__sent.push(t), autoGrowInput() { sandbox.__grew++; } },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => '', configured: () => false },
    __sent: [], __grew: 0
  };
  sandbox.globalThis = sandbox; win.SpeechRecognition = MockSR;
  vm.createContext(sandbox);
  const { Voice } = bootVoice(sandbox);   // the voice scripts in index.html order
  Voice.init({ name: 'Tester' });
  return { Voice, nodes, sandbox, input: nodes['chat-input'], sent: () => sandbox.__sent };
}

const tick = (n = 12) => new Promise(r => setTimeout(r, n));
const lastSR = () => srInstances[srInstances.length - 1];

(async () => {
  // --- webSpeech: EMPTY composer — the normal dictation UX is fully preserved -------------------
  {
    const t = boot();
    t.Voice.startListening(); await tick();
    lastSR().fireInterim('hello comm');
    A.ok(t.input.value === 'hello comm', 'empty composer: interim preview renders into the box');
    lastSR().fireInterim('hello commander');
    A.ok(t.input.value === 'hello commander', 'empty composer: later interim replaces dictation\'s own preview');
    lastSR().fireFinal('hello commander'); await tick();
    t.Voice.stopListening(); await tick();
    A.ok(t.input.value === '', 'empty composer: finalize clears dictation\'s own preview');
    A.ok(t.sent().length === 1 && t.sent()[0] === 'hello commander', 'empty composer: finalize sends the transcript');
  }

  // --- webSpeech: TYPED DRAFT — interims must never overwrite it --------------------------------
  {
    const t = boot();
    t.input.value = 'my typed draft';                        // the Commander is mid-thought
    t.Voice.startListening(); await tick();
    lastSR().fireInterim('noise words');
    A.ok(t.input.value === 'my typed draft', 'typed draft: interim does NOT overwrite it');
    lastSR().fireFinal('noise words'); await tick();
    t.Voice.stopListening(); await tick();
    A.ok(t.input.value === 'my typed draft', 'typed draft: non-empty finalize does NOT clear it');
    A.ok(t.sent().length === 1 && t.sent()[0] === 'noise words', 'typed draft: the spoken transcript still sends as its own message');
  }

  // --- webSpeech: TYPED DRAFT + EMPTY finalize (the exact reported wipe) ------------------------
  {
    const t = boot();
    t.input.value = 'draft that used to get wiped';
    t.Voice.startListening(); await tick();
    lastSR().fireEmptyEnd(); await tick();                   // browser endpointed, but the two-click take stays open
    t.Voice.stopListening(); await tick();
    A.ok(t.input.value === 'draft that used to get wiped', 'typed draft: an EMPTY finalize leaves it untouched (the reported bug)');
    A.ok(t.sent().length === 0, 'typed draft: an empty finalize sends nothing');
  }

  // --- webSpeech: Commander TYPES OVER the interim preview — their text wins --------------------
  {
    const t = boot();
    t.Voice.startListening(); await tick();
    lastSR().fireInterim('partial dict');
    A.ok(t.input.value === 'partial dict', 'mixing: interim rendered while the box was empty');
    t.input.value = 'partial dict plus my typing';           // the Commander edits/types over the preview
    lastSR().fireInterim('partial dictation grows');
    A.ok(t.input.value === 'partial dict plus my typing', 'mixing: once the Commander typed, interims stop overwriting');
    lastSR().fireFinal('partial dictation grows'); await tick();
    t.Voice.stopListening(); await tick();
    A.ok(t.input.value === 'partial dict plus my typing', 'mixing: finalize leaves the Commander\'s hybrid text alone');
    A.ok(t.sent().length === 1, 'mixing: the transcript still sends');
  }

  // --- webSpeech: a dead listen clears only ITS OWN preview; a fresh listen never inherits ------
  {
    const t = boot();
    t.Voice.startListening(); await tick();
    lastSR().fireInterim('ghost words');
    A.ok(t.input.value === 'ghost words', 'stale listen: preview rendered before the failure');
    lastSR().fireError('network'); await tick();             // listen dies; its onend still delivers onFinal('')
    A.ok(t.input.value === '', 'stale listen: an errored listen clears its OWN preview only (no user text existed)');
    // the Commander now TYPES the exact string dictation once wrote — a fresh listen must still treat
    // it as a draft (proves dictShown resets per listen; stale equality can never grant clearing rights)
    t.input.value = 'ghost words';
    t.Voice.startListening(); await tick();
    lastSR().fireInterim('unrelated');
    A.ok(t.input.value === 'ghost words', 'fresh listen: typed text is protected even when it equals a stale preview string');
    lastSR().fireEmptyEnd(); await tick();
    t.Voice.stopListening(); await tick();
    A.ok(t.input.value === 'ghost words', 'fresh listen: empty finalize cannot clear typed text matching a stale preview');
  }

  // --- recorder (desktop): TYPED DRAFT + empty STT transcript -----------------------------------
  {
    const t = boot({ recorder: true, sttText: '' });
    t.input.value = 'desktop draft';
    t.Voice.startListening(); await tick();
    const mr = mrInstances[mrInstances.length - 1];
    mr.ondataavailable && mr.ondataavailable({ data: { size: 1 } });   // some audio got recorded
    t.Voice.stopListening(); await tick(30);                 // stop → finish → stubbed STT: ''
    A.ok(t.input.value === 'desktop draft', 'recorder: empty transcript finalize leaves the typed draft untouched');
    A.ok(t.sent().length === 0, 'recorder: empty transcript sends nothing');
  }

  // --- recorder (desktop): TYPED DRAFT + real STT transcript ------------------------------------
  {
    const t = boot({ recorder: true, sttText: 'spoken message' });
    t.input.value = 'desktop draft two';
    t.Voice.startListening(); await tick();
    const mr = mrInstances[mrInstances.length - 1];
    mr.ondataavailable && mr.ondataavailable({ data: { size: 1 } });
    t.Voice.stopListening(); await tick(30);
    A.ok(t.input.value === 'desktop draft two', 'recorder: real transcript finalize leaves the typed draft untouched');
    A.ok(t.sent().length === 1 && t.sent()[0] === 'spoken message', 'recorder: real transcript sends as its own message');
  }

  A.report('voice.draftguard.test');
})().catch(e => { console.error(e); process.exit(1); });
