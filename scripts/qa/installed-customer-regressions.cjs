'use strict';
// Reuse the real-provider-adapter/MCP scenarios against the actual installed bundle on the
// disposable Windows runner. Each SidecarFixture owns an isolated scratch station/profile.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw Error('Installed customer proof requires a disposable hosted Windows runner');
}
const root = path.resolve(__dirname, '../..');
const installed = path.dirname(process.env.EXE || '');
const canonical = p => path.resolve(p).toLowerCase();
if (!process.env.EXE || canonical(process.execPath) !== canonical(path.join(installed, 'node.exe'))) {
  throw Error('Run this proof with the installed Node runtime and EXE identity');
}
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const suite = process.argv[2];
if (!['saved-provider-fallback.e2e.test.js', 'delegated-connectors.e2e.test.js'].includes(suite)) throw Error('Unknown installed scenario');
const files = ['sidecar/index.js', 'sidecar/loop.js', 'sidecar/orchestration.js', 'sidecar/inputpolicy.js'];
const identities = {};
for (const file of files) {
  const actual = hash(path.join(installed, file));
  if (actual !== hash(path.join(root, file))) throw Error('Installed source differs: ' + file);
  identities[file] = actual;
}
const { SidecarFixture } = require(path.join(root, 'test/helpers/sidecar-fixture.js'));
const create = SidecarFixture.create;
SidecarFixture.create = options => create.call(SidecarFixture, { ...options, entry: path.join(installed, 'sidecar/index.js') });
console.log(JSON.stringify({ suite, executableSha256: hash(process.env.EXE), installedRuntimeSha256: hash(process.execPath), identities,
  scope: 'Installed Node and sidecar; isolated stations; controlled upstream providers and MCP, no customer account' }));
require(path.join(root, 'test', suite));
