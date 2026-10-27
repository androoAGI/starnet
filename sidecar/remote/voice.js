/* sidecar/remote/voice.js — talking to the station from a paired device that has a microphone and a speaker
   (the AIPI-Lite desk companion). Three gateway verbs, each one small sealed frame, so a device on a phone
   hotspot streams its voice up and the station's voice down through the same relay as everything else:

     hear   { utt, part, frames:[b64 opus], frameMs, last }   collect one utterance in order; on `last`,
                                                               transcribe it with the station's STT chain -> { text }
     speak  { text }                                           synthesize in the station's default built-in voice
                                                               -> { id, mime, bytes, provider }
     speech { id, offset, length }                             that audio, in chunks -> { data, offset, bytes, done }

   Audio up is raw Opus frames exactly as the device's encoder made them (mono, one frame per element). The
   station wraps them in an Ogg container here — pure JS, no codec — and hands that to the SAME decoder and STT
   chain Telegram voice notes use. Audio down: a WAV reply (the local engine, or a keyed WAV leg) is levelled for
   the small speaker and re-encoded as IMA ADPCM (ADPCM_MIME, an 'SNA1' + rate stream). MP3 from the Edge floor is
   passed through as it is.

   Laws:
     · One utterance and one reply per device at a time. A new utterance replaces an unfinished one; a new reply
       replaces the old one. Nothing is written to disk and nothing is served after VOICE_TTL_MS. sweep() drops
       expired audio and transcripts; it runs on every voice verb and once a minute on its own unref'd timer (a
       device that never calls again), and a revoke (forget) drops a device's audio at once.
     · Parts must arrive in order (0, 1, 2 …). A gap or a repeat is refused, never silently stitched. The one
       exception: a repeat of the FINAL part (same utterance, part and audio — the reply was lost on the relay)
       returns the same transcript, never a second STT call. A new utterance, a revoke or VOICE_TTL_MS drops it.
     · Every size is capped: frames per utterance, bytes per frame, text per reply, bytes per chunk.
     · An utterance too short to be speech returns an empty transcript instead of reaching a paid STT leg. */
'use strict';

const nodeCrypto = require('crypto');
const { note } = require('../failopen.js');

const MAX_FRAMES = 1000;            // 60 s of 60 ms frames
const MAX_FRAME_BYTES = 1500;       // one Opus packet; the device's 16 kHz mono frames are ~100–200 bytes
const MAX_FRAMES_PER_PART = 64;
const MIN_SPEECH_MS = 300;
const MAX_SPEAK_TEXT = 1200;
const MAX_SPEECH_CHUNK = 64 * 1024;
const VOICE_TTL_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
const FRAME_MS = [10, 20, 40, 60];
const UTT_RE = /^[A-Za-z0-9_-]{1,40}$/;

/* ---------- Ogg/Opus muxing (RFC 7845) ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

function oggPage({ packets, granule, serial, seq, bos, eos }) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) { lacing.push(255); n -= 255; }
    lacing.push(n);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0;
  header[5] = (bos ? 0x02 : 0) | (eos ? 0x04 : 0);
  header.writeBigInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(seq >>> 0, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  for (let i = 0; i < lacing.length; i++) header[27 + i] = lacing[i];
  const page = Buffer.concat([header].concat(packets));
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/* frames: Buffer[] of raw Opus packets, all `frameMs` long, mono. inputRate is informational (OpusHead). */
function opusFramesToOgg(frames, o) {
  const frameMs = (o && o.frameMs) || 60;
  const inputRate = (o && o.inputRate) || 16000;
  const serial = (o && o.serial) || 0x53544e54;   // "STNT"
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;                       // version
  head[9] = 1;                       // channels
  head.writeUInt16LE(0, 10);         // pre-skip: the device stream starts at its first frame
  head.writeUInt32LE(inputRate, 12);
  head.writeInt16LE(0, 16);          // output gain
  head[18] = 0;                      // mapping family 0: mono/stereo
  const vendor = Buffer.from('starnet', 'latin1');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [oggPage({ packets: [head], granule: 0, serial, seq: 0, bos: true })];
  pages.push(oggPage({ packets: [tags], granule: 0, serial, seq: 1 }));
  const samplesPerFrame = frameMs * 48;   // Ogg/Opus granule is always 48 kHz
  let seq = 2, granule = 0, i = 0;
  if (!frames.length) pages.push(oggPage({ packets: [], granule: 0, serial, seq, eos: true }));
  while (i < frames.length) {
    const batch = [];
    let segs = 0;
    // stay well under the 255-lacing-value page limit
    while (i < frames.length && segs + Math.floor(frames[i].length / 255) + 1 <= 250 && batch.length < 50) {
      segs += Math.floor(frames[i].length / 255) + 1;
      batch.push(frames[i]);
      i++;
    }
    granule += batch.length * samplesPerFrame;
    pages.push(oggPage({ packets: batch, granule, serial, seq: seq++, eos: i >= frames.length }));
  }
  return Buffer.concat(pages);
}

