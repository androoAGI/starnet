/* node test/litefx.test.js — LITE EFFECTS (frontend/app/litefx.js, frontend/css/litefx.css) and the COMMS scroll path.
 *
 * Customer report 2026-11-08: "a 2014 Mac is too slow to scroll" (an old Intel Mac, macOS 11-ish, integrated GPU,
 * WKWebView). Three things changed, each locked here:
 *   1. LiteFx.decide(): a weak machine (software renderer, no WebGL, an Intel GPU on a Mac, an old Intel HD part, <= 4
 *      logical CPUs, a STRAINED floor) or an OS ask (reduced transparency → glass, reduced motion → hold) turns the
 *      effects down. A capable machine, automation, and ?fx=full keep everything exactly as it was.
 *   2. The SCROLL HOLD: a reader's scroll outside a canvas asks the floor to stand aside (World.yieldToUi); the
 *      auto-follow's own scrolls, and the station's wheel zoom, never do.
 *   3. chat.js showNewPill() — run on every scroll event while reading history — writes nothing when the pill already
 *      says the right thing (it rewrote text, label and offset each event and forced a style recalc + layout per event).
 */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('frontend/app/litefx.js');
const L = require('../frontend/app/litefx.js');
const d = s => { const r = L.decide(s); return [r.glass, r.hold, r.weak]; };

