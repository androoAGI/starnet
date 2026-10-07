/* node test/web.calm.test.js — web weather is an ANSWER, not an error.
   Field data (2026-07-31): the dominant mid-run "errors" users saw were this tool throwing on
   ordinary web reality — http 403 (bot walls), http 404 (dead links), throttled keyless engines —
   each becoming a red ✗ ERROR chip in COMMS during runs that finished fine. The tools now answer
   those as ok results that state the fact and steer the model to a different source; genuine
   faults (timeouts, SSRF refusals, unreachable network) still throw and stay isError.
   Offline + deterministic (fetch injected, DNS disabled). Pairs with sidecar/tools/builtin/web.js. */
'use strict';
const A = require('./_assert.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');

// fetch stub from a routing table keyed by URL substring -> {status, body} (headers included:
// directFetch reads content-type/location on every response, unlike the search-only stubs).
function stubFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [needle, resp] of routes) {
      if (u.indexOf(needle) >= 0) {
        if (resp.reject) throw resp.reject;
        return { status: resp.status, text: async () => resp.body || '', headers: { get: (h) => (resp.headers && resp.headers[h]) || '' } };
      }
    }
    return { status: 404, text: async () => '', headers: { get: () => '' } };
  };
}
const tools = (routes) => makeWebTools({ fetchImpl: stubFetch(routes), lookup: null });