/* ---------- levelling for a small speaker ----------
   The local engine writes 16-bit PCM WAV at speech level (decodeWavMono also reads 32-bit float). On a palm-sized
   speaker that is still quiet (2026-10-09, first live test), so the average is raised toward SPEAKER_RMS (at most
   MAX_GAIN) and peaks above the knee are bent smoothly under full scale instead of clipping. */
const SPEAKER_RMS = 0.16;   // ~-16 dBFS average
const MAX_GAIN = 3;         // never lift a near-silent take into hiss
const KNEE = 0.7;
function speakerLevel(x, gain) {
  const y = x * gain, a = Math.abs(y);
  if (a <= KNEE) return y;
  const over = a - KNEE, room = 1 - KNEE;
  return Math.sign(y) * (KNEE + room * (over / (over + room)));   // approaches 1, never reaches it
}
function decodeWavMono(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString('latin1', o, o + 4), size = buf.readUInt32LE(o + 4);
    const body = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      let format = body.readUInt16LE(0);
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24);   // WAVE_FORMAT_EXTENSIBLE: the sub-format
      fmt = { format, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') data = body;
    o += 8 + size + (size & 1);
  }
  if (!fmt || !data || !fmt.channels || !fmt.rate) return null;
  const frames = Math.floor(data.length / (fmt.channels * (fmt.bits / 8)));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      const at = (i * fmt.channels + ch) * (fmt.bits / 8);
      if (fmt.format === 3 && fmt.bits === 32) sum += data.readFloatLE(at);
      else if (fmt.format === 1 && fmt.bits === 16) sum += data.readInt16LE(at) / 32768;
      else return null;
    }
    mono[i] = Math.max(-1, Math.min(1, sum / fmt.channels));
  }
  return { rate: fmt.rate, samples: mono };
}
function speakerGain(mono) {
  let energy = 0;
  const frames = mono.length;
  for (let i = 0; i < frames; i++) energy += mono[i] * mono[i];
  const rms = frames ? Math.sqrt(energy / frames) : 0;
  return rms > 0 ? Math.max(1, Math.min(MAX_GAIN, SPEAKER_RMS / rms)) : 1;
}
function levelToInt16(mono, gain) {
  const out = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const v = speakerLevel(mono[i], gain);
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}
/* A test seam for the levelling the ADPCM path uses (the same decodeWavMono + speakerGain + levelToInt16): a WAV
   in, a mono 16-bit WAV out, levelled for the small speaker. null when the bytes are not a WAV this can read. */
