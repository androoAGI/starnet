/* node test/web.search.test.js — the web_search source chain + Mojeek parser. Offline + deterministic
   (fetch injected, DNS disabled). Guards the fix for the DuckDuckGo "anomaly/202" outage: Mojeek is the
   keyless PRIMARY, DDG html/lite are fallbacks, and a fully-blocked chain fails loudly. Pairs with
   sidecar/tools/builtin/web.js. */
'use strict';
const A = require('./_assert.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');

// A real-shape Mojeek result page (two results). Note the &#8217; / &#8211; entities — they MUST decode.
const MOJEEK_HTML =
  '<ul class="results-standard">' +
  '<li class="r1"><a title="https://www.anthropic.com/news" href="https://www.anthropic.com/news" class="ob">' +
  '<p class="i"><span class="url">https://www.anthropic.com<span> &rsaquo; news</span></span></p></a>' +
  '<h2><a class="title" title="https://www.anthropic.com/news" href="https://www.anthropic.com/news">' +
  'What&#8217;s new &#8211; Anthropic</a></h2>' +
  '<p class="s">The latest <strong>Claude</strong> announcements and research.</p></li>' +
  '<li class="r2"><a title="https://example.org/a" href="https://example.org/a" class="ob"><p class="i">x</p></a>' +
  '<h2><a class="title" title="https://example.org/a" href="https://example.org/a">Second Result</a></h2>' +
  '<p class="s">A second snippet.</p></li>' +
  '</ul>';

// DDG's anti-bot shell: 202 + "anomaly", no result anchors.
const DDG_ANOMALY = { status: 202, body: '<html><body>If this error persists... anomaly detected</body></html>' };
const DDG_HTML_OK =
  '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fddg.example%2Fhit">DDG Hit</a>' +
  '<div class="result__snippet">From DuckDuckGo.</div>';

// build a fetch stub from a routing table keyed by URL substring -> {status, body}
function stubFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [needle, resp] of routes) {
      if (u.indexOf(needle) >= 0) return { status: resp.status, text: async () => resp.body };
    }
    return { status: 404, text: async () => '' };
  };
}

