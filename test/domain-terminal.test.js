/* node test/domain-terminal.test.js — bounded one-host checks and host-enforced terminal evidence. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const DomainTask = require('../sidecar/domain-task.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const direct = 'Go ahead, check out starnessos.com and then read the docs.';
const p = DomainTask.classify(direct);
A.ok(p && p.host === 'starnessos.com', 'one explicit host + direct read language is bounded');
A.eq(DomainTask.classify('Review sidecar/index.js before release.'), null, 'a source filename is not classified as a public host');
A.eq(DomainTask.classify('Open README.md and summarize it.'), null, 'a dotted document filename is not classified as a public host');
A.eq(DomainTask.classify('Check with alice@example.com before shipping.'), null, 'an email address is not classified as a public host');
A.ok(DomainTask.classify('Open https://example.com/docs')?.host === 'example.com', 'an explicit URL remains a bounded direct-domain task');
A.eq(DomainTask.classify('Open Cargo.toml and review the package.'), null, 'Cargo.toml is not a public host');
A.eq(DomainTask.classify('Inspect config.ini for the setting.'), null, 'config.ini is not a public host');
A.eq(DomainTask.classify('Review schema.sql before migration.'), null, 'schema.sql is not a public host');
A.ok(DomainTask.classify('Open docs.rs and read the crate docs.')?.host === 'docs.rs', 'a bare domain on a real ccTLD remains supported');
A.ok(DomainTask.classify('Visit example.sh and inspect the site.')?.host === 'example.sh', 'a public suffix that resembles a file extension remains supported');
A.ok(DomainTask.classify('Check starnessos.invalid and read its docs.')?.host === 'starnessos.invalid', 'RFC-reserved invalid host remains classifiable for terminal DNS evidence');
A.eq(DomainTask.classify('Open .env.example and review it.'), null, '.env.example remains a local configuration filename');
A.eq(DomainTask.classify('Inspect widget.test before release.'), null, 'a dotted test filename is not classified as a public host');
A.eq(DomainTask.classify('Review src/docs.rs before release.'), null, 'a path remains local even when its filename ends in a public suffix');
A.eq(DomainTask.classify('Find the correct official site for starnessos.com'), null, 'a requested alternative search stays open-ended');
A.eq(DomainTask.classify('Compare starnessos.com and example.com'), null, 'multiple hosts are not collapsed to one target');
// ISSUE #58: the policy withholds web_request, so an API CALL to one host must never be classified as a page read —
// the routine that POSTed with a saved key and then "checked the response" was left without its only tool.
for (const [text, why] of [
  ['Send a POST to https://api.example.com/v1/items with header Authorization: Bearer ${MY_API_KEY}, then check the response status', 'the reported routine (POST + ${KEY} + check)'],
  ['POST {"ok":true} to https://example.com/hooks/ingest and check it returns 200', 'an uppercase HTTP method'],
  ['Check the status endpoint at https://status.example.com and report it', 'an endpoint'],
  ['Use web_request to read my orders from shop.example.com', 'web_request named outright'],
  ['Call the Acme API at acme.io and review the result', 'calling an API'],
  ['Check https://example.com/api/health with my api key', 'an /api/ path + api key'],
  ['Read https://example.com/v2/orders and summarize them', 'a versioned API path'],
  ['Open https://api.example.com and read the JSON', 'an api. host']
]) A.eq(DomainTask.classify(text), null, 'an API call is not a direct-domain page read: ' + why);
A.ok(DomainTask.classify('Read the latest post on example.com')?.host === 'example.com', 'a lowercase "post" (a blog post) is still a page read');
A.ok(DomainTask.classify('Read the Stripe API docs at stripe.com')?.host === 'stripe.com', 'reading API DOCS is still a bounded page read');
A.ok(DomainTask.isTargetFetch({ name: 'web_fetch', args: { url: 'https://www.starnessos.com/docs' } }, p), 'exact-host web_fetch is recognized');
A.ok(!DomainTask.isTargetFetch({ name: 'web_fetch', args: { url: 'https://starnesos.com' } }, p), 'spelling variants are not silently substituted');
// ISSUE #58 (residual): a one-host "check my orders on printify.com" routine with a granted key is still a
// direct-domain task, but web_request to THAT host's API stays usable; any other host is refused.
{
  const shop = DomainTask.classify('check my orders on printify.com and summarize them');
  A.ok(shop && shop.host === 'printify.com', 'a plain one-host "check" is still the bounded direct-domain policy');
  A.ok(DomainTask.isTargetRequest({ name: 'web_request', args: { url: 'https://api.printify.com/v1/shops.json' } }, shop), 'web_request to the named host\'s API subdomain is allowed');
  A.ok(DomainTask.isTargetRequest({ name: 'web_request', args: { url: 'https://printify.com/x' } }, shop), 'web_request to the named host itself is allowed');
  A.ok(!DomainTask.isTargetRequest({ name: 'web_request', args: { url: 'https://evil-printify.com/x' } }, shop), 'a look-alike host is not a subdomain');
  A.ok(!DomainTask.isTargetRequest({ name: 'web_request', args: { url: 'https://api.stripe.com/v1' } }, shop), 'web_request to another host stays refused');
  A.ok(!DomainTask.isTargetRequest({ name: 'web_fetch', args: { url: 'https://printify.com' } }, shop), 'only web_request is matched');
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const withheld = (src.match(/const directDomainWithheld = [^\n]+/) || [''])[0];
  A.ok(withheld && withheld.indexOf("'web_request'") < 0, 'the direct-domain policy no longer strips web_request from the advertised tools');
  A.ok(/c\.name === 'web_request' && !DomainTask\.isTargetRequest\(c, directDomainTask\)/.test(src), 'the dispatch guard confines web_request to the named host');
}
A.ok(DomainTask.isDomainMissing({ summary: 'domain not found', content: 'Domain starnessos.com does not resolve (ENOTFOUND).' }), 'ENOTFOUND/NXDOMAIN result is terminal evidence');
// AN INTERACTIVE VISIT IS NOT A PAGE READ: clicking, typing, signing in and searching a site need the browser, so
// these are never confined to the one-host read policy (the run keeps its ordinary tools).
for (const [text, why] of [
  ['open amazon.com and search for usb cables', 'searching the store'],
  ['Open etsy.com and search for handmade leather wallets, read the top results', 'the reported Etsy request'],
  ['browse github.com and log in', 'logging in'],
  ['visit example.com and click the pricing page', 'clicking'],
  ['open shop.com and add the blue mug to the cart', 'adding to a cart'],
  ['open example.com and type my name in the form', 'typing into a form'],
  ['check example.com in the browser and take a screenshot', 'in the browser + screenshot'],
  ['open example.com and sign in with my account', 'signing in'],
  ['open amazon.com and buy me a usb cable', 'buying']
]) A.eq(DomainTask.classify(text), null, 'an interactive visit is not a bounded page read: ' + why);
for (const [text, host, why] of [
  ['check the order status on printify.com', 'printify.com', 'a noun "order"'],
  ['Read the press release on example.com', 'example.com', 'a noun "press"'],
  ['What type of site is example.com? Check it.', 'example.com', 'a noun "type"'],
  ['check my shop on etsy.com', 'etsy.com', 'a plain one-host check']
]) A.ok(DomainTask.classify(text)?.host === host, 'a non-interactive read stays bounded: ' + why);
// THE BROWSER STAYS ON a bounded run, confined to the named host — the same bound web_request has (#58).
{
  const etsy = DomainTask.classify('check my shop on etsy.com');
  A.ok(DomainTask.isTargetNavigate({ name: 'browser.navigate', args: { url: 'https://www.etsy.com/search?q=mug' } }, etsy), 'browser.navigate to the named host is allowed');
  A.ok(DomainTask.isTargetNavigate({ name: 'browser_navigate', args: { url: 'https://m.etsy.com/shop/x' } }, etsy), 'a subdomain (wire name) is allowed');
  A.ok(DomainTask.isTargetNavigate({ name: 'browser.login', args: { url: 'https://www.etsy.com/signin' } }, etsy), 'browser.login to the named host is allowed');
  A.ok(!DomainTask.isTargetNavigate({ name: 'browser.navigate', args: { url: 'https://web.archive.org/web/etsy.com' } }, etsy), 'an archive is refused');
  A.ok(!DomainTask.isTargetNavigate({ name: 'browser.navigate', args: { url: 'https://www.google.com/search?q=etsy' } }, etsy), 'a search engine is refused');
  A.ok(!DomainTask.isTargetNavigate({ name: 'browser.navigate', args: { url: 'https://evil-etsy.com' } }, etsy), 'a look-alike host is not a subdomain');
  A.ok(!DomainTask.isTargetNavigate({ name: 'web_fetch', args: { url: 'https://etsy.com' } }, etsy), 'only the browser URL tools are matched');
  A.ok(!DomainTask.isTargetNavigate({ name: 'browser.navigate', args: { url: 'https://etsy.com' } }, null), 'no policy, no match');
  A.ok(DomainTask.isDomainMissing({ isError: true, content: 'tool browser.navigate failed: getaddrinfo ENOTFOUND etsyy.com' }), 'the browser\'s own DNS pre-check failure is terminal evidence');
  A.ok(DomainTask.isDomainMissing({ isError: true, content: 'could not load etsyy.com: net::ERR_NAME_NOT_RESOLVED' }), 'Chrome\'s name-not-resolved is terminal evidence');
  A.ok(!DomainTask.isDomainMissing({ isError: true, content: 'tool browser.navigate failed: refusing to navigate: x resolves to private address 10.0.0.1' }), 'a refused private address is not a missing domain');
  // A page that LOADED can quote the error text (node/npm error docs, an issue thread): that is not a missing host.
  A.ok(!DomainTask.isDomainMissing({ ok: true, content: 'Troubleshooting: Error: getaddrinfo ENOTFOUND registry.npmjs.org means your DNS…' }), 'a fetched page that mentions getaddrinfo ENOTFOUND is not a missing domain');
  A.ok(!DomainTask.isDomainMissing({ ok: true, isError: false, content: 'Navigated to https://nodejs.org/api/errors.html\nERR_NAME_NOT_RESOLVED and ENOTFOUND are DNS errors.' }), 'a navigated page that mentions ERR_NAME_NOT_RESOLVED is not a missing domain');
  A.ok(DomainTask.isDomainMissing({ ok: false, content: 'tool browser_navigate failed: getaddrinfo ENOTFOUND etsyy.com' }), 'ok:false alone marks the call as failed');
  A.ok(/browser\.navigate/.test(DomainTask.prompt(etsy)), 'the host policy prompt names the browser as a way to read the host');
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const withheld = (src.match(/const directDomainWithheld = [^\n]+/) || [''])[0];
  A.ok(withheld && withheld.indexOf('browser') < 0, 'the direct-domain policy no longer strips the browser from the advertised tools');
  A.ok(/c\.name === 'browser\.navigate' \|\| c\.name === 'browser\.login'\) && !DomainTask\.isTargetNavigate\(c, directDomainTask\)/.test(src), 'the dispatch guard confines browser navigation to the named host');
  A.ok(/DomainTask\.isTargetNavigate\(c, directDomainTask\)\) && DomainTask\.isDomainMissing\(r\)/.test(src), 'a missing domain reached through the browser gets the same terminal stop');
  // tool.search's pool is settled BEFORE capCtx with the same predicate, so it never offers a withheld name.
  const decl = src.indexOf('const directDomainWithheld = '), pool = src.indexOf('!directDomainWithheld(n)'), cap = src.indexOf('makeCapCtx(resolved, Object.assign(');
  A.ok(decl > 0 && pool > decl && cap > pool, 'the deferred pool tool.search reads is filtered by the direct-domain predicate before capCtx is built');
  A.ok(/policyWithheld: directDomainTask \?/.test(src), 'tool.search is told what the direct-domain policy keeps off this run');
}

const hostSrc = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
A.ok(/directDomainWithheld[\s\S]{0,220}team\\\./.test(hostSrc), 'direct-domain host withholds delegation');
A.ok(/DomainTask\.stopControl\(directDomainTask\)/.test(hostSrc), 'exact fetch missing-domain result receives host stop control');
A.ok(/Number\(o\.maxToolCalls\)/.test(hostSrc), 'run host enforces delegated task-specific tool budgets');

function toolTurn() {
  return [
    { type: 'tool_start', index: 0, id: 'fetch1', name: 'web_fetch' },
    { type: 'tool_args', index: 0, chunk: '{"url":"https://starnessos.com"}' },
    { type: 'tool_start', index: 1, id: 'search1', name: 'web_search' },
    { type: 'tool_args', index: 1, chunk: '{"query":"starnessos"}' },
    { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    { type: 'done', finishReason: 'tool_calls' }
  ];
}
function textTurn(text) {
  return [{ type: 'text', delta: text }, { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, { type: 'done', finishReason: 'stop' }];
}

(async () => {
  const requests = [];
  let turn = 0;
  const provider = {
    async *stream(req) {
      requests.push(req);
      const events = turn++ === 0 ? toolTurn() : textTurn('The exact host does not resolve; please send the corrected URL.');
      for (const ev of events) yield ev;
    },
    priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 8000
  };
  const calls = [];
  const stop = DomainTask.stopControl(p);
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: direct }], provider, emit: () => {},
    cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r',
    tools: [
      { name: 'web_fetch', description: 'fetch', schema: { type: 'object' } },
      { name: 'web_search', description: 'search', schema: { type: 'object' } }
    ],
    dispatch: async c => { calls.push(c.name); return { ok: false, isError: true, summary: 'domain not found', content: 'NXDOMAIN', control: stop }; },
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' },
    parallelSafe: () => false
  });
  A.eq(calls, ['web_fetch'], 'terminal result skips later calls already requested in the same batch');
  A.eq(requests.length, 2, 'terminal evidence buys exactly one synthesis turn');
  A.ok(!requests[1].tools || requests[1].tools.length === 0, 'synthesis turn has no callable tools');
  A.ok(result.messages.some(m => m.role === 'system' && /terminal_domain/.test(String(m.content))), 'terminal evidence is explicit in model context');
  A.eq(result.reason, 'done', 'tool-free synthesis ends cleanly');
  A.report('domain-terminal.test');
})().catch(e => { console.error(e); process.exit(1); });
