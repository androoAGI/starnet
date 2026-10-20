'use strict';

// One-time takeover of the real local lab (127.0.0.1:8790). Run ONLY while the lab is
// stopped: one writer per workspace. Writes a private backup first, then the same
// fenced installation the sidecar uses. `--rollback COMMIT_ID` restores the backup state
// only when nothing newer was written since.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeInstallation } = require('../sidecar/colony/installation.js');
const { makeService } = require('../sidecar/colony/service.js');
const { prepare } = require('./colony-authoring.cjs');

const PORT = 8790;
const root = path.resolve(__dirname, '..');
const workspace = path.join(root, '.lab-state', 'workspaces');
const deps = { fs, path, root: workspace, now: () => Date.now(), newId: () => crypto.randomUUID() };
const bind = (state, installation) => require('../sidecar/colony/core.js').reduce(state, {
  type: 'installation.bind', expectedRevision: state.revision, installation
}, { now: Date.now(), id: installation.commitId }).state;

function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function main() {
  if (await listening(PORT)) throw new Error('LAB_RUNNING: stop the lab on 127.0.0.1:8790 first (only one writer)');
  const installation = makeInstallation(deps);
  const rollbackAt = process.argv.indexOf('--rollback');
  if (rollbackAt >= 0) return installation.rollback(process.argv[rollbackAt + 1]);
  const saveFile = path.join(workspace, 'agent.save.json');
  if (!fs.existsSync(saveFile)) throw new Error('NO_LAB_SAVE');
  const state = makeService(deps).read();
  const preview = installation.preview(state, prepare);
  const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  const dir = path.join(root, '.lab-state', 'authoring-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const labBackup = path.join(dir, 'before-colony-takeover-' + Date.now() + '.json');
  fs.writeFileSync(labBackup, JSON.stringify({
    save: read(saveFile), roster: read(path.join(workspace, 'agent.roster.json')), routing: read(path.join(workspace, 'routing.plan.json'))
  }), { mode: 0o600, flag: 'wx' });
  const status = installation.install(state, {
    expectedSaveRevision: preview.nativeSaveRevision, expectedStateRevision: state.revision, previewDigest: preview.previewDigest
  }, prepare, bind);
  return { installed: status.installed, commitId: status.commitId, backup: status.backup,
    labBackup: path.relative(root, labBackup), processPipelines: Object.keys(preview.prepared.mappings).length,
    rooms: preview.prepared.rooms };
}

main().then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; });
