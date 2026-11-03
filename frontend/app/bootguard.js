/* STARNET — bootguard.js : the FIRST app script. Makes a broken boot LOUD instead of silent.

   The audit finding this answers ("first run fails silently by construction"): nothing in frontend/ listened for
   window `error` / `unhandledrejection`, and app.js guards every module with `typeof X !== 'undefined'` — so a
   404'd or syntax-broken module (a bad install, a blocked file, a half-synced mirror) produced a page that loaded,
   painted the void, and did nothing, with zero on-screen evidence of WHICH file failed. Support got a black
   screenshot.

   This module is tiny and dependency-free ON PURPOSE — it must work when everything after it is broken:
     1. installs capture-phase `error` (runtime errors AND station-owned <script> load failures — a resource
        error does not bubble, so capture on window is the only place that sees a 404'd script) +
        `unhandledrejection` listeners and keeps bounded counts/tails since page load. Counts only — no secrets
        are read, ever. Hosting layers may inject unrelated scripts; those cannot define station boot health;
     2. after DOMContentLoaded (every classic <script> has run by then) probes the ~dozen module globals without
        which the station is unusable. The probes are LITERAL `typeof X` expressions: these modules are `const`
        IIFEs (global lexical bindings, invisible on window.*), and the desktop CSP forbids eval/new Function;
     3. only if a critical global is missing OR a <script> failed to load does it render the fatal banner — matte
        CRT chrome in the app's own vocabulary, naming the file, with COPY DIAGNOSTICS + RELOAD. A healthy boot
        never sees it: neither a runtime error in a non-critical module nor a rejected promise trips the banner;
        those are counted and ride the diagnostics report (diagnostics.js appends BootGuard.summaryLine());
     4. shared/ scripts are same-origin boot data (embedded by desktop staging). Older builds fetched
        the catalog from the sidecar port and could fail while the engine was starting. Two customer boots (2026-09-10 Mac,
        2026-09-13 Windows) painted this banner naming shared/specialties.js while RELOAD cleared it. So a
        shared/ load failure is RETRIED with backoff (~27 s, the shell's own port-wait window) before it is
        declared fatal; a successful retry reloads the page ONCE (bounded) so the parser-ordered modules that
        wrap the catalog bind to the real data. app/ and js/ scripts ship inside the bundle and never retry;
     5. EVERY station <script> (app/, js/, shared/) is accounted: it RAN (its load event, seen on the document),
        FAILED TO LOAD (an error event at the element), or THREW WHILE LOADING (an error reported while it was being
        evaluated: its type name and line, never the message). #136: a SyntaxError dropped app/workflowline.js, no
        critical global was missing, and the boot check said "passed". A boot check now reads passed only when every
        station script ran; otherwise DEGRADED, naming each script that did not (the fatal rule in 3 is unchanged:
        a station that mostly works is never taken away by the banner). Once per page load the counts, those paths,
        kinds and lines go to the desktop shell (starnet_boot_report), which writes one "page-boot:" line to
        startup.log for support and the installed acceptance.

   Exposes `window.BootGuard`: state(), verdict(), summaryLine(), report(), check(), render(). Node-requirable for
   tests. */
