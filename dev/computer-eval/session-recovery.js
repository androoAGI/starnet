'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const runtime = require('../../sidecar/tools/builtin/cua-runtime');
const { makeCuaComputerTools } = require('../../sidecar/tools/builtin/cua-computer');
let opened = 0;
const tool = makeCuaComputerTools({
  allowPhysicalInput: true, binary: path.resolve(process.argv[2]), clock: { now: () => Date.now() },
  connect: async options => {
    const connection = await runtime.connect(options);
    if (++opened === 1) {
      const ended = await connection.call('end_session');
      assert.ok(!ended.isError, 'expire the exact private test session');
    }
    return connection;
  }
});
(async () => {
  const ctx = { unrestrictedHost: true, inputMode: 'full-power' };
  try {
    // Deliberately nonexistent target: this probe never captures or changes an app.
    await assert.rejects(tool.useTool.run({ action: 'get_window_state', parameters: { pid: 2147483647, window_id: 0 } }, ctx), /get_window_state again/);
    const next = await tool.useTool.run({ action: 'list_windows' }, ctx);
    assert.equal(JSON.parse(next.content).operation, 'list_windows');
    assert.equal(opened, 2, 'next observation opens a fresh private runtime');
    console.log('PASS real expired-session refusal, explicit re-observation guidance, and fresh connection');
  } finally { await tool.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
