/* node test/run-paths.test.js — the run's path object is the filesystem trust boundary (run-paths lane, 2026-10-28).

   Moving the containment proof into sidecar/run-paths.js must narrow nothing it refused and widen nothing it
   allowed. Real temp dirs, the REAL path-trust core with one trusted project, an unattended surface. Proves:

     1. every escape stays refused, in a project run and in the private workspace: `..` traversal (both separators),
        NUL, UNC (both spellings), drive-relative and drive-absolute outside the trust, another agent's workspace,
        the .env / .git floor, and a symlink or Windows junction planted inside the base that points out of it;
     2. case on Windows: a case-variant spelling of the run's own folders is the same folder (place() and path trust
        agree), and a case-variant of ANOTHER agent's workspace is still another agent's workspace;
     3. the object is bound: one run, one agent (a ctx whose paths belong to another agent never resolves), a
        station-reserved id mints nothing, and a tool built WITHOUT the trust guard never borrows the run's;
     4. place() / placeJail() name only paths resolve() maps back to the same file, and leave every unscoped name
        byte-for-byte as it was;
     5. the fs receipt text is unchanged: the same write through ctx.paths and through the pre-lane ctx shape reads
        identically. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const RunPaths = require('../sidecar/run-paths.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');

const isWin = process.platform === 'win32';
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-run-paths-')));
const WS = path.join(BASE, 'workspaces');
const PROJECT = path.join(BASE, 'project');
const OUTSIDE = path.join(BASE, 'outside');
const AID = 'coder';
const JAIL = path.join(WS, AID);
for (const d of [WS, PROJECT, OUTSIDE, JAIL, path.join(WS, 'other')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'outside the trust');
fs.writeFileSync(path.join(WS, 'other', 'theirs.txt'), 'another agent');
fs.writeFileSync(path.join(PROJECT, '.env'), 'KEY=1');

const trustCore = makePathTrust({ fsp, pathMod: path, roots: () => [PROJECT], workspaceRoot: WS });
const pathTrust = (abs, o2) => trustCore.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: (o2 && o2.agentId) || AID });
const resolver = RunPaths.makeResolver({ fsp, pathMod: path, root: WS, pathTrust });
const scoped = RunPaths.makeRunPaths(resolver, { agentId: AID, projectRoot: PROJECT });
const jailed = RunPaths.makeRunPaths(resolver, { agentId: AID });
async function refuses(p, rel, scope, re) {
  try { await p.resolve(rel, { scope: scope || 'read' }); return false; }
  catch (e) { return re ? re.test(String(e.message)) : true; }
}
function plant(linkAt, target) {
  try { fs.symlinkSync(target, linkAt, isWin ? 'junction' : 'dir'); return true; }
  catch (e) { console.log('[skip] could not plant a link at ' + linkAt + ': ' + e.message); return false; }
}

(async () => {
  try {
    // ---- 1. every escape stays refused ----
    for (const [name, p] of [['project run', scoped], ['private workspace', jailed]]) {
      for (const scope of ['read', 'write']) {
        A.ok(await refuses(p, '../outside/secret.txt', scope, /illegal path/), name + ' ' + scope + ': `..` traversal is refused');
        A.ok(await refuses(p, 'a/../../outside/secret.txt', scope, /illegal path/), name + ' ' + scope + ': a nested `..` is refused');
        A.ok(await refuses(p, '..\\outside\\secret.txt', scope, /illegal path/), name + ' ' + scope + ': a backslash `..` is refused');
        A.ok(await refuses(p, 'ok\0.txt', scope, /illegal path/), name + ' ' + scope + ': a NUL byte is refused');
        A.ok(await refuses(p, '\\\\server\\share\\x.txt', scope, /network paths|UNC/), name + ' ' + scope + ': a UNC path is refused');
        A.ok(await refuses(p, '//server/share/x.txt', scope, /network paths|UNC/), name + ' ' + scope + ': a forward-slash UNC path is refused');
        A.ok(await refuses(p, path.join(OUTSIDE, 'secret.txt'), scope, /outside the agent workspace/), name + ' ' + scope + ': an absolute path outside every trust is refused');
        A.ok(await refuses(p, 'Z:secret.txt', scope), name + ' ' + scope + ': a drive-relative path is routed to path trust and refused');
        A.ok(await refuses(p, path.join(WS, 'other', 'theirs.txt'), scope, /another agent workspace/), name + ' ' + scope + ': another agent\'s workspace is refused');
      }
    }
    A.ok(await refuses(scoped, '.env', 'read', /protected-file floor/), 'project run: the .env floor holds for a relative path');
    A.ok(await refuses(scoped, '.git/config', 'read', /protected-file floor/), 'project run: the .git floor holds for a relative path');
    if (plant(path.join(PROJECT, 'link'), OUTSIDE)) {
      A.ok(await refuses(scoped, 'link/secret.txt', 'read'), 'project run: a link inside the project that points out of it is refused');
      A.ok(await refuses(scoped, 'link/new.txt', 'write'), 'project run: and so is a write through it');
    }
    if (plant(path.join(JAIL, 'link'), OUTSIDE)) {
      A.ok(await refuses(jailed, 'link/secret.txt', 'read', /via symlink/), 'private workspace: a planted link out of the jail is refused');
    }
    // what was reachable stays reachable
    fs.writeFileSync(path.join(PROJECT, 'ok.txt'), 'in the project');
    const inProj = await scoped.resolve('ok.txt', { scope: 'read' });
    A.eq(inProj.abs, path.join(PROJECT, 'ok.txt'), 'project run: a relative path resolves in the project');
    const ownAbs = await scoped.resolve(path.join(JAIL, 'mine.txt'), { scope: 'write' });
    A.eq(ownAbs.abs, path.join(JAIL, 'mine.txt'), 'project run: the agent\'s OWN workspace by absolute path is still reachable (no narrowing)');
    A.eq((await jailed.resolve('notes/a.txt', { scope: 'write' })).abs, path.join(JAIL, 'notes', 'a.txt'), 'private workspace: a relative path resolves in the jail');

    // ---- 2. case on Windows ----
    {
      const W = path.win32;
      const wr = RunPaths.makeResolver({ pathMod: W, root: 'C:\\StarNet\\workspaces' });
      const wp = RunPaths.makeRunPaths(wr, { agentId: AID, projectRoot: 'C:\\Users\\me\\Proj' });
      A.eq(wp.place('c:\\users\\ME\\proj\\src\\a.js'), 'src/a.js', 'win32: a case-variant spelling of the project is the project (place gives the relative name)');
      A.eq(wp.place('C:\\Users\\me\\Project2\\a.js'), 'C:\\Users\\me\\Project2\\a.js', 'win32: a sibling whose name merely starts the same is NOT inside (absolute)');
      A.eq(wp.placeJail('shots/s.png'), 'C:\\StarNet\\workspaces\\' + AID + '\\shots\\s.png', 'win32: a jail name in a project run is the absolute jail path');
      if (isWin) {
        const variant = path.join(WS.toUpperCase(), AID.toUpperCase(), 'case.txt');
        A.ok(!!(await scoped.resolve(variant, { scope: 'write' })), 'windows: a case-variant of the own workspace is still the own workspace');
        A.ok(await refuses(scoped, path.join(WS.toUpperCase(), 'OTHER', 'theirs.txt'), 'read', /another agent workspace/), 'windows: a case-variant of another agent\'s workspace is still refused');
        A.ok(await refuses(scoped, path.join(PROJECT.toUpperCase(), '.ENV'), 'read', /protected-file floor/), 'windows: a case-variant .ENV is still behind the floor');
      }
    }

    // ---- 3. the object is bound ----
    {
      const fsTrusted = makeFsTools({ fsp, pathMod: path, root: WS, pathTrust });
      let err = null;
      try { await fsTrusted.readTool.run({ path: 'ok.txt' }, { agentId: 'other', paths: scoped }); } catch (e) { err = e; }
      A.ok(err && /run paths belong to agent coder/.test(err.message), 'a ctx whose paths belong to another agent never resolves for this one');
      A.throws(() => RunPaths.makeRunPaths(resolver, { agentId: 'codex' }), 'a station-reserved id mints no path object');
      A.throws(() => RunPaths.makeRunPaths(resolver, { agentId: '../x' }), 'a malformed id mints no path object');
      A.ok(Object.isFrozen(scoped) && Reflect.set(scoped, 'root', OUTSIDE) === false && scoped.root === PROJECT, 'the path object is frozen: its root cannot be re-pointed');
      // a tool built WITHOUT the trust guard (the /api/file helper, the one-off route registry) never borrows the run's
      const bare = makeFsTools({ fsp, pathMod: path, root: WS });
      let e1 = null, e2 = null;
      try { await bare.readTool.run({ path: path.join(PROJECT, 'ok.txt') }, { agentId: AID, paths: scoped }); } catch (e) { e1 = e; }
      try { await bare.readTool.run({ path: 'ok.txt' }, { agentId: AID, paths: scoped }); } catch (e) { e2 = e; }
      A.ok(e1 && /illegal path/.test(e1.message), 'a guard-less resolver still refuses an absolute path even when the ctx carries a trusted path object');
      A.ok(e2 && /requires the project trust guard/.test(e2.message), 'and still refuses a project-relative path');
    }

    // ---- 4. placement names only what resolve() maps back ----
    {
      fs.mkdirSync(path.join(JAIL, 'shots'), { recursive: true });
      fs.writeFileSync(path.join(JAIL, 'shots', 's.png'), 'png');
      fs.writeFileSync(path.join(PROJECT, 'made.txt'), 'made');
      for (const [name, p, abs] of [['project run, project file', scoped, path.join(PROJECT, 'made.txt')], ['project run, jail file', scoped, path.join(JAIL, 'shots', 's.png')],
        ['private workspace, jail file', jailed, path.join(JAIL, 'shots', 's.png')]]) {
        const named = p.place(abs);
        A.eq((await p.resolve(named, { scope: 'read' })).abs, abs, name + ': place() -> resolve() returns the same file (' + named + ')');
      }
      A.eq(jailed.placeJail('.output/x.txt'), '.output/x.txt', 'unscoped: a jail name is returned byte-for-byte');
      A.eq(jailed.placeJail('downloads\\a b.pdf'), 'downloads\\a b.pdf', 'unscoped: any spelling is returned byte-for-byte');
      A.eq(scoped.placeJail('.output/x.txt'), path.join(JAIL, '.output/x.txt'), 'project run: a jail name becomes the absolute jail path');
      A.eq(scoped.placeJail('../escape.txt'), '../escape.txt', 'placeJail never builds a path out of a `..` name');
      A.eq(scoped.placeJail(path.join(OUTSIDE, 'a')), path.join(OUTSIDE, 'a'), 'placeJail leaves an absolute name as it was');
      A.eq(scoped.shellCwd(), null, 'a fresh run starts with no remembered `cd`');
      scoped.setShellCwd(path.join(PROJECT, 'sub'));
      A.eq(jailed.shellCwd(), null, 'one run\'s `cd` is invisible to another run\'s object');
      scoped.setShellCwd(null);
    }

    // ---- 5. the fs receipt text is unchanged ----
    {
      const fsTools = makeFsTools({ fsp, pathMod: path, root: WS, pathTrust });
      for (const [name, viaPaths, legacy] of [
        ['project run', { agentId: AID, projectRoot: PROJECT, paths: scoped }, { agentId: AID, projectRoot: PROJECT }],
        ['private workspace', { agentId: AID, paths: jailed }, { agentId: AID }]
      ]) {
        const a = await fsTools.writeTool.run({ path: 'receipt-a.txt', content: 'same bytes' }, viaPaths);
        const b = await fsTools.writeTool.run({ path: 'receipt-b.txt', content: 'same bytes' }, legacy);
        const norm = r => String(r.content).split('receipt-b.txt').join('receipt-a.txt');
        A.eq(norm(b), String(a.content), name + ': the fs.write receipt reads the same through ctx.paths as through the pre-lane ctx');
        A.eq(String(b.summary).split('receipt-b.txt').join('receipt-a.txt'), String(a.summary), name + ': and so does its summary');
      }
    }
  } finally {
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  A.report('run-paths');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
