/* node test/webkit-floor-boot.test.js — the WebKit floor job judges the right thing, and CI runs it before a draft.

   scripts/qa/webkit-floor-boot.mjs boots the station page in a REAL WebKit (Playwright) with every API newer than the
   engine floor removed; CI runs it (.github/workflows/webkit-floor-boot.yml), the gate cannot. This test proves offline
   what it would decide, running the REAL script with only Playwright faked (the transport edge) and a stub entry for
   the keyless sidecar it boots:
     W1 the floor shim is the table's: it deletes every API newer than the floor, keeps the floor's own, and is the init
        script the harness hands the browser;
     W2 the verdict is green ONLY for a full accounting (the boot guard counted, saw and ran every station script) and
        nothing else wrong; red on any script that did not run, a page error, a script that did not arrive, the fatal
        banner, an engine below the floor, a shim that kept an API, or no accounting at all (an older boot guard);
     W3 Playwright missing is exit 3, "unconfigured", never green; a run boots the sidecar keyless on a port from the OS,
        visits / and /agent-station-demo.html, writes the receipt, exits 0 green / 1 red, and retries --retry times;
     W4 the wiring: playwright pinned in the workflow (the harness's pin), installed --no-save and never in package.json,
        run with --floor --retry 1, the receipt kept; fast-gate calls it, and the release train calls it for the ref
        under test and stages no draft without it. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'qa', 'webkit-floor-boot.mjs');

function run(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT].concat(args), { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', code => {
      const line = out.split(/\r?\n/).find(l => l.startsWith('{"harness"')) || '';
      let verdict = null;
      try { verdict = JSON.parse(line); } catch (_) { verdict = null; }
      resolve({ code, out, verdict });
    });
  });
}

// Playwright, faked at the edge: a real HTTP request to the page (the stub sidecar answers), canned page state by mode.
const FAKE_PLAYWRIGHT = `'use strict';
const fs = require('fs');
const MODE = process.env.FAKE_PW_MODE || 'green', LOG = process.env.FAKE_PW_LOG;
const log = e => { if (LOG) fs.appendFileSync(LOG, JSON.stringify(e) + '\\n'); };
const full = { checked: true, verdict: 'passed', listed: true, total: 3, ran: 3, seen: 3, notRun: [], missing: [], belowFloor: false, floorMissing: [], floor: '15.4', fatal: false };
const threw = Object.assign({}, full, { verdict: 'DEGRADED', ran: 2, notRun: [{ file: 'app/workflowline.js', why: 'threw', kind: 'TypeError', line: 1 }] });
exports.webkit = { async launch(opts) {
  log({ launch: opts });
  return { version: () => '0.0-fake', async close() {}, async newContext() {
    const init = [];
    return { async close() {}, async addInitScript(s) { init.push(s && s.content); log({ init: s && s.content }); }, async newPage() {
      const on = {};
      return {
        on(evt, fn) { (on[evt] = on[evt] || []).push(fn); },
        async goto(url) { log({ goto: url }); const r = await fetch(url); return { status: () => r.status }; },
        async waitForFunction() {}, async waitForTimeout() {},
        async evaluate() { return { accounting: MODE === 'older' ? null : MODE === 'threw' ? threw : full, banner: false, shim: init.length ? { floor: '15.4', removed: ['array-to-sorted'], absent: [], kept: [] } : null }; },
        async screenshot(o) { fs.writeFileSync(o.path, 'png'); }
      };
    } };
  } };
} };
`;

(async () => {
  const floor = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'engine-floor.mjs')).href);
  const harness = await import(pathToFileURL(SCRIPT).href);
  const table = floor.readFloor();

  /* ---- W1 the shim ---- */
  {
    const shim = floor.shimSource(table);
    const ctx = vm.createContext({});
    // an engine with every table API (stubs where the vm has no browser)
    vm.runInContext('(function (paths) { paths.forEach(function (path) { var p = path.split("."), o = globalThis; for (var j = 0; j < p.length - 1; j++) { if (p[j] === "prototype") { o = o.prototype; continue; } if (o[p[j]] == null) o[p[j]] = function () {}; o = o[p[j]]; } var k = p[p.length - 1]; if (typeof o[k] !== "function") Object.defineProperty(o, k, { value: function () {}, configurable: true, writable: true }); }); })(' +
      JSON.stringify(table.features.filter(f => f.kind === 'api').map(f => f.path)) + ');', ctx);
    vm.runInContext(shim, ctx);
    const kind = p => vm.runInContext('(function () { try { var o = globalThis, s = ' + JSON.stringify(p) + '.split("."); for (var i = 0; i < s.length; i++) o = o[s[i]]; return typeof o; } catch (e) { return "undefined"; } })()', ctx);
    const gone = floor.postFloorApis(table).filter(f => kind(f.path) !== 'undefined').map(f => f.path);
    const kept = floor.floorApis(table).filter(f => kind(f.path) !== 'function').map(f => f.path);
    A.eq([gone, kept], [[], []], 'W1: the shim deletes every API newer than the floor (' + floor.postFloorApis(table).length + ') and keeps every floor API');
    const report = vm.runInContext('globalThis.__STARNET_FLOOR_SHIM__', ctx);
    A.eq([report.floor, report.removed.length, report.kept.length], [table.safari, floor.postFloorApis(table).length, 0], 'W1: and says what it removed');
    const src = fs.readFileSync(SCRIPT, 'utf8');
    A.ok(/shimSource\(table\)/.test(src) && /addInitScript\(\{ content: shim \}\)/.test(src), 'W1: the harness hands the browser the table\'s shim as an init script');
  }

  /* ---- W2 the verdict ---- */
  {
    const full = { checked: true, verdict: 'passed', listed: true, total: 270, ran: 270, seen: 270, notRun: [], missing: [], belowFloor: false, floorMissing: [] };
    const page = over => Object.assign({ path: '/', loaded: true, status: 200, accounting: full, banner: false, shim: { removed: ['x'], kept: [], absent: [] }, pageErrors: [], failedScripts: [] }, over);
    const j = (over, opts) => harness.judgePage(page(over), opts);
    A.eq(j({}), { ok: true, why: [] }, 'W2: green for a full accounting and nothing else wrong');
    const red = [
      ['a script that threw while loading', { accounting: Object.assign({}, full, { verdict: 'DEGRADED', ran: 269, notRun: [{ file: 'app/workflowline.js', why: 'threw', kind: 'SyntaxError', line: 797 }] }) }, 'app/workflowline.js threw while loading (SyntaxError at line 797)'],
      ['a script that did not load', { accounting: Object.assign({}, full, { verdict: 'FAILED', ran: 269, seen: 270, notRun: [{ file: 'app/recipes.js', why: 'load' }] }) }, 'app/recipes.js did not load'],
      ['a script with no load event', { accounting: Object.assign({}, full, { verdict: 'DEGRADED', ran: 269, seen: 269, notRun: [{ file: 'js/util.js', why: 'never' }] }) }, 'js/util.js never ran'],
      ['fewer ran than counted', { accounting: Object.assign({}, full, { ran: 268 }) }, '268 of 270 station scripts ran'],
      ['scripts not seen', { accounting: Object.assign({}, full, { seen: 12 }) }, 'seen for 12 of 270'],
      ['no script counted', { accounting: Object.assign({}, full, { listed: false, total: null, ran: null, seen: 0 }) }, 'counted no station script'],
      ['a check that never ran', { accounting: Object.assign({}, full, { checked: false, verdict: 'not run yet' }) }, 'never ran its check'],
      ['a missing critical module', { accounting: Object.assign({}, full, { verdict: 'FAILED', missing: ['World'] }) }, 'critical modules missing: World'],
      ['an engine below the floor', { accounting: Object.assign({}, full, { belowFloor: true, floorMissing: ['structuredClone'] }) }, 'below the floor (no structuredClone)'],
      ['a verdict that is not passed', { accounting: Object.assign({}, full, { verdict: 'DEGRADED' }) }, 'the boot check reads DEGRADED'],
      ['no accounting (an older boot guard)', { accounting: null }, 'no per-script accounting'],
      ['the fatal banner', { banner: true }, 'fatal boot banner'],
      ['a page error while booting', { pageErrors: ['TypeError: x is not a function @ /app/chat.js:12'] }, 'page error while booting: TypeError'],
      ['a script that did not arrive', { failedScripts: ['/app/recipes.js (HTTP 404)'] }, 'a script did not arrive: /app/recipes.js (HTTP 404)'],
      ['a shim that kept an API', { shim: { removed: [], kept: ['array-with'], absent: [] } }, 'could not remove: array-with'],
      ['no shim', { shim: null }, 'the floor shim did not run'],
      ['a page that did not load', { loaded: false, status: 500 }, 'did not load (HTTP 500)']
    ];
    for (const [what, over, says] of red) {
      const v = j(over);
      A.ok(v.ok === false && v.why.some(w => w.includes(says)), 'W2: red on ' + what + ', saying so: ' + JSON.stringify(v.why));
    }
    A.eq(j({ shim: null }, { floor: false }).ok, true, 'W2: without --floor no shim is expected');
  }

  /* ---- W3 the real script ---- */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-webkit-floor-test-'));
  try {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    const bare = Object.assign({}, process.env, { PLAYWRIGHT_MODULE_DIR: empty });
    const un = await run(['--floor', '--out', path.join(tmp, 'out-un')], bare);
    A.eq(un.code, 3, 'W3: Playwright missing is exit 3 (' + un.out.trim().slice(0, 200) + ')');
    A.ok(un.verdict && un.verdict.ok === false && un.verdict.unconfigured === true && /::warning::/.test(un.out), 'W3: "unconfigured", never green, with a warning annotation');
    A.eq((await run(['--bogus'], bare)).code, 2, 'W3: an unknown argument is a usage error');

    // the fake Playwright (only the edge) and a stub keyless sidecar
    const pwDir = path.join(tmp, 'pw', 'node_modules', 'playwright');
    fs.mkdirSync(pwDir, { recursive: true });
    fs.writeFileSync(path.join(pwDir, 'package.json'), JSON.stringify({ name: 'playwright', version: '0.0.0-fake', main: 'index.js' }));
    fs.writeFileSync(path.join(pwDir, 'index.js'), FAKE_PLAYWRIGHT);
    const stub = path.join(tmp, 'stub-sidecar.js');
    fs.writeFileSync(stub, [
      "'use strict';",
      "const http = require('http');",
      "const secrets = Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET/i.test(k));",
      "http.createServer((req, res) => {",
      "  if (req.url === '/api/health') { res.writeHead(200); return res.end('ok'); }",
      "  res.writeHead(secrets.length ? 500 : 200, { 'Content-Type': 'text/html' }); res.end('<html>stub station</html>');",
      "}).listen(Number(process.env.STARNET_PORT), '127.0.0.1');"
    ].join('\n'));
    const fakeEnv = (mode, log) => Object.assign({}, process.env, { PLAYWRIGHT_MODULE_DIR: path.join(tmp, 'pw'), FAKE_PW_MODE: mode, FAKE_PW_LOG: log, OPENROUTER_API_KEY: 'sk-or-v1-LEAK' });
    const readLog = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

    const out = path.join(tmp, 'out-green'), log = path.join(tmp, 'green.log');
    const green = await run(['--floor', '--sidecar', stub, '--out', out], fakeEnv('green', log));
    A.eq(green.code, 0, 'W3: a full accounting on both pages exits 0 (' + green.out.trim().slice(0, 300) + ')');
    const events = readLog(log), gotos = events.filter(e => e.goto).map(e => e.goto), inits = events.filter(e => 'init' in e).map(e => e.init);
    A.ok(events.some(e => e.launch && e.launch.headless === true), 'W3: WebKit is launched headless');
    A.eq(gotos.map(u => u.replace(/^http:\/\/127\.0\.0\.1:\d+/, '')), ['/', '/agent-station-demo.html'], 'W3: both pages of the booted sidecar are opened: ' + gotos.join(' '));
    const port = Number((/^http:\/\/127\.0\.0\.1:(\d+)\//.exec(gotos[0]) || [])[1]);
    A.ok(port > 0, 'W3: on the port the OS handed out (' + port + ')');
    A.ok(inits.length === 2 && inits.every(s => s === floor.shimSource(table)), 'W3: every page gets the table\'s floor shim before any script');
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'receipt.json'), 'utf8'));
    A.ok(receipt.ok === true && receipt.pages.length === 2 && receipt.pages.every(p => p.ok && p.status === 200 && fs.existsSync(p.screenshot)) && receipt.floor.safari === table.safari && receipt.playwright === '0.0.0-fake',
      'W3: the receipt names the floor, Playwright, each page (HTTP 200 from the keyless stub, no key leaked into it) and its screenshot');

    const redLog = path.join(tmp, 'red.log'), t0 = Date.now();
    const red = await run(['--floor', '--sidecar', stub, '--retry', '1', '--out', path.join(tmp, 'out-red')], fakeEnv('threw', redLog));
    A.eq(red.code, 1, 'W3: a script that did not run exits 1');
    A.ok(red.verdict && red.verdict.attempts === 2 && red.verdict.pages[0].why.some(w => w.includes('app/workflowline.js threw while loading')), 'W3: --retry 1 boots once more, then red naming the script: ' + JSON.stringify(red.verdict && red.verdict.pages[0].why));
    A.ok(/::error::the station page does not boot in WebKit at the floor \(Safari 15\.4\): \/: app\/workflowline\.js/.test(red.out), 'W3: a red run leaves an ::error:: annotation naming the page and the script');
    A.eq(readLog(redLog).filter(e => e.launch).length, 2, 'W3: one browser per attempt (' + (Date.now() - t0) + ' ms)');

    const older = await run(['--floor', '--sidecar', stub, '--out', path.join(tmp, 'out-older')], fakeEnv('older', path.join(tmp, 'older.log')));
    A.ok(older.code === 1 && older.verdict.pages.every(p => p.why.some(w => /no per-script accounting/.test(w))), 'W3: a page whose boot guard has no accounting is red');

    const plainLog = path.join(tmp, 'plain.log');
    const plain = await run(['--sidecar', stub, '--out', path.join(tmp, 'out-plain')], fakeEnv('green', plainLog));
    A.ok(plain.code === 0 && readLog(plainLog).every(e => !('init' in e)), 'W3: without --floor the browser gets no shim');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  /* ---- W4 the wiring ---- */
  const rd = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const wf = rd('.github/workflows/webkit-floor-boot.yml');
  A.ok(/\n {2}workflow_call:/.test(wf), 'W4: the WebKit job is a reusable workflow');
  A.ok(new RegExp('PLAYWRIGHT_VERSION: "' + harness.PLAYWRIGHT_PIN.replace(/\./g, '\\.') + '"').test(wf) && /^\d+\.\d+\.\d+$/.test(harness.PLAYWRIGHT_PIN), 'W4: playwright is pinned to an exact version, the harness\'s own (' + harness.PLAYWRIGHT_PIN + ')');
  A.ok(/npm i --no-save [^\n]*"playwright@\$PLAYWRIGHT_VERSION"/.test(wf) && /npx playwright install --with-deps webkit/.test(wf), 'W4: installed --no-save in CI, with WebKit');
  const pkg = JSON.parse(rd('package.json'));
  A.ok(!Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies)).some(k => /playwright/.test(k)), 'W4: playwright is never a dependency in package.json');
  A.ok(/node scripts\/qa\/webkit-floor-boot\.mjs --floor --retry 1 --out webkit-floor\n/.test(wf), 'W4: the job runs the harness at the floor, with one retry');
  A.ok(/if: always\(\)\n\s+uses: actions\/upload-artifact@v4[\s\S]*path: webkit-floor\//.test(wf), 'W4: the receipt and screenshots are kept, red or green');
  A.ok(/ref: \$\{\{ inputs\.ref \|\| github\.ref \}\}/.test(wf), 'W4: it checks out the ref under test');
  const fast = rd('.github/workflows/fast-gate.yml');
  A.ok(/\n {2}webkit-floor:\n {4}uses: \.\/\.github\/workflows\/webkit-floor-boot\.yml\n/.test(fast), 'W4: fast-gate runs it on every PR and trunk push');
  const train = rd('.github/workflows/release-train.yml');
  const job = (train.match(/\n {2}webkit-floor-boot:\n(?: {4}.*\n| {6}.*\n)+/) || [''])[0];
  A.ok(/uses: \.\/\.github\/workflows\/webkit-floor-boot\.yml/.test(job) && /needs: gate/.test(job) && /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.ref \}\}/.test(job), 'W4: the release train runs it for the tag under test: ' + job.trim().split('\n').join(' | '));
  const stage = train.slice(train.indexOf('\n  stage-draft:'), train.indexOf('\n  stage-draft:') + 200);
  A.ok(/needs: \[[^\]]*\bwebkit-floor-boot\b[^\]]*\]/.test(stage) && /needs: \[[^\]]*\bassemble\b/.test(stage), 'W4: no draft is staged until the page booted at the floor');

  A.report('webkit-floor-boot');
})().catch(e => { console.error(e); process.exit(1); });
