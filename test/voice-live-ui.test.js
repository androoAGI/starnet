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
  /* The probe reads a refused reply through the ONE shared classifier (Harness.classifyApiFailure, harness.js) that
     voice synthesis and push-to-talk use too. Lift the real function and bind it to a recovery state, the way the
     Harness export binds the live one. */
  const harnessSource = fs.readFileSync(path.join(root, 'frontend', 'app', 'harness.js'), 'utf8');
  const cm = /(  function classifyApiFailure\([\s\S]*?\n  \})/.exec(harnessSource);
  assert.ok(cm, 'harness.js defines the shared classifyApiFailure');
  // eslint-disable-next-line no-new-func
  const classifyApiFailure = new Function(cm[1] + '\nreturn classifyApiFailure;')();
  const harnessWith = state => ({ classifyApiFailure: r => classifyApiFailure(r, state) });
  // eslint-disable-next-line no-new-func
  const withHarness = H => new Function('Harness', m[1] + '\nreturn availabilityFailure;')(H);
  const stale = withHarness(harnessWith({ sessionStale: true, tokenWithheld: '' }));
  assert.deepEqual(
    stale({ ok: false, status: 403 }),
    { probeFailed: true, staleSession: true, tokenWithheld: '', status: 403 },
    'an old sidecar token (the recovery proved the session stale) is a stale page, not allowed into a silent voice session'
  );
  assert.deepEqual(
    stale({ ok: false, status: 500 }),
    { probeFailed: true, staleSession: false, tokenWithheld: '', status: 500 },
    'other sidecar failures are also refused before the microphone opens'
  );
  assert.equal(stale({ ok: true, status: 200 }), null, 'a healthy probe proceeds normally');
  assert.deepEqual(
    withHarness(harnessWith({ sessionStale: false, tokenWithheld: '' }))({ ok: false, status: 403 }),
    { probeFailed: true, staleSession: false, tokenWithheld: '', status: 403 },
    'a 403 the stale-token recovery did NOT prove (the route\'s own refusal) is refused, but never called a restart'
  );
  /* A page the station KEPT its key from (Harness.tokenWithheld) gets the same 403, but it is not a restart: a reload
     only re-runs the same ownership check. It carries the withheld notice and never reads as stale (threads-backend-05). */
  assert.deepEqual(
    withHarness(harnessWith({ sessionStale: false, tokenWithheld: 'other-user', withheldNotice: 'WITHHELD NOTICE' }))({ ok: false, status: 403 }),
    { probeFailed: true, staleSession: false, tokenWithheld: 'WITHHELD NOTICE', status: 403 },
    'a withheld page\'s 403 carries the withheld notice, never a stale (restarted) session'
  );
  const bare = withHarness(harnessWith({ sessionStale: false, tokenWithheld: 'peer-not-found' }))({ ok: false, status: 403 });
  assert.ok(bare.staleSession === false && /could not confirm this browser/.test(bare.tokenWithheld) && !/restart|reload/i.test(bare.tokenWithheld),
    'a withheld page with no notice text still names the check, never a restart: ' + bare.tokenWithheld);
  const noHarness = withHarness(undefined)({ ok: false, status: 403 });
  assert.ok(noHarness.probeFailed === true && noHarness.staleSession === false,
    'with no Harness at all the probe is still refused, and nothing claims a restart it cannot prove');
}
{
  const startBody = bodyOf('start');
  assert.match(startBody, /readiness\.probeFailed[\s\S]*?reload this page to reconnect voice/, 'stale pages receive an actionable reload message');
  assert.match(startBody, /if \(withheld\) setUnrecoverableError\(withheld\);/, 'a withheld page shows the withheld notice as its error');
  assert.ok(startBody.indexOf('withheld ?') > 0 && startBody.indexOf('withheld ?') < startBody.indexOf('station restarted'),
    'the withheld check comes before every restart line');
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
{
  // an arriving ask is SAID aloud with who asks, what exactly, and the exact words that answer it (2026-10-13 review: a
  // question was read as "Approval needed: brief.ask — {json}. Say approve…", then "approve" was refused for it)
  const spokenSrc = /(  function spokenAsk\(p, ws\) \{[\s\S]*?\n  \})\n/.exec(source);
  assert.ok(spokenSrc, 'voice-live.js defines spokenAsk()');
  // its helpers: the question line, the card's own words (askParts) and the once-only asks
  const helperSrc = ['questionLine', 'askParts'].map(name => {
    const m = new RegExp('(  function ' + name + '\\(pending, ws\\) \\{[\\s\\S]*?\\n  \\})\\n').exec(source);
    assert.ok(m, 'voice-live.js defines ' + name + '()');
    return m[1];
  });
  const onceOnlySrc = /  const ONCE_ONLY = new Set\([^\n]*\);/.exec(source);
  assert.ok(onceOnlySrc, 'voice-live.js defines ONCE_ONLY');
  // eslint-disable-next-line no-new-func
  const spokenAsk = new Function('App', 'Chat', onceOnlySrc[0] + '\n' + helperSrc.join('\n') + '\n' + spokenSrc[1] + '\nreturn spokenAsk;')(
    { agentName: id => ({ lead: 'NOVA', writer: 'VEX' })[id] || id }, { consentPhrase: p => 'change ' + JSON.parse(p.argsSummary).path });
  assert.equal(spokenAsk({ tool: 'fs.write', argsSummary: '{"path":"notes.md"}' }, { agentId: 'lead' }), 'NOVA needs approval to change notes.md. Say approve, always allow, or deny.', 'the lead\'s own ask: the exact words that answer it');
  assert.equal(spokenAsk({ tool: 'fs.write', argsSummary: '{"path":"email.md"}', workerAgentId: 'writer' }, { agentId: 'lead' }), 'VEX needs approval to change email.md. Say approve or deny.', 'a worker\'s ask names the worker and offers once-or-deny only, like its row');
  // a question is read as the question, in the asking worker's name, with only the answers voice can give (questionLine)
  const questionSaid = spokenAsk({ tool: 'brief.ask', argsSummary: '{"question":"Which tier leads?"}', workerAgentId: 'writer' }, { agentId: 'lead' });
  assert.equal(questionSaid, 'VEX asks: Which tier leads? Say use your judgment, or answer on the card.', 'a question is never read as an approval');
  assert.doesNotMatch(questionSaid, /approv|always allow|deny/i, 'a question never offers approval answers');
  assert.match(bodyOf('announceWaits'), /speakLocal\(spokenAsk\(pending, ws\)\)/, 'the live tick speaks it');
}
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

// A spoken approval uses the same confirmed answer path as a rendered card. Execute
// that actual Chat helper with actual Channels; the clock belongs to Chat, which closes pauses.
const approvalStart = source.indexOf('  const approvalSubmissions = new Set();');
const approvalEnd = source.indexOf('  /* THE CALL IS BOUND', approvalStart);
const consentStart = chatSource.indexOf('  const settledPromptNotices = new Set();');
const consentEnd = chatSource.indexOf('  // the channel\'s record', consentStart);
assert.ok(approvalStart >= 0 && approvalEnd > approvalStart && approvalEnd - approvalStart < 4000, 'complete bounded voice approval controller is present');
assert.ok(consentStart >= 0 && consentEnd > consentStart && consentEnd - consentStart < 6000, 'complete bounded confirmed-answer contract is present');
const flushApproval = () => new Promise(resolve => setImmediate(resolve));
function approvalFixture(opts = {}) {
  const Channels = require('../frontend/app/channels.js'); Channels.reset();
  const ws = { id: 'voice-parallel', agentId: 'lead' }, calls = [], events = [], spoken = [];
  Channels.begin(ws.id, 1000); Channels.setRunId(ws.id, 'lead-run');
  Channels.setPending(ws.id, { promptId: 'worker-first', tool: 'fs.write' }, 2000);
  Channels.setPending(ws.id, { promptId: 'worker-second', tool: opts.tool || 'shell.exec', ...(opts.worker ? { workerAgentId: opts.worker } : {}) }, 3000);
  const Workstreams = { active: () => ws, get: id => id === ws.id ? ws : null };
  let respond = (_run, _prompt, decision) => ({ ok: true, decision });
  const Harness = { consent: (...args) => { calls.push(args); return respond(...args); } };
  const U = { bus: { emit: (...args) => events.push(args) } }, clock = { now: () => 8000 };
  // eslint-disable-next-line no-new-func
  const Chat = new Function('Harness', 'Channels', 'Workstreams', 'U', 'Date', 'StationUI',
    'askerName', 'actionPhrase', 'isActiveWs', 'renderPresence', 'syncStatus',
    chatSource.slice(consentStart, consentEnd) + '\nreturn { answerConsent };')(
    Harness, Channels, Workstreams, U, clock, { notify() {}, settleNotifs() {} },
    () => 'worker', () => 'write a file', () => false, () => {}, () => {}
  );
  Object.assign(Chat, opts.chat || {});   // e.g. the real module's consentPhrase
  // Supply module state, not another implementation of approval or settlement.
  // eslint-disable-next-line no-new-func
  const controller = new Function('Workstreams', 'Channels', 'Chat', 'App', 'speakLocal', 'refreshTask',
    "let active = true, sessionSeq = 1, boundWsId = 'voice-parallel';\n" + source.slice(approvalStart, approvalEnd) +
    '\nreturn { answer: approvalCommand, end: () => { active = false; }, replaceCall: () => { sessionSeq++; }, rebind: id => { boundWsId = id; } };')(
    Workstreams, Channels, Chat, opts.App, text => spoken.push(text), () => {}
  );
  return { ...controller, Channels, ws, calls, events, spoken, respond: fn => { respond = fn; },
    pending: () => Channels.pendingAllOf(ws.id).map(p => p.promptId) };
}
(async () => {
  for (const [speech, decision] of [['approve', 'once'], ['always allow', 'always'], ['deny', 'deny']]) {
    const f = approvalFixture();
    assert.equal(f.answer('maybe'), false, 'unrecognized speech cannot settle a prompt');
    assert.deepEqual(f.pending(), ['worker-first', 'worker-second']);
    assert.equal(f.answer(speech), true);
    assert.deepEqual(f.events, [], 'the bus cannot claim success synchronously');
    assert.deepEqual(f.spoken, [], 'speech cannot claim success before acknowledgement');
    await flushApproval();
    assert.deepEqual(f.calls, [['lead-run', 'worker-second', decision]], 'voice sends only the selected prompt decision through Chat');
    assert.deepEqual(f.events, [['permission.response', { promptId: 'worker-second', decision, via: 'voice' }]], 'the bus names the confirmed prompt');
    assert.deepEqual(f.pending(), ['worker-first'], 'voice answer preserves the other pending prompt');
    assert.equal(f.Channels.peek(f.ws.id).pausedAt, 2000, 'the outstanding prompt keeps the original pause open');
    assert.equal(f.Channels.statusOf(f.ws.id), 'awaiting your approval…', 'the channel still truthfully waits');
    assert.equal(f.Channels.elapsedOf(f.ws.id, 9000), 1000, 'waiting on the sibling is not counted as run time');
    assert.equal(f.answer(speech), true); await flushApproval();
    assert.deepEqual(f.calls[1], ['lead-run', 'worker-first', decision], 'the next answer reaches the remaining prompt');
    assert.deepEqual(f.pending(), []);
    assert.equal(f.Channels.peek(f.ws.id).pausedAt, 0, 'answering the final prompt closes the pause');
    assert.equal(f.Channels.peek(f.ws.id).pausedMs, 6000, 'the pause closes once when all prompts settle');
    assert.equal(f.Channels.statusOf(f.ws.id), 'working…');
    assert.equal(f.answer(speech), false, 'a settled conversation cannot submit the same prompt again');
    assert.equal(f.calls.length, 2);
  }
  {
    // a delegated worker's request is once-or-deny by voice too: "always allow" grants nothing and says why
    const f = approvalFixture();
    f.Channels.setPending(f.ws.id, { promptId: 'worker-third', tool: 'fs.write', workerAgentId: 'writer' }, 4000);
    assert.equal(f.answer('always allow'), true);
    await flushApproval();
    assert.deepEqual(f.calls, [], 'no standing grant is sent for a worker\'s request');
    assert.match(f.spoken[0] || '', /only be approved once or denied/);
    assert.deepEqual(f.pending(), ['worker-first', 'worker-second', 'worker-third'], 'nothing is settled');
  }
  {
    const f = approvalFixture(); let resolve;
    f.respond(() => new Promise(done => { resolve = done; }));
    f.answer('approve'); f.answer('approve'); await flushApproval();
    assert.deepEqual(f.calls, [['lead-run', 'worker-second', 'once']], 'duplicate in-flight speech submits once');
    assert.deepEqual(f.pending(), ['worker-first', 'worker-second'], 'in-flight acknowledgement clears nothing');
    assert.deepEqual([f.events, f.spoken], [[], []]);
    resolve({ ok: false, error: 'offline' }); await flushApproval();
    assert.deepEqual(f.pending(), ['worker-first', 'worker-second'], 'refusal preserves both prompts');
    assert.deepEqual(f.events, [], 'refusal emits no confirmed response');
    assert.ok(f.spoken.every(t => !/^Approved/.test(t)), 'refusal never claims approval');
    f.respond(() => Promise.reject(new Error('network failed'))); f.answer('approve'); await flushApproval();
    assert.deepEqual(f.pending(), ['worker-first', 'worker-second'], 'a transport failure also preserves both prompts');
    f.respond(() => ({ ok: true, decision: 'deny' })); f.answer('approve'); await flushApproval();
    assert.equal(f.calls.length, 3, 'a refused or failed submission remains retryable');
    assert.deepEqual(f.pending(), ['worker-first']);
    assert.deepEqual(f.events, [['permission.response', { promptId: 'worker-second', decision: 'deny', via: 'voice' }]], 'the confirmed applied decision wins');
    assert.equal(f.spoken.at(-1), 'Denied.', 'speech reports the applied decision, not the requested approval');
  }
  {
    const f = approvalFixture();
    f.Channels.setRunId(f.ws.id, 'newer-channel-run');
    f.Channels.setPending(f.ws.id, { promptId: 'worker-second', tool: 'shell.exec', runId: 'original-parent-run' }, 3000);
    f.Channels.setPending('unrelated', { promptId: 'other-prompt' }, 3000);
    f.answer('approve'); await flushApproval();
    assert.deepEqual(f.calls, [['original-parent-run', 'worker-second', 'once']], 'stamped prompt owner wins over a newer channel run');
    assert.deepEqual(f.Channels.pendingAllOf('unrelated').map(p => p.promptId), ['other-prompt']);
    f.Channels.setPending(f.ws.id, { promptId: 'question', tool: 'brief.ask' }, 3000);
    assert.equal(f.answer('approve'), false, 'a question is never answered as a tool approval');
    assert.equal(f.calls.length, 1);
  }
  for (const change of ['end', 'replaceCall', 'rebind']) {
    const f = approvalFixture(); let resolve;
    f.respond(() => new Promise(done => { resolve = done; }));
    f.answer('approve'); await flushApproval(); f[change]('different-chat');
    resolve({ ok: true, decision: 'once' }); await flushApproval();
    assert.deepEqual(f.pending(), ['worker-first'], change + ': confirmation still settles its original prompt');
    assert.deepEqual(f.spoken, [], change + ': late confirmation cannot speak into another call or chat');
  }
  {
    const f = approvalFixture(); let reject;
    f.respond(() => new Promise((_done, fail) => { reject = fail; }));
    f.answer('approve'); await flushApproval();
    f.Channels.clearPending(f.ws.id, 8000, 'worker-second'); reject(new Error('local response lost')); await flushApproval();
    assert.deepEqual(f.pending(), ['worker-first']);
    assert.deepEqual(f.spoken, ['That approval is no longer waiting.'], 'a failed local request on a prompt settled elsewhere says so, never that it still waits (review app-shell-ui-08)');
  }
  // review app-shell-ui-03: the leash, the login window and a plugin install are answered fresh every time — the station
  // grants that ONE call whatever grade arrives. A spoken "always allow" there must submit once and say so, never
  // "Always allowed." (the station's echo of a requested 'always' is not a standing grant for these)
  for (const tool of ['station.power', 'browser.login', 'browser.login.done', 'plugin.submit']) {
    const f = approvalFixture({ tool });
    f.answer('always allow'); await flushApproval();
    assert.deepEqual(f.calls, [['lead-run', 'worker-second', 'once']], tool + ': a spoken always is submitted as once');
    assert.ok(f.spoken.every(t => !/Always allowed/.test(t)), tool + ': voice never confirms a standing grant');
    assert.match(f.spoken.at(-1) || '', /can only be approved once\. Approved once/, tool + ': voice says why it approved once');
  }
  {
    const f = approvalFixture();
    f.answer('always allow'); await flushApproval();
    assert.deepEqual(f.calls, [['lead-run', 'worker-second', 'always']], 'an ordinary card still takes a spoken always');
    assert.equal(f.spoken.at(-1), 'Always allowed.');
  }
  // review app-shell-ui-08: with several asks open, the spoken outcome names which one it answered — who asked, for what
  {
    const phrase = p => ({ 'shell.exec': 'run a command: npm test', 'plugin.submit': 'install the plugin it built “x” — it stays OFF until you approve its code' })[p.tool] || 'write a file';
    const App = { agentName: id => ({ nova: 'NOVA', mira: 'MIRA', lead: 'LEAD' })[id] || null };
    const f = approvalFixture({ worker: 'nova', chat: { consentPhrase: phrase }, App });
    f.answer('approve'); await flushApproval();
    assert.equal(f.spoken.at(-1), 'Approved once: NOVA to run a command: npm test.', 'the outcome names the asker and the action');
    f.respond(() => ({ ok: true, decision: 'deny' })); f.answer('deny'); await flushApproval();
    assert.equal(f.spoken.at(-1), 'Denied: LEAD to write a file.', 'the lead\'s own ask names the lead');
    const g = approvalFixture({ tool: 'plugin.submit', worker: 'mira', chat: { consentPhrase: phrase }, App });
    g.answer('always allow'); await flushApproval();
    assert.equal(g.spoken.at(-1), 'This one can only be approved once. Approved once: MIRA to install the plugin it built “x”.', 'speech drops the card\'s fine print');
    const h = approvalFixture({ chat: { consentPhrase: phrase } });
    h.answer('approve'); await flushApproval();
    assert.equal(h.spoken.at(-1), 'Approved once: run a command: npm test.', 'with no name to give, the outcome still names the action');
  }
  // the hands-free announcement offers only the keys the card has
  {
    const waitsStart = source.indexOf('  function announceWaits() {');
    const waitsEnd = source.indexOf('  /* Answer visible chips by voice.', waitsStart);
    assert.ok(waitsStart >= 0 && waitsEnd > waitsStart, 'announceWaits() is present');
    const say = (tool, extra) => {
      const Channels = require('../frontend/app/channels.js'); Channels.reset();
      Channels.setPending('w', Object.assign({ promptId: 'p-' + tool, tool }, extra || {}), 1000);
      const spoken = [];
      // eslint-disable-next-line no-new-func
      new Function('Workstreams', 'Channels', 'Chat', 'App', 'speakLocal',
        "let active = true, boundWsId = 'w', spokenApprovalId = null, sessionSeq = 1; const boundSession = () => ({ id: 'w', agentId: 'lead' });\n" +
        source.slice(waitsStart, waitsEnd) + source.slice(approvalStart, approvalEnd) + '\nannounceWaits();')(
        { activeId: () => 'w', active: () => ({ id: 'w' }) }, Channels, chat || {}, App, t => spoken.push(t));
      return spoken.join(' ');
    };
    let chat = null, App;
    for (const tool of ['station.power', 'browser.login', 'browser.login.done', 'plugin.submit']) {
      assert.match(say(tool), /Say approve or deny\.$/, tool + ': a card with no Always is never offered "always allow" aloud');
    }
    assert.match(say('fs.write'), /Say approve, always allow, or deny\.$/, 'an ordinary card keeps all three answers');
    // …and names who asks and what for, in the card's words, never the raw tool id (review app-shell-ui-08)
    chat = { consentPhrase: p => p.tool === 'shell.exec' ? 'run a command: npm test' : 'write a file' };
    App = { agentName: id => (id === 'lead' ? 'NOVA' : null) };
    assert.equal(say('shell.exec'), 'NOVA needs approval to run a command: npm test. Say approve, always allow, or deny.');
    // a question is not an approval: it is spoken as the question, with only the answers voice can give — the card's
    // one-tap options (chipCommand presses them) — never approve/always/deny, which approvalCommand ignores for brief.ask
    const question = q => say('brief.ask', { argsSummary: typeof q === 'string' ? q : JSON.stringify(q) });
    assert.equal(question({ question: 'Which database should I use?', options: ['Postgres', 'SQLite'] }),
      'NOVA asks: Which database should I use? Say Postgres, SQLite, or use your judgment.', 'a question is read aloud with its options');
    assert.equal(question({ question: 'Ship it today', options: [] }), 'NOVA asks: Ship it today. Say use your judgment, or answer on the card.');
    assert.equal(question({ question: 'Which pages?', options: ['Home', 'About'], multiSelect: true }), 'NOVA asks: Which pages? Answer on the card.',
      'a multi-select card is not offered by voice: its keys only toggle');
    assert.equal(question({ question: 'Tell me about the last export.', mode: 'conversation' }), 'NOVA asks: Tell me about the last export. Answer on the card.');
    assert.equal(question('not json'), 'NOVA has a quick question for you. Answer on the card.');
    for (const line of [question({ question: 'Which one?', options: ['A'] }), question('not json')]) {
      assert.doesNotMatch(line, /approv|always allow|deny/i, 'a question never offers approval answers');
    }
  }
  // a spoken pick presses a pending question's real option key first; a multi-select card's toggles are never pressed
  {
    const chipStart = source.indexOf('  function chipButtons() {');
    const chipEnd = source.indexOf('  /* ⛔ THE ONLY WAIT THAT SPEAKS', chipStart);
    const cmdStart = source.indexOf('  function matchChoice(said, labels) {');
    const cmdEnd = source.indexOf('  const approvalSubmissions = new Set();', cmdStart);
    assert.ok(chipStart >= 0 && chipEnd > chipStart && cmdStart > chipEnd && cmdEnd > cmdStart, 'chipButtons() and chipCommand() are present');
    const button = (label, cls) => ({ textContent: label, disabled: false, cls: cls || '', clicked: 0, click() { this.clicked++; } });
    const dom = (askRows, chips) => ({ querySelectorAll: sel => sel === '#chat-log [data-clarify-prompt] .consent-btns'
      ? askRows.map(btns => ({ querySelector: q => (q === '.consent-confirm' && btns.some(b => /consent-confirm/.test(b.cls))) ? {} : null, querySelectorAll: () => btns }))
      : sel === '#chat-log .choice-row button.choice' ? chips : [] });
    const press = (document, said) => {
      const spoken = [];
      // eslint-disable-next-line no-new-func
      const handled = new Function('document', 'speakLocal', 'refreshTask', source.slice(chipStart, chipEnd) + source.slice(cmdStart, cmdEnd) + '\nreturn chipCommand;')(
        document, t => spoken.push(t), () => {})(said);
      return { handled, spoken };
    };
    const pg = button('★ Postgres'), sq = button('SQLite'), judge = button('use your judgment'), old = button('Postgres');
    const r1 = press(dom([[pg, sq, judge]], [old]), 'postgres');
    assert.ok(r1.handled && pg.clicked === 1 && old.clicked === 0, 'the pending question\'s own key is pressed, not an older chip of the same name');
    assert.deepEqual(r1.spoken, ['Postgres.']);
    const home = button('Home'), confirm = button('✔ confirm', 'consent-btn consent-confirm'), chip = button('Home');
    const r2 = press(dom([[home, confirm]], [chip]), 'home');
    assert.ok(home.clicked === 0, 'a multi-select toggle is never pressed by voice');
    assert.ok(r2.handled && chip.clicked === 1, 'with no single-pick question open, chips answer as before');
  }
  assert.equal(source, fs.readFileSync(path.join(root, 'website', 'app', 'app', 'voice-live.js'), 'utf8'), 'the website voice controller matches the desktop');
  console.log('voice-live-ui.test.js: ok (confirmed ownership, siblings, pause accounting, refusal, duplicate, inflight and call-generation controls)');
})().catch(error => { console.error(error); process.exitCode = 1; });
