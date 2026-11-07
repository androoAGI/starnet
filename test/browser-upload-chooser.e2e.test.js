/* #104, the second report: browser.upload on a visible upload BUTTON reported success and the Etsy photo stayed empty.
   Real Chromium, local fixture pages only: Etsy itself cannot be tested here, and nothing here claims it works.
   Before the fix the button's nearest container decided the input, by position:
     /decoy    the section holds a hidden decoy input; the button opens the REAL one elsewhere, which alone has a listener.
               The decoy took the file, read back "selected", and the page saw nothing.
     /made     the button makes its input in its click handler, as uploader libraries do. Position found nothing.
     /video    a photo into accept="video/*" (the only nearby input) read back "selected".
     /deaf     an input no script listens on: still "selected", but the receipt now says the page did not react.
   Review of the first fix (a click on ANY ref was a new way to act on a page):
     /posted   a form's submit button beside its input: clicking it sent an empty POST and navigated. Never clicked now.
     /publish  PUBLISH LISTING beside a file input: clicking it fired POST /publish. Never clicked now.
     /jump     a type=button UPLOAD control that navigates: refused, naming the click, never "selected" on the new page.
     /confirm  a confirm() in the click: wedged the tool for 40 s. Dismissed and refused, and the page answers again at once.
     /slow     a change handler whose POST is still in flight at the readback: not "did not react".
     /framed   an input in a same-origin iframe whose thumbnail lands in the parent: not "did not react". */
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
  '/none': '<section>' + BTN + '</section>',
  '/posted': '<form method="post" action="/sent"><input id="fi" type="file"><button id="b">UPLOAD PHOTO</button></form>',
  '/publish': '<section><input id="fi" type="file"><button id="b" onclick="fetch(\'/publish\',{method:\'POST\'})">PUBLISH LISTING</button></section>',
  '/jump': '<section><button id="b" type="button" onclick="location.href=\'/elsewhere\'">UPLOAD PHOTO</button></section>',
  '/elsewhere': '<section><input id="other" type="file"></section>',
  '/confirm': '<section><button id="b" type="button" onclick="confirm(\'really?\')">UPLOAD PHOTO</button><input id="fi" type="file" hidden></section>',
  '/slow': '<section><input id="fi" type="file"></section><label for="fi">CHOOSE PHOTO</label><script>document.getElementById("fi").addEventListener("change",()=>{fetch("/hold",{method:"POST"});});</script>',
  '/framed': '<iframe id="f" width="400" height="120" srcdoc="<label for=i>CHOOSE PHOTO</label><input id=i type=file onchange=&quot;parent.document.getElementById(\'thumbs\').textContent=\'thumb\'&quot;>"></iframe><div id="thumbs"></div>'
};