function wavToPcm16(buf) {
  const w = decodeWavMono(buf);
  if (!w) return null;
  const fmt = { rate: w.rate };
  const pcm = levelToInt16(w.samples, speakerGain(w.samples));
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) out.writeInt16LE(pcm[i], i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + out.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(fmt.rate, 24); h.writeUInt32LE(fmt.rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(out.length, 40);
  return Buffer.concat([h, out]);
}

/* ---------- IMA ADPCM: a spoken reply at 4 bits a sample ----------
   Raw 24 kHz PCM is 48 KB/s; through the relay, one sealed request per chunk, that ran slower than real time and
   the first live replies stuttered. IMA ADPCM is 4:1 (12 KB/s), trivially decodable on the device, and good enough
   for speech. Stream: "SNA1" + rate (u32 LE) + nibbles, low nibble first, one encoder state for the whole reply. */
const ADPCM_STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282,
  1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const ADPCM_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_MIME = 'audio/x-starnet-adpcm';
function adpcmHeader(rate) { const h = Buffer.alloc(8); h.write('SNA1', 0, 'latin1'); h.writeUInt32LE(rate, 4); return h; }
function makeAdpcmEncoder() {
  let pred = 0, index = 0, half = -1;   // half: a low nibble waiting for its high nibble
  function nibble(sample) {
    const step = ADPCM_STEPS[index];
    let diff = sample - pred, code = 0;
    if (diff < 0) { code = 8; diff = -diff; }
    let delta = step >> 3;
    if (diff >= step) { code |= 4; diff -= step; delta += step; }
    if (diff >= step >> 1) { code |= 2; diff -= step >> 1; delta += step >> 1; }
    if (diff >= step >> 2) { code |= 1; delta += step >> 2; }
    pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - delta : pred + delta));
    index = Math.max(0, Math.min(88, index + ADPCM_INDEX[code & 7]));
    return code;
  }
  return {
    encode(int16) {
      const out = [];
      for (let i = 0; i < int16.length; i++) {
        const c = nibble(int16[i]);
        if (half < 0) half = c; else { out.push(half | (c << 4)); half = -1; }
      }
      return Buffer.from(out);
    },
    flush() { if (half < 0) return Buffer.alloc(0); const b = Buffer.from([half]); half = -1; return b; }
  };
}
function decodeAdpcm(buf) {   // the device's decoder, in JS: what the tests (and only the tests) use
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'SNA1') return null;
  const rate = buf.readUInt32LE(4), out = new Int16Array((buf.length - 8) * 2);
  let pred = 0, index = 0, n = 0;
  for (let i = 8; i < buf.length; i++) {
    for (const code of [buf[i] & 15, buf[i] >> 4]) {
      const step = ADPCM_STEPS[index];
      let delta = step >> 3;
      if (code & 4) delta += step;
      if (code & 2) delta += step >> 1;
      if (code & 1) delta += step >> 2;
      pred = Math.max(-32768, Math.min(32767, code & 8 ? pred - delta : pred + delta));
      index = Math.max(0, Math.min(88, index + ADPCM_INDEX[code & 7]));
      out[n++] = pred;
    }
  }
  return { rate, samples: out };
}

/* Sentences, so the first one is spoken while the rest are still being synthesised. A sentence ends only at
   terminal punctuation followed by a space or the end (the local engine's own rule, local-voice speechPieces):
   "3.5", "0.13.2" and "$4.99" are one number each, never "three. five". */
