'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(root, 'frontend', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'frontend', 'app', 'voice-live.js'), 'utf8');
const voiceSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'voice.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'frontend', 'css', 'app.css'), 'utf8');

assert.doesNotMatch(index, /id="voice-mode"/, 'legacy hands-free button is removed from COMMS');
assert.equal((index.match(/id="voice-live"/g) || []).length, 1, 'Local Live is the one hands-free control');
assert.match(index, /aria-label="Start Local Live hands-free voice"/, 'the canonical hands-free control has an explicit accessible name');
assert.match(source, /document\.body\.appendChild\(panel\)/, 'live controller is app-global, not mounted inside COMMS');
assert.doesNotMatch(source, /insertBefore\(panel,\s*chatLog\)/, 'live controller must not consume transcript space');
assert.match(source, /button\.onclick\s*=\s*\(\)\s*=>\s*active\s*\?\s*end\(\)\s*:\s*start\(false\)/, 'live button toggles the session off');
assert.match(source, /addEventListener\('pointermove'/, 'floating controller supports pointer dragging');
assert.match(source, /POSITION_KEY/, 'floating position is remembered');
assert.match(source, /seq\s*!==\s*sessionSeq/, 'late microphone permission cannot resurrect a closed session');
assert.match(source, /requestPartial\(utterance,\s*utteranceSeq\)/, 'long turns surface local partial transcription');
assert.match(source, /id="lv-endpoint"[^>]*aria-label="Pause before sending your turn"/, 'Local Live exposes an explicit turn-end pause control');
assert.match(source, /TURN_END_KEY\s*=\s*'starnet\.liveVoice\.turnEndMs\.v1'/, 'the turn-end choice persists across calls');
assert.match(source, /DEFAULT_TURN_END_MS\s*=\s*1200/, 'the default uses the proven quick boundary without returning to a sub-second cutoff');
assert.match(source, /function endpointSilenceMs\(text,\s*baseMs\)/, 'turn endpointing has a dedicated user-adjustable policy');
assert.match(source, /Math\.min\(3600,\s*wait\s*\+\s*600\)/, 'incomplete partial transcripts receive an additional hesitation grace period');
assert.match(source, /partialText\s*=\s*text/, 'semantic pause handling is grounded in the real partial transcript');
assert.match(source, /PRE_ROLL_MS\s*=\s*900/, 'the utterance keeps enough pre-roll to preserve words spoken during calibration');
assert.match(source, /MAX_UTTERANCE_MS\s*=\s*60000/, 'a normal long sentence is not chopped at the former 20-second ceiling');
assert.match(source, /CALIBRATION_FLOOR_CEILING\s*=\s*0\.016/, 'speaking during startup cannot become an unreachably high noise floor');
assert.match(source, /noiseFloor\s*\+\s*\(outputActive\s*\?\s*0\.025\s*:\s*0\.006\)/, 'distant speech uses an additive sensitivity margin instead of multiplying room noise');
assert.doesNotMatch(source, /durationMs\s*>=\s*20000/, 'the former 20-second hard cutoff is removed');
assert.match(source, /scheduleReconnect\(/, 'lost microphones enter the reconnect state machine');
assert.match(source, /approvalCommand\(lower\)/, 'run-scoped approvals can be answered by an explicit voice command');
assert.match(source, /agentCommand\(value,\s*lower\)/, 'voice can select the active Starnet agent without provider coupling');
assert.match(source, /Harness\.getProv/, 'the controller reports the active Starnet provider');
assert.doesNotMatch(source, /CODEX OAUTH/, 'provider-agnostic voice UI does not claim Codex is required');
assert.match(source, /attachCoordinator\(\{\s*onState,\s*onAssistant,\s*onOutputLevel,\s*onTiming[\s\S]*?onSpeechInterrupted[\s\S]*?\}\)/, 'live controller subscribes to real agent output levels');
assert.match(source, /bar\.dataset\.src\s*=\s*cell\.src/, 'wave history preserves which side of the conversation produced each sample');
assert.match(source, /setAttribute\('aria-busy'/, 'working voice states are exposed to assistive technology');
assert.match(source, /Agent speaking — press to interrupt and speak/, 'barge-in control names the active agent-speaking state');
assert.match(source, /Stop Local Live hands-free voice/, 'active Local Live button truthfully advertises its stop action');
assert.match(source, /Voice\.inVoiceMode\(\)[\s\S]*?Voice\.stopConvo\(\)/, 'Local Live closes any legacy hands-free loop before opening');
assert.match(chatSource, /VoiceLive\.start\(false\)/, '/voice live opens the canonical Local Live system');
assert.match(chatSource, /Local Live voice stopped\./, '/voice live toggles the canonical system off');
assert.doesNotMatch(chatSource, /Hands-free voice mode toggled\./, 'slash command no longer activates the legacy hands-free loop');
assert.match(voiceSource, /const endFailed\s*=\s*error\s*=>[\s\S]*?onSpeakEnd\(\)[\s\S]*?onFail/, 'media failures clear speaking and meter state before the queue advances');
assert.match(voiceSource, /currentAudioCleanup/, 'interrupted blob playback has an explicit URL cleanup path');
assert.match(css, /\.live-voice-panel\s*\{[^}]*position:\s*fixed/s, 'controller follows the user across StarNet views');
assert.match(css, /\.lv-head\s*\{[^}]*cursor:\s*grab/s, 'header advertises the drag affordance');
assert.match(css, /\.lv-wave i\[data-src="self"\]/, 'the user side of the shared waveform has an explicit visual contract');
assert.match(css, /\.lv-wave i\[data-src="agent"\]/, 'the agent side of the shared waveform has an explicit visual contract');
assert.match(css, /\[data-state="hearing"\][\s\S]*?\.lv-heard[\s\S]*?display:\s*-webkit-box/, 'recognized words stay visible while the Commander is speaking');
assert.match(css, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.lv-x\s*\{[^}]*pointer-events:\s*auto/, 'touch users always have a reachable close control');

// Exercise the endpoint policy, not only its spelling. The chosen pause is the base truth; a partial that
// visibly trails off gets a bounded extra beat so saying a company name and then spelling it remains one turn.
{
  const m = /(  function endpointSilenceMs\(text, baseMs\) \{[\s\S]*?\n  \})/.exec(source);
  assert.ok(m, 'voice-live.js still defines the endpoint policy as an extractable pure function');
  // eslint-disable-next-line no-new-func
  const endpointSilenceMs = new Function(m[1] + '\nreturn endpointSilenceMs;')();
  assert.equal(endpointSilenceMs('finished thought.', 1200), 1200, 'the quick default closes a complete turn after 1.2 seconds');
  assert.equal(endpointSilenceMs('Acme and', 1200), 1800, 'the quick default preserves normal-length grace for an unfinished thought');
  assert.equal(endpointSilenceMs('finished thought.', 1800), 1800, 'a complete thought honors the selected pause exactly');
  assert.equal(endpointSilenceMs('Acme and', 1800), 2400, 'a trailing continuation word gets another 600ms');
  assert.equal(endpointSilenceMs('still thinking and', 3200), 3600, 'hesitation grace remains bounded at 3.6 seconds');
}

/* ⛔ LIVE VOICE OPENS AUDIBLE ON *BOTH* PATHS. Local Live has two entry points: start() when the bundled
   offline speech engine is available and startDictation() for explicit opt-out or a degraded/custom bundle.
   Wiring the speaker auto-enable into start() alone leaves that fallback room muted, so the Commander can
   talk but never hear an answer. Assert it per-function, not file-wide: a file-wide match would pass while
   one runtime path remained broken. */
function bodyOf(name) {
  const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n  \\}').exec(source);
  assert.ok(m, 'voice-live.js still defines ' + name + '()');
  return m[0];
}
{
  const m = /(  function availabilityFailure\([\s\S]*?\n  \})/.exec(source);
  assert.ok(m, 'voice-live.js still classifies failed availability probes before opening the mic');
  // eslint-disable-next-line no-new-func
  const availabilityFailure = new Function(m[1] + '\nreturn availabilityFailure;')();
  assert.deepEqual(
    availabilityFailure({ ok: false, status: 403 }),
    { probeFailed: true, staleSession: true, status: 403 },
    'an old sidecar token is recognized as a stale page, not allowed into a silent voice session'
  );
  assert.deepEqual(
    availabilityFailure({ ok: false, status: 500 }),
    { probeFailed: true, staleSession: false, status: 500 },
    'other sidecar failures are also refused before the microphone opens'
  );
  assert.equal(availabilityFailure({ ok: true, status: 200 }), null, 'a healthy probe proceeds normally');
}
{
  const startBody = bodyOf('start');
  assert.match(startBody, /readiness\.probeFailed[\s\S]*?reload this page to reconnect voice/, 'stale pages receive an actionable reload message');
  assert.ok(
    startBody.indexOf('readiness.probeFailed') < startBody.indexOf('openMicrophone(seq)'),
    'a failed sidecar probe is refused before requesting microphone access'
  );
  assert.match(startBody, /catch \(error\)[\s\S]*?Voice\.restoreSpeak\(\)/, 'failed startup restores a mute that Live Voice lifted');
}
for (const fn of ['start', 'startDictation']) {
  assert.match(bodyOf(fn), /Voice\.forceSpeakOn\(\)/, fn + '() force-enables the speaker — hands-free is never opened muted');
  /* ⛔ BOTH entry points speak with the BUILT-IN identity. setLocalTts(true) is what routes /api/tts through
     the picked voice; the dictation leg passing false is what let the keyed provider voice speak on every
     degraded install while the picker adjusted an engine that was not there (the identity bug Andrew heard).
     The sidecar maps the pick onto the Edge floor when the offline engine is absent, so true is correct on
     the shipped path too. */
  assert.match(bodyOf(fn), /Voice\.setLocalTts\(true\)/, fn + '() opts into the built-in voice identity');
}
// (start()'s failure teardown legitimately resets the flag — only a reset on the HAPPY path would be the bug,
// and the positive per-function assert above is what locks that.)
assert.match(bodyOf('finish'), /Voice\.restoreSpeak\(\)/, 'leaving restores a mute we lifted (a hand-set speaker is left alone)');
assert.match(bodyOf('finish'), /Voice\.setLocalTts\(false\)/, 'leaving live voice returns ordinary speech to the persona ladder');

/* ⛔ THE CALL IS BOUND TO ONE SESSION. Everything routed through Chat lands on the ACTIVE workstream, so
   without a binding, browsing the rail mid-call silently re-targeted the conversation — the next utterance
   ran in whatever session was open, under that session's agent (Andrew hit this live). Both entry points
   bind; every utterance pins focus back to the bound session; the binding dies with the call; and the ONE
   legitimate rebind is a voice-driven station.switch_session while a call is live. */
for (const fn of ['start', 'startDictation']) {
  assert.match(bodyOf(fn), /bindSession\(\)/, fn + '() binds the call to the session it was opened in');
}
assert.match(bodyOf('handleTranscript'), /ensureBoundFocus\(\)/, 'every utterance routes to the BOUND session, not whatever is focused');
assert.doesNotMatch(bodyOf('onAssistant'), /ensureBoundFocus\(\)/, 'a delayed assistant reply preserves the browsed session and its draft');
assert.match(bodyOf('rebind'), /Voice\.stopSpeaking\(\)/, 'a voice-commanded rebind cuts queued audio owned by the former session');
assert.match(bodyOf('finish'), /boundWsId = null/, 'the binding dies with the call');
assert.match(source, /boundSession\(\) \|\| Workstreams\.active\(\)/, "the panel reports the CALL's session, not the browsed one");
const cmdSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'stationcommands.js'), 'utf8');
assert.match(cmdSource, /VoiceLive\.isActive\(\) && VoiceLive\.rebind/, 'a voice-driven session switch rebinds the live call (a UI click never routes through that verb)');

