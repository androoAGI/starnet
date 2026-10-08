/* node test/provider-validate-rejected.http.test.js — #90: a key Anthropic REFUSES must say so.

   Reported: an Anthropic key that /v1/models answered with 401 read "provider returned no usable models for this key".
   The adapter folded every non-OK /models answer into an empty catalog, so the key check blamed the catalog for what
   was the provider rejecting the key. The OpenRouter credential-probe branch of the same route already said
   "provider rejected this key (HTTP 401)"; the native Anthropic path now reaches the same words.

   Boots the REAL sidecar (hermetic SidecarFixture) against a fake Anthropic /v1 that answers /models by key:
     · a refused key (401 / 403) -> credentialVerified:false, status, and the rejected-key copy (never "no usable models")
     · a key the API accepts with an EMPTY catalog keeps the old "no usable models" line (that one is true)
     · a model list answering another status (404 from a proxy, 529 overloaded) names THAT answer, not a credential probe
     · a request that never reached Anthropic (refused connection) names the network cause (#62), never the key
     · a good key verifies, and the refused key never leaks into any answer.
   NOT in test:fast (child-process boot); listed in test/http.list. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const KEYS = { 'sk-ant-api03-good': 200, 'sk-ant-api03-empty': 200, 'sk-ant-usr-refused': 401, 'sk-ant-api03-scoped': 403, 'sk-ant-api03-busy': 529 };

(async () => {
  const seen = [];
  const server = http.createServer((rq, rs) => {
    const key = String(rq.headers['x-api-key'] || '');
    seen.push(rq.method + ' ' + rq.url);
    if (!/\/v1\/models/.test(rq.url)) { rs.writeHead(404, { 'Content-Type': 'application/json' }); return rs.end('{}'); }
    const status = KEYS[key] || 401;
    rs.writeHead(status, { 'Content-Type': 'application/json' });
    if (status === 401) return rs.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    if (status === 403) return rs.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'this key is not scoped to a workspace' } }));
    if (status === 529) return rs.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    rs.end(JSON.stringify({ data: key === 'sk-ant-api03-empty' ? [] : [{ id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5' }] }));
  });
  await new Promise(resolve => server.listen(0, HOST, resolve));
  const baseUrl = 'http://' + HOST + ':' + server.address().port + '/v1';
  // a port that refuses connections: listen, note it, close — nothing answers there afterwards
  const gone = http.createServer();
  await new Promise(resolve => gone.listen(0, HOST, resolve));
  const deadBaseUrl = 'http://' + HOST + ':' + gone.address().port + '/v1';
  await new Promise(resolve => gone.close(resolve));
  const fixture = SidecarFixture.create({ prefix: 'validate-rejected-', timeoutMs: 20000, env: {
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0', ANTHROPIC_API_KEY: '', SKYNET_ANTHROPIC_KEY: '', STARNET_ANTHROPIC_KEY: ''
  } });
  try {
    await fixture.start();
    const check = (key, at) => fixture.json('POST', '/api/providers/validate', { provider: 'anthropic', key, baseUrl: at || baseUrl });

    const refused = await check('sk-ant-usr-refused');
    A.eq(refused.status, 200, 'validate answers 200 with a verdict');
    A.eq(refused.body.credentialVerified, false, 'a 401 key is not verified');
    A.eq(refused.body.status, 401, 'the provider status rides the answer');
    A.eq(refused.body.error, 'provider rejected this key (HTTP 401)', 'a 401 from /v1/models reads as a rejected key (got ' + JSON.stringify(refused.body.error) + ')');
    A.ok(String(refused.body.error || '').indexOf('no usable models') < 0, 'never "no usable models" for a key the provider refused');
    A.eq(refused.body.reachable, true, 'the endpoint answered, so it is reachable');

    const scoped = await check('sk-ant-api03-scoped');
    A.eq(scoped.body.error, 'provider rejected this key (HTTP 403)', 'a 403 reads as a rejected key too');

    const empty = await check('sk-ant-api03-empty');
    A.eq(empty.body.credentialVerified, false, 'an accepted key with no models is still not verified');
    A.eq(empty.body.error, 'provider returned no usable models for this key', 'an accepted key with an EMPTY catalog keeps the old (true) line');

    const busy = await check('sk-ant-api03-busy');
    A.eq(busy.body.credentialVerified, false, 'a 529 model list is not a verified key');
    A.eq(busy.body.status, 529, 'and carries the status');
    A.eq(busy.body.error, "the provider's model list answered HTTP 529", 'a non-refusal status names the model list answer (got ' + JSON.stringify(busy.body.error) + ')');
    A.ok(String(busy.body.error || '').indexOf('credential probe') < 0, 'never "credential probe": no credential probe ran on this path');

    const unreached = await check('sk-ant-api03-good', deadBaseUrl);
    A.eq(unreached.body.credentialVerified, false, 'a key check that never reached Anthropic verifies nothing');
    A.eq(unreached.body.reachable, false, 'and says the provider was not reached');
    A.ok(/ECONNREFUSED/.test(String(unreached.body.error || '')), 'it names the network cause (#62 wording) (got ' + JSON.stringify(unreached.body.error) + ')');
    A.ok(String(unreached.body.error || '').indexOf('no usable models') < 0 && String(unreached.body.error || '').indexOf('rejected') < 0, 'never blames the key when the request never arrived');

    const good = await check('sk-ant-api03-good');
    A.eq(good.body.credentialVerified, true, 'a key the API accepts verifies (got ' + JSON.stringify(good.body) + ')');

    A.ok(seen.some(s => /^GET \/v1\/models/.test(s)), 'the check really reached the fake /v1/models');
    A.ok(JSON.stringify([refused.body, scoped.body, empty.body, busy.body, unreached.body, good.body]).indexOf('sk-ant-') < 0, 'no answer echoes a candidate key');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(fixture.output()).slice(-3000));
    A.ok(false, 'the test threw: ' + ((e && e.message) || e));   // report() exits with the assertion tally, so count it
  } finally {
    await fixture.dispose();
    try { server.closeAllConnections(); server.close(); } catch (e) { console.warn(e.message); }
  }
  A.report('provider-validate-rejected.http.test');
})().catch(e => { console.error(e); process.exit(1); });
