'use strict';

// Private native input transport. This is deliberately not an isolated MCP
// connector: the host must authorize computer.use before opening this runtime.
const cp = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { makeMcpClient } = require('../../mcp/client.js');

function childEnv(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (source[key] != null) env[key] = source[key];
  }
  env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0';
  return env;
}
function data(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
async function connect({ binary, signal, clock, timeoutMs = 20000 }) {
  if (!clock || typeof clock.now !== 'function') throw new Error('Computer runtime requires a host clock');
  if (signal?.aborted) throw new Error('Computer control cancelled');
  const env = childEnv();
  const socket = '\\\\.\\pipe\\starnet-cua-' + randomUUID();
  const session = 'starnet-' + randomUUID();
  let daemon, proxy, client, closed = false, closePromise, failure;
  const children = new Set();
  const launch = args => {
    const child = cp.spawn(binary, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    child.stderr.resume(); // Never log desktop content or arbitrary native diagnostics.
    child.on('error', () => { failure = new Error('Computer driver could not start'); client?.close(failure.message); });
    child.on('exit', () => { children.delete(child); if (!closed) { failure = new Error('Computer driver exited'); client?.close(failure.message); } });
    return child;
  };
  function terminate() {
    for (const child of children) {
      // Never taskkill /T: apps opened for the user may be descendants. Only
      // these directly spawned driver/proxy processes belong to this runtime.
      child.kill();
    }
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    signal?.removeEventListener('abort', abort);
    client?.close('Computer control closed');
    closePromise = (async () => {
      // Graceful private-daemon shutdown also closes its UIA helper. This must
      // not close applications the Commander asked us to open.
      try { await cli(['stop', '--socket', socket]); } catch {}
      terminate();
      await Promise.all([...children].map(child => new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 1000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      })));
    })();
    return closePromise;
  }
  const abort = () => { void close(); };
  signal?.addEventListener('abort', abort, { once: true });
  const cli = args => new Promise((resolve, reject) => cp.execFile(binary, args, { env, windowsHide: true, timeout: 1500, maxBuffer: 65536 }, (err, out) => err ? reject(err) : resolve(out)));
  try {
    const manifest = JSON.parse(await cli(['manifest']));
    if (manifest.binary_version !== '0.28.2') throw new Error('CUA version mismatch; install the supported 0.28.2 driver in Abilities');
    if (closed || signal?.aborted) throw new Error('Computer control cancelled');
    daemon = launch(['serve', '--embedded', '--socket', socket, '--permission-mode', 'unrestricted', '--dangerously-bypass-approvals', '--no-overlay']);
    daemon.stdout.resume();
    const deadline = clock.now() + timeoutMs;
    for (;;) {
      if (closed || signal?.aborted) throw new Error('Computer control cancelled');
      if (failure) throw failure;
      try { await cli(['status', '--socket', socket]); break; } catch {}
      if (clock.now() >= deadline) throw new Error('Computer driver startup timed out');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (closed) throw new Error('Computer control cancelled');
    proxy = launch(['mcp', '--embedded', '--socket', socket]);
    let onMessage, buffer = '';
    proxy.stdout.setEncoding('utf8');
    proxy.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 48 * 1024 * 1024) { client?.close('Computer response too large'); terminate(); return; }
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try { onMessage?.(JSON.parse(line)); }
        catch { client?.close('Invalid computer response'); terminate(); }
      }
    });
    proxy.stdin.on('error', () => client?.close('Computer transport closed'));
    client = makeMcpClient({ timeoutMs, transport: {
      send: message => new Promise((resolve, reject) => proxy.stdin.write(JSON.stringify(message) + '\n', e => e ? reject(e) : resolve())),
      onMessage: cb => { onMessage = cb; },
      close: () => {} // close() above reaps both the proxy and its private daemon.
    }});
    await client.initialize();
    const tools = await client.listTools();
    const started = await client.callTool('start_session', { session });
    if (started.isError) throw new Error('Computer session could not start');
    return {
      session, socket, close,
      async call(name, args = {}) {
        if (closed || failure) throw failure || new Error('Computer control closed');
        const tool = tools.find(t => t.name === name);
        if (!tool) throw new Error('Computer driver does not support ' + name);
        const scoped = tool.inputSchema?.properties?.session ? { ...args, session } : args;
        try { return await client.callTool(name, scoped); }
        catch (error) { await close(); throw new Error(error.message + '; outcome unknown. Observe again before deciding whether to retry.'); }
      }
    };
  } catch (error) { await close(); throw error; }
}
module.exports = { connect, childEnv, data };
