/* node test/engine-floor.test.js — scripts/lib/engine-floor.json is the ONE web-engine floor, and every mirror equals it.

   THE HOLE THIS CLOSES (gh#136, qa/bugs/5308fc67, email E12): the floor was declared three ways and they disagreed.
   tauri.conf.json promised macOS 11.0; bootguard.js called any engine without regex lookbehind TOO OLD ("needs Safari
   16.4+"), so on a healthy Safari 16.0 Mac every copied report said "web engine: TOO OLD" and one missing non-critical
   file rendered "STARNET NEEDS A NEWER macOS" with RELOAD hidden instead of naming the file; and the syntax ratchet
   banned 16.4 syntax precisely so that engines BELOW 16.4 could parse the page.

   Laws:
     F1 the table is well-formed: one floor (Safari, the macOS minimum, the first macOS that ships that Safari) and its
        features, each syntax (a pattern) or api (a path), each with the Safari version that shipped it;
     F2 every mirror equals it: tauri.conf.json bundle.macOS.minimumSystemVersion, bootguard's FLOOR literal and its
        floor probes (exactly the api features whose since IS the floor), and the ratchet that reads it; bootguard
        names no other Safari version;
     F3 bootguard calls an engine too old EXACTLY when it is below the floor: an engine with every floor API and every
        newer one removed by the WebKit floor shim is not; a Safari 16.0 engine (no regex lookbehind) is not; an engine
        without any ONE floor API is, for every floor API in turn, and it names that API;
     F4 the words come from FLOOR: below the floor the report and the banner name Safari <floor> and the missing APIs,
        RELOAD hidden; above it a missing file is a broken file, named, with RELOAD;
     F5 staging refuses a drifted mirror, naming the file and the floor's value, before it stages anything. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { decomment } = require('./helpers/decomment.js');

const ROOT = path.join(__dirname, '..');
const BG = 'frontend/app/bootguard.js';
const SRC = fs.readFileSync(path.join(ROOT, BG), 'utf8');
const CRITICAL = ['U', 'Harness', 'Save', 'CloudSave', 'World', 'StationUI', 'Chat', 'Channels', 'Personas', 'Onboarding', 'Tutorial', 'App', 'Topbar'];
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function fakeEl(tag) {
  const el = { tagName: tag.toUpperCase(), children: [], style: {}, attrs: {}, textContent: '', className: '', id: '' };
  el.appendChild = c => { el.children.push(c); return c; };
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.getAttribute = k => el.attrs[k];
  return el;
}
function textOf(el) { return (el.textContent || '') + el.children.map(textOf).join('\n'); }

(async () => {
  let floor = null, table = null;
  try {
    floor = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'engine-floor.mjs')).href);
    table = floor.readFloor();
  } catch (e) { A.ok(false, 'F1: the one floor exists and reads (scripts/lib/engine-floor.json via engine-floor.mjs): ' + (e && e.message)); }

  /* ---- F1 the table ---- */
  if (table) {
    A.eq([table.safari, table.macos, table.macosWithFloor], ['15.4', '11.0', '12.3'], 'F1: the floor is Andrew\'s default: Safari 15.4 on macOS 11.0+, built into macOS 12.3');
    A.ok(floor.floorApis(table).length >= 3, 'F1: APIs define the floor: ' + floor.floorApis(table).map(f => f.path).join(', '));
    A.ok(floor.postFloorSyntax(table).some(f => f.id === 'regex-lookbehind') && floor.postFloorSyntax(table).some(f => f.id === 'class-static-block'), 'F1: the two syntax rules the ratchet always had are newer than the floor');
    A.ok(floor.postFloorApis(table).length >= 20, 'F1: APIs newer than the floor are listed (' + floor.postFloorApis(table).length + ')');
    const broken = Object.assign({}, table, { features: table.features.concat([{ id: 'array-at', kind: 'api', since: '15.4', path: 'Array.prototype.at' }]) });
    A.ok((() => { try { floor.validate(broken); return false; } catch (e) { return /listed twice/.test(e.message); } })(), 'F1: a feature listed twice is refused');
    A.ok((() => { try { floor.validate(Object.assign({}, table, { safari: '15' })); return false; } catch (e) { return /safari/.test(e.message); } })(), 'F1: a floor that is not a version is refused');
  }

  /* ---- F2 the mirrors ---- */
  const tauri = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  A.eq(tauri.bundle.macOS.minimumSystemVersion, table ? table.macos : '11.0', 'F2: tauri.conf.json minimumSystemVersion is the floor\'s macOS (unchanged at 11.0)');
  if (floor && table) {
    A.eq(floor.readFloorLiteral(SRC), { safari: table.safari, macos: table.macos, macosWithFloor: table.macosWithFloor }, 'F2: bootguard\'s FLOOR literal is the table');
    A.eq(floor.readProbeNames(SRC), floor.floorApis(table).map(f => f.path), 'F2: bootguard\'s floor probes are exactly the APIs the floor is defined by');
    A.eq(floor.mirrorDrift({ root: ROOT, table }), [], 'F2: no mirror drifts');
  }
  const code = decomment(SRC);
  A.ok(!/Safari \d+\.\d+/.test(code) && !/\(\?<[=!]/.test(code), 'F2: bootguard names no Safari version of its own and parses no lookbehind (every floor word comes from FLOOR)');
  const ratchet = fs.readFileSync(path.join(ROOT, 'test', 'webkit-floor-syntax.test.js'), 'utf8');
  A.ok(/floor\.syntaxRules\(table\)/.test(ratchet) && /floor\.apiRules\(table\)/.test(ratchet) && !/\bALLOW\b/.test(ratchet) && !/re: \//.test(ratchet), 'F2: the syntax/API ratchet takes its rules from the table and has no allowlist');

  /* ---- F3 / F4 bootguard in engines built from the table ---- */
  // a modern engine: every api feature of the table exists (the owners a browser has, as stubs in the vm)
  const apis = table ? table.features.filter(f => f.kind === 'api') : [];
  const ENSURE = '(function (paths) {\n' +
    '  for (var i = 0; i < paths.length; i++) {\n' +
    '    var p = paths[i].split("."), o = globalThis;\n' +
    '    for (var j = 0; j < p.length - 1; j++) {\n' +
    '      if (p[j] === "prototype") { o = o.prototype; continue; }\n' +
    '      if (o[p[j]] == null) o[p[j]] = function () {};\n' +
    '      o = o[p[j]];\n' +
    '    }\n' +
    '    var k = p[p.length - 1];\n' +
    '    if (typeof o[k] !== "function") Object.defineProperty(o, k, { value: function () {}, configurable: true, writable: true });\n' +
    '  }\n' +
    '  if (typeof Crypto === "function" && !globalThis.crypto) globalThis.crypto = Object.create(Crypto.prototype);\n' +
    // older than the floor (Safari 14), so in every engine at it: an engine is judged by the floor's own APIs
    '  if (typeof Element === "function" && !Element.prototype.replaceChildren) Element.prototype.replaceChildren = function () {};\n' +
    '})(' + JSON.stringify(apis.map(f => f.path)) + ');';
  const NO_LOOKBEHIND = "(function () { var R = RegExp; var W = function RegExp(p, f) { if (/\\(\\?<[=!]/.test(String(p && p.source !== undefined ? p.source : p))) throw new SyntaxError('Invalid regular expression: invalid group specifier name'); return new R(p, f); }; W.prototype = R.prototype; globalThis.RegExp = W; })();";
  function drop(p) {
    const parts = p.split('.'), key = parts.pop();
    return 'delete ' + (parts.length ? 'globalThis.' + parts.join('.') : 'globalThis') + '[' + JSON.stringify(key) + '];';
  }
  function engine({ shimAt = table && table.safari, drops = [], noLookbehind = false, mac = false, missing = [] } = {}) {
    const handlers = { win: {}, doc: {} };
    const body = fakeEl('body');
    const document = { readyState: 'loading', body, addEventListener(t, fn) { (handlers.doc[t] = handlers.doc[t] || []).push(fn); }, createElement: fakeEl };
    const sandbox = {
      document, console,
      location: { href: 'tauri://localhost/', pathname: '/', reload() { sandbox.__reloaded = (sandbox.__reloaded || 0) + 1; } },
      navigator: { userAgent: mac ? MAC_UA : 'test-ua' },
      addEventListener(t, fn) { (handlers.win[t] = handlers.win[t] || []).push(fn); }
    };
    sandbox.window = sandbox;
    for (const n of CRITICAL) if (!missing.includes(n)) sandbox[n] = {};
    vm.createContext(sandbox);
    vm.runInContext(ENSURE, sandbox);
    if (shimAt && floor) vm.runInContext(floor.shimSource(Object.assign({}, table, { safari: shimAt })), sandbox);
    for (const p of drops) vm.runInContext(drop(p), sandbox);
    if (noLookbehind) vm.runInContext(NO_LOOKBEHIND, sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'bootguard.js' });
    const g = sandbox.BootGuard;
    const fire = (t, e) => (handlers.win[t] || []).forEach(fn => fn(e));
    const ready = () => (handlers.doc.DOMContentLoaded || []).forEach(fn => fn({}));
    const banner = () => body.children.find(c => c.id === 'bootguard-fatal') || null;
    const tooOld = () => /web engine:\s+TOO OLD/.test(g.report());
    return { sandbox, g, fire, ready, banner, tooOld };
  }
  const missingScript = () => ({ target: Object.assign(fakeEl('script'), { src: 'tauri://localhost/app/foryou.js' }) });

  if (table) {
    // the floor engine itself: every API newer than the floor deleted by the WebKit floor shim
    const atFloor = engine();
    const shim = atFloor.sandbox.__STARNET_FLOOR_SHIM__;
    A.eq(shim && shim.removed.slice().sort(), floor.postFloorApis(table).map(f => f.id).sort(), 'F3: the floor shim deletes every table API newer than the floor');
    A.eq(shim && [shim.kept, shim.absent], [[], []], 'F3: and keeps none of them');
    atFloor.ready();
    A.eq(atFloor.tooOld(), false, 'F3: an engine exactly at the floor is not too old');
    // a Safari 16.0 engine (APIs newer than 16.0 gone, no regex lookbehind): the engine the old 16.4 probe misjudged
    const s16 = engine({ shimAt: '16.0', noLookbehind: true, mac: true });
    s16.ready();
    A.eq(s16.tooOld(), false, 'F3: a Safari 16.0 engine (no lookbehind) is not called too old in the copied report');
    const s16b = engine({ shimAt: '16.0', noLookbehind: true, mac: true });
    s16b.fire('error', missingScript()); s16b.ready();
    const b16 = s16b.banner(), t16 = b16 ? textOf(b16) : '';
    A.ok(/STATION FAILED TO BOOT/.test(t16) && t16.includes('script did not load — app/foryou.js') && /RELOAD/.test(t16), 'F4: above the floor a missing file is a broken file: named, with RELOAD (' + t16.split('\n')[0] + ')');
    A.ok(!/NEWER macOS/.test(t16), 'F4: never "a newer macOS" for a missing file above the floor');
    // below the floor: each floor API missing, in turn
    for (const f of floor.floorApis(table)) {
      const e = engine({ drops: [f.path], mac: true, missing: ['World'] });
      e.ready();
      const r = e.g.report(), b = e.banner(), txt = b ? textOf(b) : '';
      A.ok(e.tooOld() && r.includes('no ' + f.path) && r.includes('needs Safari ' + table.safari + '+'), 'F3: an engine without ' + f.path + ' is below the floor, and the report names it: ' + (r.split('\n').find(l => /web engine/.test(l)) || 'no web engine line'));
      A.ok(/NEEDS A NEWER macOS/.test(txt) && txt.includes('Safari ' + table.safari) && txt.includes('macOS 11 Big Sur') && txt.includes('macOS 12.3 Monterey') && !/RELOAD/.test(txt), 'F4: and the banner says which macOS and Safari, without RELOAD (' + f.path + ')');
    }
    // an engine below the floor on another OS names the APIs it lacks
    const linux = engine({ drops: ['structuredClone'], missing: ['World'] });
    linux.ready();
    const lb = linux.banner() ? textOf(linux.banner()) : '';
    A.ok(/NEEDS A NEWER WEB ENGINE/.test(lb) && lb.includes('no structuredClone'), 'F4: off macOS the banner names the missing API');
    // a [SecureContext] API is no evidence of age on a page served insecurely
    const lan = engine({ drops: ['Crypto.prototype.randomUUID'] });
    lan.sandbox.isSecureContext = false;
    const fm = lan.g._internals.floorMissing;
    A.eq(typeof fm === 'function' ? fm() : 'no floorMissing()', [], 'F3: crypto.randomUUID missing on an insecure page is not "below the floor"');
  }

  /* ---- F5 staging refuses a drifted mirror ---- */
  const stageSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-frontend-dist.mjs'), 'utf8');
  const main = stageSrc.slice(stageSrc.indexOf('if (isMain)'));
  A.ok(/assertEngineFloor\(\{ root: ROOT \}\)/.test(main) && main.indexOf('assertEngineFloor(') < main.lastIndexOf('stage();'), 'F5: the staging entry checks the floor before it stages');
  if (floor && table) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-engine-floor-'));
    try {
      const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
      const conf = JSON.stringify(tauri, null, 2);
      put('src-tauri/tauri.conf.json', conf); put(BG, SRC);
      const refused = () => { try { floor.assertEngineFloor({ root: tmp, table }); return ''; } catch (e) { return e.message; } };
      A.eq(refused(), '', 'F5: agreeing mirrors stage');
      const drifted = JSON.parse(conf); drifted.bundle.macOS.minimumSystemVersion = '12.0';
      put('src-tauri/tauri.conf.json', JSON.stringify(drifted, null, 2));
      let msg = refused();
      A.ok(msg.includes('src-tauri/tauri.conf.json') && msg.includes('"12.0"') && msg.includes('macOS "' + table.macos + '"'), 'F5: a drifted tauri.conf.json is refused, named, with the floor\'s value: ' + msg.split('\n')[1]);
      put('src-tauri/tauri.conf.json', conf);
      put(BG, SRC.replace("safari: '" + table.safari + "'", "safari: '16.4'"));
      msg = refused();
      A.ok(msg.includes(BG + ' FLOOR.safari is "16.4"') && msg.includes('"' + table.safari + '"'), 'F5: a drifted bootguard FLOOR is refused, named: ' + msg.split('\n')[1]);
      put(BG, SRC.replace(/\n\s*\['structuredClone',[^\n]*/, ''));
      msg = refused();
      A.ok(msg.includes(BG + ' FLOOR_PROBES are') && msg.includes('structuredClone'), 'F5: a floor probe dropped from bootguard is refused, named: ' + msg.split('\n')[1]);
      put(BG, SRC.replace(/const FLOOR = Object\.freeze\(/, 'const FLOOR_ = Object.freeze('));
      A.ok(refused().includes(BG + ' carries no FLOOR literal'), 'F5: a bootguard without the literal is refused');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  A.report('engine-floor');
})().catch(e => { console.error(e); process.exit(1); });
