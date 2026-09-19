'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startOverseerProvider } = require('../test/helpers/overseer-provider.js');
const { allocatePort } = require('../test/helpers/sidecar-fixture.js');
(async () => {
  const provider = await startOverseerProvider({ workerDelay: 6000 });
  const profile = path.resolve('.dogfood/overseer/profile'); fs.mkdirSync(profile, { recursive: true });
  const port = Number(process.env.STARNET_PORT) || await allocatePort();
  const child = spawn(process.execPath, ['dev/seed.js', '--keep', '--workspace', path.resolve('.dogfood/overseer/workspace')], { windowsHide: true, stdio: 'inherit', env: {
    ...process.env, APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile,
    SKYNET_PORT: String(port), STARNET_PORT: String(port), SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + provider.server.address().port + '/api/v1'
  } });
  child.on('exit', () => provider.server.close());
  process.on('exit', () => { try { child.kill(); } catch (_) {} });
})().catch(e => { console.error(e); process.exitCode = 1; });
