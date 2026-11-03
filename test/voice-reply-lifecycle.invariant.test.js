'use strict';
/* node test/voice-reply-lifecycle.invariant.test.js — I3: every spoken reply ends EXACTLY ONCE.

   A reply ends in one terminal state, done or cancelled{cause}, and its heartbeat (endReply's onDone, else the
   hands-free re-arm) fires exactly once on every path: a natural end, a skipped sentence, the rest-of-reply cooldown,
   a playback error, an autoplay refusal (cancelled: playback_blocked), a stall the playback watchdog catches, and each
   cancel scope and cause, before and after endReply. In hands-free the mic re-opens exactly once afterwards: never is
   a wedge (2f7b280c), twice an echo. Chunks add up: sent = spoken + skipped (each with its event) + discarded at the
   cancel (reply_cancelled.queued) + dropped_after_cancel events.

   Boots the real voice-state.js + voice.js in index.html order (test/helpers/voice-rig.js) in a fabricated window:
   fakes only at fetch, Audio, AudioContext, SpeechRecognition, localStorage and Chat. The rows also run on the reply
   contract of 0b8441064 (one global token captured at send, endReply(onDone, opts)), where the cancel rows fail: the
   heartbeat never fired, no cancel was typed, and the chunks vanished. */
const A = require('./_assert.js');
const { bootVoice } = require('./helpers/voice-rig.js');

// ---- the fabricated window -------------------------------------------------------------------------------------
let mics = [];
class MockSR {
  constructor() { this.started = false; mics.push(this); }
  start() { this.started = true; }
  stop() { this.started = false; setTimeout(() => this.onend && this.onend(), 0); }
  abort() { this.started = false; setTimeout(() => this.onend && this.onend(), 0); }
  final(text) {
    if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
    this.started = false; if (this.onend) this.onend();
  }
}
const lastMic = () => mics[mics.length - 1];
let spoken = [], playing = [];
// play() starts the clip (onplay); `ends` decides what the clip does next
function audioClass(ends) {
  return class {
    constructor(src) { this.src = src; this.onplay = this.onended = this.onerror = null; this.volume = 1; this.playbackRate = 1; this.ended = false; }
    play() {
      if (ends === 'blocked') { const e = new Error('autoplay refused'); e.name = 'NotAllowedError'; return Promise.reject(e); }
      setTimeout(() => {
        if (this.onplay) this.onplay();
        playing.push(this.src);
        if (ends === 'ok') setTimeout(() => { this.ended = true; spoken.push(this.src); if (this.onended) this.onended(); }, 0);
        if (ends === 'error') setTimeout(() => { this.error = { code: 3 }; if (this.onerror) this.onerror(); }, 0);
        // 'held': plays until something stops it (or the playback watchdog gives up on it)
      }, 0);
      return Promise.resolve();
    }
    pause() {} load() {} addEventListener() {} removeEventListener() {}
  };
}
const audio = (text) => Promise.resolve({ ok: true, status: 200, headers: { get: k => (/content-type/i.test(k) ? 'audio/mpeg' : '') }, blob: async () => ({ size: 64, text }) });
const unavailable = () => Promise.resolve({ ok: false, status: 503, headers: { get: () => 'application/json' }, json: async () => ({ fallback: true, reason: 'edge: edge timeout' }) });
function rig(o) {
  mics = []; spoken = []; playing = [];
  const el = () => ({ value: '', textContent: '', title: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, setAttribute() {}, getAttribute() {}, addEventListener() {} });
  const nodes = {}; ['chat-input', 'chat-status', 'chat-mic', 'voice-toggle', 'voice-mode'].forEach(id => { nodes[id] = el(); });
  const store = {};
  // the long ceilings are compressed (the 128 s playback watchdog to 200 ms, the retry gaps to 30 ms); the 150 ms re-arm is real
  const st = (fn, ms, ...a) => setTimeout(fn, ms >= 30000 ? 200 : ms >= 300 ? 30 : ms, ...a);
  const sandbox = {
    window: { SpeechRecognition: MockSR, AudioContext: undefined }, navigator: { mediaDevices: undefined }, location: { search: '' },
    document: { getElementById: id => nodes[id] || null, addEventListener() {} },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    SpeechRecognition: MockSR, MediaRecorder: undefined, Audio: audioClass(o.audio || 'ok'),
    requestAnimationFrame: cb => st(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout,
    setTimeout: st, clearTimeout, setInterval, clearInterval, AbortController,
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: blob => blob.text, revokeObjectURL() {} },
    Blob: class { constructor(parts, opts) { this.size = 1; this.type = (opts && opts.type) || ''; } },
    fetch: (url, init) => String(url).includes('/api/tts')
      ? (o.tts || audio)(JSON.parse(init.body).text)
      : Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) }),
    Chat: { isBusy: () => false, status() {}, send() {}, autoGrowInput() {} },
    SFX: { open() {}, click() {}, think() {}, boot() {} },
    Personas: { DEFAULT_ID: 'professional', get: () => ({ ttsVoice: 'Umbriel', ttsSpeed: 1 }) },
    Harness: { getKey: () => '', configured: () => false }
  };
  sandbox.globalThis = sandbox;
  const mods = bootVoice(sandbox);
  mods.Voice.init({ name: 'Tester' });
  return mods;
}
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(pred, ms) { for (let w = 0; w < ms && !pred(); w += 10) await tick(10); return pred(); }

