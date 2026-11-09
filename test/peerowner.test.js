/* node test/peerowner.test.js — the served page hands its master token only to a process of the SAME OS user
   (sidecar/peerowner.js). Loopback TCP has no per-user ACL, so before 2026-10-10 any local account could read
   `GET /` and drive the owner's station. Pure parsers + the injected-dependency check, plus ONE real loopback
   round trip on this machine proving our own process is recognised (the owner is never locked out). */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');
const P = require('../sidecar/peerowner.js');

// ---- netstat: the CLIENT row (local = client endpoint, foreign = our port) names the PID ----
const NETSTAT = [
  'Active Connections', '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:8787         0.0.0.0:0              LISTENING       100',
  '  TCP    127.0.0.1:8787         127.0.0.1:52345        ESTABLISHED     100',
  '  TCP    127.0.0.1:52345        127.0.0.1:8787         HERGESTELLT     4242',
  '  TCP    127.0.0.1:52346        127.0.0.1:9999         ESTABLISHED     777',
  '  TCP    [::1]:52347            [::1]:8787             ESTABLISHED     888',
  '  UDP    127.0.0.1:52345        *:*                                    999'
].join('\r\n');
A.eq(P.parseNetstatPid(NETSTAT, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52345, serverPort: 8787 }), 4242, 'netstat: client row → its pid (localized state column ignored)');
A.eq(P.parseNetstatPid(NETSTAT, { clientAddress: '::ffff:127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52345, serverPort: 8787 }), 4242, 'netstat: an IPv4-mapped peer address matches the IPv4 row');
A.eq(P.parseNetstatPid(NETSTAT, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52346, serverPort: 8787 }), null, 'netstat: a row to ANOTHER server port is not our peer');
A.eq(P.parseNetstatPid(NETSTAT, { clientAddress: '::1', serverAddress: '::1', clientPort: 52347, serverPort: 8787 }), 888, 'netstat: IPv6 loopback row');
A.eq(P.parseNetstatPid(NETSTAT, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 8787, serverPort: 52345 }), 100, 'netstat: direction matters (local column is the client side)');
A.eq(P.parseNetstatPid('', { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 1, serverPort: 2 }), null, 'netstat: empty output → no pid');

// ---- tasklist: a match is a CSV row whose 2nd field is exactly the pid; the INFO line (any language) is not ----
A.eq(P.tasklistListsPid('"node.exe","4242","Console","1","50,212 K"\r\n', 4242), true, 'tasklist: CSV row with the pid → listed');
A.eq(P.tasklistListsPid('INFO: No tasks are running which match the specified criteria.\r\n', 4242), false, 'tasklist: INFO line → not listed');
A.eq(P.tasklistListsPid('"node.exe","42420","Console","1","50,212 K"', 4242), false, 'tasklist: a longer pid is not a prefix match');

// ---- /proc/net/tcp: uid of the socket whose LOCAL port is the client's and REMOTE port is ours ----
const PROC = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:2253 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1',
  '   1: 0100007F:CD39 0100007F:2253 01 00000000:00000000 00:00000000 00000000  1001        0 2 1',
  '   2: 0100007F:2253 0100007F:CD39 01 00000000:00000000 00:00000000 00000000  1000        0 3 1'
].join('\n');
A.eq(P.parseProcNetTcpUid(PROC, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52537, serverPort: 8787 }), 1001, '/proc/net/tcp: client socket uid (0xCD39=52537 → 0x2253=8787)');
A.eq(P.parseProcNetTcpUid(PROC, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52538, serverPort: 8787 }), null, '/proc/net/tcp: unknown client port → null');
const PROC6 = '  sl  local_address remote_address st tx rx tr tm retr uid\n   0: 0000000000000000FFFF00000100007F:CD39 0000000000000000FFFF00000100007F:2253 01 0:0 00:0 0 1002 0 4 1';
A.eq(P.parseProcNetTcpUid(PROC6, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52537, serverPort: 8787 }), 1002, '/proc/net/tcp6: IPv4-mapped loopback client');
const PROCLAN = '  sl  local_address rem_address st\n   0: 0A00000A:CD39 0100007F:2253 01 0:0 00:0 0 1003 0 5 1';
A.eq(P.parseProcNetTcpUid(PROCLAN, { clientAddress: '127.0.0.1', serverAddress: '127.0.0.1', clientPort: 52537, serverPort: 8787 }), null, '/proc/net/tcp: a non-loopback local address is never our peer');

