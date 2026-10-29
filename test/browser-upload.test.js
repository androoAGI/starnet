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
   root OUTSIDE every jail (egress-files.js defaultStagingRoot: os.tmpdir()/starnet-upload-staging-<id>/<agent>/<rand>),
   is locked owner-only, and is re-verified around the hand-off.
   Review round 6 BLOCKER (scratchpad rr6-chrome-submit.js, real Chrome): the browser reads the file at FORM SUBMIT, a
   later action, so a swap after browser.upload returned was sent. Every staged copy stays registered with its sha256,
   and every later browser action that can submit or read re-proves it first; a change empties the input, drops the copy
   and refuses the action. Threat model (owner decision): these guard the tool path and accidental leaks, not a hostile
   same-user shell. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const { makeEgressReader, defaultStagingRoot } = require('../sidecar/egress-files.js');
const RunPaths = require('../sidecar/run-paths.js');
const { selectFiles } = require('../sidecar/tools/builtin/browser-upload.js');
const rejects = async (p, re, message) => { try { await p; A.ok(false, message + ': did not refuse'); } catch (e) { A.ok(re.test(e.message), message + ': ' + e.message); } };
(async () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-unit-')));
  let stagingRootForCleanup = null;   // the station staging root lives under os.tmpdir(), OUTSIDE scratch
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
        const st = { handed: [], sent: [], submits: 0, cleared: 0, clearedPaths: [], loader: 'L1' };
        const submit = () => { st.submits++; st.sent.push(st.handed.map(p => (fs.existsSync(p) ? fs.readFileSync(p, 'latin1') : null))); if (o.navigates) st.loader = 'L' + (st.submits + 1); };
        const d = {
          st,
          snapshot: async () => [{ role: 'button', text: 'Choose file', x: 1, y: 1, w: 10, h: 10 }, { role: 'button', text: 'Send form', x: 1, y: 30, w: 10, h: 10 }],
          upload: async (_n, abs, expected) => { st.handed = abs.slice(); const r = { status: 'selected', files: expected, retained: true, events: ['change'] }; if (o.doc) r.doc = { sid: null, loader: st.loader }; return r; },
          clearUpload: async () => { st.cleared++; st.handed = []; return { cleared: true }; },
          click: async () => { submit(); return 'clicked'; },
          press: async () => { submit(); return 'pressed'; },
          type: async () => 'typed',
          back: async () => { st.loader = 'L-back'; return 'https://example.com/back'; }
        };
        if (o.doc) {
          d.uploadDocAlive = async doc => doc.loader === st.loader;
          d.clearStagedInputs = async (_doc, paths) => { st.clearedPaths.push(...paths); const before = st.handed.length; st.handed = st.handed.filter(p => !paths.includes(p)); return { cleared: before - st.handed.length }; };
        }
        return d;
      }
      async function selected(o) {
        fs.writeFileSync(path.join(root, 'r6', 'own.bin'), OWN6);
        fs.writeFileSync(secret6, SECRET6);
        const d = chromeLike(o);
        const tb = makeBrowserTools({ driver: d, fsp, pathMod: path, root, egress });
        const [choose, send] = (await tb.session.snapshot()).map(n => n.ref);
        const tool = name => tb.tools.find(t => t.name === name);
        const receipt = await tool('browser.upload').run({ ref: choose, paths: ['own.bin'] }, { agentId: 'r6' });
        return { d, tb, tool, choose, send, receipt, copy: d.st.handed[0] };
      }
      const attempt = async p => { try { return { out: await p }; } catch (e) { return { error: e }; } };
      const sentBytes = d => d.st.sent.flat().filter(b => b != null);
      const REFUSED = /was refused: an uploaded file changed on disk after you selected it, so it was not sent; select it again/;

      // control: the receipt is honest, and a normal upload then click sends the original bytes
      {
        const x = await selected();
        A.ok(/^File selected for upload; StarNet re-checks it before each later browser action\./.test(x.receipt.content) && !/selection verified/i.test(x.receipt.content),
          'R6 (4): the receipt says the file was selected and is re-checked, never that it is verified: ' + x.receipt.content.slice(0, 90));
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
      A.eq(fs.existsSync(path.join(stagingRoot, 'r6')) ? fs.readdirSync(path.join(stagingRoot, 'r6')) : [], [], 'R6: no staged copy is left behind');
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
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('starnet-upload-unit-')) fs.rmSync(scratch, { recursive: true, force: true });
    if (stagingRootForCleanup && /starnet-upload-staging-[0-9a-f]{16}$/.test(stagingRootForCleanup)) { try { fs.rmSync(stagingRootForCleanup, { recursive: true, force: true }); } catch (e) { console.log('[cleanup] ' + e.message); } }
  }
  A.report('browser-upload');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
