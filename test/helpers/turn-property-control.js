'use strict';
/* Failure reproduction stays opt-in while the orchestrator owns a broad gate. A shrink child starts the
   named test from scratch, so every candidate has a fresh store, page, provider and (HTTP tier) sidecar. */
const { spawnSync } = require('node:child_process');
const legacyControl = process.env.TURN_PROP_MERGE === 'legacy';
const hasPrefix = process.env.TURN_PROP_PREFIX !== undefined;
const requestedWindow = process.env.TURN_PROP_WINDOW;
if (requestedWindow !== undefined && !['shadow', 'id'].includes(requestedWindow)) throw Error('invalid TURN_PROP_WINDOW');
const windowModes = requestedWindow ? [requestedWindow] : legacyControl ? ['shadow'] : ['shadow', 'id'];
function steps(full) {
  if (!hasPrefix) return full;
  const n = Number(process.env.TURN_PROP_PREFIX);
  if (!Number.isSafeInteger(n) || n < 0 || n > full) throw Error('invalid TURN_PROP_PREFIX');
  return n;
}
function failure(error, seed, trace, windowMode) {
  // Keep the assertion site, not random run ids or wall-clock values, as the replay failure identity.
  const site = String(error.stack || '').split('\n').find(line => /(?:turn-oracle|turn-identity\.property|turn-http-property-campaign|turn-http-fixture|page-model)\.?(?:http\.)?(?:test\.)?js:\d+/.test(line)) || '';
  return { seed, windowMode, trace: trace.slice(), op: trace[trace.length - 1] || 'setup', name: error.name, code: error.code || '', site: site.trim(), message: error.message,
    ...(error.recoveryEvidence ? { recoveryEvidence: error.recoveryEvidence } : {}) };
}
function reportFailure(error, seed, trace, file, windowMode) {
  const original = failure(error, seed, trace, windowMode);
  console.error('TURN_PROPERTY_FAILURE=' + JSON.stringify(original));
  console.error('reproduce: ' + (legacyControl ? 'TURN_PROP_MERGE=legacy ' : '') + (windowMode ? 'TURN_PROP_WINDOW=' + windowMode + ' ' : '') + 'TURN_PROP_SEED=' + seed + ' TURN_PROP_PREFIX=' + trace.length + ' node ' + file);
  if (process.env.TURN_PROP_SHRINK !== '1' || process.env.TURN_PROP_SHRINK_CHILD === '1') return;
  let best = trace.length;
  const same = candidate => candidate && candidate.op === original.op && candidate.name === original.name && candidate.code === original.code && candidate.site === original.site;
  // Greedily discard a trailing half, then smaller tails. A retained failure must be the same assertion.
  for (let cut = Math.floor(best / 2); cut >= 1; cut = Math.floor(cut / 2)) {
    while (best - cut >= 0) {
      const prefix = best - cut;
      // Let the fixture's own bounded route/start waits unwind and dispose its sidecar. Killing only this
      // child on a parent timeout could strand the sidecar grandchild before its finally block runs.
      const child = spawnSync(process.execPath, [file], { cwd: process.cwd(), encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024, env: Object.assign({}, process.env, { TURN_PROP_SEED: String(seed),
          TURNID_SEEDS: '1', TURN_HTTP_SEEDS: '1', TURN_PROP_PREFIX: String(prefix), TURN_PROP_SHRINK_CHILD: '1',
          ...(windowMode ? { TURN_PROP_WINDOW: windowMode } : {}) }) });
      const output = String(child.stdout || '') + '\n' + String(child.stderr || '');
      const line = output.split(/\r?\n/).find(value => value.startsWith('TURN_PROPERTY_FAILURE='));
      let candidate = null;
      if (line) try { candidate = JSON.parse(line.slice('TURN_PROPERTY_FAILURE='.length)); } catch (_) {}
      if (child.error || (child.status !== 0 && !candidate)) {
        console.error('shrink fixture failed; original prefix retained: ' + (child.error && child.error.message || output.slice(-2000)));
        return;
      }
      if (!same(candidate)) break;
      best = prefix;
    }
  }
  console.error('fresh-fixture shrunk failing prefix: ' + JSON.stringify({ seed, steps: best, trace: trace.slice(0, best), assertion: original.site }));
}
module.exports = { legacyControl, hasPrefix, windowModes, steps, reportFailure };
