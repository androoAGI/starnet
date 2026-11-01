/* node test/protected-floor-ntfs.test.js — the protected-file floor must hold against NTFS stream syntax.

   Found live by sweep/safecell (2026-10-20): Windows opens `<dir>\.env::$DATA` as the file `.env` and
   `<dir>\.git::$INDEX_ALLOCATION\hooks\x` as `.git\hooks\x`, but both floors matched `.env` / `.git` only when
   followed by a dot, a separator or the end of the string. A watched fs.write of `.env::$DATA` (one "Approve once"
   for an ordinary file write) created `workspaces/agent/.env`, a write of `repo/.git::$INDEX_ALLOCATION/hooks/pre-commit`
   planted a git hook, and inside a blessed project with no .env yet `<proj>\.env::$DATA` created one — the realpath
   re-proof only catches a target that already exists.

   Two floors, both checked: the consent broker's hardline (sidecar/index.js hardlineFloor, extracted from source —
   index.js boots a server and cannot be required) and pathtrust.js hardlineReason via a real guard call. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { makePathTrust } = require('../sidecar/pathtrust.js');

const src = readSidecarSource();
const m = src.match(/function hardlineFloor\(call\) \{[\s\S]*?\n\}/);
A.ok(m, 'hardlineFloor(call) found in sidecar/index.js');
if (!m) A.report('protected-floor-ntfs.test');
// eslint-disable-next-line no-new-func
const hardlineFloor = new Function(m[0] + '\nreturn hardlineFloor;')();
const floor = p => hardlineFloor({ name: 'fs.write', args: { path: p } });

for (const p of ['.env::$DATA', '.ENV::$DATA', 'sub\\.env:secret', 'repo/.git::$INDEX_ALLOCATION/hooks/pre-commit',
  'repo\\.git::$INDEX_ALLOCATION\\config', '.git:x', 'C:\\proj\\.env::$DATA']) {
  A.ok(!!floor(p), 'broker floor blocks NTFS stream form: ' + p);
}
// the floor's original shapes still hold, and ordinary neighbours stay writable
for (const p of ['.env', '.env.local', 'a/.git/config', '.git']) A.ok(!!floor(p), 'broker floor still blocks ' + p);
for (const p of ['.envrc', 'notes.env.md', 'my.git.txt', '.github/workflows/ci.yml', 'C:\\proj\\src\\main.js']) A.ok(!floor(p), 'broker floor leaves ' + p + ' alone');

(async () => {
  const ROOT = path.join(os.tmpdir(), 'starnet-floor-ntfs-' + process.pid);
  const proj = path.join(ROOT, 'proj');
  await fsp.mkdir(path.join(proj, 'src'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'src', 'main.js'), '1\n');
  const real = await fsp.realpath(proj);
  const pt = makePathTrust({ fsp, pathMod: path, roots: () => [real], bless: async () => true, isGitRepoOf: async () => false, now: () => 1 });
  const denied = async (p, label) => {
    try { await pt.guard(p, { scope: 'write', surface: 'interactive', prompt: async () => 'once' }); A.ok(false, label + ' — was NOT refused'); }
    catch (e) { A.ok(/protected-file floor/.test(String(e && e.message)), label + ' (' + String(e && e.message).slice(0, 80) + ')'); }
  };
  // no .env and no .git exist yet: the realpath re-proof has nothing to resolve, so the raw floor is the only guard
  await denied(path.join(proj, '.env::$DATA'), 'path trust refuses a NEW .env through ::$DATA in a blessed root');
  await denied(path.join(proj, '.git::$INDEX_ALLOCATION', 'hooks', 'pre-commit'), 'path trust refuses a .git stream path in a blessed root');
  const ok = await pt.guard(path.join(proj, 'src', 'main.js'), { scope: 'write', surface: 'interactive', prompt: async () => 'once' });
  A.ok(ok && ok.abs, 'an ordinary file in the blessed root still resolves');
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
  A.report('protected-floor-ntfs.test');
})();
