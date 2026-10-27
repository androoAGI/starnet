/* test/helpers/comms-dom.js — a small COMMS column for running the REAL dialogue.js (and the stores that drive it) in a vm.

   The same element model test/dialogue-offer-yields.test.js uses: boxes are set by hand in VISUAL px (getBoundingClientRect),
   offsetHeight/clientHeight are layout px, so the offer fit runs its real arithmetic. station() builds #chat-panel with the
   transcript (#chat-log), the queued-message strip (#chat-queued) and the message box (#chat-inputrow > #chat-input), loads
   dialogue.js plus any extra sources into one context, and answers the questions the comms-owner tests ask:
     covers(y)       → does the open panel sit over the point y (visual px)? A click there would land on the panel.
     inputUsable()   → is #chat-input on screen AND not under the panel (the gh#158 "no message box" check);
     key(name, tgt)  → dispatch a keydown the way the browser does (document listeners first, then window).
   Nothing here reads sidecar source. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.nodeType = 1; this.children = []; this.parentNode = null; this.style = {};
    this.attrs = {}; this.dataset = {}; this.listeners = {}; this._cls = new Set(); this._text = ''; this.box = null;
    this.offsetHeight = 0; this.clientHeight = 0; this.clientTop = 0; this.value = ''; this.disabled = false; this.hidden = false;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._cls.add(x)), remove: (...c) => c.forEach(x => self._cls.delete(x)), contains: c => self._cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !self._cls.has(c) : !!on; if (v) self._cls.add(c); else self._cls.delete(c); return v; }
    };
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  set innerHTML(v) { for (const c of this.children) c.parentNode = null; this.children = []; this._text = ''; }
  get innerHTML() { return ''; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.innerHTML = ''; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(n) { if (n.parentNode) n.remove(); n.parentNode = this; this.children.push(n); return n; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; } }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get isConnected() { let x = this; while (x.parentNode) x = x.parentNode; return x.tagName === 'BODY'; }
  addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }
  removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter(f => f !== fn); }
  dispatch(k, ev) { for (const fn of (this.listeners[k] || []).slice()) fn(ev || { target: this, preventDefault() {}, stopPropagation() {} }); }
  click() { if (this.onclick) this.onclick({ target: this, preventDefault() {}, stopPropagation() {} }); this.dispatch('click'); }
  getBoundingClientRect() { const b = this.box || { top: 0, height: 0 }; return { top: b.top, bottom: b.top + b.height, height: b.height, left: 0, right: 360, width: 360 }; }
  focus() { this._doc && (this._doc.activeElement = this); }
  querySelector() { return null; } querySelectorAll() { return []; }
}
const all = e => [e, ...e.children.flatMap(all)];

/* station({ zoom, sources:[repo paths], globals:{} }) → the COMMS column with the real Dialogue (and every extra source) loaded */
function station(opts) {
  opts = opts || {};
  const k = opts.zoom || 1;
  const body = new El('body'), html = new El('html');
  const host = new El('aside'); host.id = 'chat-panel';
  host.box = { top: 0, height: 800 }; host.offsetHeight = 800 / k; host.clientHeight = 800 / k;
  const logEl = new El('div'); logEl.id = 'chat-log'; logEl.box = { top: 120, height: 470 };
  const queued = new El('div'); queued.id = 'chat-queued'; queued.box = { top: 640, height: 0 };
  const row = new El('div'); row.id = 'chat-inputrow'; row.box = { top: 640, height: 160 };
  const input = new El('textarea'); input.id = 'chat-input'; input.box = { top: 660, height: 60 };
  row.appendChild(input);
  for (const n of [logEl, queued, row]) host.appendChild(n);
  body.appendChild(host);
  const winKeys = [], docKeys = [], events = [];
  const doc = {
    body, documentElement: html, activeElement: body,
    createElement: t => { const e = new El(t); e._doc = doc; return e; },
    getElementById: id => all(body).find(e => e.id === id) || null,
    dispatchEvent: ev => { events.push(ev && ev.type); return true; },
    addEventListener: (k2, fn) => { if (k2 === 'keydown') docKeys.push(fn); },
    removeEventListener: (k2, fn) => { if (k2 === 'keydown') { const i = docKeys.indexOf(fn); if (i >= 0) docKeys.splice(i, 1); } }
  };
  for (const e of all(body)) e._doc = doc;
  const ctx = vm.createContext(Object.assign({
    console, Promise, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, Object, Array, String, Number, Boolean, Error,
    AbortController, document: doc,
    window: { addEventListener: (k2, fn) => { if (k2 === 'keydown') winKeys.push(fn); }, removeEventListener: (k2, fn) => { if (k2 === 'keydown') { const i = winKeys.indexOf(fn); if (i >= 0) winKeys.splice(i, 1); } } },
    CustomEvent: function CustomEvent(t) { this.type = t; },
    matchMedia: () => ({ matches: true }),   // reduced motion: a beat types out at once
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} }
  }, opts.globals || {}));
  vm.runInContext(read('frontend/app/dialogue.js') + '\nthis.Dialogue = Dialogue;', ctx, { filename: 'dialogue.js' });
  for (const src of (opts.sources || [])) vm.runInContext(read(src), ctx, { filename: src });
  const key = (name, target, pre) => {
    const ev = { key: name, target: target || body, defaultPrevented: !!pre, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const fn of docKeys.slice()) fn(ev);
    for (const fn of winKeys.slice()) fn(ev);
    return ev;
  };
  const panel = () => all(host).find(e => e._cls.has('fnv-dialogue')) || null;
  const covers = y => { const p = panel(); if (!p) return false; const top = parseFloat(p.style.top || '0') * k, bottom = 800 - parseFloat(p.style.bottom || '0') * k; return y >= top && y < bottom; };
  const inputCentre = () => input.box.top + input.box.height / 2;
  const inputUsable = () => input.isConnected && !input.hidden && !input.disabled && !covers(inputCentre());
  const find = cls => all(host).filter(e => e._cls.has(cls));
  return { ctx, D: ctx.Dialogue, doc, host, logEl, input, queued, row, body, key, panel, covers, inputCentre, inputUsable, find, events, all: () => all(body) };
}
const settle = async () => { for (let n = 0; n < 40; n++) await new Promise(r => setImmediate(r)); };

module.exports = { station, settle, El, read };
