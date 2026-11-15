'use strict';
// Exercise the production card renderers and folder-button handler, not a copied implementation.
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const A = require('./_assert.js');
const D = require('../frontend/app/deliverables.js');
const source = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.handlers = {}; this.className = ''; this.textContent = ''; this.disabled = false;
    this.classList = { add: (...values) => { this.className += ' ' + values.join(' '); } }; }
  appendChild(n) { this.children.push(n); return n; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return this.attributes[k]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const cls = selector.slice(1), found = [];
    for (const child of this.children) { if (String(child.className).split(' ').includes(cls)) found.push(child); if (child.querySelectorAll) found.push(...child.querySelectorAll(selector)); }
    return found;
  }
  click() { const e = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; this.handlers.click(e); return e; }
}
const calls = [], notices = [], rows = [], openedFiles = [], copies = [];
let fail = null, hold = null;
const core = { invoke: async (command, args) => { calls.push({ command, args }); if (fail) throw fail; if (hold) await hold; } };
const ctx = vm.createContext({
  document: { createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }) },
  tauriCore: () => core, glyphSpan: () => new Element('span'), SVG_FOLDER: '',
  setTimeout: () => 0, StationUI: { notify: text => notices.push(text) },
  copyArtifactPath: (...args) => copies.push(args),
  copyPathButton: () => { const n = new Element('button'); n.className = 'deliverable-copy-path'; return n; },
  wireFileOpen: (_a, ...args) => openedFiles.push(args), wireLightbox() {},
  fileBlobUrl: async () => 'blob:test', openFallback() {},
  row: () => { const r = { d: new Element('div'), body: new Element('div') }; rows.push(r); return r; },
  noteDeliveryLanding() {}, autoscroll() {}, deliverableAlreadyShown: () => true,
  fmtBytes: n => n + ' B', URL: { revokeObjectURL() {} }
});
for (const name of ['resetFeedbackLabel', 'folderButton', 'inRoot', 'deliverableLine', 'imageDeliverableLine', 'mediaPlayerLine', 'recapArtifactLine']) {
  vm.runInContext(A.fnBody(source, 'function ' + name + '('), ctx);
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const ROOT = 'E:\\Example Workspace\\Creator Project';
const REL = 'mission-004-quality-review\\LEAD_QUALITY_REPORT.md';
(async () => {
  for (const [render, ext] of [['deliverableLine','md'], ['deliverableLine','svg'], ['deliverableLine','py'], ['imageDeliverableLine','png'], ['mediaPlayerLine','mp4']]) {
    calls.length = 0;
    const p = 'nested folder/report.' + ext;
    if (render === 'mediaPlayerLine') ctx[render](p, 'designer', 'video', ROOT);
    else ctx[render](p, 'designer', ROOT);
    const b = rows.at(-1).body.querySelector('.deliverable-folder');
    A.ok(b, render + ': folder key exists for ' + ext);
    A.eq(b.getAttribute('data-default-label'), 'OPEN FOLDER', 'clear folder label');
    const event = b.click(); await tick();
    A.eq(calls, [{ command:'starnet_reveal_path', args: {path: ROOT + '/' + p, agentId: 'designer'} }], render + ': one click reveals exact project file');
    A.ok(event.prevented && event.stopped, 'folder click cannot also open file or toggle card');
    A.eq(b.querySelector('.fb-label').textContent, 'opened', 'feedback only after native success');
  }
  calls.length = 0;
  ctx.deliverableLine('nested folder/report.py', 'worker-7');
  rows.at(-1).body.querySelector('.deliverable-folder').click(); await tick();
  A.eq(calls[0].args, {path:'nested folder/report.py',agentId:'worker-7'}, 'agent-relative paths retain the writing owner');
  calls.length = 0;
  const abs = ROOT + '\\' + REL;
  const recap = ctx.recapArtifactLine({path:abs,kind:'file'},'foreman','run-004');
  A.ok(recap.querySelector('.deliverable-folder'), 'completed recap keeps folder action even when original row was shown');
  recap.querySelector('.deliverable-folder').click(); await tick();
  A.eq(calls[0].args.path, abs, 'recap reveals exact saved absolute path');
  A.eq(ctx.inRoot(ROOT,abs),abs,'absolute paths are never prefixed again');
  A.ok(openedFiles.length > 0, 'normal filename open remains separately wired');
  for (const error of ['the saved artifact no longer exists','artifact is outside the station workspace and trusted folders','protected station paths cannot be opened']) {
    calls.length = 0; fail = new Error(error);
    const b = ctx.folderButton('worker-7', 'missing.md'); b.click(); await tick();
    A.eq(calls.length,1,'failure never triggers another launch');
    A.ok(notices.at(-1).includes(error),'native failure reason reaches user');
    A.eq(b.querySelector('.fb-label').textContent,'could not open folder','visible failure, no false success');
    A.eq(b.disabled,false,'failed button can be retried');
  }
  fail = null;
  A.eq(copies.length,0,'native errors never silently copy a path');
  let release; hold = new Promise(r=>{release=r;}); calls.length=0;
  const b = ctx.folderButton('agent','out.md'); b.click(); b.click(); await tick();
  A.eq(calls.length,1,'in-flight double click cannot launch twice'); release(); await tick(); hold=null;
  // DELIVERABLES uses the same production folder button with backend-proven addresses.
  for (const url of [
    '/api/file?agent=foreman&path='+encodeURIComponent(REL)+'&project='+encodeURIComponent(ROOT),
    '/api/file?agent=designer&path='+encodeURIComponent('nested folder/output.svg'),
    '/api/file?agent=foreman&path='+encodeURIComponent(abs),
    '/workshop-run/designer/run-004/sub%20dir/image.png'
  ]) {
    const loc = D.savedLocation({agentId:'fallback'}, {path:'wrong-display-name.md',openUrl:url}, ROOT);
    calls.length=0; ctx.folderButton(loc.agentId,loc.path).click(); await tick();
    A.eq(calls[0], {command:'starnet_reveal_path',args:{path:loc.path,agentId:loc.agentId}}, 'DELIVERABLES reveals backend location with its actual owner');
  }
  const loc = D.savedLocation({agentId:'foreman'},{openUrl:'/api/file?agent=foreman&path='+encodeURIComponent(REL)+'&project='+encodeURIComponent(ROOT)},ROOT);
  A.eq(loc.path,abs,'actual project report resolves to exact E: path');
  // OPEN FILE must keep the proven project root and actual URL owner too.
  const savedWindow = global.window;
  global.window = {__TAURI__: {core}, getSelection: () => ''};
  try {
    calls.length = 0;
    const f = {path:REL,preview:'markdown',openUrl:'/api/file?agent=foreman&path='+encodeURIComponent(REL)+'&project='+encodeURIComponent(ROOT)};
    const card = {dataset:{i:'0'},querySelector:()=>null};
    const link = {dataset:{file:'0'},closest: sel => sel === 'a[data-file]' ? link : sel === '[data-i]' ? card : null};
    await D.handleOpenClick({target:link,preventDefault(){},stopPropagation(){}},[{agentId:'wrong-display-owner',files:[f]}]);
    A.eq(calls, [{command:'starnet_open_artifact',args:{path:abs,agentId:'foreman'}}], 'OPEN FILE remains separate and uses the same backend-proven project location');
  } finally { global.window = savedWindow; }
  A.report('windows-output-folder');
})().catch(error=>{console.error(error);process.exit(1);});
