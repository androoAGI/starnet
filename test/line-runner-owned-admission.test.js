/* Integration of the actual host's lineRunner admission adapter with the real line executor and RunTable.
   Routine hops stay visible and block their group through core execution; one completion releases only its own admission.
   The transport is held at runOnce, not a copied registry. Optional profile setup must unwind the same admission on failure. */
'use strict';
const A = require('./_assert');
const fs = require('fs');
const { makeRunTable } = require('../sidecar/run-table');
const { makeLineRunner } = require('../sidecar/routing/line-runner');
const source = fs.readFileSync(require.resolve('../sidecar/index'), 'utf8');
const match = source.match(/const lineRunner = LineRunner\.makeLineRunner\([\s\S]*?liveRuns: (\{[\s\S]*?\n  \} \}),\n  \/\/ Lazy closures/);
if (!match) throw new Error('actual host lineRunner admission adapter was not found');
const adapter = new Function('runTable', 'return (' + match[1] + ');');
const hop = { agentId: 'editor', text: 'approved handoff' };
const profile = { liveSource: 'cron', runId: () => 'routine-hop' };
const success = { reason: 'done', outcome: 'succeeded', text: 'accepted answer' };

(async () => {
  const table = makeRunTable({ now: () => 5 });
  const pending = [];
  const runner = makeLineRunner({ liveRuns: adapter(table), runOnce: () => new Promise(resolve => pending.push(resolve)) });
  const first = runner.hopRunner(profile)(hop);
  A.ok(table.has('routine-hop'), 'held routine hop is visible before core finishes');
  A.ok(table.groupBusy('editor'), 'held routine hop retains the original metadata group admission');
  A.eq(table.live().map(r => r.source), ['cron'], 'snapshot and drain see the routine source');
  const second = runner.hopRunner(profile)(hop);
  A.eq(table.size(), 1, 'same-id overlap joins one entry');
  pending.shift()(success);
  A.eq((await first).text, success.text, 'first hop returns only the accepted terminal text');
  A.ok(table.has('routine-hop') && table.groupBusy('editor'), 'first completion preserves the second admission');
  pending.shift()(success);
  await second;
  A.eq(table.size(), 0, 'last completion removes its entry');
  A.ok(!table.groupBusy('editor'), 'last completion releases its group admission');

  for (const failure of ['core', 'crate', 'history']) {
    let called = 0;
    const r = makeLineRunner({ liveRuns: adapter(table), runOnce: async () => { called++; throw new Error('core failed'); } });
    const p = Object.assign({}, profile);
    if (failure === 'crate') p.crate = { place: () => { throw new Error('crate failed'); } };
    if (failure === 'history') p.history = { load: () => [], append: () => { throw new Error('history failed'); } };
    let result;
    try { result = await r.hopRunner(p)(hop); }
    catch (e) { result = { error: e.message }; }
    A.ok(result.error.includes(failure + ' failed'), failure + ' failure is preserved');
    A.eq(table.size(), 0, failure + ' failure releases the owned admission');
    A.ok(!table.groupBusy('editor'), failure + ' failure releases group ownership');
    A.eq(called, failure === 'core' ? 1 : 0, failure + ' failure does not run later work');
  }

  // Legacy injected registries still balance add/remove. A returned lease always wins over remove-by-id.
  for (const owned of [false, true]) {
    let adds = 0, releases = 0, removes = 0;
    const r = makeLineRunner({ liveRuns: {
      add() { adds++; return owned ? () => { releases++; } : undefined; },
      remove() { removes++; }
    }, runOnce: async () => success });
    await r.hopRunner(profile)(hop);
    A.eq([adds, releases, removes], owned ? [1, 1, 0] : [1, 0, 1], owned ? 'exact admission release takes priority' : 'legacy injected registry is balanced');
  }
  A.report('line runner owned admission');
})().catch(e => { console.error(e.stack); process.exit(1); });
