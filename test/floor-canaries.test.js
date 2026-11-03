/* Each floor calls the real product client, with only fetch/DNS faked. The updater runs its real CLI in a child
 * with a fetch preload. No external traffic, publisher credentials, device approvals or installed app are used. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
let checks = 0;
function ok(value, why) { checks++; assert.ok(value, why); }
function eq(a, b, why) { checks++; assert.deepEqual(a, b, why); }
const response = (body, status = 200, headers = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const google = JSON.stringify({ installed: { client_id: '123456-fixture.apps.googleusercontent.com', client_secret: 'fixture-never-print-me' } });
const env = { STARNET_GOOGLE_DESKTOP_CLIENT_JSON: google };
function healthy(url) {
  const u = new URL(String(url));
  if (u.hostname === 'www.mojeek.com') return response('<a class="title" href="https://example.com/">Example Domain</a><p class="s">Example</p>');
  if (u.hostname === 'html.duckduckgo.com') return response('<a class="result__a" href="https://example.com/">Example Domain</a>');
  if (u.hostname === 'lite.duckduckgo.com') return response('<a rel="nofollow" href="https://example.com/" class="result-link">Example Domain</a>');
  if (u.hostname === 'example.com') return response('<h1>Example Domain</h1><p>For use in examples.</p>', 200, { 'content-type': 'text/html' });
  if (u.hostname === 'openrouter.ai') return response({ data: [{ id: 'fixture/model', name: 'Fixture', context_length: 8192 }] });
  if (u.hostname === 'models.dev') return response({ openai: { models: { fixture: { cost: { input: 1, output: 2 } } } } });
  if (u.hostname === 'github.com') return response({ device_code: 'fixture-device-private', user_code: 'ABCD-EFGH', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
  if (u.hostname === 'auth.openai.com') return response({ device_auth_id: 'fixture-device-private', user_code: 'ABCD-EFGH', interval: 5 });
  if (u.hostname === 'accounts.google.com') {
    const r = response('<input id="identifierId">');
    Object.defineProperty(r, 'url', { value: 'https://accounts.google.com/v3/signin/identifier' });
    return r;
  }
  throw new Error('unexpected fixture request');
}

async function main() {
  const { FLOORS, probeFloor, runFloor, parseArgs, exitCode } = await import(pathToFileURL(path.join(ROOT, 'scripts/canary/floors.mjs')));
  const ids = FLOORS.map(f => f.id);
  eq(new Set(ids).size, 8, 'eight distinct product floors');
  eq(JSON.parse(execFileSync(process.execPath, ['scripts/canary/floors.mjs', '--list'], { cwd: ROOT, encoding: 'utf8' })), ids, 'CLI matrix comes from the table');
  for (const floor of FLOORS) {
    ok(fs.existsSync(path.join(ROOT, floor.module)), floor.id + ' product module exists');
    if (floor.export) ok(typeof require(path.join(ROOT, floor.module))[floor.export] === 'function', floor.id + ' production export exists');
  }
  const opts = { productRoot: ROOT, env, lookup, fetchImpl: async (url, init) => {
    ok(init.signal && typeof init.signal.aborted === 'boolean', 'every external request is bounded');
    return healthy(url);
  } };
  for (const id of ids.filter(id => id !== 'update-host')) {
    const good = await probeFloor(id, opts);
    ok(good.ok && good.status === 'passed', id + ' real client accepts a healthy transport');
    ok(good.requests.length > 0, id + ' no cached success');
    for (const badStatus of [403, 500]) {
      const bad = await probeFloor(id, { ...opts, fetchImpl: async url => {
        const good = healthy(url);
        return response(await good.text(), badStatus);
      } });
      ok(!bad.ok && bad.floor === id, id + ' rejects HTTP ' + badStatus + ' even with a plausible healthy body');
    }
    const drift = await probeFloor(id, { ...opts, fetchImpl: async () => response({ changed_schema: true }) });
    ok(!drift.ok, id + ' changed payload is red');
    const down = await probeFloor(id, { ...opts, fetchImpl: async () => { throw new Error('fixture-never-print-me fixture-device-private'); } });
    ok(!down.ok && !JSON.stringify(down).includes('fixture-never-print-me') && !JSON.stringify(down).includes('fixture-device-private'), id + ' transport error does not print private material');
    ok(!JSON.stringify(good).includes('fixture-device-private') && !JSON.stringify(good).includes('ABCD-EFGH') && !JSON.stringify(good).includes('fixture-never-print-me'), id + ' receipt excludes sign-in data');
  }
  const primary = await probeFloor('web-search', opts);
  eq(primary.rungs.map(r => r.status), ['passed', 'not checked', 'not checked'], 'unreached fallbacks are not claimed healthy');
  const fallback = await probeFloor('web-search', { ...opts, fetchImpl: async url => new URL(String(url)).hostname === 'www.mojeek.com' ? response('unavailable', 503) : healthy(url) });
  ok(fallback.ok && fallback.source === 'duckduckgo-html', 'real product fallback recovers after primary failure');
  eq(fallback.rungs.map(r => r.status), ['failed', 'passed', 'not checked'], 'real attempted rungs are named');
  const direct = await probeFloor('web-fetch', opts);
  eq(direct.source, 'direct', 'keyless reader is direct, never mislabeled Jina');
  ok(direct.requests.every(r => r.host !== 'r.jina.ai'), 'no unauthenticated Jina request invented by canary');
  const noGoogle = await probeFloor('google-signin', { ...opts, env: {} });
  ok(!noGoogle.ok && noGoogle.skipped && noGoogle.status === 'unconfigured' && noGoogle.requests.length === 0, 'missing registration is unconfigured, not verified');
  const invalidGoogle = await probeFloor('google-signin', { ...opts, env: { STARNET_GOOGLE_DESKTOP_CLIENT_JSON: '{bad' } });
  ok(!invalidGoogle.ok && !invalidGoogle.skipped, 'malformed registration fails rather than silently skipping');
  for (const error of ['invalid_client', 'deleted_client', 'redirect_uri_mismatch', 'access_denied']) {
    const rejected = await probeFloor('google-signin', { ...opts, fetchImpl: async () => response('<input id="identifierId">' + error) });
    ok(!rejected.ok, 'Google ' + error + ' is rejected even in HTTP200');
  }
  let calls = 0, waits = 0;
  const retried = await runFloor('openrouter-catalog', { ...opts, retry: 1, wait: async () => { waits++; }, fetchImpl: async url => ++calls === 1 ? response({}, 503) : healthy(url) });
  ok(retried.ok && calls === 2 && waits === 1 && retried.attempts === 2, 'one retry makes a fresh real catalog request');
  const afterCache = await probeFloor('openrouter-catalog', { ...opts, fetchImpl: async () => response({}, 500) });
  ok(!afterCache.ok, 'a previous successful catalog cannot hide a later dead floor');
  eq(exitCode({ ok: false, status: 'failed' }, false), 1, 'normal dead floor fails');
  eq(exitCode({ ok: false, status: 'failed' }, true), 0, 'report-only preserves failed verdict but exits0');
  eq(exitCode(noGoogle, false), 0, 'unconfigured publisher configuration is a warning');
  for (const args of [[], ['--floor', 'unknown'], ['--floor'], ['--floor', 'web-search', '--retry', '99'], ['--bogus']]) {
    checks++; assert.throws(() => parseArgs(args), 'invalid CLI refuses');
  }

  // Run the existing update verifier itself. Only its global fetch is replaced, in an isolated child process.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-floor-canaries-'));
  try {
    const preload = path.join(scratch, 'fetch.cjs');
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8')).version;
    const platforms = Object.fromEntries(['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'].map(id => [id, { signature: 'x'.repeat(80), url: 'https://github.com/fixture/fixture/releases/download/v' + version + '/' + id }]));
    fs.writeFileSync(preload, 'global.fetch = async (url, init) => { const bad = process.env.FLOOR_FIXTURE; if (bad === "http") return new Response("no", {status:500}); if (String(url).endsWith("latest.json")) return Response.json(bad === "shape" ? {} : ' + JSON.stringify({ version, pub_date: '2026-11-03T00:00:00Z', platforms }) + '); return new Response("", {status:200}); };');
    const runChild = mode => (root) => new Promise(resolveResult => {
      execFile(process.execPath, ['--require', preload, path.join(root, 'scripts/verify-update-host.mjs')], { cwd: root,
        env: { ...process.env, FLOOR_FIXTURE: mode }, windowsHide: true, timeout: 15000 }, error => resolveResult({ ok: !error, exit: error ? error.code : 0 }));
    });
    const good = await probeFloor('update-host', { productRoot: ROOT, runUpdateHost: runChild('good') });
    ok(good.ok, 'real product updater verifier accepts healthy manifest and reachable assets');
    for (const mode of ['http', 'shape']) {
      const bad = await probeFloor('update-host', { productRoot: ROOT, runUpdateHost: runChild(mode) });
      ok(!bad.ok && bad.floor === 'update-host', 'real update verifier rejects ' + mode);
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }

  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/floor-canaries.yml'), 'utf8');
  ok(wf.includes('floors=$(node scripts/canary/floors.mjs --list)') && wf.includes('fromJSON(needs.plan.outputs.floors)'), 'workflow matrix uses the one table');
  ok(wf.includes("cron: '17 */6 * * *'") && wf.includes('fail-fast: false') && wf.includes('--retry 1'), 'six-hour checks retain other floor results and retry once');
  ok(/floors_report_only:\s+type: boolean\s+default: true/.test(wf), 'reusable callers default report-only');
  ok(wf.includes('REPORT_ONLY: ${{ inputs.floors_report_only == true }}'), 'call policy uses typed input rather than caller event name');
  ok(wf.includes("matrix.floor == 'google-signin' && inputs.floors_report_only != true && secrets.STARNET_GOOGLE_DESKTOP_CLIENT_JSON"), 'publisher material is limited to its non-report leg');
  ok(wf.includes('ref: ${{ inputs.ref || github.ref }}') && wf.includes('path: .canary-tool'), 'canary and product refs stay separate');
  console.log('floor-canaries.test: OK (' + checks + ' assertions)');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
