/* node test/clipboard-ack.census.test.js — INV-7, copy controls acknowledge only a real copy (truthful-ack lane, 2026-11-03).

   THE DEFECT CLASS. A copy key that says COPIED is a claim about the Commander's clipboard. The briefing's "copy briefing" key
   printed "copied ✓" whether or not anything was written (stationui.js); chat.js and diagnostics.js each carried their own copy
   of the clipboard helper, and ten files wrote the clipboard by hand, several announcing on a write they never checked.

   THE CONTRACT, proven three ways:
     1. U.copyText (the real frontend/js/util.js, evaluated with a fake navigator/document at the edge) resolves true ONLY when
        a write happened — Clipboard API ok; Clipboard refused + the textarea copy command succeeded; both failed; no Clipboard
        API at all — and its write STARTS synchronously, inside the click (WebKit allows a clipboard write only during the
        click's activation). Diag.copyText, Diag.copyDeferred and Chat.copyText are that helper.
     2. Clipboard API access exists only in util.js and in bootguard.js (an audited row: the boot guard must copy before
        util.js has loaded) — exact counts, both ways.
     3. Every copy control sets its success words from that boolean: a census per control (each row names the control and its
        success words; every occurrence of them must sit behind the `ok` the clipboard resolved), and the census covers every
        call of the one clipboard in the frontend, so a new copy control must add its row. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');

const ROOT = path.join(__dirname, '..', 'frontend');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const UTIL = read('js/util.js');

/* ---- 1. the one clipboard, run from the real util.js ---- */
function loadU(env) {
  const ctx = vm.createContext(Object.assign({ Promise, Blob, console }, env || {}));
  vm.runInContext(UTIL, ctx, { filename: 'util.js' });
  return vm.runInContext('U', ctx);
}
function fakeDocument(execResult) {
  const log = { exec: 0, appended: 0, removed: 0, value: null };
  const document = {
    body: { appendChild: el => { log.appended++; log.value = el.value; } },
    createElement: () => ({ value: '', style: {}, setAttribute() {}, focus() {}, select() {}, remove() { log.removed++; } }),
    execCommand: cmd => { log.exec++; if (cmd !== 'copy') return false; if (execResult === 'throw') throw new Error('denied'); return execResult; }
  };
  return { document, log };
}

(async () => {
  const HAS_ONE = typeof loadU().copyText === 'function' && typeof loadU().copyDeferred === 'function';
  A.ok(HAS_ONE, 'util.js carries the one clipboard: U.copyText and U.copyDeferred');
  // without it the behaviour cases cannot run; the source census below still reports every control
  if (HAS_ONE) await behaviour();
  await aliases();
  census();
  A.report('clipboard-ack census');
})().catch(e => { console.log('FAIL: clipboard-ack census threw - ' + (e && e.stack || e)); process.exit(1); });

