'use strict';
require('./google-future-release.cjs');
// Synthetic provider for the sidecar and seeded UI acceptance checks. Never loaded
// by product code. No production network or Google account is used by these tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns');
const catalog = require('../../sidecar/mcp/catalog.js');
const hosts = new Set(['accounts.google.com', 'oauth2.googleapis.com', 'openidconnect.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com', 'docs.googleapis.com', 'sheets.googleapis.com']);
const lookup = dns.promises.lookup;
dns.promises.lookup = (host, options) => hosts.has(host) ? Promise.resolve([{ address: '142.250.1.1', family: 4 }]) : lookup(host, options);
const root = () => process.env.STARNET_WORKSPACES || process.env.SKYNET_WORKSPACES;
const marker = name => path.join(root(), name);
const originalRename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (/[\\/]connectors[\\/]state\.json$/.test(to) && fs.existsSync(marker('google-write-fail'))) throw Error('synthetic persistence failure');
  return originalRename.apply(this, arguments);
};
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (raw, opts = {}) => {
  const url = new URL(String(raw));
  if (!hosts.has(url.hostname)) return realFetch(raw, opts);
  if (url.hostname === 'oauth2.googleapis.com') {
    const form = new URLSearchParams(opts.body);
    const refreshing = form.get('grant_type') === 'refresh_token';
    const code = form.get('code') || '';
    const product = code.split(':')[0] || 'gmail';
    if (refreshing) {
      fs.writeFileSync(marker('google-refreshed'), 'yes');
      if (fs.existsSync(marker('google-revoked'))) return json({ error: 'invalid_grant' }, 400);
    } else {
      fs.writeFileSync(marker('google-exchange'), 'yes');
      if (fs.existsSync(marker('google-challenge'))) {
        const expected = fs.readFileSync(marker('google-challenge'), 'utf8');
        const actual = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (expected !== actual) return json({ error: 'invalid_grant' }, 400);
      }
      if (code.includes('hold')) {
        fs.writeFileSync(marker('google-held'), 'yes');
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(marker('google-release')) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      }
    }
    return json({ access_token: refreshing ? 'GOOGLE_REFRESHED_TEST' : 'GOOGLE_ACCESS_TEST',
      ...(code.includes('no-refresh') ? {} : { refresh_token: 'GOOGLE_REFRESH_TEST' }), token_type: 'Bearer', expires_in: 3600,
      scope: code.includes('partial') ? 'openid' : (catalog.get(product)?.staticOauth.scopes || catalog.get('gmail').staticOauth.scopes).join(' ') });
  }
  if (url.hostname === 'openidconnect.googleapis.com') return json({ sub: 'synthetic-account', email: 'google-fixture@example.invalid', email_verified: true });
  if (fs.existsSync(marker('google-revoked'))) return json({ error: { message: 'sensitive body must never enter logs' } }, 401);
  if (!String(opts.headers?.Authorization || '').startsWith('Bearer GOOGLE_')) return json({ error: 'unauthenticated' }, 401);
  fs.appendFileSync(marker('google-api-calls'), JSON.stringify({ method: opts.method || 'GET', path: url.pathname }) + '\n');
  if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'google-fixture@example.invalid', messagesTotal: 1, threadsTotal: 1 });
  if (url.pathname.endsWith('/messages')) return json({ messages: [{ id: 'message-1', threadId: 'thread-1' }] });
  if (url.pathname.includes('/messages/')) return json({ id: 'message-1', snippet: 'Synthetic message for acceptance testing.' });
  return json({ files: [], items: [], id: 'synthetic-result' });
};