// ---- lsof -F pu: owners other than ourselves ----
A.eq(P.parseLsofOwners('p100\nu501\nf12\np4242\nu501\nf20\n', 100), [{ pid: 4242, uid: 501 }], 'lsof: our own server socket is dropped, the client stays');
A.eq(P.parseLsofOwners('', 100), [], 'lsof: nothing visible → no owners');

// ---- the check itself, with injected lookups ----
// win32 basename: the injected exe paths are Windows paths ('C:\\W\\System32\\netstat.exe'), and POSIX path.basename
// does not split on '\\' — on the Linux CI gate every fake would miss and read as lookup-failed.
function fakeRun(map) { return async (exe, args) => { const k = path.win32.basename(exe); return map[k] ? map[k](args) : { ok: false, code: -1, stdout: '' }; }; }
const Q = { remoteAddress: '127.0.0.1', remotePort: 52345, localAddress: '127.0.0.1', localPort: 8787 };

(async () => {
  const winSame = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner', winSystemDir: 'C:\\W\\System32',
    run: fakeRun({ 'netstat.exe': () => ({ ok: true, stdout: NETSTAT }),
      'tasklist.exe': (a) => ({ ok: true, stdout: a.indexOf('USERNAME eq HOST\\owner') >= 0 && a.indexOf('PID eq 4242') >= 0 ? '"chrome.exe","4242","Console","1","1 K"' : 'INFO: none' }) }) });
  A.eq((await winSame(Q)).ok, true, 'win32: client owned by our user → token');

  let tasklistCalls = 0;
  const winOther = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner',
    run: fakeRun({ 'netstat.exe': () => ({ ok: true, stdout: NETSTAT }), 'tasklist.exe': () => { tasklistCalls++; return { ok: true, stdout: 'INFO: No tasks are running which match the specified criteria.' }; } }) });
  const o1 = await winOther(Q);
  A.eq([o1.ok, o1.reason, o1.pid], [false, 'other-user', 4242], 'win32: a process another account owns → withheld (other-user)');
  await winOther(Q);
  A.eq(tasklistCalls, 2, 'win32: a refusal is never cached (every load re-checks)');

  const winNoNetstat = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner', run: fakeRun({}) });
  A.eq((await winNoNetstat(Q)).reason, 'lookup-failed', 'win32: netstat unavailable → fail closed');
  const winGone = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner', run: fakeRun({ 'netstat.exe': () => ({ ok: true, stdout: '' }) }) });
  A.eq((await winGone(Q)).reason, 'peer-not-found', 'win32: connection not in the table → fail closed');
  const winSelf = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 4242, winUser: 'HOST\\owner', run: fakeRun({ 'netstat.exe': () => ({ ok: true, stdout: NETSTAT }) }) });
  A.eq((await winSelf(Q)).ok, true, 'win32: our own process fetching / is ourselves');

  // A PID identifies a current process, not a process generation. The OS may reuse a once-owned PID
  // for another account before any time-based cache expires, including on a different exact socket.
  let calls = 0, currentNetstat = NETSTAT, sameOwner = true, tasklistOk = true;
  const winFresh = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner', now: () => 1000, cacheMs: 15000,
    run: fakeRun({ 'netstat.exe': () => ({ ok: true, stdout: currentNetstat }), 'tasklist.exe': () => {
      calls++; return { ok: tasklistOk, stdout: sameOwner ? '"chrome.exe","4242","Console","1","1 K"' : '' };
    } }) });
  A.eq((await winFresh(Q)).ok, true, 'win32: current owner receives the token');
  await winFresh(Q);
  A.eq(calls, 2, 'win32: every page checks current ownership even for the same exact connection');
  currentNetstat = NETSTAT.replaceAll(':52345', ':52348'); sameOwner = false;
  const reused = await winFresh({ ...Q, remotePort: 52348 });
  A.eq([reused.ok, reused.reason], [false, 'other-user'], 'win32: recycled PID on another socket cannot borrow its previous owner verdict');
  A.eq(calls, 3, 'win32: a recycled PID is checked with tasklist inside the former cache window');
  sameOwner = true;
  A.eq((await winFresh({ ...Q, remotePort: 52348 })).ok, true, 'win32: a previous refusal does not poison a later proven owner');
  tasklistOk = false;
  A.eq((await winFresh({ ...Q, remotePort: 52348 })).reason, 'lookup-failed', 'win32: lookup failure after prior success still fails closed');

  const linSame = P.makePeerOwnerCheck({ platform: 'linux', uid: 1001, readFile: async (f) => f === '/proc/net/tcp' ? PROC : '' });
  A.eq((await linSame({ remoteAddress: '127.0.0.1', remotePort: 52537, localAddress: '127.0.0.1', localPort: 8787 })).ok, true, 'linux: same uid → token');
  const linOther = P.makePeerOwnerCheck({ platform: 'linux', uid: 1000, readFile: async (f) => f === '/proc/net/tcp' ? PROC : '' });
  A.eq((await linOther({ remoteAddress: '127.0.0.1', remotePort: 52537, localAddress: '127.0.0.1', localPort: 8787 })).reason, 'other-user', 'linux: another uid → withheld');

  // A local account may bind another 127/8 address with the SAME client port. The connection's complete
  // tuple decides ownership; a same-port row belonging to us must never authorize the foreign socket.
  const collided = PROC + '\n   3: 0200007F:CD39 0100007F:2253 01 0:0 00:0 0 1002 0 9 1';
  const linCollision = P.makePeerOwnerCheck({ platform: 'linux', uid: 1001, readFile: async f => f === '/proc/net/tcp' ? collided : '' });
  A.eq((await linCollision({ remoteAddress: '127.0.0.2', remotePort: 52537, localAddress: '127.0.0.1', localPort: 8787 })).reason,
    'other-user', 'linux: a foreign loopback address cannot borrow the same-port owner row');
  A.eq((await linCollision({ remoteAddress: '127.0.0.3', remotePort: 52537, localAddress: '127.0.0.1', localPort: 8787 })).ok,
    false, 'linux: an absent exact client address fails closed');
  const wrongServer = PROC.replace('0100007F:CD39 0100007F:2253', '0100007F:CD39 0200007F:2253');
  const linWrongServer = P.makePeerOwnerCheck({ platform: 'linux', uid: 1001, readFile: async f => f === '/proc/net/tcp' ? wrongServer : '' });
  A.eq((await linWrongServer({ remoteAddress: '127.0.0.1', remotePort: 52537, localAddress: '127.0.0.1', localPort: 8787 })).ok,
    false, 'linux: a connection to a different server address is not our peer');
  const closed = PROC.replace('CD39 0100007F:2253 01', 'CD39 0100007F:2253 06');
  const linClosed = P.makePeerOwnerCheck({ platform: 'linux', uid: 1001, readFile: async f => f === '/proc/net/tcp' ? closed : '' });
  A.eq((await linClosed({ remoteAddress: '127.0.0.1', remotePort: 52537, localAddress: '127.0.0.1', localPort: 8787 })).ok,
    false, 'linux: a TIME_WAIT row cannot authorize an established request');
  A.eq((await linSame({ remoteAddress: '127.0.0.1', remotePort: 52537, localPort: 8787 })).ok,
    false, 'linux: missing server address fails closed');
  const q6 = { clientAddress: '::1', serverAddress: '::1', clientPort: 52537, serverPort: 8787 };
  A.eq(P.parseProcNetTcpUid(PROC6, q6), null, 'linux: IPv4-mapped row cannot authorize an IPv6 loopback client');
  const ipv6 = PROC6.replaceAll('0000000000000000FFFF00000100007F', '00000000000000000000000001000000');
  A.eq(P.parseProcNetTcpUid(ipv6, q6), 1002, 'linux: exact IPv6 loopback tuple remains supported');
  A.eq(P.parseProcNetTcpUid(PROC6, { ...q6, clientAddress: '::ffff:127.0.0.1', serverAddress: '::ffff:127.0.0.1' }), 1002,
    'linux: IPv4-mapped socket spelling matches its exact mapped proc row');

  const macSame = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501, run: async () => ({ ok: true, code: 0, stdout: 'p100\nu501\nf12\nn127.0.0.1:8787->127.0.0.1:52345\np4242\nu501\nf20\nn127.0.0.1:52345->127.0.0.1:8787\n' }) });
  A.eq((await macSame(Q)).ok, true, 'darwin: client of our uid → token');
  const macHidden = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501, run: async () => ({ ok: false, code: 1, stdout: 'p100\nu501\n' }) });
  A.eq((await macHidden(Q)).reason, 'peer-not-found', 'darwin: a client lsof cannot see (another user) → withheld');
  const macOther = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501, run: async () => ({ ok: true, code: 0, stdout: 'p4242\nu502\nf20\nn127.0.0.1:52345->127.0.0.1:8787\n' }) });
  A.eq((await macOther(Q)).reason, 'other-user', 'darwin: another uid → withheld');

  const macUnrelated = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501,
    run: async () => ({ ok: true, code: 0, stdout: 'p4242\nu501\nf20\nn127.0.0.1:52345->127.0.0.1:9999\n' }) });
  A.eq((await macUnrelated(Q)).ok, false, 'darwin: a same-port socket to another server cannot authorize the request');
  const macUnproven = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501,
    run: async () => ({ ok: true, code: 0, stdout: 'p4242\nu501\n' }) });
  A.eq((await macUnproven(Q)).ok, false, 'darwin: owner without the exact connection name is unproven');
  const macMixed = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501,
    run: async () => ({ ok: true, code: 0, stdout: 'p4242\nu502\nf20\nn127.0.0.1:52345->127.0.0.1:9999\np9999\nu501\nf25\nn127.0.0.1:52345->127.0.0.1:8787\n' }) });
  A.eq((await macMixed(Q)).ok, true, 'darwin: an unrelated foreign socket does not hide the proven owner');
  const macOtherAddress = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501,
    run: async () => ({ ok: true, code: 0, stdout: 'p4242\nu501\nf20\nn127.0.0.2:52345->127.0.0.1:8787\n' }) });
  A.eq((await macOtherAddress(Q)).ok, false, 'darwin: a different client address cannot authorize the request');
  A.eq(P.parseNetstatPid(NETSTAT.replace('127.0.0.1:52345        127.0.0.1:8787', '127.0.0.1:52345        127.0.0.2:8787'),
    { clientAddress: '127.0.0.1', clientPort: 52345, serverAddress: '127.0.0.1', serverPort: 8787 }), null,
    'win32: a same-port socket to another server address is not the peer');

  A.eq((await P.makePeerOwnerCheck({ platform: 'sunos' })(Q)).ok, false, 'unknown platform → fail closed');
  A.eq((await P.makePeerOwnerCheck({ platform: 'sunos', trustAll: true })(Q)).ok, true, 'STARNET_TRUST_LOCAL_PEERS escape hatch');
  A.eq((await winSame({ remoteAddress: '127.0.0.1' })).ok, false, 'no ports on the socket → fail closed');

  // ---- final review B10: one retry with a longer limit; a proved answer lives as long as its connection, no longer ----
  {
    // a lookup that fails (a timeout on a loaded box) is run once more, with the longer limit, before the check gives up
    const seen = [];
    let netstatFails = 1, tasklistFails = 1;
    const winSlow = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner',
      run: async (exe, args, opts) => {
        const k = path.win32.basename(exe); seen.push(k + '@' + (opts && opts.timeoutMs));
        if (k === 'netstat.exe') return netstatFails-- > 0 ? { ok: false, code: -1, stdout: '' } : { ok: true, stdout: NETSTAT };
        return tasklistFails-- > 0 ? { ok: false, code: -1, stdout: '' } : { ok: true, stdout: '"chrome.exe","4242","Console","1","1 K"' };
      } });
    const slow = await winSlow(Q);
    A.eq([slow.ok, slow.reason], [true, 'same-user'], 'win32: a lookup that failed once passes on its retry');
    A.eq(seen, ['netstat.exe@5000', 'netstat.exe@15000', 'tasklist.exe@5000', 'tasklist.exe@15000'], 'win32: each failed tool is retried ONCE, with the longer limit');
    seen.length = 0; netstatFails = 2;
    A.eq((await winSlow(Q)).reason, 'lookup-failed', 'win32: a lookup that fails twice still fails closed');
    A.eq(seen, ['netstat.exe@5000', 'netstat.exe@15000'], 'win32: never more than one retry');
    seen.length = 0;
    const other = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner',
      run: async (exe, args, opts) => { const k = path.win32.basename(exe); seen.push(k + '@' + opts.timeoutMs); return k === 'netstat.exe' ? { ok: true, stdout: NETSTAT } : { ok: true, stdout: 'INFO: none' }; } });
    A.eq((await other(Q)).reason, 'other-user', 'win32: another account\'s process is refused');
    A.eq(seen, ['netstat.exe@5000', 'tasklist.exe@5000'], 'win32: a lookup that RAN is never retried (an answer, not a failure)');
    const macSeen = [];
    const macRetry = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501, run: async (exe, args, opts) => {
      macSeen.push(opts.timeoutMs);
      return macSeen.length === 1 ? { ok: false, code: -1, stdout: '' } : { ok: true, code: 0, stdout: 'p4242\nu501\nf20\nn127.0.0.1:52345->127.0.0.1:8787\n' };
    } });
    A.eq([(await macRetry(Q)).ok, macSeen], [true, [5000, 15000]], 'darwin: a failed lsof is retried once with the longer limit');
    const macNone = [];
    const macEmpty = P.makePeerOwnerCheck({ platform: 'darwin', selfPid: 100, uid: 501, run: async (exe, args, opts) => { macNone.push(opts.timeoutMs); return { ok: false, code: 1, stdout: '' }; } });
    A.eq([(await macEmpty(Q)).reason, macNone], ['peer-not-found', [5000]], 'darwin: lsof listing nothing (exit 1) is an answer, not retried');

    // the same CONNECTION (the server's socket object) reuses a proved answer; anything else is checked afresh
    let looks = 0, owner = true;
    const conn = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner',
      run: async (exe) => { const k = path.win32.basename(exe); if (k === 'tasklist.exe') looks++; return k === 'netstat.exe' ? { ok: true, stdout: NETSTAT } : { ok: true, stdout: owner ? '"chrome.exe","4242","Console","1","1 K"' : 'INFO: none' }; } });
    const sockA = { destroyed: false }, sockB = { destroyed: false };
    A.eq((await conn(Object.assign({ socket: sockA }, Q))).ok, true, 'socket: the owner is proved');
    owner = false;   // (a later lookup would refuse: only a reuse can still answer yes)
    const again = await conn(Object.assign({ socket: sockA }, Q));
    A.eq([again.ok, again.sameConnection, looks], [true, true, 1], 'socket: a later request on the SAME connection reuses the answer, no lookup');
    A.eq([(await conn(Object.assign({ socket: sockB }, Q))).reason, looks], ['other-user', 2], 'socket: a NEW connection on the same port is checked afresh');
    A.eq([(await conn(Object.assign({ socket: sockB }, Q))).reason, looks], ['other-user', 3], 'socket: a refusal is never kept');
    sockA.destroyed = true;
    A.eq([(await conn(Object.assign({ socket: sockA }, Q))).ok, looks], [false, 4], 'socket: a closed connection keeps nothing');
    A.eq([(await conn(Q)).ok, looks], [false, 5], 'no socket: every request is checked, as before');
    owner = true;
    const sockC = { destroyed: false };
    const both = await Promise.all([conn(Object.assign({ socket: sockC }, Q)), conn(Object.assign({ socket: sockC }, Q))]);
    A.eq([both.map(v => v.ok), looks], [[true, true], 6], 'socket: two checks on one connection share one lookup');
    let failing = true;
    const flaky = P.makePeerOwnerCheck({ platform: 'win32', selfPid: 100, winUser: 'HOST\\owner',
      run: async (exe) => (path.win32.basename(exe) === 'netstat.exe' && !failing) ? { ok: true, stdout: NETSTAT } : (failing ? { ok: false, code: -1, stdout: '' } : { ok: true, stdout: '"chrome.exe","4242","Console","1","1 K"' }) });
    const sockD = { destroyed: false };
    A.eq((await flaky(Object.assign({ socket: sockD }, Q))).reason, 'lookup-failed', 'socket: an unknown owner fails closed');
    failing = false;
    A.eq((await flaky(Object.assign({ socket: sockD }, Q))).ok, true, 'socket: …and is not kept, so the next request on it checks again');
    A.eq((await P.makePeerOwnerCheck({ platform: 'sunos' })(Object.assign({ socket: {} }, Q))).ok, false, 'socket: an unknown platform still fails closed');
  }

  // ---- REAL round trip on this OS: our own loopback client is recognised as the owner ----
  if (process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin') {
    const real = P.makePeerOwnerCheck({
      platform: process.platform, selfPid: process.pid, uid: (typeof process.getuid === 'function') ? process.getuid() : null,
      winUser: (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + os.userInfo().username,
      winSystemDir: path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32'),
      readFile: (f) => fsp.readFile(f, 'utf8'),
      run: (exe, args) => new Promise(r => execFile(exe, args, { windowsHide: true, timeout: 10000, maxBuffer: 16 << 20 },
        (e, so) => r({ ok: !e, code: e && typeof e.code === 'number' ? e.code : (e ? -1 : 0), stdout: String(so || '') })))
    });
    // SETTLES, never hangs: a client that fails to start or connect (AV/loopback filtering, a spawn failure under memory
    // pressure) used to leave the server holding the event loop until the gate's 50-minute kill, naming nothing. Now it
    // resolves a failing verdict that says why, and the assertion below fails on it (review tests-17).
    const ROUND_TRIP_MS = 45000;   // > the two 10 s lookups (netstat + tasklist) plus a child spawn on a loaded box
    const verdict = await new Promise((resolve) => {
      let done = false, timer = null, srv = null;
      const finish = (v) => {
        if (done) return;
        done = true; clearTimeout(timer);
        srv.close(() => {});
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
        resolve(v);
      };
      srv = http.createServer(async (req, res) => {
        const s = req.socket;
        const v = await real({ remoteAddress: s.remoteAddress, remotePort: s.remotePort, localAddress: s.localAddress, localPort: s.localPort });
        res.end('x'); finish(v);
      });
      timer = setTimeout(() => finish({ ok: false, reason: 'no verdict: the loopback round trip did not finish within ' + (ROUND_TRIP_MS / 1000) + ' s' }), ROUND_TRIP_MS);
      srv.listen(0, '127.0.0.1', () => {
        // a CHILD process is the client, so the peer pid is not our own (the netstat → tasklist path really runs)
        const port = srv.address().port;
        execFile(process.execPath, ['-e', "require('http').get('http://127.0.0.1:" + port + "/',r=>r.resume())"], { windowsHide: true, timeout: ROUND_TRIP_MS },
          (e, _so, se) => { if (e) finish({ ok: false, reason: 'loopback client failed: ' + (e.code || e.message) + ' ' + String(se || '').slice(0, 200) }); });
      });
    });
    A.eq([verdict.ok, verdict.reason], [true, 'same-user'], 'real loopback: a process of this OS user is recognised (owner never locked out) — got ' + JSON.stringify(verdict));
  }
  A.report();
})();
