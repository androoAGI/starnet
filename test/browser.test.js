/* node test/browser.test.js - browser automation contract:
   action surface, URL/redirect guards, snapshot refs, consent flags,
   capability projection, and graceful Chromium-missing errors. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { makeBrowserTools, _internals: T } = require('../sidecar/tools/builtin/browser.js');

const call = (name, args) => ({ id: 'c_' + name, name, args: args || {}, argsRaw: JSON.stringify(args || {}), parseError: null });
async function rejects(p, re, msg) {
  try { await p; A.ok(false, msg + ' - did not reject'); }
  catch (e) { A.ok(re.test((e && e.message) || String(e)), msg); }
}

function fakeDriver() {
  const log = { clicked: [], typed: [], pressed: [], scrolled: [], navigated: [], testInput: [], evaluated: [], states: [], hovered: [], dragged: [], selected: [], viewports: [] };
  let pageText = 'Example page text';
  return {
    log,
    navigate: async url => {
      log.navigated.push(url);
      if (/redirect-private/.test(url)) return 'http://127.0.0.1/admin';
      return url;
    },
    snapshot: async () => [
      { role: 'button', text: 'Search', x: 10, y: 20, w: 80, h: 30 },
      { role: 'textbox', text: 'Query', x: 10, y: 60, w: 200, h: 24 }
    ],
    click: async node => { log.clicked.push(node.text); return 'clicked ' + node.text; },
    type: async (node, text) => { log.typed.push([node.text, text]); pageText += ' ' + text; return 'typed ' + text; },
    press: async key => { log.pressed.push(key); return 'pressed ' + key; },
    hover: async node => { log.hovered.push(node.text); return 'hovered'; },
    drag: async (a, b) => { log.dragged.push([a.text, b.text]); return 'dragged'; },
    selectOption: async (node, value) => { log.selected.push([node.text, value]); return value === 'nope' ? { ok: false, reason: 'no option matching "nope"', options: ['a', 'b'] } : { ok: true, value, label: value.toUpperCase() }; },
    viewport: async (w, h, o) => { log.viewports.push([w, h, o && o.mobile === true]); return w + 'x' + h; },
    forward: async () => 'https://example.com/fwd',
    scroll: async (x, y) => { log.scrolled.push([x, y]); return 'scrolled ' + y; },
    back: async () => 'https://example.com/back',
    getText: async () => pageText,
    consoleLog: () => [{ type: 'warning', text: 'careful' }],
    handleDialog: async action => ({ type: action === 'dismiss' ? 'confirm' : 'alert', message: 'hello' }),
    screenshot: async () => Buffer.from('png').toString('base64'),
    testInput: async action => { log.testInput.push(action); return 'synthetic ' + action.action; },
    testEval: async expression => {
      log.evaluated.push(expression);
      if (String(expression).trim() === 'location.href') return log.navigated[log.navigated.length - 1] || 'about:blank';
      return { ok: true, expression };
    },
    testState: async selector => { log.states.push(selector); return { syntheticReady: true, pointerLockTag: 'CANVAS', element: { exists: true } }; }
  };
}

(async () => {
  // URL guard
  A.notThrows(() => T.assertSafeUrl('https://example.com/path'), 'public HTTPS URL is allowed');
  A.throws(() => T.assertSafeUrl('http://localhost:3000'), 'localhost URL is blocked');
  A.throws(() => T.assertSafeUrl('http://192.168.0.5'), 'private IPv4 URL is blocked');
  A.throws(() => T.assertSafeUrl('https://printer.lan'), 'intranet suffix URL is blocked');
  A.notThrows(() => T.assertLoopbackUrl('http://127.0.0.1:5173/game'), 'local test route accepts numeric loopback');
  A.notThrows(() => T.assertLoopbackUrl('http://localhost:4173/'), 'local test route accepts localhost');
  A.throws(() => T.assertLoopbackUrl('http://192.168.0.5'), 'local test route never widens to the LAN');
  A.throws(() => T.assertLoopbackUrl('https://example.com'), 'local test route accepts loopback only');

  // Station-owned Chrome announces the installed browser generation, never the headless product token.
  {
    const identity = T.makeLaunchIdentity('fake-chrome.exe', { browserVersion: '140.0.7339.12', locale: 'en_US', platform: 'win32', arch: 'x64' });
    A.eq(identity.locale, 'en-US', 'host locale is normalized for Chrome');
    A.ok(/Chrome\/140\.0\.7339\.12/.test(identity.userAgent), 'launch identity matches the installed browser version');
    A.ok(/Windows NT 10\.0; Win64; x64/.test(identity.userAgent), 'launch identity matches the host platform family');
    A.ok(!/HeadlessChrome/.test(identity.userAgent), 'station identity never announces the headless product token');
    const unknown = T.makeLaunchIdentity('missing-chrome', { spawnSync: () => ({ stdout: '', stderr: '' }), locale: 'de-DE' });
    A.eq(unknown.userAgent, '', 'an unproven browser version is never fabricated');
    A.eq(unknown.locale, 'de-DE', 'locale consistency remains available when version probing is unavailable');
    const probes = [];
    const winVersion = T.detectBrowserVersion('C:\\Program Files\\Chrome\\chrome.exe', {
      platform: 'win32', spawnSync: (exe, args) => { probes.push([exe, args]); return probes.length === 1 ? { stdout: '' } : { stdout: '149.0.7827.55' }; }
    });
    A.eq(winVersion, '149.0.7827.55', 'Windows GUI Chrome falls back to its file ProductVersion when --version is silent');
    A.ok(probes.length === 2 && /powershell/i.test(probes[1][0]), 'the version fallback is a bounded local file-metadata query');

    const cdpIdentity = T.makeCdpIdentity(
      { product: 'HeadlessChrome/149.0.7827.55' },
      { ua: 'HeadlessChrome/149.0.0.0', platform: 'Win32', hints: {
        brands: [{ brand: 'HeadlessChrome', version: '149' }, { brand: 'Not)A;Brand', version: '24' }],
        fullVersionList: [{ brand: 'HeadlessChrome', version: '149.0.7827.55' }],
        platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', bitness: '64', mobile: false
      } },
      { chromePath: 'fake-chrome.exe', locale: 'en-US', platform: 'win32', arch: 'x64' }
    );
    A.ok(/Chrome\/149\.0\.7827\.55/.test(cdpIdentity.userAgent), 'CDP identity derives the exact connected browser version');
    A.eq(cdpIdentity.userAgentMetadata.brands.some(b => /HeadlessChrome/.test(b.brand)), false, 'Client Hint brands never retain the headless product token');
    A.ok(cdpIdentity.userAgentMetadata.brands.some(b => b.brand === 'Chromium' && b.version === '149'), 'Client Hint major version agrees with the legacy UA');
    A.ok(cdpIdentity.userAgentMetadata.fullVersionList.some(b => b.brand === 'Chromium' && b.version === '149.0.7827.55'), 'high-entropy Client Hints agree with the exact UA version');
    A.eq(cdpIdentity.userAgentMetadata.platform, 'Windows', 'natural platform metadata is preserved instead of fabricated');
    const edgeIdentity = T.makeCdpIdentity({ product: 'Chrome/149.0.7827.55' }, {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 HeadlessChrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0',
      platform: 'Win32', hints: { brands: [{ brand: 'Microsoft Edge', version: '149' }], platform: 'Windows' }
    }, { chromePath: 'msedge.exe', locale: 'en-US', platform: 'win32' });
    A.ok(/Chrome\/149\.0\.7827\.55/.test(edgeIdentity.userAgent) && /Edg\/149/.test(edgeIdentity.userAgent), 'identity cleanup preserves the connected browser family instead of disguising Edge as Chrome');

    const fullCandidate = T.CHROME_CANDIDATES.find(c => !c.headless);
    const shellCandidate = T.CHROME_CANDIDATES.find(c => c.headless);
    if (fullCandidate && shellCandidate) {
      const picked = T.resolveChrome(false, p => p === fullCandidate.path || p === shellCandidate.path);
      A.eq(picked.path, fullCandidate.path, 'ordinary headless runs prefer a full Chromium binary over headless-shell');
      A.eq(picked.headless, false, 'the preferred browser retains the full browser surface');
    }
  }

  const driver = fakeDriver();
  const B = makeBrowserTools({ driver, vision: async ({ question }) => 'vision answer: ' + question });
  const names = B.tools.map(t => t.name).sort();
  A.eq(names, [
    'browser.attach', 'browser.back', 'browser.click', 'browser.console', 'browser.detach', 'browser.dialog', 'browser.drag',
    'browser.emulate', 'browser.eval', 'browser.find', 'browser.forward', 'browser.get_text', 'browser.hover', 'browser.inspect',
    'browser.intercept', 'browser.login', 'browser.navigate', 'browser.network',
    'browser.pdf', 'browser.press', 'browser.screenshot', 'browser.scroll', 'browser.select', 'browser.snapshot',
    'browser.tab_close', 'browser.tab_select', 'browser.tabs',
    'browser.test_input', 'browser.test_navigate', 'browser.test_snapshot', 'browser.test_state',
    'browser.type', 'browser.upload', 'browser.viewport', 'browser.vision', 'browser.wait'
  ], 'browser action surface is complete');
  A.eq(B.tools.find(t => t.name === 'browser.click').requiresConsent, true, 'click is consent-gated');
  A.eq(B.tools.find(t => t.name === 'browser.snapshot').requiresConsent, false, 'snapshot is read-only');

  // navigate + redirect guard
  {
    const out = await B.tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
    A.ok(/https:\/\/example\.com/.test(out.content), 'navigate returns the final public URL');
    await rejects(B.session.navigate('https://redirect-private.example'), /blocked unsafe redirect/, 'unsafe redirect is refused explicitly');
    const local = await B.tools.find(t => t.name === 'browser.test_navigate').run({ url: 'http://127.0.0.1:5173/' }, {});
    A.ok(/synthetic-input isolated|headless/i.test(local.content), 'local test navigation reports its isolated posture');
    await B.tools.find(t => t.name === 'browser.test_input').run({ action: 'key_down', key: 'KeyW' }, {});
    await B.tools.find(t => t.name === 'browser.test_state').run({ selector: '#hud' }, {});
    const localSnap = await B.tools.find(t => t.name === 'browser.test_snapshot').run({ limit: 5 }, {});
    A.ok(/button|link|textbox/.test(localSnap.content), 'local snapshot exposes synthetic-click coordinates without arbitrary JavaScript');
    A.eq(driver.log.testInput[0].action, 'key_down', 'local game input routes through the synthetic driver');
    A.eq(driver.log.states[0], '#hud', 'local game state inspection routes through the bounded CDP state reader');

    const ownedDriver = fakeDriver();
    const owned = makeBrowserTools({ driver: ownedDriver, requireOwnedServer: true, ownsLocalUrl: async o => o.serverId === 'bg_1' });
    const ownedNav = owned.tools.find(t => t.name === 'browser.test_navigate');
    A.ok(ownedNav.schema.required.includes('serverId'), 'production local navigation requires an owned background-server handle');
    await rejects(ownedNav.run({ url: 'http://127.0.0.1:5173/', serverId: 'bg_other' }, { agentId: 'ag' }), /not proven to belong/i, 'unowned localhost service is refused');
    await ownedNav.run({ url: 'http://127.0.0.1:5173/', serverId: 'bg_1' }, { agentId: 'ag' });
    A.eq(ownedDriver.log.navigated.length, 1, 'owned background service may enter the isolated browser');
    ownedDriver.log.navigated.push('http://127.0.0.1:9999/admin');
    await rejects(owned.tools.find(t => t.name === 'browser.test_input').run({ action: 'click', x: 1, y: 1 }, {}), /left its owned server origin/i, 'synthetic input is disabled if the page leaves its owned origin');
    A.eq(ownedDriver.log.testInput.length, 0, 'origin drift is refused before another input event dispatches');
  }

  // refs expire after the next snapshot
  {
    const snap = await B.tools.find(t => t.name === 'browser.snapshot').run({}, {});
    const searchRef = (snap.content.match(/(b\d+) \[button\] Search/) || [])[1];
    A.ok(!!searchRef, 'snapshot returns stable element refs');
    const click = await B.tools.find(t => t.name === 'browser.click').run({ ref: searchRef }, {});
    A.ok(/clicked Search/.test(click.content), 'click uses a snapshot ref');
    await B.session.snapshot();
    /* STALE-REF RECOVERY - a DELIBERATE contract change. This used to reject. A second snapshot renumbers
       refs, which killed every ref the agent was holding, mid-task, over a page that had not changed at
       all. Recovery re-resolves the ref by role+text against a FRESH snapshot - never against the old
       coordinates, so the "silently mis-aimed" hazard the old contract guarded is eliminated rather than
       tolerated - and the answer SAYS it recovered, because acting on a re-found node is a different claim
       from acting on the ref the agent named. The guards that keep this honest are asserted below. */
    const again = await B.session.click(searchRef);
    A.ok(/clicked Search/.test(again), 'a stale ref is RECOVERED by re-finding the same element');
    A.ok(/had gone stale/.test(again), 'and the recovery is DISCLOSED, never silent');
  }

  // type/press/scroll/back/console/dialog/get_text/vision all route through the driver
  {
    const nodes = await B.session.snapshot();
    const textbox = nodes.find(n => n.role === 'textbox');
    await B.tools.find(t => t.name === 'browser.type').run({ ref: textbox.ref, text: 'hello' }, {});
    await B.tools.find(t => t.name === 'browser.press').run({ key: 'Enter' }, {});
    await B.tools.find(t => t.name === 'browser.scroll').run({ y: 250 }, {});
    const back = await B.tools.find(t => t.name === 'browser.back').run({}, {});
    const con = await B.tools.find(t => t.name === 'browser.console').run({}, {});
    const dlg = await B.tools.find(t => t.name === 'browser.dialog').run({ action: 'dismiss' }, {});
    const txt = await B.tools.find(t => t.name === 'browser.get_text').run({}, {});
    const vis = await B.tools.find(t => t.name === 'browser.vision').run({ question: 'what changed?' }, {});
    A.eq(driver.log.typed[0], ['Query', 'hello'], 'type routes to the textbox ref');
    A.eq(driver.log.pressed[0], 'Enter', 'press routes to driver');
    A.eq(driver.log.scrolled[0], [0, 250], 'scroll routes to driver');
    A.ok(/back/.test(back.content), 'back returns the resulting URL');
    A.ok(/careful/.test(con.content), 'console returns recent messages');
    A.ok(/confirm/.test(dlg.content), 'dialog action routes to driver');
    A.ok(/hello/.test(txt.content), 'get_text returns page text');
    A.ok(/vision answer/.test(vis.content), 'vision hook is available');
  }

  // registry/capability integration
  {
    const reg = makeRegistry();
    makeBrowserTools({ driver: fakeDriver() }).register(reg);
    const station = { agents: { ag: { id: 'ag', room: 'r' } }, rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'dish' }] } } };
    const resolved = resolveTools('ag', station);
    A.ok(resolved.tools.indexOf('browser.navigate') >= 0 && resolved.tools.indexOf('browser.click') >= 0, 'dish grants browser tools');
    A.eq(resolved.approvalRules['browser.click'].requiresConsent, true, 'mutating browser tools carry consent rules');
    const noDish = resolveTools('ag', { agents: { ag: { id: 'ag', room: 'r' } }, rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }] } } });
    const denied = await reg.dispatch(call('browser.navigate', { url: 'https://example.com' }), makeCapCtx(noDish));
    A.eq(denied.summary, 'capdenied', 'without a dish, browser tools are capability-denied');

    const workbench = resolveTools('ag', { agents: { ag: { id: 'ag', room: 'r' } }, rooms: { r: { id: 'r', objects: [{ objectType: 'computer' }, { objectType: 'workbench' }] } } });
    A.ok(workbench.tools.indexOf('browser.test_navigate') >= 0 && workbench.tools.indexOf('browser.test_input') >= 0 && workbench.tools.indexOf('browser.test_state') >= 0, 'workbench grants the isolated local-game CDP surface');
  }

  // Chromium-missing degrades as a clean tool error through dispatch
  {
    const reg = makeRegistry();
    makeBrowserTools({ existsSync: () => false, WebSocketImpl: null }).register(reg);
    const r = await reg.dispatch(call('browser.navigate', { url: 'https://example.com' }));
    A.eq(r.isError, true, 'missing Chromium returns tool error');
    A.ok(/browser unavailable/.test(r.content), 'missing Chromium error is explicit');
  }

  // browser.vision: with a vision dep the answer flows through; with NONE it is honestly unavailable
  {
    const withVision = makeBrowserTools({ driver: fakeDriver(), vision: async ({ question }) => 'I see: ' + question });
    const ok = await withVision.tools.find(t => t.name === 'browser.vision').run({ question: 'what page?' }, {});
    A.eq(ok.summary, 'vision', 'wired vision reports success summary');
    A.ok(/I see: what page\?/.test(ok.content), 'wired vision answer flows through');

    const noVision = makeBrowserTools({ driver: fakeDriver() });   // no vision dep
    const un = await noVision.tools.find(t => t.name === 'browser.vision').run({ question: 'what page?' }, {});
    A.eq(un.summary, 'vision unavailable', 'missing vision provider yields an honest unavailable summary, not a success stub');
    // 2026-07-22: the unavailable message must NEVER solicit an API key from the user (that wording primed
    // agents to demand OpenRouter keys — the Telegram media bug); it names the missing route and forbids asking.
    A.ok(/unavailable/i.test(un.content) && /vision route/i.test(un.content), 'unavailable content names the missing vision route');
    A.ok(/do not ask the user for an api key/i.test(un.content), 'unavailable content forbids soliciting a key');
    A.ok(!/connect an? (OpenRouter|API) key/i.test(un.content), 'unavailable content never tells the agent to request a key');
    A.ok(!/I see:/.test(un.content), 'unavailable content never fabricates a description');
  }

  // ---- HEADLESS-BY-DEFAULT (2026-07-07 direction: research must never open a window on the user's
  //      screen; a visible window exists ONLY while the Commander asked to watch) ----
  {
    const made = [];   // capture every driver launch + its mode via the makeDriver seam
    const mkSession = (env, extra) => T.makeBrowserSession(Object.assign({
      env: env || {},
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => { drv.closed = true; }; made.push(drv); return drv; }
    }, extra || {}));

    const s = mkSession();
    await s.navigate('https://example.com');                        // plain research navigate
    A.eq(made.length, 1, 'first navigate launches one driver');
    A.eq(made[0].headed, false, 'DEFAULT IS HEADLESS: research never opens a window');

    await s.navigate('https://example.com/2');                       // still no visibility request
    A.eq(made.length, 1, 'mode unchanged -> no relaunch');

    await s.navigate('https://example.com/3', { visible: true });    // the Commander asked to watch
    A.eq(made.length, 2, 'visible:true relaunches the driver');
    A.eq(made[1].headed, true, 'visible:true opens the HEADED window');
    A.eq(made[0].closed, true, 'the headless driver was closed on the mode switch');

    await s.navigate('https://example.com/4');                       // follow-up drive of the SAME window
    A.eq(made.length, 2, 'a plain navigate after visible:true keeps the watched window (no relaunch)');

    await s.navigate('https://example.com/5', { visible: false });   // done watching
    A.eq(made.length, 3, 'visible:false relaunches back');
    A.eq(made[2].headed, false, 'visible:false returns to headless');

    // a headless env pins the posture: even an explicit visible:true stays headless (CI/soak safety)
    const s2 = mkSession({ SKYNET_BROWSER_HEADLESS: '1' });
    await s2.navigate('https://example.com', { visible: true });
    A.eq(made[made.length - 1].headed, false, 'SKYNET_BROWSER_HEADLESS=1 wins over visible:true');

    const s3 = mkSession({}, { forceHeadless: true });
    await s3.navigate('https://example.com', { visible: true });
    A.eq(made[made.length - 1].headed, false, 'host forceHeadless policy wins over model-controlled visible:true');

    // A same-profile mode switch must await asynchronous teardown too; otherwise the replacement can open
    // while Chrome still owns the profile lock even though close() eventually succeeds.
    let modeCloseSettled = true;
    const asyncMade = [];
    const asyncSession = T.makeBrowserSession({
      makeDriver: (d) => {
        const drv = fakeDriver();
        drv.headed = !!d.headed;
        drv.createdBeforePriorClose = !modeCloseSettled;
        drv.close = async () => {
          modeCloseSettled = false;
          await new Promise(resolve => setTimeout(resolve, 20));
          modeCloseSettled = true;
        };
        asyncMade.push(drv);
        return drv;
      }
    });
    await asyncSession.navigate('https://example.com');
    await asyncSession.navigate('https://example.com/watch', { visible: true });
    A.eq(asyncMade[1].createdBeforePriorClose, false,
      'visible-mode replacement waits for the prior same-profile driver to close');
    await asyncSession.close();
  }

  // The default tool surface is fail-closed: no model-controlled visible flag. A separately
  // constructed attended host may opt in, but runOnce never does for tasks/autonomy/tests.
  {
    const made = [];
    const B2 = makeBrowserTools({
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => {}; made.push(drv); return drv; }
    });
    const nav = B2.tools.find(t => t.name === 'browser.navigate');
    A.eq(nav.schema.properties.visible, undefined, 'ordinary task browser schema cannot request a visible window');
    A.ok(/HEADLESS/i.test(nav.description), 'the description states the headless posture');
    const r1 = await nav.run({ url: 'https://example.com' }, {});
    A.ok(/headless — not visible/.test(r1.content), 'a research navigate reports headless honestly');
    await rejects(nav.run({ url: 'https://example.com', visible: true }, {}), /visible.*disabled|headless-only/i, 'forged visible:true is refused by host policy');
    A.eq(made.map(d => d.headed), [false], 'ordinary task browsing never creates a headed driver');

    const attended = makeBrowserTools({
      allowVisible: true,
      makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => !!d.headed; drv.close = () => {}; made.push(drv); return drv; }
    });
    const attendedNav = attended.tools.find(t => t.name === 'browser.navigate');
    A.ok(attendedNav.schema.properties.visible, 'a separately constructed attended surface may expose visible');
    const r2 = await attendedNav.run({ url: 'https://example.com', visible: true }, {});
    A.ok(/visible window/.test(r2.content), 'explicit attended surface reports its visible window truthfully');
  }

  // Pointer/keyboard locks are emulated inside the CDP page before navigation; the native
  // browser implementation (and therefore Win32 ClipCursor) is never reached.
  A.ok(/requestPointerLock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap overrides requestPointerLock');
  A.ok(/exitPointerLock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap overrides exitPointerLock');
  A.ok(/requestFullscreen/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /exitFullscreen/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap emulates fullscreen without a platform transition');
  A.ok(/keyboard/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /lock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap neutralizes keyboard lock');
  A.ok(/wakeLock/.test(T.SYNTHETIC_INPUT_BOOTSTRAP) && /orientation/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'isolation bootstrap neutralizes wake/orientation locks');
  A.ok(/Object\.freeze\(attestation\)/.test(T.SYNTHETIC_INPUT_BOOTSTRAP), 'page code cannot forge the synthetic-isolation ready attestation');
  A.ok(/getOwnPropertyDescriptor\(Element\.prototype,'requestPointerLock'\)/.test(T.makeCdpDriver.toString()), 'navigation verifies the actual non-writable pointer-lock descriptor');
  A.ok(/getOwnPropertyDescriptor\(Element\.prototype,'requestFullscreen'\)/.test(T.makeCdpDriver.toString()), 'navigation verifies the actual non-writable fullscreen descriptor');

  // Drive the real CDP adapter against an in-memory protocol peer: the bootstrap must be
  // registered BEFORE Page.navigate, and the launched process must stay headless/muted.
  {
    const sent = [], launches = [], inputDelays = [];
    let currentUrl = 'about:blank', isolationReady = true;
    const fakeProc = pid => {
      let close;
      return { pid, on(ev, fn) { if (ev === 'close') close = fn; }, kill() { if (close) queueMicrotask(() => close(0)); } };
    };
    class FakeWS {
      constructor() { this.handlers = {}; FakeWS.last = this; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
      fire(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        if (m.method === 'Page.navigate') currentUrl = m.params.url;
        let value = currentUrl;
        if (m.method === 'Runtime.evaluate' && /return \{ready:/.test(String(m.params && m.params.expression || ''))) {
          value = { ready: isolationReady, error: isolationReady ? null : 'simulated bootstrap refusal' };
        } else if (m.method === 'Runtime.evaluate' && /getHighEntropyValues/.test(String(m.params && m.params.expression || ''))) {
          value = { ua: 'HeadlessChrome/140.0.0.0', platform: 'Win32', hints: {
            brands: [{ brand: 'HeadlessChrome', version: '140' }],
            fullVersionList: [{ brand: 'HeadlessChrome', version: '140.0.7339.12' }],
            platform: 'Windows', platformVersion: '19.0.0', architecture: 'x86', bitness: '64', mobile: false
          } };
        }
        const result = m.method === 'Runtime.evaluate' ? { result: { value } } :
          (m.method === 'Browser.getVersion' ? { product: 'HeadlessChrome/140.0.7339.12' } : {});
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    let browserVersionAttempts = 0;
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9347,
      inputSeed: 'browser-input-contract', inputSleep: async ms => { inputDelays.push(ms); },
      fetchImpl: async url => {
        if (url.endsWith('/json/version') && browserVersionAttempts++ === 0) throw new Error('browser endpoint still starting');
        return { json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://fake' }] };
      },
      WebSocketImpl: FakeWS,
      spawn: (exe, args) => { launches.push({ exe, args }); return fakeProc(42); }
    });
    await d.navigate('http://127.0.0.1:5173/');
    const installAt = sent.findIndex(m => m.method === 'Page.addScriptToEvaluateOnNewDocument');
    const navAt = sent.findIndex(m => m.method === 'Page.navigate');
    A.ok(installAt >= 0 && installAt < navAt, 'synthetic input bootstrap is installed before navigation');
    A.ok(/requestPointerLock/.test(sent[installAt].params.source), 'CDP installs the pointer-lock override source');
    A.ok(/state\.ready/.test(sent[installAt].params.source), 'pointer-lock bootstrap exposes a verifiable ready marker');
    A.ok(launches[0].args.some(a => /^--headless/.test(a)) && launches[0].args.includes('--mute-audio'), 'CDP browser process is headless and muted');
    A.ok(!launches[0].args.includes('--new-window'), 'synthetic test browser never requests a window');
    A.eq(browserVersionAttempts, 2, 'a transient /json/version startup miss is retried before page-only fallback disables popup adoption');
    A.ok(sent.some(m => m.method === 'Target.setAutoAttach' && m.params.waitForDebuggerOnStart === true), 'new targets are paused before scripts can reach native input APIs');
    A.ok(!sent.some(m => m.method === 'Runtime.enable'), 'the page-observable Runtime domain is never globally enabled');
    await d.consoleLog();
    A.ok(sent.some(m => m.method === 'Runtime.enable'), 'Runtime observation begins only after browser.console is requested');

    // BOUNDED INPUT CADENCE: real actions use deterministic paths/timing, never instant teleport bursts.
    let mark = sent.length;
    await d.click({ x: 10, y: 20, w: 80, h: 30 });
    let input = sent.slice(mark).filter(m => m.method === 'Input.dispatchMouseEvent');
    A.ok(input.filter(m => m.params.type === 'mouseMoved').length >= 3, 'click moves through a bounded pointer path before pressing');
    A.eq(input.slice(-2).map(m => m.params.type), ['mousePressed', 'mouseReleased'], 'click ends with an ordered press/release pair');
    A.ok(inputDelays.some(ms => ms >= 35 && ms <= 90), 'click carries a bounded press duration');

    mark = sent.length; inputDelays.length = 0;
    await d.type({ x: 10, y: 60, w: 200, h: 24 }, 'abc');
    const inserts = sent.slice(mark).filter(m => m.method === 'Input.insertText');
    A.eq(inserts.map(m => m.params.text).join(''), 'abc', 'paced typing preserves the exact text');
    A.eq(inserts.length, 3, 'short text is typed character by character');
    A.ok(inputDelays.filter(ms => ms >= 25 && ms <= 70).length >= 2, 'typing intervals stay inside the bounded cadence');

    mark = sent.length; inputDelays.length = 0;
    await d.scroll(0, 240);
    const wheels = sent.slice(mark).filter(m => m.method === 'Input.dispatchMouseEvent' && m.params.type === 'mouseWheel');
    A.ok(wheels.length >= 3 && wheels.length <= 6, 'scroll uses a bounded wheel-event sequence');
    A.eq(wheels.reduce((n, m) => n + m.params.deltaY, 0), 240, 'wheel steps preserve the requested total distance');
    FakeWS.last.fire('message', { data: JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'popup-session', targetInfo: { type: 'page', targetId: 'popup-target' } } }) });
    // Adoption is a multi-hop promise chain (inject shim, inject settle marker, record, resume).
    await new Promise(resolve => setTimeout(resolve, 60));
    // A popup is now ADOPTED rather than killed: a target=_blank checkout, a PDF that opens beside the
    // page, or an SSO popup used to be Target.closeTarget'd while paused, which read to the agent as
    // "the link did nothing". The reason for closing was real - a new page target does not inherit a
    // target-scoped preload - so adoption installs the SAME shim before resuming, exactly like the
    // iframe path, and closes the target if that injection ever fails.
    const popupShim = sent.filter(m => m.sessionId === 'popup-session' && m.method === 'Page.addScriptToEvaluateOnNewDocument');
    A.ok(popupShim.some(m => /requestPointerLock/.test(m.params.source)), 'an adopted popup gets the input-isolation shim');
    const resumeAt = sent.findIndex(m => m.sessionId === 'popup-session' && m.method === 'Runtime.runIfWaitingForDebugger');
    const shimAt = sent.findIndex(m => m.sessionId === 'popup-session' && m.method === 'Page.addScriptToEvaluateOnNewDocument');
    A.ok(shimAt >= 0 && resumeAt > shimAt, 'the shim is installed BEFORE the popup is allowed to run');
    A.ok(!sent.some(m => m.method === 'Target.closeTarget' && m.params.targetId === 'popup-target'), 'a successfully shimmed popup is kept, not killed');
    await d.close();

    // ATTENDED LOGIN uses a human-driven window with synthetic isolation disabled. In that mode
    // no Target auto-attach runs, so there is no adopted page session on a browser-level websocket.
    // Page.* must therefore use the page websocket from /json/list; an unscoped Page.enable on the
    // browser endpoint is a protocol error and used to make the visible login window never open.
    {
      const attendedFetched = [], attendedSent = [];
      let attendedUrl = 'about:blank', attendedClose = null;
      const attendedProc = {
        pid: 45,
        on(ev, fn) { if (ev === 'close') attendedClose = fn; },
        kill() { if (attendedClose) queueMicrotask(() => attendedClose(0)); }
      };
      class AttendedWS {
        constructor(url) { this.url = url; this.handlers = {}; setTimeout(() => this.fire('open', {}), 0); }
        addEventListener(name, fn) { (this.handlers[name] = this.handlers[name] || []).push(fn); }
        fire(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
        send(raw) {
          const m = JSON.parse(raw); attendedSent.push(m);
          if (this.url === 'ws://attended-browser' && !m.sessionId && /^Page\./.test(m.method)) {
            setTimeout(() => {
              this.fire('message', { data: JSON.stringify({ id: m.id, error: { code: -32601, message: "'" + m.method + "' wasn't found" } }) });
              if (attendedClose) attendedClose(1);
            }, 0);
            return;
          }
          if (m.method === 'Page.navigate') attendedUrl = m.params.url;
          let result = {};
          if (m.method === 'Runtime.evaluate') {
            const expr = String(m.params && m.params.expression || '');
            const value = expr === 'location.href' ? attendedUrl
              : (/ready:document\.readyState/.test(expr) ? { ok: true, ready: 'complete', n: 0 } : undefined);
            result = { result: { value } };
          } else if (m.method === 'Page.getFrameTree') {
            result = { frameTree: { frame: { id: 'attended-main' } } };
          } else if (m.method === 'Page.navigate') {
            result = { frameId: 'attended-main' };
          }
          setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        }
        close() {}
      }
      const attended = T.makeCdpDriver({
        chrome: 'fake-chrome.exe', headed: true, forceHeadless: false, syntheticInputOnly: false,
        timeoutMs: 1000, cdpPort: 9349, settleQuietPolls: 1, settleNavBudgetMs: 300, settleActionBudgetMs: 300, settleMinObserveMs: 0,
        fetchImpl: async url => {
          attendedFetched.push(url);
          return { json: async () => url.endsWith('/json/version')
            ? { webSocketDebuggerUrl: 'ws://attended-browser' }
            : [{ type: 'page', webSocketDebuggerUrl: 'ws://attended-page' }] };
        },
        WebSocketImpl: AttendedWS,
        spawn: () => attendedProc
      });
      const attendedFinal = await attended.navigate('http://127.0.0.1:5173/');
      A.eq(attendedFinal, 'http://127.0.0.1:5173/', 'human-driven attended login navigates through a page endpoint');
      A.ok(attendedFetched.some(u => /\/json\/list$/.test(u)), 'attended login discovers the page websocket through /json/list');
      A.ok(!attendedFetched.some(u => /\/json\/version$/.test(u)), 'attended login never selects the browser websocket without target adoption');
      A.ok(!attendedSent.some(m => m.method === 'Target.setAutoAttach'), 'human-driven attended login does not arm synthetic target adoption');
      await attended.close();
    }

    isolationReady = false; currentUrl = 'about:blank'; sent.length = 0;
    const refused = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9348,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://fake-refused' }] }),
      WebSocketImpl: FakeWS,
      spawn: () => fakeProc(43)
    });
    await rejects(refused.navigate('http://127.0.0.1:5173/'), /isolation failed to install.*simulated bootstrap refusal/i, 'navigation fails closed before input when the lock shim is not proven');
    A.ok(sent.some(m => m.method === 'Page.navigate' && m.params.url === 'about:blank'), 'failed isolation navigates away from the unshimmed page');
    await refused.close();

    const privateProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-cdp-owner-'));
    const fetched = [], privateLaunches = [];
    isolationReady = true; currentUrl = 'about:blank'; sent.length = 0;
    const privatePort = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000,
      cdpPort: 0, profileDir: privateProfile, browserVersion: '140.0.7339.12', locale: 'en-US', platform: 'win32',
      fetchImpl: async url => { fetched.push(url); return { json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://owned-private' }] }; },
      WebSocketImpl: FakeWS,
      spawn: (exe, args) => { privateLaunches.push(args); return fakeProc(44); }
    });
    await privatePort.navigate('http://127.0.0.1:5173/');
    // FINGERPRINT GUARD: production uses a private non-zero port so no other run can attach and port=0
    // cannot trigger AutomationControlled. The launch flag is separately locked below because real current
    // headless Chromium still exposed navigator.webdriver until that Blink feature was disabled explicitly.
    const portArg = privateLaunches[0].find(a => /^--remote-debugging-port=/.test(a));
    A.ok(portArg, 'production launch carries a private CDP port');
    const launchedPort = Number(String(portArg).split('=')[1]);
    A.ok(Number.isInteger(launchedPort) && launchedPort > 0 && launchedPort < 65536, 'the private CDP port is a real ephemeral port, never literal 0 (port 0 sets navigator.webdriver)');
    A.ok(launchedPort !== 9347, 'the private port is per-run, never the process-wide default another agent run could attach to');
    A.ok(fetched.some(u => u === 'http://127.0.0.1:' + launchedPort + '/json/list'), 'driver attaches only through the private port it allocated for this run');
    A.eq(privatePort.attachedPort(), launchedPort, 'driver reports the privately owned attached port');
    A.eq(privateLaunches[0].some(a => /^--user-agent=/.test(a)), false, 'launch flags do not create a legacy-UA / Client-Hints contradiction');
    A.eq(privateLaunches[0].includes('--disable-gpu'), false, 'owned Chrome does not force a software-renderer fingerprint');
    const uaOverride = sent.find(m => m.method === 'Emulation.setUserAgentOverride' && m.params && /Chrome\/140\.0\.7339\.12/.test(m.params.userAgent || ''));
    A.ok(!!uaOverride, 'the connected browser generation is installed through one CDP identity override');
    A.eq(uaOverride.params.userAgentMetadata.brands.some(b => /HeadlessChrome/.test(b.brand)), false, 'the CDP override removes HeadlessChrome from Client Hints too');
    A.ok(privateLaunches[0].includes('--lang=en-US'), 'private launch language matches the host locale');
    A.ok(privateLaunches[0].includes('--disable-blink-features=AutomationControlled'), 'private launch disables Chromium automation signaling');
    await privatePort.close();
    fs.rmSync(privateProfile, { recursive: true, force: true });
  }

  // ---- AUTO-WAIT: actions settle before they return ------------------------------------------
  // THE SILENT CORRUPTER this replaces: the whole wait vocabulary was three fixed sleeps, and
  // click/type/press returned with ZERO settle, so the next snapshot read the PRE-CLICK DOM and any
  // SPA hydrating past the blind 900ms answered an empty page ("no interactive elements").
  {
    // A fake page whose settle probe reports a scripted hydration timeline.
    function settleRig(script) {
      const state = { probes: 0, sent: [], url: 'about:blank' };
      class WS {
        constructor() { this.handlers = {}; WS.last = this; setTimeout(() => this.fire('open', {}), 0); }
        addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
        fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
        send(raw) {
          const m = JSON.parse(raw); state.sent.push(m);
          if (m.method === 'Page.navigate') state.url = m.params.url;
          const expr = String((m.params && m.params.expression) || '');
          let value = state.url;
          if (/return \{ready:/.test(expr)) value = { ready: true, error: null };          // isolation attestation
          else if (/document\.readyState/.test(expr)) {  // the settle probe
            value = script(state.probes++);
          }
          const result = m.method === 'Runtime.evaluate' ? { result: { value } } : {};
          setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        }
        close() {}
      }
      const driver = T.makeCdpDriver({
        chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9349,
        settleQuietPolls: 2, settleNavBudgetMs: 400, settleActionBudgetMs: 400, settleMinObserveMs: 0, settleEmptyGraceMs: 0,
        fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://settle' }] }),
        WebSocketImpl: WS,
        spawn: () => ({ pid: 51, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
      });
      return { driver, state };
    }

    // The settle marker itself must observe the DOM and survive a page that has no <html> yet.
    A.ok(/MutationObserver/.test(T.SETTLE_BOOTSTRAP), 'settle bootstrap observes DOM mutations');
    A.ok(/documentElement \? observe\(\) :/.test(T.SETTLE_BOOTSTRAP) || /documentElement/.test(T.SETTLE_BOOTSTRAP), 'settle bootstrap defers until a document root exists');
    A.ok(/document\.readyState/.test(T.SETTLE_PROBE) && /s\.n/.test(T.SETTLE_PROBE), 'settle probe reads readyState and the mutation counter');
    A.ok(!/Date\.now|performance\.now/.test(T.SETTLE_BOOTSTRAP), 'settle marker counts mutations rather than reading a clock (determinism law)');
    A.ok(/addScriptToEvaluateOnNewDocument/.test(T.makeCdpDriver.toString()), 'settle marker is reinstalled for every new document');

    // A. a page that hydrates late: navigate must NOT return on the first look.
    {
      const rig = settleRig(i => i < 3 ? { ok: true, ready: 'loading', n: i } : { ok: true, ready: 'complete', n: 99 });
      await rig.driver.navigate('http://127.0.0.1:5173/');
      A.ok(rig.state.probes >= 4, 'navigate keeps polling a hydrating page instead of a blind fixed sleep (probes=' + rig.state.probes + ')');
      await rig.driver.close();
    }

    // B. a static page settles on the FIRST quiet read — auto-wait is faster than the old 900ms sleep.
    {
      const rig = settleRig(() => ({ ok: true, ready: 'complete', n: 7 }));
      // Observe the requested delay, not OS scheduling latency on a busy test host.
      // This still catches a regression to the old unconditional 900ms sleep.
      const scheduled = [];
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (fn, ms, ...args) => {
        scheduled.push(ms);
        return originalSetTimeout(fn, ms, ...args);
      };
      try { await rig.driver.navigate('http://127.0.0.1:5173/'); }
      finally { global.setTimeout = originalSetTimeout; }
      A.ok(!scheduled.includes(900), 'an already-quiet page does not schedule the old 900ms blind wait');
      A.ok(rig.state.probes <= 4, 'a settled page costs only the quiet-confirmation polls (' + rig.state.probes + ')');
      await rig.driver.close();
    }

    // C. THE REGRESSION: click/type/press must settle. Previously they issued Input.* and returned.
    {
      const rig = settleRig(() => ({ ok: true, ready: 'complete', n: 0 }));
      await rig.driver.navigate('http://127.0.0.1:5173/');
      const before = rig.state.probes;
      await rig.driver.click({ x: 1, y: 1, w: 10, h: 10 });
      A.ok(rig.state.probes > before, 'click settles before returning');
      const afterClick = rig.state.probes;
      await rig.driver.press('Enter');
      A.ok(rig.state.probes > afterClick, 'press settles before returning');
      const afterPress = rig.state.probes;
      await rig.driver.scroll(0, 400);
      A.ok(rig.state.probes > afterPress, 'scroll settles (lazy-load/infinite-scroll content lands before the next snapshot)');
      await rig.driver.close();
    }

    // D. a page that NEVER goes quiet (a spinner, a poller) must still return at the budget.
    {
      let tick = 0;
      const rig = settleRig(() => ({ ok: true, ready: 'complete', n: tick++ }));
      const t0 = Date.now();
      await rig.driver.navigate('http://127.0.0.1:5173/');
      const ms = Date.now() - t0;
      A.ok(ms >= 350, 'a never-quiet page spends its settle budget');
      A.ok(ms < 3000, 'a never-quiet page still returns — auto-wait can never hang the run (' + ms + 'ms)');
      await rig.driver.close();
    }

    // D2. MINIMUM OBSERVATION WINDOW. Quiescence cannot see the future: a click handler that renders
    // from a setTimeout leaves the page genuinely still in the meantime. Watching for a minimum span
    // catches that, while staying adaptive - a slow page still waits far past the window.
    {
      const state = { probes: 0 };
      class WS2 {
        constructor() { this.handlers = {}; WS2.last = this; setTimeout(() => this.fire('open', {}), 0); }
        addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
        fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
        send(raw) {
          const m = JSON.parse(raw);
          const expr = String((m.params && m.params.expression) || '');
          let value = 'about:blank';
          if (/return \{ready:/.test(expr)) value = { ready: true, error: null };
          else if (/document\.readyState/.test(expr)) { state.probes++; value = { ok: true, ready: 'complete', n: 0 }; }
          const result = m.method === 'Runtime.evaluate' ? { result: { value } } : {};
          setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        }
        close() {}
      }
      const drv = T.makeCdpDriver({
        chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9352,
        settleQuietPolls: 1, settleNavBudgetMs: 5000, settleActionBudgetMs: 5000, settleMinObserveMs: 300, settleEmptyGraceMs: 0,
        fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://min' }] }),
        WebSocketImpl: WS2,
        spawn: () => ({ pid: 81, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
      });
      const t0 = Date.now();
      await drv.navigate('http://127.0.0.1:5173/');
      const ms = Date.now() - t0;
      A.ok(ms >= 280, 'a page that is quiet from the first poll is still observed for the minimum window (' + ms + 'ms)');
      A.ok(ms < 2000, 'and the minimum window does not become a long fixed sleep');
      await drv.close();
    }

    // E. no settle marker (a page that blocked the bootstrap) falls back to the legacy blind sleep
    // rather than skipping the wait entirely.
    {
      const rig = settleRig(() => 'http://127.0.0.1:5173/');   // a non-object answer = unmeasurable
      const t0 = Date.now();
      await rig.driver.navigate('http://127.0.0.1:5173/');
      A.ok(Date.now() - t0 >= 850, 'an unmeasurable page still gets the legacy 900ms settle');
      await rig.driver.close();
    }
  }

  // ---- THE REST OF THE TABLE-STAKES ACTION SET -----------------------------------------------
  // hover/select/drag/viewport/forward were all missing outright: menus that only open on hover were
  // unreachable, a native <select> cannot be driven by clicking (its popup is browser chrome, not
  // page content), and the viewport was pinned to the --window-size launch flag.
  {
    const d = fakeDriver();
    const X = makeBrowserTools({ driver: d });
    const tool = n => X.tools.find(t => t.name === n);
    const snap = await X.session.snapshot();
    const [btn, box] = snap;

    await tool('browser.hover').run({ ref: btn.ref }, {});
    A.eq(d.log.hovered, ['Search'], 'hover reaches the element by ref');

    await tool('browser.drag').run({ from: btn.ref, to: box.ref }, {});
    A.eq(d.log.dragged, [['Search', 'Query']], 'drag carries both endpoints');

    const sel = await tool('browser.select').run({ ref: box.ref, value: 'uk' }, {});
    A.ok(/Selected "UK"/.test(sel.content), 'select reports the chosen option by its label');
    const bad = await tool('browser.select').run({ ref: box.ref, value: 'nope' }, {});
    A.ok(/Could not select/.test(bad.content), 'a missing option is reported, not silently ignored');
    A.ok(/Available values: a, b/.test(bad.content), 'and the real options are offered back');

    const vp = await tool('browser.viewport').run({ width: 375, height: 812, mobile: true }, {});
    A.eq(d.log.viewports, [[375, 812, true]], 'viewport passes width/height/mobile to the driver');
    A.ok(/fresh browser\.snapshot/.test(vp.content), 'resizing tells the agent its refs are now stale');
    /* A resize RELAYS the page, so the old coordinates are dead. Recovery never reuses them — it takes a
       fresh snapshot and re-finds the element — so the click lands on the REFLOWED position instead of
       being refused outright. Being told to re-snapshot (asserted above) is still the honest advice; this
       is the safety net for the agent that acts on a ref it was already holding. */
    const afterResize = await X.session.click(btn.ref);
    A.ok(/had gone stale/.test(afterResize), 'a ref from before a resize is recovered against the reflowed page');

    const fwd = await tool('browser.forward').run({}, {});
    A.ok(/example\.com\/fwd/.test(fwd.content), 'forward completes the history pair with back');

    // Consent posture: reading/looking is free, mutating the page is gated.
    A.eq(tool('browser.hover').requiresConsent, false, 'hover is not consent-gated (it mutates nothing)');
    A.eq(tool('browser.viewport').requiresConsent, false, 'resizing the viewport is not consent-gated');
    A.eq(tool('browser.select').requiresConsent, true, 'select changes form state, so it is consent-gated');
    A.eq(tool('browser.drag').requiresConsent, true, 'drag is consent-gated');

    // A driver that predates these says so plainly rather than throwing a raw TypeError.
    const old = fakeDriver(); delete old.hover;
    await rejects(makeBrowserTools({ driver: old }).session.hover('b1'), /unknown browser ref|unavailable in this driver/, 'a driver without hover reports it honestly');
  }

  // ---- TABS: adopted page targets ------------------------------------------------------------
  // A target=_blank checkout, a PDF beside the page or an SSO popup used to be Target.closeTarget'd
  // while still paused, which read to the agent as "the link did nothing".
  {
    const sent = [];
    class WS3 {
      constructor() { this.handlers = {}; WS3.last = this; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
      fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
      emit(method, params) { this.fire('message', { data: JSON.stringify({ method, params }) }); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        const expr = String((m.params && m.params.expression) || '');
        let result = {};
        if (m.method === 'Runtime.evaluate') {
          let value = null;
          if (/return \{ready:/.test(expr)) value = { ready: true, error: null };
          else if (/document\.readyState/.test(expr)) value = { ok: true, ready: 'complete', n: 0 };
          else if (/location\.href, title/.test(expr)) value = m.sessionId ? { url: 'https://x.test/receipt', title: 'Receipt' } : { url: 'https://x.test/', title: 'Shop' };
          else if (/role="button"/.test(expr)) value = m.sessionId ? [{ index: 0, role: 'button', text: 'Print', x: 1, y: 1, w: 9, h: 9 }] : [{ index: 0, role: 'link', text: 'Open', x: 1, y: 1, w: 9, h: 9 }];
          else value = 'https://x.test/';
          result = { result: { value } };
        }
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9353,
      settleQuietPolls: 1, settleNavBudgetMs: 300, settleActionBudgetMs: 300, settleMinObserveMs: 0, settleEmptyGraceMs: 0,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://tabs' }] }),
      WebSocketImpl: WS3,
      spawn: () => ({ pid: 91, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
    });
    await d.navigate('https://x.test/');
    A.eq((await d.tabs()).length, 1, 'one tab before any popup');

    WS3.last.emit('Target.attachedToTarget', { sessionId: 'tab-2', targetInfo: { type: 'page', targetId: 'TARGET2' } });
    await new Promise(r => setTimeout(r, 60));
    const list = await d.tabs();
    A.eq(list.length, 2, 'an adopted page target becomes a second tab instead of being killed');
    A.eq(list[0].active, true, 'the ORIGINAL tab stays active — switching is never implicit');
    A.eq(list[1].url, 'https://x.test/receipt', 'the new tab reports its OWN url, read from its own session');

    // Page commands must follow the active tab, and ONLY on an explicit switch.
    const beforeSwitch = (await d.snapshot(10))[0];
    A.eq(beforeSwitch.text, 'Open', 'before switching, snapshot still reads tab 0');
    await d.selectTab(1);
    A.eq((await d.tabs())[1].active, true, 'tab_select moves the active target');
    A.eq((await d.snapshot(10))[0].text, 'Print', 'after switching, snapshot reads the SECOND tab');
    const sawSession = sent.filter(m => m.method === 'Runtime.evaluate' && /role="button"/.test(String(m.params.expression))).pop();
    A.eq(sawSession.sessionId, 'tab-2', 'page commands carry the active tab session');

    await d.selectTab(0);
    A.eq((await d.snapshot(10))[0].text, 'Open', 'switching back reads tab 0 again');
    const back = sent.filter(m => m.method === 'Runtime.evaluate' && /role="button"/.test(String(m.params.expression))).pop();
    A.ok(back.sessionId === undefined, 'tab 0 sends with NO session id (the original target)');

    let threw = false;
    try { await d.selectTab(9); } catch (_) { threw = true; }
    A.ok(threw, 'selecting a nonexistent tab is refused');
    try { threw = false; await d.closeTab(0); } catch (_) { threw = true; }
    A.ok(threw, 'the first tab cannot be closed');

    await d.closeTab(1);
    A.eq((await d.tabs()).length, 1, 'a closed tab leaves the list');
    A.ok(sent.some(m => m.method === 'Target.closeTarget' && m.params.targetId === 'TARGET2'), 'closing a tab closes its real target');

    // A tab that vanishes on its own must not strand the driver on a dead session.
    WS3.last.emit('Target.attachedToTarget', { sessionId: 'tab-3', targetInfo: { type: 'page', targetId: 'TARGET3' } });
    await new Promise(r => setTimeout(r, 60));
    await d.selectTab(1);
    WS3.last.emit('Target.detachedFromTarget', { sessionId: 'tab-3' });
    const after = await d.tabs();
    A.eq(after.length, 1, 'a detached tab drops out of the list');
    A.eq(after[0].active, true, 'and the driver falls back to the original tab rather than a dead session');
    await d.close();
  }

  // ---- PAGE EVAL IS GATED ON WHICH PROFILE IS LIVE ------------------------------------------
  // The loopback-only gate cost real capability (computed style, data-*, shadow DOM). Lifting it
  // outright is not safe either: browser.login puts REAL signed-in sessions in the persistent
  // profile, so arbitrary eval THERE plus web_request is an account-takeover primitive. The line is
  // not "eval is dangerous", it is "eval is dangerous where the credentials are".
  {
    const ephemeral = fakeDriver();
    ephemeral.evalPublic = async e => ({ ok: true, value: 'ran:' + e });
    ephemeral.usingPersistentProfile = () => false;
    const E = makeBrowserTools({ driver: ephemeral });
    const out = await E.tools.find(t => t.name === 'browser.eval').run({ expression: '1+1' }, {});
    A.ok(/ran:1\+1/.test(out.content), 'eval RUNS on the ephemeral profile — there are no credentials to steal there');

    const signedIn = fakeDriver();
    signedIn.evalPublic = async () => { throw new Error('should never reach the driver'); };
    signedIn.usingPersistentProfile = () => true;
    const S2 = makeBrowserTools({ driver: signedIn });
    await rejects(S2.tools.find(t => t.name === 'browser.eval').run({ expression: 'document.cookie' }, {}),
      /refused|signed-in station profile/i, 'eval is REFUSED while the signed-in station profile is live');
    await rejects(S2.session.evalPublic('document.cookie'), /cookies and storage/i,
      'and the refusal says WHY, and names the tools that do work there');

    A.eq(E.tools.find(t => t.name === 'browser.eval').requiresConsent, true, 'eval is consent-gated even when allowed');
    A.eq(E.tools.find(t => t.name === 'browser.inspect').requiresConsent, false, 'inspect is a read, so it is not consent-gated');

    // inspect must work REGARDLESS of profile - it is the whole point of having a bounded reader.
    const insp = fakeDriver();
    insp.usingPersistentProfile = () => true;
    insp.inspect = async () => ({ ok: true, tag: 'button', role: '', text: 'Buy', disabled: true, checked: null,
      box: { x: 1, y: 2, w: 3, h: 4 }, styles: { display: 'none' }, attrs: { id: 'buy' }, data: { sku: 'X1' },
      shadow: [{ tag: 'input', type: 'text', text: '' }] });
    const I = makeBrowserTools({ driver: insp });
    const ins = await I.tools.find(t => t.name === 'browser.inspect').run({ ref: (await I.session.snapshot())[0].ref }, {});
    A.ok(/display=none/.test(ins.content), 'inspect reports computed style — the concrete thing the eval gate cost');
    A.ok(/sku=X1/.test(ins.content), 'inspect reports data-* attributes');
    A.ok(/shadow DOM controls/.test(ins.content), 'inspect reaches into shadow DOM');
    A.ok(/DISABLED/.test(ins.content), 'inspect explains why a control will not respond');
  }

  // ---- IFRAME TRAVERSAL ----------------------------------------------------------------------
  // snapshot/get_text ran Runtime.evaluate with no session, so they never left the top frame:
  // an Auth0/Okta/Stripe login, a payment form or a consent wall was completely invisible.
  {
    const sent = [];
    let attachHook = null;
    class WS {
      constructor() { this.handlers = {}; WS.last = this; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
      fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
      emit(method, params) { this.fire('message', { data: JSON.stringify({ method, params }) }); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        const expr = String((m.params && m.params.expression) || '');
        let result = {};
        if (m.method === 'DOM.getFrameOwner') result = { backendNodeId: 77 };
        else if (m.method === 'DOM.getBoxModel') result = { model: { content: [100, 200, 400, 200, 400, 500, 100, 500] } };
        else if (m.method === 'Runtime.evaluate') {
          let value = 'about:blank';
          if (/return \{ready:/.test(expr)) value = { ready: true, error: null };
          else if (/document\.readyState/.test(expr)) value = { ok: true, ready: 'complete', n: 0 };
          else if (/const pick = doc/.test(expr)) value = m.sessionId ? 'Enter your card' : 'Top page';
          else if (/role="button"/.test(expr)) {
            // The TOP document answers one button; the iframe session answers a different one.
            value = m.sessionId
              ? [{ index: 0, role: 'textbox', text: 'Card number', x: 5, y: 10, w: 200, h: 30 }]
              : [{ index: 0, role: 'button', text: 'Checkout', x: 10, y: 20, w: 80, h: 30 }];
          }
          result = { result: { value } };
        }
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        if (m.method === 'Target.setAutoAttach' && attachHook) { const h = attachHook; attachHook = null; setTimeout(h, 1); }
      }
      close() {}
    }
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9351,
      settleQuietPolls: 1, settleNavBudgetMs: 300, settleActionBudgetMs: 300,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://frames' }] }),
      WebSocketImpl: WS,
      spawn: () => ({ pid: 71, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
    });
    // An out-of-process iframe attaches (as production Chrome does for a cross-origin frame).
    attachHook = () => WS.last.emit('Target.attachedToTarget', { sessionId: 'frame-1', targetInfo: { type: 'iframe', targetId: 'FRAME1' } });
    await d.navigate('https://shop.test/');
    await new Promise(r => setTimeout(r, 30));

    const nodes = await d.snapshot(40);
    A.eq(nodes.length, 2, 'snapshot returns the top document AND the iframe');
    A.eq(nodes[0].text, 'Checkout', 'top-frame element first');
    const inner = nodes[1];
    A.eq(inner.text, 'Card number', 'the iframe element is no longer invisible');
    // THE COORDINATE TRAP: the frame reports 5,10 relative to ITSELF; the iframe box starts at 100,200.
    A.eq([inner.x, inner.y], [105, 210], 'iframe coordinates are translated into the top page, so a click lands correctly');
    A.eq(inner.frame, 1, 'the element is marked as belonging to a frame');
    A.eq(nodes.map(n => n.index), [0, 1], 'indexes are renumbered across the merged set');

    const text = await d.getText();
    A.ok(/Top page/.test(text) && /Enter your card/.test(text), 'get_text reads the frame as well as the top document');
    A.ok(/--- frame 1 ---/.test(text), 'frame text is labelled rather than silently concatenated');
    A.ok(sent.some(m => m.method === 'Page.addScriptToEvaluateOnNewDocument' && m.sessionId === 'frame-1' && /MutationObserver/.test(m.params.source)), 'the settle marker is installed into adopted frames too');

    /* THE WEDGE GUARD. An out-of-process iframe has NO execution context while paused, so a
       Runtime.evaluate into it always fails ("Cannot find default execution context"). The old chain
       did exactly that, rejected, closed the target, and never resumed the frame — and a paused OOPIF
       blocks its PARENT's renderer, so every later eval on the top page timed out. Measured on trunk:
       ANY page with a cross-origin iframe hung browser.navigate for the full CDP timeout and threw.
       The frame must therefore be set up with preloads ONLY, and must always end up resumed. */
    const frameMsgs = sent.filter(m => m.sessionId === 'frame-1');
    const resumeIdx = frameMsgs.findIndex(m => m.method === 'Runtime.runIfWaitingForDebugger');
    A.ok(resumeIdx >= 0, 'an adopted frame is ALWAYS resumed — leaving it paused wedges the parent page');
    // Only the window BEFORE the resume is the paused window; snapshot/get_text legitimately
    // evaluate in the frame afterwards.
    const whilePaused = frameMsgs.slice(0, resumeIdx);
    A.ok(!whilePaused.some(m => m.method === 'Runtime.evaluate'),
      'a PAUSED iframe target is never Runtime.evaluate\'d — it has no execution context yet');
    A.ok(whilePaused.length > 0 && whilePaused.every(m => m.method === 'Page.addScriptToEvaluateOnNewDocument'),
      'only preloads precede the resume');

    // A popup is the MIRROR CASE: Page.* does not ack until resume, so its preload must be sent
    // without awaiting, while Runtime.evaluate (about:blank has a context) is the liveness check.
    const popMsgs = sent.filter(m => m.sessionId === 'popup-session');
    if (popMsgs.length) {
      const addAt = popMsgs.findIndex(m => m.method === 'Page.addScriptToEvaluateOnNewDocument');
      const runAt = popMsgs.findIndex(m => m.method === 'Runtime.runIfWaitingForDebugger');
      A.ok(addAt >= 0 && runAt > addAt, 'a popup preload is queued before its resume');
    }
    await d.close();
  }

  // ---- FILE UPLOAD, JAIL-CHECKED --------------------------------------------------------------
  // Without DOM.setFileInputFiles any form with an attachment step was a dead end. The path an
  // upload posts must come through the SAME jail as fs.* - an upload is an exfiltration primitive
  // if it can reach outside the agent's workspace.
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upload-'));
    try {
      const fsp = require('node:fs/promises');
      fs.mkdirSync(path.join(ws, 'ag'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'ag', 'resume.pdf'), 'PDF');
      fs.writeFileSync(path.join(ws, 'secret.txt'), 'not yours');   // OUTSIDE the agent's folder

      const d = fakeDriver();
      d.upload = async (node, abs) => { d.log.uploaded = [node.text, abs]; return abs.length + ' file(s) attached'; };
      const U = makeBrowserTools({ driver: d, fsp, pathMod: path, root: ws });
      const snap = await U.session.snapshot();
      const ref = snap[0].ref;
      const up = U.tools.find(t => t.name === 'browser.upload');

      const ok = await up.run({ ref, paths: ['resume.pdf'] }, { agentId: 'ag' });
      A.eq(d.log.uploaded[1], [path.join(ws, 'ag', 'resume.pdf')], 'the driver receives an ABSOLUTE path inside the agent workspace');
      A.ok(/Submit the form when ready/.test(ok.content), 'the agent is told attaching is not submitting');

      await rejects(up.run({ ref, paths: ['../secret.txt'] }, { agentId: 'ag' }), /illegal path|escapes workspace/i, 'a path escaping the workspace is refused');
      await rejects(up.run({ ref, paths: [path.join(ws, 'secret.txt')] }, { agentId: 'ag' }), /illegal path/i, 'an absolute path outside the jail is refused');
      await rejects(up.run({ ref, paths: ['nope.txt'] }, { agentId: 'ag' }), /ENOENT|not found/i, 'a missing file fails loudly here, not silently inside the page');
      A.eq(d.log.uploaded[1], [path.join(ws, 'ag', 'resume.pdf')], 'no refused upload ever reached the driver');
      A.eq(up.requiresConsent, true, 'upload is consent-gated');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // AGENT INPUT NEVER BECOMES PAGE CODE: browser.select embeds the requested value as a string
  // literal in a fixed expression, so a crafted value cannot compose script.
  {
    A.eq(T.jsLiteral('plain'), '"plain"', 'a plain value is a plain literal');
    A.eq(T.jsLiteral('a"b'), '"a\\"b"', 'quotes are escaped');
    // The property that matters: whatever the agent supplies, evaluating the literal yields the SAME
    // STRING BACK — it is data, never code. eval here is the point of the assertion.
    for (const evil of ['"}); alert(1); (() => ({a: "', '\\"; globalThis.pwned = 1; //', '</script>', '\n\r\t']) {
      A.eq(eval(T.jsLiteral(evil)), evil, 'break-out attempt round-trips as data: ' + JSON.stringify(evil));
    }
    const ls = T.jsLiteral('x' + String.fromCharCode(0x2028) + 'y');
    A.ok(ls.indexOf('\\u2028') > 0, 'U+2028 is escaped (legal in JSON, a line terminator in older JS)');
    A.ok(ls.indexOf(String.fromCharCode(0x2028)) < 0, 'and the raw separator never reaches the page expression');
  }

  // ---- SCREENSHOTS ARE NO LONGER WRITE-ONLY --------------------------------------------------
  // screenshot() had exactly ONE consumer - vision() - which handed the base64 to a model and
  // returned a BYTE COUNT. The user could never see what the agent saw, and the frame was dropped.
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-shots-'));
    try {
      const fsp = require('node:fs/promises');
      const emitted = [];
      const ctx = { agentId: 'ag', room: 'lab', emit: (name, payload) => emitted.push([name, payload]) };
      const S = makeBrowserTools({ driver: fakeDriver(), fsp, pathMod: path, root: ws });

      const out = await S.tools.find(t => t.name === 'browser.screenshot').run({}, ctx);
      const rel = (out.content.match(/shots\/shot-[a-f0-9]+\.png/) || [])[0];
      A.ok(!!rel, 'screenshot reports the saved path');
      A.ok(fs.existsSync(path.join(ws, 'ag', rel)), 'the PNG is actually written into the agent workspace jail');
      A.eq(fs.readFileSync(path.join(ws, 'ag', rel)).toString(), 'png', 'the captured bytes are what got written');
      const deliv = emitted.find(e => e[0] === 'deliverable');
      A.ok(!!deliv, 'a deliverable event is emitted so the capture shows up in the station');
      A.eq(deliv[1].kind, 'image', 'the deliverable is an image');
      A.eq(deliv[1].agentId, 'ag', 'the deliverable is attributed to the capturing agent');
      A.eq(deliv[1].room, 'lab', 'the deliverable carries the room');
      A.ok(/\/api\/file\?agent=ag/.test(out.content), 'a viewer link is offered');

      // Content-addressed: the same viewport twice is ONE file, not a pile of near-duplicates.
      const again = await S.tools.find(t => t.name === 'browser.screenshot').run({}, ctx);
      A.eq((again.content.match(/shots\/shot-[a-f0-9]+\.png/) || [])[0], rel, 'an unchanged capture is idempotent (content-addressed)');

      // vision now PERSISTS the frame it analyzed, so the model's reading can be checked against pixels.
      const V = makeBrowserTools({ driver: fakeDriver(), fsp, pathMod: path, root: ws, vision: async () => 'a login form' });
      const vout = await V.tools.find(t => t.name === 'browser.vision').run({ question: 'what is this?' }, ctx);
      A.ok(/a login form/.test(vout.content), 'vision still answers the question');
      A.ok(/Screenshot saved to shots\//.test(vout.content), 'vision saves the frame it analyzed instead of dropping it');

      // No workspace wired: say so honestly rather than naming a file that does not exist.
      const N = makeBrowserTools({ driver: fakeDriver() });
      const nout = await N.tools.find(t => t.name === 'browser.screenshot').run({}, ctx);
      A.ok(/no workspace to save into/.test(nout.content), 'a run without a workspace admits the image was discarded');
      A.ok(!/shots\//.test(nout.content), 'and never invents a saved path');
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  }

  // ---- NETWORK TRUTH: the agent is told the main document's real HTTP status ------------------
  // Before this, navigate() returned only location.href, so a 403, a 404 and a page that rendered
  // nothing were indistinguishable — the agent read the error page and reported it as the answer.
  {
    A.eq(T.describeResponse(null), { text: '', summary: '' }, 'a driver that cannot observe the network claims nothing');
    A.eq(T.describeResponse({ status: 200 }).text, ' (HTTP 200)', 'a 2xx is reported plainly');
    A.ok(/HTTP 403/.test(T.describeResponse({ status: 403, statusText: 'Forbidden' }).text), 'a 403 is surfaced');
    A.ok(/error response, not the content/.test(T.describeResponse({ status: 404 }).text), 'a non-2xx warns that the body is an error page');
    A.ok(/REQUEST FAILED/.test(T.describeResponse({ status: 0, failure: 'net::ERR_NAME_NOT_RESOLVED' }).text), 'a transport failure is distinguished from an HTTP status');

    // Fake CDP that emits Network events for the page it "loads".
    function netRig(events) {
      const state = { sent: [], url: 'about:blank' };
      class WS {
        constructor() { this.handlers = {}; WS.last = this; setTimeout(() => this.fire('open', {}), 0); }
        addEventListener(n, fn) { (this.handlers[n] = this.handlers[n] || []).push(fn); }
        fire(n, v) { for (const fn of this.handlers[n] || []) fn(v); }
        emit(method, params) { this.fire('message', { data: JSON.stringify({ method, params }) }); }
        send(raw) {
          const m = JSON.parse(raw); state.sent.push(m);
          const expr = String((m.params && m.params.expression) || '');
          let result = {};
          if (m.method === 'Page.getFrameTree') result = { frameTree: { frame: { id: 'MAIN' } } };
          else if (m.method === 'Runtime.evaluate') {
            let value = state.url;
            if (/return \{ready:/.test(expr)) value = { ready: true, error: null };
            else if (/document\.readyState/.test(expr)) value = { ok: true, ready: 'complete', n: 0 };
            result = { result: { value } };
          }
          if (m.method === 'Page.navigate') { state.url = m.params.url; for (const e of events) this.emit(e[0], e[1]); }
          setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
        }
        close() {}
      }
      const driver = T.makeCdpDriver({
        chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: true, timeoutMs: 1000, cdpPort: 9350,
        settleQuietPolls: 1, settleNavBudgetMs: 300, settleActionBudgetMs: 300, settleMinObserveMs: 0, settleEmptyGraceMs: 0,
        fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://net' }] }),
        WebSocketImpl: WS,
        spawn: () => ({ pid: 61, on(ev, fn) { if (ev === 'close') this._c = fn; }, kill() { if (this._c) queueMicrotask(() => this._c(0)); } })
      });
      return { driver, state };
    }

    // A. a 403 main document is captured and reported.
    {
      const rig = netRig([['Network.responseReceived', { type: 'Document', frameId: 'MAIN', response: { status: 403, statusText: 'Forbidden', url: 'https://x.test/' } }]]);
      await rig.driver.navigate('https://x.test/');
      A.eq(rig.driver.lastResponse().status, 403, 'main-document 403 captured from the Network domain');
      await rig.driver.close();
    }

    // B. THE SUB-FRAME TRAP: an ad/iframe 404 must never read as the page's own status.
    {
      const rig = netRig([
        ['Network.responseReceived', { type: 'Document', frameId: 'MAIN', response: { status: 200, statusText: 'OK', url: 'https://x.test/' } }],
        ['Network.responseReceived', { type: 'Document', frameId: 'IFRAME', response: { status: 404, statusText: 'Not Found', url: 'https://ads.test/' } }]
      ]);
      await rig.driver.navigate('https://x.test/');
      A.eq(rig.driver.lastResponse().status, 200, 'a sub-frame document response never overwrites the top frame status');
      await rig.driver.close();
    }

    // C. a transport failure (DNS/refused/cert) produces no response at all.
    {
      const rig = netRig([['Network.loadingFailed', { requestId: 'r1', type: 'Document', errorText: 'net::ERR_NAME_NOT_RESOLVED' }]]);
      await rig.driver.navigate('https://nope.test/');
      A.eq(rig.driver.lastResponse().failure, 'net::ERR_NAME_NOT_RESOLVED', 'transport failure recorded');
      A.eq(rig.driver.lastResponse().status, 0, 'a failed request has no HTTP status');
      await rig.driver.close();
    }

    // D. status must not leak from the previous page.
    {
      const rig = netRig([['Network.responseReceived', { type: 'Document', frameId: 'MAIN', response: { status: 500, statusText: 'Server Error', url: 'https://x.test/' } }]]);
      await rig.driver.navigate('https://x.test/');
      A.eq(rig.driver.lastResponse().status, 500, 'first navigation records its status');
      rig.state.sent.length = 0;
      const quiet = netRig([]);                       // a second navigation that emits nothing
      await quiet.driver.navigate('https://y.test/');
      A.eq(quiet.driver.lastResponse(), null, 'a navigation with no observed response reports NOTHING rather than a stale status');
      await rig.driver.close(); await quiet.driver.close();
    }

    // E. the tool text the agent actually reads carries the status.
    {
      const statusDriver = fakeDriver();
      statusDriver.lastResponse = () => ({ status: 403, statusText: 'Forbidden', failure: null });
      const B403 = makeBrowserTools({ driver: statusDriver });
      const out = await B403.tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
      A.ok(/HTTP 403/.test(out.content), 'browser.navigate tells the agent the page was a 403');
      A.ok(/error response, not the content/.test(out.content), 'and warns that the body is the error page');
      // A driver with no network visibility must not invent a status.
      const plain = await makeBrowserTools({ driver: fakeDriver() }).tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com' }, {});
      A.ok(!/HTTP/.test(plain.content), 'a driver without network visibility claims no status (truthful telemetry)');
    }

    // F. a verification interstitial is a distinct outcome, never page content.
    {
      const wallDriver = fakeDriver();
      wallDriver.challengeStatus = async () => ({ challenged: true, signal: 'title', title: 'Just a moment...' });
      wallDriver.lastResponse = () => ({ status: 200, statusText: 'OK', failure: null });
      const wall = makeBrowserTools({ driver: wallDriver });
      const nav = await wall.tools.find(t => t.name === 'browser.navigate').run({ url: 'https://example.com/challenge' }, {});
      A.ok(/^verification wall(?: 200)?$/.test(nav.summary), 'browser.navigate reports a challenge as its own outcome');
      A.ok(/not page content/i.test(nav.content), 'navigation refuses to treat a challenge as content');
      A.ok(/browser\.attach/.test(nav.content) && /browser\.login/.test(nav.content), 'navigation gives the honest attended escalation paths');
      const text = await wall.tools.find(t => t.name === 'browser.get_text').run({}, {});
      A.eq(text.summary, 'verification wall', 'browser.get_text preserves the same challenge outcome');
      A.ok(!/Example page text/.test(text.content), 'browser.get_text never returns the challenge body as readable content');
    }
  }

  // ---- ATTENDED BROWSER LOGIN (browser.login): human-driven headed takeover on the persistent
  //      station profile, bracketed by two live consent asks; unattended runs refuse. ----
  {
    const mkLease = () => {
      const l = { acquired: 0, released: 0, ok: true };
      l.profile = { dir: '/station-profile', acquire: () => { if (!l.ok) return false; l.acquired++; return true; }, release: () => { l.released++; } };
      return l;
    };
    const mkSeam = () => {
      const made = [];
      const makeDriver = (d) => {
        const drv = fakeDriver();
        drv.headed = !!d.headed; drv.profileDir = d.profileDir; drv.cleanupProfile = d.cleanupProfile;
        drv.synthetic = d.syntheticInputOnly; drv.visible = () => !!d.headed; drv.close = () => { drv.closed = true; };
        made.push(drv); return drv;
      };
      return { made, makeDriver };
    };

    // 1. UNATTENDED RUNS REFUSE: no attendedLogin dep (cron/hub/night-shift) -> honest error, no window.
    {
      const seam = mkSeam();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {}),
        /watched COMMS session|unattended/i, 'browser.login refuses without the attended channel');
      A.eq(seam.made.length, 0, 'an unattended login attempt never launches any browser');
    }

    // 2. ENV-PINNED HEADLESS REFUSES before any consent ask or window.
    {
      const seam = mkSeam();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, env: { STARNET_BROWSER_HEADLESS: '1' }, attendedLogin: { prompt: async () => 'once' } });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {}),
        /pins the browser headless/i, 'env headless pin refuses a login window');
      A.eq(seam.made.length, 0, 'env-pinned headless never launches a headed browser');
    }

    // 3. URL guard applies BEFORE any prompt: private hosts never reach the Commander.
    {
      let prompts = 0;
      const seam = mkSeam();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, attendedLogin: { prompt: async () => { prompts++; return 'once'; } } });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'http://192.168.0.5/router' }, {}),
        /private\/loopback\/intranet/i, 'login URL rides the same SSRF guard as navigate');
      A.eq(prompts, 0, 'a refused URL never generates a consent ask');
    }

    // 4. COMMANDER DECLINES: no window, honest content back to the model.
    {
      const seam = mkSeam();
      const asked = [];
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, attendedLogin: { prompt: async f => { asked.push(f.tool); return 'deny'; } } });
      const out = await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {});
      A.eq(asked, ['browser.login'], 'a declined open ask never proceeds to the done-wait');
      A.ok(/declined/i.test(out.content), 'declined login reports honestly');
      A.eq(seam.made.length, 0, 'declined login never launches a browser');
    }

    // 5. FULL APPROVED FLOW: headed relaunch on the persistent profile with shims OFF, done-wait,
    //    then headless restore with shims back ON — same profile, refs invalidated, lease held.
    {
      const seam = mkSeam();
      const lease = mkLease();
      const asked = [];
      const B2 = makeBrowserTools({
        makeDriver: seam.makeDriver, forceHeadless: true, syntheticInputOnly: true,
        persistentProfile: lease.profile,
        attendedLogin: { prompt: async f => { asked.push({ tool: f.tool, host: f.argsSummary }); return 'once'; } }
      });
      const out = await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {});
      A.eq(asked.map(a => a.tool), ['browser.login', 'browser.login.done'], 'both consent phases ride the live channel in order');
      A.eq(asked[0].host, 'erank.com', 'the consent ask names the host, not the full URL');
      A.eq(seam.made.length, 2, 'login = one headed launch + one headless restore');
      A.eq(seam.made[0].headed, true, 'the login window is headed');
      A.eq(seam.made[0].synthetic, false, 'the human-driven window carries NO synthetic-input shims (SSO popups must work)');
      A.eq(seam.made[0].profileDir, '/station-profile', 'the login window uses the persistent station profile');
      A.eq(seam.made[0].cleanupProfile, false, 'the persistent profile is never marked for cleanup');
      A.eq(seam.made[0].closed, true, 'the headed window is torn down after Done');
      A.eq(seam.made[1].headed, false, 'after Done the browser is headless again');
      A.eq(seam.made[1].profileDir, '/station-profile', 'the restored headless browser keeps the authenticated profile');
      A.ok(/finished logging in/i.test(out.content), 'completed login reports honestly');
      A.ok(lease.acquired >= 1 && lease.released === 0, 'the profile lease is held for the rest of the run');
      await B2.session.close();
      A.ok(lease.released >= 1, 'session close releases the profile lease');
    }

    // 6. SAME-PROFILE RELAUNCH: wait for asynchronous teardown before constructing the replacement.
    {
      let closeSettled = true;
      const made = [];
      const B2 = makeBrowserTools({
        persistentProfile: mkLease().profile,
        attendedLogin: { prompt: async () => 'once' },
        makeDriver: (d) => {
          const drv = fakeDriver();
          drv.headed = !!d.headed;
          drv.visible = () => !!d.headed;
          drv.createdBeforePriorClose = !closeSettled;
          drv.close = async () => {
            closeSettled = false;
            await new Promise(resolve => setTimeout(resolve, 20));
            closeSettled = true;
          };
          made.push(drv);
          return drv;
        }
      });
      await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {});
      A.eq(made.length, 2, 'login still relaunches headed then headless');
      A.eq(made[1].createdBeforePriorClose, false,
        'the replacement browser is not constructed until the prior same-profile driver closes');
      await B2.session.close();
    }

    // A rejected teardown means the prior browser may still own the profile. Refuse the replacement and
    // surface the failure instead of reporting a successful login with two same-profile drivers alive.
    {
      const made = [];
      const B2 = makeBrowserTools({
        persistentProfile: mkLease().profile,
        attendedLogin: { prompt: async () => 'once' },
        makeDriver: (d) => {
          const drv = fakeDriver();
          drv.headed = !!d.headed;
          drv.visible = () => !!d.headed;
          drv.close = async () => { throw new Error('profile teardown failed'); };
          made.push(drv);
          return drv;
        }
      });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com/login' }, {}),
        /profile teardown failed/i, 'a failed same-profile teardown is surfaced to the caller');
      A.eq(made.length, 1, 'a failed teardown never constructs a replacement against the still-live profile');
      await rejects(B2.session.navigate('https://example.com'), /profile teardown failed/i,
        'the next mode-less browser action fails closed instead of reusing the headed unshimmed driver');
      A.eq(made.length, 1, 'the next mode-less action also cannot spawn a replacement against the uncertain profile');
    }

    // 7. LEASE CONTENTION: another run holds the profile -> honest error, no window.
    {
      const seam = mkSeam();
      const lease = mkLease(); lease.ok = false;
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, persistentProfile: lease.profile, attendedLogin: { prompt: async () => 'once' } });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {}),
        /in use by another agent run/i, 'a held profile lease refuses the login honestly');
      A.eq(seam.made.length, 0, 'lease contention never opens a window');
    }

    // 8. HEADLESS-ONLY BINARY: window impossible -> restore headless posture, honest error.
    {
      const made = [];
      const B2 = makeBrowserTools({
        makeDriver: (d) => { const drv = fakeDriver(); drv.headed = !!d.headed; drv.visible = () => false; drv.close = () => {}; made.push(drv); return drv; },
        attendedLogin: { prompt: async () => 'once' }
      });
      await rejects(B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {}),
        /visible login window is impossible/i, 'a headless-only binary reports the truth instead of pretending a window exists');
      A.eq(made.length, 2 , 'the failed headed attempt is restored to headless');
      A.eq(made[1].headed, false, 'restore after headless-only failure is headless');
    }

    // 9. DONE-WAIT CANCELLED: window closes, honest "unconfirmed" content (cookies may exist).
    {
      const seam = mkSeam();
      let n = 0;
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, persistentProfile: mkLease().profile, attendedLogin: { prompt: async () => (++n === 1 ? 'once' : 'deny') } });
      const out = await B2.tools.find(t => t.name === 'browser.login').run({ url: 'https://erank.com' }, {});
      A.ok(/without a Done confirmation/i.test(out.content), 'a cancelled done-wait reports unconfirmed honestly');
      A.eq(seam.made[seam.made.length - 1].headed, false, 'cancelled login still restores headless mode');
    }

    // 10. ORDINARY RESEARCH RUNS reuse the persistent profile when free (signed-in browsing), and
    //    fall back to the ephemeral per-run profile when another run holds the lease.
    {
      const seam = mkSeam();
      const lease = mkLease();
      const B2 = makeBrowserTools({ makeDriver: seam.makeDriver, forceHeadless: true, profileDir: '/ephemeral', persistentProfile: lease.profile });
      await B2.session.navigate('https://example.com');
      A.eq(seam.made[0].profileDir, '/station-profile', 'a plain research run browses on the station profile (saved logins apply)');
      A.eq(seam.made[0].headed, false, 'the persistent profile never changes the headless posture');
      A.eq(seam.made[0].cleanupProfile, false, 'the persistent profile is not cleaned up by a research run');

      const seam2 = mkSeam();
      const held = mkLease(); held.ok = false;
      const B3 = makeBrowserTools({ makeDriver: seam2.makeDriver, forceHeadless: true, profileDir: '/ephemeral', persistentProfile: held.profile });
        await rejects(B3.session.navigate('https://example.com'), /in use by another agent run/, 'a held lease cannot silently replace saved logins');
        A.eq(seam2.made.length, 0, 'contention does not launch an unsigned browser');
    }

    // 11. browser.login carries a long tool timeout (it wraps two human-paced consent waits).
    {
      const B2 = makeBrowserTools({ driver: fakeDriver() });
      const t = B2.tools.find(x => x.name === 'browser.login');
      A.ok(t.timeoutMs >= 30 * 60 * 1000, 'login tool timeout outlives the fail-closed consent timers');
      A.eq(t.requiresConsent, false, 'login runs its OWN two-phase consent (no double prompt)');
      A.eq(t.capability, 'web', 'login rides the web capability (dish object), no new grant surface');
    }
  }

  /* ---- a STALLED navigation must not poison the session (2026-07-25, from a real user report) ----
     Page.navigate does not resolve until the navigation commits, so a slow or challenge-walled origin blew
     the 15s command budget and threw "CDP timeout: Page.navigate". Nothing cancelled the load, so the
     renderer stayed busy and the NEXT tool call (browser.snapshot's Runtime.evaluate) queued behind it and
     timed out too — the user saw both fail and read it as "the browser is broken". */
  {
    // The CDP client unrefs its timeout timers, so while awaiting a deliberately-stalled navigation there
    // is nothing left holding the event loop open and node would EXIT mid-test with code 0 — scoring green
    // having verified nothing. (_assert.js now catches that, but the cure is to hold the loop open.)
    const keepAlive = setInterval(() => {}, 50);
    const sent = [];
    let currentUrl = 'about:blank';
    let stall = true;
    class StallWS {
      constructor() { this.h = {}; setTimeout(() => this.fire('open', {}), 0); }
      addEventListener(n, f) { (this.h[n] = this.h[n] || []).push(f); }
      fire(n, v) { for (const f of this.h[n] || []) f(v); }
      send(raw) {
        const m = JSON.parse(raw); sent.push(m);
        if (m.method === 'Page.navigate') { currentUrl = m.params.url; if (stall) return; }   // never answers
        const value = m.method === 'Runtime.evaluate' ? currentUrl : undefined;
        const result = m.method === 'Runtime.evaluate' ? { result: { value } } : {};
        setTimeout(() => this.fire('message', { data: JSON.stringify({ id: m.id, result }) }), 0);
      }
      close() {}
    }
    const d = T.makeCdpDriver({
      chrome: 'fake-chrome.exe', forceHeadless: true, syntheticInputOnly: false,
      timeoutMs: 400, navTimeoutMs: 800, cdpPort: 9361,
      fetchImpl: async () => ({ json: async () => [{ type: 'page', webSocketDebuggerUrl: 'ws://stall' }] }),
      WebSocketImpl: StallWS,
      // kill() must actually signal 'close', or session.close() rightly refuses to believe Chromium exited.
      spawn: () => { let onClose = null; return { pid: 7, on(ev, fn) { if (ev === 'close') onClose = fn; }, kill() { if (onClose) queueMicrotask(() => onClose(0)); } }; }
    });

    let navErr = null;
    try { await d.navigate('https://slow.example.com/listing/1'); } catch (e) { navErr = e; }
    A.ok(!!navErr, 'a stalled navigation still fails rather than hanging forever');
    A.ok(!/CDP timeout/.test(navErr.message), 'the raw "CDP timeout: Page.navigate" no longer reaches the agent');
    A.ok(/did not finish loading/.test(navErr.message), 'the error says what actually happened');
    A.ok(/slow\.example\.com/.test(navErr.message), 'the error names the host that stalled');
    A.ok(/web_request|get_text/.test(navErr.message), 'the error offers a next move');
    A.ok(sent.some(m => m.method === 'Page.stopLoading'), 'THE FIX: the stalled load is cancelled so the renderer is freed');

    // the session must be usable immediately afterwards — this is the half the user actually lost
    const after = await d.snapshot(5);
    A.ok(after !== undefined, 'the NEXT call succeeds instead of inheriting the wedge');
    stall = false;
    A.eq(await d.navigate('https://example.com/'), 'https://example.com/', 'a later healthy navigation still works');
    await d.close();
    clearInterval(keepAlive);
  }

  /* The driver's navigation budget must stay UNDER browser.navigate's tool budget. If the outer tool
     timeout fired first it would abort run() mid-flight and the stopLoading recovery above would never
     happen — re-creating the exact wedge. Locked here because the two numbers live in different places. */
  {
    const navTool = makeBrowserTools({ existsSync: () => false, WebSocketImpl: null }).tools
      .find(t => t.name === 'browser.navigate');
    A.ok(navTool.timeoutMs >= 45000, 'browser.navigate gets a larger tool budget than other browser tools');
    const others = makeBrowserTools({ existsSync: () => false, WebSocketImpl: null }).tools
      .filter(t => t.name !== 'browser.navigate' && t.name !== 'browser.login');
    A.ok(others.every(t => t.timeoutMs < navTool.timeoutMs), 'and it is the longest of the ordinary browser tools');
  }

  /* ---- SSRF parity with web_fetch. browser.navigate RUNS the page's scripts, so its guard must not be the
     weaker of the two. Two holes, both closed: a trailing-dot FQDN walked past every NAME rule (WHATWG only
     strips the root label for IP literals), and there was no DNS-rebinding check at all. ---- */
  {
    const { assertSafeUrl, assertResolvedSafe } = require('../sidecar/tools/builtin/browser.js')._internals;
    const blocked = ['http://localhost./', 'http://myapp.local./', 'http://svc.internal./',
      'http://router.lan./', 'http://intranet.corp./', 'http://wiki./', 'http://box.home./'];
    for (const u of blocked) {
      let threw = false;
      try { assertSafeUrl(u); } catch (e) { threw = true; }
      A.ok(threw, 'trailing-dot FQDN is refused: ' + u);
    }
    A.eq(assertSafeUrl('http://example.com./').hostname, 'example.com.', 'a public name with a root label still resolves normally');

    const priv = async (addr) => {
      let threw = false;
      try { await assertResolvedSafe(new URL('http://public-name.example/'), async () => [{ address: addr }]); }
      catch (e) { threw = true; }
      return threw;
    };
    A.ok(await priv('127.0.0.1'), 'a public NAME resolving to loopback is refused (DNS rebinding)');
    A.ok(await priv('192.168.1.10'), 'a public NAME resolving to RFC-1918 is refused');
    A.ok(!(await priv('93.184.216.34')), 'a genuinely public address is allowed through');
    let noLookup = true;
    try { await assertResolvedSafe(new URL('http://public-name.example/'), null); } catch (e) { noLookup = false; }
    A.ok(noLookup, 'with no resolver wired the guard is inert (rigs/tests keep the old behaviour)');
  }

  A.report('browser.test');
})();
