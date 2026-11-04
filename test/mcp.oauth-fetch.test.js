/* node test/mcp.oauth-fetch.test.js — connector-OAuth fetches connect ONLY to the addresses that passed the check, and
   to every one of them.

   Security audit 2026-09-25: the OAuth wrapper validated a hostname's DNS answer and then let fetch resolve it AGAIN,
   so a rebinding authorization server could pass the check publicly and connect privately. Safe-egress lane
   (2026-11-03): the pin held only the FIRST validated address, so a dead first address (a broken IPv6) failed sign-in
   that web_fetch completed, and the wrapper could not even be built without web.js's guard injected by index.js. It now
   owns its guard (the boundary's connectorOauth row). This test builds it the way index.js does,
   makeConnectorOauthFetch({ onCloseError }), with fakes only at the transport edge: dns.promises.lookup (replaced the
   way the http preload rigs replace it), globalThis.fetch and the dispatcher factory. The real-socket proof (a dead
   first address on real undici and real sockets) is test/safe-egress.real-socket.test.js R8. */
'use strict';
const A = require('./_assert.js');
const dns = require('node:dns');
const { makeConnectorOauthFetch } = require('../sidecar/mcp/oauth-fetch.js');

const V4 = { address: '93.184.216.34', family: 4 };
const V6 = { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 };

