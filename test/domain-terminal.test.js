/* node test/domain-terminal.test.js — bounded one-host checks and host-enforced terminal evidence. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
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
/* A FILE NAME IS NOT A HOST (overnight soak 10-15). .md is Moldova, .py Paraguay, .sh Saint Helena, .rs Serbia: a
   lowercase file name plus any "check/open/read/review" was read as one exact website, and that run lost team.* and
   web_search ("Review main.py and fix the bug" -> host main.py; a lead asked to hand a poem file to COPY "could not
   delegate" because the sentence named soak-poem-….md and ended "I'll check back later"). Every row is one sentence:
   [text, the host it must name or null, why]. */
for (const [text, host, why] of [
  // file names / paths: never a host
  ['Review main.py and fix the bug', null, 'a python source file'],
  ['open notes.md and summarize it', null, 'a markdown note'],
  ["Hand this to COPY to do in the background: write a two-line poem about the station into a file named soak-poem-mv9az8r3.md. Do not ask me questions. I'll check back later.", null, 'the soak delegation sentence'],
  ['check build.sh for errors', null, 'a shell script'],
  ['review lib.rs', null, 'a rust source file'],
  ['Review main.cc and fix the crash', null, 'a C++ source file'],
  ['review test.pl before the release', null, 'a perl script'],
  ['check main.tf', null, 'a terraform file'],
  ['review player.gd', null, 'a godot script'],
  ['review requirements.in', null, 'a pip-tools input file'],
  ['open logo.ai and edit the layers', null, 'an illustrator file in a file task (.ai is mixed)'],
  ['review libfoo.so and fix the link error', null, 'a shared object in a code task (.so is mixed)'],
  ['Check main.py:12 for the bug', null, 'a file:line reference'],
  ['Can you check main.py?', null, 'a file name ending a question'],
  ['open notes.md#install and read it', null, 'a markdown anchor'],
  ['Read the docs in guide.md', null, '"in <file>" names a file even beside "docs"'],
  ['run deploy.ps1 and check the output', null, 'a .ps1 script is not the host deploy.ps'],
  ['open song.mp3 and review it', null, 'an .mp3 is not the host song.mp'],
  ['check backup.bz2', null, 'a .bz2 archive is not the host backup.bz'],
  ['review libfoo.so.6', null, 'a versioned shared object'],
  ['check notes.md for broken links', null, '"links" in a markdown check is not web evidence'],
  ['check models.py for the domain model', null, 'a "domain model" is not web evidence'],
  ['check the urls listed in readme.md', null, '"urls" listed in a file is not web evidence'],
  // real sites: still one exact host
  ['check example.com', 'example.com', 'a bare .com'],
  ['open starnetos.com', 'starnetos.com', 'the product site'],
  ['review github.io pages', 'github.io', 'a bare .io'],
  ['check itch.io site', 'itch.io', 'a bare .io named as a site'],
  ['read the docs at docs.python.org', 'docs.python.org', 'a three-label docs host'],
  ['visit www.notes.md', 'notes.md', 'www. makes a file-like suffix a website'],
  ['check https://main.py/', 'main.py', 'an explicit scheme makes a file-like suffix a website'],
  ['check docs.rs/tokio', 'docs.rs', 'a URL path makes a file-like suffix a website'],
  ['Check the perplexity.ai website', 'perplexity.ai', 'a mixed suffix named as a website'],
  ['open claude.ai', 'claude.ai', 'a mixed suffix with no file evidence stays a website'],
  ['check notion.so', 'notion.so', 'a mixed .so with no file evidence stays a website'],
  ['Visit point.md', 'point.md', 'a file-like suffix with a web verb'],
  ['Check example.com and save the summary into notes.md', 'example.com', 'the file it saves to is not a second host'],
  ['check about.me', 'about.me', 'a bare .me with no workspace file']
]) A.eq((DomainTask.classify(text) || {}).host || null, host, 'file names are not hosts: ' + why + ' (' + JSON.stringify(text) + ')');
A.eq(DomainTask.classify("Hand this to COPY: summarize example.com. I'll check back later."), null, '"check back later" is not an inspect verb');
/* THE WORKER BOUND IS FOR A PURE READ (starnet-releases#5). The host policy is the same either way; only a pure read
   carries the 3-turn / 3-tool / 45s worker bound. Every row: [text, pureRead, why]. */
