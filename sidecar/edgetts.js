/* sidecar/edgetts.js — zero-dependency client for Microsoft's Edge "Read Aloud" TTS endpoint.
   This is the FREE, KEYLESS neural voice floor: any station (zero-key / Anthropic-only / Codex-only)
   gets a decent neural voice with no credential and no Edge install. It speaks the same private
   websocket protocol the Edge browser's read-aloud feature uses.

   Why hand-rolled instead of Node's global WebSocket: the endpoint only answers requests that carry
   a browser User-Agent + the chrome-extension Origin + Connection:Upgrade. Node's WHATWG WebSocket
   forbids setting those headers, so we drive node:https' raw HTTP upgrade and frame the protocol by
   hand (masked client frames, incremental server-frame parser, binary audio payloads).

   Pure pieces (secMsGec / wsEncode / makeWsParser) are exported so they can be unit-tested offline,
   and synth() takes host/port/insecure overrides (also readable from env) so a test can point it at a
   loopback server that speaks the same codec. No dependencies: node:https / node:http / node:crypto only. */
'use strict';

const https = require('node:https');
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');

// The public trusted-client token + Chromium version string the Edge read-aloud client presents.
const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_VER = '143.0.3650.96';
// Nearest Edge neural voice to the station's locked Algenib identity (low gravelly male bass).
const DEFAULT_VOICE = 'en-US-ChristopherNeural';
// Edge outputs mp3 for this format (matches what the browser <audio> plays natively).
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
// WebSocket GUID (RFC 6455) — only needed by a peer that VALIDATES the handshake accept; the raw
// node:http upgrade path here doesn't, but the loopback test server uses it, so export nothing extra.

// STARNET_/SKYNET_-prefixed env, mirroring sidecar/index.js's ENV() so overrides work under either brand.
function env(suffix) { const k = 'STARNET_' + suffix; return (k in process.env) ? process.env[k] : process.env['SKYNET_' + suffix]; }
function truthyOff(v) { return /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim()); }
function truthyOn(v) { return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }

/* Sec-MS-GEC v2 (the endpoint 403s every v1 token since ~2026-10-13, which silenced every keyless station).
   v1 was plain uppercase SHA-256 of (Windows FILETIME ticks rounded down to a 300s window) + the trusted
   token; v2 hashes the SAME string with a keyed SHA-256 variant and a CS64 checksum over it, sent as
   "<16 hex CS64>-<64 hex digest>" with Sec-MS-GEC-Version "2-<chromium>". Ported from rany2/edge-tts
   src/edge_tts/drm.py (generate_sec_ms_gec_v2, 2026-10-13); test/edgetts-gec-v2.test.js pins vectors
   produced by that reference. All arithmetic is uint32: Math.imul for products, >>> 0 to wrap sums. */
const GEC_SHA_INITIAL = [0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19];
const GEC_SHA_STATE = [0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2];
const GEC_SHA_SCHEDULE = [0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0,
  0xF9E70AB6, 0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564];
const SHA_K = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2];
const GEC_SHA_ADJUSTMENT = 0xC9DC06A7;
const GEC_SHA_BLOCK_K = SHA_K.slice(0, 14).concat([GEC_SHA_ADJUSTMENT], SHA_K.slice(15));
const GEC_SIGMA0_ADJUSTMENT = 0x059C0B80;
const GEC_SIGMA1_ADJUSTMENT = 0x000B92C0;
const GEC_CS64_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C], [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167]];
const GEC_CS64_FACTOR = 0x82893933;
const GEC_CS64_ADJUSTMENT0 = 0xF2F90B1A;
const GEC_CS64_ADJUSTMENT1 = 0x0B1A0000;

const u32 = (v) => v >>> 0;
const rotr = (v, n) => u32((v >>> n) | (v << (32 - n)));
const rol16 = (v) => u32((v << 16) | (v >>> 16));
const sigma0 = (v) => u32(rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3));
const sigma1 = (v) => u32(rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10));

