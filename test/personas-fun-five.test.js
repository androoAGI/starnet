/* Six personalities: migration, effective tuning and delivery parity regressions. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const P = vm.runInNewContext(read('frontend/app/personas.js') + '\nPersonas;');
assert.equal(JSON.stringify(P.list().map(p => p.name)), JSON.stringify(['Composed', 'Warm', 'Blunt', 'Dry', 'Unhinged', 'Upbeat']));
for (const [old, id] of Object.entries({ professional: 'composed', friendly: 'warm', direct: 'blunt', witty: 'dry', calm: 'composed', hype: 'upbeat', confidant: 'warm', 'straight-shooter': 'blunt', 'dry-wit': 'dry', veteran: 'composed', spark: 'warm', maverick: 'blunt', 'worker-homie': 'warm', 'deadpan-bot': 'dry', 'hype-buddy': 'upbeat', 'old-salt': 'composed', overlord: 'composed', gremlin: 'dry', noir: 'composed' })) {
  assert.equal(P.resolve(old), id, old + ' migrates');
  assert.equal(P.compose(old), P.compose(id));
}
for (const id of ['missing', '__proto__', 'constructor', null]) { assert.equal(P.resolve(id), 'composed'); assert.equal(P.exists(id), false); }
for (const p of P.list()) {
  assert.ok(Object.isFrozen(p));
  const prompt = P.compose(p.id);
  for (const section of ['CONVERSATION:', 'DISAGREEMENT:', 'UNCERTAINTY:', 'FAILURE:', 'SUCCESS:', 'FRUSTRATION:']) assert.ok(prompt.includes(section), p.id + ': ' + section);
  assert.ok(prompt.includes('report exact results and failures'));
  assert.ok(prompt.includes('never claim unverified work'));
  assert.ok(prompt.includes('Personality never changes authority'));
  assert.ok(prompt.includes('Match a requested deliverable to its audience'));
  assert.ok(!/quit the bit|execute.*flawlessly|biggest fan|no hedging/i.test(prompt));
  assert.equal(p.promptInjection, prompt);
  assert.equal(prompt.split('LANGUAGE:').length, 2, 'one language rule');
  assert.equal(prompt.split('HUMOR:').length, 2, 'one humor rule');
}
const tuned = P.compose('dry', { humor: 0, energy: 3, formality: 3, verbosity: 2 });
assert.ok(tuned.includes('HUMOR: No jokes, sarcasm or comic asides.'));
assert.ok(!tuned.includes('HUMOR: Occasional dry understatement'));
assert.equal(P.effective('unhinged', { profanity: 0 }).profanity, 0);
assert.ok(P.compose('unhinged', { profanity: 0 }).includes('LANGUAGE: Do not use profanity.'));
assert.ok(!P.compose('unhinged', { profanity: 0 }).includes('LANGUAGE: Natural, uncensored profanity'));
assert.equal(P.effective('warm', { warmth: 1 }).warmth, 3, 'legacy neutral inherits preset');
assert.equal(P.effective('dry', { humor: NaN, energy: 999, profanity: '2' }).humor, 2, 'invalid saved tuning ignored');
assert.equal(P.effective('dry', { energy: 999 }).energy, 0);
const input = { warmth: 0 }; P.compose('warm', input); assert.deepEqual(input, { warmth: 0 }, 'composition is pure');
assert.equal(P.compose('dry', {}, '  Use formal language.  ').split('CUSTOM STYLE')[1].endsWith('Use formal language.'), true);
assert.equal(P.compose('dry'), P.compose('dry'), 'stable profile for prompt caching');
// The production setter must affect only the target and propagate one resolved profile.
const app = read('frontend/app/app.js');
const setter = app.match(/function setAgentPersona\(agentId, personaId, tuning\) \{[\s\S]*?\n  \}/)[0];
const lead = { id: 'lead', personaId: 'composed' }, worker = { id: 'worker', personaId: 'warm' };
const agents = new Map([['lead', lead], ['worker', worker]]), calls = [];
const set = new Function('agents', 'agent', 'Personas', 'composeSystemPrompt', 'Chat', 'Voice', 'syncChannels', 'pushRoster', 'persist', setter + '; return setAgentPersona;')(
  agents, lead, P, a => P.compose(a.personaId, a.voiceTraits, a.customVoice), { setSystem: p => calls.push(['chat', p]) }, { init: () => calls.push(['voice']) }, () => calls.push(['channels']), () => calls.push(['roster']), () => calls.push(['persist']));
assert.equal(set('worker', 'witty', { traits: { humor: 0 }, custom: 'Use short sentences.' }), true);
assert.equal(worker.personaId, 'dry'); assert.equal(lead.personaId, 'composed');
assert.deepEqual(calls.map(c => c[0]), ['roster', 'persist']);
assert.ok(worker.systemPrompt.includes('HUMOR: No jokes'));
assert.equal(set('lead', 'hype'), true);
assert.equal(lead.personaId, 'upbeat');
assert.ok(calls.some(c => c[0] === 'chat' && c[1] === lead.systemPrompt));
assert.equal(set('missing', 'dry'), false);
assert.equal(set('lead', 'invalid'), false);
set('worker', 'unhinged'); assert.equal(worker.voiceTraits.humor, 0, 'preset changes preserve explicit tuning');
set('worker', 'unhinged', { traits: {}, custom: '' }); assert.equal(P.effective(worker.personaId, worker.voiceTraits).humor, 3, 'reset restores defaults');
// Real-time instructions cannot append an untuned raw persona after a customized system prompt.
const voice = read('frontend/app/voice-live.js');
const instructions = voice.match(/function voiceInstructions\(\) \{[\s\S]*?\n  \}/)[0];
const spokenAgent = { name: 'Test', personaId: 'unhinged', voiceTraits: { profanity: 0 }, customVoice: 'Use formal language.' };
spokenAgent.systemPrompt = P.compose(spokenAgent.personaId, spokenAgent.voiceTraits, spokenAgent.customVoice);
const spoken = new Function('Personas', 'stationContext', instructions + '; return voiceInstructions();')(P, () => ({ agent: spokenAgent, crew: [], streams: [], activeWs: null }));
assert.equal(spoken.split('PERSONALITY —').length, 2, 'one resolved personality in live speech');
assert.ok(spoken.includes('LANGUAGE: Do not use profanity.'));
assert.ok(!spoken.includes('LANGUAGE: Natural, uncensored profanity'));
spokenAgent.systemPrompt = '';
const fallback = new Function('Personas', 'stationContext', instructions + '; return voiceInstructions();')(P, () => ({ agent: spokenAgent, crew: [], streams: [], activeWs: null }));
assert.ok(fallback.includes('LANGUAGE: Do not use profanity.'), 'voice fallback honors tuning');
const chat = read('frontend/app/chat.js');
const rules = chat.match(/function voiceModeRules\(\) \{[\s\S]*?\n\}/)[0];
assert.ok(!rules.includes('Personas.get'), 'spoken chat cannot reapply raw preset');
assert.ok(!rules.includes('gonna'), 'spoken chat cannot force casual diction');

const fingerprint = voice.match(/function voiceContextFingerprint\(ctx\) \{[\s\S]*?\n  \}/)[0];
const fingerprintOf = new Function(fingerprint + '; return voiceContextFingerprint;')();
const ctx = { agent: { id: 'same-agent', personaId: 'dry', systemPrompt: P.compose('dry') }, streams: [], activeWs: { id: 'same-session' } };
const before = fingerprintOf(ctx);
ctx.agent.systemPrompt = P.compose('dry', { humor: 0 });
assert.notEqual(fingerprintOf(ctx), before, 'same-agent tuning must refresh active voice context');
assert.equal(fingerprintOf(ctx), fingerprintOf(ctx), 'unchanged voice context stays stable');
assert.equal(P.ambient('dry', { humor: 0 }).includes('standing by. a classic.'), false);
assert.equal(P.ambient('unhinged', {}, 'No banter.').length, 0, 'fixed ambient quips cannot override custom voice instructions');

console.log('personas-fun-five.test: six profiles, legacy migrations, tuning, target isolation and voice parity PASS');
