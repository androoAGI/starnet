'use strict';
const A = require('./_assert.js');
(async () => {
  const { criteria, parseArgs } = await import('../scripts/qa/turn-identity-soak.mjs');
  const week = 7 * 24 * 60 * 60 * 1000, first = 1000;
  const bucket = (compared = 100) => ({ compared, byClass: {}, bytesBySub: {}, fitBoundaryMaxDepth: 0, degraded: {} });
  const soak = { state: 'open', resetAt: first, writeFailures: 0,
    releases: [{ app: '0.14.2', boots: 2, firstAt: first, lastAt: first + week }],
    agg: { '0.14.2': { 'window.shadow.desk': bucket() } } };
  const result = (s, release = '0.14.2', includes = []) => Object.fromEntries(criteria(s, release, includes).map(c => [c.name, c.pass]));
  A.ok(Object.values(result(soak)).every(Boolean), 'exact release can satisfy the selected ledger evidence');
  const later = structuredClone(soak); later.releases[0].app = '0.14.3'; later.agg = { '0.14.3': { 'window.shadow.desk': bucket() } };
  A.eq(result(later)['release boot span at least seven days'], false, 'later semver does not silently prove requested release span');
  A.eq(result(later)['at least 100 shadow desk comparisons'], false, 'later semver does not silently supply requested desk samples');
  A.ok(Object.values(result(later, '0.14.2', ['0.14.3'])).every(Boolean), 'explicit owner inclusion selects the additional exact bucket');
  const dirty = structuredClone(soak); dirty.agg['0.14.3'] = { 'window.shadow.desk': { ...bucket(), byClass: { unexplained: 1 } } };
  A.eq(result(dirty)['no unexplained divergence'], true, 'unselected release is outside the exact report');
  A.eq(result(dirty, '0.14.2', ['0.14.3'])['no unexplained divergence'], false, 'included release also contributes failures');
  const fallback = structuredClone(soak); fallback.agg['0.14.2']['window.shadow.-'] = { ...bucket(), byClass: { unexplained: 1 } };
  A.eq(result(fallback)['no unexplained divergence'], false, 'unknown-caller window failures cannot disappear from selected evidence');
  fallback.agg['0.14.2']['window.shadow.desk'].compared = 0;
  A.eq(result(fallback)['at least 100 shadow desk comparisons'], false, 'unknown caller cannot provide desk comparison samples');
  const reset = structuredClone(soak); reset.resetAt = first + 1;
  A.eq(result(reset)['release boot span at least seven days'], false, 'reset inside observed span invalidates the continuous span');
  const short = structuredClone(soak); short.releases[0].lastAt--;
  A.eq(result(short)['release boot span at least seven days'], false, 'short span does not round up');
  A.eq(parseArgs(['--base', 'http://localhost:1', '--release', '0.14.2', '--include-release', '0.14.3', '--include-release', '0.14.3', '--include-release', '0.14.4']).includeReleases,
    ['0.14.3', '0.14.4'], 'repeat inclusion is explicit and deduplicated');
  A.throws(() => parseArgs(['--base', 'http://localhost:1']), 'release remains mandatory');
  A.throws(() => parseArgs(['--release', '0.14.2']), 'base remains mandatory');
  A.throws(() => parseArgs(['--base', 'http://localhost:1', '--release', '0.14.2', '--include-later', 'true']), 'no implicit successor switch exists');
  A.report('turn-soak.qa');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
