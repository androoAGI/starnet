/* node test/egress-floor-canary.test.js — the live egress canary judges the right thing, offline.

   scripts/canary/egress-floor.mjs makes ONE real pass through every outbound consumer (web_request, web_fetch,
   connector OAuth, the skill document fetch and package session, the owned browser's proxy) on real DNS and real TLS,
   so the gate cannot run it for real. This pins, without a network:
     - its argument parsing: the defaults, every flag, https only, and a usage error (exit 2) for anything else
     - its judgement: green ONLY when every consumer answered HTTP 200 with the marker (web_fetch from the direct pinned
       path, the proxy with a 200 tunnel and an authorized TLS session); each failure names the consumer and why, and
       the report carries no page text
     - that it builds each consumer the way sidecar/index.js does (the same construction text in both), so the canary
       cannot drift onto a wiring production does not use */
'use strict';
const A = require('./_assert.js');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { readSidecarSource } = require('./helpers/source');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'canary', 'egress-floor.mjs');

function run(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT].concat(args), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, out }));
  });
}

(async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);
  A.eq(mod.CHECKS, ['web_request', 'web_fetch', 'connector-oauth', 'skill-document', 'skill-package', 'browser-proxy'], 'the canary checks every outbound consumer');

  // ---- parseArgs ----
  A.eq(mod.parseArgs([]), { url: 'https://example.com/', marker: 'Example Domain', retry: 0, reportOnly: false, json: '' }, 'defaults: example.com, its marker, one pass, blocking, no file');
  const o = mod.parseArgs(['--url', 'https://www.iana.org/help/example-domains', '--marker', 'Example Domains', '--retry', '2', '--report-only', '--json', 'out.json']);
  A.eq([o.url, o.marker, o.retry, o.reportOnly, path.basename(o.json), path.isAbsolute(o.json)], ['https://www.iana.org/help/example-domains', 'Example Domains', 2, true, 'out.json', true], 'every flag is read; --json resolves to an absolute path');
  A.eq(mod.parseArgs(['--retry', 'many']).retry, 0, 'a retry count that is not a number means none');
  A.eq(mod.parseArgs(['--marker', '']).marker, '', 'an empty marker accepts any 200');
  for (const [args, re, why] of [
    [['--bogus'], /unknown argument/, 'an unknown argument'],
    [['--url'], /missing value/, 'a flag without its value'],
    [['--url', 'http://example.com/'], /must be https/, 'a plain-http URL (connector sign-in and skill sources refuse it)'],
    [['--url', 'not a url'], /not a URL/, 'a URL that does not parse']
  ]) {
    let msg = '';
    try { mod.parseArgs(args); } catch (e) { msg = e.message; }
    A.ok(re.test(msg), 'parseArgs refuses ' + why + ' (' + msg + ')');
  }

  // ---- judge ----
  const PAGE = '<html><title>Example Domain</title></html>';
  const green = () => [
    { check: 'web_request', status: 200, text: 'GET example.com 200 ' + PAGE, ms: 120 },
    { check: 'web_fetch', status: 200, source: 'direct', text: 'Example Domain\nThis domain is for use in documentation.' },
    { check: 'connector-oauth', status: 200, text: PAGE },
    { check: 'skill-document', status: 200, text: PAGE },
    { check: 'skill-package', status: 200, text: PAGE },
    { check: 'browser-proxy', tunnel: 200, authorized: true, status: 200, text: 'HTTP/1.1 200 OK\r\n\r\n' + PAGE }
  ];
  const g = mod.judge(green(), 'Example Domain');
  A.ok(g.ok === true && g.why === '' && g.failed.length === 0, 'every consumer answering 200 with the marker is green');
  A.ok(g.checks.length === 6 && g.checks.every(c => c.ok && c.marker === true && c.bytes > 0 && !('text' in c)), 'the report has one row per consumer, with sizes and marker flags but no page text');
  A.eq(g.checks[0].ms, 120, 'and keeps each check\'s timing');
  const red = (mutate, name, re, label) => {
    const rows = green();
    mutate(rows);
    const v = mod.judge(rows, 'Example Domain');
    A.ok(v.ok === false && v.failed.indexOf(name) >= 0 && re.test(v.why), label + ': red, naming ' + name + ' (' + v.why + ')');
    return v;
  };
  red(rows => { rows[0].status = 502; }, 'web_request', /^web_request: HTTP 502$/, 'web_request answering 502');
  red(rows => { rows[1].source = 'jina'; }, 'web_fetch', /not the direct pinned fetch/, 'web_fetch text from a vendor instead of the pinned direct fetch');
  red(rows => { rows[2] = { check: 'connector-oauth', error: 'fetch failed (connect ECONNREFUSED ::1:443)', code: 'ECONNREFUSED' }; }, 'connector-oauth', /failed: fetch failed .*\[ECONNREFUSED\]$/, 'connector OAuth failing to connect');
  red(rows => { rows[3].text = 'a captive portal'; }, 'skill-document', /lacks "Example Domain"/, 'a skill fetch answered by something else');
  red(rows => { rows.splice(4, 1); }, 'skill-package', /did not run/, 'a consumer that never ran');
  red(rows => { rows[5] = { check: 'browser-proxy', tunnel: 403, refusal: 'refusing to navigate: example.com resolves to private address 0.0.0.0' }; }, 'browser-proxy', /CONNECT with 403 \(refusing to navigate/, 'the proxy refusing the tunnel');
  red(rows => { rows[5].authorized = false; rows[5].authorizationError = 'CERT_HAS_EXPIRED'; }, 'browser-proxy', /not authorized \(CERT_HAS_EXPIRED\)/, 'an unauthorized TLS session through the tunnel');
  const two = red(rows => { rows[0].status = 500; rows[5].tunnel = 502; }, 'web_request', /^web_request:/, 'two failures');
  A.eq(two.failed, ['web_request', 'browser-proxy'], 'every failed consumer is listed, the first one named in why');
  A.ok(mod.judge(green().map(r => Object.assign(r, { text: 'anything at all' })), '').ok, 'an empty marker accepts any 200');
  A.eq(mod.judge(null, 'x').failed, mod.CHECKS, 'no results at all: every consumer is red');

  // ---- the CLI: usage errors exit 2 before any network ----
  for (const args of [['--bogus'], ['--url', 'http://example.com/']]) {
    const r = await run(args);
    A.ok(r.code === 2 && !/\{"canary"/.test(r.out), 'the CLI exits 2 on a usage error, with no verdict line: ' + args.join(' ') + ' (' + r.out.trim().slice(0, 120) + ')');
  }

  // ---- it builds every consumer the way the composition root does ----
  const script = fs.readFileSync(SCRIPT, 'utf8');
  const sidecar = readSidecarSource();
  for (const construction of ['makeSkillDocumentFetcher({ fetchImpl: globalThis.fetch })', 'makeConnectorOauthFetch({ onCloseError: e =>']) {
    A.ok(script.indexOf(construction) >= 0 && sidecar.indexOf(construction) >= 0, 'the canary and sidecar/index.js build it the same way: ' + construction);
  }
  A.ok(/startPinnedProxy\(B\.proxyGuards\(\)\)/.test(script) && /startPinnedProxy\(proxyGuards\(/.test(sidecar), 'the canary\'s proxy has the guards makeCdpDriver gives the owned browser\'s proxy');
  A.ok(/makeWebTools\(\{\}\)/.test(script) && /makeSkillPackageFetcher\(\{ fetchDocument/.test(script), 'web tools and the package session are built with no injected transport');

  A.report('egress-floor-canary.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
