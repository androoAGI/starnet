/* sidecar/tools/builtin/webreader.js — the station READER: a shared, headless, cookie-less real-Chrome
   fallback that web_fetch and web_search borrow when plain HTTP is bot-walled or throttled.

   WHY (2026-07-31, field data + the Hermes reach audit): the dominant real-world web failures are bot
   walls (403) and throttled keyless engines — problems a REAL browser fingerprint doesn't have. Hermes
   solves reach architecturally (vendor reader APIs + real browsers, model-driven escalation, no
   automatic fallback); StarNet is local-first with no vendor keys, but it SHIPS a CDP Chrome. This
   module turns that asset into automatic reach: when the cheap path fails in a way a browser can fix,
   the tool quietly reads the page through Chrome instead of reporting weather.

   SHAPE:
     makeWebReader(deps?) -> { available(), fetchText(url, opts), search(query, opts), close() }
       deps.browser   : the ../browser.js module api (injectable; defaults to require)
       deps.makeDriver: driver factory override for tests (real one = browser._internals.makeCdpDriver)
       deps.env       : env for headless pinning / chrome discovery
       deps.idleMs    : teardown after this much idle (default 90s)

   POSTURE (do not weaken):
     · ALWAYS headless, ALWAYS an ephemeral profile, NEVER the station's persistent (signed-in)
       profile — web_fetch is a read-scope no-consent tool, so it must never ride the Commander's
       logins: an authenticated page leaking into a no-consent tool would be a real exfil channel.
       The plain-HTTP path carries no cookies; the reader must match it.
     · One shared Chrome for the whole sidecar, lazily booted, serialized (one page at a time),
       torn down after idle. Cold start is paid once per burst, not per fetch.
     · SSRF guarding for the INITIAL url is the caller's job (webFetch's assertSafeUrl +
       assertResolvedSafe already ran). Redirects inside Chrome follow browser.navigate's existing
       posture — the same run already holds browser.navigate via the same dish, so this opens no
       reach the agent did not already have.
     · A challenge interstitial is NOT content. Port of the Hermes heuristic: a title matching the
       blocked-patterns list means the wall is still up, and the reader says so instead of returning
       "Just a moment…" as page text. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).webreader = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (req) {
  'use strict';

  const IDLE_MS_DEFAULT = 90000;
  const RESULTS_MAX = 12;
  const TEXT_MAX = 12000;
  const Challenge = req('./browserchallenge.js');
  const { looksChallenged, looksBlockedText, CHALLENGE_TITLES } = Challenge;

  // In-page result extractors. DOM queries, not regex-over-HTML: the browser already parsed the page,
  // and selector drift is easier to see and fix than regex drift. Each returns [{title,url,snippet}].
  const EXTRACT_BING = `(() => {
    const out = [];
    for (const li of document.querySelectorAll('li.b_algo')) {
      const a = li.querySelector('h2 a');
      if (!a) continue;
      let url = a.href || '';
      // bing wraps organic hits as /ck/a?…&u=a1<base64url> click-trackers — hand the model the REAL
      // destination, not a tracking bounce (live-found: every result URL was a /ck/a wrapper)
      try {
        const uo = new URL(url);
        if (uo.pathname === '/ck/a') {
          const p = uo.searchParams.get('u') || '';
          if (p.slice(0, 2) === 'a1') {
            const dec = atob(p.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
            if (/^https?:/.test(dec)) url = dec;
          }
        }
      } catch (e) {}
      const title = (a.innerText || '').trim();
      if (!/^https?:/.test(url) || !title) continue;
      const sn = li.querySelector('.b_caption p, p');
      out.push({ title, url, snippet: sn ? (sn.innerText || '').trim().slice(0, 320) : '' });
      if (out.length >= ${RESULTS_MAX}) break;
    }
    return out;
  })()`;
  /* Engine order is EMPIRICAL (live-probed 2026-07-31 in real headless Chrome):
       · bing serves real results (10 anchors) — PRIMARY.
       · html.duckduckgo.com serves a duck-CAPTCHA (202) even to a real browser — not listed.
       · duckduckgo.com (the JS app) is the second try; its extractor targets the data-testid DOM. */
  const EXTRACT_DDG_MAIN = `(() => {
    const out = [];
    for (const row of document.querySelectorAll('[data-testid="result"], article[data-nrn]')) {
      const a = row.querySelector('a[data-testid="result-title-a"], h2 a');
      if (!a) continue;
      const url = a.href || '';
      const title = (a.innerText || '').trim();
      if (!/^https?:/.test(url) || !title) continue;
      const sn = row.querySelector('[data-testid="result-snippet"]');
      out.push({ title, url, snippet: sn ? (sn.innerText || '').trim().slice(0, 320) : '' });
      if (out.length >= ${RESULTS_MAX}) break;
    }
    return out;
  })()`;
  const ENGINES = [
    { id: 'bing', url: q => 'https://www.bing.com/search?q=' + q, extract: EXTRACT_BING },
    { id: 'duckduckgo', url: q => 'https://duckduckgo.com/?q=' + q + '&ia=web', extract: EXTRACT_DDG_MAIN }
  ];

  function makeWebReader(deps) {
    deps = deps || {};
    const browser = deps.browser || (req ? req('./browser.js') : null);
    const internals = browser && browser._internals;
    const makeDriver = deps.makeDriver || (internals && internals.makeCdpDriver);
    const idleMs = deps.idleMs == null ? IDLE_MS_DEFAULT : Number(deps.idleMs);
    const env = deps.env || (typeof process !== 'undefined' ? process.env : {});

    let driver = null, idleTimer = null, chain = Promise.resolve(), closed = false;
    let warm = false;   // the current driver has produced a page: its browser STARTED (web.js times only the start)
    /* A BROWSER THAT CANNOT START (live walk 10-14): Chromium failed to launch, and every engine of every search
       relaunched it — 3 tries × ~20 s each — while the worker's web_search sat on "Searching …" for 80 s, then 185 s.
       A launch failure now ends that search's engine loop and holds the reader down for a cooldown: availability()
       says why, so web_search skips the rung at once (and tells the Commander) instead of relaunching a dead browser. */
    // the host injects the real clock (index.js); never ambient time here (lint-determinism) — with none, the cooldown never reads as over
    const clock = typeof deps.now === 'function' ? deps.now : () => 0;
    const LAUNCH_COOLDOWN_MS = deps.launchCooldownMs == null ? 10 * 60000 : Number(deps.launchCooldownMs);
    let launchDown = null;   // { at, reason }
    const launchFailureOf = e => {
      const m = String((e && e.message) || e || '');
      return /could not attach to Chromium|exited before CDP ownership|Chromium not found|browser could not start|WebSocket\/fetch is not available/i.test(m)
        ? m.replace(/^browser unavailable:\s*/i, '').replace(/^the station browser could not start:\s*/i, '')
          // the driver's words for a Chrome that quit at launch, said plainly (how it exited stays: it is the diagnosis)
          .replace(/^spawned Chromium exited before CDP ownership was established(?::\s*(.+))?$/i, (_, how) => 'Chrome closed right after it was launched' + (how ? ', ' + how : ''))
        : '';
    };
    /* NOT THE STATION BROWSER (user report 10-28). This hidden Chrome belongs to web_search/web_fetch alone; the browser
       tool runs its own. Calling it "the station browser" told agents (and the people reading them) that browsing itself
       was dead, so a research run stopped while browser.navigate was still there to try. */
    const downNote = () => 'web search\'s background browser could not start (' + launchDown.reason.slice(0, 160) + ')';

    function availability() {
      if (String(env.SKYNET_WEB_READER || env.STARNET_WEB_READER || '') === '0') return { ok: false, reason: 'disabled' };
      if (launchDown && clock() - launchDown.at < LAUNCH_COOLDOWN_MS) return { ok: false, launchFailed: true, reason: downNote() };
      if (!makeDriver) return { ok: false, reason: 'browser module unavailable' };
      if (deps.makeDriver) return { ok: true };   // an injected factory needs no Chrome on disk
      try {
        const r = internals && internals.resolveChrome && internals.resolveChrome(false, deps.existsSync);
        return r ? { ok: true } : { ok: false, reason: 'no Chromium on this machine' };
      } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
    }

    function armIdle() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { teardown(); }, idleMs);
      if (idleTimer.unref) idleTimer.unref();
    }
    function teardown() {
      const d = driver; driver = null; warm = false;
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (d) { try { const p = d.close(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    }
    function ensureDriver() {
      if (driver) return driver;
      const P = req ? req('node:path') : null;
      const OS = req ? req('node:os') : null;
      driver = makeDriver({
        forceHeadless: true, headless: true, cdpPort: 0, env,
        // ephemeral, reader-owned profile — never the station's signed-in one (see POSTURE above)
        profileDir: P && OS ? P.join(OS.tmpdir(), 'starnet-webreader-' + process.pid) : undefined,
        cleanupProfile: true
      });
      return driver;
    }
    // one page, one job at a time — a second caller queues rather than stealing the tab mid-read
    function enqueue(job) {
      const run = chain.then(job, job);
      chain = run.then(() => {}, () => {});
      return run;
    }

    /* fetchText(url) -> { ok:true, status, url, title, text }
                       | { ok:false, reason, status?, title? }        — never throws for page-level outcomes */
    function fetchText(url, opts) {
      const avail = availability();
      if (!avail.ok) return Promise.resolve({ ok: false, reason: avail.reason, launchFailed: avail.launchFailed === true });
      if (closed) return Promise.resolve({ ok: false, reason: 'reader closed' });
      const signal = opts && opts.signal;
      return enqueue(async () => {
        if (signal && signal.aborted) return { ok: false, reason: 'cancelled' };
        let d;
        try { d = ensureDriver(); } catch (e) { return { ok: false, reason: String((e && e.message) || e) }; }
        try {
          await d.navigate(String(url));
          warm = true;
          const resp = typeof d.lastResponse === 'function' ? d.lastResponse() : null;
          const status = resp && Number(resp.status) || 0;
          let title = '';
          try { const t = await d.evalPublic('document.title'); title = String((t && t.value !== undefined ? t.value : t) || ''); } catch (_) {}
          if (looksChallenged(title)) return { ok: false, reason: 'challenge', status, title };
          if (status >= 400) return { ok: false, reason: 'http ' + status, status, title };
          let text = String((await d.getText()) || '').slice(0, TEXT_MAX);
          if (!text.trim()) {   // JS-late render: one bounded re-read before calling it empty (held ref'd — see sleepMs note)
            await new Promise(res => setTimeout(res, 800));
            text = String((await d.getText()) || '').slice(0, TEXT_MAX);
          }
          if (!text.trim()) return { ok: false, reason: 'empty', status, title };
          if (looksBlockedText(text)) return { ok: false, reason: 'challenge', status, title };
          return { ok: true, status, url: String(url), title, text };
        } catch (e) {
          // A slow/refusing page is NOT a wedged driver: navigate() already ran its Page.stopLoading
          // recovery and promises the session is usable for the very next call — keep the warm Chrome.
          // Anything else (CDP/socket-level) rebuilds on the next use.
          if (!/did not finish loading/.test(String((e && e.message) || ''))) teardown();
          const lf = launchFailureOf(e);
          if (lf) { launchDown = { at: clock(), reason: lf }; return { ok: false, reason: downNote(), launchFailed: true }; }
          return { ok: false, reason: String((e && e.message) || e) };
        } finally { armIdle(); }
      });
    }

    /* search(query, { signal, onLaunched }) -> { engine, results:[{title,url,snippet}] } — results:[] when every engine
       is dry. Engines are tried in order inside ONE queue slot; first non-empty wins. onLaunched() fires once the
       browser has STARTED — at once for a warm one, else when its first page answers (a slow page counts: the browser
       is up) — so a caller can bound the start without ever cutting short a healthy browser's reading (review 10-14). */
    function search(query, opts) {
      const avail = availability();
      if (!avail.ok) return Promise.resolve({ engine: '', results: [], reason: avail.reason, launchFailed: avail.launchFailed === true });
      if (closed) return Promise.resolve({ engine: '', results: [], reason: 'reader closed' });
      const signal = opts && opts.signal;
      const q = encodeURIComponent(String(query || '')).replace(/%20/g, '+');
      let told = false;
      const launched = () => {
        if (told || !opts || typeof opts.onLaunched !== 'function') return;
        told = true;
        try { opts.onLaunched(); } catch (e) { console.warn('[webreader] onLaunched threw', e); }
      };
      if (driver && warm) launched();   // already running: nothing to start (a queued read is the browser working)
      return enqueue(async () => {
        let d;
        try { d = ensureDriver(); } catch (e) { return { engine: '', results: [], reason: String((e && e.message) || e) }; }
        if (warm) launched();
        // deliberately NOT unref'd: an operational wait must hold the event loop open (an unref'd
        // timer here let the whole test process drain and exit mid-poll); only the IDLE timer unrefs
        const sleepMs = (ms) => new Promise(res => setTimeout(res, ms));
        for (const eng of ENGINES) {
          if (signal && signal.aborted) break;
          try {
            await d.navigate(eng.url(q));
            warm = true; launched();
            /* HYDRATION POLLING (live-found 2026-07-31): bing lands via an `rdr` redirect, so the
               settle can return on the INTERMEDIATE document — an extractor fired immediately reads
               zero rows on a page that shows ten a second later. Poll briefly instead of trusting
               the first read; a genuinely empty engine costs ~2s extra, a hydrating one is caught. */
            let rows = [];
            for (let attempt = 0; attempt < 7 && !rows.length; attempt++) {
              if (attempt) await sleepMs(900);
              if (signal && signal.aborted) break;
              const raw = await d.evalPublic(eng.extract);
              // an eval that errored (context destroyed mid-redirect) is a RETRY, not an empty page
              if (raw && raw.ok === false) continue;
              const val = raw && raw.value !== undefined ? raw.value : raw;
              rows = Array.isArray(val) ? val.filter(r => r && r.url && r.title) : [];
            }
            if (rows.length) { armIdle(); return { engine: eng.id, results: rows.slice(0, RESULTS_MAX) }; }
          } catch (e) {
            // the browser itself could not start: the next engine would only relaunch it — stop, and say so
            const lf = launchFailureOf(e);
            if (lf) {
              launchDown = { at: clock(), reason: lf };
              teardown(); armIdle();
              return { engine: '', results: [], reason: downNote(), launchFailed: true };
            }
            // a slow engine page is survivable (navigate's stopLoading recovery) — only a
            // driver-level failure warrants a rebuild before the next engine
            if (/did not finish loading/.test(String((e && e.message) || ''))) { warm = true; launched(); }   // slow page, live browser
            else {
              teardown();
              try { d = ensureDriver(); } catch (_) { break; }
            }
          }
        }
        armIdle();
        return { engine: '', results: [] };
      });
    }

    function close() { closed = true; teardown(); }

    return { available: availability, fetchText, search, close, _internals: { looksChallenged, looksBlockedText, CHALLENGE_TITLES, EXTRACT_BING, EXTRACT_DDG_MAIN, ENGINES } };
  }

  return { makeWebReader };
});