// Standard SHA-256 compression rounds from `first` to 63 over a full 64-word schedule; returns the working registers.
function shaRounds(state, w, first) {
  const k = first === 14 ? GEC_SHA_BLOCK_K : SHA_K;
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const t1 = u32(h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + u32(g ^ (e & (f ^ g))) + k[i] + w[i]);
    const t2 = u32((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + u32((a & b) | (c & (a | b))));
    h = g; g = f; f = e; e = u32(d + t1); d = c; c = b; b = a; a = u32(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}
function expandSchedule(w, from) {
  for (let i = from; i < 64; i++) w.push(u32(sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]));
}
// The keyed state for the first seven bytes of the token string (the v2 "salt"): a pre-run partial block.
function gecShaInit(head7) {
  const w = new Array(14).fill(0);
  w.push(head7.readUIntBE(0, 3), head7.readUInt32BE(3));
  for (let i = 16; i < 30; i++) {
    let v = GEC_SHA_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? u32(sigma1(w[i - 2]) ^ GEC_SIGMA1_ADJUSTMENT) : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? u32(sigma0(w[i - 15]) ^ GEC_SIGMA0_ADJUSTMENT) : sigma0(w[i - 15]);
    w.push(u32(v));
  }
  w.push(u32(sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + GEC_SHA_ADJUSTMENT - SHA_K[14]));
  expandSchedule(w, 31);
  const working = shaRounds(GEC_SHA_STATE, w, 14);
  return GEC_SHA_INITIAL.map((x, i) => u32(x + working[i]));
}
function gecSha256(data) {
  if (data.length < 7) throw new Error('edgetts: token salt must contain at least seven bytes');
  const length = 57 + data.length;
  const zeros = (((55 - length) % 64) + 64) % 64;
  const lenBuf = Buffer.alloc(8); lenBuf.writeBigUInt64BE(BigInt(length * 8));
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(zeros), lenBuf]);
  let state = gecShaInit(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w = [];
    for (let j = 0; j < 16; j++) w.push(padded.readUInt32BE(off + j * 4));
    expandSchedule(w, 16);
    const working = shaRounds(state, w, 0);
    state = state.map((x, i) => u32(x + working[i]));
  }
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(x, i * 4));
  return out;
}
function gecCs64(data, digest) {
  const keyA = u32(digest.readUInt32LE(0) | 1), keyB = u32(digest.readUInt32LE(4) | 1);
  const factors = [u32(Math.imul(keyA, GEC_CS64_FACTOR)), u32(Math.imul(keyB, GEC_CS64_FACTOR))];
  const terms = GEC_CS64_COEFFICIENTS.map(([coef], i) => u32(Math.imul(coef, factors[i % 2])));
  const offsets = GEC_CS64_COEFFICIENTS.map(([, offset]) => offset);
  // little-endian words of (0x00 + data), zero-padded to whole words and then to an even word count
  const src = Buffer.concat([Buffer.from([0]), data]);
  const bytes = Buffer.concat([src, Buffer.alloc((4 - (src.length % 4)) % 4)]);
  const words = [];
  for (let off = 0; off < bytes.length; off += 4) words.push(bytes.readUInt32LE(off));
  if (words.length % 2) words.push(0);
  words.forEach((word, i) => {
    let term = Math.imul(word, i % 2 === 0 ? keyA : keyB);
    let offset = Math.imul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) { term = u32(term) + u32(Math.imul(GEC_CS64_ADJUSTMENT0, factors[0])); offset = u32(offset) + GEC_CS64_ADJUSTMENT1; }
    terms.push(u32(term)); offsets.push(u32(offset));
  });
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16(u32(offsets[i] + x));
    let q = u32(Math.imul(t, 0x76F50F34));
    const swapStep = u32(u32(Math.imul(rol16(q), 0xC3EFEA97)) + q);
    t = rol16(u32(offsets[i + 1] + y));
    q = u32(Math.imul(t, 0x1881CE3C));
    swapLast = u32(u32(Math.imul(rol16(q), 0x35BD1EC9)) + q);
    swapAcc = u32(swapAcc + swapStep + swapLast);

    state = u32(u32(Math.imul(state, keyA)) + x);
    state = u32(Math.imul(rol16(state), 0xCF98B111));
    state = u32(Math.imul(rol16(state), 0x87085B9F));
    state = u32(Math.imul(rol16(state), 0x12CEB96D));
    state = u32(Math.imul(rol16(state), 0x257E1D83));
    const mid = state;
    t = u32(u32(Math.imul(state, keyB)) + y);
    t = u32(Math.imul(rol16(t), 0xA27416F5));
    t = u32(Math.imul(rol16(t), 0xD38396FF));
    state = u32(Math.imul(rol16(u32(Math.imul(rol16(t), 0x7C932B89))), 0xBFA49F69));
    acc = u32(acc + mid + state);
  }
  const out = Buffer.alloc(8);
  out.writeUInt32LE(u32(swapLast ^ state), 0); out.writeUInt32LE(u32(swapAcc ^ acc), 4);
  return out;
}

