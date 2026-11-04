/* node test/voice.mic-release.test.js — the microphone is released, and the Windows preview is paced
   (memory lane 2026-10-20, "eats my PC's resources").

   1. voice.js: getUserMedia races a 12 s ceiling so a dismissed permission prompt cannot wedge the mic button. A prompt
      answered AFTER that ceiling still opened the microphone, and nothing ever stopped the stream: the mic stayed live
      until a reload. The late grant is now released the moment it lands.
   2. voice-live.js: the dictation meter tap has the same race and the same leak (its real function, extracted).
   3. voice.js: the live preview re-transcribes the WHOLE take so far (Windows: a fresh PowerShell + System.Speech per
      call). Restarted the moment the previous one ended, previews ran back to back for the whole take — O(T^2) work.
      The next preview now waits at least as long as the last one took.

   Boots the real frontend/app/voice.js in a fabricated window (the voice.button.test.js approach). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootVoice } = require('./helpers/voice-rig.js');
const LIVE_SRC = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'voice-live.js'), 'utf8');

const tick = (n = 10) => new Promise(r => setTimeout(r, n));
async function until(pred, ms) { for (let w = 0; w < ms && !pred(); w += 10) await tick(10); return pred(); }

let gumPending = [], processors = [];
class MockMR {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() { if (this.state !== 'inactive') { this.state = 'inactive'; setTimeout(() => { this.onstop && this.onstop(); }, 0); } }
}
class MockProcessor {
  constructor() { this.onaudioprocess = null; processors.push(this); }
  connect() {} disconnect() {}
  fire(samples) { if (this.onaudioprocess) this.onaudioprocess({ inputBuffer: { getChannelData: () => samples } }); }
}
class MockAC {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0); } }; }
  createScriptProcessor() { return new MockProcessor(); }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 0 } }; }
  close() {} resume() {}
}
function mkEl(id) {
  const cls = new Set();
  const e = { id, value: '', textContent: '', title: '', innerHTML: '', style: {}, _attrs: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
    setAttribute(k, v) { e._attrs[k] = v; }, getAttribute(k) { return e._attrs[k]; }, addEventListener() {}, onclick: null };
  return e;
}
// gum: 'hang' queues the request (resolve it later by hand) or a function returning a stream.
function boot(opts) {
  gumPending = []; processors = [];
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => nodes[id] = mkEl(id));
  // Only the 12 s permission ceiling is compressed; every other timer is real (and unref'd so the test can exit).
  const st = (fn, ms, ...a) => { const t = setTimeout(fn, ms === 12000 ? (opts.gumCeilingMs || 12000) : ms, ...a); if (t.unref) t.unref(); return t; };
  const sandbox = {
    window: {},
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: () => new Promise((res, rej) => {
      if (opts.gum === 'hang') gumPending.push({ res, rej }); else res({ getTracks: () => [{ stop() {} }] });
    }) } },
    location: { search: opts.recorder ? '?stt=recorder' : '' },
    localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })(),
    SpeechRecognition: undefined, MediaRecorder: MockMR, AudioContext: MockAC, Audio: undefined,
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    AbortController,
    Blob: class { constructor(parts, o) { this.size = (parts && parts.length) ? 1 : 0; this.type = (o && o.type) || ''; } },
    fetch: opts.fetch || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({ text: 'words' }) })),
    Chat: { isBusy: () => false, status: s => { nodes['chat-status'].textContent = s; }, send: t => sandbox.__sent.push(t), autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => '', configured: () => false },
    __sent: []
  };
  sandbox.globalThis = sandbox;
  sandbox.window.AudioContext = MockAC;
  vm.createContext(sandbox);
  const { Voice } = bootVoice(sandbox);   // the voice scripts in index.html order
  Voice.init({ name: 'Tester' });
  return { Voice, nodes, sandbox };
}

(async () => {
  // ---- 1. voice.js: a permission granted after the 12 s ceiling never leaves the mic live ----
  {
    const t = boot({ recorder: true, gum: 'hang', gumCeilingMs: 40 });
    t.Voice.startListening();
    await until(() => gumPending.length === 1, 1000);
    await until(() => !t.Voice.isListening(), 1000);
    A.eq(t.Voice.isListening(), false, 'the unanswered prompt times out and the button recovers');
    let stopped = 0;
    gumPending[0].res({ getTracks: () => [{ stop() { stopped++; } }] });   // the Commander answers the prompt late
    await until(() => stopped > 0, 1000);
    A.eq(stopped, 1, 'the late grant is released at once (the stream stayed live until a reload before)');
  }

  // ---- 2. voice-live.js: the meter tap releases a late grant the same way ----
  {
    const m = /(  async function openMeterTap\(seq\) \{[\s\S]*?\n  \})/.exec(LIVE_SRC);
    A.ok(!!m, 'voice-live.js still defines openMeterTap as an extractable function');
    const pending = [];
    const nav = { mediaDevices: { getUserMedia: () => new Promise(res => pending.push(res)) } };
    const fast = (fn, ms) => setTimeout(fn, ms === 12000 ? 30 : ms);
    // eslint-disable-next-line no-new-func
    const openMeterTap = new Function('navigator', 'setTimeout', 'console', m[1] + '\nreturn openMeterTap;')(nav, fast, { warn() {}, log() {} });
    await openMeterTap(1);   // returns once the prompt ceiling passes
    A.eq(pending.length, 1, 'the tap asked for the microphone once');
    let stopped = 0;
    pending[0]({ getTracks: () => [{ stop() { stopped++; } }] });
    await until(() => stopped > 0, 1000);
    A.eq(stopped, 1, 'a meter-tap grant that lands after the ceiling is released');
  }

  // ---- 3. voice.js: the Windows preview waits at least as long as its last run took ----
  {
    const COST = 600;   // > half the 650 ms preview interval, so back-to-back scheduling is visible
    const runs = [];
    const fetch = (url) => {
      if (url === '/api/stt/status') return Promise.resolve({ ok: true, json: async () => ({ available: true, preferred: 'native', native: true }) });
      if (url === '/api/stt/native') {
        const run = { start: Date.now(), end: 0 };
        runs.push(run);
        return new Promise(r => { const tm = setTimeout(() => { run.end = Date.now(); r({ ok: true, json: async () => ({ ok: true, text: 'still talking' }) }); }, COST); if (tm.unref) tm.unref(); });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    const t = boot({ fetch });
    await tick(30);
    t.Voice.startListening();
    await until(() => processors.length > 0, 1000);
    const proc = processors[processors.length - 1];
    const speech = new Float32Array(2048).fill(0.18);
    const feed = setInterval(() => proc.fire(speech), 20);
    await tick(3200);
    clearInterval(feed);
    await until(() => runs.every(r => r.end), 2000);
    A.ok(runs.length >= 2, 'the preview still runs during a long take (' + runs.length + ' runs)');
    A.eq(t.nodes['chat-input'].value, 'still talking', 'and still shows the interim words');
    const gaps = runs.slice(1).map((r, i) => r.start - runs[i].end);
    const costs = runs.slice(0, -1).map(r => r.end - r.start);
    A.ok(gaps.every((g, i) => g >= costs[i] - 25), 'each preview waits at least as long as the previous one took (gaps ' + gaps.join(',') + ' ms after runs of ' + costs.join(',') + ' ms)');
    // duty cycle from the first preview's start to the last one's start: at most about half, however long the take
    const busy = costs.reduce((n, c) => n + c, 0) / (runs[runs.length - 1].start - runs[0].start);
    A.ok(busy <= 0.55, 'preview work is at most about half the wall time (' + Math.round(100 * busy) + '% busy)');
    t.Voice.stopConvo();
  }

  A.report('voice.mic-release.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
