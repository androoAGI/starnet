/* browser-upload.js — #104: prove local file selection, never infer a remote upload.
   Runs on browser.js's pinned CDP channel so tab loss cannot redirect a file to another page. */
'use strict';
const path = require('node:path');
const { note: failNote } = require('../../failopen.js');

// Serialized into the page as fixed code; caller supplies only numeric coordinates and file count.
function inputAtPoint(x, y, count) {
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
function observeSelection() {
  const input = this, events = [];
  const files = () => Array.from(input.files || [], f => ({ name: f.name, size: f.size, type: f.type }));
  const observe = event => { if (events.length < 8) events.push({ type: event.type, files: files() }); };
  input.addEventListener('input', observe, true); input.addEventListener('change', observe, true);
  const stop = () => { input.removeEventListener('input', observe, true); input.removeEventListener('change', observe, true); };
  return { stop, finish() {
    stop();
    return { input: { id: input.id.slice(0, 200), name: input.name.slice(0, 200), accept: input.accept.slice(0, 500), multiple: input.multiple },
      connected: input.isConnected, files: files(), events };
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
async function selectFiles({ cdp: c, node, paths, expected, settle }) {
  await c.send('DOM.enable');
  const x = node.x + Math.max(1, Math.floor(node.w / 2)), y = node.y + Math.max(1, Math.floor(node.h / 2));
  const resolved = await c.send('Runtime.evaluate', { expression: '(' + inputAtPoint.toString() + ')(' + [x, y, paths.length].map(v => JSON.stringify(v)).join(',') + ')' });
  const problem = pageError(resolved, 'upload control could not be resolved');
  if (problem) throw problem;
  const objectId = resolved && resolved.result && resolved.result.objectId;
  if (!objectId) throw new Error('upload control could not be resolved; no file was selected');
  let monitorId;
  try {
    const monitor = await c.send('Runtime.callFunctionOn', { objectId, functionDeclaration: observeSelection.toString() });
    monitorId = monitor && monitor.result && monitor.result.objectId;
    if (!monitorId || monitor.exceptionDetails) throw new Error('could not observe the file input; no file was selected');
    await c.send('DOM.setFileInputFiles', { files: paths, objectId });
    await settle(c);
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
    const wanted = expected || paths.map(p => ({ name: path.basename(p) }));
    const retained = receipt && receipt.connected && matches(receipt.files, wanted);
    const observed = receipt && Array.isArray(receipt.events) && receipt.events.find(e => matches(e.files, wanted));
    if (!retained && !observed) throw new Error('the file input did not confirm the requested file selection; it may have rejected or replaced it. Inspect the page before retrying; remote upload is not verified');
    return { status: 'selected', input: receipt.input, files: retained ? receipt.files : observed.files,
      retained: !!retained, events: receipt.events.map(e => e.type), evidence: retained ? 'FileList readback' : 'file-selection event' };
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
   it, by setting its value to '', and the empty FileList is read back in the same call. Throws when it is not empty. */
async function emptyInput(c, objectId) {
  const r = await c.send('Runtime.callFunctionOn', { objectId, returnByValue: true,
    functionDeclaration: 'function () { this.value = ""; return this.files ? this.files.length : -1; }' });
  if (!r || r.exceptionDetails || !r.result || r.result.value !== 0) throw new Error('the file input could not be emptied');
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
   input) is emptied (emptyInput, proven). -> { cleared } (the inputs emptied). caseless: compare paths without case
   (Windows). Throws when an input that holds one could not be emptied. */
async function clearFilesHolding({ cdp: c, paths, caseless }) {
  const norm = p => { const r = path.resolve(String(p)); return caseless ? r.toLowerCase() : r; };
  const want = new Set((paths || []).map(norm));
  const group = 'starnet-upload-clear';
  const items = async objectId => {
    const r = await c.send('Runtime.getProperties', { objectId, ownProperties: true });
    return ((r && r.result) || []).filter(p => /^\d+$/.test(p.name) && p.value && p.value.objectId).map(p => p.value.objectId);
  };
  let cleared = 0;
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
      for (const fileId of (filesId ? await items(filesId) : [])) {
        const info = await c.send('DOM.getFileInfo', { objectId: fileId });
        if (info && info.path && want.has(norm(info.path))) { holds = true; break; }
      }
      if (holds) { await emptyInput(c, inputId); cleared++; }
    }
  } finally {
    await c.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(e => failNote('browser.upload.object-cleanup', e));
  }
  return { cleared };
}
module.exports = { selectFiles, clearFiles, clearFilesHolding, _internals: { inputAtPoint, observeSelection, matches, fileInputsHolding } };
