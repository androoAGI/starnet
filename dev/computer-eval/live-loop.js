'use strict';
// Replay chooses one read-only action; the tool, pixels and run loop are real.
const assert = require('node:assert/strict');
const { connect, makeDriver } = require('./cua-driver.js');
const { makeComputerTools } = require('../../sidecar/tools/builtin/computer.js');
const { makeImageWire } = require('../../sidecar/tools/builtin/imagewire.js');
const { makeReplayProvider } = require('../../sidecar/providers/replay.js');
const { makeCostEngine } = require('../../sidecar/cost.js');
const { runAgentLoop } = require('../../sidecar/loop.js');

async function run(binary, pid, windowId) {
  const conn = await connect({ binary, fullPower: true });
  try {
    const driver = makeDriver(conn, { pid, window_id: windowId });
    const tool = makeComputerTools({ driver, allowPhysicalInput: true, imageWire: makeImageWire() }).useTool;
    await assert.rejects(tool.run({ action: 'screenshot' }, {}), /Full Power/);
    const provider = makeReplayProvider({ turns: [[
      { type: 'tool_start', index: 0, id: 'capture-proof', name: 'computer.use' },
      { type: 'tool_args', index: 0, chunk: '{"action":"screenshot"}' },
      { type: 'done', finishReason: 'tool_calls' }
    ], [{ type: 'text', delta: 'Capture returned.' }, { type: 'done', finishReason: 'stop' }]] });
    const messages = [{ role: 'user', content: 'Capture the selected disposable evaluation document.' }];
    const events = [];
    const context = { unrestrictedHost: true, inputMode: 'full-power' };
    await runAgentLoop({
      messages, provider, emit: (name, data) => events.push({ name, data }),
      cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'cua-eval', runId: 'cua-eval',
      tools: [tool], limits: { maxIters: 4, grace: false }, toolImages: true,
      capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'cua-eval', room: 'office' },
      dispatch: async call => ({ ok: true, ...await tool.run(call.args || JSON.parse(call.argsRaw), context) })
    });
    const images = messages.filter(m => m.role === 'user' && Array.isArray(m.content)).flatMap(m => m.content).filter(p => p.type === 'image_url');
    assert.equal(images.length, 1, 'actual CUA screenshot must reach model transcript');
    const results = messages.filter(m => m.role === 'tool');
    assert.equal(results.length, 1);
    assert.match(results[0].content, /capture_after/);
    return { passed: true, imageTurns: images.length, toolResults: results.length, restrictedContextRejected: true, eventNames: events.map(e => e.name) };
  } finally { await conn.close(); }
}
if (require.main === module) run(process.argv[2], Number(process.argv[3]), Number(process.argv[4])).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { run };
