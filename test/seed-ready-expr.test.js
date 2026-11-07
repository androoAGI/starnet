'use strict';
/* node test/seed-ready-expr.test.js - scripts/lib/seed.mjs READY_EXPR: ready means the game screen is active, nothing less. A fallback on "the dock is
   visible" answered ready as soon as a new document was parsed, while its stylesheets were still loading (comms-owner looked at #screen-boot through it). */
const A = require('./_assert.js');

(async () => {
  const { READY_EXPR, waitDevReady } = await import('../scripts/lib/seed.mjs');
  const page = (dev, active) => {
    const els = { 'screen-game': { classList: { contains: c => c === 'active' && active } }, bottombar: { offsetParent: {} } };
    return new Function('window', 'document', 'return ' + READY_EXPR)({ __STARNET_DEV__: dev }, { getElementById: id => els[id] || null });
  };
  A.eq(page({}, true), true, 'the game screen is active: ready');
  A.eq(page({}, false), false, 'a laid-out dock on a page whose game screen is not active is not ready');
  A.eq(page(undefined, true), false, 'a page with no dev marker is not ready');
  // a reload restarts a boot in progress: at one every 5 s, a boot of 6 s never finished, and only the old fallback's early answer had hidden that
  let polls = 0, navigations = 0;
  const ready = await waitDevReady({ send: async () => { navigations++; } }, async () => ++polls > 6, { tries: 8, url: 'http://127.0.0.1:1/' });
  A.eq(ready, true, 'a boot of six seconds is waited for');
  A.eq(navigations, 0, 'and left to finish');
  A.report('seed-ready-expr');
})().catch(e => { console.error(e); process.exit(1); });
