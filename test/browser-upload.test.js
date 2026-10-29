/* #104 + run-paths review round 3 (M-B): an upload is a file LEAVING the station, so browser.upload proves every path
   through the ONE egress reader (sidecar/egress-files.js, probe mode) and hands the browser the proven REAL path. Only
   a file in the run's own private workspace or its own approved project root goes; another blessed root, This Computer
   reach, Full Power ~/.ssh, a floored file and a hard link are refused (each was uploaded before, with no card under
   Full Power), and the run's fs.read guard is never asked. No CDP ack-only success.
   Review round 4, minor-1 (scratchpad rr4-egress.js section G): the browser opens the path it is handed AFTER the proof,
   so a folder swapped for a junction in between changed the bytes uploaded. The browser is now handed a STAGED COPY of
   the proven bytes (a fresh random folder of <jail>/.upload-staging, the original name), dropped when the run ends or
   its own browser closes, bounded in size, and swept at boot without ever entering a link. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { makeBrowserTools } = require('../sidecar/tools/builtin/browser.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const { makeEgressReader } = require('../sidecar/egress-files.js');
const RunPaths = require('../sidecar/run-paths.js');
const { selectFiles } = require('../sidecar/tools/builtin/browser-upload.js');
const rejects = async (p, re, message) => { try { await p; A.ok(false, message + ': did not refuse'); } catch (e) { A.ok(re.test(e.message), message + ': ' + e.message); } };
(async () => {
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-unit-')));
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
    // the browser is handed a STAGED COPY (round 4, minor-1): <jail>/.upload-staging/<24 hex>/<the file's own name>,
    // holding the proven bytes
    const STAGE = path.join(root, 'agent', '.upload-staging');
    const stagedCopy = (p, name) => !!p && path.dirname(path.dirname(p)) === STAGE && /^[0-9a-f]{24}$/.test(path.basename(path.dirname(p))) && path.basename(p) === (name || 'photo.txt');
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
      // a staging folder that is a link is never written through
      const away = path.join(scratch, 'away');
      fs.mkdirSync(away, { recursive: true });
      fs.rmdirSync(STAGE);
      fs.symlinkSync(away, STAGE, isWin ? 'junction' : 'dir');
      try {
        await rejects(run(['photo.txt'], { agentId: 'agent' }), /staging folder \.upload-staging in your workspace is a link to somewhere else/, 'a staging folder that is a link is refused');
        A.eq(fs.readdirSync(away), [], 'and nothing was written through it');
      } finally { try { fs.unlinkSync(STAGE); } catch (e) { fs.rmdirSync(STAGE); } }
      // THE BOOT SWEEP: a crash's leftovers go; a link is unlinked, never entered; a moved agent folder is never walked
      const { sweepUploadStaging } = require('../sidecar/egress-files.js');
      const left = path.join(STAGE, 'a1b2c3d4e5f6a1b2c3d4e5f6');
      fs.mkdirSync(left, { recursive: true });
      fs.writeFileSync(path.join(left, 'photo.txt'), 'LEFT BEHIND');
      fs.symlinkSync(path.join(home, 'sub'), path.join(left, 'trap'), isWin ? 'junction' : 'dir');
      fs.symlinkSync(path.join(home, 'sub'), path.join(STAGE, 'trap2'), isWin ? 'junction' : 'dir');
      const zeta = path.join(scratch, 'zeta-real');
      fs.mkdirSync(path.join(zeta, '.upload-staging', 'f00f00f00f00f00f00f00f00'), { recursive: true });
      fs.writeFileSync(path.join(zeta, '.upload-staging', 'f00f00f00f00f00f00f00f00', 'keep.txt'), 'KEEP');
      fs.symlinkSync(zeta, path.join(root, 'zeta'), isWin ? 'junction' : 'dir');
      try {
        const n = await sweepUploadStaging({ fsp, pathMod: path, workspaces: root });
        A.ok(n === 1 && !fs.existsSync(left), 'the boot sweep removes a crashed run\'s staged copy (' + n + ')');
        A.eq(fs.readFileSync(path.join(home, 'sub', 'x.txt'), 'utf8'), 'HOME-SECRET-X', 'a link inside a staged folder is unlinked, never followed');
        A.ok(fs.existsSync(path.join(STAGE, 'trap2')), 'a link in the staging folder is never entered');
        A.ok(fs.existsSync(path.join(zeta, '.upload-staging', 'f00f00f00f00f00f00f00f00', 'keep.txt')), 'an agent folder that is a link is never walked');
        A.eq(await sweepUploadStaging({ fsp, pathMod: path, workspaces: path.join(scratch, 'no-such-dir') }), 0, 'no workspaces folder: nothing to sweep');
      } finally {
        for (const l of [path.join(STAGE, 'trap2'), path.join(root, 'zeta')]) { try { fs.unlinkSync(l); } catch (e) { try { fs.rmdirSync(l); } catch (e2) { console.log('[cleanup] ' + e2.message); } } }
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
  }
  A.report('browser-upload');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
