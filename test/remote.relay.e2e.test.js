/* node test/remote.relay.e2e.test.js — the PRODUCT path: a real booted sidecar dials out to a real relay, and the
   WebCrypto phone client pairs and works through it. Mock model, zero spend, all on 127.0.0.1.
     · the desk switches Remote on -> the station signs in at the relay (GET /api/remote says online)
     · PAIR A PHONE gives a relay pairing link; the phone pairs through the relay with it
     · the relay serves the phone app itself, locked down by CSP
     · a real task from the phone; its shell approval answered on the phone; the reply in the thread
     · revoke at the desk kicks the phone at the relay
     · with the relay switched off (STARNET_REMOTE_RELAY=off), pairing says so plainly instead of offering a dead link */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Phone = require('../relay/app/phone-client.js');
const { makeRelay } = require('../relay/server.js');
const path = require('path');

const HOST = '127.0.0.1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitUntil(fn, ms, label) { const t = Date.now() + ms; while (Date.now() < t) { if (await fn()) return; await sleep(40); } throw new Error('timed out waiting for ' + label); }

function startMockModel() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let body = ''; req.on('data', d => { body += d; });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body); } catch (_) {}
        const msgs = p.messages || [];
        const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
        const tools = msgs.slice(msgs.lastIndexOf(lastUser) + 1).filter(m => m && m.role === 'tool');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const call = (id, name, args) => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n'); res.end('data: [DONE]\n\n'); };
        const say = (t) => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n'); res.end('data: [DONE]\n\n'); };
        if (/relay shell proof/i.test(String(lastUser && lastUser.content))) {
          if (!tools.length) return call('b1', 'brief_proceed', { objective: 'relay proof' });
          if (!tools.some(m => /RELAY_OK/.test(JSON.stringify(m))) && tools.length < 3) return call('s1', 'shell_exec', { cmd: 'echo RELAY_OK' });
          return say('RELAY_SHELL_DONE');
        }
        say('OK');
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

