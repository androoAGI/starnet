/* node test/web.reach.test.js — the WEB REACH layer: the station READER (webreader.js) and its
   automatic rungs inside web_fetch / web_search.

   Field context (2026-07-31): plain HTTP is bot-walled (403s) and the keyless engines throttle; a
   REAL local Chrome sails past both. The reader is a shared, headless, cookie-less browser the web
   tools borrow: web_fetch retries walled/JS-only pages through it; web_search uses it as the last
   keyless rung before the paid fallback. Also locks the Mojeek `+`-encoding fix: a %20-encoded
   multi-word query gets Mojeek's empty interstitial, the SAME query +-encoded gets real results —
   that one character was the field's endless "mojeek: 0 results".
   Offline + deterministic: driver and fetch are injected. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { makeWebReader } = require('../sidecar/tools/builtin/webreader.js');

// ---- a scriptable fake CDP driver for makeWebReader ----
function fakeDriver(script) {
  const calls = { navigations: [], closed: 0 };
  return {
    calls,
    driver: {
      navigate: async (url) => { calls.navigations.push(url); const page = script(url); if (page.navThrow) throw new Error(page.navThrow); },
      lastResponse: () => { const page = script(calls.navigations[calls.navigations.length - 1]); return { status: page.status == null ? 200 : page.status }; },
      evalPublic: async (expr) => {
        const page = script(calls.navigations[calls.navigations.length - 1]);
        if (/document\.title/.test(expr)) return { value: page.title || '' };
        return { value: page.results || [] };   // an engine-extract expression
      },
      getText: async () => { const page = script(calls.navigations[calls.navigations.length - 1]); return page.text || ''; },
      close: async () => { calls.closed++; }
    }
  };
}
const reader = (script) => {
  const fd = fakeDriver(script);
  const r = makeWebReader({ makeDriver: () => fd.driver, idleMs: 3600000 });
  return { r, calls: fd.calls };
};

// fetch stub (headers included: directFetch reads content-type/location on every response)
function stubFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [needle, resp] of routes) {
      if (u.indexOf(needle) >= 0) {
        if (resp.reject) throw resp.reject;
        return { status: resp.status, text: async () => resp.body || '', json: async () => (resp.json !== undefined ? resp.json : JSON.parse(resp.body || 'null')), headers: { get: (h) => (resp.headers && resp.headers[h]) || '' } };
      }
    }
    return { status: 404, text: async () => '', headers: { get: () => '' } };
  };
}

(async () => {
  // ================= makeWebReader =================

  // ---- A. a readable page comes back as text with its status ----
  {
    const { r } = reader(() => ({ status: 200, title: 'Fine Article', text: 'The actual page text.' }));
    const out = await r.fetchText('https://ok.example/a');
    A.ok(out.ok, 'the reader reads a normal page');
    A.eq(out.status, 200, 'and reports the real HTTP status');
    A.ok(/actual page text/.test(out.text), 'returning the rendered text');
  }

  // ---- B. a challenge interstitial is a WALL, not content (the Hermes title heuristic) ----
  {
    const { r } = reader(() => ({ status: 200, title: 'Just a moment...', text: 'Checking your browser before accessing' }));
    const out = await r.fetchText('https://walled.example/a');
    A.ok(!out.ok && out.reason === 'challenge', 'a challenge title is refused as a wall — "Just a moment…" is never page content');
  }

  // ---- C. a still-4xx page through the browser reports its status ----
  {
    const { r } = reader(() => ({ status: 403, title: 'Forbidden', text: 'denied' }));
    const out = await r.fetchText('https://hard.example/a');
    A.ok(!out.ok && out.reason === 'http 403', 'a 403 even in the real browser is reported as such');
  }

  // ---- D. search: bing is primary (live-probed: DDG's html endpoint CAPTCHAs even a real Chrome);
  //         a dry primary falls through to the duckduckgo JS app ----
  {
    const { r, calls } = reader((url) => /bing/.test(url)
      ? { status: 200, results: [{ title: 'Hit', url: 'https://x.example/a', snippet: 's' }] }
      : { status: 200, results: [] });
    const out = await r.search('some query');
    A.eq(out.engine, 'bing', 'bing answers first');
    A.eq(out.results.length, 1, 'with its rows');
    A.eq(calls.navigations.length, 1, 'and no second engine was burned');
    A.ok(/\+/.test(calls.navigations[0]) && !/%20/.test(calls.navigations[0]), 'the engine query uses +-encoding');
    const { r: r2, calls: c2 } = reader((url) => /duckduckgo/.test(url)
      ? { status: 200, results: [{ title: 'B', url: 'https://y.example/b', snippet: '' }] }
      : { status: 200, results: [] });
    const out2 = await r2.search('another query');
    A.eq(out2.engine, 'duckduckgo', 'a dry bing falls through to the duckduckgo app');
    A.eq(c2.navigations.length, 2, 'exactly one navigation per engine tried');
  }

  // ---- D2. a block page wearing a normal title is caught by its TEXT (the live Reddit case) ----
  {
    const { r } = reader(() => ({ status: 200, title: 'reddit.com', text: "You've been blocked by network security. To continue, log in to your Reddit account." }));
    const out = await r.fetchText('https://blocked.example/a');
    A.ok(!out.ok && out.reason === 'challenge', 'a terse blocked-by-security page is a wall, never content');
  }
  {
    const { r } = reader(() => ({ status: 200, title: 'Long analysis', text: ('A real article about how sites say you have been blocked by network security. ' + 'x'.repeat(1400)) }));
    const out = await r.fetchText('https://article.example/a');
    A.ok(out.ok, 'a LONG page mentioning block phrases is real content — the text heuristic only fires on terse pages');
  }

  // ---- E. kill switch: SKYNET_WEB_READER=0 reports unavailable and never boots a driver ----
  {
    const fd = fakeDriver(() => ({ status: 200, text: 'x' }));
    const r = makeWebReader({ makeDriver: () => fd.driver, env: { SKYNET_WEB_READER: '0' } });
    A.eq(r.available().ok, false, 'the kill switch disables the reader');
    const out = await r.fetchText('https://ok.example/a');
    A.ok(!out.ok && fd.calls.navigations.length === 0, 'a disabled reader never navigates');
  }

  // ================= web.js integration =================

  // ---- F. a bot-walled fetch (403) automatically retries through the reader and succeeds ----
  {
    const { r } = reader(() => ({ status: 200, title: 'Article', text: 'Browser-rendered body text.' }));
    const { fetchTool } = makeWebTools({ fetchImpl: stubFetch([['walled.example', { status: 403 }]]), lookup: null, reader: r });
    const res = await fetchTool.run({ url: 'https://walled.example/story' }, {});
    A.ok(/Browser-rendered body text/.test(res.content), 'the walled page was read through the station browser');
    A.ok(/read via the station browser after http 403/.test(res.content), 'the provenance label says the browser read it (truthful telemetry)');
    A.ok(/chars via browser$/.test(res.summary), 'the summary names the browser source');
  }

  // ---- G. a JS-only page (empty extract) takes the reader rung too ----
  {
    const { r } = reader(() => ({ status: 200, title: 'App', text: 'Rendered by JavaScript.' }));
    const { fetchTool } = makeWebTools({ fetchImpl: stubFetch([['spa.example', { status: 200, body: '<html><body></body></html>' }]]), lookup: null, reader: r });
    const res = await fetchTool.run({ url: 'https://spa.example/app' }, {});
    A.ok(/Rendered by JavaScript/.test(res.content), 'an empty plain-HTTP extract is retried in the real browser');
  }

  // ---- H. a dead link (404) NEVER boots the browser — Chrome cannot resurrect a missing page ----
  {
    const fd = fakeDriver(() => ({ status: 200, text: 'never' }));
    const r = makeWebReader({ makeDriver: () => fd.driver, idleMs: 3600000 });
    const { fetchTool } = makeWebTools({ fetchImpl: stubFetch([['dead.example', { status: 404 }]]), lookup: null, reader: r });
    const res = await fetchTool.run({ url: 'https://dead.example/gone' }, {});
    A.eq(res.summary, 'dead link (404)', 'the 404 still answers as a dead link');
    A.eq(fd.calls.navigations.length, 0, 'and the reader was never consulted');
  }

  // ---- I. the reader also refused -> the calm answer says the browser tried (escalation is visible) ----
  {
    const { r } = reader(() => ({ status: 200, title: 'Just a moment...', text: 'checking' }));
    const { fetchTool } = makeWebTools({ fetchImpl: stubFetch([['walled.example', { status: 403 }]]), lookup: null, reader: r });
    const res = await fetchTool.run({ url: 'https://walled.example/story' }, {});
    A.eq(res.summary, 'site declined (403)', 'still a calm site-declined answer');
    A.ok(/browser also tried/.test(res.content) && /verification wall/.test(res.content),
      'the answer records that the station browser escalated and met a verification wall');
  }

  // ---- J. search: throttled scrape chain falls through to the reader BEFORE the paid fallback ----
  {
    const { r } = reader((url) => /duckduckgo/.test(url)
      ? { status: 200, results: [{ title: 'Browser Hit', url: 'https://z.example/hit', snippet: 'via chrome' }] }
      : { status: 200, results: [] });
    const w = makeWebTools({
      fetchImpl: stubFetch([
        ['mojeek.com', { status: 403, body: 'forbidden' }],
        ['duckduckgo.com', { status: 202, body: 'anomaly' }]
      ]),
      lookup: null, reader: r,
      openrouter: { apiKey: 'k', model: 'm' }   // present, and must NOT be reached
    });
    const res = await w.webSearch('some query', {});
    A.eq(res.source, 'browser', 'the reader rung rescues a throttled chain');
    A.eq(res.results[0].title, 'Browser Hit', 'with the browser-extracted results');
  }

  // ---- K. no reader wired -> behavior identical to before (regression lock) ----
  {
    const { fetchTool, searchTool } = makeWebTools({ fetchImpl: stubFetch([['walled.example', { status: 403 }], ['mojeek.com', { status: 500, body: '' }], ['duckduckgo.com', { status: 202, body: 'anomaly' }]]), lookup: null });
    const res = await fetchTool.run({ url: 'https://walled.example/story' }, {});
    A.eq(res.summary, 'site declined (403)', 'without a reader the 403 soft answer is unchanged');
    const s = await searchTool.run({ query: 'q' }, {});
    A.eq(s.summary, 'engines throttled — no results', 'without a reader the throttle answer is unchanged');
  }

  // ---- L. the Mojeek query is +-encoded, never %20 (the one-character outage) ----
  {
    const seen = [];
    const w = makeWebTools({
      fetchImpl: async (url) => { seen.push(String(url)); return { status: 200, text: async () => '', headers: { get: () => '' } }; },
      lookup: null
    });
    try { await w.webSearch('multi word query', {}); } catch (_) {}
    const mo = seen.find(u => u.indexOf('mojeek') >= 0);
    A.ok(mo && mo.indexOf('multi+word+query') >= 0, 'mojeek gets + for spaces');
    A.ok(mo.indexOf('%20') < 0, 'and never %20 — that encoding gets the empty interstitial');
  }

  /* ---- M-P. A STATION BROWSER THAT CANNOT START (live walk 10-14): a worker's web_search sat on "Searching …" for
     80 s and then 185 s while Chromium failed to launch (browser.launch-retry ×5) — each engine relaunched the dead
     browser (3 tries × ~20 s), and nobody was told. Now a launch failure ends the reader's engine loop and holds the
     reader down for a cooldown, the search rung is time-boxed when a later rung can still answer, and the result
     SAYS the station browser could not start. ---- */
  const deadDriver = () => ({ navigate: async () => { throw new Error('browser unavailable: could not attach to Chromium'); },
    lastResponse: () => null, evalPublic: async () => ({ value: [] }), getText: async () => '', close: async () => {} });
  const THROTTLED = [['mojeek.com', { status: 403, body: 'forbidden' }], ['duckduckgo.com', { status: 202, body: 'anomaly' }]];
  const OR_HIT = ['openrouter.ai', { status: 200, json: { choices: [{ message: { content: '', annotations: [{ type: 'url_citation', url_citation: { title: 'OR Hit', url: 'https://or.example/x', content: 'via openrouter' } }] } }] } }];
  {
    let made = 0, now = 1.8e12;
    const r = makeWebReader({ makeDriver: () => { made++; return deadDriver(); }, idleMs: 3600000, now: () => now });
    const out = await r.search('q');
    A.ok(out.results.length === 0 && out.launchFailed === true && /could not start/.test(out.reason), 'M: a launch failure is reported as the browser not starting: ' + JSON.stringify(out));
    A.eq(made, 1, 'M: the next engine does not relaunch a browser that cannot start');
    const av = r.available();
    A.ok(!av.ok && av.launchFailed === true && /could not start/.test(av.reason), 'M: the reader reports itself down while it cools off');
    const f = await r.fetchText('https://ok.example/');
    A.ok(!f.ok && made === 1, 'M: a fetch during the cooldown does not relaunch it either');
    now += 11 * 60000;
    A.ok(r.available().ok, 'M: after the cooldown it may try again');
  }
  {
    const r = makeWebReader({ makeDriver: () => deadDriver(), idleMs: 3600000 });
    await r.search('warm');   // the browser failed to start a moment ago
    const w = makeWebTools({ fetchImpl: stubFetch(THROTTLED.concat([OR_HIT])), lookup: null, reader: r, openrouter: { apiKey: 'k', model: 'm' } });
    const res = await w.searchTool.run({ query: 'q' }, {});
    A.ok(/via openrouter/.test(res.summary), 'N: the search still answers through the next rung: ' + res.summary);
    A.ok(/station browser could not start/.test(res.summary) && /station browser could not start/.test(res.content), 'N: and says the station browser could not start: ' + res.summary);
  }
  {
    // a browser stuck starting: the rung gives up within its budget when OpenRouter can still answer
    let made = 0;
    const r = makeWebReader({ makeDriver: () => { made++; return { navigate: () => new Promise(() => {}), close: async () => {}, evalPublic: async () => ({ value: [] }), getText: async () => '' }; }, idleMs: 3600000 });
    const w = makeWebTools({ fetchImpl: stubFetch(THROTTLED.concat([OR_HIT])), lookup: null, reader: r, openrouter: { apiKey: 'k', model: 'm' }, readerBudgetMs: 60 });
    const t0 = Date.now();
    const res = await w.searchTool.run({ query: 'q' }, {});
    A.ok(Date.now() - t0 < 3000 && /via openrouter/.test(res.summary), 'O: a browser that does not answer in time is passed over: ' + res.summary);
    A.ok(/station browser was not ready within/.test(res.summary), 'O: and the answer says so: ' + res.summary);
    const t1 = Date.now();
    const again = await w.searchTool.run({ query: 'q2' }, {});
    A.ok(Date.now() - t1 < 6000 && made === 1 && /station browser is still starting/.test(again.summary), 'O: the next search does not queue behind the stuck browser (the engines keep their polite spacing): ' + again.summary + ' ms=' + (Date.now() - t1) + ' made=' + made);
  }
  {
    // with no later rung the reader keeps its full time: a slow-but-healthy browser still answers
    const { r } = reader((url) => /bing/.test(url) ? { status: 200, results: [{ title: 'Slow Hit', url: 'https://s.example/', snippet: '' }] } : { status: 200, results: [] });
    const slow = { search: (q, o) => new Promise(res => setTimeout(() => res(r.search(q, o)), 120)), available: () => r.available() };
    const w = makeWebTools({ fetchImpl: stubFetch(THROTTLED), lookup: null, reader: slow, readerBudgetMs: 30 });
    const res = await w.webSearch('q', {});
    A.eq(res.source, 'browser', 'P: no OpenRouter key → the browser rung is not time-boxed (it is the last resort)');
  }
  {
    /* Q (review 10-14): the budget bounds the browser's START, never a healthy browser's work. A browser that is up
       but slow to read an engine page must not be passed over to the PAID OpenRouter search. */
    let orCalls = 0;
    const slowDriver = { navigate: async () => {}, lastResponse: () => ({ status: 200 }), getText: async () => '', close: async () => {},
      evalPublic: (expr) => /document\.title/.test(expr) ? Promise.resolve({ value: '' })
        : new Promise(res => setTimeout(() => res({ value: [{ title: 'Slow Hit', url: 'https://s.example/', snippet: '' }] }), 150)) };
    const r = makeWebReader({ makeDriver: () => slowDriver, idleMs: 3600000 });
    const fetchOr = stubFetch(THROTTLED.concat([OR_HIT]));
    const counting = async (u, o) => { if (String(u).indexOf('openrouter.ai') >= 0) orCalls++; return fetchOr(u, o); };
    const w = makeWebTools({ fetchImpl: counting, lookup: null, reader: r, openrouter: { apiKey: 'k', model: 'm' }, readerBudgetMs: 40 });
    const res = await w.webSearch('q', {});
    A.ok(res.source === 'browser' && orCalls === 0 && !res.browserNote, 'Q: a started browser that reads slowly keeps the search (no paid fallback): ' + res.source + ' or=' + orCalls);
    const again = await w.webSearch('q2', {});
    A.ok(again.source === 'browser' && orCalls === 0, 'Q: a warm browser is never time-boxed either');
  }
  {
    /* R (review 10-14): with no OpenRouter key and every rung dry, a browser that could not start is NAMED — never
       "engines throttled", never "not a malfunction". */
    const r = makeWebReader({ makeDriver: () => deadDriver(), idleMs: 3600000 });
    const w = makeWebTools({ fetchImpl: stubFetch(THROTTLED), lookup: null, reader: r });
    const res = await w.searchTool.run({ query: 'q' }, {});
    A.ok(/station browser could not start/.test(res.summary) && !/throttled/.test(res.summary), 'R: the summary names the dead browser: ' + res.summary);
    A.ok(/station browser could not start/.test(res.content) && !/not a malfunction/.test(res.content), 'R: the content says so too, and does not call it a non-fault: ' + res.content);
    const again = await w.searchTool.run({ query: 'q2' }, {});
    A.ok(/station browser could not start/.test(again.summary), 'R: a later search during the cooldown says so at once: ' + again.summary);
  }
  {
    /* S: the reader never reads ambient time (lint-determinism): the station's ONE reader gets the real clock from the
       composition root, so its launch cooldown really ends in production; with no clock injected it never measures as over. */
    const host = readSidecarSource();
    A.ok(/const stationWebReader = makeWebReader\(\{ env: process\.env, now: \(\) => Date\.now\(\) \}\);/.test(host), 'S: the host injects the real clock into the station web reader');
    const r = makeWebReader({ makeDriver: () => ({ navigate: async () => { throw new Error('browser unavailable: could not attach to Chromium'); },
      lastResponse: () => null, evalPublic: async () => ({ value: [] }), getText: async () => '', close: async () => {} }), idleMs: 3600000 });
    await r.search('q');
    A.ok(!r.available().ok && r.available().launchFailed === true, 'S: with no clock injected, a dead browser stays down (the cooldown never reads as over)');
  }

  A.report('web.reach.test');
})();