// The endpoint rejects a request whose token is outside the current ~5-minute window.
// The clock is INJECTED (determinism law: no ambient Date.now outside the composition root).
function secMsGec(nowMs) {
  const secs = Math.floor(Number(nowMs) / 1000) + 11644473600;   // unix → windows epoch offset
  const rounded = secs - (secs % 300);
  const ticks = BigInt(rounded) * 10000000n;                     // 100ns FILETIME ticks
  const data = Buffer.from(`${ticks}${TRUSTED_TOKEN}`, 'ascii');
  const digest = gecSha256(data);
  return gecCs64(data, digest).toString('hex').toUpperCase() + '-' + digest.toString('hex').toUpperCase();
}

// Which Edge voice to use — explicit opt wins, else SKYNET_EDGE_TTS_VOICE, else the Algenib-nearest default.
function resolveVoice(opts) {
  return String((opts && opts.voice) || env('EDGE_TTS_VOICE') || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
}

// XML-escape text interpolated into the SSML <voice> body so a stray & < > ' " can't break the document.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Encode ONE websocket frame. Client→server frames MUST be masked (opts.mask omitted/true); a server (the
// loopback test) passes {mask:false}. opcode: 0x1 text, 0x2 binary, 0x9 ping, 0xA pong, 0x8 close.
function wsEncode(opcode, payload, opts) {
  const mask = !opts || opts.mask !== false;
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payload.length;
  const maskBit = mask ? 0x80 : 0x00;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, maskBit | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = maskBit | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = maskBit | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([header, payload]);
  const m = randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ m[i & 3];
  return Buffer.concat([header, m, masked]);
}

// Incremental server→client frame parser. Buffers partial reads and calls onFrame(opcode, payload) once a
// full message is assembled — reassembling continuation (0x0) fragments under the initiating opcode, passing
// ping (0x9) through so the caller can pong, dropping pong (0xA), and calling onClose() on a close (0x8) frame.
function makeWsParser(onFrame, onClose) {
  let buf = Buffer.alloc(0);
  let fragOp = 0, fragParts = [];
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;                     // masked server frames are non-spec but tolerated
      if (buf.length < off + len) return;       // wait for the rest of the frame
      let payload = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(off - 4, off); const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; payload = p; }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { if (onClose) onClose(); return; }
      if (opcode === 0x9) { onFrame(0x9, payload); continue; }   // ping — caller must pong
      if (opcode === 0xA) continue;                              // pong — ignore
      if (opcode === 0x0) { fragParts.push(payload); if (fin) { onFrame(fragOp, Buffer.concat(fragParts)); fragParts = []; fragOp = 0; } continue; }
      if (!fin) { fragOp = opcode; fragParts = [payload]; continue; }
      onFrame(opcode, payload);
    }
  };
}

/* CODED failures (sidecar/speech-outcome.js): every rejection carries err.speechCode (+ err.http for a refused
   upgrade), so a caller never re-reads the message to decide whether a failure is a blip or permanent. The messages
   are unchanged (an older desk still reads them as text). Socket errors from node keep their own err.code
   (ECONNRESET, ENOTFOUND…), which the outcome maps to 'network'. */
