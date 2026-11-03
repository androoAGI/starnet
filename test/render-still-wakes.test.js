/* node test/render-still-wakes.test.js — what starts on the floor from OUTSIDE a frame wakes the STILL tier (world.js).

   Andrew, 2026-10-21 (approved): "draw 30/s while nothing on screen moves, snap back to 60 the instant anything moves".
   A still floor waits up to 33 ms between draws, so state that a callback writes between frames — not a frame, not a U.bus
   event, not a World API call — must wake it (motionWake: the next vsync is drawn), or what it starts lands a still tick
   late. The 10-21 review found these writers silent; this file locks each one on the REAL source:
     1. voice.js: Voice.isSpeaking / isListening flip from audio playback and STT callbacks (the hero's talk track, the
        listening ring at its feet, a voice-held bubble) → World.voiceChanged on every flip (the real voice.js, booted);
     2. world.js: the SHIPPED pallet pop is motion for its 900 ms, and the line plates' answer wakes the floor so the pop
        starts on the next vsync (the real drawShippedPallet / pollLineStats, lifted);
     3. world.js: every other async writer of drawn state (FIRST SHIP, the snapshot reconcile, feed truth, the crate join,
        the step-test lamp, portals, the jukebox, a crate released by the hand-off grace, the awakening's Turn, the link). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const VoiceRig = require('./helpers/voice-rig.js');

const root = path.join(__dirname, '..');
const VOICE = fs.readFileSync(path.join(root, 'frontend/app/voice.js'), 'utf8');
const world = fs.readFileSync(path.join(root, 'frontend/app/world.js'), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const code = strip(world);
const tick = (n = 10) => new Promise(r => setTimeout(r, n));
async function until(pred, ms) { for (let w = 0; w < ms && !pred(); w += 10) await tick(10); return pred(); }

// ---- 1. voice.js: the real module, booted in a fabricated window (the voice.mic-release.test.js approach) ---------------
class MockMR {
  static isTypeSupported() { return true; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; this.state = 'inactive'; }
  start() { this.state = 'recording'; }
  stop() { if (this.state !== 'inactive') { this.state = 'inactive'; setTimeout(() => { this.onstop && this.onstop(); }, 0); } }
}
class MockAC {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, getFloatTimeDomainData(b) { b.fill(0); } }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 0 } }; }
  close() {} resume() {}
}
const players = [];
class HeldAudio {   // play() starts at once (onplay); the test ends it by hand (onended), like a clip finishing
  constructor(src) { this.src = src || ''; this.onplay = this.onended = this.onerror = null; this.volume = 1; this.playbackRate = 1; this.ended = false; players.push(this); }
  play() { queueMicrotask(() => { if (this.onplay) this.onplay(); }); return Promise.resolve(); }
  pause() {} load() {} addEventListener() {} removeEventListener() {}
}
function mkEl(id) {
  const cls = new Set();
  const e = { id, value: '', textContent: '', title: '', innerHTML: '', style: {}, _attrs: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => { (on === undefined ? !cls.has(c) : on) ? cls.add(c) : cls.delete(c); }, contains: c => cls.has(c) },
    setAttribute(k, v) { e._attrs[k] = v; }, getAttribute(k) { return e._attrs[k]; }, addEventListener() {}, onclick: null };
  return e;
}
function bootVoice() {
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => nodes[id] = mkEl(id));
  const st = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); if (t.unref) t.unref(); return t; };
  const wakes = [];
  const sandbox = {
    window: {},
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [{ stop() {} }] }) } },
    location: { search: '?stt=recorder' },
    localStorage: (() => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => m[k] = String(v), removeItem: k => delete m[k] }; })(),
    SpeechRecognition: undefined, MediaRecorder: MockMR, AudioContext: MockAC, Audio: HeldAudio,
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    AbortController,
    Blob: class { constructor(parts, o) { this.size = (parts && parts.length) ? 1 : 0; this.type = (o && o.type) || ''; } },
    fetch: url => String(url).includes('/api/tts')
      ? Promise.resolve({ ok: true, headers: { get: () => 'audio/mpeg' }, blob: async () => ({ size: 128 }) })
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: () => Promise.resolve({ text: 'words' }) }),
    Chat: { isBusy: () => false, status: s => { nodes['chat-status'].textContent = s; }, send() {}, autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => '', configured: () => false },
  };
  sandbox.globalThis = sandbox;
  sandbox.window.AudioContext = MockAC;
  vm.createContext(sandbox);
  const { Voice } = VoiceRig.bootVoice(sandbox);   // the voice scripts in index.html order
  // the floor's wake, recording what the floor would read at that instant
  sandbox.World = { voiceChanged: () => wakes.push({ speaking: Voice.isSpeaking(), listening: Voice.isListening() }) };
  Voice.init({ name: 'Tester' });
  return { Voice, wakes };
}

(async () => {
  {
    const { Voice, wakes } = bootVoice();
    wakes.length = 0;
    Voice.setSpeakReplies(true);
    const reply = Voice.openReply({ owner: 'general' });   // chat.js opens the reply's handle at send
    Voice.speakChunk(reply, 'The relay is green.', 'agent');
    Voice.endReply(reply);
    A.ok(await until(() => Voice.isSpeaking(), 2000), '(the reply starts playing: the audio element fired play)');
    A.ok(wakes.some(w => w.speaking === true), 'voice.js wakes the floor the moment the voice starts (isSpeaking true when World.voiceChanged runs) — the talk track is drawn on the next vsync');
    const n = wakes.length;
    const a = players[players.length - 1];
    a.ended = true; if (a.onended) a.onended();   // the clip finishes
    A.ok(await until(() => !Voice.isSpeaking(), 2000), '(the voice ends)');
    A.ok(wakes.length > n && wakes.slice(n).some(w => w.speaking === false), '...and the moment it stops (the mouth closes, a voice-held bubble may vanish)');
  }
  {
    const { Voice, wakes } = bootVoice();
    wakes.length = 0;
    Voice.startListening();
    A.ok(await until(() => Voice.isListening(), 2000), '(the mic opens on the recorder path)');
    A.ok(wakes.some(w => w.listening === true), 'voice.js wakes the floor when the mic opens (the listening ring at the hero\'s feet)');
    const n = wakes.length;
    Voice.stopListening();
    A.ok(await until(() => !Voice.isListening(), 2000), '(the take ends)');
    A.ok(wakes.length > n && wakes.slice(n).some(w => w.listening === false), '...and when it closes');
  }
  {
    // RATCHET: every flip of `speaking` / `listening` goes through the setter that wakes, and both setters wake first
    const src = strip(VOICE);
    const flips = [...src.matchAll(/(^|[^.\w])(speaking|listening)\s*=\s*(true|false)\s*;/g)].map(m => ({ name: m[2], at: m.index }));
    A.ok(flips.length >= 8, '(found ' + flips.length + ' flips of speaking / listening in voice.js)');
    const loose = flips.filter(f => {
      const after = src.slice(f.at, f.at + 200), setter = f.name === 'speaking' ? 'setSpeaking(' : 'setMicState(';
      return after.indexOf(setter) < 0;
    });
    A.ok(!loose.length, 'every flip of Voice.isSpeaking / isListening is followed by setSpeaking / setMicState' + (loose.length ? ' — loose: ' + loose.map(f => f.name + '@' + f.at).join(', ') : ''));
    A.ok(/function setMicState\(on\) \{\s*wakeFloor\(\);/.test(src) && /function setSpeaking\(on\) \{\s*wakeFloor\(\);/.test(src), '...and both setters wake the floor before anything can return early');
    A.ok(/function wakeFloor\(\) \{ if \(typeof World !== 'undefined' && World && typeof World\.voiceChanged === 'function'\) World\.voiceChanged\(\); \}/.test(src), '...through World.voiceChanged (absent World: a no-op)');
    A.ok(/voiceChanged: \(\) => \{ motionWake\(\); \}/.test(code), 'World.voiceChanged is motionWake (the next vsync is drawn, the wait dropped)');
  }

  // ---- 2. the SHIPPED pallet pop: motion for 900 ms, and the plates' answer wakes the floor ------------------------------
  {
    const body = A.fnBody(code, 'function drawShippedPallet(now)');
    A.ok(!!body, 'world.js carries drawShippedPallet');
    const sb = { routingPlan: { lineOfProp: { ob1: 'L1' } }, geo: { props: [{ id: 'ob1', t: 'outbox', x: 2, y: 2 }] }, lineStats: { known: true, byLine: { L1: { shipped: 1 } } },
      drawPallet: (ob, done, since) => { sb.drawn = { done, since }; }, Map };
    vm.createContext(sb);
    vm.runInContext('const palletSeen = new Map(); var palletPopAt = -1e9;\n' + body + '\nthis.draw = drawShippedPallet; this.popAt = () => palletPopAt;', sb);
    sb.draw(1000);
    A.ok(sb.popAt() === -1e9 && sb.drawn.done === 1, 'the first count a page sees pops nothing (it shipped before this page looked)');
    sb.lineStats = { known: true, byLine: { L1: { shipped: 2 } } };
    sb.draw(5000);
    A.eq(sb.popAt(), 5000, "a risen count stamps the pop on the frame that draws it (palletPopAt — the verdict's clock for it)");
    A.ok(sb.drawn.since === 0, '(drawPallet starts its 900 ms pop on that same frame)');
    sb.draw(5100);
    A.eq(sb.popAt(), 5000, '...and a count that holds re-stamps nothing');
    const fx = A.fnBody(code, 'function fxStillWhy(now)');
    A.ok(/if \(now - palletPopAt < 900\) return 'fx';/.test(fx), 'fxStillWhy keeps the pop at the normal pace for its 900 ms');
    const pal = A.fnBody(code, 'function drawPallet(ob, done, since)');
    A.ok(/const pop = \(i === shown - 1 && since < 900\) \? 1 - since \/ 900 : 0;/.test(pal), '(the pop really is 900 ms: drawPallet)');
  }
  {
    // the real pollLineStats: its answer lands between frames — the new count is on the floor, and the floor is woken
    const body = A.fnBody(code, 'function pollLineStats()');
    let wakes = 0, answer = { ok: true, lines: [{ lineId: 'L1', shipped: 3 }], docks: [] };
    const sb = { LineWatch: { localMidnight: () => 0 }, fetch: async () => ({ ok: true, json: async () => answer }), apiUrl: p => p,
      pollLineJobStreams() {}, shipBaseStale: () => false, refreshShipBase() {}, buildRoutingNags: () => [], lineWatch: () => null,
      motionWake: () => { wakes++; }, Date, lineStats: { known: false, byLine: {}, since: 0 }, routingNags: [] };
    vm.createContext(sb);
    vm.runInContext(body + '\nthis.poll = pollLineStats;', sb);
    sb.poll(); await tick(20);
    A.ok(sb.lineStats.known && sb.lineStats.byLine.L1.shipped === 3 && wakes === 1, 'the line plates\' answer wakes the floor once it is in (the pop and the plates are drawn on the next vsync)');
    sb.fetch = async () => ({ ok: false, json: async () => ({}) });
    sb.poll(); await tick(20);
    A.ok(!sb.lineStats.known && wakes === 2, '...and so does a refusal that takes the plates and pallets away');
    sb.fetch = async () => ({ ok: true, json: async () => null });
    sb.poll(); await tick(20);
    A.eq(wakes, 2, '...while no answer (a network drop) changes nothing and wakes nothing');
  }

  // ---- 3. every other async writer of drawn state wakes the floor (the real source, function by function) ----------------
  {
    const has = (sig, re, label) => { const b = A.fnBody(code, sig); A.ok(!!b && re.test(b), label); };
    has('function noteFirstShip(p)', /firstShipPulse = \{ at: \(typeof performance !== 'undefined'\) \? performance\.now\(\) : fnow, tiles: receipt\.tiles \};[^\n]*\n\s*motionWake\(\);/, 'FIRST SHIP: the pulse set in the count read\'s answer wakes the floor (test/first-ship-receipt drives it)');
    has('function fetchSnapshot()', /reconcileFromSnapshot\(snap\);[^\n]*\n\s*motionWake\(\);/, 'the snapshot reconcile (run clocks, glyphs, queues, lit bodies) wakes the floor');
    has('function pollFeedState()', /if \(changed\) \{ routingNags = buildRoutingNags\(\); motionWake\(\); \}/, 'a feed-truth change (the NO FEED callouts) wakes the floor');
    has('function pollLineJobStreams()', /lineJobStream = m;\s*motionWake\(\);/, 'the crate join (which chute a pending crate stands on) wakes the floor');
    has('function pollStepTest()', /noteStepTest\(j\.session \|\| null\); motionWake\(\);/, 'the step-test session (the PAUSED lamp) wakes the floor');
    has('function pollConnectors()', /reconcileConnectors\(connIds\);\s*motionWake\(\);/, "a connector portal's state wakes the floor");
    has('function pollSpotify()', /PropSprites\.setSpotifyConnected\(!!\(j && j\.connected\)\); motionWake\(\);/, "the jukebox's dead/live state wakes the floor");
    has('function emitProductCrate(aid, spec, dockId)', /convey\.enqueueAt\(t\.x, t\.y, spec\); motionWake\(\);/, 'a product crate enqueued (the hand-off grace timer releases one between frames) rides from the next vsync');
    has('function loadStation(st)', /unsub = station\.onChange\(p => \{[^\n]*motionWake\(\); \}\);/, 'a layout edit (station.onChange — a builder step or an undo after an await) wakes the floor (test/render-still.test.js drives it)');
    has('function awakenTurn()', /agent\.dir = side; motionWake\(\);[\s\S]*setGlance\('south', 700, performance\.now\(\)\); motionWake\(\);[\s\S]*agent\.dir = 'south'; motionWake\(\);/, "each timed beat of the awakening's Turn wakes the floor");
    const open = code.slice(code.indexOf('const open = () => {'), code.indexOf('connOpenFn = open;'));
    A.ok(/source\.onopen = \(\) => \{[^\n]*motionWake\(\); \};/.test(open) && /source\.onerror = \(\) => \{[^\n]*bridgeRecovering = true; motionWake\(\);/.test(open),
      'the channel bridge opening or dropping (LINK DOWN, the dimmed telemetry) wakes the floor');
    A.ok(/if \(typeof U\.bus\.tap === 'function'\) U\.bus\.tap\(motionWake\);/.test(code), '(every harness event on U.bus already does: U.bus.tap)');
  }
  A.report('render still wakes (voice, pallet, async writers)');
})().catch(e => { console.error(e); process.exitCode = 1; });
