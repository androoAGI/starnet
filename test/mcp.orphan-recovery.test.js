/* node test/mcp.orphan-recovery.test.js - real Windows force-death -> next-boot MCP orphan reap. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const A = require('./_assert.js');
const { makeProcLedger } = require('../sidecar/procledger.js');
const { makeStdioTransport } = require('../sidecar/mcp/transport.stdio.js');
const { makeMcpClient } = require('../sidecar/mcp/client.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return true; await sleep(25); }
  return false;
}
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch (_) { return false; } }

async function ownerMode(dir) {
  const ledger = makeProcLedger({ fs, pathMod: path, file: path.join(dir, 'ledger.json'), clock: { now: () => Date.now() } });
  const transport = makeStdioTransport({
    userControlIsolated: true,
    command: process.execPath,
    args: [path.join(dir, 'server.js')],
    allowedCommands: [path.basename(process.execPath)],
    processEnv: { PATH: process.env.PATH || '' },
    ledger,
    // Fault injection: emulate a brokered child whose OS lifetime is independent of the sidecar.
    spawnImpl: (command, args, options) => cp.spawn(command, args, Object.assign({}, options, { detached: true })),
    timeoutMs: 2000
  });
  const client = makeMcpClient({ transport, timeoutMs: 2000 });
  await client.initialize();
  await ledger.pinIdentity(transport.childPid);
  fs.writeFileSync(path.join(dir, 'ready.json'), JSON.stringify({ ownerPid: process.pid, childPid: transport.childPid }));
  setInterval(() => {}, 1000);
}

if (process.argv[2] === '--owner') {
  ownerMode(process.argv[3]).catch(e => { console.error(e && e.stack || e); process.exit(2); });
} else (async () => {
  if (process.platform !== 'win32') {
    A.ok(true, 'Windows force-death proof is host-gated; portable ledger semantics are covered by procledger.test');
    return A.report('mcp.orphan-recovery');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-mcp-orphan-'));
  const server = path.join(dir, 'server.js');
  fs.writeFileSync(server, [
    "'use strict';",
    "const readline=require('readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line',line=>{let m;try{m=JSON.parse(line)}catch(_){return}if(m.id!=null&&m.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}}}})+'\\n')});",
    "setInterval(()=>{},1000);"
  ].join('\n'));
  let owner = null, childPid = 0;
  try {
    owner = cp.spawn(process.execPath, [__filename, '--owner', dir], { stdio: 'ignore', windowsHide: true });
    A.ok(await waitFor(() => fs.existsSync(path.join(dir, 'ready.json')), 15000), 'owner started and durably pinned the real MCP child');
    const ready = JSON.parse(fs.readFileSync(path.join(dir, 'ready.json'), 'utf8'));
    childPid = Number(ready.childPid);
    A.ok(childPid > 0 && alive(childPid), 'real stdio MCP child is alive before forced sidecar death');
    owner.kill('SIGKILL');
    await waitFor(() => !alive(ready.ownerPid), 5000);
    A.ok(alive(childPid), 'TerminateProcess-style owner death leaves the child orphaned for the proof');

    const nextBoot = makeProcLedger({ fs, pathMod: path, file: path.join(dir, 'ledger.json'), clock: { now: () => Date.now() } });
    const swept = await nextBoot.sweep();
    A.eq(swept.probeFailed, false, 'next-boot Windows ownership probe completed');
    // the summary says why a live child was not killed: reused, killFailed, gone and examined 0 otherwise all print the same line
    const summary = JSON.stringify(swept);
    A.eq(swept.killed, 1, 'next boot reaped exactly the owned MCP child ' + summary);
    A.ok(await waitFor(() => !alive(childPid), 5000), 'no MCP orphan remains after the next-boot sweep ' + summary);
  } finally {
    try { if (owner && alive(owner.pid)) owner.kill('SIGKILL'); } catch (_) {}
    if (childPid && alive(childPid)) {
      try { cp.spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch (_) {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('mcp.orphan-recovery');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
