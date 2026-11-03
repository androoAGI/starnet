/* node test/bundle-source-integrity.test.js — a desktop package must never ship an empty or missing engine module.

   Customer report 85f602c4 (Windows 0.13.2): the local engine would not start, quoting
   "Cannot find module './tools/builtin/shell.js'" with the installed shell.js at zero bytes. The public installer's
   shell.js was inspected and is whole, so this guard does not claim to explain that install. What it closes is the
   build-side door: every bundle path (npm run desktop:build, desktop:dev and both CI workflows) copies the bundled
   trees straight from the working tree, and nothing checked that tree. A torn or zero-byte module in the checkout
   a package is built from would ship as-is. The staging step now refuses to stage when a bundled code file is empty,
   or when a file git tracks with content is missing or empty on disk.

   CLASS: the trees come from src-tauri/tauri.conf.json bundle.resources, never a hand list. The guard once named
   sidecar, shared and frontend while the bundle also shipped bin/, so a zero-byte bin/lib/cli-core.js passed. Every
   repo-owned tree the real map bundles is damaged in turn below; the third-party voice-deps tree is named but not held
   to the empty-file rule; a resource the guard cannot classify stops the build. */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..');
const REAL_CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));

(async () => {
  const mod = await import(require('node:url').pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'bundle-source-integrity.mjs')).href);
  const { checkBundleSources, assertBundleSources, bundledTrees } = mod;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-integrity-'));
  const put = (rel, text) => { const f = path.join(tmp, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const paths = r => r.problems.map(p => p.path).sort();
  try {
    // the fixture checkout bundles exactly what the real one does
    put('src-tauri/tauri.conf.json', JSON.stringify({ bundle: { resources: REAL_CONF.bundle.resources } }, null, 2));
    put('sidecar/index.js', 'require("./tools/builtin/shell.js");\n');
    put('sidecar/tools/builtin/shell.js', 'module.exports = {};\n');
    put('shared/events.js', 'module.exports = {};\n');
    put('bin/starnet.js', 'require("./lib/cli-core.js");\n');
    put('bin/lib/cli-core.js', 'module.exports = function main() {};\n');
    put('frontend/app/app.js', 'window.App = {};\n');
    put('frontend/index.html', '<!doctype html>\n');
    put('frontend/assets/blank.png', '');   // an empty MEDIA file is not code: never a reason to refuse a build
    put('src-tauri/voice-deps/node_modules/pkg/empty.js', '');   // third-party packages ship empty files on purpose

    const clean = checkBundleSources({ root: tmp, tracked: null });
    A.eq(clean.problems, [], 'a whole tree stages');
    A.eq(clean.trees.slice().sort(), ['bin', 'frontend', 'shared', 'sidecar'], 'the repo trees come from the tauri.conf.json map: ' + JSON.stringify(clean.trees));
    A.eq(clean.thirdParty, ['src-tauri/voice-deps/node_modules'], 'the third-party tree is named, and its empty files are not refused');

    // the customer's shape: shell.js present but zero bytes
    put('sidecar/tools/builtin/shell.js', '');
    const empty = checkBundleSources({ root: tmp, tracked: null });
    A.eq(empty.problems.map(p => p.path), ['sidecar/tools/builtin/shell.js'], 'an empty engine module is refused by name');
    A.ok(/empty/.test(empty.problems[0].reason), 'the reason says it is empty: ' + empty.problems[0].reason);
    let threw = null;
    try { assertBundleSources({ root: tmp, tracked: null }); } catch (e) { threw = e; }
    A.ok(threw && /sidecar\/tools\/builtin\/shell\.js/.test(threw.message) && /refusing to stage/i.test(threw.message),
      'the build stops before packaging and names the file: ' + (threw && threw.message));
    put('sidecar/tools/builtin/shell.js', 'module.exports = {};\n');

    // CLASS: a zero-byte code file in EVERY repo-owned tree the real map bundles is refused by name, bin/ included
    const repoTrees = bundledTrees(ROOT).repo.map(t => t.tree);
    A.ok(repoTrees.includes('bin') && repoTrees.includes('sidecar') && repoTrees.includes('frontend') && repoTrees.includes('shared'),
      'the real map bundles bin, sidecar, frontend and shared: ' + JSON.stringify(repoTrees));
    for (const tree of repoTrees) {
      const rel = tree + '/zz-probe/zeroed.js';
      put(rel, '');
      A.eq(paths(checkBundleSources({ root: tmp, tracked: null })), [rel], 'a zero-byte code file in ' + tree + '/ is refused by name');
      fs.rmSync(path.join(tmp, tree, 'zz-probe'), { recursive: true, force: true });
    }
    put('bin/lib/cli-core.js', '');
    A.eq(paths(checkBundleSources({ root: tmp, tracked: null })), ['bin/lib/cli-core.js'], 'a zero-byte bin/lib/cli-core.js no longer passes');
    put('bin/lib/cli-core.js', 'module.exports = function main() {};\n');

    // an empty shared contract or frontend script is the same failure
    put('shared/schema.js', '');
    put('frontend/app/chat.js', '');
    A.eq(paths(checkBundleSources({ root: tmp, tracked: null })), ['frontend/app/chat.js', 'shared/schema.js'], 'shared/ and frontend code are checked too');
    put('shared/schema.js', 'module.exports = {};\n');
    put('frontend/app/chat.js', 'window.Chat = {};\n');

    // git-tracked content that is missing (or empty) on disk is refused even when it is not a .js file
    const tracked = [
      { path: 'sidecar/index.js', size: 40 },
      { path: 'sidecar/tools/builtin/shell.js', size: 21 },
      { path: 'sidecar/skills/catalog.json', size: 300 },
      { path: 'bin/lib/station-recovery.json', size: 12 },
      { path: 'frontend/assets/blank.png', size: 0 },     // tracked empty stays allowed
      { path: 'docs/notes.md', size: 10 }                  // outside the bundled trees: not this guard's business
    ];
    const missing = checkBundleSources({ root: tmp, tracked });
    A.eq(paths(missing), ['bin/lib/station-recovery.json', 'sidecar/skills/catalog.json'], 'a tracked bundled file missing on disk is refused, in bin/ too');
    A.ok(missing.problems.every(p => /missing/.test(p.reason)), JSON.stringify(missing.problems));
    put('bin/lib/station-recovery.json', '{}\n');
    put('sidecar/skills/catalog.json', '');
    A.eq(paths(checkBundleSources({ root: tmp, tracked })), ['sidecar/skills/catalog.json'], 'a tracked file emptied on disk is refused');
    put('sidecar/skills/catalog.json', '{}\n');
    A.eq(checkBundleSources({ root: tmp, tracked }).problems, [], 'restored: stages again');

    // no git (a source tarball build): the structural rule still runs, and the receipt says git was not consulted
    const nogit = checkBundleSources({ root: tmp, tracked: null });
    A.eq(nogit.gitChecked, false, 'the receipt never claims a git comparison it did not make');
    A.eq(checkBundleSources({ root: tmp, tracked }).gitChecked, true);

    // a bundled resource the guard cannot classify stops the build, named, instead of going unguarded
    put('src-tauri/tauri.conf.json', JSON.stringify({ bundle: { resources: Object.assign({}, REAL_CONF.bundle.resources, { 'models-dist': 'models' }) } }));
    let unknown = null;
    try { checkBundleSources({ root: tmp, tracked: null }); } catch (e) { unknown = e; }
    A.ok(unknown && /models-dist/.test(unknown.message) && /STAGED_RESOURCES/.test(unknown.message), 'an unknown bundled tree is refused by name: ' + (unknown && unknown.message));
    put('src-tauri/tauri.conf.json', JSON.stringify({ bundle: { resources: Object.assign({}, REAL_CONF.bundle.resources, { '../docs': 'docs' }) } }));
    put('docs/zeroed.json', '');
    A.eq(paths(checkBundleSources({ root: tmp, tracked: null })), ['docs/zeroed.json'], 'a newly bundled repo tree is guarded the moment the map names it');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // WIRING: every bundle path runs stage-frontend-dist, and staging runs the guard first
  const stageSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'stage-frontend-dist.mjs'), 'utf8');
  A.ok(/assertBundleSources\(/.test(stageSrc), 'stage-frontend-dist calls the guard');
  A.ok(stageSrc.indexOf('assertBundleSources(') < stageSrc.lastIndexOf('stage();'), 'the guard runs before anything is staged');
  const guardSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'bundle-source-integrity.mjs'), 'utf8');
  A.ok(!/BUNDLED_TREES\s*=/.test(guardSrc) && /tauri\.conf\.json/.test(guardSrc), 'the guard keeps no hand list of trees; it reads the tauri map');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const script of ['desktop:build', 'desktop:dev']) A.ok(/stage-frontend-dist\.mjs/.test(pkg.scripts[script]), script + ' stages through the guarded script');
  for (const wf of ['desktop-build.yml', 'release-train.yml']) {
    A.ok(/node scripts\/stage-frontend-dist\.mjs/.test(fs.readFileSync(path.join(ROOT, '.github', 'workflows', wf), 'utf8')), wf + ' stages through the guarded script');
  }

  // the real checkout this test runs in is whole
  const real = checkBundleSources({ root: ROOT });
  A.eq(real.problems, [], 'this checkout has no empty or missing bundled module');

  A.report('bundle-source-integrity');
})().catch(e => { console.error(e); process.exit(1); });
