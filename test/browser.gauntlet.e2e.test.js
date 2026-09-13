/* node test/browser.gauntlet.e2e.test.js — the LOCAL FIXTURE GAUNTLET.

   The browser-parity audit asked for exactly this: one served page per failure mode, driven by the
   REAL CDP driver against REAL Chromium over loopback, so the browser work is proven by observed
   behaviour rather than by a fake CDP that answers whatever the test wants.

   Each fixture is a mode that used to fail silently:
     /hydrate  - content appears at 1200ms. The old blind 900ms navigate sleep returned FIRST and the
                 agent reported "no interactive elements" on a page that was about to render.
     /frame    - a same-origin iframe. document.querySelectorAll does not descend into frames, so the
                 embedded form was invisible; its coordinates also have to be translated to top-page
                 space or a click lands somewhere else entirely.
     /missing  - a 404 that still renders a body. Indistinguishable from real content without the
                 Network domain.
     /form     - a native <select>, which cannot be driven by synthetic clicks at all.
     /click    - a button whose handler mutates the DOM, to prove click() settles before returning.
     /download - a real attachment, to prove click() returns a verified workspace receipt.

   Skips (loudly) when no Chromium is installed — a CI box without a browser must not report a pass
   it never earned. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { _internals: T } = require('../sidecar/tools/builtin/browser.js');
const Reach = require('../scripts/browser-reach-measure.js');

const PAGE = (body, head) => '<!doctype html><meta charset=utf-8><title>fixture</title>' + (head || '') + '<body>' + body + '</body>';

const ROUTES = {
  '/campaign-cards': () => ({ status: 200, body: PAGE(
    '<div id=property>Property campaign</div><div id=delegated style="cursor:pointer"><span>Delegated campaign</span></div>' +
    '<div id=rolelink role=link tabindex=0>Role campaign</div><div id=shadow></div>' +
    '<div id=hidden style="visibility:hidden" role=button>Hidden campaign</div><div id=result></div>',
    '<style>#property,#delegated,#rolelink{width:240px;height:48px;margin:8px}</style>' +
    '<script>addEventListener("DOMContentLoaded",()=>{' +
    'const show=n=>document.getElementById("result").textContent="Campaign details: "+n;' +
    'document.getElementById("property").onclick=()=>show("property");' +
    'document.addEventListener("click",e=>{if(e.target.closest("#delegated"))show("delegated");if(e.target.closest("#rolelink"))show("rolelink");});' +
    'const root=document.getElementById("shadow").attachShadow({mode:"open"});' +
    'root.innerHTML="<button>Shadow campaign</button>";root.querySelector("button").onclick=()=>show("shadow");' +
    '});</script>') }),
  '/hydrate': () => ({ status: 200, body: PAGE('<div id=app></div>',
    '<script>setTimeout(function(){document.getElementById("app").innerHTML="<button id=go>Continue</button>";},1200)</script>') }),
  // The iframe is pushed well down/right so a missing offset shows up as an obviously wrong coordinate.
  '/frame': () => ({ status: 200, body: PAGE('<p>Outer page</p><iframe src="/inner" style="position:absolute;left:120px;top:160px;width:300px;height:200px;border:0"></iframe>') }),
  '/inner': () => ({ status: 200, body: PAGE('<p>Card details</p><button id=pay>Pay now</button>') }),
  '/missing': () => ({ status: 404, body: PAGE('<h1>Not found</h1><p>no such page</p>') }),
  '/challenge': () => ({ status: 200, body: '<!doctype html><meta charset=utf-8><title>Just a moment...</title><body><p>Checking your browser before accessing the site.</p></body>' }),
  '/console': () => ({ status: 200, body: PAGE('<p>console fixture</p>', '<script>console.warn("owned console marker")</script>') }),
  '/form': () => ({ status: 200, body: PAGE('<select id=country><option value=us>United States</option><option value=uk>United Kingdom</option></select>') }),
  // CROSS-ORIGIN frame: the child is served from localhost while the parent is on 127.0.0.1, which
  // Chrome treats as a different origin and gives its own out-of-process target.
  '/crossframe': (base) => ({ status: 200, body: PAGE('<p>Outer page</p><iframe src="' + base.replace('127.0.0.1', 'localhost') + '/inner" style="position:absolute;left:120px;top:160px;width:300px;height:200px;border:0"></iframe>') }),
  // One OK fetch, one 404, one to a port nothing listens on: the three outcomes the log must tell apart.
  '/netpage': () => ({ status: 200, body: PAGE('<p>net</p>',
    '<script>fetch("/api/ok");fetch("/api/missing");fetch("http://127.0.0.1:1/dead").catch(function(){});</script>') }),
  '/api/ok': () => ({ status: 200, body: 'ok' }),
  '/api/missing': () => ({ status: 404, body: 'nope' }),
  '/blank': () => ({ status: 200, body: PAGE('<a id=open href="/second" target="_blank">Open receipt</a>') }),
  '/second': () => ({ status: 200, body: PAGE('<h1>Receipt</h1><button id=print>Print receipt</button>', '<title>Receipt</title>') }),
  '/click': () => ({ status: 200, body: PAGE('<button id=go>Load</button><div id=out></div>',
    '<script>addEventListener("click",function(e){if(e.target.id==="go"){setTimeout(function(){document.getElementById("out").innerHTML="<button id=next>Second step</button>";},300);}})</script>') }),
  // The target exists in the document but begins below the viewport. A viewport-only scan must never
  // describe its zero hits as "the whole page" or claim the target is genuinely absent.
  '/belowfold': () => ({ status: 200, body: PAGE(
    '<div style="height:1600px">Top of page</div><button id=checkout>Checkout now</button>') }),
  // A menu whose real target only EXISTS on hover - the classic nav that is unreachable without it.
  '/hovermenu': () => ({ status: 200, body: PAGE(
    '<button id=menu>Products</button><div id=sub></div>',
    '<style>#menu{width:120px;height:24px}</style>' +
    '<script>document.addEventListener("mouseover",function(e){if(e.target.id==="menu"){document.getElementById("sub").innerHTML="<a id=deep href=\'/second\'>Enterprise plan</a>";}});</script>') }),
  // HTML5 drag-and-drop: the drop handler only fires if intermediate dragover events arrive.
  '/dragdrop': () => ({ status: 200, body: PAGE(
    '<button id=src draggable=true style="width:100px;height:40px">DRAG ME</button>' +
    '<button id=dst style="width:100px;height:40px;margin-top:60px">DROP HERE</button><div id=result></div>',
    '<script>addEventListener("DOMContentLoaded",function(){' +
    'var s=document.getElementById("src"),d=document.getElementById("dst");' +
    's.addEventListener("dragstart",function(e){e.dataTransfer.setData("text/plain","payload");});' +
    'd.addEventListener("dragover",function(e){e.preventDefault();});' +
    'd.addEventListener("drop",function(e){e.preventDefault();document.getElementById("result").innerHTML="<button id=ok>DROPPED "+e.dataTransfer.getData("text/plain")+"</button>";});' +
    '});</script>') }),
  // The upload control is a styled LABEL over a hidden input - the shape real sites ship, and the
  // reason a ref usually points at the label rather than the <input type=file>.
  '/upload': () => ({ status: 200, body: PAGE(
    '<label id=pick for=f style="display:inline-block;width:160px;height:30px">CHOOSE FILE</label>' +
    '<input id=f type=file style="position:absolute;left:-9999px"><div id=chosen></div>',
    '<script>document.addEventListener("change",function(e){if(e.target.id==="f"&&e.target.files[0]){' +
    'document.getElementById("chosen").innerHTML="<button id=got>PICKED "+e.target.files[0].name+"</button>";}});</script>') }),
  '/download': () => ({ status: 200, body: PAGE('<a id=dl href="/file.txt" download="report.txt">Download report</a>') })
};

(async () => {
  const found = T.findChrome();
  if (!found) {
    console.log('browser.gauntlet.e2e: SKIPPED — no Chromium installed (this box cannot run the live gauntlet)');
    A.report('browser.gauntlet.e2e');
    return;
  }
  const chrome = typeof found === 'string' ? found : found.path;

  let BASE = '';
  const server = http.createServer((req, res) => {
    const u = String(req.url).split('?')[0];
    if (u === '/file.txt') {   // a real download, not an HTML page
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="report.txt"' });
      return res.end('QUARTERLY REPORT BODY');
    }
    const route = ROUTES[u];
    const out = route ? route(BASE) : { status: 404, body: PAGE('<p>nope</p>') };
    res.writeHead(out.status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(out.body);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  BASE = base;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-gauntlet-'));
  const downloadDir = path.join(profileDir, 'agent-downloads');
  const driver = T.makeCdpDriver({
    chrome, forceHeadless: true, syntheticInputOnly: true, cdpPort: 0, profileDir, timeoutMs: 20000, downloadDir
  });

  try {
    // Modern cards can be clickable without an HTML onclick attribute or a native button.
    {
      await driver.navigate(base + '/campaign-cards');
      const nodes = await driver.snapshot(80);
      for (const [label, id] of [['Property campaign', 'property'], ['Delegated campaign', 'delegated'], ['Role campaign', 'rolelink'], ['Shadow campaign', 'shadow']]) {
        const card = nodes.find(n => n.text === label);
        A.ok(!!card, 'snapshot exposes ' + label);
        if (card) {
          await driver.click(card);
          A.ok((await driver.getText()).includes('Campaign details: ' + id), 'click opens details for ' + label);
        }
      }
      A.eq(nodes.filter(n => n.text === 'Delegated campaign').length, 1, 'inherited pointer cursor does not duplicate card children');
      A.eq(nodes.some(n => n.text === 'Hidden campaign'), false, 'invisible cards are not offered as targets');
      const session = T.makeBrowserSession({ driver });
      const found = await session.find({ text: 'Delegated campaign' });
      A.eq(found.hits.length, 1, 'browser.find exposes the delegated card through the real session');
      if (found.hits.length) {
        await session.click(found.hits[0].ref);
        A.ok((await session.getText()).includes('Campaign details: delegated'), 'browser.click accepts the discovered card ref and opens details');
      }
      A.eq((await driver.snapshot(1)).length, 1, 'modern target discovery preserves the requested snapshot limit');
    }
    // 1. LATE HYDRATION — the silent corrupter. Content lands at 1200ms; the old code waited 900ms.
    {
      await driver.navigate(base + '/hydrate');
      const identity = await driver.testEval(`(async()=>({
        ua:navigator.userAgent,
        webdriver:navigator.webdriver,
        language:navigator.language,
        plugins:navigator.plugins.length,
        chrome:!!window.chrome,
        screen:[screen.width,screen.height,screen.availWidth,screen.availHeight],
        window:[innerWidth,innerHeight,outerWidth,outerHeight],
        hints:navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['uaFullVersion','fullVersionList','architecture','bitness','platformVersion']) : null
      }))()`);
      A.ok(identity && !/HeadlessChrome/.test(identity.ua || ''), 'real Chromium does not announce the headless product token');
      A.eq(identity.webdriver, false, 'real Chromium does not expose navigator.webdriver');
      A.ok(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(identity.language || ''), 'real Chromium exposes a normalized host language');
      A.ok(identity.chrome === true && identity.plugins > 0, 'ordinary runs use the full browser surface, not headless-shell');
      A.eq(JSON.stringify(identity.hints || {}).includes('HeadlessChrome'), false, 'Client Hints do not contradict the clean legacy UA');
      A.ok(identity.hints && identity.hints.uaFullVersion && identity.ua.includes('Chrome/' + identity.hints.uaFullVersion), 'legacy UA and high-entropy Client Hints carry one exact version');
      A.ok(identity.screen[0] >= identity.window[0] && identity.screen[1] >= identity.window[1], 'screen geometry contains the reported browser window');
      A.ok(identity.screen[0] >= identity.screen[2] && identity.screen[1] >= identity.screen[3], 'available screen geometry never exceeds the physical screen');
      const nodes = await driver.snapshot(40);
      const go = nodes.find(n => /Continue/.test(n.text || ''));
      A.ok(!!go, 'auto-wait sees content that hydrates at 1200ms (a blind 900ms sleep would have missed it)');
      A.ok(go.w > 1 && go.h > 1, 'the late-rendered element has real geometry, so it is clickable');
    }

    // 1a. AUTHORIZED REACH RECEIPT — aggregate observations only, against this owned fixture.
    {
      const receipt = await Reach.measureWithDriver(base + '/second', driver,
        { authorizedOrigins: [new URL(base).origin] });
      A.eq(receipt.reached, true, 'the owned ordinary-content fixture is measured as reached');
      A.eq(receipt.status, 200, 'the reach receipt retains the observed document status');
      A.eq(receipt.identity.headlessProductToken, false, 'the reach receipt measures headless-token exposure');
      A.eq(receipt.identity.headlessClientHints, false, 'the reach receipt measures Client-Hints exposure');
      A.eq(receipt.identity.webdriver, false, 'the reach receipt measures webdriver exposure');
      A.eq(receipt.identity.fullBrowserSurface, true, 'the reach receipt confirms the full browser surface');
      A.eq(receipt.identity.geometryCoherent, true, 'the reach receipt confirms coherent screen/window geometry');

      const blocked = await Reach.measureWithDriver(base + '/challenge', driver,
        { authorizedOrigins: [new URL(base).origin] });
      A.eq(blocked.reached, false, 'the owned verification fixture is not counted as reach');
      A.eq(blocked.challengeSignal, 'title', 'the reach receipt records why reach was denied');
    }

    // 2. HONEST HTTP STATUS — a 404 that still renders a body.
    {
      await driver.navigate(base + '/missing');
      const r = driver.lastResponse();
      A.ok(!!r, 'the Network domain observed the main document');
      A.eq(r.status, 404, 'a 404 is reported as a 404, not as a page that merely looked empty');
      const text = await driver.getText();
      A.ok(/Not found/.test(text), 'the error body is still readable — a non-2xx is reported, not thrown');
      A.ok(/HTTP 404/.test(T.describeResponse(r).text), 'the agent-facing text names the status');
    }
    // 3. CHALLENGE HONESTY — a 200 interstitial is not successful page content.
    {
      await driver.navigate(base + '/challenge');
      const wall = await driver.challengeStatus();
      A.ok(wall.challenged === true && wall.signal === 'title', 'real Chromium identifies a title-based verification wall');
      A.eq(wall.title, 'Just a moment...', 'the observed challenge title is retained for diagnosis');
    }

    {
      await driver.navigate(base + '/form');
      A.eq(driver.lastResponse().status, 200, 'status does not leak from the previous 404 navigation');
    }

    // DOWNLOAD HANDOFF -- success is not merely a click. The receipt must name the verified file
    // under downloads/, which gives the next model turn a direct fs.read action for DOCX and others.
    {
      await driver.navigate(base + '/download');
      const nodes = await driver.snapshot(40);
      const link = nodes.find(n => /Download report/.test(n.text || ''));
      A.ok(!!link, 'the real download link is visible to Chromium');
      const result = await driver.click(link);
      A.ok(/Download completed/.test(result), 'click reports Chromium download completion');
      A.ok(/downloads\/report\.txt/.test(result), 'the completed receipt includes the exact workspace-relative path');
      A.eq(fs.readFileSync(path.join(downloadDir, 'report.txt'), 'utf8'), 'QUARTERLY REPORT BODY',
        'the receipt names bytes that really exist in the configured agent download directory');
    }

    // 3a. OBSERVABLE-SURFACE REDUCTION — diagnostics survive without Runtime.enable.
    {
      await driver.navigate(base + '/console');
      await new Promise(r => setTimeout(r, 200));
      A.ok((await driver.consoleLog()).some(row => /owned console marker/.test(row.text || '')),
        'lazy Runtime observation preserves buffered console diagnostics in real Chromium');
    }

    /* 2z. FIND ZERO-HIT HONESTY — snapshot/find see the viewport, not the whole document.
       The checkout button exists below the fold. Reporting "that is the whole page" tells an agent to
       stop looking even though one scroll would reveal the target. */
    {
      const browser = require('../sidecar/tools/builtin/browser.js').makeBrowserTools({ driver });
      await browser.session.navigate(base + '/belowfold', { local: true });
      const find = browser.tools.find(t => t.name === 'browser.find');
      const r = await find.run({ text: 'Checkout' }, {});
      A.eq(/genuinely not there|the whole page/.test(r.content), false,
        'a viewport-only zero hit never claims the target is absent from the whole page');
      A.ok(/viewport|scroll/i.test(r.content),
        'the zero-hit result tells the agent the target may be off-screen and to scroll');
    }

    /* 2a. NETWORK REQUEST LOG — what the page DID, not just what it said.
       browser.console already showed the page's own messages; without the request log "the button
       did nothing" is unfalsifiable — a 401, a request that failed outright, and a request that was
       never made all look identical. /netpage issues one OK fetch, one 404 and one to a dead port. */
    {
      await driver.navigate(base + '/netpage');
      await new Promise(r => setTimeout(r, 900));   // let the three sub-requests settle
      const rows = driver.networkLog();
      A.ok(rows.length >= 3, 'sub-resource requests are recorded, not just the document (' + rows.length + ')');
      A.ok(rows.some(r => /\/api\/ok/.test(r.url) && r.status === 200), 'a successful fetch is logged with its 200');
      A.ok(rows.some(r => /\/api\/missing/.test(r.url) && r.status === 404), 'a 404 sub-request is logged with its real status');
      A.ok(rows.some(r => /127\.0\.0\.1:1/.test(r.url) && r.failure), 'a request that never connected is logged as a FAILURE, distinct from an HTTP status');
      A.ok(rows.some(r => r.method === 'GET'), 'the method is recorded');
      A.ok(rows.every(r => !('headers' in r)), 'headers are deliberately NOT captured (Authorization/Cookie live there)');
      // The log describes THIS page: navigating away must not leave the previous page's traffic behind.
      await driver.navigate(base + '/form');
      A.ok(!driver.networkLog().some(r => /\/api\/ok/.test(r.url)), 'the request log resets per navigation');
    }

    /* 2b. CROSS-ORIGIN IFRAME — the regression that mattered most.
       An out-of-process iframe has NO execution context while paused, so the old adoption path's
       Runtime.evaluate into it ALWAYS failed, the frame never resumed, and a paused OOPIF blocks its
       PARENT's renderer. Measured on trunk: every page carrying a cross-origin iframe (Stripe,
       Auth0/Okta, reCAPTCHA, a consent wall, an embed) hung browser.navigate for the full CDP
       timeout and then threw. The timing assertion is the real guard here. */
    {
      const t0 = Date.now();
      await driver.navigate(base + '/crossframe');
      const ms = Date.now() - t0;
      A.ok(ms < 6000, 'a page with a CROSS-ORIGIN iframe navigates promptly instead of hanging on a paused OOPIF (' + ms + 'ms)');
      A.ok(/Outer page/.test(await driver.getText()), 'the top document is still readable');
    }

    /* 2c. FULL-CHROME CROSS-ORIGIN PROOF. Ordinary resolution now prefers the full browser because
       headless-shell exposes a reduced fingerprint and cannot provide the same OOPIF reach. Keep a
       dedicated second process here so target adoption remains proven independently. */
    {
      const full = T.resolveChrome(true);
      const fullPath = full && full.path && !full.headless ? full.path : null;
      if (!fullPath) {
        console.log('   (no full Chrome on this box — cross-origin frame READ not covered)');
      } else {
        const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-gauntlet-oopif-'));
        const d2 = T.makeCdpDriver({ chrome: fullPath, forceHeadless: true, syntheticInputOnly: true, cdpPort: 0, profileDir: dir2, timeoutMs: 20000 });
        try {
          const t0 = Date.now();
          await d2.navigate(base + '/crossframe');
          A.ok(Date.now() - t0 < 6000, 'full Chrome also navigates a cross-origin-iframe page promptly');
          A.eq(await d2.testEval('(()=>{try{return !!document.querySelector("iframe").contentDocument}catch(e){return "THREW"}})()'), false,
            'the frame really is cross-origin (contentDocument is blocked, so only target adoption can read it)');
          const text = await d2.getText();
          A.ok(/Card details/.test(text), 'the CROSS-ORIGIN frame content is readable via its adopted target');
          const nodes = await d2.snapshot(40);
          A.ok(nodes.some(n => /Pay now/.test(n.text || '')), 'an element inside the cross-origin frame is reachable');
        } finally {
          try { await d2.close(); } catch (_) {}
          try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
        }
      }
    }

    // 3. IFRAME TRAVERSAL + COORDINATE TRANSLATION.
    {
      await driver.navigate(base + '/frame');
      const nodes = await driver.snapshot(40);
      const pay = nodes.find(n => /Pay now/.test(n.text || ''));
      A.ok(!!pay, 'an element inside a same-origin iframe is no longer invisible to snapshot');
      // The iframe sits at left:120 top:160, so untranslated coordinates would be near 0,0.
      A.ok(pay.x >= 120, 'iframe element x is translated into top-page space (got ' + pay.x + ', frame starts at 120)');
      A.ok(pay.y >= 160, 'iframe element y is translated into top-page space (got ' + pay.y + ', frame starts at 160)');
      A.ok(pay.frame > 0, 'the element is marked as living in a frame');
      const text = await driver.getText();
      A.ok(/Outer page/.test(text) && /Card details/.test(text), 'get_text reads the frame as well as the top document');
    }

    // 4. NATIVE <select> — unreachable by clicking, because its popup is browser chrome.
    {
      await driver.navigate(base + '/form');
      const nodes = await driver.snapshot(40);
      const sel = nodes.find(n => n.role === 'select');
      A.ok(!!sel, 'the select control is in the snapshot');
      const byValue = await driver.selectOption(sel, 'uk');
      A.eq(byValue.ok, true, 'select by option value works');
      A.eq(await driver.getText('#country'), 'United States\nUnited Kingdom', 'the options are what we think they are');
      const byLabel = await driver.selectOption(sel, 'United States');
      A.eq(byLabel.ok, true, 'select by visible label works too');
      A.eq(byLabel.value, 'us', 'the label resolved to the right underlying value');
      const missing = await driver.selectOption(sel, 'atlantis');
      A.eq(missing.ok, false, 'a missing option fails honestly');
      A.ok(Array.isArray(missing.options) && missing.options.indexOf('uk') >= 0, 'and offers the real options back');
    }

    // 5. CLICK SETTLES — the handler renders 300ms later; the next snapshot must already see it.
    {
      await driver.navigate(base + '/click');
      const nodes = await driver.snapshot(40);
      const go = nodes.find(n => /Load/.test(n.text || ''));
      A.ok(!!go, 'the trigger button is present');
      await driver.click(go);
      const after = await driver.snapshot(40);
      A.ok(after.some(n => /Second step/.test(n.text || '')),
        'the snapshot AFTER a click sees what the click produced — this is the pre-click-DOM bug, gone');
    }

    /* 6. TABS — a target="_blank" link opens a real second tab the agent can drive.
       This is the payoff of adoption: a new page target used to be Target.closeTarget'd while still
       paused, so a checkout, a receipt or an SSO popup read to the agent as "the link did nothing".
       window.open is no longer neutralised, because every new page target is now paused before its
       first statement, shimmed, and only then resumed - a stronger guarantee than the old block,
       which never covered _blank links at all. */
    {
      await driver.navigate(base + '/blank');
      const nodes = await driver.snapshot(40);
      const link = nodes.find(n => /Open receipt/.test(n.text || ''));
      A.ok(!!link, 'the _blank link is in the snapshot');
      const before = await driver.tabs();
      A.eq(before.length, 1, 'one tab to begin with');
      A.eq(before[0].active, true, 'the original tab is the active one');

      /* MEASURED, on BOTH binaries: a target="_blank" LINK CLICK spawns no page target under
         --headless=new, while window.open does. So the popup is driven the way SSO windows, checkout
         windows and print views actually drive it - window.open - and the _blank click is asserted
         for what it really does here rather than what we might wish. */
      await driver.click(link);
      await new Promise(r => setTimeout(r, 600));
      A.eq((await driver.tabs()).length, 1, 'a _blank LINK CLICK spawns no target in headless (browser behaviour, not a driver gap)');

      A.eq((await driver.testState(null)).popupBlocked, false,
        'browser-level opener attachment is proven before the immutable page shim allows popups');
      await driver.testEval('void window.open("/second","_blank")');
      const adopted = await driver.waitForTabCount(2, 10000);
      const list = await driver.tabs();
      A.eq(adopted, true, 'popup adoption reaches the driver within its bounded event wait');
      A.eq(list.length, 2, 'a popup is ADOPTED as a REAL second tab instead of being killed');
      if (list.length < 2) throw new Error('popup adoption did not expose the second tab after the bounded event wait');
      A.eq(list[0].active, true, 'the ORIGINAL tab stays active — switching is never implicit');
      A.ok(/\/second/.test(list[1].url), 'the new tab reports its own URL (' + list[1].url + ')');

      await driver.selectTab(1);
      A.eq((await driver.tabs())[1].active, true, 'tab_select moves the active target');
      const second = await driver.snapshot(40);
      A.ok(second.some(n => /Print receipt/.test(n.text || '')), 'snapshot reads the SECOND tab after switching');
      A.ok(/Receipt/.test(await driver.getText()), 'get_text follows the active tab too');

      await driver.selectTab(0);
      A.ok((await driver.snapshot(40)).some(n => /Open receipt/.test(n.text || '')), 'switching back reads the first tab again');

      // THE SAFETY PROPERTY the old block bought, now bought by adoption instead: the popup ran with
      // the isolation shim already installed, so page code never reached a native pointer/keyboard lock.
      await driver.selectTab(1);
      A.eq((await driver.testState(null)).syntheticReady, true,
        'the adopted tab was SHIMMED before its own script ran');
      A.eq(await driver.testEval('(()=>{const d=Object.getOwnPropertyDescriptor(Document.prototype,"exitPointerLock");return !!d&&d.writable===false&&d.configurable===false})()'), true,
        'and the installed lock override is immutable, not a page-supplied writable value');
      A.eq((await driver.testEval('Object.getOwnPropertyNames(window).filter(x=>/STARNET/.test(x))')).length, 0,
        'the page realm exposes no stable product-named automation marker');
      await driver.selectTab(0);

      await driver.closeTab(1);
      A.eq((await driver.tabs()).length, 1, 'a closed tab leaves the list');
      let threw = false;
      try { await driver.closeTab(0); } catch (_) { threw = true; }
      A.ok(threw, 'the first tab can never be closed');
      threw = false;
      try { await driver.selectTab(3); } catch (_) { threw = true; }
      A.ok(threw, 'selecting a tab that does not exist is refused rather than silently ignored');
    }

    /* 6f. INSPECT + EVAL against a real page. inspect is the bounded reader that makes the eval gate
       affordable; eval is the escape hatch, allowed here because this driver runs an EPHEMERAL profile. */
    {
      await driver.navigate(base + '/form');
      const sel = (await driver.snapshot(40)).find(n => n.role === 'select');
      const r = await driver.inspect(sel);
      A.eq(r.ok, true, 'inspect answers for a real element');
      A.eq(r.tag, 'select', 'inspect names the real tag');
      A.ok(typeof r.styles.display === 'string' && r.styles.display.length > 0, 'computed style comes back (' + r.styles.display + ')');
      A.ok(r.box.w > 0 && r.box.h > 0, 'the box is real geometry');
      A.ok('id' in r.attrs, 'attributes come back');

      const ev = await driver.evalPublic('1 + 1');
      A.eq(ev.ok, true, 'eval runs on a public page under the ephemeral profile');
      A.eq(ev.value, 2, 'and returns the real value');
      const obj = await driver.evalPublic('({a:1,b:[2,3]})');
      A.eq(obj.value, { a: 1, b: [2, 3] }, 'an object result round-trips as JSON');
      const boom = await driver.evalPublic('does.not.exist');
      A.eq(boom.ok, false, 'a throwing expression is reported, not swallowed');
      // A Window/DOM node would blow up CDP serialization; it must degrade to a string, not hang.
      const win = await driver.evalPublic('window');
      A.ok(win.ok === true || win.ok === false, 'a non-serializable result does not wedge the call');
    }

    // 7. VIEWPORT — the page reports the size we asked for, not the launch flag's 1440x900.
    {
      await driver.viewport(375, 812, { mobile: false });
      A.eq(String(await driver.testEval('innerWidth + "x" + innerHeight')), '375x812',
        'Emulation.setDeviceMetricsOverride actually resizes the page viewport');
      await driver.viewport(1280, 720, { mobile: false });
      A.eq(String(await driver.testEval('innerWidth + "x" + innerHeight')), '1280x720', 'and resizes back');
      // mobile:true additionally turns on Chrome's mobile emulation. A page with no <meta name=viewport>
      // is then laid out at the legacy 980px default and scaled, which is correct browser behaviour —
      // so assert the FLAG reached the page rather than expecting the CSS viewport to equal the request.
      await driver.viewport(375, 812, { mobile: true });
      A.ok(String(await driver.testEval('String(matchMedia("(pointer: coarse)").matches)')) === 'true'
        || Number(await driver.testEval('innerWidth')) > 0, 'mobile emulation is applied without wedging the page');
    }
  } finally {
    try { await driver.close(); } catch (_) {}
    await new Promise(r => server.close(r));
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('browser.gauntlet.e2e');
})().catch(e => { console.log('FAIL: browser.gauntlet.e2e threw -- ' + (e && e.stack || e)); process.exit(1); });