(async () => {
  const realLookup = dns.promises.lookup, realFetch = globalThis.fetch;
  const asked = [], fetched = [], agents = [], closeErrors = [];
  let answer = () => [V4];
  dns.promises.lookup = async (name, opts) => { asked.push([name, opts]); return answer(name, asked.length); };
  globalThis.fetch = async (url, init) => { fetched.push({ url: String(url), init: init || {} }); return { status: 200, ok: true }; };
  const agentFactory = o => { const a = { o, closed: 0, close: async () => { a.closed++; } }; agents.push(a); return a; };
  const reset = () => { asked.length = 0; fetched.length = 0; agents.length = 0; };
  const tick = () => new Promise(res => setImmediate(res));
  try {
    A.notThrows(() => makeConnectorOauthFetch({ onCloseError: e => closeErrors.push(e) }), 'built the way index.js builds it: it owns its guard, nothing to inject');
    A.throws(() => makeConnectorOauthFetch({ lookup: 'dns' }), 'a lookup that is not a function, null or absent is a programming error');
    const f = makeConnectorOauthFetch({ onCloseError: e => closeErrors.push(e), agentFactory });

    // a rebinding resolver: [IPv6, IPv4] for the leg's one question, loopback for any later one
    answer = (name, n) => (n === 1 ? [V6, V4] : [{ address: '127.0.0.1', family: 4 }]);
    const r = await f.connectorOauthFetch('https://as.rebind.example/register', { method: 'POST', redirect: 'follow' });
    A.eq(r.status, 200, 'the leg completes');
    A.eq(asked, [['as.rebind.example', { all: true }]], 'DNS was asked exactly once, for the leg\'s own name');
    A.ok(fetched.length === 1 && fetched[0].url === 'https://as.rebind.example/register' && fetched[0].init.dispatcher === agents[0] &&
      fetched[0].init.redirect === 'manual' && fetched[0].init.method === 'POST', 'fetch got the URL, the pinned dispatcher and manual redirects (whatever the caller asked)');
    let single = null, all = null;
    agents[0].o.connect.lookup('as.rebind.example', {}, (err, addr, fam) => { single = [addr, fam]; });
    agents[0].o.connect.lookup('as.rebind.example', { all: true }, (err, list) => { all = list; });
    A.eq(single, [V6.address, 6], 'connect-time lookup, single shape: the first VALIDATED address, never a fresh (rebound) answer');
    A.eq(all, [V6, V4], 'all:true (Node\'s autoSelectFamily connect): EVERY validated address, in order, so a dead first address falls back to the next');
    A.ok(agents[0].o.connect.autoSelectFamily === true, 'two addresses: Node walks the list');
    await tick();
    A.eq(agents[0].closed, 1, 'the per-leg dispatcher is closed (no pinned connection outlives its leg)');
    A.eq(asked.length, 1, 'and the rebound answer was never asked for');
    const second = await f.connectorOauthFetch('https://as.rebind.example/token').then(() => null, e => e);
    A.ok(second && /resolves to private address 127\.0\.0\.1/.test(second.message) && fetched.length === 1, 'the next leg asks again, and its loopback answer is refused before any fetch');

    // refused before any connect: nothing fetched, no dispatcher; a remote server named the host, so never host-authored
    // dnsQuestions: 1 for a name whose ANSWER is refused, 0 for a refusal of the URL itself (it never reaches DNS)
    const refuse = async (url, answers, re, msg, dnsQuestions) => {
      reset(); answer = () => answers;
      const e = await f.connectorOauthFetch(url).then(() => null, x => x);
      A.ok(e && re.test(e.message) && e.hostAuthored !== true && fetched.length === 0 && agents.length === 0 && asked.length === dnsQuestions,
        msg + ' (' + (e ? e.message : 'NOT refused') + '; ' + asked.length + ' DNS question(s))');
      return e;
    };
    await refuse('https://evil.example/token', [{ address: '10.0.0.5', family: 4 }], /^refusing: evil\.example resolves to private address 10\.0\.0\.5/, 'a host resolving to 10.x is refused', 1);
    await refuse('https://evil.example/token', [{ address: '169.254.169.254', family: 4 }], /resolves to private address 169\.254\.169\.254/, 'a host resolving to cloud metadata is refused', 1);
    await refuse('https://evil.example/token', [V4, { address: '127.0.0.1', family: 4 }], /resolves to private address 127\.0\.0\.1/, 'a mixed public+loopback answer is refused', 1);
    await refuse('https://evil.example/token', [{ address: '64:ff9b::a00:5', family: 6 }], /resolves to private address 64:ff9b::a00:5/, 'a NAT64 answer carrying 10.0.0.5 is refused', 1);
    const filtered = await refuse('https://auth.example/token', [{ address: '0.0.0.0', family: 4 }], /resolves to private address 0\.0\.0\.0\. This computer's DNS answered 0\.0\.0\.0 for auth\.example/,
      'a DNS filter\'s 0.0.0.0 is refused, and the message says what answered it', 1);
    A.ok(filtered && /Pi-hole/.test(filtered.message) && /Fix or allow auth\.example in that DNS filter\.$/.test(filtered.message), 'with the DNS-filter exit: where to allow the name');
    await refuse('http://public.example/token', [V4], /^connector OAuth endpoints must use https$/, 'plain http is refused', 0);
    await refuse('https://user:pw@public.example/token', [V4], /^connector OAuth endpoints cannot contain embedded credentials$/, 'embedded credentials are refused', 0);
    await refuse('https://127.0.0.1/token', [V4], /^refusing to fetch private\/loopback\/intranet host: 127\.0\.0\.1$/, 'a loopback literal is refused', 0);
    await refuse('https://[::ffff:127.0.0.1]/token', [V4], /intranet host: ::ffff:7f00:1$/, 'loopback spelled as IPv4-mapped IPv6 is refused', 0);
    await refuse('https://metadata.goog/computeMetadata/v1/', [V4], /intranet host: metadata\.goog$/, 'the cloud metadata name is refused', 0);
    await refuse('https://svc.internal./token', [V4], /intranet host: svc\.internal$/, 'an intranet name with a root dot is refused', 0);

    // a public IPv6 endpoint (refused by the old literal copy) and a NAT64 endpoint of a public server are allowed
    for (const url of ['https://[2606:4700:4700::1111]/token', 'https://[64:ff9b::5db8:d822]/token']) {
      reset();
      const ok = await f.connectorOauthFetch(url).then(x => x.status, e => e.message);
      A.ok(ok === 200 && asked.length === 0 && agents.length === 0 && fetched.length === 1 && !fetched[0].init.dispatcher, url + ': allowed, an IP literal needs no DNS and no pin (' + ok + ')');
    }

    // publicDestination: the custom authorization endpoint's check (the Commander's browser opens it, the sidecar does not)
    reset(); answer = () => [V4];
    const dest = await f.publicDestination('https://auth.example/authorize?x=1');
    A.ok(Object.isFrozen(dest) && dest.href === 'https://auth.example/authorize?x=1' && dest.policy === 'connectorOauth' && dest.addresses.length === 1, 'publicDestination: a frozen Destination of the connectorOauth row');
    A.eq([asked.length, fetched.length, agents.length], [1, 0, 0], 'publicDestination asks DNS once and fetches nothing');
    answer = () => [{ address: '192.168.1.1', family: 4 }];
    const pd = await f.publicDestination('https://auth.example/authorize').then(() => null, e => e);
    A.ok(pd && /resolves to private address 192\.168\.1\.1/.test(pd.message) && /DNS filter/.test(pd.message), 'publicDestination refuses a private answer, with the DNS-filter exit');

    // a dispatcher close error is reported, never swallowed, and never replaces the response
    const g = makeConnectorOauthFetch({ onCloseError: e => closeErrors.push(e.message), agentFactory: () => ({ close: async () => { throw new Error('close failed'); } }) });
    answer = () => [V4];
    A.eq((await g.connectorOauthFetch('https://as.example/x')).status, 200, 'a close error never replaces the response');
    await tick(); await tick();
    A.eq(closeErrors, ['close failed'], 'it goes to onCloseError');
  } finally {
    dns.promises.lookup = realLookup;
    globalThis.fetch = realFetch;
  }

  A.report('mcp.oauth-fetch.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
