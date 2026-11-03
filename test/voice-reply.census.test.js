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
   The Live-turn rows run the call's own turn path through liveWindow's real microphone frame (VAD onset, endpoint,
   transcription) and recognizer: every handleTranscript outcome and a refused microphone. The speaker-lease rows follow. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { chatReply, liveWindow } = require('./helpers/voice-rig.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

// ---- the real chat.js speech closure: the reply is opened at send, exactly as send() does it ----
const FIRST = 'First sentence of the reply.', SECOND = 'Second sentence of the reply.';
function send(env) {
  const run = chatReply(env.Voice);
  return { speech: run.speech, stream() { run.say(FIRST); run.close(SECOND); } };
}
// ---- the fabricated window (test/helpers/voice-rig.js liveWindow): fakes only at the transport edge ----
const rig = leg => liveWindow({ leg });
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));
async function until(pred, ms) { for (let w = 0; w < ms && !pred(); w += 10) await tick(10); return pred(); }

/* ---- THE ROWS: [Voice or VoiceLive key, label, entry run between the send and the first chunk, expected outcome].
   'spoken', or the CANCEL_CAUSES cause the reply must be cancelled with. `before` runs ahead of the send. ---- */
const hooks = { onState() {}, onTranscript: () => false };
const V = (key, label, run, expect, before) => ({ mod: 'Voice', key, label, run, expect, before });
const L = (key, label, run, expect, before) => ({ mod: 'VoiceLive', key, label, run, expect, before });
const startCall = env => env.VoiceLive.start(false);
const T = (label, run, expect) => ({ mod: 'live', key: 'models leg', label, run, expect, before: startCall });
const D = (label, run, expect) => ({ mod: 'live', key: 'dictation leg', label, run, expect, before: startCall, leg: 'dictation' });
// one spoken turn on the models leg, with the chat and station state it meets
const turn = (text, o) => async e => {
  o = o || {};
  Object.assign(e.w, { busy: !!o.busy, sendState: o.sendState || null, pending: o.pending || null, chips: o.chips || [] });
  if (o.agents) e.node('comms-agent-select').options = o.agents;
  A.ok(e.w.onset(), 'live turn "' + text + '": the call heard the onset');
  A.ok(await e.w.endTurn(text), 'live turn "' + text + '": the endpoint closed the turn into the transcription');
};
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
  V('stopSpeaking', "audible/microphone_activity (the Live onset's call)", e => e.Voice.stopSpeaking('audible', 'microphone_activity', { rms: 0.1 }), 'spoken'),
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
  // the Live panel's own buttons, reachable mid-call (internal entries: not export keys). The meter cuts only what is
  // audible, so a reply still thinking is left to speak
  { mod: 'panel', key: 'lv-barge', label: 'the meter pressed to cut in', run: e => e.press('lv-barge'), expect: 'spoken', before: startCall },
  { mod: 'panel', key: 'lv-pause', label: 'PAUSE MIC', run: e => e.press('lv-pause'), expect: 'spoken', before: startCall },
  { mod: 'panel', key: 'lv-close', label: 'the panel closed', run: e => e.press('lv-close'), expect: 'call_end', before: startCall },
  // the call's own turn path (internal entries): the models leg hears the Commander through its real microphone frame
  // (VAD onset, endpoint, the station's transcription), the dictation leg through its recognizer
  T('the Commander starts speaking (VAD onset)', e => A.ok(e.w.onset(), 'VAD onset: the call heard it'), 'spoken'),
  T('onset, then an empty transcript', turn(''), 'spoken'),
  T('onset, then a follow-up queued behind the run', turn('and check the moon too', { busy: true }), 'spoken'),
  T("onset, then the answer to the run's pending ask", turn('use postgres', { busy: true, sendState: 'answered' }), 'spoken'),
  T('onset, then a turn that starts a run', turn('what about the weather', { sendState: 'started' }), 'superseded'),
  T("onset, then 'stop'", turn('stop', { busy: true }), 'user_stop'),
  T("onset, then 'stop, <redirect>'", turn('stop, check the logs instead', { busy: true }), 'user_stop'),
  T("onset, then 'stop speaking'", turn('stop speaking', { busy: true }), 'spoken'),
  T("onset, then 'pause the mic'", turn('pause the mic'), 'spoken'),
  T('onset, then a spoken approval', turn('approve', { busy: true, pending: { promptId: 'p1', tool: 'fs.write' } }), 'spoken'),
  T('onset, then a chip picked by voice', turn('postgres', { chips: [{ textContent: 'Postgres', disabled: false, click() {} }] }), 'spoken'),
  T('onset, then an agent switch', turn('switch to nova', { agents: [{ value: 'nova', textContent: 'NOVA' }] }), 'spoken'),
  T('onset, then a status question', turn('what is the status'), 'spoken'),
  T("onset, then 'end the call'", turn('end the call'), 'call_end'),
  T('a COMMS mic take refused mid-call', e => { e.Voice.startListening(); e.w.mic().fail('not-allowed'); }, 'spoken'),
  D('the microphone is refused (not-allowed)', e => e.w.mic().fail('not-allowed'), 'spoken'),
  D('the recognizer fails three times in a row', async e => {
    for (let i = 0; i < 3; i++) {
      const before = e.w.mics.length;
      e.w.mic().fail('network');
      if (i < 2) await until(() => e.w.mics.length > before && e.w.mic().started, 1000);   // the loop re-arms between errors
    }
  }, 'spoken')
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
      const env = rig(row.leg);
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
