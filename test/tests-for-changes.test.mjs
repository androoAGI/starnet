/* scripts/tests-for-changes.mjs — a change selects the tests that can see it.

   THE MISS THIS CLOSES: fc98fb777 changed sidecar/taskbrief-tools.js and the HTTP e2e
   test/ask-brief-before-approval.e2e.test.js went red, because only the module's own FAST test ran. That e2e names
   no module; it reaches taskbrief-tools only through the tool wire names brief_proceed and brief_ask. So rule (c)
   (tests naming a tool name the changed module registers, dotted or x_y wire form) is the one that must find it.

   This test asserts SELECTION only. The e2e itself is not run here (it boots a sidecar), and it is not used as proof
   of anything else. Nothing here spawns a browser or boots a sidecar. Red at 45e7ee302: the script does not exist. */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const A = require('./_assert.js');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const memo = new Map();
const rd = rel => { if (!memo.has(rel)) { const p = join(ROOT, rel); memo.set(rel, existsSync(p) ? readFileSync(p, 'utf8') : null); } return memo.get(rel); };
const listed = name => rd(name).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(s => s.split('|')[0].trim());

const E2E = 'test/ask-brief-before-approval.e2e.test.js';
const mod = await import('../scripts/tests-for-changes.mjs');
A.ok(typeof mod.selectTests === 'function', 'scripts/tests-for-changes.mjs exports a pure selectTests()');

// The real test estate: every file on a mandatory gate, with its text (the same input the CLI wrapper builds).
const files = [...new Set([...listed('test/fast.list'), ...listed('test/http.list')])].filter(f => existsSync(join(ROOT, f)));
const tests = files.map(file => ({ file, text: rd(file) }));
A.ok(tests.length > 1000, 'the gate lists give the selector a real estate to choose from (' + tests.length + ')');
A.ok(tests.some(t => t.file === E2E), 'the ask-brief e2e is on a gate list');

// ---- RED: the exact miss behind fc98fb777 ----
const t0 = Date.now();
const hit = mod.selectTests({ changed: ['sidecar/taskbrief-tools.js'], tests, read: rd });
A.ok(hit.selected.includes(E2E), 'changing taskbrief-tools.js selects the ask-brief e2e');
A.ok((hit.reasons[E2E] || []).includes('c'), 'it is selected through rule (c), the tool wire names (reasons: ' + JSON.stringify(hit.reasons[E2E]) + ')');
A.ok(!(hit.reasons[E2E] || []).includes('a') && !(hit.reasons[E2E] || []).includes('b'),
  'that e2e names no module and requires none, so (a) and (b) are not what found it');
A.ok(hit.selected.some(f => /taskbrief/.test(f) && !/e2e|http/.test(f)), 'the module\'s own fast tests are still selected (rule a)');
A.ok(hit.smoke.length > 0 && hit.selected.includes(hit.smoke[0]), 'the smoke fallback is always part of the selection');

// ---- PLANTED: with rule (c) disabled the red case fails ----
const noC = mod.selectTests({ changed: ['sidecar/taskbrief-tools.js'], tests, read: rd, disable: ['c'] });
A.ok(!noC.selected.includes(E2E), 'with rule (c) disabled the ask-brief e2e is no longer selected (the rule is the only path to it)');
A.ok(noC.selected.length > 0, 'disabling a rule never empties the selection (smoke stays)');

// ---- (c) is capped and ranked, never a flood ----
A.ok(hit.selected.length < 120, 'a tool-name change selects a bounded set, not the estate (' + hit.selected.length + ')');

// ---- LIVENESS: a change no rule knows still returns the smoke fallback, fast ----
const t1 = Date.now();
const none = mod.selectTests({ changed: ['docs/nothing.md'], tests, read: rd });
A.ok(none.selected.length > 0 && none.smoke.length > 0, 'an unknown change returns a non-empty smoke fallback');
A.eq(none.selected, none.smoke, 'with no rule matching, the selection is exactly the smoke fallback');
A.ok(Date.now() - t1 < 5000, 'the fallback comes back within 5 s');
A.ok(none.smoke.every(f => !/\.(?:http|e2e)\./.test(f)), 'the smoke fallback is cheap rule tests, not e2e');
const empty = mod.selectTests({ changed: [], tests, read: rd });
A.ok(empty.selected.length > 0, 'an empty change list still returns the smoke fallback');

// ---- (a) requires: a module required by a test selects that test; a test that only mentions the name in text does not ----
const fake = [
  { file: 'test/a.test.js', text: "const M = require('../sidecar/widget.js'); A.report('a');" },
  { file: 'test/b.test.js', text: "const x = 'widget'; A.report('b');" },
  { file: 'test/c.test.js', text: "const H = require('./helpers/wh.js'); A.report('c');" },
  { file: 'test/d.http.test.js', text: "fetch('/api/widgets/list'); A.report('d');" },
  { file: 'test/e.e2e.test.js', text: "call('widget_poke', {}); A.report('e');" },
  { file: 'test/f.test.js', text: "call('widget_poke', {}); A.report('f');" },
];
const fakeRead = rel => ({
  'sidecar/widget.js': "const tool = { name: 'widget.poke' }; app.get('/api/widgets/list', h);",
  'test/helpers/wh.js': "module.exports = require('../../sidecar/widget.js');",
}[rel] ?? null);
const f = mod.selectTests({ changed: ['sidecar/widget.js'], tests: fake, read: fakeRead });
A.ok(f.reasons['test/a.test.js'].includes('a'), 'rule (a): a test that requires the changed module is selected');
A.ok(f.reasons['test/c.test.js'].includes('a'), 'rule (a): a test that reaches the module through a helper is selected');
A.eq((f.reasons['test/b.test.js'] || []).filter(r => r !== 'd'), [], 'a fast test that only has the word in a string does not require the module (at most the smoke fallback)');
A.ok(f.reasons['test/d.http.test.js'].includes('b'), 'rule (b): an http test naming the module route string is selected');
A.ok(f.reasons['test/e.e2e.test.js'].includes('c'), 'rule (c): the wire form x_y of a registered tool name is found');
A.ok(f.reasons['test/f.test.js'] && f.reasons['test/f.test.js'].includes('c'), 'rule (c) also reaches a fast test that names the tool');

// ---- the CLI wrapper's git half is a separate, thin function ----
A.ok(typeof mod.changedFromGit === 'function', 'a CLI wrapper reads the change list from git diff --name-only');
A.ok(typeof mod.main === 'function', 'the module has a main() for the CLI');

// every selected file is a real test file
A.ok(hit.selected.every(f => existsSync(join(ROOT, f))), 'every selected path exists');
A.ok(Array.isArray(readdirSync(join(ROOT, 'test'))), 'estate sanity');
void t0;
A.report('tests-for-changes');