'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.BootGuard = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const TAIL = 24;   // bounded tails: diagnostics need the shape of the failure, not an unbounded log
  const state = {
    uncaught: 0, rejections: 0, scriptFailures: 0,
    errors: [], rejected: [], scripts: [], where: [],
    missing: [], checked: false, fired: false, startedAt: Date.now(),
    // shared/ catalog retry ledger — see header (4). attempts counts retries scheduled since page load;
    // pending is the retry currently in flight (verify() defers the banner while one is); recovered marks a
    // retry that loaded, after which the page reloads once so every dependent module binds the real catalog.
    retry: { attempts: 0, pending: 0, recovered: 0, exhausted: false, deferred: false, src: '', reloads: 0 },
    // per-script accounting — see header (5). files: station path → { loaded, failed, threw: { kind, line } | null };
    // accounting: the DOMContentLoaded verdict over every station <script> of the page; reported: the shell has it.
    files: Object.create(null), fileCount: 0, loadsSeen: 0, dcl: false, accounting: null, reported: false
  };
  const MAX_FILES = 2048;   // bounds the ledger (the station page loads ~270 scripts)
  const SENT_NOT_RUN = 40;  // at most this many not-run scripts are named to the shell; the counts carry the rest
  // backoff schedule for the shared/ catalog (ms between attempts). ~27 s total: the desktop shell waits up
  // to ~25 s for the sidecar port, so a boot that races the engine settles inside this window.
  const RETRY_WAITS = [800, 2000, 4000, 8000, 12000];
  const RELOAD_KEY = 'starnet.bootguard.autoreload';   // sessionStorage: bounded auto-reloads per tab
  const RELOAD_MAX = 2;                                 // a flapping engine gets the banner, never a reload loop

  /* THE CRITICAL SET — module global → the file that defines it. Chosen from what app.js already guards with
     `typeof X !== 'undefined'`: with any one of these missing the station cannot boot, save, render, or talk.
     Literal typeofs (see header). Adding one here = declaring "the app is unusable without it". */
  const PROBES = [
    ['U',          'js/util.js',           () => typeof U],
    ['Harness',    'app/harness.js',       () => typeof Harness],
    ['Save',       'app/save.js',          () => typeof Save],
    ['CloudSave',  'app/cloudsave.js',     () => typeof CloudSave],
    ['World',      'app/world.js',         () => typeof World],
    ['StationUI',  'app/stationui.js',     () => typeof StationUI],
    ['Chat',       'app/chat.js',          () => typeof Chat],
    ['Channels',   'app/channels.js',      () => typeof Channels],
    ['Personas',   'app/personas.js',      () => typeof Personas],
    ['Onboarding', 'app/onboarding.js',    () => typeof Onboarding],
    ['Tutorial',   'app/tutorial.js',      () => typeof Tutorial],
    ['App',        'app/app.js',           () => typeof App],
    ['Topbar',     'app/topbar.js',        () => typeof Topbar]
  ];

  function push(list, item) { list.push(String(item).slice(0, 300)); if (list.length > TAIL) list.shift(); }
  function shortPath(s) {
    // regex-only (no URL global needed): drop scheme+host, query/hash, leading slashes → 'app/world.js'
    s = String(s || '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
    return s.replace(/^\/+/, '') || '(inline)';
  }
  function isStationScript(s) {
    // Every authored station module lives below one of these three roots. Public hosts may append their own
    // analytics/challenge scripts (for example Cloudflare's /beacon.min.js); a blocked optional host script is
    // not evidence that StarNet failed to boot. Keep the allowlist structural so real app/shared 404s remain loud.
    return /^(?:app|js|shared)\//.test(shortPath(s));
  }
  // Catalog retry retained for browser/dev service startup; failure does not prove engine health.
  function isSharedScript(s) { return /^shared\//.test(shortPath(s)); }
  function isRetryElement(t) {
    try { return !!(t && typeof t.getAttribute === 'function' && t.getAttribute('data-bootguard-retry')); } catch (_) { return false; }
  }
  // a retry needs a timer and a document to inject into; the node/vm test sandbox has neither, which keeps
  // the classic "failed shared script is fatal" path deterministic there.
  function canRetry() {
    const doc = root.document;
    return typeof root.setTimeout === 'function' && !!doc && typeof doc.createElement === 'function' && !!(doc.head || doc.body);
  }
  function reloadsSoFar() {
    try { const v = root.sessionStorage && root.sessionStorage.getItem(RELOAD_KEY); return v ? (parseInt(v, 10) || 0) : 0; } catch (_) { return state.retry.reloads; }
  }
  function noteReload(n) {
    state.retry.reloads = n;
    try { if (root.sessionStorage) root.sessionStorage.setItem(RELOAD_KEY, String(n)); } catch (_) {}
  }
  function scheduleRetry(src) {
    const r = state.retry;
    if (r.exhausted || r.pending) return false;
    if (r.attempts >= RETRY_WAITS.length) { r.exhausted = true; return false; }
    const wait = RETRY_WAITS[r.attempts];
    r.attempts++; r.pending++; r.src = shortPath(src);
    root.setTimeout(function () {
      try {
        const doc = root.document;
        const el = doc.createElement('script');
        el.setAttribute('data-bootguard-retry', String(r.attempts));
        el.async = false;
        el.onload = function () { r.pending = Math.max(0, r.pending - 1); onRetryLoaded(); };
        el.onerror = function () {
          r.pending = Math.max(0, r.pending - 1);
          if (!scheduleRetry(src)) { r.exhausted = true; if (r.deferred) verify(); }
        };
        el.src = String(src) + (String(src).indexOf('?') > -1 ? '&' : '?') + 'bootguard-retry=' + r.attempts;
        (doc.head || doc.body).appendChild(el);
      } catch (_) {
        r.pending = Math.max(0, r.pending - 1);
        r.exhausted = true; if (r.deferred) verify();
      }
    }, wait);
    return true;
  }
  function onRetryLoaded() {
    const r = state.retry;
    r.recovered++;
    const n = reloadsSoFar();
    if (n < RELOAD_MAX) {
      // the catalog answered late: app/specialties.js already wrapped an empty catalog, so the only honest
      // recovery is a fresh parse — bounded, and only after a PROVEN successful load (never a blind loop).
      noteReload(n + 1);
      try { root.location.reload(); return; } catch (_) {}
    }
    // reload budget spent (a flapping engine): the page is still bound to an empty catalog → say so.
    r.exhausted = true; if (r.deferred) verify();
  }
  // the error's TYPE name ('SyntaxError', 'TypeError', …) or '' — a bare identifier, so it can never carry data
  function errorKind(e) {
    try {
      const n = e && e.error && typeof e.error.name === 'string' ? e.error.name : '';
      if (/^[A-Z][A-Za-z]{0,40}Error$/.test(n)) return n;
      const m = /^(?:Uncaught )?([A-Z][A-Za-z]{0,40}Error)\b/.exec(String((e && e.message) || ''));
      return m ? m[1] : '';
    } catch (_) { return ''; }
  }
  function reasonText(r) {
    if (r == null) return 'unhandled rejection (no reason)';
    if (typeof r === 'object') return String(r.message || r.reason || r.name || (function () { try { return JSON.stringify(r); } catch (_) { return '[object]'; } })());
    return String(r);
  }

  /* ---- 1. the listeners ---- */
  // the ledger entry of one station script (null once the ledger is full)
  function entry(file) {
    let k = state.files[file];
    if (!k) {
      if (state.fileCount >= MAX_FILES) return null;
      k = state.files[file] = { loaded: false, failed: false, threw: null };
      state.fileCount++;
    }
    return k;
  }
  function scriptPath(t) {
    try { return shortPath(t.src || (t.getAttribute && t.getAttribute('src'))); } catch (_) { return ''; }
  }
  // the station script being evaluated when an error was reported: document.currentScript names it (an error in a
  // function it called still means it did not finish); without it, the error's own file while that file has not
  // fired its load event. After DOMContentLoaded no classic station script is still loading.
  function loadingScript(e) {
    try {
      const cur = root.document && root.document.currentScript;
      if (cur && !isRetryElement(cur)) { const f = scriptPath(cur); if (isStationScript(f)) return f; }
    } catch (_) {}
    if (state.dcl) return '';
    const f = shortPath(e && e.filename), k = state.files[f];
    return isStationScript(f) && !(k && k.loaded) ? f : '';
  }
  function onLoad(e) {
    try {
      const t = e && e.target;
      if (!t || !t.tagName || String(t.tagName).toUpperCase() !== 'SCRIPT' || isRetryElement(t)) return;
      const f = scriptPath(t);
      if (!isStationScript(f)) return;
      const k = entry(f);
      if (k && !k.loaded) { k.loaded = true; state.loadsSeen++; }
    } catch (_) {}
  }
  function onError(e) {
    try {
      const t = e && e.target;
      if (t && t !== root && t.tagName) {
        // a RESOURCE failure (capture phase). Only <script> is a boot fault — an <img>/<audio> that 404s is cosmetic.
        const src = t.src || t.getAttribute && t.getAttribute('src');
        if (String(t.tagName).toUpperCase() === 'SCRIPT' && isRetryElement(t)) return;   // a retry's own miss is handled by its onerror
        if (String(t.tagName).toUpperCase() === 'SCRIPT' && isStationScript(src)) {
          state.scriptFailures++;
          push(state.scripts, shortPath(src));
          const k = entry(shortPath(src));
          if (k) k.failed = true;
          if (isSharedScript(src) && canRetry()) scheduleRetry(src);
        }
        return;
      }
      state.uncaught++;
      const at = shortPath(e && e.filename) + (e && e.lineno ? ':' + e.lineno : '');
      push(state.errors, (e && e.message ? e.message : 'error') + ' @ ' + at);
      // WHERE, for the copied diagnostics (#136: "page errors: 1 uncaught error(s)" was all a Mac report could say while a
      // SyntaxError dropped app/workflowline.js). File:line + the error's type name only — never the message, which can
      // carry data — so a module that failed to parse is named by every report, banner or not. Distinct places, FIRST seen
      // kept (a boot-time parse error must not be pushed out by a later error looping in one place), bounded.
      const kind = errorKind(e), w = at + (kind ? ' (' + kind + ')' : '');
      if (state.where.indexOf(w) < 0 && state.where.length < TAIL) state.where.push(w.slice(0, 300));
      // a THROW WHILE LOADING: that station script did not run (header 5): its kind and line, never the message
      const lf = loadingScript(e);
      const k = lf ? entry(lf) : null;
      if (k && !k.threw && !k.failed) {
        const line = shortPath(e && e.filename) === lf ? (parseInt(e && e.lineno, 10) || 0) : 0;
        k.threw = { kind: kind || 'Error', line: line > 0 ? line : 0 };
      }
    } catch (_) {}
  }
  function onRejection(e) {
    try { state.rejections++; push(state.rejected, reasonText(e && e.reason)); } catch (_) {}
  }
  function install() {
    try {
      if (typeof root.addEventListener !== 'function') return false;
      root.addEventListener('error', onError, true);
      root.addEventListener('unhandledrejection', onRejection);
      // a script's load event stops at the document (the DOM never hands a load event on to window), so the
      // accounting listens there, capture phase
      try { const doc = root.document; if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('load', onLoad, true); } catch (_) {}
      return true;
    } catch (_) { return false; }
  }

  /* ---- 2. the boot-integrity check ---- */
  function check(probes) {
    const list = Array.isArray(probes) ? probes : PROBES;
    state.missing = [];
    for (const p of list) {
      let kind = 'undefined';
      try { kind = p[2](); } catch (_) { kind = 'undefined'; }
      if (kind === 'undefined') state.missing.push({ name: p[0], file: p[1] });
    }
    state.checked = true;
    return state.missing.length === 0 && state.scriptFailures === 0;
  }

  /* the per-script verdict at DOMContentLoaded (header 5): every station <script> of the page, deduplicated. Without a
     script list (a stub document) the ledger alone names what it saw fail; a script with neither a load nor an error
     event has no evidence of running. An unavailable load listener must not turn zero observations into a passed boot. */
  function account() {
    const known = state.files, out = { listed: false, total: null, ran: null, seen: 0, notRun: [] };
    let list = null;
    try {
      const doc = root.document;
      if (doc && typeof doc.querySelectorAll === 'function') {
        const els = doc.querySelectorAll('script[src]'), had = Object.create(null);
        list = [];
        for (let i = 0; i < els.length; i++) {
          if (isRetryElement(els[i])) continue;
          const f = scriptPath(els[i]);
          if (!isStationScript(f) || had[f]) continue;
          had[f] = true; list.push(f);
        }
      }
    } catch (_) { list = null; }
    const names = list || Object.keys(known);
    for (let i = 0; i < names.length; i++) {
      const f = names[i], k = known[f] || {};
      if (k.loaded || k.failed) out.seen++;
      if (k.failed) out.notRun.push({ file: f, why: 'load' });
      else if (k.threw) out.notRun.push({ file: f, why: 'threw', kind: k.threw.kind, line: k.threw.line });
      else if (list && !k.loaded) out.notRun.push({ file: f, why: 'never' });
    }
    if (list) { out.listed = true; out.total = list.length; out.ran = list.length - out.notRun.length; }
    state.accounting = out;
    return out;
  }
  // what did not run: the DOMContentLoaded accounting, or (before it) what the ledger has seen fail so far
  function notRunNow() {
    if (state.accounting) return state.accounting.notRun;
    const out = [];
    for (const f of Object.keys(state.files)) {
      const k = state.files[f];
      if (k.failed) out.push({ file: f, why: 'load' });
      else if (k.threw) out.push({ file: f, why: 'threw', kind: k.threw.kind, line: k.threw.line });
    }
    return out;
  }
  function whyNotRun(n) {
    return n.file + ' (' + (n.why === 'load' ? 'failed to load' : n.why === 'never' ? 'no load event' : n.kind + (n.line ? ' at line ' + n.line : '')) + ')';
  }
  function bootVerdict() {
    if (!state.checked) return 'not run yet';
    if (state.missing.length || state.scriptFailures) return 'FAILED';
    return notRunNow().length ? 'DEGRADED' : 'passed';
  }
  function listed(items, max) {
    return items.slice(0, max).map(whyNotRun).join(', ') + (items.length > max ? ' +' + (items.length - max) + ' more' : '');
  }

  /* ---- 3. the report + the banner ---- */
  /* AN OUTDATED WEB ENGINE is not a broken file. macOS 10.15 (Safari 13 WebKit, 2026-10-08 report) parsed the bundle
     into four SyntaxError/TypeErrors and the banner said "a broken or blocked file", which RELOAD can never fix. On
     macOS the app window uses the SYSTEM WebKit, which only updates with Safari / macOS.
     THE FLOOR is scripts/lib/engine-floor.json, the one place it is declared; FLOOR mirrors it (stage-frontend-dist.mjs
     refuses to stage when they disagree, test/engine-floor.test.js holds them equal). An engine is below the floor
     exactly when it lacks one of the APIs the floor is defined by (the table's api features whose since is the floor,
     which the station code uses without a guard). Syntax newer than the floor is banned from the page by
     test/webkit-floor-syntax.test.js, so no probe parses it here. Literal typeofs: the desktop CSP forbids eval. */
  const FLOOR = Object.freeze({ safari: '15.4', macos: '11.0', macosWithFloor: '12.3' });
  const FLOOR_PROBES = [
    ['Object.hasOwn',                         () => typeof Object.hasOwn],
    ['Array.prototype.at',                    () => typeof Array.prototype.at],
    ['structuredClone',                       () => typeof structuredClone],
    // a [SecureContext] API: a page served insecurely (plain http on a LAN address) lacks it on every engine, so there
    // its absence says nothing about the engine's age
    ['Crypto.prototype.randomUUID',           () => root.isSecureContext === false ? 'function' : (typeof crypto === 'undefined' || !crypto ? 'undefined' : typeof crypto.randomUUID)],
    ['HTMLDialogElement.prototype.showModal', () => typeof HTMLDialogElement === 'undefined' || !HTMLDialogElement.prototype ? 'undefined' : typeof HTMLDialogElement.prototype.showModal]
  ];
  const MAC_NAMES = { 11: 'Big Sur', 12: 'Monterey', 13: 'Ventura', 14: 'Sonoma', 15: 'Sequoia' };
  function macName(v) { const s = String(v).replace(/\.0$/, ''); const n = MAC_NAMES[parseInt(s, 10)]; return n ? s + ' ' + n : s; }
  // the floor APIs this engine lacks ([] = at or above the floor)
  function floorMissing() {
    const out = [];
    for (const p of FLOOR_PROBES) {
      let kind = 'undefined';
      try { kind = p[1](); } catch (_) { kind = 'undefined'; }
      if (kind !== 'function') out.push(p[0]);
    }
    return out;
  }
  function belowFloor() { return floorMissing().length > 0; }
  function isMacUA() {
    try { return /Macintosh|Mac OS X/.test(String(root.navigator && root.navigator.userAgent || '')); } catch (_) { return false; }
  }
  function summaryLine() {
    const parts = [];
    if (state.scriptFailures) parts.push(state.scriptFailures + ' script load failure(s): ' + state.scripts.join(', '));
    // the scripts that loaded but did not run (a load failure is named just above)
    const notRun = notRunNow().filter(n => n.why !== 'load');
    if (notRun.length) parts.push(notRun.length + ' station script(s) did not run: ' + listed(notRun, 6));
    if (state.missing.length) parts.push(state.missing.length + ' missing module(s): ' + state.missing.map(m => m.name).join(', '));
    if (state.uncaught) {
      const w = state.where;
      parts.push(state.uncaught + ' uncaught error(s)' + (w.length ? ' at ' + w.slice(0, 4).join(', ') + (w.length > 4 ? ' +' + (w.length - 4) + ' more' : '') : ''));
    }
    if (state.rejections) parts.push(state.rejections + ' unhandled rejection(s)');
    return parts.length ? parts.join(' · ') : 'none recorded since page load';
  }
  function report() {
    const L = [];
    L.push('STARNET BOOT GUARD (page-side — measured by the app window itself)');
    L.push('when:           ' + new Date().toISOString());
    L.push('page:           ' + String((root.location && root.location.pathname) || '/'));
    L.push('boot check:     ' + bootVerdict());
    const a = state.accounting, notRun = notRunNow();
    if (a && a.listed) L.push('scripts:        ' + a.ran + ' of ' + a.total + ' station scripts ran' + (notRun.length ? ' · did not run: ' + listed(notRun, 12) : ''));
    else if (notRun.length) L.push('scripts:        did not run: ' + listed(notRun, 12));
    if (state.missing.length) L.push('missing:        ' + state.missing.map(m => m.name + ' (' + m.file + ')').join(', '));
    if (state.scripts.length) L.push('scripts failed: ' + state.scripts.join(', '));
    if (state.retry.attempts) L.push('shared retry:   ' + state.retry.attempts + ' attempt(s) for ' + state.retry.src + (state.retry.recovered ? ' — recovered (reloaded ' + state.retry.reloads + '×)' : state.retry.exhausted ? ' — script load retries exhausted' : ' — in progress'));
    const below = floorMissing();
    if (below.length) L.push('web engine:     TOO OLD — no ' + below.join(', ') + ' (needs Safari ' + FLOOR.safari + '+ WebKit on macOS)');
    L.push('page errors:    ' + summaryLine());
    state.errors.forEach(x => L.push('  error:        ' + x));
    state.rejected.forEach(x => L.push('  rejection:    ' + x));
    try { if (root.navigator && root.navigator.userAgent) L.push('webview:        ' + String(root.navigator.userAgent).slice(0, 300)); } catch (_) {}
    return L.join('\n');
  }

  function copyText(text) {
    try { if (typeof Diag !== 'undefined' && Diag && Diag.copyText) return Promise.resolve(Diag.copyText(text)); } catch (_) {}
    try {
      if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) return root.navigator.clipboard.writeText(text).then(() => true, () => false);
    } catch (_) {}
    return Promise.resolve(false);
  }

  function render() {
    const doc = root.document;
    if (!doc || !doc.body || state.fired) return null;
    state.fired = true;
    const why = [];
    state.missing.forEach(m => why.push(m.name + ' — ' + m.file));
    state.scripts.forEach(s => { if (!state.missing.some(m => m.file === s)) why.push('script did not load — ' + s); });
    notRunNow().forEach(n => { if (n.why === 'threw') why.push('script threw while loading — ' + whyNotRun(n)); });

    const wrap = doc.createElement('div');
    wrap.id = 'bootguard-fatal'; wrap.className = 'bgf'; wrap.setAttribute('role', 'alert');
    // inline essentials so the banner is visible even if app.css itself failed to arrive
    // top/left/right/bottom, not `inset`: the outdated-engine case below must still cover the window (inset is Safari 14.1+)
    wrap.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:900;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.88);font-family:VT323,monospace;';

    const card = doc.createElement('div'); card.className = 'bgf-card';
    const head = doc.createElement('div'); head.className = 'bgf-head';
    const below = floorMissing(), old = below.length > 0;
    const mac = isMacUA();
    head.textContent = old ? (mac ? '▮ STARNET NEEDS A NEWER macOS' : '▮ STARNET NEEDS A NEWER WEB ENGINE') : '▮ STATION FAILED TO BOOT';
    const lead = doc.createElement('div'); lead.className = 'bgf-lead';
    lead.textContent = old
      ? (mac
        ? 'this Mac’s built-in web engine is too old to run StarNet. StarNet needs macOS ' + macName(FLOOR.macos) + ' or later with Safari ' + FLOOR.safari + ' or newer — macOS ' + macName(FLOOR.macosWithFloor) + ' or later has it built in. nothing is broken and your station is untouched: update macOS (or Safari) in System Settings, then reopen StarNet.'
        : 'this computer’s web engine is too old to run StarNet (it has no ' + below.join(', ') + '). nothing is broken and your station is untouched: update the system web engine (WebKitGTK on Linux, WebView2 on Windows), then reopen StarNet.')
      : 'the app window loaded, but a required module did not. this is a broken or blocked file, not your station — your saved station has not been changed by this screen.';
    const list = doc.createElement('ul'); list.className = 'bgf-list';
    why.forEach(w => { const li = doc.createElement('li'); li.textContent = w; list.appendChild(li); });
    const pre = doc.createElement('pre'); pre.className = 'bgf-pre'; pre.textContent = report();
    const acts = doc.createElement('div'); acts.className = 'bgf-actions';
    const copyBtn = doc.createElement('button'); copyBtn.type = 'button'; copyBtn.className = 'btn bgf-copy'; copyBtn.textContent = '⧉ COPY DIAGNOSTICS';
    copyBtn.onclick = () => {
      copyBtn.disabled = true; copyBtn.textContent = '⧉ COPYING…';
      const mine = report();
      let extra = Promise.resolve('');
      try { if (typeof Diag !== 'undefined' && Diag && Diag.fetchText) extra = Promise.resolve(Diag.fetchText()).catch(() => ''); } catch (_) {}
      extra.then(t => copyText(mine + (t ? '\n\n' + t : ''))).then(ok => {
        copyBtn.disabled = false;
        copyBtn.textContent = ok ? '✓ DIAGNOSTICS COPIED' : '⧉ COPY FAILED — SELECT THE TEXT ABOVE';
      }, () => { copyBtn.disabled = false; copyBtn.textContent = '⧉ COPY FAILED — SELECT THE TEXT ABOVE'; });
    };
    const reloadBtn = doc.createElement('button'); reloadBtn.type = 'button'; reloadBtn.className = 'btn-xl bgf-reload'; reloadBtn.textContent = '⟳ RELOAD';
    reloadBtn.onclick = () => { try { root.location.reload(); } catch (_) {} };
    acts.appendChild(copyBtn); if (!old) acts.appendChild(reloadBtn);   // RELOAD cannot update a web engine
    card.appendChild(head); card.appendChild(lead); card.appendChild(list); card.appendChild(pre); card.appendChild(acts);
    wrap.appendChild(card);
    doc.body.appendChild(wrap);
    return wrap;
  }

  /* The page's own verdict, for the desktop shell (header 5) and the WebKit floor job (scripts/qa/webkit-floor-boot.mjs). */
  function verdict() {
    const a = state.accounting;
    return {
      checked: state.checked, verdict: bootVerdict(), listed: !!(a && a.listed),
      total: a ? a.total : null, ran: a ? a.ran : null, seen: a ? a.seen : 0,
      notRun: notRunNow().map(n => Object.assign({}, n)), missing: state.missing.map(m => m.name),
      belowFloor: belowFloor(), floorMissing: floorMissing(), floor: FLOOR.safari, fatal: state.fired
    };
  }
  /* ONCE per page load, to the desktop shell: counts, station paths, error type names and line numbers — nothing a
     message could carry. boot_report.rs sanitizes it again and writes one "page-boot:" line to startup.log. No shell
     (a browser, the website demo) sends nothing; an older shell has no such command and its rejection is swallowed. */
  function sendReport() {
    if (state.reported) return;
    state.reported = true;
    try {
      const t = root.__TAURI__, core = t && t.core;
      if (!core || typeof core.invoke !== 'function') return;
      const a = state.accounting || account();
      const report = {
        total: a.listed ? a.total : 0,
        ran: a.listed ? a.ran : 0,
        notRun: a.notRun.slice(0, SENT_NOT_RUN).map(n => n.why === 'threw' ? { file: n.file, why: 'threw', kind: n.kind, line: n.line } : { file: n.file, why: n.why }),
        missing: state.missing.slice(0, 32).map(m => m.name),
        belowFloor: belowFloor()
      };
      const p = core.invoke('starnet_boot_report', { report });
      if (p && typeof p.then === 'function') p.then(null, function () {});
    } catch (_) {}
  }
  function verify() {
    try {
      state.dcl = true;
      try { account(); } catch (_) { state.accounting = null; }   // never in the way of the fatal check below
      if (check()) { sendReport(); return; }
      // a shared/ retry is still in flight: hold the banner until it loads (→ reload) or gives up (→ render).
      if (state.retry.pending && !state.retry.exhausted) { state.retry.deferred = true; return; }
      render();
      sendReport();
    } catch (_) {}
  }
  function arm() {
    const doc = root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', verify);
    else verify();
  }

  const installed = install();
  arm();

  return {
    state: () => state,
    installed, verdict, summaryLine, report, check, render, verify,
    PROBES: PROBES.map(p => ({ name: p[0], file: p[1] })),
    FLOOR, FLOOR_PROBES: FLOOR_PROBES.map(p => p[0]),
    _internals: { belowFloor, floorMissing, account, onError, onLoad, onRejection, shortPath, isStationScript, isSharedScript, reasonText, errorKind, PROBES, RETRY_WAITS, RELOAD_MAX, SENT_NOT_RUN }
  };
});