for (const [text, pure, why] of [
  ['Review the deployment script for starnet-demo.io, write a unit test for it, and run it.', false, "the reporter's brief"],
  ['Review the deployment script for starnet-demo.io, write a unit test that covers it, then run the test and report the result.', false, 'review + write a test + run it'],
  ['Inspect the nginx config for example.com and fix the redirect.', false, 'inspect + fix'],
  ['Check example.com and save the summary into notes.md', false, 'check + save'],
  ['Check example.com and build a landing page like it.', false, 'check + build'],
  ['Review the auth flow for example.com and implement the missing token refresh.', false, 'review + implement'],
  ['Can you check example.com and fix the broken header?', false, '"and fix" in a question'],
  ['- review the starnet-demo.io deploy config\n- run the smoke tests', false, 'a bulleted run step'],
  ["Read example.com's pricing page and write a summary into notes.md", false, 'a summary written into a file'],
  // F10 (review of 0.14.1): the file a summary goes into, in every form a Commander or a lead names it
  ['Read the API docs at docs.example.com and write a short summary into C:\\Users\\me\\proj\\notes.md', false, 'a Windows drive-letter path'],
  ['Read the API docs at docs.example.com and write a short summary into C:/Users/me/proj/notes.md', false, 'a drive-letter path with forward slashes'],
  ['Read the API docs at docs.example.com and write a short summary into C:\\Users\\me\\My Project\\notes.md', false, 'an unquoted path with a space'],
  ['Read the API docs at docs.example.com and write a short summary into "C:\\Users\\me\\My Project\\notes.md"', false, 'a double-quoted path with a space'],
  ["Read the API docs at docs.example.com and write a short summary into 'C:\\Users\\me\\My Project\\notes.md'", false, 'a single-quoted path with a space'],
  ['Read the API docs at docs.example.com and write a short summary into `C:\\Users\\me\\My Project\\notes.md`', false, 'a backticked path with a space'],
  ['Read the API docs at docs.example.com and write a short summary into "C:\\Users\\me\\My Project\\notes"', false, 'a quoted path with no extension'],
  ['Read the API docs at docs.example.com and write a short summary into C:\\Users\\me\\proj\\NOTES', false, 'a drive-letter path with no extension'],
  ['Read the API docs at docs.example.com and write a short summary to D:\\work\\summary.txt', false, '"to" a drive-letter path'],
  ['Read the API docs at docs.example.com and write a short summary into \\\\server\\share\\notes.md', false, 'a UNC path'],
  ['Read the API docs at docs.example.com and write a short summary into ~/proj/notes.md', false, 'a home path'],
  ['Read the API docs at docs.example.com and write a short summary into /home/me/proj/notes.md', false, 'a POSIX absolute path'],
  ['Read the API docs at docs.example.com and write a short summary into docs/notes.md', false, 'a relative path with a separator'],
  ['Read the API docs at docs.example.com and write a short summary into the notes folder', false, '"the notes folder"'],
  ['Read the docs at docs.example.com/v1/api and write a short summary', true, 'a URL path is not a file destination'],
  ['Read https://docs.example.com/guide/intro and write a short summary', true, 'an explicit URL is not a file destination'],
  ['Read the API docs at docs.example.com and write a short summary to the Commander', true, 'a summary "to the Commander" is the answer'],
  ['Read the API docs at docs.example.com and write a short summary in plain English', true, 'a summary "in plain English" is the answer'],
  ["Read example.com's pricing page", true, 'a pure read'],
  ['read the pricing page on example.com', true, 'a pure read'],
  ['Go ahead, check out starnessos.com and then read the docs.', true, 'a pure docs read'],
  ['check claude.ai and write a summary', true, 'a summary is the answer, not an artifact'],
  ["Read example.com's pricing page and write a short summary of the plans.", true, 'a short summary is the answer'],
  ['check the latest build on ci.example.com', true, '"the latest build" is a noun'],
  ['check if example.com is up and running', true, '"up and running" is not a run step'],
  ['Read the docs at bun.sh on how to install it', true, '"how to install" is what the docs say']
]) {
  const policy = DomainTask.classify(text);
  A.ok(!!policy && policy.kind === 'direct-domain', '#5 still one exact host: ' + why + ' (' + JSON.stringify(text) + ')');
  A.eq(policy && policy.pureRead, pure, '#5 pure read: ' + why + ' (' + JSON.stringify(text) + ')');
  A.eq(policy && policy.workerMaxTools, pure ? 3 : undefined, '#5 the worker bound rides only a pure read: ' + why);
}
/* Review of the soak lane (10-15). Every row: [text, the host it must name or null, why].
   1. A DELEGATION IS NOT A ONE-SITE CHECK FOR THE LEAD. On base a site AND a file read as two "hosts", so the lead kept
      team.dispatch; once the file stopped counting, "Ask COPY to check example.com and save it into notes.md" withheld
      team.* and the lead could not hand it over — the soak's own symptom. The worker the lead dispatches is still bounded
      by orchestration.js (3 turns, 3 tools, 45s), so the bound stays on the run that fetches.
   2. WEB EVIDENCE MUST GOVERN THE NAME. "docs"/"site"/"visit" anywhere in the sentence made intro.md, handler.rs or
      notes.md a website; it now counts only beside the name (visit X, the X website, X and read its docs).
   3. A MIXED SUFFIX (.ai .so .pt) IS A FILE ONLY ON FILE-TYPE EVIDENCE. Generic task words (errors, write, in X) are
      what people say about claude.ai too; a typo'd startup.ai keeps its early NXDOMAIN stop.
   4. MORE CODE EXTENSIONS: .cu .nc .cl .la .bb are files without web evidence; .pt is mixed (Portugal / PyTorch). */