// The reply contract this file drives. Before reply handles (0b8441064) the same sequences ran on one global token
// captured at send, an owner object and endReply(onDone, opts): kept so the rows prove the class RED there.
function contract(Voice) {
  if (Voice.openReply) return {
    handles: true,
    open: owner => Voice.openReply({ owner }),
    chunk: (reply, text) => Voice.speakChunk(reply, text, 'agent'),
    end: (reply, onDone) => Voice.endReply(reply, onDone),
    stop: (scope, cause) => Voice.stopSpeaking(scope, cause),
    cancel: (reply, cause) => Voice.cancelReply(reply, cause)
  };
  return {
    handles: false,
    open: () => { const opts = { replyToken: Voice.replyToken() }; opts.owner = opts; return opts; },
    chunk: (opts, text) => Voice.speakChunk(text, 'agent', opts),
    end: (opts, onDone) => Voice.endReply(onDone, opts),
    stop: (scope, cause) => Voice.stopSpeaking(cause),
    cancel: () => { throw new Error('there is no cancelReply before reply handles'); }
  };
}

/* One row: hands-free on, the Commander's turn sent (the mic closes until the reply ends), then the reply.
   o.chunks are offered before the event, o.late after it; o.closeFirst closes the reply before the event.
   o.event(api, reply, Voice) is the cancel (absent: the reply runs to its own end). o.waitAudible holds the event
   until the first clip plays. Expected: o.state/o.cause, the heartbeat count, the mic opens, and the chunk sum. */
