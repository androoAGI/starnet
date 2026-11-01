/* #104 review round: when browser.upload may click, what a click may do, and what the accept list and the "page did not
   react" line may claim. No browser: the page-side functions run over a small fake DOM, and the click race over a fake CDP
   channel. The real-Chromium half is browser-upload-chooser.e2e. */
'use strict';
const A = require('./_assert.js');
const vm = require('node:vm');
const Upload = require('../sidecar/tools/builtin/browser-upload.js');
const { controlAtPoint, acceptRefusal, observeSelection } = Upload._internals;
const { selectFiles, clickForChooser } = Upload;

// ---- a fake DOM: just what controlAtPoint reads
function el(tag, attrs, kids, extra) {
  const a = attrs || {};
  const node = Object.assign({
    tagName: tag, id: a.id || '', type: a.type || (tag === 'BUTTON' ? 'submit' : ''), form: null, disabled: false, value: a.value || '',
    innerText: a.text || '', parentElement: null, kids: kids || [],
    getAttribute: k => (a[k] == null ? null : String(a[k])), hasAttribute: k => a[k] != null,
    getRootNode: () => ({}),
    closest(sel) { const tags = sel.split(',').map(s => s.toUpperCase()); for (let n = node; n; n = n.parentElement) if (tags.includes(n.tagName)) return n; return null; },
    querySelector(sel) { return sel === 'img[alt]' ? all(node).find(n => n.tagName === 'IMG' && n.getAttribute('alt') != null) || null : null; },
    querySelectorAll(sel) { return sel === 'input[type=file]' ? all(node).filter(n => n.tagName === 'INPUT' && n.type === 'file') : []; },
    getBoundingClientRect: () => (a.hiddenInput ? { width: 0, height: 0 } : { width: 100, height: 20 }),
    style: { display: a.hiddenInput ? 'none' : 'block', visibility: 'visible', opacity: '1' }
  }, extra || {});
  for (const k of node.kids) k.parentElement = node;
  return node;
}
function all(n) { return n.kids.reduce((out, k) => out.concat(k, all(k)), []); }
function verdict(target) {
  const doc = { elementFromPoint: () => target, defaultView: { getComputedStyle: n => n.style } };
  return vm.runInNewContext('(' + controlAtPoint.toString() + ')(5,5)', { document: doc, Number, String, Array });
}
const hiddenInput = () => el('INPUT', { type: 'file', hiddenInput: true }, [], { type: 'file' });
const shownInput = () => el('INPUT', { type: 'file' }, [], { type: 'file' });
const button = (text, attrs, extra) => el('BUTTON', Object.assign({ text, type: 'button' }, attrs), [], Object.assign({ type: 'button' }, extra));

