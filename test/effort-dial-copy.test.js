// effort-dial-copy.test.js — (W1.12) the effort dial's lines never promise an effect a message will not get, in COMMS and in the
// terminal alike. The Claude CLI is given no effort for a message (its run records say 'cli-default'), so on claude-cli /fast
// and /reasoning name the level they stored and say it does not change a message; on any other provider every line is the
// one it always was. Both surfaces read ONE fact for it, the provider registry's effortDialReachesRuns. The functions run for
// real (sliced from chat.js and bin/lib/dashboard.js, with stubbed station seams), not matched as source.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');
const registry = require('../sidecar/providers/registry.js');

// ---- the one fact: does the dial reach this route's runs ----
const reaches = typeof registry.effortDialReachesRuns === 'function' ? registry.effortDialReachesRuns : null;
A.ok(!!reaches, 'the provider registry answers whether the dial reaches a route\'s runs (effortDialReachesRuns)');
if (reaches) {
  A.eq(reaches('claude-cli'), false, 'claude-cli: the dial never reaches a run (no --effort for a message)');
  A.eq(reaches('claude-code'), false, '...by any of its names');
  for (const id of ['openrouter', 'codex', 'anthropic', 'openai', 'gemini', 'ollama', 'custom', 'starnet'])
    A.eq(reaches(id), true, id + ': the dial reaches its runs');
  A.eq(reaches(''), true, 'no route picked yet: the station default (which takes the dial)');
}
const frontendRegistry = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'provider-registry.js'), 'utf8');
A.ok(frontendRegistry === fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'providers', 'registry.js'), 'utf8'), 'the page loads the same registry (npm run sync:website)');

// ---- COMMS (chat.js) ----
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
const parts = ['function effortReachesModel(', 'function reasoningModelNote(', 'function reasoningLevelOf(', 'function reasoningCommand(', 'function fastCommand('].map(h => A.fnBody(src, h));
parts.forEach((p, i) => A.ok(p.length > 40 && p.length < 4000, 'sliced a whole function #' + i));
const levels = /const REASONING_LEVELS = \[[^\]]*\];/.exec(src);
const aliases = /const MEDIUM_ALIASES = \[[^\]]*\];/.exec(src);
A.ok(levels && aliases, 'the level lists are where the commands read them');
A.ok(/effortDialReachesRuns\(prov\)/.test(A.fnBody(src, 'function effortReachesModel(')) && !/'claude-cli'/.test(A.fnBody(src, 'function effortReachesModel(')),
  'COMMS reads the registry fact, not its own copy of a provider name');

function station(prov, effort) {
  const lines = [];
  const store = { effort };
  const sandbox = {
    lines,
    SK: { providers: { registry } },
    Harness: {
      getProv: () => prov,
      getModel: () => 'some-model',
      getReasoningEffort: () => store.effort,
      normalizeReasoningEffort: (raw) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].indexOf(raw) >= 0 ? raw : 'medium'
    },
    App: { applyConfig: (c) => { if (c && c.reasoningEffort) store.effort = c.reasoningEffort; } }
  };
  vm.createContext(sandbox);
  vm.runInContext([levels[0], aliases[0], 'function localLine(t) { lines.push(t); }'].concat(parts).join('\n')
    + '\nthis.fast = fastCommand; this.reasoning = reasoningCommand;', sandbox);
  return { fast: () => { sandbox.fast(); return lines[lines.length - 1]; }, reasoning: (a) => { sandbox.reasoning(a); return lines[lines.length - 1]; } };
}

const NOTE = ' Note: Claude Code runs your messages on its own default effort, so this setting does not change them.';
// on claude-cli: the stored level is named, and no line promises a quicker, cheaper or longer-thinking message
A.eq(station('claude-cli', 'high').fast(), 'Reasoning effort: high → minimal. /reasoning high to put it back.' + NOTE, 'claude-cli /fast: no "quicker, cheaper replies"');
A.eq(station('claude-cli', 'minimal').fast(), 'Reasoning effort is already minimal.' + NOTE, 'claude-cli /fast at minimal: no "as fast as it gets"');
A.eq(station('claude-cli', 'high').reasoning('low'), 'Reasoning effort: high → low (for claude-cli).' + NOTE, 'claude-cli /reasoning <level>: no "Takes effect on your next message"');
A.eq(station('claude-cli', 'high').reasoning(''), 'Reasoning effort: high (for claude-cli). Set it with /reasoning none|minimal|low|medium|high|xhigh.' + NOTE,
  'claude-cli /reasoning status: no "faster and cheaper"');
A.eq(station('claude-cli', 'high').reasoning('high'), 'Reasoning effort is already high.' + NOTE, 'claude-cli /reasoning <same level>: the note');
// any other provider: the lines it always had
A.eq(station('openrouter', 'high').fast(), 'Reasoning effort: high → minimal — quicker, cheaper replies. /reasoning high to put it back.', 'openrouter /fast unchanged');
A.eq(station('openrouter', 'none').fast(), 'Already as fast as it gets — reasoning effort is none. /reasoning medium to let it think longer.', 'openrouter /fast at none unchanged');
A.eq(station('openrouter', 'high').reasoning('low'), 'Reasoning effort: high → low (for openrouter). Takes effect on your next message.', 'openrouter /reasoning <level> unchanged');
A.eq(station('openrouter', 'medium').reasoning(''), 'Reasoning effort: medium (for openrouter). Set it with /reasoning none|minimal|low|medium|high|xhigh — lower answers faster and cheaper, higher thinks longer first.',
  'openrouter /reasoning status unchanged');
