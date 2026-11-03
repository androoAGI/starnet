/* node test/closed-window-retainers.test.js — a CLOSED station window must not stay reachable (night-leak, 2026-10-15).
   A dock sweep on the soak's user station left 21.7k detached elements alive between sweeps; scans of every JS-visible
   holder pinned them on module state that outlived its window:
     SETTINGS  <- StationUI repaintAutonomyDial / repaintPermAgents (closures over the closed render)   3,509 elements
     CONNECT   <- StationUI skillsShown.win (the closed ABILITIES window itself)                           8,762 elements
     MY WORK   <- OutboxView `mounted` (until a crate change happened to prune it)                           696 elements
     AUTOMATE  <- WorkflowsWindow `body`                                                                     (pinned in workflows-window.test)
   This runs the real closeTerm + the SETTINGS / DELIVERABLES close hooks and the real OutboxView against stubs. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), A = require('./_assert');
const sui = fs.readFileSync(path.join(__dirname, '../frontend/app/stationui.js'), 'utf8');

/* ---- closeTerm hands the closing window to its teardown; SETTINGS' teardown drops both repaint hooks ---- */
{
  const closeTerm = A.fnBody(sui, 'function closeTerm(');
  const drop = A.fnBody(sui, 'function dropSettingsRepaints(');
  A.ok(closeTerm.length > 200 && drop.length > 20, 'the real closeTerm and SETTINGS teardown are sliced');
  const settingsEntry = (sui.match(/\n    settings: \['SETTINGS',[^\n]*\n/) || [''])[0];
  A.ok(/onClose: dropSettingsRepaints/.test(settingsEntry), 'BUILDERS.settings registers the teardown as its onClose');
  const dlvEntry = (sui.match(/\}, \{ console: true, className: 'dlv-win'[^\n]*\n/) || [''])[0];
  A.ok(/onClose: w => \{[^}]*OutboxView\.unmount\(w\)/.test(dlvEntry), 'BUILDERS.deliverables lets OutboxView go of the closing window');
  const run = Function('closeTermSrc', 'dropSrc', `
    let repaintAutonomyDial = () => 'paint', repaintPermAgents = () => 'paint';
    const open = {}, minimized = {}, calls = [], staleWins = {};   // staleWins: the render contract's paints owed (closeTerm drops them)
    const removeChip = () => {}, sfx = () => {}, syncBB = () => {}, syncScrim = () => {}, visibleCount = () => 1;
    const document = { getElementById: () => null };
    eval(dropSrc); eval(closeTermSrc);
    const win = { style: {}, classList: { add() {} }, addEventListener() {}, isConnected: true, remove() {} };
    win._onClose = (w) => { calls.push(w); dropSettingsRepaints(); };
    open.settings = win;
    closeTerm('settings');
    return { auto: repaintAutonomyDial, perm: repaintPermAgents, calls, win, open };`);
  const r = run(closeTerm, drop);
  A.eq([r.auto, r.perm], [null, null], 'closing SETTINGS leaves no repaint hook armed over the closed render');
  A.ok(r.calls.length === 1 && r.calls[0] === r.win, 'closeTerm passes the closing window to its teardown (exactly once)');
  A.ok(!('settings' in r.open), 'the slot is freed');
  // the live callers already treat a null hook as "no SETTINGS open"
  A.ok(/if \(repaintAutonomyDial\) repaintAutonomyDial\(\)/.test(sui) && /if \(repaintPermAgents\) repaintPermAgents\(\)/.test(sui), 'every caller of the hooks checks for null');
}

/* ---- OutboxView: a replaced or closed TO REVIEW host leaves `mounted` at once ---- */
{
  const src = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/outbox.js'), 'utf8');
  const host = () => ({ hidden: false, innerHTML: '', isConnected: true, querySelector: () => ({ addEventListener() {}, innerHTML: '' }), querySelectorAll: () => [] });
  const ctx = vm.createContext({ console, window: {}, document: { createElement: () => ({}) }, ReturnStore: { pendingRows: () => [] },
    StationUI: { registerWindow() {}, h: { esc: s => String(s), sfx() {}, fmtRel: () => '', notify() {}, openTerm() {}, WS: {}, persistWS() {} } } });
  vm.runInContext(src, ctx, { filename: 'outbox.js' });
  const OV = ctx.window.OutboxView;
  A.ok(OV && typeof OV.unmount === 'function' && typeof OV._mountedCount === 'function', 'OutboxView exposes unmount (and a count for probes)');
  const a = host(), b = host();
  OV.build(a); OV.build(b);
  A.eq(OV._mountedCount(), 2, 'two live TO REVIEW copies are both kept fresh');
  a.isConnected = false;           // DELIVERABLES re-rendered: its old host left the DOM
  const c = host(); OV.build(c);
  A.eq(OV._mountedCount(), 2, 'a build prunes a replaced (disconnected) copy at once, not at the next crate change');
  const win = { contains: el => el === b };
  OV.unmount(win);
  A.eq(OV._mountedCount(), 1, 'closing DELIVERABLES drops every copy inside the closing window, while it is still connected');
  OV.build(c); OV.build(c);
  A.eq(OV._mountedCount(), 1, 'rebuilding the same host never duplicates it');
}
/* ---- CHANNELS: the once-wired bus handler must not close over a window's build scope; close drops the refresh + poll ----
   (heap snapshot of the probe station: U.bus._h['channel.connect'][1] -> context -> body -> the FIRST CHANNELS window, and
   buildMessaging._refresh / the 30 s poll's DOMTimer -> the LAST one) */
{
  const src = fs.readFileSync(path.join(__dirname, '../frontend/app/windows/messaging.js'), 'utf8');
  const build = A.fnBody(src, 'function buildMessaging(');
  A.ok(build.length > 1000 && !/U\.bus\.on\(/.test(build), 'buildMessaging creates no bus handler (a closure made there would hold its window)');
  A.ok(/U\.bus\.on\('channel\.connect', onChannelConnect\)/.test(A.fnBody(src, 'function wireChannelHealth(')), 'the one channel.connect handler is the module-scope onChannelConnect');
  A.ok(/wireChannelHealth\(\);/.test(build), '...wired from the build, once');
  const registered = {}, intervals = new Set();
  const ctx = vm.createContext({ console, document: { querySelector: () => null }, U: { bus: { on() {} } },
    setInterval: (fn, ms) => { const id = { fn, ms }; intervals.add(id); return id; }, clearInterval: id => intervals.delete(id),
    StationUI: { registerWindow: (k, t, fn, o) => { registered[k] = { fn, o }; }, h: { sfx() {}, notify() {}, openTerm() {}, mountConsole() {}, present: [] } } });
  vm.runInContext(src, ctx, { filename: 'messaging.js' });
  const m = registered.messaging;
  A.ok(m && typeof m.o.onClose === 'function', 'CHANNELS registers a close teardown');
  m.fn._refresh = () => {}; m.fn._poll = ctx.setInterval(() => {}, 30000);
  m.o.onClose();
  A.ok(m.fn._refresh === null && m.fn._poll === null && intervals.size === 0, 'closing CHANNELS drops its refresh hook and stops its 30 s poll at once');
}
A.report('closed-window-retainers');
