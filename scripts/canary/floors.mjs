#!/usr/bin/env node
/* Live floor checks use the product clients from --product-root; the canary itself can come from a newer workflow.
 * Each invocation starts fresh and reports only counts/statuses, never response bodies, OAuth codes or client material.
 * Search reports the real fallback ladder (unreached rungs are not checked). Keyless web_fetch is DIRECT: the product
 * deliberately stopped calling unauthenticated Jina. A successful direct fetch must never be called a Jina proof.
 * OAuth probes only start a disposable sign-in request; they never poll, exchange a code, or connect an account.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const FLOORS = Object.freeze([
  { id: 'web-search', depends: 'keyless web search', module: 'sidecar/tools/builtin/web.js', export: 'makeWebTools' },
  { id: 'web-fetch', depends: 'keyless direct page reading', module: 'sidecar/tools/builtin/web.js', export: 'makeWebTools' },
  { id: 'openrouter-catalog', depends: 'model selection and capabilities', module: 'sidecar/providers/openrouter.js', export: 'makeOpenRouterProvider' },
  { id: 'models-dev-prices', depends: 'live model pricing', module: 'sidecar/providers/liveprices.js', export: 'makeLivePrices' },
  { id: 'google-signin', depends: 'publisher Google desktop registration', module: 'sidecar/mcp/google-client.js', export: 'loadDesktopClient' },
  { id: 'github-device', depends: 'GitHub device sign-in start', module: 'sidecar/mcp/github-device.js', export: 'createDeviceFlow' },
  { id: 'codex-device', depends: 'ChatGPT device sign-in start', module: 'sidecar/providers/codex-auth.js', export: 'startDeviceLogin' },
  { id: 'update-host', depends: 'published desktop update manifest and assets', module: 'scripts/verify-update-host.mjs', export: null }
].map(Object.freeze));

export function parseArgs(argv) {
  const o = { productRoot: ROOT, floor: '', retry: 0, reportOnly: false, json: '', list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error('missing value for ' + a); return v; };
    if (a === '--list') o.list = true;
    else if (a === '--floor') o.floor = value();
    else if (a === '--product-root') o.productRoot = resolve(value());
    else if (a === '--json') o.json = resolve(value());
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--retry') { o.retry = Number(value()); if (!Number.isInteger(o.retry) || o.retry < 0 || o.retry > 3) throw new Error('retry must be 0..3'); }
    else throw new Error('unknown argument: ' + a);
  }
  if (!o.list && !FLOORS.some(f => f.id === o.floor)) throw new Error('name one floor from --list');
  return o;
}

function runUpdateHost(productRoot, env) {
  return new Promise(resolveResult => {
    // The existing product verifier checks schema, version, platform coverage and actual asset reachability.
    // Its output may include provider-controlled URLs; the public receipt keeps only the exit status.
    execFile(process.execPath, [join(productRoot, 'scripts/verify-update-host.mjs')],
      { cwd: productRoot, env, timeout: 180000, windowsHide: true, maxBuffer: 1024 * 1024 }, error => {
        resolveResult({ ok: !error, exit: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          why: error ? 'the product update verifier failed or timed out' : '' });
      });
  });
}

const SEARCH_HOSTS = { mojeek: 'www.mojeek.com', 'duckduckgo-html': 'html.duckduckgo.com', 'duckduckgo-lite': 'lite.duckduckgo.com' };
export async function probeFloor(id, options = {}) {
  const floor = FLOORS.find(f => f.id === id);
  if (!floor) throw new Error('unknown floor');
  const productRoot = resolve(options.productRoot || ROOT), env = options.env || process.env;
  const require = createRequire(join(productRoot, 'package.json'));
  const fresh = file => { const p = require.resolve(join(productRoot, file)); delete require.cache[p]; return require(p); };
  const requests = [];
  const fetchImpl = options.fetchImpl || require('undici').fetch;
  const signal = options.signal || AbortSignal.timeout(90000);
  const fetchEdge = async (url, init = {}) => {
    const host = new URL(String(url)).hostname;
    const row = { host, status: null }; requests.push(row);
    const response = await fetchImpl(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal });
    row.status = response.status;
    return response;
  };
  const base = { canary: 'external-floor', floor: id, ok: false, status: 'failed' };
  const finish = result => ({ ...base, ...result, requests });
  try {
    if (id === 'update-host') {
      // Injection is the child-process boundary; offline tests run the real verifier with a fetch-only preload.
      const result = await (options.runUpdateHost || runUpdateHost)(productRoot, env);
      return finish({ ...result, status: result.ok ? 'passed' : 'failed' });
    }
    const mod = fresh(floor.module);
    if (typeof mod[floor.export] !== 'function') return finish({ why: 'the product client export is missing' });
    let result;
    if (id === 'web-search' || id === 'web-fetch') {
      const deps = { fetchImpl: fetchEdge };
      // Tests fake DNS at its boundary with public addresses. Live checks retain the product's resolver and pinning.
      if (options.lookup) deps.lookup = options.lookup;
      const web = mod.makeWebTools(deps);
      if (id === 'web-search') {
        let answer, failed = false;
        try { answer = await web.webSearch('IANA example domains', { signal }); } catch (_) { failed = true; }
        const rungs = Object.entries(SEARCH_HOSTS).map(([source, host]) => ({ source,
          status: answer && answer.source === source ? 'passed' : requests.some(r => r.host === host) ? 'failed' : 'not checked' }));
        result = { ok: !failed && !!answer && Array.isArray(answer.results) && answer.results.some(r => /^https?:\/\//.test(r.url || '')),
          rungs, source: answer && answer.source || '', why: failed ? 'the product search ladder returned no usable result' : '' };
      } else {
        const answer = await web.webFetch('https://example.com/', { signal });
        result = { ok: answer.source === 'direct' && /example domain/i.test(answer.text || ''), source: answer.source,
          why: 'the keyless direct reader must return the example page; Jina is not a keyless product floor' };
      }
    } else if (id === 'openrouter-catalog') {
      const rows = await mod.makeOpenRouterProvider({ fetch: fetchEdge }).listModels();
      const ok = Array.isArray(rows) && rows.length > 0 && rows.every(r => typeof r.id === 'string' && r.id.trim());
      result = { ok, models: Array.isArray(rows) ? rows.length : 0, why: 'the live product catalog must contain model identifiers' };
    } else if (id === 'models-dev-prices') {
      const prices = mod.makeLivePrices({ fetchImpl: fetchEdge, now: Date.now });
      const ok = await prices.refresh(true);
      result = { ok: ok && prices.state().loaded, why: 'the live payload must load through the product price parser' };
    } else if (id === 'github-device') {
      const flow = mod.createDeviceFlow({ fetchImpl: fetchEdge, now: Date.now, snapshot: () => ({}), complete: () => { throw new Error('canary never completes sign-in'); } });
      try {
        const answer = await flow.start('canary', 'github', signal);
        result = { ok: answer.deviceFlow === true && answer.expiresIn > 0, why: 'the product device flow did not start' };
      } finally { flow.cancelAll(); }
    } else if (id === 'codex-device') {
      const answer = await mod.startDeviceLogin({ fetch: fetchEdge });
      result = { ok: !!answer.device_auth_id && !!answer.user_code && answer.expires_in > 0, why: 'the product device flow did not start' };
    } else if (id === 'google-signin') {
      const raw = env.STARNET_GOOGLE_DESKTOP_CLIENT_JSON || '';
      if (!raw) return finish({ status: 'unconfigured', skipped: true, why: 'publisher Google desktop registration is not available to this check' });
      const client = mod.loadDesktopClient({ env: { STARNET_GOOGLE_DESKTOP_CLIENT_JSON: raw }, readFile: () => '' });
      if (!client) return finish({ why: 'publisher Google desktop registration is invalid' });
      const oauth = fresh('sidecar/mcp/oauth.js'), cfg = fresh('sidecar/mcp/catalog.js').get('google-files').staticOauth;
      const verifier = randomBytes(32).toString('base64url');
      const url = oauth.buildAuthorizeUrl({ authorizationEndpoint: cfg.authorizationEndpoint, clientId: client.clientId,
        redirectUri: 'http://127.0.0.1/', challenge: createHash('sha256').update(verifier).digest('base64url'),
        state: randomBytes(16).toString('hex'), scope: cfg.scopes, extraParams: cfg.extraAuthParams });
      const response = await fetchEdge(url, { redirect: 'follow' });
      const body = await response.text();
      const final = new URL(response.url || url);
      const rejected = /invalid_client|deleted_client|redirect_uri_mismatch|access_denied|\/signin\/oauth\/error/i.test(body + final.pathname);
      const login = /identifierId|accounts\.google\.com\/ServiceLogin/i.test(body) || /\/(?:v\d+\/)?signin\/(?:identifier|chooser)/.test(final.pathname);
      result = { ok: response.ok && final.hostname === 'accounts.google.com' && !rejected && login,
        why: rejected ? 'Google rejected the publisher authorization request' : 'Google must offer sign-in for the product authorization request' };
    }
    // A parser that accepts a plausible body on HTTP 500 is still not evidence that the live floor works.
    // Search may legitimately recover through a later rung, so judge its selected rung, not failed earlier requests.
    const successfulHost = id === 'web-search' ? SEARCH_HOSTS[result.source] : null;
    const judged = successfulHost ? requests.filter(r => r.host === successfulHost) : requests;
    if (result.ok && (!judged.length || judged.some(r => r.status == null || r.status < 200 || r.status >= 300))) {
      result = { ...result, ok: false, why: 'the product client did not receive a successful live response' };
    }
    return finish({ ...result, status: result.ok ? 'passed' : 'failed', why: result.ok ? '' : result.why });
  } catch (_) {
    // Deliberately do not serialize exception text: a transport/client may include codes, tokens or response bodies.
    return finish({ why: 'the product client rejected the response or could not reach its floor' });
  }
}

export async function runFloor(id, options = {}) {
  const attempts = [];
  for (let i = 0; i <= (options.retry || 0); i++) {
    if (i) await (options.wait || (ms => new Promise(r => setTimeout(r, ms))))(5000);
    const result = await probeFloor(id, options);
    attempts.push(result);
    if (result.ok || result.skipped) break;
  }
  const last = attempts[attempts.length - 1];
  return { canary: 'external-floor', floor: id, ok: last.ok, status: last.status, attempts: attempts.length, last };
}

export function exitCode(result, reportOnly) { return result.ok || result.status === 'unconfigured' || reportOnly ? 0 : 1; }
async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (_) { console.error('floors: use --list, or --floor <id> [--retry 0..3] [--report-only] [--product-root DIR] [--json FILE]'); process.exitCode = 2; return; }
  if (o.list) { console.log(JSON.stringify(FLOORS.map(f => f.id))); return; }
  const result = await runFloor(o.floor, o), line = JSON.stringify(result);
  console.log(line);
  if (o.json) writeFileSync(o.json, line + '\n');
  if (!result.ok) console.log('::' + (exitCode(result, o.reportOnly) ? 'error' : 'warning') + '::' + o.floor + ': ' + result.last.why);
  process.exitCode = exitCode(result, o.reportOnly);
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(() => { console.error('floors: the canary could not produce its receipt'); process.exitCode = 1; });