for (const [text, host, why] of [
  // 1. delegation keeps team.dispatch for the lead
  ['Hand this to COPY to do in the background: check starnetos.com and write a two-line summary into a file named site-notes.md. I will look later.', null, 'a background hand-off to COPY'],
  ['Ask COPY to check example.com and save the summary into notes.md', null, '"ask <crew> to" delegates'],
  ['Have NOVA review starnetos.com and put her notes in review.md', null, '"have <crew> review" delegates'],
  ['Delegate to COPY: open example.com and write findings to report.md', null, '"delegate" delegates'],
  ['Hand this to COPY: check example.com and summarize it', null, '"hand this to <crew>" delegates'],
  ['Give it to NOVA: open starnetos.com', null, '"give it to <crew>" delegates'],
  ['check example.com in the background', null, '"in the background" is a hand-off'],
  ['read the links in notes.md and check example.com', null, 'the links in a file are hosts nobody named'],
  ['check example.com and the pages it links to', null, 'pages it links to are hosts nobody named'],
  ['Check example.com and save the summary into notes.md', 'example.com', 'no delegation: still one exact host'],
  ['check example.com for broken links', 'example.com', 'checking one site for broken links stays a one-host check'],
  ['have a look at example.com', 'example.com', '"have a look" is not a delegation'],
  ['Can you have a quick look at example.com', 'example.com', '"have a quick look" is not a delegation'],
  ['have a worker check example.com', null, '"have a worker check" delegates'],
  // 2. web evidence beside the name, not anywhere in the sentence
  ['review intro.md in the docs', null, '"in the docs" does not make intro.md a site'],
  ['read changelog.md and the docs', null, '"and the docs" does not make changelog.md a site'],
  ['review getting-started.md for the docs site', null, '"for the docs site" does not make a .md a site'],
  ['check index.md on the website', null, '"on the website" does not make index.md a site'],
  ['review about.md for the site', null, '"for the site" does not make about.md a site'],
  ['check post.md renders on my site', null, '"on my site" does not make post.md a site'],
  ['review handler.rs and the docs', null, '"and the docs" does not make handler.rs a site'],
  ['Check notes.md, then visit the website it links to', null, '"visit" governs the website, not notes.md'],
  ['review the intro.md docs', null, 'a .md is never a site by a "docs" word'],
  ['open bun.sh and read the docs', 'bun.sh', '"X and read the docs" names the site'],
  ['Read the docs at docs.rs', 'docs.rs', '"the docs at X" names the site'],
  ['check the itch.sh website', 'itch.sh', '"the X website" names the site'],
  ['go to point.md and read it', 'point.md', '"go to X" is a web verb'],
  ['open main.py and read the docs', null, '.py, like .md, is a site only on strong evidence'],
  ['check app.py site settings', null, '"X site settings" is not "the X site"'],
  ['Read the pricing on cursor.sh', 'cursor.sh', '"the pricing on X" names the site'],
  ['check amazon.in prices', 'amazon.in', '"X prices" names the site'],
  ['Is example.sh up? check it', 'example.sh', '"is X up" names the site'],
  ['pull main.py up and check it', null, '"pull X up" is not "is X up"'],
  // 3. mixed suffixes need file-type evidence
  ['check claude.ai for errors', 'claude.ai', 'errors are what people check a site for too'],
  ['check claude.ai and write a summary', 'claude.ai', 'writing a summary of a site is not a file task'],
  ['check the new features in claude.ai', 'claude.ai', '"in claude.ai" is a place on the web'],
  ['check my settings in notion.so', 'notion.so', '"in notion.so" is a place on the web'],
  ['check libfoo.so', null, 'a lib-named .so is a shared library'],
  ['run ldd on plugin.so', null, 'ldd names a shared object'],
  // 4. code extensions that are also country codes
  ['review kernel.cu and fix the bug', null, 'a CUDA source file'],
  ['open data.nc and plot the temperature', null, 'a NetCDF file'],
  ['review kernel.cl', null, 'an OpenCL kernel'],
  ['check libfoo.la', null, 'a libtool archive'],
  ['review recipe.bb', null, 'a BitBake recipe'],
  ['load model.pt and check the weights', null, 'a PyTorch checkpoint'],
  ['check publico.pt', 'publico.pt', 'a Portuguese site'],
  ['visit falabella.cl', 'falabella.cl', 'a Chilean site named with a web verb']
]) A.eq((DomainTask.classify(text) || {}).host || null, host, 'review 10-15: ' + why + ' (' + JSON.stringify(text) + ')');
// a file that EXISTS in the run's workspace/project is a file, whatever its suffix (the host passes the predicate)
{
  const ws = new Set(['about.me', 'report.io', 'logo.ai']);
  const isFile = name => ws.has(name);
  A.eq(DomainTask.classify('check about.me', { isFile }), null, 'an existing workspace file named about.me is a file');
  A.eq(DomainTask.classify('open logo.ai and describe the artwork', { isFile }), null, 'an existing workspace logo.ai is a file');
  A.eq(DomainTask.classify('open report.io and read it', { isFile }), null, 'an existing workspace file named report.io is a file');
  A.eq((DomainTask.classify('check example.com', { isFile }) || {}).host, 'example.com', 'a site with no such workspace file stays a site');
  A.eq((DomainTask.classify('check https://about.me/', { isFile }) || {}).host, 'about.me', 'an explicit URL is a site even when a same-named file exists');
}
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
  const src = readSidecarSource();
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
  const src = readSidecarSource();
  const withheld = (src.match(/const directDomainWithheld = [^\n]+/) || [''])[0];
  A.ok(withheld && withheld.indexOf('browser') < 0, 'the direct-domain policy no longer strips the browser from the advertised tools');
  A.ok(/c\.name === 'browser\.navigate' \|\| c\.name === 'browser\.login'\) && !DomainTask\.isTargetNavigate\(c, directDomainTask\)/.test(src), 'the dispatch guard confines browser navigation to the named host');
  A.ok(/DomainTask\.isTargetNavigate\(c, directDomainTask\)\) && DomainTask\.isDomainMissing\(r\)/.test(src), 'a missing domain reached through the browser gets the same terminal stop');
  // tool.search's pool is settled BEFORE capCtx with the same predicate, so it never offers a withheld name.
  const decl = src.indexOf('const directDomainWithheld = '), pool = src.indexOf('!directDomainWithheld(n)'), cap = src.indexOf('makeCapCtx(resolved, Object.assign(');
  A.ok(decl > 0 && pool > decl && cap > pool, 'the deferred pool tool.search reads is filtered by the direct-domain predicate before capCtx is built');
  A.ok(/policyWithheld: directDomainTask \?/.test(src), 'tool.search is told what the direct-domain policy keeps off this run');
}

const hostSrc = readSidecarSource();
A.ok(/directDomainWithheld[\s\S]{0,220}team\\\./.test(hostSrc), 'direct-domain host withholds delegation');
A.ok(/DomainTask\.stopControl\(directDomainTask\)/.test(hostSrc), 'exact fetch missing-domain result receives host stop control');
A.ok(/const directDomainTask = isTask && !o\.toolsOptional \? DomainTask\.classify\(latestUserText\(messages\), \{ isFile: runFileExists\(agentId, o\.projectRoot\) \}\)/.test(hostSrc),
  'the run host tells the classifier which dotted names are files where this run reads (project, else workspace)');
A.ok(/makeOrchestrationTools\(\{[\s\S]{0,6000}\bfileProbe: runFileExists\b/.test(hostSrc),
  'the dispatcher classifies a worker brief with the same file probe the worker run uses (one brief, one answer)');
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
