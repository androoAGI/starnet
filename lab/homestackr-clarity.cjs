'use strict';

// Content-only migration: preserves geometry, identities, history and process state.
const fs = require('node:fs');
const path = require('node:path');
const WM = require('../frontend/app/worldmodel.js');
const { processes } = require('../frontend/app/homestackr-workflows.js');
const { PROCESSES } = require('../sidecar/colony/catalog.js');
const { client, inspect, edit } = require('./workflow.cjs');

function prepare(input, installation) {
  if (!installation || installation.installed !== true || installation.state !== 'committed' || installation.commitId !== input.colonyInstallation?.commitId) throw new Error('HomeStackR installation is not confirmed');
  const save = structuredClone(input), st = WM.create(structuredClone(save.station)), changed = [];
  for (const [id, definition] of Object.entries(processes)) {
    const mapping = installation.mappings?.[id];
    if (!mapping || mapping.businessUnitId !== 'homestackr' || mapping.steps?.length !== definition.steps.length || st.propById(mapping.intake)?.t !== 'intake') throw new Error('HomeStackR mapping mismatch: ' + id);
    for (const [i, fields] of definition.steps.entries()) {
      const prop = st.propById(mapping.steps[i]), role = PROCESSES[id].roles[i];
      if (!prop || prop.t !== 'bay' || prop.agentId !== 'colony_homestackr_' + role) throw new Error('HomeStackR step mismatch: ' + id);
      const original = {
        label: role,
        brief: 'Marke HomeStackR, Ablauf ' + id + '. Fachaufträge nur über die Business-Steuerung mit Versions-/Budgetnachweisen ausführen. Kein Versand, Upload oder Veröffentlichen. ' + (role === 'review' ? 'Unabhängig prüfen; nicht selbst überarbeiten oder menschliche Freigabe ersetzen.' : 'Nur belegte Quellen und freigegebene interne Werkzeuge verwenden.'),
        hands: 'Versionierte Artefaktreferenzen und konkrete Befunde; keine Selbstfreigabe.'
      };
      for (const key of ['label', 'brief', 'hands']) if (prop[key] !== original[key] && prop[key] !== fields[key]) throw new Error('Existing user instructions preserved; review manually: ' + prop.id + '.' + key);
      if (Object.keys(fields).some(key => prop[key] !== fields[key])) {
        edit(st, prop.id, fields);
        changed.push({ process: id, step: prop.id, label: fields.label });
      }
    }
  }
  const result = inspect(st);
  if (!result.valid) throw new Error('HomeStackR routing is invalid');
  if (changed.length) {
    // Do not reserialize unrelated legacy records (the model normalizes old props).
    for (const change of changed) {
      const target = save.station.props.find(p => p.id === change.step), edited = st.propById(change.step);
      for (const key of ['label', 'brief', 'hands']) target[key] = edited[key];
    }
    save.updatedAt = Math.max(Date.now(), Number(save.updatedAt || 0) + 1);
  }
  return { save, plan: result.plan, changed };
}

async function main(args) {
  const request = await client('http://127.0.0.1:8790', { allowLiveAuthoring: args.includes('--live-authoring') });
  const before = (await request('/api/save')).save;
  const installation = await request('/api/colony/installation');
  const prepared = prepare(before, installation);
  if (!args.includes('--apply') || !prepared.changed.length) return { applied: false, changed: prepared.changed, executionStarted: false };
  const dir = path.resolve(__dirname, '../.lab-state/authoring-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'before-homestackr-clarity-' + Date.now() + '.json'), JSON.stringify(before), { mode: 0o600, flag: 'wx' });
  const saved = await request('/api/save', prepared.save);
  try { await request('/api/routing', prepared.plan); }
  catch (error) { throw new Error('Descriptions saved, routing sync failed; reload the browser: ' + error.message); }
  return { applied: true, revision: saved.revision, changed: prepared.changed, executionStarted: false };
}
module.exports = { prepare, main };
if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
