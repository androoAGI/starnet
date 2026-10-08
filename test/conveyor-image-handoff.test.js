/* node test/conveyor-image-handoff.test.js — issue #88: an image one Conveyor stage MAKES is readable by the next
   stage of the same project-bound line.

   The report (v0.13.1): on a line bound to a trusted project, Production's image_generate {path:"handoff-002.png"}
   succeeded but pointed at /api/file?agent=designer&path=…; the next stage's fs_read / fs_search / directory list
   could not find it in the project, and a retry with an absolute project path answered "illegal path". Same root
   cause as #77 (the media tools resolved through a jail with no project awareness), fixed by 63607af5c — but that
   fix's test only drove a DELEGATED worker. A Conveyor stage reaches the tools by a different seam:

     line.projectRoot ──runOnceCore──▶ o.projectRoot ──dispatch ctx──▶ ctx.projectRoot ──▶ image/fs tools

   So this test pins BOTH halves: (A) the sidecar seam, source-locked, and (B) the stage-to-stage hand-off over the
   real tools with the ctx a line stage gets. Hermetic: real temp dirs, the REAL path-trust core with the project
   as the one blessed root, an injected image fetch. No network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');

// ---- A. the seam: a line stage's run carries the line's project into every tool's ctx ----
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const SRC = stripComments(fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8'));
const core0 = SRC.indexOf('async function runOnceCore(');
A.ok(core0 > 0, 'runOnceCore exists in sidecar/index.js');
const head = SRC.slice(core0, core0 + 2500);
A.ok(/if \(line\.projectRoot\) \{[\s\S]{0,200}o = \{ \.\.\.o, workdir: root, projectRoot: root \}/.test(head),
  'runOnceCore stamps a project-bound line\'s projectRoot onto the stage run (line.projectRoot → o.projectRoot)');
A.ok(/projectRoot: o\.projectRoot \|\| null,/.test(SRC),
  'the tool dispatch ctx carries the run\'s projectRoot (o.projectRoot → ctx.projectRoot)');

// ---- B. the hand-off over the real tools ----
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-issue88-handoff-'));
const WORKSPACES = path.join(BASE, 'workspaces');
const PROJECT = path.join(BASE, 'ShopLine');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const imageFetch = async () => ({
  status: 200,
  json: async () => ({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }] }),
  headers: { get: () => 'application/json' }
});

(async () => {
  fs.mkdirSync(WORKSPACES, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  for (const a of ['designer', 'reviewer']) fs.mkdirSync(path.join(WORKSPACES, a), { recursive: true });
  const projectReal = fs.realpathSync(PROJECT);
  // a Conveyor stage runs with no one to prompt — the autonomous surface, like production's runPathTrust for a line run
  const core = makePathTrust({ fsp, pathMod: path, roots: () => [projectReal], workspaceRoot: WORKSPACES });
  const pathTrust = (abs, o2) => core.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: o2 && o2.agentId });
  const image = makeImageTools({ openrouter: { apiKey: 'sk-test' }, fsp, pathMod: path, root: WORKSPACES, fetchImpl: imageFetch, pathTrust, auxVision: async () => 'a red square' });
  const fsTools = makeFsTools({ fsp, pathMod: path, root: WORKSPACES, pathTrust });

  // the ctx each stage gets: its own agent, the LINE's project, its line + bay
  const stage = (agentId, dockId) => ({ agentId, projectRoot: projectReal, lineId: 'line-shop', dockId, emit: () => {} });
  const production = stage('designer', 'dock-production');
  const review = stage('reviewer', 'dock-review');

  // Production makes the image with a project-relative path
  const gen = await image.generateTool.run({ prompt: 'product mockup', path: 'handoff-002.png' }, production);
  const inProject = path.join(projectReal, 'handoff-002.png');
  A.ok(fs.existsSync(inProject), 'Production\'s image_generate("handoff-002.png") lands in the line\'s project folder');
  A.ok(!fs.existsSync(path.join(WORKSPACES, 'designer', 'handoff-002.png')), 'and not in Production\'s private workspace (the reported bug)');
  A.ok(gen.content.indexOf('Saved at: ' + inProject) >= 0, 'the receipt names the project location: ' + gen.content);
  A.ok(gen.content.indexOf('&project=' + encodeURIComponent(path.resolve(projectReal))) >= 0,
    'the viewer URL opens the PROJECT copy (?project=), not the bare agent-scoped one the report saw');

  // the next stage finds it every way the report tried
  let read = null, readErr = null;
  try { read = await fsTools.readTool.run({ path: 'handoff-002.png' }, review); } catch (e) { readErr = e; }
  A.ok(read && !readErr, 'Review\'s fs_read("handoff-002.png") finds it: ' + (readErr && readErr.message));
  const found = await fsTools.searchTool.run({ query: 'handoff-002.png', target: 'files' }, review);
  A.ok(/handoff-002\.png/.test(found.content), 'Review\'s fs_search for the file finds it: ' + found.content);
  const listed = await fsTools.listTool.run({}, review);
  A.ok(listed.content.split('\n').includes('handoff-002.png'), 'listing the project shows it: ' + listed.content);
  const seen = await image.analyzeTool.run({ image: 'handoff-002.png', prompt: 'what is it?' }, review);
  A.ok(/red square/.test(seen.content), 'Review\'s image_analyze("handoff-002.png") reads the project copy');

  // the report's retry: an ABSOLUTE trusted-project path is accepted, not "illegal path"
  let abs = null, absErr = null;
  try { abs = await image.generateTool.run({ prompt: 'v2', path: path.join(projectReal, 'renders', 'handoff-003.png') }, production); } catch (e) { absErr = e; }
  A.ok(abs && !absErr && fs.existsSync(path.join(projectReal, 'renders', 'handoff-003.png')),
    'an absolute path inside the line\'s trusted project saves there: ' + (absErr && absErr.message));
  let absRead = null;
  try { absRead = await fsTools.readTool.run({ path: 'renders/handoff-003.png' }, review); } catch (_) {}
  A.ok(!!absRead, 'and the next stage reads it project-relative');

  // still project-scoped: a stage cannot write outside its line's project
  let escaped = null;
  try { await image.generateTool.run({ prompt: 'x', path: '../escape.png' }, production); } catch (e) { escaped = e; }
  A.ok(escaped && !fs.existsSync(path.join(BASE, 'escape.png')), 'a ".." path cannot leave the line\'s project');

  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
  A.report('conveyor-image-handoff.test');
})().catch(e => { console.log('FAIL: conveyor-image-handoff.test threw — ' + (e && e.stack || e)); process.exit(1); });
