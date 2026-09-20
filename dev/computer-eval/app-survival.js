'use strict';
// Regression for cleanup accidentally killing apps launched for the Commander.
// WScript owns only this fresh, noninteractive sleep fixture; no user app is closed.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { connect, data } = require('../../sidecar/tools/builtin/cua-runtime');
(async () => {
  const dir = path.resolve('.qa_tmp/cua-production'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app-survival-' + randomUUID() + '.vbs');
  fs.writeFileSync(file, 'WScript.Sleep 120000\r\n');
  const conn = await connect({ binary: path.resolve(process.argv[2]), clock: { now: () => Date.now() } });
  let pid;
  try {
    const reply = await conn.call('launch_app', { path: path.join(process.env.SystemRoot, 'System32/wscript.exe'), additional_arguments: ['//B', '//Nologo', file] });
    assert.ok(!reply.isError, JSON.stringify(data(reply)));
    pid = data(reply).pid;
    assert.ok(Number.isInteger(pid) && pid > 0, 'driver reported the exact launched fixture process');
    process.kill(pid, 0);
    await conn.close();
    process.kill(pid, 0);
    console.log('PASS: app launched by CUA survives private runtime cleanup');
  } finally {
    await conn.close();
    if (pid) { try { process.kill(pid); } catch {} }
    fs.unlinkSync(file);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
