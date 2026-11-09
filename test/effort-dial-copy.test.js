// effort-dial-copy.test.js — (W1.12) the effort dial's chat lines never promise an effect a message will not get.
// The Claude CLI is given no effort for a message (its run records say 'cli-default'), so on claude-cli /fast and
// /reasoning name the level they stored and say it does not change a message; on any other provider every line is the
// one it always was. The functions run for real (sliced from chat.js, stubbed Harness/App), not matched as source.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
const parts = ['function effortReachesModel(', 'function reasoningModelNote(', 'function reasoningLevelOf(', 'function reasoningCommand(', 'function fastCommand('].map(h => A.fnBody(src, h));
parts.forEach((p, i) => A.ok(p.length > 40 && p.length < 4000, 'sliced a whole function #' + i));
const levels = /const REASONING_LEVELS = \[[^\]]*\];/.exec(src);
const aliases = /const MEDIUM_ALIASES = \[[^\]]*\];/.exec(src);
A.ok(levels && aliases, 'the level lists are where the commands read them');

function station(prov, effort) {
  const lines = [];
  const store = { effort };
  const sandbox = {
    lines,
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

A.report('effort-dial-copy.test');
