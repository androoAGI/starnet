/* scripts/lib/bundle-source-integrity.mjs — refuse to package an engine or frontend that is missing code.

   The desktop bundle copies its trees straight out of the working tree (src-tauri/tauri.conf.json `resources`), the
   frontend through stage-frontend-dist.mjs. Nothing checked those trees before packaging, so a torn write, an
   interrupted checkout or a tool that truncated a file would ship a zero-byte module that only fails when an installed
   engine first requires it (customer report 85f602c4: "Cannot find module './tools/builtin/shell.js'" with a zero-byte
   shell.js; the public installer itself was inspected and is whole).

   WHICH TREES: the ones tauri.conf.json bundles, read from that map on every run (build.rs reads the same map for the
   install manifest it embeds in the exe, src-tauri/src/install_manifest.rs). A hand list here once named sidecar,
   shared and frontend while the bundle also shipped bin/, so a zero-byte bin/lib/cli-core.js passed. A source outside
   src-tauri ('../bin') is that repo tree; a source the build stages inside src-tauri maps to the tree it is staged
   from (STAGED_RESOURCES), or to null for a third-party tree. A resource that table does not know stops the build, so
   a new bundled tree is never silently unguarded.

   Two rules, both structural, over the repo-owned trees:
     1. no CODE file (.js .cjs .mjs .json .html .css) is zero bytes — none ever is on purpose;
     2. when git is available, every file git tracks WITH CONTENT exists on disk and is not empty.
   The third-party tree (the staged voice-deps node_modules) is named but not held to rule 1: npm packages ship empty
   files on purpose. The install manifest still lists its code files, so an install that lost one is named at startup.
   It never rewrites or restores anything: it names the files and the build stops. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* tauri.conf.json sources the build stages inside src-tauri -> the repo tree each is made from (null: third-party).
   The guard runs before staging, so it checks the source tree, not the staged copy. */
export const STAGED_RESOURCES = Object.freeze({
  'frontend-dist': 'frontend',            // stage-frontend-dist.mjs mirrors frontend/
  'voice-deps/node_modules': null         // stage-voice-deps.mjs: the production closure of npm packages
});
// the code-file set; src-tauri/src/install_manifest.rs CODE_EXTENSIONS lists the same extensions (install-manifest.test.js)
export const CODE = /\.(?:c?js|mjs|json|html?|css)$/i;
// generated/vendor folders inside a bundled tree that are not part of the shipped source
const SKIP_DIRS = new Set(['node_modules', '.git']);

/* The bundled trees, from src-tauri/tauri.conf.json bundle.resources: { repo: [{ tree, installed }], thirdParty: [...] }.
   `tree` is repository-relative. Throws, naming the resource, when a source is neither a repo tree nor a known staged one. */
export function bundledTrees(root) {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const resources = conf && conf.bundle && conf.bundle.resources;
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new Error('src-tauri/tauri.conf.json bundle.resources must be a map of source to installed path');
  }
  const repo = [], thirdParty = [];
  for (const [source, installed] of Object.entries(resources)) {
    const src = String(source).split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (/^\.\.\/[^.]/.test(src) && !src.slice(3).split('/').includes('..')) { repo.push({ tree: src.slice(3), installed }); continue; }
    if (Object.prototype.hasOwnProperty.call(STAGED_RESOURCES, src)) {
      const from = STAGED_RESOURCES[src];
      if (from) repo.push({ tree: from, installed }); else thirdParty.push({ tree: 'src-tauri/' + src, installed });
      continue;
    }
    throw new Error('src-tauri/tauri.conf.json bundles "' + source + '" and the bundle guard does not know which tree it is made from: '
      + 'add it to STAGED_RESOURCES in scripts/lib/bundle-source-integrity.mjs');
  }
  return { repo, thirdParty };
}

function walk(root, rel, onFile) {
  let names;
  try { names = readdirSync(join(root, rel)); }
  catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const r = rel ? rel + '/' + name : name;
    const st = statSync(join(root, r));
    if (st.isDirectory()) walk(root, r, onFile);
    else if (st.isFile()) onFile(r, st.size);
  }
}

/* Files git tracks under the given trees with their HEAD blob sizes, or null when git cannot answer
   (a source archive with no .git): the structural rule still runs and the receipt says git was not consulted. */
export function trackedBlobs(root, trees = bundledTrees(root).repo.map(t => t.tree)) {
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '-l', '-z', 'HEAD', '--', ...trees], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = [];
    for (const rec of out.split('\0')) {
      const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(rec);
      if (m) rows.push({ path: m[2], size: Number(m[1]) });
    }
    return rows;
  } catch (e) {
    console.warn('[bundle-integrity] git could not list tracked files (' + ((e && e.code) || (e && e.message) || e) + '); checking empty code files only');
    return null;
  }
}

export function checkBundleSources({ root, tracked } = {}) {
  if (!root) throw new Error('checkBundleSources needs a root');
  const map = bundledTrees(root);
  const trees = map.repo.map(t => t.tree);
  if (tracked === undefined) tracked = trackedBlobs(root, trees);
  const problems = [];
  const seen = new Set();
  for (const tree of trees) {
    walk(root, tree, (rel, size) => {
      if (size === 0 && CODE.test(rel)) { problems.push({ path: rel, reason: 'empty (0 bytes)' }); seen.add(rel); }
    });
  }
  if (Array.isArray(tracked)) {
    for (const t of tracked) {
      const rel = String(t && t.path || '').split('\\').join('/');
      if (!rel || !(Number(t.size) > 0) || seen.has(rel)) continue;
      if (!trees.some(tree => rel === tree || rel.startsWith(tree + '/'))) continue;
      let st = null;
      try { st = statSync(join(root, rel)); }
      catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      if (!st || !st.isFile()) problems.push({ path: rel, reason: 'missing (git tracks ' + t.size + ' bytes)' });
      else if (st.size === 0) problems.push({ path: rel, reason: 'empty (0 bytes; git tracks ' + t.size + ')' });
    }
  }
  return { problems, gitChecked: Array.isArray(tracked), trees, thirdParty: map.thirdParty.map(t => t.tree) };
}

export function assertBundleSources(opts) {
  const r = checkBundleSources(opts);
  if (r.problems.length) {
    const list = r.problems.slice(0, 20).map(p => '  - ' + p.path + ': ' + p.reason).join('\n');
    throw new Error('refusing to stage the desktop bundle: ' + r.problems.length + ' bundled code file(s) are empty or missing\n' + list
      + (r.problems.length > 20 ? '\n  - …' : '') + '\nRestore them (git checkout -- <path>) and build again; a package built from this tree would fail to start.');
  }
  return r;
}
