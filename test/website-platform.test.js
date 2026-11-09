/* node test/website-platform.test.js — the download page names a Mac's chip only when the browser really says it.
 *
 * Customer report 2026-11-08: an Intel Mac owner got macOS's "not supported on this type of Mac". site.js had returned
 * 'mac-arm' for EVERY Mac (every Mac browser says "Intel Mac OS X" and "MacIntel", Apple Silicon included, so the old
 * code guessed the common case), and the page marked the Apple Silicon card DETECTED. website/platform.js now reads
 * the chip from User-Agent Client Hints (Chromium) or an unmasked WebGL renderer, and says "unknown" otherwise;
 * site.js then marks both Mac cards alike and shows the About This Mac check.
 */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const P = require('../website/platform.js');

const UA = {
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0',
  win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

// ---- osFamily
A.eq(P.osFamily(UA.win, 'Win32', 0), 'windows', 'Windows UA');
A.eq(P.osFamily('', 'Windows', 0), 'windows', 'Windows by userAgentData.platform');
A.eq(P.osFamily(UA.macSafari, 'MacIntel', 0), 'mac', 'Safari on a Mac (Apple Silicon says MacIntel too)');
A.eq(P.osFamily('', 'macOS', 0), 'mac', 'Mac by userAgentData.platform');
A.eq(P.osFamily(UA.macSafari, 'MacIntel', 5), null, 'an iPad asking for the desktop site is not a Mac (touch screen, no Mac build runs on it)');
A.eq(P.osFamily(UA.iphone, 'iPhone', 5), null, 'iPhone');
A.eq(P.osFamily(UA.linux, 'Linux x86_64', 0), null, 'Linux has no public build');
A.eq(P.osFamily(undefined, undefined, undefined), null, 'nothing known → null');

// ---- archFromHints (Chromium: getHighEntropyValues(['architecture']))
A.eq(P.archFromHints({ architecture: 'arm' }), 'arm', 'client hints arm');
A.eq(P.archFromHints({ architecture: 'x86' }), 'intel', 'client hints x86 → Intel Mac');
A.eq(P.archFromHints({ architecture: '' }), null, 'empty architecture names nothing');
A.eq(P.archFromHints({}), null, 'missing architecture');
A.eq(P.archFromHints(null), null, 'no hints');

// ---- archFromRenderer (unmasked WebGL renderer)
const R = {
  'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)': 'arm',
  'Apple M2': 'arm',
  'Apple M4 Max': 'arm',
  'Apple GPU': null,                                                              // Safari masks both kinds the same
  'Intel(R) Iris(TM) Plus Graphics 655': 'intel',
  'ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)': 'intel',
  'Intel HD Graphics 5000 OpenGL Engine': 'intel',                               // a 2014 MacBook Air
  'Intel Iris Pro OpenGL Engine': 'intel',
  'AMD Radeon Pro 5500M OpenGL Engine': 'intel',
  'ANGLE (ATI Technologies Inc., AMD Radeon Pro 560X OpenGL Engine, OpenGL 4.1)': 'intel',
  'NVIDIA GeForce GT 750M OpenGL Engine': 'intel',                               // a 2014 15" MacBook Pro
  'Google SwiftShader': null,
  '': null,
};
for (const [r, want] of Object.entries(R)) A.eq(P.archFromRenderer(r), want, 'renderer ' + JSON.stringify(r));
A.eq(P.archFromRenderer(undefined), null, 'no renderer');

// ---- pick
A.eq(P.pick('windows', null), 'windows', 'Windows card');
A.eq(P.pick('mac', 'arm'), 'mac-arm', 'Apple Silicon card');
A.eq(P.pick('mac', 'intel'), 'mac-intel', 'Intel card');
A.eq(P.pick('mac', null), 'mac-unknown', 'a Mac whose chip is unknown is never guessed');
A.eq(P.pick(null, 'arm'), null, 'no OS, no card');

// ---- detect: the browser glue, with stubbed navigator/document
function fakeDoc(renderer, opts = {}) {
  const made = { contexts: 0, lost: 0 };
  const doc = {
    made,
    createElement(tag) {
      A.eq(tag, 'canvas', 'detect only ever makes a canvas');
      return {
        width: 0, height: 0,
        getContext(kind, attrs) {
          if (opts.noWebgl) return null;
          made.contexts++;
          if (kind === 'webgl') A.eq(attrs && attrs.powerPreference, 'low-power', 'the probe asks for the low-power GPU (never wakes a discrete one)');
          return {
            getExtension(name) {
              if (name === 'WEBGL_debug_renderer_info') return opts.masked ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
              if (name === 'WEBGL_lose_context') return { loseContext() { made.lost++; } };
              return null;
            },
            getParameter(p) { return p === 0x9246 ? renderer : ''; },
          };
        },
      };
    },
  };
  return doc;
}
const chromeUad = (arch, opts = {}) => ({
  platform: 'macOS',
  getHighEntropyValues(keys) {
    A.ok(Array.isArray(keys) && keys.includes('architecture'), 'asks only for what it needs: architecture');
    if (opts.reject) return Promise.reject(new Error('denied'));
    if (opts.throws) throw new Error('boom');
    return Promise.resolve({ architecture: arch, platform: 'macOS' });
  },
});

(async () => {
  let r, d;
  r = await P.detect({ userAgent: UA.win, platform: 'Win32' }, fakeDoc(''));
  A.eq([r.os, r.card], ['windows', 'windows'], 'Windows → Windows card');

  d = fakeDoc('should not be read');
  r = await P.detect({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('x86') }, d);
  A.eq([r.card, r.source], ['mac-intel', 'client-hints'], 'Chrome on an Intel Mac → Intel card from client hints');
  A.eq(d.made.contexts, 0, 'client hints answered: no WebGL context is made');

  r = await P.detect({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('arm') }, fakeDoc(''));
  A.eq([r.card, r.source], ['mac-arm', 'client-hints'], 'Chrome on Apple Silicon → Apple Silicon card');

  d = fakeDoc('Apple GPU');
  r = await P.detect({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }, d);
  A.eq([r.card, r.arch, r.source], ['mac-unknown', null, 'unknown'], 'Safari ("Apple GPU" on both kinds) → unknown, never Apple Silicon by default');
  A.eq(d.made.lost, d.made.contexts, 'every probe context is released');

  r = await P.detect({ userAgent: UA.macFirefox, platform: 'MacIntel' }, fakeDoc('Intel(R) HD Graphics 6000'));
  A.eq([r.card, r.source], ['mac-intel', 'webgl'], 'Firefox on an Intel Mac → Intel card from the GPU');

  r = await P.detect({ userAgent: UA.macFirefox, platform: 'MacIntel' }, fakeDoc('Apple M1'));
  A.eq([r.card, r.source], ['mac-arm', 'webgl'], 'Firefox on Apple Silicon → Apple Silicon card from the GPU');

  r = await P.detect({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('', {}) }, fakeDoc('ANGLE (Intel Inc., Intel(R) Iris(TM) Graphics 6100, OpenGL 4.1)'));
  A.eq([r.card, r.source], ['mac-intel', 'webgl'], 'empty client-hint architecture falls back to the GPU');

  r = await P.detect({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('arm', { reject: true }) }, fakeDoc('Apple GPU'));
  A.eq(r.card, 'mac-unknown', 'a refused client-hints request falls back, and an unnamed GPU stays unknown');

  r = await P.detect({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('arm', { throws: true }) }, fakeDoc('NVIDIA GeForce GT 750M OpenGL Engine'));
  A.eq(r.card, 'mac-intel', 'a throwing client-hints call falls back to the GPU');

  r = await P.detect({ userAgent: UA.macSafari, platform: 'MacIntel' }, fakeDoc('', { noWebgl: true }));
  A.eq(r.card, 'mac-unknown', 'no WebGL at all → unknown');

  r = await P.detect({ userAgent: UA.macSafari, platform: 'MacIntel' }, fakeDoc('Intel Iris', { masked: true }));
  A.eq(r.card, 'mac-unknown', 'no debug-renderer extension → unknown');

  r = await P.detect({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 5 }, fakeDoc('Apple GPU'));
  A.eq(r.card, null, 'iPad → no card marked');

  // ---- site.js wiring: run its platform block against a stub DOM and the real SNPlatform
  const site = read('website/site.js');
  A.eq(/return 'mac-arm'/.test(site), false, 'site.js no longer answers mac-arm for every Mac');
  const start = site.indexOf('/* ---------- platform detection'), end = site.indexOf('/* ---------- live release links');
  A.ok(start > 0 && end > start, 'site.js platform block is findable');
  const block = site.slice(start, end);
  async function runSite(nav, renderer) {
    const cls = { windows: new Set(), 'mac-arm': new Set(), 'mac-intel': new Set() };
    const card = os => ({ classList: { add: c => cls[os].add(c) } });
    const which = { hidden: true };
    const document = Object.assign(fakeDoc(renderer), {
      querySelector(sel) {
        if (sel === '.dl-card') return card('windows');
        const m = /^\.dl-card\[data-os="([^"]+)"\]$/.exec(sel);
        return m && cls[m[1]] ? card(m[1]) : null;
      },
      querySelectorAll(sel) { return sel === '.dl-card[data-os^="mac-"]' ? [card('mac-arm'), card('mac-intel')] : []; },
      getElementById(id) { return id === 'dl-mac-which' ? which : null; },
    });
    vm.runInNewContext(block, { window: { SNPlatform: P }, navigator: nav, document });
    for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r));
    const on = os => [...cls[os]].sort().join(',');
    return { windows: on('windows'), arm: on('mac-arm'), intel: on('mac-intel'), which: !which.hidden };
  }
  A.eq(await runSite({ userAgent: UA.macSafari, platform: 'MacIntel', maxTouchPoints: 0 }, 'Apple GPU'),
    { windows: '', arm: 'check-chip', intel: 'check-chip', which: true }, 'Safari on a Mac: both Mac cards marked alike + the About This Mac line shown');
  A.eq(await runSite({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('x86') }, ''),
    { windows: '', arm: '', intel: 'detected', which: false }, 'Chrome on an Intel Mac: the Intel card is DETECTED, Apple Silicon is not');
  A.eq(await runSite({ userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: chromeUad('arm') }, ''),
    { windows: '', arm: 'detected', intel: '', which: false }, 'Chrome on Apple Silicon: the Apple Silicon card is DETECTED');
  A.eq(await runSite({ userAgent: UA.win, platform: 'Win32' }, ''),
    { windows: 'detected', arm: '', intel: '', which: false }, 'Windows: the Windows card is DETECTED');

  // ---- the page itself
  const html = read('website/index.html');
  A.ok(/<script src="platform\.js\?v=\d+"><\/script>\s*<script src="site\.js/.test(html), 'index.html loads platform.js right before site.js');
  const arm = html.slice(html.indexOf('data-os="mac-arm"'), html.indexOf('data-os="mac-intel"'));
  A.ok(/not supported on this type of Mac/.test(arm) && /href="#dl-mac-intel"/.test(arm), 'the Apple Silicon card says what macOS shows on an Intel Mac and links the Intel build');
  A.ok(/id="dl-mac-intel"/.test(html), 'the Intel card is the link target');
  const which = /<p class="dl-which" id="dl-mac-which" hidden>([^<]*)<\/p>/.exec(html);
  A.ok(which && /About This Mac/.test(which[1]) && /Chip Apple M/.test(which[1]) && /Processor &hellip; Intel/.test(which[1]),
    'the unknown-chip line is on the page, hidden until site.js needs it, with the About This Mac check');
  A.ok(/macOS 11\+/.test(arm) && /Intel-based Macs &middot; macOS 11\+/.test(html), 'both Mac cards state the macOS 11 minimum (src-tauri minimumSystemVersion)');
  A.eq(JSON.parse(read('src-tauri/tauri.conf.json')).bundle.macOS.minimumSystemVersion, '11.0', 'the stated minimum matches the bundle');
  for (const asset of ['aarch64.dmg', 'x64.dmg']) A.ok(html.includes('data-asset="' + asset + '"'), 'the release still ships ' + asset);

  // ---- the privacy page's "one api.github.com request" stays true: the detector makes no requests at all
  A.eq(/fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|new Image/.test(read('website/platform.js')), false, 'platform.js makes no network calls');

  A.report('website-platform.test');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
