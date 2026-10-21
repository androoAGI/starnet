'use strict';
const fs = require('node:fs'), path = require('node:path');
const { client } = require('./business-client.cjs');
async function main(args) {
  const request = await client(), before = await request('/api/colony');
  if (Object.values(before.tasks).some(t => t.activeAttempt)) throw new Error('An active business run prevents reconfiguration');
  const defaults = (await request('/api/colony/model-defaults')).models;
  const models = { ...defaults, ...before.configuration.models };
  const pilotFlag = args.indexOf('--pilot-model'), pilotModel = pilotFlag >= 0 ? args[pilotFlag + 1] : null;
  if (pilotModel) for (const role of ['research', 'editorial', 'design', 'review']) {
    const id = 'colony_lifestruct_' + role, wire = models[id] || defaults[id]; if (wire) models[id] = { ...wire, model: pilotModel };
  }
  const flag = args.includes('--visual-model') ? args.indexOf('--visual-model') : args.indexOf('--review-model'), reviewer = flag >= 0 ? args[flag + 1] : null;
  if (reviewer) for (const [id, wire] of Object.entries(models)) if (id.endsWith('_review') || id.endsWith('_design')) models[id] = { ...wire, model: reviewer };
  // The fixer is optional at runtime but must be configured before a hard-case escalation.
  // Reuse that brand's configured reviewer model; this configuration itself makes no model call.
  for (const brand of ['lifestruct', 'ashveil', 'homestackr']) {
    const source = models['colony_' + brand + '_review'] || models['colony_' + brand + '_editorial'];
    if (source) models['colony_' + brand + '_fixer'] = { provider: source.provider, model: source.model };
  }
  const config = { type: 'configuration.set', accountingMode: 'tokens', enabled: true, models, poolBudget: { usd: 0, tokens: 2000000, ms: 7200000 } };
  if (!args.includes('--apply')) return { applied: false, agents: Object.keys(models).length, reviewer, pilotModel, accountingMode: 'tokens', externalActionsEnabled: false };
  const backup = path.resolve(__dirname, '../.lab-state/authoring-backups/business-before-' + Date.now() + '.json');
  fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 }); fs.writeFileSync(backup, JSON.stringify(before), { mode: 0o600, flag: 'wx' });
  const synced = await request('/api/colony/command', { type: 'catalog.sync', expectedRevision: before.revision });
  const result = await request('/api/colony/command', { ...config, expectedRevision: synced.revision });
  return { applied: true, revision: result.revision, agents: Object.keys(models).length, reviewer, pilotModel, accountingMode: 'tokens', externalActionsEnabled: false, modelCalls: 0 };
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