(async () => {
  // ---- A. a dead link (404) is an ok ANSWER: no throw, calm summary, do-not-refetch guidance ----
  {
    const { fetchTool } = tools([['dead.example', { status: 404 }]]);
    const r = await fetchTool.run({ url: 'https://dead.example/gone' }, {});
    A.eq(r.summary, 'dead link (404)', 'a 404 answers with a calm dead-link summary');
    A.ok(/No page exists/.test(r.content) && /Do not refetch/.test(r.content),
      'the 404 answer states the fact and steers away from a blind retry');
    A.ok(!/ERROR|failed/i.test(r.summary), 'the summary never carries alarm words');
  }

  // ---- B. a bot wall (403) is an ok ANSWER naming the site's refusal, not a tool failure ----
  {
    const { fetchTool } = tools([['walled.example', { status: 403 }]]);
    const r = await fetchTool.run({ url: 'https://walled.example/article' }, {});
    A.eq(r.summary, 'site declined (403)', 'a 403 answers as the site declining');
    A.ok(/bot protection|login wall/.test(r.content), 'the 403 answer explains WHY (bot wall), so the model changes source');
  }

  // ---- C. their outage (503) and their throttle (429) are answers about THEIR side ----
  {
    const { fetchTool } = tools([['down.example', { status: 503 }]]);
    const r = await fetchTool.run({ url: 'https://down.example/a' }, {});
    A.eq(r.summary, 'site outage (503)', 'a 5xx answers as the site\'s own outage');
    A.ok(/their side/.test(r.content), 'the 5xx answer assigns the outage to the site, not the harness');
    const { fetchTool: f2 } = tools([['busy.example', { status: 429 }]]);
    const r2 = await f2.run({ url: 'https://busy.example/a' }, {});
    A.eq(r2.summary, 'rate-limited (429)', 'a 429 answers as rate-limiting');
  }

  // ---- D. a domain that does not resolve is an answer (dead site), not a network fault ----
  {
    const nx = new Error('fetch failed'); nx.cause = { code: 'ENOTFOUND' };
    const { fetchTool } = tools([['nope.example', { reject: nx }]]);
    const r = await fetchTool.run({ url: 'https://nope.example/x' }, {});
    A.eq(r.summary, 'domain not found', 'ENOTFOUND answers as a dead/mistyped domain');

    let networkCalls = 0;
    const dnsNx = new Error('getaddrinfo ENOTFOUND nope.example'); dnsNx.code = 'ENOTFOUND';
    const early = makeWebTools({
      fetchImpl: async () => { networkCalls++; throw new Error('fetch should not run after proven NXDOMAIN'); },
      lookup: async () => { throw dnsNx; }
    });
    const r2 = await early.fetchTool.run({ url: 'https://nope.example/docs' }, {});
    A.eq(r2.summary, 'domain not found', 'resolver ENOTFOUND is preserved as terminal domain evidence');
    A.eq(networkCalls, 0, 'proven resolver ENOTFOUND avoids a doomed network timeout');

    let reservedLookups = 0, reservedFetches = 0;
    const reserved = makeWebTools({
      fetchImpl: async () => { reservedFetches++; throw new Error('reserved host must never reach fetch'); },
      lookup: async () => { reservedLookups++; return []; }
    });
    const started = Date.now();
    const r3 = await reserved.fetchTool.run({ url: 'https://starnessos.invalid/docs' }, {});
    A.eq(r3.summary, 'domain not found', 'reserved .invalid is immediate terminal domain evidence');
    A.eq(reservedLookups, 0, 'reserved .invalid never burns an OS resolver timeout');
    A.eq(reservedFetches, 0, 'reserved .invalid never reaches the network');
    A.ok(Date.now() - started < 1000, 'reserved .invalid returns useful feedback in under one second');
  }

  // ---- E. a JS-only page (200, empty extract) answers "no readable text" instead of erroring ----
  {
    const { fetchTool } = tools([['spa.example', { status: 200, body: '<html><body></body></html>' }]]);
    const r = await fetchTool.run({ url: 'https://spa.example/app' }, {});
    A.eq(r.summary, 'no readable text', 'an empty extraction answers as a JS-only page');
  }

  // ---- F. an exhausted search chain is an ok ANSWER carrying the engine detail ----
  {
    const { searchTool } = tools([
      ['mojeek.com', { status: 403, body: 'forbidden' }],
      ['duckduckgo.com', { status: 202, body: 'anomaly' }]
    ]);
    const r = await searchTool.run({ query: 'anything' }, {});
    A.eq(r.summary, 'engines throttled — no results', 'an all-down chain answers as throttled engines');
    A.ok(/mojeek/.test(r.content) && /Do not immediately repeat/.test(r.content),
      'the throttle answer keeps the per-engine detail and the change-strategy guidance');
    A.ok(/not a malfunction/.test(r.content), 'the answer says out loud that nothing is broken');
  }

  // ---- F2. NO engine could be reached (offline / TLS broken here) is a FAULT, never "throttling" ----
  // (2026-10-07) a machine whose outbound TLS failed was told "temporary throttling ... not a malfunction".
  const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  {
    const { searchTool } = tools([['mojeek.com', { reject: reset() }], ['duckduckgo.com', { reject: reset() }]]);
    let err = null;
    try { await searchTool.run({ query: 'anything' }, {}); } catch (e) { err = e; }
    A.ok(err, 'an all-transport-failed chain THROWS (isError, loop-guard protection) instead of answering ok');
    A.ok(err && /ECONNRESET/.test(err.message), 'the error names the transport cause code');
    A.ok(err && /www\.mojeek\.com/.test(err.message), 'and the host that was dialled (the cause named none)');
    A.ok(err && /could not reach any search engine/.test(err.message), 'it says no engine was reachable');
    A.ok(err && !/not a malfunction|temporary throttling|temporarily unavailable/.test(err.message),
      'it never claims throttling / "not a malfunction"');
    A.ok(err && err.__allFailed === true && err.__unreachable === true, 'the raw flags: __allFailed AND __unreachable');
  }
  // ---- F3. mixed: one engine ANSWERED (202 anomaly) -> still the throttle answer, now with the cause named ----
  {
    const { searchTool } = tools([['mojeek.com', { reject: reset() }], ['duckduckgo.com', { status: 202, body: 'anomaly' }]]);
    const r = await searchTool.run({ query: 'anything' }, {});
    A.eq(r.summary, 'engines throttled — no results', 'an engine that answered keeps the calm throttle answer');
    A.ok(/mojeek: fetch failed \(ECONNRESET www\.mojeek\.com\)/.test(r.content), 'the per-engine detail names code + host');
  }
  // ---- F4. the reader rung's empty result is NEUTRAL: offline + Chrome installed still throws ----
  {
    const rd = { available: () => ({ ok: true }), search: async () => ({ engine: '', results: [] }) };
    const { searchTool } = makeWebTools({ fetchImpl: stubFetch([['mojeek.com', { reject: reset() }], ['duckduckgo.com', { reject: reset() }]]), lookup: null, reader: rd });
    let err = null;
    try { await searchTool.run({ query: 'anything' }, {}); } catch (e) { err = e; }
    A.ok(err && err.__unreachable === true, 'reader "0 results" is not proof the web answered — still unreachable');
  }
  // ---- F5. a cancelled run is a cancel, never "no results": no engine is dialled after the abort ----
  {
    let fetches = 0;
    const { searchTool } = makeWebTools({ fetchImpl: async () => { fetches++; throw reset(); }, lookup: null });
    const ac = new AbortController(); ac.abort();
    let err = null, r = null;
    try { r = await searchTool.run({ query: 'anything' }, { signal: ac.signal }); } catch (e) { err = e; }
    A.ok(err && !r, 'an already-aborted search throws instead of answering');
    A.eq(fetches, 0, 'zero fetches after the abort');
  }

  // ---- G. the RAW fns keep the strict throwing contract (internal callers + older tests) ----
  {
    const w = tools([['dead.example', { status: 404 }]]);
    let threw = '';
    try { await w.webFetch('https://dead.example/gone', {}); } catch (e) { threw = e.message; }
    A.eq(threw, 'http 404', 'raw webFetch still throws http statuses');
    const w2 = tools([['mojeek.com', { status: 500, body: '' }], ['duckduckgo.com', { status: 202, body: 'anomaly' }]]);
    let all = false;
    try { await w2.webSearch('q', {}); } catch (e) { all = !!e.__allFailed; }
    A.ok(all, 'raw webSearch still throws __allFailed');
  }

  // ---- H. genuine faults still THROW from the tool (stay isError; keep loop-guard protection) ----
  {
    const abort = new Error('This operation was aborted');
    const { fetchTool } = tools([['slow.example', { reject: abort }]]);
    let threw = '';
    try { await fetchTool.run({ url: 'https://slow.example/x' }, {}); } catch (e) { threw = e.message; }
    A.ok(/aborted/.test(threw), 'an abort is a genuine fault and still throws');
    const { fetchTool: f2 } = tools([]);
    let ssrf = '';
    try { await f2.run({ url: 'http://localhost/admin' }, {}); } catch (e) { ssrf = e.message; }
    A.ok(/private|loopback|intranet/.test(ssrf), 'the SSRF refusal still throws — a security refusal is never softened');
  }

  // ---- I. the happy path is byte-identical: fenced page text, chars-via-source summary ----
  {
    const { fetchTool } = tools([['ok.example', { status: 200, body: '<html><body><p>Real content here.</p></body></html>' }]]);
    const r = await fetchTool.run({ url: 'https://ok.example/page' }, {});
    A.ok(/Real content here/.test(r.content), 'a readable page still returns its text');
    A.ok(/chars via direct$/.test(r.summary), 'the success summary shape is unchanged');
  }

  A.report('web.calm.test');
})();
