/* node test/browser.tool-parity.test.js — every browser tool the module registers must ALSO be
   granted by CAP_REGISTRY, with matching scope and consent.

   THE TRAP THIS EXISTS FOR: a tool is registered in sidecar/tools/builtin/browser.js, unit-tested,
   even proven against real Chromium — and still withheld from every real agent, because
   resolveTools grants from CAP_REGISTRY and nothing pinned the two lists together. That is not
   hypothetical: browser.screenshot/hover/select/drag/viewport/forward/upload/network/tabs/
   tab_select/tab_close all shipped that way and were only caught by a LIVE agent run, where the
   model got back `WITHHELD: "browser.screenshot" ... its capability was not granted to this run`.

   capdrift.test.js guards the neighbouring seam (which PROPS map to which capability TYPES). It
   cannot see this one, because a missing TOOL row leaves the prop mapping perfectly intact. */
'use strict';
const A = require('./_assert.js');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

// The registry is keyed by objectType; flatten every row so a tool can be looked up by name.
const rows = [];
for (const objectType of Object.keys(CAP_REGISTRY)) {
  for (const row of (CAP_REGISTRY[objectType] || [])) rows.push(Object.assign({ objectType }, row));
}
const byTool = new Map(rows.map(r => [r.tool, r]));

/* Tools that deliberately carry NO capability grant. Real-screen desktop authority is not an
   ordinary run capability (see capability/capsummary.js) — these are stripped from every runOnce
   flow by enforceSyntheticOnly, so a grant row would be the lie, not the omission. */
const INTENTIONALLY_UNGRANTED = new Set(['computer.use', 'desktop.open']);

const fakeDriver = () => ({
  navigate: async u => u, snapshot: async () => [], click: async () => 'c', type: async () => 't',
  press: async () => 'p', scroll: async () => 's', back: async () => 'b', getText: async () => '',
  consoleLog: () => [], handleDialog: async () => ({}), screenshot: async () => '',
  hover: async () => 'h', drag: async () => 'd', selectOption: async () => ({ ok: true }),
  viewport: async () => '1x1', forward: async () => 'f', upload: async () => 'u',
  tabs: async () => [], selectTab: async () => '', closeTab: async () => '',
  testInput: async () => '', testEval: async () => '', testState: async () => ({})
});

(async () => {
  const B = makeBrowserTools({ driver: fakeDriver() });
  const tools = B.tools.filter(t => !INTENTIONALLY_UNGRANTED.has(t.name));
  A.ok(tools.length >= 20, 'the browser module registers a real tool surface (' + tools.length + ')');

  const missing = tools.filter(t => !byTool.has(t.name)).map(t => t.name);
  A.eq(missing, [], 'every registered browser tool is GRANTED by CAP_REGISTRY (missing => withheld from real agents)');

  // A grant row that lies about scope or consent is its own bug: the registry row is what the
  // capability gate enforces, so a mismatch means the gate is stricter or looser than the tool says.
  for (const t of tools) {
    const row = byTool.get(t.name);
    if (!row) continue;
    A.eq(row.scope, t.scope, 'scope matches the tool definition for ' + t.name);
    A.eq(!!row.requiresConsent, !!t.requiresConsent, 'consent flag matches the tool definition for ' + t.name);
  }

  // And the reverse: a registry row naming a browser tool that no longer exists is dead weight that
  // would silently grant nothing.
  const live = new Set(B.tools.map(t => t.name));
  const stale = rows.filter(r => /^browser\./.test(r.tool) && !live.has(r.tool)).map(r => r.tool);
  A.eq(stale, [], 'no CAP_REGISTRY row names a browser tool that no longer exists');

  // The two capability families stay separate: the public web surface vs the localhost workbench.
  for (const t of tools) {
    const row = byTool.get(t.name);
    if (!row) continue;
    const expected = /^browser\.test_/.test(t.name) ? 'workbench' : 'web';
    A.eq(row.capId, expected, t.name + ' is granted by the ' + expected + ' capability');
  }

  /* Every browser.<name> the module's own text points an agent at must be a tool that exists. The eval refusal told
     agents to use "browser.test_eval", which was never registered (10-07). A failNote tag or the file's own name is
     not a tool mention; those few are listed here, and a hyphenated tag (browser.kill-tree) never matches. A name
     that ends a sentence ("use browser.test_eval.") still counts: only a dot followed by more name (a.b.c) is skipped. */
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'tools', 'builtin', 'browser.js'), 'utf8');
    const NOT_TOOLS = new Set(['browser.js', 'browser.orphans']);
    const mentioned = new Set();
    for (const m of src.matchAll(/\bbrowser\.[a-z_]+(?![\w-]|\.\w)/g)) mentioned.add(m[0]);
    const ghosts = Array.from(mentioned).filter(n => !live.has(n) && !NOT_TOOLS.has(n)).sort();
    A.eq(ghosts, [], 'every browser.* name browser.js mentions is a registered tool (no ghost tools in hints)');
  }

  A.report('browser.tool-parity.test');
})().catch(e => { console.log('FAIL: browser.tool-parity.test threw -- ' + (e && e.stack || e)); process.exit(1); });
