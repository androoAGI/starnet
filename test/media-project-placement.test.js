/* node test/media-project-placement.test.js — issue #77: a file a delegated Creator MAKES (image_generate /
   voice_generate) lands where its lead can read it.

   The report: in a Supervisor's project conversation ("YoutubeService", trusted), a dispatched Creator ran
   image_generate {path:"thumbnail-test-v1.png"}; it succeeded and pointed at /api/file?agent=designer&path=…, the
   Supervisor's fs_read {path:"thumbnail-test-v1.png"} in the project answered "no such file", and only moving the PNG
   by hand made it readable. The media tools resolved paths through a jail with NO project awareness and no path
   trust, while fs.* roots relative paths at ctx.projectRoot (#60). Fixed: the same jail, the same rule.

   Hermetic: real temp dirs, the REAL path-trust core (sidecar/pathtrust.js) with the project as the one blessed
   root, the real fs.* tools for the Supervisor, an injected image fetch and speech synth. No network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');
const { makeVoiceTools } = require('../sidecar/tools/builtin/voice.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makePathTrust } = require('../sidecar/pathtrust.js');

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-issue77-media-'));
const WORKSPACES = path.join(BASE, 'workspaces');
const PROJECT = path.join(BASE, 'YoutubeService');
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x21, 0x22, 0x23]);

const imageFetch = async (url) => ({
  status: 200,
  json: async () => ({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }] }),
  headers: { get: () => 'application/json' }
});

(async () => {
  fs.mkdirSync(WORKSPACES, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACES, 'supervisor'), { recursive: true });   // every roster agent has its workspace
  const projectReal = fs.realpathSync(PROJECT);
  // the station's path-trust core, with YoutubeService as the one trusted ("My Project Folders") root; a delegated
  // worker is an autonomous surface with no prompt, exactly like production's runPathTrust for a worker run
  const core = makePathTrust({ fsp, pathMod: path, roots: () => [projectReal], workspaceRoot: WORKSPACES });
  const pathTrust = (abs, o2) => core.guard(abs, { scope: (o2 && o2.scope) || 'read', surface: 'autonomous', agentId: o2 && o2.agentId });
  const auxVision = async () => 'a red square';

  const image = makeImageTools({ openrouter: { apiKey: 'sk-test' }, fsp, pathMod: path, root: WORKSPACES, fetchImpl: imageFetch, pathTrust, auxVision });
  const voice = makeVoiceTools({ synth: async () => ({ ok: true, buf: MP3, ext: 'mp3', mime: 'audio/mpeg', provider: 'edge' }), fsp, pathMod: path, root: WORKSPACES, pathTrust });
  const supervisorFs = makeFsTools({ fsp, pathMod: path, root: WORKSPACES, pathTrust });

  // ---- A. the reported flow: Creator (designer) in the project scope, relative path ----
  const emits = [];
  const creatorCtx = { agentId: 'designer', projectRoot: PROJECT, emit: (n, p) => emits.push({ n, p }) };
  const gen = await image.generateTool.run({ prompt: 'a youtube thumbnail', path: 'thumbnail-test-v1.png' }, creatorCtx);
  const inProject = path.join(PROJECT, 'thumbnail-test-v1.png');
  A.ok(fs.existsSync(inProject), 'image_generate with a relative path in a project-scoped run lands IN the project folder');
  A.ok(!fs.existsSync(path.join(WORKSPACES, 'designer', 'thumbnail-test-v1.png')), 'and not in the Creator\'s private workspace (the reported bug)');
  A.ok(gen.content.indexOf('Saved at: ' + inProject) >= 0, 'the receipt names the absolute location: ' + gen.content);
  A.ok(/project folder/.test(gen.content) && gen.content.indexOf('reads it as "thumbnail-test-v1.png"') >= 0, 'the receipt says it is in the project and how a teammate reads it');
  A.ok(gen.content.indexOf('&project=' + encodeURIComponent(path.resolve(PROJECT))) >= 0, 'the viewer URL opens the PROJECT copy (/api/file ?project=), not the private workspace');
  A.eq(gen.summary, 'image → thumbnail-test-v1.png', 'the summary artifacts.js parses is unchanged (relative path; the library adds ?project=)');
  A.ok(emits.some(e => e.n === 'deliverable' && e.p.agentId === 'designer'), 'the deliverable is still emitted');

  // ---- B. the Supervisor's fs_read from the same project finds it (the reported "no such file") ----
  const supervisorCtx = { agentId: 'supervisor', projectRoot: PROJECT };
  let read = null, readErr = null;
  try { read = await supervisorFs.readTool.run({ path: 'thumbnail-test-v1.png' }, supervisorCtx); } catch (e) { readErr = e; }
  A.ok(read && !readErr, 'the Supervisor fs_read("thumbnail-test-v1.png") in YoutubeService finds the Creator\'s image: ' + (readErr && readErr.message));
  // and image_analyze resolves the same relative path in the same place
  const seen = await image.analyzeTool.run({ image: 'thumbnail-test-v1.png', prompt: 'what is it?' }, supervisorCtx);
  A.ok(/red square/.test(seen.content), 'the Supervisor image_analyze("thumbnail-test-v1.png") reads the project copy');

  // ---- C. voice_generate: the same rule ----
  const v = await voice.generateTool.run({ text: 'intro line', path: 'audio/intro' }, creatorCtx);
  A.ok(fs.existsSync(path.join(PROJECT, 'audio', 'intro.mp3')), 'voice_generate with a relative path in a project-scoped run lands in the project folder');
  A.ok(v.content.indexOf('Saved at: ' + path.join(PROJECT, 'audio', 'intro.mp3')) >= 0, 'its receipt names the absolute location');

  // ---- D. no project scope: private workspace, said plainly, with the export route ----
  const priv = await image.generateTool.run({ prompt: 'a scratch sketch', path: 'sketch.png' }, { agentId: 'designer' });
  const privAbs = path.join(WORKSPACES, 'designer', 'sketch.png');
  A.ok(fs.existsSync(privAbs), 'unscoped: the image saves in the private workspace (unchanged)');
  A.ok(priv.content.indexOf('Saved at: ' + privAbs) >= 0 && /PRIVATE workspace/.test(priv.content), 'unscoped: the receipt says PRIVATE workspace with the absolute path');
  A.ok(/cannot read it there/.test(priv.content) && /absolute path inside that project/.test(priv.content), 'unscoped: the receipt says a lead cannot read it and how to save into a project instead');
  A.ok(priv.content.indexOf('/api/file?agent=designer&path=sketch.png') >= 0, 'unscoped: the viewer URL is the private one');
  const vp = await voice.generateTool.run({ text: 'scratch take' }, { agentId: 'designer' });
  A.ok(/PRIVATE workspace/.test(vp.content), 'unscoped voice_generate says PRIVATE workspace too');

  // ---- E. the export route the private receipt names: an absolute path inside the trusted project ----
  const exported = await image.generateTool.run({ prompt: 'final art', path: path.join(PROJECT, 'final.png') }, { agentId: 'designer' });
  A.ok(fs.existsSync(path.join(PROJECT, 'final.png')), 'an absolute path inside the trusted project saves there, from any conversation');
  A.ok(exported.content.indexOf('&project=') >= 0, 'and the viewer opens it through the project');

  // ---- F. still project-scoped, never whole-computer ----
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-issue77-untrusted-'));
  let denied = null;
  try { await image.generateTool.run({ prompt: 'x', path: path.join(outside, 'leak.png') }, { agentId: 'designer' }); } catch (e) { denied = e; }
  A.ok(denied && !fs.existsSync(path.join(outside, 'leak.png')), 'an absolute path in an UNtrusted folder is refused (no whole-computer access): ' + (denied && denied.message));
  let escaped = null;
  try { await image.generateTool.run({ prompt: 'x', path: '../escape.png' }, creatorCtx); } catch (e) { escaped = e; }
  A.ok(escaped && !fs.existsSync(path.join(BASE, 'escape.png')), 'a ".." path cannot leave the project');
  let crossAgent = null;
  try { await supervisorFs.readTool.run({ path: privAbs }, supervisorCtx); } catch (e) { crossAgent = e; }
  A.ok(crossAgent && /another agent workspace/.test(crossAgent.message), 'another agent\'s PRIVATE workspace stays unreadable (why the receipt says so): ' + (crossAgent ? crossAgent.message : 'read succeeded'));

  // ---- G. no pathTrust wired (bare rigs/tests): the historic private jail, unchanged ----
  const bare = makeImageTools({ openrouter: { apiKey: 'sk-test' }, fsp, pathMod: path, root: WORKSPACES, fetchImpl: imageFetch });
  let bareErr = null;
  try { await bare.generateTool.run({ prompt: 'x', path: 'p.png' }, creatorCtx); } catch (e) { bareErr = e; }
  A.ok(bareErr && /project trust guard/.test(bareErr.message), 'without a trust guard a project-scoped write refuses rather than silently landing privately');

  try { fs.rmSync(outside, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
  A.report('media-project-placement.test');
})().catch(e => { console.log('FAIL: media-project-placement.test threw — ' + (e && e.stack || e)); process.exit(1); });
