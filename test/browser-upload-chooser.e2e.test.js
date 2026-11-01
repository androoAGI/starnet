/* #104, the second report: browser.upload on a visible upload BUTTON reported success and the Etsy photo stayed empty.
   Real Chromium, local fixture pages only: Etsy itself cannot be tested here, and nothing here claims it works.
   Before the fix the button's nearest container decided the input, by position:
     /decoy    the section holds a hidden decoy input; the button opens the REAL one elsewhere, which alone has a listener.
               The decoy took the file, read back "selected", and the page saw nothing.
     /made     the button makes its input in its click handler, as uploader libraries do. Position found nothing.
     /video    a photo into accept="video/*" (the only nearby input) read back "selected".
     /deaf     an input no script listens on: still "selected", but the receipt now says the page did not react. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

const BTN = '<button id="b" style="display:inline-block;width:220px;height:40px">CHOOSE PHOTO</button>';
const SEEN = 'window.seen=[];const heard=e=>{window.seen.push({id:e.target.id,files:Array.from(e.target.files,f=>f.name)});document.getElementById("thumbs").textContent="thumb";};';
const pages = {
  '/decoy': '<section>' + BTN + '<input id="decoy" type="file" hidden></section><div><input id="real" type="file" hidden></div><div id="thumbs"></div>'
    + '<script>' + SEEN + 'const real=document.getElementById("real");real.addEventListener("change",heard);document.getElementById("b").addEventListener("click",()=>real.click());</script>',
  '/made': '<section>' + BTN + '</section><div id="thumbs"></div>'
    + '<script>' + SEEN + 'document.getElementById("b").addEventListener("click",()=>{const i=document.createElement("input");i.type="file";i.id="made";i.addEventListener("change",heard);i.click();});</script>',
  '/video': '<section>' + BTN + '<input id="clip" type="file" accept="video/*" hidden></section><script>window.seen=[];document.getElementById("clip").addEventListener("change",e=>window.seen.push(e.target.id));</script>',
  '/deaf': '<section>' + BTN + '<input id="quiet" type="file" hidden></section>',
  '/none': '<section>' + BTN + '</section>'
};

(async () => {
  const found = T.findChrome();
  if (!found) { console.log('browser-upload-chooser.e2e: SKIPPED — no Chromium installed'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-chooser-'));
  const project = path.join(scratch, 'project'), workspace = path.join(scratch, 'workspaces'), stagingBase = path.join(scratch, 'staging');
  fs.mkdirSync(project); fs.mkdirSync(path.join(workspace, 'agent'), { recursive: true }); fs.mkdirSync(stagingBase);
  fs.writeFileSync(path.join(project, 'photo.png'), 'PNG BYTES');
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><body>' + (pages[req.url] || '') + '</body>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const driver = T.makeCdpDriver({ chrome: typeof found === 'string' ? found : found.path, forceHeadless: true, syntheticInputOnly: true, profileDir: path.join(scratch, 'chrome'), cdpPort: 0, timeoutMs: 20000 });
  driver.allowLocal(base);
  const approved = async abs => {
    const rel = path.relative(fs.realpathSync.native(project), abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside trusted project');
    return { base: project, abs };
  };
  const egress = require('../sidecar/egress-files.js').makeEgressReader({ fsp, pathMod: path, workspaces: workspace, guard: approved, tmpdir: stagingBase });
  const browser = makeBrowserTools({ driver, fsp, pathMod: path, root: workspace, egress });
  const tool = browser.tools.find(t => t.name === 'browser.upload');
  const ctx = { agentId: 'agent', projectRoot: project };
  const upload = async route => {
    await browser.session.navigate(base + route, { local: true, visible: false });
    const n = (await browser.session.snapshot(80)).find(x => /CHOOSE PHOTO/.test(x.text || ''));
    if (!n) throw new Error('fixture control missing: ' + route);
    return tool.run({ ref: n.ref, paths: ['photo.png'] }, ctx);
  };
  const refusal = async route => { try { await upload(route); return ''; } catch (e) { return String(e.message); } };
  try {
    let r = await upload('/decoy');
    A.eq(await driver.testEval('window.seen'), [{ id: 'real', files: ['photo.png'] }], 'the input the button opens gets the file, and the page hears it');
    A.eq(await driver.testEval('document.getElementById("decoy").files.length'), 0, 'the nearby decoy gets nothing (was: it took the file)');
    A.ok(/"id":"real"/.test(r.content) && /the file chooser the page opened/.test(r.content), 'the receipt names the input and how it was found: ' + r.content.slice(0, 400));
    A.ok(!/DID NOT REACT/.test(r.content) && !/found by position/.test(r.content), 'a page that reacted reads clean');
    A.ok(/not verified/i.test(r.content), 'still no claim that a server received it');

    r = await upload('/made');
    A.eq(await driver.testEval('window.seen'), [{ id: 'made', files: ['photo.png'] }], 'an input the click itself makes gets the file (was: refused, none nearby)');
    A.ok(/selected/.test(r.summary), 'and that reads as selected: ' + r.summary);

    const refused = await refusal('/video');
    A.ok(/accepts video\/\*, not photo\.png/.test(refused), 'a photo into a video-only input is refused: ' + refused);
    A.eq(await driver.testEval('window.seen.length'), 0, 'and the input never fired');
    A.eq(await driver.testEval('document.getElementById("clip").files.length'), 0, 'and holds nothing');

    r = await upload('/deaf');
    A.ok(/selected/.test(r.summary) && /the page did not react/.test(r.summary), 'a page that ignores the selection says so in the summary: ' + r.summary);
    A.ok(/THE PAGE DID NOT REACT/.test(r.content) && /found by position/.test(r.content), 'and the receipt tells the agent not to report it attached: ' + r.content.slice(0, 500));
    A.ok(/"domChanges":0/.test(r.content) && /"requests":0/.test(r.content), 'the numbers are in the readback');

    const none = await refusal('/none');
    A.ok(/opened no file chooser/.test(none) && /no associated file input/.test(none), 'no chooser and no input refuses and says it clicked: ' + none);

    // the interception ended with that one click: a page's own later chooser is not swallowed by a stale interception
    await browser.session.navigate(base + '/deaf', { local: true, visible: false });
    A.eq(await driver.testEval('document.getElementById("quiet").files.length'), 0, 'a fresh page holds nothing');
    await browser.releaseUploads();
    console.log('UPLOAD_CHOOSER_RECEIPT ' + JSON.stringify({ deaf: r.content.slice(0, 600) }));
  } finally {
    let closeError = null;
    try { await driver.close(); } catch (e) { closeError = e; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (closeError) throw closeError;
    if (path.dirname(scratch) === path.resolve(os.tmpdir())) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  A.report('browser-upload-chooser.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