async function row(name, o) {
  try { await runRow(name, o); } catch (e) { A.ok(false, name + ' threw: ' + (e && e.message || e)); }
}
async function runRow(name, o) {
  const { Voice } = rig(o);
  const api = contract(Voice);
  Voice.setSpeakReplies(true);
  Voice.toggleVoiceMode();
  await until(() => lastMic() && lastMic().started, 1000);
  lastMic().final('what is the status');
  const micsBefore = mics.length;
  let beats = 0;
  const onDone = () => { beats++; Voice.onTurnEnd(); };   // the heartbeat, counted; onTurnEnd is the same re-arm the default runs
  const reply = api.open('general');
  const others = o.others ? o.others(api) : [];
  for (const text of o.chunks || []) api.chunk(reply, text);
  if (o.closeFirst) api.end(reply, onDone);
  if (o.waitAudible) await until(() => playing.length > 0, 2000);
  if (o.event) o.event(api, reply, Voice);
  for (const text of o.late || []) api.chunk(reply, text);
  if (!o.closeFirst) api.end(reply, onDone);
  await until(() => !Voice.isReplyPending() && (o.convo === false || mics.length > micsBefore), 4000);
  await tick(300);   // past the 150 ms re-arm: a second open would land here
  const sent = (o.chunks || []).length + (o.late || []).length;
  const events = Voice.speechDiagnostics().filter(e => !api.handles || e.reply === reply.id);
  const cancels = events.filter(e => e.reason === 'reply_cancelled');
  const tally = {
    spoken: spoken.filter(text => (o.chunks || []).concat(o.late || []).indexOf(text) >= 0).length,
    skipped: events.filter(e => e.skipped).length,
    discarded: cancels.reduce((n, e) => n + (e.queued || 0), 0),
    dropped: events.filter(e => e.reason === 'dropped_after_cancel').length
  };
  if (api.handles) {
    A.eq([reply.state, reply.cause], [o.state || 'done', o.cause || ''], name + ': one terminal state' + (o.cause ? ', with its cause' : ''));
    A.eq(Voice.replies().filter(r => r.id === reply.id).length, 0, name + ': an ended reply leaves the live set');
  }
  A.eq(cancels.length, o.cause ? 1 : 0, name + ': ' + (o.cause ? 'exactly one typed reply_cancelled' : 'no cancel'));
  if (o.cause) A.ok(cancels.every(e => e.cause === o.cause), name + ': the cancel names its cause (' + JSON.stringify(cancels) + ')');
  // closed before it ended: the producer's onDone is the heartbeat. Cancelled first: the default heartbeat fired then.
  const closedFirst = o.closeFirst || !o.cause;
  A.eq(beats, closedFirst ? 1 : 0, name + ': the heartbeat fired exactly ' + (closedFirst ? 'once' : 'once, at the cancel (a later endReply adds nothing)'));
  A.eq(mics.length - micsBefore, o.convo === false ? 0 : 1, name + ': the hands-free mic re-opens ' + (o.convo === false ? 'never (the loop ended)' : 'exactly once'));
  A.eq(tally.spoken + tally.skipped + tally.discarded + tally.dropped, sent,
    name + ': sent ' + sent + ' = spoken + skipped + discarded + dropped ' + JSON.stringify(tally));
  if (o.expect) A.eq(Object.assign({}, tally, {}), Object.assign({}, tally, o.expect), name + ': ' + JSON.stringify(o.expect));
  if (o.after) o.after(Voice, others);
  Voice.stopConvo();
}

