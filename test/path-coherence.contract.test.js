/* node test/path-coherence.contract.test.js — ONE PATH DECISION PER RUN (run-paths lane, 2026-10-28).

   The family: a relative path meant a different folder to different tools in the same run, and each fix patched one
   copy of the decision (#60 fs vs shell, #77/#88 media, 8c442112 parked output, #81 loops). This contract drives the
   REAL tools — fs.*, shell.exec, verify.run, terminal.start/read, browser.screenshot/pdf/upload/click, image_generate /
   image_analyze, voice_generate — over real temp dirs, the REAL path-trust core and the REAL local execution
   environment (only process spawning is faked: a tiny interpreter for `cd`, `touch` and `test -f`), and checks:

     A. PRODUCER x CONSUMER x SURFACE: whatever one tool produced at a path it named, every other tool opens at that
        same name, on every surface (an ordinary chat, a project chat, a routine, a loop).
     B. ONE SOURCE: every path-resolving tool takes its decision from the run's path object (ctx.paths) and nothing
        else — a loose ctx.projectRoot that disagrees with it is ignored by all of them.
     C. A `cd` in one chat never moves another chat's shell, verify or terminal.
     D. ENTRY POINTS: runOnce mints ctx.paths (and no projectCwd); the loop driver hands its folder to the run; a
        delegated worker inherits the lead's folder from ctx.paths; the host's park pointer, postcondition reader
        and attachment note go through the same object.

   The host ctx is minted the way runOnce mints it at THIS commit: { paths } when sidecar/run-paths.js exists, the
   historic { projectRoot, projectCwd } otherwise — so on the pre-fix tree every row runs against what that tree's
   host really passed, and the rows that were broken there fail. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readSidecarSource, sidecarTopLevelFunction } = require('./helpers/source');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const Shell = require('../sidecar/tools/builtin/shell.js');
const { makeVerifyTool } = require('../sidecar/tools/builtin/verify.js');
const { makeTerminalTools } = require('../sidecar/tools/builtin/terminal.js');
const { makeBrowserTools, _internals: BrowserT } = require('../sidecar/tools/builtin/browser.js');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');
const { makeVoiceTools } = require('../sidecar/tools/builtin/voice.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');
const { makeEnvironmentManager } = require('../sidecar/environment.js');
const { makeLoopDriver } = require('../sidecar/loopjob-driver.js');
const LoopStore = require('../sidecar/loopjob-store.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
let RunPaths = null;
try { RunPaths = require('../sidecar/run-paths.js'); } catch (e) { console.log('[pre-fix tree] no sidecar/run-paths.js: ' + e.message); }

const isWin = process.platform === 'win32';
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-path-coherence-')));
const WS = path.join(BASE, 'workspaces');
const PROJECT = path.join(BASE, 'project');
const DECOY = path.join(BASE, 'decoy');
const AID = 'coder';
const JAIL = path.join(WS, AID);
for (const d of [WS, PROJECT, DECOY, JAIL, path.join(PROJECT, 'sub')]) fs.mkdirSync(d, { recursive: true });
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---- the station: real path trust (PROJECT and DECOY both trusted, so a wrong base SUCCEEDS into the wrong folder
// instead of throwing — the failure this contract must see), an unattended surface, no prompt ----
const trustCore = makePathTrust({ fsp, pathMod: path, roots: () => [PROJECT, DECOY], workspaceRoot: WS });
const pathTrust = (abs, o2) => trustCore.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: (o2 && o2.agentId) || AID });

// ---- process spawning, faked: a 3-word shell. Every command reports its cwd + exit code through the real marker ----
const spawned = [];
function fakeSpawn(file, opts) {
  const marked = String(file);
  const cmd = marked.split('\n__sk_ec=')[0].split(' & call echo ')[0].trim();
  let cwd = (opts && opts.cwd) || JAIL, ec = 0, out = 'ok';
  spawned.push({ cmd, cwd });
  const m = /^(cd|touch|test -f) (.+)$/.exec(cmd);
  if (m && m[1] === 'cd') { const next = path.resolve(cwd, m[2]); if (fs.existsSync(next)) cwd = next; else ec = 1; }
  else if (m && m[1] === 'touch') fs.writeFileSync(path.resolve(cwd, m[2]), 'made by the shell');
  else if (m && m[1] === 'test -f') ec = fs.existsSync(path.resolve(cwd, m[2])) ? 0 : 1;
  let dataCb = null;
  return {
    pid: 4242, kill() {}, unref() {},
    stdout: { on(ev, fn) { if (ev === 'data') dataCb = fn; } },
    stderr: { on() {} },
    stdin: { write() {}, end() {}, on() {} },
    on(ev, fn) {
      if (ev === 'close') setTimeout(() => { if (dataCb) dataCb(Buffer.from(out + '\n__SK_CWD__' + cwd + '__SK_EC__' + ec + '__SK_END__')); fn(0); }, 0);
    }
  };
}
const env = makeEnvironmentManager({ spawn: fakeSpawn, fs, pathMod: path, root: WS, config: { backend: 'local' }, env: {} });

// ---- the run's tools, built the way runOnce builds them ----
const fsTools = makeFsTools({ fsp, pathMod: path, root: WS, environment: env, pathTrust });
const shellTool = Shell.makeShellTool({ spawn: fakeSpawn, fs, pathMod: path, root: WS, environment: env }).execTool;
const verifyTool = makeVerifyTool({ spawn: fakeSpawn, fs, pathMod: path, root: WS, environment: env }).verifyTool;
const terminalStarts = [];
const terminalManager = {
  start(o) { terminalStarts.push(o); return { ok: true, persisted: true, session: { sessionId: 's1', name: o.name, state: 'running', cols: 80, rows: 24, cwd: o.cwd } }; },
  read() { return { ok: true, offset: 0, nextOffset: 2, endOffset: 2, output: 'hi', session: { name: 't', state: 'running', cols: 80, rows: 24, outputSpillVerified: true, outputBytes: 12, outputPath: '.output/terminal-t.txt' } }; },
  status() { return null; }, storeHealth() { return { ok: true }; }
};
const terminal = makeTerminalTools({ manager: terminalManager, environment: env, fs, pathMod: path, root: WS, platform: process.platform });
const termStart = terminal.tools.find(t => t.name === 'terminal.start');
const termRead = terminal.tools.find(t => t.name === 'terminal.read');
const uploads = [];
const fakeSession = {
  screenshot: async () => PNG_B64,
  pdf: async () => Buffer.from('%PDF-1.4 contract').toString('base64'),
  upload: async (ref, abs, expected) => { uploads.push(abs.slice()); return { status: 'selected', retained: true, files: expected.map(e => ({ name: e.name, size: e.size })) }; },
  // the driver's download receipt, through the REAL ledger and the driver's own wording; opts.place is the run's
  // placement the tool layer hands in (an older tool layer hands nothing and the jail-relative name stands)
  click: async (ref, opts) => {
    const dir = path.join(JAIL, 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const ledger = BrowserT.makeDownloadLedger(dir);
    const before = ledger.cursor();
    ledger.begin({ guid: 'g1', suggestedFilename: 'report.txt' });
    fs.writeFileSync(path.join(dir, 'report.txt'), 'downloaded bytes');
    ledger.progress({ guid: 'g1', state: 'completed', receivedBytes: 16, totalBytes: 16 });
    const receipt = await ledger.waitAfter(before, 20);
    const shown = opts && typeof opts.place === 'function' ? opts.place(receipt.absolute) : receipt.relative;
    return 'clicked\nDownload completed and the host verified the saved file.\nSaved path: ' + shown + '\nSize: ' + receipt.bytes + ' bytes';
  }
};
const browser = makeBrowserTools({ session: fakeSession, fsp, pathMod: path, root: WS, pathTrust });
const btool = name => browser.tools.find(t => t.name === name);
const imageFetch = async () => ({ status: 200, headers: { get: () => 'application/json' },
  json: async () => ({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }] }) });
const image = makeImageTools({ openrouter: { apiKey: 'sk-test' }, fsp, pathMod: path, root: WS, fetchImpl: imageFetch, pathTrust, auxVision: async () => 'a one-pixel image' });
const voice = makeVoiceTools({ synth: async () => ({ ok: true, buf: Buffer.from([0x49, 0x44, 0x33, 4]), ext: 'mp3', mime: 'audio/mpeg' }), fsp, pathMod: path, root: WS, pathTrust });

// ---- the host ctx, minted the way runOnce mints it at this commit ----
let runSeq = 0;
function hostCtx(o) {
  o = o || {};
  const ctx = { agentId: AID, runId: 'run-' + (++runSeq), projectRoot: o.projectRoot || null, emit() {} };
  if (RunPaths) {
    ctx.paths = RunPaths.makeRunPaths(RunPaths.makeResolver({ fsp, pathMod: path, root: WS, environment: env, pathTrust }),
      { agentId: AID, projectRoot: o.pathsRoot !== undefined ? o.pathsRoot : (o.projectRoot || ''), workdir: o.workdir || '' });
  } else {
    ctx.projectCwd = o.workdir || null;   // the pre-fix host's field
  }
  return ctx;
}
async function attempt(fn) { try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, e }; } }
const rows = [];
function row(name, pass, detail) { rows.push({ name, pass: !!pass }); A.ok(pass, name + (pass ? '' : ' — ' + (detail || ''))); }
const savedAt = (text, re) => { const m = re.exec(String(text || '')); return m ? m[1].trim() : ''; };
let fileSeq = 0;
const freshName = stem => stem + '-' + (++fileSeq) + '.txt';

(async () => {
  try {
    // ================= A. producer x consumer x surface =================
    const surfaces = {
      'ordinary chat': () => hostCtx({}),
      'project chat': () => hostCtx({ projectRoot: PROJECT }),
      // runOnceCore normalizes a routine's workdir into projectRoot before the ctx is built
      'routine': () => hostCtx({ projectRoot: PROJECT, workdir: PROJECT })
    };
    // producers: each makes a file in `ctx` and returns the path string its receipt told the model
    const producers = {
      'fs.write': async (ctx) => { const n = freshName('fsw'); await fsTools.writeTool.run({ path: n, content: 'from fs.write' }, ctx); return n; },
      'shell touch': async (ctx) => { const n = freshName('sh'); await shellTool.run({ cmd: 'touch ' + n }, ctx); return n; },
      'image_generate': async (ctx) => { const r = await image.generateTool.run({ prompt: 'p', path: 'img-' + (++fileSeq) + '.png' }, ctx); return savedAt(r.content, /^Generated and saved (.+?) \(/m); },
      'voice_generate': async (ctx) => { const r = await voice.generateTool.run({ text: 'hello', path: 'take-' + (++fileSeq) }, ctx); return savedAt(r.content, /saved (\S+\.mp3) \(/); },
      'browser.screenshot': async (ctx) => { const r = await btool('browser.screenshot').run({}, ctx); return savedAt(r.content, /^Screenshot saved to (.+?) \(\d+ KB\)/m); },
      'browser.pdf': async (ctx) => { const r = await btool('browser.pdf').run({}, ctx); return savedAt(r.content, /^PDF saved to (.+?) \(\d+ KB\)/m); },
      'browser download': async (ctx) => { const r = await btool('browser.click').run({ ref: 'e1' }, ctx); return savedAt(r.content, /^Saved path: (.+)$/m); },
      'terminal.read spill': async (ctx) => {
        fs.mkdirSync(path.join(JAIL, '.output'), { recursive: true });
        fs.writeFileSync(path.join(JAIL, '.output', 'terminal-t.txt'), 'terminal log');
        const r = await termRead.run({ session: 't' }, ctx); return savedAt(r.content, /saved once at (.+?) \(page with fs\.read\)/);
      }
    };
    // consumers: each opens `name` in `ctx` and says whether it found the producer's file
    const consumers = {
      'fs.read': async (ctx, n) => { const r = await attempt(() => fsTools.readTool.run({ path: n }, ctx)); return r.ok; },
      'shell test -f': async (ctx, n) => { const r = await attempt(() => shellTool.run({ cmd: 'test -f ' + n }, ctx)); return r.ok && /\[exit 0\]/.test(String(r.v.content)); },
      'verify.run test -f': async (ctx, n) => { const r = await attempt(() => verifyTool.run({ cmd: 'test -f ' + n }, ctx)); return r.ok && /PASSED/.test(String(r.v.content)); },
      'browser.upload': async (ctx, n) => { uploads.length = 0; const r = await attempt(() => btool('browser.upload').run({ ref: 'f1', paths: [n] }, ctx)); return r.ok && uploads.length === 1; },
      'terminal.start cwd': async (ctx, n) => {
        terminalStarts.length = 0;
        const r = await attempt(() => termStart.run({ name: 't' + fileSeq, command: 'node' }, ctx));
        return r.ok && terminalStarts.length === 1 && fs.existsSync(path.resolve(terminalStarts[0].cwd, n));
      }
    };
    for (const [sname, mk] of Object.entries(surfaces)) {
      for (const [pname, produce] of Object.entries(producers)) {
        const ctx = mk();
        const made = await attempt(() => produce(ctx));
        if (!made.ok || !made.v) { row(pname + ' produces a named file @ ' + sname, false, made.e ? made.e.message : 'no path in the receipt'); continue; }
        const absolute = path.isAbsolute(made.v);
        // In a project run a file on the PRIVATE shelf (a frame, a PDF, a download, a spill) lies outside the run's base,
        // so its receipt is absolute. The path-taking tools open it (path trust serves the agent's own workspace); the
        // shell's floor refuses an absolute path in a command and that floor must STAY — nothing here may widen it.
        row(pname + ' names its file relative to the run base, or absolutely only outside it @ ' + sname + ' (' + made.v + ')',
          absolute ? !fs.realpathSync(path.dirname(made.v)).toLowerCase().startsWith((sname === 'ordinary chat' ? JAIL : PROJECT).toLowerCase() + path.sep) : true);
        for (const [cname, consume] of Object.entries(consumers)) {
          if (absolute && cname === 'terminal.start cwd') continue;   // a cwd meets relative names only
          if (absolute && /^(shell|verify)/.test(cname)) {
            const refused = await attempt(() => (cname === 'shell test -f' ? shellTool : verifyTool).run({ cmd: 'test -f ' + made.v }, ctx));
            row(pname + ' -> ' + cname + ' @ ' + sname + ': the absolute-path floor still refuses it', !refused.ok && /refused/.test(String(refused.e && refused.e.message)));
            continue;
          }
          row(pname + ' -> ' + cname + ' @ ' + sname + ' (' + made.v + ')', await consume(ctx, made.v));
        }
      }
    }

    // ================= B. ONE SOURCE: ctx.paths decides, a disagreeing loose field does not =================
    // The run's path object says PROJECT; a stale ctx.projectRoot says DECOY (both trusted, so a tool that reads the
    // loose field lands in the decoy without an error). Every path-resolving tool must use PROJECT.
    {
      const one = () => { const c = hostCtx({ projectRoot: DECOY, pathsRoot: PROJECT }); if (!RunPaths) c.projectRoot = DECOY; return c; };
      const inProject = n => fs.existsSync(path.join(PROJECT, n)), inDecoy = n => fs.existsSync(path.join(DECOY, n));
      let n = freshName('one'); await attempt(() => fsTools.writeTool.run({ path: n, content: 'x' }, one()));
      row('ONE SOURCE fs.write resolves against ctx.paths, not a loose ctx.projectRoot', inProject(n) && !inDecoy(n));
      n = freshName('one'); await attempt(() => shellTool.run({ cmd: 'touch ' + n }, one()));
      row('ONE SOURCE shell.exec starts in ctx.paths root', inProject(n) && !inDecoy(n));
      spawned.length = 0; await attempt(() => verifyTool.run({ cmd: 'test -f x' }, one()));
      row('ONE SOURCE verify.run runs in ctx.paths root', spawned.length === 1 && spawned[0].cwd === PROJECT, spawned[0] && spawned[0].cwd);
      terminalStarts.length = 0; await attempt(() => termStart.run({ name: 'one', command: 'node' }, one()));
      row('ONE SOURCE terminal.start opens in ctx.paths root', terminalStarts.length === 1 && terminalStarts[0].cwd === PROJECT, terminalStarts[0] && terminalStarts[0].cwd);
      const img = 'one-' + (++fileSeq) + '.png'; await attempt(() => image.generateTool.run({ prompt: 'p', path: img }, one()));
      row('ONE SOURCE image_generate places in ctx.paths root', inProject(img) && !inDecoy(img));
      fs.writeFileSync(path.join(PROJECT, 'ref.png'), Buffer.from(PNG_B64, 'base64'));
      const seen = await attempt(() => image.analyzeTool.run({ image: 'ref.png', prompt: 'what' }, one()));
      row('ONE SOURCE image_analyze reads from ctx.paths root', seen.ok, seen.e && seen.e.message);
      await attempt(() => voice.generateTool.run({ text: 'x', path: 'one-voice' }, one()));
      row('ONE SOURCE voice_generate places in ctx.paths root', inProject('one-voice.mp3') && !inDecoy('one-voice.mp3'));
      fs.writeFileSync(path.join(PROJECT, 'up.txt'), 'upload me'); uploads.length = 0;
      await attempt(() => btool('browser.upload').run({ ref: 'f1', paths: ['up.txt'] }, one()));
      row('ONE SOURCE browser.upload reads from ctx.paths root', uploads.length === 1 && uploads[0][0] === path.join(PROJECT, 'up.txt'), uploads[0] && uploads[0][0]);
      const shot = await attempt(() => btool('browser.screenshot').run({}, one()));
      const shotPath = shot.ok ? savedAt(shot.v.content, /^Screenshot saved to (.+?) \(\d+ KB\)/m) : '';
      row('ONE SOURCE browser.screenshot names its file for ctx.paths (absolute in a project run)', !!shotPath && path.isAbsolute(shotPath) && fs.existsSync(shotPath), shotPath);
    }

    // ================= C. a `cd` in one chat never moves another =================
    {
      const chatA = hostCtx({}), chatB = hostCtx({});
      fs.mkdirSync(path.join(JAIL, 'deep'), { recursive: true });
      await shellTool.run({ cmd: 'cd deep' }, chatA);
      spawned.length = 0; await shellTool.run({ cmd: 'touch a-still-here.txt' }, chatA);
      row('a `cd` carries over within ONE run', spawned[0] && spawned[0].cwd === path.join(JAIL, 'deep'), spawned[0] && spawned[0].cwd);
      spawned.length = 0; await shellTool.run({ cmd: 'touch b.txt' }, chatB);
      row('a `cd` in one chat does not move another chat\'s shell', spawned[0] && spawned[0].cwd === JAIL, spawned[0] && spawned[0].cwd);
      spawned.length = 0; await verifyTool.run({ cmd: 'test -f b.txt' }, hostCtx({}));
      row('nor another chat\'s verify.run', spawned[0] && spawned[0].cwd === JAIL, spawned[0] && spawned[0].cwd);
      terminalStarts.length = 0; await termStart.run({ name: 'cdx', command: 'node' }, hostCtx({}));
      row('nor another chat\'s terminal.start', terminalStarts[0] && terminalStarts[0].cwd === JAIL, terminalStarts[0] && terminalStarts[0].cwd);
      const proj = hostCtx({ projectRoot: PROJECT });
      await shellTool.run({ cmd: 'cd sub' }, proj);
      spawned.length = 0; await shellTool.run({ cmd: 'touch p.txt' }, hostCtx({ projectRoot: PROJECT }));
      row('a `cd` in one project chat does not move another chat in the same project', spawned[0] && spawned[0].cwd === PROJECT, spawned[0] && spawned[0].cwd);
    }

    // ================= D. entry points =================
    // D1. the LOOP driver hands its folder to the run (it told the agent "you work in <folder>" and gave the tools none)
    {
      const calls = [];
      let loops = LoopStore.createLoop([], { id: 'l1', objective: 'tidy the repo', agentId: AID, workdir: PROJECT }, { now: 1700006400000 });
      const drv = makeLoopDriver({
        getLoops: () => loops, setLoops: (next) => { loops = next; return true; },
        runOnce: (o) => { calls.push(o); return new Promise(() => {}); },
        newId: () => 'loop-run-1', newAbort: () => { const s = { aborted: false }; return { signal: s, abort() { s.aborted = true; } }; },
        now: () => 1700006400000, isHalted: () => false, concurrencyFree: () => true, defaultModel: 'm', persona: 'P',
        projectLine: (l) => l.workdir ? '\n\nPROJECT FOLDER: ' + l.workdir : '', ledger: () => {}
      });
      drv.applyTick(1700006400000);
      await new Promise(r => setImmediate(() => setImmediate(r)));
      const opts = calls[0] || {};
      row('LOOP entry: the run is handed the loop\'s folder as its projectRoot', opts.projectRoot === PROJECT, String(opts.projectRoot));
      // and the run built from those opts resolves where the loop's prompt says it works
      const loopCtx = hostCtx({ projectRoot: opts.projectRoot || '', workdir: opts.workdir || '' });
      const n = freshName('loop'); await attempt(() => fsTools.writeTool.run({ path: n, content: 'x' }, loopCtx));
      row('LOOP entry: fs.write in a loop lands in the loop\'s folder', fs.existsSync(path.join(PROJECT, n)));
      const t = await attempt(() => shellTool.run({ cmd: 'test -f ' + n }, loopCtx));
      row('LOOP entry: fs.write -> shell test -f', t.ok && /\[exit 0\]/.test(String(t.v.content)));
    }
    // D2. a delegated worker inherits the lead's folder from the lead's run path object
    {
      const runs = [];
      const { dispatchTool } = makeOrchestrationTools({ runOnce: async (o) => { runs.push(o); return { reason: 'done', text: 'ok' }; }, roster: () => new Map([['helper', { system: 'S', name: 'HELPER' }]]), key: 'k', model: 'm', perWorker: 1, newId: () => 'w' + runs.length });
      const lead = hostCtx({ projectRoot: PROJECT, workdir: PROJECT });
      delete lead.projectRoot;   // the path object alone must carry the scope
      await attempt(() => dispatchTool.run({ workers: [{ agentId: 'helper', prompt: 'help' }] }, Object.assign(lead, { signal: { aborted: false }, consent: { _isLeadConsent: true } })));
      row('WORKER entry: team.dispatch hands the worker the lead\'s project root from ctx.paths', runs[0] && runs[0].projectRoot === PROJECT, runs[0] && runs[0].projectRoot);
      row('WORKER entry: and the lead\'s routine folder', runs[0] && runs[0].workdir === PROJECT, runs[0] && runs[0].workdir);
    }
    // D3. the host: runOnce mints ONE path object into the tool ctx, and its own path consumers read it
    {
      const src = readSidecarSource();
      const core = sidecarTopLevelFunction('runOnceCore') || '';
      row('HOST: runOnce mints the run path object (RunPaths.makeRunPaths)', /RunPaths\.makeRunPaths\(/.test(core));
      row('HOST: the tool ctx carries it as ctx.paths', /\bpaths: runPaths\b/.test(core));
      row('HOST: projectCwd is gone from the tool ctx', !/\bprojectCwd:/.test(core));
      row('HOST: the park pointer is placed by the run path object', /parked\.path = runPaths\.placeJail\(parked\.path\)/.test(core));
      row('HOST: the postcondition reader resolves through the run path object', /readPostconditionArtifact[\s\S]{0,400}runPaths\.resolve\(requirement\.path/.test(core));
      row('HOST: a project chat\'s attachment note is placed by the same rule', /expandUserAttachments\(messages, agentId, attachPlace/.test(src));
      row('TOOLS: no sidecar code reads ctx.projectCwd', !/ctx\.projectCwd/.test(src));
    }
  } finally {
    fs.rmSync(BASE, { recursive: true, force: true });
  }
  const failed = rows.filter(r => !r.pass);
  console.log('path coherence: ' + (rows.length - failed.length) + '/' + rows.length + ' rows hold' + (failed.length ? '; failing:\n  ' + failed.map(r => r.name).join('\n  ') : ''));
  A.report('path-coherence.contract');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
