/* node test/bootguard.test.js — the boot guard makes a broken boot LOUD and stays silent on a healthy one.

   frontend/app/bootguard.js is the first app script: it installs window error/unhandledrejection listeners,
   tallies them, and after DOMContentLoaded probes the critical module globals; a missing global or a failed
   <script> renders the fatal banner naming the file. No jsdom in this repo — the module is run in a vm context
   with a hand-rolled window/document stub (it touches only addEventListener, readyState, createElement,
   body.appendChild), which is exactly the dependency budget the module promises. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'bootguard.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'frontend', 'index.html'), 'utf8');

const CRITICAL = ['U', 'Harness', 'Save', 'CloudSave', 'World', 'StationUI', 'Chat', 'Channels', 'Personas', 'Onboarding', 'Tutorial', 'App', 'Topbar'];

function fakeEl(tag) {
  const el = { tagName: tag.toUpperCase(), children: [], style: {}, attrs: {}, textContent: '', className: '', id: '' };
  el.appendChild = c => { el.children.push(c); return c; };
  el.setAttribute = (k, v) => { el.attrs[k] = v; };
  el.getAttribute = k => el.attrs[k];
  return el;
}
function textOf(el) { return (el.textContent || '') + el.children.map(textOf).join('\n'); }

/* boot the module in a sandbox. `globals` = the module globals present at DOMContentLoaded time.
   readyState 'loading' so the check is deferred until we fire DOMContentLoaded ourselves. The sandbox is an engine AT
   the floor (scripts/lib/engine-floor.json): the vm has Object.hasOwn and Array#at, and gets the browser's floor APIs
   here; opts.before runs in the context first (an older engine deletes what it lacks). */
function boot(globals, opts) {
  opts = opts || {};
  const handlers = { win: {}, doc: {} };
  const body = fakeEl('body');
  const document = {
    readyState: opts.readyState || 'loading',
    body,
    addEventListener(t, fn) { (handlers.doc[t] = handlers.doc[t] || []).push(fn); },
    createElement: fakeEl
  };
  function HTMLDialogElement() {}
  HTMLDialogElement.prototype.showModal = function () {};
  const sandbox = {
    document,
    location: { href: 'http://127.0.0.1:8787/', reload() { sandbox.__reloaded = (sandbox.__reloaded || 0) + 1; } },
    navigator: { userAgent: 'test-ua' },
    addEventListener(t, fn, cap) { (handlers.win[t] = handlers.win[t] || []).push({ fn, cap }); },
    structuredClone: v => JSON.parse(JSON.stringify(v)),
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    HTMLDialogElement,
    console
  };
  sandbox.window = sandbox;
  Object.assign(sandbox, globals || {});
  vm.createContext(sandbox);
  if (opts.before) vm.runInContext(opts.before, sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'bootguard.js' });
  const fire = (t, e) => (handlers.win[t] || []).forEach(h => h.fn(e));
  const ready = () => (handlers.doc.DOMContentLoaded || []).forEach(fn => fn({}));
  const banner = () => body.children.find(c => c.id === 'bootguard-fatal') || null;
  return { sandbox, guard: sandbox.BootGuard, handlers, fire, ready, banner, body };
}
const allGlobals = () => Object.fromEntries(CRITICAL.map(n => [n, {}]));

