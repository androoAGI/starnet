/* sidecar/tools/builtin/web.js — the WEB capability: web_search(query) and web_fetch(url).
   Zero extra API keys for the MVP. Node 18+. One runtime dep: undici (its fetch + a per-hop Agent that pins the
   DNS-validated address — the rebinding guard; staged into the desktop bundle by scripts/stage-voice-deps.mjs).

   makeWebTools(deps?) -> { searchTool, fetchTool, register(registry),
                            webSearch(query,opts), webFetch(url,opts) }   // raw fns exported for reuse/testing
     deps.fetchImpl  : (url, init) => Promise<Response>   // injectable for tests; defaults to undici.fetch
     deps.openrouter : { apiKey, model } | null           // enables the OpenRouter search/fetch FALLBACK
     deps.userAgent  : override UA string

   DESIGN (re-validated live, June 2026):
     web_search PRIMARY  = Mojeek (GET https://www.mojeek.com/search?q=…), an independent keyless engine,
                           parsed to [{title,url,snippet}]. Chosen because DuckDuckGo's keyless HTML/lite
                           endpoints now return a 202 "anomaly" anti-bot shell on essentially EVERY request
                           (not just under rapid load), so the old DDG-only chain failed for every user — and
                           for ChatGPT/Codex users (no OpenRouter key) there was no fallback at all.
                  FALLBACK1 = DuckDuckGo HTML endpoint (POST https://html.duckduckgo.com/html/). Kept in case
                              DDG un-blocks; the 202/anomaly shell is detected and treated as a soft failure.
                  FALLBACK2 = DuckDuckGo lite endpoint (different markup, sometimes survives when html/ is blocked).
                  FALLBACK3 = OpenRouter web plugin (needs the user's existing OpenRouter key; ~$0.005/call).
     web_fetch  PRIMARY  = Jina Reader (https://r.jina.ai/<url>) -> clean markdown/text. Keyless = 20 RPM.
                           Surfaces upstream errors INSIDE a 200 body ("Warning: Target URL returned error 404"),
                           so we scan the body, not just the status.
                  FALLBACK = direct fetch + HTML->text strip (works great for static/simple pages; no rate limit).

   SECURITY: web_fetch refuses non-http(s) and SSRF targets — loopback/RFC-1918/link-local/ULA/CGNAT,
   IPv6 private + IPv4-mapped, integer/hex IP encodings, and bare intranet names — for the requested
   host, every REDIRECT hop (followed manually + re-validated), and the address a name RESOLVES to
   (rebinding). All network calls are time-bounded. Output is truncated. No secrets are ever logged. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('../fence.js') : (root.SK && root.SK.fence));
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).web = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fence) {
  'use strict';

  const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                     '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const FETCH_MAX_CHARS   = 6000;   // web_fetch truncation
  const net = require('node:net');
  const responseProvenance = require('../response-provenance.js');
  /* RAW-BODY CEILING, applied BEFORE anything parses the response.
     htmlToText is a chain of lazy `[\s\S]*?` replaces — quadratic in the input — and the clamp to
     FETCH_MAX_CHARS ran AFTER it. Measured on a page of repeated "<script>": 64KB -> 55ms, 256KB -> 880ms,
     1MB -> 14.3 SECONDS of synchronous event-loop freeze, and it grows from there. StarNet is one process,
     so that is the whole station stopped by a page the agent was asked to read — and web_fetch is
     read-only, no-consent, callable on any URL including one suggested by untrusted content.
     2MB leaves the extractor far more material than the 6k it will keep, while bounding the worst case to
     well under a second. */
  const RAW_BODY_MAX_CHARS = 2 * 1024 * 1024;
  /* THE CEILING IS ENFORCED WHILE READING, NOT AFTER (2026-10-20). The cut above ran on r.text(), which had
     already pulled, decompressed and decoded the WHOLE body: a 32 MiB file pulled 33,554,432 bytes to keep
     2 Mi characters (station RSS 61 -> 164 MB), an endless stream never finished, and a gzip/br bomb inflated
     in full. Now the body streams in and the read stops at RAW_BODY_MAX_BYTES (3 bytes per UTF-16 unit, so the
     kept text is still the full 2 Mi characters for any UTF-8) and cancels the rest. One TextDecoder pass over
     the kept bytes decodes exactly as Response.text() does (BOM stripped, invalid bytes -> U+FFFD).
     Content-Length is never trusted to refuse a body: under gzip it is the compressed wire size. A response
     without a stream (test doubles that only implement text()) keeps the historic path. `truncated` lets a
     caller say the body was cut instead of calling it whole; `downloadStopped` says the READ stopped at the
     byte cap with more pending. They differ: a 2-6 MiB ASCII body is read whole and only its decoded text is
     cut, so calling that "not downloaded" would be false. */
  const RAW_BODY_MAX_BYTES = RAW_BODY_MAX_CHARS * 3;
  const { note: failNote } = require('../../failopen');
  async function readBodyInfo(r) {
    const body = r && r.body;
    if (!body || typeof body.getReader !== 'function') {
      const t = await r.text();
      const s = String(t == null ? '' : t);
      return s.length > RAW_BODY_MAX_CHARS ? { text: s.slice(0, RAW_BODY_MAX_CHARS), truncated: true, downloadStopped: false } : { text: s, truncated: false, downloadStopped: false };
    }
    const reader = body.getReader();
    const chunks = [];
    let bytes = 0, truncated = false;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        const value = step.value instanceof Uint8Array ? step.value : new Uint8Array(step.value || []);
        const room = RAW_BODY_MAX_BYTES - bytes;
        if (value.byteLength >= room) {
          chunks.push(value.subarray(0, room)); bytes += room;
          truncated = value.byteLength > room;
          break;
        }
        chunks.push(value); bytes += value.byteLength;
      }
      if (bytes >= RAW_BODY_MAX_BYTES && !truncated) truncated = !(await reader.read()).done;   // exactly at the cap: is there more?
    } finally {
      if (truncated) {
        try { await reader.cancel(); } catch (e) { failNote('web.body.cancel', e); }
      } else {
        try { reader.releaseLock(); } catch (e) { failNote('web.body.release', e); }
      }
    }
    const downloadStopped = truncated;   // the read stopped at the byte cap and cancelled the rest
    let s = new TextDecoder('utf-8').decode(Buffer.concat(chunks.map(c => Buffer.from(c.buffer, c.byteOffset, c.byteLength))));
    if (s.length > RAW_BODY_MAX_CHARS) { s = s.slice(0, RAW_BODY_MAX_CHARS); truncated = true; }
    return { text: s, truncated, downloadStopped };
  }
  function readBodyBounded(r) {
    return readBodyInfo(r).then(info => info.text);
  }
  const RAW_BODY_MAX_LABEL = String(RAW_BODY_MAX_CHARS).replace(/\B(?=(\d{3})+(?!\d))/g, ',');   // "2,097,152"
  const RAW_BODY_CUT_NOTE = 'response body cut at its first ' + RAW_BODY_MAX_LABEL + ' characters (raw-body ceiling); the rest was not kept';
  const RAW_BODY_STOP_NOTE = RAW_BODY_CUT_NOTE + ', and the download stopped at ' + String(RAW_BODY_MAX_BYTES).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' bytes';   // "6,291,456"
  const SNIPPET_MAX_CHARS = 320;
  const SEARCH_TIMEOUT_MS = 12000;
  const FETCH_TIMEOUT_MS  = 15000;
  const OPENROUTER_SEARCH_TIMEOUT_MS = SEARCH_TIMEOUT_MS + 8000;

  // ---------- untrusted-content fence ----------
  // Page text and search snippets are attacker-authored input that lands directly in the agent's
  // context (the highest-volume untrusted input in the harness). Fence every web tool result in
  // explicit BEGIN/END markers with a data-not-instructions notice, and scrub any literal END
  // marker from the content so a hostile page cannot close the fence early and smuggle
  // "instructions" outside it. The fence is host-authored transcript framing, not model output.
  // MOVED to sidecar/tools/fence.js (2026-07-25) so browser page reads and MCP connector results — the two
  // untrusted sources that were arriving RAW — share this exact marker pair and scrub. A second copy would
  // drift, and a drifted scrub string is a fence a hostile page can close. Behavior here is unchanged.
  const FENCE_END = fence.FENCE_END;
  const fenceExternal = fence.fenceExternal;

  // ---------- small utilities ----------
  // Abort the fetch when EITHER our own timeout fires OR the parent run signal aborts (a tool-timeout in the
  // registry, or the run being cancelled). Chaining the parent means a cancelled/timed-out web_* call actually
  // drops its in-flight HTTP request instead of running to completion in the background.
  function withTimeout(promiseFactory, ms, parent) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      const reason = new Error('request timed out after ' + ms + 'ms');
      reason.__timeout = true;
      try { ctrl.abort(reason); } catch (_) { ctrl.abort(); }
    }, ms);
    if (parent) {
      if (parent.aborted) { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }
      else { try { parent.addEventListener('abort', () => { try { ctrl.abort(parent.reason); } catch (_) { ctrl.abort(); } }, { once: true }); } catch (_) {} }
    }
    return Promise.resolve(promiseFactory(ctrl.signal)).catch(e => {
      // Node/undici often discards AbortController.reason and reports only "This operation was aborted".
      // Preserve the distinction between our per-provider expiry and a parent run/tool cancellation so the
      // model can change source instead of blindly retrying an opaque abort.
      if (timedOut) {
        const reason = new Error('request timed out after ' + ms + 'ms');
        reason.__timeout = true;
        throw reason;
      }
      throw e;
    }).finally(() => clearTimeout(t));
  }
  function decodeEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch (e) { return ' '; } });
  }
  function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
  function clamp(s, n) { s = String(s); return s.length > n ? s.slice(0, n).trimEnd() + ' …' : s; }
  /* undici's whole message for ANY failed outbound fetch is "fetch failed"; the reason lives on .cause. Name its
     code + host so a failure is diagnosable from the transcript instead of an unactionable slogan — the cause's
     own host/IP first, else the host we DIALLED: a TLS-alert or socket cause (ERR_SSL_TLSV1_ALERT_DECODE_ERROR,
     UND_ERR_SOCKET) carries no host at all, and "fetch failed (ERR_SSL_…)" left a customer unable to tell which
     service broke (2026-10-07). Never the raw cause and never a URL: with auth.in:"query" the request URL carries
     a key. Same shape as telegram.transport.js errOf. Returns e. */
  function nameTransport(e, host) {
    const c = e && e.cause;
    // A response body can fail after headers arrived. Keep its distinct prefix;
    // append only bounded machine metadata, never decoder text or cause URLs.
    if (c && e instanceof Error && e.name !== 'AbortError' && e.message === 'terminated') {
      const code = typeof c.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c.code) ? c.code : '';
      const h = typeof host === 'string' ? host : '';
      const ip = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
      const hostname = h.length <= 253 && (/^[A-Za-z0-9.-]+$/.test(h) || net.isIP(ip)) ? h : '';
      if (code) e.message += ' (' + [code, hostname].filter(Boolean).join(' ') + ')';
      return e;
    }
    if (c && e instanceof Error && /^fetch failed$/.test(e.message)) {
      const detail = [c.code || c.name || '', c.hostname || c.address || host || ''].filter(Boolean).join(' ');
      if (detail) e.message = 'fetch failed (' + detail + ')';
    }
    return e;
  }
  /* Did this failure happen BEFORE any server answered? (no connection, DNS, TLS, reset, no reply in time.)
     An HTTP status or a DDG anomaly page is the web ANSWERING; these are not. Codes are read the same way
     softFetchAnswer reads them (e, e.errors[], e.cause, e.cause.errors[]). */
  const TRANSPORT_CODE_RE = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_\w+|ERR_SSL_\w+|ERR_TLS_\w+|CERT_\w+|\w*_SIGNATURE\w*|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;
  function isTransportFault(e) {
    if (!e) return false;
    if (e.__timeout) return true;
    if (/^fetch failed/.test(String(e.message || ''))) return true;
    const c = e.cause;
    const codes = [e.code].concat(
      (e.errors || []).map(x => x && x.code),
      c ? [c.code].concat((c.errors || []).map(x => x && x.code)) : []
    );
    return codes.some(x => typeof x === 'string' && TRANSPORT_CODE_RE.test(x));
  }

  function waitAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) { reject(signal.reason || new Error('request aborted')); return; }
      const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
      if (signal) signal.addEventListener('abort', () => {
        clearTimeout(timer); reject(signal.reason || new Error('request aborted'));
      }, { once: true });
    });
  }

  /* Process-owned per-host politeness. `run` serializes only matching hosts, spaces requests after
     the first, and remembers bounded server backoff across agent runs. It never retries a request:
     the caller still sees the original 403/429/503 and chooses another source. */
  function makePoliteScheduler(deps) {
    deps = deps || {};
    const minGapMs = Math.max(0, Number(deps.minGapMs == null ? 350 : deps.minGapMs));
    const initialBackoffMs = Math.max(minGapMs, Number(deps.initialBackoffMs == null ? 1200 : deps.initialBackoffMs));
    const maxBackoffMs = Math.max(initialBackoffMs, Number(deps.maxBackoffMs == null ? 30000 : deps.maxBackoffMs));
    const maxHosts = Math.max(1, Number(deps.maxHosts == null ? 512 : deps.maxHosts));
    const wait = typeof deps.wait === 'function' ? deps.wait : waitAbortable;
    // Production injects the wall clock at the composition root. A no-clock unit construction stays
    // conservative (it may wait the full remembered delay) without smuggling ambient time into logic.
    const now = typeof deps.now === 'function' ? deps.now : () => 0;
    const hosts = new Map();
    let touchSeq = 0;

    function stateFor(host) {
      let state = hosts.get(host);
      if (!state) {
        if (hosts.size >= maxHosts) {
          let victim = null;
          for (const [key, candidate] of hosts) {
            if (candidate.queued === 0 && (!victim || candidate.touched < victim[1].touched)) victim = [key, candidate];
          }
          if (victim) hosts.delete(victim[0]);
        }
        state = { tail: Promise.resolve(), seen: false, backoffMs: 0, nextAllowedAt: 0, requests: 0, lastDelayMs: 0, lastStatus: 0, queued: 0, touched: ++touchSeq };
        hosts.set(host, state);
      }
      state.touched = ++touchSeq;
      return state;
    }
    function retryAfterMs(response) {
      try {
        const raw = response && response.headers && response.headers.get('retry-after');
        if (!/^\s*\d+(?:\.\d+)?\s*$/.test(String(raw || ''))) return 0;
        return Math.min(maxBackoffMs, Math.max(0, Math.round(Number(raw) * 1000)));
      } catch (_) { return 0; }
    }
    function note(state, response) {
      const status = Number(response && response.status) || 0;
      state.lastStatus = status;
      if (status === 403 || status === 429 || status === 503) {
        const directed = retryAfterMs(response);
        state.backoffMs = directed || Math.min(maxBackoffMs, state.backoffMs ? state.backoffMs * 2 : initialBackoffMs);
        state.nextAllowedAt = Math.max(state.nextAllowedAt, now() + state.backoffMs);
      } else if (status >= 200 && status < 400) {
        state.backoffMs = 0;
      }
    }
    function awaitTurn(previous, signal) {
      if (!signal) return previous;
      if (signal.aborted) return Promise.reject(signal.reason || new Error('request aborted'));
      return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason || new Error('request aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        previous.then(
          value => { signal.removeEventListener('abort', aborted); resolve(value); },
          error => { signal.removeEventListener('abort', aborted); reject(error); }
        );
      });
    }
    async function run(url, signal, request) {
      let host = '';
      try { host = hostOf(new URL(String(url))); } catch (_) { return request(); }
      const state = stateFor(host);
      const previous = state.tail;
      let release;
      state.tail = new Promise(resolve => { release = resolve; });
      state.queued++;
      try {
        await awaitTurn(previous, signal);
        const delayMs = state.seen ? Math.max(0, state.nextAllowedAt - now()) : 0;
        state.lastDelayMs = delayMs;
        if (delayMs) await wait(delayMs, signal);
        state.seen = true; state.requests++;
        state.nextAllowedAt = Math.max(state.nextAllowedAt, now() + minGapMs);
        const response = await request();
        note(state, response);
        return response;
      } finally { state.queued--; state.touched = ++touchSeq; release(); }
    }
    function snapshot() {
      return Array.from(hosts.entries()).map(([host, state]) => ({
        host, requests: state.requests, backoffMs: state.backoffMs, nextAllowedAt: state.nextAllowedAt,
        lastDelayMs: state.lastDelayMs, lastStatus: state.lastStatus
      }));
    }
    return { run, snapshot };
  }

  // ---------- SSRF / URL guard for web_fetch ----------
  // The model picks the URL, so this guard is a real trust boundary: refuse loopback, RFC-1918,
  // link-local, ULA, CGNAT, IPv6 private/mapped, integer/hex IP encodings, and bare intranet names —
  // for IPv4, IPv6 (bracketed), and (when a resolver is wired) the address a name RESOLVES to.
  function isPrivateV4(h) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
    const p = h.split('.').map(Number);
    if (p.some(n => n > 255)) return true;                       // malformed octet -> refuse
    const a = p[0], b = p[1];
    return a === 0 || a === 127 || a === 10 ||
      (a === 192 && b === 168) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127);                        // CGNAT 100.64.0.0/10
  }
  function isPrivateV6(h) {
    h = String(h).toLowerCase();
    return h === '::1' || h === '::' ||
      /^::ffff:/.test(h) ||                                      // IPv4-mapped (Node renders 127.0.0.1 as ::ffff:7f00:1)
      /^fe[89ab][0-9a-f]:/.test(h) ||                            // fe80::/10 link-local
      /^f[cd][0-9a-f]{2}:/.test(h);                              // fc00::/7 unique-local
  }
  function hostOf(u) {
    let h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[') h = h.slice(1, -1);                 // strip IPv6 brackets
    // ...and the FQDN root label. WHATWG strips a trailing dot for IP literals but NOT for names, so
    // `localhost.` / `svc.internal.` / `wiki.` kept theirs and slipped past every name rule below. The DNS
    // guard would usually catch it downstream, but it is best-effort (a failed lookup returns silently, and
    // deps.lookup:null disables it), so the static rule must be right on its own. Same fix as browser.js.
    else h = h.replace(/\.+$/, '');
    return h;
  }
  // a refusal the HOST wrote: never taints the run, and its row says why (see browser.js hostRefusal)
  function hostRefusal(msg, summary) { const e = new Error(msg); e.hostAuthored = true; if (summary) e.toolSummary = summary; return e; }
  // ...but ONLY for the caller's own URL. A REDIRECT hop's refusal names a host the REMOTE server chose (its Location
  // header, or a name whose DNS it runs), so its text is outside text: it must reach the run like a fetched byte and
  // latch the taint, exactly as before the refusal was host-authored. Every redirect hop's guard error passes here.
  function redirectRefusal(e) { if (e && e.hostAuthored) delete e.hostAuthored; return e; }
  function assertSafeUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw hostRefusal('invalid URL: ' + raw, 'invalid URL'); }
    if (u.protocol === 'file:') throw hostRefusal('only http(s) URLs are allowed. Files are read with fs_read — a worker\'s saved file at the exact path its dispatch row lists (artifacts[].abs).', 'not a web address (file://)');
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw hostRefusal('only http(s) URLs are allowed', 'not a web address');
    const h = hostOf(u);
    const blockedName =
      h === 'localhost' || h === '0.0.0.0' ||
      h === 'metadata.goog' || h.endsWith('.metadata.goog') ||                  // GCP cloud-metadata shorthand (metadata.google.internal already caught by .internal)
      h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') ||
      h.endsWith('.lan') || h.endsWith('.intranet') || h.endsWith('.home') || h.endsWith('.corp');
    const numericHost = /^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h);   // integer / hex IP encodings (e.g. http://2130706433/)
    const bareName = h.indexOf('.') < 0 && h.indexOf(':') < 0 && !numericHost;  // single-label intranet name
    if (blockedName || bareName || numericHost || isPrivateV4(h) || isPrivateV6(h))
      throw hostRefusal('refusing to fetch private/loopback/intranet host: ' + h);
    return u;
  }
  // Resolve every candidate and return the address that the connection must use.
  // A DNS failure is not evidence that the destination is safe, so fail closed.
  function nodeLookup(host) { const dns = require('node:dns'); return dns.promises.lookup(host, { all: true }); }
  async function assertResolvedSafe(u, lookup) {
    const addrs = await resolvedSafeAddrs(u, lookup);
    return addrs && addrs[0];
  }
  async function resolvedSafeAddrs(u, lookup) {
    if (!lookup) return;
    const h = hostOf(u);
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.indexOf(':') >= 0) return;   // already a literal
    // RFC 2606 reserves .invalid specifically for names that can never resolve. Asking the host resolver anyway
    // cost 11s on the release-audit machine before it returned ENOTFOUND, leaving a direct-domain run visibly
    // "working" even though the answer is knowable locally. Preserve the same ENOTFOUND evidence shape without
    // touching ordinary domains or their real DNS semantics.
    if (h.endsWith('.invalid')) {
      const e = new Error('getaddrinfo ENOTFOUND ' + h);
      e.code = 'ENOTFOUND';
      throw e;
    }
    let addrs;
    addrs = await lookup(u.hostname);
    if (!Array.isArray(addrs) || !addrs.length) throw new Error('no verified DNS address for ' + h);
    for (const a of (addrs || [])) {
      const ip = (a && a.address) || '';
      if (!net.isIP(ip)) throw new Error('resolver returned an invalid IP address for ' + h);
      // host-authored like the static refusal above when the name is the caller's own; a redirect hop's name came
      // from the remote server, and its caller strips the mark (redirectRefusal)
      if (isPrivateV4(ip) || isPrivateV6(ip)) throw hostRefusal('refusing: ' + u.hostname + ' resolves to private address ' + ip);
    }
    return addrs;
  }

  // ---------- HTML -> readable text (web_fetch fallback) ----------
  /* HTML -> readable text, in ONE LINEAR PASS.
     This used to be a chain of lazy `[\s\S]*?` replaces, every one of them QUADRATIC on input the fetch
     does not control. `<script` with no `</script>` makes the lazy scan walk to end-of-input from each of
     the N start positions; `<[^>]+>` does the same on a run of `<`. Measured on a page of repeated
     "<script>": 64KB -> 55ms, 256KB -> 880ms, 1MB -> 14.3 SECONDS of synchronous event-loop freeze — the
     whole station (UI, API, SSE bus, every agent run) stopped by a page an agent was asked to read, on a
     read-only no-consent tool. Capping the input alone only moved the number; the scan itself had to stop
     being quadratic.
     An indexOf-driven walk is O(n) and output-equivalent for well-formed HTML: skip the contents of
     script/style/noscript and comments, turn block-closers and <br> into newlines, and drop every other tag.
     An UNCLOSED block or tag consumes the rest of the input exactly as the lazy regex did. */
  const BLOCK_CLOSERS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'section', 'article', 'header', 'footer']);
  const SKIP_BLOCKS = new Set(['script', 'style', 'noscript']);
  function stripMarkup(html) {
    const s = String(html);
    const out = [];
    let i = 0;
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { out.push(s.slice(i)); break; }
      if (lt > i) out.push(s.slice(i, lt));
      if (s.startsWith('<!--', lt)) {                                  // comment: skip to the terminator
        const end = s.indexOf('-->', lt + 4);
        out.push(' ');
        if (end < 0) break;
        i = end + 3; continue;
      }
      const gt = s.indexOf('>', lt + 1);
      if (gt < 0) { out.push(' '); break; }                            // unterminated tag consumes the rest
      const inner = s.slice(lt + 1, gt);
      const m = /^\/?\s*([a-zA-Z][a-zA-Z0-9]*)/.exec(inner);
      const name = m ? m[1].toLowerCase() : '';
      const closing = inner.charAt(0) === '/';
      if (!closing && SKIP_BLOCKS.has(name)) {                         // skip the whole block's contents
        const close = s.toLowerCase().indexOf('</' + name, gt + 1);
        out.push(' ');
        if (close < 0) break;                                          // unclosed block consumes the rest
        const closeGt = s.indexOf('>', close);
        i = closeGt < 0 ? s.length : closeGt + 1; continue;
      }
      if (name === 'br' || (closing && BLOCK_CLOSERS.has(name))) out.push('\n');
      else out.push(' ');
      i = gt + 1;
    }
    return out.join('');
  }
  function htmlToText(html) {
    return decodeEntities(stripMarkup(html))
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ======================================================================
  //  web_search
  // ======================================================================

  // DuckDuckGo wraps result hrefs as /l/?uddg=<encoded-real-url>. Unwrap them.
  function unwrapDDG(href) {
    if (!href) return '';
    href = decodeEntities(href);
    if (href.startsWith('//')) href = 'https:' + href;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const uddg = u.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
      return u.href;
    } catch (e) { return href; }
  }

  // True if the response is DDG's empty anti-bot shell (status 202 + "anomaly"/"challenge", no results).
  function isDDGBlocked(status, html) {
    const low = html.toLowerCase();
    return status === 202 || low.includes('anomaly') || (low.includes('challenge') && !low.includes('result__a'));
  }

  /* The anchor-text capture is BOUNDED. `([\s\S]*?)</a>` scans to end-of-input from every start position
     when the closing tag is absent, so a search-engine body with many result-link OPENS and no closers is
     quadratic: measured 1MB -> 1403ms of frozen event loop on this single-process host. A result TITLE is a
     few dozen characters; 600 is already absurdly generous, and it turns each failed attempt into a fixed
     cost instead of a full scan. (The snippet lookups were already windowed to a 2500-char tail.) */
  function parseDDGHtml(html) {
    const out = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = unwrapDDG(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) continue;
      // snippet lives just after the title link in a .result__snippet element
      const tail = html.slice(m.index, m.index + 2500);
      const sm = tail.match(/class="result__snippet"[^>]*>([\s\S]{0,1200}?)<\/a>/i) ||
                 tail.match(/class="result__snippet"[^>]*>([\s\S]{0,1200}?)<\/(div|span|td)>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  // DDG lite endpoint has a flat <table> of <a class="result-link"> + a following snippet row.
  function parseDDGLite(html) {
    const out = [];
    const re = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = unwrapDDG(m[1]);
      const title = stripTags(m[2]);
      if (!url || !title) continue;
      const tail = html.slice(m.index, m.index + 2500);
      const sm = tail.match(/class="result-snippet"[^>]*>([\s\S]{0,1200}?)<\/td>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  // Mojeek: each result is <li> ... <a class="title" href="<real-url>">Title</a> ... <p class="s">snippet</p>.
  // Unlike DDG the href is the REAL destination (no /l/?uddg= redirect wrapper), so no unwrap is needed.
  function parseMojeek(html) {
    const out = [];
    const re = /<a[^>]*class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const url = decodeEntities(m[1]);
      const title = stripTags(m[2]);
      if (!url || !/^https?:\/\//i.test(url) || !title) continue;
      // snippet lives in the <p class="s"> just after the title link
      const tail = html.slice(m.index, m.index + 3000);
      const sm = tail.match(/<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/i);
      out.push({ title, url, snippet: sm ? clamp(stripTags(sm[1]), SNIPPET_MAX_CHARS) : '' });
    }
    return out;
  }

  function makeWebTools(deps) {
    deps = deps || {};
    const undici = require('undici');
    const rawFetch = deps.fetchImpl || undici.fetch;
    if (!rawFetch) throw new Error('web.js requires global fetch (Node 18+) or deps.fetchImpl');
    const politeness = deps.politeness || makePoliteScheduler({
      wait: deps.politeWait, minGapMs: deps.politeMinGapMs,
      initialBackoffMs: deps.politeInitialBackoffMs, maxBackoffMs: deps.politeMaxBackoffMs,
      now: deps.politeNow, maxHosts: deps.politeMaxHosts
    });
    const doFetch = (url, opts) => politeness.run(url, opts && opts.signal, () => rawFetch(url, opts));
    const UA = deps.userAgent || DEFAULT_UA;
    const or = deps.openrouter || null;
    // DNS-rebinding guard resolver: default to real Node DNS; pass deps.lookup:null to disable (tests).
    const doLookup = ('lookup' in deps) ? deps.lookup : nodeLookup;
    const makePinnedAgent = deps.agentFactory || (options => new undici.Agent(options));
    // One dispatcher per requested hop: its socket lookup returns ONLY the
    // address validated for this hop. The URL stays intact for Host and TLS SNI.
    // Closing after the body is read prevents an old connection from carrying
    // the next hop past its own DNS validation.
    // Node 20+ connects with autoSelectFamily on, which asks the lookup for { all: true } and expects an ARRAY
    // of {address, family}. Answering (address, family) there made Node read `undefined` as the list, so every
    // pinned request died as "fetch failed" (cause ERR_INVALID_IP_ADDRESS) — web_request could reach nothing
    // (user report, 0.12.5 + 0.13.0). The list holds every VALIDATED address, so a v6-less network still
    // reaches v4; the single-address shape keeps the first one.
    async function fetchPinned(u, init) {
      const addrs = await resolvedSafeAddrs(u, doLookup);
      const pinned = addrs ? addrs.map(a => ({ address: a.address, family: a.family || net.isIP(a.address) })) : null;
      const dispatcher = pinned ? makePinnedAgent({ connect: {
        lookup(hostname, options, callback) {
          if (options && options.all) callback(null, pinned.map(a => Object.assign({}, a)));
          else callback(null, pinned[0].address, pinned[0].family);
        }
      } }) : null;
      try {
        const r = await doFetch(u.href, dispatcher ? Object.assign({}, init, { dispatcher }) : init);
        const info = await readBodyInfo(r);
        return { status: r.status, ct: r.headers.get('content-type') || '', loc: r.headers.get('location') || '', body: info.text, bodyTruncated: info.truncated, bodyDownloadStopped: info.downloadStopped };
      } catch (e) {
        // name the cause code + host (nameTransport). Cause host/IP FIRST, the requested hostname only as the
        // fallback — never reorder: the pinned-dispatcher test expects the IP when the cause carries one.
        throw nameTransport(e, u.hostname);
      } finally {
        if (dispatcher) await dispatcher.close();
      }
    }
    // web_request needs the RUN's surface (host authority — never taken from tool args) and a resolver for
    // the Commander's stored keys. Default: no keys and the strict surface, so an unwired caller can only
    // make UNAUTHENTICATED requests rather than silently gaining credentials it was never handed.
    const surface = deps.surface === 'interactive' ? 'interactive' : 'autonomous';
    // The station READER (webreader.js): a shared headless cookie-less real Chrome that fetch/search
    // borrow when plain HTTP hits a bot wall or every engine throttles. Optional — absent, everything
    // behaves exactly as before. Availability is probed lazily per use (Chrome may not exist).
    const reader = deps.reader || null;
    const readerReady = () => { try { return !!(reader && reader.available().ok); } catch (_) { return false; } };
    /* THE READER RUNG KEEPS TIME (live walk 10-14: a worker's search sat on "Searching …" for 80 s, then 185 s, while
       Chromium failed to launch, and nobody was told). When a later rung can still answer (OpenRouter), the browser's
       START gets READER_RUNG_MS; a browser not up by then is passed over, and while it is still starting no search
       queues behind it. The budget bounds ONLY the start (review 10-14): once the browser has produced a page
       (reader.search's onLaunched) the search waits for it as before, so a healthy-but-slow read never tips into the
       PAID OpenRouter search. A browser that could not start is named in the answer (webreader holds it down a while). */
    const READER_RUNG_MS = Number.isFinite(deps.readerBudgetMs) ? Math.max(1, deps.readerBudgetMs) : 15000;
    let readerStarting = null;   // a reader search still running after its rung passed it over
    const readerDown = () => { try { const a = reader && reader.available(); return a && !a.ok && a.launchFailed ? String(a.reason || 'web search\'s background browser could not start') : ''; } catch (_) { return ''; } };
    // start(onLaunched) -> the reader's search promise; resolves LATE when the browser has not STARTED within ms
    function readerWithin(start, ms) {
      let timer = null, up = false, giveUp = null;
      const late = new Promise(res => { giveUp = res; });
      const p = start(() => { up = true; if (timer) { clearTimeout(timer); timer = null; } });
      if (!up) timer = setTimeout(() => giveUp(LATE), ms);
      return Promise.race([p, late]).then(v => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (v !== LATE) return v;
        readerStarting = p;
        const clear = () => { if (readerStarting === p) readerStarting = null; };
        p.then(clear, clear);
        return LATE;
      });
    }
    const LATE = { late: true };
    const serviceKeys = {
      resolve: (name, sfc) => (typeof deps.resolveServiceKey === 'function'
        ? deps.resolveServiceKey(name, sfc)
        : { ok: false, reason: 'unknown' })
    };
    // rng for multipart boundaries: injectable (determinism lint bans ambient Math.random in backend
    // logic); defaults to node crypto on the host. Only the requestTool's multipart path needs it.
    const nodeCrypto = deps.crypto || (typeof require === 'function' ? require('crypto') : null);

    function searchHeaders(extra) {
      return Object.assign({
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      }, extra || {});
    }

    async function ddgSearch(endpoint, parser, query, parent) {
      const html = await withTimeout(signal => doFetch(endpoint, {
        method: 'POST',
        headers: searchHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: 'q=' + formEncode(query) + '&kl=us-en',   // form-urlencoded: spaces are `+` (see the Mojeek law below)
        signal
      }).then(async r => ({ status: r.status, body: await readBodyBounded(r) })), SEARCH_TIMEOUT_MS, parent);
      if (isDDGBlocked(html.status, html.body)) { const e = new Error('duckduckgo rate-limited (anomaly/202)'); e.__blocked = true; throw e; }
      return parser(html.body);
    }

    // PRIMARY: Mojeek — keyless GET, independent index, no aggressive bot-shell. Treat a non-200 (e.g. a
    // 403/429 throttle) as a soft failure so the chain falls through to DDG/OpenRouter.
    /* ⛔ SPACES MUST BE `+`, NOT `%20` (live A/B, 2026-07-31): for a `%20`-encoded multi-word query
       Mojeek answers 200 with a ~5.7KB "Please…" interstitial and ZERO result anchors; the identical
       query `+`-encoded answers the real 20KB result page. encodeURIComponent produces %20, so every
       multi-word search silently got the shell — the field's endless "mojeek: 0 results". Form-style
       encoding is what a real browser submits for a query string, and it is what Mojeek expects. */
    const formEncode = (q) => encodeURIComponent(q).replace(/%20/g, '+');
    async function mojeekSearch(query, parent) {
      const res = await withTimeout(signal => doFetch('https://www.mojeek.com/search?q=' + formEncode(query), {
        method: 'GET', headers: searchHeaders(), signal
      }).then(async r => ({ status: r.status, body: await readBodyBounded(r) })), SEARCH_TIMEOUT_MS, parent);
      if (res.status !== 200) throw new Error('mojeek http ' + res.status);
      return parseMojeek(res.body);
    }

    // FALLBACK3: OpenRouter web plugin. Hides the search as one model turn, but very robust. Enabled via the
    // `plugins:[{id:'web'}]` request field (NOT a tools entry) — results come back as message.annotations of
    // type 'url_citation', which we read below.
    async function openrouterSearch(query, parent) {
      if (!or || !or.apiKey) throw new Error('no OpenRouter key for search fallback');
      const body = {
        model: or.model || 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content:
          'Search the web for: ' + query + '\nReturn the top results as a numbered list, each line "Title — URL — one-sentence snippet".' }],
        plugins: [{ id: 'web', max_results: 8 }]
      };
      const data = await withTimeout(signal => doFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + or.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal
      }).then(r => r.json()), OPENROUTER_SEARCH_TIMEOUT_MS, parent);
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      // Prefer structured url_citation annotations when present.
      const ann = (msg && msg.annotations) || [];
      const cites = ann.filter(a => a && a.type === 'url_citation' && a.url_citation)
                       .map(a => ({ title: a.url_citation.title || a.url_citation.url, url: a.url_citation.url,
                                    snippet: clamp(a.url_citation.content || '', SNIPPET_MAX_CHARS) }));
      if (cites.length) return cites;
      // else parse the model's plain-text list
      const text = (msg && msg.content) || '';
      return String(text).split('\n').map(l => {
        const mm = l.match(/^\s*\d+[.)]\s*(.+?)\s+[—-]\s+(https?:\/\/\S+)\s*[—-]?\s*(.*)$/);
        return mm ? { title: mm[1].trim(), url: mm[2].trim(), snippet: clamp(mm[3].trim(), SNIPPET_MAX_CHARS) } : null;
      }).filter(Boolean);
    }

    // PUBLIC: returns { results:[{title,url,snippet}], source } ; throws only if every path fails.
    async function webSearch(query, opts) {
      query = String(query || '').trim();
      if (!query) throw new Error('empty query');
      const parent = opts && opts.signal;   // the run/tool-timeout signal, threaded down so a cancel drops the fetch
      const errors = [];
      // [source, run, the host it dials — named on a bare transport failure (nameTransport)]
      const chain = [
        ['mojeek',          () => mojeekSearch(query, parent), 'www.mojeek.com'],
        ['duckduckgo-html', () => ddgSearch('https://html.duckduckgo.com/html/', parseDDGHtml, query, parent), 'html.duckduckgo.com'],
        ['duckduckgo-lite', () => ddgSearch('https://lite.duckduckgo.com/lite/', parseDDGLite, query, parent), 'lite.duckduckgo.com']
      ];
      // The READER outranks the paid fallback: a real local Chrome sails past the fingerprint checks
      // that throttle the scrape endpoints, costs nothing, and keeps search working with zero keys.
      // browserNote: what the Commander is told when this search reached the browser rung and the browser was
      // down, still starting, or too slow — only when the rung was actually reached (an engine that answered first
      // makes the browser irrelevant to this search).
      let browserNote = '';
      const laterRung = !!(or && or.apiKey);
      if (reader) {
        const down = readerDown();
        const starting = !down && !!readerStarting && laterRung;
        if (down || starting || readerReady()) chain.push(['browser', async () => {
          if (down) { browserNote = down; throw new Error(down); }
          if (starting) { browserNote = 'web search\'s background browser is still starting'; throw new Error(browserNote); }
          const r = laterRung
            ? await readerWithin(onLaunched => reader.search(query, { signal: parent, onLaunched }), READER_RUNG_MS)
            : await reader.search(query, { signal: parent });
          if (r === LATE) {
            browserNote = 'web search\'s background browser was not ready within ' + (READER_RUNG_MS >= 1000 ? Math.round(READER_RUNG_MS / 1000) + ' s' : READER_RUNG_MS + ' ms');
            throw new Error(browserNote);
          }
          if (r && r.launchFailed) { browserNote = String(r.reason || 'web search\'s background browser could not start'); throw new Error(browserNote); }
          return (r && r.results) || [];
        }]);
      }
      if (laterRung) chain.push(['openrouter', () => openrouterSearch(query, parent), 'openrouter.ai']);
      /* Throttling vs. no connection (2026-10-07). "Every engine declined" is web weather only if some engine
         ANSWERED (a status, an anomaly page, 0 results). When every HTTP engine failed before any server
         answered (offline, DNS down, TLS broken on this machine), calling that throttling would be the harness
         lying about its own connectivity. The reader rung is NEUTRAL: reader.search swallows Chrome's navigation
         failures and resolves [] — that is no proof either way. A cancelled run is a cancel, never "no results". */
      let httpTried = 0, httpTransport = 0;
      for (const [source, fn, host] of chain) {
        if (parent && parent.aborted) throw (parent.reason instanceof Error ? parent.reason : new Error('web_search cancelled'));
        if (source !== 'browser') httpTried++;
        try {
          const results = await fn();
          if (results && results.length) return { results: results.slice(0, (opts && opts.limit) || 8), source, browserNote };
          errors.push(source + ': 0 results');
        } catch (e) {
          if (parent && parent.aborted) throw e;
          nameTransport(e, host);
          if (source !== 'browser' && isTransportFault(e)) httpTransport++;
          errors.push(source + ': ' + (e && e.message ? e.message : String(e)));
        }
      }
      const unreachable = httpTried > 0 && httpTransport === httpTried;
      const e = new Error(unreachable
        ? 'web_search could not reach any search engine (' + errors.join(' | ') + '). This machine\'s network '
          + 'connection may be down, or something on it is blocking HTTPS; this is not engine throttling. Check '
          + 'connectivity before searching again, or finish with an explicit evidence limitation.'
        : 'web_search failed (' + errors.join(' | ')
          + '). Search providers are temporarily unavailable; do not immediately repeat the same search. '
          + 'Use sources already returned, try a known direct URL with web_fetch, or finish with an explicit evidence limitation.');
      e.__allFailed = true; e.__unreachable = unreachable; e.__errors = errors.slice(); e.__browserNote = browserNote; throw e;
    }

    // ====================================================================
    //  web_fetch
    // ====================================================================

    /* Jina Reader — clean text extraction, but KEYED. Its keyless tier is gone: as of 2026-07-25 every
       r.jina.ai request without a token returns 401 AuthenticationRequiredError (verified against
       example.com, Wikipedia and a vendor docs site — it is not a rate limit, it is auth). The old comment
       here still promised "keyless 20 RPM", so every web_fetch spent a doomed round-trip on Jina before
       silently falling back to directFetch. That is why fetch quality quietly degraded for everyone: the
       fallback returns our own cruder htmlToText, and anti-bot sites refuse it outright.
       Now: only attempted when a key is actually configured (deps.jinaKey, wired from the KEYS store), so a
       user with no Jina key goes straight to direct with no wasted hop, and a user WITH one gets the good
       extraction back. Either way the caller still falls back, so this can never be a hard failure. */
    async function jinaFetch(targetUrl, parent) {
      if (!deps.jinaKey) { const e = new Error('jina not configured'); e.__retryDirect = true; throw e; }
      const headers = { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'User-Agent': UA };
      if (deps.jinaKey) headers['Authorization'] = 'Bearer ' + deps.jinaKey;
      // readBodyInfo, like directFetch: a reader body cut at the raw-body ceiling must say so, not read as the whole page
      const res = await withTimeout(signal => doFetch('https://r.jina.ai/' + targetUrl, { headers, signal })
        .then(async r => { const info = await readBodyInfo(r); return { status: r.status, body: info.text, bodyTruncated: info.truncated }; }), FETCH_TIMEOUT_MS, parent);
      if (res.status === 401 || res.status === 402 || res.status === 429) {
        const e = new Error('jina ' + res.status); e.__retryDirect = true; throw e;
      }
      if (res.status >= 400) throw new Error('jina http ' + res.status);
      // Jina reports upstream failures inside a 200 body.
      if (/^Warning: Target URL returned error \d/m.test(res.body)) {
        const w = res.body.match(/Warning: Target URL returned error (\d+)[^\n]*/);
        const e = new Error('upstream ' + (w ? w[1] : 'error')); e.__retryDirect = true; throw e;
      }
      const body = res.body.replace(/^(Title:[^\n]*\n)?(URL Source:[^\n]*\n)?(Published Time:[^\n]*\n)?(Markdown Content:\n)?/i, '');
      return { text: body.trim(), cut: !!res.bodyTruncated };
    }

    // FALLBACK: direct fetch + strip. No rate limit; great for static pages. Redirects are followed
    // MANUALLY so every hop is re-validated against the SSRF guard — a public page cannot bounce us
    // to an internal address (e.g. a 302 -> http://169.254.169.254/ cloud-metadata endpoint).
    // Re-validate a redirect target. Its refusal is never host-authored: the server picked the name (redirectRefusal).
    async function redirectTarget(loc, base) {
      try {
        const next = assertSafeUrl(new URL(loc, base).href);
        await assertResolvedSafe(next, doLookup);
        return next;
      } catch (e) { throw redirectRefusal(e); }
    }
    async function directFetch(u0, parent) {
      let u = u0;
      for (let hop = 0; hop < 6; hop++) {
        let res;
        try {
          res = await withTimeout(signal => fetchPinned(u, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }, redirect: 'manual', signal
          }), FETCH_TIMEOUT_MS, parent);
        } catch (e) { throw hop > 0 ? redirectRefusal(e) : e; }   // fetchPinned re-resolves a redirect hop's name too
        if (res.status >= 300 && res.status < 400 && res.loc) {
          u = await redirectTarget(res.loc, u.href);   // re-validate the redirect target
          continue;
        }
        if (res.status >= 400) throw new Error('http ' + res.status);
        // `cut`: the page body hit the raw-body ceiling, so this text comes from its first part only
        const cut = !!res.bodyTruncated;
        if (/application\/(json|xml)|text\/(plain|csv)/i.test(res.ct)) return { text: res.body.trim(), cut };
        return { text: htmlToText(res.body), cut };
      }
      throw new Error('too many redirects');
    }

    // PUBLIC: returns { text, url, source }; throws only if both paths fail.
    async function webFetch(rawUrl, opts) {
      const u = assertSafeUrl(rawUrl);
      await assertResolvedSafe(u, doLookup);   // refuse names that RESOLVE to private addresses (rebinding)
      const max = (opts && opts.maxChars) || FETCH_MAX_CHARS;
      const parent = opts && opts.signal;   // run/tool-timeout signal, threaded down so a cancel drops the fetch
      let text, source, jErr, cut = false;
      const direct = async () => { const d = await directFetch(u, parent); cut = d.cut; source = 'direct'; return d.text; };
      try { const j = await jinaFetch(u.href, parent); text = j.text; cut = j.cut; source = 'jina'; }
      catch (e) { jErr = e; text = await direct(); }
      if (!text || !text.trim()) {
        if (source === 'jina') text = await direct();
        if (!text || !text.trim()) throw new Error('web_fetch got empty content' + (jErr ? ' (jina: ' + jErr.message + ')' : ''));
      }
      const bounded = clamp(text, max);
      const out = { text: bounded, fullText: bounded === text ? null : text, url: u.href, source };
      if (cut) out.cut = true;   // only when it happened: the result object is otherwise unchanged
      return out;
    }

    // ====================================================================
    //  Tool definitions (match sidecar/tools/tool.js shape)
    // ====================================================================
    /* ---------- web weather is an ANSWER, not an error ----------
       Field data (2026-07-31, the Commander's own live workspace): the single biggest source of
       mid-run "errors" users see is this file throwing on ordinary web reality — bot-blocked sites
       (http 403), dead links (http 404), throttled keyless engines. Each throw became
       "ERROR: tool web_fetch failed: http 403" in the transcript and a red ✗ chip in COMMS, and a
       research task would rack up dozens — reading as a malfunctioning agent when nothing was wrong.
       Reference harnesses (Hermes) return these to the MODEL as plain data and show the user nothing.

       So: when the web ANSWERED — with a refusal, a 404, a throttle — the tool SUCCEEDED at finding
       that out. Return an ok result whose content states the fact and steers the model to a different
       source (never a blind retry). Genuine faults (timeouts, aborts, SSRF refusals, invalid URLs,
       unreachable network) still throw and still become isError results — those keep the loop-guard
       and repeat protection. Truthful telemetry cuts both ways: asserting a FAILURE the harness
       didn't have is as untruthful as hiding one. */
    function softFetchAnswer(e, rawUrl) {
      const msg = String((e && e.message) || '');
      const url = String(rawUrl || '');
      let host = url; try { host = new URL(url).hostname; } catch (_) {}
      const m = msg.match(/^http (\d{3})$/);
      if (m) {
        const s = +m[1];
        if (s === 404 || s === 410) return {
          content: 'No page exists at ' + url + ' (HTTP ' + s + ') — the link is dead or the content moved. ' +
                   'Do not refetch this exact URL; search for where it lives now, or use another source.',
          summary: 'dead link (' + s + ')'
        };
        if (s === 429) return {
          content: host + ' is rate-limiting automated readers right now (HTTP 429). ' +
                   'Use a different source for this information; the URL may work again later.',
          summary: 'rate-limited (429)'
        };
        if (s >= 500) return {
          content: host + '\'s own server is failing right now (HTTP ' + s + ') — an outage on their side. ' +
                   'Use a different source, or retry this URL later.',
          summary: 'site outage (' + s + ')'
        };
        return {
          content: host + ' declined automated access to ' + url + ' (HTTP ' + s + ') — bot protection or a ' +
                   'login wall. This page cannot be read directly; get the same information from a different ' +
                   'source instead of retrying.',
          summary: 'site declined (' + s + ')'
        };
      }
      if (msg === 'too many redirects') return {
        content: 'The URL ' + url + ' redirect-loops (6+ hops) and never lands on a page. Treat it as ' +
                 'unreachable and use a different source.',
        summary: 'redirect loop'
      };
      if (/^web_fetch got empty content/.test(msg)) return {
        content: 'The page at ' + url + ' loaded but yielded no readable text — it likely renders entirely ' +
                 'with JavaScript. Use the browser tool if one is available, or a different source.',
        summary: 'no readable text'
      };
      // getaddrinfo ENOTFOUND — the DOMAIN does not resolve: a dead site or a mistyped host, i.e. an answer.
      // (EAI_AGAIN / ECONNREFUSED / resets stay hard errors: they can also mean the USER'S network is down,
      // and calling that "web weather" would be the harness lying about its own connectivity.)
      const cause = e && e.cause;
      const causeCodes = [e && e.code].concat(
        (e && e.errors || []).map(x => x && x.code),
        cause ? [cause.code].concat((cause.errors || []).map(x => x && x.code)) : []
      );
      if (causeCodes.indexOf('ENOTFOUND') >= 0) return {
        content: 'The domain ' + host + ' does not resolve — the site no longer exists or the hostname is ' +
                 'mistyped. Do not retry this URL; search for the right address or use another source.',
        summary: 'domain not found'
      };
      return null;
    }
    /* The providers above are sequential fallbacks. The registry timeout must cover their SUM, not one
       provider plus a guess. The old 37s wrapper could abort OpenRouter before its own 20s allowance after
       Mojeek + both DDG paths had consumed time — exactly when the fallback was most needed. */
    const searchChainTimeoutMs = (SEARCH_TIMEOUT_MS * 3)
      + (reader ? 45000 : 0)   // the reader rung: Chrome boot + up to two engine navigations
      + ((or && or.apiKey) ? OPENROUTER_SEARCH_TIMEOUT_MS : 0)
      + 5000;
    const searchTool = {
      name: 'web_search', capability: 'web', scope: 'read', requiresConsent: false, timeoutMs: searchChainTimeoutMs,
      resultScrub: false,   // external content, not a station store (registry.js resultScrubFor; review r3)
      description: 'Search the web and get a list of results (title, url, snippet). Use this to find current information and pages to read. ' +
        'If every engine is throttled the result says so: that is temporary web weather, not a malfunction; change strategy instead of repeating the search.',
      schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      run: async (args, ctx) => {
        // visible tool activity is the loop's frozen agent.tool_call / agent.tool_result events
        let results, source, browserNote = '';
        try { ({ results, source, browserNote } = await webSearch(args.query, { signal: ctx && ctx.signal })); }
        catch (e) {
          // An exhausted keyless chain is the engines' weather, not a harness fault — answer it as
          // information (see softFetchAnswer's rationale above). webSearch itself still throws, so
          // programmatic callers and tests keep the strict contract. NOT when no engine could even be reached
          // (__unreachable: offline / TLS broken here) — that is a genuine fault and stays an isError result.
          // …unless the station browser was DOWN (review 10-14): the browser is what gets past the engines' throttling, so a
          // dead one is a station fault the Commander must hear about — named in the summary, never called web weather.
          // That browser is web_search's own (user report 10-28): the agent is told the browser tool is a separate one, so
          // a dead search helper never reads as "browsing is impossible" and ends a run that browser.navigate could finish.
          if (e && e.__allFailed && !e.__unreachable && e.__browserNote) return {
            content: 'No results this time — the keyless engines declined (' + (e.__errors || []).filter(x => !/^browser:/.test(x)).join('; ') + '), and ' +
                     e.__browserNote + ', so it could not search past them. Do not immediately repeat the same search. ' +
                     'That background browser belongs to web_search only: if you have the browser tool, browser.navigate ' +
                     'opens pages in its own, separate browser, which may still start. Otherwise use sources already gathered, ' +
                     'web_fetch a known URL directly, or finish and state the evidence limitation (name the background browser ' +
                     'problem to the Commander).',
            summary: 'no results · ' + e.__browserNote
          };
          if (e && e.__allFailed && !e.__unreachable) return {
            content: 'No results this time — every search engine declined (' + (e.__errors || []).join('; ') + '). ' +
                     'This is temporary throttling of the keyless engines, not a malfunction. Do not immediately ' +
                     'repeat the same search: use sources already gathered, web_fetch a known URL directly, or ' +
                     'finish and state the evidence limitation.',
            summary: 'engines throttled — no results'
          };
          throw e;
        }
        const content = results.length
          ? fenceExternal(
              results.map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.url + (r.snippet ? '\n   ' + r.snippet : '')).join('\n'),
              'search results (titles/snippets are third-party text)')
          : 'No results.';
        // the station's own note, outside the fence: why this search did not use the station browser
        const note = browserNote ? 'Note: ' + browserNote + ', so this search used ' + source + '.\n' : '';
        return { content: note + content, summary: results.length + ' result(s) via ' + source + (browserNote ? ' · ' + browserNote : '') };
      }
    };

    const fetchTool = {
      name: 'web_fetch', capability: 'web', scope: 'read', requiresConsent: false,
      // a page's own text, not a station store: the registry's stored-text scrub turned a Firebase web apiKey or a docs
      // example the task had to copy into [redacted-…] (registry.js resultScrubFor; review r3)
      resultScrub: false,
      timeoutMs: FETCH_TIMEOUT_MS + 20000 + (reader ? 45000 : 0),   // the reader rung needs Chrome boot + nav + settle
      description: 'Fetch a web page by URL and return its main text content (cleaned). Use after web_search to read a result. ' +
        'Bot-blocked and JavaScript-only pages are automatically retried through the station\'s own browser, so one call is enough. ' +
        'If a page still cannot be read (dead link, site outage, verification wall) the result says so: that is information about the site, not a tool failure; use a different source rather than retrying the same URL.',
      schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
      run: async (args, ctx) => {
        let out;
        try { out = await webFetch(args.url, { signal: ctx && ctx.signal }); }
        catch (e) {
          /* THE READER RUNG — a wall a REAL browser can climb: bot-block statuses, challenge-prone
             503s, and JS-only pages. Dead links (404/410), genuine outages (500/502/504) and network
             faults skip it — Chrome cannot resurrect a page that does not exist, and a cold boot is
             not free. On success the label SAYS the browser read it (truthful provenance). */
          const msg = String((e && e.message) || '');
          const m = msg.match(/^http (\d{3})$/);
          const s = m ? +m[1] : 0;
          const walled = s === 401 || s === 403 || s === 407 || s === 429 || s === 451 || s === 503
            || /^web_fetch got empty content/.test(msg);
          if (walled && readerReady()) {
            const r = await reader.fetchText(args.url, { signal: ctx && ctx.signal });
            if (r && r.ok) {
              const text = clamp(r.text, FETCH_MAX_CHARS);
              return {
                content: fenceExternal(text, 'page text from ' + (r.url || args.url) + ' (read via the station browser' + (s ? ' after http ' + s : '') + ')'),
                fullContent: text === r.text ? undefined : fenceExternal(r.text, 'page text from ' + (r.url || args.url) + ' (read via the station browser' + (s ? ' after http ' + s : '') + ')'),
                summary: text.length + ' chars via browser'
              };
            }
            const soft2 = softFetchAnswer(e, args.url);
            if (soft2) return {
              content: soft2.content + ' (The station\'s own browser also tried and was refused'
                + (r && r.reason === 'challenge' ? ' — the site is holding a verification wall' : '') + '.)',
              summary: soft2.summary
            };
          }
          const soft = softFetchAnswer(e, args.url);   // the web ANSWERED (403/404/throttle/…) → ok result
          if (soft) return soft;
          throw e;                                     // genuine fault (timeout/abort/SSRF/bad URL) → isError
        }
        // a page cut at the raw-body ceiling says so in its label instead of reading as the whole page
        const pageLabel = 'page text from ' + out.url + (out.cut ? ' (first ' + RAW_BODY_MAX_LABEL + ' characters of a longer page)' : '');
        return { content: fenceExternal(out.text, pageLabel), fullContent: out.fullText ? fenceExternal(out.fullText, pageLabel) : undefined, summary: out.text.length + ' chars via ' + out.source };
      }
    };

    /* ---------- web_request: call a third-party REST API with the Commander's key ----------
       WHY THIS EXISTS: before it, nothing in StarNet could send a custom header. web_fetch's whole schema
       is {url}, so ANY authenticated API meant handing the agent a full shell (shell.exec + curl), which
       needs a placed workbench and is a far larger grant than "make one HTTPS call". This tool is the
       narrow capability that job actually needs.

       THE SECRET NEVER ENTERS MODEL CONTEXT. The model writes a PLACEHOLDER — Authorization:
       "Bearer ${PRINTIFY_API_KEY}" — and the host substitutes the value at send time from the KEYS store.
       The model can therefore use a key it has never seen, and a transcript/log leak cannot spend it.
       Placeholders resolve in HEADERS ONLY: putting a secret in a URL would leak it into history, proxy
       logs, and Referer headers, so a placeholder in the url is refused rather than silently sent. */
    const SECRET_REF_RE = /\$\{([A-Z][A-Z0-9_]*)\}/g;
    const SECRET_REF_TEST = /\$\{[A-Z][A-Z0-9_]*\}/;   // non-global twin: .test() on a /g regex is stateful
    /* WORKSPACE FILES IN AN OUTBOUND REQUEST. Upload endpoints (Printify/Printful/Shopify-class) take file
       BYTES — base64 inside JSON, or multipart/form-data — and the body is model-written text: a 2MB PNG is
       ~2.8M base64 chars, orders of magnitude past any context budget, so for months the harness simply could
       not carry the byte-bearing step of any API workflow. Same cure as ${KEY} headers: the model writes a
       REFERENCE (${file:relative/path}, or a multipart part naming a file), the host resolves it at send
       time, and the payload never enters model context in either direction. Files resolve through
       deps.readWorkspaceFile: the per-agent workspace jail only (no project root, no absolute paths, no
       path-trust), so a request can only ever carry the agent's own workspace. This is deliberately narrower
       than fs.read and browser.upload, which also reach the run's trusted project: widening an outbound-network
       tool is a decision, not a polish fix. Lowercase 'file:' can never collide with SECRET_REF's [A-Z] names. */
    const FILE_REF_RE = /\$\{file:([^}]*)\}/g;
    const FILE_REF_TEST = /\$\{file:/;
    const FILE_MAX_BYTES = 20 * 1024 * 1024;      // one referenced file
    const PAYLOAD_MAX_BYTES = 25 * 1024 * 1024;   // the whole outbound body
    const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json',
      txt: 'text/plain', csv: 'text/csv', zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg' };
    const guessMime = (name) => MIME_BY_EXT[String(name).replace(/^.*\./, '').toLowerCase()] || 'application/octet-stream';
    /* NO TOOL-LEVEL CLAMP ON THE RESPONSE (2026-10-12, user report: an Etsy-factory Publisher could not configure a
       Printify product). The body used to be cut to 8,000 characters right here, the rest destroyed and nothing
       parked. A commerce API answers in documents far past that — a Printify product with its variants and print
       areas runs 50-200 KB, a blueprint's variant catalog the same — so the agent saw a third of a product, could not
       build a valid PUT (Printify wants EVERY variant when variants are sent), could not read back its own write,
       and either looped on "cannot verify" or guessed ids. The whole body now goes to the registry, whose
       window-scaled cap shows what fits and PARKS the rest to a file the agent reads in ranges (registry.js
       PARKING). `select` below asks for just the fields a step needs, extracted host-side from the whole body. */
    const SELECT_MAX_PATHS = 40;
    const UNSAFE_KEY = new Set(['__proto__', 'constructor', 'prototype']);
    const MISSING = Symbol('missing');
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    function selectPaths(raw) {
      const list = Array.isArray(raw) ? raw : (raw == null ? [] : String(raw).split(','));
      return list.map(s => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, SELECT_MAX_PATHS);
    }
    // "variants[].id" -> ['variants','[]','id'] · "[].id" -> ['[]','id'] · jq-ish "$.data[*].title" / "data.*.title" too
    function pathSegments(p) {
      return String(p).replace(/^\$?\.?/, '').replace(/\[\*?\]|\.\*(?=\.|$)/g, '.[].').split('.').filter(Boolean);
    }
    // The selected sub-tree of `node`, nesting kept, or MISSING. Arrays map element-wise, so paths that share an
    // array ("variants[].id" + "variants[].price") merge back into one row per element.
    function pickPath(node, segs) {
      if (!segs.length) return node;
      const head = segs[0], rest = segs.slice(1);
      if (head === '[]') {
        if (!Array.isArray(node)) return MISSING;
        const arr = node.map(x => pickPath(x, rest));
        return arr.some(x => x !== MISSING) ? arr : MISSING;
      }
      if (UNSAFE_KEY.has(head) || !node || typeof node !== 'object' || Array.isArray(node) || !own(node, head)) return MISSING;
      const v = pickPath(node[head], rest);
      if (v === MISSING) return MISSING;
      const o = {}; o[head] = v; return o;
    }
    function mergePicked(a, b) {
      if (a === MISSING) return b;
      if (b === MISSING) return a;
      if (Array.isArray(a) && Array.isArray(b)) return a.map((x, i) => mergePicked(x, i < b.length ? b[i] : MISSING));
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        const o = {};
        for (const k of Object.keys(a)) if (!UNSAFE_KEY.has(k)) o[k] = a[k];
        for (const k of Object.keys(b)) if (!UNSAFE_KEY.has(k)) o[k] = own(o, k) ? mergePicked(o[k], b[k]) : b[k];
        return o;
      }
      return b;
    }
    function projectJson(text, paths) {
      let data;
      try { data = JSON.parse(text); } catch (_) { return { ok: false, why: 'the response is not JSON' }; }
      let out = MISSING; const missed = [];
      for (const p of paths) {
        const segs = pathSegments(p);
        const v = segs.length ? pickPath(data, segs) : MISSING;
        if (v === MISSING) missed.push(p); else out = mergePicked(out, v);
      }
      if (out === MISSING) {
        // name the real shape so the next call can fix its paths instead of guessing again
        const shape = Array.isArray(data) ? 'a JSON array of ' + data.length + ' items (start paths with [] , e.g. "[].id")'
          : (data && typeof data === 'object' ? 'an object with keys: ' + Object.keys(data).slice(0, 30).join(', ') : 'a JSON ' + typeof data);
        return { ok: false, why: 'none of the selected fields exist; the response is ' + shape };
      }
      return { ok: true, text: JSON.stringify(out, (k, v) => (v === MISSING ? null : v)), missed };
    }
    /* THE NEXT MOVE, AT THE MOMENT OF BLOCKAGE. A live A/B run (haiku-4.5, 2026-10-12) showed a model handed the whole
       1.4 MB body (head + tail in view, the rest parked) still never thought of `select` — it paged the parked file and
       guessed. So when a JSON body is bigger than this result can show, the host names the document's shape and a
       ready select for it, in front of the body where no cut can reach. */
    function jsonShapeHint(text, budget) {
      if (!(text.length > budget)) return '';
      let data; try { data = JSON.parse(text); } catch (_) { return ''; }
      const objOf = arr => arr.find(x => x && typeof x === 'object' && !Array.isArray(x));
      const keysOf = o => { const k = Object.keys(o).filter(x => !UNSAFE_KEY.has(x)); return k.slice(0, 20).join(', ') + (k.length > 20 ? ', …' : ''); };
      let shape, example = [];
      if (Array.isArray(data)) {
        const el = objOf(data);
        shape = 'an array of ' + data.length + ' items' + (el ? ' shaped {' + keysOf(el) + '}' : '');
        if (el) example = Object.keys(el).filter(x => !UNSAFE_KEY.has(x)).slice(0, 2).map(k => '[].' + k);
      } else if (data && typeof data === 'object') {
        const keys = Object.keys(data).filter(x => !UNSAFE_KEY.has(x));
        shape = 'an object with ' + keys.slice(0, 20).map(k => {
          if (!Array.isArray(data[k])) return k;
          const el = objOf(data[k]);
          return k + ' (array of ' + data[k].length + (el ? ' {' + keysOf(el) + '}' : '') + ')';
        }).join('; ');
        example = keys.filter(k => !Array.isArray(data[k]) && (data[k] === null || typeof data[k] !== 'object')).slice(0, 2);
        const arrKey = keys.find(k => Array.isArray(data[k]) && objOf(data[k]));
        if (arrKey) example = example.concat(Object.keys(objOf(data[arrKey])).filter(x => !UNSAFE_KEY.has(x)).slice(0, 2).map(k => arrKey + '[].' + k));
      } else return '';
      return 'this JSON response is ' + text.length + ' characters, more than this result can show, so part of it is cut below '
        + '(the whole body is saved to the file named at the cut). It is ' + shape + '. To get exactly the fields you need from the '
        + 'WHOLE response, call web_request again with select' + (example.length ? ', e.g. "select": ' + JSON.stringify(example) : '') + '.';
    }
    const SAFE_METHODS = new Set(['GET', 'HEAD']);
    const ALL_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

    // One refusal per resolver verdict, shared by ${KEY} headers and the auth descriptor.
    function keyRefusal(r, name) {
      if (r.reason === 'unattended') return 'this run is unattended and "' + r.name + '" is not approved for unattended use — approve it in CONNECT › ABILITIES › CONNECTED › API KEYS, or run this while watching';
      if (r.reason === 'unresolved') return '"' + r.name + '" is kept in 1Password and could not be read (' + String(r.detail || 'not read yet') + ') — ask the Commander to unlock 1Password, then try again. Do not ask for the key itself';
      // A MODEL-PROVIDER key is never handed to a tool and KEYS refuses to store one, so pointing at KEYS here sent
      // agents to ask the Commander for "access" nobody can grant (2026-09-28: OpenRouter was already connected;
      // the agent wanted the raw key to chase a transparent background image_generate could not make yet).
      if (r.reason === 'reserved') return name + ' is a model-provider key: StarNet never hands provider keys to tools and API KEYS cannot store one, so do not ask the Commander for it. Use the built-in tools that already ride the station\'s connection instead: image_generate for images (transparent:true for a transparent background) and image_analyze to look at one.';
      // A key pasted into chat is saved with keys.save (advertised only on a run whose Commander's messages hold one),
      // so the fix names that route too — "add it in KEYS" alone sent agents asking for "a new key" (2026-10-25).
      return 'no enabled service key provides ' + name + ' — if the Commander pasted the key into this chat, save it with keys.save first; '
        + 'otherwise ask them to paste it here, or add it in CONNECT › ABILITIES › CONNECTED › API KEYS';
    }

    function resolveSecretRefs(value, surface, used) {
      let failure = null;
      const out = String(value).replace(SECRET_REF_RE, (whole, name) => {
        const r = serviceKeys.resolve(name, surface);
        if (r.ok) { used.push(name); return r.value; }
        failure = failure || keyRefusal(r, name);
        return whole;
      });
      return { out, failure };
    }

    const requestTool = {
      // scope 'write', NOT 'execute': in this codebase 'execute' means running a host process (shell.exec,
      // verify.run) and carries the autonomous exec lockout. This mutates a THIRD-PARTY resource over HTTPS
      // and spawns nothing, so it is a write — which is also what keeps it under the exec lockout by design.
      name: 'web_request', capability: 'web', scope: 'write', impact: 'external-credentialed',
      requiresConsent: true, network: true, timeoutMs: FETCH_TIMEOUT_MS + 20000,
      description:
        'Call a third-party REST API (Printify, Etsy, Stripe, any HTTP API) and return the response. ' +
        'To authenticate, put a stored key\'s environment-variable NAME in a header value as ${NAME}, ' +
        'e.g. headers {"Authorization": "Bearer ${PRINTIFY_API_KEY}"}. The host substitutes the real value at send time; ' +
        'you never see it; save a key pasted in chat with keys.save. Placeholders work in headers only, never in the url.',
      schema: {
        type: 'object', required: ['url'],
        properties: {
          url: { type: 'string', description: 'Full https URL of the API endpoint.' },
          select: {
            type: 'array', items: { type: 'string' },
            description: 'JSON field paths to return from the WHOLE response; [] walks arrays: ["id","variants[].id"] or ["[].id"].'
          },
          method: { type: 'string', description: 'GET (default), HEAD, POST, PUT, PATCH or DELETE.' },
          headers: { type: 'object', description: 'Request headers; ${KEY_NAME} placeholders allowed.' },
          body: {
            type: 'string',
            description: 'Request body for POST/PUT/PATCH (JSON as a string). Put ${file:relative/path} where a file\'s ' +
              'base64 belongs; the host encodes that workspace file at send time, e.g. ' +
              '{"contents":"${file:mockups/mockup.png}"}. Never base64 a file yourself.'
          },
          multipart: {
            type: 'array',
            items: {
              type: 'object', required: ['name'],
              properties: {
                name: { type: 'string', description: 'Form field name.' },
                file: { type: 'string', description: 'Workspace-relative file to attach (curl -F style).' },
                value: { type: 'string', description: 'Text of a plain field; give file OR value, not both.' },
                filename: { type: 'string', description: 'Filename to present (defaults to the file\'s own name).' },
                contentType: { type: 'string', description: 'Part content-type (defaults from the file extension).' }
              }
            },
            description: 'multipart/form-data instead of body, for file-upload endpoints, ' +
              'e.g. [{"name":"file","file":"mockups/a.png"},{"name":"title","value":"Mockup A"}].'
          },
          auth: {
            type: 'object',
            description: 'For an API that wants the key as a query parameter: ' +
              '{"key":"SOME_API_KEY","in":"query","name":"api_key"}; the host appends it at send time, so the ' +
              'secret never appears in the url you write. "in":"header" also works (optional "prefix", e.g. "Bearer ").'
          }
        }
      },
      run: async (args, ctx) => {
        const method = String((args && args.method) || 'GET').toUpperCase();
        if (!ALL_METHODS.has(method)) throw new Error('unsupported method: ' + method);
        const rawUrl = String((args && args.url) || '');
        if (SECRET_REF_TEST.test(rawUrl)) {
          throw new Error('a ${KEY} placeholder cannot go in the url — secrets in URLs leak into logs and history. Put it in a header instead.');
        }
        if (FILE_REF_TEST.test(rawUrl)) {
          throw new Error('a ${file:...} reference cannot go in the url — files travel in the body or in multipart parts.');
        }
        const u = assertSafeUrl(rawUrl);
        await assertResolvedSafe(u, doLookup);

        const used = [];
        /* WHICH HEADER SLOTS ACTUALLY CARRY A SECRET. The redirect guard below used to decide this by NAME
           (authorization|cookie|x-api-key) — but the model picks the slot, and half the real API world puts
           the key somewhere else (X-Shopify-Access-Token, Private-Token, apikey, X-Auth-Token), so an open
           redirect on a trusted host forwarded the Commander's key to the attacker verbatim. The host does
           not need to guess: the substitution happens right here, so record the exact keys it wrote into. */
        const secretHeaders = new Set();
        const headers = { 'User-Agent': UA, 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8' };
        const src = (args && args.headers && typeof args.headers === 'object') ? args.headers : {};
        for (const k of Object.keys(src)) {
          if (/[\r\n]/.test(k) || /[\r\n]/.test(String(src[k]))) throw new Error('header contains a newline: ' + k);
          if (FILE_REF_TEST.test(String(src[k]))) throw new Error('a ${file:...} reference cannot go in a header — files travel in the body or in multipart parts.');
          const before = used.length;
          const r = resolveSecretRefs(src[k], surface, used);
          if (r.failure) throw new Error(r.failure);
          if (used.length > before) secretHeaders.add(k.toLowerCase());   // this slot now holds a real key
          headers[k] = r.out;
        }
        /* A ${KEY} placeholder in the BODY is silently NOT substituted (headers only, by design) — which
           shipped the literal text "${STRIPE_API_KEY}" to the third party and left the model debugging a
           confusing 401. Refuse it with the same clarity the url check already uses. */
        if (args && args.body != null && SECRET_REF_TEST.test(String(args.body))) {
          throw new Error('a ${KEY} placeholder cannot go in the body — the host substitutes stored keys into HEADERS only. Put it in a header (or use "auth").');
        }
        /* AUTH DESCRIPTOR — for APIs that take the key as a query parameter. The model NAMES the key and the
           slot; the HOST resolves and attaches it here, after the model has finished composing the request.
           That keeps the "a secret never appears in a url the model wrote" rule intact while still covering
           the (real, common) class of APIs that will not accept a header. The value is attached only to the
           FIRST hop: a redirect target comes from the server, so an open redirect cannot carry it onward. */
        const auth = (args && args.auth && typeof args.auth === 'object') ? args.auth : null;
        if (auth) {
          const where = String(auth.in || 'header').toLowerCase();
          const slot = String(auth.name || '').trim();
          const keyName = String(auth.key || '').trim();
          if (!slot) throw new Error('auth.name is required (the header or query-parameter name to put the key in)');
          if (!/^[A-Z][A-Z0-9_]*$/.test(keyName)) throw new Error('auth.key must be a stored key NAME like PRINTIFY_API_KEY, never a key value');
          if (where !== 'query' && where !== 'header') throw new Error('auth.in must be "query" or "header"');
          const r = serviceKeys.resolve(keyName, surface);
          if (!r.ok) throw new Error(keyRefusal(r, keyName));
          used.push(keyName);
          if (where === 'query') u.searchParams.set(slot, r.value);
          else { headers[slot] = String(auth.prefix || '') + r.value; secretHeaders.add(slot.toLowerCase()); }
        }

        /* ---- assemble the outbound payload (string body, ${file:...} substitution, or multipart) ----
           Bytes are read HOST-SIDE through the fs jail and never surface in the tool result — the label
           names which files were sent (truthful provenance), the content itself stays out of context. */
        const canCarryBody = method !== 'GET' && method !== 'HEAD';
        const multipart = (args && Array.isArray(args.multipart)) ? args.multipart : null;
        if (multipart && args && args.body != null) throw new Error('send either body or multipart, not both');
        if (multipart && !canCarryBody) throw new Error('multipart needs POST, PUT or PATCH');
        const sentFiles = [];
        let payloadBytes = 0;
        const readFileRef = async (rel) => {
          const rr = String(rel == null ? '' : rel).trim();
          if (!rr) throw new Error('a file reference needs a workspace-relative path');
          if (typeof deps.readWorkspaceFile !== 'function') throw new Error('this run has no workspace, so it cannot attach files');
          // throws on jail escape ('..', absolute, symlink out) and on a missing file — fail loudly pre-send
          const buf = await deps.readWorkspaceFile((ctx && ctx.agentId) || 'agent', rr);
          if (buf.length > FILE_MAX_BYTES) throw new Error('"' + rr + '" is ' + (buf.length / (1024 * 1024)).toFixed(1) + 'MB — the per-file limit is ' + (FILE_MAX_BYTES / (1024 * 1024)) + 'MB');
          payloadBytes += buf.length;
          if (payloadBytes > PAYLOAD_MAX_BYTES) throw new Error('the request payload exceeds the ' + (PAYLOAD_MAX_BYTES / (1024 * 1024)) + 'MB total limit');
          sentFiles.push(rr);
          return buf;
        };
        let bodyPayload;   // string | Buffer | undefined
        if (multipart) {
          if (!multipart.length) throw new Error('multipart needs at least one part');
          // quotes/CRLF in a name or filename would break out of the Content-Disposition header line
          const cleanToken = (s, what) => { s = String(s); if (/[\r\n"]/.test(s)) throw new Error(what + ' must not contain quotes or newlines'); return s; };
          if (!nodeCrypto) throw new Error('multipart needs the Node host');
          const boundary = '----StarNetPart' + nodeCrypto.randomBytes(16).toString('hex');
          const chunks = [];
          for (const p of multipart) {
            if (!p || typeof p !== 'object' || !p.name) throw new Error('each multipart part needs a "name"');
            const hasFile = p.file != null, hasValue = p.value != null;
            if (hasFile === hasValue) throw new Error('part "' + p.name + '": give exactly one of "file" (workspace path) or "value" (literal text)');
            if (hasValue && SECRET_REF_TEST.test(String(p.value))) throw new Error('a ${KEY} placeholder cannot go in a multipart value — the host substitutes stored keys into HEADERS only.');
            let head = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + cleanToken(p.name, 'a part name') + '"';
            let data;
            if (hasFile) {
              data = await readFileRef(p.file);
              const fname = cleanToken(p.filename != null ? p.filename : String(p.file).replace(/^.*[\\/]/, ''), 'a filename');
              head += '; filename="' + fname + '"\r\nContent-Type: ' + (p.contentType ? cleanToken(p.contentType, 'a part content-type') : guessMime(fname));
            } else {
              data = Buffer.from(String(p.value), 'utf8');
              if (p.contentType) head += '\r\nContent-Type: ' + cleanToken(p.contentType, 'a part content-type');
            }
            chunks.push(Buffer.from(head + '\r\n\r\n', 'utf8'), data, Buffer.from('\r\n', 'utf8'));
          }
          chunks.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
          bodyPayload = Buffer.concat(chunks);
          headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;   // ours wins: the boundary must match the encoding
        } else if (canCarryBody && args && args.body != null) {
          const s = String(args.body);
          if (FILE_REF_TEST.test(s)) {
            let out = '', last = 0, m;
            FILE_REF_RE.lastIndex = 0;
            while ((m = FILE_REF_RE.exec(s))) {
              out += s.slice(last, m.index) + (await readFileRef(m[1])).toString('base64');
              last = m.index + m[0].length;
            }
            bodyPayload = out + s.slice(last);
          } else {
            bodyPayload = s;
          }
        }
        const hasBody = bodyPayload !== undefined;
        if (hasBody && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';

        /* Redirects are followed manually so every hop is re-validated against the SSRF guard. Credentials are
           dropped the moment the ORIGIN changes — an open redirect must never forward the user's key.
           TWO corrections to what "origin" and "credential" mean here:
             · origin, not host. hostOf() ignores scheme and port, so an https -> http redirect on the SAME
               hostname kept the Authorization header and put the key on the wire in CLEARTEXT.
             · the slots we PROVABLY filled with a secret (secretHeaders), not a three-name denylist — plus
               the denylist, which still covers a credential the caller supplied literally rather than via
               ${KEY} (a pasted cookie or bearer we never resolved and therefore never recorded). */
        const originOf = (x) => x.protocol + '//' + hostOf(x) + ':' + (x.port || (x.protocol === 'https:' ? '443' : '80'));
        const firstOrigin = originOf(u);
        const isCredential = (k) => secretHeaders.has(k.toLowerCase()) || /^(authorization|cookie|x-api-key)$/i.test(k);
        let target = u, res = null, responseUrl = null;
        for (let hop = 0; hop < 5; hop++) {
          const sendHeaders = hop === 0 || originOf(target) === firstOrigin
            ? headers
            : Object.keys(headers).reduce((o, k) => (isCredential(k) ? o : (o[k] = headers[k], o)), {});
          try {
            res = await withTimeout(signal => fetchPinned(target, {
              method, headers: sendHeaders, body: hasBody ? bodyPayload : undefined, redirect: 'manual', signal
            }), FETCH_TIMEOUT_MS, ctx && ctx.signal);
          } catch (e) { throw hop > 0 ? redirectRefusal(e) : e; }   // a redirect hop's re-resolve refusal is outside text
          // Capture the URL that actually answered, before a redirect advances target (even on the last hop).
          responseUrl = target.href;
          if (res.status >= 300 && res.status < 400 && res.loc) {
            target = await redirectTarget(res.loc, target.href);
            continue;
          }
          break;
        }

        // The response is UNTRUSTED third-party data — fenced like every other external content path so a
        // hostile API body cannot issue instructions. redact() strips any secret that echoed back.
        const scrub = typeof deps.redact === 'function' ? deps.redact : (s => s);
        const bodyText = scrub(String(res.body || ''));
        const label = method + ' ' + u.origin + u.pathname + ' -> HTTP ' + res.status
          + (used.length ? ' (authenticated with ' + used.join(', ') + ')' : '')
          + (sentFiles.length ? ' (sent ' + Math.ceil(payloadBytes / 1024) + 'KB from workspace file' + (sentFiles.length > 1 ? 's' : '') + ': ' + sentFiles.join(', ') + ')' : '');
        // The host's note rides OUTSIDE the fence (it is ours, not the third party's) and BEFORE it, so a head+tail
        // cut of a large selection can never eat it.
        const paths = selectPaths(args && args.select);
        /* A BODY CUT AT THE RAW-BODY CEILING IS NEVER CALLED WHOLE (2026-10-20). The cut used to be silent, and the
           notes below then described a >2 MB answer as "the whole N-character response" / "The complete response
           is saved" — so select failed on the cut JSON or the agent reasoned from partial data it was told was
           complete. A cut body gets the host's own note, and every "whole"/"complete" claim speaks of the
           received part instead. */
        const cutBody = !!res.bodyTruncated;
        // "not downloaded" only when the read really stopped at the byte cap; a body read whole was only not KEPT
        const cutLine = cutBody ? '[' + (res.bodyDownloadStopped ? RAW_BODY_STOP_NOTE : RAW_BODY_CUT_NOTE) + ']\n' : '';
        let shown = bodyText, note = '';
        if (!paths.length && res.status >= 200 && res.status < 300) {
          let budget = ctx ? ctx.outputMax : null;
          if (typeof budget === 'function') { try { budget = budget(); } catch (_) { budget = null; } }
          budget = Number(budget) > 0 ? Number(budget) : 80000;   // registry OUTPUT_MAX when no host budget was passed
          note = jsonShapeHint(bodyText, budget);
        } else if (paths.length) {
          if (res.status < 200 || res.status >= 300) {
            note = 'select was not applied: the call failed with HTTP ' + res.status + (cutBody ? ', so the received part of the error body follows.' : ', so the whole error body follows.');
          } else {
            const p = projectJson(bodyText, paths);
            if (p.ok) {
              shown = p.text;
              note = 'selected ' + (paths.length - p.missed.length) + ' of ' + paths.length + ' field path(s) from '
                + (cutBody ? 'the first ' + bodyText.length + ' characters of a longer response' : 'the whole ' + bodyText.length + '-character response')
                + (p.missed.length ? '; not present: ' + p.missed.join(', ') : '')
                + (cutBody ? '. The received part is saved too; its file is named below.' : '. The complete response is saved too; its file is named below.');
            } else {
              note = 'select was not applied: ' + p.why + (cutBody ? '. The received part of the response follows.' : '. The whole response follows.');
            }
          }
        }
        const fenced = fenceExternal(bodyText || '(empty response body)', label);
        if (shown === bodyText) return responseProvenance.stamp({ content: cutLine + (note ? '[' + note + ']\n' : '') + fenced, summary: method + ' ' + hostOf(u) + ' ' + res.status }, responseUrl);
        return responseProvenance.stamp({
          content: cutLine + '[' + note + ']\n' + fenceExternal(shown, label + ' (selected fields)'),
          fullContent: fenced,   // the registry parks this whole body and names the file in the result
          summary: method + ' ' + hostOf(u) + ' ' + res.status + ' (select)'
        }, responseUrl);
      }
    };

    return {
      searchTool, fetchTool, requestTool, webSearch, webFetch,
      // exported for unit tests
      _internals: { parseDDGHtml, parseDDGLite, parseMojeek, unwrapDDG, isDDGBlocked, htmlToText, assertSafeUrl, assertResolvedSafe, isPrivateV4, isPrivateV6, fenceExternal, withTimeout, politeness },
      register(reg) { reg.register(searchTool); reg.register(fetchTool); reg.register(requestTool); return reg; }
    };
  }

  return { makeWebTools, makePoliteScheduler };
});