(async () => {
  // ---- A. parseMojeek extracts title/url/snippet and decodes HTML entities ----
  const W0 = makeWebTools({ fetchImpl: async () => ({ status: 200, text: async () => '' }), lookup: null });
  const parsed = W0._internals.parseMojeek(MOJEEK_HTML);
  A.eq(parsed.length, 2, 'parseMojeek finds both results');
  A.eq(parsed[0].url, 'https://www.anthropic.com/news', 'parseMojeek takes the real href (no redirect unwrap)');
  A.ok(parsed[0].title.indexOf('&#') < 0 && /^What’s new – Anthropic$/.test(parsed[0].title),
    'parseMojeek decodes numeric entities in the title (&#8217;->’, &#8211;->–)');
  A.ok(/latest Claude announcements/.test(parsed[0].snippet), 'parseMojeek pulls the <p class="s"> snippet, tags stripped');
  A.ok(parsed[0].snippet.indexOf('<strong>') < 0, 'parseMojeek strips tags from the snippet');

  // ---- B. Mojeek is PRIMARY: a 200 Mojeek page wins even though DDG would also answer ----
  const wMojeek = makeWebTools({ fetchImpl: stubFetch([
    ['mojeek.com', { status: 200, body: MOJEEK_HTML }],
    ['duckduckgo', { status: 200, body: DDG_HTML_OK }]
  ]), lookup: null });
  const r1 = await wMojeek.webSearch('anthropic', {});
  A.eq(r1.source, 'mojeek', 'web_search uses Mojeek as the primary source');
  A.eq(r1.results.length, 2, 'web_search returns the Mojeek results');

  // ---- C. Mojeek down (403) -> falls through to DuckDuckGo html ----
  const wFallback = makeWebTools({ fetchImpl: stubFetch([
    ['mojeek.com', { status: 403, body: 'forbidden' }],
    ['html.duckduckgo.com', { status: 200, body: DDG_HTML_OK }]
  ]), lookup: null });
  const r2 = await wFallback.webSearch('anthropic', {});
  A.eq(r2.source, 'duckduckgo-html', 'web_search falls through to DDG html when Mojeek is down');

  // ---- D. Mojeek down + DDG html/lite both 202-blocked + no OpenRouter key -> fails loudly ----
  const wAllDown = makeWebTools({ fetchImpl: stubFetch([
    ['mojeek.com', { status: 500, body: 'err' }],
    ['html.duckduckgo.com', DDG_ANOMALY],
    ['lite.duckduckgo.com', DDG_ANOMALY]
  ]), lookup: null });
  let threw = false;
  let allDownMessage = '';
  try { await wAllDown.webSearch('anthropic', {}); } catch (e) {
    threw = !!e.__allFailed;
    allDownMessage = String(e && e.message || '');
  }
  A.ok(threw, 'web_search throws __allFailed when every keyless source is down and there is no OpenRouter key');
  A.ok(/do not immediately repeat/.test(allDownMessage), 'an exhausted provider chain tells the worker to change strategy');

  // ---- E. The keyed rescue path receives its FULL 20s allowance after all three keyless fallbacks ----
  const calls = [];
  const wOpenRouter = makeWebTools({
    openrouter: { apiKey: 'test-key', baseUrl: 'https://openrouter.ai/api/v1', model: 'test-model' },
    lookup: null,
    fetchImpl: async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.indexOf('mojeek.com') >= 0) return { status: 200, text: async () => '<html>no results</html>' };
      if (u.indexOf('duckduckgo.com') >= 0) return { status: 202, text: async () => DDG_ANOMALY.body };
      if (u.indexOf('openrouter.ai') >= 0) return {
        json: async () => ({ choices: [{ message: { content: '1. Rescue Result — https://example.com/rescue — usable evidence' } }] })
      };
      throw new Error('unexpected URL ' + u);
    }
  });
  const rescued = await wOpenRouter.webSearch('anthropic', {});
  A.eq(rescued.source, 'openrouter', 'OpenRouter rescues a fully blocked keyless chain');
  A.ok(calls[calls.length - 1].indexOf('openrouter.ai') >= 0, 'the keyed fallback runs last');
  A.ok(wOpenRouter.searchTool.timeoutMs >= 61000,
    'the registry wrapper covers 3x12s keyless + 20s OpenRouter + scheduling slack (was 37s)');

  // ---- E2. The rung goes where its key was saved (credential-store lane, S6) ----
  {
    const engines = u => (u.indexOf('mojeek.com') >= 0 ? { status: 200, text: async () => '<html>no results</html>' } : u.indexOf('duckduckgo.com') >= 0 ? { status: 202, text: async () => DDG_ANOMALY.body } : null);
    const dialed = [];
    const wProxy = makeWebTools({
      openrouter: { apiKey: 'proxy-key', baseUrl: 'http://proxy.test/api/v1/' }, lookup: null,
      fetchImpl: async (url, init) => {
        const u = String(url);
        const free = engines(u);
        if (free) return free;
        dialed.push({ url: u, auth: init.headers.Authorization, model: JSON.parse(init.body).model });
        return { json: async () => ({ choices: [{ message: { content: '1. Rescue Result — https://example.com/rescue — usable evidence' } }] }) };
      }
    });
    A.eq((await wProxy.webSearch('anthropic', {})).source, 'openrouter', 'the rung answers from the endpoint saved with its key');
    A.eq(dialed, [{ url: 'http://proxy.test/api/v1/chat/completions', auth: 'Bearer proxy-key', model: 'openai/gpt-4o-mini' }],
      'it dials that endpoint, never openrouter.ai, and a run on another provider sends OpenRouter\'s search model, never its own model id');

    const wDown = makeWebTools({
      openrouter: { apiKey: 'proxy-key', baseUrl: 'http://user:secret@proxy.test:8443/token-in-path/v1' }, lookup: null,
      fetchImpl: async url => { const free = engines(String(url)); if (free) return free; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }
    });
    let down = '';
    try { await wDown.webSearch('anthropic', {}); } catch (e) { down = String(e && e.message || ''); }
    A.ok(/openrouter: fetch failed \(ECONNREFUSED proxy\.test:8443\)/.test(down), 'a transport failure names the host it dialed: ' + down);
    A.ok(!/openrouter\.ai/.test(down) && !/secret|token-in-path/.test(down), '...never openrouter.ai, and never the URL\'s credentials: ' + down);

    let keyOnly = 0;
    const wNoEndpoint = makeWebTools({ openrouter: { apiKey: 'orphan-key' }, lookup: null, fetchImpl: async url => { const free = engines(String(url)); if (free) return free; keyOnly++; throw new Error('this key must not leave'); } });
    let orphan = '';
    try { await wNoEndpoint.webSearch('anthropic', {}); } catch (e) { orphan = String(e && e.__allFailed); }
    A.eq([keyOnly, orphan], [0, 'true'], 'a key with no endpoint arms nothing: there is nowhere it was saved to send it');

    /* E3. A run in flight whose rung's key went (credential-store lane, review r1). The run host builds web_search once per run,
       on the rung's key; it hands keyGone, its in-flight watch over that key: '' while a station layer still holds it, else the
       sentence. The rung asks before it dials, so a key removed or rotated away mid-run is never sent, and the search says why
       beside the free engines' own answers. Red at bfca6be28, where the rung sent the key the run started with until the run
       ended. */
    let why = '', dials = 0;
    const wFlight = makeWebTools({ openrouter: { apiKey: 'flight-key', baseUrl: 'http://proxy.test/api/v1' }, keyGone: () => why, lookup: null,
      fetchImpl: async url => { const free = engines(String(url)); if (free) return free; dials++; return { json: async () => ({ choices: [{ message: { content: '1. Rescue Result — https://example.com/rescue — usable evidence' } }] }) }; } });
    A.eq([(await wFlight.webSearch('anthropic', {})).source, dials], ['openrouter', 1], 'E3: while its key is held the rung answers');
    why = 'the OPENROUTER key this run started with was removed or replaced on this station, so web_search did not send it';
    let refused = '';
    try { await wFlight.webSearch('anthropic', {}); } catch (e) { refused = String(e && e.message || ''); }
    A.eq(dials, 1, 'E3: once it is gone the rung never dials');
    A.ok(refused.includes('openrouter: ' + why), 'E3: ...and the search says why, beside the free engines\' own answers: ' + refused.slice(0, 300));
    let heldDials = 0;
    const wThrows = makeWebTools({ openrouter: { apiKey: 'flight-key', baseUrl: 'http://proxy.test/api/v1' }, keyGone: () => { throw new Error('watch broke'); }, lookup: null,
      fetchImpl: async url => { const free = engines(String(url)); if (free) return free; heldDials++; return { json: async () => ({ choices: [{ message: { content: '1. R — https://example.com/r — x' } }] }) }; } });
    A.eq([(await wThrows.webSearch('anthropic', {})).source, heldDials], ['openrouter', 1], 'E3: a check that throws reads as held, as the loop\'s does');
  }

  // ---- F. A provider-local abort is surfaced as a timeout, not an opaque undici AbortError ----
  let timeoutMessage = '';
  try {
    await wOpenRouter._internals.withTimeout(signal => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
    }), 5);
  } catch (e) { timeoutMessage = String(e && e.message || ''); }
  A.ok(/request timed out after 5ms/.test(timeoutMessage), 'provider timeout explains the abort so the worker can change source');

  /* ---- a hostile search-engine body must not stall the single-process host ----
     `([\s\S]*?)</a>` scans to end-of-input from every start position when the closer is absent, so a body
     with many result-link OPENS and no closers was quadratic: measured 1MB -> 1403ms of frozen event loop
     (and web_search reaches DDG whenever Mojeek is throttled). ---- */
  {
    const { parseDDGHtml } = makeWebTools({ fetchImpl: async () => ({ status: 200, text: async () => '', headers: { get: () => '' } }), lookup: null })._internals;
    const unit = '<a class="result__a" href="http://x">';
    const evil = unit.repeat(Math.floor(1024 * 1024 / unit.length));
    const t0 = Date.now();
    parseDDGHtml(evil);
    const ms = Date.now() - t0;
    A.ok(ms < 500, 'a megabyte of unclosed result anchors parses in ' + ms + 'ms (was 1403ms)');
    const rows = parseDDGHtml('<a class="result__a" href="http://e.com/a">Title</a><div class="result__snippet">Snip</div>');
    A.eq(rows.length, 1, 'an ordinary DDG body still yields its result');
    A.eq(rows[0].title, 'Title', 'with its title');
    A.eq(rows[0].snippet, 'Snip', 'and its snippet');
  }

  A.report('web.search.test');
})();