/* ---- 0. the slot: bootguard is the FIRST script in index.html, ahead of legacymigrate ---- */
const firstScript = INDEX.indexOf('<script');
A.ok(firstScript >= 0 && INDEX.slice(firstScript, firstScript + 80).includes('app/bootguard.js'), 'bootguard.js is the very first <script> in frontend/index.html');
A.ok(INDEX.indexOf('app/bootguard.js') < INDEX.indexOf('app/legacymigrate.js'), 'bootguard loads before legacymigrate (the first store-touching script)');
A.ok(!/bootguard\.js"[^>]*\bdefer\b/.test(INDEX), 'bootguard is NOT deferred — it must be installed before any other script can throw');

/* ---- 1. listeners are installed in the capture phase (a 404\'d <script> error does not bubble) ---- */
{
  const t = boot(allGlobals());
  A.eq(t.guard.installed, true, 'the guard reports its listeners installed');
  const err = (t.handlers.win.error || [])[0];
  A.ok(err && err.cap === true, 'the window error listener is capture-phase (sees resource failures)');
  A.ok((t.handlers.win.unhandledrejection || []).length === 1, 'an unhandledrejection listener is installed');
  A.ok((t.handlers.doc.DOMContentLoaded || []).length === 1, 'the boot check is deferred to DOMContentLoaded while the document is loading');
}

/* ---- 2. HEALTHY boot: every critical global present, no script failures -> NO banner, ever ---- */
{
  const t = boot(allGlobals());
  t.fire('error', { message: 'a cosmetic image 404', target: Object.assign(fakeEl('img'), { src: 'assets/x.png' }) });
  t.fire('unhandledrejection', { reason: new Error('late fetch died') });
  t.ready();
  A.eq(t.banner(), null, 'a healthy boot renders no banner (img 404 + a rejected promise are counted, not fatal)');
  const s = t.guard.state();
  A.eq([s.checked, s.fired, s.missing.length, s.scriptFailures, s.rejections, s.uncaught], [true, false, 0, 0, 1, 0], 'healthy state: checked, not fired, nothing missing, rejection tallied, img error ignored');
  A.ok(t.guard.summaryLine().includes('1 unhandled rejection'), 'summaryLine reports the rejection tally: ' + t.guard.summaryLine());
}
{
  const t = boot(allGlobals());
  t.ready();
  A.eq(t.guard.summaryLine(), 'none recorded since page load', 'a clean boot reports a real zero, never a guess');
  A.ok(t.guard.report().includes('boot check:     passed'), 'report() says the boot check passed');
}

/* ---- 3. a missing critical module -> the banner names the module AND its file ---- */
{
  const g = allGlobals(); delete g.World;
  const t = boot(g);
  t.ready();
  const b = t.banner();
  A.ok(b, 'a missing World global renders the fatal banner');
  const txt = b ? textOf(b) : '';
  A.ok(txt.includes('STATION FAILED TO BOOT'), 'banner carries the fatal heading');
  A.ok(txt.includes('World — app/world.js'), 'banner names the missing module and the file that defines it');
  A.ok(txt.includes('boot check:     FAILED'), 'the embedded report says FAILED');
  A.ok(b && b.attrs.role === 'alert', 'banner is an aria alert');
  const buttons = [];
  (function walk(el) { if (el.tagName === 'BUTTON') buttons.push(el); el.children.forEach(walk); })(b);
  A.eq(buttons.map(x => x.textContent), ['⧉ COPY DIAGNOSTICS', '⟳ RELOAD'], 'banner offers COPY DIAGNOSTICS + RELOAD');
  A.ok(buttons.every(x => /\bbtn(-xl)?\b/.test(x.className)), 'both controls wear station button skins (no white HTML controls)');
  buttons[1].onclick();
  A.eq(t.sandbox.__reloaded, 1, 'RELOAD reloads the page');
  t.ready();
  A.eq(t.body.children.filter(c => c.id === 'bootguard-fatal').length, 1, 'a second check never stacks a second banner');
}

/* ---- 4. a <script> load failure (404/blocked) is fatal even when the probe list is intact ---- */
{
  const t = boot(allGlobals());
  t.fire('error', { target: Object.assign(fakeEl('script'), { src: 'http://127.0.0.1:8787/app/recipes.js' }) });
  t.ready();
  const b = t.banner();
  A.ok(b, 'a failed <script> renders the banner');
  A.ok(b && textOf(b).includes('script did not load — app/recipes.js'), 'banner names the script that failed to load (path only)');
  A.ok(t.guard.summaryLine().includes('1 script load failure(s): app/recipes.js'), 'summaryLine carries the script failure');
}
{
  const t = boot(allGlobals());
  t.fire('error', { target: Object.assign(fakeEl('script'), { src: 'http://127.0.0.1:8787/shared/specialties.js' }) });
  t.ready();
  A.ok(t.banner(), 'a failed shared station dependency is still fatal');
  A.ok(textOf(t.banner()).includes('script did not load — shared/specialties.js'), 'the shared dependency is named');
}

/* ---- 4b. the sidecar-served shared/ catalog is RETRIED with backoff before it is fatal (engine not up yet) ---- */
// a retry needs a timer + a document head; give the sandbox both and drive the fake clock by hand.
function retryable(t, opts) {
  opts = opts || {};
  const timers = [];
  t.sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  t.sandbox.document.head = fakeEl('head');
  if (opts.reloadsSoFar != null) {
    let v = String(opts.reloadsSoFar);
    t.sandbox.sessionStorage = { getItem: () => v, setItem: (k, x) => { v = String(x); } };
  }
  const shared = () => ({ target: Object.assign(fakeEl('script'), { src: 'http://127.0.0.1:8787/shared/specialties.js' }) });
  const tick = () => { const x = timers.shift(); if (!x) throw new Error('no timer pending'); x.fn(); return x.ms; };
  const lastRetry = () => t.sandbox.document.head.children[t.sandbox.document.head.children.length - 1] || null;
  return { timers, shared, tick, lastRetry };
}
{
  // (a) the catalog answers on the first retry → no banner, exactly one bounded reload (the parser-ordered wrappers rebind)
  const t = boot(allGlobals());
  const r = retryable(t);
  t.fire('error', r.shared());
  const st = t.guard.state();
  A.eq([st.scriptFailures, st.retry.attempts, st.retry.pending], [1, 1, 1], 'a shared/ load failure is counted AND schedules one retry');
  t.ready();
  A.eq(t.banner(), null, 'DOMContentLoaded with a retry in flight holds the banner (deferred, not fatal yet)');
  A.eq(st.retry.deferred, true, 'the deferred verify is recorded');
  const ms = r.tick();
  A.eq(ms, t.guard._internals.RETRY_WAITS[0], 'first retry waits the first backoff step');
  const el = r.lastRetry();
  A.ok(el && el.tagName === 'SCRIPT' && el.getAttribute('data-bootguard-retry') === '1', 'the retry is a marked <script> in <head>');
  A.ok(/shared\/specialties\.js\?bootguard-retry=1$/.test(el.src), 'the retry re-requests the SAME sidecar URL with a cache-busting retry marker: ' + el.src);
  t.fire('error', { target: el });
  A.eq([st.scriptFailures, st.retry.attempts], [1, 1], 'a retry element\'s own capture-phase error is NOT double-counted or re-scheduled');
  el.onload();
  A.eq(t.sandbox.__reloaded, 1, 'a successful retry reloads the page once');
  A.eq([st.retry.recovered, st.retry.reloads], [1, 1], 'the recovery + reload are recorded');
  A.eq(t.banner(), null, 'no banner after a recovered catalog');
  A.ok(t.guard.report().includes('shared retry:   1 attempt(s) for shared/specialties.js — recovered (reloaded 1×)'), 'the report names the recovered retry');
}
{
  // (b) the engine never answers → every backoff step is spent, THEN the banner names the shared file (still fatal, just later)
  const t = boot(allGlobals());
  const r = retryable(t);
  const WAITS = t.guard._internals.RETRY_WAITS;
  t.fire('error', r.shared());
  t.ready();
  const seen = [];
  for (let i = 0; i < WAITS.length; i++) {
    A.eq(t.banner(), null, 'no banner while retry ' + (i + 1) + ' is pending');
    seen.push(r.tick());
    r.lastRetry().onerror();
  }
  A.eq(seen, WAITS, 'the retries follow the documented backoff schedule');
  A.eq(r.timers.length, 0, 'no further retry is scheduled once the budget is spent');
  const b = t.banner();
  A.ok(b, 'exhausted retries render the fatal banner');
  A.ok(textOf(b).includes('script did not load — shared/specialties.js'), 'the banner still names the shared dependency');
  A.ok(t.guard.report().includes('shared retry:   ' + WAITS.length + ' attempt(s) for shared/specialties.js — script load retries exhausted'), 'the report records the spent retry budget without inventing engine health');
  A.eq(t.sandbox.__reloaded, undefined, 'a failed retry never reloads the page');
}
{
  // (c) the reload budget is bounded: a flapping engine gets the banner, never a reload loop
  const t = boot(allGlobals());
  const r = retryable(t, { reloadsSoFar: t.guard._internals.RELOAD_MAX });
  t.fire('error', r.shared());
  t.ready();
  r.tick(); r.lastRetry().onload();
  A.eq(t.sandbox.__reloaded, undefined, 'over budget: no reload');
  A.ok(t.banner(), 'over budget: the banner renders instead (the page is still bound to an empty catalog)');
}
{
  // (d) only shared/ retries — an app/ or js/ module ships inside the bundle; its failure is immediately fatal
  const t = boot(allGlobals());
  const r = retryable(t);
  t.fire('error', { target: Object.assign(fakeEl('script'), { src: 'http://127.0.0.1:8787/app/recipes.js' }) });
  A.eq([t.guard.state().retry.attempts, r.timers.length], [0, 0], 'an app/ script failure schedules no retry');
  t.ready();
  A.ok(t.banner(), 'an app/ script failure is fatal at once');
}

/* ---- 5. hosting-injected scripts are not station modules and cannot take the app down ---- */
{
  const t = boot(allGlobals());
  t.fire('error', { target: Object.assign(fakeEl('script'), { src: 'http://127.0.0.1:9220/beacon.min.js/v31ed6d6f95cf4e85b04c19e7a9bdbcba1788362987495' }) });
  t.ready();
  A.eq(t.banner(), null, 'a blocked hosting analytics beacon does not render the fatal banner');
  A.eq(t.guard.state().scriptFailures, 0, 'the hosting beacon is not counted as a station script failure');
  A.eq(t.guard.summaryLine(), 'none recorded since page load', 'the ignored hosting script does not poison diagnostics');
}

/* ---- 6. runtime errors are tallied with file:line, bounded, secret-free (counts + message tail only) ---- */
{
  const t = boot(allGlobals());
  for (let i = 0; i < 40; i++) t.fire('error', { message: 'boom ' + i, filename: 'http://127.0.0.1:8787/app/chat.js', lineno: 10 + i });
  const s = t.guard.state();
  A.eq(s.uncaught, 40, 'every uncaught error is counted');
  A.eq(s.errors.length, 24, 'the error tail is bounded');
  A.ok(s.errors[0].startsWith('boom 16 @ app/chat.js:26'), 'tail keeps the most recent entries with file:line: ' + s.errors[0]);
  A.eq(t.guard._internals.reasonText({ message: 'm' }), 'm', 'reasonText prefers .message');
  A.eq(t.guard._internals.reasonText('plain'), 'plain', 'reasonText passes strings through');
}

/* ---- 6b. the copied diagnostics NAME where an uncaught error happened (#136, 2026-10-18) ----
   A pre-16.4 Mac WebKit hit a SyntaxError parsing app/workflowline.js; WorkflowLine never existed, no critical probe failed
   (no banner), and the report a user can paste said only "page errors: 1 uncaught error(s)". The summary line now carries
   file:line + the error's TYPE name — never the message, which can carry data — and the boot check reads DEGRADED,
   naming the script that did not run (header 5; section 11 holds it for every station script). */
{
  const t = boot(allGlobals());
  t.fire('error', { message: 'SyntaxError: Invalid regular expression: invalid group specifier name', filename: 'tauri://localhost/app/workflowline.js?v=1', lineno: 797, error: { name: 'SyntaxError' } });
  t.ready();
  A.eq(t.banner(), null, 'a non-critical module failing to parse is not the fatal banner');
  A.eq(t.guard.summaryLine(), '1 station script(s) did not run: app/workflowline.js (SyntaxError at line 797) · 1 uncaught error(s) at app/workflowline.js:797 (SyntaxError)', 'the summary names the script that did not run, and the file, line and error type: ' + t.guard.summaryLine());
  A.ok(t.guard.report().includes('boot check:     DEGRADED') && t.guard.report().includes('scripts:        did not run: app/workflowline.js (SyntaxError at line 797)'), 'the boot check is DEGRADED, never "passed", and names the script: ' + t.guard.report().split('\n').slice(3, 5).join(' / '));
  const Diag = require('../frontend/app/diagnostics.js');
  A.eq(Diag.withPageErrors('REPORT', t.guard), 'REPORT\npage errors:   1 station script(s) did not run: app/workflowline.js (SyntaxError at line 797) · 1 uncaught error(s) at app/workflowline.js:797 (SyntaxError)', 'COPY DIAGNOSTICS carries the script and the location');
}
{
  // runtime errors (after DOMContentLoaded): counted with their places, never a script that did not run
  const t = boot(allGlobals());
  t.ready();
  t.fire('error', { message: 'TypeError: bad token sk-live-SECRET in https://x/?key=SECRET', filename: 'http://127.0.0.1:8787/app/chat.js?ticket=SECRET', lineno: 5 });
  t.fire('error', { message: 'Uncaught TypeError: x', filename: 'http://127.0.0.1:8787/app/chat.js', lineno: 5 });
  t.fire('error', { message: 'Script error.', filename: '', lineno: 0 });
  for (let i = 0; i < 6; i++) t.fire('error', { message: 'ReferenceError: y', filename: 'http://127.0.0.1:8787/app/m' + i + '.js', lineno: 1, error: { name: 'Error with spaces' } });
  const line = t.guard.summaryLine();
  A.ok(!/SECRET/.test(line), 'the summary never carries an error message, query or ticket: ' + line);
  A.ok(line.startsWith('9 uncaught error(s) at app/chat.js:5 (TypeError), (inline), app/m0.js:1 (ReferenceError), app/m1.js:1 (ReferenceError) +4 more'), 'locations are de-duplicated, bounded, typed from the message when the error object is absent: ' + line);
  A.eq(t.guard._internals.errorKind({ error: { name: 'x\nSyntaxError' }, message: '' }), '', 'a type name that is not a bare identifier is dropped');
}
{
  const t = boot(allGlobals());
  t.fire('error', { message: 'SyntaxError: bad', filename: 'http://127.0.0.1:8787/app/workflowline.js', lineno: 797 });
  t.ready();
  for (let i = 0; i < 60; i++) t.fire('error', { message: 'TypeError: loop', filename: 'http://127.0.0.1:8787/app/world.js', lineno: 9 });
  A.eq(t.guard.summaryLine(), '1 station script(s) did not run: app/workflowline.js (SyntaxError at line 797) · 61 uncaught error(s) at app/workflowline.js:797 (SyntaxError), app/world.js:9 (TypeError)', 'the first (boot-time) place is kept while a later error loops, and only the boot-time one did not run: ' + t.guard.summaryLine());
}

/* ---- 7. COPY DIAGNOSTICS rides Diag when present (page report + sidecar report), falls back to the clipboard ---- */
(async () => {
  {
    let copied = '';
    const g = allGlobals(); delete g.Chat;
    g.Diag = { fetchText: () => Promise.resolve('SIDECAR REPORT'), copyText: t => { copied = t; return Promise.resolve(true); } };
    const t = boot(g);
    t.ready();
    const b = t.banner();
    const copyBtn = (function find(el) { if (el.tagName === 'BUTTON' && /COPY/.test(el.textContent)) return el; for (const c of el.children) { const r = find(c); if (r) return r; } return null; })(b);
    copyBtn.onclick();
    await new Promise(r => setTimeout(r, 10));
    A.ok(copied.includes('STARNET BOOT GUARD') && copied.includes('Chat (app/chat.js)') && copied.endsWith('SIDECAR REPORT'), 'copy = page-side boot report + the sidecar report via Diag');
    A.eq(copyBtn.textContent, '✓ DIAGNOSTICS COPIED', 'button confirms the copy');
  }
  {
    let copied = '';
    const g = allGlobals(); delete g.Chat;
    const t = boot(g);
    t.sandbox.navigator.clipboard = { writeText: s => { copied = s; return Promise.resolve(); } };
    t.ready();
    const copyBtn = (function find(el) { if (el.tagName === 'BUTTON' && /COPY/.test(el.textContent)) return el; for (const c of el.children) { const r = find(c); if (r) return r; } return null; })(t.banner());
    copyBtn.onclick();
    await new Promise(r => setTimeout(r, 10));
    A.ok(copied.includes('missing:        Chat (app/chat.js)'), 'without Diag the page report still reaches the clipboard');
  }

  /* ---- 8. diagnostics.js appends the page-error line to every copied report ---- */
  {
    const Diag = require('../frontend/app/diagnostics.js');
    A.eq(Diag.withPageErrors('REPORT', { summaryLine: () => '2 uncaught error(s)' }), 'REPORT\npage errors:   2 uncaught error(s)', 'withPageErrors appends the guard tally');
    A.eq(Diag.withPageErrors('REPORT', null), 'REPORT', 'no guard -> text unchanged');
    A.eq(Diag.withPageErrors('', { summaryLine: () => 'x' }), '', 'an empty report stays empty (the caller\'s "could not read" path is preserved)');
    const src = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'diagnostics.js'), 'utf8');
    A.ok(/\.then\(text => text \? withPageErrors\(text\) : text\)/.test(src), 'Diag.copy() routes the report through withPageErrors');
  }

  /* ---- 9. the probe set is the critical set app.js already guards ---- */
  {
    const t = boot(allGlobals());
    A.eq(t.guard.PROBES.map(p => p.name), CRITICAL, 'the critical probe list is exactly the documented set');
    t.guard.PROBES.forEach(p => A.ok(fs.existsSync(path.join(ROOT, 'frontend', p.file)), 'probe file exists: ' + p.file));
    A.ok(!/new Function\s*\(|[^\w.'"]eval\s*\(/.test(SRC), 'no eval() / new Function() — the desktop CSP forbids it, probes are literal typeofs');
  }
  /* ---- 10. an engine BELOW THE FLOOR (macOS 10.15 / Safari 13, 2026-10-08 report) is named, not called a broken file.
     The floor and its words are scripts/lib/engine-floor.json's (test/engine-floor.test.js holds every floor API in turn). ---- */
  {
    const g = allGlobals(); delete g[CRITICAL[0]];
    // Safari 13 has none of the floor's APIs
    g.structuredClone = undefined; g.HTMLDialogElement = undefined; g.crypto = {};
    const t = boot(g, { before: 'delete Object.hasOwn; delete Array.prototype.at;' });
    t.sandbox.navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' };
    t.ready();
    const b = t.banner();
    A.ok(!!b, 'a missing module on an outdated engine still renders the banner');
    const txt = b ? textOf(b) : '';
    A.ok(txt.includes('NEEDS A NEWER macOS') && /macOS 11 Big Sur/.test(txt) && /Safari 15\.4 or newer/.test(txt) && /macOS 12\.3 Monterey/.test(txt), 'the banner names the real cause: a newer macOS / Safari, at the floor');
    A.ok(!txt.includes('broken or blocked file'), 'an outdated engine is never called a broken or blocked file');
    A.ok(!txt.includes('RELOAD'), 'no RELOAD (it can never update a web engine)');
    A.ok(t.guard.report().includes('web engine:     TOO OLD — no Object.hasOwn, Array.prototype.at, structuredClone, Crypto.prototype.randomUUID, HTMLDialogElement.prototype.showModal (needs Safari 15.4+ WebKit on macOS)'), 'the copied report says the web engine is too old and what it lacks: ' + t.guard.report().split('\n').find(l => /web engine/.test(l)));
    A.ok(b && !/inset:/.test(b.style.cssText) && /top:0;left:0;right:0;bottom:0/.test(b.style.cssText), 'the overlay avoids inset (Safari 14.1+) so it covers an old window');
    const modern = boot(allGlobals()), bf = modern.guard._internals.belowFloor;
    A.eq(typeof bf === 'function' ? bf() : 'no belowFloor()', false, 'an engine at the floor is not flagged');
    A.ok(!/web engine/.test(modern.guard.report()), 'and its report has no web-engine warning');
  }

  /* ---- 11. PER-SCRIPT ACCOUNTING (header 5): every station <script> of the real index.html RAN, FAILED TO LOAD or THREW
     WHILE LOADING, and the page's verdict reaches the shell once. The page below is index.html's own script list, loaded
     the way a browser does: each script is current while it evaluates, fires its load event on the document after, and
     DOMContentLoaded comes last. ---- */
  const PAGE = [...INDEX.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1].replace(/^\/+/, ''));
  A.ok(PAGE.length > 200 && PAGE[0] === 'app/bootguard.js' && PAGE.includes('shared/specialties.js'), 'the page under test is index.html\'s ' + PAGE.length + ' scripts, boot guard first');
  function page(opts) {
    opts = opts || {};
    const g = allGlobals();
    (opts.missing || []).forEach(n => { delete g[n]; });
    const calls = [];
    if (opts.shell !== false) {
      g.__TAURI__ = { core: { invoke(cmd, args) {
        calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
        if (opts.shell === 'throws') throw new Error('no ipc');
        return opts.shell === 'older' ? Promise.reject(new Error('command starnet_boot_report not found')) : Promise.resolve(null);
      } } };
    }
    const els = PAGE.map(src => Object.assign(fakeEl('script'), { src: 'tauri://localhost/' + src }));
    const t = boot(g, { before: opts.before || '' });
    const doc = t.sandbox.document;
    doc.querySelectorAll = sel => { if (opts.listThrows) throw new Error('no selectors'); return sel === 'script[src]' ? els : []; };
    doc.currentScript = null;
    const docFire = (type, e) => (t.handlers.doc[type] || []).forEach(fn => fn(e));
    // the guard itself has run (boot() above): its own load event comes next, then every other script in order
    if (!(opts.noLoad && opts.noLoad.includes(PAGE[0]))) docFire('load', { target: els[0] });
    for (let i = 1; i < els.length; i++) {
      const el = els[i], file = PAGE[i];
      if (opts.fails && opts.fails.includes(file)) { t.fire('error', { target: el }); continue; }
      doc.currentScript = el;
      const th = opts.throws && opts.throws[file];
      if (th) t.fire('error', Object.assign({ message: th.message || (th.kind + ': at load sk-SECRET-' + i), filename: th.elsewhere ? 'tauri://localhost/js/util.js' : el.src, lineno: th.line || 0 }, th.kind ? { error: { name: th.kind } } : {}));
      doc.currentScript = null;
      if (!(opts.noLoad && opts.noLoad.includes(file))) docFire('load', { target: el });
    }
    (opts.afterLoad || []).forEach(e => t.fire('error', e));
    t.ready();
    return Object.assign(t, { els, calls, report: () => (calls.find(c => c.cmd === 'starnet_boot_report') || { args: {} }).args.report });
  }
  const STATION = PAGE.slice(1);
  // the verdict, or what a guard without per-script accounting amounts to (the commit before had none)
  const V = t => typeof t.guard.verdict === 'function' ? t.guard.verdict() : { verdict: 'none (no per-script accounting)', listed: false, total: null, ran: null, seen: 0, notRun: [] };
  {
    const t = page();
    const v = V(t);
    A.eq([v.verdict, v.listed, v.total, v.ran, v.seen, v.notRun.length], ['passed', true, PAGE.length, PAGE.length, PAGE.length, 0], 'healthy page: every station script ran, each seen by its own load event');
    A.ok(t.guard.report().includes('boot check:     passed') && t.guard.report().includes('scripts:        ' + PAGE.length + ' of ' + PAGE.length + ' station scripts ran'), 'the report says passed and counts every script');
    A.eq(t.guard.summaryLine(), 'none recorded since page load', 'the copied diagnostics stay a real zero');
    A.eq(t.calls.length, 1, 'ONE starnet_boot_report per page load');
    A.eq(t.report(), { total: PAGE.length, ran: PAGE.length, notRun: [], missing: [], belowFloor: false }, 'the shell gets the counts, nothing else');
    t.ready(); t.guard.verify();
    A.eq(t.calls.length, 1, 'a second check sends nothing more');
  }
  {
    // Losing the entire load-event stream is weaker evidence than losing one event, never a healthy boot.
    const unavailable = [
      page({ noLoad: PAGE }),
      page({ before: "const realListen = document.addEventListener; document.addEventListener = function(t, fn) { if (t === 'load') throw new Error('load listener unavailable'); return realListen.call(this, t, fn); };" })
    ];
    for (const t of unavailable) {
      const v = V(t), r = t.report();
      A.eq([v.verdict, v.total, v.ran, v.seen, v.notRun.length], ['DEGRADED', PAGE.length, 0, 0, PAGE.length], 'no observed script loads cannot certify that every script ran');
      A.ok(v.notRun.every(n => n.why === 'never') && r.ran === 0 && r.notRun.length === 40, 'the shell receives zero proven loads and bounded missing-event evidence');
      A.eq(t.banner(), null, 'missing measurement alone does not take away a functioning station');
    }
  }
  {
    // EVERY station script in turn throws while loading (the #136 shape), every critical global still present
    const wrong = [];
    for (const file of STATION) {
      const t = page({ throws: { [file]: { kind: 'SyntaxError', line: 7 } } });
      const v = V(t), r = t.report() || {};
      const ok = v.verdict === 'DEGRADED' && v.ran === PAGE.length - 1 && v.notRun.length === 1 && v.notRun[0].file === file && !t.banner()
        && t.guard.report().includes('did not run: ' + file + ' (SyntaxError at line 7)') && t.guard.summaryLine().startsWith('1 station script(s) did not run: ' + file + ' (SyntaxError at line 7)')
        && JSON.stringify(r.notRun) === JSON.stringify([{ file, why: 'threw', kind: 'SyntaxError', line: 7 }]) && r.ran === PAGE.length - 1 && !/SECRET/.test(JSON.stringify(r) + t.guard.summaryLine());
      if (!ok) wrong.push(file + ' → ' + v.verdict + ' ' + JSON.stringify(v.notRun));
    }
    A.eq(wrong, [], 'every one of the ' + STATION.length + ' station scripts that throws while loading is named (kind + line, never the message), DEGRADED, no banner, one page-boot report naming it');
  }
  {
    // EVERY station script in turn fails to load: the fatal rule (a station script 404) is unchanged, and it is named
    const wrong = [];
    for (const file of STATION) {
      const t = page({ fails: [file] });
      const v = V(t), r = t.report() || {}, b = t.banner();
      const ok = v.verdict === 'FAILED' && b && textOf(b).includes('script did not load — ' + file)
        && JSON.stringify(r.notRun) === JSON.stringify([{ file, why: 'load' }]) && r.total === PAGE.length && r.ran === PAGE.length - 1;
      if (!ok) wrong.push(file + ' → ' + v.verdict + ' ' + JSON.stringify(r.notRun));
    }
    A.eq(wrong, [], 'every one of the ' + STATION.length + ' station scripts that fails to load is FAILED (the banner names it) and reported once');
  }
  {
    // the throw came from a function in another file while app/workflowline.js evaluated: still that script, no line
    const t = page({ throws: { 'app/workflowline.js': { kind: 'TypeError', line: 40, elsewhere: true } } });
    A.eq(V(t).notRun, [{ file: 'app/workflowline.js', why: 'threw', kind: 'TypeError', line: 0 }], 'a throw from a called file is the evaluating script\'s (document.currentScript)');
    // a script whose load event never came, while every other script fired one
    const quiet = page({ noLoad: ['app/recipes.js'] });
    A.eq([V(quiet).verdict, V(quiet).notRun], ['DEGRADED', [{ file: 'app/recipes.js', why: 'never' }]], 'a script with no load event did not run');
    // an error AFTER a script loaded (a timer before DOMContentLoaded) is a runtime error, not a script that did not run
    const late = page({ afterLoad: [{ message: 'TypeError: late', filename: 'tauri://localhost/app/chat.js', lineno: 3 }] });
    A.eq([V(late).verdict, late.guard.state().uncaught], ['passed', 1], 'a runtime error after its script loaded is counted, the boot still passed');
    // a throw with no type name still counts, as an Error
    const plain = page({ throws: { 'app/recipes.js': { message: 'boom', line: 2 } } });
    A.eq(V(plain).notRun, [{ file: 'app/recipes.js', why: 'threw', kind: 'Error', line: 2 }], 'a throw without a type name is an Error');
  }
  {
    // a critical module that throws while loading: the fatal banner (missing global) also names the throw
    const t = page({ throws: { 'app/world.js': { kind: 'SyntaxError', line: 12 } }, missing: ['World'] });
    const b = t.banner();
    A.ok(b && textOf(b).includes('World — app/world.js') && textOf(b).includes('script threw while loading — app/world.js (SyntaxError at line 12)'), 'the banner names a critical script that threw while loading');
    A.eq([V(t).verdict, (t.report() || {}).missing], ['FAILED', ['World']], 'FAILED, with the missing module named to the shell');
  }
  {
    // bounded: 60 scripts that did not run name 40 to the shell; the counts carry the rest
    const throws = {};
    STATION.slice(0, 60).forEach(f => { throws[f] = { kind: 'SyntaxError', line: 1 }; });
    const r = page({ throws }).report();
    A.eq([r.notRun.length, r.total - r.ran], [40, 60], 'at most 40 not-run scripts are named to the shell, the counts say 60');
  }
  {
    // the shell's side may be missing (an older shell), throw, or be absent (browser, website): the boot is unharmed
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on('unhandledRejection', onUnhandled);
    const older = page({ shell: 'older' });
    const thrower = page({ shell: 'throws', missing: ['Chat'] });
    const browser = page({ shell: false });
    await new Promise(r => setTimeout(r, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    A.eq([older.calls.length, unhandled], [1, 0], 'an older shell rejects the unknown command: swallowed, no unhandled rejection');
    A.ok(thrower.banner() && V(thrower).verdict === 'FAILED', 'an invoke that throws leaves the fatal banner intact');
    A.eq([browser.calls.length, V(browser).verdict], [0, 'passed'], 'no shell: nothing is sent');
  }
  {
    // a document with no script list (or one that throws) is never blinded: the ledger names what it saw
    const bare = boot(allGlobals());
    bare.ready();
    A.eq([V(bare).listed, V(bare).verdict], [false, 'passed'], 'no querySelectorAll: no count, no crash, passed');
    A.ok(!/scripts:/.test(bare.guard.report()), 'and no scripts line it cannot back');
    const t = page({ listThrows: true, throws: { 'app/recipes.js': { kind: 'SyntaxError', line: 4 } } });
    A.eq([V(t).listed, V(t).verdict, V(t).notRun.map(n => n.file)], [false, 'DEGRADED', ['app/recipes.js']], 'a throwing script list: the throw is still named, DEGRADED');
    A.eq([t.report().total, t.report().ran], [0, 0], 'and the shell is told nothing was counted');
  }
  {
    // the shared catalog retry: the report waits for the final verdict (once), never mid-retry
    const t = page({ fails: ['shared/specialties.js'] });
    A.eq(t.calls.length, 1, 'no retry possible in this sandbox: the fatal verdict is reported once');
    const r = boot(allGlobals());
    const calls = [];
    r.sandbox.__TAURI__ = { core: { invoke: (cmd, args) => { calls.push(args); return Promise.resolve(); } } };
    const timers = [];
    r.sandbox.setTimeout = (fn, ms) => { timers.push(fn); return timers.length; };
    r.sandbox.document.head = fakeEl('head');
    r.fire('error', { target: Object.assign(fakeEl('script'), { src: 'tauri://localhost/shared/specialties.js' }) });
    r.ready();
    A.eq(calls.length, 0, 'a shared/ retry in flight: nothing reported yet');
    for (let i = 0; i < r.guard._internals.RETRY_WAITS.length; i++) { timers.shift()(); const head = r.sandbox.document.head.children; head[head.length - 1].onerror(); }
    A.eq([calls.length, calls[0] && calls[0].report.notRun], [1, [{ file: 'shared/specialties.js', why: 'load' }]], 'the exhausted retry reports the failure once');
  }
  A.report('bootguard');
})();
