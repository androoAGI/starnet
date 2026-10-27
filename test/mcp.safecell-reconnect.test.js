/* node test/mcp.safecell-reconnect.test.js — a Safe Cell stdio MCP connector after a Docker restart.
   The docker backend's `ready` cache was trusted by every path but a foreground exec: ensureReady answered
   reused:true without asking docker, and the manager's auto-reconnect never called it anyway — it went straight
   to makeTransport -> spawnStdio, a synchronous `docker exec -i` into the cell. After Docker Desktop restarts (no
   restart policy: the cell comes back STOPPED) every reconnect exec'd into a stopped container until the attempt
   cap, and Reload did the same. Now every connect awaits the host's prepareConnect, which index.js wires to
   ensureReady, and ensureReady re-checks a cached cell.
   REAL connector manager + REAL stdio transport + REAL docker environment backend; only the docker CLI is a
   stateful fake (it plays the containers and speaks MCP inside a running one). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const A = require('./_assert.js');
const { makeConnectorManager } = require('../sidecar/mcp/manager.js');
const { makeStdioTransport } = require('../sidecar/mcp/transport.stdio.js');
const { makeEnvironmentManager } = require('../sidecar/environment.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-safecell-reconnect-'));
  let cell = 'missing', label = '', intoStopped = 0;
  const servers = [];   // live MCP exec children
  // pid stays undefined on every fake child, so no teardown path can ever signal a real process
  const dockerSpawn = (file, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { setImmediate(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null); }); };
    const a = args || [];
    const done = (out, code) => setImmediate(() => { if (out) child.stdout.emit('data', Buffer.from(out)); child.emit('exit', code); child.emit('close', code); });
    child.stdin = { write() { return true; }, end() {} };
    if (a[0] === 'inspect') { if (cell === 'missing') done('Error: No such object\n', 1); else done((cell === 'running') + '\t' + label + '\tsc1\n', 0); }
    else if (a[0] === 'create') { label = a.find(x => /^ai\.starnet\.workspace=/.test(x)).split('=')[1]; cell = 'stopped'; done('cid\n', 0); }
    else if (a[0] === 'start') { cell = 'running'; done('started\n', 0); }
    else if (a[0] === 'exec' && cell !== 'running') {
      intoStopped++;
      setImmediate(() => { child.stderr.emit('data', Buffer.from('Error response from daemon: container 9c1 is not running\n')); child.emit('exit', 1); child.emit('close', 1); });
    } else if (a[0] === 'exec' && a[1] === '-i') {          // the MCP server, inside the running cell
      child.stdin = { write(line, enc, cb) {
        for (const raw of String(line).split('\n')) {
          let m; try { m = JSON.parse(raw); } catch (_) { continue; }
          if (!m || m.id == null) continue;
          const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'cell-mcp' } }
            : m.method === 'tools/list' ? { tools: [{ name: 'lookup', inputSchema: { type: 'object' } }] } : {};
          setImmediate(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')));
        }
        if (typeof cb === 'function') setImmediate(cb);
        return true;
      }, end() {} };
      servers.push(child);
    } else if (a[0] === 'exec') done(/starnet-ready/.test(a[a.length - 1]) ? 'starnet-ready' : '', 0);
    else done('', 0);
    return child;
  };
  const env = makeEnvironmentManager({ spawn: dockerSpawn, fs, pathMod: path, root, clock: { now: () => 0 },
    config: { backend: 'docker', dockerBin: 'dockerx', dockerImage: 'starnet-node:test' } });

  const timers = [];
  const mgr = makeConnectorManager({
    makeTransport: cfg => makeStdioTransport(Object.assign({}, cfg, { userControlIsolated: true, processEnv: {}, platform: 'linux',
      spawnImpl: (command, args, spawnOptions) => env.spawnStdio({ agentId: cfg.agentId, command, args, spawnOptions }) })),
    // the same hook index.js wires (pinned below): ready the Safe Cell before every connect, readiness swallowed
    prepareConnect: async cfg => { if (cfg.transport === 'stdio') { try { await env.ensureReady(cfg.agentId); } catch (_) { /* the transport reports "not ready" */ } } },
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeoutImpl: () => {},
    random: () => 0, reconnectBaseMs: 1000, reconnectMaxAttempts: 3, timeoutMs: 2000
  });
  const drain = async () => { const t = timers.shift(); if (t) await t.fn(); await new Promise(r => setTimeout(r, 20)); return !!t; };

  try {
    await env.ensureReady('sc1');   // the cell is up before the first connect (configure used to do exactly this)
    const first = await mgr.configure('cellmcp', { transport: 'stdio', command: 'npx', args: ['cell-mcp'], agentId: 'sc1' });
    A.eq(first.state, 'up', 'fixture: a Safe Cell stdio connector connects up (' + (first.error || '') + ')');
    A.eq(cell, 'running', 'fixture: its first connect created and started the cell');

    // Docker Desktop restarts: the exec child dies, the cell comes back STOPPED (no restart policy)
    cell = 'stopped';
    const dying = servers[servers.length - 1];
    dying.emit('exit', 137); dying.emit('close', 137);
    await new Promise(r => setTimeout(r, 20));
    A.eq(mgr.status('cellmcp').state, 'error', 'the connector honestly goes to error when its process dies');
    A.eq(timers.length, 1, 'and a reconnect is scheduled');

    await drain();
    A.eq(intoStopped, 0, 'the reconnect never execs into the stopped cell (' + intoStopped + ' execs refused as not running)');
    A.eq(cell, 'running', 'the reconnect started the cell again');
    A.eq(mgr.status('cellmcp').state, 'up', 'the connector is back up after one reconnect, not stuck until the attempt cap (' + (mgr.status('cellmcp').detail || '') + ')');

    // a manual Reload (refresh -> connect) after the cell stopped again revives it the same way
    cell = 'stopped';
    const reload = await mgr.refresh('cellmcp');
    A.ok(reload.ok && cell === 'running' && intoStopped === 0, 'a Reload after the cell stopped starts it and reconnects (' + JSON.stringify(reload) + ')');
  } finally {
    try { await mgr.close(); } catch (_) { /* teardown */ }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* tmp */ }
  }

  // THE HOST WIRING: index.js passes prepareConnect, readying the docker cell of a stdio connector through
  // executionEnvironment.ensureReady (index.js is never required here — it boots a real sidecar).
  const src = readSidecarSource();
  const at = src.indexOf('const connectors = makeConnectorManager({');
  const block = at >= 0 ? src.slice(at, src.indexOf('\n});', at)) : '';
  const hook = (block.match(/prepareConnect: async \(cfg\) => \{[\s\S]*?\n  \},/) || [''])[0];
  A.ok(/cfg\.transport !== 'stdio'/.test(hook) && /backendIdFor\(aid\) !== 'docker'/.test(hook) && /await executionEnvironment\.ensureReady\(aid\)/.test(hook),
    'index.js readies a Safe Cell stdio connector\'s docker cell inside every connect (prepareConnect -> ensureReady)');

  A.report('mcp.safecell-reconnect.test');
})().catch(e => { console.log('FAIL: mcp.safecell-reconnect.test threw - ' + (e && e.stack || e)); process.exit(1); });
