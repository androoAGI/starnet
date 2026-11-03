'use strict';
/* node test/voice-reply.census.test.js — I1: nothing between a send and its first chunk drops the reply in silence.

   THE SWEEP. Boots the real voice-state.js, voice.js and voice-live.js in frontend/index.html order
   (test/helpers/voice-rig.js) and opens each reply through the REAL chat.js speech closure (sliced from
   'const SPEAK_MARKER' to its 'try {'), with fakes only at fetch, Audio, AudioContext, SpeechRecognition,
   getUserMedia, localStorage and Chat. Every row runs ONE entry point between the send and the first chunk, then the
   run streams two sentences and closes. Pass: the reply is spoken, or it carries exactly one reply_cancelled whose
   cause is in CANCEL_CAUSES plus one dropped_after_cancel for each later chunk. Never a silent drop. Each row also
   states which of the two it expects.
   THE CENSUS. Every key of Voice and of VoiceLive has a row (a new export without one fails, so does a stale row); no
   replyToken is left anywhere in frontend/app; every production speakChunk/endReply passes a reply handle; every
   stopSpeaking/cancelReply/endSession call names its scope and a CANCEL_CAUSES cause; both HTML entries load
   voice-state.js before voice.js.
   Extended by the Live-turn rows (VAD onset, transcript outcomes, a denied mic) and the speaker-lease rows. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bootVoice } = require('./helpers/voice-rig.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

// ---- the real chat.js speech closure: the reply is opened at send, exactly as send() does it ----
const CHAT = read('frontend/app/chat.js');
const SPEECH_FROM = CHAT.indexOf('    const SPEAK_MARKER');
const SPEECH_TO = CHAT.indexOf('\n    try {', SPEECH_FROM);
A.ok(SPEECH_FROM > 0 && SPEECH_TO > SPEECH_FROM, 'chat.js still carries the speech closure from SPEAK_MARKER to its try {');
const SPEECH = new vm.Script(CHAT.slice(SPEECH_FROM, SPEECH_TO) +
  '\nthis.__speech = typeof speech === "undefined" ? null : speech; this.__push = pushSpeech; this.__close = closeSpeech;', { filename: 'chat.js speech closure' });
const FIRST = 'First sentence of the reply.', SECOND = 'Second sentence of the reply.';
function send(env) {
  const ctx = vm.createContext({ ws: { id: 'ws-a', agentId: 'agent' }, willSpeak: true, speechOwner: () => true, acc: '', spokenIdx: 0,
    name: 'agent', Voice: env.Voice, Date, setTimeout, clearTimeout });
  SPEECH.runInContext(ctx);
  return {
    speech: ctx.__speech,
    stream() { ctx.acc = FIRST + ' '; ctx.__push(false); ctx.acc += SECOND; ctx.__push(true, ctx.acc); ctx.__close(); }
  };
}

// ---- the fabricated window: fakes only at the transport edge ----
function node() {
  return { textContent: '', value: '', title: '', innerHTML: '', hidden: false, disabled: false, dataset: {}, children: [], options: [],
    style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute() {}, addEventListener() {}, appendChild() {}, querySelector: () => node(), dispatchEvent() {} };
}
class MockSR { constructor() { this.started = false; } start() { this.started = true; } stop() { this.started = false; } abort() { this.started = false; } }
class MockAC {
  constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; }
  resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { return { connect() {}, disconnect() {}, onaudioprocess: null }; }
  createGain() { return { connect() {}, disconnect() {}, gain: { value: 0 } }; }
}
function rig() {
  const nodes = new Map(), store = {}, spoken = [];
  // every id resolves, except the Live panel until voice-live.js builds it (so its real buttons get their handlers)
  const $ = id => { if (id === 'live-voice-panel' && !nodes.has(id)) return null; if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  class AutoEndAudio {   // a clip that plays to its end
    constructor(src) { this.src = src; this.onplay = this.onended = this.onerror = null; this.volume = 1; this.playbackRate = 1; this.ended = false; }
    play() { setTimeout(() => { if (this.onplay) this.onplay(); setTimeout(() => { this.ended = true; spoken.push(this.src); if (this.onended) this.onended(); }, 0); }, 0); return Promise.resolve(); }
    pause() {} load() {} addEventListener() {} removeEventListener() {}
  }
  const json = body => Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
  const track = { enabled: true, onended: null, stop() {}, getSettings: () => ({}) };
  const sandbox = {
    window: { SpeechRecognition: MockSR, AudioContext: MockAC, addEventListener() {} },
    document: { getElementById: $, addEventListener() {}, createElement: () => node(), body: { appendChild: el => { if (el && el.id) nodes.set(el.id, el); } }, querySelectorAll: () => [] },
    navigator: { platform: 'Win32', userAgent: 'test', mediaDevices: { addEventListener() {},
      getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } },
    location: { search: '' },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    SpeechRecognition: MockSR, MediaRecorder: undefined, AudioContext: MockAC, Audio: AutoEndAudio,
    performance: { now: () => Date.now() }, Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, AbortController, queueMicrotask,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: blob => blob.text, revokeObjectURL() {} },
    Blob: class { constructor(parts, opts) { this.size = 1; this.type = (opts && opts.type) || ''; } },
    fetch: (url, init) => {
      if (String(url).includes('/api/tts')) {
        const text = JSON.parse(init.body).text;
        return Promise.resolve({ ok: true, status: 200, headers: { get: k => (/content-type/i.test(k) ? 'audio/mpeg' : '') }, blob: async () => ({ size: 64, text }) });
      }
      if (String(url).includes('/api/local-voice/status')) return json({ available: true, asr: 'ready', tts: 'ready', voices: [], voice: '' });
      return json({});
    },
    Chat: { isBusy: () => false, status() {}, send() {}, autoGrowInput() {}, stopActive() {}, sendOrQueue: () => ({ state: 'started' }) },
    Workstreams: { activeId: () => 'ws-a', active: () => ({ id: 'ws-a', agentId: 'agent', title: 'General' }), get: id => ({ id, agentId: 'agent', title: id }),
      list: () => [{ id: 'ws-a', agentId: 'agent', title: 'General' }], switch: id => ({ id }) },
    Channels: { isBusy: () => false, statusOf: () => '', pendingOf: () => null, pendingAllOf: () => [] },
    SFX: { open() {}, click() {}, think() {}, boot() {}, press() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => '', getProv: () => 'openrouter', getModel: () => 'model', configured: () => false }
  };
  sandbox.globalThis = sandbox;
  const env = bootVoice(sandbox, { through: 'voice-live.js' });
  env.spoken = spoken;
  env.press = id => $(id).onclick();   // a real Live panel button, through the handler voice-live.js wired to it
  return env;
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(pred, ms) { for (let w = 0; w < ms && !pred(); w += 10) await tick(10); return pred(); }

/* ---- THE ROWS: [Voice or VoiceLive key, label, entry run between the send and the first chunk, expected outcome].
   'spoken', or the CANCEL_CAUSES cause the reply must be cancelled with. `before` runs ahead of the send. ---- */
