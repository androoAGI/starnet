'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const state = path.join(root, '.lab-state');
const workspace = path.join(state, 'workspaces');
const home = path.join(state, 'home');
const argv = process.argv.slice(2);
/* LIVE is the default: the lab exists to test the real station, and in the old offline default NOT ONE provider
   card could be set up and NOT ONE model could run (every save answered "LAB_OFFLINE"). --offline keeps the
   silent posture for scripted authoring tests. */
const live = !argv.includes('--offline') && !/^(0|false|no|off)$/i.test(String(process.env.LAB_LIVE || '').trim());
const portArg = argv.find(a => /^\d+$/.test(a));
const port = Number(portArg || 8790);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid lab port');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
const savePath = path.join(workspace, 'agent.save.json');
if (!fs.existsSync(savePath)) {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'dev/fixtures/seed-workspace/agent.save.json'), 'utf8'));
  const now = Date.now();
  const doc = fixture.doc;
  doc.updatedAt = now;
  doc.agent.name = 'Lifestruct Analyst';
  doc.agent.model = 'lab/no-model';
  doc.agent.purpose = 'Offline test profile. No AI execution is enabled.';
  doc.agents = [
    { ...structuredClone(doc.agent), id: 'life_content', name: 'Lifestruct Content', color: '#96c7b4' },
    { ...structuredClone(doc.agent), id: 'life_review', name: 'Lifestruct Review', color: '#b4a7d6' }
  ];
  fixture.updatedAt = now;
  fixture.savedAt = now;
  fs.writeFileSync(savePath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, 'agent.roster.json'), JSON.stringify({ version: 1, agents: [doc.agent, ...doc.agents].map(a => ({
    agentId: a.id, name: a.name, model: 'lab/no-model', provider: 'openrouter',
    system: 'Offline test profile. Never run models, publish, or upload.'
  })) }, null, 2), { mode: 0o600 });
}
const env = {
  PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
  LANG: 'C.UTF-8', STARNET_WORKSPACES: workspace, STARNET_PORT: String(port),
  STARNET_DEV: '1', STARNET_DEFAULT_MODEL: 'lab/no-model', STARNET_FULL_ACCESS: '0',
  STARNET_LIVE_PRICES: '0', STARNET_CRON_ENABLED: '0', STARNET_NIGHTSHIFT_ENABLED: '0',
  STARNET_COLONY_LEGACY_BRANDS: '1',
  STARNET_CLOUD_URL: '', STARNET_CREDITS_URL: ''
};
// Live mode: real model calls. Outbound stays limited to the known provider hosts (the guard's default list),
// so a provider card can be set up and used without opening the lab to arbitrary network traffic.
env.LAB_LIVE = live ? '1' : '0';
if (live) {
  // Only an EXPLICIT list replaces the guard's default (every host StarNet's provider cards talk to).
  if (String(process.env.LAB_ALLOW_HOSTS || '').trim()) env.LAB_ALLOW_HOSTS = process.env.LAB_ALLOW_HOSTS;
  // OpenCode serves TWO endpoints, and they are not interchangeable:
  //   Go plan (the lab's setup):  https://opencode.ai/zen/go/v1        (chat + /models in the same base)
  //   pay-as-you-go:               https://opencode.ai/inference/openai/v1 (chat) with the catalog at /inference/v1/models
  // A GO key on the pay-as-you-go path has NO model access there ("Model access is disabled", measured
  // 2026-10-20) — so the lab points at the GO path, which also demands the x-opencode-session header
  // (StarNet sends one per conversation; the gateway answers 400 MissingSessionID without it).
  env.CUSTOM_OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1';
  env.OPENAI_COMPATIBLE_BASE_URL = 'https://opencode.ai/zen/go/v1';
  env.STARNET_DEFAULT_MODEL = process.env.LAB_MODEL || 'deepseek-v4.1-flash';
}
// A managed-provider value stranded in the save would boot into the RESUME screen.
const repair = require('./repair.cjs');
const repaired = { save: repair.repairSave(workspace), roster: repair.repairRoster(workspace) };
if (repaired.save.changed) console.log('[lab] repaired save provider -> ' + repaired.save.to);
console.log(`StarNet local lab: http://127.0.0.1:${port}\nIsolated state: ${state}`);
if (live) {
  const allowed = String(env.LAB_ALLOW_HOSTS || require('./guard.cjs').defaultAllowHosts().join(','));
  console.log('LIVE MODE — echte Modellaufrufe moeglich. Erlaubte Hosts: ' + allowed);
  console.log('Standardmodell: ' + env.STARNET_DEFAULT_MODEL + ' · Anbieter-Basis-URL: ' + env.CUSTOM_OPENAI_BASE_URL);
  console.log('Ein Anbieter-Schluessel wird gebraucht: SETTINGS -> PROVIDERS -> CUSTOM. Weiterer Host? Start mit LAB_ALLOW_HOSTS=' + allowed + ',<host>.');
  console.log('Kein Veroeffentlichen, keine Uploads. Nur im vertrauenswuerdigen Netz nutzen.');
} else {
  console.log('OFFLINE — keine Modelle, keine Schluessel, keine Uploads, keine ausgehenden Verbindungen, keine Unterprozesse.');
  console.log('Fuer einen benutzbaren Laborbetrieb: ohne --offline starten.');
}
const child = spawn(process.execPath, ['--require', path.join(__dirname, 'guard.cjs'), path.join(root, 'sidecar/index.js')], {
  cwd: root, env, stdio: 'inherit'
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code == null ? 0 : code));
