/* node test/egress-files.test.js — a file LEAVES the station only from the producing run's own folders (run-paths lane,
   review round 2, 2026-10-28; sidecar/egress-files.js).

   OWNER DECISION, final: channel.send's files, a routine delivery's ATTACH names and generated-image picks, and
   web_request's ${file:…} carry a file out only when its REAL path is inside the producing run's own private workspace
   (paths.jail) or its own approved project root (paths.root). The credential / repository floor always holds, for every
   spelling including jail-relative names and whatever fullAccess / unrestrictedHost say. Never another blessed root, a
   session root, a hand-off read grant, This Computer or Full Power reach; never a path-trust prompt; never an absolute
   host path in what a chat or the model is told.

   Built as index.js wires it: the REAL path-trust core, a run's ctx.paths minted with runPathTrust's options (posture,
   grants and a live prompt included), and makeEgressReader({ guard: pathTrustCore.guard }). Every row below that is
   "refused" was SENT before this fix (scratchpad probes r2-egress.js, r2-jailfloor.js). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const RunPaths = require('../sidecar/run-paths.js');
const { makeEgressReader } = require('../sidecar/egress-files.js');

const isWin = process.platform === 'win32';
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-egress-')));
const WS = path.join(BASE, 'workspaces'), PA = path.join(BASE, 'projA'), PB = path.join(BASE, 'projB'), HOME = path.join(BASE, 'home');
const JAIL = path.join(WS, 'alpha');
for (const d of [path.join(JAIL, 'shots'), path.join(JAIL, 'repo', '.git'), path.join(WS, 'gamma'), path.join(WS, 'beta'), path.join(PA, '.git'), PB, path.join(HOME, '.ssh')]) fs.mkdirSync(d, { recursive: true });
const put = (p, s) => fs.writeFileSync(p, s);
put(path.join(JAIL, 'shots', 'x.png'), 'PNG-alpha');
put(path.join(JAIL, 'repo', '.env'), 'OPENAI_API_KEY=sk-live-jail');
put(path.join(JAIL, 'repo', '.git', 'config'), '[remote] url = https://ghp_TOKEN@github.com/me/repo');
put(path.join(WS, 'gamma', 'private.md'), 'GAMMA-PRIVATE');
put(path.join(PA, 'report.md'), 'A-REPORT');
put(path.join(PA, '.env'), 'A_SECRET=dotenv');
put(path.join(PA, '.git', 'config'), '[remote] url=https://tok@github.com/x');
put(path.join(PA, 'appsettings.json'), '{"Password":"hunter2"}');
put(path.join(PB, 'credentials.json'), '{"private_key":"B"}');
put(path.join(HOME, 'taxes.pdf'), 'HOME-TAXES');
put(path.join(HOME, '.ssh', 'id_ed25519'), 'SSH-KEY');

let blessed = [PA, PB];
const core = makePathTrust({ fsp, pathMod: path, roots: () => blessed, workspaceRoot: WS, now: () => 0 });
let prompted = 0;
const askAlways = async () => { prompted++; return 'always'; };
// a run's ctx.paths exactly as runOnceCore mints it: the run guard carries the posture, the hand-off grants and a prompt
function runCtx(o) {
  o = o || {};
  const agentId = o.agentId || 'alpha';
  const runPathTrust = (abs, o2) => core.guard(abs, {
    scope: (o2 && o2.scope) || 'read', surface: o.surface || 'autonomous', prompt: o.prompt || null, sessionRoots: new Set(),
    agentId: (o2 && o2.agentId) || agentId, readGrants: o.readGrants || [], fullAccess: !!o.fullAccess, unrestrictedHost: !!o.unrestrictedHost });
  const paths = RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: WS, pathTrust: runPathTrust }), { agentId, projectRoot: o.projectRoot || '' });
  return { agentId, paths };
}
const reader = makeEgressReader({ fsp, pathMod: path, workspaces: WS, guard: (abs, o2) => core.guard(abs, o2), maxBytes: 50 * 1024 * 1024 });
const noHostPath = got => !String(got.error || '').includes(BASE) && !String(got.shown || '').includes(BASE) && !/^[A-Za-z]:[\\/]|^[\\/]/.test(String(got.shown || ''));
function plant(linkAt, target) {
  try { fs.symlinkSync(target, linkAt, isWin ? 'junction' : 'dir'); return true; }
  catch (e) { console.log('[skip] could not plant a link at ' + linkAt + ': ' + e.message); return false; }
}

(async () => {
  try {
    const unscoped = runCtx({}), inA = runCtx({ projectRoot: PA });
    const sends = async (label, name, ctx, root, bytes) => {
      const got = await reader.readFor(ctx ? ctx.agentId : 'alpha', name, ctx, root);
      A.ok(got.ok && got.buffer.toString() === bytes, label + ' SENDS (' + (got.ok ? 'ok' : got.error) + ')');
    };
    const refuses = async (label, name, ctx, root, re) => {
      const got = await reader.readFor(ctx ? ctx.agentId : 'alpha', name, ctx, root);
      A.ok(!got.ok, label + ' is REFUSED (was: ' + (got.ok ? JSON.stringify(got.buffer.toString()) + ' sent' : 'refused') + ')');
      if (!got.ok && re) A.ok(re.test(got.error), label + ': says why (' + got.error + ')');
      if (!got.ok) A.ok(noHostPath(got), label + ': the refusal names no absolute host path (' + got.error + ' | ' + got.shown + ')');
      return got;
    };

    // ---- 1. the owner decision: the run's OWN approved root and its OWN private workspace still send ----
    await sends('project-A run, relative report.md', 'report.md', inA, '', 'A-REPORT');
    await sends('project-A run, its own root by absolute path', path.join(PA, 'report.md'), inA, '', 'A-REPORT');
    await sends('unscoped run, jail-relative shots/x.png', 'shots/x.png', unscoped, '', 'PNG-alpha');
    await sends('project-A run, its own jail by absolute path', path.join(JAIL, 'shots', 'x.png'), inA, '', 'PNG-alpha');
    await sends('routine delivery (a finished project-A row), relative report.md', 'report.md', null, PA, 'A-REPORT');
    if (isWin) await sends('project-A run, its own jail by a case variant', path.join(WS, 'ALPHA', 'SHOTS', 'X.PNG'), inA, '', 'PNG-alpha');

    // ---- 2. nothing beyond the run's own folders (B1: every one of these was SENT) ----
    const outside = /outside (your workspace|this run's project folder or your workspace)/;
    await refuses('unscoped chat run, a file in another blessed root', path.join(PB, 'credentials.json'), unscoped, '', outside);
    await refuses('project-A run, a file in ANOTHER blessed root', path.join(PB, 'credentials.json'), inA, '', outside);
    await refuses('unscoped run, a file in a blessed root it does not work in', path.join(PA, 'appsettings.json'), unscoped, '', outside);
    await refuses('routine delivery (ctx null), another blessed root', path.join(PB, 'credentials.json'), null, '', outside);
    await refuses('routine delivery of a project-A row, another blessed root', path.join(PB, 'credentials.json'), null, PA, outside);
    await refuses('This Computer (fullAccess) run, ~/taxes.pdf', path.join(HOME, 'taxes.pdf'), runCtx({ fullAccess: true }), '', outside);
    await refuses('Full Power run, another agent\'s workspace', path.join(WS, 'gamma', 'private.md'), runCtx({ unrestrictedHost: true }), '', outside);
    await refuses('a lead holding a hand-off read grant on that file', path.join(WS, 'gamma', 'private.md'), runCtx({ readGrants: [path.join(WS, 'gamma', 'private.md')] }), '', outside);
    await refuses('project-A run, another agent\'s workspace', path.join(WS, 'gamma', 'private.md'), inA, '', outside);
    await refuses('UNC', '\\\\127.0.0.1\\c$\\Windows\\win.ini', inA, '', /network path/);
    await refuses('forward-slash UNC', '//127.0.0.1/c$/Windows/win.ini', inA, '', /network path/);
    await refuses('a `..` climb out of the root', '../projB/credentials.json', inA, '', /climbs out/);
    await refuses('a drive-relative name', 'C:credentials.json', inA, '', /drive-relative/);

    // ---- 3. the floor ALWAYS (B1 + M1): Full Power, This Computer, jail-relative names, every spelling ----
    const floor = /protected file/;
    await refuses('Full Power, the project .env', '.env', runCtx({ projectRoot: PA, unrestrictedHost: true }), '', floor);
    await refuses('Full Power, .git/config', '.git/config', runCtx({ projectRoot: PA, unrestrictedHost: true }), '', floor);
    await refuses('Full Power, ~/.ssh key', path.join(HOME, '.ssh', 'id_ed25519'), runCtx({ unrestrictedHost: true }), '', floor);
    await refuses('This Computer, ~/.ssh key', path.join(HOME, '.ssh', 'id_ed25519'), runCtx({ fullAccess: true }), '', floor);
    for (const n of ['.env', '.ENV', '.env.', '.env::$DATA', '.git/config']) await refuses('project-A run floor: ' + n, n, inA, '', floor);
    for (const n of ['repo/.env', 'repo/.git/config', path.join(JAIL, 'repo', '.env'), path.join(JAIL, 'repo', '.git', 'config')]) {
      await refuses('jail floor, live run: ' + path.basename(n), n, unscoped, '', floor);
      await refuses('jail floor, routine delivery: ' + path.basename(n), n, null, '', floor);
      await refuses('jail floor, Full Power run: ' + path.basename(n), n, runCtx({ unrestrictedHost: true }), '', floor);
    }
    // a link named innocently, planted in the jail, pointing at the floor and out to another blessed root
    if (plant(path.join(JAIL, 'notes'), path.join(PA, '.git'))) await refuses('a jail link onto a repository\'s .git', 'notes/config', unscoped, '', floor);
    if (plant(path.join(JAIL, 'jx'), PB)) await refuses('a jail link onto another blessed root', 'jx/credentials.json', unscoped, '', outside);
    if (plant(path.join(PA, 'px'), HOME)) await refuses('a project link out to the home folder', 'px/taxes.pdf', inA, '', outside);

    // ---- 4. a send never raises a path card, and a revoked root stops it ----
    prompted = 0;
    const watched = runCtx({ projectRoot: PA, surface: 'interactive', prompt: askAlways });
    await refuses('a watched run naming an unblessed folder', path.join(HOME, 'taxes.pdf'), watched, '', outside);
    await sends('a watched run, its own project file', 'report.md', watched, '', 'A-REPORT');
    A.eq(prompted, 0, 'no send asked the path-trust prompt');
    blessed = [PB];
    await refuses('project-A run after A\'s grant was revoked', 'report.md', inA, '', /no longer approved/);
    await refuses('a routine row of A after the revoke', 'report.md', null, PA, /no longer approved/);
    blessed = [PA, PB];
    await refuses('a missing file', 'nope.md', inA, '', /is not in this run's project folder/);

  } finally {
    // unlink the planted links first, so removing the temp tree never walks through one into its target
    for (const l of [path.join(JAIL, 'notes'), path.join(JAIL, 'jx'), path.join(PA, 'px')]) {
      let st = null;
      try { st = fs.lstatSync(l); } catch (e) { if (e.code !== 'ENOENT') console.log('[cleanup] ' + e.message); }
      if (!st) continue;
      try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { console.log('[cleanup] ' + e2.message); } }
    }
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  A.report('egress-files.test');
})().catch(e => { console.error(e); process.exit(1); });
