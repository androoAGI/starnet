/* node test/registry.tool-outcome.contract.test.js — a tool that RETURNS its own failure is a failed tool result
   (typed-outcomes lane, 2026-10-29).

   sidecar/tools/registry.js wrapped any returned object as ok:true and dropped a returned isError (audit B6: "the tool
   registry wraps any returned object as ok:true"). group.handoff / group.publish / group.read answered a refusal as
   { content: 'REFUSED: …', summary: 'refused', isError: true } and every surface keyed on the result read it as a success:
   the tool row, agent.tool_result, the run's toolsOk proof count, the loop guard, an ACP editor's red/green. The registry is
   the one seam every result passes, so the contract lives there: a returned { isError: true }, { ok: false } or
   { status: 'error' } is a failed result; a throw still is; a result that says nothing of the kind is unchanged. */
'use strict';
const A = require('./_assert.js');
const { sidecarSourceFiles } = require('./helpers/source.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop } = require('../sidecar/loop.js');

const call = (name, args, id) => ({ id: id || 'c1', name, args: args || {}, argsRaw: JSON.stringify(args || {}), parseError: null });
const tool = (name, run) => ({ name, description: name, capability: 'compute', scope: 'read', impact: 'none', schema: { type: 'object', properties: {} }, run });

(async () => {
  const reg = makeRegistry();
  // the exact refusal shape sidecar/group-sessions.js returns (read below, so this fixture cannot drift from it)
  reg.register(tool('refuses', async () => ({ content: 'REFUSED: Turn no longer active', summary: 'refused', isError: true })));
  reg.register(tool('okfalse', async () => ({ content: 'nothing matched', ok: false })));
  reg.register(tool('statuserr', async () => ({ content: 'the backend said no', status: 'error', summary: 'backend-refused' })));
  reg.register(tool('fine', async () => ({ content: 'all good', summary: 'fine' })));
  reg.register(tool('falsy', async () => ({ content: 'kept', isError: false, ok: true })));
  reg.register(tool('bare', async () => 'plain text'));
  reg.register(tool('throws', async () => { throw new Error('boom'); }));
  reg.register(tool('jsonok', async () => ({ content: JSON.stringify({ ok: false, declined: true }) })));   // a payload's own words are the tool's data

  const CASES = [
    ['refuses', false, 'refused', /^REFUSED: Turn no longer active$/],
    ['okfalse', false, 'error', /^nothing matched$/],
    ['statuserr', false, 'backend-refused', /^the backend said no$/],
    ['fine', true, 'fine', /^all good$/],
    ['falsy', true, 'ok', /^kept$/],
    ['bare', true, 'ok', /^plain text$/],
    ['throws', false, null, /boom/],
    ['jsonok', true, 'ok', /declined/]
  ];
  for (const [name, ok, summary, content] of CASES) {
    const r = await reg.dispatch(call(name), { agentId: 'a', runId: 'r' });
    A.eq([r.ok, r.isError], [ok, !ok], name + ': ok=' + ok + ', isError=' + !ok);
    if (summary) A.eq(r.summary, summary, name + ': summary ' + summary);
    A.ok(content.test(String(r.content)), name + ': its own content is kept: ' + JSON.stringify(r.content));
  }

  // the fixture is group-sessions' real shape
  const gs = (sidecarSourceFiles().find(f => f.rel === 'sidecar/group-sessions.js') || {}).text || '';
  A.ok(/catch \(e\) \{ return \{ content: 'REFUSED: ' \+ e\.message, summary: 'refused', isError: true \}; \}/.test(gs), 'group-sessions refuses with the { content, summary, isError:true } shape this test registers');

  // end to end through the real loop: the refusal reaches agent.tool_result as an error (never ok), and the model is told
  {
    const bus = A.makeBus();
    const seq = A.collectBus(bus, events.names());
    const emit = makeEmitter(bus, () => {});
    let turn = 0;
    const provider = { priceOf: () => null, contextLimit: () => 0, stream: async function* () {
      turn++;
      if (turn === 1) { yield { type: 'tool_start', index: 0, id: 't1', name: 'refuses' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'done', finishReason: 'tool_calls' }; return; }
      yield { type: 'text', delta: 'the peer refused' }; yield { type: 'done', finishReason: 'stop' };
    } };
    const dispatch = (c, meta) => reg.dispatch(c, Object.assign({ agentId: 'a', runId: 'r1' }, meta || {}));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'hand it off' }], provider, emit, dispatch, tools: reg.wireFormat(), model: 'm', agentId: 'a', runId: 'r1' });
    const results = seq.filter(e => e.name === 'agent.tool_result');
    A.eq(results.map(e => [e.payload.ok, e.payload.isError]), [[false, true]], 'the refused call is reported as a failed tool result');
    const toolMsg = (res.messages || []).find(m => m && m.role === 'tool');
    A.ok(toolMsg && /REFUSED/.test(String(toolMsg.content)), 'the model still reads the refusal');
    A.eq(res.reason, 'done', 'and the run goes on (a failed tool is not a failed run)');
  }

  A.report('registry.tool-outcome.contract.test');
})().catch(e => { console.error(e); process.exit(1); });