// ---- may this control be clicked
{
  const inSection = (b, input) => { el('SECTION', {}, input ? [b, input] : [b]); return b; };
  for (const name of ['CHOOSE PHOTO', 'Upload', 'UPLOAD PHOTO', 'Add up to 20 photos', 'Browse', 'Attach a file', 'Select images', 'Drag and drop your files'])
    A.eq(verdict(inSection(button(name), hiddenInput())).click, true, 'named upload, input hidden: ' + name);
  for (const name of ['PUBLISH LISTING', 'Save', 'Next', 'Delete photo', 'Publish and upload', 'Submit upload', 'Send file', 'Photos', 'OK', ''])
    A.eq(verdict(inSection(button(name), hiddenInput())).click, false, 'not an upload name: ' + JSON.stringify(name));
  A.eq(verdict(inSection(button('UPLOAD PHOTO'), shownInput())).click, false, 'a visible input beside it is what the page asks for: that button sends, it does not choose');
  // the review's two regressions, as written
  const inForm = button('UPLOAD PHOTO', { type: 'submit' }, { type: 'submit' });
  inForm.form = {};
  el('FORM', {}, [inForm, shownInput()]);
  A.ok(/submit/.test(verdict(inForm).why), 'a submit button in a form is never clicked');
  const hiddenForm = button('UPLOAD PHOTO', { type: 'submit' }, { type: 'submit' });
  hiddenForm.form = {};
  el('FORM', {}, [hiddenForm, hiddenInput()]);
  A.eq(verdict(hiddenForm).click, false, 'nor when the input is hidden: submit-capable decides first');
  const typeButton = button('UPLOAD PHOTO');
  typeButton.form = {};
  el('FORM', {}, [typeButton, hiddenInput()]);
  A.eq(verdict(typeButton).click, true, 'type=button inside a form cannot submit it');
  A.eq(verdict(inSection(button('PUBLISH LISTING'), shownInput())).click, false, 'PUBLISH LISTING is not clicked');
  const outsideForm = button('UPLOAD PHOTO', { type: 'submit' }, { type: 'submit' });
  A.eq(verdict(inSection(outsideForm, hiddenInput())).click, true, 'a default-type button with no form has nothing to submit');
  const off = button('UPLOAD PHOTO', {}, { disabled: true });
  A.eq(verdict(inSection(off, hiddenInput())).click, false, 'disabled');
  const link = el('A', { text: 'Upload photo', href: '/upload' });
  A.ok(/link/.test(verdict(link).why), 'a real link navigates');
  A.eq(verdict(el('A', { text: 'Upload photo', href: '#' })).click, true, 'an in-page anchor does not');
  // the name comes from the control: a click on an inner span, an icon with a label, an id, an image's alt
  const span = el('SPAN', { text: '' });
  el('BUTTON', { 'aria-label': 'Upload photo', type: 'button' }, [span], { type: 'button' });
  A.eq(verdict(span).click, true, 'an icon inside a labelled button');
  A.eq(verdict(el('DIV', { id: 'photoUpload', role: 'button' })).click, true, 'an id that says so, camelCase split');
  A.eq(verdict(el('DIV', { id: 'publish-upload', role: 'button' })).click, false, 'the other word wins');
  A.eq(verdict(el('DIV', { role: 'button', text: 'upload ' + 'x'.repeat(90) })).click, false, 'a long text is content, not a name');
}

// ---- the accept list refuses only what it can prove
{
  for (const [accept, file] of [['image/x-png', 'a.png'], ['image/*;capture=camera', 'a.png'], ['image/png; q=1', 'a.png'], ['audio/mp3', 'a.mp3'], ['audio/mpeg3', 'a.mp3'], ['.jpg', 'a.jpeg'], ['.jpeg', 'a.JPG'], ['image/jpg', 'a.jpeg'],
    ['audio/*', 'a.webm'], ['video/*', 'a.webm'], ['audio/mp4', 'a.mp4'], ['png,jpg', 'a.pdf'], ['image', 'a.pdf'], ['*', 'a.pdf'], ['audio/x-wav', 'a.wav']])
    A.eq(acceptRefusal(accept, [file]), '', accept + ' does not refuse ' + file);
  for (const [accept, file] of [['video/*', 'a.png'], ['image/*', 'a.pdf'], ['.pdf', 'a.png'], ['image/png', 'a.jpg'], ['image/*;capture=camera', 'a.mp4']])
    A.ok(/not a\./.test(acceptRefusal(accept, [file])), accept + ' refuses ' + file);
  A.ok(/not b\.png/.test(acceptRefusal('.jpg', ['a.jpg', 'b.png'])), 'every file is checked');
}

