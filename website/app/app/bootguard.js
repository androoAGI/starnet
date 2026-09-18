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
        wrap the catalog bind to the real data. app/ and js/ scripts ship inside the bundle and never retry.

   Exposes `window.BootGuard`: state(), summaryLine(), report(), check(), render(). Node-requirable for tests. */
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
    errors: [], rejected: [], scripts: [],
    missing: [], checked: false, fired: false, startedAt: Date.now(),
    // shared/ catalog retry ledger — see header (4). attempts counts retries scheduled since page load;
    // pending is the retry currently in flight (verify() defers the banner while one is); recovered marks a
    // retry that loaded, after which the page reloads once so every dependent module binds the real catalog.
    retry: { attempts: 0, pending: 0, recovered: 0, exhausted: false, deferred: false, src: '', reloads: 0 }
  };
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
  function reasonText(r) {
    if (r == null) return 'unhandled rejection (no reason)';
    if (typeof r === 'object') return String(r.message || r.reason || r.name || (function () { try { return JSON.stringify(r); } catch (_) { return '[object]'; } })());
    return String(r);
  }

  /* ---- 1. the listeners ---- */
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
          if (isSharedScript(src) && canRetry()) scheduleRetry(src);
        }
        return;
      }
      state.uncaught++;
      push(state.errors, (e && e.message ? e.message : 'error') + ' @ ' + shortPath(e && e.filename) + (e && e.lineno ? ':' + e.lineno : ''));
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

  /* ---- 3. the report + the banner ---- */
  function summaryLine() {
    const parts = [];
    if (state.scriptFailures) parts.push(state.scriptFailures + ' script load failure(s): ' + state.scripts.join(', '));
    if (state.missing.length) parts.push(state.missing.length + ' missing module(s): ' + state.missing.map(m => m.name).join(', '));
    if (state.uncaught) parts.push(state.uncaught + ' uncaught error(s)');
    if (state.rejections) parts.push(state.rejections + ' unhandled rejection(s)');
    return parts.length ? parts.join(' · ') : 'none recorded since page load';
  }
  function report() {
    const L = [];
    L.push('STARNET BOOT GUARD (page-side — measured by the app window itself)');
    L.push('when:           ' + new Date().toISOString());
    L.push('page:           ' + String((root.location && root.location.pathname) || '/'));
    L.push('boot check:     ' + (!state.checked ? 'not run yet' : (state.missing.length || state.scriptFailures) ? 'FAILED' : 'passed'));
    if (state.missing.length) L.push('missing:        ' + state.missing.map(m => m.name + ' (' + m.file + ')').join(', '));
    if (state.scripts.length) L.push('scripts failed: ' + state.scripts.join(', '));
    if (state.retry.attempts) L.push('shared retry:   ' + state.retry.attempts + ' attempt(s) for ' + state.retry.src + (state.retry.recovered ? ' — recovered (reloaded ' + state.retry.reloads + '×)' : state.retry.exhausted ? ' — script load retries exhausted' : ' — in progress'));
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

    const wrap = doc.createElement('div');
    wrap.id = 'bootguard-fatal'; wrap.className = 'bgf'; wrap.setAttribute('role', 'alert');
    // inline essentials so the banner is visible even if app.css itself failed to arrive
    wrap.style.cssText = 'position:fixed;inset:0;z-index:900;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.88);font-family:VT323,monospace;';

    const card = doc.createElement('div'); card.className = 'bgf-card';
    const head = doc.createElement('div'); head.className = 'bgf-head';
    head.textContent = '▮ STATION FAILED TO BOOT';
    const lead = doc.createElement('div'); lead.className = 'bgf-lead';
    lead.textContent = 'the app window loaded, but a required module did not. this is a broken or blocked file, not your station — your saved station has not been changed by this screen.';
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
    acts.appendChild(copyBtn); acts.appendChild(reloadBtn);
    card.appendChild(head); card.appendChild(lead); card.appendChild(list); card.appendChild(pre); card.appendChild(acts);
    wrap.appendChild(card);
    doc.body.appendChild(wrap);
    return wrap;
  }

  function verify() {
    try {
      if (check()) return;
      // a shared/ retry is still in flight: hold the banner until it loads (→ reload) or gives up (→ render).
      if (state.retry.pending && !state.retry.exhausted) { state.retry.deferred = true; return; }
      render();
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
    installed, summaryLine, report, check, render, verify,
    PROBES: PROBES.map(p => ({ name: p[0], file: p[1] })),
    _internals: { onError, onRejection, shortPath, isStationScript, isSharedScript, reasonText, PROBES, RETRY_WAITS, RELOAD_MAX }
  };
});