async function behaviour() {
  {   // Clipboard API ok: true, the text is written once, no fallback
    const writes = []; const d = fakeDocument(true);
    const U = loadU({ navigator: { clipboard: { writeText: t => { writes.push(t); return Promise.resolve(); } } }, document: d.document });
    const p = U.copyText('alpha');
    A.eq(writes.length, 1, 'the write STARTS synchronously, inside the click (before any await): WebKit\'s activation rule');
    A.eq(await p, true, 'Clipboard API ok -> true');
    A.eq(writes[0], 'alpha', 'the exact text is written');
    A.eq(d.log.exec, 0, 'no fallback copy when the Clipboard API took it');
  }
  {   // Clipboard refuses, the textarea copy command succeeds: true
    const d = fakeDocument(true);
    const U = loadU({ navigator: { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } }, document: d.document });
    A.eq(await U.copyText('beta'), true, 'Clipboard refused + the copy command succeeded -> true');
    A.ok(d.log.exec === 1 && d.log.value === 'beta' && d.log.removed === 1, 'the fallback copies the same text from a hidden textarea it removes again');
  }
  {   // both fail: false
    const d = fakeDocument(false);
    const U = loadU({ navigator: { clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } }, document: d.document });
    A.eq(await U.copyText('gamma'), false, 'Clipboard refused + the copy command refused -> false (never "copied")');
    const t = fakeDocument('throw');
    const U2 = loadU({ navigator: { clipboard: { writeText: () => Promise.reject(new Error('x')) } }, document: t.document });
    A.eq(await U2.copyText('gamma'), false, 'a copy command that throws -> false, and copyText never throws');
  }
  {   // no Clipboard API at all
    const d = fakeDocument(true);
    const U = loadU({ navigator: {}, document: d.document });
    const p = U.copyText('delta');
    A.eq(d.log.exec, 1, 'with no Clipboard API the copy command runs synchronously, inside the click');
    A.eq(await p, true, 'no Clipboard API + the copy command succeeded -> true');
    const f = fakeDocument(false);
    A.eq(await loadU({ navigator: {}, document: f.document }).copyText('delta'), false, 'no Clipboard API + the copy command refused -> false');
    A.eq(await loadU({}).copyText('delta'), false, 'no navigator and no document -> false');
    const thrower = { clipboard: { writeText: () => { throw new Error('sync throw'); } } };
    const g = fakeDocument(true);
    A.eq(await loadU({ navigator: thrower, document: g.document }).copyText('eps'), true, 'a Clipboard API that throws synchronously falls back to the copy command');
  }
  {   // empty text is no copy
    let called = false;
    const U = loadU({ navigator: { clipboard: { writeText: () => { called = true; return Promise.resolve(); } } }, document: fakeDocument(true).document });
    A.eq(await U.copyText(''), false, 'empty text -> false');
    A.eq(await U.copyText(null), false, 'null -> false');
    A.ok(!called, 'nothing is written for empty text');
  }
}

/* the aliases: Diag (required in node, as diagnostics-copy-gesture does) reaches the same helper through util.js's export */
async function aliases() {
  {
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const setNavigator = v => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
    try {
      const Diag = require('../frontend/app/diagnostics.js');
      const writes = [];
      setNavigator({ clipboard: { writeText: t => { writes.push(t); return Promise.resolve(); } } });
      A.eq(await Diag.copyText('zeta'), true, 'Diag.copyText resolves the one clipboard\'s true');
      A.eq(writes.join(), 'zeta', '…having written the text');
      setNavigator({ clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) } });
      A.eq(await Diag.copyText('eta'), false, 'Diag.copyText resolves false on a refused copy (no document here: no fallback)');
    } catch (e) { A.ok(false, 'Diag.copyText runs the one clipboard in node (' + (e && e.message) + ')'); }
    finally { if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc); else delete globalThis.navigator; }
    const diag = read('app/diagnostics.js'), chat = read('app/chat.js');
    A.ok(/function copyToClipboard\(text\) \{ const u = clip\(\); return u \? u\.copyText\(text\) : Promise\.resolve\(false\); \}/.test(diag)
      && /function copyDeferred\(textP\) \{ const u = clip\(\); return u \? u\.copyDeferred\(textP\) : Promise\.resolve\(false\); \}/.test(diag)
      && /copyText: copyToClipboard, copyDeferred/.test(diag), 'Diag.copyText and Diag.copyDeferred are the one clipboard (U.copyText / U.copyDeferred)');
    A.ok(/function copyText\(text\) \{ return U\.copyText\(text\); \}/.test(chat), 'Chat.copyText is the one clipboard (U.copyText)');
    A.ok(!/function fallbackCopy\(/.test(diag) && !/function fallbackCopy\(/.test(chat), 'the duplicate fallbackCopy helpers are gone');
  }
}