const hooks = { onState() {}, onTranscript: () => false };
const V = (key, label, run, expect, before) => ({ mod: 'Voice', key, label, run, expect, before });
const L = (key, label, run, expect, before) => ({ mod: 'VoiceLive', key, label, run, expect, before });
const startCall = env => env.VoiceLive.start(false);
const ROWS = [
  V('recordSpeechEvent', '', e => e.Voice.recordSpeechEvent('microphone_settings', {}), 'spoken'),
  V('speechDiagnostics', '', e => e.Voice.speechDiagnostics(), 'spoken'),
  V('isReplyPending', '', e => e.Voice.isReplyPending(), 'spoken'),
  V('openReply', 'another run opens its own reply', e => e.Voice.openReply({ owner: 'ws-b' }), 'spoken'),
  V('cancelReply', 'this reply, superseded', (e, reply) => e.Voice.cancelReply(reply, 'superseded'), 'superseded'),
  V('cancelReply', "another run's reply", e => e.Voice.cancelReply(e.Voice.openReply({ owner: 'ws-b' }), 'superseded'), 'spoken'),
  V('replies', '', e => e.Voice.replies(), 'spoken'),
  V('init', 'another agent takes the voice', e => e.Voice.init({ name: 'Other' }), 'session_init'),
  V('speak', 'a one-shot line first', e => e.Voice.speak('A one-shot line.', 'agent'), 'spoken'),
  V('speakChunk', 'a stray chunk with no reply', e => e.Voice.speakChunk(null, 'A stray chunk.', 'agent'), 'spoken'),
  V('endReply', 'a stray close with no reply', e => e.Voice.endReply(null), 'spoken'),
  V('mutter', '', e => e.Voice.mutter('hmm'), 'spoken'),
  V('ambientLine', '', e => e.Voice.ambientLine(['line']), 'spoken'),
  V('setAgent', '', e => e.Voice.setAgent('Other'), 'spoken'),
  V('setPersona', '', e => e.Voice.setPersona('gremlin', 'Other'), 'spoken'),
  V('isOn', '', e => e.Voice.isOn(), 'spoken'),
  V('setSpeakReplies', 'on', e => e.Voice.setSpeakReplies(true), 'spoken'),
  V('setSpeakReplies', 'off', e => e.Voice.setSpeakReplies(false), 'speaker_off'),
  V('startListening', '', e => e.Voice.startListening(), 'spoken'),
  V('stopListening', 'after a listen', e => { e.Voice.startListening(); e.Voice.stopListening(); }, 'spoken'),
  V('toggleListen', '', e => e.Voice.toggleListen(), 'spoken'),
  V('stopSpeaking', 'no scope (audible): a reply still thinking is not cut', e => e.Voice.stopSpeaking(), 'spoken'),
  V('stopSpeaking', 'audible/microphone_button', e => e.Voice.stopSpeaking('audible', 'microphone_button'), 'spoken'),
  V('stopSpeaking', 'all/user_stop', e => e.Voice.stopSpeaking('all', 'user_stop'), 'user_stop'),
  V('stopSpeaking', 'all/microphone_activity (the onset)', e => e.Voice.stopSpeaking('all', 'microphone_activity', { rms: 0.1 }), 'microphone_activity'),
  V('toggleVoiceMode', 'hands-free on', e => e.Voice.toggleVoiceMode(), 'spoken'),
  V('toggleVoiceMode', 'hands-free on, then off', e => { e.Voice.toggleVoiceMode(); e.Voice.toggleVoiceMode(); }, 'handsfree_off'),
  V('stopConvo', 'Esc, DISCONNECT, /voice off', e => e.Voice.stopConvo(), 'handsfree_off'),
  V('onTurnEnd', '', e => e.Voice.onTurnEnd(), 'spoken'),
  V('canListen', '', e => e.Voice.canListen(), 'spoken'),
  V('canSpeak', '', e => e.Voice.canSpeak(), 'spoken'),
  V('startCoordinator', '', e => e.Voice.startCoordinator(hooks), 'spoken'),
  V('stopCoordinator', 'with no coordinator', e => e.Voice.stopCoordinator(), 'spoken'),
  V('stopCoordinator', 'ending a dictation loop', e => e.Voice.stopCoordinator(), 'handsfree_off', e => { e.Voice.startCoordinator(hooks); }),
  V('pauseCoordinator', '', e => e.Voice.pauseCoordinator(), 'spoken', e => { e.Voice.startCoordinator(hooks); }),
  V('resumeCoordinator', '', e => { e.Voice.pauseCoordinator(); e.Voice.resumeCoordinator(); }, 'spoken', e => { e.Voice.startCoordinator(hooks); }),
  V('attachCoordinator', '', e => e.Voice.attachCoordinator(hooks), 'spoken'),
  V('detachCoordinator', '', e => e.Voice.detachCoordinator(), 'spoken', e => { e.Voice.attachCoordinator(hooks); }),
  V('canOAuthLive', '', e => e.Voice.canOAuthLive(), 'spoken'),
  V('personaId', '', e => e.Voice.personaId(), 'spoken'),
  V('setLocalTts', '', e => e.Voice.setLocalTts(true), 'spoken'),
  V('voiceChoice', '', e => e.Voice.voiceChoice('agent'), 'spoken'),
  V('localVoiceId', '', e => e.Voice.localVoiceId('agent'), 'spoken'),
  V('setVoiceChoice', '', e => e.Voice.setVoiceChoice('am_onyx', 'agent'), 'spoken'),
  V('voiceLabel', '', e => e.Voice.voiceLabel('am_onyx'), 'spoken'),
  V('rememberVoiceLabels', '', e => e.Voice.rememberVoiceLabels([{ id: 'am_onyx', label: 'ONYX' }]), 'spoken'),
  V('currentAgentId', '', e => e.Voice.currentAgentId(), 'spoken'),
  V('microphoneHelp', '', e => e.Voice.microphoneHelp(), 'spoken'),
  V('voiceEffect', '', e => e.Voice.voiceEffect(), 'spoken'),
  V('setVoiceEffect', '', e => e.Voice.setVoiceEffect('natural'), 'spoken'),
  V('playbackChain', '', e => e.Voice.playbackChain(), 'spoken'),
  V('forceSpeakOn', '', e => e.Voice.forceSpeakOn(), 'spoken'),
  V('restoreSpeak', 'nothing to restore', e => e.Voice.restoreSpeak(), 'spoken'),
  V('sttEngine', '', e => e.Voice.sttEngine(), 'spoken'),
  V('isListening', '', e => e.Voice.isListening(), 'spoken'),
  V('isSpeaking', '', e => e.Voice.isSpeaking(), 'spoken'),
  V('inVoiceMode', '', e => e.Voice.inVoiceMode(), 'spoken'),
  L('init', '', e => e.VoiceLive.init(), 'spoken'),
  L('start', 'Local Live opens on the models leg', e => e.VoiceLive.start(false), 'spoken'),
  L('end', 'the call ends', e => e.VoiceLive.end(), 'call_end'),
  L('isActive', '', e => e.VoiceLive.isActive(), 'spoken'),
  L('statusSnapshot', '', e => e.VoiceLive.statusSnapshot(), 'spoken'),
  L('voices', '', e => e.VoiceLive.voices('agent'), 'spoken'),
  L('setVoice', '', e => e.VoiceLive.setVoice('am_onyx', 'agent'), 'spoken'),
  L('rebind', 'with no call bound', e => e.VoiceLive.rebind('ws-b'), 'spoken'),
  L('rebind', "the call moves off this reply's session", e => e.VoiceLive.rebind('ws-b'), 'session_rebind', startCall),
  L('rebind', 'the call moves to this session', e => e.VoiceLive.rebind('ws-a'), 'spoken', startCall),
  L('boundSessionId', '', e => e.VoiceLive.boundSessionId(), 'spoken'),
  // the Live panel's own buttons, reachable mid-call (internal entries: not export keys)
  { mod: 'panel', key: 'lv-barge', label: 'the meter pressed to cut in', run: e => e.press('lv-barge'), expect: 'microphone_button', before: startCall },
  { mod: 'panel', key: 'lv-pause', label: 'PAUSE MIC', run: e => e.press('lv-pause'), expect: 'spoken', before: startCall },
  { mod: 'panel', key: 'lv-close', label: 'the panel closed', run: e => e.press('lv-close'), expect: 'call_end', before: startCall }
];

