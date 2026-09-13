/* sidecar/tools/builtin/browser.js - browser automation tools.
   A small CDP-backed browser surface with an injected-driver seam for tests:
   navigate, snapshot, click, type, scroll, back, press, console, dialog,
   get_text, and vision. Element refs are valid only until the next snapshot.

   SECURITY: browser.navigate refuses private/loopback/intranet URLs before
   navigation and validates the final URL after redirects. Mutating actions are
   consent-gated by the same registry/capability path as every other tool. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).browser = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const P = require('node:path');
  const OS = require('node:os');
  const FS = require('node:fs');
  const CP = require('node:child_process');
  const NET = require('node:net');
  const { swallow } = require('../../failopen.js');
  const Challenge = require('./browserchallenge.js');
  const { deriveReadClient } = require('./browser-workflow.js');
  // UNTRUSTED-CONTENT FENCE (2026-07-25): page text, snapshots, console rows and dialog messages are all
  // authored by the SITE, not the Commander. web_* has fenced since the web lane; these reads did not, so
  // the most direct "read a hostile page" path arrived raw. Same marker pair as web — one model contract.
  const { fenceExternal } = require('../fence.js');

  const MAX_TEXT = 12000;
  /* AUTO-WAIT (2026-07-25). The whole wait vocabulary used to be three fixed sleeps — navigate 900ms,
     back 500ms, connect-retry 250ms — and click/type/press returned with ZERO settle time. So the
     snapshot after a click read the PRE-CLICK DOM, and any SPA that hydrated past 900ms answered an
     empty page, which the agent reported as "no interactive elements". A fixed sleep is wrong in both
     directions: too short for a slow app, wasted latency on a static one.
     Instead the page tells us when it went quiet. A MutationObserver counts DOM changes; we poll that
     counter and proceed as soon as readyState is complete AND the count has held still across
     SETTLE_QUIET_POLLS polls, giving up at a budget. A static page now settles in ~1 poll (FASTER than
     the old 900ms blind wait) and a slow SPA gets the time it actually needs.
     The page keeps a mutation COUNTER, never a timestamp: the determinism law bans ambient time in
     backend logic, and a counter is the better primitive anyway — the sidecar owns the notion of
     "quiet" (counter unchanged across N consecutive polls) and the page just reports what happened. */
  const SETTLE_POLL_MS = 40;
  const SETTLE_QUIET_POLLS = 3;         // consecutive unchanged polls (~120ms) before we call it settled
  const SETTLE_NAV_BUDGET_MS = 8000;    // ceiling for a navigation/history move
  const SETTLE_ACTION_BUDGET_MS = 3000; // ceiling after click/type/press/scroll
  // Paid ONLY when a snapshot came back empty — see the re-read note in snapshot().
  const SETTLE_EMPTY_GRACE_MS = 1500;
  const SNAP_DEFAULT = 80;              // node cap shared by browser.snapshot and stale-ref recovery
  // browser.find scans at the driver's own ceiling (collectNodes clamps to 200) and then filters, so a
  // match on a dense page is found rather than lost past the default cap.
  const FIND_SCAN_CAP = 200;
  /* browser.wait budget. Every ACTION already auto-settles (waitForSettle), so this is not "wait for the
     page to calm down" — it is "wait for a CONDITION the agent can name": a spinner to clear, a result row
     to appear, a redirect to land. Capped because an agent that can ask for an unbounded wait will
     eventually spend a whole run budget sitting on a condition that is never going to be true. */
  const WAIT_DEFAULT_MS = 10000;
  const WAIT_MAX_MS = 30000;
  const WAIT_POLL_MS = 150;
  // A click that starts a download waits for Chromium's terminal download event, but stays below the
  // browser.click tool budget. Ordinary clicks pay none of this budget because we only wait after a
  // Browser.downloadWillBegin event has actually arrived.
  const DOWNLOAD_WAIT_MS = 10000;
  // browser.intercept's vocabulary → CDP resource types. Module-scoped because BOTH layers need it:
  // the session validates the agent's kinds (so a bad kind fails loudly on any driver, including an
  // injected test one) and the driver maps them onto Fetch.enable patterns.
  const INTERCEPT_TYPES = { image: 'Image', media: 'Media', font: 'Font', stylesheet: 'Stylesheet' };
  /* A MINIMUM observation window before quiescence may be declared. DOM quiescence cannot see the
     future: a click handler that renders from a setTimeout leaves the page genuinely still in the
     meantime, so a pure quiet check returns before the work lands. Watching for at least this long
     catches the ordinary handler/animation-frame delay while still being adaptive - a slow page
     keeps waiting well past it, unlike the fixed sleeps this replaced. */
  const SETTLE_MIN_OBSERVE_MS = 400;
  const SETTLE_BOOTSTRAP_TEMPLATE = String.raw`(() => {
    const SLOT = __STARNET_SETTLE_SLOT__;
    if (globalThis[SLOT]) return;
    const s = { n: 0 };
    try { Object.defineProperty(globalThis, SLOT, { value: s, configurable: false, writable: false }); } catch (e) { return; }
    const bump = () => { s.n++; };
    const observe = () => {
      try { new MutationObserver(bump).observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, characterData: true }); } catch (e) {}
    };
    // addScriptToEvaluateOnNewDocument runs before <html> exists, so defer until there is a root.
    try { if (document.documentElement) observe(); else document.addEventListener('readystatechange', observe, { once: true }); } catch (e) {}
    // A resource landing (or a history move) is a change even when it mutates no nodes.
    try { addEventListener('load', bump); addEventListener('popstate', bump); } catch (e) {}
  })()`;
  // Cheap per-poll read: is the document done, and how many mutations has it seen so far?
  const SETTLE_PROBE_TEMPLATE = `(() => { const s = globalThis[__STARNET_SETTLE_SLOT__];
    return { ok: !!s, ready: document.readyState, n: s ? s.n : -1 }; })()`;
  function settleSource(slot) { return SETTLE_BOOTSTRAP_TEMPLATE.replace('__STARNET_SETTLE_SLOT__', JSON.stringify(slot)); }
  function settleProbeSource(slot) { return SETTLE_PROBE_TEMPLATE.replace('__STARNET_SETTLE_SLOT__', JSON.stringify(slot)); }
  const SETTLE_BOOTSTRAP = settleSource('__STARNET_SETTLE__');
  const SETTLE_PROBE = settleProbeSource('__STARNET_SETTLE__');
  const DEFAULT_PORT = Number(process.env.STARNET_BROWSER_CDP || process.env.SKYNET_BROWSER_CDP || 9347);

  /* DOWNLOAD RECEIPTS. Browser.setDownloadBehavior already put bytes in the agent jail, but click()
     returned only "clicked". That made a successful Google Drive export observationally identical to a
     button that did nothing, so an agent kept inspecting the same page. This ledger turns Chromium's
     browser-scoped download events into a receipt only when the named file also exists on disk.

     The suggested filename is page/server metadata. Keep only its basename (no traversal) and fence it
     when it is shown to the model; the trusted host claim is merely that the verified path exists. */
  function makeDownloadLedger(downloadDir) {
    const root = downloadDir ? P.resolve(downloadDir) : '';
    const records = new Map();
    const waiters = new Set();
    let sequence = 0;

    function wake() {
      for (const fn of Array.from(waiters)) { try { fn(); } catch (_) {} }
      waiters.clear();
    }
    function cursor() { return sequence; }
    function begin(event) {
      event = event || {};
      const guid = String(event.guid || 'download-' + (sequence + 1));
      const raw = String(event.suggestedFilename || 'download');
      const filename = P.basename(raw) || 'download';
      const record = {
        guid, sequence: ++sequence, filename, state: 'inProgress',
        receivedBytes: 0, totalBytes: 0
      };
      records.set(guid, record);
      wake();
      return Object.assign({}, record);
    }
    function progress(event) {
      event = event || {};
      const record = records.get(String(event.guid || ''));
      if (!record) return null;
      if (event.state) record.state = String(event.state);
      if (Number.isFinite(Number(event.receivedBytes))) record.receivedBytes = Math.max(0, Number(event.receivedBytes));
      if (Number.isFinite(Number(event.totalBytes))) record.totalBytes = Math.max(0, Number(event.totalBytes));
      wake();
      return Object.assign({}, record);
    }
    function startedAfter(after) {
      let found = null;
      for (const record of records.values()) {
        if (record.sequence > Number(after || 0) && (!found || record.sequence < found.sequence)) found = record;
      }
      return found;
    }
    function verify(record) {
      if (!record) return null;
      if (record.state === 'canceled') return { status: 'canceled' };
      if (record.state !== 'completed') return { status: 'started' };
      if (!root) return { status: 'unverified' };
      const absolute = P.resolve(root, record.filename);
      const inside = absolute === root || absolute.startsWith(root + P.sep);
      if (!inside) return { status: 'unverified' };
      try {
        const stat = FS.statSync(absolute);
        if (!stat.isFile()) return { status: 'unverified' };
        return {
          status: 'completed', absolute, relative: 'downloads/' + record.filename.replace(/\\/g, '/'),
          filename: record.filename, bytes: stat.size
        };
      } catch (_) { return { status: 'unverified' }; }
    }
    async function waitAfter(after, budgetMs) {
      const record = startedAfter(after);
      if (!record) return null;
      const budget = Math.max(0, Number(budgetMs) || 0);
      let expired = false;
      let timer = null;
      if (budget > 0) timer = setTimeout(() => { expired = true; wake(); }, budget);
      try {
        for (;;) {
          const receipt = verify(record);
          if (receipt.status !== 'started' || expired || budget === 0) return receipt;
          await new Promise(resolve => waiters.add(resolve));
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return { cursor, begin, progress, startedAfter, waitAfter, _records: records };
  }
  // Installed Chrome's "new" headless mode can still enter the platform pointer-lock path after
  // a CDP click. On Windows that path calls ClipCursor and moves the REAL cursor. Install this
  // bootstrap before every navigation so game code observes a faithful logical lock while the
  // browser never reaches native pointer/keyboard lock. CDP Input.* remains fully synthetic.
  const SYNTHETIC_INPUT_TEMPLATE = String.raw`(() => {
    const SLOT = __STARNET_INPUT_SLOT__;
    if (globalThis[SLOT]) return;
    const ALLOW_POPUPS = __STARNET_ALLOW_POPUPS__;
    const state = { pointer: null, fullscreen: null, keyboard: false, ready: false, popupBlocked: false, error: null };
    let request = null, exit = null, fullscreenRequest = null, fullscreenExit = null, blockedOpen = null, keyboardLock = null, keyboardUnlock = null, wakeRequest = null, orientationLock = null, orientationUnlock = null;
    const attestation = {};
    Object.defineProperties(attestation, {
      allowPopups: { get: () => ALLOW_POPUPS },
      pointer: { get: () => state.pointer },
      fullscreen: { get: () => state.fullscreen },
      ready: { get: () => state.ready },
      popupBlocked: { get: () => state.popupBlocked },
      error: { get: () => state.error },
      requestPointerLock: { get: () => request },
      exitPointerLock: { get: () => exit },
      requestFullscreen: { get: () => fullscreenRequest },
      exitFullscreen: { get: () => fullscreenExit },
      blockedOpen: { get: () => blockedOpen },
      keyboardLock: { get: () => keyboardLock },
      keyboardUnlock: { get: () => keyboardUnlock },
      wakeRequest: { get: () => wakeRequest },
      orientationLock: { get: () => orientationLock },
      orientationUnlock: { get: () => orientationUnlock }
    });
    Object.freeze(attestation);
    Object.defineProperty(globalThis, SLOT, { value: attestation, configurable: false, writable: false });
    const fire = (name) => queueMicrotask(() => document.dispatchEvent(new Event(name)));
    try {
      request = function () { state.pointer = this; fire('pointerlockchange'); return Promise.resolve(); };
      exit = function () { state.pointer = null; fire('pointerlockchange'); };
      Object.defineProperty(Document.prototype, 'pointerLockElement', { configurable: false, get() { return state.pointer; } });
      Object.defineProperty(Element.prototype, 'requestPointerLock', { configurable: false, writable: false, value: request });
      Object.defineProperty(Document.prototype, 'exitPointerLock', { configurable: false, writable: false, value: exit });
      for (const name of ['webkitRequestPointerLock','mozRequestPointerLock']) {
        if (name in Element.prototype) Object.defineProperty(Element.prototype, name, { configurable: false, writable: false, value: request });
      }
      for (const name of ['webkitExitPointerLock','mozExitPointerLock']) {
        if (name in Document.prototype) Object.defineProperty(Document.prototype, name, { configurable: false, writable: false, value: exit });
      }
      for (const name of ['webkitPointerLockElement','mozPointerLockElement']) {
        if (name in Document.prototype) Object.defineProperty(Document.prototype, name, { configurable: false, get() { return state.pointer; } });
      }
      fullscreenRequest = function () { state.fullscreen = this; fire('fullscreenchange'); return Promise.resolve(); };
      fullscreenExit = function () { state.fullscreen = null; fire('fullscreenchange'); return Promise.resolve(); };
      Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: false, get() { return state.fullscreen; } });
      Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: false, writable: false, value: fullscreenRequest });
      Object.defineProperty(Document.prototype, 'exitFullscreen', { configurable: false, writable: false, value: fullscreenExit });
      for (const name of ['webkitRequestFullscreen','webkitRequestFullScreen','mozRequestFullScreen','msRequestFullscreen']) {
        if (name in Element.prototype) Object.defineProperty(Element.prototype, name, { configurable: false, writable: false, value: fullscreenRequest });
      }
      for (const name of ['webkitExitFullscreen','webkitCancelFullScreen','mozCancelFullScreen','msExitFullscreen']) {
        if (name in Document.prototype) Object.defineProperty(Document.prototype, name, { configurable: false, writable: false, value: fullscreenExit });
      }
      if (navigator.keyboard) {
        keyboardLock = async function () { state.keyboard = true; return undefined; };
        keyboardUnlock = function () { state.keyboard = false; };
        Object.defineProperty(navigator.keyboard, 'lock', { configurable: false, writable: false, value: keyboardLock });
        Object.defineProperty(navigator.keyboard, 'unlock', { configurable: false, writable: false, value: keyboardUnlock });
      }
      if (navigator.wakeLock) {
        wakeRequest = async function (type) {
          let released = false;
          return Object.freeze({ type: String(type || 'screen'), get released() { return released; }, async release() { released = true; }, addEventListener() {}, removeEventListener() {} });
        };
        Object.defineProperty(navigator.wakeLock, 'request', { configurable: false, writable: false, value: wakeRequest });
      }
      if (globalThis.screen && screen.orientation) {
        orientationLock = async function () { return undefined; };
        orientationUnlock = function () {};
        Object.defineProperty(screen.orientation, 'lock', { configurable: false, writable: false, value: orientationLock });
        Object.defineProperty(screen.orientation, 'unlock', { configurable: false, writable: false, value: orientationUnlock });
      }
      /* A popup is a new CDP target and does NOT inherit a target-scoped preload, so it could run
         unshimmed script and reach native pointer/keyboard locks. There are exactly two safe answers:
         (a) block it here, or (b) pause every new page target before its first statement, inject the
         same shim, and only then resume it. (b) is strictly better - it keeps _blank checkouts, SSO
         popups and PDFs reachable - but it depends on browser-level auto-attach being armed, which is
         a DRIVER fact this page cannot verify. So the driver decides and bakes the answer in here;
         when it could not arm adoption it passes false and we fall back to blocking. Fail closed. */
      if (!ALLOW_POPUPS) {
        blockedOpen = function () { return null; };
        Object.defineProperty(globalThis, 'open', { configurable: false, writable: false, value: blockedOpen });
      }
      const escapesTarget = (el, override) => {
        const base=document.querySelector&&document.querySelector('base[target]');
        const t=String(override||el&&el.target||base&&base.target||'').trim().toLowerCase();
        return !!t && t !== '_self' && t !== '_top' && t !== '_parent';
      };
      globalThis.addEventListener('click', e => {
        const p=typeof e.composedPath==='function'?e.composedPath():[];
        const el=p.find(x => x instanceof HTMLAnchorElement || x instanceof HTMLAreaElement);
        if(escapesTarget(el)){e.preventDefault();e.stopImmediatePropagation();}
      }, true);
      globalThis.addEventListener('submit', e => {
        const ft=e.submitter&&(e.submitter.formTarget||e.submitter.getAttribute&&e.submitter.getAttribute('formtarget'));
        if(escapesTarget(e.target,ft)){e.preventDefault();e.stopImmediatePropagation();}
      }, true);
      if (globalThis.HTMLFormElement) {
        const nativeSubmit=HTMLFormElement.prototype.submit;
        Object.defineProperty(HTMLFormElement.prototype,'submit',{configurable:false,writable:false,value:function(){
          if(escapesTarget(this)) return undefined;
          return nativeSubmit.call(this);
        }});
      }
      // When popups are ADOPTED the block is deliberately absent, so it cannot gate readiness.
      // The guarantee moved to the driver: no page target resumes before it is shimmed.
      state.popupBlocked = ALLOW_POPUPS ? false : (globalThis.open === blockedOpen);
      const popupOk = ALLOW_POPUPS || state.popupBlocked;
      const aliasesReady = ['webkitRequestPointerLock','mozRequestPointerLock'].every(n => !(n in Element.prototype) || Element.prototype[n] === request)
        && ['webkitExitPointerLock','mozExitPointerLock'].every(n => !(n in Document.prototype) || Document.prototype[n] === exit);
      const keyboardReady = !navigator.keyboard || (navigator.keyboard.lock === keyboardLock && navigator.keyboard.unlock === keyboardUnlock);
      const fullscreenReady = Element.prototype.requestFullscreen === fullscreenRequest && Document.prototype.exitFullscreen === fullscreenExit;
      const wakeReady = !navigator.wakeLock || navigator.wakeLock.request === wakeRequest;
      const orientationReady = !globalThis.screen || !screen.orientation || (screen.orientation.lock === orientationLock && screen.orientation.unlock === orientationUnlock);
      state.ready = Element.prototype.requestPointerLock === request && Document.prototype.exitPointerLock === exit && aliasesReady && fullscreenReady && keyboardReady && wakeReady && orientationReady && popupOk;
      if (!state.ready) throw new Error('user-control override did not stick');
    } catch (e) {
      state.ready = false;
      state.error = String(e && e.message || e || 'bootstrap failed');
    }
  })();`;
  // Environment-level headless selection. Production runOnce additionally passes forceHeadless,
  // so neither model arguments nor desktop-shell presence can create a window there.
  /* The bootstrap above is a TEMPLATE: __STARNET_ALLOW_POPUPS__ is substituted per run. The exported
     constant keeps the fail-closed (popups blocked) form, which is also what every rig that installs
     the raw string gets. */
  function syntheticInputSource(allowPopups, slot) {
    return SYNTHETIC_INPUT_TEMPLATE
      .replace('__STARNET_ALLOW_POPUPS__', allowPopups === true ? 'true' : 'false')
      .replace('__STARNET_INPUT_SLOT__', JSON.stringify(slot || '__STARNET_SYNTHETIC_INPUT__'));
  }
  const SYNTHETIC_INPUT_BOOTSTRAP = syntheticInputSource(false);

  function internalMarker(seed, purpose) {
    let n = 2166136261;
    for (const ch of String(seed || '') + ':' + String(purpose || '')) {
      n ^= ch.charCodeAt(0); n = Math.imul(n, 16777619) >>> 0;
    }
    return '__' + n.toString(16).padStart(8, '0');
  }

  function headlessRequested(env) {
    env = env || process.env;
    return /^(1|true|yes|on)$/i.test(String(env.STARNET_BROWSER_HEADLESS || env.SKYNET_BROWSER_HEADLESS || ''));
  }
  function playwrightChromes() {
    // ms-playwright caches live under per-user app data with a versioned dir name;
    // scan for them instead of pinning any machine-specific path or revision.
    // Each candidate is tagged headless:true when it is a chrome-headless-shell build
    // (those CANNOT run headed — a headed launch must skip them).
    const roots = [];
    if (process.env.LOCALAPPDATA) roots.push(P.join(process.env.LOCALAPPDATA, 'ms-playwright'));
    roots.push(P.join(OS.homedir(), '.cache', 'ms-playwright'));
    roots.push(P.join(OS.homedir(), 'Library', 'Caches', 'ms-playwright'));
    const out = [];
    for (const root of roots) {
      let dirs = [];
      try { dirs = FS.readdirSync(root); } catch (_) { continue; }
      for (const d of dirs.sort().reverse()) {
        if (/^chromium_headless_shell-\d+$/.test(d)) {
          out.push({ path: P.join(root, d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'), headless: true });
          out.push({ path: P.join(root, d, 'chrome-headless-shell-linux', 'headless_shell'), headless: true });
        } else if (/^chromium-\d+$/.test(d)) {
          out.push({ path: P.join(root, d, 'chrome-win64', 'chrome.exe'), headless: false });
          out.push({ path: P.join(root, d, 'chrome-linux', 'chrome'), headless: false });
          out.push({ path: P.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'), headless: false });
        }
      }
    }
    return out;
  }
  // Candidate list, each tagged whether it is a headless-only binary. Env overrides and
  // real installed browsers are full Chrome (can run headed or headless).
  const CHROME_CANDIDATES = [
    process.env.STARNET_CHROME && { path: process.env.STARNET_CHROME, headless: false },
    process.env.SKYNET_CHROME && { path: process.env.SKYNET_CHROME, headless: false },
    ...playwrightChromes(),
    { path: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: false },
    { path: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: false },
    process.env.LOCALAPPDATA && { path: P.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'), headless: false },
    { path: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', headless: false },
    { path: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: false },
    process.env.LOCALAPPDATA && { path: P.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), headless: false },
    { path: '/usr/bin/google-chrome', headless: false },
    { path: '/usr/bin/chromium-browser', headless: false },
    { path: '/usr/bin/chromium', headless: false },
    { path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false }
  ].filter(Boolean);

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  function normalizeBrowserLocale(value) {
    const raw = String(value || '').trim().replace(/_/g, '-');
    return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(raw) ? raw : 'en-US';
  }
  function hostBrowserLocale(deps) {
    if (deps && deps.locale) return normalizeBrowserLocale(deps.locale);
    try { return normalizeBrowserLocale(Intl.DateTimeFormat().resolvedOptions().locale); }
    catch (_) { return 'en-US'; }
  }
  function detectBrowserVersion(chromePath, deps) {
    const injected = String(deps && deps.browserVersion || '').trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(injected)) return injected;
    const run = deps && deps.spawnSync || CP.spawnSync;
    try {
      const out = run(chromePath, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
      const text = String(out && (out.stdout || out.stderr) || '');
      const hit = text.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (hit) return hit[1];
    } catch (_) {}
    // GUI Chrome on Windows commonly detaches without writing `--version` to stdout. FileVersion is
    // the same installed-binary fact and does not require launching a browser window.
    if (String(deps && deps.platform || process.platform) === 'win32' && chromePath) {
      try {
        const ps = deps && deps.powerShellPath || 'powershell.exe';
        const literal = String(chromePath).replace(/'/g, "''");
        const out = run(ps, ['-NoProfile', '-NonInteractive', '-Command',
          "(Get-Item -LiteralPath '" + literal + "').VersionInfo.ProductVersion"],
        { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        const hit = String(out && (out.stdout || out.stderr) || '').match(/(\d+\.\d+\.\d+\.\d+)/);
        if (hit) return hit[1];
      } catch (_) {}
    }
    return '';
  }
  function makeLaunchIdentity(chromePath, deps) {
    deps = deps || {};
    const locale = hostBrowserLocale(deps);
    const version = detectBrowserVersion(chromePath, deps);
    if (!version) return { locale, version: '', userAgent: '' };
    const platform = String(deps.platform || process.platform);
    const arch = String(deps.arch || process.arch);
    let osToken = 'X11; Linux ' + (arch === 'arm64' ? 'aarch64' : 'x86_64');
    if (platform === 'win32') osToken = 'Windows NT 10.0; Win64; x64';
    else if (platform === 'darwin') osToken = 'Macintosh; Intel Mac OS X 10_15_7';
    return {
      locale, version,
      userAgent: 'Mozilla/5.0 (' + osToken + ') AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + version + ' Safari/537.36'
    };
  }

  function browserVersionFrom(value) {
    const hit = String(value || '').match(/(?:Headless)?Chrome\/(\d+\.\d+\.\d+\.\d+)|\b(\d+\.\d+\.\d+\.\d+)\b/);
    return hit ? (hit[1] || hit[2]) : '';
  }
  function cleanBrandRows(rows, version, full) {
    const major = String(version || '').split('.')[0];
    const out = [], seen = new Set();
    for (const row of (Array.isArray(rows) ? rows : [])) {
      let brand = String(row && row.brand || '');
      if (!brand) continue;
      if (/headlesschrome/i.test(brand)) brand = 'Chromium';
      if (seen.has(brand)) continue;
      seen.add(brand);
      out.push({ brand, version: brand === 'Chromium' ? (full ? version : major) : String(row.version || '') });
    }
    if (!seen.has('Chromium')) out.unshift({ brand: 'Chromium', version: full ? version : major });
    return out;
  }
  /* Build one CDP-owned identity from the browser's OWN pre-navigation Client Hints, changing only
     the headless product label and matching the UA version. This avoids the worse failure modes of
     hand-invented fingerprint tables: blank high-entropy hints, a Windows UA paired with Linux hints,
     or a Chrome/149 UA paired with HeadlessChrome/149 brands. */
  function makeCdpIdentity(browserInfo, natural, deps) {
    natural = natural || {};
    const hints = natural.hints || {};
    const version = browserVersionFrom(browserInfo && (browserInfo.product || browserInfo.userAgent)) ||
      browserVersionFrom(natural.ua) || detectBrowserVersion(deps && deps.chromePath, deps);
    if (!version) return null;
    const launch = makeLaunchIdentity(deps && deps.chromePath || '', Object.assign({}, deps, { browserVersion: version }));
    const nativeUa = String(natural.ua || '');
    // Preserve the browser family and its native OS token (notably Edge's trailing Edg/* token);
    // replace only Chromium's headless product component with the connected engine version.
    const userAgent = /(?:HeadlessChrome|Chrome)\/\d+(?:\.\d+){0,3}/.test(nativeUa)
      ? nativeUa.replace(/(?:HeadlessChrome|Chrome)\/\d+(?:\.\d+){0,3}/, 'Chrome/' + version)
      : launch.userAgent;
    return {
      userAgent,
      platform: natural.platform || (String(deps && deps.platform || process.platform) === 'win32' ? 'Win32' : ''),
      userAgentMetadata: {
        brands: cleanBrandRows(hints.brands, version, false),
        fullVersionList: cleanBrandRows(hints.fullVersionList, version, true),
        fullVersion: version,
        platform: String(hints.platform || ''),
        platformVersion: String(hints.platformVersion || ''),
        architecture: String(hints.architecture || ''),
        model: String(hints.model || ''),
        mobile: hints.mobile === true,
        bitness: String(hints.bitness || ''),
        wow64: hints.wow64 === true
      }
    };
  }

  /* A private, per-run CDP endpoint plus an explicit automation-signal override.
     `--remote-debugging-port=0` asks Chromium to pick the port, but Chromium's
     content/child/runtime_features.cc special-cases port 0 and calls
     WebRuntimeFeatures::EnableAutomationControlled(true). A non-zero private port avoids that
     specific trigger and prevents cross-run attachment, but the real-browser gauntlet proved current
     headless Chromium can still expose navigator.webdriver. Station-launched browsers therefore also
     disable the AutomationControlled Blink feature. Attached Commander-owned Chrome is never launched
     or modified here. We allocate the private endpoint ourselves: bind 127.0.0.1:0, keep whatever the
     OS hands us, release it, and pass that number to Chromium. */
  function allocateEphemeralPort() {
    return new Promise((resolve, reject) => {
      let srv;
      try { srv = NET.createServer(); } catch (e) { reject(e); return; }
      srv.unref();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = addr && addr.port;
        srv.close(() => {
          if (Number.isInteger(port) && port > 0 && port < 65536) resolve(port);
          else reject(new Error('could not allocate a private CDP port'));
        });
      });
    });
  }
  function clamp(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n).trimEnd() + ' ...' : s; }
  /* Embed an agent-supplied VALUE in a fixed page expression as a string literal. JSON.stringify covers
     quotes/backslashes/control chars; U+2028 and U+2029 are legal in JSON but were line terminators in
     JS before ES2019, so they are escaped explicitly rather than trusted to the engine's edition. */
  function jsLiteral(v) {
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    return JSON.stringify(String(v == null ? '' : v)).split(LS).join('\\u2028').split(PS).join('\\u2029');
  }
  /* Render the main document's real HTTP outcome for the agent. A non-2xx is NOT an error the tool
     throws on — the page may still be worth reading — but the agent must be told, or it will report an
     error page's contents as the answer. A driver that cannot observe the network says nothing. */
  function describeResponse(r) {
    if (!r) return { text: '', summary: '' };
    if (r.failure) return { text: ' — REQUEST FAILED (' + r.failure + ')', summary: ' (failed)' };
    const code = Number(r.status) || 0;
    if (!code) return { text: '', summary: '' };
    if (code >= 200 && code < 300) return { text: ' (HTTP ' + code + ')', summary: ' ' + code };
    return { text: ' — HTTP ' + code + (r.statusText ? ' ' + r.statusText : '') +
             ' (the page below is the server\'s error response, not the content you asked for)', summary: ' ' + code };
  }
  /* The host, normalized for COMPARISON. Two normalizations matter and both were missing:
     · lowercase + IPv6 bracket strip (as before).
     · TRAILING DOTS. `http://localhost./` is the FQDN-root spelling of `localhost` and every resolver
       treats them as the same name — but WHATWG only strips the dot for IP literals, so the name kept it
       and `h === 'localhost'`, `h.endsWith('.local')`, and the single-label `bareName` rule ALL missed.
       Every name-based rule in assertSafeUrl was therefore one keystroke from being bypassed
       (`localhost.`, `svc.internal.`, `router.lan.`, `wiki.` all reached the network). Strip the root
       label here so the one comparison helper is right for every caller. */
  function hostOf(u) {
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1);
    else h = h.replace(/\.+$/, '');
    return h;
  }
  function isPrivateV4(h) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;
    const a = p[0], b = p[1];
    return a === 0 || a === 127 || a === 10 ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  function isPrivateV6(h) {
    h = String(h).toLowerCase();
    return h === '::1' || h === '::' || /^::ffff:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || /^f[cd][0-9a-f]{2}:/.test(h);
  }
  function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http(s) URLs are allowed');
    const h = hostOf(u);
    const numericHost = /^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);
    const blockedName = h === 'localhost' || h === '0.0.0.0' || h.endsWith('.localhost') || h.endsWith('.local') ||
      h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.intranet') || h.endsWith('.home') || h.endsWith('.corp');
    const bareName = h.indexOf('.') < 0 && h.indexOf(':') < 0 && !numericHost;
    if (blockedName || bareName || numericHost || isPrivateV4(h) || isPrivateV6(h)) {
      throw new Error('refusing to navigate to private/loopback/intranet host: ' + h);
    }
    return u;
  }
  /* DNS-REBINDING GUARD — the half assertSafeUrl structurally cannot do. Name rules only ever see the
     STRING; a public name that RESOLVES to 127.0.0.1 / RFC-1918 (nip.io, localtest.me, or simply an
     attacker-controlled A record) walked straight through them. web_fetch has resolved every hop since the
     web lane (web.js assertResolvedSafe); browser.navigate — the tool that then RUNS the page's scripts —
     did not, so the weaker guard sat in front of the more capable tool.
     Injectable + best-effort, byte-identical to web.js: a resolution failure is left for the navigation to
     surface, and IP literals are already checked statically above. Pass lookup:null to disable (tests). */
  function nodeLookup(host) { const dns = require('node:dns'); return dns.promises.lookup(host, { all: true }); }
  async function assertResolvedSafe(u, lookup) {
    if (!lookup) return;
    const h = hostOf(u);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(':') >= 0) return;   // already a literal
    let addrs;
    try { addrs = await lookup(h); } catch (e) { return; }
    for (const a of (addrs || [])) {
      const ip = (a && a.address) || '';
      if (isPrivateV4(ip) || isPrivateV6(ip)) throw new Error('refusing to navigate: ' + h + ' resolves to private address ' + ip);
    }
  }
  // Separate from assertSafeUrl: public browsing retains its SSRF boundary. Only the workbench-
  // scoped browser.test_navigate tool may use this validator, and only for an agent's local dev UI.
  function assertLoopbackUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('invalid local test URL: ' + raw); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('local browser tests allow http(s) only');
    const h = hostOf(u);
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') {
      throw new Error('local browser tests are restricted to loopback (127.0.0.1/localhost/::1)');
    }
    return u;
  }
  // Resolve a Chrome binary. Always prefer a full browser: headless-shell exposes a materially
  // different browser surface (no plugins/window.chrome and HeadlessChrome Client Hints) even when
  // its legacy UA is overridden. A shell remains a compatibility fallback when no full build exists.
  // Returns { path, headless } where headless=true means a visible window is impossible.
  function resolveChrome(wantHeaded, existsSync) {
    existsSync = existsSync || FS.existsSync;
    const exists = (c) => { try { return existsSync(c.path); } catch (_) { return false; } };
    for (const c of CHROME_CANDIDATES) { if (!c.headless && exists(c)) return { path: c.path, headless: false }; }
    for (const c of CHROME_CANDIDATES) { if (c.headless && exists(c)) return { path: c.path, headless: true }; }
    return null;
  }
  // Back-compat shim (tests/other callers): return just the path of the first existing binary.
  function findChrome(existsSync) {
    const r = resolveChrome(false, existsSync);
    return r ? r.path : '';
  }

  class CdpClient {
    constructor(ws, timeoutMs) {
      this.ws = ws;
      this.timeoutMs = timeoutMs || 15000;
      this.id = 0;
      this.pending = new Map();
      this.handlers = new Map();
      ws.addEventListener('message', e => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          if (p.timer) clearTimeout(p.timer);
          m.error ? p.reject(new Error(m.error.message || 'CDP error')) : p.resolve(m.result || {});
        } else if (m.method) {
          const hs = this.handlers.get(m.method) || [];
          // The sessionId rides along as a second argument: a handler that must REPLY to an event
          // (Fetch.requestPaused) has to answer on the session the event came from, not the active one.
          for (const h of hs) { try { h(m.params || {}, m.sessionId); } catch (_) {} }
        }
      });
    }
    // `timeoutMs` overrides the client default for ONE call. Navigation needs a much larger budget than an
    // ordinary command: Page.navigate does not resolve until the navigation COMMITS, so a slow origin, a
    // redirect chain, or an anti-bot challenge can legitimately outlast a budget sized for Runtime.evaluate.
    send(method, params, sessionId, timeoutMs) {
      const id = ++this.id;
      const budget = timeoutMs || this.timeoutMs;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, budget);
        if (timer && typeof timer.unref === 'function') timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        const message = { id, method, params: params || {} };
        if (sessionId) message.sessionId = sessionId;
        this.ws.send(JSON.stringify(message));
      });
    }
    on(method, fn) {
      const hs = this.handlers.get(method) || [];
      hs.push(fn); this.handlers.set(method, hs);
    }
    close() { try { this.ws.close(); } catch (_) {} }
  }

  function makeCdpDriver(deps) {
    deps = deps || {};
    const fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const WebSocketImpl = deps.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    const spawn = deps.spawn || CP.spawn;
    // HEADLESS BY DEFAULT (2026-07-07 direction): research must never open a window on the user's screen.
    // A window appears only when the CALL asked for one (deps.headed — browser.navigate visible:true, i.e.
    // the Commander asked to watch) and no headless env pins it down (CI/soak rigs still win). Legacy
    // deps.headless===true keeps forcing headless for injected test rigs.
    const wantHeaded = deps.forceHeadless !== true && !!deps.headed && !headlessRequested(deps.env) && deps.headless !== true;
    // Resolve the binary honoring the headed preference (skip headless-shell when headed).
    let chromePath = deps.chrome || null, binIsHeadlessOnly = false;
    if (!chromePath) {
      const r = resolveChrome(wantHeaded, deps.existsSync);
      if (r) { chromePath = r.path; binIsHeadlessOnly = r.headless; }
    }
    // Production passes cdpPort 0, meaning "give this run its own private endpoint" — a
    // process-wide port can attach to another agent's browser. We honour that request by
    // allocating a NON-zero ephemeral port ourselves (see allocateEphemeralPort): literal 0
    // reaches Chromium as an automation signal and sets navigator.webdriver.
    const cdpPort = deps.cdpPort == null ? DEFAULT_PORT : Number(deps.cdpPort);
    const privatePort = cdpPort === 0;
    const profileDir = deps.profileDir || P.join(OS.tmpdir(), 'starnet-browser-' + process.pid);
    // Page-realm safety/settle state must be readable by the driver, but fixed product-named globals
    // are an avoidable signature. Opaque per-profile slots preserve the contract without publishing
    // `__STARNET_*` on every site.
    const inputMarker = internalMarker(profileDir, 'input');
    const settleMarker = internalMarker(profileDir, 'settle');
    const inputStateExpr = 'globalThis[' + JSON.stringify(inputMarker) + ']';
    const settleBootstrap = settleSource(settleMarker);
    const settleProbe = settleProbeSource(settleMarker);
    const stationMetrics = { width: 1440, height: 900, screenWidth: 1440, screenHeight: 900, deviceScaleFactor: 1, mobile: false };
    // Stale from a previous run on this profile; cleared so nothing can mistake it for live state.
    const activePortFile = P.join(profileDir, 'DevToolsActivePort');
    const timeoutMs = deps.timeoutMs || 15000;
    // Navigation is the one command whose duration is the SITE's to decide, not ours, so it gets its own
    // budget. Derived from timeoutMs (so an injected test rig scales with it) and floored well above it.
    // MUST stay comfortably under the browser.navigate TOOL budget (NAV_TOOL_TIMEOUT_MS below): if the outer
    // tool timeout fired first it would abort the run() mid-flight and the Page.stopLoading recovery would
    // never happen - leaving exactly the wedged session that change exists to prevent.
    const navTimeoutMs = deps.navTimeoutMs || Math.max(timeoutMs * 2, 30000);
    // Auto-wait thresholds are injectable so a test can drive the real settle loop (including the
    // budget-exhausted path) without burning the production ceilings in wall-clock time.
    const settleQuietPolls = deps.settleQuietPolls == null ? SETTLE_QUIET_POLLS : Number(deps.settleQuietPolls);
    const settleNavBudgetMs = deps.settleNavBudgetMs == null ? SETTLE_NAV_BUDGET_MS : Number(deps.settleNavBudgetMs);
    const settleActionBudgetMs = deps.settleActionBudgetMs == null ? SETTLE_ACTION_BUDGET_MS : Number(deps.settleActionBudgetMs);
    const settleEmptyGraceMs = deps.settleEmptyGraceMs == null ? SETTLE_EMPTY_GRACE_MS : Number(deps.settleEmptyGraceMs);
    const settleMinObserveMs = deps.settleMinObserveMs == null ? SETTLE_MIN_OBSERVE_MS : Number(deps.settleMinObserveMs);
    const downloadWaitMs = deps.downloadWaitMs == null ? DOWNLOAD_WAIT_MS : Math.max(0, Number(deps.downloadWaitMs));
    const inputSleep = typeof deps.inputSleep === 'function' ? deps.inputSleep : sleep;
    if (!fetchImpl || !WebSocketImpl) throw new Error('browser unavailable: Node WebSocket/fetch is not available');
    /* ATTACH MODE. deps.attachPort names an ALREADY-RUNNING Chrome's DevTools port (the Commander started
       it with --remote-debugging-port). We launch nothing, so we need no Chromium binary of our own — the
       missing-Chromium refusal below would be wrong here and is skipped. Everything downstream is
       identical: the same CDP driver over the same protocol. */
    const attachPort = deps.attachPort == null ? null : Number(deps.attachPort);
    if (attachPort !== null && (!Number.isInteger(attachPort) || attachPort < 1 || attachPort > 65535)) {
      throw new Error('browser attach: port must be an integer 1-65535');
    }
    if (!chromePath && attachPort === null) throw new Error('browser unavailable: Chromium not found; set STARNET_CHROME');
    // We run headed only if requested AND the chosen binary can actually show a window.
    const headed = wantHeaded && !binIsHeadlessOnly;

    let proc = null, procExited = false, procError = null, procClosePromise = null, cdp = null, consoleLog = [], dialog = null, attachedPort = null;
    const downloads = deps.downloadDir ? makeDownloadLedger(deps.downloadDir) : null;
    // Owned-browser identity is derived after CDP connects. Windows Chrome GUI binaries often emit
    // nothing for `chrome.exe --version`; launch-time probing alone left their UA as HeadlessChrome.
    // Attached Commander-owned Chrome is intentionally excluded from every override.
    let stationIdentity = null;
    /* NETWORK TRUTH. navigate() used to return only location.href, so a 403, a 404 and a page that
       simply rendered nothing were indistinguishable to the agent — it would "read" an error page and
       report its contents as the answer. The Network domain gives the main document's real status, and
       an in-flight request count that makes auto-wait aware of XHR that has not landed yet. */
    let mainFrameId = null, lastResponse = null;
    const inflight = new Set();
    const runtimeConsoleSessions = new Set();
    /* REQUEST LOG. `browser.console` already lets the agent see what the page SAID; this is what the
       page DID. Without it "the button did nothing" is unfalsifiable — you cannot tell a 401 from a
       CORS refusal from a request that was never made. Bounded like consoleLog, and deliberately
       header-free: Authorization/Cookie live in headers, and the agent does not need them to debug. */
    const NETLOG_MAX = 200;
    let netLog = [];
    const netById = new Map();
    /* INTERCEPT state. The kinds currently blocked (by CDP resource type). Kinds live on the DRIVER,
       not per tab, because "block images" is a statement about the RUN's browsing posture — but CDP's
       Fetch domain is session-scoped, so applyIntercept walks every known tab session and selectTab
       re-applies to tabs adopted later. */
    let interceptKinds = [];
    /* EMULATION state, kept for two reasons: selectTab must re-apply it to a newly-focused tab
       (Emulation.* overrides are per-session too), and the tool must be able to report truthfully
       what is currently being emulated instead of guessing. */
    let emulation = null;
    /* INPUT CADENCE. One deterministic seed per run gives natural-looking bounded paths without
       ambient randomness, flaky tests, or unbounded latency. Long text is grouped into at most 40
       paced inserts, so a large form body cannot turn into minutes of artificial delay. */
    let inputSeed = 2166136261;
    for (const ch of String(deps.inputSeed || profileDir)) {
      inputSeed ^= ch.charCodeAt(0); inputSeed = Math.imul(inputSeed, 16777619) >>> 0;
    }
    function inputRandom() {
      inputSeed ^= inputSeed << 13; inputSeed ^= inputSeed >>> 17; inputSeed ^= inputSeed << 5;
      return (inputSeed >>> 0) / 4294967296;
    }
    function inputBetween(min, max) { return Math.round(min + inputRandom() * (max - min)); }
    async function inputPause(min, max) { await inputSleep(inputBetween(min, max)); }
    let pointer = { x: 720, y: 450 };
    async function movePointer(c, target, button) {
      const start = { x: pointer.x, y: pointer.y };
      const dx = target.x - start.x, dy = target.y - start.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const steps = Math.max(3, Math.min(9, Math.ceil(dist / 180) + inputBetween(2, 4)));
      const bend = (inputRandom() - 0.5) * Math.min(70, dist * 0.18);
      const nx = dist ? -dy / dist : 0, ny = dist ? dx / dist : 0;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, eased = t * t * (3 - 2 * t);
        const arc = Math.sin(Math.PI * t) * bend;
        const x = Math.round(start.x + dx * eased + nx * arc);
        const y = Math.round(start.y + dy * eased + ny * arc);
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: button || 'none' });
        await inputPause(6, 18);
      }
      pointer = { x: target.x, y: target.y };
    }
    function netRecord(requestId, patch) {
      let row = netById.get(requestId);
      if (!row) {
        row = { id: requestId, method: '', url: '', type: '', status: 0, bytes: 0, failure: null, done: false };
        netById.set(requestId, row);
        netLog.push(row);
        if (netLog.length > NETLOG_MAX) { const drop = netLog.shift(); netById.delete(drop.id); }
      }
      Object.assign(row, patch);
      return row;
    }
    const frameSessions = new Map();   // CDP sessionId -> frameId, for every adopted (out-of-process) iframe
    /* TABS. pageSessions holds every adopted extra page target in the order it appeared. activeSession
       is the CDP session every page-scoped command targets: null means the ORIGINAL tab, so the default
       behaviour of every existing tool is byte-identical until the agent explicitly switches. That
       matters — the failure mode of a multi-target driver is quietly reading the WRONG DOM, so
       switching is never implicit. */
    const pageSessions = new Map();    // CDP sessionId -> targetId, for every adopted extra tab
    const tabWaiters = new Set();      // bounded observers waiting for popup adoption to become visible
    let activeSession = null;
    function wakeTabWaiters() {
      for (const wake of Array.from(tabWaiters)) {
        try { wake(); } catch (_) {}
      }
    }
    /* POPUP ADOPTION. A popup is only safe to allow if EVERY new page target is paused before its
       first statement and shimmed. That needs auto-attach on the BROWSER connection: measured,
       Target.setAutoAttach sent on a PAGE session covers that page's own subordinate targets
       (out-of-process iframes, workers) and NEVER fires for a popup, even when /json/list proves the
       target exists. So we connect to the browser endpoint; if that fails we fall back to the page
       endpoint with popups BLOCKED, which is the old behaviour. openerSession is the original tab -
       under browser-level auto-attach every command is session-scoped, including tab 0's. */
    let popupsAdopted = false, openerSession = null, openerTargetId = null, resolveOpenerAttach;
    const openerAttach = new Promise(resolve => { resolveOpenerAttach = resolve; });
    function adoptOpenerSession(sessionId, targetId) {
      if (openerSession !== null) return false;
      openerSession = sessionId;
      openerTargetId = targetId || null;
      if (resolveOpenerAttach) {
        resolveOpenerAttach(sessionId);
        resolveOpenerAttach = null;
      }
      return true;
    }
    function prepareAdoptedPage(sessionId, targetId, allowPopups) {
      installStationIdentity(sessionId).catch(() => {});
      installStationMetrics(sessionId).catch(() => {});
      cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: syntheticInputSource(allowPopups, inputMarker) }, sessionId).catch(() => {});
      cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: settleBootstrap }, sessionId).catch(() => {});
      pageSessions.set(sessionId, targetId);
      wakeTabWaiters();
      cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {
        pageSessions.delete(sessionId);
        wakeTabWaiters();
        if (cdp && targetId) cdp.send('Target.closeTarget', { targetId }).catch(() => {});
      });
    }
    async function preferVisibleAttachedPage() {
      if (attachPort === null || !openerSession || !pageSessions.size) return;
      const candidates = [openerSession].concat(Array.from(pageSessions.keys()));
      const states = await Promise.all(candidates.map(async sid => {
        try {
          const r = await cdp.send('Runtime.evaluate', {
            expression: '({ visibility: document.visibilityState, focused: document.hasFocus() })',
            returnByValue: true
          }, sid);
          return { sid, state: r && r.result && r.result.value };
        } catch (_) { return { sid, state: null }; }
      }));
      // A focused document wins across multiple Chrome windows. If Chrome itself is not foreground,
      // visibility still distinguishes the selected tab in each non-minimized window.
      const chosen = states.find(x => x.state && x.state.focused)
        || states.find(x => x.state && x.state.visibility === 'visible');
      const visible = chosen && chosen.sid;
      if (!visible || visible === openerSession) return;
      const currentTargetId = pageSessions.get(visible) || null;
      const backgroundSession = openerSession;
      const backgroundTargetId = openerTargetId;
      pageSessions.delete(visible);
      openerSession = visible;
      openerTargetId = currentTargetId;
      // The first protocol event was held paused for main-page setup. Once a different, actually visible
      // tab becomes tab 0, prepare and resume that first event as an ordinary background tab instead.
      prepareAdoptedPage(backgroundSession, backgroundTargetId, true);
    }
    async function deriveStationIdentity(sessionId) {
      if (attachPort !== null) return null;
      let browserInfo = null, natural = null;
      try { browserInfo = await cdp.send('Browser.getVersion', {}); } catch (_) {}
      if (!browserVersionFrom(browserInfo && (browserInfo.product || browserInfo.userAgent)) &&
          !/^\d+\.\d+\.\d+\.\d+$/.test(String(deps.browserVersion || ''))) return null;
      for (let attempt = 0; attempt < 10 && !natural; attempt++) {
        try {
          const raw = await cdp.send('Runtime.evaluate', {
            expression: `(async()=>{let hints={};try{hints=navigator.userAgentData?await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList','wow64']):{};}catch(e){}return{ua:navigator.userAgent,platform:navigator.platform,hints};})()`,
            awaitPromise: true, returnByValue: true
          }, sessionId);
          const value = raw && raw.result && raw.result.value;
          if (value && typeof value === 'object') natural = value;
        } catch (_) {}
        if (!natural) await sleep(40);
      }
      return makeCdpIdentity(browserInfo, natural, Object.assign({}, deps, { chromePath }));
    }
    function installStationIdentity(sessionId) {
      if (!stationIdentity || attachPort !== null) return Promise.resolve();
      return cdp.send('Emulation.setUserAgentOverride', stationIdentity, sessionId);
    }
    function installStationMetrics(sessionId) {
      if (attachPort !== null || headed) return Promise.resolve();
      return cdp.send('Emulation.setDeviceMetricsOverride', stationMetrics, sessionId);
    }
    async function connect() {
      if (cdp) return cdp;
      /* ATTACH: no spawn, no profile dir, no proc ledger entry. `proc` deliberately stays null, which is
         what makes close() safe — it kills `owned`, and a browser we did not start is not ours to kill.
         Shutting the Commander's real Chrome (and every unsaved tab in it) because an agent run ended
         would be indefensible. */
      /* ATTACH MODE skips ONLY the launch. `proc` deliberately stays null, and that is what makes close()
         safe: it kills `owned`, and a browser we did not start is not ours to kill — ending an agent run by
         shutting the Commander's real Chrome, with every unsaved tab in it, would be indefensible. Nothing
         is written to the proc ledger for the same reason: the sweeper must never reap a process we borrowed.
         Execution then falls through into the SAME readiness/attach/setup loop the launch path uses. */
      let launchPort;
      if (attachPort !== null) {
        launchPort = attachPort;
      } else {
      try { FS.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
      if (privatePort) { try { FS.rmSync(activePortFile, { force: true }); } catch (_) {} }
      // Allocated here, not by Chromium, so the launch carries no automation flag. Chromium still
      // writes the bound port into this profile's DevToolsActivePort, which stays the readiness proof.
      launchPort = privatePort ? await allocateEphemeralPort() : cdpPort;
      const args = ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
        '--remote-debugging-port=' + launchPort, '--window-size=1440,900',
        '--user-data-dir=' + profileDir];
      args.push('--lang=' + hostBrowserLocale(deps));
      if (headed) {
        // Visible window the user can watch (and hear — no --mute-audio in headed mode).
        args.push('--new-window');
      } else {
        args.push('--headless=new', '--hide-scrollbars', '--mute-audio');
      }
      args.push('about:blank');
      proc = spawn(chromePath, args, { stdio: 'ignore', windowsHide: !headed });
      procClosePromise = new Promise(resolve => {
        if (proc && proc.on) proc.on('close', () => { procExited = true; resolve(true); });
        else resolve(true);
        if (proc && proc.on) proc.on('error', e => { procError = (e && e.message) || String(e); procExited = true; resolve(true); });
      });
      // proc-ledger: a force-killed sidecar can't run close() — record the browser so the next boot's sweep
      // reaps it. The unique profile dir is the identity token, so PID reuse (or the user's OWN Chrome,
      // same exe) never matches and is never killed.
      try {
        if (deps.ledger && proc && proc.pid) {
          const pid = proc.pid;
          deps.ledger.record({ pid, cmd: chromePath + ' --user-data-dir=' + profileDir, kind: 'browser' });
          if (proc.on) proc.on('close', () => { try { deps.ledger.release(pid); } catch (_) {} });
        }
      } catch (_) {}
      }
      for (let i = 0; i < 40; i++) {
        if (attachPort === null && procExited) throw new Error('spawned Chromium exited before CDP ownership was established' + (procError ? ': ' + procError : ''));
        try {
          // We chose launchPort ourselves, so it IS the endpoint — no DevToolsActivePort read-back.
          // (Chromium only writes that file when IT picked the port; installed Chrome launched on an
          // explicit port may never write it, which would strand the loop.) A successful /json/list
          // on our own private port is the readiness proof.
          const port = launchPort;
          // The BROWSER endpoint is what makes popup adoption possible; /json/list is still the
          // readiness proof and the fallback when a rig exposes no browser websocket.
          let wsUrl = null, viaBrowser = false, browserProbeTransient = false;
          if (deps.adoptPopups !== false && deps.syntheticInputOnly !== false) {
            try {
              const v = await (await fetchImpl('http://127.0.0.1:' + port + '/json/version')).json();
              if (v && v.webSocketDebuggerUrl) { wsUrl = v.webSocketDebuggerUrl; viaBrowser = true; }
            } catch (_) { wsUrl = null; browserProbeTransient = true; }
          }
          // Chrome can expose /json/list a scheduler beat before /json/version while starting under load. Falling
          // back to the page websocket on that first transient miss permanently disables popup adoption for the
          // whole run even though the browser endpoint becomes ready milliseconds later. Retry that exact failure
          // within the existing bounded readiness loop; a successful-but-unsupported /json/version response still
          // falls back immediately, and the final iterations preserve page-only compatibility.
          if (!wsUrl && browserProbeTransient && i < 30) {
            await sleep(50);
            continue;
          }
          if (!wsUrl) {
            const r = await fetchImpl('http://127.0.0.1:' + port + '/json/list');
            const targets = await r.json();
            const pg = targets.find(t => t && t.type === 'page');
            wsUrl = pg && pg.webSocketDebuggerUrl;
          }
          if (wsUrl) {
            const ws = new WebSocketImpl(wsUrl);
            await new Promise((resolve, reject) => {
              ws.addEventListener('open', resolve, { once: true });
              ws.addEventListener('error', reject, { once: true });
            });
            cdp = new CdpClient(ws, timeoutMs);
            attachedPort = port;
            // Browser.* download events are emitted on the root connection, not a page session. Register
            // before enabling downloads so a fast local/file response cannot finish between setup steps.
            if (downloads) {
              cdp.on('Browser.downloadWillBegin', event => { downloads.begin(event); });
              cdp.on('Browser.downloadProgress', event => { downloads.progress(event); });
            }
            if (deps.syntheticInputOnly !== false) {
              // New page targets do not inherit a target-scoped preload. Pause every related
              // target before its scripts run and close popups; inject the same shim into any
              // out-of-process iframe before resuming it.
              /* Auto-attach is armed on BOTH the browser connection (so popups are seen) and the page
                 session (so out-of-process iframes are). A target can therefore be delivered TWICE,
                 once per connection, and the duplicate session is paused like any other — leaving it
                 unresumed wedges the parent renderer, which is the exact failure this driver already
                 fixed once. Adopt the first session for a target; immediately resume any duplicate. */
              const adoptedTargets = new Set();
              cdp.on('Target.attachedToTarget', p => {
                const info = p.targetInfo || {}, sid = p.sessionId;
                if (!sid) return;
                if (info.targetId && adoptedTargets.has(info.targetId)) {
                  Promise.resolve(cdp.send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
                  return;
                }
                if (info.targetId) adoptedTargets.add(info.targetId);
                if (info.type === 'page') {
                  if (viaBrowser && openerSession === null) {
                    // The original tab. Its setup is finished by connect() below, which needs to
                    // await it; recording the session is all that happens here.
                    adoptOpenerSession(sid, info.targetId);
                    return;
                  }
                  /* ADOPT, don't kill. A target=_blank link or a popup used to be closed outright
                     (Target.closeTarget while still paused), so a checkout that opens in a new tab, a
                     PDF that opens beside the page, or an SSO popup was a dead end with no explanation.
                     The reason for closing was real — a new page target does NOT inherit a
                     target-scoped preload, so it could run unshimmed script — but that is exactly what
                     the iframe path already solves: attach, inject the shim, THEN resume. Runs are
                     forceHeadless, so an adopted tab can never put a window on the user's screen.
                     If the shim fails to install we still close it: fail closed, never unshimmed. */
                  /* A PAUSED PAGE TARGET IS THE MIRROR IMAGE OF A PAUSED IFRAME (both measured):
                       iframe — Page.* acknowledges; Runtime.evaluate has no execution context.
                       page   — Page.* does NOT acknowledge until resumed; Runtime.evaluate works,
                                because a popup starts life on about:blank, which HAS a context.
                     So the preload must be sent WITHOUT awaiting its reply — awaiting deadlocks until
                     the CDP timeout, and the catch would then close the very tab we set out to adopt.
                     It still takes effect; only the acknowledgement is deferred. Wire order is
                     preserved, so it is installed before the resume that triggers the navigation. */
                  /* RESUME IMMEDIATELY. A same-origin popup shares its OPENER's renderer process, so a
                     popup left paused blocks the opener's Runtime.evaluate too - the identical wedge a
                     paused out-of-process iframe caused, just reached from the other side. Measured law:
                     Page.* does not acknowledge on a paused page target, so awaiting the preload here
                     would stall until the CDP timeout and take the opener down with it.
                  The websocket is ordered, so queueing the preloads before the resume is enough for
                     them to apply to the document the popup is about to load - nothing needs awaiting.
                     about:blank is deliberately not shimmed: it has no content to protect, and reaching
                     for it is what made this path block. */
                   // Receiving this event from the browser endpoint is itself proof that popup adoption
                   // is armed, even while setAutoAttach's acknowledgement is still in flight.
                   prepareAdoptedPage(sid, info.targetId, viaBrowser);
                  return;
                }
                if (info.type !== 'iframe') {
                  // Workers have no DOM/input APIs. Resume them untouched so physics/service
                  // workers keep working; only DOM-capable targets need the preload.
                  Promise.resolve(cdp.send('Runtime.runIfWaitingForDebugger', {}, sid)).catch(() => {});
                  return;
                }
                /* AN OUT-OF-PROCESS IFRAME HAS NO EXECUTION CONTEXT WHILE PAUSED.
                   This path used to Runtime.evaluate the bootstrap into a paused OOPIF. That call
                   ALWAYS fails ("Cannot find default execution context") — there is no document yet
                   to evaluate into — so the chain rejected, the catch closed the target, and the frame
                   never resumed. A paused OOPIF blocks its PARENT's renderer, so every subsequent
                   Runtime.evaluate on the top page timed out too: measured, any page carrying a
                   cross-origin iframe (Stripe, Auth0/Okta, reCAPTCHA, a consent wall, an embed) made
                   browser.navigate hang for the full CDP timeout and then throw.
                   The preload is the ONLY thing needed and the only thing that works here:
                   Page.addScriptToEvaluateOnNewDocument DOES acknowledge on a paused OOPIF (~1ms) and
                   applies to the document the frame is about to load. Then resume. */
                Promise.resolve()
                  .then(() => installStationIdentity(sid))
                  .then(() => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: syntheticInputSource(false, inputMarker) }, sid))
                  .then(() => cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: settleBootstrap }, sid))
                  // Remember the adopted frame. It was already attached and shimmed, but nothing ever
                  // recorded its session, so snapshot/get_text could never look inside it: a login form
                  // in an Auth0/Okta/Stripe iframe, or a consent banner, was simply invisible.
                  .then(() => { if (info.targetId) frameSessions.set(sid, info.targetId); })
                  .then(() => cdp.send('Runtime.runIfWaitingForDebugger', {}, sid))
                  // Fail closed: an unshimmed frame is removed rather than resumed. Leaving it PAUSED
                  // is the one outcome we must never pick — that is what wedged the parent page.
                  .catch(() => {
                    frameSessions.delete(sid);
                    if (cdp && info.targetId) cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
                  });
              });
              cdp.on('Target.detachedFromTarget', p => {
              if (!p || !p.sessionId) return;
              frameSessions.delete(p.sessionId);
              pageSessions.delete(p.sessionId);
              wakeTabWaiters();
              // A closed tab must never leave the driver pointed at a dead session.
              if (activeSession === p.sessionId) activeSession = null;
            });
              let initialPageCount = 1;
              if (viaBrowser && attachPort !== null) {
                try {
                  const initial = await cdp.send('Target.getTargets');
                  initialPageCount = Math.max(1, (initial && initial.targetInfos || []).filter(t => t && t.type === 'page').length);
                } catch (_) {}
              }
              await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
              if (viaBrowser) {
                // Auto-attach on the browser connection also attaches the EXISTING tab. Wait on that
                // protocol event, not a fixed scheduler-speed poll: under full-suite load the event can
                // arrive after two seconds, and installing the immutable popup block before it does is
                // permanent for the page. The ordinary CDP timeout keeps this proof bounded and fail-closed.
                await Promise.race([openerAttach, sleep(timeoutMs)]);
                popupsAdopted = openerSession !== null;
                if (popupsAdopted && attachPort !== null) {
                  // Existing Commander tabs arrive as the same attachedToTarget event as future popups,
                  // and protocol order is not UI-focus order. Wait for the initial set, then make the
                  // actually visible/focused page tab 0 before any snapshot or action can run.
                  if (initialPageCount > 1) await waitForTabCount(initialPageCount, timeoutMs);
                  await preferVisibleAttachedPage();
                }
              }
            }
            // Popups are only unblocked once adoption is proven armed. Anything else - no browser
            // endpoint, isolation disabled, the opener never attaching - keeps the old block.
            const shimSource = syntheticInputSource(popupsAdopted, inputMarker);
            const S = openerSession || undefined;   // under browser-level attach, even tab 0 is a session
            await cdp.send('Page.enable', {}, S);
            // Runtime.evaluate does not require Runtime.enable. Leave the observable Runtime domain
            // disabled during ordinary browsing; browser.console enables it lazily for the active tab
            // only when the agent explicitly asks for console diagnostics.
            if (deps.syntheticInputOnly !== false) {
              // Install for all future documents AND the current about:blank. A page click can
              // now satisfy its logical pointer-lock contract without touching Win32 ClipCursor.
              await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: shimSource }, S);
              await cdp.send('Runtime.evaluate', { expression: shimSource, awaitPromise: true }, S);
            }
            // The settle marker is measurement, not a security shim, so it installs UNCONDITIONALLY —
            // auto-wait must still work on a rig that disabled the synthetic-input isolation.
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: settleBootstrap }, S);
            await cdp.send('Runtime.evaluate', { expression: settleBootstrap }, S);
            await cdp.send('Network.enable', {}, S);
            await cdp.send('DOM.enable', {}, S);
            // waitForDebuggerOnStart pauses EVERY page target, the original tab included. Its setup is
            // done, so let it run - a tab left paused wedges the whole session.
            if (openerSession && deps.syntheticInputOnly !== false) {
              // Browser-level auto-attach covers TOP-LEVEL targets (that is what makes popups visible);
              // out-of-process IFRAMES hang off the page, so the page session needs its own arming or
              // cross-origin frames stop attaching entirely.
              try { await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, openerSession); } catch (_) {}
            }
            if (openerSession) { try { await cdp.send('Runtime.runIfWaitingForDebugger', {}, openerSession); } catch (_) {} }   // getFrameOwner/getBoxModel, for placing iframe content in the top page
            if (attachPort === null && !headed) {
              /* Client Hints reveal their high-entropy values only in a trustworthy origin. Probe the
                 browser's own loopback DevTools endpoint before any site is visited, then preserve those
                 native values while replacing only the headless brand/legacy-UA label. Network listeners
                 are installed below, so this owned bootstrap navigation never appears as page telemetry. */
              try { await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + launchPort + '/json/version' }, S, navTimeoutMs); } catch (_) {}
              stationIdentity = await deriveStationIdentity(S);
              await installStationIdentity(S);
              await installStationMetrics(S);
            }
            // Identify the top frame so a sub-frame's document response can never be mistaken for the
            // page's own status (an ad iframe 404 must not read as "the page 404'd").
            try {
              const tree = await cdp.send('Page.getFrameTree', {}, S);
              mainFrameId = (tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id) || null;
            } catch (_) { mainFrameId = null; }
            /* DOWNLOADS INTO THE JAIL. The Chrome profile lives in OS.tmpdir(), outside WORKSPACES, so
               anything the agent downloaded landed where it could not read it back — the bytes were
               unreachable even by accident. Point Chrome at the agent's own downloads/ directory.
               Browser.setDownloadBehavior is browser-scoped and not always accepted on a page
               connection; Page.setDownloadBehavior is the deprecated page-scoped equivalent. Try both. */
            if (deps.downloadDir) {
              try { FS.mkdirSync(deps.downloadDir, { recursive: true }); } catch (_) {}
              const behavior = { behavior: 'allow', downloadPath: deps.downloadDir };
              try { await cdp.send('Browser.setDownloadBehavior', Object.assign({ eventsEnabled: true }, behavior)); }
              catch (_) { try { await cdp.send('Page.setDownloadBehavior', behavior); } catch (_) {} }
            }
            /* browser.intercept — every request paused here matched a blocked-type Fetch pattern, so the
               only job is to fail it fast. The reply goes to the SESSION THE EVENT CAME FROM (second
               handler arg): answering on the active session would leave a background tab's paused request
               hanging forever, which wedges that tab's load. The blocked request then surfaces through the
               ordinary Network.loadingFailed path as net::ERR_BLOCKED_BY_CLIENT — browser.network stays
               truthful about what the page lost without any bookkeeping here. */
            cdp.on('Fetch.requestPaused', (p, sid) => {
              if (!p || !p.requestId) return;
              Promise.resolve(cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sid)).catch(() => {});
            });
            cdp.on('Network.requestWillBeSent', p => {
              if (!p || !p.requestId) return;
              inflight.add(p.requestId);
              const req = p.request || {};
              netRecord(p.requestId, { method: req.method || 'GET', url: req.url || '', type: p.type || '' });
            });
            cdp.on('Network.loadingFinished', p => {
              if (!p || !p.requestId) return;
              inflight.delete(p.requestId);
              netRecord(p.requestId, { bytes: Math.max(0, Math.round(Number(p.encodedDataLength) || 0)), done: true });
            });
            cdp.on('Network.responseReceived', p => {
              if (!p) return;
              const r = p.response || {};
              if (p.requestId) netRecord(p.requestId, { status: Number(r.status) || 0, url: r.url || '', type: p.type || '' });
              if (p.type !== 'Document') return;
              if (mainFrameId && p.frameId && p.frameId !== mainFrameId) return;
              lastResponse = { status: Number(r.status) || 0, statusText: r.statusText || '', url: r.url || '', mimeType: r.mimeType || '', failure: null };
            });
            cdp.on('Network.loadingFailed', p => {
              if (!p) return;
              if (p.requestId) { inflight.delete(p.requestId); netRecord(p.requestId, { failure: p.errorText || 'request failed', done: true }); }
              // A transport-level failure (DNS, refused, cert) never produces a response at all.
              if (p.type === 'Document') lastResponse = { status: 0, statusText: '', url: '', mimeType: '', failure: p.errorText || 'request failed' };
            });
            cdp.on('Runtime.consoleAPICalled', p => {
              const text = (p.args || []).map(a => a.value != null ? a.value : (a.description || a.type || '')).join(' ');
              consoleLog.push({ type: p.type || 'log', text: clamp(text, 500) });
              if (consoleLog.length > 200) consoleLog = consoleLog.slice(-200);
            });
            cdp.on('Page.javascriptDialogOpening', p => { dialog = { type: p.type || 'alert', message: p.message || '' }; });
            return cdp;
          }
        } catch (_) {}
        await sleep(250);
      }
      throw new Error('browser unavailable: could not attach to Chromium');
    }
    /* Page-scoped command channel. Every page command (Runtime/Input/DOM/Emulation/Page) goes through
       here so it lands on the ACTIVE tab; browser-scoped commands (Target and Browser) keep using cdp
       directly and are never given a sessionId. An explicit sessionId argument still wins, which is how
       snapshot/get_text reach individual iframe sessions. */
    let pageProxy = null;
    async function page() {
      const c = await connect();
      if (!pageProxy || pageProxy.__cdp !== c) {
        pageProxy = {
          __cdp: c,
          // NOTE the 4th arg: CdpClient.send takes a per-call timeout (navigation uses it). Dropping it
          // here would silently put navigation back on the 15s budget and re-open the stalled-session wedge.
          send: (method, params, sessionId, timeoutMs) => c.send(method, params, sessionId !== undefined ? sessionId : (activeSession || openerSession || undefined), timeoutMs),
          on: (n, fn) => c.on(n, fn)
        };
      }
      return pageProxy;
    }
    async function evalJS(expression) {
      const c = await page();
      const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('page eval failed: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || 'exception'));
      return r.result && r.result.value;
    }
    /* Wait for the page to go quiet. Returns true if it genuinely settled, false if the budget ran out
       or the settle marker was unavailable (a page that blocked the bootstrap, or a bare CDP endpoint).
       NEVER throws and NEVER waits past the budget: a wait helper that can hang would be worse than the
       fixed sleeps it replaces. `fallbackMs` is the legacy blind sleep used only when we cannot measure. */
    async function waitForSettle(c, opts) {
      opts = opts || {};
      const quietPolls = opts.quietPolls == null ? settleQuietPolls : opts.quietPolls;
      const budgetMs = opts.budgetMs || settleActionBudgetMs;
      // The budget is a TIMER, not a clock read — determinism law bans ambient time in backend logic,
      // and a timer expresses "stop waiting" just as well.
      let expired = false, observed = settleMinObserveMs <= 0;
      const timer = setTimeout(() => { expired = true; }, budgetMs);
      const minTimer = observed ? null : setTimeout(() => { observed = true; }, settleMinObserveMs);
      try {
        let lastN = null, stable = 0;
        for (;;) {
          let probe = null;
          try {
            const r = await c.send('Runtime.evaluate', { expression: settleProbe, returnByValue: true });
            probe = r && r.result && r.result.value;
          } catch (_) { probe = null; }
          // Marker absent (or a non-object answer from a stub endpoint): we cannot measure quiescence.
          if (!probe || typeof probe !== 'object' || probe.ok !== true) {
            const fb = Number(opts.fallbackMs || 0);
            if (fb > 0) await sleep(fb);
            return false;
          }
          stable = (lastN !== null && probe.n === lastN) ? stable + 1 : 0;
          lastN = probe.n;
          // A quiet DOM is not proof of a quiet page: an XHR can still be in flight with nothing
          // rendered yet. Wait for the network too — but a long-poll/SSE/websocket connection never
          // finishes, so a much longer run of DOM stillness releases us regardless.
          const netIdle = inflight.size === 0;
          if (observed && probe.ready === 'complete' && stable >= quietPolls && (netIdle || stable >= quietPolls * 3)) return true;
          if (expired) return false;                  // spend the budget, then proceed with what we have
          await sleep(SETTLE_POLL_MS);
        }
      } finally { clearTimeout(timer); if (minTimer) clearTimeout(minTimer); }
    }
    async function navigate(url) {
      const c = await page();
      lastResponse = null;   // this navigation's status, never the previous page's
      netLog = []; netById.clear();   // the log describes THIS page, not whatever came before
      /* A stalled navigation used to poison the WHOLE session. Page.navigate blocks until commit, so a slow
         or challenge-walled origin blew the 15s command budget and threw "CDP timeout: Page.navigate" - and
         because nothing ever cancelled it, the renderer stayed busy loading and the NEXT tool call
         (browser.snapshot's Runtime.evaluate) queued behind it and timed out too. A user hit exactly that
         pair on a listing page, which reads as "the browser is broken" rather than "that page did not load".
         Now: navigation gets its own larger budget, and on timeout we ALWAYS Page.stopLoading (best-effort,
         on a short budget of its own) so the session is usable for the very next call. */
      try {
        await c.send('Page.navigate', { url }, undefined, navTimeoutMs);
      } catch (e) {
        if (!/CDP timeout/.test(String(e && e.message))) throw e;
        try { await c.send('Page.stopLoading', {}, undefined, Math.min(timeoutMs, 5000)); } catch (_) {}
        let host = url;
        try { host = new URL(url).host; } catch (_) {}
        throw new Error('the page did not finish loading within ' + Math.round(navTimeoutMs / 1000) + 's, so the ' +
          'navigation to ' + host + ' was stopped (the browser is still usable). The site may be slow, may be ' +
          'refusing automated browsers, or may be holding a challenge page. Try browser.get_text to see what ' +
          'did load, or reach the site through its API with web_request instead.');
      }
      // Replaces the blind 900ms sleep: wait for the page to actually go quiet, keeping the fixed sleep
      // only as the fallback for a page whose quiescence we cannot measure.
      await waitForSettle(c, { budgetMs: settleNavBudgetMs, fallbackMs: 900 });
      const finalUrl = await evalJS('location.href');
      if (deps.syntheticInputOnly !== false) {
        const isolation = await evalJS(`(() => {
          const s=${inputStateExpr};
           const rd=Object.getOwnPropertyDescriptor(Element.prototype,'requestPointerLock');
           const ed=Object.getOwnPropertyDescriptor(Document.prototype,'exitPointerLock');
           const fd=Object.getOwnPropertyDescriptor(Element.prototype,'requestFullscreen');
           const fe=Object.getOwnPropertyDescriptor(Document.prototype,'exitFullscreen');
           const od=Object.getOwnPropertyDescriptor(globalThis,'open');
          const kd=navigator.keyboard&&Object.getOwnPropertyDescriptor(navigator.keyboard,'lock');
          const ku=navigator.keyboard&&Object.getOwnPropertyDescriptor(navigator.keyboard,'unlock');
           const pointerReady=!!(s&&rd&&ed&&rd.value===s.requestPointerLock&&ed.value===s.exitPointerLock&&rd.writable===false&&ed.writable===false&&rd.configurable===false&&ed.configurable===false);
           const fullscreenReady=!!(s&&fd&&fe&&fd.value===s.requestFullscreen&&fe.value===s.exitFullscreen&&fd.writable===false&&fe.writable===false&&fd.configurable===false&&fe.configurable===false);
           const popupReady=(s&&s.allowPopups===true)?true:!!(s&&od&&od.value===s.blockedOpen&&od.writable===false&&od.configurable===false);
           const keyboardReady=!navigator.keyboard||!!(kd&&ku&&kd.value===s.keyboardLock&&ku.value===s.keyboardUnlock&&kd.writable===false&&ku.writable===false&&kd.configurable===false&&ku.configurable===false);
           const wakeReady=!navigator.wakeLock||navigator.wakeLock.request===s.wakeRequest;
           const orientationReady=!globalThis.screen||!screen.orientation||(screen.orientation.lock===s.orientationLock&&screen.orientation.unlock===s.orientationUnlock);
           return {ready:!!(s&&s.ready&&pointerReady&&fullscreenReady&&popupReady&&keyboardReady&&wakeReady&&orientationReady),error:s&&s.error||null};
        })()`);
        if (!isolation || isolation.ready !== true) {
          // Fail closed before the caller can dispatch a click/user gesture. Pointer lock cannot
          // normally activate without that gesture, so an unsuccessful shim never gets driven.
          try { await c.send('Page.navigate', { url: 'about:blank' }); } catch (_) {}
          throw new Error('synthetic input isolation failed to install: ' + ((isolation && isolation.error) || 'unknown bootstrap failure'));
        }
      }
      return finalUrl;
    }
    /* Where an adopted iframe sits in the TOP page. Elements inside a frame report coordinates relative
       to that frame, so without this offset every click into an iframe would land somewhere else. If the
       offset cannot be determined the frame's elements are OMITTED rather than offered at coordinates we
       know are wrong — an invisible element is a gap, a mis-aimed one is a wrong action. */
    async function frameOffset(c, frameId) {
      try {
        const owner = await c.send('DOM.getFrameOwner', { frameId });
        if (!owner || !owner.backendNodeId) return null;
        const box = await c.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
        const quad = box && box.model && box.model.content;
        if (!quad || quad.length < 2) return null;
        return { x: Math.round(quad[0]), y: Math.round(quad[1]) };
      } catch (_) { return null; }
    }
    async function evalIn(c, expression, sessionId) {
      try {
        const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
        if (r && r.exceptionDetails) return null;
        return r && r.result && r.result.value;
      } catch (_) { return null; }
    }
    async function snapshot(limit) {
      const c = await page();
      const cap = Math.max(1, Math.min(200, Number(limit || 80)));
      let out = await collectNodes(c, cap);
      /* AUTO-WAIT + RE-READ. DOM quiescence cannot see the future: a page whose framework renders from
         a setTimeout is genuinely STILL at load time, goes quiet, and only then paints. That is exactly
         the reported symptom — an empty snapshot the agent reports as "no interactive elements".
         An empty page is already a dead end, so it is the one case worth paying for: wait a bounded
         grace and look once more. A page that HAS content pays nothing. */
      if (!out.length && settleEmptyGraceMs > 0) {
        await sleep(settleEmptyGraceMs);
        await waitForSettle(c, { budgetMs: settleActionBudgetMs });
        out = await collectNodes(c, cap);
      }
      return out.map((n, i) => Object.assign({}, n, { index: i }));
    }
    async function collectNodes(c, cap) {
      const expr = snapshotExpr(cap);
      const raw = await evalIn(c, expr);
      const out = Array.isArray(raw) ? raw : [];   // a non-array answer means 'nothing readable', not a crash
      let frameNo = 0;
      // Out-of-process frames are tracked per driver, not per tab, so only merge them while the
      // ORIGINAL tab is active — attributing tab 0's frames to tab 2 would be exactly the
      // wrong-DOM failure this design exists to avoid.
      for (const [sid, frameId] of ((activeSession && activeSession !== openerSession) ? [] : frameSessions)) {
        if (out.length >= cap) break;
        frameNo++;
        const off = await frameOffset(c, frameId);
        if (!off) continue;
        const nodes = (await evalIn(c, expr, sid)) || [];
        for (const n of nodes) {
          if (out.length >= cap) break;
          out.push(Object.assign({}, n, { x: n.x + off.x, y: n.y + off.y, frame: frameNo }));
        }
      }
      return out;
    }
    /* Walks SAME-ORIGIN iframes as well as the top document. An out-of-process (cross-origin) frame
       gets its own CDP session and is handled by frameSessions; a same-origin frame does NOT — it
       shares this execution context, and document.querySelectorAll simply does not descend into it.
       Without this walk a same-origin embedded form is invisible for the same reason a cross-origin
       one was. Offsets accumulate down the tree so every coordinate is in TOP-page space. */
    function snapshotExpr(cap) {
      return `(() => {
        const q = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[tabindex]:not([tabindex="-1"]),[onclick],summary,label';
        const out = [];
        const visit = (doc, dx, dy, frame, depth) => {
          if (!doc || depth > 4 || out.length >= ${cap}) return;
          // Framework handlers usually live on DOM properties or delegated listeners, not HTML
          // onclick attributes. A pointer cursor is a candidate hint, not proof a click succeeded.
          // Walk open shadow roots too; querySelectorAll never crosses that boundary by itself.
          for (const el of doc.querySelectorAll('*')) {
            if (out.length >= ${cap}) return;
            if (el.shadowRoot) visit(el.shadowRoot, dx, dy, frame, depth + 1);
            if (out.length >= ${cap}) return;
            const r = el.getBoundingClientRect();
            const x = r.left + dx, y = r.top + dy;
            if (!(r.width > 1 && r.height > 1 && y + r.height >= 0 && x + r.width >= 0 && y <= innerHeight && x <= innerWidth)) continue;
            const view = el.ownerDocument.defaultView;
            const style = view.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.visibility === 'collapse' || style.display === 'none') continue;
            const parent = el.parentElement || (el.getRootNode().host || null);
            const pointer = style.cursor === 'pointer' && (!parent || view.getComputedStyle(parent).cursor !== 'pointer');
            const semantic = el.matches(q);
            if (!semantic && typeof el.onclick !== 'function' && !pointer) continue;
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' || tag === 'textarea' ? 'textbox' : semantic ? tag : 'clickable');
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
            const node = { index: out.length, role, text, x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
            if (frame) node.frame = frame;
            out.push(node);
          }
          let n = frame;
          for (const f of doc.querySelectorAll('iframe,frame')) {
            let sub = null;
            try { sub = f.contentDocument; } catch (e) { sub = null; }   // cross-origin: handled via its own CDP session
            if (!sub) continue;
            const fr = f.getBoundingClientRect();
            visit(sub, dx + fr.left, dy + fr.top, (n = (n || 0) + 1), depth + 1);
          }
        };
        visit(document, 0, 0, 0, 0);
        return out;
      })()`;
    }
    // Every mutating action settles before it returns, so the NEXT snapshot/get_text reads the DOM the
    // action produced rather than the one it replaced. This is the fix for the silent corrupter: these
    // three used to return with zero settle time.
    function center(node) {
      return { x: node.x + Math.max(1, Math.floor(node.w / 2)), y: node.y + Math.max(1, Math.floor(node.h / 2)) };
    }
    async function click(node) {
      const c = await page();
      const downloadCursor = downloads ? downloads.cursor() : 0;
      const x = node.x + Math.max(1, Math.floor(node.w / 2));
      const y = node.y + Math.max(1, Math.floor(node.h / 2));
      await movePointer(c, { x, y }, 'none');
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await inputPause(35, 90);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      // Do not make every click ten seconds slower. A wait is justified only when Chromium proved this
      // click started a download; then the terminal event plus an on-disk stat produce the receipt.
      if (downloads && downloads.startedAfter(downloadCursor)) {
        const receipt = await downloads.waitAfter(downloadCursor, downloadWaitMs);
        if (receipt && receipt.status === 'completed') {
          const metadata = fenceExternal('Saved path: ' + receipt.relative + '\nSize: ' + receipt.bytes + ' bytes', 'download filename and metadata reported by the controlled browser');
          return 'clicked\nDownload completed and the host verified the saved file.\n' + metadata
            + '\nRead it with fs.read using the saved path above; Word (.docx) files are extracted automatically.';
        }
        if (receipt && receipt.status === 'canceled') return 'clicked\nDownload canceled. No saved path was claimed.';
        if (receipt && receipt.status === 'unverified') return 'clicked\nChromium reported the download complete, but the host could not verify a readable saved file. Do not claim it was saved.';
        return 'clicked\nDownload started but did not complete within the browser action budget. No saved path was claimed. Use fs.list on downloads/ later to check for a completed file.';
      }
      return 'clicked';
    }
    async function type(node, text) {
      await click(node);
      const c = await page();
      const chars = Array.from(String(text || ''));
      const paced = Math.min(chars.length, 40);
      let at = 0;
      for (let i = 0; i < paced; i++) {
        const take = Math.ceil((chars.length - at) / (paced - i));
        await c.send('Input.insertText', { text: chars.slice(at, at + take).join('') });
        at += take;
        if (i + 1 < paced) await inputPause(25, 70);
      }
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'typed';
    }
    async function press(key) {
      const c = await page();
      key = String(key || 'Enter');
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
      await inputPause(25, 70);
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
      // Enter/Escape routinely submit or dismiss, so a keypress gets a navigation-sized budget.
      await waitForSettle(c, { budgetMs: settleNavBudgetMs });
      return 'pressed ' + key;
    }
    /* Hover is not a nicety: menus, tooltips and disclosure widgets render their real targets only on
       mouseover, so without it whole navigations are unreachable from a snapshot. */
    async function hover(node) {
      const c = await page();
      const p = center(node);
      await movePointer(c, p, 'none');
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'hovered';
    }
    /* HTML5 drag-and-drop needs intermediate move events — a press/release pair at two points is
       ignored by every library that listens for dragover. */
    async function drag(from, to) {
      const c = await page();
      const a = center(from), b = center(to);
      await movePointer(c, a, 'none');
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      await inputPause(45, 100);
      await movePointer(c, b, 'left');
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'dragged';
    }
    /* A <select> cannot be driven by synthetic clicks — the popup is native chrome, outside the page.
       Set the value and fire the events a framework listens for. The agent supplies only a VALUE, never
       code: it is embedded as a JS string literal, so no page script can be composed from tool input. */
    async function selectOption(node, value) {
      const p = center(node);
      const lit = jsLiteral(value);
      const r = await evalJS(`(() => {
        const el = document.elementFromPoint(${p.x}, ${p.y});
        const sel = el && (el.tagName === 'SELECT' ? el : el.closest && el.closest('select'));
        if (!sel) return { ok: false, reason: 'no <select> at this ref' };
        const want = ${lit};
        const opts = Array.from(sel.options || []);
        const hit = opts.find(o => o.value === want) || opts.find(o => (o.label || o.text || '').trim() === want);
        if (!hit) return { ok: false, reason: 'no option matching ' + JSON.stringify(want), options: opts.slice(0, 40).map(o => o.value) };
        sel.value = hit.value;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: hit.value, label: (hit.label || hit.text || '').trim() };
      })()`);
      await waitForSettle(await page(), { budgetMs: settleActionBudgetMs });
      return r;
    }
    /* The viewport was pinned to the launch flag --window-size=1440,900, so mobile layouts and
       responsive breakpoints were simply unreachable. */
    async function viewport(width, height, opts) {
      opts = opts || {};
      const c = await page();
      await c.send('Emulation.setDeviceMetricsOverride', {
        width: Math.max(1, Math.round(Number(width) || 0)),
        height: Math.max(1, Math.round(Number(height) || 0)),
        deviceScaleFactor: Number(opts.scale) > 0 ? Number(opts.scale) : 1,
        mobile: opts.mobile === true
      });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return Math.round(Number(width) || 0) + 'x' + Math.round(Number(height) || 0);
    }
    /* PDF — Page.printToPDF renders the CURRENT document (whole page, not the viewport crop a
       screenshot gives). It can legitimately take longer than an ordinary command on a long page, so
       it gets the navigation-class budget. Headed Chrome builds that refuse the command reject the
       CDP call; the caller reports that honestly rather than synthesizing an empty file. */
    async function pdf(opts) {
      opts = opts || {};
      const c = await page();
      const r = await c.send('Page.printToPDF', { printBackground: true, landscape: opts.landscape === true }, undefined, navTimeoutMs);
      return (r && r.data) || '';
    }
    /* Fetch.enable's patterns pre-filter by resource type, so only requests of BLOCKED kinds ever
       pause — everything else flows with zero interception overhead. Session-scoped, hence the walk
       over every known tab session; disabling walks the same set so no background tab keeps blocking. */
    async function applyIntercept(c) {
      for (const sid of tabSessions()) {
        const sessionId = sid === null ? undefined : sid;
        try {
          if (!interceptKinds.length) await c.send('Fetch.disable', {}, sessionId);
          else await c.send('Fetch.enable', { patterns: interceptKinds.map(k => ({ urlPattern: '*', resourceType: INTERCEPT_TYPES[k], requestStage: 'Request' })) }, sessionId);
        } catch (_) {}
      }
    }
    async function intercept(kinds) {
      const list = (Array.isArray(kinds) ? kinds : []).map(k => String(k || '').trim().toLowerCase()).filter(Boolean);
      const bad = list.filter(k => !INTERCEPT_TYPES[k]);
      if (bad.length) throw new Error('browser.intercept: unknown kind(s): ' + bad.join(', ') + ' (supported: ' + Object.keys(INTERCEPT_TYPES).join(', ') + ')');
      interceptKinds = Array.from(new Set(list));
      await applyIntercept(await page());
      return interceptKinds.slice();
    }
    /* EMULATION. Overrides are all-or-nothing per call for the fields given; reset returns an owned
       browser to its station identity (not Chromium's HeadlessChrome default). Attached Chrome still
       clears to its real identity because stationIdentity is intentionally never created there. */
    async function applyEmulation(c) {
      const e = emulation;
      if (!e) {
        try {
          if (attachPort === null && !headed) await c.send('Emulation.setDeviceMetricsOverride', stationMetrics);
          else await c.send('Emulation.clearDeviceMetricsOverride', {});
        } catch (_) {}
        try { await c.send('Emulation.setTouchEmulationEnabled', { enabled: false }); } catch (_) {}
        try { await c.send('Emulation.setUserAgentOverride', stationIdentity || { userAgent: '' }); } catch (_) {}
        try { await c.send('Emulation.setLocaleOverride', {}); } catch (_) {}
        try { await c.send('Emulation.setTimezoneOverride', { timezoneId: '' }); } catch (_) {}
        return;
      }
      if (e.width && e.height) await c.send('Emulation.setDeviceMetricsOverride', { width: e.width, height: e.height, deviceScaleFactor: e.scale || 1, mobile: e.mobile === true });
      if (e.touch != null) { try { await c.send('Emulation.setTouchEmulationEnabled', { enabled: e.touch === true }); } catch (_) {} }
      if (e.userAgent || e.locale) await c.send('Emulation.setUserAgentOverride', Object.assign({ userAgent: e.userAgent || '' }, e.locale ? { acceptLanguage: e.locale } : {}));
      if (e.locale) { try { await c.send('Emulation.setLocaleOverride', { locale: e.locale }); } catch (_) {} }
      if (e.timezone) await c.send('Emulation.setTimezoneOverride', { timezoneId: e.timezone });
    }
    async function emulate(next) {
      emulation = next || null;
      const c = await page();
      await applyEmulation(c);
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return emulation ? Object.assign({}, emulation) : null;
    }
    /* INSPECT — the bounded half of "page eval".
       The audit's real complaint about the loopback-only eval gate was concrete: no computed style, no
       data-* attributes, no shadow DOM. Those are READS, and they do not need arbitrary code. This
       returns them as structured data from a FIXED expression, so it is available on any page with no
       eval gate at all - and it can never reach cookies or storage, which is where the risk actually
       lives. */
    async function inspect(node) {
      const p = center(node);
      return evalJS(`(() => {
        const el = document.elementFromPoint(${p.x}, ${p.y});
        if (!el) return { ok: false, reason: 'nothing at this ref (take a fresh browser.snapshot)' };
        const cs = getComputedStyle(el);
        const want = ['display','visibility','opacity','position','color','backgroundColor','fontSize',
          'fontWeight','width','height','zIndex','overflow','pointerEvents','cursor','textAlign','border'];
        const styles = {}; for (const k of want) styles[k] = cs[k];
        const attrs = {}; for (const a of el.attributes) attrs[a.name] = String(a.value).slice(0, 300);
        const data = {}; for (const k of Object.keys(el.dataset || {})) data[k] = String(el.dataset[k]).slice(0, 300);
        const r = el.getBoundingClientRect();
        // Shadow DOM is the other thing the gate cost us; expose its interactive contents, not a handle.
        let shadow = null;
        if (el.shadowRoot) {
          shadow = Array.from(el.shadowRoot.querySelectorAll('a,button,input,textarea,select'))
            .slice(0, 20).map(x => ({ tag: x.tagName.toLowerCase(), type: x.type || '', text: (x.innerText || x.value || '').trim().slice(0, 80) }));
        }
        return { ok: true, tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '', text: (el.innerText || el.value || '').trim().slice(0, 400),
          disabled: !!el.disabled, checked: el.checked === undefined ? null : !!el.checked,
          box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          styles, attrs, data, shadow };
      })()`);
    }
    /* PUBLIC PAGE EVAL — allowed only while the EPHEMERAL profile is in use.
       Keeping the loopback-only gate forever costs real capability, but lifting it outright is not
       safe either: browser.login puts REAL signed-in sessions in the persistent profile, so arbitrary
       eval there plus web_request is an account-takeover primitive on a prompt-injected run. The
       honest line is not "eval is dangerous" - it is "eval is dangerous WHERE THE CREDENTIALS ARE".
       So the driver reports which profile is live and the session refuses accordingly.
       Results come back JSON-serialized: an object graph (a Window, a DOM node) would either blow up
       CDP serialization or hand the model a reference it cannot use. */
    async function evalPublic(expression) {
      const lit = jsLiteral(String(expression == null ? '' : expression));
      const r = await evalJS(`(() => {
        try {
          const v = (0, eval)(${lit});
          if (v === undefined) return { ok: true, value: '(undefined)' };
          try { return { ok: true, value: JSON.stringify(v) === undefined ? String(v) : JSON.parse(JSON.stringify(v)) }; }
          catch (e) { return { ok: true, value: String(v) }; }
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`);
      return r;
    }
    /* Tab 0 is always the ORIGINAL target (sessionId null); adopted tabs follow in the order they
       appeared. Switching is explicit and never implicit — a multi-target driver's worst failure is
       silently reading the wrong DOM, so nothing moves the agent between tabs on its own. */
    function tabSessions() { return [openerSession].concat(Array.from(pageSessions.keys())); }
    /* Popup adoption is delivered by Target.attachedToTarget, not by a page mutation. Callers that
       must act on a newly opened tab need a bounded observation of that event; repeatedly sampling
       tabs() guesses at scheduler speed and becomes flaky when the full QA suite is loading Chromium.
       This resolves on the actual state transition and returns false on timeout, so a missing popup is
       still an honest failure rather than an ever-widening sleep. */
    async function waitForTabCount(count, budgetMs) {
      const wanted = Math.max(1, Math.floor(Number(count) || 1));
      const budget = Math.max(250, Math.min(WAIT_MAX_MS, Number(budgetMs || WAIT_DEFAULT_MS)));
      if (tabSessions().length >= wanted) return true;
      return await new Promise(resolve => {
        let timer = null, done = false;
        const finish = ok => {
          if (done) return;
          done = true;
          tabWaiters.delete(wake);
          if (timer) clearTimeout(timer);
          resolve(ok);
        };
        const wake = () => {
          if (tabSessions().length >= wanted) finish(true);
        };
        tabWaiters.add(wake);
        timer = setTimeout(() => finish(tabSessions().length >= wanted), budget);
        wake();
      });
    }
    async function tabs() {
      const c = await page();
      const out = [];
      const sessions = tabSessions();
      for (let i = 0; i < sessions.length; i++) {
        const sid = sessions[i];
        const info = await evalIn(c, '({ url: location.href, title: document.title })', sid === null ? undefined : sid);
        out.push({
          index: i,
          url: (info && info.url) || '(unknown)',
          title: (info && info.title) || '',
          active: (activeSession || openerSession || null) === sid
        });
      }
      return out;
    }
    async function selectTab(index) {
      const sessions = tabSessions();
      const i = Number(index);
      if (!Number.isInteger(i) || i < 0 || i >= sessions.length) throw new Error('no such tab: ' + index + ' (there are ' + sessions.length + ')');
      activeSession = sessions[i];
      const c = await page();
      /* Intercept and emulation are session-scoped in CDP but run-scoped in intent: a tab adopted
         after they were set (a popup, a target=_blank checkout) has neither. Re-applying on focus is
         what keeps "block images" true on the tab the agent is actually driving. */
      if (interceptKinds.length) { try { await applyIntercept(c); } catch (_) {} }
      if (emulation) { try { await applyEmulation(c); } catch (_) {} }
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return (await evalIn(c, 'location.href')) || '(unknown)';
    }
    async function closeTab(index) {
      const sessions = tabSessions();
      const i = Number(index);
      if (i === 0) throw new Error('the first tab cannot be closed');
      if (!Number.isInteger(i) || i < 0 || i >= sessions.length) throw new Error('no such tab: ' + index);
      const sid = sessions[i];
      const targetId = pageSessions.get(sid);
      pageSessions.delete(sid);
      if (activeSession === sid) activeSession = null;   // never leave the driver on a dead session   // never leave the driver on a dead session
      const c = await connect();
      if (targetId) { try { await c.send('Target.closeTarget', { targetId }); } catch (_) {} }
      return 'closed tab ' + i;
    }
    async function forward() {
      await evalJS('history.forward()');
      await waitForSettle(await page(), { budgetMs: settleNavBudgetMs, fallbackMs: 500 });
      return evalJS('location.href');
    }
    /* FILE UPLOAD. Without DOM.setFileInputFiles any form with an attachment step is a dead end.
       The ref usually points at a styled LABEL, because real file inputs are routinely hidden — so
       resolve from the click point to the actual <input type=file> (self, the label's control, or the
       nearest one in the same container) and hand CDP that element's objectId. Paths are resolved and
       jail-checked by the caller; this only ever sees absolute paths. */
    async function upload(node, absPaths) {
      const c = await page();
      await c.send('DOM.enable');
      const p = center(node);
      const r = await c.send('Runtime.evaluate', { expression: `(() => {
        const el = document.elementFromPoint(${p.x}, ${p.y});
        if (!el) return null;
        if (el.tagName === 'INPUT' && el.type === 'file') return el;
        if (el.control && el.control.tagName === 'INPUT' && el.control.type === 'file') return el.control;
        const lbl = el.closest && el.closest('label');
        if (lbl && lbl.control && lbl.control.type === 'file') return lbl.control;
        const scope = (el.closest && el.closest('form,fieldset,section,div')) || document;
        return scope.querySelector('input[type=file]');
      })()` });
      const objectId = r && r.result && r.result.objectId;
      if (!objectId) throw new Error('no file input found at this ref — snapshot the page and pick the upload control');
      await c.send('DOM.setFileInputFiles', { files: absPaths, objectId });
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return absPaths.length + ' file(s) attached';
    }
    async function testInput(action) {
      const a = Object.assign({}, action || {});
      const c = await page();
      const kind = String(a.action || '');
      const code = String(a.key || a.code || '');
      const key = code.indexOf('Key') === 0 ? code.slice(3).toLowerCase()
        : code.indexOf('Digit') === 0 ? code.slice(5) : (code || '');
      if (kind === 'key_down' || kind === 'key_up') {
        await c.send('Input.dispatchKeyEvent', { type: kind === 'key_down' ? 'keyDown' : 'keyUp', key, code });
        return kind + ' ' + code;
      }
      if (kind === 'key_press') {
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
        if (/^Escape$/i.test(code || key)) await evalJS('document.exitPointerLock()');
        return 'key_press ' + code;
      }
      const x = Number(a.x) || 0, y = Number(a.y) || 0;
      const button = String(a.button || 'left');
      if (kind === 'mouse_move' && (a.dx != null || a.dy != null)) {
        // Pointer lock is emulated, so synthesize relative motion in the page realm. The game
        // receives movementX/Y while no platform cursor exists to confine or warp.
        const dx = Number(a.dx) || 0, dy = Number(a.dy) || 0;
        await evalJS(`(() => {
          const s=${inputStateExpr};
          if(!s||!s.ready) throw new Error('synthetic input isolation is not active');
          const e=new MouseEvent('mousemove',{bubbles:true,clientX:${JSON.stringify(x)},clientY:${JSON.stringify(y)}});
          Object.defineProperty(e,'movementX',{value:${JSON.stringify(dx)}});
          Object.defineProperty(e,'movementY',{value:${JSON.stringify(dy)}});
          (s.pointer||document).dispatchEvent(e);
        })()`);
        return 'mouse_move relative ' + dx + ',' + dy;
      }
      if (kind === 'mouse_move') {
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        return 'mouse_move ' + x + ',' + y;
      }
      if (kind === 'mouse_down' || kind === 'mouse_up') {
        await c.send('Input.dispatchMouseEvent', { type: kind === 'mouse_down' ? 'mousePressed' : 'mouseReleased', x, y, button, clickCount: 1 });
        return kind + ' ' + button;
      }
      if (kind === 'click') {
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
        return 'click ' + x + ',' + y;
      }
      throw new Error('unsupported synthetic browser input action: ' + kind);
    }
    async function testEval(expression) { return evalJS(String(expression || '')); }
    async function testState(selector) {
      const sel = selector == null ? 'null' : JSON.stringify(String(selector));
      return evalJS(`(() => {
        const s=${inputStateExpr};
        const q=${sel}; const el=q?document.querySelector(q):null;
        let element=null;
        if(q){
          const r=el&&el.getBoundingClientRect();
          element={exists:!!el,tag:el&&el.tagName||null,text:el&&String(el.innerText||el.textContent||'').trim().slice(0,4000),value:el&&'value'in el?String(el.value).slice(0,1000):null,visible:!!(r&&r.width>0&&r.height>0),className:el&&String(el.className||'').slice(0,1000)};
        }
        return {url:location.href,title:document.title,syntheticReady:!!(s&&s.ready),popupBlocked:!!(s&&s.popupBlocked),pointerLockTag:document.pointerLockElement&&document.pointerLockElement.tagName||null,element};
      })()`);
    }
    // Scrolling is what triggers lazy-load / infinite-scroll, so it settles too — otherwise the very
    // content the scroll was meant to reveal is missing from the next snapshot.
    async function scroll(x, y) {
      const c = await page();
      const totalX = Number(x) || 0, totalY = Number(y) || 0;
      const steps = inputBetween(3, 6);
      let sentX = 0, sentY = 0;
      for (let i = 1; i <= steps; i++) {
        const nextX = Math.round(totalX * i / steps), nextY = Math.round(totalY * i / steps);
        await c.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: pointer.x, y: pointer.y,
          deltaX: nextX - sentX, deltaY: nextY - sentY
        });
        sentX = nextX; sentY = nextY;
        if (i < steps) await inputPause(20, 55);
      }
      await waitForSettle(c, { budgetMs: settleActionBudgetMs });
      return 'scrolled';
    }
    async function back() {
      await evalJS('history.back()');
      await waitForSettle(await page(), { budgetMs: settleNavBudgetMs, fallbackMs: 500 });
      return evalJS('location.href');
    }
    async function getText(selector) {
      const sel = selector ? jsLiteral(String(selector)) : 'null';
      // Same-origin frames are appended for the same reason snapshot walks them: their content is
      // invisible to a top-document read even though the agent can see it on screen.
      const expr = `(() => {
        const pick = doc => { const el = ${sel} ? doc.querySelector(${sel}) : doc.body; return (el && (el.innerText || el.textContent) || '').replace(/\\s+\\n/g, '\\n').trim(); };
        const parts = [pick(document)];
        let n = 0;
        for (const f of document.querySelectorAll('iframe,frame')) {
          let sub = null;
          try { sub = f.contentDocument; } catch (e) { sub = null; }
          if (!sub) continue;
          const t = pick(sub);
          if (t) parts.push('\\n--- frame ' + (++n) + ' ---\\n' + t);
        }
        return parts.join('').trim();
      })()`;
      const c = await page();
      const parts = [String((await evalIn(c, expr)) || '')];
      // Read adopted iframes too. A consent wall, a payment form or an SSO login is routinely the
      // ONLY meaningful text on the page and lives entirely inside a frame — reading just the top
      // document returns an empty-looking page and the agent concludes there is nothing there.
      let frameNo = 0;
      for (const [sid] of frameSessions) {
        frameNo++;
        const t = String((await evalIn(c, expr, sid)) || '').trim();
        if (t) parts.push('\n--- frame ' + frameNo + ' ---\n' + t);
      }
      return parts.join('').trim();
    }
    async function challengeStatus() {
      const pageState = await evalJS(`(() => ({
        title: String(document.title || '').slice(0, 300),
        text: String(document.body && (document.body.innerText || document.body.textContent) || '').trim().slice(0, 1200)
      }))()`);
      const detected = Challenge.detectChallenge(pageState || {});
      return Object.assign({ title: pageState && pageState.title || '' }, detected);
    }
    async function readConsoleLog() {
      const c = await page();
      const sessionKey = activeSession || openerSession || '__root__';
      if (!runtimeConsoleSessions.has(sessionKey)) {
        await c.send('Runtime.enable', {});
        runtimeConsoleSessions.add(sessionKey);
        // Runtime.enable flushes buffered console entries asynchronously. Give that bounded protocol
        // delivery one turn before reading the local ring.
        await sleep(20);
      }
      return consoleLog.slice();
    }

    /* waitFor — poll a NAMED condition until it holds or the budget expires.

       This is the piece that was missing. Every action already auto-settles, but settling answers "has the
       page stopped changing", not "has the thing I am waiting for happened". A result list that arrives
       800ms after an XHR, a spinner that clears, a redirect that lands — the agent's only previous options
       were to re-snapshot in a loop or guess a sleep, and a guessed sleep is why agent browsing is flaky.

       The predicate is BUILT HERE from structured parameters and every model-supplied string goes through
       jsLiteral. The model never supplies the expression — browser.eval is the deliberate, profile-gated
       door for that, and this must not become a second one that bypasses its credential check.

       Returns {ok, hit, ms, url, error} and NEVER throws on a timeout: "the condition did not become true"
       is a real, useful answer that the agent must be able to act on, not a tool failure. */
    async function waitFor(cond, budgetMs) {
      cond = cond || {};
      const sel = cond.selector ? jsLiteral(String(cond.selector)) : null;
      const txt = cond.text != null && cond.text !== '' ? jsLiteral(String(cond.text)) : null;
      const inUrl = cond.urlContains ? jsLiteral(String(cond.urlContains)) : null;
      const gone = cond.gone === true;
      if (!sel && !txt && !inUrl) throw new Error('browser.wait needs one of: selector, text, urlContains');
      /* A "visible" element is not merely present: a display:none node, a zero-box node and a node inside a
         collapsed parent all match querySelector while being invisible to the user. Waiting for presence
         alone is how an agent proceeds into a still-hidden dialog. offsetParent covers the display chain;
         the rect check covers the zero-size case. */
      const expr = `(() => {
        try {
          const vis = el => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (!r || (r.width <= 0 && r.height <= 0)) return false;
            const s = window.getComputedStyle ? getComputedStyle(el) : null;
            if (s && (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0')) return false;
            return el.offsetParent !== null || (s && s.position === 'fixed');
          };
          let hit = true;
          ${sel ? `hit = hit && Array.prototype.some.call(document.querySelectorAll(${sel}), vis);` : ''}
          ${txt ? `hit = hit && ((document.body ? (document.body.innerText || '') : '').indexOf(${txt}) >= 0);` : ''}
          ${inUrl ? `hit = hit && (location.href.indexOf(${inUrl}) >= 0);` : ''}
          return { ok: true, hit: ${gone ? '!hit' : 'hit'}, url: location.href };
        } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`;
      const budget = Math.max(250, Math.min(WAIT_MAX_MS, Number(budgetMs || WAIT_DEFAULT_MS)));
      // Timer, not a clock read — the determinism law bans ambient time in backend logic, and elapsed
      // time is reported from the poll count so the number stays honest without reading a clock.
      let expired = false;
      const timer = setTimeout(() => { expired = true; }, budget);
      let polls = 0;
      try {
        for (;;) {
          const c = await page();
          let probe = null;
          try {
            const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
            probe = r && r.result && r.result.value;
          } catch (e) { probe = null; }
          // A THROWN predicate is a bad selector, not a false condition. Saying so immediately beats
          // burning the whole budget and then reporting a timeout the agent would misread as "not there".
          if (probe && probe.ok === false) return { ok: false, hit: false, ms: polls * WAIT_POLL_MS, error: probe.error };
          if (probe && probe.hit === true) return { ok: true, hit: true, ms: polls * WAIT_POLL_MS, url: probe.url || '' };
          if (expired) return { ok: true, hit: false, ms: budget, url: (probe && probe.url) || '', timedOut: true };
          polls++;
          await sleep(WAIT_POLL_MS);
        }
      } finally { clearTimeout(timer); }
    }
    async function handleDialog(action, promptText) {
      const c = await page();
      await c.send('Page.handleJavaScriptDialog', { accept: action !== 'dismiss', promptText: promptText || '' });
      const d = dialog; dialog = null; return d || { type: 'none', message: '' };
    }
    async function screenshot() {
      const c = await page();
      const r = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      return r.data || '';
    }
    async function close() {
      const owned = proc, waitForClose = procClosePromise;
      async function exitedWithin(ms) {
        if (!waitForClose) return false;
        let timer;
        try { return await Promise.race([waitForClose, new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
        finally { clearTimeout(timer); }
      }
      // Only OUR persistent browser: a forced kill can lose newly written login cookies. Browser.close
      // flushes Chromium's profile stores. An attached user browser has no owned process and is never closed.
      let exited = false;
      if (owned && cdp && deps.profileIsPersistent) {
        let timer;
        try {
          await Promise.race([cdp.send('Browser.close').catch(swallow('browser.profile.close')), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        } finally { clearTimeout(timer); }
        exited = await exitedWithin(2000);
      }
      try { cdp && cdp.close(); } catch (_) {}
      try { if (owned && !exited) owned.kill('SIGKILL'); } catch (_) {}
      cdp = null; proc = null;
      if (owned && waitForClose && !exited) {
        exited = await exitedWithin(3000);
        if (!exited) throw new Error('owned Chromium did not exit after synthetic test session closed');
      }
      if (deps.cleanupProfile === true) { try { FS.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {} }
    }
    // visible() is the TRUTH the model reports: true only if the controlled window is
    // actually on the user's screen. Headless mode, or a headless-only binary fallback in
    // a headed request, both read as not visible.
    function visible() { return headed; }
    return { navigate, snapshot, click, type, press, hover, drag, selectOption, viewport, forward, upload, tabs, waitForTabCount, selectTab, closeTab, inspect, evalPublic, waitFor, pdf, intercept, emulate, usingPersistentProfile: () => !!deps.profileIsPersistent, testInput, testEval, testState, scroll, back, getText, challengeStatus, handleDialog, screenshot, close, consoleLog: readConsoleLog, networkLog: () => netLog.map(r => Object.assign({}, r)), lastDialog: () => dialog, lastResponse: () => lastResponse, visible, headed, headlessFallback: wantHeaded && binIsHeadlessOnly, attachedPort: () => attachedPort, profileDir };
  }

  function makeBrowserSession(deps) {
    deps = deps || {};
    let driver = deps.driver || null;
    const injected = !!deps.driver;            // a test-injected driver never mode-switches
    const makeDriver = deps.makeDriver || makeCdpDriver;   // seam so tests can observe the headed flag
    let driverHeaded = null;                    // the REAL driver's current mode (null = none yet)
    let teardownFailure = null;                 // fail-closed latch: a possibly-live headed driver is never reusable
    let version = 0, seq = 0, localMode = false, localOrigin = null;
    /* navEpoch is deliberately NOT `version`. `version` bumps on every snapshot AND every navigation, so it
       cannot distinguish the two — and the difference decides whether a stale ref may be RECOVERED.
       Re-snapshotting the same page only renumbers refs, so re-finding "the Submit button" is the same
       button. A NAVIGATION replaces the document, where the same role+text is a DIFFERENT control on a
       different page — recovering across it would click something the agent never saw. So refs remember
       the epoch they were minted in, and recovery refuses across an epoch change. */
    let navEpoch = 0;
    const refs = new Map();
    // ATTENDED LOGIN (persistent profile): deps.persistentProfile = { dir, acquire(), release() } names the
    // ONE durable station browser profile (cookies survive run end and sidecar restarts). acquire/release is
    // an in-process single-owner lease supplied by the host — Chrome cannot share a user-data-dir between
    // processes, and one-sidecar-per-save-dir is a hard invariant, so an in-process lease is sufficient.
    // Ordinary tools wait for this profile; contention must never change account/session identity.
    let leaseHeld = false;
    /* ATTACH state. Sticky for the life of the session: once a run has driven the Commander's own browser
       it must not be able to quietly drop back to "ordinary headless" and re-open the eval door — the
       credentials it was exposed to do not un-expose themselves. Cleared only by detach(), which tears the
       driver down. */
    let attachedToUserBrowser = false, attachedUserPort = null;
    function acquirePersistent() {
      // While attached to the Commander's own Chrome the station profile is not in play at all; taking its
      // single-owner lease would block a concurrent run from a browser this one is not using.
      if (attachedToUserBrowser) return false;
      const pp = deps.persistentProfile;
      if (!pp || !pp.dir || typeof pp.acquire !== 'function') return false;
      if (leaseHeld) return true;
      try { leaseHeld = pp.acquire() === true; } catch (_) { leaseHeld = false; }
      return leaseHeld;
    }
    function profileDeps() {
      // cleanupProfile:false is load-bearing — the durable profile must never ride the ephemeral rm on close.
      if (acquirePersistent()) return { profileDir: deps.persistentProfile.dir, cleanupProfile: false, profileIsPersistent: true };
      if (deps.persistentProfile && !attachedToUserBrowser) throw new Error('the station browser profile is in use by another agent run — retry after it finishes; saved logins were not replaced');
      return { profileIsPersistent: false };
    }
    async function waitForProfile(signal) {
      if (!deps.persistentProfile || attachedToUserBrowser || leaseHeld) return;
      const limit = deps.profileWaitMs == null ? 8000 : Math.max(0, Math.min(8000, deps.profileWaitMs));
      let reported = false;
      try {
      for (let elapsed = 0; ; elapsed += 100) {
        if (signal && signal.aborted) throw new Error('browser session wait cancelled');
        if (acquirePersistent()) return;
        if (!reported && typeof deps.onProfileWait === 'function') { deps.onProfileWait(true); reported = true; }
        if (elapsed >= limit) throw new Error('the station browser profile is in use by another agent run — retry after it finishes; saved logins were not replaced');
        await new Promise((resolve, reject) => {
          const done = () => { if (signal) signal.removeEventListener('abort', cancel); resolve(); };
          const timer = setTimeout(done, 100);
          const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new Error('browser session wait cancelled')); };
          if (signal) signal.addEventListener('abort', cancel, { once: true });
        });
      }
      } finally { if (reported) deps.onProfileWait(false); }
    }
    function releasePersistent() {
      const pp = deps.persistentProfile;
      if (leaseHeld && pp && typeof pp.release === 'function') { try { pp.release(); } catch (_) {} }
      leaseHeld = false;
    }
    /* ensureDriver(wantVisible):
         undefined  -> reuse whatever is running (or start HEADLESS — the default posture).
         false/true -> if the running driver's mode differs, RELAUNCH in the requested mode on the same
                       profile dir (cookies/logins survive the swap). Headless is the default; a visible
                       window exists only while the Commander asked for one. */
    function wantedHeaded(wantVisible) {
      return deps.forceHeadless === true ? false
        : (wantVisible === undefined ? (driverHeaded === null ? false : driverHeaded)
          : (!!wantVisible && !headlessRequested(deps.env) && deps.headless !== true));
    }
    function ensureDriver(wantVisible) {
      if (teardownFailure) throw teardownFailure;
      const headed = wantedHeaded(wantVisible);
      if (driver) {
        /* An ATTACHED session never mode-switches. The relaunch below rebuilds the driver WITHOUT
           attachPort, so honouring a headless request here would silently drop the Commander's browser and
           substitute a station one — the agent would go on clicking, in the wrong browser, signed into
           nothing, and nothing in the transcript would say so. Detaching is explicit or not at all. */
        if (attachedToUserBrowser) return driver;
        if (injected || wantVisible === undefined || driverHeaded === headed) return driver;
        // Every real mode switch is asynchronous because close() waits for the same-profile Chrome process.
        // Callers with an explicit mode must use ensureDriverMode(), which awaits that teardown.
        throw new Error('browser mode switch requires awaited teardown');
      }
      driver = makeDriver(Object.assign({}, deps, profileDeps(), { headed }));
      driverHeaded = headed;
      return driver;
    }
    // Tear down the current driver and relaunch with explicit overrides on the SAME persistent profile
    // (cookies survive the swap). Injected test drivers never mode-switch — the flow still runs so the
    // consent contract is testable, but the driver object stays the same.
    async function relaunch(overrides) {
      if (injected) return driver;
      if (teardownFailure) throw teardownFailure;
      // A rejected close means the old browser may still own the persistent profile. Keep its reference and
      // surface the failure; constructing a replacement here risks profile corruption and a false success.
      // The reference is cleared BEFORE propagating so a later mode-less call cannot reconnect that headed,
      // unshimmed driver. The latch blocks every later action in this run rather than spawning against a profile
      // whose ownership is now unknown.
      if (driver) {
        const closing = driver;
        try { await closing.close(); }
        catch (e) {
          driver = null; driverHeaded = null; version++;
          teardownFailure = e instanceof Error ? e : new Error(String(e || 'browser teardown failed'));
          throw teardownFailure;
        }
        driver = null; driverHeaded = null;
      }
      driver = makeDriver(Object.assign({}, deps, profileDeps(), overrides));
      driverHeaded = !!overrides.headed;
      version++;   // any element refs belong to the torn-down browser
      return driver;
    }
    async function ensureDriverMode(wantVisible) {
      const headed = wantedHeaded(wantVisible);
      if (!driver) return ensureDriver(wantVisible);
      if (attachedToUserBrowser || injected || driverHeaded === headed) return driver;
      return relaunch({ headed });
    }
    function refFor(node) {
      const ref = 'b' + (++seq);
      refs.set(ref, { version, navEpoch, node });
      return ref;
    }
    function requireRef(ref) {
      const r = refs.get(String(ref || ''));
      if (!r) throw new Error('unknown browser ref: ' + ref + ' (take a fresh browser.snapshot)');
      if (r.version !== version) throw new Error('stale browser ref: ' + ref + ' (refs expire after each browser.snapshot)');
      return r.node;
    }
    /* STALE-REF RECOVERY. The single most common way an agent browser run dies: snapshot, act, act again —
       and the second act fails because something re-snapshotted in between, so every ref the agent is
       holding went stale at once. The page did not change; only our numbering did. Re-snapshot and re-find
       the SAME element by its identity (role + text), then act on it.

       Deliberately conservative, because this recovers a MUTATING action:
         · refuses across a navigation (see navEpoch above),
         · requires a UNIQUE role+text match — ambiguity fails loudly and names the candidates rather than
           guessing which "Delete" the agent meant,
         · never silent. The caller reports that it recovered, because an action the agent believes it aimed
           at ref b7 and which actually landed on a re-found node is a different claim. */
    function nodeIdentity(n) {
      return (n && n.role ? String(n.role) : '') + '\u0000' + String((n && n.text) || '').trim().slice(0, 120);
    }
    async function withRefRecovery(refList, act) {
      const list = Array.isArray(refList) ? refList : [refList];
      try { return { out: await act(list.map(requireRef)), recovered: false }; }
      catch (e) {
        // Only a STALE ref is recoverable - an unknown one was never minted here, so there is nothing to
        // re-find, and a genuine failure thrown by act() must propagate untouched.
        if (!/^stale browser ref/.test(String(e && e.message))) throw e;
        const known = list.map(r => refs.get(String(r || '')));
        if (known.some(k => !k)) throw e;
        if (known.some(k => k.navEpoch !== navEpoch)) {
          throw new Error('stale browser ref: ' + list.join('/') + ' - the page navigated since that snapshot, '
            + 'so it points at the previous page. Take a fresh browser.snapshot.');
        }
        const wants = known.map(k => nodeIdentity(k.node));
        if (wants.some(w => !w.replace(/ /g, '').trim())) throw e;   // an unlabelled node: nothing to match on
        /* ONE re-snapshot resolves EVERY ref in the call. Snapshotting per-ref would invalidate the refs
           resolved by the previous pass - which is exactly what makes a two-ref drag unrecoverable. */
        const fresh = await snapshot(SNAP_DEFAULT);
        const nodes = [];
        for (let i = 0; i < list.length; i++) {
          const hits = fresh.filter(n => nodeIdentity(n) === wants[i]);
          if (!hits.length) {
            throw new Error('stale browser ref: ' + list[i] + ' - it was ' + describeNode(known[i].node)
              + ', which is no longer on the page. Take a fresh browser.snapshot.');
          }
          if (hits.length > 1) {
            throw new Error('stale browser ref: ' + list[i] + ' - ' + hits.length + ' elements now match '
              + describeNode(known[i].node) + ' (' + hits.map(h => h.ref).join(', ') + '), so which one you '
              + 'meant is ambiguous. Take a fresh browser.snapshot and pick one.');
          }
          nodes.push(requireRef(hits[0].ref));
        }
        return { out: await act(nodes), recovered: true };
      }
    }
    function describeNode(n) {
      return '[' + ((n && n.role) || 'element') + ']' + ((n && n.text) ? ' "' + String(n.text).slice(0, 60) + '"' : '');
    }
    // DNS-rebinding resolver for PUBLIC navigation (never for the loopback test tool, which is an explicit
    // allowlist). Defaults to real Node DNS; deps.lookup === null disables it for rigs/tests.
    const doLookup = ('lookup' in deps) ? deps.lookup : nodeLookup;
    async function navigate(url, opts) {
      opts = opts || {};
      const local = opts.local === true;
      const validate = local ? assertLoopbackUrl : assertSafeUrl;
      const u = validate(url);
      if (!local) await assertResolvedSafe(u, doLookup);   // refuse names that RESOLVE private (rebinding)
      const wantedMode = local ? false : ('visible' in opts ? !!opts.visible : undefined);
      const d = wantedMode === undefined ? ensureDriver() : await ensureDriverMode(wantedMode);
      const finalUrl = await d.navigate(u.href);
      if (finalUrl) {
        try {
          validate(finalUrl);
          // the post-redirect host must clear the SAME resolution bar as the one we asked for
          if (!local) await assertResolvedSafe(new URL(finalUrl), doLookup);
        } catch (e) {
          try { await d.navigate('about:blank'); } catch (_) {}
          throw new Error('blocked unsafe redirect: ' + e.message);
        }
      }
      if (local && new URL(finalUrl || u.href).origin !== u.origin) {
        try { await d.navigate('about:blank'); } catch (_) {}
        throw new Error('blocked local redirect outside the owned server origin');
      }
      localMode = local;
      localOrigin = local ? u.origin : null;
      version++;
      navEpoch++;   // a new document: every existing ref is now unrecoverable, not merely renumbered
      return finalUrl || u.href;
    }
    // A driver predating this accessor (an injected test fake) simply reports no status.
    function lastResponse() {
      const d = driver;
      return (d && typeof d.lastResponse === 'function') ? d.lastResponse() : null;
    }
    async function snapshot(limit) {
      const nodes = await ensureDriver().snapshot(limit);
      version++;
      const out = (nodes || []).map(n => Object.assign({}, n, { ref: refFor(n) }));
      return out;
    }
    /* Every ref-taking ACTION runs through recovery. The disclosure is appended to the driver's own answer
       rather than swallowed: the agent asked to act on ref b7 and we acted on a node we re-found, so it has
       to be able to see that happened — a silent recovery is the tool quietly changing the target. */
    async function actOnRef(refList, run) {
      const { out, recovered } = await withRefRecovery(refList, ns => run.apply(null, ns));
      if (!recovered) return out;
      const which = Array.isArray(refList) ? refList.join('/') : refList;
      const note = ' (ref ' + which + ' had gone stale; re-found the same element by role and text on the same page)';
      // selectOption/inspect answer with an OBJECT the tool layer destructures; appending a string to that
      // would turn a structured answer into "[object Object]...". Carry the disclosure as a field instead.
      return (out && typeof out === 'object') ? Object.assign({}, out, { recovered: true }) : String(out) + note;
    }
    async function click(ref) { const d = ensureDriver(); return actOnRef(ref, n => d.click(n)); }
    async function type(ref, text) { const d = ensureDriver(); return actOnRef(ref, n => d.type(n, text)); }
    async function press(key) { return ensureDriver().press(key); }
    // A driver that predates one of these (an injected fake) says so plainly instead of throwing a
    // TypeError the agent cannot interpret.
    function driverFn(d, name) {
      if (typeof d[name] !== 'function') throw new Error('browser.' + name + ' is unavailable in this driver');
      return d[name].bind(d);
    }
    async function hover(ref) { const d = ensureDriver(); return actOnRef(ref, n => driverFn(d, 'hover')(n)); }
    // drag takes TWO refs. Recovering one while the other is stale would act on a half-current pair, so the
    // destination is resolved inside the source's recovery — either both are valid together, or it fails.
    async function drag(fromRef, toRef) { const d = ensureDriver(); return actOnRef([fromRef, toRef], (a, b) => driverFn(d, 'drag')(a, b)); }
    async function selectOption(ref, value) { const d = ensureDriver(); return actOnRef(ref, n => driverFn(d, 'selectOption')(n, value)); }
    async function viewport(width, height, opts) {
      const d = ensureDriver();
      const out = await driverFn(d, 'viewport')(width, height, opts || {});
      version++;   // a resize relays the page: every ref from the previous layout is now meaningless
      return out;
    }
    async function forward() { const d = ensureDriver(); version++; navEpoch++; return driverFn(d, 'forward')(); }
    async function upload(ref, absPaths) { const d = ensureDriver(); return actOnRef(ref, n => driverFn(d, 'upload')(n, absPaths)); }
    async function inspect(ref) { const d = ensureDriver(); return actOnRef(ref, n => driverFn(d, 'inspect')(n)); }
    // wait() is READ-ONLY and takes no ref, so it needs no recovery — it is the tool an agent reaches for
    // precisely when it does NOT yet know what is on the page.
    async function wait(cond, budgetMs) { return driverFn(ensureDriver(), 'waitFor')(cond, budgetMs); }
    /* find(query) — snapshot the current viewport, then keep only what matches.

       WHY IT IS NOT JUST "snapshot with a bigger limit". A real page routinely carries hundreds of
       VISIBLE interactive elements; browser.snapshot caps at 80 by default and 200 at most. On a dense
       viewport the one link the agent wants may simply not be IN the list. This scans at the driver's
       maximum and returns only the hits, which costs a fraction of the tokens and answers the question
       the agent actually had. It deliberately does not claim to scan off-screen or hidden controls:
       returned refs must describe elements the driver can act on at their reported coordinates.

       It mints refs and bumps `version` exactly like a snapshot, because it IS a fresh DOM read; refs from
       before it are stale (and recoverable under the same rules). */
    async function find(query, limit) {
      const q = String((query && query.text) || '').trim().toLowerCase();
      const role = String((query && query.role) || '').trim().toLowerCase();
      if (!q && !role) throw new Error('browser.find needs text or role to match on');
      const nodes = await ensureDriver().snapshot(FIND_SCAN_CAP);
      version++;
      const hits = [];
      for (const n of (nodes || [])) {
        if (role && String(n.role || '').toLowerCase() !== role) continue;
        if (q && String(n.text || '').toLowerCase().indexOf(q) < 0) continue;
        hits.push(Object.assign({}, n, { ref: refFor(n) }));
        if (hits.length >= Math.max(1, Math.min(50, Number(limit || 20)))) break;
      }
      // `scanned` and `capped` describe the VISIBLE scan only. A below-fold or closed-menu control is not in
      // `nodes`, so even an uncapped zero must never be promoted into a whole-document absence claim.
      return { hits, scanned: (nodes || []).length, capped: (nodes || []).length >= FIND_SCAN_CAP };
    }
    // pdf() is a READ of the current document — allowed everywhere, including attached mode, where
    // "print the page you are looking at" is exactly as safe as get_text on it.
    async function pdf(opts) { return driverFn(ensureDriver(), 'pdf')(opts || {}); }
    /* intercept/emulate are refused while ATTACHED, and the reason is ownership, not risk arithmetic:
       the Commander's own Chrome is not the station's to reconfigure. Blocking resource loads or
       spoofing device/language/timezone inside their real signed-in browser changes what THEY see and
       how sites treat THEM, in ways that outlast the agent's attention. The station browser exists for
       exactly this kind of reshaping. */
    async function intercept(kinds) {
      if (attachedToUserBrowser) throw new Error('browser.intercept is refused while attached to your own Chrome — your real browser is not the station\'s to reconfigure. Detach first, or use the station browser.');
      // Validated HERE so a bad kind fails loudly on every driver, including injected test drivers.
      const list = (Array.isArray(kinds) ? kinds : []).map(k => String(k || '').trim().toLowerCase()).filter(Boolean);
      const bad = list.filter(k => !INTERCEPT_TYPES[k]);
      if (bad.length) throw new Error('browser.intercept: unknown kind(s): ' + bad.join(', ') + ' (supported: ' + Object.keys(INTERCEPT_TYPES).join(', ') + ')');
      return driverFn(ensureDriver(), 'intercept')(Array.from(new Set(list)));
    }
    async function emulate(opts) {
      if (attachedToUserBrowser) throw new Error('browser.emulate is refused while attached to your own Chrome — spoofing device, language or timezone inside your real signed-in browser is not the station\'s to do. Detach first, or use the station browser.');
      const out = await driverFn(ensureDriver(), 'emulate')(opts || null);
      version++;   // metric/UA changes relay the page: refs from the previous layout are meaningless
      return out;
    }
    /* attach(port) — drive the Commander's OWN already-running Chrome instead of a station-launched one.

       WHY THIS AND NOT A STEALTH ENGINE. The practical wall in agent browsing is not that a headless
       browser cannot click; it is that a fresh headless profile is signed into nothing and looks like
       exactly what it is. The other answer to that is a fingerprint-spoofing build. This one is better on
       every axis that matters: it IS a real browser with a real profile and the Commander's real sessions,
       it needs no 300MB download or side-car server, and it involves no deception.

       WHAT IT COSTS, STATED PLAINLY: every login the Commander has. That is why eval is refused above,
       why the tool requires consent, and why we never kill the process on close. */
    async function attach(port) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('browser.attach: port must be an integer 1-65535');
      // Probing BEFORE the relaunch means a wrong port reports "nothing is listening" while the run still
      // has its previous browser, instead of tearing down a working session to discover the port is dead.
      const probe = await probeDevTools(p);
      if (!probe.ok) throw new Error(probe.error);
      if (leaseHeld) releasePersistent();   // never hold the station profile lease while driving another browser
      /* Set BEFORE the relaunch, not after: relaunch() calls profileDeps(), which would otherwise re-acquire
         the very lease just released — pinning the station profile for a run that is not even using it. */
      attachedToUserBrowser = true;
      attachedUserPort = p;
      await relaunch({ attachPort: p, headed: true });
      version++; navEpoch++;               // a different browser entirely: every ref is dead
      return probe;
    }
    async function probeDevTools(port) {
      const f = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
      if (!f) return { ok: false, error: 'browser.attach: this runtime has no fetch' };
      try {
        // 127.0.0.1 ONLY, never a hostname and never the LAN. A DevTools endpoint is unauthenticated
        // remote code execution over the browser — reaching one on another machine is not a feature.
        const r = await f('http://127.0.0.1:' + port + '/json/version');
        const v = await r.json();
        if (!v || !v.webSocketDebuggerUrl) {
          return { ok: false, error: 'browser.attach: something is listening on 127.0.0.1:' + port + ' but it is not a Chrome DevTools endpoint.' };
        }
        return { ok: true, browser: String(v.Browser || 'Chrome'), port: port };
      } catch (e) {
        return { ok: false, error: 'browser.attach: nothing is listening on 127.0.0.1:' + port + '. Use browser.login for a saved StarNet session. Advanced attachment requires Chrome launched with --remote-debugging-port=' + port + ' and a separate --user-data-dir; current Chrome does not expose its default profile this way.' };
      }
    }
    async function detach() {
      if (!attachedToUserBrowser) return 'Not attached; nothing to detach.';
      const port = attachedUserPort;
      // Drop the CDP socket WITHOUT killing the browser: driver.close() only kills a process it spawned,
      // and in attach mode there is none.
      try { if (driver && driver.close) await driver.close(); } catch (_) {}
      driver = null; driverHeaded = null;
      attachedToUserBrowser = false; attachedUserPort = null;
      version++; navEpoch++;
      return 'Detached from your Chrome on port ' + port + '. It is still running and untouched; later browser actions use the station browser again.';
    }
    /* THE GATE. Refuse page eval whenever this run is driving the PERSISTENT profile, because that
       profile carries the Commander's real logged-in sessions (browser.login put them there). On the
       ephemeral profile there is nothing to steal, so the same call is fine. */
    function evalAllowed() {
      /* ATTACHED to the Commander's OWN Chrome is the strictest case there is, and it comes first. The
         station's persistent profile holds the logins the Commander chose to give the agent; their real
         browser holds EVERY login they have — bank, email, employer SSO. The existing law is "eval is
         dangerous WHERE THE CREDENTIALS ARE", and this is where they all are. */
      if (attachedToUserBrowser) return { ok: false, reason: 'this run is attached to your own Chrome' };
      if (leaseHeld) return { ok: false, reason: 'this run is using the signed-in station profile' };
      const d = driver;
      if (d && typeof d.usingPersistentProfile === 'function' && d.usingPersistentProfile()) {
        return { ok: false, reason: 'this run is using the signed-in station profile' };
      }
      return { ok: true };
    }
    async function evalPublic(expression) {
      const gate = evalAllowed();
      if (!gate.ok) throw new Error('browser.eval is refused: ' + gate.reason + ', and arbitrary page ' +
        'script there could read the cookies and storage of accounts you are signed into. Use ' +
        'browser.inspect for computed styles/attributes/shadow DOM, browser.get_text for content, or ' +
        'browser.test_eval on your own localhost server.');
      const d = ensureDriver();
      return driverFn(d, 'evalPublic')(expression);
    }
    async function tabs() { const d = ensureDriver(); return driverFn(d, 'tabs')(); }
    // Switching tabs points every subsequent tool at a DIFFERENT document, so refs from the old one
    // must die — a ref silently re-aimed at another page is the worst outcome available here.
    // A tab switch is a different DOCUMENT, exactly like a navigation — refs minted on tab 0 must never be
    // recoverable against tab 2's page, so this bumps the epoch and not just the ref version.
    async function selectTab(i) { const d = ensureDriver(); const out = await driverFn(d, 'selectTab')(i); version++; navEpoch++; return out; }
    async function closeTab(i) { const d = ensureDriver(); const out = await driverFn(d, 'closeTab')(i); version++; return out; }
    async function requireLocalDriver() {
      if (!localMode) throw new Error('browser.test_input requires browser.test_navigate to a loopback URL first');
      const d = await ensureDriverMode(false);
      if (typeof d.testEval !== 'function') throw new Error('local browser URL verification is unavailable in this driver');
      const href = await d.testEval('location.href');
      let current;
      try { current = assertLoopbackUrl(href); } catch (e) { localMode = false; localOrigin = null; throw new Error('local test page left its owned server: ' + e.message); }
      if (current.origin !== localOrigin) { localMode = false; localOrigin = null; throw new Error('local test page left its owned server origin'); }
      return d;
    }
    async function testInput(action) {
      const d = await requireLocalDriver();
      if (typeof d.testInput !== 'function') throw new Error('synthetic browser input is unavailable in this driver');
      return d.testInput(action || {});
    }
    async function testEval(expression) {
      const d = await requireLocalDriver();
      if (typeof d.testEval !== 'function') throw new Error('local browser evaluation is unavailable in this driver');
      return d.testEval(expression);
    }
    async function testState(selector) {
      const d = await requireLocalDriver();
      if (typeof d.testState !== 'function') throw new Error('local browser state inspection is unavailable in this driver');
      return d.testState(selector);
    }
    async function testSnapshot(limit) { await requireLocalDriver(); return snapshot(limit); }
    async function scroll(x, y) { return ensureDriver().scroll(x, y); }
    async function back() { version++; navEpoch++; return ensureDriver().back(); }
    async function getText(selector) { return ensureDriver().getText(selector); }
    async function challengeStatus() {
      const d = ensureDriver();
      return typeof d.challengeStatus === 'function'
        ? d.challengeStatus()
        : { challenged: false, signal: null, title: '' };
    }
    // A driver without network visibility reports an empty log rather than pretending.
    function networkLog(limit) {
      const d = driver;
      const rows = (d && typeof d.networkLog === 'function') ? d.networkLog() : [];
      return rows.slice(-(limit || 60));
    }
    async function consoleLog(limit) {
      const list = ensureDriver().consoleLog ? await ensureDriver().consoleLog() : [];
      return list.slice(-(limit || 40));
    }
    async function dialog(action, promptText) { return ensureDriver().handleDialog(action || 'accept', promptText || ''); }
    async function screenshot() { return ensureDriver().screenshot(); }
    async function vision(question) {
      const data = await ensureDriver().screenshot();
      const bytes = Math.round(String(data || '').length * 3 / 4);
      // `image` rides along so the caller can PERSIST the analyzed frame — the screenshot used to be
      // handed to the model and dropped, leaving the user unable to check what the agent actually saw.
      if (deps.vision) {
        const answer = await deps.vision({ imageBase64: data, question: question || '' });
        return { ok: true, answer: String(answer == null ? '' : answer), bytes, image: data };
      }
      // No vision provider wired — do NOT fake an answer. Report honestly.
      return { ok: false, bytes, image: data, reason: 'no vision route wired into this run — do not ask the user for an API key; report the screenshot as unavailable' };
    }
    /* ATTENDED LOGIN TAKEOVER: the agent hit a login wall and asks the Commander to sign in THEMSELVES.
       Two live consent asks bracket a headed relaunch on the persistent profile:
         1. permission.prompt tool:'browser.login'      — "open a visible window so you can log in to <host>?"
         2. permission.prompt tool:'browser.login.done' — blocks until the Commander clicks Done (or cancels).
       While the window is up, synthetic-input shims are OFF (the human is driving real Chrome; SSO popups and
       redirects must work) and the agent's driving tools are the ones paused — this function doesn't return
       until the window is torn down and the browser is back to shimmed HEADLESS mode on the same profile.
       Credentials are typed into real Chrome by the human; they never transit the agent or the sidecar.
       Fail-closed inheritance: both asks ride the run's consent channel (auto-deny on timeout/disconnect),
       and env-pinned headless (CI/soak) refuses before any window can appear. */
    async function login(url, signal) {
      const attended = deps.attendedLogin;
      if (!attended || typeof attended.prompt !== 'function') {
        throw new Error('browser.login needs a watched COMMS session — an unattended run cannot open a login window for the Commander');
      }
      if (headlessRequested(deps.env) || deps.headless === true) {
        throw new Error('browser.login unavailable: this host pins the browser headless (STARNET_BROWSER_HEADLESS)');
      }
      const u = assertSafeUrl(url);
      await assertResolvedSafe(u, doLookup);   // same rebinding bar as navigate — a login window is not a weaker surface
      const host = hostOf(u);
      const approved = d => !!d && d !== 'deny';
      if (!approved(await attended.prompt({ tool: 'browser.login', scope: 'execute', argsSummary: host }))) {
        return { status: 'declined', host };
      }
      // The durable profile is what makes the login outlive this run. When a host wires one, contention is a
      // hard stop (logging into a throwaway profile would silently lose the session at run end — dishonest);
      // a host with NO persistent profile still gets a within-run login on its ephemeral profile.
      await waitForProfile(signal);
      // Headed + real input: forceHeadless is HOST authority for model-driven navigation; this relaunch is
      // human-consented (the prompt above), so it may override it. syntheticInputOnly:false drops the popup
      // block and input shims — SSO login flows need real popups and the human's real pointer.
      const d = await relaunch({ headed: true, forceHeadless: false, headless: false, syntheticInputOnly: false });
      localMode = false; localOrigin = null;
      let finalUrl = null;
      try {
        finalUrl = await d.navigate(u.href);
        if (finalUrl) assertSafeUrl(finalUrl);
        const vis = typeof d.visible === 'function' ? d.visible() : true;
        if (!vis) throw new Error('no full Chrome found — only a headless-shell binary, so a visible login window is impossible; install Chrome or set STARNET_CHROME');
      } catch (e) {
        // restore the shimmed headless posture before surfacing the failure
        await relaunch({ headed: false });
        throw e;
      }
      const done = approved(await attended.prompt({ tool: 'browser.login.done', scope: 'execute', argsSummary: host }));
      // Done or cancelled, the window closes and research mode resumes on the SAME profile — any cookies the
      // site set during the attempt are already durable.
      await relaunch({ headed: false });
      return { status: done ? 'done' : 'unconfirmed', host, url: finalUrl || u.href };
    }
    async function close() {
      try { if (driver && driver.close) await driver.close(); }
      finally { releasePersistent(); }
    }
    // Visibility of the controlled window, for truthful navigate reporting. Only meaningful
    // once a driver exists; an injected test driver may not expose it (default true = don't lie about headless).
    function visible() {
      const d = ensureDriver();
      return typeof d.visible === 'function' ? d.visible() : (d.visible != null ? !!d.visible : true);
    }
    function headlessFallback() {
      const d = driver || null;
      return !!(d && d.headlessFallback);
    }
    function attachedPort() {
      const d = driver || null;
      return d && typeof d.attachedPort === 'function' ? d.attachedPort() : null;
    }
    return { waitForProfile, navigate, snapshot, click, type, press, hover, drag, select: selectOption, viewport, forward, upload, tabs, selectTab, closeTab, inspect, evalPublic, evalAllowed, wait, find, pdf, intercept, emulate, attach, detach, attachedToUser: () => attachedToUserBrowser, testInput, testEval, testState, testSnapshot, scroll, back, getText, challengeStatus, consoleLog, networkLog, dialog, vision, screenshot, login, close, visible, headlessFallback, attachedPort, lastResponse, _internals: { refs, version: () => version, navEpoch: () => navEpoch, localMode: () => localMode, localOrigin: () => localOrigin, leaseHeld: () => leaseHeld } };
  }

  function makeBrowserTools(deps) {
    deps = deps || {};
    const session = deps.session || makeBrowserSession(deps);
    const allowVisible = deps.allowVisible === true;
    const read = (name, description, schema, run) => ({ name, capability: 'web', impact: 'synthetic-browser', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const exec = (name, description, schema, run, consent) => ({ name, capability: 'web', impact: 'synthetic-browser', scope: 'execute', requiresConsent: consent !== false, timeoutMs: 20000, description, schema, run });
    const testRead = (name, description, schema, run) => ({ name, capability: 'workbench', impact: 'synthetic-browser', scope: 'read', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    const testExec = (name, description, schema, run) => ({ name, capability: 'workbench', impact: 'synthetic-browser', scope: 'execute', requiresConsent: false, timeoutMs: 20000, description, schema, run });
    /* SCREENSHOTS WERE WRITE-ONLY. screenshot() had exactly one consumer — vision() — which handed the
       base64 to a model and returned a BYTE COUNT, so the user could never see what the agent saw and
       the agent could never re-examine it. Frames now land in the agent's jailed workspace and emit the
       same `deliverable` event image_generate already uses, so a capture shows up in the station.
       Saving needs the workspace jail; a rig without it degrades to the old capture-only behaviour
       rather than pretending a file exists. */
    const shotFsp = deps.fsp, shotPath = deps.pathMod, shotRoot = deps.root;
    const canSaveShots = !!(shotFsp && shotPath && shotRoot);
    const shotJail = canSaveShots ? require('./fs.js').makeFsTools({ fsp: shotFsp, pathMod: shotPath, root: shotRoot })._internals : null;
    async function saveShot(ctx, b64) {
      if (!canSaveShots) return null;
      const aid = (ctx && ctx.agentId) || 'agent';
      const buffer = Buffer.from(String(b64 || ''), 'base64');
      if (!buffer.length) return null;
      // Content-addressed name: deterministic (no ambient clock/rng — determinism law) and idempotent,
      // so re-capturing an unchanged viewport reuses one file instead of piling up near-duplicates.
      const h = require('node:crypto').createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const rel = 'shots/shot-' + h + '.png';
      const { abs } = await shotJail.resolveInside(aid, rel);   // throws on jail escape / abs / '..'
      await shotFsp.mkdir(shotPath.dirname(abs), { recursive: true });
      await shotFsp.writeFile(abs, buffer);
      if (ctx && typeof ctx.emit === 'function') {
        const d = { id: 'shot_' + h, agentId: aid, kind: 'image', title: rel };
        if (ctx.room) d.room = ctx.room;
        ctx.emit('deliverable', d);
      }
      return { rel, bytes: buffer.length, viewer: '/api/file?agent=' + encodeURIComponent(aid) + '&path=' + encodeURIComponent(rel) };
    }
    // Same jail, same content-addressing, same deliverable event as saveShot — but kind:'file' (a PDF
    // is a document the user opens, not pixels the chat inlines) and its own pdf/ shelf.
    async function savePdf(ctx, b64) {
      if (!canSaveShots) return null;
      const aid = (ctx && ctx.agentId) || 'agent';
      const buffer = Buffer.from(String(b64 || ''), 'base64');
      if (!buffer.length) return null;
      const h = require('node:crypto').createHash('sha1').update(buffer).digest('hex').slice(0, 12);
      const rel = 'pdf/page-' + h + '.pdf';
      const { abs } = await shotJail.resolveInside(aid, rel);
      await shotFsp.mkdir(shotPath.dirname(abs), { recursive: true });
      await shotFsp.writeFile(abs, buffer);
      if (ctx && typeof ctx.emit === 'function') {
        const d = { id: 'pdf_' + h, agentId: aid, kind: 'file', title: rel };
        if (ctx.room) d.room = ctx.room;
        ctx.emit('deliverable', d);
      }
      return { rel, bytes: buffer.length, viewer: '/api/file?agent=' + encodeURIComponent(aid) + '&path=' + encodeURIComponent(rel) };
    }
    const navProps = { url: { type: 'string' } };
    if (allowVisible) navProps.visible = { type: 'boolean' };
    const localNavRequired = deps.requireOwnedServer === true ? ['url', 'serverId'] : ['url'];
    // browser.navigate outlives the 20s every other browser tool gets: the driver allows a page up to
    // ~30s to commit, and the tool budget must sit ABOVE that so the driver's own timeout fires first and
    // gets to run its Page.stopLoading recovery. An outer abort here would strand the stalled navigation.
    const NAV_TOOL_TIMEOUT_MS = 45000;
    const tools = [
      Object.assign(read('browser.navigate', 'Navigate the AGENT-CONTROLLED browser to a public http(s) URL. HEADLESS in ordinary agent runs: it never opens a window or uses the user\'s input. Private, loopback, intranet, and unsafe redirects remain refused; use browser.test_navigate for a local dev server.', { type: 'object', required: ['url'], properties: navProps },
        async a => {
          if (a && a.visible === true && !allowVisible) throw new Error('visible browser mode is disabled: this run is headless-only');
          const url = await session.navigate(a.url, ('visible' in (a || {})) ? { visible: a.visible === true } : undefined);
          const challenge = await session.challengeStatus();
          if (challenge && challenge.challenged) {
            let host = url;
            try { host = new URL(url).host; } catch (_) {}
            const http = describeResponse(session.lastResponse && session.lastResponse());
            return {
              content: 'Browser reached a human-verification wall at ' + host + http.text + '. This is not page content. If the Commander is available, use browser.attach for their own Chrome or browser.login when sign-in is required; otherwise report the wall plainly.',
              summary: 'verification wall' + http.summary
            };
          }
          let vis = true;
          try { vis = session.visible(); } catch (_) {}
          const suffix = vis
            ? ' (visible window on the user\'s screen)'
            : (session.headlessFallback && session.headlessFallback()
              ? ' (headless fallback — no visible window; no full Chrome found, only a headless-shell binary)'
              : ' (headless — not visible to the user)');
          // HONEST STATUS. Without this the agent cannot tell a 403/404 from a page that simply
          // rendered nothing, and will happily read an error page back as the answer.
          const http = describeResponse(session.lastResponse && session.lastResponse());
          return { content: 'Browser navigated to ' + url + http.text + suffix, summary: 'navigated' + http.summary };
        }), { timeoutMs: NAV_TOOL_TIMEOUT_MS }),
      testRead('browser.test_navigate', 'Open an agent-owned local dev URL (127.0.0.1/localhost/::1 only) in the HEADLESS CDP browser for UI/game testing. In normal runs serverId must name this agent\'s running shell background server. Physical pointer/keyboard locks are emulated inside the page, so they never reach Windows.', { type: 'object', required: localNavRequired, properties: { url: { type: 'string' }, serverId: { type: 'string' } } },
        async (a, ctx) => {
          assertLoopbackUrl(a.url);
          if (deps.requireOwnedServer === true) {
            const owns = typeof deps.ownsLocalUrl === 'function' && await deps.ownsLocalUrl({ url: a.url, serverId: String(a.serverId || ''), agentId: ctx && ctx.agentId, runId: ctx && ctx.runId });
            if (!owns) throw new Error('local test URL is not proven to belong to this agent\'s running background server');
          }
          const url = await session.navigate(a.url, { local: true, visible: false });
          return { content: 'Local browser navigated to ' + url + ' (headless, synthetic-input isolated; physical mouse/keyboard untouched)', summary: 'local test navigated' };
        }),
      testRead('browser.test_snapshot', 'Return interactive elements and coordinates from the current browser.test_navigate page. Refs expire after the next snapshot; use the reported coordinates with browser.test_input.', { type: 'object', properties: { limit: { type: 'number' } } },
        async a => {
          const nodes = await session.testSnapshot((a && a.limit) || 80);
          return { content: nodes.length ? nodes.map(n => '[' + n.ref + '] ' + n.role + (n.text ? ' "' + n.text + '"' : '') + ' @ ' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h).join('\n') : '(no visible interactive elements)', summary: nodes.length + ' local elements' };
        }),
      testExec('browser.test_input', 'Dispatch synthetic input inside the current browser.test_navigate page through CDP/page events. Key down/up supports holds; relative mouse_move supplies movementX/Y for FPS camera tests. This never moves, clicks, confines, or types through the operating system.', {
        type: 'object', required: ['action'], properties: {
          action: { type: 'string', enum: ['key_down', 'key_up', 'key_press', 'mouse_move', 'mouse_down', 'mouse_up', 'click'] },
          key: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, dx: { type: 'number' }, dy: { type: 'number' }, button: { type: 'string' }
        }
      }, async a => ({ content: await session.testInput(a), summary: 'synthetic input' })),
      testRead('browser.test_state', 'Read non-mutating state from the current local test page: URL/title, synthetic-isolation status, logical pointer-lock tag, and optional element text/value/visibility/class. Arbitrary page JavaScript and navigation are not exposed.', { type: 'object', properties: { selector: { type: 'string' } } },
        async a => {
          const value = await session.testState(a && a.selector);
          return { content: JSON.stringify(value == null ? null : value), summary: 'local state' };
        }),
      read('browser.snapshot', 'Return a structured snapshot of visible interactive elements. Element refs expire after the next snapshot.', { type: 'object', properties: { limit: { type: 'number' } } },
        async a => {
          const nodes = await session.snapshot(a.limit || 80);
          // The frame marker matters to the agent: an element inside an iframe belongs to a different
          // document (a payment form, an SSO login), and its coordinates are already translated here.
          const lines = nodes.map(n => n.ref + ' [' + n.role + '] ' + (n.text || '(no text)') + ' @ ' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h + (n.frame ? ' (iframe ' + n.frame + ')' : ''));
          return { content: fenceExternal(lines.join('\n') || 'No visible interactive elements.', 'page snapshot from the controlled browser'), summary: nodes.length + ' ref(s)' + (nodes.some(n => n.frame) ? ' (incl. iframes)' : '') };
        }),
      /* browser.attach ALWAYS costs a consent prompt and can never be defaulted away. Everything else in
         this file drives a browser the station owns; this one drives the Commander's, where every account
         they have is already signed in. The consent card is the only place a human sees that difference
         before it happens, so `false` is never passed for the consent flag here. */
      exec('browser.attach', 'Attach to an explicitly prepared Chrome debugging session. Prefer browser.login for guided sign-in with a reusable StarNet profile. Advanced attachment requires --remote-debugging-port=<port> and a separate --user-data-dir; current Chrome refuses debugging its default profile. Only accounts signed into that separate profile are available. Use this when a task needs a real logged-in session that browser.login cannot supply. browser.eval stays refused while attached. browser.detach lets go without closing their browser.',
        { type: 'object', required: ['port'], properties: { port: { type: 'number' } } },
        async a => {
          const r = await session.attach(a.port);
          return {
            content: 'Attached to your running ' + r.browser + ' on port ' + r.port + '. Actions now drive YOUR browser and YOUR logged-in sessions, in a window you can watch. '
              + 'browser.eval is refused while attached. Take a browser.snapshot to see the current tab, or browser.tabs to list what is open. browser.detach releases it without closing anything.',
            summary: 'attached to your Chrome'
          };
        }),
      exec('browser.detach', 'Stop driving the Commander\'s own Chrome and go back to the station browser. Their browser keeps running and every tab stays open — this only lets go of it.', { type: 'object', properties: {} },
        async () => ({ content: await session.detach(), summary: 'detached' }), false),
      read('browser.find', 'Find visible elements in the current viewport by text and/or role, and get refs you can click or type into. Prefer this over browser.snapshot on a busy viewport: snapshot lists the first 80 interactive elements, while this scans up to 200 and returns only what matches. It does not scan below the fold or inside closed menus; scroll or open the menu and try again. Refs from earlier snapshots expire, same as after any snapshot.',
        { type: 'object', properties: { text: { type: 'string' }, role: { type: 'string' }, limit: { type: 'number' } } },
        async a => {
          const r = await session.find({ text: a.text, role: a.role }, a.limit);
          const what = [a.text ? 'text containing ' + JSON.stringify(a.text) : '', a.role ? 'role ' + JSON.stringify(a.role) : ''].filter(Boolean).join(' and ');
          if (!r.hits.length) {
            /* Snapshot intentionally filters to visible, actionable geometry. Even an uncapped scan therefore
               proves absence only in the current viewport — never below the fold or inside a closed menu. */
            return {
              content: 'No visible element matches ' + what + ' in the current viewport. Scanned ' + r.scanned + ' visible interactive element(s)'
                + (r.capped ? ' and reached the 200-element scan cap.' : '.')
                + ' The target may be off-screen, inside a closed menu, not loaded yet, or rendered without discoverable interaction semantics. Use browser.get_text or browser.vision to distinguish these; scroll or open the menu and try again, or use browser.wait when content is loading. Do not repeat unchanged searches or screenshots. browser.click requires a discovered ref; browser.test_input is only for owned local test pages, not a coordinate-click fallback for this website. If a fresh read and targeted recovery still cannot expose the target, report the limitation and current page instead of looping.',
              summary: 'no match'
            };
          }
          const lines = r.hits.map(n => n.ref + ' [' + n.role + '] ' + (n.text || '(no text)') + ' @ ' + n.x + ',' + n.y + ' ' + n.w + 'x' + n.h + (n.frame ? ' (iframe ' + n.frame + ')' : ''));
          // Same fence as browser.snapshot: this is PAGE-authored text, and a page can write anything it likes.
          return { content: fenceExternal(lines.join('\n'), 'matching elements from the controlled browser'), summary: r.hits.length + ' match(es) of ' + r.scanned + ' scanned' };
        }),
      /* browser.wait is READ scope and needs no consent: it changes nothing, it only looks. Its whole
         purpose is to replace the guessed sleep, which is the single biggest source of flaky agent
         browsing — and a tool the agent must pay a consent prompt for is a tool it will skip. */
      read('browser.wait', 'Wait until something is true on the page, instead of guessing a delay: an element matching a CSS selector becomes visible, some text appears, or the URL contains a string. Set gone:true to wait for it to DISAPPEAR (a spinner, a "Saving..." banner). Every other browser action already waits for the page to settle by itself — reach for this when you are waiting on a specific thing, like search results loading or a redirect landing. It reports honestly whether the condition actually became true.',
        { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, urlContains: { type: 'string' }, gone: { type: 'boolean' }, timeoutMs: { type: 'number' } } },
        async a => {
          const r = await session.wait({ selector: a.selector, text: a.text, urlContains: a.urlContains, gone: a.gone === true }, a.timeoutMs);
          const what = a.selector ? 'selector ' + JSON.stringify(a.selector)
            : a.text ? 'text ' + JSON.stringify(a.text) : 'url containing ' + JSON.stringify(a.urlContains || '');
          if (r && r.ok === false) return { content: 'The wait condition could not be evaluated: ' + (r.error || 'unknown') + '. Check the selector.', summary: 'wait error' };
          if (r && r.hit) {
            return { content: 'Condition met: ' + what + ' ' + (a.gone === true ? 'is gone' : 'is present') + ' after ~' + r.ms + 'ms. Take a fresh browser.snapshot to act on the page.', summary: 'condition met' };
          }
          /* A TIMEOUT IS NOT AN ERROR AND MUST NOT READ LIKE SUCCESS. The agent has to be able to branch on
             it — "the results never loaded" is a finding, and the honest wording is what stops it from
             proceeding as though the element were there. */
          return { content: 'TIMED OUT after ' + (r && r.ms) + 'ms: ' + what + ' never ' + (a.gone === true ? 'went away' : 'appeared') + '. The page may have failed, or the condition may be wrong — browser.get_text and browser.network will say which.', summary: 'timed out' };
        }),
      exec('browser.click', 'Click a visible element by ref from the latest browser.snapshot. If the click downloads a file, the result waits for Chromium and verifies the saved file under downloads/; pass that exact path to fs.read (Word .docx files are extracted automatically).', { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
        async a => {
          const content = await session.click(a.ref);
          return { content, summary: /Download completed/.test(content) ? 'download completed' : 'clicked' };
        }),
      exec('browser.type', 'Click/focus an element by ref from the latest browser.snapshot, then type text into it.', { type: 'object', required: ['ref', 'text'], properties: { ref: { type: 'string' }, text: { type: 'string' } } },
        async a => ({ content: await session.type(a.ref, a.text), summary: 'typed' })),
      exec('browser.scroll', 'Scroll the page by x/y CSS pixels.', { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        async a => ({ content: await session.scroll(a.x || 0, a.y || 0), summary: 'scrolled' }), false),
      exec('browser.hover', 'Move the pointer over an element by ref from the latest browser.snapshot. Menus, tooltips and disclosure widgets only render their real targets on hover — take a fresh snapshot afterwards to see what appeared.', { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
        async a => ({ content: await session.hover(a.ref), summary: 'hovered' }), false),
      exec('browser.select', 'Choose an option in a <select> dropdown by ref. Pass the option value OR its visible label. A native dropdown cannot be driven by clicking — its popup is browser chrome, not part of the page.', { type: 'object', required: ['ref', 'value'], properties: { ref: { type: 'string' }, value: { type: 'string' } } },
        async a => {
          const r = await session.select(a.ref, a.value);
          if (r && r.ok) return { content: 'Selected "' + (r.label || r.value) + '".', summary: 'selected' };
          const opts = r && r.options && r.options.length ? ' Available values: ' + r.options.join(', ') : '';
          return { content: 'Could not select: ' + ((r && r.reason) || 'unknown') + '.' + opts, summary: 'not selected' };
        }),
      exec('browser.drag', 'Drag one element onto another (both refs from the latest browser.snapshot). Sends the intermediate move events HTML5 drag-and-drop listeners require.', { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
        async a => ({ content: await session.drag(a.from, a.to), summary: 'dragged' })),
      exec('browser.viewport', 'Resize the page viewport, e.g. to check a mobile layout (375x812) or a wide desktop one. Element refs from earlier snapshots stop being valid — take a fresh browser.snapshot after resizing.', { type: 'object', required: ['width', 'height'], properties: { width: { type: 'number' }, height: { type: 'number' }, mobile: { type: 'boolean' }, scale: { type: 'number' } } },
        async a => ({ content: 'Viewport is now ' + await session.viewport(a.width, a.height, { mobile: a.mobile === true, scale: a.scale }) + ' — take a fresh browser.snapshot.', summary: 'viewport' }), false),
      exec('browser.forward', 'Go forward in browser history (the counterpart of browser.back).', { type: 'object', properties: {} },
        async () => ({ content: 'Browser moved forward to ' + await session.forward(), summary: 'forward' }), false),
      read('browser.tabs', 'List the browser tabs. A link with target="_blank", a checkout popup or a PDF opens a NEW tab — it is listed here, and browser.tab_select switches to it. Tab 0 is the one you started in.', { type: 'object', properties: {} },
        async () => {
          const list = await session.tabs();
          // FENCED: a tab TITLE is `document.title` — fully attacker-controlled, and a popup a hostile page
          // opened can name itself anything. The URL is page-chosen too. This reads like host bookkeeping but
          // it is page content, which is exactly why it needs the marker.
          return {
            content: fenceExternal(list.map(t => '[' + t.index + ']' + (t.active ? ' *' : '  ') + ' ' + (t.title || '(untitled)') + ' — ' + t.url).join('\n'), 'browser tab titles and URLs, authored by the pages themselves'),
            summary: list.length + ' tab(s)'
          };
        }),
      exec('browser.tab_select', 'Switch to a tab by index from browser.tabs. Every later action applies to THAT tab, and element refs from the previous tab stop being valid — take a fresh browser.snapshot.', { type: 'object', required: ['index'], properties: { index: { type: 'number' } } },
        async a => ({ content: 'Now on tab ' + a.index + ': ' + await session.selectTab(a.index) + ' — take a fresh browser.snapshot.', summary: 'tab ' + a.index }), false),
      exec('browser.tab_close', 'Close a tab by index from browser.tabs. Tab 0 cannot be closed.', { type: 'object', required: ['index'], properties: { index: { type: 'number' } } },
        async a => ({ content: await session.closeTab(a.index), summary: 'tab closed' })),
      exec('browser.upload', 'Attach files from your workspace to a file-upload control on the page. "ref" is the upload control (or its visible label) from the latest browser.snapshot; "paths" are workspace-relative files. Submitting the form is a separate click.', { type: 'object', required: ['ref', 'paths'], properties: { ref: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } } },
        async (a, ctx) => {
          if (!canSaveShots) throw new Error('browser.upload needs a workspace; this run has none');
          const aid = (ctx && ctx.agentId) || 'agent';
          const rels = Array.isArray(a.paths) ? a.paths : [a.paths];
          if (!rels.length) throw new Error('browser.upload needs at least one path');
          // Resolve through the SAME jail as fs.* — an upload must never be able to post a file from
          // outside the agent's workspace (resolveInside throws on '..', absolute paths, escapes).
          const abs = [];
          for (const rel of rels) {
            const r = await shotJail.resolveInside(aid, String(rel));
            await shotFsp.stat(r.abs);   // fail loudly here, not silently inside the page
            abs.push(r.abs);
          }
          return { content: await session.upload(a.ref, abs) + ': ' + rels.join(', ') + '. Submit the form when ready.', summary: 'uploaded ' + abs.length };
        }),
      exec('browser.back', 'Go back in browser history.', { type: 'object', properties: {} },
        async () => ({ content: 'Browser went back to ' + await session.back(), summary: 'back' }), false),
      exec('browser.press', 'Press a keyboard key in the browser.', { type: 'object', required: ['key'], properties: { key: { type: 'string' } } },
        async a => ({ content: await session.press(a.key), summary: 'pressed' })),
      read('browser.console', 'Read recent browser console warnings/errors/logs.', { type: 'object', properties: { limit: { type: 'number' } } },
        async a => {
          const rows = await session.consoleLog(a.limit || 40);
          return { content: fenceExternal(rows.map(r => '[' + r.type + '] ' + r.text).join('\n') || 'No console messages.', 'browser console output from the page'), summary: rows.length + ' console row(s)' };
        }),
      read('browser.inspect', 'Inspect one element by ref from the latest browser.snapshot: computed styles, every attribute, data-* values, aria/role, disabled/checked state, its box, and any shadow-DOM controls inside it. Use this when a page LOOKS wrong or a control will not respond - it answers "why" without running page script.', { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } },
        async a => {
          const r = await session.inspect(a.ref);
          if (!r || r.ok !== true) return { content: 'Could not inspect: ' + ((r && r.reason) || 'unknown'), summary: 'not inspected' };
          const lines = ['<' + r.tag + '>' + (r.role ? ' role=' + r.role : '') + (r.disabled ? ' DISABLED' : '') + (r.checked === true ? ' CHECKED' : ''),
            'text: ' + (r.text || '(none)'),
            'box: ' + r.box.x + ',' + r.box.y + ' ' + r.box.w + 'x' + r.box.h,
            'styles: ' + Object.keys(r.styles).map(k => k + '=' + r.styles[k]).join('; '),
            'attrs: ' + (Object.keys(r.attrs).length ? Object.keys(r.attrs).map(k => k + '=' + r.attrs[k]).join('; ') : '(none)')];
          if (Object.keys(r.data || {}).length) lines.push('data-*: ' + Object.keys(r.data).map(k => k + '=' + r.data[k]).join('; '));
          if (r.shadow) lines.push('shadow DOM controls: ' + (r.shadow.length ? r.shadow.map(x => x.tag + (x.type ? '[' + x.type + ']' : '') + ' "' + x.text + '"').join(', ') : '(none)'));
          return { content: lines.join('\n'), summary: 'inspected ' + r.tag };
        }),
      exec('browser.eval', 'Run a JavaScript expression in the CURRENT page and get its value back as JSON. Refused while the browser is using your signed-in station profile, because page script there could read the cookies and storage of accounts you are logged into - browser.inspect and browser.get_text work everywhere and cover most of what this is for.', { type: 'object', required: ['expression'], properties: { expression: { type: 'string' } } },
        async a => {
          const r = await session.evalPublic(a.expression);
          if (r && r.ok === false) return { content: 'The expression threw: ' + r.error, summary: 'eval threw' };
          const v = r && r.value;
          return { content: typeof v === 'string' ? v : JSON.stringify(v), summary: 'eval' };
        }),
      read('browser.network', 'List observed requests from the current page. filter matches the URL; failedOnly shows errors. deriveReadClient returns runnable Node.js GET client templates for observed successful Fetch/XHR requests, without capturing credentials or executing traffic. Use this to learn a repeated read-only website lookup; verify the client against the browser before saving it as a skill.', { type: 'object', properties: { limit: { type: 'number' }, filter: { type: 'string' }, failedOnly: { type: 'boolean' }, deriveReadClient: { type: 'boolean' } } },
        async a => {
          let rows = session.networkLog(a.limit || 60);
          if (a.filter) { const f = String(a.filter).toLowerCase(); rows = rows.filter(r => String(r.url).toLowerCase().indexOf(f) >= 0); }
          if (a.failedOnly === true) rows = rows.filter(r => r.failure || (r.status && (r.status < 200 || r.status >= 300)));
          if (a.deriveReadClient === true) {
            const derived = deriveReadClient(rows);
            return { content: fenceExternal(JSON.stringify(derived, null, 2), 'observed website request templates; unverified external data'), summary: derived.candidates.length + ' read-only client candidate(s), unverified' };
          }
          if (!rows.length) return { content: 'No matching network requests were recorded for this page.', summary: '0 requests' };
          const line = r => (r.method || 'GET') + ' ' + (r.status ? r.status : (r.failure ? 'FAILED' : 'pending')) +
            ' ' + clamp(r.url, 200) + (r.type ? ' [' + r.type + ']' : '') +
            (r.bytes ? ' ' + r.bytes + 'B' : '') + (r.failure ? ' — ' + r.failure : '');
          const bad = rows.filter(r => r.failure || (r.status && (r.status < 200 || r.status >= 300))).length;
          // FENCED: every row is derived from what the PAGE chose to request — URLs and transport failure
          // strings are attacker-shaped, and a long crafted URL is a fine place to hide a directive.
          return { content: fenceExternal(rows.map(line).join('\n'), 'network request log from the controlled browser, driven by the page'), summary: rows.length + ' request(s)' + (bad ? ', ' + bad + ' failed' : '') };
        }),
      exec('browser.dialog', 'Accept or dismiss the current JavaScript dialog.', { type: 'object', properties: { action: { type: 'string' }, promptText: { type: 'string' } } },
        async a => {
          const d = await session.dialog(a.action || 'accept', a.promptText || '');
          return { content: 'Dialog ' + (d.type || 'none') + ': ' + fenceExternal(d.message || '', 'javascript dialog text from the page'), summary: 'dialog' };
        }),
      read('browser.get_text', 'Return visible page text, optionally scoped by CSS selector. A detected verification wall is reported as a wall, never returned as page content.', { type: 'object', properties: { selector: { type: 'string' } } },
        async a => {
          const challenge = await session.challengeStatus();
          if (challenge && challenge.challenged) {
            return {
              content: 'The current page is a human-verification wall, not readable page content. Use browser.attach for the Commander\'s own Chrome or browser.login when sign-in is required; otherwise report the wall plainly.',
              summary: 'verification wall'
            };
          }
          return { content: fenceExternal(clamp(await session.getText(a.selector || ''), MAX_TEXT), 'page text from the controlled browser'), summary: 'text' };
        }),
      // ATTENDED LOGIN: requiresConsent stays false because the flow runs its OWN two-phase live consent
      // (open-window ask + done-wait) — the generic broker card would double-prompt. timeoutMs must outlive
      // both consent waits (each fail-closes on its own CONSENT timer + rendered-ack extension), so the only
      // job of this bound is to stop a wedged flow from pinning the run forever.
      {
        name: 'browser.login', capability: 'web', impact: 'synthetic-browser', scope: 'execute', requiresConsent: false, timeoutMs: 60 * 60 * 1000,
        description: 'Ask the Commander to open a VISIBLE browser window and log in to a site THEMSELVES (their password is typed into real Chrome — it never passes through you; never ask for credentials in chat). Blocks until they finish, then returns to headless mode. Verify the signed-in account on the page after Done; confirmation alone does not prove authentication. Cookies persist in the station browser profile, so future runs stay signed in. Use only when a site genuinely requires login; works only in a watched COMMS session.',
        schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
        run: async (a, ctx) => {
          const r = await session.login(a.url, ctx && ctx.signal);
          if (r.status === 'declined') return { content: 'Commander declined to open a login window for ' + r.host + '. Continue without authentication and say what is blocked.', summary: 'login declined' };
          if (r.status === 'unconfirmed') return { content: 'Login window for ' + r.host + ' closed without a Done confirmation. Any cookies the site set were saved to the station profile; verify with browser.navigate whether you are signed in before relying on it.', summary: 'login unconfirmed' };
          return { content: 'Commander finished logging in at ' + r.host + '. The browser is back in headless research mode. Done is a human confirmation, not authentication proof: use browser.navigate to verify the account and access before continuing.', summary: 'login done' };
        }
      },
      read('browser.vision', 'Capture the current viewport and answer a question about what is on screen (vision rides the session\'s own model when no dedicated vision key exists — never ask the user for an API key). If no vision route is available this returns a clear "unavailable" result — it never fabricates a description.', { type: 'object', properties: { question: { type: 'string' } } },
        async (a, ctx) => {
          const r = await session.vision(a.question || '');
          // Save the analyzed frame either way: on success so the user can check the model's reading
          // against the actual pixels, and on failure so the capture is not simply thrown away.
          let shot = null;
          try { shot = await saveShot(ctx, r && r.image); } catch (_) { shot = null; }
          const saved = shot ? '\n\nScreenshot saved to ' + shot.rel + '\nView: ' + shot.viewer : '';
          if (r && r.ok) {
            // the vision answer DESCRIBES attacker-controlled pixels, so it inherits the page's trust level.
            // `saved` stays OUTSIDE the fence: it is host-authored provenance about where we wrote the
            // screenshot, not page content, and burying it inside would tell the model to distrust our own note.
            // The analyzed frame rides back WITH its description: the description is a second model's reading
            // of the pixels, and the run's own model should be able to check it against them.
            return { content: fenceExternal(r.answer || '(vision model returned no text)', 'vision description of the page on screen') + saved, summary: 'vision', images: (r.image ? [{ mime: 'image/png', data: String(r.image) }] : null) };
          }
          const reason = (r && r.reason) || 'vision model is not configured';
          return { content: 'browser.vision unavailable: ' + reason + ' (captured ' + ((r && r.bytes) || 0) + ' bytes but did not analyze them).' + saved, summary: 'vision unavailable' };
        }),
      read('browser.screenshot', 'Capture the current viewport as a PNG, save it into your workspace, and show it to the user. Use this to prove what a page actually looked like, or to keep a frame you want to refer back to. Returns the saved path; browser.vision is the tool that ANSWERS QUESTIONS about a page.', { type: 'object', properties: {} },
        async (a, ctx) => {
          const data = await session.screenshot();
          if (!data) return { content: 'Screenshot unavailable: this browser driver captured no image.', summary: 'no image' };
          const shot = await saveShot(ctx, data);
          if (!shot) {
            const bytes = Math.round(String(data).length * 3 / 4);
            return { content: 'Captured ' + bytes + ' bytes but this run has no workspace to save into, so the image was discarded.', summary: 'not saved' };
          }
          return {
            content: 'Screenshot saved to ' + shot.rel + ' (' + (shot.bytes / 1024).toFixed(0) + ' KB).\nView: ' + shot.viewer,
            summary: 'shot → ' + shot.rel,
            // THE PIXELS THEMSELVES. Until this rode along, "screenshot" meant the model got a FILE PATH and
            // never saw the screen — it could prove a page to the Commander and remained blind to it itself.
            // The loop fences and attaches these (see loop.js SCREENSHOTS AS PIXELS); a text-only model simply
            // never has the field turned on.
            images: [{ mime: 'image/png', data: String(data) }]
          };
        }),
      read('browser.pdf', 'Render the CURRENT page to a PDF file in your workspace — the whole document, not just the visible viewport. Use it to keep an article, a receipt, a report, or anything the user asked you to save in a form they can open later. Returns the saved path. browser.screenshot is the tool for a quick visual proof of the viewport.', { type: 'object', properties: { landscape: { type: 'boolean' } } },
        async (a, ctx) => {
          let data = null;
          try { data = await session.pdf({ landscape: a && a.landscape === true }); }
          catch (e) {
            // Headed Chrome builds that refuse Page.printToPDF land here; an honest refusal beats a fake file.
            return { content: 'browser.pdf failed: ' + ((e && e.message) || e) + '. If the browser is in a visible window, try again after it returns to headless mode.', summary: 'pdf failed' };
          }
          if (!data) return { content: 'browser.pdf produced no data for this page.', summary: 'no pdf' };
          const doc = await savePdf(ctx, data);
          if (!doc) {
            const bytes = Math.round(String(data).length * 3 / 4);
            return { content: 'Rendered ' + bytes + ' bytes of PDF but this run has no workspace to save into, so it was discarded.', summary: 'not saved' };
          }
          return { content: 'PDF saved to ' + doc.rel + ' (' + (doc.bytes / 1024).toFixed(0) + ' KB).\nView: ' + doc.viewer, summary: 'pdf → ' + doc.rel };
        }),
      exec('browser.intercept', 'Block heavy resource types (image, media, font, stylesheet) in the station browser to make text research faster and cheaper — pages load without downloading what you were never going to read. Pass kinds:[] to turn blocking off. Blocked requests appear in browser.network as ERR_BLOCKED_BY_CLIENT, so nothing is hidden. Blocking "stylesheet" can change layout and hide elements — use it only for pure text scraping. Refused while attached to the Commander\'s own Chrome.', { type: 'object', required: ['kinds'], properties: { kinds: { type: 'array', items: { type: 'string', enum: ['image', 'media', 'font', 'stylesheet'] } } } },
        async a => {
          const active = await session.intercept(a.kinds);
          return {
            content: active.length ? 'Now blocking: ' + active.join(', ') + '. Applies to the tabs of this browsing session; browser.network shows what was blocked. Pass kinds:[] to stop.' : 'Blocking is off — all resource types load again.',
            summary: active.length ? 'blocking ' + active.join(',') : 'blocking off'
          };
        }, false),
      exec('browser.emulate', 'Emulate a device, user agent, language, or timezone in the station browser — for checking a mobile layout, a localized page, or time-dependent rendering. Pass device (iphone | pixel | ipad) for a one-call phone/tablet profile (metrics + touch + matching user agent), or set userAgent / locale (e.g. "de-DE") / timezone (e.g. "Europe/Berlin") individually. Pass reset:true to clear every override. Refs from earlier snapshots expire — take a fresh browser.snapshot. Refused while attached to the Commander\'s own Chrome.', { type: 'object', properties: { device: { type: 'string', enum: ['iphone', 'pixel', 'ipad'] }, userAgent: { type: 'string' }, locale: { type: 'string' }, timezone: { type: 'string' }, reset: { type: 'boolean' } } },
        async a => {
          a = a || {};
          if (a.reset === true) {
            await session.emulate(null);
            return { content: 'Emulation cleared — the browser is back to its real device metrics, user agent, language and timezone. Take a fresh browser.snapshot.', summary: 'emulation off' };
          }
          /* Preset UA strings freeze a browser generation and will age — that is inherent to UA
             emulation, and honest enough for layout testing. They are NOT a stealth feature: the
             station's answer to bot walls is browser.attach (a real browser), never spoofing. */
          const DEVICES = {
            iphone: { width: 390, height: 844, scale: 3, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
            pixel: { width: 412, height: 915, scale: 2.625, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' },
            ipad: { width: 820, height: 1180, scale: 2, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' }
          };
          const base = a.device ? DEVICES[String(a.device).toLowerCase()] : null;
          if (a.device && !base) throw new Error('browser.emulate: unknown device "' + a.device + '" (supported: iphone, pixel, ipad)');
          const next = Object.assign({}, base || {});
          if (a.userAgent) next.userAgent = String(a.userAgent);
          if (a.locale) next.locale = String(a.locale);
          if (a.timezone) next.timezone = String(a.timezone);
          if (!Object.keys(next).length) throw new Error('browser.emulate needs a device, userAgent, locale, timezone, or reset:true');
          const active = await session.emulate(next);
          const parts = [];
          if (active && active.width) parts.push((active.mobile ? 'mobile ' : '') + active.width + 'x' + active.height + '@' + (active.scale || 1) + 'x');
          if (active && active.userAgent) parts.push('UA set');
          if (active && active.locale) parts.push('locale ' + active.locale);
          if (active && active.timezone) parts.push('timezone ' + active.timezone);
          return { content: 'Emulating: ' + parts.join(', ') + '. Take a fresh browser.snapshot — earlier refs expired. reset:true clears it.', summary: 'emulating ' + (a.device || parts.join(',')) };
        }, false)
    ];
    // Reserve before driver creation, within the tool's existing abort/timeout budget. Local test tools
    // and explicit attach/detach retain their separate lifecycle; login keeps its human-consent boundary.
    for (const tool of tools) {
      if (/^browser\.(test_|attach$|detach$|login$)/.test(tool.name)) continue;
      const run = tool.run;
      tool.run = async (args, ctx) => {
        if (typeof session.waitForProfile === 'function') await session.waitForProfile(ctx && ctx.signal);
        return run(args, ctx);
      };
    }
    return { tools, session, register(reg) { tools.forEach(t => reg.register(t)); return reg; }, _internals: { assertSafeUrl, assertLoopbackUrl, assertResolvedSafe, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, makeDownloadLedger, findChrome, resolveChrome, headlessRequested, SYNTHETIC_INPUT_BOOTSTRAP, CHROME_CANDIDATES } };
  }

  return { makeBrowserTools, _internals: { assertSafeUrl, assertLoopbackUrl, assertResolvedSafe, isPrivateV4, isPrivateV6, makeBrowserSession, makeCdpDriver, makeDownloadLedger, findChrome, resolveChrome, headlessRequested, SYNTHETIC_INPUT_BOOTSTRAP, SETTLE_BOOTSTRAP, SETTLE_PROBE, SETTLE_QUIET_POLLS, describeResponse, jsLiteral, normalizeBrowserLocale, detectBrowserVersion, makeLaunchIdentity, browserVersionFrom, cleanBrandRows, makeCdpIdentity, CHROME_CANDIDATES } };
});
