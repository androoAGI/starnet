#!/usr/bin/env node
// Run in the release build before Tauri copies sidecar resources. The installed
// client JSON is native-app metadata, not a confidential web application secret.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { desktopClient, RELEASE_DEFERRED } = require('../sidecar/mcp/google-client.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'sidecar/mcp/google-client.json');
try {
  const raw = process.env.STARNET_GOOGLE_DESKTOP_CLIENT_JSON;
  if (RELEASE_DEFERRED) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    console.log('Google Workspace deferred from this release; publisher registration omitted.');
  } else if (!raw && process.argv.includes('--optional')) {
    // Never reuse a stale registration from a different build on a persistent runner.
    if (fs.existsSync(target)) fs.unlinkSync(target);
    console.log('Google sign-in unavailable in this internal build; no publisher registration supplied.');
  } else {
    if (!raw) throw new Error('STARNET_GOOGLE_DESKTOP_CLIENT_JSON must contain StarNet’s Google Desktop app registration');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { throw new Error('Google Desktop registration must be valid JSON'); }
    const client = desktopClient(parsed);
    // Strip unrelated project fields; only Google's installed client metadata ships.
    const output = JSON.stringify({ installed: { client_id: client.clientId, client_secret: client.clientSecret } });
    // Native client metadata is public. Bundled resources must remain readable
    // when an installer places the app under a different OS account.
    fs.writeFileSync(target, output + '\n', { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    if (fs.readFileSync(target, 'utf8').trim() !== output) throw new Error('Google registration staging read-back failed');
    console.log('StarNet Google Desktop registration staged and verified.');
  }
} catch (e) {
  console.error('Google sign-in release configuration failed: ' + e.message);
  process.exitCode = 1;
}
