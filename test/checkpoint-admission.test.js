/* node test/checkpoint-admission.test.js — a checkpoint is taken only AFTER the call is admitted (lane checkpoint-links,
   review round 1, 2026-10-30). A refused call snapshots nothing.

   Before this lane, on trunk d5024f5a (all pre-existing; the rows here pin the fix):
     - terminal.start awaited ctx.checkpointMutation(where.cwd, …, { always:true }) BEFORE its real-path containment and
       protected-folder refusals, so `terminal.start {cwd:"jx"}` (a junction in the workspace pointing out) was refused
       "outside your workspace by its real path" with the whole workspace already snapshotted;
     - POST /api/autonomy/write snapshotted the workspace before reg.dispatch(fs.write): before consent and before the
       path proof, so a denied or escaping write left a checkpoint;
     - the host's generic hook snapshotted every shell.* / verify.* name that is not a precise one BEFORE
       registry.dispatch, ahead of the authority, capability, schema, consent and hook gates: every shell.bg.status /
       read / wait poll (scope 'read') re-hashed the whole tree, and a refused shell.bg.write still snapshotted.
   Now: terminal.start proves its real folder first (and again after the checkpoint await); the autonomy write hands
   fs.write a ctx.checkpointMutation that run-paths calls after consent and the path proof; the generic snapshot runs at
   the registry's last seam before tool.run (beforeToolExecute) and never for a read-scope tool; shell.bg.write takes its
   own checkpoint after its input screen. Section 3's behaviour rows are controls of fs.write's run-paths seam (green on
   trunk too: they never run handleAutonomyWrite); its source locks pin the handler. Sibling:
   test/checkpoint-links.test.js (the capture/restore link boundary). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTerminalTools } = require('../sidecar/tools/builtin/terminal.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeConsentBroker } = require('../sidecar/permissions.js');
const { sidecarTopLevelFunction } = require('./helpers/source');

const isWin = process.platform === 'win32';
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-ckpt-admission-')));
const links = [];
function link(target, at) { fs.symlinkSync(target, at, isWin ? 'junction' : 'dir'); links.push(at); }

(async () => {
  try {
    // ================= 1. terminal.start: the real folder is proven before the checkpoint =================
    {
      const root = path.join(BASE, 'term'), workspace = path.join(root, 'a1');
      fs.mkdirSync(path.join(workspace, 'repo', '.git'), { recursive: true });
      const outsideDir = path.join(BASE, 'term-outside'); fs.mkdirSync(outsideDir);
      link(outsideDir, path.join(workspace, 'jx'));
      const starts = [];
      const manager = {
        start(o) { starts.push(o); return { ok: true, persisted: true, session: { sessionId: 'term_' + starts.length, name: o.name, state: 'running', cols: 120, rows: 30, pid: 8, cwd: o.cwd, command: o.command } }; },
        storeHealth() { return { loaded: 'ok', persisted: true, error: null }; }
      };
      const environment = { backendId: 'local', ensureWorkspace: () => workspace, getCwd: () => workspace };
      const start = makeTerminalTools({ manager, environment, fs, pathMod: path, root, platform: process.platform, envFor: () => ({}) }).tools.find((t) => t.name === 'terminal.start');
      const checkpoints = [];
      const ctx = { agentId: 'a1', surface: 'interactive', checkpointMutation: async (cwd, label) => { checkpoints.push([cwd, label]); } };
      let why = '';
      try { await start.run({ name: 'jx', command: 'echo hi', cwd: 'jx' }, ctx); why = 'STARTED'; } catch (e) { why = e.message; }
      A.ok(/outside your workspace by its real path/.test(why), 'a junction cwd pointing out is refused (' + why + ')');
      A.eq(checkpoints.length, 0, 'and the refused start snapshotted NOTHING (it used to snapshot the workspace first)');
      why = '';
      try { await start.run({ name: 'g', command: 'echo hi', cwd: 'repo/.git' }, ctx); why = 'STARTED'; } catch (e) { why = e.message; }
      A.ok(/protected folder/.test(why), 'a protected-folder cwd is refused (' + why + ')');
      A.eq(checkpoints.length, 0, 'and snapshotted nothing either');
      const ok = await start.run({ name: 'repl', command: 'echo hi' }, ctx);
      A.ok(/Started as term_1/.test(ok.content), 'an admitted start still starts');
      A.eq(checkpoints.length, 1, 'and takes its one checkpoint');
      A.eq(starts.length, 1, 'only the admitted start reached the manager');
      // the re-check after the checkpoint await still holds: a folder swapped for a link during it is refused
      fs.mkdirSync(path.join(workspace, 'swap'));
      const racer = Object.assign({}, ctx, { checkpointMutation: async () => { fs.rmdirSync(path.join(workspace, 'swap')); link(outsideDir, path.join(workspace, 'swap')); } });
      why = '';
      try { await start.run({ name: 'sw', command: 'echo hi', cwd: 'swap' }, racer); why = 'STARTED'; } catch (e) { why = e.message; }
      A.ok(/changed while the session was being prepared|outside your workspace/.test(why) && starts.length === 1, 'a swap during the checkpoint await is still caught after it (' + why + ')');
    }

    // ================= 2. shell.bg.write: its own checkpoint, after the input screen =================
    {
      const root = path.join(BASE, 'bg'); fs.mkdirSync(path.join(root, 'a1'), { recursive: true });
      const written = [];
      const bg = { write: async (aid, id, o) => { written.push(o.input); return { ok: true, bytes: o.input.length }; }, closeStdin: async () => ({ ok: true }) };
      const fam = makeShellTool({ spawn: () => { throw new Error('must not spawn'); }, fs, pathMod: path, root, bg });
      const checkpoints = [];
      const ctx = { agentId: 'a1', checkpointMutation: async (cwd, label, opts) => { checkpoints.push([cwd, label, opts]); } };
      let why = '';
      try { await fam.bgWriteTool.run({ id: 'bg_1', input: 'explorer.exe .' }, ctx); why = 'SENT'; } catch (e) { why = e.message; }
      A.ok(/refused/.test(why) && !written.length, 'a screened-out line is refused (' + why.slice(0, 80) + ')');
      A.eq(checkpoints.length, 0, 'and snapshots nothing (green on trunk too, where shell.js took no checkpoint: the next rows are the pin)');
      const sent = await fam.bgWriteTool.run({ id: 'bg_1', input: 'echo hi' }, ctx);   // trunk's shell guard (repair) refuses a bare word it cannot prove is a console tool on Windows: the admitted line is a known one
      A.ok(/Sent 7 byte/.test(sent.content), 'an admitted line is sent');
      A.eq(checkpoints.length, 1, 'after one checkpoint');
      A.eq(checkpoints[0] && [path.resolve(checkpoints[0][0]), checkpoints[0][1], checkpoints[0][2] && checkpoints[0][2].always], [path.resolve(root, 'a1'), 'shell.bg.write', true], 'of the agent workspace, labelled, taken whatever the fs.* flag says');
      await fam.bgWriteTool.run({ id: 'bg_1', eof: true }, ctx);
      A.eq(checkpoints.length, 2, 'closing stdin (which can start the work) checkpoints too');
      A.eq(['shell.bg.status', 'shell.bg.read', 'shell.bg.wait'].map((n) => fam[{ 'shell.bg.status': 'bgStatusTool', 'shell.bg.read': 'bgReadTool', 'shell.bg.wait': 'bgWaitTool' }[n]].scope), ['read', 'read', 'read'], 'the polls are read-scope (the generic hook skips them)');
    }

    // ================= 3. the autonomy write: fs.write calls the checkpoint after consent and its path proof =================
    {
      const root = path.join(BASE, 'auto');
      fs.mkdirSync(path.join(root, 'agent'), { recursive: true });
      const hardlineFloor = (call) => {   // the same floor index.js wires (kept in step with autonomy-write.test.js)
        const p = call && call.args && call.args.path;
        if (typeof p === 'string' && (/(^|[\\/])\.env(\.|$)/i.test(p) || /(^|[\\/])\.git([\\/]|$)/i.test(p))) return 'protected-file floor';
        return null;
      };
      const asked = [];
      const write = async (grants, rel) => {
        const reg = makeRegistry();
        makeFsTools({ fsp, pathMod: path, root, limits: { writeBytes: 1 << 20 } }).register(reg);
        const consent = makeConsentBroker({ bypass: false, hardline: hardlineFloor, sessionKey: 'k', grantsPermanent: new Set(grants), surface: 'autonomous' });
        return reg.dispatch({ name: 'fs.write', args: { path: rel, content: 'x' }, id: '1' },
          { agentId: 'agent', consent, emit() {}, timeoutMs: 10000, checkpointMutation: async (base) => { asked.push(base); return null; } });
      };
      let r = await write([], 'drafts/x.md');
      A.ok(r && !r.ok, 'fixture: an ungranted autonomous write is denied');
      // CONTROLS of the seam handleAutonomyWrite now relies on (fs.write's run-paths hook, already on trunk): green on
      // trunk d5024f5a too. The index.js move itself is pinned by the three source locks below
      A.eq(asked.length, 0, 'control: fs.write\'s run-paths checkpoint hook does not fire for a denied write');
      r = await write(['cabinet:write'], '.env');
      A.ok(r && !r.ok && asked.length === 0, 'control: nor for a floor-blocked write');
      r = await write(['cabinet:write'], '../escape.md');
      A.ok(r && !r.ok && asked.length === 0, 'control: nor for an escaping write');
      r = await write(['cabinet:write'], 'drafts/x.md');
      A.ok(r && r.ok, 'a granted write lands');
      A.eq(asked.map((b) => path.resolve(b)), [path.resolve(root, 'agent')], 'control: after one call of the hook, with the agent workspace');
      const handler = sidecarTopLevelFunction('handleAutonomyWrite');
      const cb = handler.indexOf('const checkpointMutation = async'), cbEnd = handler.indexOf('};', cb);
      const snapAt = handler.indexOf('checkpointStore.snapshot(');
      A.ok(cb > 0 && snapAt > cb && snapAt < cbEnd && handler.indexOf('checkpointStore.snapshot(', cbEnd) < 0, 'handleAutonomyWrite snapshots only inside the checkpointMutation callback');
      A.ok(/reg\.dispatch\(call, \{[^\n]{0,200}?checkpointMutation: checkpointMutation \}\)/.test(handler), 'and hands that callback to the fs.write dispatch');
      A.ok(/checkpointPathInside\(path\.resolve\(String\(base\)\), autonomyWorkspace\)/.test(handler), 'the callback snapshots the agent\'s own workspace only');
      // A SLOW CHECKPOINT IS NOT THE WRITE'S TIME (undo review 12's laws BLOCKER). The autonomy write's snapshot runs inside fs.write now, through
      // run-paths, and counted against the tool's own timeout (10 s), so a snapshot past it failed the write ("timed out ... Its effect is UNKNOWN")
      // where trunk, which took it before the dispatch, wrote. run-paths holds the registry's deadline while the checkpoint runs: fs.write's timeout
      // at 3 s here, a checkpoint of 4.5 s
      const slowReg = makeRegistry();
      slowReg.register(Object.assign({}, makeFsTools({ fsp, pathMod: path, root, limits: { writeBytes: 1 << 20 } }).writeTool, { timeoutMs: 3000 }));
      const slowConsent = makeConsentBroker({ bypass: false, hardline: hardlineFloor, sessionKey: 'k', grantsPermanent: new Set(['cabinet:write']), surface: 'autonomous' });
      let slowTaken = 0;
      r = await slowReg.dispatch({ name: 'fs.write', args: { path: 'drafts/slow.md', content: 'after a slow checkpoint' }, id: '2' },
        { agentId: 'agent', consent: slowConsent, emit() {}, timeoutMs: 10000, checkpointMutation: async () => { await new Promise((done) => setTimeout(done, 4500)); slowTaken++; return null; } });
      A.ok(r && r.ok && slowTaken === 1, 'a granted write whose checkpoint takes longer than the tool\'s timeout still lands (' + String(JSON.stringify(r && (r.content || r.summary))).slice(0, 160) + ')');
      A.eq(fs.existsSync(path.join(root, 'agent', 'drafts', 'slow.md')) ? fs.readFileSync(path.join(root, 'agent', 'drafts', 'slow.md'), 'utf8') : null, 'after a slow checkpoint', 'with its bytes');
    }

    // ================= 4. the generic hook: at the registry's last seam, never for a read-scope tool =================
    {
      const reg = makeRegistry();
      const ran = [];
      reg.register({ name: 'shell.bg.kill', capability: 'workbench', impact: 'workspace-process', scope: 'write', requiresConsent: true, schema: { type: 'object', properties: {} }, run: async () => { ran.push('kill'); return 'killed'; } });
      reg.register({ name: 'shell.bg.status', capability: 'workbench', impact: 'workspace-process', scope: 'read', requiresConsent: false, schema: { type: 'object', properties: {} }, run: async () => { ran.push('status'); return 'status'; } });
      const seams = [];
      const seam = async (call, tool) => { seams.push(call.name + ':' + tool.scope); return null; };
      await reg.dispatch({ name: 'shell.bg.kill', args: {}, id: '1' }, { agentId: 'a', emit() {}, consent: () => ({ allow: false, reason: 'no' }), beforeToolExecute: seam });
      await reg.dispatch({ name: 'shell.bg.kill', args: {}, id: '2' }, { agentId: 'a', emit() {}, canUse: () => ({ ok: false, reason: 'not granted' }), beforeToolExecute: seam });
      A.eq(seams, [], 'a call the consent or capability gate refuses never reaches beforeToolExecute (where the generic snapshot now runs)');
      await reg.dispatch({ name: 'shell.bg.kill', args: {}, id: '3' }, { agentId: 'a', emit() {}, consent: () => ({ allow: true }), beforeToolExecute: seam });
      await reg.dispatch({ name: 'shell.bg.status', args: {}, id: '4' }, { agentId: 'a', emit() {}, beforeToolExecute: seam });
      A.eq(seams, ['shell.bg.kill:write', 'shell.bg.status:read'], 'an admitted call reaches it with its tool, scope included');
      const core = sidecarTopLevelFunction('runOnceCore');
      const def = core.indexOf('const genericSnapshot = async (tool) => {');
      const body = def >= 0 ? core.slice(def, core.indexOf('\n    };', def)) : '';
      A.ok(/if \(!genericCheckpoint \|\| !tool \|\| tool\.scope === 'read'\) return;/.test(body) && /checkpointStore\.snapshot\(agentId, \{ runId, turn, label: c\.name \}\)/.test(body), 'the generic snapshot skips a read-scope tool');
      const calls = core.split('checkpointStore.snapshot(agentId, { runId, turn, label: c.name })').length - 1;
      A.eq(calls, 1, 'and is the only generic snapshot in the dispatch path');
      const wired = core.indexOf('beforeToolExecute: async (call, tool) => {\n          await genericSnapshot(tool);');
      const dispatchAt = core.indexOf('r = await registry.dispatch(c, dctx);');
      A.ok(wired > 0 && dispatchAt > wired && (core.match(/await genericSnapshot\(/g) || []).length === 1, 'it runs only inside beforeToolExecute, wired before the dispatch');
      A.ok(/const preciseCheckpoint = [^\n]*shell\\\.bg\\\.write/.test(core), 'shell.bg.write takes its own checkpoint, so the generic hook leaves it alone');
    }
  } finally {
    for (const l of links.slice().reverse()) {
      try { if (isWin) execFileSync('cmd', ['/c', 'rmdir', l], { windowsHide: true, stdio: 'ignore' }); else fs.unlinkSync(l); }
      catch (e) { console.log('[cleanup] could not remove link ' + l + ': ' + e.message); }
    }
    const left = links.filter((l) => { try { fs.lstatSync(l); return true; } catch (_) { return false; } });
    if (!left.length) { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {} }
    else console.log('[cleanup] left ' + BASE + ' in place: links remain');
  }
  A.report('checkpoint-admission.test');
})().catch((e) => { console.log('FAIL: checkpoint-admission.test threw — ' + (e && e.stack || e)); process.exit(1); });