(async () => {
  const llm = await startMockModel();
  const relay = makeRelay({ appDir: path.join(__dirname, '..', 'relay', 'app'), extraFiles: { '/vt323.woff2': path.join(__dirname, '..', 'frontend', 'assets', 'fonts', 'vt323.woff2') }, log: () => {} });
  const relayPort = await relay.listen(0, HOST);
  const relayUrl = 'http://' + HOST + ':' + relayPort;
  const env = {
    SKYNET_OPENROUTER_BASE: llm.base, STARNET_OPENROUTER_BASE: llm.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-relay-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-relay-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const fx = new SidecarFixture({ prefix: 'sn-relay-e2e-', timeoutMs: 15000, env: Object.assign({ STARNET_REMOTE_RELAY: relayUrl }, env) });
  const bare = new SidecarFixture({ prefix: 'sn-relay-none-', timeoutMs: 15000, env: Object.assign({ STARNET_REMOTE_RELAY: 'off' }, env) });
  let c = null;
  try {
    // the relay serves the phone app, locked down
    const page = await fetch(relayUrl + '/');
    A.eq(page.status, 200, 'the relay serves the phone app');
    A.ok(/default-src 'self'/.test(page.headers.get('content-security-policy') || ''), 'with a strict CSP');
    A.ok(/StarNet Remote/.test(await page.text()), 'it is the Remote deck');
    A.eq((await fetch(relayUrl + '/phone-client.js')).status, 200, 'the phone client is served next to it');
    A.eq((await fetch(relayUrl + '/vt323.woff2')).status, 200, 'and the station font');
    A.eq((await fetch(relayUrl + '/../sidecar/index.js')).status === 200, false, 'nothing outside the app folder');

    await fx.start();
    A.eq((await fx.json('POST', '/api/roster', { agents: [{ agentId: 'forge', name: 'FORGE', system: 'You are FORGE.', model: 'test/model' }] })).status, 200, 'roster');
    // Remote on, the pairing link and the new phone are authority changes the desk confirms (GHSA-2hpj #1, #7): this bare
    // station takes the code it printed on its own console, which the fixture types as the person there would (deskJson)
    const on = await fx.deskJson('POST', '/api/remote/enable', { on: true });
    A.eq(on.body.enabled, true, 'Remote on');
    A.eq(on.body.listening, false, 'no LAN door unless asked for');
    await waitUntil(async () => ((await fx.json('GET', '/api/remote')).body.relay || {}).state === 'online', 10000, 'station online at the relay');
    const pr = await fx.deskJson('POST', '/api/remote/pair', {});
    A.eq(pr.status, 200, 'pairing code');
    A.ok(pr.body.pairUrl.indexOf(relayUrl + '/#pair=') === 0, 'the pairing link opens the app on the relay, secret in the fragment');
    const blob = JSON.parse(Buffer.from(pr.body.pairBlob.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    A.eq(blob.r, relayUrl, 'the link names the relay');
    A.eq(await Phone.fingerprint(blob.s), pr.body.fingerprint, 'phone and desk show the same station code');

    const key = await Phone.makeDeviceKey();
    // the link's `c` is the pairing's 128-bit secret, the proof's key (GHSA-2hpj #7)
    A.eq(blob.c, pr.body.secret, 'the link carries the 128-bit secret, not the short code');
    const paired = await Phone.pairRelay({ relay: blob.r, stationPub: blob.s, pairingId: blob.p, secret: blob.c, name: 'E2E phone', key });
    A.ok(/^dev_/.test(paired.deviceId) && paired.relayToken, 'paired through the relay');
    // a new phone waits for the desk's approval (its name and fingerprint), then asks first
    A.eq((await fx.json('GET', '/api/remote')).body.devices.find(d => d.id === paired.deviceId).pending, true, 'the new phone waits for the desk');
    const approved = await fx.deskJson('POST', '/api/remote/activate', { deviceId: paired.deviceId });
    A.eq([approved.status, (approved.body.devices || []).find(d => d.id === paired.deviceId).pending], [200, false], 'the desk approves the phone');
    c = Phone.connectRelay({ relay: blob.r, stationPub: blob.s, deviceId: paired.deviceId, relayToken: paired.relayToken, key });
    const events = []; c.onEvent(e => events.push(e));
    const st = await c.call('status');
    A.ok(st.ok && st.data.agents.some(a => a.agentId === 'forge'), 'status through the relay');

    const sent = await c.call('send', { agentId: 'forge', text: 'relay shell proof' });
    A.eq(sent.ok, true, 'task sent through the relay');
    await waitUntil(() => events.some(e => e.type === 'approval.opened' && e.approval.runId === sent.data.runId), 20000, 'approval through the relay');
    const ap = events.find(e => e.type === 'approval.opened').approval;
    A.eq((await c.call('decide', { runId: ap.runId, promptId: ap.promptId, decision: 'once' })).ok, true, 'approved on the phone');
    await waitUntil(() => events.some(e => e.type === 'run.ended' && e.runId === sent.data.runId), 30000, 'run end through the relay');
    const th = await c.call('thread', { streamId: sent.data.streamId });
    A.ok(th.data.some(t => t.role === 'assistant' && /RELAY_SHELL_DONE/.test(t.content)), 'the reply is in the conversation');

    const closed = []; c.onStatus((s, d) => { if (s === 'closed') closed.push(d && d.code); });
    A.eq((await fx.json('POST', '/api/remote/revoke', { deviceId: paired.deviceId })).status, 200, 'revoke at the desk');
    await waitUntil(() => closed.length > 0, 5000, 'phone kicked at the relay');
    let refused = false; try { await c.call('status'); } catch (_) { refused = true; }
    A.ok(refused, 'the removed phone cannot get back in');

    // a build with no relay says so
    await bare.start();
    A.eq((await bare.deskJson('POST', '/api/remote/enable', { on: true })).body.enabled, true, 'no relay: Remote still switches on at the desk');
    const none = await bare.json('POST', '/api/remote/pair', {});
    A.eq(none.status, 409, 'no relay: pairing refused');
    A.ok(/no relay/.test(String(none.body.error)), 'with a plain reason: ' + none.body.error);
    A.eq((await bare.json('GET', '/api/remote')).body.relay, null, 'and the desk status shows no relay');
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + '\n--- sidecar ---\n' + String(fx.output ? fx.output() : '').slice(-2500));
  } finally {
    try { c && c.close(); } catch (_) {}
    await fx.dispose(); await bare.dispose();
    await relay.close(); llm.server.close();
  }
  A.report('remote relay e2e');
})();
