#!/usr/bin/env node
/*
 * egress-floor.mjs — the LIVE canary for StarNet's outbound boundary (sidecar/net/safe-egress.js).
 *
 * WHY. Every outbound path whose destination a model or a remote server picks dials through the boundary's pinned
 * dispatcher: web_fetch and web_request, connector sign-in, the skill / market / community-map downloads and the owned
 * browser's proxy. Stubs cannot see what gh#82 was: on real Node the pin answered the { all: true } connect lookup
 * with a single address and every pinned request died as "fetch failed" (customer reports E22, 0.12.5-0.13.0), while
 * every test passed. So this makes ONE real pass through each consumer, built the way sidecar/index.js builds it, on
 * this computer's DNS, real TLS and the real internet. The class-level proofs are test/safe-egress.conformance.test.js
 * and test/safe-egress.real-socket.test.js; this proves nothing regressed out there.
 *
 * CHECKS (each against --url, default https://example.com/):
 *   web_request      makeWebTools({}).requestTool (npm undici.fetch through the hop's pinned Agent)
 *   web_fetch        makeWebTools({}).webFetch (the direct path; no reader key is configured, so no vendor answers)
 *   connector-oauth  makeConnectorOauthFetch({ onCloseError }) (globalThis.fetch with the boundary's npm-undici Agent)
 *   skill-document   makeSkillDocumentFetcher({ fetchImpl: globalThis.fetch })
 *   skill-package    makeSkillPackageFetcher over that fetcher: the session (one answer, one keep-alive Agent per host)
 *   browser-proxy    startPinnedProxy with the browser's guards (proxyGuards): CONNECT host:443, a TLS handshake whose
 *                    certificate is verified for the host, and a GET through the tunnel
 * PASS = every check answered HTTP 200 with the marker text in the body (default "Example Domain"); web_fetch's text
 * came from the direct path; the proxy's tunnel answered 200 and its TLS session was authorized.
 * OPTIONS:
 *   --url <https url>   the page to reach (https: connector sign-in and skill sources refuse anything else)
 *   --marker <text>     text the page must contain ('' accepts any 200)
 *   --retry N           re-run a red pass N more times, 5 s apart
 *   --report-only       exit 0 even when red, after a ::warning:: line (a scheduled run)
 *   --json <file>       also write the verdict JSON there
 * Prints ONE verdict line: {"canary":"egress-floor","ok":…}. Exit 0 green, 1 red, 2 usage.
 * Wiring it into .github/workflows/floor-canaries.yml is Andrew's call (the safe-egress lane ships the script, its
 * offline test and a live run).
 */
import http from 'node:http';
import tls from 'node:tls';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

export const CHECKS = Object.freeze(['web_request', 'web_fetch', 'connector-oauth', 'skill-document', 'skill-package', 'browser-proxy']);

export function parseArgs(argv) {
  const o = { url: 'https://example.com/', marker: 'Example Domain', retry: 0, reportOnly: false, json: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error('missing value for ' + a); return argv[++i]; };
    if (a === '--url') o.url = String(next());
    else if (a === '--marker') o.marker = String(next());
    else if (a === '--retry') o.retry = Math.max(0, Number(next()) || 0);
    else if (a === '--report-only') o.reportOnly = true;
    else if (a === '--json') o.json = resolve(next());
    else throw new Error('unknown argument: ' + a);
  }
  let u;
  try { u = new URL(o.url); } catch (_) { throw new Error('--url is not a URL: ' + o.url); }
  if (u.protocol !== 'https:') throw new Error('--url must be https (connector sign-in and skill sources refuse anything else): ' + o.url);
  return o;
}

/* Judge one pass. results: [{ check, status?, text?, source?, tunnel?, authorized?, authorizationError?, error?, code?,
   ms? }]. Every check in CHECKS must be present and green. -> { ok, why, failed, checks }: why names the FIRST check
   that is not; checks is the per-check report (no page text, only its size and whether the marker was in it). */
