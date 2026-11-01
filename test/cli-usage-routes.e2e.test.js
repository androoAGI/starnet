'use strict';
/* node test/cli-usage-routes.e2e.test.js — GET /api/usage/providers on a REAL sidecar (hermetic SidecarFixture: temp
   workspace + profile, no provider call leaves the machine). Locks:
     1. a station no call has run on says nothing: no subscription windows, no rate buckets (the terminal says unknown)
     2. what a provider last said survives a restart: the windows written to WORKSPACES/.usage/subscriptions.json by one
        station are what the next one serves
     3. the route is behind the station's token like every /api read
   Part of test:http. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const ENV = { STARNET_REMOTE_RELAY: 'off', SKYNET_REMOTE_RELAY: 'off' };

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-cli-usage-', env: ENV });
  try {
    await fixture.start();
    /* 1 */
    let r = await fixture.json('GET', '/api/usage/providers');
    A.ok(r.status === 200 && r.body && typeof r.body.subscriptions === 'object' && Array.isArray(r.body.rate), 'the route answers its shape: ' + JSON.stringify(r.body));
    A.eq([Object.keys(r.body.subscriptions).length, r.body.rate.length], [0, 0], 'no call yet: nothing said, nothing made up');

    /* 3 */
    const bare = await new Promise(res => {
      const q = http.request({ host: '127.0.0.1', port: fixture.port, path: '/api/usage/providers', method: 'GET', headers: { Origin: 'http://evil.example' } }, rs => { rs.resume(); res(rs.statusCode); });
      q.on('error', () => res(0)); q.end();
    });
    A.ok(bare >= 400, 'without the station\'s token (a foreign page) it is refused: ' + bare);

    /* 2 */
    await fixture.stop();
    const file = path.join(fixture.workspace, '.usage', 'subscriptions.json');
    const said = { 'claude-cli': { primary: { windows: [{ id: 'five_hour', label: '5-hour', usedPct: 12, resetsAt: 1793082000000, status: 'allowed' }], seenAt: 1793081000000 } } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, providers: said }));
    await fixture.start();
    r = await fixture.json('GET', '/api/usage/providers');
    A.eq(r.body.subscriptions, said, 'after a restart the station still says what the provider last said');
  } finally {
    await fixture.dispose();
  }
  A.report('cli-usage-routes.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
