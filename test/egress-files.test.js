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
   "refused" was SENT before this fix (scratchpad probes r2-egress.js, r2-jailfloor.js, r2-routine.js; section 6, review
   round 3: rr3-egress.js — hard links, a jail that is a junction, a stale single-holder fallback).

   Review round 4: section 7 (MAJOR-2, rr4-routine.js) the routine's OWN folders send what they hold however old, another
   agent's stale file is still refused, and a refusal is told apart from a plain "not found"; section 8 (minor-6,
   rr4-unc.js) a file on a network share is refused for the true reason; a workspace folder that is a link is trunk's on
   the station and refused for egress with a fix-it hint (minor-2).
   NOT DONE, owner decision (minor-5): a hard link stays refused for egress even when it is a build output the agent made
   itself; with MAJOR-2 a routine's refused file is now named in the chat, so the refusal is visible.
   Review round 6: the staging root must be ours (created non-recursively 0o700; a squatted, linked or shared one is
   refused, the owner check through an injected stat), a staged copy carries the sha256 of the bytes written and
   verifyStaged re-hashes, unstage re-proves its folder before each unlink (rr6-dropstaged-race.js A), and the boot sweep
   runs once per root at host start. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const RunPaths = require('../sidecar/run-paths.js');
const { makeEgressReader, sweepUploadStaging } = require('../sidecar/egress-files.js');
const RoutineMedia = require('../sidecar/routine-media.js');

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

    // ---- 5. a routine fire reads each name through the ONE row that produced it (m-routine-root) ----
    put(path.join(WS, 'beta', 'report.md'), 'BETA-STALE-DECOY');
    const reply = 'Daily digest done.\nATTACH: report.md\nATTACH: ' + path.join(PB, 'credentials.json');
    async function fire(runs, generatedImages) {
      const fireRead = reader.fireReader(runs, 'alpha', PA);
      const named = RoutineMedia.parseReply(reply).files;
      // every agent of the fire is asked, as the host asked before this fix: the fire reader must answer the same for each
      const found = (await RoutineMedia.readNamed(named, RoutineMedia.fireAgents(runs, 'alpha'), fireRead)).found;
      const attach = RoutineMedia.pickFiles({ named: found, runs, agentId: 'alpha', generatedImages: !!generatedImages });
      const sent = [];
      const out = await RoutineMedia.sendFiles(attach.files, { read: fireRead, send: async (item) => { sent.push(item.buffer.toString()); return { ok: true }; } });
      return { sent, out, found };
    }
    let r = await fire([{ agentId: 'beta', projectRoot: PA }, { agentId: 'alpha', projectRoot: PA }]);
    A.eq(r.sent, ['A-REPORT'], 'scheduled fire (hops carry the routine folder): the project report, and never the other root\'s secret');
    r = await fire([{ agentId: 'beta', projectRoot: '' }, { agentId: 'alpha', projectRoot: PA }]);
    A.ok(r.sent.indexOf('BETA-STALE-DECOY') < 0 && r.sent.indexOf('{"private_key":"B"}') < 0, 'Run Now, newer unscoped hop: the stale decoy in beta\'s workspace never wins (sent ' + JSON.stringify(r.sent) + ')');
    r = await fire([{ agentId: 'beta', projectRoot: '' }, { agentId: 'alpha', projectRoot: PA, artifacts: [{ kind: 'file', path: 'report.md' }] }]);
    A.eq(r.sent, ['A-REPORT'], 'the row whose ledger names report.md is the one it is read through');
    r = await fire([{ agentId: 'alpha', projectRoot: '' }, { agentId: 'beta', projectRoot: '', artifacts: [{ kind: 'file', path: 'report.md' }] }, { agentId: 'alpha', projectRoot: PA }]);
    A.eq(r.sent, ['BETA-STALE-DECOY'], 'the ledger decides even for another agent: beta made report.md, so beta\'s is the one');
    // a generated image is read through the row that generated it, never another row's same-named file
    fs.mkdirSync(path.join(WS, 'beta', 'images'), { recursive: true });
    fs.mkdirSync(path.join(PA, 'images'), { recursive: true });
    put(path.join(PA, 'images', 'pic.png'), 'ALPHA-PROJECT-PIC');
    put(path.join(WS, 'beta', 'images', 'pic.png'), 'BETA-PIC');
    const imgRuns = [{ agentId: 'beta', projectRoot: '' }, { agentId: 'alpha', projectRoot: PA, artifacts: [{ kind: 'image', path: 'images/pic.png' }] }];
    const fireRead = reader.fireReader(imgRuns, 'alpha', PA);
    const picks = RoutineMedia.pickFiles({ named: [], runs: imgRuns, agentId: 'alpha', generatedImages: true });
    A.eq(picks.files.map(f => [f.path, f.agents[0], f.root === PA]), [['images/pic.png', 'alpha', true]], 'a generated-image pick carries its row (agent and root)');
    const sentImgs = [];
    await RoutineMedia.sendFiles(picks.files, { read: fireRead, send: async (item) => { sentImgs.push(item.buffer.toString()); return { ok: true }; } });
    A.eq(sentImgs, ['ALPHA-PROJECT-PIC'], 'the generated image goes from the row that made it');

    // ---- 6. review round 3: ONE name, ONE file, the bytes that were proven ----
    // M-A: a HARD LINK is the same file under a second name; `mklink /H` (fs.linkSync) needs no admin on NTFS. Every one of
    // these was SENT (scratchpad rr3-egress.js section 1): the name is innocent and its real path is inside the folder.
    const linkRefused = /has other names on this disk \(a hard link\)/;
    const hardlinks = [
      [path.join(JAIL, 'hl-ssh.txt'), path.join(HOME, '.ssh', 'id_ed25519'), 'hl-ssh.txt', unscoped, 'a jail hard link to ~/.ssh/id_ed25519 (a floored file)'],
      [path.join(JAIL, 'hl-taxes.pdf'), path.join(HOME, 'taxes.pdf'), 'hl-taxes.pdf', unscoped, 'a jail hard link to a file outside every folder of the run'],
      [path.join(JAIL, 'hl-env.txt'), path.join(PA, '.env'), path.join(JAIL, 'hl-env.txt'), inA, 'a project run naming its own jail\'s hard link to the project .env (floored)'],
      [path.join(PA, 'notes.txt'), path.join(HOME, '.ssh', 'id_ed25519'), 'notes.txt', inA, 'a project-root hard link to ~/.ssh/id_ed25519']
    ];
    for (const [at, target, name, ctx, label] of hardlinks) {
      try { fs.linkSync(target, at); } catch (e) { console.log('[skip] hard link ' + label + ': ' + e.message); continue; }
      await refuses(label, name, ctx, '', linkRefused);
      await refuses(label + ', Full Power', name, runCtx({ projectRoot: ctx.paths.root || '', unrestrictedHost: true }), '', linkRefused);
      await refuses(label + ', routine delivery', name, null, ctx.paths.root || '', linkRefused);
      const probed = await reader.read(ctx.paths, name, { probe: true });
      A.ok(!probed.ok && linkRefused.test(probed.error), label + ': a probe (browser.upload) is refused too');
    }
    // the bytes read are bounded by what was proven: a handle whose size was understated (the file grew after the check)
    // is refused, and so is a handle whose inode differs from the path's (bigint compare, never a rounded double)
    {
      put(path.join(JAIL, 'grow.txt'), 'ABCDEFGH');
      const lying = (patch) => Object.assign({}, fsp, {
        open: async (p, f) => { const fh = await fsp.open(p, f); const st0 = fh.stat.bind(fh); fh.stat = async (o) => patch(await st0(o)); return fh; }
      });
      const grew = makeEgressReader({ fsp: lying(st => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size - 1n })), pathMod: path, workspaces: WS });
      let got = await grew.read(unscoped.paths, 'grow.txt');
      A.ok(!got.ok && /changed while it was being read/.test(got.error), 'a file larger than its proven size is refused, never sent whole (' + (got.ok ? JSON.stringify(got.buffer.toString()) + ' sent' : got.error) + ')');
      const swapped = makeEgressReader({ fsp: lying(st => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + (1n << 60n) })), pathMod: path, workspaces: WS });
      got = await swapped.read(unscoped.paths, 'grow.txt');
      A.ok(!got.ok && /changed while it was being read/.test(got.error), 'an inode differing only above 2^53 is a different file (' + (got.ok ? 'SENT' : got.error) + ')');
      got = await reader.read(unscoped.paths, 'grow.txt');
      A.ok(got.ok && got.buffer.toString() === 'ABCDEFGH' && got.size === 8, 'the honest file still sends whole');
      // the probe: every check, the proven REAL path, no bytes
      const probed = await reader.read(inA.paths, isWin ? path.join(PA.toUpperCase(), 'REPORT.MD') : path.join(PA, 'report.md'), { probe: true });
      A.ok(probed.ok && probed.buffer === undefined && probed.abs === fs.realpathSync.native(path.join(PA, 'report.md')) && probed.size === 8, 'a probe names the proven real path (as the disk spells it) and reads nothing (' + JSON.stringify(probed) + ')');
      for (const n of ['.env', path.join(PB, 'credentials.json'), '../projB/credentials.json']) {
        const p2 = await reader.read(inA.paths, n, { probe: true });
        A.ok(!p2.ok, 'a probe refuses what a send refuses: ' + path.basename(n));
      }
    }
    // minor-1: the private workspace must BE its folder. workspaces/delta as a junction to the home folder sent its files.
    if (plant(path.join(WS, 'delta'), HOME)) {
      const delta = runCtx({ agentId: 'delta' });
      // round 4, minor-2: on the station that folder is trunk's (fs.* works in it); only what leaves is refused, and the
      // refusal says how to fix it
      await refuses('a jail that is a junction to the home folder, relative taxes.pdf', 'taxes.pdf', delta, '', /workspace folder is a link to somewhere else, so files in it never leave the station; move the folder back or unlink it/);
      A.eq((await delta.paths.resolve('taxes.pdf', { scope: 'read' })).abs, path.join(WS, 'delta', 'taxes.pdf'), 'a jail that is a junction: fs.* on the station resolves in it, as on trunk');
      await refuses('a jail that is a junction, the same file by absolute path', path.join(HOME, 'taxes.pdf'), delta, '', /workspace folder is a link|outside/);
      const fromRow = await reader.readFor('delta', 'taxes.pdf', null, '');
      A.ok(!fromRow.ok && /workspace folder is a link/.test(fromRow.error), 'a jail that is a junction, a routine delivery of its row (' + (fromRow.ok ? 'SENT' : fromRow.error) + ')');
    }
    // minor-4: a fire's single-holder fallback ignores a same-named file older than the fire's first row
    {
      put(path.join(WS, 'beta', 'digest.md'), 'BETA-STALE-DIGEST');
      const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      fs.utimesSync(path.join(WS, 'beta', 'digest.md'), old, old);
      const fireStart = Date.now() - 60 * 1000;
      const rows = [{ agentId: 'beta', projectRoot: '', startedAt: fireStart + 1000 }, { agentId: 'alpha', projectRoot: PA, startedAt: fireStart }];
      let got = await reader.fireReader(rows, 'alpha', PA)('alpha', 'digest.md');
      A.ok(!got.ok && /older than this routine fire/.test(got.error), 'a stale same-named file that is the only hit is refused (' + (got.ok ? JSON.stringify(got.buffer.toString()) + ' sent' : got.error) + ')');
      A.ok(noHostPath(got), 'and the refusal names no host path');
      put(path.join(PA, 'digest.md'), 'A-DIGEST-FROM-THIS-FIRE');
      got = await reader.fireReader(rows, 'alpha', PA)('alpha', 'digest.md');
      A.ok(got.ok && got.buffer.toString() === 'A-DIGEST-FROM-THIS-FIRE', 'the file this fire wrote still sends, the stale one never counts against it (' + (got.ok ? 'sent' : got.error) + ')');
    }

    // ---- 7. review round 4, MAJOR-2 (scratchpad rr4-routine.js): the routine's OWN folders send what they hold ----
    // The round-3 mtime filter applied to the routine's own agent too: a weekly report another process made, the
    // project's budget, a file copied in (CopyFileW keeps the source's mtime) were all refused as "older than this
    // routine fire", and the chat got the raw ATTACH line with no note. The filter is for ANOTHER row's folder only.
    {
      const DAY = 86400e3, now = Date.now(), startedAt = now - 60e3;
      const aged = (f, s, ago) => { put(f, s); const t = new Date(now - ago); fs.utimesSync(f, t, t); };
      aged(path.join(JAIL, 'weekly.pdf'), 'WEEKLY-REPORT', 3 * DAY);
      aged(path.join(PA, 'budget.xlsx'), 'PROJECT-BUDGET', 2 * DAY);
      aged(path.join(HOME, 'scan.pdf'), 'SCAN-ON-SHARE', 30 * DAY);
      fs.copyFileSync(path.join(HOME, 'scan.pdf'), path.join(JAIL, 'scan.pdf'));
      const own = [
        ['unscoped routine: an existing workspace file ("send me weekly.pdf")', [{ agentId: 'alpha', projectRoot: '', startedAt, artifacts: [] }], '', 'weekly.pdf', 'WEEKLY-REPORT'],
        ['project routine: an existing project file ("send me budget.xlsx")', [{ agentId: 'alpha', projectRoot: PA, startedAt, artifacts: [] }], PA, 'budget.xlsx', 'PROJECT-BUDGET'],
        ['a file the routine copied in, its old mtime kept', [{ agentId: 'alpha', projectRoot: '', startedAt, artifacts: [] }], '', 'scan.pdf', 'SCAN-ON-SHARE'],
        ['the routine\'s own agent with no row of its own in the fire', [{ agentId: 'beta', projectRoot: '', startedAt, artifacts: [] }], '', 'weekly.pdf', 'WEEKLY-REPORT']
      ];
      for (const [label, runs, folder, name, bytes] of own) {
        const r = await RoutineMedia.readNamed([name], ['alpha'], reader.fireReader(runs, 'alpha', folder));
        A.ok(r.found.length === 1 && r.found[0].got.buffer.toString() === bytes, 'MAJOR-2 ' + label + ' SENDS (was: ' + (r.missing[0] ? r.missing[0].error : 'sent') + ')');
      }
      // another row's stale same-named file is still never this fire's (the round-3 test above, from the other side)
      aged(path.join(WS, 'beta', 'weekly-beta.pdf'), 'BETA-OLD', 3 * DAY);
      const other = await reader.fireReader([{ agentId: 'beta', projectRoot: '', startedAt }, { agentId: 'alpha', projectRoot: '', startedAt }], 'alpha', '')('alpha', 'weekly-beta.pdf');
      A.ok(!other.ok && /older than this routine fire/.test(other.error), 'another agent\'s stale file is still refused (' + (other.ok ? 'SENT' : other.error) + ')');
      // a REFUSAL is not a "not found": the reader marks a missing name, so readNamed can tell the host which lines to
      // strip and name in the missed-file note (a name that is simply not there stays prose: "MEDIA: N/A")
      let hl = false;
      try { fs.linkSync(path.join(HOME, 'taxes.pdf'), path.join(JAIL, 'build-out.pdf')); hl = true; } catch (e) { console.log('[skip] hard link: ' + e.message); }
      const names = ['charts/none.png', 'N/A', '../projB/credentials.json', '.env', 'repo/.git/config'].concat(hl ? ['build-out.pdf'] : []);
      const r = await RoutineMedia.readNamed(names, ['alpha'], reader.fireReader([{ agentId: 'alpha', projectRoot: '', startedAt, artifacts: [] }], 'alpha', ''));
      A.eq(r.missing.map(m => [m.path, !!m.refused]), names.map(n => [n, !/^(charts\/none\.png|N\/A)$/.test(n)]), 'readNamed marks a refusal as refused and a plain not-found as not (' + r.missing.map(m => m.path + ': ' + m.error).join(' | ') + ')');
      A.ok(r.missing.every(m => noHostPath(m)), 'and no refusal names an absolute host path');
      const gone = await reader.readFor('alpha', 'charts/none.png', unscoped);
      A.ok(!gone.ok && gone.notFound === true, 'the reader marks a name that is not there notFound');
      const floored = await reader.readFor('alpha', '.env', unscoped);
      A.ok(!floored.ok && floored.notFound !== true, 'and a refusal is never notFound');
    }

    // ---- 8. review round 4, minor-6 (scratchpad rr4-unc.js): WORKSPACES on a network share ----
    // A file on a share never leaves (the floor refuses every UNC path), but the reason given was "a protected file
    // (credentials or repository internals)". The chat is told the real reason in shown names only; the console gets
    // the share's path.
    {
      const warned = [];
      const warn0 = console.warn;
      // a share's real path is spelled with \ on any host (path.relative gives / on Linux, which the console line would carry)
      const unc = rel => rel.split(/[\\/]/).join('\\');
      const onShare = (p) => { const r = path.relative(WS, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? '\\\\nas01\\starnet-data\\workspaces\\' + unc(r) : null; };
      const nasFsp = Object.assign({}, fsp, { realpath: async (p) => { const r = await fsp.realpath(p); return onShare(r) || r; } });
      const nas = makeEgressReader({ fsp: nasFsp, pathMod: path, workspaces: WS, guard: (abs, o2) => core.guard(abs, o2) });
      console.warn = (...a) => { warned.push(a.join(' ')); };
      let got;
      try { got = await nas.read(unscoped.paths, 'shots/x.png'); } finally { console.warn = warn0; }
      A.ok(!got.ok && /this station's workspaces live on a network share/.test(got.error) && /files on network shares never leave the station/.test(got.error), 'workspaces on a share: the refusal says so (' + (got.ok ? 'SENT' : got.error) + ')');
      A.ok(!got.ok && !/protected file/.test(got.error), 'and no longer calls it a protected file');
      A.ok(!got.ok && got.error.indexOf('nas01') < 0 && got.error.indexOf('starnet-data') < 0 && noHostPath(got), 'the chat-facing refusal names neither the server nor any host path: ' + (got.error || ''));
      A.ok(warned.some(w => w.indexOf('\\\\nas01\\starnet-data\\workspaces\\alpha\\shots\\x.png') >= 0), 'the full path goes to the console: ' + JSON.stringify(warned));
      const probe = await nas.read(unscoped.paths, 'shots/x.png', { probe: true });
      A.ok(!probe.ok && /network share/.test(probe.error), 'a probe (browser.upload) says the same');
      // a project folder on a share, and a link out to one, are refused with the same true reason
      const projShare = Object.assign({}, fsp, { realpath: async (p) => { const r = await fsp.realpath(p); const rel = path.relative(PA, r); return !rel.startsWith('..') && !path.isAbsolute(rel) ? '\\\\nas01\\projects\\a\\' + unc(rel) : r; } });
      console.warn = () => {};
      try { got = await makeEgressReader({ fsp: projShare, pathMod: path, workspaces: WS, guard: (abs, o2) => core.guard(abs, o2) }).read(inA.paths, 'report.md'); } finally { console.warn = warn0; }
      A.ok(!got.ok && /network share/.test(got.error) && !/protected file/.test(got.error) && got.error.indexOf('nas01') < 0, 'a file whose real path is on a share: the same true reason (' + (got.ok ? 'SENT' : got.error) + ')');
      // the machine's own admin share, when this account can reach it: WORKSPACES spelled \\localhost\c$\…
      const m = /^([A-Za-z]):\\(.*)$/.exec(WS);
      const shareWs = isWin && m ? '\\\\localhost\\' + m[1].toLowerCase() + '$\\' + m[2] : '';
      let reachable = false;
      try { if (shareWs) { fs.accessSync(path.join(shareWs, 'alpha', 'shots', 'x.png')); reachable = true; } } catch (e) { console.log('[skip] the admin share is not reachable here: ' + e.code); }
      if (reachable) {
        const shareCtx = { agentId: 'alpha', paths: RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: shareWs }), { agentId: 'alpha' }) };
        console.warn = () => {};
        try { got = await makeEgressReader({ fsp, pathMod: path, workspaces: shareWs }).read(shareCtx.paths, 'shots/x.png'); } finally { console.warn = warn0; }
        A.ok(!got.ok && /this station's workspaces live on a network share/.test(got.error) && got.error.indexOf('localhost') < 0, 'a real \\\\localhost\\c$ workspaces root: refused for the true reason (' + (got.ok ? 'SENT' : got.error) + ')');
      }
    }

    // ---- review round 5 MAJOR (scratchpad rr5r-stage-race.js S4): dropStaged must never delete OUTSIDE the staging
    //      root when a per-copy folder is swapped for a junction to a VICTIM folder between its lstat and its readdir.
    //      Tested with a racy fsp that swaps during readdir exactly as the probe does, for both the unstage path (run
    //      end / browser close) and the boot-sweep path; the victim directory stays untouched. ----
    {
      const cp = require('node:child_process');
      const sh = c => { try { cp.execSync(c, { stdio: 'pipe' }); return true; } catch (e) { return false; } };
      const stagingRoot = path.join(BASE, 'upload-staging');
      const AG = path.join(stagingRoot, 'alpha');
      const victim = path.join(BASE, 'Documents');
      const s4ctx = runCtx({ agentId: 'alpha' });
      const sreader = (fspX) => makeEgressReader({ fsp: fspX, pathMod: path, workspaces: WS, stagingRoot, guard: (abs, o2) => core.guard(abs, o2) });
      put(path.join(JAIL, 's4.txt'), 'ORIGINAL-S4');
      const linkToVictim = (folder) => { try { fs.unlinkSync(folder); } catch (_) {} if (isWin) sh('cmd /c mklink /J "' + folder + '" "' + victim + '"'); else try { fs.symlinkSync(victim, folder, 'dir'); } catch (e) { console.log('[skip] symlink: ' + e.message); } };
      const madeVictim = () => { fs.rmSync(victim, { recursive: true, force: true }); fs.mkdirSync(victim, { recursive: true }); put(path.join(victim, 'taxes.pdf'), 'TAXES'); put(path.join(victim, 'thesis.docx'), 'THESIS'); };
      // the FIRST readdir of the armed folder swaps it (its one file removed, the folder rmdir'd, a junction to the victim
      // put in its place), then the real readdir runs — so readdir returns the victim's children, as the probe showed
      const racyFsp = (armedRef) => Object.assign({}, fsp, { readdir: async (p, o) => {
        if (armedRef.folder && path.resolve(p) === path.resolve(armedRef.folder)) {
          const f = armedRef.folder; armedRef.folder = null;
          for (const n of fs.readdirSync(f)) fs.unlinkSync(path.join(f, n));
          fs.rmdirSync(f); linkToVictim(f);
        }
        return fsp.readdir(p, o);
      } });
      const stageS4 = async (rd) => rd.read(s4ctx.paths, 's4.txt', { stage: { dir: AG } });
      const victimIntact = () => fs.readdirSync(victim).sort();
      // (a) UNSTAGE with no known name (the probe's call path — readdir driven): the mid-readdir swap reaches nothing
      { madeVictim(); const armed = { folder: null }; const rd = sreader(racyFsp(armed));
        const g = await stageS4(rd); A.ok(g.ok && g.staged, 'S4: a file stages into the station root for unstage (' + (g.ok ? 'ok' : g.error) + ')');
        armed.folder = g.staged; await rd.unstage(g.staged);
        A.eq(victimIntact(), ['taxes.pdf', 'thesis.docx'], 'S4 unstage: a junction swapped in mid-readdir deletes NOTHING outside the staging root'); }
      // (b) UNSTAGE bounded to the known file name (the production call path): a copy folder that is already a junction
      { madeVictim(); const rd = sreader(fsp); const g = await stageS4(rd); A.ok(g.ok && g.staged, 'S4: a file stages for bounded unstage');
        linkToVictim(g.staged); await rd.unstage(g.staged, 's4.txt');
        A.eq(victimIntact(), ['taxes.pdf', 'thesis.docx'], 'S4 unstage (bounded, name known): a junctioned copy folder deletes nothing in the victim'); }
      // (c) BOOT SWEEP: the same mid-readdir swap reaches nothing
      { madeVictim(); const rd = sreader(fsp); const g = await stageS4(rd); A.ok(g.ok && g.staged, 'S4: a file stages for the boot sweep');
        const armed = { folder: g.staged }; const n = await sweepUploadStaging({ fsp: racyFsp(armed), pathMod: path, stagingRoot });
        A.eq(victimIntact(), ['taxes.pdf', 'thesis.docx'], 'S4 boot sweep: a junction swapped in mid-readdir deletes NOTHING outside the staging root (removed ' + n + ')'); }
      // clean the staging tree, junctions first so rm never walks through one into the victim
      try {
        for (const ag of (fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [])) {
          const agd = path.join(stagingRoot, ag);
          for (const c of (fs.existsSync(agd) ? fs.readdirSync(agd) : [])) { const f = path.join(agd, c); let st = null; try { st = fs.lstatSync(f); } catch (_) {} if (st && st.isSymbolicLink()) { try { fs.unlinkSync(f); } catch (e) { try { fs.rmdirSync(f); } catch (_) {} } } }
        }
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      } catch (e) { console.log('[cleanup] ' + e.message); }
    }

    /* ---- review round 6 (scratchpad rr6-dropstaged-race.js, rr6-chrome-submit.js; the root squat and the boot sweep).
       Every row below failed before the fix: a squatted staging root was adopted, a staged copy carried no hash so an
       in-place overwrite kept every identity it was checked by, unstage's known-name delete followed a junction swapped
       in after its proof, and the boot sweep ran only under require.main === module. ---- */
    {
      const cp = require('node:child_process');
      const crypto = require('node:crypto');
      const sha = s => crypto.createHash('sha256').update(s).digest('hex');
      const sh = c => { try { cp.execSync(c, { stdio: 'pipe' }); return true; } catch (e) { console.log('[skip] ' + c + ': ' + e.message.split('\n')[0]); return false; } };
      const linkDir = (at, target) => { if (isWin) return sh('cmd /c mklink /J "' + at + '" "' + target + '"'); try { fs.symlinkSync(target, at, 'dir'); return true; } catch (e) { console.log('[skip] symlink: ' + e.message); return false; } };
      const unlinkDir = at => { let st = null; try { st = fs.lstatSync(at); } catch (e) { if (e.code !== 'ENOENT') throw e; } if (st && st.isSymbolicLink()) { if (isWin) sh('cmd /c rmdir "' + at + '"'); else fs.unlinkSync(at); } };
      const quiet = async fn => { const w0 = console.warn, said = []; console.warn = (...a) => said.push(a.join(' ')); try { return { got: await fn(), said }; } finally { console.warn = w0; } };
      const r6ctx = runCtx({ agentId: 'alpha' }), r6inA = runCtx({ projectRoot: PA });
      const OWN = 'R6-OWN-BYTES-0123456789';   // 23 bytes
      put(path.join(JAIL, 'r6.txt'), OWN);
      const SR = path.join(BASE, 'r6-staging'), SRA = path.join(SR, 'alpha');
      const r6reader = o => makeEgressReader(Object.assign({ fsp, pathMod: path, workspaces: WS, stagingRoot: SR, guard: (abs, o2) => core.guard(abs, o2) }, o || {}));
      const stage = (rd, ctx, name) => rd.read((ctx || r6ctx).paths, name || 'r6.txt', { stage: { dir: SRA } });

      // MAJOR (POSIX root squat): (1) the root pre-created as a link to a folder elsewhere is refused, nothing written through it
      const elsewhere = path.join(BASE, 'r6-elsewhere');
      fs.mkdirSync(elsewhere, { recursive: true });
      if (linkDir(SR, elsewhere)) {
        try {
          const { got: g, said } = await quiet(() => stage(r6reader()));
          A.ok(!g.ok && /upload staging folder is a link to somewhere else/.test(g.error) && noHostPath(g), 'R6 squat: a staging ROOT that is a link is refused (' + (g.ok ? 'STAGED into ' + g.abs : g.error) + ')');
          A.eq(fs.readdirSync(elsewhere), [], 'R6 squat: nothing was written through the linked root');
          A.ok(said.some(w => w.indexOf(SR) >= 0), 'R6 squat: the host path goes to the console only');
        } finally { unlinkDir(SR); }
      }
      // (2)-(4) the owner check, with an injected stat (Windows stat carries no owner; on POSIX it is process.getuid())
      const ME = 1000, THEM = 4242;
      const statAs = who => Object.assign({}, fsp, { lstat: async (p, o) => {
        const st = await fsp.lstat(p, o);
        const w = (o && o.bigint) ? null : who(path.resolve(p));
        if (!w) return st;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: w.uid, mode: w.mode });
      } });
      const owned = { uid: ME, mode: 0o40700 };
      const under = p => p === path.resolve(SR) || p === path.resolve(SRA);   // the two staging folders only (a file's stat is never faked)
      const squats = [
        ['a staging root another user made first', p => (p === path.resolve(SR) ? { uid: THEM, mode: 0o40700 } : under(p) ? owned : null), /upload staging folder belongs to another user/],
        ['a group/other-writable staging root', p => (p === path.resolve(SR) ? { uid: ME, mode: 0o40777 } : under(p) ? owned : null), /upload staging folder is writable by other users/],
        ['a per-agent staging folder another user made first', p => (p === path.resolve(SRA) ? { uid: THEM, mode: 0o40700 } : under(p) ? owned : null), /upload staging folder belongs to another user/]
      ];
      for (const [label, who, re] of squats) {
        fs.rmSync(SR, { recursive: true, force: true });   // a real folder here (the link above was unlinked first)
        fs.mkdirSync(SRA, { recursive: true });            // the squatter's folder, there before the station's
        const { got: g } = await quiet(() => stage(r6reader({ fsp: statAs(who), stagingOwner: { uid: ME } })));
        A.ok(!g.ok && re.test(g.error) && noHostPath(g), 'R6 squat: ' + label + ' is refused, fail closed (' + (g.ok ? 'STAGED' : g.error) + ')');
        A.eq(fs.readdirSync(SRA), [], 'R6 squat: ' + label + ': nothing was staged in it');
      }
      // the boot sweep never walks a root that is not ours
      const left = path.join(SRA, 'a1b2c3d4e5f6a1b2c3d4e5f6');
      fs.mkdirSync(left, { recursive: true }); put(path.join(left, 'r6.txt'), 'LEFT');
      const { got: n0 } = await quiet(() => sweepUploadStaging({ fsp: statAs(p => (p === path.resolve(SR) ? { uid: THEM, mode: 0o40700 } : null)), pathMod: path, stagingRoot: SR, stagingOwner: { uid: ME } }));
      A.ok(n0 === 0 && fs.existsSync(path.join(left, 'r6.txt')), 'R6 squat: the boot sweep never walks a staging root another user owns (' + n0 + ')');
      // (5) the station's own root, owned and private: created NON-recursively with mode 0o700; staging works from the
      //     own jail and the own project root
      fs.rmSync(SR, { recursive: true, force: true });
      const made = [];
      const spy = Object.assign({}, statAs(p => (under(p) ? owned : null)), { mkdir: async (p, o) => { made.push([path.resolve(p), o]); return fsp.mkdir(p, o); } });
      const mine = r6reader({ fsp: spy, stagingOwner: { uid: ME } });
      const g1 = await stage(mine), g2 = await stage(mine, r6inA, 'report.md');
      A.ok(g1.ok && g2.ok, 'R6: an owned private root stages from the own jail and the own project root (' + [g1, g2].map(g => (g.ok ? 'ok' : g.error)).join(' / ') + ')');
      const rootMade = made.find(m => m[0] === path.resolve(SR));
      A.ok(rootMade && rootMade[1] && rootMade[1].mode === 0o700 && !rootMade[1].recursive, 'R6: the staging root is created non-recursively, mode 0o700: ' + JSON.stringify(rootMade && rootMade[1]));
      if (!isWin) A.eq(fs.statSync(SR).mode & 0o777, 0o700, 'R6 (POSIX): the created root is 0700');
      // (6) never made recursively: a root whose parent is missing refuses and creates nothing
      const deep = path.join(BASE, 'r6-no-parent', 'staging');
      const g3 = await makeEgressReader({ fsp, pathMod: path, workspaces: WS, stagingRoot: deep, guard: (abs, o2) => core.guard(abs, o2) }).read(r6ctx.paths, 'r6.txt', { stage: { dir: path.join(deep, 'alpha') } });
      A.ok(!g3.ok && !fs.existsSync(path.join(BASE, 'r6-no-parent')), 'R6: the root is never made recursively (a missing parent refuses, nothing is created): ' + (g3.ok ? 'STAGED' : g3.error));

      // BLOCKER (1): the staged copy carries the sha256 of the bytes written, and verifyStaged re-hashes. An in-place
      // overwrite to the same size with its mtime put back keeps dev/ino/nlink/size, so only the bytes give it away.
      fs.rmSync(SR, { recursive: true, force: true });
      const rd = r6reader();
      const s1 = await stage(rd);
      A.ok(s1.ok && s1.sha256 === sha(OWN) && s1.nlink === 1, 'R6 BLOCKER: the staged copy carries the sha256 of the bytes written and its one name (' + (s1.ok ? s1.sha256 : s1.error) + ')');
      A.ok((await rd.verifyStaged(s1.abs, s1)).ok, 'R6 BLOCKER: an unchanged staged copy re-verifies, bytes included');
      const t1 = fs.statSync(s1.abs);
      fs.writeFileSync(s1.abs, 'SECRET-OF-THE-USER-0000'); fs.utimesSync(s1.abs, t1.atime, t1.mtime);
      const v1 = await rd.verifyStaged(s1.abs, s1);
      A.ok(!v1.ok && /bytes changed/.test(v1.error), 'R6 BLOCKER: an in-place overwrite to the same size, mtime restored, is caught by the re-hash (' + (v1.ok ? 'PASSED' : v1.error) + ')');
      const s2 = await stage(rd);
      const secret = path.join(HOME, 'r6-secret');
      put(secret, 'SECRET-OF-THE-USER-1111');
      const t2 = fs.statSync(s2.abs);
      fs.utimesSync(secret, t2.atime, t2.mtime);
      let linked = false;
      try { fs.unlinkSync(s2.abs); fs.linkSync(secret, s2.abs); linked = true; } catch (e) { console.log('[skip] hard link: ' + e.message); }
      if (linked) {
        const v2 = await rd.verifyStaged(s2.abs, s2);
        A.ok(!v2.ok, 'R6 BLOCKER: a hard-link swap to a secret (same size, mtime aligned) is caught (' + (v2.ok ? 'PASSED' : v2.error) + ')');
      }
      for (const s of [s1, s2]) await rd.unstage(s.staged, path.basename(s.abs));
      A.eq(fs.readFileSync(secret, 'utf8'), 'SECRET-OF-THE-USER-1111', 'R6 BLOCKER: dropping the swapped copy unlinks the name only; the secret is untouched');

      // MINOR (rr6-dropstaged-race.js A): unstage with the name known, the copy folder swapped for a junction to a VICTIM
      // right after its first proof (at the lstat of folder/<name>): nothing in the victim is deleted
      {
        const victim = path.join(BASE, 'r6-victim');
        fs.mkdirSync(victim, { recursive: true }); put(path.join(victim, 'r6.txt'), 'TAXES'); put(path.join(victim, 'thesis.docx'), 'THESIS');
        let armed = null, fired = false;
        const racy = Object.assign({}, fsp, { lstat: async (p, o) => {
          if (armed && !fired && path.resolve(p) === path.resolve(path.join(armed, 'r6.txt'))) {
            fired = true;
            for (const n of fs.readdirSync(armed)) fs.unlinkSync(path.join(armed, n));
            fs.rmdirSync(armed);
            linkDir(armed, victim);
          }
          return fsp.lstat(p, o);
        } });
        const rr = r6reader({ fsp: racy });
        const g = await stage(rr);
        A.ok(g.ok, 'R6 minor: a file stages for the bounded unstage (' + (g.ok ? 'ok' : g.error) + ')');
        if (g.ok) {
          armed = g.staged;
          await rr.unstage(g.staged, 'r6.txt');
          A.ok(fired, 'R6 minor: the junction swap fired after the folder was first proven');
          A.eq(fs.readdirSync(victim).sort(), ['r6.txt', 'thesis.docx'], 'R6 minor: unstage (known name) deletes NOTHING in the victim a junction swapped in points to');
          let gone = true;
          try { fs.lstatSync(g.staged); gone = false; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (!gone) unlinkDir(g.staged);
          A.ok(gone, 'R6 minor: the junction swapped in is removed as a link');
        }
      }

      // INFO: the boot sweep runs ONCE per root, at host start whoever started the host
      {
        const { sweepUploadStagingOnce } = require('../sidecar/egress-files.js');
        const SO = path.join(BASE, 'r6-once'), first = path.join(SO, 'alpha', 'b1b2c3d4e5f6a1b2c3d4e5f6'), second = path.join(SO, 'alpha', 'c1b2c3d4e5f6a1b2c3d4e5f6');
        fs.mkdirSync(first, { recursive: true }); put(path.join(first, 'x.txt'), 'CRASHED');
        const n1 = typeof sweepUploadStagingOnce === 'function' ? await sweepUploadStagingOnce({ fsp, pathMod: path, stagingRoot: SO }) : -1;
        fs.mkdirSync(second, { recursive: true }); put(path.join(second, 'x.txt'), 'LIVE RUN');
        const n2 = typeof sweepUploadStagingOnce === 'function' ? await sweepUploadStagingOnce({ fsp, pathMod: path, stagingRoot: SO }) : -1;
        A.ok(n1 === 1 && !fs.existsSync(first) && n2 === 0 && fs.existsSync(path.join(second, 'x.txt')), 'R6 info: the boot sweep runs once per staging root; a second call never sweeps a live run\'s copy (' + n1 + ', ' + n2 + ')');
        const src = require('./helpers/source.js').readSidecarSource();
        const at = src.indexOf('sweepUploadStagingOnce({');
        const nextFile = src.indexOf('\n/* ---- sidecar/', 1);
        const line = at < 0 ? '' : src.slice(src.lastIndexOf('\n', at) + 1, src.indexOf('\n', at));
        A.ok(at > 0 && at < nextFile && /^require\('\.\/egress-files\.js'\)\.sweepUploadStagingOnce\(\{ fsp, pathMod: path, workspaces: WORKSPACES \}\)/.test(line),
          'R6 info: index.js sweeps at module load, a top-level statement (no require.main === module guard): ' + JSON.stringify(line.slice(0, 120)));
        A.ok(src.slice(0, nextFile).indexOf('require.main === module) require(\'./egress-files.js\').sweepUploadStaging') < 0, 'R6 info: the require.main-only boot sweep is gone');
      }
      fs.rmSync(SR, { recursive: true, force: true });
    }
  } finally {
    // unlink the planted links first, so removing the temp tree never walks through one into its target
    for (const l of [path.join(JAIL, 'notes'), path.join(JAIL, 'jx'), path.join(PA, 'px'), path.join(WS, 'delta')]) {
      let st = null;
      try { st = fs.lstatSync(l); } catch (e) { if (e.code !== 'ENOENT') console.log('[cleanup] ' + e.message); }
      if (!st) continue;
      try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { console.log('[cleanup] ' + e2.message); } }
    }
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  A.report('egress-files.test');
})().catch(e => { console.error(e); process.exit(1); });
