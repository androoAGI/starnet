/* #104 + run-paths review round 3 (M-B): an upload is a file LEAVING the station, so browser.upload proves every path
   through the ONE egress reader (sidecar/egress-files.js, probe mode) and hands the browser the proven REAL path. Only
   a file in the run's own private workspace or its own approved project root goes; another blessed root, This Computer
   reach, Full Power ~/.ssh, a floored file and a hard link are refused (each was uploaded before, with no card under
   Full Power), and the run's fs.read guard is never asked. No CDP ack-only success.
   Review round 4, minor-1 (scratchpad rr4-egress.js section G): the browser opens the path it is handed AFTER the proof,
   so a folder swapped for a junction in between changed the bytes uploaded. The browser is handed a STAGED COPY of the
   proven bytes (a fresh random folder, the original name), dropped when the run ends or its own browser closes, bounded
   in size, and swept at boot without ever entering a link.
   Review round 5 (scratchpad rr5r-stage-race.js): the staged copy lived in the agent's OWN jail, so a same-run process
   could find and swap it (hard link / junction) between staging and Chrome's read. The copy now lives in a station-owned
   root OUTSIDE every jail (egress-files.js defaultStagingRoot: <per-user base>/starnet-upload-staging-<id>/<agent>/<rand>),
   is locked owner-only, and is re-verified around the hand-off.
   Review round 6 BLOCKER (scratchpad rr6-chrome-submit.js, real Chrome): the browser reads the file at FORM SUBMIT, a
   later action, so a swap after browser.upload returned was sent. Every staged copy stays registered with its sha256,
   and every later browser action that can submit or read re-proves it first; a change empties the input, drops the copy
   and refuses the action. Threat model (owner decision): these guard the tool path and accidental leaks, not a hostile
   same-user shell.
   run-paths-polish P1 (live walk W-R7 (b) on 0.14.2): the copies were deleted at every reply end, so a file the agent
   selected without submitting was gone when the PERSON clicked Submit (Chrome: ERR_FILE_NOT_FOUND, the input still
   showing the file). The registry is the browser SESSION's now (upload-stage.js): a copy lives while the page it went
   into lives, re-proved before every later agent action of any reply; it goes when that page is gone, after its TTL
   (the input emptied, and said), when another agent takes the browser, and when the browser closes. Round-7 minors:
   m1 a failed hand-off keeps no copy; m2 the tool never empties an input by coordinates when a driver can do it by the
   File's identity, and never before anything was handed; m3 a multi-file input emptied whole names every file it held.
   run-paths-polish review round 1 (scratchpad rev1/rev1-repro.js R-B): the receipt promised "the form can still be
   submitted after this reply" from every browser that names its page, but a run's OWN browser (every unattended run)
   and the PRIVATE browser a COMMS run gets while the station is busy close at the run end, and the copy with them.
   The promise is made only for a browser that outlives the run (the station view says which: outlivesRun).
   Review round 2, minor R-A (scratchpad verify-sec/r2/cross-agent-e2e.js, rev2/rev2-walk.js X1): the station registry is
   shared by every agent that drives it, and a note or a refusal quotes a copy's name. Agent A's TTL note, queued after
   A's run ended, was said on agent B's first action in the station, and B's action refused for A's changed copy named
   A's file while A was never told. Each is said only to the agent whose file it is.
   Polish review round 1, minor 2 (scratchpad rev1/rev1-crossover.js, rev2/rev2-walk.js X2): a second run whose first
   browser tool is a test_*, login or need_human call binds the STATION's registry before any take, and at its end it
   released every copy there: the driving run's copy, mid-reply, was dropped and its input emptied, so that run's own
   Submit sent nothing. A run's end now releases only the copies its own browser.upload selected.
   COORDINATOR CALL (2026-10-30, Andrew may override): a copy staged in an earlier reply MAY be sent by a later run of
   the SAME agent while its page lives (the egress decision was made and proven at staging, and it is re-proved before
   every action); another agent taking the station browser drops every copy, and withholds the notes not for it.
   TEST HYGIENE (polish review round 1): this test stages in-process, so its per-user staging base is pointed inside
   its own scratch (test/helpers/staging-base.js), never the user's real %LOCALAPPDATA%\StarNet or TEMP. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { makeBrowserViews } = require('../sidecar/browser-view.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const { makeEgressReader, defaultStagingRoot } = require('../sidecar/egress-files.js');
const RunPaths = require('../sidecar/run-paths.js');
const { selectFiles } = require('../sidecar/tools/builtin/browser-upload.js');
const { hermeticStagingBase } = require('./helpers/staging-base.js');
const rejects = async (p, re, message) => { try { await p; A.ok(false, message + ': did not refuse'); } catch (e) { A.ok(re.test(e.message), message + ': ' + e.message); } };
(async () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-unit-')));
  const scratchTmp = path.resolve(os.tmpdir());
  const perUser = hermeticStagingBase(scratch);   // the per-user staging base, inside scratch (never the user's real one)
  let stagingRootForCleanup = null;   // the station staging root lives in the per-user staging base, OUTSIDE the jail
  try {
    const project = path.join(scratch, 'project'), other = path.join(scratch, 'other-project'), outside = path.join(scratch, 'outside'), root = path.join(scratch, 'workspaces');
    const home = path.join(scratch, 'home');
    for (const p of [project, other, outside, path.join(root, 'agent'), path.join(root, 'other'), path.join(home, '.ssh')]) fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(project, 'photo.txt'), 'PROJECT');
    fs.writeFileSync(path.join(other, 'photo.txt'), 'OTHER-ROOT');
    fs.writeFileSync(path.join(root, 'agent', 'photo.txt'), 'PRIVATE');
    fs.writeFileSync(path.join(root, 'other', 'photo.txt'), 'OTHER');
    fs.writeFileSync(path.join(outside, 'photo.txt'), 'OUTSIDE');
    fs.writeFileSync(path.join(project, '.env'), 'PRIVATE_TEST_SECRET');
    fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'SSH-KEY');
    const roots = new Set([project, other]), calls = [], seen = [];
    let fullAccess = false, replyMode = 'selected', onUpload = null;
    const trust = makePathTrust({ fsp, pathMod: path, roots: () => [...roots], workspaceRoot: root });
    const driver = {
      snapshot: async () => [{ role: 'button', text: 'Choose photo', x: 1, y: 1, w: 10, h: 10 }],
      upload: async (_node, abs, expected) => {
        calls.push(abs);
        if (onUpload) await onUpload(abs);
        seen.push(abs.map(p => fs.readFileSync(p, 'utf8')));   // what the browser reads when it opens the path, later
        if (replyMode === 'ack') return '1 file(s) attached';
        return { status: 'selected', files: expected, retained: true, input: { id: '<script>untrusted</script>' }, events: ['change'], evidence: 'FileList readback' };
      }
    };
    const guardCalls = [];
    // wired as index.js wires it: the host's egress reader (its guard is the station guard, asked in its strictest form)
    const egress = makeEgressReader({ fsp, pathMod: path, workspaces: root, guard: (abs, o2) => trust.guard(abs, o2) });
    const b = makeBrowserTools({ driver, fsp, pathMod: path, root, egress, pathTrust: (abs, opts) => {
      guardCalls.push(opts);
      return trust.guard(abs, { ...opts, surface: 'autonomous', fullAccess });
    } });
    const ref = (await b.session.snapshot())[0].ref;
    const up = b.tools.find(t => t.name === 'browser.upload');
    const ctx = { agentId: 'agent', projectRoot: project };
    const run = (paths, context = ctx) => up.run({ ref, paths }, context);
    // a run's ctx.paths exactly as runOnceCore mints it, posture in its guard (Full Power: unrestrictedHost)
    const minted = (o) => ({ agentId: 'agent', paths: RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root,
      pathTrust: (abs, o2) => trust.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: 'agent', fullAccess: !!o.fullAccess, unrestrictedHost: !!o.unrestrictedHost }) }), { agentId: 'agent', projectRoot: o.projectRoot || '' }) });
    // the browser is handed a STAGED COPY (round 4, minor-1; round 5 relocation): a station-owned root OUTSIDE the jail,
    // <stagingRoot>/<agent>/<24 hex>/<the file's own name>, holding the proven bytes
    const stagingRoot = defaultStagingRoot(path, root);
    stagingRootForCleanup = stagingRoot;
    A.ok(path.resolve(stagingRoot).toLowerCase().startsWith(path.join(scratch, 'per-user-base').toLowerCase() + path.sep),
      'test hygiene: this in-process test stages inside its own scratch, never the user\'s real per-user base: ' + stagingRoot);
    const STAGE = path.join(stagingRoot, 'agent');
    const stagedCopy = (p, name) => !!p && path.dirname(path.dirname(p)) === STAGE && /^[0-9a-f]{24}$/.test(path.basename(path.dirname(p))) && path.basename(p) === (name || 'photo.txt');
    // review round 5 (3): the station staging root is OUTSIDE every jail and blessed root, so neither the fs.* path
    // trust nor the shell's absolute-path floor can reach it by a LITERAL path. (HONEST: a shell with the user's rights
    // can still COMPUTE a temp dir and owner-only ACLs do not stop the same user — the header's remaining defences.)
    {
      const litPath = path.join(STAGE, 'deadbeefdeadbeefdeadbeef', 'photo.txt');
      for (const scope of ['read', 'write']) {
        let denied = null;
        try { await trust.guard(litPath, { scope, surface: 'autonomous', agentId: 'agent' }); } catch (e) { denied = e; }
        A.ok(denied && /outside the agent workspace|no project root grant/.test(denied.message), 'fs.' + scope + ' cannot reach the staging root by a literal path: ' + (denied && denied.message));
      }
      const shell = require('../sidecar/tools/builtin/shell.js').makeShellTool({ spawn: () => { throw new Error('a refused command must never spawn'); }, fs, pathMod: path, root });
      await rejects(Promise.resolve().then(() => shell.execTool.run({ cmd: 'echo hi', cwd: STAGE }, { agentId: 'agent' })), /cwd must stay inside your workspace/, 'shell.exec refuses the staging root as cwd');
      if (process.platform === 'win32') await rejects(Promise.resolve().then(() => shell.execTool.run({ cmd: 'type ' + path.join(STAGE, 'x.txt') }, { agentId: 'agent' })), /drive-absolute paths/, 'shell.exec refuses the drive-absolute staging path as a command argument');
    }
    const handed = (bytes, name) => stagedCopy(calls.at(-1) && calls.at(-1)[0], name) && calls.at(-1).length === 1 && seen.at(-1)[0] === bytes;
    const said = () => JSON.stringify(calls.at(-1)) + ' = ' + JSON.stringify(seen.at(-1));
    let r = await run(['photo.txt']);
    A.ok(handed('PROJECT'), 'project-relative file reaches the browser from the active project, as a staged copy: ' + said());
    A.ok(/BEGIN EXTERNAL WEB CONTENT/.test(r.content) && /Remote upload\/server acceptance is not verified/.test(r.content), 'page-authored input identity is fenced and remote acceptance is unproven');
    await run(['photo.txt'], { agentId: 'agent' });
    A.ok(handed('PRIVATE'), 'unscoped relative file retains private workspace behavior: ' + said());
    await run([path.join(project, 'photo.txt')]);
    A.ok(handed('PROJECT'), 'the run\'s own root by absolute path works: ' + said());
    await run([path.join(root, 'agent', 'photo.txt')]);
    A.ok(handed('PRIVATE'), 'a project run\'s own private workspace by absolute path works: ' + said());
    await run([path.join(project.toUpperCase(), 'PHOTO.TXT')].map(p => (process.platform === 'win32' ? p : path.join(project, 'photo.txt'))));
    A.ok(handed('PROJECT', 'photo.txt'), 'the copy carries the proven file\'s own name, never the name as written: ' + said());
    A.eq(guardCalls.length, 0, 'the run\'s fs.read guard is never asked (an upload never raises a path card)');
    let before = calls.length;
    for (const p of ['../outside/photo.txt', '.env', '.', 'missing.txt']) await rejects(run([p]), /climbs out|protected|not a file|cannot be read|is not in/i, 'refuses ' + p);
    await rejects(run(['photo.txt', '']), /non-empty/i, 'rejects invalid lists atomically');
    await rejects(run(['photo.txt', '.env']), /protected/i, 'one refused path refuses the whole selection');
    A.eq(calls.length, before, 'refused paths never reach browser');
    // M-B: everything fs.read could reach but the run's own folders (each of these was uploaded before round 3)
    await rejects(run([path.join(other, 'photo.txt')]), /outside this run's project folder/, 'another blessed root is refused');
    await rejects(run([path.join(project, 'photo.txt')], { agentId: 'agent' }), /outside your workspace/, 'an unscoped run cannot upload from a blessed root it does not work in');
    fullAccess = true;
    await rejects(run([path.join(outside, 'photo.txt')], { agentId: 'agent' }), /outside your workspace/, 'This Computer (Full Access) reach is refused');
    await rejects(run([path.join(outside, 'photo.txt')], minted({ fullAccess: true })), /outside your workspace/, 'This Computer, through a minted run path object, is refused');
    fullAccess = false;
    await rejects(run([path.join(home, '.ssh', 'id_ed25519')], minted({ unrestrictedHost: true })), /protected file/, 'Full Power ~/.ssh is refused (the credential floor, no card)');
    await rejects(run([path.join(root, 'other', 'photo.txt')], minted({ unrestrictedHost: true })), /outside your workspace/, 'Full Power: another agent\'s workspace is refused');
    await rejects(run(['.env'], minted({ projectRoot: project, unrestrictedHost: true })), /protected file/, 'Full Power: the project .env is refused (the floor)');
    let linked = false;
    try { fs.linkSync(path.join(home, '.ssh', 'id_ed25519'), path.join(root, 'agent', 'notes.txt')); linked = true; } catch (e) { console.log('[skip] hard link: ' + e.message); }
    if (linked) {
      await rejects(run(['notes.txt'], { agentId: 'agent' }), /hard link/, 'a jail hard link to ~/.ssh is refused');
      await rejects(run([path.join(root, 'agent', 'notes.txt')]), /hard link/, 'and by absolute path from a project run');
    }
    A.eq(calls.length, before, 'none of them reached the browser');
    roots.delete(project);
    await rejects(run(['photo.txt']), /no longer approved/i, 'revoked project cannot silently fall back to private same-name file');
    roots.add(project);
    const link = path.join(project, 'escape');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await rejects(run(['escape/photo.txt']), /outside this run's project folder/i, 'project junction cannot disclose an untrusted sibling file');
    // a rig with no host egress reader sends from the private workspace only (no guard to prove a root still approved)
    const rig = makeBrowserTools({ driver, fsp, pathMod: path, root });
    const rigUp = rig.tools.find(t => t.name === 'browser.upload');
    const rigRef = (await rig.session.snapshot())[0].ref;
    await rigUp.run({ ref: rigRef, paths: ['photo.txt'] }, { agentId: 'agent' });
    A.ok(handed('PRIVATE'), 'a rig without the host reader still uploads from the private workspace: ' + said());
    await rejects(rigUp.run({ ref: rigRef, paths: ['photo.txt'] }, ctx), /cannot prove the project folder is still approved/, 'and refuses a project file it cannot prove approved (fail closed)');

    // ---- review round 4, minor-1: the bytes uploaded are the bytes proven, whatever the folder becomes afterwards ----
    {
      const isWin = process.platform === 'win32';
      const sub = path.join(root, 'agent', 'sub');
      fs.mkdirSync(sub, { recursive: true }); fs.writeFileSync(path.join(sub, 'x.txt'), 'JAIL-SUB-X');
      fs.mkdirSync(path.join(home, 'sub'), { recursive: true }); fs.writeFileSync(path.join(home, 'sub', 'x.txt'), 'HOME-SECRET-X');
      let swapped = false;
      onUpload = async () => {   // after the proof, before the browser opens the path: the folder becomes a junction
        fs.renameSync(sub, sub + '-real');
        fs.symlinkSync(path.join(home, 'sub'), sub, isWin ? 'junction' : 'dir');
        swapped = true;
      };
      try { await run(['sub/x.txt'], { agentId: 'agent' }); } finally {
        onUpload = null;
        if (swapped) { try { fs.unlinkSync(sub); } catch (e) { fs.rmdirSync(sub); } fs.renameSync(sub + '-real', sub); }
      }
      A.ok(swapped && handed('JAIL-SUB-X', 'x.txt'), 'swapping the proven folder for a junction after the proof cannot change the bytes uploaded (was: HOME-SECRET-X): ' + said());
      // the copies go: releaseUploads (the host calls it when the run ends) removes every one this browser was handed
      const copy = calls.at(-1)[0];
      const folders = () => (fs.existsSync(STAGE) ? fs.readdirSync(STAGE) : []);
      A.ok(fs.existsSync(copy) && folders().length >= 5, 'the copies stay while the run may still submit the form (' + folders().length + ')');
      await b.releaseUploads();
      A.ok(!fs.existsSync(copy) && !fs.existsSync(path.dirname(copy)), 'releaseUploads removes the staged copy and its folder');
      await rig.releaseUploads();
      A.eq(folders(), [], 'every staged copy of both browsers is gone at run end');
      A.eq(fs.readFileSync(path.join(sub, 'x.txt'), 'utf8') + fs.readFileSync(path.join(root, 'agent', 'photo.txt'), 'utf8'), 'JAIL-SUB-XPRIVATE', 'and the source files are untouched');
      // a selection that is refused part-way leaves no copy behind
      await rejects(run(['photo.txt', '.env']), /protected/i, 'one refused path refuses the whole selection');
      A.eq(folders(), [], 'a refused selection leaves no staged copy');
      // this run's OWN browser takes its copies with it when it closes
      const own = makeBrowserTools({ driver, fsp, pathMod: path, root, egress });
      await own.tools.find(t => t.name === 'browser.upload').run({ ref: (await own.session.snapshot())[0].ref, paths: ['photo.txt'] }, { agentId: 'agent' });
      A.ok(handed('PRIVATE') && folders().length === 1, 'a private browser\'s upload is staged');
      await own.session.close();
      A.eq(folders(), [], 'closing the run\'s own browser removes its staged copies');
      // bounded: a file over the limit is refused with a clear message, and nothing is copied
      const small = makeBrowserTools({ driver, fsp, pathMod: path, root, egress, uploadMaxBytes: 4 });
      await rejects(small.tools.find(t => t.name === 'browser.upload').run({ ref: (await small.session.snapshot())[0].ref, paths: ['photo.txt'] }, { agentId: 'agent' }), /"photo\.txt" is 7 bytes; a browser upload takes at most 4 bytes/, 'a file over the upload limit is refused, saying the limit');
      A.eq(folders(), [], 'and nothing was staged for it');
      A.eq(require('../sidecar/egress-files.js').STAGE_MAX_BYTES, 200 * 1024 * 1024, 'the default limit is 200 MB');
      // a per-agent staging folder that is a link is never written through (now in the station root, not the jail)
      const away = path.join(scratch, 'away');
      fs.mkdirSync(away, { recursive: true });
      try { fs.rmdirSync(STAGE); } catch (e) { fs.rmSync(STAGE, { recursive: true, force: true }); }
      fs.symlinkSync(away, STAGE, isWin ? 'junction' : 'dir');
      try {
        await rejects(run(['photo.txt'], { agentId: 'agent' }), /upload staging folder is a link to somewhere else/, 'a staging folder that is a link is refused');
        A.eq(fs.readdirSync(away), [], 'and nothing was written through it');
      } finally { try { fs.unlinkSync(STAGE); } catch (e) { try { fs.rmdirSync(STAGE); } catch (e2) { console.log('[cleanup] ' + e2.message); } } }
      // THE BOOT SWEEP walks the STATION staging root <root-id>/<agent>/<copy>: a crash's leftovers go; a link is
      // unlinked never entered; an agent folder that is itself a link is never walked
      const { sweepUploadStaging } = require('../sidecar/egress-files.js');
      const left = path.join(STAGE, 'a1b2c3d4e5f6a1b2c3d4e5f6');
      fs.mkdirSync(left, { recursive: true });
      fs.writeFileSync(path.join(left, 'photo.txt'), 'LEFT BEHIND');
      fs.symlinkSync(path.join(home, 'sub'), path.join(left, 'trap'), isWin ? 'junction' : 'dir');
      fs.symlinkSync(path.join(home, 'sub'), path.join(STAGE, 'trap2'), isWin ? 'junction' : 'dir');
      const zeta = path.join(scratch, 'zeta-real');
      fs.mkdirSync(path.join(zeta, 'f00f00f00f00f00f00f00f00'), { recursive: true });
      fs.writeFileSync(path.join(zeta, 'f00f00f00f00f00f00f00f00', 'keep.txt'), 'KEEP');
      fs.symlinkSync(zeta, path.join(stagingRoot, 'zeta'), isWin ? 'junction' : 'dir');
      try {
        const n = await sweepUploadStaging({ fsp, pathMod: path, workspaces: root });
        A.ok(n === 1 && !fs.existsSync(left), 'the boot sweep removes a crashed run\'s staged copy (' + n + ')');
        A.eq(fs.readFileSync(path.join(home, 'sub', 'x.txt'), 'utf8'), 'HOME-SECRET-X', 'a link inside a staged folder is unlinked, never followed');
        A.ok(fs.existsSync(path.join(STAGE, 'trap2')), 'a link in the staging folder is never entered');
        A.ok(fs.existsSync(path.join(zeta, 'f00f00f00f00f00f00f00f00', 'keep.txt')), 'an agent folder that is a link is never walked');
        A.eq(await sweepUploadStaging({ fsp, pathMod: path, workspaces: path.join(scratch, 'no-such-dir') }), 0, 'no staging root: nothing to sweep');
      } finally {
        for (const l of [path.join(STAGE, 'trap2'), path.join(stagingRoot, 'zeta')]) { try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { console.log('[cleanup] ' + e2.message); } } }
        try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { console.log('[cleanup] ' + e.message); }
      }
    }

    /* ---- review round 5 (scratchpad rr5r-stage-race.js): a CONCURRENT SAME-RUN PROCESS (a forked writer, as the probe
       does) that computes the station staging root and swaps the staged copy for a hard link / junction to a secret
       between staging and the browser's read. Each scenario must now REFUSE and cancel the selection, and the secret
       must never be what sat at the staged path when the browser was handed it. ---- */
    {
      const cp = require('node:child_process');
      const WRITER = path.join(__dirname, 'helpers', 'upload-race-writer.js');
      fs.mkdirSync(path.join(root, 'racer'), { recursive: true });
      fs.mkdirSync(path.join(home, 'secrets'), { recursive: true });
      const raceSecret = path.join(home, 'secrets', 'id_rsa');   // a credential OUTSIDE every jail and root, like ~/.ssh/id_rsa
      const SECRET_BYTES = 'BEGIN OPENSSH PRIVATE KEY SECRET';   // 32 bytes; contains SECRET
      fs.writeFileSync(raceSecret, SECRET_BYTES);
      const RSTAGE = path.join(stagingRoot, 'racer');
      async function raceScenario(label, mode, fileName, fileBytes) {
        fs.writeFileSync(path.join(root, 'racer', fileName), fileBytes);
        const writer = cp.fork(WRITER, [mode, RSTAGE, fileName, raceSecret, path.dirname(raceSecret)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        try {
          await new Promise(r => writer.once('message', r));   // ready
          const swap = () => new Promise(res => { writer.once('message', m => res(m)); writer.send({ go: true }); });
          let cleared = false, handoff = null;
          const d = {
            snapshot: async () => [{ role: 'button', text: 'Choose', x: 1, y: 1, w: 10, h: 10 }],
            clearUpload: async () => { cleared = true; return { cleared: true }; },
            upload: async (_n, abs, expected) => {
              handoff = abs.map(p => { try { return fs.readFileSync(p, 'latin1'); } catch (e) { return ''; } });   // what sat there when handed (pre-swap)
              await swap();                                                                                        // the fork swaps the copy DURING the hand-off
              return { status: 'selected', files: expected, retained: true, events: ['change'] };
            }
          };
          const rb = makeBrowserTools({ driver: d, fsp, pathMod: path, root, egress });
          const rref = (await rb.session.snapshot())[0].ref;
          const rup = rb.tools.find(t => t.name === 'browser.upload');
          let threw = null;
          try { await rup.run({ ref: rref, paths: [fileName] }, { agentId: 'racer' }); } catch (e) { threw = e; }
          await rb.releaseUploads();
          A.ok(threw && /changed .*after it was selected/.test(threw.message), label + ': the swapped staged copy is refused: ' + (threw && threw.message));
          A.ok(cleared, label + ': the file input is cleared, so a form submitted later sends nothing');
          A.ok(handoff && handoff.join('').indexOf('SECRET') < 0, label + ': only the proven bytes ever sat at the staged path (no secret): ' + JSON.stringify(handoff));
          A.eq(fs.readFileSync(raceSecret, 'utf8'), SECRET_BYTES, label + ': the secret file itself is untouched');
        } finally { try { writer.kill(); } catch (e) { console.log('[cleanup] ' + e.message); } }
      }
      await raceScenario('S1 hard-link swap of the staged copy', 'hardlink', 'a.txt', 'A'.repeat(64));
      await raceScenario('S1s hard-link swap, copy padded to the secret size', 'hardlink', 'pad.txt', 'B'.repeat(SECRET_BYTES.length));
      await raceScenario('S2 hard-link swap around a delayed page read', 'hardlink', 's2.txt', 'C'.repeat(40));
      await raceScenario('S2b hard-link swap before a later form submit', 'hardlink', 's2b.txt', 'D'.repeat(40));
      await raceScenario('S3 staged folder swapped for a junction to the secret', 'junction', 'id_rsa', 'DECOY-IN-MY-OWN-WORKSPACE');
      try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { console.log('[cleanup] ' + e.message); }
    }

    /* ---- review round 6 BLOCKER (scratchpad rr6-chrome-submit.js against a REAL headless Chrome; rr6-postreturn-
       window.js): Chrome reads an uploaded file at FORM SUBMIT, a later separate action, not when it is selected. The
       driver below does what Chrome does: upload() hands the input a PATH and reads nothing; click() and press() submit
       the form, reading whatever sits at the handed path NOW. Each swap made after browser.upload returned was sent at
       the click before the fix. Now the click is refused, the input emptied, the staged copy dropped and NOTHING sent;
       a normal upload then click still sends the original bytes. ---- */
    {
      fs.mkdirSync(path.join(root, 'r6'), { recursive: true });
      const SECRET6 = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-OF-THE-USER-0123456789abcdef\n-----END OPENSSH PRIVATE KEY-----\n';
      const OWN6 = 'A'.repeat(200);   // the model's own file, a DIFFERENT size from the secret, as in the probe
      const secret6 = path.join(home, '.ssh', 'id_rsa');
      const padded = () => (SECRET6 + ' '.repeat(OWN6.length)).slice(0, OWN6.length);
      function chromeLike(o) {
        o = o || {};
        const st = { handed: [], sent: [], submits: 0, cleared: 0, clearedPaths: [], loader: 'L1', alive: 'yes', failUpload: null };
        const submit = () => { st.submits++; st.sent.push(st.handed.map(p => (fs.existsSync(p) ? fs.readFileSync(p, 'latin1') : null))); if (o.navigates) st.loader = 'L' + (st.submits + 1); };
        const d = {
          st,
          personSubmit: submit,   // the PERSON clicks Submit in the station browser: no agent tool, no gate
          snapshot: async () => [{ role: 'button', text: 'Choose file', x: 1, y: 1, w: 10, h: 10 }, { role: 'button', text: 'Send form', x: 1, y: 30, w: 10, h: 10 }],
          upload: async (_n, abs, expected) => {
            const doc = o.doc ? { sid: null, loader: st.loader } : null;
            if (st.failUpload === 'before') throw new Error('no associated file input found at this ref; snapshot the page and pick the file input or its label');
            st.handed = abs.slice();
            if (o.onHand) await o.onHand(abs);
            if (st.failUpload === 'after') throw Object.assign(new Error('the file input did not confirm the requested file selection'), { handed: true }, doc ? { uploadDoc: doc } : {});
            if (st.failUpload === 'receipt') return { status: 'selected', files: [], retained: true, events: ['change'], doc };
            const r = { status: 'selected', files: expected, retained: true, events: ['change'] }; if (doc) r.doc = doc; return r;
          },
          clearUpload: async () => { st.cleared++; st.handed = []; return { cleared: true }; },
          click: async () => { submit(); return 'clicked'; },
          press: async () => { submit(); return 'pressed'; },
          type: async () => 'typed',
          back: async () => { st.loader = 'L-back'; return 'https://example.com/back'; }
        };
        if (o.doc) {
          d.uploadDocAlive = async doc => (st.alive === 'unknown' ? null : st.alive === 'closed' ? false : doc.loader === st.loader);
          // a real input is emptied WHOLE (browser-upload.js clearFilesHolding), and says every File it held (m3)
          d.clearStagedInputs = async (_doc, paths) => {
            st.clearedPaths.push(...paths);
            if (!st.handed.some(p => paths.includes(p))) return { cleared: 0, paths: [] };
            const held = st.handed; st.handed = [];
            return { cleared: 1, paths: held };
          };
        }
        return d;
      }
      async function selected(o) {
        fs.writeFileSync(path.join(root, 'r6', 'own.bin'), OWN6);
        fs.writeFileSync(secret6, SECRET6);
        const d = chromeLike(o);
        const tb = makeBrowserTools(Object.assign({ driver: d, fsp, pathMod: path, root, egress }, (o && o.deps) || {}));
        const [choose, send] = (await tb.session.snapshot()).map(n => n.ref);
        const tool = name => tb.tools.find(t => t.name === name);
        const receipt = await tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, { agentId: 'r6' });
        return { d, tb, tool, choose, send, receipt, copy: d.st.handed[0] };
      }
      const attempt = async p => { try { return { out: await p }; } catch (e) { return { error: e }; } };
      const sentBytes = d => d.st.sent.flat().filter(b => b != null);
      const REFUSED = /was refused: an uploaded file changed on disk after you selected it, so it was not sent; select it again/;
      /* A FIRED TTL IS DONE WHEN ITS NOTE IS WRITTEN, not when its folder is gone. The registry's expire runs on its own
         promise: the copy's rmdir takes the folder off the disk, its completion comes back on a later turn of the loop, and
         only then is the note written (upload-stage.js expire). A walk that moved on when the folder was gone could act in
         that gap, and its next action had no note to say. So this waits for each live copy's own unstage to finish
         (bounded: a copy that never goes fails its assertion and never strands the walk), then one turn for the rest of
         expire, which does no more I/O. */
      const ttlDone = async (session, fireTtl) => {
        let pending = 0;
        for (const c of session.uploadStage.copies()) {
          const unstage = c.unstage;
          pending++;
          c.unstage = () => Promise.resolve().then(unstage).finally(() => { pending--; });
        }
        fireTtl();
        for (let i = 0; i < 500 && pending > 0; i++) await new Promise(r => setTimeout(r, 10));
        await new Promise(r => setImmediate(r));
      };

      // control: the receipt is honest, and a normal upload then click sends the original bytes
      {
        const x = await selected();
        A.ok(/^File selected for upload: the input was handed a checked copy of it\./.test(x.receipt.content) && /re-checks it before each later browser action/.test(x.receipt.content) && !/selection verified/i.test(x.receipt.content),
          'R6 (4): the receipt says the file was selected and is re-checked, never that it is verified: ' + x.receipt.content.slice(0, 90));
        // P1: a driver that cannot name the page keeps the copy only until the reply ends, and the receipt says exactly that
        A.ok(/cannot name the page, so StarNet keeps that copy only until this reply ends/.test(x.receipt.content) && /submit the form in this reply, or select the file again later/.test(x.receipt.content),
          'P1: with no page identity the receipt says the copy lasts until this reply ends: ' + x.receipt.content.slice(0, 260));
        const c = await attempt(x.tool('browser.click').run({ ref: x.send }, { agentId: 'r6' }));
        A.ok(!c.error && x.d.st.submits === 1 && sentBytes(x.d).length === 1 && sentBytes(x.d)[0] === OWN6, 'R6 control: a normal upload then click sends the original bytes (' + (c.error ? c.error.message : sentBytes(x.d).map(b => b.length + ' B').join(',')) + ')');
        A.ok(fs.existsSync(x.copy), 'R6 control: the staged copy stays while the same page may submit again');
        await x.tb.releaseUploads();
      }
      // the probe's swaps, each made AFTER browser.upload returned and BEFORE the click
      const swaps = [
        ['in-place overwrite with the secret (size changes)', cpy => fs.writeFileSync(cpy, SECRET6)],
        ['in-place overwrite padded to the same size, mtime restored', cpy => { const s = fs.statSync(cpy); fs.writeFileSync(cpy, padded()); fs.utimesSync(cpy, s.atime, s.mtime); }],
        ['hard-link swap to the secret, padded, mtime aligned', cpy => { const s = fs.statSync(cpy); fs.writeFileSync(secret6, padded()); fs.utimesSync(secret6, s.atime, s.mtime); fs.unlinkSync(cpy); fs.linkSync(secret6, cpy); fs.utimesSync(cpy, s.atime, s.mtime); }],
        ['the staged copy deleted', cpy => fs.unlinkSync(cpy)]
      ];
      for (const [label, swap] of swaps) {
        const x = await selected();
        swap(x.copy);
        const c = await attempt(x.tool('browser.click').run({ ref: x.send }, { agentId: 'r6' }));
        A.ok(c.error && REFUSED.test(c.error.message) && /"own\.bin"/.test(c.error.message), 'R6 ' + label + ': the click is refused: ' + (c.error ? c.error.message : 'CLICKED, sent ' + JSON.stringify(sentBytes(x.d).map(b => b.slice(0, 40)))));
        A.eq(x.d.st.submits, 0, 'R6 ' + label + ': the click never reached the page');
        A.ok(x.d.st.cleared === 1 && x.d.st.handed.length === 0, 'R6 ' + label + ': the file input was emptied');
        A.ok(!fs.existsSync(path.dirname(x.copy)), 'R6 ' + label + ': the staged copy was dropped');
        A.ok(fs.readFileSync(secret6, 'latin1').indexOf('SECRET-OF-THE-USER') >= 0 && fs.statSync(secret6).nlink === 1, 'R6 ' + label + ': the secret is untouched and has one name again');
        // the next click goes ahead (nothing staged is live) and the emptied input sends nothing
        const again = await attempt(x.tool('browser.click').run({ ref: x.send }, { agentId: 'r6' }));
        A.ok(!again.error && x.d.st.submits === 1 && sentBytes(x.d).length === 0, 'R6 ' + label + ': a later click submits an empty input: nothing left the station (' + JSON.stringify(sentBytes(x.d).map(b => b.slice(0, 40))) + ')');
        await x.tb.releaseUploads();
      }
      // every action that can submit or read is gated, not only click (the upload itself too: its change event can
      // submit another input's selection)
      for (const [name, args] of [['browser.press', { key: 'Enter' }], ['browser.type', { ref: null, text: 'x' }], ['browser.back', {}], ['browser.upload', { ref: null, paths: ['own.bin'] }]]) {
        const x = await selected();
        const s = fs.statSync(x.copy);
        fs.writeFileSync(x.copy, padded()); fs.utimesSync(x.copy, s.atime, s.mtime);
        const a = Object.assign({}, args); if ('ref' in a) a.ref = name === 'browser.upload' ? x.choose : x.send;
        const r = await attempt(x.tool(name).run(a, { agentId: 'r6' }));
        A.ok(r.error && new RegExp('^' + name.replace('.', '\\.') + ' ' + REFUSED.source).test(r.error.message) && x.d.st.submits === 0 && x.d.st.handed.length === 0,
          'R6 ' + name + ' after a swap is refused, the input emptied, nothing sent: ' + (r.error ? r.error.message.slice(0, 120) : 'RAN'));
        await x.tb.releaseUploads();
      }
      // a driver that names the page (the CDP driver): the input is emptied by the File's own path, the page's
      // bookkeeping never reaches the model, and (3) a copy whose page navigated away is dropped after that action
      {
        const x = await selected({ doc: true, navigates: true });
        A.ok(!/loader|"doc"/.test(x.receipt.content), 'R6: the page bookkeeping (doc) is not in the model-facing readback');
        const s = fs.statSync(x.copy);
        fs.writeFileSync(x.copy, padded()); fs.utimesSync(x.copy, s.atime, s.mtime);
        const c = await attempt(x.tool('browser.click').run({ ref: x.send }, { agentId: 'r6' }));
        A.ok(c.error && REFUSED.test(c.error.message) && x.d.st.clearedPaths.length === 1 && x.d.st.clearedPaths[0] === x.copy && x.d.st.cleared === 0,
          'R6: the CDP-style driver empties the input holding that exact copy (clearStagedInputs by path, no ref): ' + JSON.stringify(x.d.st.clearedPaths));
        await x.tb.releaseUploads();
        const y = await selected({ doc: true, navigates: true });
        await y.tool('browser.click').run({ ref: y.send }, { agentId: 'r6' });
        A.ok(sentBytes(y.d)[0] === OWN6 && !fs.existsSync(path.dirname(y.copy)), 'R6 (3): a submit that navigated the page away sent the original bytes, then its staged copy was dropped');
        const z = await selected({ doc: true });
        await z.tool('browser.click').run({ ref: z.send }, { agentId: 'r6' });
        A.ok(fs.existsSync(z.copy), 'R6 (3): a click that leaves the page in place keeps the copy (the page may still send it)');
        await z.tb.releaseUploads();
        A.ok(fs.existsSync(z.copy), 'P1: the reply end keeps a copy whose page is alive');
        await z.tb.session.close();
        A.ok(!fs.existsSync(path.dirname(z.copy)), 'P1: closing that browser drops the copy');
      }
      // (3) without a page identity (an injected driver): the next navigation drops the session's copies
      {
        const x = await selected();
        await x.tool('browser.back').run({}, { agentId: 'r6' });
        A.ok(!fs.existsSync(path.dirname(x.copy)), 'R6 (3): with no page identity, a navigation drops the session\'s staged copies');
        await x.tb.releaseUploads();
      }
      // pure observers never pay for a re-hash and are never refused (a snapshot cannot submit)
      {
        const x = await selected();
        fs.writeFileSync(x.copy, SECRET6);
        const r = await attempt(x.tool('browser.snapshot').run({}, { agentId: 'r6' }));
        A.ok(!r.error, 'R6: browser.snapshot is an observer and is not refused');
        const c = await attempt(x.tool('browser.click').run({ ref: x.send }, { agentId: 'r6' }));
        A.ok(c.error && REFUSED.test(c.error.message) && x.d.st.submits === 0, 'R6: ...but the click after it still is');
        await x.tb.releaseUploads();
      }

      /* ---- run-paths-polish P1: THE LIVE WALK W-R7 (b). One browser session for several replies, as the station browser
         is (index.js runOnceCore builds makeBrowserTools({ session }) per run and calls releaseUploads at its end). The
         agent selects a file and does NOT submit; the reply ends; the PERSON clicks Submit. On d5024f5a2 the copy was
         deleted at the reply end and the person's Submit read nothing (Chrome: ERR_FILE_NOT_FOUND). ---- */
      {
        fs.writeFileSync(path.join(root, 'r6', 'own.bin'), OWN6);
        fs.writeFileSync(secret6, SECRET6);
        const d = chromeLike({ doc: true, navigates: true });
        const shared = makeBrowserTools({ driver: d, fsp, pathMod: path, root, egress }).session;
        const reply = () => { const tb = makeBrowserTools({ session: shared, fsp, pathMod: path, root, egress }); return { tb, tool: n => tb.tools.find(t => t.name === n) }; };
        const [choose, send] = (await shared.snapshot()).map(n => n.ref);
        const one = reply();
        const receipt = await one.tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, { agentId: 'r6' });
        const copy = d.st.handed[0];
        await one.tb.releaseUploads();   // THE REPLY ENDS
        A.ok(fs.existsSync(copy), 'P1 W-R7 (b): the staged copy outlives the reply while its page lives (was: deleted at the reply end)');
        d.personSubmit();
        A.eq(sentBytes(d), [OWN6], 'P1 W-R7 (b): the person\'s later Submit sends the selected bytes (was: ERR_FILE_NOT_FOUND, nothing sent)');
        A.ok(/StarNet keeps that copy while this page stays open, at most 30 min, so the form can still be submitted after this reply/.test(receipt.content)
          && /When the page navigates away, its tab or the browser closes, another agent takes this browser, or 30 min pass, the copy is dropped and an input still holding it is emptied/.test(receipt.content)
          && /The input holds the requested file now\./.test(receipt.content) && !/still holds/.test(receipt.content),
          'P1: the receipt states the copy\'s real lifecycle: ' + receipt.content.slice(0, 420));
        // that Submit navigated: the page is gone, so the next reply's first gated action drops the copy (drop-on-submit-navigation)
        const two = reply();
        await two.tool('browser.press').run({ key: 'Tab' }, { agentId: 'r6' });
        A.ok(!fs.existsSync(path.dirname(copy)), 'P1: once the person\'s submit navigated the page away, its copy is dropped');

        // THE RE-PROOF HOLDS ACROSS REPLIES: selected in one reply, swapped after it ended, refused in the next
        d.st.sent.length = 0; d.st.submits = 0;
        const three = reply();
        await three.tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, { agentId: 'r6' });
        const copy3 = d.st.handed[0];
        await three.tb.releaseUploads();
        const s3 = fs.statSync(copy3);
        fs.writeFileSync(copy3, padded()); fs.utimesSync(copy3, s3.atime, s3.mtime);   // same size, mtime restored: only the bytes changed
        const four = reply();
        const c4 = await attempt(four.tool('browser.click').run({ ref: send }, { agentId: 'r6' }));
        A.ok(c4.error && REFUSED.test(c4.error.message) && d.st.submits === 0 && d.st.handed.length === 0 && !fs.existsSync(path.dirname(copy3)),
          'P1: a copy swapped after its reply ended is re-proved by the NEXT reply\'s action: refused, input emptied, dropped, nothing sent (' + (c4.error ? c4.error.message.slice(0, 80) : 'CLICKED') + ')');
        A.eq(c4.error && c4.error.hostAuthored, true, 'P2: that refusal is the host\'s own (its tool line shows the reason)');

        // THE DOCUMENT GOES: an agent navigation (browser.back) drops the copy after that action
        const five = reply();
        await five.tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, { agentId: 'r6' });
        const copy5 = d.st.handed[0];
        await five.tool('browser.back').run({}, { agentId: 'r6' });
        A.ok(!fs.existsSync(path.dirname(copy5)), 'P1 document gone: navigating away drops the copy after that action');
        // ...the tab closes while nobody acts: the registry's sweep drops it, no agent action needed
        d.st.loader = 'L-tab';
        const [chooseNow] = (await shared.snapshot()).map(n => n.ref);   // the page moved on: a fresh snapshot
        await five.tool('browser.upload').run({ ref: chooseNow, paths: ['own.bin'] }, { agentId: 'r6' });
        const copy6 = d.st.handed[0];
        await five.tb.releaseUploads();
        A.ok(fs.existsSync(copy6), 'P1: (control) kept past the reply end while its tab is open');
        d.st.alive = 'closed';
        await shared.uploadStage.sweep();
        A.ok(!fs.existsSync(path.dirname(copy6)), 'P1 document gone: a closed tab\'s copy is dropped by the sweep');
        // ...unknown liveness (a busy page) is never "gone" at the reply end, and never forever: the browser close drops it
        d.st.alive = 'yes';
        await five.tool('browser.upload').run({ ref: chooseNow, paths: ['own.bin'] }, { agentId: 'r6' });
        const copy7 = d.st.handed[0];
        d.st.alive = 'unknown';
        await five.tb.releaseUploads();
        await shared.uploadStage.sweep();
        A.ok(fs.existsSync(copy7), 'P1: a page whose liveness cannot be read is not "gone": the reply end and the sweep keep its copy');
        // ANOTHER AGENT takes the browser (browser-view.js take -> handTo): the earlier agent's copy goes, its input emptied
        d.st.alive = 'yes';
        d.st.clearedPaths.length = 0;
        await shared.handTo({ agentId: 'someone-else' });
        A.ok(!fs.existsSync(path.dirname(copy7)) && d.st.clearedPaths.includes(copy7) && d.st.handed.length === 0, 'P1: another agent taking the browser drops the earlier agent\'s copy and empties its input');
        // the browser closes: every copy goes
        const [chooseAgain] = (await shared.snapshot()).map(n => n.ref);   // a change of hands kills refs (handTo)
        await five.tool('browser.upload').run({ ref: chooseAgain, paths: ['own.bin'] }, { agentId: 'r6' });
        const copy8 = d.st.handed[0];
        await shared.close();
        A.ok(!fs.existsSync(path.dirname(copy8)), 'P1: the browser closing drops its copies');
      }

      /* ---- review round 1 (scratchpad rev1/rev1-repro.js R-B): A LATER SUBMIT IS PROMISED ONLY BY A BROWSER THAT
         OUTLIVES THE RUN. A run's OWN browser (no deps.session: cron, night shift, channels, the API, any run without the
         station) closes at the run end (index.js runOnceCore: session.close -> upload-stage.js dropAll), and so does the
         PRIVATE browser a COMMS run gets while another run drives the station (browser-view.js releaseRun -> close).
         Both receipts said "the form can still be submitted after this reply (by you later, or by the person)" while
         the copy died with the browser at the reply end. The station view is the real one here. ---- */
      {
        const LATER = /submitted after this reply|by you later, or by the person/;
        const OWN_LIFE = /This run browses in its own browser, which closes when this reply ends: StarNet keeps that copy until then \(at most 30 min\) and re-checks it before each later browser action, so submit the form in this reply; after it, that page and its file are gone\./;
        const settle = async p => { for (let i = 0; i < 100 && fs.existsSync(path.dirname(p)); i++) await new Promise(r => setTimeout(r, 10)); };
        // a run's OWN browser, its driver naming the page (the CDP driver does)
        const x = await selected({ doc: true });
        A.ok(!LATER.test(x.receipt.content) && OWN_LIFE.test(x.receipt.content),
          'rev1: a run\'s own browser never promises a submit after the reply: ' + x.receipt.content.slice(0, 380));
        await x.tb.session.close(); await x.tb.releaseUploads();   // THE RUN ENDS (index.js runOnceCore: its own browser closes)
        A.ok(!fs.existsSync(path.dirname(x.copy)), 'rev1: ...and its copy is gone at the run end, as that receipt said');

        // THE STATION VIEW: agent A drives the station browser; agent B's COMMS run, started meanwhile, browses privately
        fs.mkdirSync(path.join(root, 'r6b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'r6b', 'own.bin'), OWN6);
        const dS = chromeLike({ doc: true }), dP = chromeLike({ doc: true });
        const stationSession = makeBrowserTools({ driver: dS, fsp, pathMod: path, root, egress }).session;
        const privateSession = makeBrowserTools({ driver: dP, fsp, pathMod: path, root, egress }).session;
        const views = makeBrowserViews({ now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, makeStationSession: () => stationSession });
        const runOf = (agentId, runId) => {
          const view = views.sessionForRun({ agentId, runId, interactive: true, makePrivate: () => privateSession });
          const tb = makeBrowserTools({ session: view, fsp, pathMod: path, root, egress });   // as index.js runOnceCore builds it
          return { view, tb, tool: n => tb.tools.find(t => t.name === n), ctx: { agentId } };
        };
        const a = runOf('r6', 'run-a');
        const [chooseA] = (await a.view.snapshot()).map(n => n.ref);   // A takes the wheel
        const receiptA = await a.tool('browser.upload').run({ ref: chooseA, paths: ['own.bin'] }, a.ctx);
        const copyA = dS.st.handed[0];
        const b = runOf('r6b', 'run-b');
        const [chooseB] = (await b.view.snapshot()).map(n => n.ref);   // the station browser is A's: B goes private
        const receiptB = await b.tool('browser.upload').run({ ref: chooseB, paths: ['own.bin'] }, b.ctx);
        const copyB = dP.st.handed[0];
        A.ok(a.view.outlivesRun === true && b.view.outlivesRun === false && views.list().station.driver.runId === 'run-a',
          'rev1: the station view says whether this run\'s browser outlives the run, and asking never takes the wheel (A: ' + a.view.outlivesRun + ', B: ' + b.view.outlivesRun + ')');
        A.ok(LATER.test(receiptA.content) && /another agent takes this browser/.test(receiptA.content),
          'rev1: the station browser outlives the run: its receipt keeps the later-submit promise and names every drop: ' + receiptA.content.slice(0, 440));
        A.ok(!LATER.test(receiptB.content) && OWN_LIFE.test(receiptB.content),
          'rev1: the private fallback (the station busy) never promises a submit after the reply: ' + receiptB.content.slice(0, 380));
        // THE RUNS END, in index.js runOnceCore order: the view is released, then the run-end release
        views.releaseRun('run-b'); await settle(copyB); await b.tb.releaseUploads();
        views.releaseRun('run-a'); await a.tb.releaseUploads();
        A.ok(!fs.existsSync(path.dirname(copyB)), 'rev1: B\'s private browser closed with its run, and its copy with it, as its receipt said');
        A.ok(fs.existsSync(copyA), 'rev1: A\'s copy outlives the run in the station browser, as its receipt said');
        dS.personSubmit();
        A.eq(sentBytes(dS), [OWN6], 'rev1: the person\'s later Submit in the station browser sends A\'s selected bytes');
        await views.close();
        A.ok(!fs.existsSync(path.dirname(copyA)), 'rev1: closing the station browser drops its copy');
        A.eq(fs.existsSync(path.join(stagingRoot, 'r6b')) ? fs.readdirSync(path.join(stagingRoot, 'r6b')) : [], [], 'rev1: no staged copy of B is left behind');
      }

      /* ---- review round 2, minor R-A: WHAT IS SAID ABOUT A STAGED COPY IS ITS OWN AGENT'S. The station view is the real
         one (index.js wiring), its registry the station browser's; the TTL is injected and fires when the test says. ---- */
      {
        const timers = [];
        const fakeSet = (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; };
        const fakeClear = t => { if (t) t.done = true; };
        const KEEP = 60000;
        const expire = () => ttlDone(stationSession, () => { for (const t of timers.slice()) if (!t.done && t.ms === KEEP) { t.done = true; t.fn(); } });
        fs.writeFileSync(path.join(root, 'r6', 'own.bin'), OWN6);
        const dS = chromeLike({ doc: true });
        const stationSession = makeBrowserTools({ driver: dS, fsp, pathMod: path, root, egress, uploadKeepMs: KEEP, uploadSetTimeout: fakeSet, uploadClearTimeout: fakeClear }).session;
        const views = makeBrowserViews({ now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, makeStationSession: () => stationSession });
        const runOf = (agentId, runId) => {
          const view = views.sessionForRun({ agentId, runId, interactive: true, makePrivate: () => { throw new Error('this walk never browses privately'); } });
          const tb = makeBrowserTools({ session: view, fsp, pathMod: path, root, egress });
          const end = async () => { views.releaseRun(runId); await tb.releaseUploads(); };   // index.js runOnceCore order
          return { view, tb, tool: n => tb.tools.find(t => t.name === n), ctx: { agentId }, end };
        };
        const selectIn = async r => { const [choose] = (await r.view.snapshot()).map(n => n.ref); await r.tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, r.ctx); return dS.st.handed[0]; };
        const SAID = /\[StarNet, staged uploads\]/;
        // agent A selects in the station and A's run ends: the copy is kept; its TTL runs out while nobody acts
        const a1 = runOf('r6', 'ra-1');
        const copy1 = await selectIn(a1);
        await a1.end();
        await expire();
        A.ok(!fs.existsSync(path.dirname(copy1)) && dS.st.handed.length === 0, 'R-A: (control) A\'s kept copy expired after A\'s run: dropped, its input emptied');
        // A's NEXT run takes the station: the note is A's, and is said to A
        const a2 = runOf('r6', 'ra-2');
        const outA = await a2.tool('browser.press').run({ key: 'Tab' }, a2.ctx);
        A.ok(SAID.test(outA.content) && /"own\.bin" was kept 1 min \(the limit\) and dropped/.test(outA.content), 'R-A: (control) the TTL note is said on the same agent\'s next action: ' + outA.content);
        // ...again, and this time ANOTHER agent takes the station first: B's first action says nothing of A's file
        const copy2 = await selectIn(a2);
        await a2.end();
        await expire();
        const b1 = runOf('r6b', 'rb-1');
        const outB = await b1.tool('browser.press').run({ key: 'Tab' }, b1.ctx);
        A.ok(!/own\.bin/.test(outB.content) && !SAID.test(outB.content), 'R-A: agent B\'s first action in the station is never told agent A\'s file name (was: A\'s TTL note, appended): ' + JSON.stringify(outB.content));
        await b1.end();
        // A drives the station and its copy changes on disk; B's run starts meanwhile and its first tool is a test_ tool
        // (no profile wait, so its gate runs on the station registry): refused, never naming A's file; A is told
        const a3 = runOf('r6', 'ra-3');
        const copy3 = await selectIn(a3);
        const s3 = fs.statSync(copy3);
        fs.writeFileSync(copy3, 'C'.repeat(OWN6.length)); fs.utimesSync(copy3, s3.atime, s3.mtime);
        const b2 = runOf('r6b', 'rb-2');
        const sentBefore = dS.st.sent.length;
        const x1 = await attempt(b2.tool('browser.test_navigate').run({ url: 'http://127.0.0.1:1/' }, b2.ctx));
        A.ok(x1.error && /another agent had selected in this browser changed on disk/.test(x1.error.message) && !/own\.bin/.test(x1.error.message) && x1.error.hostAuthored === true,
          'R-A: B\'s action refused for A\'s changed copy never names A\'s file (was: it named own.bin): ' + (x1.error ? x1.error.message : 'RAN'));
        A.ok(!fs.existsSync(path.dirname(copy3)) && dS.st.handed.length === 0 && dS.st.sent.length === sentBefore, 'R-A: ...A\'s changed copy is dropped and its input emptied all the same, nothing sent');
        const outA3 = await a3.tool('browser.press').run({ key: 'Tab' }, a3.ctx);
        A.ok(/"own\.bin" changed on disk \(the staged upload's bytes changed\) and was dropped, so it was not sent; its file input was emptied/.test(outA3.content),
          'R-A: ...and A is told, on A\'s own next action (was: never): ' + outA3.content);
        await b2.end(); await a3.end();
        await views.close();
        A.ok([copy1, copy2, copy3].every(c => !fs.existsSync(path.dirname(c))), 'R-A: no staged copy of this walk is left behind');
      }

      /* ---- polish review round 1, minor 2 (rev1/rev1-crossover.js, rev2/rev2-walk.js X2): A RUN'S END RELEASES ITS OWN
         COPIES ONLY. Agent A drives the station browser and selects a file whose page its driver cannot name (a copy
         that lives "only until this reply ends"). Agent B's run starts meanwhile; its first tool is a test_ tool, which
         skips the profile wait, so its gate binds the STATION's registry before any take (B then browses privately).
         B's run ends before A submits. B's end used to release every copy in the station's registry: A's copy was
         dropped and its input emptied mid-reply, and A's own Submit sent nothing. The station view is the real one. ---- */
      {
        fs.writeFileSync(path.join(root, 'r6', 'own.bin'), OWN6);
        const dS = chromeLike({}), dP = chromeLike({});   // drivers that cannot name the page
        const stationSession = makeBrowserTools({ driver: dS, fsp, pathMod: path, root, egress }).session;
        const privateSession = makeBrowserTools({ driver: dP, fsp, pathMod: path, root, egress }).session;
        const views = makeBrowserViews({ now: () => 0, setTimeout: () => 0, clearTimeout: () => {}, makeStationSession: () => stationSession });
        const runOf = (agentId, runId) => {
          const view = views.sessionForRun({ agentId, runId, interactive: true, makePrivate: () => privateSession });
          const tb = makeBrowserTools({ session: view, fsp, pathMod: path, root, egress });   // as index.js runOnceCore builds it
          const end = async () => { views.releaseRun(runId); await tb.releaseUploads(); };   // index.js runOnceCore order
          return { view, tb, tool: n => tb.tools.find(t => t.name === n), ctx: { agentId }, end };
        };
        const a = runOf('r6', 'm2-a');
        const [choose, send] = (await a.view.snapshot()).map(n => n.ref);   // A takes the wheel
        const receipt = await a.tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, a.ctx);
        const copyA = dS.st.handed[0];
        A.ok(/only until this reply ends/.test(receipt.content) && fs.existsSync(copyA), 'minor 2: (control) a copy with no page identity lives until its own reply ends: ' + receipt.content.slice(0, 160));
        const b = runOf('r6b', 'm2-b');
        await attempt(b.tool('browser.test_navigate').run({ url: 'http://127.0.0.1:1/' }, b.ctx));   // B's first browser tool
        await b.end();
        A.ok(fs.existsSync(copyA) && dS.st.handed[0] === copyA && dS.st.cleared === 0,
          'minor 2: ANOTHER run ending leaves A\'s copy and its input alone (was: dropped and emptied mid-reply): ' + JSON.stringify({ onDisk: fs.existsSync(copyA), handed: dS.st.handed.length, cleared: dS.st.cleared }));
        await a.tool('browser.click').run({ ref: send }, a.ctx);
        A.eq(sentBytes(dS), [OWN6], 'minor 2: ...so A\'s own Submit in this reply sends the selected bytes (was: nothing)');
        await a.end();
        A.ok(!fs.existsSync(path.dirname(copyA)), 'minor 2: (control) A\'s OWN reply end still drops its no-page copy, as its receipt said');
        await views.close();
      }

      /* ---- Codex A3-CAP-01: THE BOUND IS STRICT. "At most 32 staged copies and 1 GB at once" was false for one
         selection: the incoming batch was exempt from the eviction, and browser.upload had no limit on its paths, so one
         call could stage 33 files, or 6 x 200 MB, past the bound. A selection over it is now refused whole, before a byte
         is staged when the count says so, else as soon as the staged bytes pass it, and leaves no copy behind. ---- */
      {
        const staged = () => (fs.existsSync(path.join(stagingRoot, 'r6')) ? fs.readdirSync(path.join(stagingRoot, 'r6')) : []);
        for (let i = 0; i <= 32; i++) fs.writeFileSync(path.join(root, 'r6', 'n' + i + '.txt'), 'N' + i);
        const names = n => Array.from({ length: n }, (_, i) => 'n' + i + '.txt');
        const before = staged().length;
        const dC = chromeLike({ doc: true });
        const tc = makeBrowserTools({ driver: dC, fsp, pathMod: path, root, egress });
        const [chooseC] = (await tc.session.snapshot()).map(n => n.ref);
        const over = await attempt(tc.tools.find(t => t.name === 'browser.upload').run({ ref: chooseC, paths: names(33) }, { agentId: 'r6' }));
        A.ok(over.error && over.error.hostAuthored === true && /at most 32 files and 1024 MB at once/.test(over.error.message) && /this selection is 33 files, so nothing was selected or uploaded/.test(over.error.message),
          'A3-CAP-01: 33 files in one selection are refused whole (was: all staged, past the 32-copy bound): ' + (over.error ? over.error.message : 'RAN'));
        A.ok(dC.st.handed.length === 0 && staged().length === before && tc.session.uploadStage.size === 0, 'A3-CAP-01: ...before anything was staged, registered or handed to the page');
        const dB = chromeLike({ doc: true });
        const tbB = makeBrowserTools({ driver: dB, fsp, pathMod: path, root, egress, uploadMaxLiveBytes: 2 * 1048576 });
        fs.writeFileSync(path.join(root, 'r6', 'big1.bin'), Buffer.alloc(1048576, 1));
        fs.writeFileSync(path.join(root, 'r6', 'big2.bin'), Buffer.alloc(1048576, 2));
        fs.writeFileSync(path.join(root, 'r6', 'big3.bin'), Buffer.alloc(1048576, 3));
        const [chooseB] = (await tbB.session.snapshot()).map(n => n.ref);
        const heavy = await attempt(tbB.tools.find(t => t.name === 'browser.upload').run({ ref: chooseB, paths: ['big1.bin', 'big2.bin', 'big3.bin'] }, { agentId: 'r6' }));
        A.ok(heavy.error && /at most 32 files and 2 MB at once/.test(heavy.error.message) && /this selection is over 2 MB/.test(heavy.error.message),
          'A3-CAP-01: a selection over the byte bound is refused whole too: ' + (heavy.error ? heavy.error.message : 'RAN'));
        A.ok(dB.st.handed.length === 0 && staged().length === before && tbB.session.uploadStage.size === 0, 'A3-CAP-01: ...and the copies it had staged are gone again');
        const fits = await attempt(tbB.tools.find(t => t.name === 'browser.upload').run({ ref: chooseB, paths: ['big1.bin', 'big2.bin'] }, { agentId: 'r6' }));
        A.ok(fits.out && dB.st.handed.length === 2 && tbB.session.uploadStage.size === 2, 'A3-CAP-01: (control) a selection within the bound is selected as before');
        await tbB.session.close(); await tc.session.close();
        A.eq(staged().length, before, 'A3-CAP-01: no staged copy of these selections is left behind');
      }

      /* ---- P1: THE TTL and THE CLEARED INPUT. A copy kept as long as it may be is dropped, the input still holding it is
         emptied by the File's own path (so the page never shows a file it cannot send), and it is said on the next agent
         action. Timers are injected: the TTL fires when the test says. ---- */
      {
        const timers = [];
        const fakeSet = (fn, ms) => { const t = { fn, ms, done: false }; timers.push(t); return t; };
        const fakeClear = t => { if (t) t.done = true; };
        const fire = ms => { for (const t of timers.slice()) if (!t.done && t.ms === ms) { t.done = true; t.fn(); } };
        const KEEP = 60000;
        const x = await selected({ doc: true, deps: { uploadKeepMs: KEEP, uploadSetTimeout: fakeSet, uploadClearTimeout: fakeClear } });
        A.ok(/at most 1 min/.test(x.receipt.content), 'P1 TTL: the receipt names the TTL the registry runs (' + KEEP + ' ms)');
        await x.tb.releaseUploads();
        A.ok(fs.existsSync(x.copy), 'P1 TTL: (control) kept past the reply end');
        await ttlDone(x.tb.session, () => fire(KEEP));
        A.ok(!fs.existsSync(path.dirname(x.copy)), 'P1 TTL: the copy is dropped when its TTL runs out');
        A.ok(x.d.st.clearedPaths.includes(x.copy) && x.d.st.handed.length === 0, 'P1 cleared input: the input still holding it is emptied (by the File\'s own path)');
        x.d.personSubmit();
        A.eq(sentBytes(x.d), [], 'P1 cleared input: a later Submit sends nothing, and the page showed no file it could not send');
        const next = await x.tool('browser.press').run({ key: 'Tab' }, { agentId: 'r6' });
        A.ok(/\[StarNet, staged uploads\] The staged upload copy of "own\.bin" was kept 1 min \(the limit\) and dropped, and the file input holding it was emptied/.test(next.content),
          'P1 TTL: it is said on the next agent browser action: ' + next.content);
        // the sweep's quick identity check: a copy swapped for a hard link while nobody acts is dropped before the person submits
        const y = await selected({ doc: true, deps: { uploadKeepMs: KEEP, uploadSetTimeout: fakeSet, uploadClearTimeout: fakeClear } });
        let linked = false;
        try { const s = fs.statSync(y.copy); fs.writeFileSync(secret6, padded()); fs.utimesSync(secret6, s.atime, s.mtime); fs.unlinkSync(y.copy); fs.linkSync(secret6, y.copy); linked = true; } catch (e) { console.log('[skip] hard link: ' + e.message); }
        if (linked) {
          await y.tb.session.uploadStage.sweep();
          A.ok(!fs.existsSync(path.dirname(y.copy)) && y.d.st.handed.length === 0 && fs.statSync(secret6).nlink === 1, 'P1 sweep: a copy swapped for a hard link while nobody acts is dropped and its input emptied; the secret keeps one name');
          y.d.personSubmit();
          A.eq(sentBytes(y.d), [], 'P1 sweep: the person\'s later Submit sends nothing');
        }
        await y.tb.session.close();
        await x.tb.session.close();
        // NO PAGE IDENTITY: the reply end empties the input (here by ref: this injected driver has no identity clear) and drops it
        const z = await selected();
        await z.tb.releaseUploads();
        A.ok(!fs.existsSync(path.dirname(z.copy)) && z.d.st.cleared === 1 && z.d.st.handed.length === 0, 'P1 cleared input: with no page identity the reply end empties its input, then drops the copy');
      }

      /* ---- round-7 minors on the hand-off itself ---- */
      {
        // m1: a hand-off that fails BEFORE the input took the files keeps no copy and touches no input
        const a1 = await selected({ doc: true });
        await a1.tb.session.close();
        a1.d.st.failUpload = 'before';
        a1.d.st.clearedPaths.length = 0; a1.d.st.cleared = 0;
        const r1 = await attempt(a1.tool('browser.upload').run({ ref: a1.choose, paths: ['own.bin'] }, { agentId: 'r6' }));
        A.ok(r1.error && /no associated file input/.test(r1.error.message) && a1.tb.session.uploadStage.size === 0 && a1.d.st.clearedPaths.length === 0 && a1.d.st.cleared === 0,
          'm1: a hand-off that failed before anything was selected keeps no copy and empties no input (' + (r1.error && r1.error.message) + ')');
        // m1: one that fails AFTER (e.handed) empties the inputs holding the copy by its path, then drops it
        a1.d.st.failUpload = 'after';
        const r2 = await attempt(a1.tool('browser.upload').run({ ref: a1.choose, paths: ['own.bin'] }, { agentId: 'r6' }));
        A.ok(r2.error && a1.tb.session.uploadStage.size === 0 && a1.d.st.clearedPaths.length === 1 && a1.d.st.handed.length === 0 && a1.d.st.cleared === 0,
          'm1: a hand-off that failed after the input took the files empties that input by the File\'s path and keeps no copy: ' + JSON.stringify(a1.d.st.clearedPaths));
        A.ok(!fs.existsSync(path.dirname(a1.d.st.clearedPaths[0])), 'm1: ...and its folder is gone');
        // m1: a selection the readback cannot prove keeps no copy either
        a1.d.st.failUpload = 'receipt';
        const r3 = await attempt(a1.tool('browser.upload').run({ ref: a1.choose, paths: ['own.bin'] }, { agentId: 'r6' }));
        A.ok(r3.error && /verified file-selection evidence/.test(r3.error.message) && a1.tb.session.uploadStage.size === 0 && a1.d.st.handed.length === 0,
          'm1: an unproven selection keeps no copy and its input is emptied');
        await a1.tb.session.close();

        // m2: a copy changed BEFORE the hand-off: nothing was handed, so no input is touched (it used to empty "the input
        // at the ref", destroying an earlier valid selection)
        const swapEgress = Object.assign({}, egress, { readFor: async (...args) => {
          const g = await egress.readFor(...args);
          if (g && g.ok && g.staged) fs.writeFileSync(g.abs, 'CHANGED-' + 'B'.repeat(192));
          return g;
        } });
        const d2 = chromeLike({ doc: true });
        d2.st.handed = ['earlier-valid-selection'];
        const tb2 = makeBrowserTools({ driver: d2, fsp, pathMod: path, root, egress: swapEgress });
        const [ch2] = (await tb2.session.snapshot()).map(n => n.ref);
        const r4 = await attempt(tb2.tools.find(t => t.name === 'browser.upload').run({ ref: ch2, paths: ['own.bin'] }, { agentId: 'r6' }));
        A.ok(r4.error && /changed before it was selected/.test(r4.error.message) && /nothing was selected or uploaded/.test(r4.error.message) && r4.error.hostAuthored === true,
          'm2: a change before the hand-off is refused, nothing selected: ' + (r4.error && r4.error.message));
        A.ok(d2.st.cleared === 0 && d2.st.clearedPaths.length === 0 && d2.st.handed[0] === 'earlier-valid-selection' && tb2.session.uploadStage.size === 0,
          'm2: ...and no input was touched (the earlier selection stands) and no copy is kept');
        // m2: a change AFTER the hand-off empties the input holding the copy by the File's own path, never by ref
        const d3 = chromeLike({ doc: true, onHand: async abs => { fs.writeFileSync(abs[0], padded()); } });
        const tb3 = makeBrowserTools({ driver: d3, fsp, pathMod: path, root, egress });
        const [ch3] = (await tb3.session.snapshot()).map(n => n.ref);
        const r5 = await attempt(tb3.tools.find(t => t.name === 'browser.upload').run({ ref: ch3, paths: ['own.bin'] }, { agentId: 'r6' }));
        A.ok(r5.error && /changed after it was selected/.test(r5.error.message) && /the selection was cancelled \(its file input was emptied\)/.test(r5.error.message),
          'm2: a change after the hand-off is refused and says the input was emptied: ' + (r5.error && r5.error.message));
        A.ok(d3.st.cleared === 0 && d3.st.clearedPaths.length === 1 && d3.st.handed.length === 0 && tb3.session.uploadStage.size === 0,
          'm2: ...emptied by the File\'s own path (clearStagedInputs), never by the ref\'s coordinates: ' + JSON.stringify({ byRef: d3.st.cleared, byPath: d3.st.clearedPaths.length }));

        // m3: a multi-file input is emptied whole: the refusal names the OTHER file it held, and that copy goes too
        fs.writeFileSync(path.join(root, 'r6', 'two.bin'), 'B'.repeat(50));
        const d4 = chromeLike({ doc: true });
        const tb4 = makeBrowserTools({ driver: d4, fsp, pathMod: path, root, egress });
        const [ch4, send4] = (await tb4.session.snapshot()).map(n => n.ref);
        await tb4.tools.find(t => t.name === 'browser.upload').run({ ref: ch4, paths: ['own.bin', 'two.bin'] }, { agentId: 'r6' });
        const [own4, two4] = d4.st.handed;
        fs.writeFileSync(own4, SECRET6);
        const r6 = await attempt(tb4.tools.find(t => t.name === 'browser.click').run({ ref: send4 }, { agentId: 'r6' }));
        A.ok(r6.error && REFUSED.test(r6.error.message) && /"own\.bin"/.test(r6.error.message) && /Its file input was emptied, so select "two\.bin" again too\./.test(r6.error.message),
          'm3: the multi-file clear names every file the emptied input held: ' + (r6.error && r6.error.message));
        A.ok(!fs.existsSync(path.dirname(own4)) && !fs.existsSync(path.dirname(two4)) && tb4.session.uploadStage.size === 0 && d4.st.submits === 0, 'm3: ...and both copies are dropped, nothing sent');
        await tb4.session.close();
      }
      A.eq(fs.existsSync(path.join(stagingRoot, 'r6')) ? fs.readdirSync(path.join(stagingRoot, 'r6')) : [], [], 'R6: no staged copy is left behind');
    }

    /* ---- W-R7 (0.14.2 live walk, real Chrome): the agent selected a file, the reply ended, the person submitted the form
       themselves: Chrome showed "Your file couldn't be accessed · ERR_FILE_NOT_FOUND" while the input still displayed the
       file, because the receipt had told the model, with no time bound, "The input still holds the requested files."
       0.14.2 fixed the words for the one lifetime it had: the copy went at every reply end, so the receipt told the agent
       to have the person re-attach the file. run-paths-polish then fixed the lifetime (the P1 and rev1 blocks above), and
       the v0.14.2 merge-back keeps that receipt (docs/releases/0.14.2/CUT_RECORD.md section 12). It has no re-attach line
       because no lifetime needs one: while the page lives the person's Submit sends the file, a run's own browser closes
       with the run, and with no page identity the input is emptied with the copy. What W-R7 asked of the words holds on
       each of the three: the input holds the files only NOW, the receipt says how long the copy lives and what that leaves
       to do, one file reads as one file, a cleared selection is never claimed held, and "retained" is still the
       readback. ---- */
    {
      fs.mkdirSync(path.join(root, 'r7'), { recursive: true });
      fs.writeFileSync(path.join(root, 'r7', 'cv.pdf'), 'CV');
      fs.writeFileSync(path.join(root, 'r7', 'cover.pdf'), 'COVER');
      const prose = c => c.replace(/\[BEGIN EXTERNAL WEB CONTENT[\s\S]*?\[END EXTERNAL WEB CONTENT\]/g, '');
      // every sentence that says the input holds/keeps/retains the files. The cleared variant's "no longer retains" is not
      // one, and neither is "StarNet keeps that copy": that is the copy's lifetime, pinned word for word below
      const holds = c => prose(c).split(/(?<=\.)\s+/).filter(s => /\binput\b/i.test(s) && /\b(holds|keeps|retains|still has)\b/i.test(s.replace(/\bStarNet keeps\b/g, '')) && !/\b(no longer|cleared)\b/i.test(s));
      const stagedNow = () => (fs.existsSync(path.join(stagingRoot, 'r7')) ? fs.readdirSync(path.join(stagingRoot, 'r7')) : []);
      const LIFETIMES = [
        { label: 'no page identity', namesPage: false, outlivesRun: false,
          life: /This browser cannot name the page, so StarNet keeps that copy only until this reply ends \(an input still holding it is then emptied\) and re-checks it before each later browser action: submit the form in this reply, or select the file again later\. / },
        { label: 'a run\'s own browser', namesPage: true, outlivesRun: false,
          life: /This run browses in its own browser, which closes when this reply ends: StarNet keeps that copy until then \(at most 30 min\) and re-checks it before each later browser action, so submit the form in this reply; after it, that page and its file are gone\. If the page navigates away or its tab closes first, the copy is dropped and an input still holding it is emptied\. / },
        { label: 'a browser that outlives the run', namesPage: true, outlivesRun: true,
          life: /StarNet keeps that copy while this page stays open, at most 30 min, so the form can still be submitted after this reply \(by you later, or by the person\), and re-checks it before each later browser action\. When the page navigates away, its tab or the browser closes, another agent takes this browser, or 30 min pass, the copy is dropped and an input still holding it is emptied\. / }
      ];
      for (const { label, namesPage, outlivesRun, life } of LIFETIMES) {
        let keep = true;
        const d7 = {
          snapshot: async () => [{ role: 'button', text: 'Choose file', x: 1, y: 1, w: 10, h: 10 }],
          upload: async (_n, _abs, expected) => Object.assign({ status: 'selected', files: expected, retained: keep, events: ['input', 'change'], evidence: keep ? 'FileList readback' : 'file-selection event' }, namesPage ? { doc: { sid: null, loader: 'L1' } } : {})
        };
        if (namesPage) { d7.uploadDocAlive = async () => true; d7.clearStagedInputs = async () => ({ cleared: 0, paths: [] }); }
        const own = makeBrowserTools({ driver: d7, fsp, pathMod: path, root, egress });
        const t7 = outlivesRun ? makeBrowserTools({ session: own.session, fsp, pathMod: path, root, egress }) : own;   // a reply's tools over a kept browser, as index.js runOnceCore builds them
        const ref7 = (await own.session.snapshot())[0].ref;
        const up7 = paths => t7.tools.find(t => t.name === 'browser.upload').run({ ref: ref7, paths }, { agentId: 'r7' });
        const bounded = (c, which) => {
          const p = prose(c);
          A.ok(!/still holds/i.test(p), which + ': never the unbounded "still holds" claim: ' + p);
          A.ok(life.test(p), which + ': the receipt says how long the copy lives and what that leaves to do: ' + p);
          A.ok(/submitted after this reply|by you later, or by the person/.test(p) === outlivesRun, which + ': a submit after this reply is promised only by a browser that outlives the run: ' + p);
          A.ok(holds(c).every(s => /\bnow\b/.test(s)) && (!holds(c).length || life.test(p)), which + ': every "the input holds" claim is bounded to now, beside that lifetime: ' + JSON.stringify(holds(c)));
          A.ok(/Remote upload\/server acceptance is not verified\. Inspect the page's thumbnail\/status or network response before reporting upload success\. Submit the form only when the task requires it\.$/.test(c)
            && /\[BEGIN EXTERNAL WEB CONTENT — file input readback from the controlled browser\./.test(c), which + ': the fenced readback and the remote-acceptance line are kept');
        };
        const one = await up7(['cv.pdf']);
        bounded(one.content, 'W-R7, ' + label + ', retained, one file');
        A.ok(prose(one.content).includes('The input holds the requested file now. ') && /"retained":true/.test(one.content), 'W-R7, ' + label + ': a retained selection says the input holds the file NOW, and the readback still says retained: ' + prose(one.content));
        A.eq(holds(one.content), ['The input holds the requested file now.'], 'W-R7, ' + label + ': that NOW sentence is the only claim that the input holds the file');
        const two = await up7(['cv.pdf', 'cover.pdf']);
        bounded(two.content, 'W-R7, ' + label + ', retained, two files');
        A.ok(prose(two.content).includes('The input holds the requested files now. '), 'W-R7, ' + label + ': two files read as plural: ' + prose(two.content));
        keep = false;
        const gone = await up7(['cv.pdf']);
        bounded(gone.content, 'W-R7, ' + label + ', not retained');
        A.ok(prose(gone.content).includes('The input was cleared, replaced, or no longer retains the selection after a file-selection event. ') && !holds(gone.content).length && /"retained":false/.test(gone.content),
          'W-R7, ' + label + ': a cleared selection is disclosed and never claimed held: ' + prose(gone.content));
        // what each receipt said of the reply's end
        if (namesPage && !outlivesRun) await own.session.close();   // a run's own browser closes at the run end (index.js runOnceCore)
        await t7.releaseUploads();   // THE REPLY ENDS
        A.eq(stagedNow().length > 0, outlivesRun, 'W-R7, ' + label + ': past the reply end only a browser that outlives the run keeps the copies');
        await own.session.close();
        A.eq(stagedNow(), [], 'W-R7, ' + label + ': no copy outlives its browser');
      }
    }

    replyMode = 'ack';
    await rejects(run(['photo.txt']), /verified file-selection evidence/i, 'legacy acknowledgement never becomes an upload-success claim');

    // A protocol acknowledgement without FileList or a witnessed selection must fail; tab loss must propagate.
    const trace = [];
    const cdp = { send: async (method, args) => {
      trace.push(method);
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input' } };
      if (method === 'Runtime.callFunctionOn' && args.objectId === 'input') return { result: { objectId: 'observer' } };
      if (method === 'Runtime.callFunctionOn' && args.returnByValue) return { result: { value: { connected: true, files: [], events: [], input: {} } } };
      return {};
    } };
    await rejects(selectFiles({ cdp, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.txt'], expected: [{ name: 'photo.txt', size: 7 }], settle: async () => {} }), /did not confirm/i, 'empty readback after CDP ack fails honestly');
    A.ok(trace.includes('DOM.setFileInputFiles') && trace.includes('Runtime.releaseObject'), 'selection was attempted and remote handles were released');

    // #104 second report: a file its input's accept list excludes is refused; only what can be proven (real-page proof: browser-upload-chooser.e2e)
    {
      const { acceptRefusal } = require('../sidecar/tools/builtin/browser-upload.js')._internals;
      A.ok(/accepts video\/\*, not photo\.png/.test(acceptRefusal('video/*', ['photo.png'])), 'a photo into a video-only input is refused');
      A.ok(/accepts \.pdf, not photo\.png/.test(acceptRefusal('.pdf', ['photo.png'])), 'an extension list excludes it too');
      for (const accept of ['', 'image/*', 'image/png,image/jpeg', '.png', '.PNG', '*/*']) A.eq(acceptRefusal(accept, ['photo.png']), '', 'accept ' + JSON.stringify(accept) + ' takes a PNG');
      A.eq(acceptRefusal('video/*', ['notes.xyz']), '', 'an extension nothing here knows is not refused on a guess');
      // and selectFiles enforces it: the input's own accept list is read before anything is handed over
      {
        const sent = [];
        const videoOnly = { send: async (method, args) => {
          sent.push(method);
          if (method === 'Runtime.evaluate') return { result: { type: 'object', objectId: 'clip' } };
          if (method === 'Runtime.callFunctionOn' && args.returnByValue && /this\.accept/.test(args.functionDeclaration)) return { result: { value: { accept: 'video/*' } } };
          // the rest of a willing page, so that only the accept check stands between this photo and the input
          const took = { connected: true, files: [{ name: 'photo.png', size: 7 }], events: [], input: {}, pageReaction: { domChanges: 0, requests: 0 } };
          if (method === 'Runtime.callFunctionOn' && /this\.(peek|finish)\(\)/.test(args.functionDeclaration)) return { result: { value: took } };
          if (method === 'Runtime.callFunctionOn' && !args.returnByValue && /events/.test(args.functionDeclaration)) return { result: { objectId: 'watch' } };
          return { result: {} };
        } };
        let excluded = null;
        try { await selectFiles({ cdp: videoOnly, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.png'], expected: [{ name: 'photo.png', size: 7 }], settle: async () => {} }); } catch (e) { excluded = e; }
        A.ok(excluded && /accepts video\/\*, not photo\.png/.test(excluded.message), 'a photo into a video-only input is refused by selectFiles itself: ' + (excluded && excluded.message));
        A.eq(sent.filter(m => m === 'DOM.setFileInputFiles').length, 0, 'and no file is ever handed to that input');
      }
      // a control with no direct input asks the page's chooser first, and the input Chrome names is the one that gets the files
      const calls = [];
      const chooser = { send: async (method, args) => {
        calls.push([method, args]);
        if (method === 'Runtime.evaluate' && /controlAtPoint/.test(args.expression)) return { result: { value: { click: true } } };
        if (method === 'Runtime.evaluate') return { result: { type: 'object', subtype: 'null', value: null } };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'chosen' } };
        if (method === 'Runtime.callFunctionOn' && args.functionDeclaration.includes('this.finish')) return { result: { value: { connected: true, files: [{ name: 'photo.txt', size: 7 }], events: [], input: {}, pageReaction: { domChanges: 2, requests: 1 } } } };
        if (method === 'Runtime.callFunctionOn' && args.objectId === 'chosen' && !args.returnByValue && /observe|events/.test(args.functionDeclaration)) return { result: { objectId: 'observer' } };
        return { result: {} };
      } };
      const got = await selectFiles({ cdp: chooser, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.txt'], expected: [{ name: 'photo.txt', size: 7 }], settle: async () => {}, openChooser: async () => 77 });
      A.eq(calls.find(c => c[0] === 'DOM.setFileInputFiles')[1].objectId, 'chosen', 'the files go to the input the chooser named');
      A.eq(calls.filter(c => c[0] === 'Runtime.evaluate' && !/controlAtPoint/.test(c[1].expression)).length, 1, 'position is never consulted when the page opened a chooser');
      A.eq([got.resolvedBy, got.pageReaction, got.clicked], ['the file chooser the page opened', { domChanges: 2, requests: 1 }, true], 'the receipt says how it was found, that it clicked, and what the page did');
    }
    await rejects(selectFiles({ cdp, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.txt'], settle: async () => { throw new Error('REF_TAB_CLOSED'); } }), /REF_TAB_CLOSED/, 'pinned-tab loss is preserved, never rerouted');

    // A page refusal reaches the model as its one-line reason, never with V8 stack frames.
    const refusal = { send: async (method) => {
      if (method === 'Runtime.evaluate') return { exceptionDetails: { text: 'Uncaught', exception: { description:
        'Error: ambiguous upload control: more than one file input is nearby; select its specific file input or associated label\n    at inputAtPoint (<anonymous>:30:35)\n    at <anonymous>:1:2' } } };
      return {};
    } };
    let refused = null;
    try { await selectFiles({ cdp: refusal, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.txt'], settle: async () => {} }); } catch (e) { refused = e; }
    A.eq(refused && refused.message, 'ambiguous upload control: more than one file input is nearby; select its specific file input or associated label', 'page refusal keeps only its reason: no stack frames, no "Error:" prefix');

    // A form that submits on change navigates away before the readback: the effect is unknown, never a plain failure.
    const released = [];
    const navigating = { send: async (method, args) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input' } };
      if (method === 'Runtime.callFunctionOn' && args.objectId === 'input') return { result: { objectId: 'observer' } };
      if (method === 'Runtime.callFunctionOn' && args.returnByValue) throw new Error('Could not find object with given id');
      if (method === 'Runtime.releaseObject') released.push(args.objectId);
      return {};
    } };
    let lost = null;
    try { await selectFiles({ cdp: navigating, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.txt'], settle: async () => {} }); } catch (e) { lost = e; }
    A.ok(lost && /may already have been submitted/.test(lost.message), 'lost readback says the form may already have been submitted: ' + (lost && lost.message));
    A.ok(lost && !/Could not find object/.test(lost.message), 'the raw CDP protocol error is not the model-facing reason');
    A.eq(lost && lost.effectUnknown, true, 'lost readback is marked effectUnknown so the registry warns against a blind retry');
    A.ok(released.includes('input'), 'the input handle is still released after a lost readback');
    // Tab loss during the readback keeps its own code and message.
    const closing = { send: async (method, args) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input' } };
      if (method === 'Runtime.callFunctionOn' && args.objectId === 'input') return { result: { objectId: 'observer' } };
      if (method === 'Runtime.callFunctionOn' && args.returnByValue) throw Object.assign(new Error('the browser tab this action started on was closed part-way through'), { code: 'REF_TAB_CLOSED' });
      return {};
    } };
    let closed = null;
    try { await selectFiles({ cdp: closing, node: { x: 0, y: 0, w: 10, h: 10 }, paths: ['photo.txt'], settle: async () => {} }); } catch (e) { closed = e; }
    A.eq(closed && closed.code, 'REF_TAB_CLOSED', 'tab loss during readback propagates unchanged');
  } finally {
    perUser.restore();
    if (path.dirname(scratch) === scratchTmp && path.basename(scratch).startsWith('starnet-upload-unit-')) fs.rmSync(scratch, { recursive: true, force: true });
    if (stagingRootForCleanup && /starnet-upload-staging-[0-9a-f]{16}$/.test(stagingRootForCleanup)) { try { fs.rmSync(stagingRootForCleanup, { recursive: true, force: true }); } catch (e) { console.log('[cleanup] ' + e.message); } }
  }
  A.report('browser-upload');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
