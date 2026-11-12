'use strict';
/* Per-service Google release on a real sidecar: releasing ONE service (Calendar, a sensitive-tier scope) opens
   exactly that service — catalog card, sign-in, callback, tools — while every other Google service (including
   the restricted Gmail/Drive tier and send-only Gmail) stays deferred with its own tier message, and an old hosted
   Calendar endpoint cannot ride the released id. Synthetic Google only; no real account or network. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-google-per-service-', timeoutMs: 30000, env: {
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    STARNET_DEFAULT_MODEL: 'replay', STARNET_OPENROUTER_KEY: '',
    STARNET_CONNECTOR_ENCRYPTION_KEY: '29'.repeat(32),
    NODE_OPTIONS: '--require=' + JSON.stringify(path.join(__dirname, 'fixtures/google-calendar-release.cjs').replace(/\\/g, '/'))
  } });
  try {
    await fixture.start();
    const cards = (await fixture.json('GET', '/api/connectors/catalog')).body.connectors.filter(c => c.googleApi && c.id !== 'google-files');
    assert.equal(cards.length, 6);
    const cal = cards.find(c => c.id === 'google-calendar');
    assert.equal(cal.releaseDeferred, false); assert.equal(cal.signInAvailable, true);
    for (const c of cards.filter(c => c.id !== 'google-calendar')) {
      assert.equal(c.releaseDeferred, true, c.id + ' stays deferred');
      assert.equal(c.signInAvailable, false, c.id + ' cannot sign in');
      assert.match(c.signInMessage, new RegExp('^' + c.name.replace(/[()]/g, '\\$&') + ' is deferred until'), c.id + ' names itself');
      assert.equal(/security assessment/.test(c.signInMessage), c.id === 'gmail' || c.id === 'google-drive', c.id + ' names its own tier');
    }
    for (const id of ['gmail', 'gmail-send', 'google-drive', 'google-docs', 'google-sheets']) {
      const r = await fixture.json('POST', '/api/connectors/oauth/start', { id });
      assert.equal(r.status, 503, id + ' sign-in refused'); assert.equal(r.body.code, 'google_release_deferred');
    }
    const start = await fixture.json('POST', '/api/connectors/oauth/start', { id: 'google-calendar' });
    assert.equal(start.status, 200, 'the released service signs in');
    const auth = new URL(start.body.url);
    assert.deepEqual(auth.searchParams.get('scope').split(' ').filter(s => /calendar/.test(s)).sort(),
      ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.freebusy', 'https://www.googleapis.com/auth/calendar.events.readonly']);
    const page = await (await fixture.request('/api/connectors/oauth/callback?state=' + auth.searchParams.get('state') + '&code=' + encodeURIComponent('google-calendar:good'))).text();
    assert.match(page, /connected/);
    const row = (await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'google-calendar');
    assert.ok(row && !row.releaseDeferred && row.state === 'up' && row.toolCount === 4, 'Calendar is live with its 4 tools: ' + JSON.stringify(row && { state: row.state, toolCount: row.toolCount }));
    const legacy = await fixture.json('POST', '/api/connectors', { id: 'cal-legacy', transport: 'http', url: 'https://calendarmcp.googleapis.com/mcp/v1', oauth: true });
    assert.equal(legacy.status, 503, 'an old hosted Calendar endpoint stays deferred');
    console.log('google-per-service-release: PASS (one released service opens end to end; five stay deferred with their own tier messages; legacy endpoint refused)');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
