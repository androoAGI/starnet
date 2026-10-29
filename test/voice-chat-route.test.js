/* node test/voice-chat-route.test.js — SETTINGS › Models › VOICE CHAT MODEL (Hermes parity auxiliary.voice_chat):
   a spoken turn may run on its own model. Three layers:
   1) PURE planner (sidecar/voice-chat-route.js): only a configured, different, fitting voice model takes the turn;
      reasoning OFF by default (lowest offered level where OFF is refused); '' keeps the typed effort; junk settings
      read as the default.
   2) SOURCE GUARD (host): the route is resolved once in runOnceCore for voiceTurn runs, the agent's own route rides
      as the first provider fallback, the decision rides agent.run.start, and both ingresses mark the turn.
   3) SOURCE GUARD (frontend): COMMS marks a spoken reply (never live-call delegations), the notice reasons match
      the planner's, and the Settings row saves on the change. The live proof is test/voice-chat-model.e2e.test.js. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const V = require('../sidecar/voice-chat-route.js');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = { provider: 'openrouter', model: 'anthropic/claude-opus-4.8' };
const fits = { credentialOk: true, contextLimit: 200000, efforts: null };

// ---------- 1. settings ----------
{
  A.eq(V.cleanSetting(null), { provider: '', model: '', reasoningEffort: 'none' }, 'no setting = follow the agent, reasoning off');
  A.eq(V.cleanSetting({ model: 'x/fast', provider: 'OpenRouter', reasoningEffort: 'LOW' }), { provider: 'openrouter', model: 'x/fast', reasoningEffort: 'low' }, 'normalized');
  A.eq(V.cleanSetting({ provider: 'openrouter' }).provider, '', 'a provider without a model is dropped (nothing to route to)');
  A.eq(V.cleanSetting({ reasoningEffort: '' }).reasoningEffort, '', '"" = keep the typed effort');
  A.eq(V.cleanSetting({ reasoningEffort: 'bogus' }).reasoningEffort, 'none', 'junk effort = the default');
  A.eq(V.cleanSetting({ model: 'a\nb' }).model, '', 'control characters never become a model id');
  A.ok(V.isDefault({}) && V.isDefault({ reasoningEffort: 'none' }) && !V.isDefault({ reasoningEffort: 'low' }), 'isDefault');
  A.eq(V.validatePatch({ clear: true }), { ok: true, setting: null }, 'clear');
  A.eq(V.validatePatch({ model: 'x/y', reasoningEffort: 'off' }).setting.reasoningEffort, 'none', 'off = none');
  A.ok(!V.validatePatch({ reasoningEffort: 'turbo' }).ok, 'unknown effort refused with a reason');
  A.ok(!V.validatePatch({ model: 'x'.repeat(201) }).ok, 'over-long model refused');
  A.ok(!V.validatePatch('nope').ok, 'non-object refused');
}

// ---------- 1b. effort ----------
{
  A.eq(V.voiceEffort('none', null), 'none', 'unknown levels: ask for off, the adapter clamps');
  A.eq(V.voiceEffort('none', ['none', 'low', 'high']), 'none', 'off offered');
  A.eq(V.voiceEffort('none', ['high', 'low', 'medium']), 'low', 'off refused: the weakest offered level');
  A.eq(V.voiceEffort('none', ['minimal', 'low']), 'minimal', 'minimal beats low');
  A.eq(V.voiceEffort('', ['low']), null, '"" = no override');
  A.eq(V.voiceEffort('low', ['none', 'high']), 'low', 'an explicit level the list lacks still goes out (adapter clamps)');
}

// ---------- 1c. the plan ----------
{
  let p = V.planVoiceRoute({ setting: {}, main, target: fits });
  A.eq([p.route, p.model, p.reasoningEffort, p.reason], ['main', main.model, 'none', ''], 'no voice model: the agent answers, reasoning off');
  p = V.planVoiceRoute({ setting: { reasoningEffort: '' }, main, target: fits });
  A.eq(p.reasoningEffort, null, 'auto + "" = byte-identical to a typed turn');
  p = V.planVoiceRoute({ setting: { model: 'google/gemini-3-flash' }, main, target: fits });
  A.eq([p.route, p.provider, p.model, p.reason], ['voice', 'openrouter', 'google/gemini-3-flash', ''], 'a voice model on the agent\'s provider takes the turn');
  p = V.planVoiceRoute({ setting: { model: 'claude-haiku-5-5', provider: 'anthropic' }, main, target: fits });
  A.eq([p.route, p.provider], ['voice', 'anthropic'], 'a voice model may live on another provider');
  p = V.planVoiceRoute({ setting: { model: main.model }, main, target: fits });
  A.eq([p.route, p.reason], ['main', ''], 'the same model is no route change');
  p = V.planVoiceRoute({ setting: { model: 'x/fast' }, main, target: { credentialOk: false } });
  A.eq([p.route, p.model, p.reason], ['main', main.model, 'not_configured'], 'no credential: stays on the agent, says why');
  p = V.planVoiceRoute({ setting: { model: 'x/fast' }, main, target: { credentialOk: true, contextLimit: 32000 }, promptTokens: 10000, compactAt: 0.65 });
  A.eq([p.route, p.reason], ['main', 'too_large'], 'never compacts to fit: 10k + overhead crosses 65% of 32k');
  p = V.planVoiceRoute({ setting: { model: 'x/fast' }, main, target: { credentialOk: true, contextLimit: 32000 }, promptTokens: 2000, compactAt: 0.65 });
  A.eq(p.route, 'voice', 'a small conversation fits the small model');
  p = V.planVoiceRoute({ setting: { model: 'x/fast' }, main, target: { credentialOk: true, contextLimit: 0 }, promptTokens: 900000 });
  A.eq(p.route, 'voice', 'an unknown window counts as fitting (the run keeps its reactive overflow guard)');
  p = V.planVoiceRoute({ setting: { model: 'x/fast' }, main, target: { credentialOk: true, contextLimit: 200000, efforts: ['low', 'high'] } });
  A.eq(p.reasoningEffort, 'low', 'the voice model\'s own levels clamp the effort');
  p = V.planVoiceRoute({ setting: { model: 'x/fast' }, main, target: { credentialOk: false, efforts: ['none'] }, mainEfforts: ['high', 'medium'] });
  A.eq(p.reasoningEffort, 'medium', 'staying on the agent: ITS levels clamp the effort');
  A.ok(V.reasonText('too_large') && V.reasonText('not_configured') && !V.reasonText('x'), 'reason text');
}

// ---------- 2. host source guards ----------
{
  const idx = readSidecarSource();
  A.ok(/require\('\.\/voice-chat-route\.js'\)/.test(idx), 'host requires the planner');
  A.ok(/exact: '\/api\/voice\/chat-model', h: handleVoiceChatStatus/.test(idx) && /exact: '\/api\/voice\/chat-model', h: handleVoiceChatSet/.test(idx), 'GET + POST routes registered');
  A.ok(/VOICE_CHAT_FILE = path\.join\(WORKSPACES, 'voice-chat\.json'\)/.test(idx) && /makeDomainStore\(\{\s*fs, path, file: VOICE_CHAT_FILE/.test(idx), 'persisted through the durable domain store');
  // the route locals are destructured here (messages became a `let` beside it: the run host expands attachments later)
  const routeLocals = idx.indexOf('const { key, system: rawSystem, agentId = \'agent\', signal, runId } = o;');
  A.ok(routeLocals > idx.indexOf('async function runOnceCore('), 'runOnceCore destructures its route locals');
  const core = idx.slice(idx.indexOf('async function runOnceCore('), routeLocals);
  A.ok(/o\.voiceTurn === true && !o\.voiceRoute && !o\.recovery && !o\.internal/.test(core) && /o = await applyVoiceTurnRoute\(o\)/.test(core), 'runOnceCore resolves the route once, before any route local is read');
  A.ok(/runStartExtra\.voiceRoute = \{/.test(idx), 'the decision rides agent.run.start');
  A.ok(/name === 'agent\.run\.start' && payload && payload\.runId === runId && \([^)]*runStartExtra\.voiceRoute\)\) payload = Object\.assign\(\{\}, payload, runStartExtra\)/.test(idx),
    "the loop's own run.start merges the voice route (without it the field never reaches the page)");
  const apply = idx.slice(idx.indexOf('async function applyVoiceTurnRoute('), idx.indexOf('async function applyVoiceTurnRoute(') + 6000);
  A.ok(/next\.fallbackProviders = \[\{ provider: mainProvider, model: mainModel/.test(apply), 'the agent\'s route is the first fallback');
  A.ok(/sameProvider \? \(o\.key \|\| ''\) : ''/.test(apply), 'a page key never crosses providers');
  A.ok(/if \(!sameProvider\) next\.keyPool = undefined/.test(apply), 'a page key pool never crosses providers');
  A.ok(/voiceTurn: !!\(body && body\.voiceTurn === true\)/.test(idx), '/api/run marks the turn only on an explicit true');
  A.ok(/voiceTurn: \(!!spoken && !lineId\) \|\| undefined/.test(read('sidecar/channels/hub.js')), 'a channel voice note is a voice turn (never a line stage)');
}

// ---------- 3. frontend source guards ----------
{
  const chat = read('frontend/app/chat.js');
  A.ok(/voiceTurn: \(willSpeak && !liveVoiceCall\(\)\) \|\| undefined/.test(chat), 'COMMS marks a spoken reply, never a live-call delegation');
  const m = /const VOICE_ROUTE_REASONS = (\{[^}]*\});/.exec(chat);
  A.ok(!!m, 'COMMS notice reasons present');
  if (m) {
    const map = Function('return ' + m[1])();
    A.eq(Object.keys(map).sort(), ['not_configured', 'too_large'], 'notice covers every planner reason');
    Object.keys(map).forEach(k => A.eq(map[k], V.reasonText(k), 'notice text matches the planner for ' + k));
  }
  A.ok(/if \(voiceTurn && !internal\) reqBody\.voiceTurn = true/.test(read('frontend/app/harness.js')), 'Harness sends the mark');
  const ui = read('frontend/app/stationui.js');
  A.ok(/id="vcm-model"/.test(ui) && /id="vcm-effort"/.test(ui) && /wireVoiceChatModel\(host\)/.test(ui), 'Settings row present + wired');
  A.ok(/modelSel\.addEventListener\('change', post\)/.test(ui) && /effortSel\.addEventListener\('change', post\)/.test(ui), 'saves on the change');
}

A.report('voice-chat-route');