(async () => {
  const two = ['First sentence of the reply.', 'Second sentence of the reply.'];
  // ---- a reply that runs to its own end ----
  await row('natural end', { chunks: two, closeFirst: true, expect: { spoken: 2 } });
  await row('a skipped sentence', { chunks: ['A bad sentence nobody can voice.', 'A good sentence after it.'], closeFirst: true,
    tts: text => (/bad/.test(text) ? unavailable() : audio(text)), expect: { spoken: 1, skipped: 1 } });
  await row('the rest-of-reply cooldown', { chunks: ['Dead one.', 'Dead two.', 'Dead three.'], closeFirst: true, tts: unavailable, expect: { spoken: 0, skipped: 3 } });
  await row('a playback error', { chunks: ['A clip the element cannot play.'], closeFirst: true, audio: 'error', expect: { spoken: 0, skipped: 1 } });
  await row('a stalled output (the playback watchdog)', { chunks: ['A clip that never ends.'], closeFirst: true, audio: 'held', expect: { spoken: 0, skipped: 1 } });
  await row('autoplay refused', { chunks: two, closeFirst: true, audio: 'blocked', late: ['A sentence after the refusal.'],
    state: 'cancelled', cause: 'playback_blocked', expect: { spoken: 0, discarded: 2, dropped: 1 } });

  // ---- every cancel: a reply still thinking (pending), and one speaking (audible), before and after endReply ----
  const cancels = [
    ['stopSpeaking all/user_stop', (api) => api.stop('all', 'user_stop'), 'user_stop', 'all'],
    ['the mic button (audible/microphone_button)', (api) => api.stop('audible', 'microphone_button'), 'microphone_button', 'audible'],
    ['a listen over speech (audible/listen_start)', (api) => api.stop('audible', 'listen_start'), 'listen_start', 'audible'],
    ['the speaker muted (setSpeakReplies)', (api, reply, Voice) => Voice.setSpeakReplies(false), 'speaker_off', 'all'],
    ['cancelReply superseded', (api, reply) => api.cancel(reply, 'superseded'), 'superseded', 'all'],
    ['hands-free off (stopConvo)', (api, reply, Voice) => Voice.stopConvo(), 'handsfree_off', 'all', false]
  ];
  for (const [label, event, cause, scope, convo] of cancels) {
    // pending: the reply was opened at send and has no chunk yet; the 'audible' scope leaves it to speak
    const survives = scope === 'audible';
    await row(label + ', pending', { event, late: two, convo, state: survives ? 'done' : 'cancelled', cause: survives ? '' : cause,
      expect: survives ? { spoken: 2 } : { spoken: 0, discarded: 0, dropped: 2 } });
    // audible: the first clip is on the speaker, the second queued behind it
    for (const closeFirst of [false, true]) {
      await row(label + ', audible, ' + (closeFirst ? 'after' : 'before') + ' endReply', { chunks: two, closeFirst, waitAudible: true, audio: 'held', event, convo,
        late: closeFirst ? [] : ['A late sentence from the run.'], state: 'cancelled', cause,
        expect: { spoken: 0, discarded: 2, dropped: closeFirst ? 0 : 1 } });
    }
  }

  // ---- two replies: cutting what is audible never takes the reply still thinking with it ----
  await row('two replies: the audible one is cut, the pending one still speaks', {
    chunks: two, closeFirst: true, waitAudible: true, audio: 'held', state: 'cancelled', cause: 'microphone_button',
    others: api => [api.open('general')],
    event: api => api.stop('audible', 'microphone_button'),
    expect: { spoken: 0, discarded: 2, dropped: 0 },
    after: (Voice, [next]) => {
      const api = contract(Voice);
      api.chunk(next, 'The next reply, still speaking.');
      if (api.handles) A.eq(next.state, 'open', 'two replies: the pending reply was not cancelled by the audible scope');
      A.ok(playing.indexOf('The next reply, still speaking.') >= 0 || Voice.isReplyPending(), 'two replies: the pending reply is queued to speak');
    }
  });

  // ---- the vocabulary: every cause is typed exactly once, and an unknown cause is never recorded as itself ----
  const { Voice, VoiceState } = rig({});
  A.ok(VoiceState && Array.isArray(VoiceState.CANCEL_CAUSES), 'voice-state.js loads before voice.js and carries CANCEL_CAUSES');
  if (VoiceState && Voice.openReply) {
    Voice.setSpeakReplies(true);
    for (const cause of VoiceState.CANCEL_CAUSES) {
      let beats = 0;
      const reply = Voice.openReply({ owner: 'general' });
      Voice.endReply(Voice.openReply({ owner: 'other' }));   // a bystander that ends on its own
      A.eq(Voice.cancelReply(reply, cause), true, cause + ': cancelReply ends an open reply');
      A.eq(Voice.cancelReply(reply, 'user_stop'), false, cause + ': a second cancel is refused (one terminal state)');
      Voice.endReply(reply, () => { beats++; });
      A.eq([reply.state, reply.cause, beats], ['cancelled', cause, 0], cause + ': cancelled once, with its cause; a later endReply adds no heartbeat');
    }
    const odd = Voice.openReply({ owner: 'general' });
    Voice.cancelReply(odd, 'because');
    A.eq(odd.cause, 'user_stop', 'a cause outside CANCEL_CAUSES is recorded as user_stop, never as itself');
    A.eq(Voice.speechDiagnostics().filter(e => e.reason === 'reply_cancelled').every(e => VoiceState.CANCEL_CAUSES.indexOf(e.cause) >= 0), true,
      'every reply_cancelled names a cause in CANCEL_CAUSES');
    A.ok(Object.isFrozen(odd) && (() => { try { odd.state = 'open'; } catch (_) {} return odd.state === 'cancelled'; })(), 'a handle is read-only');
  }
  A.report('voice-reply-lifecycle.invariant');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
