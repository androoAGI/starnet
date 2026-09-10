'use strict';
// Test process only: deterministic GitHub + MCP responses through the real sidecar routes.
const dns = require('node:dns');
const lookup = dns.promises.lookup;
const hosts = ['github.com', 'api.github.com', 'api.githubcopilot.com'];
dns.promises.lookup = function (host, options) {
  return hosts.includes(host) ? Promise.resolve([{ address: '93.184.216.34', family: 4 }]) : lookup.call(this, host, options);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (raw, options = {}) {
  const u = new URL(String(raw));
  if (!hosts.includes(u.hostname)) return originalFetch(raw, options);
  let result;
  if (u.pathname === '/login/device/code') result = { device_code: 'FIXTURE_DEVICE', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
  else if (u.pathname === '/login/oauth/access_token') result = { access_token: 'FIXTURE_ACCESS', refresh_token: 'FIXTURE_REFRESH', expires_in: 28800, scope: 'repo,read:org', token_type: 'bearer' };
  else if (u.pathname === '/user') result = { id: 42, login: 'fixture-user' };
  else {
    let msg = {}; try { msg = JSON.parse(options.body); } catch (_) {}
    if (msg.method && msg.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    result = { jsonrpc: '2.0', id: msg.id, result: msg.method === 'initialize' ?
      { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'github-fixture', version: '1' } } :
      { tools: [{ name: 'get_me', description: 'Fixture identity', inputSchema: { type: 'object', properties: {} } }] } };
  }
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
