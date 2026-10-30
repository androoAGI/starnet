/* #104: real Chromium file-selection proof, local fixtures only; no external form submission.
   Review round 6 BLOCKER (scratchpad rr6-chrome-submit.js): Chrome reads an uploaded file at FORM SUBMIT, a later
   separate action. /form posts multipart to this same local fixture server: a normal upload then browser.click sends
   the original bytes (and the staged copy goes once the page navigated away); a hard-link swap of the staged copy to a
   secret made AFTER the selection (padded to its size, mtime aligned) refuses the click, empties the real input
   (DOM.getFileInfo by path) and nothing reaches the server. Before the fix the secret was posted. */
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
  const egress = require('../sidecar/egress-files.js').makeEgressReader({ fsp, pathMod: path, workspaces: workspace, guard: approved });
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
    // ---- review round 6 BLOCKER: the bytes are read at SUBMIT; a swap after the selection must never be posted ----
    const click = browser.tools.find(t => t.name === 'browser.click');
    const sendRef = async () => { const n = (await browser.session.snapshot(80)).find(x => /SEND FORM/.test(x.text || '')); if (!n) throw new Error('SEND FORM missing'); return n.ref; };
    const STAGE = path.join(defaultStagingRoot(path, workspace), 'agent');
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
    await browser.releaseUploads();
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
    // the station staging root this fixture's uploads made under os.tmpdir() (outside scratch): it holds only real
    // folders and files (no test here plants a link in it), so it goes too
    const stagingRoot = defaultStagingRoot(path, workspace);
    if (/starnet-upload-staging-[0-9a-f]{16}$/.test(stagingRoot)) { try { fs.rmSync(stagingRoot, { recursive: true, force: true }); } catch (e) { console.log('[cleanup] ' + e.message); } }
    if (closeError) throw closeError;
    /* driver.close() resolves once the Chromium it spawned has exited. On Windows that is the whole tree (taskkill /T);
       on Linux and macOS only that browser process is killed and its helper processes exit after it on their own.
       Linux CI run 40976584893 hit ENOTEMPTY on chrome/Default right after every assertion passed: something wrote
       into the profile after the removal had read it (most likely such a helper; not observed directly). fs.rmSync
       cannot ride that out (Node 22): it reads each folder once and its retries re-try only that folder's rmdir.
       fsp.rm re-runs the whole removal: up to 10 retries, ~5.5 s in all. A profile still being written to after that
       still fails this test. */
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('starnet-upload-live-')) await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  A.report('browser-upload.e2e');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
