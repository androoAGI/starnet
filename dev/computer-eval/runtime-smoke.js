'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const { connect, childEnv } = require('../../sidecar/tools/builtin/cua-runtime');
const binary = path.resolve(process.argv[2] || '.qa_tmp/cua-evaluation/driver/cua-driver.exe');
const status = socket => new Promise(resolve => cp.execFile(binary, ['status', '--socket', socket], { env: childEnv(), windowsHide: true, timeout: 2000 }, err => resolve(!err)));
(async () => {
  const ac = new AbortController(); let first, second;
  try {
    first = await connect({ binary, signal: ac.signal });
    second = await connect({ binary });
    assert.notEqual(first.socket, second.socket); assert.notEqual(first.session, second.session);
    assert.equal((await first.call('list_windows')).isError, undefined);
    ac.abort(); await first.close();
    assert.equal(await status(first.socket), false, 'cancelled private daemon is gone');
    assert.equal(await status(second.socket), true, 'other run remains independent');
    assert.equal((await second.call('list_windows')).isError, undefined);
    await second.close();
    assert.equal(await status(second.socket), false, 'normal completion reaps private daemon');
    console.log('PASS real CUA runtime: independent sessions, cancellation, continued second session, normal cleanup');
  } finally { await first?.close(); await second?.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