// ---- page reaction: every same-origin document is watched, and an unreadable ancestor is partial
{
  const observerLog = [];
  const makeWin = () => {
    const w = { frames: [], parent: null, document: { documentElement: {} }, performance: { count: 0, getEntriesByType() { return new Array(w.performance.count); } } };
    w.parent = w;
    w.MutationObserver = function (fn) { this.fire = () => fn([{}]); this.observe = () => observerLog.push(this); this.takeRecords = () => []; this.disconnect = () => {}; };
    return w;
  };
  const input = own => ({ addEventListener() {}, removeEventListener() {}, files: [], id: '', name: '', accept: '', multiple: false, isConnected: true, ownerDocument: own.document });
  const top = makeWin(), frame = makeWin();
  frame.parent = top; top.frames = [frame]; frame.document.defaultView = frame;
  const box = observeSelection.call(input(frame));
  A.eq(observerLog.length, 2, 'the input is in a frame: both documents are watched');
  observerLog[0].fire();   // the page around the iframe shows the thumbnail
  top.performance.count = 1;
  const r = box.finish().pageReaction;
  A.eq([r.domChanges, r.requests, r.partial], [1, 1, false], 'a change in the parent document and a request from it are the page reacting');
  A.ok(typeof observeSelection.call(input(frame)).peek === 'function', 'peek reads without ending the observation');
  const walled = makeWin();
  walled.parent = {};
  Object.defineProperty(walled.parent, 'document', { get() { throw new Error('cross-origin'); } });
  walled.document.defaultView = walled;
  A.eq(observeSelection.call(input(walled)).finish().pageReaction.partial, true, 'a cross-origin parent leaves the answer partial');
}

