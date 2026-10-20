'use strict';

/* Repairs lab-only boot state without touching station content.
   The UI can persist provider "starnet" (managed inference) after a failed model
   lookup. This lab has no managed account, so that state strands the boot on the
   RESUME screen. Pin the dev provider instead. Idempotent; keeps a backup. */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER = process.env.LAB_PROVIDER || 'custom';

function atomicWrite(file, text, mode) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

function repairSave(root) {
  const savePath = path.join(root, 'agent.save.json');
  if (!fs.existsSync(savePath)) return { changed: false, reason: 'no save' };
  const wrapper = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const doc = wrapper.doc;
  if (!doc || !doc.agent) return { changed: false, reason: 'no agent in save' };
  const before = { prov: doc.prov, agentProv: doc.agent.provider };
  const wrong = [doc.prov, doc.agent.provider].some(p => p && p !== PROVIDER);
  if (!wrong) return { changed: false, provider: doc.prov || null };
  const backup = savePath.replace(/\.json$/, '.before-provider-repair.json');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(wrapper, null, 2), { mode: 0o600, flag: 'wx' });
  const now = Date.now();
  doc.prov = PROVIDER;
  doc.agent.provider = PROVIDER;
  for (const agent of (Array.isArray(doc.agents) ? doc.agents : [])) {
    if (agent && agent.provider && agent.provider !== PROVIDER) agent.provider = PROVIDER;
  }
  doc._saveRevision = (Number(doc._saveRevision) || 0) + 1;
  doc.updatedAt = Math.max(now, Number(doc.updatedAt) || 0);
  wrapper.updatedAt = Math.max(now, Number(wrapper.updatedAt) || 0);
  wrapper.savedAt = now;
  atomicWrite(savePath, JSON.stringify(wrapper, null, 2));
  return { changed: true, from: before, to: PROVIDER, backup };
}

function repairRoster(root) {
  const file = path.join(root, 'agent.roster.json');
  if (!fs.existsSync(file)) return { changed: false };
  const roster = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  for (const agent of (Array.isArray(roster.agents) ? roster.agents : [])) {
    if (agent && agent.provider && agent.provider !== PROVIDER) { agent.provider = PROVIDER; changed = true; }
  }
  if (changed) atomicWrite(file, JSON.stringify(roster, null, 2));
  return { changed };
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '.lab-state', 'workspaces');
  const save = repairSave(root);
  const roster = repairRoster(root);
  console.log(JSON.stringify({ save, roster }, null, 2));
}

module.exports = { repairSave, repairRoster, PROVIDER };
