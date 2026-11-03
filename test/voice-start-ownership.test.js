'use strict';
// Deferred transport/permission promises drive the actual page handlers and init/teardown.
// No timer race: an old callback is released only after its owner was explicitly stopped/replaced.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');
const { liveWindow } = require('./helpers/voice-rig.js');
const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
const command = new vm.Script(A.fnBody(chat, '  function voiceCommand(args) {') + '\nthis.voiceCommandForTest = voiceCommand;');
const stopLines = A.fnBody(chat, '  function abort() {').split('\n').filter(line => /^\s*if \(typeof Voice(?:Live)? !== 'undefined'/.test(line));
A.eq(stopLines.length, 2, 'DISCONNECT uses the actual two voice teardown statements');
const disconnect = new vm.Script(stopLines.join('\n'));
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const response = body => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
const ready = () => response({ available: true, asr: 'ready', tts: 'ready', voices: [], voice: '' });
function window(opts) {
  const e = liveWindow(opts);
  e.sandbox.localLine = () => {};
  command.runInContext(e.sandbox);
  e.VoiceLive.init();
  return e;
}
const exits = [
  ['endSession', e => e.Voice.endSession('disconnect')],
  ['DISCONNECT', e => disconnect.runInContext(e.sandbox)],
  ['voice_off', e => e.sandbox.voiceCommandForTest('off')],
  ['session_init', e => e.Voice.init({ name: 'Next agent', resumeCue: false })]
];
function micTransport(e) {
  const requests = [];
  e.sandbox.navigator.mediaDevices.getUserMedia = () => {
    const pending = deferred(), track = { enabled: true, stopped: 0, stop() { this.stopped++; }, getSettings: () => ({}) };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    requests.push({ ...pending, track, stream });
    return pending.promise;
  };
  return requests;
}
async function initialized(opts) {
  const e = window(opts); e.Voice.init({ name: 'Tester', resumeCue: false }); await flush(); return e;
}
function timers(e, delay) {
  const captured = [], original = e.sandbox.setTimeout;
  e.sandbox.setTimeout = (fn, ms, ...args) => {
    if (ms !== delay) return original(fn, ms, ...args);
    const timer = { fn: () => fn(...args) }; captured.push(timer); return timer;
  };
  return captured;
}
function recorderTransport(recorders) {
  return { configure: sandbox => {
    sandbox.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; recorders.push(this); }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; } // native stop/error delivery is explicitly released by each row
    };
  } };
}

