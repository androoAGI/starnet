'use strict';
/* An EARLY ACCESS build on a real sidecar: every SENSITIVE Google service is open before Google verification, every
   such card says so plainly and its sign-in reaches Google. A RESTRICTED service (full Gmail, whole Drive) is one Google
   blocks outright ("This app is blocked", no Advanced — GitHub #148), so its sign-in is HELD: the card says so in one
   line and points at what works, the route refuses, and a saved connection is not deferred. Old hosted endpoints stay
   refused. Synthetic Google only. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-google-early-', timeoutMs: 30000, env: {
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    STARNET_DEFAULT_MODEL: 'replay', STARNET_OPENROUTER_KEY: '',
    STARNET_CONNECTOR_ENCRYPTION_KEY: '3a'.repeat(32),
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/google-early-access.cjs').replace(/\\/g, '/')
  } });
  try {
    await fixture.start();
    const all = (await fixture.json('GET', '/api/connectors/catalog')).body.connectors;
    const cards = all.filter(c => c.googleApi && c.id !== 'google-files');
    assert.equal(cards.length, 6);
    const HELD = { gmail: ['Gmail', 'gmail-app-password', 'Gmail (app password)'], 'google-drive': ['Google Drive', 'google-files', 'Selected Google files'] };
    for (const c of cards) {
      assert.equal(c.releaseDeferred, false, c.id + ' is not deferred in early access');
      if (HELD[c.id]) {
        const [name, useId, useName] = HELD[c.id];
        assert.equal(c.signInHeld, true, c.id + ' sign-in is held (Google blocks the restricted tier outright)');
        assert.equal(c.signInAvailable, false, c.id + ' offers no sign-in');
        assert.equal(c.useInstead, useId, c.id + ' points at the connection to try instead');
        assert.ok(all.some(x => x.id === useId), useId + ' is in the catalog');
        assert.equal(c.signInMessage, 'Google blocks StarNet’s ' + name + ' sign-in until StarNet passes Google’s review. Meanwhile you can try ' + useName + ' instead.', c.id + ': one honest line, never that the alternative works');
        assert.ok(!c.earlyAccess && !/Advanced|Sign in with Google/.test(c.blurb), c.id + ' never promises a way through Google: ' + c.blurb);
        continue;
      }
      assert.ok(!c.signInHeld, c.id + ' (sensitive) is not held');
      assert.equal(c.signInAvailable, true, c.id + ' can sign in');
      assert.equal(c.earlyAccess, true, c.id + ' is flagged early access');
      assert.match(c.blurb, /^Early access — Google has not finished verifying StarNet yet\. When Google says the app isn’t verified, choose Advanced, then Go to StarNet\. /, c.id + ' says so on the card, with the way through');
    }
    const files = all.find(c => c.id === 'google-files');
    assert.ok(files && !files.earlyAccess && !/^Early access/.test(files.blurb), 'Selected Google files is a verified surface, not early access');
    for (const id of Object.keys(HELD)) {
      const held = await fixture.json('POST', '/api/connectors/oauth/start', { id });
      assert.equal(held.status, 503, id + ': the route refuses a held sign-in too');
      assert.equal(held.body.code, 'google_signin_held');
      assert.ok(!held.body.url, id + ': no Google URL is minted');
    }
    const start = await fixture.json('POST', '/api/connectors/oauth/start', { id: 'gmail-send' });
    assert.equal(start.status, 200, 'send-only Gmail (sensitive) signs in on an early-access build');
    assert.equal(new URL(start.body.url).origin, 'https://accounts.google.com');
    const legacy = await fixture.json('POST', '/api/connectors', { id: 'gm-legacy', transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', oauth: true });
    assert.equal(legacy.status, 503, 'old hosted endpoints stay refused');
    console.log('google-early-access.e2e: PASS (four sensitive services open and labelled, restricted Gmail/Drive sign-in held with what works, sign-in reaches Google, legacy refused)');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