(async () => {
  const found = T.findChrome();
  if (!found) { console.log('browser-upload-chooser.e2e: SKIPPED — no Chromium installed'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-chooser-'));
  const project = path.join(scratch, 'project'), workspace = path.join(scratch, 'workspaces'), stagingBase = path.join(scratch, 'staging');
  fs.mkdirSync(project); fs.mkdirSync(path.join(workspace, 'agent'), { recursive: true }); fs.mkdirSync(stagingBase);
  fs.writeFileSync(path.join(project, 'photo.png'), 'PNG BYTES');
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts.push(req.url);
    if (req.url === '/hold') return;   // answered by server.closeAllConnections at teardown: in flight for the whole run
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta charset="utf-8"><body>' + (pages[req.url] || '') + '</body>');
  });
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
    const n = (await browser.session.snapshot(80)).find(x => /CHOOSE PHOTO|UPLOAD PHOTO|PUBLISH LISTING/.test(x.text || ''));
    if (!n) throw new Error('fixture control missing: ' + route);
    return tool.run({ ref: n.ref, paths: ['photo.png'] }, ctx);
  };
  const refusal = async route => { try { await upload(route); return ''; } catch (e) { return String(e.message); } };
  /* A KILLED CHROMIUM CAN TAKE A MINUTE OR MORE TO LET GO ON A BUSY WINDOWS BOX (measured 2026-11-01; the full account is in
     browser-upload.e2e.test.js, which this teardown copies). driver.close() waits 8 s (production's bound, pinned in
     browser-close-cleanup), then rejects and keeps ownership; this fixture then waits for the driver to see the exit and
     closes again to prove it, without killing again. A helper can still hold the profile's files after that, so the Windows
     removal starts over while a file is held. Both share one bound; a Chromium or a file still held at it fails this step. */
  const LET_GO_BOUND_MS = 300000, LET_GO_POLL_MS = 500;
  let letGoDeadline = null;
  const waitToLetGo = async () => {
    if (letGoDeadline === null) letGoDeadline = Date.now() + LET_GO_BOUND_MS;
    if (Date.now() >= letGoDeadline) return false;
    await new Promise(r => setTimeout(r, LET_GO_POLL_MS));
    return true;
  };
  const closeDriver = async () => {
    try { return await driver.close(); }
    catch (e) {
      if (!/owned Chromium did not exit/.test(e.message)) throw e;
      const from = Date.now();
      while (driver.ownedPid()) if (!(await waitToLetGo())) throw e;
      console.log('[teardown] Chromium left ' + Math.round((Date.now() - from) / 1000) + ' s after driver.close gave up on it');
    }
    return driver.close();
  };
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

    // the review's regressions, in real Chromium
    r = await upload('/posted');
    A.eq(posts, [], 'a form\'s submit button is not clicked: no POST');
    A.eq(await driver.testEval('location.pathname'), '/posted', 'and no navigation');
    A.eq(await driver.testEval('document.getElementById("fi").files.length'), 1, 'the input beside it takes the file, unclicked');
    A.ok(/found by position/.test(r.content) && !/was clicked/.test(r.content), 'and the receipt says position, and no click: ' + r.content.slice(0, 300));

    r = await upload('/publish');
    A.eq(posts, [], 'PUBLISH LISTING is not clicked');
    A.eq(await driver.testEval('document.getElementById("fi").files.length'), 1, 'the nearby input takes the file');

    const jumped = await refusal('/jump');
    A.ok(/was clicked/.test(jumped) && /navigated/.test(jumped) && /no file was selected/.test(jumped), 'a click that navigates is refused and named: ' + jumped);
    A.eq(await driver.testEval('location.pathname'), '/elsewhere', 'the fixture did navigate');
    A.eq(await driver.testEval('document.getElementById("other").files.length'), 0, 'and the new page\'s input got nothing (was: "selected 1 file(s)")');

    const started = Date.now();
    const asked = await refusal('/confirm');
    A.ok(/was clicked/.test(asked) && /confirm dialog/.test(asked) && /dismissed/.test(asked), 'a dialog from the click is refused and named: ' + asked);
    A.ok(Date.now() - started < 30000, 'well under the 40 s wedge: ' + (Date.now() - started) + ' ms');
    A.eq(await driver.testEval('1+1'), 2, 'and the page answers right after');
    A.eq(await driver.testEval('document.getElementById("fi").files.length'), 0, 'and nothing was selected');

    r = await upload('/slow');
    A.ok(posts.includes('/hold'), 'the fixture\'s POST left');
    A.ok(!/DID NOT REACT/.test(r.content) && /"requests":[1-9]/.test(r.content), 'a POST still in flight is the page reacting: ' + r.content.slice(0, 500));

    r = await upload('/framed');
    A.eq(await driver.testEval('document.getElementById("thumbs").textContent'), 'thumb', 'the fixture\'s thumbnail landed in the parent');
    A.ok(!/DID NOT REACT/.test(r.content), 'a same-origin parent reacting is the page reacting: ' + r.content.slice(0, 500));

    // the interception ended with the click that used it: a later real click's chooser is no longer intercepted by anyone.
    // Chrome reports Page.fileChooserOpened only while interception is on, so the count proves it from both sides.
    const seenSoFar = driver.chooserEventCount();
    A.ok(seenSoFar >= 2, 'the counter saw the choosers the uploads opened: ' + seenSoFar);
    await browser.session.navigate(base + '/decoy', { local: true, visible: false });
    const later = (await browser.session.snapshot(80)).find(x => /CHOOSE PHOTO/.test(x.text || ''));
    await browser.session.click(later.ref);
    A.eq(driver.chooserEventCount(), seenSoFar, 'a later click on the same kind of button is not intercepted');
    await browser.releaseUploads();
    console.log('UPLOAD_CHOOSER_RECEIPT ' + JSON.stringify({ deaf: r.content.slice(0, 600) }));
  } finally {
    let closeError = null;
    try { await closeDriver(); } catch (e) { closeError = e; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (closeError) throw closeError;
    // Chrome's main process exiting does not end its utility processes (a StorageService one held the profile past 11 s on
    // a loaded box, measured 2026-11-01). On Windows the removal starts over while a file is held, inside the bound above;
    // elsewhere about a minute of linear backoff. A lock that outlasts either still fails this step.
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('starnet-upload-chooser-')) {
      if (process.platform === 'win32') {
        const from = Date.now();
        let held = null;
        for (;;) {
          try { fs.rmSync(scratch, { recursive: true, force: true }); break; }
          catch (e) {
            if (!/^(EBUSY|EPERM|ENOTEMPTY)$/.test(e.code) || !(await waitToLetGo())) throw e;
            held = held || e;
          }
        }
        if (held) console.log('[teardown] scratch removed after ' + Math.round((Date.now() - from) / 1000) + ' s: ' + held.code + ' on ' + held.path);
      } else {
        try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 24, retryDelay: 200 }); }
        catch (e) { if (e.code !== 'ENOTEMPTY') throw e; console.log('[teardown] Chrome still writes ' + e.path + ' after a minute: this scratch stays in the temp folder'); }
      }
    }
  }
  A.report('browser-upload-chooser.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