// ---- 1. decide(): who gets lite
const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)';
A.eq(d({ cores: 16, mac: false, renderer: NVIDIA }), [false, false, false], 'a capable PC keeps every effect');
A.eq(d({ cores: 8, mac: true, renderer: 'Apple GPU' }), [false, false, false], 'an Apple Silicon Mac (masked GPU, 8 cores) keeps every effect');
A.eq(d({ cores: 8, mac: true, renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' }), [false, false, false], 'an M1 named by its GPU keeps every effect');
A.eq(d({ cores: 12, mac: false, renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x000046A6) Direct3D11 vs_5_0 ps_5_0, D3D11)' }), [false, false, false], 'a current Intel Iris Xe PC is not "old Intel"');
A.eq(d({ cores: 8, mac: false, renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)' }), [false, false, false], 'UHD naming is not the old HD part');
A.eq(d({ cores: 4, mac: true, renderer: 'Apple GPU' }), [true, true, true], 'a 2014 MacBook Air / 13" Pro (4 logical CPUs, masked GPU) → lite');
A.eq(d({ cores: 8, mac: true, renderer: 'Intel Iris Pro OpenGL Engine' }), [true, true, true], 'an Intel Mac named by its GPU → lite, whatever its CPU count');
A.eq(d({ cores: 8, mac: true, renderer: 'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)' }), [true, true, true], 'an Intel Mac through ANGLE → lite');
A.eq(d({ cores: 8, mac: false, renderer: 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)' }), [true, true, true], 'an old Intel HD part anywhere → lite');
A.eq(d({ cores: 16, renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)' }), [true, true, true], 'a software renderer → lite');
A.eq(d({ cores: 16, renderer: 'Microsoft Basic Render Driver' }), [true, true, true], 'Windows basic render → lite');
A.eq(d({ cores: 16, renderer: NVIDIA, caveat: true }), [true, true, true], 'a context that only exists with a major performance caveat → lite');
A.eq(d({ cores: 16, webgl: false }), [true, true, true], 'no WebGL at all → lite');
A.eq(d({ cores: 16, renderer: NVIDIA, strained: true }), [true, true, true], 'a STRAINED floor is a struggling machine → lite');
A.eq(d({ cores: 0, renderer: '' }), [false, false, false], 'an unknown CPU count is not a weak signal');
A.eq(d({ cores: 16, renderer: NVIDIA, reducedTransparency: true }), [true, false, false], 'reduced transparency → lighter glass only');
A.eq(d({ cores: 16, renderer: NVIDIA, reducedMotion: true }), [false, true, false], 'reduced motion → the floor stands aside during a scroll, glass kept');
A.eq(d({ cores: 2, mac: true, renderer: 'Intel HD Graphics 5000 OpenGL Engine', automation: true }), [false, false, false], 'automation keeps the shipped look whatever the machine');
A.eq(d({ cores: 2, webgl: false, override: 'full' }), [false, false, false], '?fx=full wins over every weak signal');
A.eq(d({ cores: 16, renderer: NVIDIA, automation: true, override: 'lite' }), [true, true, true], '?fx=lite wins, automation included (perf probes)');
A.ok(L.decide({ cores: 4, mac: true, renderer: 'Intel Iris Pro OpenGL Engine', reducedMotion: true }).why.join() === 'intel-mac-gpu,cores<=4,reduced-motion', 'why names every reason, in order');
A.eq(L.heavyPace({ strained: true, drawCostMs: 2 }), true, 'a strained floor is heavy');
A.eq(L.heavyPace({ strained: false, drawCostMs: L.HEAVY_DRAW_MS }), true, 'a draw that costs a whole 60 Hz frame is heavy');
A.eq(L.heavyPace({ strained: false, drawCostMs: 3 }), false, 'a cheap floor is not');
A.eq(L.heavyPace(null), false, 'no readout is not heavy');
A.ok(L.HOLD_MS > 16 && L.HOLD_MS < 250, 'the hold outlasts the gap between wheel events and stays under World\'s 250 ms cap');

// ---- 2. the browser glue, in a stub page
function page(opts = {}) {
  const listeners = {}, classes = new Set(), yields = [], idle = [];
  const on = (target) => (type, fn, o) => { (listeners[target + ':' + type] = listeners[target + ':' + type] || []).push({ fn, capture: !!(o && o.capture), passive: !!(o && o.passive) }); };
  let renderer = opts.renderer || '', made = 0, lost = 0;
  const document = {
    body: { classList: { toggle: (c, v) => { if (v) classes.add(c); else classes.delete(c); }, contains: c => classes.has(c) } },
    addEventListener: on('document'),
    createElement: () => ({ getContext: () => { if (opts.noWebgl) return null; made++; return {
      RENDERER: 0x1F01, getExtension: n => n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : n === 'WEBGL_lose_context' ? { loseContext: () => { lost++; } } : null,
      getParameter: p => p === 0x9246 ? renderer : '' }; } }),
  };
  let now = 1000;
  const pace = Object.assign({ strained: false, drawCostMs: 3 }, opts.pace || {});
  const ctx = {
    document, window: { addEventListener: on('window') }, location: { search: opts.search || '' },
    navigator: Object.assign({ hardwareConcurrency: 16, webdriver: false, platform: 'Win32', userAgent: 'Windows NT 10.0' }, opts.nav || {}),
    matchMedia: q => ({ matches: !!(opts.media && opts.media[q]) }),
    performance: { now: () => now },
    requestIdleCallback: fn => idle.push(fn),
    URLSearchParams, setTimeout: fn => idle.push(fn),
    World: { yieldToUi: ms => yields.push(ms), renderPace: () => Object.assign({}, pace) },
  };
  ctx.window.addEventListener = on('window');
  vm.runInNewContext(SRC + '\nthis.LiteFx = LiteFx;', ctx);
  const fire = (target, type, ev) => { for (const l of listeners[target + ':' + type] || []) l.fn(ev); };
  const el = (tag, inStage) => ({ tagName: tag, closest: sel => (sel === '#stage-wrap' && inStage ? {} : null) });
  return { ctx, classes, yields, idle, fire, el, listeners, pace, tick: ms => { now += ms; }, gpu: () => ({ made, lost }), setRenderer: r => { renderer = r; } };
}

{ // automation: nothing changes, nothing is held, no GPU probe is even scheduled
  const p = page({ nav: { webdriver: true, hardwareConcurrency: 2 } });
  A.eq(p.classes.has('sn-lite-glass'), false, 'automation: no lite glass');
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq(p.yields.length, 0, 'automation: a scroll never holds the floor');
  A.eq(p.idle.length, 0, 'automation: no GPU probe');
}
{ // ?fx=lite: the hold, exactly where a reader scrolls
  const p = page({ search: '?fx=lite' });
  A.ok(p.classes.has('sn-lite-glass'), '?fx=lite turns the glass down before first paint');
  for (const t of ['wheel', 'touchmove']) {
    const l = p.listeners['window:' + t]; A.ok(l && l[0].capture && l[0].passive, t + ' is watched capture + passive (it can never block a scroll)');
  }
  A.ok(p.listeners['document:scroll'] && p.listeners['document:scroll'][0].passive, 'element scrolls are watched passively on capture');
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq(p.yields, [L.HOLD_MS], 'a wheel over COMMS holds the floor for HOLD_MS');
  p.fire('window', 'wheel', { target: p.el('CANVAS') });
  p.fire('window', 'wheel', { target: p.el('SPAN', true) });
  A.eq(p.yields.length, 1, 'a wheel on the station (its canvas, or anything over it in #stage-wrap) is a camera zoom, never held');
  p.tick(1000);
  p.fire('document', 'scroll', { target: p.el('DIV') });
  A.eq(p.yields.length, 1, 'a scroll with no reader gesture (the auto-follow pinning a streaming reply) never holds the floor');
  p.fire('window', 'touchmove', { target: p.el('DIV') }); p.tick(100);
  p.fire('document', 'scroll', { target: p.el('DIV') });
  A.eq(p.yields.length, 3, 'a touch drag holds, and so does the scroll it causes');
  p.tick(1000);
  p.fire('window', 'pointerdown', { target: p.el('DIV') });
  p.fire('document', 'scroll', { target: p.el('DIV') });
  A.eq(p.yields.length, 4, 'a scrollbar drag (scroll while a press is held) holds');
  p.fire('window', 'pointerup', {});
  p.fire('document', 'scroll', { target: p.el('DIV') });
  A.eq(p.yields.length, 4, 'released: scrolls no longer hold');
  A.eq(p.ctx.LiteFx.state().holds, 4, 'the readout counts holds');
}
{ // a capable machine: full look, no hold — unless the floor itself is struggling
  const p = page({ nav: { hardwareConcurrency: 16 }, renderer: NVIDIA });
  A.eq(p.classes.has('sn-lite-glass'), false, 'capable: glass kept at boot');
  A.eq(p.idle.length, 1, 'capable: one GPU probe, deferred to idle');
  p.idle.shift()();
  A.eq(p.classes.has('sn-lite-glass'), false, 'capable: still glass after the GPU probe (an NVIDIA GPU)');
  A.eq(p.gpu().lost, p.gpu().made, 'the probe releases every context it made');
  A.ok(p.gpu().made >= 1 && p.gpu().made <= 2, 'at most two probe contexts (strict, then relaxed)');
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq(p.yields.length, 0, 'capable + cheap floor: a scroll leaves the floor drawing');
  p.pace.drawCostMs = 22; p.tick(1500);
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq(p.yields.length, 1, 'a floor whose draw costs a whole frame stands aside during a scroll');
  A.eq(p.classes.has('sn-lite-glass'), false, '...without touching the glass (cost alone is not strain)');
  p.pace.drawCostMs = 3; p.pace.strained = true; p.tick(1500);
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.ok(p.classes.has('sn-lite-glass'), 'a STRAINED floor turns the glass down');
  p.pace.strained = false; p.tick(1500);
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.ok(p.classes.has('sn-lite-glass'), '...and it stays down when the strain probe flips back (no flapping panels)');
}
{ // the masked-GPU Intel Mac the CPU count misses is caught by its GPU name when the browser gives one
  const p = page({ nav: { hardwareConcurrency: 8, platform: 'MacIntel', userAgent: 'Macintosh; Intel Mac OS X 10_15_7' }, renderer: 'Intel Iris Pro OpenGL Engine' });
  A.eq(p.classes.has('sn-lite-glass'), false, 'before the probe: no signal yet');
  p.idle.shift()();
  A.ok(p.classes.has('sn-lite-glass'), 'an Intel GPU on a Mac → lite glass once the probe has run');
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq(p.yields.length, 1, '...and the hold');
}
{ // OS asks
  const p = page({ media: { '(prefers-reduced-transparency: reduce)': true } });
  A.ok(p.classes.has('sn-lite-glass'), 'reduced transparency → lite glass at boot');
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq(p.yields.length, 0, '...but no hold (only motion asks for that)');
  const q = page({ media: { '(prefers-reduced-motion: reduce)': true } });
  A.eq(q.classes.has('sn-lite-glass'), false, 'reduced motion keeps the glass');
  q.fire('window', 'wheel', { target: q.el('DIV') });
  A.eq(q.yields.length, 1, '...and holds the floor while you scroll');
}
{ // ?fx=full: never lite, never held, even on a weak floor
  const p = page({ search: '?fx=full', nav: { hardwareConcurrency: 2 }, pace: { strained: true, drawCostMs: 90 } });
  p.fire('window', 'wheel', { target: p.el('DIV') });
  A.eq([p.classes.has('sn-lite-glass'), p.yields.length], [false, 0], '?fx=full: full look and no hold, whatever the floor costs');
}

// ---- wiring: loaded early, scoped, and network-free
const html = read('frontend/index.html');
const iBoot = html.indexOf('<script src="app/glass-boot.js">'), iLite = html.indexOf('<script src="app/litefx.js">'), iWorld = html.indexOf('<script src="app/world.js');
A.ok(iBoot > 0 && iLite > iBoot && (iWorld < 0 || iLite < iWorld), 'litefx.js loads right after glass-boot.js (body class before first paint), ahead of the floor');
A.ok(/<link rel="stylesheet" href="css\/litefx\.css">/.test(html), 'litefx.css is linked');
const css = read('frontend/css/litefx.css').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = css.split('}').map(r => r.split('{')[0].trim()).filter(Boolean);
A.ok(selectors.length >= 3, 'litefx.css has rules');
for (const sel of selectors) for (const part of sel.split(/,(?![^(]*\))/)) A.ok(/^body\.sn-lite-glass\b/.test(part.trim()), 'every lite rule is scoped to body.sn-lite-glass, so a capable machine matches none: ' + part.trim());
A.ok(/-webkit-backdrop-filter:\s*none !important/.test(css) && /[^-]backdrop-filter:\s*none !important/.test(css), 'lite kills BOTH spellings (a Mac engine before Safari 18 only reads -webkit-)');
A.eq(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/.test(SRC), false, 'litefx.js makes no network calls');
A.ok(/powerPreference: 'low-power'/.test(SRC), 'the GPU probe never asks for the discrete GPU');
const gd = read('frontend/css/glass-demo.css');
A.ok(/\.glass-demo \.term-scrim \{[^}]*-webkit-backdrop-filter: none;[^}]*backdrop-filter: none;/.test(gd),
  'the window scrim cancels its blur in BOTH spellings: style.css sets -webkit-backdrop-filter too, and a pre-18 Mac engine reads only that one');

// ---- 3. chat.js: the pill on the scroll path writes nothing it does not change
{
  const chat = read('frontend/app/chat.js');
  const src = ['  function positionNewPill(', '  function setPillText(', '  function showNewPill(', '  function hideNewPill('].map(h => A.fnBody(chat, h));
  A.ok(src.every(s => s && s.length < 3000), 'the pill functions are findable');
  const writes = [];
  const mk = (id) => {
    const cls = new Set(); let text = '', bottom = '';
    const attrs = {};
    return { id, classList: { add: c => { if (!cls.has(c)) writes.push(id + ' +' + c); cls.add(c); }, remove: c => { if (cls.has(c)) writes.push(id + ' -' + c); cls.delete(c); }, contains: c => cls.has(c) },
      get textContent() { return text; }, set textContent(v) { writes.push(id + ' text'); text = v; },
      getAttribute: k => (k in attrs ? attrs[k] : null), setAttribute: (k, v) => { writes.push(id + ' @' + k); attrs[k] = v; },
      style: { get bottom() { return bottom; }, set bottom(v) { writes.push(id + ' bottom'); bottom = v; } },
      offsetHeight: 60, appendChild() {} };
  };
  const els = { 'chat-panel': mk('panel'), 'chat-inputrow': mk('composer'), 'chat-queued': null, 'comms-newpill': null };
  const log = mk('log');
  const ctx = { stick: false, heldCard: null, log, SFX: undefined, jumpToBottom() {},
    el: id => els[id], document: { createElement: () => { const p = mk('pill'); els['comms-newpill'] = p; return p; } } };
  vm.runInNewContext(src.join('\n') + '\nthis.show = showNewPill; this.hide = hideNewPill;', ctx);
  ctx.show(false);
  A.ok(writes.includes('pill text') && writes.includes('pill +show'), 'the first scroll up shows the pill');
  writes.length = 0;
  for (let i = 0; i < 30; i++) ctx.show(false);
  A.eq(writes, [], 'thirty more scroll events while reading history write NOTHING (no style invalidation, no forced layout next event)');
  ctx.show(true);
  A.ok(writes.includes('pill +hasnew') && writes.includes('pill text'), 'new content still flips it to "new messages"');
  A.eq(els['comms-newpill'].textContent, 'new messages', 'with the new text');
  writes.length = 0; ctx.show(false);
  A.eq(writes, [], 'and holds that state silently');
  els['chat-inputrow'].offsetHeight = 90; ctx.show(false);
  A.eq(writes, ['pill bottom'], 'a taller composer still moves the pill (only real changes write)');
}

A.report('litefx.test');
