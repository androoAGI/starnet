'use strict';
/* node test/voice-live-turns.table.test.js — a Local Live turn cuts only what it should (I4), a refused microphone
   pauses the call (I5), and every leg attaches one hook object (I6).

   Runs the real voice-state.js + voice.js + voice-live.js in the window test/helpers/voice-rig.js fabricates (fakes only
   at fetch, Audio, AudioContext, SpeechRecognition, getUserMedia and localStorage; Chat, Workstreams and Channels are
   plain state there). Every reply is opened through the REAL chat.js speech closure, as send() opens it.

   I4 THE TURN TABLE. The reply's state when the Commander speaks {pending: sent, nothing said yet; audible: a sentence
   queued} x the turn {empty, a follow-up queued behind the run, the answer to its pending ask, 'pause the mic', a spoken
   approval, a chip, an agent switch, a status question, 'stop speaking', 'stop', 'stop, <redirect>', a turn that starts
   a run}. The models leg hears the turn through its real microphone frame (VAD onset, endpoint, the station's
   transcription); the dictation leg through its recognizer, with no VAD. The onset cuts an AUDIBLE reply at once
   (microphone_activity) and keeps the 300 ms rule while output is active. A PENDING reply survives every turn but one
   that starts a run (superseded; the new run's reply, opened inside the send, speaks) and the stop commands (user_stop,
   before the run is stopped). 'stop speaking' cuts only what is audible. No reply is ever dropped in silence.
   I5 A REFUSED MICROPHONE PAUSES. On a Live leg 'not-allowed' pauses the loop: hands-free stays on, the panel reads
   PAUSED with microphoneHelp() in its error row, that help is the tick's last status write, the awaited reply still
   speaks, and RESUME re-arms. The three-errors cap pauses the same way, and voice.js has one way to pause.
   I6 ONE HOOK OBJECT. voice-live.js builds the coordinator hooks in exactly one factory, the models, dictation and
   realtime legs attach it, and its keys cover every hook voice.js emits (coordinatorEvent and onTranscript).
   On 0b8441064 the onset cut every reply (a pending one in silence), a started turn left no superseded event, a refused
   microphone ended the loop through stopConvo with the panel never told, and three different hook literals were
   attached. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { chatReply, liveWindow } = require('./helpers/voice-rig.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(pred, ms) { for (let w = 0; w < ms && !pred(); w += 10) await tick(10); return pred(); }
const FIRST = 'First sentence of the reply.', SECOND = 'Second sentence of the reply.';
const NEXT = ['The new run speaks first.', 'And then it finishes.'];

// a Local Live call on `leg`, open and listening, on a page whose speaker is on
async function call(leg) {
  const env = liveWindow({ leg });
  env.Voice.init({ name: 'Tester' });
  env.Voice.setSpeakReplies(true);
  await tick(20);                       // init's STT provider probe has answered, as on a page already open
  await env.VoiceLive.start(false);
  return env;
}
// what became of a reply: 'spoken' (every sentence), its typed cancel cause (every sentence accounted for: spoken,
// discarded at the cancel, or dropped after it), or the silent drop described
async function fate(env, run, texts = [FIRST, SECOND]) {
  const reply = run.speech;
  const all = () => texts.every(text => env.spoken.indexOf(text) >= 0);
  await until(() => !env.Voice.isReplyPending() && (all() || !!(reply && reply.state === 'cancelled')), 3000);
  const events = env.Voice.speechDiagnostics().filter(e => reply && e.reply === reply.id);
  const cancels = events.filter(e => e.reason === 'reply_cancelled');
  const dropped = events.filter(e => e.reason === 'dropped_after_cancel').length;
  const said = texts.filter(text => env.spoken.indexOf(text) >= 0).length;
  if (all() && !cancels.length) return 'spoken';
  if (cancels.length === 1 && said + (cancels[0].queued || 0) + dropped === texts.length) return cancels[0].cause;
  return 'dropped in silence (said ' + said + '/' + texts.length + ', cancels ' + JSON.stringify(cancels) + ', dropped ' + dropped + ')';
}
const bodyOf = (src, name) => { const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}').exec(src); return m ? m[0] : ''; };

/* ---- I4: [turn, transcript, the chat and station state it meets, the fate of a reply still PENDING] ---- */
const TURNS = [
  ['an empty transcript', '', {}, 'spoken'],
  ['a follow-up queued behind the run', 'and check the moon too', { busy: true }, 'spoken'],
  ["the answer to the run's pending ask", 'use postgres', { busy: true, sendState: 'answered' }, 'spoken'],
  ["'pause the mic'", 'pause the mic', {}, 'spoken'],
  ['a spoken approval', 'approve', { busy: true, pending: { promptId: 'p1', tool: 'fs.write' } }, 'spoken'],
  ['a chip picked by voice', 'postgres', { chips: true }, 'spoken'],
  ['an agent switch', 'switch to nova', { agents: true }, 'spoken'],
  ['a status question', 'what is the status', {}, 'spoken'],
  ["'stop speaking'", 'stop speaking', { busy: true }, 'spoken'],
  ["'stop'", 'stop', { busy: true }, 'user_stop'],
  ["'stop, <redirect>'", 'stop, check the logs instead', { busy: true }, 'user_stop'],
  ['a turn that starts a run', 'what about the weather', { sendState: 'started' }, 'superseded']
];
function stage(env, o) {
  const clicks = [];
  Object.assign(env.w, { busy: !!o.busy, sendState: o.sendState || null, pending: o.pending || null,
    chips: o.chips ? [{ textContent: 'Postgres', disabled: false, click() { clicks.push('Postgres'); } }] : [] });
  if (o.agents) env.node('comms-agent-select').options = [{ value: 'nova', textContent: 'NOVA' }];
  return clicks;
}
// what each turn does besides the reply's fate, checked on both legs
async function sideEffects(env, name, text, o, run, clicks) {
  const id = run.speech ? run.speech.id : null;
  if (text === 'stop' || /^stop, /.test(text)) {
    A.ok(env.w.stops.length === 1 && Array.isArray(env.w.stops[0]) && env.w.stops[0].indexOf(id) < 0,
      name + ': the reply was cancelled BEFORE its run was stopped (its flushed partial text never plays after "Stopped.")');
  }
  if (text === 'stop') A.ok(await until(() => env.spoken.indexOf('Stopped.') >= 0, 1000), name + ': "Stopped." is said');
  if (o.sendState === 'started' || /^stop, /.test(text)) {
    const next = env.w.runs[0];
    A.ok(!!next && !!next.speech && next.speech.state === 'open', name + ": the new run's reply, opened inside the send, is left open");
    if (next) { next.say(NEXT[0]); next.close(NEXT[1]); A.eq(await fate(env, next, NEXT), 'spoken', name + ': the new run speaks'); }
  }
  if (o.chips) A.eq(clicks.join(), 'Postgres', name + ': the real chip button was pressed');
  if (o.agents) A.eq(env.node('comms-agent-select').value, 'nova', name + ': the agent was switched');
}

