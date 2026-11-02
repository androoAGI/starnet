/* #104: real Chromium file-selection proof, local fixtures only; no external form submission.
   Review round 6 BLOCKER (scratchpad rr6-chrome-submit.js): Chrome reads an uploaded file at FORM SUBMIT, a later
   separate action. /form posts multipart to this same local fixture server: a normal upload then browser.click sends
   the original bytes (and the staged copy goes once the page navigated away); a hard-link swap of the staged copy to a
   secret made AFTER the selection (padded to its size, mtime aligned) refuses the click, empties the real input
   (DOM.getFileInfo by path) and nothing reaches the server. Before the fix the secret was posted.
   run-paths-polish P1 (live walk W-R7 (b) on 0.14.2): the agent selects a file and does NOT submit, the reply ends, and
   the PERSON clicks Submit. The copy was deleted at the reply end and Chrome showed ERR_FILE_NOT_FOUND; now it lives
   while its page does, the Submit posts the selected bytes, and the copy goes once that submit navigated the page away.
   Review round 7 minor 4: a busy page (its main thread spinning) reads alive at once, from Chrome's own navigation
   events, without a command to its renderer. Polish review round 1: only a browser kept past the run (the station's)
   promises a submit after the reply; a run's own browser closes at the run end, and its receipt says so.
   Codex A3-LIFE-01: an input is emptied only while it still holds the very File objects whose paths were proven,
   compared in the same page-side call that empties it; the R6 swap below proves, in real Chrome, that a selection's
   File objects keep their identity, so its input is still emptied. Test hygiene: the copies are staged in a base of
   this fixture's own scratch, never the user's real %LOCALAPPDATA%\StarNet or TEMP. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');
const { defaultStagingRoot } = require('../sidecar/egress-files.js');

(async () => {
  const found = T.findChrome();
  if (!found) { console.log('browser-upload.e2e: SKIPPED — no Chromium installed'); return; }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-live-'));
  const project = path.join(scratch, 'project'), workspace = path.join(scratch, 'workspaces'), stagingBase = path.join(scratch, 'staging');
  fs.mkdirSync(project); fs.mkdirSync(path.join(workspace, 'agent'), { recursive: true }); fs.mkdirSync(stagingBase);
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
    '/frame': '<iframe src="/label" style="width:600px;height:220px"></iframe>',
    '/form': '<form id="f" method="post" enctype="multipart/form-data" action="/posted"><label for="fi" style="display:inline-block;width:220px;height:40px">CHOOSE FILE</label>'
      + '<input id="fi" name="fi" type="file" style="position:absolute;left:-9999px"><button id="go" type="submit" style="display:inline-block;width:160px;height:40px">SEND FORM</button></form>'
  };
  const posts = [];   // what the fixture server received from /form, per POST: the "fi" part's bytes (latin1), or null
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks), m = /boundary=(.+)$/.exec(req.headers['content-type'] || '');
        let part = null;
        if (m) {
          const b = Buffer.from('--' + m[1]);
          for (let i = body.indexOf(b); i >= 0;) {
            const head = body.indexOf('\r\n\r\n', i);
            if (head < 0) break;
            const next = body.indexOf(b, head);
            if (/name="fi"/.test(body.slice(i, head).toString('latin1'))) { part = body.slice(head + 4, next < 0 ? body.length : next - 2).toString('latin1'); break; }
            i = next;
          }
        }
        posts.push(part);
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('posted');
      });
      return;
    }
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
  // TEST HYGIENE (polish review round 1): this fixture stages in-process, so its staging base is a folder of its own
  // scratch (the reader's injected base), never the user's real %LOCALAPPDATA%\StarNet or TEMP
  const egress = require('../sidecar/egress-files.js').makeEgressReader({ fsp, pathMod: path, workspaces: workspace, guard: approved, tmpdir: stagingBase });
  const browser = makeBrowserTools({ driver, fsp, pathMod: path, root: workspace, egress });
  const tool = browser.tools.find(t => t.name === 'browser.upload');
  const ctx = { agentId: 'agent', projectRoot: project };
  const open = async (route, label) => {
    await browser.session.navigate(base + route, { local: true, visible: false });
    const n = (await browser.session.snapshot(80)).find(n => (label || /CHOOSE PHOTO/).test(n.text || ''));
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
  /* A KILLED CHROMIUM CAN TAKE MINUTES TO LET GO ON A BUSY WINDOWS BOX, and this step went red with every assertion held.
     Measured 2026-11-01 with the CPU at 80-100%: a bare Chromium, no StarNet code, took 21.0, 38.3, 24.4, 22.0 and 2.6 s
     from taskkill to exit. In this step the killed processes sat at one thread and no handles for up to 71 s, the exit
     took up to 65 s, and red runs took 52-214 s against 16-32 s green. The teardown meets that twice:
     - driver.close() waits 8 s (production's bound, pinned in browser-close-cleanup), then rejects and keeps ownership, so
       only a later close that proves the exit can succeed. 6 of 9 runs ended there, and 4 of 5 on trunk. After that one
       rejection the fixture waits for the driver to see the exit and closes again to prove it. It does not kill again: the
       first close already did. Any other close failure is not waited on.
     - a helper can outlast the browser process (by 58 s and 16 s in the two runs that failed) with the profile's files
       still held, so the removal below failed with EBUSY in 2 of 10 runs. It now starts over while a file is held.
     Both share one bound. A Chromium still there at the bound, or a file still held, fails this step with that error.
     This wait is why the step is in test/slow.list. */
  const LET_GO_BOUND_MS = 300000, LET_GO_POLL_MS = 500;
  let letGoDeadline = null;
  // false once the teardown's one bound has passed; it starts at the first thing that had to be waited for
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
    let ref = await open('/label');
    const selected = await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    let events = await driver.testEval('selections');
    A.eq(events[0] && events[0].files, [{ name: 'photo.txt', size: 19 }], 'project-relative upload selects project bytes, never same-name private decoy');
    A.ok(/selected/i.test(selected.summary) && !/uploaded/i.test(selected.summary), 'summary claims file selection only');
    A.ok(/not verified|does not prove/i.test(selected.content), 'receipt does not claim remote server acceptance');
    A.ok(selected.content.includes('photo') && /19/.test(selected.content), 'receipt identifies file input and selected bytes');
    // review round 1: this tool set's OWN browser closes at the run end (index.js runOnceCore), so no later submit is promised
    A.ok(/This run browses in its own browser, which closes when this reply ends/.test(selected.content) && !/submitted after this reply/.test(selected.content),
      'rev1 (real Chrome): a run\'s own browser never promises a submit after the reply: ' + selected.content.slice(0, 200));
    A.eq(events.map(e => e.type), ['input', 'change'], 'real browser fires input and change on selected input');
    await refused('/ambiguous', ['photo.txt'], /ambiguous|more than one|multiple file inputs/i);
    await refused('/disabled', ['photo.txt'], /disabled/i);
    await refused('/label', ['photo.txt', 'second.txt'], /multiple|one file/i);
    ref = await open('/unique');
    const unique = await tool.run({ ref, paths: [path.join(project, 'photo.txt')] }, ctx);
    A.ok(/selected/i.test(unique.summary), 'the run\'s own project file by absolute path works on unique nearby input');
    ref = await open('/multiple');
    const both = await tool.run({ ref, paths: ['photo.txt', 'second.txt'] }, ctx);
    events = await driver.testEval('selections');
    A.eq(events[0] && events[0].files.length, 2, 'multiple input receives both requested files');
    A.ok(/The input holds the requested files now\./.test(both.content), 'real Chrome: two files read as plural in the receipt: ' + both.content.slice(0, 420));
    ref = await open('/clears');
    const cleared = await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    A.ok(/cleared|no longer|not retained/i.test(cleared.content), 'framework-cleared input is disclosed, not claimed retained');
    A.ok(/not verified|does not prove/i.test(cleared.content), 'clearing is not promoted to remote upload success');
    ref = await open('/frame');
    const framed = await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    A.ok(/selected/i.test(framed.summary), 'same-origin iframe label resolves inside its document');
    A.eq(await driver.testEval('document.querySelector("iframe").contentWindow.selections[0].files[0].size'), 19, 'iframe selected correct project bytes');
    // ---- review round 6 BLOCKER: the bytes are read at SUBMIT; a swap after the selection must never be posted ----
    const click = browser.tools.find(t => t.name === 'browser.click');
    const sendRef = async () => { const n = (await browser.session.snapshot(80)).find(x => /SEND FORM/.test(x.text || '')); if (!n) throw new Error('SEND FORM missing'); return n.ref; };
    const STAGE = path.join(defaultStagingRoot(path, workspace, stagingBase), 'agent');
    A.ok(path.resolve(STAGE).startsWith(path.resolve(scratch) + path.sep), 'test hygiene: the copies are staged inside this fixture\'s own scratch: ' + STAGE);
    const copies = () => (fs.existsSync(STAGE) ? fs.readdirSync(STAGE) : []).map(d => path.join(STAGE, d, 'photo.txt')).filter(p => fs.existsSync(p));
    // control: a normal upload then a click posts the ORIGINAL bytes, and the copy goes once the page navigated away
    ref = await open('/form', /CHOOSE FILE/);
    await browser.releaseUploads();
    await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    A.eq(copies().length, 1, 'R6 control: one staged copy is live after the selection');
    posts.length = 0;
    await click.run({ ref: await sendRef() }, ctx);
    for (let i = 0; i < 50 && !posts.length; i++) await new Promise(r => setTimeout(r, 100));
    A.eq(posts, ['PROJECT PHOTO BYTES'], 'R6 control: a normal upload then browser.click posts the original bytes through real Chrome');
    A.eq(copies(), [], 'R6 (3): once the submit navigated the page away, its staged copy is dropped');
    // the swap: the staged copy replaced by a hard link to a secret (padded to its size, mtime aligned), then the click
    const secret = path.join(scratch, 'secret-id_rsa');
    fs.writeFileSync(secret, 'SECRET-OF-THE-USER!');   // 19 bytes, the size of the selected file
    ref = await open('/form', /CHOOSE FILE/);
    const older = new Set(copies());
    await tool.run({ ref, paths: ['photo.txt'] }, ctx);
    const copy = copies().find(p => !older.has(p));   // the copy THIS selection was handed
    let swapped = false;
    try {
      const s = fs.statSync(copy);
      fs.utimesSync(secret, s.atime, s.mtime);
      fs.unlinkSync(copy); fs.linkSync(secret, copy); fs.utimesSync(copy, s.atime, s.mtime);
      swapped = true;
    } catch (e) { console.log('[skip] hard-link swap: ' + e.message); }
    if (swapped) {
      A.eq(await driver.testEval('document.getElementById("fi").files.length'), 1, 'R6 swap: the real input still holds the selection before the click');
      posts.length = 0;
      let refusedClick = '';
      try { await click.run({ ref: await sendRef() }, ctx); } catch (e) { refusedClick = e.message; }
      await new Promise(r => setTimeout(r, 500));
      A.ok(/an uploaded file changed on disk after you selected it, so it was not sent; select it again/.test(refusedClick) && !/could not be emptied/.test(refusedClick), 'R6 swap: browser.click is refused: ' + refusedClick);
      A.eq(posts, [], 'R6 swap: nothing reached the server (was: the secret, posted at submit)');
      A.eq(await driver.testEval('document.getElementById("fi").files.length'), 0, 'R6 swap: the real file input was emptied (by the File\'s own path)');
      A.ok(!fs.existsSync(path.dirname(copy)) && fs.readFileSync(secret, 'utf8') === 'SECRET-OF-THE-USER!' && fs.statSync(secret).nlink === 1, 'R6 swap: the staged copy was dropped; the secret is untouched with one name');
      // the form, submitted anyway, now carries no file
      await click.run({ ref: await sendRef() }, ctx);
      for (let i = 0; i < 50 && !posts.length; i++) await new Promise(r => setTimeout(r, 100));
      A.ok(posts.length === 1 && !posts[0], 'R6 swap: a later submit of that form posts an empty file part: ' + JSON.stringify(posts));
    }
    // ---- run-paths-polish P1, LIVE WALK W-R7 (b): select, the reply ends, the PERSON submits later ----
    // the reply's tools over a browser kept past the run, as index.js runOnceCore builds them over the station browser
    const reply = makeBrowserTools({ session: browser.session, fsp, pathMod: path, root: workspace, egress });
    ref = await open('/form', /CHOOSE FILE/);
    const p1 = await reply.tools.find(t => t.name === 'browser.upload').run({ ref, paths: ['photo.txt'] }, ctx);
    A.ok(/StarNet keeps that copy while this page stays open/.test(p1.content) && /The input holds the requested file now\./.test(p1.content), 'P1 (real Chrome): the receipt says the copy lives while its page does: ' + p1.content.slice(0, 160));
    const held = browser.session.uploadStage.copies();
    const pageDoc = held.length ? held[held.length - 1].doc : null;
    A.ok(!!(pageDoc && pageDoc.loader), 'P1 (real Chrome): the CDP driver names the page the file went into');
    await reply.releaseUploads();   // THE REPLY ENDS (index.js runOnceCore); the station browser stays open
    A.ok(copies().length >= 1, 'P1 (real Chrome): the staged copy outlives the reply while its page is open (was: deleted at the reply end)');
    // m4: the page busy (its main thread spinning) still reads alive at once: Chrome's own navigation events answer
    await driver.testEval('setTimeout(() => { const t = Date.now(); while (Date.now() - t < 3000) {} }, 50), 1');
    await new Promise(r => setTimeout(r, 300));
    const tBusy = Date.now();
    const busyAlive = await driver.uploadDocAlive(pageDoc);
    const busyMs = Date.now() - tBusy;
    A.ok(busyAlive === true && busyMs < 1000, 'm4 (real Chrome): a busy page reads alive at once, without asking its renderer (' + busyMs + ' ms, ' + busyAlive + ')');
    await new Promise(r => setTimeout(r, 3200));   // the page's spin ends
    posts.length = 0;
    await driver.testEval('document.getElementById("go").click(), 1');   // THE PERSON clicks Submit: no agent tool, no gate
    for (let i = 0; i < 50 && !posts.length; i++) await new Promise(r => setTimeout(r, 100));
    A.eq(posts, ['PROJECT PHOTO BYTES'], 'P1 W-R7 (b) (real Chrome): the person\'s later Submit posts the selected bytes (was: ERR_FILE_NOT_FOUND, nothing posted)');
    for (let i = 0; i < 30 && (await driver.uploadDocAlive(pageDoc)) !== false; i++) await new Promise(r => setTimeout(r, 100));
    await browser.session.uploadStage.sweep();   // the registry's 15 s sweep, now: that submit navigated the page away
    A.eq(browser.session.uploadStage.size, 0, 'P1 (real Chrome): once the submit navigated the page away, its copy is dropped with no agent action');
    await browser.releaseUploads();
    console.log('UPLOAD_LIVE_RECEIPT ' + JSON.stringify({ selected: selected.content, cleared: cleared.content }));
  } finally {
    let closeError = null;
    try { await closeDriver(); }
    catch (e) { closeError = e; }
    finally {
      // The fixture must stop listening even if Chromium teardown fails. Keep the original failure
      // and leave its scratch/profile intact whenever cleanup cannot prove it is safe to remove.
      try {
        const serverClosed = new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
        server.closeAllConnections(); await serverClosed;
      } catch (e) { if (!closeError) closeError = e; else console.error('Upload fixture server cleanup failed:', e); }
    }
    // the station staging root this fixture's uploads made in its own staging base (inside scratch, which a failed
    // cleanup keeps): it holds only real folders and files (no test here plants a link in it), so it goes on every exit
    const stagingRoot = defaultStagingRoot(path, workspace, stagingBase);
    if (/starnet-upload-staging-[0-9a-f]{16}$/.test(stagingRoot)) { try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { console.log('[cleanup] ' + e.message); } }
    if (closeError) throw closeError;
    /* driver.close() resolves once the browser process it spawned has exited. On Windows the whole tree was killed
       (taskkill /T), but a helper can still hold the profile's files after that (EBUSY on its leveldb log, its model store
       or the cache's sqldb0), so the Windows removal starts over, reading the tree afresh, while a file is held (EBUSY,
       EPERM, ENOTEMPTY), inside the teardown's one bound above. A file still held at the bound throws, and so does any other
       error at once, so a Chromium that never lets go stays visible.
       On Linux and macOS only that browser process is killed; its helper processes exit after it on their own.
       Linux CI run 40976584893 hit ENOTEMPTY on chrome/Default right after every assertion passed: something wrote
       into the profile after the removal had read it (most likely such a helper; not observed directly). One removal
       pass reads each folder once, so it cannot ride that out. On POSIX the whole removal therefore starts over, reading
       the tree afresh, but only when a folder gained an entry (ENOTEMPTY, or EEXIST, which POSIX also allows there): at
       most 10 retries (11 passes), waiting 0.1 s, 0.2 s ... 1 s between them, 5.5 s of waiting in all, each retry
       logged. A profile still being written to after that fails this test with that error. fsp.rm's own maxRetries is
       not used: Node applies it again at every folder level, so its waits multiply with depth (scratch, chrome and
       Default each multiply them). */
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('starnet-upload-live-')) {
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
      } else for (let retry = 1; ; retry++) {
        try { await fsp.rm(scratch, { recursive: true, force: true }); break; }
        catch (e) {
          if (retry > 10 || (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST')) throw e;
          console.log('[cleanup] scratch removal retry ' + retry + '/10 after ' + e.code + ' on ' + e.path);
          await new Promise(r => setTimeout(r, retry * 100));
        }
      }
    }
  }
  A.report('browser-upload.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
