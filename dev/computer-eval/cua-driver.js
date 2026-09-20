'use strict';

// Evaluation-only adapter. Not registered in the shipping sidecar. The caller must
// already hold StarNet's Full Power authority; production consent is not replaced.
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { makeMcpClient } = require('../../sidecar/mcp/client.js');

function childEnv(source = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (source[key] != null) env[key] = source[key];
  }
  env.CUA_DRIVER_RS_TELEMETRY_ENABLED = '0';
  return env;
}
function unwrap(result) {
  if (result.isError) throw new Error((result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'));
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}
async function connect({ binary, fullPower, timeoutMs = 20000 }) {
  if (fullPower !== true) throw new Error('Evaluation launcher requires explicit Full Power');
  const env = childEnv();
  const socket = process.platform === 'win32' ? '\\\\.\\pipe\\starnet-cua-eval-' + randomUUID() : require('node:path').join(require('node:os').tmpdir(), 'sn-' + randomUUID() + '.sock');
  const session = 'starnet-eval-' + randomUUID();
  const errors = [];
  const start = (args) => {
    const child = spawn(binary, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', b => { errors.push(String(b)); if (errors.length > 20) errors.shift(); });
    return child;
  };
  const daemon = start(['serve', '--embedded', '--socket', socket, '--permission-mode', 'unrestricted', '--dangerously-bypass-approvals', '--no-overlay']);
  daemon.stdout.resume();
  let spawnError, proxy, client;
  daemon.on('error', e => { spawnError = e; });
  const cli = (args) => new Promise((resolve, reject) => execFile(binary, args, { env, windowsHide: true, timeout: 2500 }, (e, stdout) => e ? reject(e) : resolve(stdout)));
  async function close() {
    if (client) {
      try { await client.callTool('end_session', { session }); } catch {}
      client.close();
    }
    proxy?.kill();
    try { await cli(['stop', '--socket', socket]); } catch {}
    daemon.kill();
  }
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (spawnError) throw spawnError;
      if (daemon.exitCode !== null) throw new Error('CUA daemon exited: ' + errors.join(''));
      try { await cli(['status', '--socket', socket]); break; } catch {}
      if (Date.now() > deadline) throw new Error('CUA startup timeout: ' + errors.join(''));
      await new Promise(r => setTimeout(r, 150));
    }
    proxy = start(['mcp', '--embedded', '--socket', socket]);
    let onMessage, buffer = '';
    proxy.stdout.setEncoding('utf8');
    proxy.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 48 * 1024 * 1024) { client.close('CUA response too large'); return; }
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try { onMessage?.(JSON.parse(line)); } catch { client.close('Invalid CUA JSON-RPC'); }
      }
    });
    proxy.on('error', () => client?.close('CUA proxy failed'));
    proxy.stdin.on('error', () => client?.close('CUA proxy input closed'));
    proxy.on('exit', () => client?.close('CUA proxy exited'));
    client = makeMcpClient({ timeoutMs, transport: {
      send: message => new Promise((resolve, reject) => proxy.stdin.write(JSON.stringify(message) + '\n', e => e ? reject(e) : resolve())),
      onMessage: cb => { onMessage = cb; },
      close: () => proxy.kill()
    }});
    await client.initialize();
    const tools = await client.listTools();
    unwrap(await client.callTool('start_session', { session }));
    const scopedArgs = (name, args) => tools.find(t => t.name === name)?.inputSchema?.properties?.session ? { ...args, session } : args;
    return {
      tools, session, socket, errors, close,
      call: async (name, args = {}) => client.callTool(name, scopedArgs(name, args)),
      data: async (name, args = {}) => unwrap(await client.callTool(name, scopedArgs(name, args)))
    };
  } catch (error) { await close(); throw error; }
}

// Maps the existing injected-driver seam without widening the shipping tool schema.
// Coordinates are CUA window-local pixels, unlike the legacy virtual-desktop coordinates.
function makeDriver(connection, target) {
  if (!Number.isInteger(target?.pid) || target.window_id == null) throw new Error('An observed exact window target is required');
  const scope = { pid: target.pid, window_id: target.window_id };
  let lastState;
  let selectedToken;
  return {
    async capture() {
      selectedToken = null;
      const result = await connection.call('get_window_state', { ...scope });
      lastState = unwrap(result);
      const image = (result.content || []).find(c => c.type === 'image');
      if (!image) throw new Error('CUA returned no screenshot');
      return { data: image.data, mimeType: image.mimeType };
    },
    async observe() { selectedToken = null; lastState = await connection.data('get_window_state', { ...scope, include_screenshot: false }); return lastState; },
    selectElement(index) {
      const element = lastState?.elements?.find(e => e.element_index === index);
      if (!element?.element_token) throw new Error('Select an element from the latest observation');
      selectedToken = element.element_token;
    },
    async perform(action) {
      const args = { ...scope };
      if (selectedToken) args.element_token = selectedToken;
      selectedToken = null; // An action consumes its observation; callers must observe again.
      let name;
      switch (action.action) {
        case 'screenshot': return 'capture requested';
        case 'click': case 'double_click':
          name = action.action;
          if (!args.element_token) {
            if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new Error('Click requires an observed element or finite window-local coordinates');
            Object.assign(args, { x: action.x, y: action.y });
          }
          if (action.button) args.button = action.button;
          break;
        case 'type': name = 'type_text'; args.text = action.text; break;
        case 'key': name = 'press_key'; args.key = action.key; break;
        case 'hotkey': name = 'hotkey'; args.keys = action.keys; break;
        default: throw new Error('Evaluation adapter has not implemented: ' + action.action);
      }
      const result = await connection.data(name, args);
      if (result.refusal || result.effect === 'refused' || result.status === 'refused') throw new Error(JSON.stringify(result));
      // Preserve the driver's effect/verdict: dispatched does not mean accomplished.
      return JSON.stringify(result);
    },
    get lastState() { return lastState; }
  };
}
module.exports = { connect, makeDriver, unwrap, childEnv };
