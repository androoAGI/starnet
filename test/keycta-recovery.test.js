'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
let provider = 'anthropic', model = 'claude-test', linked = true, busy = false, agentId = 'pops';
const lines = [], rows = [], controls = {};
const node = () => ({ removed: false, remove() { this.removed = true; } });
const banner = { hidden: true, dataset: {}, querySelector: s => controls[s] ||= { textContent: '' } };
let opened = 0;
const context = {
  module: { exports: {} }, setInterval: () => 1,
  document: { getElementById: id => id === 'key-cta' ? banner : null },
  App: { currentAgent: () => ({ id: agentId, name: 'POPS', onboarded: true }) },
  Harness: { getProv: () => provider, getModel: () => model, configured: () => linked, hasStoredCredential: () => false },
  ModelDock: { open: () => opened++ },
  Chat: {
    isBusy: () => busy,
    localLine(text) { const n = Object.assign(node(), { text }); lines.push(n); return n; },
    choices(items, pick) { const n = Object.assign(node(), { items, pick, dismiss() { this.remove(); } }); rows.push(n); return n; }
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/app/keycta.js'), 'utf8'), context);
const cta = context.module.exports;
cta.arm();
assert.match(lines[0].text, /no ANTHROPIC key/);
cta.refresh();
assert.equal(lines.length, 1, 'unchanged gaps do not spam the transcript');
provider = 'starnet'; model = '';
cta.refresh();
assert.equal(lines[0].removed, true, 'obsolete key text retired');
assert.equal(rows[0].removed, true, 'obsolete key buttons retired');
assert.equal(cta.gapOf().kind, 'nomodel');
assert.match(lines[1].text, /no model is selected for STARNET/);
rows[1].pick({ value: 'primary' });
assert.equal(opened, 1, 'model recovery opens the actual picker');
model = 'anthropic/test';
cta.refresh();
assert.equal(cta.gapOf(), null);
assert.equal(banner.hidden, true);
assert.equal(lines[1].removed, true);
assert.equal(rows[1].removed, true);
// Link loss must offer linking, not a nonexistent StarNet API key or a false ready claim.
linked = false; model = ''; cta.refresh();
assert.equal(cta.gapOf().kind, 'unlinked');
assert.match(rows[2].items[0].label, /LINK STARNET/);
// Retire stale statements even while another conversation is streaming; defer new chat prompts.
busy = true; linked = true; cta.refresh();
assert.equal(lines[2].removed, true);
assert.equal(lines.length, 3);
busy = false; cta.refresh();
assert.equal(lines.length, 4);
agentId = 'another'; cta.refresh();
assert.equal(lines[3].removed, true, 'focused-agent change retires the old prompt');
assert.equal(lines.length, 5);
model = 'anthropic/test'; cta.refresh();
assert.equal(banner.hidden, true);
console.log('keycta-recovery: provider switch, empty model, relink, busy and focus transitions passed');