// Exercise the binding state machine, not only its spelling. A UI rail switch changes activeId but
// cannot change boundWsId; the next call-owned event restores the original workstream and transcript.
{
  const m = /(  let boundWsId = null;[\s\S]*?  function ensureBoundFocus\(\) \{[\s\S]*?\n  \})\n\n  function handleTranscript/.exec(source);
  assert.ok(m, 'voice-live.js still carries the complete session-binding state machine');
  let activeId = 'research';
  const sessions = {
    research: { id: 'research', archived: false },
    general: { id: 'general', archived: false }
  };
  const effects = [];
  const Workstreams = {
    activeId: () => activeId,
    get: id => sessions[id] || null,
    switch: id => { effects.push('switch:' + id); activeId = id; return sessions[id] || null; }
  };
  // eslint-disable-next-line no-new-func
  const binding = new Function('Workstreams', 'Chat', 'App', 'Voice', 'caption', 'refreshTask',
    'let spokenApprovalId = null;\n' + m[1] + '\nreturn { bindSession, ensureBoundFocus, bound: () => boundWsId };'
  )(
    Workstreams,
    { load: ws => effects.push('load:' + ws.id) },
    { refreshRail: () => effects.push('rail') },
    { stopSpeaking: () => effects.push('stop-audio') },
    () => {},
    () => {}
  );
  binding.bindSession();
  activeId = 'general'; // a UI click: visible selection changes, call ownership does not
  binding.ensureBoundFocus();
  assert.equal(binding.bound(), 'research', 'a rail click never rebinds the call');
  assert.equal(activeId, 'research', 'the next call-owned event restores the originating session');
  assert.deepEqual(effects, ['switch:research', 'load:research', 'rail'], 'focus + transcript are restored together');
}

