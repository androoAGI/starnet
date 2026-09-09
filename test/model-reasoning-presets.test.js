/* Presentation presets must never cap a model's top effort or rewrite saved exact settings. */
'use strict';
const A = require('./_assert.js');
const Dock = require('../frontend/app/modeldock.js');
const { reasoningPresetsFor: presets, reasoningPresetFor: selected, effortForPreset: choose } = Dock._internals;
const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const full = { provider: 'openrouter', reasoningEfforts: ['none', ...levels] };
A.eq(presets(full).map(p => [p.id, p.effort]),
  [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['max', 'max']],
  'four main presets keep the maximum effort reachable');
A.eq(presets({ provider: 'codex' }).map(p => p.effort), ['low', 'medium', 'high', 'xhigh'],
  'Codex fallback exposes four distinct levels and Max reaches xhigh');
A.eq(presets({ provider: 'custom', supportsReasoning: false }), [],
  'a model without adjustable reasoning does not acquire fake choices');
A.eq(selected('none', full), null, 'saved Off is not misrepresented as LOW');
A.eq(choose('unknown', 'xhigh', full), 'xhigh', 'unknown preset cannot mutate a supported saved effort');
A.eq(selected('minimal', full).id, 'low', 'minimal is displayed in the LOW range');
A.eq(selected('xhigh', full).id, 'high', 'xhigh stays below the true Max range');
A.eq(choose('low', 'minimal', full), 'minimal', 'reselecting LOW preserves saved minimal');
A.eq(choose('high', 'xhigh', full), 'xhigh', 'reselecting HIGH preserves saved xhigh');
A.eq(choose('max', 'xhigh', full), 'max', 'Max from xhigh still increases effort');
A.eq(choose('medium', 'xhigh', full), 'medium', 'explicitly choosing another preset applies its target');
A.eq(choose('low', 'none', full), 'low', 'LOW explicitly enables reasoning from Off');
A.eq(Dock.efforts.optionsFor(full), ['none', ...levels], 'Advanced and other pickers retain all exact levels');
A.eq(Dock.efforts.clamp('xhigh', full), 'xhigh', 'existing exact transport remains unchanged');
A.eq(presets({ provider: 'codex', reasoningEfforts: ['high', 'low', 'medium'] }).map(p => [p.id, p.effort]),
  [['low', 'low'], ['medium', 'medium'], ['max', 'high']], 'limited model never gets a duplicate fourth option');

// Exercise every sparse capability set, including unordered metadata and optional Off.
for (let mask = 0; mask < (1 << levels.length); mask++) {
  for (const withOff of [false, true]) {
    const available = levels.filter((_, i) => mask & (1 << i));
    if (!available.length && !withOff) continue;
    const exact = (withOff ? ['none', ...available] : available).slice().reverse();
    const item = { provider: 'custom', reasoningEfforts: exact };
    const before = JSON.stringify(item);
    const choices = presets(item);
    A.eq(choices.length, Math.min(4, available.length), 'at most four genuine choices: ' + mask + '/' + withOff);
    A.eq(new Set(choices.map(p => p.effort)).size, choices.length, 'no duplicate levels: ' + mask);
    A.ok(choices.every(p => p.effort !== 'none' && exact.includes(p.effort)), 'main options are supported and never Off: ' + mask);
    A.ok(choices.every((p, i) => !i || levels.indexOf(p.effort) > levels.indexOf(choices[i - 1].effort)), 'preset strength strictly increases: ' + mask);
    if (available.length) {
      A.eq(choices[choices.length - 1].effort, available[available.length - 1], 'Max always reaches the declared ceiling: ' + mask);
      A.eq(choices[choices.length - 1].id, 'max', 'highest option is visibly Max: ' + mask);
    }
    for (const effort of exact) {
      const range = selected(effort, item);
      if (range) A.eq(choose(range.id, effort, item), effort, 'highlighted range preserves exact value: ' + mask + '/' + effort);
      else A.eq(effort, 'none', 'only Off lacks a primary selection: ' + mask);
      for (const p of choices) A.ok(exact.includes(choose(p.id, effort, item)), 'selection never sends an unsupported level: ' + mask + '/' + effort + '/' + p.id);
      if (available.length) A.eq(choose('max', effort, item), available[available.length - 1], 'Max cannot cap a saved effort: ' + mask + '/' + effort);
    }
    A.eq(JSON.stringify(item), before, 'capability metadata is never mutated: ' + mask);
  }
}
// Run the real outside-click wiring. A render detaches the clicked control before document bubbling.
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/modeldock.js'), 'utf8');
const listeners = {};
let closes = 0;
const dock = { contains: () => false };
const toggle = { contains: () => false, addEventListener() {} };
const context = {
  wired: false, open: true,
  el: id => id === 'model-dock' ? dock : id === 'model-dock-toggle' ? toggle : null,
  document: { addEventListener: (type, fn) => { listeners[type] = fn; } },
  showTip() {}, hideTip() {}, closeDock: () => closes++
};
vm.runInNewContext(A.fnBody(source, '  function wire()') + '\nwire();', context);
listeners.click({ target: {}, composedPath: () => [{}, dock] });
A.eq(closes, 0, 'a detached reasoning button keeps the menu open through its original event path');
listeners.click({ target: {}, composedPath: () => [{}, toggle] });
A.eq(closes, 0, 'the toggle also remains an inside click');
listeners.click({ target: {}, composedPath: () => [{}] });
A.eq(closes, 1, 'a genuine outside click still closes');
listeners.keydown({ key: 'Escape' });
A.eq(closes, 2, 'Escape still closes the selector');
A.report('model-reasoning-presets.test');
