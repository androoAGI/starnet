'use strict';
// Completely isolated visual/migration fixture. Not the user's running lab and
// not a live pilot. The local provider refuses every generation request.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WM = require('../frontend/app/worldmodel.js');
const { create } = require('./workflow.cjs');
async function main() {
  const dir = fs.mkdtempSync('/tmp/opencode/colony-native-preview-');
  const doc = structuredClone(require('../dev/fixtures/seed-workspace/agent.save.json').doc);
  const world = WM.create(WM.starterDoc()), spec = require('./fixtures/lifestruct.json');
  create(world, spec, new Set(spec.steps.map(s => s.agentId)));
  doc.agent.name = 'Lifestruct · Vorschau'; doc.agent.provider = 'custom'; doc.agent.model = 'fixture/model';
  doc.agent.onboarded = true;
  doc.agents = [{ ...doc.agent, id: 'life_content', name: 'Lifestruct Content' }, { ...doc.agent, id: 'life_review', name: 'Lifestruct Review' }];
  doc.prov = 'custom'; doc.station = world.serialize(); doc._saveRevision = 1; doc.updatedAt = Date.now();
  fs.writeFileSync(path.join(dir, 'agent.save.json'), JSON.stringify({ version: 1, updatedAt: doc.updatedAt, doc }), { mode: 0o600 });
  const provider = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET') { console.error('UNEXPECTED_MODEL_REQUEST_REFUSED'); res.writeHead(403); return res.end('{"error":"fixture refuses generation"}'); }
    res.end(JSON.stringify({ data: [{ id: 'fixture/model', context_length: 128000, supported_parameters: ['tools'] }] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'guard.cjs'), path.resolve(__dirname, '../sidecar/index.js')], {
    cwd: path.resolve(__dirname, '..'), env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir,
      STARNET_WORKSPACES: dir, STARNET_PORT: '8794', STARNET_DEV: '1', STARNET_CRON_ENABLED: '0', STARNET_NIGHTSHIFT_ENABLED: '0',
      STARNET_LIVE_PRICES: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', LAB_LIVE: '1', LAB_ALLOW_HOSTS: '127.0.0.1',
      CUSTOM_OPENAI_KEY: 'fixture-not-real', CUSTOM_OPENAI_BASE_URL: 'http://127.0.0.1:' + provider.address().port + '/v1' }, stdio: 'inherit'
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { child.kill(signal); provider.close(); });
  child.on('exit', code => { provider.close(); process.exitCode = code || 0; });
  console.log('Isolated Colony native preview: http://127.0.0.1:8794 · ' + dir);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