A.eq(station('', 'high').fast(), 'Reasoning effort: high → minimal — quicker, cheaper replies. /reasoning high to put it back.', 'no provider picked: the line it always had');

// ---- the terminal (bin/lib/dashboard.js): the same commands, the same fact ----
const dash = fs.readFileSync(path.join(__dirname, '..', 'bin', 'lib', 'dashboard.js'), 'utf8');
const from = dash.indexOf('  const REASONING_LEVELS = ');
const fastAt = dash.indexOf('  function fastCommand(', from);
const to = dash.indexOf('\n  }\n', fastAt) + 4;
A.ok(from > 0 && fastAt > from && to > fastAt, 'fixture: the dashboard declares its dial commands in one block');
const block = dash.slice(from, to);
A.ok(/providerRegistry\.effortDialReachesRuns\(/.test(block) && !/'claude-cli'/.test(block), 'the terminal reads the registry fact, not its own copy of a provider name');
async function terminal(provider, effort, run) {
  const said = [];
  const agent = { id: 'agent', name: 'ADA', model: 'some-model', provider, reasoningEffort: effort, wireSource: 'agent' };
  const model = { state: { agents: new Map([['agent', agent]]) } };
  const client = { request: () => Promise.resolve({ ok: true, status: 200, json: { ok: true } }) };
  const api = new Function('model', 'ui', 'client', 'sayHere', 'unconfirmed', 'providerRegistry',
    block + '\nreturn { setEffort, reasoningCommand, fastCommand };')(model, { focus: 'agent' }, client, (cmd, lines) => said.push(lines.join(' ')), () => null, registry);
  await run(api);
  return said[said.length - 1];
}
(async () => {
  A.eq(await terminal('claude-cli', 'high', t => t.fastCommand()), 'Reasoning effort: high → minimal for ADA. /reasoning high puts it back.' + NOTE,
    'terminal claude-cli /fast: no "Takes effect on your next message"');
  A.eq(await terminal('claude-cli', 'high', t => t.reasoningCommand('low')), 'Reasoning effort: high → low for ADA.' + NOTE, 'terminal claude-cli /reasoning <level>: the note');
  A.eq(await terminal('claude-cli', 'high', t => t.reasoningCommand('')), 'Reasoning effort: high. Set it with /reasoning none|minimal|low|medium|high|xhigh.' + NOTE,
    'terminal claude-cli /reasoning status: no "faster and cheaper"');
  A.eq(await terminal('claude-cli', 'minimal', t => t.fastCommand()), 'Reasoning effort is already minimal.' + NOTE, 'terminal claude-cli /fast at minimal: no "as fast as it gets"');
  A.eq(await terminal('claude-cli', 'low', t => t.reasoningCommand('low')), 'Reasoning effort is already low.' + NOTE, 'terminal claude-cli /reasoning <same level>: the note');
  // any other provider: the lines it always had
  A.eq(await terminal('openrouter', 'high', t => t.fastCommand()), 'Reasoning effort: high → minimal for ADA. Takes effect on your next message. /reasoning high puts it back.', 'terminal openrouter /fast unchanged');
  A.eq(await terminal('openrouter', 'high', t => t.reasoningCommand('low')), 'Reasoning effort: high → low for ADA. Takes effect on your next message.', 'terminal openrouter /reasoning <level> unchanged');
  A.eq(await terminal('openrouter', 'medium', t => t.reasoningCommand('')), 'Reasoning effort: medium. Set it with /reasoning none|minimal|low|medium|high|xhigh — lower answers faster and cheaper, higher thinks longer first.',
    'terminal openrouter /reasoning status unchanged');
  A.eq(await terminal('openrouter', 'none', t => t.fastCommand()), 'Already as fast as it gets — reasoning effort is none. /reasoning medium lets it think longer.', 'terminal openrouter /fast at none unchanged');
  A.eq(await terminal('openrouter', 'low', t => t.reasoningCommand('low')), 'Reasoning effort is already low.', 'terminal openrouter /reasoning <same level> unchanged');

  // ---- the /fast description, in the COMMS palette and the shared slash registry: no promise any route can break ----
  const slash = require('../sidecar/slash.js');
  const fast = (slash.catalog({ recipes: [], skills: [] }).commands || []).find(c => c && c.name === 'fast');
  A.eq(fast && fast.desc, 'drop reasoning effort to minimal', 'the /fast description says what it does, not that replies get quicker or cheaper');
  A.ok(src.indexOf("Object.freeze({ name: 'fast', desc: 'drop reasoning effort to minimal', action: 'fast' }),") >= 0, 'the COMMS palette says the same');
  A.ok(!/quicker, cheaper replies'/.test(src.slice(src.indexOf("name: 'fast'"), src.indexOf("name: 'fast'") + 200)), 'and no palette line promises quicker, cheaper replies');

  A.report('effort-dial-copy.test');
})().catch(e => { console.log('FAIL: effort-dial-copy.test threw - ' + (e && e.stack || e)); process.exit(1); });
