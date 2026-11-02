/* browser-upload.js — #104: prove local file selection, never infer a remote upload.
   Runs on browser.js's pinned CDP channel so tab loss cannot redirect a file to another page.
   WHICH INPUT (#104, the second report): a ref on a visible upload BUTTON was resolved by position, to the only file input
   in the button's nearest container. A page's real input can be elsewhere, or made by the click itself, and then the
   chosen input took the file, read back as "selected", and the page never heard of it. A control that is not a file
   input or its label, and that NAMES ITSELF an upload control, is now CLICKED with the file chooser intercepted: the input
   Chrome names (Page.fileChooserOpened) is the one the page opened, so it is the one that gets the files.
   THE CLICK IS AN ACTION ON THE PAGE, so it is earned (controlAtPoint). A submit button, a real link, a control whose name
   says publish or save or delete, one with no upload name, and one beside a visible file input (that input is what the
   page asks the person to use) are never clicked: they take the old non-clicking path to the only input nearby. A click
   that navigated the main frame or raised a JavaScript dialog is refused (clickForChooser), and every refusal after a
   click says the click happened. Only a control that opens no chooser falls back to position, and the receipt says so
   (resolvedBy). A file its input's accept list excludes is refused. The receipt also carries pageReaction (DOM changes,
   requests) during the wait: none is reported as none, never as acceptance or refusal. */
'use strict';
const path = require('node:path');
const { note: failNote } = require('../../failopen.js');

// Serialized into the page as fixed code; caller supplies only numeric coordinates and file count.
function inputAtPoint(x, y, count, directOnly) {
  let doc = document, el;
  for (let depth = 0; depth < 8; depth++) {
    el = doc.elementFromPoint(x, y);
    if (!el) break;
    for (let shadow = 0; shadow < 8 && el.shadowRoot && el.shadowRoot.elementFromPoint; shadow++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el.tagName !== 'IFRAME') break;
    const box = el.getBoundingClientRect(), next = el.contentDocument;
    if (!next) throw new Error('upload control is in an inaccessible frame; no file was selected');
    x -= box.left + el.clientLeft; y -= box.top + el.clientTop; doc = next;
  }
  const isFile = n => n && n.tagName === 'INPUT' && n.type === 'file';
  let input = isFile(el) ? el : isFile(el && el.control) ? el.control : null;
  const label = el && el.closest && el.closest('label');
  if (!input && isFile(label && label.control)) input = label.control;
  if (!input && directOnly) return null;   // a button or tile: the page's own file chooser answers first (selectFiles)
  if (!input) {
    const scope = el && el.closest && el.closest('form,fieldset,section,div');
    const choices = scope ? Array.from(scope.querySelectorAll('input[type=file]')) : [];
    if (choices.length > 1) throw new Error('ambiguous upload control: more than one file input is nearby; select its specific file input or associated label');
    input = choices.length === 1 ? choices[0] : null;
  }
  if (!input) throw new Error('no associated file input found at this ref; snapshot the page and pick the file input or its label');
  if (input.disabled || input.matches(':disabled')) throw new Error('the file input is disabled; no file was selected');
  if (input.webkitdirectory) throw new Error('directory selection is not supported by browser.upload; pick a file input');
  if (count > 1 && !input.multiple) throw new Error('this input accepts only one file; no files were selected');
  return input;
}
/* MAY THIS CONTROL BE CLICKED? Serialized into the page as fixed code. Only a yes clicks; "unsure" is a no, because the
   old path (the only input nearby, unclicked) is still there. The name is the control's own: its text when short, its
   aria-label, title, value, an inner image's alt, its id, name and test id. */
