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
        exactly the pre-lane receipt, pinned literally;
     6. a FINISHED run's file is named against that run's one base (producedPath) and located only when it exists inside
        it (locateProduced), never by probing another folder for a same-named file (review round 1). */
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
    /* THE PRIVATE WORKSPACE ON THE STATION vs. WHAT LEAVES IT (owner decision, review round 3: round 2's jail floor is
       reverted). A repo the agent cloned into its own workspace keeps .env.example, .env.local, .env and .git/* for fs.*
       reads and writes, exactly as on trunk (where this proof lived in fs.js resolveInside and never asked path trust),
       with or without a guard wired, so the workshop manifest, Keep, a continued folder and /api/file work there again.
       The floor binds what LEAVES: the very same names through the egress reader are refused, Full Power included. */
    {
      fs.mkdirSync(path.join(JAIL, 'repo', '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(JAIL, 'repo', '.env'), 'OPENAI_API_KEY=sk-jail');
      fs.writeFileSync(path.join(JAIL, 'repo', '.env.example'), 'OPENAI_API_KEY=');
      fs.writeFileSync(path.join(JAIL, 'repo', '.git', 'config'), '[remote] url=https://tok@x');
      fs.writeFileSync(path.join(JAIL, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main');
      fs.writeFileSync(path.join(JAIL, 'repo', 'notes.txt'), 'fine');
      let asked = 0;
      const counted = RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: WS, pathTrust: (abs, o2) => { asked++; return pathTrust(abs, o2); } }), { agentId: AID });
      const bare = RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: WS }), { agentId: AID });
      const names = ['repo/.env', 'repo/.env.example', 'repo/.env.local', 'repo/.git/config', 'repo/.git/HEAD', 'repo/.git/hooks/pre-commit', 'repo\\.git\\config', 'fresh/.env', 'repo/notes.txt', 'repo/.github/ci.yml'];
      /* A BACKSLASH IS A SEPARATOR ON WINDOWS ONLY (Linux CI run 40976584893: this row used to expect Windows meaning on
         every host). On Windows repo\.git\config IS the repo's .git/config. On macOS and Linux `\` is an ordinary filename
         character, so the same text names ONE file in the jail root, literally `repo\.git\config`, never the repo's
         .git/config. Both are trunk parity: trunk's resolveInside was P.resolve(jail, rel) with the host's own path module.
         On every host the name resolves on the station (the jail has no floor, above) and never leaves it (below: the egress
         floor reads both separators in the name as written, the resolved path and the real path). */
      const onHost = n => (isWin ? path.join(JAIL, ...n.split(/[\\/]/)) : path.join(JAIL, ...n.split('/')));
      for (const [label, p] of [['private workspace', counted], ['private workspace, no guard wired', bare]]) {
        for (const scope of ['read', 'write']) {
          for (const n of names) {
            let got = null;
            try { got = (await p.resolve(n, { scope })).abs; } catch (e) { got = 'REFUSED: ' + e.message; }
            A.eq(got, onHost(n), label + ' ' + scope + ': trunk parity, the jail-relative ' + n + ' resolves on the station');
          }
        }
      }
      A.eq(asked, 0, 'trunk parity: a jail-relative name never asks path trust (the jail branch decides it alone)');
      {
        const bs = (await bare.resolve('repo\\.git\\config', { scope: 'read' })).abs;
        A.eq(bs === path.join(JAIL, 'repo', '.git', 'config'), isWin, (isWin ? 'windows: repo\\.git\\config IS' : 'posix: repo\\.git\\config is NOT')
          + ' the repo\'s own .git/config (' + bs + ')');
      }
      const innocent = plant(path.join(JAIL, 'innocent'), path.join(JAIL, 'repo', '.git'));
      if (innocent) A.eq((await jailed.resolve('innocent/config', { scope: 'read' })).abs, path.join(JAIL, 'innocent', 'config'), 'trunk parity: a link inside the jail onto its own .git resolves on the station');
      // ...and none of them leaves the station, whatever the posture (sidecar/egress-files.js is the floor for egress)
      const { makeEgressReader } = require('../sidecar/egress-files.js');
      const egress = makeEgressReader({ fsp, pathMod: path, workspaces: WS, guard: (abs, o2) => trustCore.guard(abs, o2) });
      const fullPower = RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: WS,
        pathTrust: (abs, o2) => trustCore.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: AID, unrestrictedHost: true }) }), { agentId: AID });
      // repo\.git\config: the repo's .git/config on Windows, a file whose NAME carries the floor on macOS and Linux; neither leaves
      const leaving = ['repo/.env', 'repo/.env.example', 'repo/.git/config', 'repo/.git/HEAD', 'repo\\.git\\config', path.join(JAIL, 'repo', '.env'), path.join(JAIL, 'repo', '.git', 'config')].concat(innocent ? ['innocent/config'] : []);
      for (const [label, p] of [['ordinary run', jailed], ['Full Power run', fullPower]]) {
        for (const n of leaving) {
          const got = await egress.read(p, n);
          A.ok(!got.ok && /protected file/.test(got.error), label + ': ' + n + ' never leaves the station (' + (got.ok ? 'SENT' : got.error) + ')');
        }
        const fine = await egress.read(p, 'repo/notes.txt');
        A.ok(fine.ok && fine.buffer.toString() === 'fine', label + ': an ordinary file beside them still leaves');
      }
    }
    /* A WORKSPACE FOLDER THAT IS A LINK (review round 3 minor-1; round 4 minor-2, owner decision). A workspaces/<id> that
       is itself a junction (a user who moved one agent's folder to a bigger disk) is on-station trunk parity: fs.* reads
       and writes in it exactly as trunk's resolveInside does (owner rule 2), and round 3's refusal here is removed. What
       LEAVES the station is the egress reader's business: it sends nothing from such a folder, and says how to fix it. */
    {
      const elsewhere = path.join(BASE, 'home');
      fs.mkdirSync(elsewhere, { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'taxes.pdf'), 'HOME-TAXES');
      if (plant(path.join(WS, 'delta'), elsewhere)) {
        const delta = RunPaths.makeRunPaths(resolver, { agentId: 'delta' });
        for (const scope of ['read', 'write']) {
          let r = null, err = '';
          try { r = await delta.resolve('taxes.pdf', { scope }); } catch (e) { err = e.message; }
          A.ok(r && r.abs === path.join(WS, 'delta', 'taxes.pdf'), 'a junction jail: fs.* ' + scope + ' of taxes.pdf resolves, as on trunk (was: ' + (err || 'ok') + ')');
        }
        let escaped = '';
        try { await delta.resolve('../outside/secret.txt', { scope: 'read' }); } catch (e) { escaped = e.message; }
        A.ok(/illegal path/.test(escaped), 'a junction jail: `..` out of it is still refused');
        const trunkFs = makeFsTools({ fsp, pathMod: path, root: WS })._internals;
        A.eq((await trunkFs.resolveInside('delta', 'taxes.pdf', { scope: 'read' })).abs, path.join(WS, 'delta', 'taxes.pdf'), 'the fs.* tool\'s own resolver agrees (trunk parity)');
        const { makeEgressReader } = require('../sidecar/egress-files.js');
        const got = await makeEgressReader({ fsp, pathMod: path, workspaces: WS }).read(delta, 'taxes.pdf');
        A.ok(!got.ok && /workspace folder is a link to somewhere else/.test(got.error) && /move the folder back or unlink it/.test(got.error), 'a junction jail: nothing in it leaves the station, and the refusal says how to fix it (' + (got.ok ? 'SENT' : got.error) + ')');
      }
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
      // (review minor) a tool built with a NARROWER guard keeps it: only the run's root comes from ctx.paths
      const refusing = (abs) => { if (String(abs).toLowerCase().indexOf(PROJECT.toLowerCase()) === 0) throw new Error('narrow guard: not this project'); return pathTrust(abs, { scope: 'read' }); };
      const narrow = makeFsTools({ fsp, pathMod: path, root: WS, pathTrust: refusing });
      let e3 = null;
      try { await narrow.readTool.run({ path: 'ok.txt' }, { agentId: AID, paths: scoped }); } catch (e) { e3 = e; }
      A.ok(e3 && /narrow guard/.test(e3.message), 'a tool\'s own narrower guard is never widened by the run\'s path object (' + (e3 && e3.message) + ')');
      // (review minor) the brand is module-private: a hand-built object carrying the old Symbol.for key is not a path object
      const forged = { [Symbol.for('starnet.runPaths')]: true, agentId: AID, root: OUTSIDE, jail: JAIL, base: () => OUTSIDE,
        resolve: async (rel) => ({ base: OUTSIDE, abs: path.join(OUTSIDE, rel) }), place: (a) => a, placeJail: (r) => r, shellCwd: () => null, setShellCwd: () => null };
      A.eq(RunPaths.isRunPaths(forged), false, 'a forged object with the public Symbol.for brand is not a run path object');
      let e4 = null, got = null;
      try { got = await fsTrusted.readTool.run({ path: 'secret.txt' }, { agentId: AID, paths: forged }); } catch (e) { e4 = e; }
      A.ok(!(got && /outside the trust/.test(String(got.content))), 'a forged ctx.paths never roots a read outside the trust (' + (e4 ? e4.message : 'read: ' + String(got && got.content).slice(0, 60)) + ')');
      A.eq(RunPaths.isRunPaths(scoped), true, 'a minted object is one');
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
      // unplaceJail (review S3): the name a CHAT may be told — jail-relative inside the private workspace, else null
      A.eq(scoped.unplaceJail(path.join(JAIL, 'shots', 's.png')), 'shots/s.png', 'unplaceJail: a private-shelf receipt becomes its jail-relative name');
      A.eq(jailed.unplaceJail(path.join(JAIL.toUpperCase(), 'shots', 's.png')), isWin ? 'shots/s.png' : null, 'unplaceJail: case-folds on Windows only');
      A.eq(scoped.unplaceJail(path.join(PROJECT, 'made.txt')), null, 'unplaceJail: a project file is not a jail name');
      A.eq(scoped.unplaceJail(path.join(WS, 'other', 'theirs.txt')), null, 'unplaceJail: another agent\'s workspace is not this jail');
      A.eq(scoped.unplaceJail(JAIL + '-evil' + path.sep + 'x.txt'), null, 'unplaceJail: a sibling that merely starts with the jail\'s name is outside');
      A.eq(scoped.unplaceJail('shots/s.png'), null, 'unplaceJail: a relative name is not absolute, so not unplaced');
      A.eq(scoped.shellCwd(), null, 'a fresh run starts with no remembered `cd`');
      // (review minor: the old row compared two independently minted objects, which could not fail) two runs of the SAME
      // agent in the SAME project, each reached the way every tool reaches it (pathsFor over its own ctx)
      const chatA = { agentId: AID, runId: 'chat-a', paths: RunPaths.makeRunPaths(resolver, { agentId: AID, projectRoot: PROJECT }) };
      const chatB = { agentId: AID, runId: 'chat-b', paths: RunPaths.makeRunPaths(resolver, { agentId: AID, projectRoot: PROJECT }) };
      const viaA = RunPaths.pathsFor(chatA, resolver, AID), viaB = RunPaths.pathsFor(chatB, resolver, AID);
      viaA.setShellCwd(path.join(PROJECT, 'sub'));
      A.ok(viaA !== viaB && viaB.shellCwd() === null && RunPaths.pathsFor(chatA, resolver, AID).shellCwd() === path.join(PROJECT, 'sub'),
        'one chat\'s `cd` stays on its own run: the same agent\'s other chat in the same project never sees it');
      // a rig with NO ctx.paths keeps the historic per-scope memo (one project run id, one cd)
      const rig1 = { agentId: AID, runId: 'rig-1', projectRoot: PROJECT }, rig2 = { agentId: AID, runId: 'rig-2', projectRoot: PROJECT };
      RunPaths.pathsFor(rig1, resolver, AID).setShellCwd(path.join(PROJECT, 'sub'));
      A.eq(RunPaths.pathsFor(rig2, resolver, AID).shellCwd(), null, 'two project runs of one agent never share a `cd`, even in a rig');
    }

    // ---- 6. a FINISHED run's file is named against that run's one base (review M2, handoff-runner, routine delivery) ----
    {
      const W = path.win32, X = path.posix;
      A.eq(RunPaths.producedPath('report.md', { projectRoot: '/proj', jail: '/ws/a' }).path, '/proj/report.md', 'producedPath: a project run\'s relative name means its project');
      A.eq(RunPaths.producedPath('report.md', { projectRoot: '', jail: '/ws/a' }).path, '/ws/a/report.md', 'producedPath: an unscoped run\'s means its workspace');
      A.eq(RunPaths.producedPath('notes\\r.md', { projectRoot: 'D:\\proj' }).path, W.resolve('D:\\proj', 'notes\\r.md'), 'producedPath: a Windows row reads as Windows on any host');
      A.eq(RunPaths.producedPath('../x.md', { projectRoot: '/proj' }), { path: null, reason: 'escapes' }, 'producedPath: a name that climbs out of its base is refused');
      A.eq(RunPaths.producedPath('C:x.md', { projectRoot: 'C:\\proj' }).reason, 'drive-relative', 'producedPath: a drive-relative name is refused');
      A.eq(RunPaths.producedPath('r.md', {}).reason, 'unknown-root', 'producedPath: no known base, no guess');
      A.eq(RunPaths.producedPath('\\\\srv\\share\\r.md', { projectRoot: '/proj' }).path, '\\\\srv\\share\\r.md', 'producedPath: an absolute name is kept as named (naming only)');
      void X;
      fs.writeFileSync(path.join(PROJECT, 'handed.md'), 'project copy');
      fs.writeFileSync(path.join(JAIL, 'handed.md'), 'STALE private copy');
      let located = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: PROJECT, jail: JAIL, list: [{ path: 'handed.md' }, { path: 'missing.md' }, { path: '\\\\srv\\share\\x.md' }, { path: '../outside/secret.txt' }] });
      A.eq(located.map(f => f.abs), [fs.realpathSync(path.join(PROJECT, 'handed.md'))], 'locateProduced: the project run\'s file, never the private decoy; missing, network and climbing names are left out');
      located = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: '', jail: JAIL, list: [{ path: 'handed.md' }] });
      A.eq(located.map(f => f.abs), [fs.realpathSync(path.join(JAIL, 'handed.md'))], 'locateProduced: an unscoped run\'s file is in its workspace');
      if (fs.existsSync(path.join(PROJECT, 'link'))) {
        located = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: PROJECT, jail: JAIL, list: [{ path: 'link/secret.txt' }] });
        A.eq(located, [], 'locateProduced: a link planted in the base cannot carry a relative name out of it');
      }
      // review round 2 (m-locateProduced): an ABSOLUTE artifact name proves itself inside the worker's own jail or root, or
      // it is dropped. It used to resolve to any file on the disk, and the lead was granted it.
      fs.mkdirSync(path.join(JAIL, 'shots'), { recursive: true });
      fs.writeFileSync(path.join(JAIL, 'shots', 'w.png'), 'shot');
      located = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: PROJECT, jail: JAIL, list: [
        { path: path.join(OUTSIDE, 'secret.txt') }, { path: path.join(WS, 'other', 'theirs.txt') },
        { path: path.join(JAIL, 'shots', 'w.png') }, { path: path.join(PROJECT, 'handed.md') }] });
      A.eq(located.map(f => f.abs), [fs.realpathSync(path.join(JAIL, 'shots', 'w.png')), fs.realpathSync(path.join(PROJECT, 'handed.md'))],
        'locateProduced: an absolute name outside the worker\'s jail and root (another folder, another agent) is dropped; its own are kept');
      located = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: '', jail: JAIL, list: [{ path: path.join(PROJECT, 'handed.md') }] });
      A.eq(located, [], 'locateProduced: an unscoped worker cannot hand on a project file by absolute name');
      if (fs.existsSync(path.join(JAIL, 'link'))) {
        located = await RunPaths.locateProduced({ fsp, pathMod: path, projectRoot: '', jail: JAIL, list: [{ path: path.join(JAIL, 'link', 'secret.txt') }] });
        A.eq(located, [], 'locateProduced: an absolute name through a link in the jail is proven by its real path');
      }
      // readRelative (review round 2): the host's ONE reader of a relative key (a postcondition path, a quest artifact key).
      // An absolute, drive-relative or network key is refused before ANY resolve, so path trust is never even asked.
      let asked = 0;
      const spyTrust = (abs, o2) => { asked++; return trustCore.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: AID }); };
      const spied = RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: WS, pathTrust: spyTrust }), { agentId: AID, projectRoot: PROJECT });
      for (const k of [path.join(PROJECT, 'handed.md'), 'C:handed.md', 'c:\\x\\y.md', '/etc/passwd', '\\\\srv\\share\\x.md', '//srv/share/x.md', '', 'a\0b']) {
        let refused = false;
        try { await RunPaths.readRelative(spied, k, () => { throw new Error('orElse must not run'); }); } catch (e) { refused = /relative to the run's folder/.test(e.message); }
        A.ok(refused, 'readRelative refuses ' + JSON.stringify(k) + ' before any resolve');
      }
      A.eq(asked, 0, 'readRelative: path trust was never asked about a refused key');
      A.eq((await RunPaths.readRelative(spied, 'handed.md')).abs, path.join(PROJECT, 'handed.md'), 'readRelative: a relative key resolves through the run path object (the project here)');
      A.ok(asked > 0, 'readRelative: and that one does meet path trust');
      A.eq(await RunPaths.readRelative(null, 'x.md', k => ({ abs: 'jail:' + k })), { abs: 'jail:x.md' }, 'readRelative: with no path object, the caller\'s legacy jail reads it');
    }

    // ---- 5. the fs receipt text is unchanged: pinned to the PRE-LANE receipt, literally (review minor: this used to
    //      compare the post-lane tool with itself). The strings below are what c9ab0f8a5's fs.write printed for the same
    //      write (only the sha256 of the bytes and the temp root are filled in). ----
    {
      const fsTools = makeFsTools({ fsp, pathMod: path, root: WS, pathTrust });
      const sha = require('node:crypto').createHash('sha256').update('same bytes').digest('hex');
      const golden = {
        'project run': 'Wrote receipt-a.txt (10 bytes).\n[mutation receipt: read-back-verified; attempted 10 bytes; written 10; verified 10; sha256 ' + sha + ']\n'
          + '[location: ' + path.join(PROJECT, 'receipt-a.txt') + ']',
        'private workspace': 'Wrote receipt-a.txt (10 bytes).\n[mutation receipt: read-back-verified; attempted 10 bytes; written 10; verified 10; sha256 ' + sha + ']\n'
          + '[location: ' + path.join(JAIL, 'receipt-a.txt') + ' (your private workspace, not a project folder; a shell working in a project will not find it here. '
          + 'To write into a project folder, give "path" as an absolute path inside it, or work from a conversation scoped to that project)]'
      };
      for (const [name, viaPaths, legacy] of [
        ['project run', { agentId: AID, projectRoot: PROJECT, paths: scoped }, { agentId: AID, projectRoot: PROJECT }],
        ['private workspace', { agentId: AID, paths: jailed }, { agentId: AID }]
      ]) {
        for (const [shape, ctx] of [['through ctx.paths', viaPaths], ['through the pre-lane ctx shape', legacy]]) {
          try { fs.rmSync(path.join(name === 'project run' ? PROJECT : JAIL, 'receipt-a.txt'), { force: true }); } catch (e) { console.log('[cleanup] ' + e.message); }
          const r = await fsTools.writeTool.run({ path: 'receipt-a.txt', content: 'same bytes' }, ctx);
          A.eq(String(r.content), golden[name], name + ': the fs.write receipt is the pre-lane receipt, ' + shape);
          A.eq(String(r.summary), 'wrote receipt-a.txt (10 B)', name + ': and so is its summary, ' + shape);
        }
      }
    }
  } finally {
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  A.report('run-paths');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
