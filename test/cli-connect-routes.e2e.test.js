'use strict';
/* node test/cli-connect-routes.e2e.test.js — the terminal's /connect on a REAL sidecar (hermetic SidecarFixture: temp
   workspace + profile, no provider call ever leaves the machine). Locks POST /api/providers/connect + /connect/take:
     1. what is not a key provider (a sign-in, credits, Ollama, Claude Code), an unknown one, or a key provider with no key
        is refused before anything moves
     2. no StarNet page: a browser/terminal station answers { code: 'no-page' } (the terminal then proves the key and hands
        it to /api/providers/engine-key — the store this station's runs read) — and that path really connects a provider
     3. a page connected: the bus carries only a one-time SLOT (never the key — every page and listener hears the bus); the
        page collects the key once (a second take, or one after the answer, finds nothing); its answer is the route's
        (saved → 200 where it went; refused → 422 with the page's own reason)
   Part of test:http. */
const A = require('./_assert.js');
const http = require('http');
const apitickets = require('../sidecar/apitickets.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a StarNet PAGE on the station's bus (an SSE ticket, as the app's EventSource signs in); onCommand sees each station.command
function page(fixture, onCommand) {
  const p = '/api/channels/events?ticket=' + encodeURIComponent(apitickets.mint(fixture.token, 'sse', apitickets.SCOPE_SSE, { now: Date.now() }));
  let raw = '';
  const req = http.request({ host: '127.0.0.1', port: fixture.port, path: p, method: 'GET', headers: { Accept: 'text/event-stream', Origin: fixture.baseUrl } }, res => {
    res.setEncoding('utf8'); let buf = '';
    res.on('data', d => {
      raw += d; buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const b = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = b.split('\n').filter(l => l.indexOf('data: ') === 0).map(l => l.slice(6)).join('\n');
        if (!data) continue;
        try { const j = JSON.parse(data); if (j && j.name === 'station.command') onCommand(j.payload || {}); } catch (_) {}
      }
    });
  });
  req.on('error', () => {}); req.end();
  return { raw: () => raw, close: () => { try { req.destroy(); } catch (_) {} } };
}
const ENV = { STARNET_REMOTE_RELAY: 'off', SKYNET_REMOTE_RELAY: 'off' };
const KEY = 'gsk_connect-e2e-SECRET-0123456789';

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-cli-connect-', env: ENV });
  try {
    await fixture.start();
    const connect = body => fixture.json('POST', '/api/providers/connect', body);

    /* 1 */
    for (const [b, why] of [[{ provider: 'codex', key: 'x' }, 'a sign-in'], [{ provider: 'starnet', key: 'x' }, 'credits'], [{ provider: 'ollama', key: 'x' }, 'Ollama'], [{ provider: 'claude-cli', key: 'x' }, 'Claude Code']]) {
      const r = await connect(b);
      A.ok(r.status === 400 && /does not take an API key/.test(r.body.error), why + ': no key to take — ' + JSON.stringify(r.body));
    }
    A.eq((await connect({ provider: 'warp', key: 'x' })).status, 400, 'an unknown provider is refused');
    A.ok(/no key/.test((await connect({ provider: 'groq' })).body.error), 'a key provider with no key is refused');
    A.ok(/base URL/.test((await connect({ provider: 'custom', key: 'x' })).body.error), 'custom with no endpoint is refused');

    /* 2 */
    let r = await connect({ provider: 'groq', key: KEY });
    A.eq([r.status, r.body.code], [409, 'no-page'], 'no page on a station with no keychain: the terminal takes the station path');
    const before = ((await fixture.json('GET', '/api/providers')).body.providers || []).find(p => p.id === 'custom');
    const e = await fixture.json('POST', '/api/providers/engine-key', { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1' });
    const after = ((await fixture.json('GET', '/api/providers')).body.providers || []).find(p => p.id === 'custom');
    A.ok(e.status === 200 && e.body.ok && before && !before.configured && after && after.configured, 'the station path connects a provider the station lists as connected');

    /* 3 */
    const seen = [];
    let take = null;
    let answer = { ok: true, result: { provider: 'groq', store: 'browser', verified: true } };
    const pg = page(fixture, async cmd => {
      seen.push(cmd);
      if (cmd.verb !== 'provider.key') return;
      take = await fixture.json('POST', '/api/providers/connect/take', { slot: cmd.args.slot });
      const again = await fixture.json('POST', '/api/providers/connect/take', { slot: cmd.args.slot });
      take.again = again.status;
      await fixture.json('POST', '/api/station/ack', Object.assign({ id: cmd.id }, answer));
    });
    await sleep(400);
    r = await connect({ provider: 'groq', key: KEY });
    A.eq([r.status, r.body.ok, r.body.via, r.body.store], [200, true, 'page', 'browser'], 'a page connected: the page saves it and the route says where: ' + JSON.stringify(r.body));
    const cmd = seen.find(c => c.verb === 'provider.key');
    A.ok(!!cmd && cmd.args.provider === 'groq' && /^[0-9a-f-]{36}$/.test(cmd.args.slot) && cmd.args.desktop === false, 'the command names the provider and a one-time slot');
    A.ok(!pg.raw().includes(KEY) && !pg.raw().includes('SECRET'), 'the key never rides the bus');
    A.eq([take.status, take.body, take.again], [200, { provider: 'groq', key: KEY, baseUrl: '' }, 404], 'the page collects it once — a second take finds nothing');
    A.eq((await fixture.json('POST', '/api/providers/connect/take', { slot: cmd.args.slot })).status, 404, 'after the answer the slot is gone');
    answer = { ok: false, error: 'provider rejected this key (HTTP 401) — nothing was saved' };
    r = await connect({ provider: 'groq', key: KEY });
    A.eq([r.status, r.body.error], [422, 'provider rejected this key (HTTP 401) — nothing was saved'], 'a page that refused it: its own reason');
    A.eq(JSON.stringify(r.body).indexOf(KEY), -1, 'no answer echoes the key');
    pg.close();
  } catch (e) {
    A.ok(false, 'threw: ' + ((e && e.stack) || e));
  } finally {
    await fixture.stop().catch(() => {});
  }
  A.report('cli-connect-routes.e2e.test');
  process.exit(process.exitCode || 0);
})();