function census() {
  /* ---- 2. Clipboard API access lives in util.js (and the boot guard) only ---- */
  const CLIPBOARD_API = /\bnavigator\.clipboard\b|\bexecCommand\(\s*['"]copy['"]\s*\)|\bnew\s+ClipboardItem\(/g;
  const API_BASELINE = {
    'js/util.js': 4,        // U.copyText (Clipboard API + the textarea copy command) and U.copyDeferred (Clipboard API + ClipboardItem)
    'app/bootguard.js': 3   // AUDITED: the boot guard copies its report before util.js has loaded (it must work when util.js did not)
  };
  const walk = (dir, out) => { for (const n of fs.readdirSync(dir)) { if (n === 'node_modules' || n === '.git') continue; const p = path.join(dir, n); if (fs.statSync(p).isDirectory()) walk(p, out); else if (n.endsWith('.js')) out.push(p); } return out; };
  const sources = walk(ROOT, []).map(f => ({ rel: path.relative(ROOT, f).split(path.sep).join('/'), src: fs.readFileSync(f, 'utf8') }));
  A.ok(sources.length > 20, 'the census sees the frontend tree (' + sources.length + ' js files)');
  const apiSeen = {};
  for (const { rel, src } of sources) {
    const n = (src.match(CLIPBOARD_API) || []).length;
    if (n) apiSeen[rel] = n;
    if (n > (API_BASELINE[rel] || 0)) A.ok(false, rel + ' writes the clipboard itself (' + n + ' Clipboard API touches) — copy through U.copyText and announce from its boolean');
  }
  for (const rel of Object.keys(API_BASELINE)) A.eq(apiSeen[rel] || 0, API_BASELINE[rel], 'Clipboard API census: ' + rel + ' equals its audited count');
  A.eq(Object.keys(apiSeen).sort().join(','), Object.keys(API_BASELINE).sort().join(','), 'the Clipboard API is touched in util.js and the boot guard only');

  /* ---- 3. every copy control announces from the boolean ----
     at:  a unique piece of the control's code (its clipboard call, or the call of the one painter it hands the boolean to)
     say: the control's success words. EVERY occurrence of them in the control's window must sit on a line where the resolved
          `ok` comes first (`ok ? …`, `if (ok) …`, `painter(btn, ok)`), so no path says them without the clipboard's yes.  */
  const CONTROLS = [
    ['app/app.js', 'U.copyText(cmd).then(done);', "'✓ COPIED'"],                                                     // COPY INSTALL COMMAND (Claude CLI)
    ['app/app.js', 'Diag.copy({ notify: false, context: { kind: diagnosis.code', "'✓ RECOVERY DETAILS COPIED'"],        // unreachable gate: recovery details
    ['app/chat.js', "if (codeEl) copyText(codeEl.textContent || '').then(ok => showCopyResult(codeBtn, ok));", 'showCopyResult(codeBtn, ok)'],   // workflow-panel markdown code copy
    ['app/chat.js', "copyText(codeEl.textContent || '').then(ok => {", 'showCopyResult(codeBtn, ok)'],                 // COMMS code-block copy
    ['app/chat.js', 'copyText(txt).then(ok => {', 'showCopyResult(btn, ok)'],                                          // COMMS message copy
    ['app/chat.js', 'return copyText(abs).then(ok => {', "'path copied'"],                                             // a deliverable's copy path
    ['app/chat.js', 'copy.onclick = () => copyText(inspect.copy || inspect.text).then(ok => {', "'✓ COPIED'"],         // consent card: copy the request
    ['app/chat.js', 'copyText(destPath).then(done);', "'copied ✓'"],                                                    // implement: copy the saved path
    ['app/chat.js', 'Diag.copy({ notify: false, context: context, onDone: (ok, text) => {', "'✓ diagnostics copied — paste into your report'"],   // a failed turn's diagnostics
    ['app/chat.js', 'copyText(h[i].content).then(ok =>', "'copied the last reply'"],                                    // /copy (the last reply)
    ['app/crtlab.js', 'U.copyText(txt).then(ok =>', "'copied ✓'"],                                                      // CRT lab: COPY VALUES
    ['app/diagnostics.js', 'copyToClipboard(t).then(ok => {', "'✓ copied'"],                                            // the shown report's copy again
    ['app/diagnostics.js', 'const okP = copyDeferred(textP);', 'ok ? okMsg'],                                            // Diag.copy's own toast
    ['app/group-chat.js', 'U.copyText(content).then(done);', "'copied'"],                                               // group chat: copy message
    ['app/group-chat.js', 'U.copyText(ins.copy || ins.text).then(done);', "'✓ COPIED'"],                                // group chat: copy the inspected request
    ['app/remote-devices.js', 'U.copyText(p.pairUrl).then(ok =>', 'Link copied'],                                       // pair a phone: COPY LINK
    ['app/stationui.js', 'Diag.copy({ notify: false, onDone: (ok, text) => {', '✓ copied — paste it into'],             // SETTINGS: copy diagnostics
    ['app/stationui.js', "Diag.copyText(text).then(ok => { liveCopy.textContent = ok ? '✓ RECEIPT COPIED'", "'✓ RECEIPT COPIED'"],   // live receipt
    ['app/stationui.js', 'Diag.copyText(Backup.recoveryCheckCommand(rbInfo)).then(ok =>', "'✓ COPIED'"],                // rollback check command
    ['app/stationui.js', 'U.copyText(block).then(ok => {', "'copied ✓'"],                                               // the dossier's copy briefing
    ['app/windows/connectors.js', 'U.copyText(path).then(ok =>', "'Path copied to your clipboard.'"],                  // plugins: where is the folder
    ['app/windows/connectors.js', 'U.copyText(device.userCode).then(ok =>', "'COPIED'"],                               // GitHub device code: COPY CODE
    ['app/windows/connectors.js', 'U.copyText(copyBtn.dataset.ccCopy).then(ok => {', "'COPIED'"],                      // catalog card: COPY
    ['app/workflowpanel.js', 'U.copyText(v).then(ok => {', "'COPIED'"]                                                   // a line trigger's copy key
  ];
  const PAINTERS = [['app/chat.js', 'function showCopyResult(btn, ok) {', "'Copied'"]];   // the one result painter chat.js hands its boolean to
  const BEFORE = 400, AFTER = 1200;
  for (const [rel, at, say] of CONTROLS.concat(PAINTERS)) {
    const src = read(rel);
    const i = src.indexOf(at);
    A.ok(i >= 0 && src.indexOf(at, i + 1) < 0, rel + ': the control is found once: ' + at.slice(0, 70));
    if (i < 0) continue;
    const from = Math.max(0, i - BEFORE), win = src.slice(from, i + at.length + AFTER);
    const isPainter = PAINTERS.some(p => p[1] === at);
    if (!isPainter) {
      A.ok(/\b(?:U|Diag|Chat)\.copy(?:Text|Deferred)?\(|(?<![.\w$])(?:copyText|copyToClipboard|copyDeferred)\(/.test(src.slice(i, i + at.length + 80)), rel + ': the control copies through the one clipboard: ' + at.slice(0, 60));
      A.ok(/\.then\(|onDone:\s*\(\s*ok\b/.test(src.slice(i, i + at.length + AFTER)), rel + ': the control reads the boolean the clipboard resolves: ' + at.slice(0, 60));
    }
    let hits = 0, bad = 0, k = -1;
    while ((k = win.indexOf(say, k + 1)) >= 0) {
      hits++;
      const lineStart = win.lastIndexOf('\n', k) + 1;
      if (!/\bok\b/.test(win.slice(lineStart, k + say.length))) bad++;
    }
    A.ok(hits > 0, rel + ': the control\'s success words are present: ' + say);
    A.eq(bad, 0, rel + ': "' + say + '" is said only behind the clipboard\'s ok (' + at.slice(0, 50) + ')');
  }

  // coverage: the census rows are every call of the one clipboard in the frontend (util.js defines it; bootguard is audited)
  const CALL = /\b(?:U|Diag|Chat)\.copy(?:Text|Deferred)?\(|(?<![.\w$])(?:copyText|copyToClipboard|copyDeferred)\(/g;
  const calls = {};
  for (const { rel, src } of sources) {
    if (rel === 'js/util.js' || rel === 'app/bootguard.js') continue;
    let m; const re = new RegExp(CALL.source, 'g');
    while ((m = re.exec(src))) {
      const ls = src.lastIndexOf('\n', m.index) + 1, le = src.indexOf('\n', m.index);
      const line = src.slice(ls, le < 0 ? src.length : le);
      if (/^\s*(?:async\s+)?function\s/.test(line)) continue;             // a helper's own definition (the aliases)
      if (line.slice(m.index - ls).indexOf('*/') >= 0) continue;          // the closing line of a header comment
      calls[rel] = (calls[rel] || 0) + 1;
    }
  }
  const rows = {};
  for (const [rel] of CONTROLS) rows[rel] = (rows[rel] || 0) + 1;
  for (const rel of Object.keys(Object.assign({}, calls, rows)))
    A.eq(calls[rel] || 0, rows[rel] || 0, 'copy-control coverage: ' + rel + ' calls the one clipboard ' + (calls[rel] || 0) + ' time(s), the census lists ' + (rows[rel] || 0) + ' (a new copy control adds its row)');
}