export function judge(results, marker) {
  const byName = new Map((Array.isArray(results) ? results : []).filter(r => r && r.check).map(r => [r.check, r]));
  const failed = [], checks = [];
  let why = '';
  for (const name of CHECKS) {
    const r = byName.get(name);
    const text = r && r.text != null ? String(r.text) : '';
    const hasMarker = !marker || text.indexOf(marker) >= 0;
    const bad = !r ? 'did not run'
      : r.error ? 'failed: ' + r.error + (r.code ? ' [' + r.code + ']' : '')
      : name === 'browser-proxy' && r.tunnel !== 200 ? 'the proxy answered CONNECT with ' + r.tunnel + (r.refusal ? ' (' + r.refusal + ')' : '')
      : name === 'browser-proxy' && r.authorized !== true ? 'the TLS session through the tunnel was not authorized' + (r.authorizationError ? ' (' + r.authorizationError + ')' : '')
      : r.status !== 200 ? 'HTTP ' + r.status
      : name === 'web_fetch' && r.source !== 'direct' ? 'the text came from ' + (r.source || 'nowhere') + ', not the direct pinned fetch'
      : !hasMarker ? 'the answer lacks "' + marker + '"' : '';
    if (bad) { failed.push(name); if (!why) why = name + ': ' + bad; }
    const row = { check: name, ok: !bad };
    if (bad) row.why = bad;
    if (r) {
      for (const k of ['status', 'source', 'tunnel', 'authorized', 'authorizationError', 'refusal', 'error', 'code', 'ms']) if (r[k] != null && r[k] !== '') row[k] = r[k];
      row.bytes = Buffer.byteLength(text);
      row.marker = !!marker && text.indexOf(marker) >= 0;
    }
    checks.push(row);
  }
  return { ok: failed.length === 0, why, failed, checks };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function timed(check, fn) {
  const t0 = Date.now();
  try { return Object.assign({ check }, await fn(), { ms: Date.now() - t0 }); }
  catch (e) {
    const cause = e && e.cause;
    return { check, error: String((e && e.message) || e) + (cause && cause.message ? ' (' + cause.message + ')' : ''),
      code: (e && e.code) || (cause && (cause.code || (cause.errors && cause.errors[0] && cause.errors[0].code))) || '', ms: Date.now() - t0 };
  }
}

// CONNECT host:port through the owned browser's proxy, then TLS (verified) and one GET through the tunnel
function throughProxy(proxy, u) {
  return new Promise((resolveIt, reject) => {
    const mark = proxy.refusalMark();
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: u.hostname + ':' + (u.port || '443'), agent: false });
    const timer = setTimeout(() => req.destroy(new Error('the proxy tunnel took longer than 30 s')), 30000);
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer); socket.destroy();
        const kept = proxy.refusalsSince(mark);
        return resolveIt({ tunnel: res.statusCode, refusal: kept.length ? kept[kept.length - 1].reason : '' });
      }
      const t = tls.connect({ socket, servername: u.hostname });   // rejectUnauthorized: the certificate must verify for the host
      let data = '';
      t.on('secureConnect', () => {
        t.write('GET ' + (u.pathname || '/') + u.search + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUser-Agent: StarNet-egress-canary\r\nConnection: close\r\n\r\n');
      });
      t.on('data', d => { data += d; });
      t.on('end', () => {
        clearTimeout(timer);
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(data);
        resolveIt({ tunnel: 200, authorized: t.authorized === true, authorizationError: t.authorizationError ? String(t.authorizationError) : '', status: m ? Number(m[1]) : 0, text: data });
      });
      t.on('error', e => { clearTimeout(timer); reject(e); });
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.end();
  });
}

async function onePass(o) {
  const { makeWebTools } = require(join(ROOT, 'sidecar', 'tools', 'builtin', 'web.js'));
  const { makeConnectorOauthFetch } = require(join(ROOT, 'sidecar', 'mcp', 'oauth-fetch.js'));
  const { makeSkillDocumentFetcher, makeSkillPackageFetcher } = require(join(ROOT, 'sidecar', 'skills', 'exchange-fetch.js'));
  const B = require(join(ROOT, 'sidecar', 'tools', 'builtin', 'browser.js'))._internals;
  const { startPinnedProxy } = require(join(ROOT, 'sidecar', 'tools', 'builtin', 'browser-proxy.js'));
  const closeErrors = [];
  const results = [];
  const web = makeWebTools({});
  results.push(await timed('web_request', async () => {
    const r = await web.requestTool.run({ url: o.url }, {});
    const m = /\s(\d{3})(?:\s|$)/.exec(String(r && r.summary || ''));
    return { status: m ? Number(m[1]) : 0, text: String(r && r.content || '') };
  }));
  results.push(await timed('web_fetch', async () => {
    const r = await web.webFetch(o.url);
    return { status: 200, source: r.source, text: r.text };
  }));
  results.push(await timed('connector-oauth', async () => {
    const f = makeConnectorOauthFetch({ onCloseError: e => closeErrors.push(String(e && e.message || e)) });
    const r = await f.connectorOauthFetch(o.url, { method: 'GET', signal: AbortSignal.timeout(30000) });
    return { status: r.status, text: await r.text() };
  }));
  const fetchDocument = makeSkillDocumentFetcher({ fetchImpl: globalThis.fetch });
  results.push(await timed('skill-document', async () => {
    const r = await fetchDocument(o.url, { maxBytes: 4000000, label: 'the canary page' });
    return { status: 200, text: r.text };
  }));
  results.push(await timed('skill-package', async () => {
    const pkg = await makeSkillPackageFetcher({ fetchDocument, now: () => Date.now() })(o.url);
    const main = pkg.files.find(f => f.path === 'SKILL.md');
    return { status: 200, text: main ? Buffer.from(main.bytes).toString('utf8') : '' };
  }));
  results.push(await timed('browser-proxy', async () => {
    const proxy = await startPinnedProxy(B.proxyGuards());
    try { return await throughProxy(proxy, new URL(o.url)); }
    finally { await proxy.close(); }
  }));
  await sleep(100);   // background closes (connector OAuth) report their errors before the verdict
  const verdict = judge(results, o.marker);
  if (closeErrors.length) verdict.closeErrors = closeErrors;
  return verdict;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(String(e.message || e)); process.exit(2); }
  const attempts = [];
  for (let i = 0; i <= o.retry; i++) {
    if (i) await sleep(5000);
    const v = await onePass(o);
    attempts.push(v);
    if (v.ok) break;
  }
  const last = attempts[attempts.length - 1];
  let npmUndici = '';
  try { npmUndici = require(join(ROOT, 'node_modules', 'undici', 'package.json')).version; } catch (_) { npmUndici = 'unreadable'; }
  const verdict = { canary: 'egress-floor', ok: !!last.ok, url: o.url, node: process.version, execPath: process.execPath,
    undici: { bundled: process.versions.undici || '', npm: npmUndici }, attempts: attempts.length, last };
  const line = JSON.stringify(verdict);
  console.log(line);
  if (o.json) writeFileSync(o.json, line + '\n');
  if (!verdict.ok) {
    console.log('::' + (o.reportOnly ? 'warning' : 'error') + '::the outbound egress floor is RED — ' + last.why);
    process.exit(o.reportOnly ? 0 : 1);
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