(async () => {
  // ---- an in-flight request counts: resource timing lists only finished ones
  {
    let started = 3;
    const cdp = { send: async (method, args) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input' } };
      if (method === 'DOM.setFileInputFiles') { started++; return {}; }
      if (method === 'Runtime.callFunctionOn' && /this\.finish/.test(args.functionDeclaration)) return { result: { value: { connected: true, files: [{ name: 'p.png', size: 1 }], events: [], input: {}, pageReaction: { domChanges: 0, requests: 0, partial: false } } } };
      if (method === 'Runtime.callFunctionOn' && /this\.peek/.test(args.functionDeclaration)) return { result: { value: { connected: true, files: [{ name: 'p.png', size: 1 }], events: [] } } };
      if (method === 'Runtime.callFunctionOn' && args.objectId === 'input' && !args.returnByValue) return { result: { objectId: 'observer' } };
      return { result: {} };
    } };
    const got = await selectFiles({ cdp, node: { x: 0, y: 0, w: 9, h: 9 }, paths: ['p.png'], expected: [{ name: 'p.png', size: 1 }], settle: async () => {}, requestsSeen: () => started });
    A.eq(got.pageReaction.requests, 1, 'the request Chrome saw start is in the receipt');
    A.eq(got.clicked, false, 'a direct input is never clicked');
  }

  // ---- the selection that confirms late (an input outside the document has only its event)
  {
    let peeks = 0;
    const late = { name: 'p.png', size: 1 };
    const events = () => (peeks >= 3 ? [{ type: 'change', files: [late] }] : []);
    const cdp = { send: async (method, args) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'input' } };
      if (method === 'Runtime.callFunctionOn' && /this\.peek/.test(args.functionDeclaration)) { peeks++; return { result: { value: { connected: false, files: [], events: events() } } }; }
      if (method === 'Runtime.callFunctionOn' && /this\.finish/.test(args.functionDeclaration)) return { result: { value: { connected: false, files: [], events: events(), input: {} } } };
      if (method === 'Runtime.callFunctionOn' && args.objectId === 'input' && !args.returnByValue) return { result: { objectId: 'observer' } };
      return { result: {} };
    } };
    const got = await selectFiles({ cdp, node: { x: 0, y: 0, w: 9, h: 9 }, paths: ['p.png'], expected: [late], settle: async () => {} });
    A.eq([got.evidence, peeks], ['file-selection event', 3], 'a change event after the settle still confirms, and the wait stops when it lands');
    peeks = -1000;
    let refused = '';
    try { await selectFiles({ cdp, node: { x: 0, y: 0, w: 9, h: 9 }, paths: ['p.png'], expected: [late], settle: async () => {}, confirmWaitMs: 200 }); }
    catch (e) { refused = e.message; }
    A.ok(/did not confirm/.test(refused), 'a page that never confirms is still refused: ' + refused);
  }

  // ---- whether the click happens at all, and what a refusal says after one
  {
    const page = (verdictValue, positionObject) => ({ send: async (method, args) => {
      if (method === 'Runtime.evaluate' && /controlAtPoint/.test(args.expression)) return { result: { value: verdictValue } };
      if (method === 'Runtime.evaluate' && args.expression.endsWith(',true)')) return { result: {} };
      if (method === 'Runtime.evaluate') return positionObject ? { result: { objectId: 'near' } } : { exceptionDetails: { text: 'x', exception: { description: 'Error: no associated file input found at this ref' } } };
      if (method === 'Runtime.callFunctionOn' && /this\.finish|this\.peek/.test(args.functionDeclaration)) return { result: { value: { connected: true, files: [{ name: 'p.png', size: 1 }], events: [], input: {} } } };
      if (method === 'Runtime.callFunctionOn' && args.objectId === 'near' && !args.returnByValue) return { result: { objectId: 'observer' } };
      return { result: {} };
    } });
    let clicks = 0;
    const open = async () => { clicks++; return null; };
    const go = cdp => selectFiles({ cdp, node: { x: 0, y: 0, w: 9, h: 9 }, paths: ['p.png'], expected: [{ name: 'p.png', size: 1 }], settle: async () => {}, openChooser: open });
    const near = await go(page({ click: false, why: 'its name says it does something else' }, true));
    A.eq([clicks, near.clicked, near.resolvedBy], [0, false, 'position: the only file input near this control'], 'unsure: no click, the old path to the nearby input');
    const odd = await go(page('not an object', true));
    A.eq(clicks, 0, 'a verdict that cannot be read is a no');
    A.eq(odd.clicked, false, 'and the receipt says no click');
    let msg = '';
    try { await go(page({ click: false }, false)); } catch (e) { msg = e.message; }
    A.ok(/no associated file input/.test(msg) && !/clicked/.test(msg), 'with no input and no click, the refusal claims no click: ' + msg);
    let err = null;
    try { await go(page({ click: true }, false)); } catch (e) { err = e; }
    A.ok(err && /opened no file chooser/.test(err.message) && err.clicked === true, 'a refusal after a click says so: ' + (err && err.message));
    const later = await selectFiles({ cdp: page({ click: true }, true), node: { x: 0, y: 0, w: 9, h: 9 }, paths: ['p.png'], expected: [{ name: 'p.png', size: 1 }], settle: async () => { throw new Error('the settle broke; no file was selected'); }, openChooser: open }).catch(e => e);
    A.ok(/this control was clicked first/.test(later.message) && /no file was selected/.test(later.message), 'any later failure names the click: ' + later.message);
    const blocked = await selectFiles({ cdp: page({ click: true }, false), node: { x: 0, y: 0, w: 9, h: 9 }, paths: ['p.png'], settle: async () => {}, openChooser: async () => { throw Object.assign(new Error('another browser.upload is clicking on this tab; no file was selected'), { notClicked: true }); } }).catch(e => e);
    A.ok(!/clicked first/.test(blocked.message) && !blocked.clicked, 'a click that never happened is not claimed');
  }

  // ---- the click race
  {
    const channel = (over) => {
      const calls = [];
      let loader = 'L1';
      return { calls, setLoader: v => { loader = v; }, send: async (method, args) => {
        calls.push([method, args]);
        if (over && over[method]) return over[method](args);
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: loader } } };
        return {};
      } };
    };
    const offs = c => c.calls.filter(x => x[0] === 'Page.setInterceptFileChooserDialog').map(x => x[1].enabled);
    const run = (c, click, onListen) => {
      let stops = 0;
      const out = clickForChooser({ cdp: c, node: {}, click, graceMs: 20, boundMs: 300, listen: h => { if (onListen) onListen(h); return () => { stops++; }; } });
      return out.then(v => ({ v, stops }), e => ({ e, stops }));
    };
    const tick = ms => new Promise(r => setTimeout(r, ms));

    let h, c = channel();
    let r = await run(c, async () => { h.chooser({ backendNodeId: 77 }); }, x => { h = x; });
    A.eq([r.v, r.stops, offs(c)], [77, 1, [true, false]], 'the input the page opened; listening and interception both end');

    c = channel();
    r = await run(c, async () => {}, x => { h = x; });
    A.eq([r.v, offs(c)], [null, [true, false]], 'no chooser: null, interception off');

    c = channel();
    r = await run(c, async () => { setTimeout(() => h.chooser({ backendNodeId: 9 }), 5); }, x => { h = x; });
    A.eq(r.v, 9, 'a chooser just after the click answered is inside the grace');

    // a confirm() stops the renderer: the click never answers
    c = channel();
    const t0 = Date.now();
    r = await run(c, () => new Promise(() => { setTimeout(() => h.dialog({ type: 'confirm' }), 5); }), x => { h = x; });
    A.ok(r.e && /was clicked/.test(r.e.message) && /confirm dialog/.test(r.e.message) && /dismissed/.test(r.e.message), 'a dialog from the click refuses and names the click: ' + (r.e && r.e.message));
    A.eq(c.calls.find(x => x[0] === 'Page.handleJavaScriptDialog')[1], { accept: false }, 'it is dismissed, never accepted');
    A.eq(offs(c), [true, false], 'interception off after a dialog');
    A.ok(Date.now() - t0 < 5000, 'bounded');

    // a click that never answers and no event at all
    c = channel();
    r = await run(c, () => new Promise(() => {}), x => { h = x; });
    A.ok(r.e && /did not answer in time/.test(r.e.message), 'a hung click refuses at its bound: ' + (r.e && r.e.message));
    A.eq(offs(c), [true, false], 'interception off after the bound');

    // the click itself throws
    c = channel();
    r = await run(c, async () => { throw new Error('tab went away'); }, x => { h = x; });
    A.ok(r.e && /tab went away/.test(r.e.message), 'a failed click propagates');
    A.eq([offs(c), r.stops], [[true, false], 1], 'interception off and listener gone when this path throws');

    // the off call failing must not hide the answer
    c = channel({ 'Page.setInterceptFileChooserDialog': a => { if (!a.enabled) throw new Error('off failed'); return {}; } });
    r = await run(c, async () => { h.chooser({ backendNodeId: 5 }); }, x => { h = x; });
    A.eq(r.v, 5, 'a failed off is noted, not fatal');

    // interception that never starts: no click happened
    c = channel({ 'Page.setInterceptFileChooserDialog': a => { if (a.enabled) throw new Error('no intercept'); return {}; } });
    let clicked = false;
    r = await run(c, async () => { clicked = true; }, x => { h = x; });
    A.eq([clicked, r.e && r.e.notClicked], [false, true], 'without interception there is no click, and the error says none happened');

    // navigation: by loader change, and by the request before it commits
    c = channel();
    r = await run(c, async () => { c.setLoader('L2'); }, x => { h = x; });
    A.ok(r.e && /navigated the page/.test(r.e.message) && /no file was selected/.test(r.e.message), 'the loader changed during the click: refused, never read as a selection');
    c = channel();
    r = await run(c, async () => { h.chooser({ backendNodeId: 7 }); c.setLoader('L2'); }, x => { h = x; });
    A.ok(r.e && /navigated/.test(r.e.message), 'even when a chooser also opened');
    c = channel();
    r = await run(c, async () => { h.navigation({ frameId: 'main' }); }, x => { h = x; });
    A.ok(r.e && /navigated/.test(r.e.message), 'a main-frame navigation requested but not committed yet counts');
    c = channel();
    r = await run(c, async () => { h.navigation({ frameId: 'ad-iframe' }); }, x => { h = x; });
    A.eq(r.v, null, 'an iframe navigating is not the page navigating');

    await tick(0);
  }
  A.report('browser-upload-chooser');
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
