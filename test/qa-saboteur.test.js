/* node test/qa-saboteur.test.js — pure locks for the EL-2 adversarial planner. */
'use strict';
const A = require('./_assert.js');
const S = require('../scripts/qa/saboteur.mjs');

const source = `const ROUTES = [
  { m: 'GET', exact: '/api/health', h: health },
  { m: 'POST', exact: '/api/save', h: save },
  { m: ['GET', 'POST'], exact: '/api/both', h: both },
  { m: 'GET', prefix: '/api/not-literal', h: nope }
];`;
const routes = S.parseLiteralApiRoutes(source);
A.eq(routes, [
  { method: 'GET', path: '/api/health' },
  { method: 'POST', path: '/api/save' },
  { method: 'GET', path: '/api/both' },
  { method: 'POST', path: '/api/both' }
], 'literal exact-route inventory preserves methods and excludes prefix matchers');

const planA = S.buildAttackPlan(routes, 42, ['auth', 'origin']);
const planB = S.buildAttackPlan(routes, 42, ['auth', 'origin']);
A.eq(planA.map(x => x.id), planB.map(x => x.id), 'same seed produces the same attack order');
A.ok(!planA.some(x => x.id === 'auth:GET:/api/health'), 'documented token-exempt health route is not falsely attacked for missing auth');
A.ok(planA.some(x => x.id === 'origin:GET:/api/health'), 'token exemption does not exempt hostile Origin containment');
A.ok(planA.some(x => x.id === 'auth:POST:/api/save'), 'token-required route receives an auth attack');

A.eq(S.verdictFor({ family: 'auth' }, { status: 403 }, true), { ok: true }, '403 closes an auth attack');
A.eq(S.verdictFor({ family: 'origin' }, { status: 200 }, true).severity, 'P1', 'origin bypass is P1');
A.eq(S.verdictFor({ family: 'payload' }, { status: 500 }, true).severity, 'P2', 'unhandled malformed payload is P2');
A.eq(S.verdictFor({ family: 'payload' }, { status: 400 }, true), { ok: true }, 'bounded validation rejection passes');
A.eq(S.verdictFor({ family: 'payload' }, { status: 400 }, false).severity, 'P1', 'sidecar death after an attack is P1');

// Boot wait + trace (guardian triage 2026-10-28): the old waitUp(base, 30) gave a cold sidecar 15s, and with stdio
// 'ignore' a boot that never came up left an empty sidecarLog. The run waits >= 30s and logs into its evidence dir.
{
  const fs = require('fs'), path = require('path');
  const text = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'qa', 'saboteur.mjs'), 'utf8');
  const wait = /waitUp\(base,\s*(\d+)\)/.exec(text);
  A.ok(wait && Number(wait[1]) >= 60, 'saboteur waits at least 60 x 500ms for the sidecar (got ' + (wait && wait[1]) + ')');
  A.ok(/bootSeededSidecar\(\{[^}]*logFile:\s*sidecarLogPath/.test(text) && /join\(outDir,\s*'sidecar\.log'\)/.test(text),
    'saboteur boots the sidecar with its output logged into the run evidence dir');
  const seed = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'seed.mjs'), 'utf8');
  A.ok(/if \(!logFile\) return spawn\(process\.execPath, \[SIDECAR\], \{ cwd: REPO, env, stdio: 'ignore' \}\);/.test(seed),
    'every other bootSeededSidecar caller keeps stdio ignore');
}

A.report('qa-saboteur');

