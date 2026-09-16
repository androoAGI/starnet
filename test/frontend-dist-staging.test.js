/* node test/frontend-dist-staging.test.js — the desktop bundle embeds the STAGED frontend (frontend/ minus the
   industrial review/source art), never the 1 GB calibration tree. Locks the exclusion rule to the runtime
   evidence (every asset folder the app requests must ship), the build wiring (package.json + both CI
   workflows stage before `tauri build`), and the provenance/ignore contract for the generated folder. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

(async () => {
  const mod = await import(require('node:url').pathToFileURL(path.join(ROOT, 'scripts', 'stage-frontend-dist.mjs')).href);
  const { shouldStage, KEEP_INDUSTRIAL } = mod;

  // ---- 1. the rule: everything ships except industrial subfolders the runtime never loads from ----
  A.eq(KEEP_INDUSTRIAL.slice().sort(), ['approved-sheet', 'complete-sheet', 'projection-correction', 'remaster'], 'the kept industrial folders are exactly the runtime roots');
  for (const p of ['index.html', 'app/chat.js', 'css/app.css', 'assets/sprites/manifest.json', 'assets/brand/starnet-logo.png', 'assets/fonts/vt323.woff2', 'assets/sfx/click.wav', 'prop-catalog-review.html']) {
    A.ok(shouldStage(p), 'ships verbatim: ' + p);
  }
  for (const p of ['assets/industrial/shell.png', 'assets/industrial/wall-acoustic.png', 'assets/industrial/floor-lunar.png', 'assets/industrial/SHELL-MATERIALS.md']) {
    A.ok(shouldStage(p), 'root-level industrial texture ships: ' + p);
  }
  for (const p of ['assets/industrial/projection-correction/manifest.json', 'assets/industrial/projection-correction/runtime-geometry.json', 'assets/industrial/remaster/walls/viewport.png', 'assets/industrial/complete-sheet/sheet.png', 'assets/industrial/approved-sheet/manifest.json']) {
    A.ok(shouldStage(p), 'runtime industrial folder ships: ' + p);
  }
  for (const p of ['assets/industrial/batch03/crew/sidetable.png', 'assets/industrial/props-v3/lowtable.png', 'assets/industrial/batch02/x.png', 'assets/industrial/props-v2/x.png', 'assets/industrial/camera-audit/x.png', 'assets/industrial/catalog-crew/x.png', 'assets/industrial/scale-calibration/x.png', 'assets/industrial/parallel-0914/x.png']) {
    A.ok(!shouldStage(p), 'review/source art is dropped from the bundle: ' + p);
  }
  A.ok(shouldStage('assets\\industrial\\remaster\\floors\\hex.png'), 'Windows separators are normalized');

  // ---- 2. every industrial path the RUNTIME code references must be kept (never drop what the app loads) ----
  const runtimeSources = ['frontend/app/industrialtextures.js', 'frontend/app/propremaster.js', 'frontend/app/projection-prop-effects.js', 'frontend/app/authored-prop-content.js'];
  for (const f of runtimeSources) {
    if (!fs.existsSync(path.join(ROOT, f))) continue;
    const src = rd(f);
    const literal = src.match(/assets\/industrial\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g) || [];
    for (const ref of new Set(literal)) {
      const rel = ref.replace(/^assets\//, 'assets/');
      // config strings that name SOURCE roots for review tooling are allowed; actual loads use the kept roots.
      if (/sourceRoot|batch03|props-v3/.test(ref) && /authored-prop-content/.test(f)) continue;
      A.ok(shouldStage(rel), f + ' references a shipped path: ' + ref);
    }
  }
  // the default remaster root is projection-correction (DENSITY 6) and its manifest points at complete-sheet
  A.ok(/projection-correction\//.test(rd('frontend/app/propremaster.js')), 'propremaster ROOT names projection-correction');
  const manifest = JSON.parse(rd('frontend/assets/industrial/projection-correction/manifest.json'));
  const refs = new Set();
  (function walk(v) { if (typeof v === 'string' && /\.(png|webp|json)$/i.test(v)) refs.add(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(manifest);
  A.ok(refs.size > 100, 'the projection manifest names its images (' + refs.size + ')');
  for (const ref of refs) {
    const rel = path.posix.normalize('assets/industrial/projection-correction/' + ref);
    A.ok(shouldStage(rel), 'every image the shipped projection manifest points at is staged: ' + rel);
  }
  A.ok(shouldStage('assets/industrial/complete-sheet/starnet-props-full-sheet.png'), 'the full sheet the manifest reaches through ../complete-sheet ships');

  // ---- 3. wiring: the stage runs before every desktop build, locally and on both CI legs ----
  const pkg = JSON.parse(rd('package.json'));
  A.ok(/stage-frontend-dist\.mjs && tauri build$/.test(pkg.scripts['desktop:build']), 'desktop:build stages the frontend immediately before tauri build');
  A.ok(/stage-frontend-dist\.mjs && tauri dev$/.test(pkg.scripts['desktop:dev']), 'desktop:dev stages the frontend before tauri dev (frontendDist is the staged copy)');
  for (const wf of ['.github/workflows/release-train.yml', '.github/workflows/desktop-build.yml']) {
    const y = rd(wf);
    A.ok(/stage-voice-deps\.mjs --target \$\{\{ matrix\.target \}\}\n\s+node scripts\/stage-frontend-dist\.mjs\n/.test(y), wf + ' stages the frontend right after the voice deps, before the build step');
  }
  const tauri = JSON.parse(rd('src-tauri/tauri.conf.json'));
  A.eq(tauri.build.frontendDist, 'frontend-dist', 'tauri embeds the staged folder');
  // the packaged sidecar serves the SAME staged copy as its `frontend` resource — the first 0.12.0 cut
  // shipped a 1.5 GB installer because this resource still pointed at the full ../frontend tree.
  A.eq(tauri.bundle.resources['frontend-dist'], 'frontend', 'the sidecar frontend resource is the staged copy (target name unchanged)');
  A.ok(!('../frontend' in tauri.bundle.resources), 'the full frontend tree is never copied into the bundle as a resource');
  A.eq(tauri.bundle.resources['../sidecar'], 'sidecar', 'sidecar resource unchanged');
  A.eq(tauri.bundle.resources['../shared'], 'shared', 'shared resource unchanged');
  A.ok(/^src-tauri\/frontend-dist\/$/m.test(rd('.gitignore')), 'the staged folder is gitignored (generated, never committed, never makes a build dirty)');
  A.ok(/"frontend-dist",/.test(rd('src-tauri/build.rs')), 'build.rs reruns provenance when the staged folder changes');

  A.report('frontend-dist-staging.test');
})().catch((e) => { console.error(e); process.exit(1); });