const MAX_SENTENCE = 240;
function splitSentences(text) {
  const parts = String(text).match(/[^]*?[.!?]+["')\]]*(?=\s|$)\s*|[^]+$/g) || [String(text)];
  const out = [];
  for (let p of parts) {
    p = p.trim();
    while (p.length > MAX_SENTENCE) {
      const cut = p.lastIndexOf(' ', MAX_SENTENCE);
      out.push(p.slice(0, cut > 40 ? cut : MAX_SENTENCE).trim());
      p = p.slice(cut > 40 ? cut : MAX_SENTENCE).trim();
    }
    if (p) out.push(p);
  }
  // Keep sentences together up to MAX_SENTENCE: a voice engine given ONE sentence at a time reads each as a standalone
  // announcement (careful onset, full final fall, a pause), which on the device sounded stilted and over-articulated
  // next to the desk speaking the same reply in one breath. Only a reply longer than that is cut, at sentences.
  const merged = [];
  for (const p of out) {
    if (merged.length && merged[merged.length - 1].length + 1 + p.length <= MAX_SENTENCE) merged[merged.length - 1] += ' ' + p;
    else merged.push(p);
  }
  return merged;
}

/* ---------- the verbs ---------- */

function makeRemoteVoice(deps) {
  const now = deps && deps.now;
  if (typeof now !== 'function') throw new Error('makeRemoteVoice needs an injected clock (deps.now)');
  const transcribeOgg = deps.transcribeOgg;     // async (oggBuf) -> { ok, text } | { ok:false, reason }
  const synthesize = deps.synthesize;           // async (text, { provider }?) -> { ok, buf, mime, provider } | { ok:false, reason }
  const newId = deps.newId;
  if (typeof newId !== 'function') throw new Error('makeRemoteVoice needs deps.newId');

  const utterances = new Map();   // deviceId -> { utt, next, frames, bytes, frameMs, at }
  const replies = new Map();      // deviceId -> { id, buf, mime, provider, at }
  const pendingReplies = new Map(); // deviceId -> first-chunk owner, installed before awaiting synthesis
  const heard = new Map();        // deviceId -> { utt, part, sig, p (the transcript's promise), at }: the last final part

  function sweep() {
    const t = now();
    for (const [k, u] of utterances) if (t - u.at > VOICE_TTL_MS) utterances.delete(k);
    for (const [k, r] of replies) if (t - r.at > VOICE_TTL_MS) replies.delete(k);
    for (const [k, r] of pendingReplies) if (t - r.at > VOICE_TTL_MS) pendingReplies.delete(k);
    for (const [k, h] of heard) if (t - h.at > VOICE_TTL_MS) heard.delete(k);
  }
  // A device that never calls again (unplugged mid-reply) must not keep its audio or transcript until another
  // device speaks: sweep also runs once a minute on its own timer, unref'd so it never keeps the sidecar alive.
  const every = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
  const sweepTimer = every(() => { try { sweep(); } catch (e) { note('remote.voice.sweep', e); } }, SWEEP_EVERY_MS);
  if (sweepTimer && typeof sweepTimer.unref === 'function') sweepTimer.unref();

  async function hear(deviceId, a) {
    sweep();
    const utt = String(a.utt || '');
    if (!UTT_RE.test(utt)) return { ok: false, error: 'unknown utterance' };
    const part = Number(a.part);
    if (!Number.isSafeInteger(part) || part < 0) return { ok: false, error: 'bad part number' };
    const frameMs = FRAME_MS.includes(Number(a.frameMs)) ? Number(a.frameMs) : 60;
    const raw = Array.isArray(a.frames) ? a.frames : [];
    if (raw.length > MAX_FRAMES_PER_PART) return { ok: false, error: 'too many frames in one part' };

    // The final part again, same audio: its reply was lost on the relay. Hand back the same transcript (or the
    // one still being made) instead of "start again" and a second paid STT call.
    const sig = a.last === true ? nodeCrypto.createHash('sha256').update(raw.map(String).join('.')).digest('base64url') : '';
    const h = heard.get(deviceId);
    if (sig && h && h.utt === utt && h.part === part && h.sig === sig) { h.at = now(); return h.p; }

    let u = utterances.get(deviceId);
    if (part === 0) {
      u = { utt, next: 0, frames: [], bytes: 0, frameMs, at: now() };
      utterances.set(deviceId, u);
      heard.delete(deviceId);   // a new utterance replaces the old transcript
    }
    if (!u || u.utt !== utt) return { ok: false, error: 'that utterance is not open (start again from part 0)' };
    if (part !== u.next) return { ok: false, error: 'part ' + part + ' arrived out of order (expected ' + u.next + ')' };
    if (u.frames.length + raw.length > MAX_FRAMES) { utterances.delete(deviceId); return { ok: false, error: 'that was too long to hear in one go' }; }
    for (const f of raw) {
      if (typeof f !== 'string' || !/^[A-Za-z0-9_-]+$/.test(f)) { utterances.delete(deviceId); return { ok: false, error: 'bad audio frame' }; }
      const buf = Buffer.from(f, 'base64url');
      if (!buf.length || buf.length > MAX_FRAME_BYTES) { utterances.delete(deviceId); return { ok: false, error: 'bad audio frame' }; }
      u.frames.push(buf);
      u.bytes += buf.length;
    }
    u.next = part + 1;
    u.at = now();
    if (a.last !== true) return { ok: true, data: { utt, received: u.frames.length } };

    utterances.delete(deviceId);
    const p = (async () => {
      const ms = u.frames.length * u.frameMs;
      if (ms < MIN_SPEECH_MS) return { ok: true, data: { utt, text: '', ms, short: true } };
      if (typeof transcribeOgg !== 'function') return { ok: false, error: 'this station cannot transcribe speech' };
      const ogg = opusFramesToOgg(u.frames, { frameMs: u.frameMs });
      let r;
      try { r = await transcribeOgg(ogg); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
      if (!r || !r.ok) return { ok: false, error: 'the station could not transcribe that (' + String((r && r.reason) || 'no transcription').slice(0, 160) + ')' };
      // Whisper turns room noise into timestamps or punctuation ("00:00:01 - 00:00:03", first live test): a
      // transcript with no letters in any script is not speech, and must not become a run on the overseer.
      const text = String(r.text || '').trim();
      if (!/\p{L}/u.test(text)) return { ok: true, data: { utt, text: '', ms, noise: text.slice(0, 80) } };
      return { ok: true, data: { utt, text, ms } };
    })();
    heard.set(deviceId, { utt, part, sig, p, at: now() });
    return p;
  }

  // provider: the engine the reply's first sentence came from. Later sentences are pinned to it, so a voice model
  // that finishes loading mid-reply (or a flaky leg) never changes the speaker or the format halfway through.
  async function synthOne(text, provider) {
    let r;
    try { r = await synthesize(text, provider ? { provider } : undefined); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    // the typed SpeechOutcome rides along (sidecar/speech-outcome.js): the device is told WHICH failure, not only its text
    if (!r || !r.ok || !Buffer.isBuffer(r.buf) || !r.buf.length) return { ok: false, reason: String((r && r.reason) || 'no audio'), outcome: (r && r.outcome) || null };
    return r;
  }

  // Encode one synthesised sentence onto the reply. WAV becomes levelled ADPCM; MP3 (the Edge floor) is
  // appended as it is (MP3 frames concatenate). A later sentence in a different format, or from a different
  // engine (another speaker), ends the reply there: silence beats a voice that changes halfway.
  function append(rec, r) {
    if (rec.provider && String(r.provider || '') !== rec.provider) return 'the station voice changed mid-reply';
    const mime = String(r.mime || '');
    if (/wav/.test(mime)) {
      if (rec.mime !== ADPCM_MIME) return 'the voice changed format mid-reply';
      const w = decodeWavMono(r.buf);
      if (!w) return 'the station\'s voice produced audio this device cannot play';
      if (rec.rate && w.rate !== rec.rate) return 'the voice changed sample rate mid-reply';
      if (!rec.rate) { rec.rate = w.rate; rec.gain = speakerGain(w.samples); rec.enc = makeAdpcmEncoder(); rec.parts.push(adpcmHeader(w.rate)); }
      rec.parts.push(rec.enc.encode(levelToInt16(w.samples, rec.gain)));
    } else {
      if (rec.mime !== mime) return 'the voice changed format mid-reply';
      rec.parts.push(r.buf);
    }
    rec.buf = Buffer.concat(rec.parts);
    rec.parts = [rec.buf];
    rec.at = now();
    return '';
  }

  async function speak(deviceId, a) {
    sweep();
    const text = String(a.text == null ? '' : a.text).replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, error: 'nothing to say' };
    if (text.length > MAX_SPEAK_TEXT) return { ok: false, error: 'that is too long to say in one reply (' + MAX_SPEAK_TEXT + ' characters max)' };
    if (typeof synthesize !== 'function') return { ok: false, error: 'this station has no voice' };
    const sentences = splitSentences(text);
    // Ownership starts at admission. An older first chunk may finish after a replacement or device revocation;
    // it must never publish audio or start synthesising the rest of that now-abandoned reply.
    const pending = { at: now() };
    pendingReplies.set(deviceId, pending);
    replies.delete(deviceId);
    const first = await synthOne(sentences[0]);
    if (pendingReplies.get(deviceId) !== pending || now() - pending.at > VOICE_TTL_MS) {
      if (pendingReplies.get(deviceId) === pending) pendingReplies.delete(deviceId);
      return { ok: false, error: 'that reply was replaced, forgotten, or expired' };
    }
    pendingReplies.delete(deviceId);
    if (!first.ok) {
      const out = { ok: false, error: 'the station could not speak that (' + first.reason.slice(0, 160) + ')' };
      if (first.outcome) { out.code = first.outcome.code; out.terminal = !!first.outcome.terminal; out.outcome = first.outcome; }
      return out;
    }
    const firstMime = String(first.mime || '');
    const rec = { id: String(newId()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40), mime: /wav/.test(firstMime) ? ADPCM_MIME : firstMime,
      provider: String(first.provider || ''), parts: [], buf: Buffer.alloc(0), rate: 0, gain: 1, enc: null, complete: false, error: '', at: now() };
    const err = append(rec, first);
    if (err) return { ok: false, error: err };
    replies.set(deviceId, rec);
    // the rest, in order, while the device is already playing the first sentence
    (async () => {
      for (let i = 1; i < sentences.length; i++) {
        if (replies.get(deviceId) !== rec) return;   // replaced or forgotten: stop spending on it
        const r = await synthOne(sentences[i], rec.provider);
        if (replies.get(deviceId) !== rec || now() - rec.at > VOICE_TTL_MS) {
          if (replies.get(deviceId) === rec) replies.delete(deviceId);
          return;
        }
        if (!r.ok) { rec.error = r.reason.slice(0, 160); rec.code = r.outcome ? r.outcome.code : ''; break; }
        const e = append(rec, r);
        if (e) { rec.error = e; break; }
      }
      if (rec.enc) { const tail = rec.enc.flush(); if (tail.length) { rec.buf = Buffer.concat([rec.buf, tail]); rec.parts = [rec.buf]; } }
      rec.complete = true;
      rec.at = now();
    })().catch((e) => { rec.error = String((e && e.message) || e).slice(0, 160); rec.complete = true; });
    return { ok: true, data: { id: rec.id, mime: rec.mime, bytes: rec.buf.length, provider: rec.provider, sentences: sentences.length } };
  }

  // A reply grows while it is synthesised: an empty chunk with done:false means "more is coming, ask again".
  function speech(deviceId, a) {
    sweep();
    const r = replies.get(deviceId);
    if (!r || r.id !== String(a.id || '')) return { ok: false, error: 'that reply is gone (ask again)' };
    const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
    const length = Math.max(1, Math.min(MAX_SPEECH_CHUNK, Math.floor(Number(a.length) || MAX_SPEECH_CHUNK)));
    if (offset > r.buf.length) return { ok: false, error: 'past the end of that reply' };
    const chunk = r.buf.subarray(offset, offset + length);
    const done = r.complete && offset + chunk.length >= r.buf.length;
    // kept after the last chunk: a frame lost on the relay can be asked for again until the TTL or the next reply
    r.at = now();
    return { ok: true, data: { id: r.id, offset, bytes: r.buf.length, data: chunk.toString('base64url'), done, pending: !done && !chunk.length, error: r.error || undefined, code: r.code || undefined } };
  }

  function forget(deviceId) { utterances.delete(deviceId); replies.delete(deviceId); pendingReplies.delete(deviceId); heard.delete(deviceId); }

  return { hear, speak, speech, forget, sweep, _sizes: () => ({ utterances: utterances.size, replies: replies.size, heard: heard.size }) };
}

module.exports = { makeRemoteVoice, opusFramesToOgg, oggCrc, wavToPcm16, decodeAdpcm, makeAdpcmEncoder, splitSentences, ADPCM_MIME, MAX_FRAMES, MAX_SPEECH_CHUNK, MAX_SPEAK_TEXT, VOICE_TTL_MS };
