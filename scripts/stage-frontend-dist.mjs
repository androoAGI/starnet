#!/usr/bin/env node
/* stage-frontend-dist.mjs — stage the SHIPPED frontend for the desktop bundle.
 *
 * Tauri embeds every byte under `build.frontendDist` into the executable. Since the 2026-09 station
 * remaster, `frontend/assets/industrial/` also carries the art SOURCES the remaster was calibrated from
 * (review batches, camera audits, calibration sheets: ~1 GB of 2K PNGs) next to the ~200 MB the app
 * actually loads at runtime. Embedding all of it produced a 926 MB executable and made NSIS fail
 * ("error mmapping file … out of range"); the 0.11.2 executable was 18 MB.
 *
 * This script mirrors `frontend/` into `src-tauri/frontend-dist/` (gitignored, regenerated on every
 * build) and drops ONLY the industrial review/source folders that no runtime code path requests. The
 * kept set is the runtime evidence, not a guess:
 *   · `assets/industrial/*.png` (root)          — industrialtextures.js loads shell/floor/wall packs here
 *   · `assets/industrial/remaster/`              — industrialtextures.js floors/walls/workstation facings
 *   · `assets/industrial/projection-correction/` — propremaster.js default ROOT (DENSITY 6) + manifest
 *   · `assets/industrial/complete-sheet/`        — referenced by projection-correction/manifest.json
 *   · `assets/industrial/approved-sheet/`        — propremaster.js `?propSet=approved` / classic fallback
 *   · every other frontend path unchanged (sprites, brand, fonts, sfx, app/, css/, js/, review pages)
 * Anything else under `assets/industrial/<dir>/` (batch02, batch03, props-v2, props-v3, catalog-*,
 * camera-audit, calibration, scale-calibration, parallel-0914, capability-*, tactical-table-polish,
 * sharpness-restoration, …) is calibration/review material consumed by tests and review pages only.
 * The browser/dev sidecar keeps serving the full `frontend/` tree, so nothing changes outside the
 * packaged desktop app.
 *
 * Usage:  node scripts/stage-frontend-dist.mjs          # stage (rm + copy), print the receipt
 *         node scripts/stage-frontend-dist.mjs --check  # print what would be excluded, write nothing
 */
import { cpSync, rmSync, mkdirSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');
export const SRC = join(ROOT, 'frontend');
export const DEST = join(ROOT, 'src-tauri', 'frontend-dist');

// industrial subfolders the runtime requests (see header). Root-level files under assets/industrial always ship.
export const KEEP_INDUSTRIAL = Object.freeze(['projection-correction', 'remaster', 'complete-sheet', 'approved-sheet']);

/** Should this frontend-relative path (posix separators) be staged into the bundle? */
export function shouldStage(rel) {
  const p = String(rel).split('\\').join('/').replace(/^\/+/, '');
  const m = p.match(/^assets\/industrial\/([^/]+)(\/|$)/);
  if (!m) return true;                       // everything outside assets/industrial ships verbatim
  const first = m[1];
  if (!m[2]) return true;                     // a root-level file (shell.png, wall-*.png, *.md) ships
  return KEEP_INDUSTRIAL.includes(first);     // a subfolder ships only when the runtime loads from it
}

function walk(dir, rel, onFile) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name), r = rel ? rel + '/' + name : name;
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, r, onFile);
    else onFile(r, st.size);
  }
}

export function plan(src = SRC) {
  const kept = { files: 0, bytes: 0 }, dropped = { files: 0, bytes: 0, dirs: new Map() };
  walk(src, '', (rel, size) => {
    if (shouldStage(rel)) { kept.files++; kept.bytes += size; return; }
    dropped.files++; dropped.bytes += size;
    const dir = rel.split('/').slice(0, 3).join('/');
    dropped.dirs.set(dir, (dropped.dirs.get(dir) || 0) + size);
  });
  return { kept, dropped };
}

export function stage({ src = SRC, dest = DEST, log = console.log } = {}) {
  if (!existsSync(src)) throw new Error('frontend source missing: ' + src);
  for (const dir of KEEP_INDUSTRIAL) {
    if (!existsSync(join(src, 'assets', 'industrial', dir))) throw new Error('runtime asset folder missing from frontend/assets/industrial: ' + dir);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const rel = relative(src, s);
      if (!rel) return true;
      const posix = rel.split(sep).join('/');
      // a dropped FOLDER must not be created empty: ask the rule with a trailing slash so
      // `assets/industrial/batch03` is judged as the subfolder it is, not as a root-level file.
      return shouldStage(statSync(s).isDirectory() ? posix + '/' : posix);
    }
  });
  const p = plan(src);
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
  log('stage-frontend-dist: ' + p.kept.files + ' file(s) / ' + mb(p.kept.bytes) + ' staged → ' + dest);
  log('  dropped review/source art: ' + p.dropped.files + ' file(s) / ' + mb(p.dropped.bytes));
  for (const [dir, bytes] of [...p.dropped.dirs].sort((a, b) => b[1] - a[1]).slice(0, 12)) log('    - ' + dir + '  ' + mb(bytes));
  return p;
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  if (process.argv.includes('--check')) {
    const p = plan();
    const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
    console.log('would stage ' + p.kept.files + ' file(s) / ' + mb(p.kept.bytes) + '; would drop ' + p.dropped.files + ' file(s) / ' + mb(p.dropped.bytes));
    for (const [dir, bytes] of [...p.dropped.dirs].sort((a, b) => b[1] - a[1])) console.log('  - ' + dir + '  ' + mb(bytes));
  } else {
    stage();
  }
}