(async () => {
  // ---- THE CENSUS ----
  const probe = rig();
  const CAUSES = probe.VoiceState ? probe.VoiceState.CANCEL_CAUSES : [];
  A.ok(CAUSES.length > 0, 'voice-state.js is loaded ahead of voice.js and exports CANCEL_CAUSES');
  for (const [mod, api] of [['Voice', probe.Voice], ['VoiceLive', probe.VoiceLive]]) {
    const keys = Object.keys(api || {}), rowKeys = new Set(ROWS.filter(r => r.mod === mod).map(r => r.key));
    for (const key of keys) A.ok(rowKeys.has(key), mod + '.' + key + ' has a census row (a new export needs one)');
    for (const key of rowKeys) A.ok(keys.indexOf(key) >= 0, mod + '.' + key + ': the row names a real export (no stale row)');
  }
  for (const entry of ['frontend/index.html', 'frontend/agent-station-demo.html']) {
    const html = read(entry), state = html.indexOf('<script src="app/voice-state.js">'), voice = html.indexOf('<script src="app/voice.js">');
    A.ok(state > 0 && voice > state, entry + ' loads app/voice-state.js before app/voice.js');
  }
  const APP = fs.readdirSync(path.join(ROOT, 'frontend', 'app')).filter(f => f.endsWith('.js')).map(f => 'frontend/app/' + f);
  const seen = { handles: 0, stops: 0 };   // the census must find the calls it rules on, or it proves nothing
  for (const file of APP) {
    const raw = read(file), src = strip(raw);
    A.ok(raw.indexOf('replyToken') < 0, file + ': no replyToken (a reply is a handle, never a global token)');
    const handles = new Set(Array.from(src.matchAll(/\bconst (\w+) = [^;\n]*?\b(?:Voice\.)?open(?:Reply)?\(/g), m => m[1]));
    for (const m of src.matchAll(/(?<!function )\b(speakChunk|endReply)\(\s*([^,)\s]*)/g)) {
      const arg = m[2], held = handles.has(arg) || (/\.handle$/.test(arg) && handles.has(arg.slice(0, -'.handle'.length)));
      A.ok(held, file + ': ' + m[1] + '(' + arg + ', ...) passes a reply handle');
      seen.handles++;
    }
    for (const m of src.matchAll(/(?<!function )\bstopSpeaking\(([^)]*)\)/g)) {
      seen.stops++;
      const a = /^\s*'(audible|all)'\s*,\s*'([a-z_]+)'/.exec(m[1]);
      A.ok(!!a && CAUSES.indexOf(a[2]) >= 0, file + ': stopSpeaking(' + m[1].trim().slice(0, 40) + ') names its scope and a CANCEL_CAUSES cause');
    }
    for (const m of src.matchAll(/(?<!function )\bcancelReply\(([^)]*)\)/g)) {
      const a = /^\s*[\w.]+\s*,\s*'([a-z_]+)'\s*$/.exec(m[1]);
      A.ok(!!a && CAUSES.indexOf(a[1]) >= 0, file + ': cancelReply(' + m[1].trim() + ') names a CANCEL_CAUSES cause');
    }
    for (const m of src.matchAll(/(?<!function )\bendSession\(([^)]*)\)/g)) {
      const a = /^\s*'([a-z_]+)'/.exec(m[1]);
      A.ok(!!a && CAUSES.indexOf(a[1]) >= 0, file + ': endSession(' + m[1].trim().slice(0, 40) + ') names a CANCEL_CAUSES cause');
    }
  }
  A.ok(seen.handles >= 8 && seen.stops >= 12, 'the census reads the production speech calls (' + JSON.stringify(seen) + ')');

  // ---- THE SWEEP ----
  for (const row of ROWS) {
    const name = row.mod + '.' + row.key + (row.label ? ' (' + row.label + ')' : '');
    try {
      const env = rig();
      env.Voice.init({ name: 'Tester' });
      env.Voice.setSpeakReplies(true);
      await tick(20);                          // init's STT provider probe has answered, as on a page already open
      if (row.before) await row.before(env);
      const chat = send(env);                  // the run is sent: its reply is open, its first chunk not yet streamed
      await row.run(env, chat.speech);
      chat.stream();                           // two sentences, then the run closes its reply
      const reply = chat.speech;
      const spokenBoth = () => env.spoken.indexOf(FIRST) >= 0 && env.spoken.indexOf(SECOND) >= 0;
      await until(() => !env.Voice.isReplyPending() && (spokenBoth() || (reply && reply.state === 'cancelled')), 3000);
      const events = env.Voice.speechDiagnostics().filter(e => reply && e.reply === reply.id);
      const cancels = events.filter(e => e.reason === 'reply_cancelled');
      const dropped = events.filter(e => e.reason === 'dropped_after_cancel').length;
      // typed: one cancel with a table cause, and both sentences accounted for (spoken, discarded at the cancel, or dropped after it)
      const said = [FIRST, SECOND].filter(text => env.spoken.indexOf(text) >= 0).length;
      const typed = cancels.length === 1 && CAUSES.indexOf(cancels[0].cause) >= 0 && said + (cancels[0].queued || 0) + dropped === 2;
      A.ok(spokenBoth() || typed, name + ': the reply is spoken, or cancelled once with a typed cause and every later chunk accounted for' +
        ' (spoken ' + JSON.stringify(env.spoken) + ', cancels ' + JSON.stringify(cancels) + ', dropped ' + dropped + ')');
      A.eq(row.expect === 'spoken' ? (spokenBoth() ? 'spoken' : 'not spoken') : (cancels[0] && cancels[0].cause) || 'no typed cancel', row.expect, name + ': expected outcome');
      if (env.VoiceLive.isActive()) env.VoiceLive.end();
    } catch (e) {
      A.ok(false, name + ' threw: ' + (e && e.message || e));
    }
  }
  A.report('voice-reply.census');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