(async () => {
  for (const [name, stop] of exits) {
    const e = window(), probes = [], originalFetch = e.sandbox.fetch;
    e.sandbox.fetch = (url, init) => {
      if (String(url) === '/api/stt/status') { const p = deferred(); probes.push(p); return p.promise; }
      return originalFetch(url, init);
    };
    e.Voice.init({ name: 'Tester', resumeCue: false });
    e.press('chat-mic');
    A.eq(e.w.mics.length, 0, name + ': the click is waiting for capability, not listening yet');
    stop(e);
    probes.forEach(p => p.resolve(response({ preferred: 'none' })));
    await flush();
    A.eq(e.w.mics.length, 0, name + ': resolving an old capability probe never opens a mic');
    A.eq(e.Voice.isListening(), false, name + ': teardown remains stopped');
    e.VoiceLive.end();
  }
  for (const cancelClick of [false, true]) {
    const e = window(), p = deferred(), fetch = e.sandbox.fetch;
    e.sandbox.fetch = (url, init) => String(url) === '/api/stt/status' ? p.promise : fetch(url, init);
    e.Voice.init({ name: 'Tester', resumeCue: false }); e.press('chat-mic');
    if (cancelClick) e.press('chat-mic');
    p.resolve(response({ preferred: 'none' })); await flush();
    A.eq(e.w.mics.length, cancelClick ? 0 : 1, 'queued capability click: ' + (cancelClick ? 'second click cancels' : 'unchanged intent starts once'));
    e.VoiceLive.end();
  }
  // A new init owns a new capability probe. The old probe must neither consume the
  // new click nor select its provider while the new status is still unavailable.
  {
    const e = window(), probes = [], fetch = e.sandbox.fetch;
    e.sandbox.fetch = (url, init) => {
      if (String(url) === '/api/stt/status') { const p = deferred(); probes.push(p); return p.promise; }
      return fetch(url, init);
    };
    e.Voice.init({ name: 'First', resumeCue: false }); e.press('chat-mic');
    e.Voice.init({ name: 'Second', resumeCue: false }); e.press('chat-mic');
    probes[0].resolve(response({ preferred: 'none' })); await flush();
    A.eq(e.w.mics.length, 0, 'an obsolete capability result cannot start the new queued click early');
    probes[1].resolve(response({ preferred: 'none' })); await flush();
    A.eq(e.w.mics.length, 1, 'the current capability result opens exactly the current click');
    e.VoiceLive.end();
  }
  for (const phase of ['models', 'native']) for (const [name, stop] of [
    ['end', e => e.press('lv-close')],
    ['DISCONNECT', e => disconnect.runInContext(e.sandbox)],
    ['voice_off', e => e.sandbox.voiceCommandForTest('off')]
  ]) {
    const e = await initialized(), p = deferred(), fetch = e.sandbox.fetch, requests = micTransport(e);
    e.sandbox.fetch = (url, init) => {
      if (String(url) === '/api/local-voice/status') return phase === 'models' ? p.promise : Promise.resolve(response({ available: false }));
      if (String(url) === '/api/stt/native/status') return p.promise;
      return fetch(url, init);
    };
    const starting = e.press('voice-live'); await flush();
    stop(e); p.resolve(phase === 'models' ? ready() : response({ available: true }));
    // A vulnerable old models start waits on the forbidden permission request;
    // settle that transport so the control can report all intended failures.
    await flush(); requests.forEach(r => r.resolve(r.stream)); await starting; await flush();
    A.eq(requests.length, 0, phase + '/' + name + ': stopped readiness intent never acquires a microphone');
    A.eq(e.w.mics.length, 0, phase + '/' + name + ': stopped readiness intent never starts dictation');
    A.eq(e.VoiceLive.isActive(), false, phase + '/' + name + ': old readiness cannot activate a call');
    A.eq(e.Voice.speakerState().leases, [], phase + '/' + name + ': old readiness cannot reacquire a speaker lease');
    e.VoiceLive.end();
  }
  // Both success and failure of an old permission request belong only to that
  // request; neither may close the newer call or give back its speaker lease.
  for (const oldFails of [false, true]) {
    const e = await initialized(), requests = micTransport(e);
    const old = e.press('voice-live'); await flush();
    A.eq(requests.length, 1, 'first call reached its actual permission boundary');
    e.VoiceLive.end();
    const current = e.press('voice-live'); await flush();
    A.eq(requests.length, 2, 'new call owns a separate permission request');
    requests[1].resolve(requests[1].stream); await current;
    A.eq(e.VoiceLive.isActive(), true, 'new call becomes active before the old permission completes');
    if (oldFails) requests[0].reject(Object.assign(new Error('Old microphone denied'), { name: 'NotAllowedError' }));
    else requests[0].resolve(requests[0].stream);
    await old; await flush();
    const label = oldFails ? 'old permission rejection' : 'old permission success';
    A.eq(e.VoiceLive.isActive(), true, label + ': the newer call remains active');
    A.eq(requests[1].track.stopped, 0, label + ': the newer microphone remains owned');
    A.eq(e.Voice.speakerState().leases, ['live'], label + ': the newer speaker lease survives');
    A.ok(!String(e.node('lv-error').textContent).includes('Old microphone'), label + ': stale error cannot overwrite the new panel');
    if (!oldFails) A.eq(requests[0].track.stopped, 1, 'late successful old permission releases only its own tracks');
    e.VoiceLive.end();
    A.eq(requests[1].track.stopped, 1, 'the current call releases its own microphone at its own end');
  }
  // Positive readiness admission and supersession: releasing an earlier readiness
  // response cannot replace a newer, already active session.
  {
    const e = await initialized(), p = deferred(), fetch = e.sandbox.fetch, requests = micTransport(e);
    let statuses = 0;
    e.sandbox.fetch = (url, init) => String(url) === '/api/local-voice/status' && ++statuses === 1 ? p.promise : fetch(url, init);
    const old = e.press('voice-live'); await flush();
    const current = e.press('voice-live'); await flush();
    A.eq(requests.length, 1, 'new readiness intent can proceed while an older probe is delayed');
    requests[0].resolve(requests[0].stream); await current;
    p.resolve(ready()); await flush();
    requests.slice(1).forEach(r => r.resolve(r.stream)); await old;
    A.eq(requests.length, 1, 'late old readiness does not open a second microphone');
    A.eq(e.VoiceLive.isActive(), true, 'the accepted current call stays active');
    e.VoiceLive.end();
  }
  // AudioContext.resume is another real asynchronous startup boundary. Both the
  // transcription graph and the dictation meter must keep their own resources.
  for (const leg of ['models', 'dictation']) for (const oldFails of [false, true]) {
    const e = await initialized(), requests = micTransport(e), contexts = [];
    e.w.leg = leg;
    const AudioContext = e.sandbox.window.AudioContext;
    e.sandbox.window.AudioContext = class extends AudioContext {
      constructor(...args) { super(...args); this.resumed = deferred(); this.graphs = 0; this.closed = 0; contexts.push(this); }
      resume() { return this.resumed.promise; }
      close() { this.closed++; return Promise.resolve(); }
      createMediaStreamSource(input) { this.graphs++; this.input = input; return super.createMediaStreamSource(input); }
    };
    const old = e.press('voice-live'); await flush();
    A.eq(requests.length, 1, leg + ': original mic/tap permission requested');
    requests[0].resolve(requests[0].stream); await flush();
    A.eq(contexts.length, 1, leg + ': original audio resume is pending');
    e.press('lv-close');
    const current = e.press('voice-live'); await flush();
    A.eq(requests.length, 2, leg + ': replacement mic/tap permission requested');
    requests[1].resolve(requests[1].stream); await flush();
    A.eq(contexts.length, 2, leg + ': replacement audio context is distinct');
    contexts[1].resumed.resolve(); await current; await flush();
    A.eq(contexts[1].graphs, 1, leg + ': replacement owns one complete graph');
    if (oldFails) contexts[0].resumed.reject(new Error('Old audio context refused'));
    else contexts[0].resumed.resolve();
    await old; await flush();
    const label = leg + (oldFails ? '/old resume rejected' : '/old resume resolved');
    A.eq(contexts[0].graphs, 0, label + ': a retired context never creates a graph');
    A.eq(contexts[1].graphs, 1, label + ': old callback cannot create a second graph on the newer context');
    A.eq(contexts[1].closed, 0, label + ': old callback cannot close the newer context');
    A.eq(requests[1].track.stopped, 0, label + ': old callback cannot stop the newer microphone');
    A.eq(e.VoiceLive.isActive(), true, label + ': newer call remains active');
    A.ok(e.Voice.speakerState().leases.includes('live'), label + ': newer call keeps its speaker lease');
    e.press('lv-close');
    A.eq(contexts[1].closed, 1, label + ': its own end closes the current context once');
    A.eq(requests[1].track.stopped, 1, label + ': its own end releases the current microphone once');
  }
  for (const [name, stop] of exits.concat([['unchanged', () => {}]])) {
    const e = await initialized(), delayed = timers(e, 150);
    e.Voice.setSpeakReplies(true); e.Voice.speak('A spoken answer to interrupt.');
    e.press('chat-mic');
    A.eq(delayed.length, 1, name + ': actual barge-in handler schedules its original 150ms callback');
    stop(e);
    delayed[0].fn(); await flush();
    A.eq(e.w.mics.length, name === 'unchanged' ? 1 : 0, name + ': only the still-owned barge-in intent opens a microphone');
    e.VoiceLive.end();
  }
  // Reconnect owns both its scheduled start and its rejected permission result.
  {
    const e = await initialized(), requests = micTransport(e), delayed = timers(e, 600);
    const first = e.press('voice-live'); await flush(); requests[0].resolve(requests[0].stream); await first;
    requests[0].track.onended();
    A.eq(delayed.length, 1, 'actual microphone-ended callback schedules reconnect');
    const retry = delayed[0].fn(); await flush();
    A.eq(requests.length, 2, 'reconnect reached its own permission await');
    e.press('lv-close');
    const next = e.press('voice-live'); await flush(); requests[2].resolve(requests[2].stream); await next;
    requests[1].reject(new Error('Old reconnect microphone denied')); await retry; await flush();
    A.eq(requests[2].track.stopped, 0, 'old reconnect rejection cannot stop the newer microphone');
    A.eq(delayed.length, 1, 'old reconnect rejection cannot schedule work for a newer call');
    A.eq(e.VoiceLive.isActive(), true, 'new call stays active after old reconnect refusal');
    e.press('lv-close');
    delayed[0].fn(); await flush();
    A.eq(requests.length, 3, 'a retired reconnect callback cannot reopen after teardown');
  }
  // The real visibility handler also resumes a context asynchronously.
  {
    const contexts = [];
    const e = await initialized({ configure: sandbox => {
      const AC = sandbox.window.AudioContext;
      sandbox.window.AudioContext = class extends AC {
        constructor(...args) { super(...args); this.pending = []; contexts.push(this); }
        resume() { const p = deferred(); this.pending.push(p); return p.promise; }
      };
    } });
    const requests = micTransport(e), delayed = timers(e, 600);
    const first = e.press('voice-live'); await flush(); requests[0].resolve(requests[0].stream); await flush();
    contexts[0].pending[0].resolve(); await first;
    contexts[0].state = 'suspended'; e.sandbox.document.hidden = false;
    e.w.listeners.visibilitychange.forEach(fn => fn());
    A.eq(contexts[0].pending.length, 2, 'actual visible-page handler waits on the current suspended context');
    e.press('lv-close');
    const next = e.press('voice-live'); await flush(); requests[1].resolve(requests[1].stream); await flush();
    contexts[1].pending[0].resolve(); await next;
    contexts[0].pending[1].reject(new Error('Old visibility resume failed')); await flush();
    A.eq(requests[1].track.stopped, 0, 'old visibility rejection cannot close the newer microphone');
    A.eq(delayed.length, 0, 'old visibility rejection cannot start a reconnect for the newer call');
    e.press('lv-close');
  }
  // Models Live does not increment the classic recorder's take sequence. Its old
  // permission rejection must additionally honor that the classic take was aborted.
  {
    const recorders = [], e = await initialized(recorderTransport(recorders)), requests = micTransport(e);
    e.press('chat-mic'); await flush();
    A.eq(requests.length, 1, 'classic recorder permission is pending');
    e.Voice.endSession('disconnect');
    const next = e.press('voice-live'); await flush(); requests[1].resolve(requests[1].stream); await next;
    requests[0].reject(Object.assign(new Error('Retired classic permission denied'), { name: 'NotAllowedError' })); await flush();
    A.eq(requests[1].track.enabled, true, 'retired classic denial cannot pause the models microphone');
    A.ok(!e.node('lv-state').textContent.includes('PAUSED'), 'retired classic denial cannot replace the newer call state');
    e.press('lv-close');
  }
  // Native recorder callbacks arrive after stop(); they still belong to the old
  // take even if a second take has already replaced every shared recorder field.
  for (const event of ['onstop', 'onerror']) {
    const recorders = [], e = await initialized(recorderTransport(recorders)), requests = micTransport(e);
    e.press('chat-mic'); requests[0].resolve(requests[0].stream); await flush();
    A.eq(recorders.length, 1, event + ': first actual recorder was constructed');
    e.Voice.endSession('disconnect');
    e.press('chat-mic'); requests[1].resolve(requests[1].stream); await flush();
    A.eq(recorders.length, 2, event + ': newer take owns a distinct actual recorder');
    recorders[0][event](); await flush();
    A.eq(requests[1].track.stopped, 0, event + ': old native callback cannot close the newer stream');
    A.eq(e.Voice.isListening(), true, event + ': old native callback cannot settle the newer take');
    e.Voice.endSession('disconnect'); recorders[1].onstop(); await flush();
    A.eq(requests[1].track.stopped, 1, event + ': current teardown releases its own stream once');
  }
  {
    const recorders = [], options = recorderTransport(recorders), configure = options.configure, previews = [];
    options.configure = sandbox => {
      configure(sandbox);
      const fetch = sandbox.fetch;
      sandbox.fetch = (url, init) => {
        if (String(url) === '/api/stt/status') return Promise.resolve(response({ preferred: 'local', local: true }));
        if (String(url) === '/api/local-voice/transcribe') { previews.push(new Float32Array(init.body)); return Promise.resolve(response({ text: '' })); }
        return fetch(url, init);
      };
    };
    const e = await initialized(options), requests = micTransport(e);
    e.press('chat-mic'); requests[0].resolve(requests[0].stream); await flush();
    e.Voice.endSession('disconnect');
    e.press('chat-mic'); requests[1].resolve(requests[1].stream); await flush();
    A.eq(e.w.processors.length, 2, 'both actual recorder takes own a PCM processor');
    e.w.processors[0].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(24000).fill(0.9) } });
    await flush();
    A.eq(previews.length, 0, 'retired PCM callback cannot feed the new capture or buy a preview call');
    e.w.processors[1].onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(24000).fill(0.2) } });
    await flush();
    A.eq(previews.length, 1, 'the current PCM callback still reaches the actual preview transport');
    A.ok(previews[0] && previews[0].length === 8000 && previews[0].every(sample => Math.abs(sample - 0.2) < 0.00001), 'current preview contains only current microphone samples');
    e.Voice.endSession('disconnect'); recorders[1].onstop();
  }
  A.report('voice-start-ownership');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
