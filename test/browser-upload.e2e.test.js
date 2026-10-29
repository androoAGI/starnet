/* #104: real Chromium file-selection proof, local fixtures only; no external form submission. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

(async () => {
  const found = T.findChrome();
  if (!found) { console.log('browser-upload.e2e: SKIPPED — no Chromium installed'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-live-'));
  const project = path.join(scratch, 'project'), workspace = path.join(scratch, 'workspaces');
  fs.mkdirSync(project); fs.mkdirSync(path.join(workspace, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(project, 'photo.txt'), 'PROJECT PHOTO BYTES');
  fs.writeFileSync(path.join(workspace, 'agent', 'photo.txt'), 'DECOY');
  fs.writeFileSync(path.join(project, 'second.txt'), 'SECOND');
  const file = '<input id="photo" type="file" style="position:absolute;left:-9999px">';
  const label = '<label for="photo" style="display:inline-block;width:220px;height:40px">CHOOSE PHOTO</label>';
  const pages = {
    '/label': label + file,
    '/unique': '<section><button>CHOOSE PHOTO</button>' + file + '</section>',
    '/ambiguous': '<section><button>CHOOSE PHOTO</button><input id="wrong" type="file" hidden>' + file + '</section>',
    '/disabled': label + file.replace('type="file"', 'type="file" disabled'),
    '/multiple': label + file.replace('type="file"', 'type="file" multiple'),
    '/clears': label + file + '<script>document.getElementById("photo").addEventListener("change",e=>{e.target.value="";});</script>',
    '/frame': '<iframe src="/label" style="width:600px;height:220px"></iframe>'
  };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><body>' + (pages[req.url] || pages['/label']) + '<pre id="events"></pre><script>window.selections=[];for(const type of ["input","change"])document.addEventListener(type,e=>{if(e.target.type==="file"){window.selections.push({type,id:e.target.id,files:Array.from(e.target.files,f=>({name:f.name,size:f.size}))});document.getElementById("events").textContent=JSON.stringify(window.selections);}},true);</script></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const driver = T.makeCdpDriver({ chrome: typeof found === 'string' ? found : found.path, forceHeadless: true, syntheticInputOnly: true, profileDir: path.join(scratch, 'chrome'), cdpPort: 0, timeoutMs: 20000 });
  driver.allowLocal(base);
  // an upload leaves the station: browser.upload proves it through the egress reader (run-paths review round 3), whose
  // guard is the station's root-approval check; this fixture approves the one project folder
  const approved = async abs => {
    const rel = path.relative(fs.realpathSync.native(project), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside trusted project');
    return { base: project, abs };
  };
  const egress = require('../sidecar/egress-files.js').makeEgressReader({ fsp, pathMod: path, workspaces: workspace, guard: approved });
  const browser = makeBrowserTools({ driver, fsp, pathMod: path, root: workspace, egress });
  const tool = browser.tools.find(t => t.name === 'browser.upload');
  const ctx = { agentId: 'agent', projectRoot: project };
  const open = async route => {
    await browser.session.navigate(base + route, { local: true, visible: false });
    const n = (await browser.session.snapshot(80)).find(n => /CHOOSE PHOTO/.test(n.text || ''));
    if (!n) throw new Error('fixture control missing: ' + route);
    return n.ref;
  };
  const refused = async (route, paths, pattern) => {
    const ref = await open(route);
    let error = '';
    try { await tool.run({ ref, paths }, ctx); } catch (e) { error = e.message; }
    A.ok(pattern.test(error), route + ' refuses meaningfully: ' + error);
    A.eq(await driver.testEval('selections.length'), 0, route + ' never sets an unrelated/refused file input');
  };
  try {
    let ref = await open('/label');
    const selected = await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    let events = await driver.testEval('selections');
    A.eq(events[0] && events[0].files, [{ name: 'photo.txt', size: 19 }], 'project-relative upload selects project bytes, never same-name private decoy');
    A.ok(/selected/i.test(selected.summary) && !/uploaded/i.test(selected.summary), 'summary claims file selection only');
    A.ok(/not verified|does not prove/i.test(selected.content), 'receipt does not claim remote server acceptance');
    A.ok(selected.content.includes('photo') && /19/.test(selected.content), 'receipt identifies file input and selected bytes');
    A.eq(events.map(e => e.type), ['input', 'change'], 'real browser fires input and change on selected input');
    await refused('/ambiguous', ['photo.txt'], /ambiguous|more than one|multiple file inputs/i);
    await refused('/disabled', ['photo.txt'], /disabled/i);
    await refused('/label', ['photo.txt', 'second.txt'], /multiple|one file/i);
    ref = await open('/unique');
    const unique = await tool.run({ ref, paths: [path.join(project, 'photo.txt')] }, ctx);
    A.ok(/selected/i.test(unique.summary), 'the run\'s own project file by absolute path works on unique nearby input');
    ref = await open('/multiple');
    await tool.run({ ref, paths: ['photo.txt', 'second.txt'] }, ctx);
    events = await driver.testEval('selections');
    A.eq(events[0] && events[0].files.length, 2, 'multiple input receives both requested files');
    ref = await open('/clears');
    const cleared = await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    A.ok(/cleared|no longer|not retained/i.test(cleared.content), 'framework-cleared input is disclosed, not claimed retained');
    A.ok(/not verified|does not prove/i.test(cleared.content), 'clearing is not promoted to remote upload success');
    ref = await open('/frame');
    const framed = await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    A.ok(/selected/i.test(framed.summary), 'same-origin iframe label resolves inside its document');
    A.eq(await driver.testEval('document.querySelector("iframe").contentWindow.selections[0].files[0].size'), 19, 'iframe selected correct project bytes');
    console.log('UPLOAD_LIVE_RECEIPT ' + JSON.stringify({ selected: selected.content, cleared: cleared.content }));
  } finally {
    let closeError = null;
    try { await driver.close(); }
    catch (e) { closeError = e; }
    finally {
      // The fixture must stop listening even if Chromium teardown fails. Keep the original failure
      // and leave its scratch/profile intact whenever cleanup cannot prove it is safe to remove.
      try {
        const serverClosed = new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
        server.closeAllConnections(); await serverClosed;
      } catch (e) { if (!closeError) closeError = e; else console.error('Upload fixture server cleanup failed:', e); }
    }
    if (closeError) throw closeError;
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('starnet-upload-live-')) fs.rmSync(scratch, { recursive: true, force: true });
  }
  A.report('browser-upload.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
