#!/usr/bin/env node
/* scripts/qa/saboteur.mjs — deterministic adversarial API sweeps for StarNet.
 *
 * This is EL-2's first executable slice. It attacks the real, isolated sidecar instead of
 * mocking handlers: every literal /api route is checked for launch-token and hostile-Origin
 * containment, then a curated set of stateful routes receives malformed JSON shapes. A seed
 * fixes attack order, and every failure carries a replayable attack id plus a machine report.
 *
 * Usage: npm run qa:saboteur [-- --seed 123 --only auth,origin,payload --no-ledger]
 *        npm run qa:saboteur -- --self-test   # plant one known canary and prove RED detection
 * Exit: 0 clean, 2 blocked, 3 one or more invariant failures.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp } from '../lib/seed.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = join(ROOT, 'sidecar', 'index.js');
const LEDGER = join(ROOT, 'scripts', 'qa', 'ledger.mjs');
const TOKEN_EXEMPT = new Set(['/api/key', '/api/channels/token', '/api/health', '/api/spotify/callback', '/api/connectors/oauth/callback']);
const PAYLOAD_ROUTES = [
  '/api/activity', '/api/autonomy/posture', '/api/cron/preview', '/api/dossier',
  '/api/memory/config', '/api/permissions/grant', '/api/quests/mint',
  '/api/runtime/knobs', '/api/scout/telemetry', '/api/slash/dispatch'
];
const PAYLOADS = [
  { name: 'truncated-object', body: '{' },
  { name: 'null', body: 'null' },
  { name: 'array', body: '[]' },
  { name: 'scalar', body: '"saboteur"' },
  { name: 'prototype-shape', body: '{"constructor":{"prototype":{"polluted":true}},"__proto__":{"polluted":true}}' }
];

function methodsOf(raw) {
  const quoted = [...String(raw).matchAll(/['"]([A-Z]+)['"]/g)].map(m => m[1]);
  return quoted.length ? quoted : [];
}

export function parseLiteralApiRoutes(source) {
  const rows = [];
  const re = /\{\s*m:\s*(\[[^\]]+\]|['"][A-Z]+['"])\s*,\s*exact:\s*['"](\/api\/[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(String(source)))) {
    for (const method of methodsOf(m[1])) rows.push({ method, path: m[2] });
  }
  const seen = new Set();
  return rows.filter(r => {
    const key = r.method + ' ' + r.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function seededOrder(items, seed) {
  let x = (Number(seed) >>> 0) || 1;
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function buildAttackPlan(routes, seed, only) {
  const enabled = new Set((only && only.length ? only : ['auth', 'origin', 'payload']).map(String));
  const attacks = [];
  for (const route of routes) {
    if (enabled.has('auth') && !TOKEN_EXEMPT.has(route.path)) attacks.push({
      family: 'auth', id: 'auth:' + route.method + ':' + route.path, route,
      expect: 'status 403 without the launch token'
    });
    if (enabled.has('origin')) attacks.push({
      family: 'origin', id: 'origin:' + route.method + ':' + route.path, route,
      expect: 'status 403 for a hostile browser Origin'
    });
  }
  if (enabled.has('payload')) {
    for (const path of PAYLOAD_ROUTES) for (const payload of PAYLOADS) attacks.push({
      family: 'payload', id: 'payload:' + payload.name + ':' + path,
      route: { method: 'POST', path }, payload,
      expect: 'a bounded non-5xx response and a live sidecar afterward'
    });
  }
  return seededOrder(attacks, seed);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function tokenFromIndex(base) {
  const text = await (await fetch(base + '/')).text();
  const m = text.match(/window\.__STARNET_API_TOKEN__=("[^"]+")/);
  return m ? JSON.parse(m[1]) : '';
}

async function request(base, attack, token) {
  const headers = { Origin: base };
  let body;
  if (attack.family === 'origin') headers.Origin = 'https://saboteur.invalid';
  if (attack.family === 'payload') {
    headers['X-StarNet-Token'] = token;
    headers['Content-Type'] = 'application/json';
    body = attack.payload.body;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(base + attack.route.path, {
      method: attack.route.method, headers, body, signal: controller.signal, redirect: 'manual'
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, body: text.slice(0, 500) };
  } finally { clearTimeout(timer); }
}

export function verdictFor(attack, response, healthOk) {
  if (!response) return { ok: false, severity: 'P1', reason: 'request did not produce a response' };
  if (attack.family === 'auth' || attack.family === 'origin') {
    return response.status === 403
      ? { ok: true }
      : { ok: false, severity: 'P1', reason: attack.family + ' boundary returned ' + response.status + ', expected 403' };
  }
  if (!healthOk) return { ok: false, severity: 'P1', reason: 'sidecar health failed after malformed payload' };
  if (response.status >= 500) return { ok: false, severity: 'P2', reason: 'malformed client payload escaped validation as HTTP ' + response.status };
  return { ok: true };
}

function fileFinding(failure, evidence) {
  const finding = {
    crew: 'Saboteur', severity: failure.verdict.severity,
    title: 'Adversarial invariant failed: ' + failure.attack.id,
    detail: failure.verdict.reason + '. Replay with: npm run qa:saboteur -- --seed ' + failure.seed + ' --only ' + failure.attack.family,
    evidence: [evidence], checkId: 'saboteur-' + failure.attack.family, subject: failure.attack.id
  };
  return spawnSync(process.execPath, [LEDGER, '--add', '--json', JSON.stringify(finding)], { cwd: ROOT, encoding: 'utf8' });
}

async function main() {
  const seed = Number(arg('--seed', String(Date.now() >>> 0))) >>> 0;
  const only = String(arg('--only', 'auth,origin,payload')).split(',').map(s => s.trim()).filter(Boolean);
  const selfTest = process.argv.includes('--self-test');
  const noLedger = selfTest || process.argv.includes('--no-ledger') || /^(1|true|yes)$/i.test(String(process.env.SKYNET_SABOTEUR_NO_LEDGER || ''));
  const keep = process.argv.includes('--keep');
  const port = Number(arg('--port', process.env.SKYNET_SABOTEUR_PORT || String(8970 + (process.pid % 20))));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const outDir = resolve(arg('--out', join(ROOT, '.bugloops', 'saboteur-' + stamp)));
  const scratch = join(outDir, 'workspace');
  mkdirSync(outDir, { recursive: true });

  const routes = parseLiteralApiRoutes(readFileSync(INDEX, 'utf8'));
  const attacks = buildAttackPlan(routes, seed, only);
  // Canary only: /api/health is intentionally token-exempt. Pretending it is protected plants a
  // known auth escape without changing product bytes, proving request -> verdict -> evidence RED.
  if (selfTest) attacks.unshift({
    family: 'auth', id: 'canary:auth-boundary-detection',
    route: { method: 'GET', path: '/api/health' }, expect: 'planted canary must be detected'
  });
  if (!routes.length || !attacks.length) {
    console.error('SABOTEUR BLOCKED — route inventory or attack plan is empty');
    process.exitCode = 2; return;
  }
  materializeSeedWorkspace(scratch);
  // The sidecar's own output goes to the run's evidence dir: a boot that never turns healthy must leave a trace.
  const sidecarLogPath = join(outDir, 'sidecar.log');
  const child = bootSeededSidecar({ port, scratchDir: scratch, logFile: sidecarLogPath });
  const base = 'http://127.0.0.1:' + port;
  const results = [];
  let blocked = '';
  try {
    // 60 tries x 500ms: a cold sidecar on a loaded gate machine can take well over the old 15s to answer /health.
    if (!await waitUp(base, 60)) throw new Error('sidecar did not become healthy within 30s (see sidecar.log)');
    const token = await tokenFromIndex(base);
    if (!token) throw new Error('served page did not carry a launch token');
    for (const attack of attacks) {
      let response = null, error = '';
      try { response = await request(base, attack, token); }
      catch (e) { error = String(e && e.message || e); }
      const healthOk = await fetch(base + '/api/health').then(r => r.ok).catch(() => false);
      const verdict = verdictFor(attack, response, healthOk);
      results.push({ attack, response, healthOk, error, verdict, seed });
    }
  } catch (e) { blocked = String(e && e.stack || e); }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise(r => child.once('exit', r));
      try { child.kill(); } catch (_) {}
      await Promise.race([gone, new Promise(r => setTimeout(r, 3000))]);   // let it flush its last lines into sidecar.log
    }
  }
  let sidecarLog = '';
  try { sidecarLog = readFileSync(sidecarLogPath, 'utf8').slice(-12000); }
  catch (e) { sidecarLog = '(sidecar.log unreadable: ' + String(e && e.code || e) + ')'; }   // the report says why the trace is missing
  const failures = results.filter(r => !r.verdict.ok);
  const report = {
    schema: 1, generatedAt: new Date().toISOString(), seed, only, routeCount: routes.length,
    attackCount: attacks.length, passed: results.length - failures.length, failed: failures.length,
    blocked, failures, results, sidecarLog
  };
  const reportPath = join(outDir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  const evidence = relative(ROOT, reportPath).replace(/\\/g, '/');
  if (!noLedger) for (const failure of failures) fileFinding(failure, evidence);
  if (!keep) { try { rmSync(scratch, { recursive: true, force: true }); } catch (_) {} }

  const canaryOnly = selfTest && failures.length === 1 && failures[0].attack.id === 'canary:auth-boundary-detection';
  if (blocked) {
    console.error('SABOTEUR BLOCKED — ' + blocked.split('\n')[0]);
    console.error('evidence: ' + evidence);
    process.exitCode = 2;
  } else if (canaryOnly) {
    console.log('SABOTEUR SELF-TEST GREEN — planted auth canary was detected and evidenced (seed ' + seed + ')');
    console.log('evidence: ' + evidence);
  } else if (failures.length) {
    console.error('SABOTEUR RED — ' + failures.length + '/' + results.length + ' attacks failed (seed ' + seed + ')');
    for (const f of failures) console.error('  ' + f.attack.id + ' — ' + f.verdict.reason);
    console.error('replay: npm run qa:saboteur -- --seed ' + seed + ' --only ' + only.join(','));
    console.error('evidence: ' + evidence);
    process.exitCode = 3;
  } else {
    console.log('SABOTEUR GREEN — ' + results.length + ' attacks passed across ' + routes.length + ' literal API routes (seed ' + seed + ')');
    console.log('evidence: ' + evidence);
  }
}

const DIRECT = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href; } catch (_) { return false; } })();
if (DIRECT) main().catch(e => { console.error('SABOTEUR BLOCKED — ' + (e && e.stack || e)); process.exitCode = 2; });
