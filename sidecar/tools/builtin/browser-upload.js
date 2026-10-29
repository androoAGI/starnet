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
/* Cancel a selection: hand the resolved file input an EMPTY FileList (DOM.setFileInputFiles with no files). Called when
   the staged copy was found to have changed around the hand-off, so a later form submit sends nothing. */
async function clearFiles({ cdp: c, node }) {
  await c.send('DOM.enable');
  const x = node.x + Math.max(1, Math.floor(node.w / 2)), y = node.y + Math.max(1, Math.floor(node.h / 2));
  const resolved = await c.send('Runtime.evaluate', { expression: '(' + inputAtPoint.toString() + ')(' + [x, y, 1].map(v => JSON.stringify(v)).join(',') + ')' });
  const problem = pageError(resolved, 'upload control could not be resolved');
  if (problem) throw problem;
  const objectId = resolved && resolved.result && resolved.result.objectId;
  if (!objectId) throw new Error('upload control could not be resolved; the selection was not cleared');
  try { await c.send('DOM.setFileInputFiles', { files: [], objectId }); }
  finally { await c.send('Runtime.releaseObject', { objectId }).catch(e => failNote('browser.upload.object-cleanup', e)); }
  return { cleared: true };
}
module.exports = { selectFiles, clearFiles, _internals: { inputAtPoint, observeSelection, matches } };
