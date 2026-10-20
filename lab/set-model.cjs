'use strict';

/* Set one model/provider on the station default and every present agent.
   Configuration only: no key access, no provider probe, no model call. */
const fs = require('node:fs');
const path = require('node:path');
const { client } = require('./workflow.cjs');

const MODEL = String(process.env.LAB_MODEL || 'deepseek-v4.1-flash').trim();
const PROVIDER = String(process.env.LAB_PROVIDER || 'custom').trim();
const EFFORT = String(process.env.LAB_EFFORT || 'none').trim();

function apply(save) {
  if (!save || !save.agent) throw new Error('No station save');
  const next = structuredClone(save);
  const ids = new Set();
  const set = a => {
    if (!a || !a.id) return;
    ids.add(a.id);
    a.model = MODEL;
    a.provider = PROVIDER;
    a.reasoningEffort = EFFORT;
  };
  set(next.agent);
  if (Array.isArray(next.agents)) next.agents.forEach(set);
  next.prov = PROVIDER;
  next.reasoningEffort = EFFORT;
  next.updatedAt = Math.max(Date.now(), Number(next.updatedAt || 0) + 1);
  return { next, ids: [...ids] };
}

async function main(args) {
  const request = await client('http://127.0.0.1:8790', { allowLiveAuthoring: true });
  let current = (await request('/api/save')).save;
  const { next, ids } = apply(current);
  if (!args.includes('--apply')) return { applied: false, model: MODEL, provider: PROVIDER, agents: ids.length, revision: current._saveRevision };
  const dir = path.resolve(__dirname, '../.lab-state/authoring-backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'before-model-' + Date.now() + '.json'), JSON.stringify(current), { mode: 0o600, flag: 'wx' });
  const saved = await request('/api/save', next);   // server enforces the revision; no blind retry
  return { applied: true, model: MODEL, provider: PROVIDER, effort: EFFORT, agents: ids.length, revision: saved.revision,
    note: 'Reload the page and let the native roster sync. No model call was made.' };
}

module.exports = { apply, main, MODEL, PROVIDER };
if (require.main === module) main(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message })); process.exitCode = 1;
});