function speechError(message, speechCode, extra) {
  const e = new Error(message);
  e.speechCode = speechCode;
  if (extra) Object.assign(e, extra);
  return e;
}
// An HTTP answer instead of the 101 upgrade. 403 is Edge refusing the token (wrong DRM version or a skewed clock).
function refusedCode(status) {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'refused';
}

/* CLOCK SKEW (upstream rany2/edge-tts drm.py handle_client_response_error): Sec-MS-GEC hashes the 5-minute window
   the CLIENT believes it is in, so a machine whose clock is off by minutes presents a token for the wrong window and
   gets 403 on every request. On a 403 that carries the server's Date header, synth retries ONCE from the server's
   clock when that clock names a different window, and remembers the offset so later calls start right. A 403 that
   persists from the server's own clock is a real refusal (the v1-token outage), never retried again. */
let clockSkewMs = 0;
function serverDateMs(res) {
  const t = Date.parse(String((res && res.headers && res.headers.date) || ''));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/* synth(text, opts) → Promise<Buffer mp3>. On ANY failure (refused upgrade, timeout, socket error, empty
   audio, a cancelled caller) it REJECTS with a coded error — the /api/tts caller catches and degrades. opts:
     voice     — Edge voice name (default: env SKYNET_EDGE_TTS_VOICE or en-US-ChristopherNeural)
     host/port — endpoint override (default speech.platform.bing.com / 443|80). Test-only.
     insecure  — use plain http upgrade instead of https (loopback test server). Test-only.
     timeoutMs — hard wall-clock per attempt (default 15000); the sidecar passes what is left of the sentence's deadline.
     signal    — an AbortSignal: the caller went away (the desk's request closed), so stop and reject 'cancelled'.
   host/port/insecure also read from SKYNET_EDGE_TTS_HOST / _PORT / _INSECURE so a spawned sidecar can be
   aimed at a loopback server without a code change. */
function synth(text, opts) {
  opts = opts || {};
  // determinism law: the wall clock is injected by the composition root (sidecar/index.js passes Date.now()).
  const nowMs = Number(opts.nowMs);
  if (!Number.isFinite(nowMs) || nowMs <= 0) return Promise.reject(speechError('edgetts.synth: opts.nowMs (injected clock) is required', 'internal_error'));
  const sentAt = nowMs + clockSkewMs;
  return synthOnce(text, opts, sentAt).catch(err => {
    const serverMs = err && err.speechCode === 'refused' && err.http === 403 ? Number(err.serverDateMs) || 0 : 0;
    if (!serverMs || (opts.signal && opts.signal.aborted) || secMsGec(serverMs) === secMsGec(sentAt)) throw err;
    clockSkewMs = serverMs - nowMs;   // this machine's clock is off: start every later call from the server's
    return synthOnce(text, opts, serverMs);
  });
}

function synthOnce(text, opts, nowMs) {
  const voice = resolveVoice(opts);
  const insecure = (opts.insecure != null) ? !!opts.insecure : truthyOn(env('EDGE_TTS_INSECURE'));
  const host = String(opts.host || env('EDGE_TTS_HOST') || 'speech.platform.bing.com').trim();
  const port = Number(opts.port || env('EDGE_TTS_PORT')) || (insecure ? 80 : 443);
  const timeoutMs = opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
  const transport = insecure ? http : https;
  const safe = xmlEscape(String(text || ''));
  const signal = opts.signal || null;
  if (signal && signal.aborted) return Promise.reject(speechError('edge cancelled', 'cancelled'));

  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const p = `/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_TOKEN}` +
      `&Sec-MS-GEC=${secMsGec(nowMs)}&Sec-MS-GEC-Version=2-${CHROMIUM_VER}&ConnectionId=${randomUUID().replace(/-/g, '')}`;
    let req, sock = null, settled = false;
    try {
      req = transport.request({
        host, port, path: p, method: 'GET', headers: {
          'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
          'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          // a fresh random MUID per connection, as the v2 Edge client sends it
          'Cookie': `muid=${randomBytes(16).toString('hex').toUpperCase()};`,
        },
      });
    } catch (e) { return reject(e); }
    // Timeout MUST tear down BOTH the request and any upgraded socket — a leaked half-open socket would keep a
    // peer (e.g. a loopback test server) from ever closing. All exits funnel through settle() so nothing lingers.
    const timer = setTimeout(() => settle(speechError('edge timeout', 'timeout')), timeoutMs);
    const onAbort = () => settle(speechError('edge cancelled', 'cancelled'));
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    function settle(err, val) {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      try { req.destroy(); } catch (_) {}
      if (sock) { try { sock.destroy(); } catch (_) {} }
      if (err) reject(err instanceof Error ? err : new Error(String(err))); else resolve(val);
    }
    req.on('error', (e) => settle(e));
    // A plain HTTP response (not a 101 upgrade) means the endpoint refused the websocket — degrade. The server's
    // Date header rides along so synth() can tell a skewed local clock from a real refusal.
    req.on('response', (res) => settle(speechError('edge upgrade refused: HTTP ' + res.statusCode, refusedCode(res.statusCode),
      { http: res.statusCode, serverDateMs: serverDateMs(res) })));
    req.on('upgrade', (res, socket) => {
      sock = socket;
      const audio = [];
      const done = (err, val) => settle(err, val);
      socket.on('error', (e) => done(e));
      // ONLY turn.end completes a clip. A CLOSE frame or a dropped connection before it is a CUT stream: resolving
      // the audio received so far served half a sentence as a whole one — and /api/tts cached it under the full
      // sentence's key, so the truncated clip replayed from disk forever. A drop used to wait out the wall clock.
      const cut = () => done(speechError('edge socket closed before turn.end', 'cut_stream'));
      socket.on('end', cut); socket.on('close', cut);
      const finish = () => { const out = Buffer.concat(audio); if (out.length) done(null, out); else done(speechError('edge: empty audio', 'empty_audio')); };
      const parse = makeWsParser((opcode, payload) => {
        if (opcode === 0x9) { try { socket.write(wsEncode(0xA, payload)); } catch (_) {} return; }   // pong the ping
        if (opcode === 0x1) {                                            // text control frame
          if (payload.toString('utf8').includes('Path:turn.end')) finish();
          return;
        }
        if (opcode === 0x2) {                                            // binary: [2-byte BE hlen][header][audio]
          if (payload.length < 2) return;
          const hlen = payload.readUInt16BE(0);
          const headerTxt = payload.subarray(2, 2 + hlen).toString('utf8');
          if (headerTxt.includes('Path:audio')) { const audioBody = payload.subarray(2 + hlen); if (audioBody.length) audio.push(audioBody); }
        }
      }, cut);
      socket.on('data', parse);
      const ts = new Date(nowMs).toISOString();   // derived from the injected clock (no ambient new Date())
      // 1) speech.config — output format + boundary metadata off (we don't consume word boundaries).
      socket.write(wsEncode(0x1, Buffer.from(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: OUTPUT_FORMAT } } } }), 'utf8')));
      // 2) the SSML request itself — Edge has no style-prompt support, so this is plain single-voice SSML.
      socket.write(wsEncode(0x1, Buffer.from(
        `X-RequestId:${randomUUID().replace(/-/g, '')}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'>${safe}</voice></speak>`, 'utf8')));
    });
    req.end();
  });
}

// Is the Edge floor enabled? Default ON; disable with SKYNET_EDGE_TTS=0 (tests need offline determinism).
function enabled() { return !truthyOff(env('EDGE_TTS')); }

// clockSkew: the offset a skewed-clock retry learned (status + tests); _resetClockSkew: tests only.
module.exports = { secMsGec, wsEncode, makeWsParser, synth, resolveVoice, enabled, DEFAULT_VOICE, OUTPUT_FORMAT,
  clockSkew: () => clockSkewMs, _resetClockSkew: () => { clockSkewMs = 0; } };
