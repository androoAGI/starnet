/* sidecar/peerowner.js — WHO is on the other end of a loopback connection? (2026-10-10 security pass)

   Why this exists. The served page (`GET /`) carries the per-launch master token so the browser UI, the `starnet`
   CLI and the ACP/MCP bridges can authenticate. Loopback TCP has NO per-user access control: any process on the
   machine — including one running under a DIFFERENT OS account (a second Windows user, a sandbox account, another
   login on a shared Linux box) — could connect, read the page and act as the owner. The Host pin and Origin list
   stop websites; they never stopped other local accounts.

   The fix is the loopback equivalent of SO_PEERCRED: before the token is put into a response, find the process
   that owns the CLIENT end of this TCP connection and require that it runs as the same OS user as the sidecar.
     win32  : `netstat -ano` maps the client's (address, port) to a PID; `tasklist /FI "PID eq N" /FI "USERNAME eq
              <us>"` lists it only when it is ours (a non-admin cannot even read another account's process owner,
              so a foreign process never matches).
     linux  : /proc/net/tcp{,6} carries the owning uid of every socket directly.
     darwin : `lsof -F pufn` on the client port; lsof run as a non-root user cannot see another user's sockets, so a
              foreign client yields no row.
   FAIL CLOSED: anything we cannot prove (lookup error, timeout, connection not found, unknown platform) withholds
   the token — the page still loads, says why, and cannot drive the station. A lookup tool that failed is run once more
   with a longer limit first, and a proved answer is kept for the life of its connection (final review B10). STARNET_TRUST_LOCAL_PEERS=1 is the owner's
   explicit escape hatch for an environment where the lookup cannot work (set in the owner's own process env —
   nothing a local stranger can reach).

   What this does NOT claim: a process running as the SAME user (including a command an agent was allowed to run)
   still passes. Same-user isolation is the OS's job (see apiauth.js THREAT MODEL).

     parseNetstatPid(text, { clientAddress, clientPort, serverAddress, serverPort }) -> pid | null
     tasklistListsPid(text, pid) -> boolean
     parseProcNetTcpUid(text, { clientAddress, clientPort, serverAddress, serverPort }) -> uid | null
     parseLsofOwners(text, selfPid, query?) -> [{ pid, uid }]
     makePeerOwnerCheck(deps) -> async ({ remoteAddress, remotePort, localAddress, localPort, socket? }) -> { ok, reason, pid? } */
'use strict';