// The output path is session-owned too. Live Voice force-enables a shared speaker, so Chat must
// explicitly refuse speech/heartbeat use by every non-bound workstream.
{
  const m = /(  function liveVoiceOwns\(ws\) \{[\s\S]*?\n  \})/.exec(chatSource);
  assert.ok(m, 'chat.js defines the live-call output ownership gate');
  let callActive = true;
  const VoiceLive = { boundSessionId: () => 'research' };
  // eslint-disable-next-line no-new-func
  const owns = new Function('VoiceLive', 'liveVoiceCall', m[1] + '\nreturn liveVoiceOwns;')(
    VoiceLive,
    () => callActive
  );
  assert.equal(owns({ id: 'research' }), true, 'the bound session owns spoken output');
  assert.equal(owns({ id: 'general' }), false, 'a browsed session cannot borrow the live-call speaker');
  callActive = false;
  assert.equal(owns({ id: 'general' }), true, 'ordinary speaker behavior is unchanged outside Live Voice');
}
assert.match(chatSource, /const speechOwner = \(\) => liveVoiceCall\(\) \? liveVoiceOwns\(ws\) : Workstreams.activeId\(\) === ws.id/, 'speech belongs to the bound call or visible direct conversation, including specialists');
assert.match(chatSource, /const pushSpeech = \(finalize, finalText\) => \{[\s\S]{0,500}!speechOwner\(\)/, 'ownership is rechecked on every streamed speech chunk');
assert.match(chatSource, /willSpeak && speechOwner\(\)[\s\S]{0,120}Voice\.endReply/, 'only the owning run may close the live speech stream');
assert.match(chatSource, /\(!liveVoiceCall\(\) \|\| liveVoiceOwns\(ws\)\)[\s\S]{0,120}Voice\.onTurnEnd/, 'only the bound run may re-arm the live microphone');

/* ⛔ LIVE VOICE RENDERS NO CLICKABLE PROMPTS — AND NARRATES NO STALE ONES. Two failures, in order: chips
   and the tap-to-correct brief card appeared mid-call and waited on a mouse (the opposite of hands-free);
   then the first fix NARRATED them, which meant opening a call over a re-rendered old beat blurted
   "say one: confirm, or not quite…" out of nowhere. The law that survived both: while a call is live the
   interactive beats are SUPPRESSED in chat.js — the agent's words are the ask — and the ONLY wait that
   speaks is an APPROVAL, which is a real blocking permission with a durable card. */
assert.match(chatSource, /function liveVoiceCall\(\)/, 'chat.js knows whether a call is live');
{
  const choicesBody = /(  function choices\(items, onPick, opts\) \{[\s\S]*?\n  \})/.exec(chatSource);
  assert.ok(choicesBody, 'chat.js still defines choices()');
  assert.match(choicesBody[1], /if \(liveVoiceCall\(\)\) return;/, 'chip rows NEVER render during a live call');
  const briefBody = /(  function briefReadCard\(ws, p\) \{[\s\S]{0,400})/.exec(chatSource);
  assert.ok(briefBody, 'chat.js still defines briefReadCard()');
  assert.match(briefBody[1], /if \(liveVoiceCall\(\)\) return;/, 'the tap-to-correct brief card never renders during a live call');
}
assert.match(bodyOf('refreshTask'), /announceWaits\(\)/, 'the live tick announces a newly-arrived approval');
assert.match(source, /Say approve, always allow, or deny/, 'an arriving approval is ASKED aloud, with the exact words that answer it');
assert.doesNotMatch(bodyOf('announceWaits'), /Say one/, 'chips are never narrated — the blurt class is dead, approvals are the only spoken wait');
assert.match(bodyOf('handleTranscript'), /approvalCommand\(lower\)/, 'a spoken approval answer settles the blocking wait first');
assert.match(bodyOf('handleTranscript'), /chipCommand\(lower\)/, 'a chip row that PRE-DATES the call can still be answered by voice');
assert.match(bodyOf('chipCommand'), /\.click\(\)/, 'a spoken pick clicks the REAL chip button — never a parallel path');

// the matcher is pure — extract and exercise it for real (the chat-linkify idiom: chat/voice files are
// browser-flow and not node-loadable whole)
{
  const m = /(  function matchChoice\([\s\S]*?\n  \})/.exec(source);
  assert.ok(m, 'voice-live.js still defines matchChoice()');
  // eslint-disable-next-line no-new-func
  const matchChoice = new Function(m[1] + '\nreturn matchChoice;')();
  const chips = ['▤ PLACE ITS DESK', 'later'];
  assert.equal(matchChoice('place its desk', chips), 0, 'an exact spoken label picks it');
  assert.equal(matchChoice('Place its desk.', chips), 0, 'punctuation and case are forgiven');
  assert.equal(matchChoice('place', chips), 0, 'a spoken prefix of a label picks it');
  assert.equal(matchChoice('later', chips), 1, 'the quiet option is just as sayable');
  assert.equal(matchChoice('yeah do that, place its desk please', chips), 0, 'the label inside a sentence picks it');
  assert.equal(matchChoice('the first one', chips), 0, 'ordinals work');
  assert.equal(matchChoice('the last one', chips), 1, '"last" works whatever the count');
  assert.equal(matchChoice('tell me about jupiter', chips), -1, 'an unrelated sentence falls through to the model');
  assert.equal(matchChoice('ok', ['ok', 'cancel']), 0, 'a short label still matches EXACTLY');
  assert.equal(matchChoice('okay lets look at the report', ['ok', 'cancel']), -1, 'but a short label never swallows a sentence (length floor)');
  assert.equal(matchChoice('la', chips), -1, 'a two-letter fragment is too little to act on');
  assert.equal(matchChoice('', chips), -1, 'silence picks nothing');
}
assert.match(voiceSource, /if \(!forcedSpeak\) return false;/, "restoreSpeak never undoes the Commander's own speaker choice");

/* ⛔ THE METER IS REAL ON THE FALLBACK LEG TOO. The dictation leg used to scroll
   nothing — the engine that listens exposes no frame clock — so the strip sat flat for both voices while
   the models leg animated in demos. The fix is a levels-only meter tap plus a fixed-cadence clock, and
   the honesty line lives in the tick: every push is a MEASURED value (the tap's RMS for your half, the
   playback tap's RMS for the agent's), and with no live source a tick pushes NOTHING — scrolling zeros
   would render "silent room", a claim the module cannot make with no signal to read. Assert the wiring
   per-function (the speaker-mute bug above taught why), and exercise the tick's truth table for real. */
for (const fn of ['startDictation']) {
  assert.match(bodyOf(fn), /openMeterTap\(seq\)/, fn + '() opens the levels-only meter tap');
  assert.match(bodyOf(fn), /setInterval\(dictationMeterTick,\s*43\)/, fn + '() scrolls the strip at the mic-frame cadence the models leg has');
}
assert.match(bodyOf('finish'), /closeMeterTap\(\)/, 'leaving live voice releases the meter tap device');
assert.match(bodyOf('finish'), /clearInterval\(meterClock\)/, 'leaving live voice stops the dictation meter clock');
{
  const tap = /(  async function openMeterTap\(seq\) \{[\s\S]*?\n  \})/.exec(source);
  assert.ok(tap, 'voice-live.js still defines openMeterTap()');
  assert.match(tap[1], /Promise\.race/, 'a dismissed WebView2 permission prompt degrades to a flat half, never a hung tap');
  assert.match(tap[1], /seq !== sessionSeq/, 'a late permission grant cannot hold an orphaned meter device');
  assert.match(tap[1], /track\.stop\(\)/, 'a tap the session no longer wants is released, not leaked');
  assert.doesNotMatch(tap[1], /setError|setState|scheduleReconnect/, 'the meter tap is cosmetic — its failure never touches session state');
}
{
  const m = /(  function dictationMeterTick\(\) \{[\s\S]*?\n  \})/.exec(source);
  assert.ok(m, 'voice-live.js still defines dictationMeterTick()');
  const run = env => {
    const pushes = [];
    // eslint-disable-next-line no-new-func
    const tick = new Function(
      'active', 'dictation', 'Voice', 'agentLevel', 'AGENT_GAIN', 'tapAlive', 'tapLevel', 'pushLevel', 'SELF', 'AGENT',
      m[1] + '\nreturn dictationMeterTick;'
    )(env.active, env.dictation, { isSpeaking: () => env.speaking }, env.agentLevel, 6, () => env.tapAlive, env.tapLevel, (v, s) => pushes.push([+v.toFixed(3), s]), 'self', 'agent');
    tick();
    return pushes;
  };
  assert.deepEqual(
    run({ active: true, dictation: true, speaking: true, agentLevel: 0.1, tapAlive: true, tapLevel: 0.9 }),
    [[0.6, 'agent']],
    'while the agent holds the turn the strip carries the agent playback level — measured, gained, colored agent'
  );
  assert.deepEqual(
    run({ active: true, dictation: true, speaking: false, agentLevel: 0.5, tapAlive: true, tapLevel: 0.05 }),
    [[0.7, 'self']],
    'while you hold the turn the strip carries the meter tap level, at the models-leg mic gain'
  );
  assert.deepEqual(
    run({ active: true, dictation: true, speaking: false, agentLevel: 0.5, tapAlive: false, tapLevel: 0.5 }),
    [],
    'a dead tap and a quiet agent push NOTHING — the meter never claims to hear a room it cannot hear'
  );
  assert.deepEqual(
    run({ active: true, dictation: false, speaking: true, agentLevel: 0.5, tapAlive: true, tapLevel: 0.5 }),
    [],
    'outside dictation mode the tick is inert — the mic frame stays the only clock on the models leg'
  );
}

console.log('voice-live-ui.test.js: ok');
