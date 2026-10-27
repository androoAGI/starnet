'use strict';
/* An EARLY ACCESS build on a real sidecar: every Google service is open before Google verification, every card
   says so plainly, sign-in reaches Google, and old hosted endpoints stay refused. Synthetic Google only. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-google-early-', timeoutMs: 30000, env: {
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    STARNET_DEFAULT_MODEL: 'replay', STARNET_OPENROUTER_KEY: '',
    STARNET_CONNECTOR_ENCRYPTION_KEY: '3a'.repeat(32),
    NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'fixtures/google-early-access.cjs').replace(/\\/g, '/'))
  } });
  try {
    await fixture.start();
    const cards = (await fixture.json('GET', '/api/connectors/catalog')).body.connectors.filter(c => c.googleApi && c.id !== 'google-files');
    assert.equal(cards.length, 6);
    for (const c of cards) {
      assert.equal(c.releaseDeferred, false, c.id + ' is open in early access');
      assert.equal(c.signInAvailable, true, c.id + ' can sign in');
      assert.equal(c.earlyAccess, true, c.id + ' is flagged early access');
      assert.match(c.blurb, /^Early access — Google has not finished verifying StarNet yet\. When Google says the app isn’t verified, choose Advanced, then Go to StarNet\. /, c.id + ' says so on the card, with the way through');
    }
    const files = (await fixture.json('GET', '/api/connectors/catalog')).body.connectors.find(c => c.id === 'google-files');
    assert.ok(files && !files.earlyAccess && !/^Early access/.test(files.blurb), 'Selected Google files is a verified surface, not early access');
    const start = await fixture.json('POST', '/api/connectors/oauth/start', { id: 'gmail' });
    assert.equal(start.status, 200, 'restricted Gmail signs in on an early-access build');
    assert.equal(new URL(start.body.url).origin, 'https://accounts.google.com');
    const legacy = await fixture.json('POST', '/api/connectors', { id: 'gm-legacy', transport: 'http', url: 'https://gmailmcp.googleapis.com/mcp/v1', oauth: true });
    assert.equal(legacy.status, 503, 'old hosted endpoints stay refused');
    console.log('google-early-access.e2e: PASS (six services open and labelled, sign-in reaches Google, legacy refused)');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
