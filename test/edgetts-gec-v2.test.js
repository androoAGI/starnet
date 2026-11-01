/* node test/edgetts-gec-v2.test.js — the free Edge floor must present the v2 Sec-MS-GEC token.

   2026-10-26 user report "after updating on mac the speech is gone": speech.platform.bing.com answered every
   v1 token (plain SHA-256, Sec-MS-GEC-Version 1-…) with HTTP 403 — 0.13.5's client too — so a station with no
   voice-capable key fell silent. v2 = "<CS64 16 hex>-<keyed SHA-256 64 hex>" + Sec-MS-GEC-Version 2-… + a muid
   cookie (rany2/edge-tts drm.py, 2026-10-13). The vectors below were produced by that Python reference
   (generate_sec_ms_gec_v2(unix_seconds)); a port that drifts by one bit 403s again. The loopback server never
   validates a token, so this file pins the token itself AND what synth() actually sends. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const crypto = require('node:crypto');
const edge = require('../sidecar/edgetts.js');

const VECTORS = [
  [1784000000, '09E8CF94E4181298-F2F36716518E085DE3482F3B6CD6A0332FFE4E4DD7542BDD81B839E28AA3758F'],
  [1784000299, '6D9FAF17D6AF8FEB-EFF26AD2C045C5CEE09EF82D1CAF120E3B3FAFFDDF7D4153ED209E8D00B77DC4'],
  [1800000000, '99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654'],
  [1700000000.5, '2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2'],
  [1761500000, '3B0053F432211953-F8A992C7D41228EAFE34CDF6B4F6811C7190932B75F119E5278B8510EEE03F41'],
  [2000000000, '2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E'],
];
for (const [secs, want] of VECTORS) A.eq(edge.secMsGec(secs * 1000), want, 'secMsGec matches the edge-tts v2 reference at unix ' + secs);
A.eq(edge.secMsGec(1784000300 * 1000), VECTORS[1][1], 'unix 1784000299 and 1784000300 share one 300s window (windows sit on the Windows epoch)');

let seen = null;
const server = http.createServer((rq, rs) => { rs.writeHead(426); rs.end(); });
server.on('upgrade', (rq, socket) => {
  seen = { url: rq.url, cookie: String(rq.headers.cookie || '') };
  const accept = crypto.createHash('sha1').update(String(rq.headers['sec-websocket-key'] || '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.on('error', () => {});
  socket.on('data', edge.makeWsParser((op, payload) => {
    if (!(op === 0x1 && payload.toString('utf8').includes('Path:ssml'))) return;
    const hdr = Buffer.from('X-RequestId:t\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n', 'utf8');
    const hl = Buffer.alloc(2); hl.writeUInt16BE(hdr.length, 0);
    socket.write(edge.wsEncode(0x2, Buffer.concat([hl, hdr, Buffer.alloc(64, 0x5a)]), { mask: false }));
    socket.write(edge.wsEncode(0x1, Buffer.from('X-RequestId:t\r\nPath:turn.end\r\n\r\n{}', 'utf8'), { mask: false }));
  }, () => {}));
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const nowMs = 1784000000000;
    const buf = await edge.synth('one whole sentence', { nowMs, host: '127.0.0.1', port: server.address().port, insecure: true, timeoutMs: 4000 });
    A.eq(buf.length, 64, 'the loopback clip comes back whole');
    const q = new URL(seen.url, 'http://x').searchParams;
    A.eq(q.get('Sec-MS-GEC'), edge.secMsGec(nowMs), 'synth sends the v2 token for its injected clock');
    A.ok(/^2-\d+\.\d+\.\d+\.\d+$/.test(q.get('Sec-MS-GEC-Version') || ''), 'synth declares Sec-MS-GEC-Version 2-<chromium>: ' + q.get('Sec-MS-GEC-Version'));
    A.ok(/^muid=[0-9A-F]{32};$/.test(seen.cookie), 'synth sends a muid cookie of 32 uppercase hex: ' + seen.cookie);
  } finally {
    try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
    server.close();
  }
  A.report('edgetts-gec-v2');
})().catch(e => { console.error(e); process.exit(1); });
