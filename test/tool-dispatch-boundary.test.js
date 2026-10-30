'use strict';
const A = require('./_assert.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false };

(async () => {
  const calls = [];
  const registry = makeRegistry();
  registry.register({ impact: 'none',
    name: 'effect.write', schema, scope: 'write',
    run: async args => { calls.push(args.value); return 'wrote ' + args.value; }
  });

  const order = [];
  const allowed = await registry.dispatch({ id: 'c1', name: 'effect.write', args: { value: 'one' } }, {
    authorize: () => ({ ok: true }), canUse: () => ({ ok: true }),
    beforeToolExecute: async (call, tool) => { order.push('dispatch:' + call.id + ':' + tool.scope); }
  });
  A.ok(allowed.ok, 'a successful dispatch boundary allows the tool to run');
  A.eq(order, ['dispatch:c1:write'], 'boundary receives the exact authorized tool call');
  A.eq(calls, ['one'], 'tool runs exactly once after the boundary succeeds');

  const stopped = await registry.dispatch({ id: 'c2', name: 'effect.write', args: { value: 'two' } }, {
    authorize: () => ({ ok: true }), canUse: () => ({ ok: true }),
    beforeToolExecute: async () => ({
      ok: false, isError: true, summary: 'recovery-journal-failed', content: 'not started',
      control: { final: true, reason: 'error', text: 'stopped' }
    })
  });
  A.ok(stopped.isError && stopped.control.final, 'a refused dispatch boundary returns the host terminal result intact');
  A.eq(calls, ['one'], 'tool never runs when durable dispatch cannot be recorded');

  const thrown = await registry.dispatch({ id: 'c3', name: 'effect.write', args: { value: 'three' } }, {
    authorize: () => ({ ok: true }), canUse: () => ({ ok: true }),
    beforeToolExecute: async () => { throw new Error('disk failure'); }
  });
  A.eq(thrown.summary, 'dispatch-boundary-failed', 'an unexpected boundary exception is classified distinctly');
  A.ok(thrown.control && thrown.control.final, 'unexpected boundary failure still ends the run safely');
  A.eq(calls, ['one'], 'unexpected boundary exception cannot reach tool.run');

  const invalid = await registry.dispatch({ id: 'c4', name: 'effect.write', args: {} }, {
    authorize: () => ({ ok: true }), canUse: () => ({ ok: true }),
    beforeToolExecute: async () => { order.push('should-not-run'); }
  });
  A.ok(invalid.isError, 'schema failure still short-circuits');
  A.ok(order.indexOf('should-not-run') < 0, 'dispatch boundary runs only after authority and validation gates');

  A.report('tool-dispatch-boundary.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
