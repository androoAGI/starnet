/* node test/edgetts-clock-skew.test.js — the free Edge floor survives a skewed clock, and every failure is CODED.

   Sec-MS-GEC hashes the 5-minute window the CLIENT believes it is in. A machine whose clock is off by minutes
   presents a token for the wrong window and Microsoft answers 403 to every request — indistinguishable, by message,
   from the 10-26 outage when the v1 token itself was refused. Upstream edge-tts (drm.py
   handle_client_response_error) reads the server's Date header on a 403 and retries once from the server's clock;
   that port lives in edgetts.synth. A 403 that persists from the server's own clock is a real refusal and is NOT
   retried again.

   Every rejection now carries err.speechCode (sidecar/speech-outcome.js), so no caller re-reads a message to decide
   whether a failure is a blip (timeout, cut_stream, rate_limited, upstream_unavailable) or permanent (refused,
   cancelled). Offline: a loopback server that checks the token against ITS clock, speaking the same codec. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const crypto = require('node:crypto');
const edge = require('../sidecar/edgetts.js');

const SERVER_NOW = 1784000000000;            // 200 s into a 300 s token window
const CLIP = Buffer.alloc(3000, 0x5a);
function audioFrame(chunk) {
  const hdr = Buffer.from('X-RequestId:t\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
  const hl = Buffer.alloc(2); hl.writeUInt16BE(hdr.length, 0);
  return edge.wsEncode(0x2, Buffer.concat([hl, hdr, chunk]), { mask: false });
}
const text = s => edge.wsEncode(0x1, Buffer.from(s, 'utf8'), { mask: false });

let mode = 'checkToken', requests = [];
const server = http.createServer((rq, rs) => { rs.writeHead(426); rs.end(); });
server.on('upgrade', (rq, socket) => {
  const q = new URL(rq.url, 'http://x').searchParams;
  requests.push({ gec: q.get('Sec-MS-GEC'), version: q.get('Sec-MS-GEC-Version') });
  const refuse = (status, dateMs) => {
    socket.write('HTTP/1.1 ' + status + ' Refused\r\nDate: ' + new Date(dateMs).toUTCString() + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.end();
  };
  if (mode === 'checkToken' && q.get('Sec-MS-GEC') !== edge.secMsGec(SERVER_NOW)) return refuse(403, SERVER_NOW);
  if (mode === 'alwaysRefuse') return refuse(403, SERVER_NOW);
  if (mode === 'rateLimited') return refuse(429, SERVER_NOW);
  if (mode === 'overloaded') return refuse(503, SERVER_NOW);
  const accept = crypto.createHash('sha1').update(String(rq.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.on('error', () => {});
  socket.on('data', edge.makeWsParser((op, payload) => {
    if (!(op === 0x1 && payload.toString('utf8').includes('Path:ssml'))) return;
    if (mode === 'hang') return;   // never answers: the per-attempt timeout (or the caller's abort) must end it
    socket.write(audioFrame(CLIP.subarray(0, 1500)));
    if (mode === 'cut') { socket.write(edge.wsEncode(0x8, Buffer.from([0x03, 0xe8]), { mask: false })); return; }
    socket.write(audioFrame(CLIP.subarray(1500)));
    socket.write(text('X-RequestId:t\r\nPath:turn.end\r\n\r\n{}'));
  }, () => {}));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = { host: '127.0.0.1', port: server.address().port, insecure: true, timeoutMs: 3000 };
  const attempt = async (nowMs, extra) => {
    try { const buf = await edge.synth('a sentence', Object.assign({}, base, { nowMs }, extra || {})); return { ok: true, bytes: buf.length }; }
    catch (e) { return { ok: false, message: String(e && e.message), speechCode: e && e.speechCode, http: e && e.http }; }
  };
  try {
    // ---- a clock an hour slow: one 403, one retry from the server's clock, then audio ----
    edge._resetClockSkew();
    mode = 'checkToken'; requests = [];
    const slow = await attempt(SERVER_NOW - 3600 * 1000);
    A.ok(slow.ok && slow.bytes === CLIP.length, 'a skewed clock recovers: the retry from the server\'s Date speaks the whole clip (' + JSON.stringify(slow) + ')');
    A.eq(requests.length, 2, 'exactly one retry after the 403');
    A.eq(requests[1].gec, edge.secMsGec(SERVER_NOW), 'the retry presents the token for the SERVER\'s window');
    A.ok(Math.abs(edge.clockSkew() - 3600 * 1000) < 2000, 'the learned offset is the hour the clock was off (' + edge.clockSkew() + ' ms)');
    requests = [];
    const later = await attempt(SERVER_NOW - 3600 * 1000);
    A.ok(later.ok, 'the next sentence speaks');
    A.eq(requests.length, 1, 'and starts from the learned offset: no second 403 (' + requests.length + ' requests)');

    // ---- a real refusal (the server's own clock agrees on the window): coded, and NOT retried ----
    edge._resetClockSkew();
    mode = 'alwaysRefuse'; requests = [];
    const refused = await attempt(SERVER_NOW);
    A.eq(refused.ok, false, 'a refused token rejects');
    A.eq(refused.speechCode, 'refused', 'coded refused (terminal)');
    A.eq(refused.http, 403, 'with the HTTP status');
    A.ok(/edge upgrade refused: HTTP 403/.test(refused.message), 'the message an older desk reads is unchanged: ' + refused.message);
    A.eq(requests.length, 1, 'a 403 whose Date names the SAME window is not retried');

    // ---- a refusal that persists even from the server's clock: one retry, then refused ----
    edge._resetClockSkew();
    requests = [];
    const stillRefused = await attempt(SERVER_NOW - 3600 * 1000);
    A.eq(stillRefused.speechCode, 'refused', 'a 403 that persists after the skew retry is a real refusal');
    A.eq(requests.length, 2, 'one retry, never a loop');

    // ---- the other coded failures ----
    edge._resetClockSkew();
    mode = 'rateLimited';
    const limited = await attempt(SERVER_NOW);
    A.eq([limited.speechCode, limited.http], ['rate_limited', 429], 'HTTP 429 is rate_limited (transient)');
    mode = 'overloaded';
    const overloaded = await attempt(SERVER_NOW);
    A.eq([overloaded.speechCode, overloaded.http], ['upstream_unavailable', 503], 'HTTP 503 is upstream_unavailable (transient)');
    mode = 'cut';
    const cut = await attempt(SERVER_NOW);
    A.eq(cut.speechCode, 'cut_stream', 'a stream cut before turn.end is cut_stream: ' + cut.message);
    mode = 'hang';
    const slowLeg = await attempt(SERVER_NOW, { timeoutMs: 300 });
    A.eq(slowLeg.speechCode, 'timeout', 'a leg that outlives its cap is timeout: ' + slowLeg.message);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const t0 = Date.now();
    const cancelled = await attempt(SERVER_NOW, { timeoutMs: 3000, signal: ac.signal });
    A.eq(cancelled.speechCode, 'cancelled', 'a caller that went away cancels the leg');
    A.ok(Date.now() - t0 < 1500, 'at once, not at the 3 s cap (' + (Date.now() - t0) + ' ms)');
    const noClock = await edge.synth('x', {}).then(() => ({}), e => e);
    A.eq(noClock.speechCode, 'internal_error', 'a caller that forgot the injected clock is a bug, coded internal_error');
  } finally {
    edge._resetClockSkew();
    try { server.closeAllConnections && server.closeAllConnections(); } catch (_) { /* teardown */ }
    server.close();
  }
  A.report('edgetts-clock-skew');
})().catch(e => { console.error(e); process.exit(1); });