function controlAtPoint(x, y) {
  let doc = document, el;
  for (let depth = 0; depth < 8; depth++) {
    el = doc.elementFromPoint(x, y);
    if (!el) break;
    for (let shadow = 0; shadow < 8 && el.shadowRoot && el.shadowRoot.elementFromPoint; shadow++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el.tagName !== 'IFRAME') break;
    const box = el.getBoundingClientRect(), next = el.contentDocument;
    if (!next) return { click: false, why: 'in an inaccessible frame' };
    x -= box.left + el.clientLeft; y -= box.top + el.clientTop; doc = next;
  }
  if (!el) return { click: false, why: 'nothing at this point' };
  const up = n => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  let control = null, n = el;
  for (let i = 0; n && i < 16; i++, n = up(n)) {
    const tag = n.tagName, role = String(n.getAttribute('role') || '').toLowerCase();
    if ((tag === 'BUTTON' || tag === 'INPUT') && n.disabled) return { click: false, why: 'disabled' };
    if ((tag === 'BUTTON' || tag === 'INPUT') && n.form && /^(submit|image|reset)$/.test(n.type)) return { click: false, why: 'it can submit its form' };
    if (tag === 'A') {
      const href = String(n.getAttribute('href') || '').trim();
      if (href && !/^(#|javascript:)/i.test(href)) return { click: false, why: 'it is a link' };
    }
    if (!control && (tag === 'BUTTON' || tag === 'INPUT' || tag === 'A' || tag === 'SUMMARY' || role === 'button' || role === 'link' || role === 'menuitem' || n.hasAttribute('onclick') || n.hasAttribute('tabindex'))) control = n;
  }
  control = control || el;
  const scope = control.closest && control.closest('form,fieldset,section,div');
  const win = doc.defaultView;
  const shown = i => {
    const r = i.getBoundingClientRect(), s = win.getComputedStyle(i);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01;
  };
  if (scope && Array.from(scope.querySelectorAll('input[type=file]')).some(shown)) return { click: false, why: 'a visible file input is beside it' };
  const text = String(control.innerText || control.textContent || '').trim();
  const pic = control.querySelector && control.querySelector('img[alt]');
  const name = [text.length <= 80 ? text : '', control.getAttribute('aria-label'), control.getAttribute('title'), control.tagName === 'INPUT' ? control.value : '',
    pic && pic.getAttribute('alt'), control.id, control.getAttribute('name'), control.getAttribute('data-testid'), control.getAttribute('data-test-id')]
    .filter(Boolean).join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.:]+/g, ' ').toLowerCase();
  if (/\b(publish|submit|send|save|post|delete|remove|buy|pay|purchase|order|checkout|confirm|continue|next|finish|done|cancel|close|sign|login|logout|reset|clear|renew)\b/.test(name)) return { click: false, why: 'its name says it does something else' };
  const named = /\b(uploads?|attach|attachments?|browse)\b/.test(name)
    || /\b(add|choose|select|pick|import|replace|change|drop|drag)\b.*\b(files?|photos?|images?|pictures?|videos?|media|documents?|attachments?|pdfs?|resumes?|cv)\b/.test(name);
  return named ? { click: true, why: '' } : { click: false, why: 'its name does not say upload' };
}
function observeSelection() {
  const input = this, events = [];
  const files = () => Array.from(input.files || [], f => ({ name: f.name, size: f.size, type: f.type }));
  const observe = event => { if (events.length < 8) events.push({ type: event.type, files: files() }); };
  input.addEventListener('input', observe, true); input.addEventListener('change', observe, true);
  /* what the page did during the wait: only "nothing" says anything, since a busy page mutates on its own. An input in a
     same-origin iframe usually shows its thumbnail in the page around it, so every same-origin document is watched. An
     ancestor this page may not read leaves the answer partial, and partial never reads as "no reaction". */
  const own = input.ownerDocument && input.ownerDocument.defaultView;
  let partial = false, top = own;
  for (let i = 0; top && i < 8; i++) {
    let parent = null;
    try { parent = top.parent; if (parent === top) break; void parent.document; } catch (_) { partial = true; break; }
    top = parent;
  }
  const wins = [];
  const collect = w => {
    if (wins.length >= 16 || wins.includes(w)) return;
    try { void w.document.documentElement; } catch (_) { return; }
    wins.push(w);
    for (let i = 0; i < w.frames.length; i++) collect(w.frames[i]);
  };
  try { collect(top); } catch (_) { partial = true; }
  if (own && !wins.includes(own)) wins.push(own);
  const resourceCount = () => wins.reduce((sum, w) => { try { return sum + w.performance.getEntriesByType('resource').length; } catch (_) { return sum; } }, 0);
  const requestsBefore = resourceCount();
  let domChanges = 0;
  const watchers = [];
  for (const w of wins) {
    try {
      const watcher = new w.MutationObserver(list => { domChanges += list.length; });
      watcher.observe(w.document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      watchers.push(watcher);
    } catch (_) { partial = true; }   // a frame gone meanwhile went unwatched: this runs in the page, so it can only say so here
  }
  const stop = () => { input.removeEventListener('input', observe, true); input.removeEventListener('change', observe, true); for (const w of watchers.splice(0)) { domChanges += w.takeRecords().length; w.disconnect(); } };
  return { stop, peek() { return { connected: input.isConnected, files: files(), events }; }, finish() {
    stop();
    return { input: { id: input.id.slice(0, 200), name: input.name.slice(0, 200), accept: input.accept.slice(0, 500), multiple: input.multiple },
      connected: input.isConnected, files: files(), events, pageReaction: { domChanges, requests: Math.max(0, resourceCount() - requestsBefore), partial } };
  } };
}
// A page-side refusal reaches the model as its one-line reason: V8 stack frames and the "Error:" prefix are noise.
function pageError(reply, fallback) {
  const d = reply && reply.exceptionDetails;
  if (!d) return null;
  const raw = (d.exception && d.exception.description) || d.text || fallback;
  return new Error(String(raw).split('\n')[0].replace(/^(?:Uncaught\s+)?Error:\s*/, '') || fallback);
}
function matches(files, expected) {
  return Array.isArray(files) && files.length === expected.length
    && files.every((f, i) => f.name === expected[i].name && (expected[i].size == null || f.size === expected[i].size));
}
/* A file its input's accept list excludes (a photo into accept="video/*"): -> the refusal, or ''. Chrome's DOM.setFileInputFiles
   ignores accept, so without this the wrong input read back as a success. ONLY WHAT CAN BE PROVEN IS REFUSED: an extension
   this table does not know passes, a token that is neither ".ext" nor type/subtype (accept="png", "image") makes the whole
   list unreadable and passes, parameters are ignored (image/*;capture=camera), and a type's everyday spellings count
   (image/x-png, image/jpg, audio/mp3). .mp4 and .webm can each hold audio or video, so either family takes them. */
const EXT_FAMILY = { '.jpg': '.jpeg', '.jpe': '.jpeg', '.jfif': '.jpeg', '.tif': '.tiff', '.htm': '.html', '.m4v': '.mp4' };
const TYPES_BY_EXT = { '.png': ['image/png'], '.jpeg': ['image/jpeg'], '.gif': ['image/gif'], '.webp': ['image/webp'], '.svg': ['image/svg+xml'],
  '.mp4': ['video/mp4', 'audio/mp4'], '.mov': ['video/quicktime'], '.webm': ['video/webm', 'audio/webm'], '.mp3': ['audio/mpeg'], '.wav': ['audio/wav'], '.pdf': ['application/pdf'] };
const TYPE_SPELLING = { 'image/x-png': 'image/png', 'image/jpg': 'image/jpeg', 'image/pjpeg': 'image/jpeg', 'image/svg': 'image/svg+xml',
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg', 'audio/x-mpeg-3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav', 'video/x-quicktime': 'video/quicktime', 'video/x-m4v': 'video/mp4',
  'application/x-pdf': 'application/pdf', 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4' };
const extOf = e => EXT_FAMILY[e] || e;
function acceptRefusal(accept, names) {
  const tokens = String(accept || '').split(',').map(t => t.split(';')[0].trim().toLowerCase()).filter(Boolean);
  if (!tokens.length || tokens.some(t => !/^(\.[a-z0-9]+|[a-z0-9.+-]+\/(\*|[a-z0-9.+-]+))$/.test(t))) return '';
  const wanted = tokens.map(t => TYPE_SPELLING[t] || (t[0] === '.' ? extOf(t) : t));
  for (const name of names) {
    const ext = extOf(path.extname(String(name)).toLowerCase()), types = TYPES_BY_EXT[ext];
    if (!types || wanted.includes(ext)) continue;
    if (wanted.some(t => t === '*/*' || types.includes(t) || (t.endsWith('/*') && types.some(type => type.startsWith(t.slice(0, -1)))))) continue;
    return 'this file input accepts ' + tokens.join(', ').slice(0, 200) + ', not ' + path.basename(String(name)) + ', so it is probably not the right input; no file was selected';
  }
  return '';
}
const CHECK_CHOSEN = 'function (count) { if (this.tagName !== "INPUT" || this.type !== "file") throw new Error("the file chooser did not name a file input; no file was selected");'
  + ' if (this.webkitdirectory) throw new Error("directory selection is not supported by browser.upload; pick a file input");'
  + ' if (count > 1 && !this.multiple) throw new Error("this input accepts only one file; no files were selected"); }';
/* CLICK ONE UPLOAD CONTROL, CHOOSER INTERCEPTED, FOR AT MOST boundMs. -> the backend node id of the input the page opened,
   or null when the click opened none. Throws, naming the click, when it navigated the main frame or raised a dialog.
   A confirm() in the click handler stops the renderer: the mouse event never answers and every evaluate waits out its
   timeout (40 s in the review's probe, against 3 s without a click). So the click is RACED, not awaited, and a dialog
   during it is dismissed (the safe answer to a page's question nobody asked to answer). Interception ends in the finally,
   on every path. listen(handlers) -> stop: the driver's Page events for this tab (chooser, dialog, navigation). */
const CHOOSER_READ_MS = 2000;
async function clickForChooser({ cdp: c, node, click, listen, graceMs, boundMs }) {
  const readFrame = async () => {
    try {
      const t = await c.send('Page.getFrameTree', {}, undefined, CHOOSER_READ_MS);
      const f = t && t.frameTree && t.frameTree.frame;
      return f && f.loaderId ? { id: f.id, loader: String(f.loaderId) } : null;
    } catch (e) { failNote('browser.upload.chooser-frame', e); return null; }
  };
  const before = await readFrame();
  let chosen, sawDialog, navigated = false;
  const chooser = new Promise(resolve => { chosen = resolve; }), dialog = new Promise(resolve => { sawDialog = resolve; });
  const timers = [];
  const after = ms => new Promise(resolve => { timers.push(setTimeout(resolve, ms)); });
  const stop = listen({
    chooser: p => chosen(p),
    dialog: p => { c.send('Page.handleJavaScriptDialog', { accept: false }, undefined, CHOOSER_READ_MS).catch(e => failNote('browser.upload.chooser-dialog', e)); sawDialog(p); },
    navigation: p => { if (!before || !p || p.frameId === before.id) navigated = true; }
  });
  const clickedRefusal = what => new Error('this control was clicked, ' + what + '; no file was selected. Take a fresh browser.snapshot and check the page before retrying');
  try {
    try { await c.send('Page.setInterceptFileChooserDialog', { enabled: true }); }
    catch (e) { if (e && typeof e === 'object') e.notClicked = true; throw e; }
    const clicking = Promise.resolve().then(() => click(c, node)).then(() => ({ done: true }), error => ({ error }));
    const dialogSeen = dialog.then(p => ({ dialog: p || {} }));
    const chooserSeen = chooser.then(p => ({ chooser: p || {} }));
    let first = await Promise.race([chooserSeen, dialogSeen, clicking, after(boundMs).then(() => ({ late: true }))]);
    if (first.error) throw first.error;
    if (first.late) throw clickedRefusal('but the page did not answer in time');
    if (first.done) first = await Promise.race([chooserSeen, dialogSeen, after(graceMs).then(() => ({}))]);
    else if (first.chooser) await Promise.race([clicking, after(boundMs)]);   // the handler finished before anything reads the page
    if (first.dialog) {
      await Promise.race([clicking, after(CHOOSER_READ_MS)]);
      throw clickedRefusal('and it opened a JavaScript ' + String(first.dialog.type || 'dialog').replace(/[^a-z]/gi, '').slice(0, 20) + ' dialog, which was dismissed, so it is probably not an upload control');
    }
    const now = await readFrame();
    if (navigated || (before && now && now.loader !== before.loader)) throw clickedRefusal('and that navigated the page: a form may have been sent, without the file');
    const p = first.chooser;
    return p && p.backendNodeId != null ? p.backendNodeId : null;
  } finally {
    for (const t of timers) clearTimeout(t);
    stop();
    await c.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(e => failNote('browser.upload.chooser-off', e));
  }
}
// a click happened, whatever fails after it: the refusal says so, since "no file was selected" alone hides a page action
async function selectFiles(o) {
  const state = { clicked: false };
  try { return await selectInto(o, state); }
  catch (e) {
    if (state.clicked && e && typeof e === 'object' && !e.notClicked) {
      e.clicked = true;
      if (typeof e.message === 'string' && !/\bclick/i.test(e.message)) e.message = 'this control was clicked first, which may have changed the page, and ' + e.message;
    }
    throw e;
  }
}
const CONFIRM_WAIT_MS = 2000, CONFIRM_POLL_MS = 100;
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
async function selectInto({ cdp: c, node, paths, expected, settle, openChooser, requestsSeen, confirmWaitMs }, state) {
  await c.send('DOM.enable');
  const x = node.x + Math.max(1, Math.floor(node.w / 2)), y = node.y + Math.max(1, Math.floor(node.h / 2));
  const atPoint = async directOnly => {
    const args = [x, y, paths.length].concat(directOnly ? [true] : []);
    const r = await c.send('Runtime.evaluate', { expression: '(' + inputAtPoint.toString() + ')(' + args.map(v => JSON.stringify(v)).join(',') + ')' });
    const problem = pageError(r, 'upload control could not be resolved');
    if (problem) throw problem;
    return r && r.result && r.result.objectId;
  };
  // is this a control that may be clicked? anything but a plain yes keeps the page untouched (controlAtPoint)
  const mayClick = async () => {
    const r = await c.send('Runtime.evaluate', { returnByValue: true, expression: '(' + controlAtPoint.toString() + ')(' + x + ',' + y + ')' });
    return !!(r && !r.exceptionDetails && r.result && r.result.value && r.result.value.click === true);
  };
  let objectId = await atPoint(true), resolvedBy = 'the file input or its label', clicked = false;
  if (!objectId && typeof openChooser === 'function' && await mayClick()) {
    clicked = state.clicked = true;   // set first: a click that throws has still happened
    const chosen = await openChooser(c, node);   // clicks the control with the chooser intercepted; null: it opened none
    if (chosen != null) {
      const r = await c.send('DOM.resolveNode', { backendNodeId: chosen });
      objectId = r && r.object && r.object.objectId;
      if (!objectId) throw new Error('the page opened a file chooser, but its input could not be reached; no file was selected');
      const checked = await c.send('Runtime.callFunctionOn', { objectId, functionDeclaration: CHECK_CHOSEN, arguments: [{ value: paths.length }] });
      const refused = pageError(checked, 'the file input could not be checked');
      if (refused) { await c.send('Runtime.releaseObject', { objectId }).catch(e => failNote('browser.upload.object-cleanup', e)); throw refused; }
      resolvedBy = 'the file chooser the page opened';
    }
  }
  if (!objectId) {
    try { objectId = await atPoint(false); }
    catch (e) { if (clicked && e && e.message) e.message = 'clicking this control opened no file chooser, and ' + e.message; throw e; }
    if (objectId) resolvedBy = clicked ? 'position: the only file input near a control that opened no file chooser' : 'position: the only file input near this control';
  }
  if (!objectId) throw new Error('upload control could not be resolved; no file was selected');
  let monitorId, handed = false;
  try {
    const declared = await c.send('Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration: 'function () { return { accept: String(this.accept || "") }; }' });
    const accept = declared && declared.result && declared.result.value && declared.result.value.accept;
    const excluded = acceptRefusal(accept, (expected || paths.map(p => ({ name: path.basename(p) }))).map(f => f.name));
    if (excluded) throw new Error(excluded);
    const monitor = await c.send('Runtime.callFunctionOn', { objectId, functionDeclaration: observeSelection.toString() });
    monitorId = monitor && monitor.result && monitor.result.objectId;
    if (!monitorId || monitor.exceptionDetails) throw new Error('could not observe the file input; no file was selected');
    handed = true;   // from here on the input may hold the files, whatever fails next (run-paths-polish m1: e.handed)
    const seenBefore = typeof requestsSeen === 'function' ? requestsSeen() : 0;
    await c.send('DOM.setFileInputFiles', { files: paths, objectId });
    await settle(c);
    /* A LOADED BOX: an input the click made is not in the document, so only its change event can prove the selection, and
       that event can land after the settle returned. A short bounded look before the verdict (peek does not end the
       observation); it adds no evidence of its own, and a page that never confirms is still refused below. */
    const confirmWanted = expected || paths.map(p => ({ name: path.basename(p) }));
    for (let waited = 0, limit = confirmWaitMs == null ? CONFIRM_WAIT_MS : confirmWaitMs; waited < limit; waited += CONFIRM_POLL_MS) {
      let seen;
      try { seen = await c.send('Runtime.callFunctionOn', { objectId: monitorId, functionDeclaration: 'function () { return this.peek(); }', returnByValue: true }); }
      catch (_) { break; }   // the page is gone: the readback below says what that means
      const v = seen && seen.result && seen.result.value;
      if (!v || !Array.isArray(v.files) || (v.connected && matches(v.files, confirmWanted)) || (Array.isArray(v.events) && v.events.some(e => matches(e.files, confirmWanted)))) break;
      await sleepMs(CONFIRM_POLL_MS);
    }
    /* A form that submits on change (onchange="this.form.submit()") navigates before the readback, and CDP answers
       "Could not find object with given id". The files WERE handed to the input, so this is not a plain failure:
       the upload may already have gone out, and a blind retry could send it twice. Tab loss keeps its own error. */
    let readback;
    try {
      readback = await c.send('Runtime.callFunctionOn', { objectId: monitorId,
        functionDeclaration: 'function () { return this.finish(); }', returnByValue: true });
    } catch (e) {
      if (e && (e.code === 'REF_TAB_CLOSED' || e.code === 'TARGET_DETACHED')) throw e;
      const lost = new Error('the files were handed to the input, but the selection could not be read back (the page may have navigated or reloaded); the form may already have been submitted. Take a fresh browser.snapshot before retrying');
      lost.effectUnknown = true;
      lost.cause = e;
      throw lost;
    }
    if (readback.exceptionDetails) throw new Error('file selection could not be read back; inspect the page before retrying');
    const receipt = readback.result && readback.result.value;
    // the browser's own count starts at the request, so an upload POST still in flight counts; resource timing lists only finished ones
    if (receipt && receipt.pageReaction && typeof requestsSeen === 'function') receipt.pageReaction.requests = Math.max(Number(receipt.pageReaction.requests) || 0, Math.max(0, requestsSeen() - seenBefore));
    const wanted = confirmWanted;
    const retained = receipt && receipt.connected && matches(receipt.files, wanted);
    const observed = receipt && Array.isArray(receipt.events) && receipt.events.find(e => matches(e.files, wanted));
    if (!retained && !observed) throw new Error('the file input did not confirm the requested file selection; it may have rejected or replaced it. Inspect the page before retrying; remote upload is not verified');
    return { status: 'selected', input: receipt.input, files: retained ? receipt.files : observed.files,
      retained: !!retained, events: receipt.events.map(e => e.type), evidence: retained ? 'FileList readback' : 'file-selection event',
      resolvedBy, clicked, pageReaction: receipt.pageReaction || null };
  } catch (e) {
    // A FAILED HAND-OFF (run-paths-polish m1): a failure once the files were handed to the input says so, so the tool
    // empties every input holding them (by the File's own path) before it drops the staged copies. Before the hand-off
    // nothing can hold them, and the copies are simply dropped.
    if (handed && e && typeof e === 'object') e.handed = true;
    throw e;
  } finally {
    if (monitorId) {
      await c.send('Runtime.callFunctionOn', { objectId: monitorId, functionDeclaration: 'function () { this.stop(); }' }).catch(e => failNote('browser.upload.observer-cleanup', e));
      await c.send('Runtime.releaseObject', { objectId: monitorId }).catch(e => failNote('browser.upload.object-cleanup', e));
    }
    await c.send('Runtime.releaseObject', { objectId }).catch(e => failNote('browser.upload.object-cleanup', e));
  }
}
/* EMPTY ONE FILE INPUT, PROVEN (review round 6). DOM.setFileInputFiles with no files is a no-op in real Chrome (the
   input kept its FileList: scratchpad fixer-r6/clear-debug.js), so the input is emptied the way page script may empty
   it, by setting its value to '', and the empty FileList is read back in the same call. Throws when it is not empty.
   files (Codex A3-LIFE-01): the File objects whose paths were proven. The input is emptied only while it still holds
   exactly those Files, compared by identity in the SAME page-side call that empties it (one JS turn: no selection can
   land in between), so a newer selection made meanwhile (another file chosen in that input) is left as it is.
   -> true: emptied | false: it holds another selection now, untouched */
const EMPTY_IF_SAME = 'function () { var now = this.files, n = arguments.length; if (!now || now.length !== n) return -2;'
  + ' for (var i = 0; i < n; i++) if (now[i] !== arguments[i]) return -2;'
  + ' this.value = ""; return this.files ? this.files.length : -1; }';
async function emptyInput(c, objectId, files) {
  const r = await c.send('Runtime.callFunctionOn', files
    ? { objectId, returnByValue: true, functionDeclaration: EMPTY_IF_SAME, arguments: files.map(id => ({ objectId: id })) }
    : { objectId, returnByValue: true, functionDeclaration: 'function () { this.value = ""; return this.files ? this.files.length : -1; }' });
  if (files && r && !r.exceptionDetails && r.result && r.result.value === -2) return false;
  if (!r || r.exceptionDetails || !r.result || r.result.value !== 0) throw new Error('the file input could not be emptied');
  return true;
}
/* Cancel a selection: empty the resolved file input (emptyInput). Called when the staged copy was found to have changed
   around the hand-off, so a later form submit sends nothing. */
async function clearFiles({ cdp: c, node }) {
  await c.send('DOM.enable');
  const x = node.x + Math.max(1, Math.floor(node.w / 2)), y = node.y + Math.max(1, Math.floor(node.h / 2));
  const resolved = await c.send('Runtime.evaluate', { expression: '(' + inputAtPoint.toString() + ')(' + [x, y, 1].map(v => JSON.stringify(v)).join(',') + ')' });
  const problem = pageError(resolved, 'upload control could not be resolved');
  if (problem) throw problem;
  const objectId = resolved && resolved.result && resolved.result.objectId;
  if (!objectId) throw new Error('upload control could not be resolved; the selection was not cleared');
  try { await emptyInput(c, objectId); }
  finally { await c.send('Runtime.releaseObject', { objectId }).catch(e => failNote('browser.upload.object-cleanup', e)); }
  return { cleared: true };
}
/* Serialized into the page as fixed code: every file input that holds a file, in the document, its same-origin frames
   and its open shadow roots (a cross-origin frame's contentDocument is null, and browser.upload never selects there). */
function fileInputsHolding() {
  const out = [], seen = new Set();
  const walk = (root, depth) => {
    if (!root || depth > 8 || seen.has(root)) return;
    seen.add(root);
    for (const el of root.querySelectorAll('input[type=file]')) if (el.files && el.files.length) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') walk(el.contentDocument, depth + 1);
    }
  };
  walk(document, 0);
  return out;
}
/* Cancel a staged copy everywhere it was selected (review round 6): every file input of the page whose FileList holds a
   File at one of `paths` (DOM.getFileInfo: the File's own path, so no ref, scroll or layout can aim this at the wrong
   input) is emptied (emptyInput, proven). -> { cleared, paths } (the inputs emptied, and the path of EVERY File they
   held: a multi-file input is emptied whole, so the caller drops and names the other copies it held too; review round
   7 minor 3). caseless: compare paths without case (Windows). Throws when an input that holds one could not be emptied.
   ONLY THAT SELECTION (Codex A3-LIFE-01): an input is emptied only while it still holds the very File objects whose
   paths were read here (emptyInput's identity check, in the page, in the same step as the clear); one whose selection
   changed in the meantime is left alone and not counted. signal: aborted when the caller stopped waiting (its bounded
   wait gave up and it already reported the input as not emptied), so nothing is changed after that. */
async function clearFilesHolding({ cdp: c, paths, caseless, signal }) {
  const norm = p => { const r = path.resolve(String(p)); return caseless ? r.toLowerCase() : r; };
  const want = new Set((paths || []).map(norm));
  const group = 'starnet-upload-clear';
  const items = async objectId => {
    const r = await c.send('Runtime.getProperties', { objectId, ownProperties: true });
    return ((r && r.result) || []).filter(p => /^\d+$/.test(p.name) && p.value && p.value.objectId).map(p => p.value.objectId);
  };
  let cleared = 0;
  const held = [];
  await c.send('DOM.enable');   // DOM.getFileInfo
  try {
    const list = await c.send('Runtime.evaluate', { expression: '(' + fileInputsHolding.toString() + ')()', objectGroup: group });
    const problem = pageError(list, 'the page\'s file inputs could not be listed');
    if (problem) throw problem;
    const listId = list && list.result && list.result.objectId;
    for (const inputId of (listId ? await items(listId) : [])) {
      const files = await c.send('Runtime.callFunctionOn', { objectId: inputId, functionDeclaration: 'function () { return Array.from(this.files || []); }', objectGroup: group });
      const filesId = files && files.result && files.result.objectId;
      let holds = false;
      const its = [], fileIds = filesId ? await items(filesId) : [];
      for (const fileId of fileIds) {
        const info = await c.send('DOM.getFileInfo', { objectId: fileId });
        if (!info || !info.path) continue;
        its.push(String(info.path));
        if (want.has(norm(info.path))) holds = true;
      }
      if (!holds) continue;
      if (signal && signal.aborted) break;   // the caller stopped waiting: change nothing now
      if (await emptyInput(c, inputId, fileIds)) { cleared++; held.push(...its); }
    }
  } finally {
    await c.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(e => failNote('browser.upload.object-cleanup', e));
  }
  return { cleared, paths: held };
}
module.exports = { selectFiles, clickForChooser, clearFiles, clearFilesHolding, _internals: { inputAtPoint, controlAtPoint, observeSelection, matches, fileInputsHolding, acceptRefusal } };