function normAddr(a) {
  let s = String(a || '').trim();
  if (/^::ffff:/i.test(s)) s = s.slice(7);   // an IPv4-mapped peer on a dual-stack socket
  return s;
}
function endpointOf(addr, port) {
  const a = normAddr(addr);
  return (a.indexOf(':') >= 0 ? '[' + a + ']' : a) + ':' + Number(port);
}
// netstat prints `  TCP    127.0.0.1:52345   127.0.0.1:8787   ESTABLISHED   1234` — the state column is localized on
// some Windows builds, so only the two endpoints and the trailing PID are read.
function parseNetstatPid(text, q) {
  const local = endpointOf(q.clientAddress, q.clientPort).toLowerCase();
  const remote = endpointOf(q.serverAddress, q.serverPort).toLowerCase();
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 4 || !/^tcp/i.test(f[0])) continue;
    if (String(f[1]).toLowerCase() !== local) continue;
    if (String(f[2]).toLowerCase() !== remote) continue;
    const pid = Number(f[f.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}
// tasklist /FO CSV /NH prints `"node.exe","1234","Console","1","50,212 K"` per match, or an INFO line (localized)
// when nothing matched — so a match is a CSV row whose second field is exactly the PID.
function tasklistListsPid(text, pid) {
  const want = '"' + Number(pid) + '"';
  return String(text || '').split(/\r?\n/).some(l => { const f = l.split(','); return f.length > 2 && f[1] === want; });
}
function hexPort(p) { return ('0000' + Number(p).toString(16).toUpperCase()).slice(-4); }
// Linux prints each 32-bit address word little-endian. Only loopback addresses are accepted;
// IPv4 sockets may live in tcp6 as IPv4-mapped addresses. Do not collapse ::1 into 127.0.0.1:
// the same ports can belong to different users on different local addresses.
function procLoopbackAddresses(address) {
  const a = normAddr(address).toLowerCase();
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return ['00000000000000000000000001000000'];
  const octets = a.split('.');
  if (octets.length !== 4 || octets[0] !== '127' || octets.some(v => !/^\d{1,3}$/.test(v) || Number(v) > 255)) return [];
  const hex = octets.reverse().map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
  return [hex, '0000000000000000FFFF0000' + hex];
}
// /proc/net/tcp row: `sl local_address rem_address st tx:rx tr:tm retrnsmt uid ...`, addresses as HEXADDR:HEXPORT.
// The client end is the row whose LOCAL port is the client's port and whose REMOTE port is ours, on loopback.
function parseProcNetTcpUid(text, q) {
  const cp = hexPort(q.clientPort), sp = hexPort(q.serverPort);
  const client = procLoopbackAddresses(q.clientAddress), server = procLoopbackAddresses(q.serverAddress);
  if (!client.length || !server.length) return null;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 8 || f[3] !== '01') continue;   // only this established connection, never a stale TIME_WAIT row
    const loc = String(f[1]).toUpperCase().split(':'), rem = String(f[2]).toUpperCase().split(':');
    if (loc.length !== 2 || rem.length !== 2 || loc[1] !== cp || rem[1] !== sp) continue;
    if (!client.includes(loc[0]) || !server.includes(rem[0])) continue;
    const uid = Number(f[7]);
    if (Number.isInteger(uid) && uid >= 0) return uid;
  }
  return null;
}
// `lsof -F pufn` groups process pid/uid and each socket's numeric local->remote name. A port filter alone
// can also list a same-port socket belonging to an unrelated process: require the exact connection.
function parseLsofOwners(text, selfPid, q) {
  const out = []; let cur = null;
  String(text || '').split(/\r?\n/).forEach(l => {
    if (l.charAt(0) === 'p') { cur = { pid: Number(l.slice(1)), uid: null, sockets: [] }; out.push(cur); }
    else if (l.charAt(0) === 'u' && cur) cur.uid = Number(l.slice(1));
    else if (l.charAt(0) === 'n' && cur) cur.sockets.push(l.slice(1));
  });
  const endpoint = v => {
    const m = String(v || '').match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
    return m ? endpointOf(m[1].replace(/^\[|\]$/g, ''), m[2]).toLowerCase() : '';
  };
  const matches = row => !q || row.sockets.some(name => {
    const pair = name.replace(/\s+\([^)]*\)$/, '').split('->');
    return pair.length === 2 && endpoint(pair[0]) === endpointOf(q.clientAddress, q.clientPort).toLowerCase()
      && endpoint(pair[1]) === endpointOf(q.serverAddress, q.serverPort).toLowerCase();
  });
  return out.filter(r => Number.isInteger(r.pid) && r.pid !== Number(selfPid) && Number.isInteger(r.uid) && matches(r))
    .map(r => ({ pid: r.pid, uid: r.uid }));
}

/* deps: { platform, run(exe, args, { timeoutMs }) -> Promise<{ ok, code, stdout }>, readFile(path) -> Promise<string>, selfPid,
           uid, winUser, winSystemDir, trustAll, firstTimeoutMs?, retryTimeoutMs? }
   Check ownership for every new connection: a PID may be recycled for another user, so even a short-lived positive
   PID cache is not evidence about the current socket owner. Only the connection itself carries an answer (check below). */
