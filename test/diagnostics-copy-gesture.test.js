/* STARNET — COPY DIAGNOSTICS must survive WebKit's user-activation rule (2026-10-07).

   WHY THIS TEST EXISTS. A macOS customer clicked "⧉ copy diagnostics for a bug report" under a failed COMMS turn
   and got "copy failed — try again" EVERY time. Diag.copy() awaited GET /api/diagnostics and only THEN wrote the
   clipboard; WebKit (macOS WKWebView, Linux WebKitGTK) allows a script clipboard write only during the click's
   transient activation, which the network round-trip had already used up — and "try again" repeated the same
   fetch-then-write, so it could never succeed. Nothing was rendered on-screen, so the user had no report at all.

   These assertions pin the fix: (1) the clipboard write is REGISTERED synchronously inside the click (a
   ClipboardItem whose content is a promise) and carries the full report once it arrives; (2) when the clipboard
   refuses, copy() resolves false and onDone still receives the full text; (3) an empty report never leaves a
   hanging write; (4) the COMMS pill and Settings render that text on-screen instead of offering a futile retry. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const Diag = require('../frontend/app/diagnostics.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tick = () => new Promise(r => setImmediate(r));

(async () => {
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const saved = { fetch: global.fetch, window: global.window, ClipboardItem: global.ClipboardItem };
  const setNavigator = v => Object.defineProperty(globalThis, 'navigator', { value: v, configurable: true, writable: true });
  // WebKit's rule, simulated: `active` is true only while the click handler runs synchronously.
  let active = false;
  const click = fn => { active = true; try { return fn(); } finally { active = false; } };
  // the sidecar answers on a LATER tick — after the click's activation is gone.
  let fetchResolved = false;
  const lateFetch = () => { fetchResolved = false; global.fetch = () => new Promise(r => setImmediate(() => { fetchResolved = true; r({ ok: true, json: () => ({ text: 'REPORT' }) }); })); };
  try {
    global.window = {};

    /* ---- (1) ClipboardItem present: the write is registered inside the gesture and carries the report ---- */
    {
      lateFetch();
      const writes = [];
      class FakeItem { constructor(data) { this.data = data; } }
      global.ClipboardItem = FakeItem;
      setNavigator({ clipboard: {
        writeText: () => active ? Promise.resolve() : Promise.reject(new Error('NotAllowedError')),
        write: items => { const rec = { duringGesture: active, beforeFetch: !fetchResolved, items }; writes.push(rec); return items[0].data['text/plain'].then(b => b.text()).then(t => { rec.text = t; }); }
      } });
      let done = null;
      const p = click(() => Diag.copy({ notify: false, onDone: (ok, text) => { done = { ok, text }; } }));
      A.eq(writes.length, 1, 'the clipboard write is registered synchronously in the click (before any await)');
      A.ok(writes[0] && writes[0].duringGesture && writes[0].beforeFetch, 'the write ran inside the user gesture, before the report fetch resolved');
      const ok = await p;
      A.eq(ok, true, 'copy() resolves true when the deferred ClipboardItem write lands');
      A.ok(writes[0] && /^REPORT/.test(writes[0].text || '') && /app screen:/.test(writes[0].text || ''), 'the clipboard receives the full assembled report: ' + (writes[0] && writes[0].text));
      A.ok(done && done.ok === true && /^REPORT/.test(done.text), 'onDone(true, text) still fires with the report');
    }

    /* ---- (2) WebKit without ClipboardItem: late writeText + execCommand both refused -> false + the full text ---- */
    {
      lateFetch();
      delete global.ClipboardItem;
      setNavigator({ clipboard: { writeText: () => active ? Promise.resolve() : Promise.reject(new Error('NotAllowedError')) } });
      let done = null, threw = false, ok;
      try { ok = await click(() => Diag.copy({ notify: false, onDone: (o, text) => { done = { ok: o, text }; } })); } catch (_) { threw = true; }
      A.ok(!threw, 'a refused clipboard never throws out of copy()');
      A.eq(ok, false, 'copy() reports the refusal honestly (false)');
      A.ok(done && done.ok === false && /^REPORT/.test(done.text), 'onDone(false, text) carries the full report so the caller can show it on-screen');
    }

    /* ---- (3) ClipboardItem write refused (e.g. an older WebView) -> falls back to writeText, which may work ---- */
    {
      lateFetch();
      global.ClipboardItem = class { constructor(data) { this.data = data; } };
      let plain = '';
      setNavigator({ clipboard: { write: () => Promise.reject(new Error('unsupported')), writeText: t => { plain = t; return Promise.resolve(); } } });
      const ok = await click(() => Diag.copy({ notify: false }));
      A.eq(ok, true, 'a refused ClipboardItem write falls through to the plain copy (WebView2 path unchanged)');
      A.ok(/^REPORT/.test(plain), 'the fallback copies the same report');
    }

    /* ---- (4) an empty report never leaves a hanging write, and never copies '' ---- */
    {
      let writeSettled = null, plainCalled = false;
      global.ClipboardItem = class { constructor(data) { this.data = data; } };
      setNavigator({ clipboard: {
        write: items => items[0].data['text/plain'].then(() => { writeSettled = 'resolved'; }, e => { writeSettled = 'rejected'; throw e; }),
        writeText: () => { plainCalled = true; return Promise.resolve(); }
      } });
      const ok = await Diag.copyDeferred(Promise.resolve(''));
      await tick();
      A.eq(ok, false, 'copyDeferred(\'\') resolves false');
      A.eq(writeSettled, 'rejected', 'the ClipboardItem content promise rejects on an empty report (no hanging write)');
      A.ok(!plainCalled, 'an empty report is never written to the clipboard');
      const okRejected = await Diag.copyDeferred(Promise.reject(new Error('boom')));
      A.eq(okRejected, false, 'a rejected text promise resolves false, never throws');
    }

    /* ---- (5) source locks: the COMMS pill and Settings render the text instead of a futile retry ---- */
    {
      const chat = read('frontend/app/chat.js');
      const start = chat.indexOf('function diagAffordance(');
      const body = start >= 0 ? chat.slice(start, chat.indexOf('\n  }\n', start)) : '';
      A.ok(!!body, 'diagAffordance exists in chat.js');
      A.ok(/Diag\.copy\(\{[^}]*onDone: \(ok, text\)[\s\S]*Diag\.showBlock\(rowEl, \{ text: text \}\)/.test(body), 'a refused COMMS copy renders the report in its row via Diag.showBlock(rowEl, { text })');
      A.ok(!/copy failed — try again/.test(body), 'the COMMS pill no longer offers a retry that can only repeat the refusal');
      A.ok(!/Diag\.copy\([^)]*\)\.then\(/.test(body), 'diagAffordance reads the result through onDone (it needs the text)');

      const sui = read('frontend/app/stationui.js');
      A.ok(/Diag\.copy\(\{ notify: false, onDone: \(ok, text\)[\s\S]{0,1200}Diag\.showBlock\(body\.querySelector\('#diag-block'\) \|\| body, \{ text \}\)/.test(sui), 'Settings shows the text the failed copy already read (no second fetch)');
      A.ok(!/copy failed — try again/.test(sui), 'Settings no longer says "try again" for a refused clipboard');

      const diag = read('frontend/app/diagnostics.js');
      A.ok(/const okP = copyDeferred\(textP\);/.test(diag), 'Diag.copy registers the clipboard write via copyDeferred in the click tick');
      A.ok(!/the report is shown below/.test(diag), 'the copy() toast never claims an on-screen report it does not render');
    }
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc); else delete globalThis.navigator;
    if (saved.fetch === undefined) delete global.fetch; else global.fetch = saved.fetch;
    if (saved.ClipboardItem === undefined) delete global.ClipboardItem; else global.ClipboardItem = saved.ClipboardItem;
    if (saved.window === undefined) delete global.window; else global.window = saved.window;
  }
  A.report('diagnostics-copy-gesture');
})();