(async () => {
  // ---- I4, the models leg: the turn is heard through the real microphone frame ----
  for (const state of ['pending', 'audible']) {
    for (const [label, text, o, pendingFate] of TURNS) {
      const name = 'models leg, ' + state + ' reply, onset then ' + label;
      try {
        const env = await call('models');
        const clicks = stage(env, o);
        const run = chatReply(env.Voice);                       // the run is sent: its reply is open
        if (state === 'audible') run.say(FIRST);                // ...and its first sentence is queued
        A.ok(env.w.onset(state === 'audible' ? 8 : 3), name + ': the call heard the onset');
        if (state === 'audible') {
          A.eq(run.speech ? run.speech.state + '/' + run.speech.cause : 'no handle', 'cancelled/microphone_activity', name + ': the onset cut the audible reply at once');
        } else {
          A.eq(run.speech ? run.speech.state : 'no handle', 'open', name + ': the onset left the reply still thinking alone');
          A.ok(env.Voice.speechDiagnostics().some(e => e.reason === 'microphone_activity' && e.replyPending === false && e.onsetMs > 0),
            name + ': the onset is still recorded with its measurements');
        }
        A.ok(await env.w.endTurn(text), name + ': the endpoint closed the turn into the transcription');
        if (state === 'pending') run.say(FIRST);
        run.close(SECOND);
        A.eq(await fate(env, run), state === 'audible' ? 'microphone_activity' : pendingFate, name);
        await sideEffects(env, name, text, o, run, clicks);
        env.VoiceLive.end();
      } catch (e) { A.ok(false, name + ' threw: ' + (e && e.stack || e)); }
    }
  }
  // the 300 ms rule: while output is active, a burst under 300 ms of sound is no onset, and the reply plays on
  for (const voiced of [3, 7]) {
    const name = 'models leg, audible reply, ' + voiced + ' loud frames (' + Math.round(voiced * 2048 / 48) + ' ms)';
    try {
      const env = await call('models');
      const run = chatReply(env.Voice);
      run.say(FIRST);
      A.ok(!env.w.onset(voiced), name + ': under 300 ms is no onset while the agent is audible');
      for (let i = 0; i < 10; i++) env.w.frame(0);
      run.close(SECOND);
      A.eq(await fate(env, run), 'spoken', name + ': the reply plays on');
      A.ok(!env.Voice.speechDiagnostics().some(e => e.reason === 'microphone_activity'), name + ': no stop was asked for');
      env.VoiceLive.end();
    } catch (e) { A.ok(false, name + ' threw: ' + (e && e.stack || e)); }
  }

  // ---- I4, the dictation leg: the same turns through its recognizer (no VAD, so an audible reply meets the turn) ----
  for (const state of ['pending', 'audible']) {
    for (const [label, text, o, pendingFate] of TURNS) {
      const name = 'dictation leg, ' + state + ' reply, then ' + label;
      try {
        const env = await call('dictation');
        const clicks = stage(env, o);
        const run = chatReply(env.Voice);
        if (state === 'audible') run.say(FIRST);
        const mic = env.w.mic();
        A.ok(!!mic && mic.started, name + ': the recognizer is listening');
        mic.final(text);
        await tick(30);
        if (state === 'pending') run.say(FIRST);
        run.close(SECOND);
        // 'stop speaking' cuts only what is audible: a reply still thinking speaks when it arrives
        const expect = state === 'audible' && text === 'stop speaking' ? 'user_stop' : pendingFate;
        A.eq(await fate(env, run), expect, name);
        await sideEffects(env, name, text, o, run, clicks);
        env.VoiceLive.end();
      } catch (e) { A.ok(false, name + ' threw: ' + (e && e.stack || e)); }
    }
  }

  // ---- I5: a refused microphone pauses the call; it never ends it ----
  for (const leg of ['dictation', 'models']) {
    const name = leg + ' leg, a refused microphone' + (leg === 'models' ? ' (a COMMS mic take, routed through the call)' : '');
    try {
      const env = await call(leg);
      const run = chatReply(env.Voice);                         // the Commander is waiting on this run's answer
      if (leg === 'models') env.Voice.startListening();
      const help = env.Voice.microphoneHelp();
      env.w.mic().fail('not-allowed');                          // the error and the recognizer's end, in one tick
      A.eq(env.w.statuses[env.w.statuses.length - 1], help, name + ": how to fix it is the tick's last status write");
      if (leg === 'dictation') A.eq(env.Voice.inVoiceMode(), true, name + ': hands-free stays on (stopConvo is never the exit)');
      A.eq(env.node('lv-state').textContent, 'PAUSED', name + ': the panel reads PAUSED');
      A.ok(!env.node('lv-error').hidden && env.node('lv-error').textContent === help, name + ': the error row says how to fix it');
      const mics = env.w.mics.length;
      await tick(200);                                          // longer than the hands-free re-arm
      A.eq(env.w.mics.length, mics, name + ': nothing re-arms into a refused microphone');
      A.eq(env.w.statuses[env.w.statuses.length - 1], help, name + ': and nothing writes over the reason while the call is paused');
      run.say(FIRST); run.close(SECOND);
      A.eq(await fate(env, run), 'spoken', name + ': the awaited reply still speaks');
      await tick(200);
      A.eq(env.w.mics.length, mics, name + ': the reply ending does not re-arm the paused microphone either');
      env.press('lv-pause');                                    // RESUME MIC
      A.ok(env.node('lv-error').hidden, name + ': RESUME clears the reason');
      if (leg === 'models') env.Voice.startListening();
      A.ok(env.w.mics.length > mics && env.w.mic().started && env.Voice.isListening(), name + ': RESUME re-arms the microphone');
      if (leg === 'models') {
        env.w.mic().fail('not-allowed');                        // refused again, and the call ends holding that pause
        env.VoiceLive.end();
        const before = env.w.mics.length;
        env.Voice.startListening();
        A.ok(env.w.mics.length > before && env.Voice.isListening(), name + ': the call ending lifts its pause (the COMMS mic is never left dead)');
        env.Voice.stopListening();
      } else env.VoiceLive.end();
    } catch (e) { A.ok(false, name + ' threw: ' + (e && e.stack || e)); }
  }
  {
    const name = 'dictation leg, the recognizer fails three times in a row';
    try {
      const env = await call('dictation');
      const run = chatReply(env.Voice);
      for (let i = 0; i < 3; i++) {
        const before = env.w.mics.length;
        env.w.mic().fail('network');
        if (i < 2) await until(() => env.w.mics.length > before && env.w.mic().started, 1000);   // the loop re-arms between errors
      }
      const why = env.w.statuses[env.w.statuses.length - 1];
      A.ok(/^Voice input paused — /.test(why), name + ": the reason is the tick's last status write (" + why + ')');
      A.eq(env.Voice.inVoiceMode(), true, name + ': hands-free stays on');
      A.eq(env.node('lv-state').textContent, 'PAUSED', name + ': the panel reads PAUSED');
      A.eq(env.node('lv-error').textContent, why, name + ': the error row carries the same reason');
      run.say(FIRST); run.close(SECOND);
      A.eq(await fate(env, run), 'spoken', name + ': the awaited reply still speaks');
      env.press('lv-pause');
      A.ok(env.Voice.isListening(), name + ': RESUME re-arms the microphone');
      env.VoiceLive.end();
    } catch (e) { A.ok(false, name + ' threw: ' + (e && e.stack || e)); }
  }
  {
    // one way to pause: the refused microphone and the three-errors cap share pauseMicLoop, the only onFatal
    const voice = read('frontend/app/voice.js');
    A.eq(voice.split("coordinatorEvent('onFatal'").length - 1, 1, 'voice.js tells the Live panel its mic loop stopped from ONE place');
    A.ok(bodyOf(voice, 'pauseMicLoop').indexOf("coordinatorEvent('onFatal'") > 0, 'that place is pauseMicLoop');
    A.ok((voice.match(/\bpauseMicLoop\(/g) || []).length >= 3, 'the refused microphone and the three-errors cap both call pauseMicLoop');
    A.eq((voice.match(/coordinatorPaused = true/g) || []).length, 2, 'only pauseMicLoop and the panel\'s own pauseCoordinator pause the loop');
  }

  // ---- I6: one hook object, attached by every leg, covering every hook voice.js emits ----
  {
    const live = read('frontend/app/voice-live.js'), voice = read('frontend/app/voice.js');
    const emitted = new Set(Array.from(voice.matchAll(/coordinatorEvent\('(on\w+)'/g), m => m[1]));
    if (/\bcoordinator\.onTranscript\b/.test(voice)) emitted.add('onTranscript');
    A.ok(emitted.size >= 10, 'voice.js emits its hooks through coordinatorEvent and onTranscript (' + Array.from(emitted).join(', ') + ')');
    A.eq((live.match(/\bfunction coordinatorHooks\(/g) || []).length, 1, 'voice-live.js builds the coordinator hooks in exactly one factory');
    const attaches = (live.match(/Voice\.(?:attach|start)Coordinator\(/g) || []).length;
    const viaFactory = (live.match(/Voice\.(?:attach|start)Coordinator\(coordinatorHooks\(\)\)/g) || []).length;
    A.ok(attaches >= 3 && viaFactory === attaches, 'every leg attaches the factory\'s object (' + viaFactory + ' of ' + attaches + ' attach calls)');
    for (const fn of ['start', 'startRealtime', 'startDictation']) {
      A.ok(/Voice\.(?:attach|start)Coordinator\(coordinatorHooks\(\)\)/.test(bodyOf(live, fn)), fn + '() attaches the one hook object');
    }
    const keys = {};
    for (const leg of ['models', 'dictation']) {
      try {
        const env = liveWindow({ leg });
        env.Voice.init({ name: 'Tester' });
        await tick(20);
        const attached = [];
        for (const k of ['attachCoordinator', 'startCoordinator']) {
          const real = env.Voice[k];
          env.Voice[k] = hooks => { attached.push(hooks); return real(hooks); };   // observed, not replaced
        }
        await env.VoiceLive.start(false);
        A.eq(attached.length, 1, leg + ' leg: the call attaches one hook object');
        const hooks = attached[0] || {};
        keys[leg] = Object.keys(hooks).sort().join(',');
        for (const hook of emitted) A.ok(typeof hooks[hook] === 'function', leg + ' leg: the hook object handles ' + hook);
        env.VoiceLive.end();
      } catch (e) { A.ok(false, 'I6 ' + leg + ' leg threw: ' + (e && e.stack || e)); }
    }
    A.eq(keys.models, keys.dictation, 'the models and dictation legs attach the identical hook set');
  }
  A.report('voice-live-turns.table');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