const FIRST_LOOKUP_MS = 5000;    // each lookup tool's first limit
const RETRY_LOOKUP_MS = 15000;   // …and the one retry's, when the first failed or ran past it (final review B10)
function makePeerOwnerCheck(deps) {
  const d = deps || {};
  const platform = d.platform || process.platform;
  /* ONE RETRY, WITH A LONGER LIMIT (final review B10). On a busy Windows machine netstat and tasklist were timed at
     1.7-3.4 s each, and one that failed or ran past its 5 s limit withheld the owner's own key ("lookup-failed"). A lookup
     tool that failed is run once more with a longer limit before the check gives up; what it still cannot prove fails
     closed, as before. run(exe, args, { timeoutMs }) is the injected runner (index.js). */
  const firstMs = Number(d.firstTimeoutMs) > 0 ? Number(d.firstTimeoutMs) : FIRST_LOOKUP_MS;
  const retryMs = Number(d.retryTimeoutMs) > 0 ? Number(d.retryTimeoutMs) : RETRY_LOOKUP_MS;
  const ran = r => !!(r && r.ok);
  async function runTool(exe, args, usable) {
    const first = await d.run(exe, args, { timeoutMs: firstMs });
    if (usable(first)) return first;
    return d.run(exe, args, { timeoutMs: retryMs });
  }
  async function win(q) {
    const sys = d.winSystemDir || 'C:\\Windows\\System32';
    const ns = await runTool(sys + '\\netstat.exe', ['-ano'], ran);
    if (!ns || !ns.ok) return { ok: false, reason: 'lookup-failed' };
    const pid = parseNetstatPid(ns.stdout, q);
    if (!pid) return { ok: false, reason: 'peer-not-found' };
    if (pid === Number(d.selfPid)) return { ok: true, reason: 'same-user', pid };
    if (!d.winUser) return { ok: false, reason: 'lookup-failed', pid };
    const tl = await runTool(sys + '\\tasklist.exe', ['/FI', 'PID eq ' + pid, '/FI', 'USERNAME eq ' + d.winUser, '/FO', 'CSV', '/NH'], ran);
    if (!tl || !tl.ok) return { ok: false, reason: 'lookup-failed', pid };
    if (!tasklistListsPid(tl.stdout, pid)) return { ok: false, reason: 'other-user', pid };
    return { ok: true, reason: 'same-user', pid };
  }
  async function linux(q) {
    let uid = null;
    for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let t = ''; try { t = await d.readFile(f); } catch (_) { t = ''; }
      uid = parseProcNetTcpUid(t, q);
      if (uid != null) break;
    }
    if (uid == null) return { ok: false, reason: 'peer-not-found' };
    return uid === Number(d.uid) ? { ok: true, reason: 'same-user' } : { ok: false, reason: 'other-user' };
  }
  async function darwin(q) {
    // lsof exits 1 when it lists nothing — that is "no visible owner", not a tool failure (and not retried)
    const r = await runTool('/usr/sbin/lsof', ['-nP', '-iTCP:' + Number(q.clientPort), '-sTCP:ESTABLISHED', '-F', 'pufn'], x => !!(x && (x.ok || x.code === 1)));
    const rows = parseLsofOwners(r && r.stdout, d.selfPid, q);
    if (!rows.length) return { ok: false, reason: (r && (r.ok || r.code === 1)) ? 'peer-not-found' : 'lookup-failed' };
    return rows.every(x => x.uid === Number(d.uid)) ? { ok: true, reason: 'same-user', pid: rows[0].pid } : { ok: false, reason: 'other-user', pid: rows[0].pid };
  }

  async function checkNow(q) {
    const query = { clientAddress: q && q.remoteAddress, clientPort: q && q.remotePort, serverAddress: q && q.localAddress, serverPort: q && q.localPort };
    if (!query.clientPort || !query.serverPort) return { ok: false, reason: 'peer-not-found' };
    try {
      if (platform === 'win32') return await win(query);
      if (platform === 'linux') return await linux(query);
      if (platform === 'darwin') return await darwin(query);
      return { ok: false, reason: 'unsupported-platform' };
    } catch (_) { return { ok: false, reason: 'lookup-failed' }; }
  }

  /* A SAME-USER ANSWER LASTS AS LONG AS ITS CONNECTION, NO LONGER (final review B10). q.socket is the server's own object for
     this TCP connection (index.js passes req.socket). Its client end belongs to the process that was proved to run as us,
     and stays there while the connection lives, so a later request on the SAME connection (a page re-read, a reload over a
     kept-alive socket) reuses that answer instead of running the lookups again, and two checks on it share one run. The
     answer is keyed by that object in a WeakMap: it cannot outlive the connection or reach another one (a new connection,
     even on the same port, is a new socket and is checked afresh). It is never a PID cache — a PID can be handed to another
     account's process — and a refusal or a lookup that failed is never kept: it fails closed and is checked again. */
  const proven = new WeakMap();     // socket -> { pid } of its proved same-user owner
  const checking = new WeakMap();   // socket -> the check already running for it
  return async function check(q) {
    if (d.trustAll) return { ok: true, reason: 'trusted-by-env' };
    const sock = q && q.socket && typeof q.socket === 'object' ? q.socket : null;
    if (!sock) return checkNow(q);
    const known = proven.get(sock);
    if (known && !sock.destroyed) return { ok: true, reason: 'same-user', pid: known.pid, sameConnection: true };
    if (checking.has(sock)) return checking.get(sock);
    const running = checkNow(q);
    checking.set(sock, running);
    try {
      const r = await running;
      if (r && r.ok === true && r.reason === 'same-user' && !sock.destroyed) proven.set(sock, { pid: r.pid });
      return r;
    } finally { checking.delete(sock); }
  };
}

module.exports = { makePeerOwnerCheck, parseNetstatPid, tasklistListsPid, parseProcNetTcpUid, parseLsofOwners, endpointOf };
