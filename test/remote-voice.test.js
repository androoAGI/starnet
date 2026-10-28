/* node test/remote-voice.test.js — StarNet Remote voice: a paired device (the AIPI-Lite companion) speaks to the
   station and hears it answer, through the gateway's hear / speak / speech verbs.
   The Ogg container the station builds from the device's raw Opus frames is decoded by the REAL decoder the
   STT chain uses (media-service oggOpusToMono16kFloat32), so a malformed page, CRC or granule fails here. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const nodeCrypto = require('crypto');
const fs = require('fs');
const { makeRemoteVoice, opusFramesToOgg, oggCrc, wavToPcm16, decodeAdpcm, makeAdpcmEncoder, splitSentences, ADPCM_MIME, MAX_FRAMES, MAX_SPEECH_CHUNK, VOICE_TTL_MS } = require('../sidecar/remote/voice.js');
const { makeGateway } = require('../sidecar/remote/gateway.js');
const { oggOpusToMono16kFloat32 } = require('../sidecar/media-service.js');

// A one-byte Opus packet: TOC config 11 (SILK wideband, 60 ms), code 0, empty frame -> the decoder conceals it
// as 60 ms of silence. Real enough to exercise the container end to end without an encoder.
const SILK_WB_60MS = Buffer.from([0x58]);
const b64u = (b) => Buffer.from(b).toString('base64url');
function wavHeader(format, channels, rate, bits, dataLen) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(format, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(dataLen, 40);
  return h;
}
function wav16(rate, frames, fn) {
  const d = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) d.writeInt16LE(Math.round(fn(i) * 32767), i * 2);
  return Buffer.concat([wavHeader(1, 1, rate, 16, d.length), d]);
}

function parsePages(buf) {
  const pages = [];
  let o = 0;
  while (o < buf.length) {
    A.eq(buf.toString('latin1', o, o + 4), 'OggS', 'page ' + pages.length + ' starts with OggS');
    const nseg = buf[o + 26];
    let body = 0;
    for (let i = 0; i < nseg; i++) body += buf[o + 27 + i];
    const len = 27 + nseg + body;
    const page = Buffer.from(buf.subarray(o, o + len));
    const crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    pages.push({ flags: buf[o + 5], granule: Number(buf.readBigInt64LE(o + 6)), seq: buf.readUInt32LE(o + 18), crc, crcOk: oggCrc(page) === crc, len });
    o += len;
  }
  return pages;
}

(async () => {
  /* ---------- 1. the Ogg/Opus container ---------- */
  {
    const frames = Array.from({ length: 120 }, () => SILK_WB_60MS);   // 7.2 s -> spans three audio pages
    const ogg = opusFramesToOgg(frames, { frameMs: 60 });
    const pages = parsePages(ogg);
    A.ok(pages.length >= 4, 'head + tags + audio pages (' + pages.length + ')');
    A.ok(pages.every(p => p.crcOk), 'every page CRC is correct');
    A.eq(pages[0].flags, 0x02, 'first page is beginning-of-stream');
    A.eq(pages[pages.length - 1].flags & 0x04, 0x04, 'last page is end-of-stream');
    A.ok(pages.every((p, i) => p.seq === i), 'page sequence numbers run 0..n');
    A.eq(pages[pages.length - 1].granule, 120 * 60 * 48, 'final granule = total samples at 48 kHz');
    const pcm = await oggOpusToMono16kFloat32(ogg);
    A.eq(pcm.length, 120 * 60 * 16, 'the STT decoder reads back exactly 7.2 s at 16 kHz');

    const big = Buffer.alloc(600, 0x11); big[0] = 0x58;   // a packet longer than one 255-byte lacing value
    const pagesBig = parsePages(opusFramesToOgg([big, SILK_WB_60MS], { frameMs: 60 }));
    A.ok(pagesBig.every(p => p.crcOk), 'multi-segment packets keep valid pages');

    const tamper = Buffer.from(ogg); tamper[tamper.length - 1] ^= 0xff;
    A.ok(!parsePages(tamper).every(p => p.crcOk), 'a flipped byte breaks that page CRC');
  }

  /* ---------- 2. hear: ordered parts, caps, the short-utterance gate ---------- */
  {
    let t = 1000;
    const heard = [];
    const voice = makeRemoteVoice({
      now: () => t, newId: () => nodeCrypto.randomUUID(),
      transcribeOgg: async (ogg) => { heard.push(ogg); const pcm = await oggOpusToMono16kFloat32(ogg); return { ok: true, text: ' turn on the lights (' + pcm.length + ') ' }; },
      synthesize: async () => ({ ok: false, reason: 'unused' })
    });
    const part = (n, count, last, utt) => voice.hear('devA', { utt: utt || 'u1', part: n, frames: Array.from({ length: count }, () => b64u(SILK_WB_60MS)), frameMs: 60, last });

    A.ok((await part(0, 10)).ok, 'part 0 opens the utterance');
    A.ok((await part(1, 10)).ok, 'part 1 continues it');
    const skip = await part(3, 10);
    A.ok(!skip.ok && /out of order/.test(skip.error), 'a skipped part is refused: ' + skip.error);
    const again = await part(1, 10);
    A.ok(!again.ok, 'a repeated part is refused');
    const other = await voice.hear('devA', { utt: 'zz', part: 2, frames: [], last: true });
    A.ok(!other.ok, 'a part for a different utterance is refused');
    const done = await part(2, 5, true);
    A.ok(done.ok, 'the last part closes it');
    A.eq(done.data.text, 'turn on the lights (' + 25 * 960 + ')', 'transcript of exactly the 25 frames sent, trimmed');
    A.eq(done.data.ms, 25 * 60, 'its length is reported');
    A.eq(heard.length, 1, 'transcribed once');
    A.eq(heard[0].toString('latin1', 0, 4), 'OggS', 'the STT chain was handed an Ogg stream');
    A.ok(!(await part(3, 1, true)).ok, 'a closed utterance takes no more parts');

    const short = await voice.hear('devA', { utt: 'u2', part: 0, frames: [b64u(SILK_WB_60MS), b64u(SILK_WB_60MS)], frameMs: 60, last: true });
    A.ok(short.ok && short.data.text === '' && short.data.short === true, 'a 120 ms blip is not speech and never reaches STT');
    A.eq(heard.length, 1, 'still transcribed once');

    for (const junk of ['00:00:01 - 00:00:03', '...', '  ♪ ♪  ', '1, 2, 3']) {
      const v2 = makeRemoteVoice({ now: () => t, newId: () => 'x', transcribeOgg: async () => ({ ok: true, text: junk }) });
      const n = await v2.hear('devN', { utt: 'n1', part: 0, frames: Array(10).fill(b64u(SILK_WB_60MS)), frameMs: 60, last: true });
      A.ok(n.ok && n.data.text === '' && n.data.noise === junk.trim(), 'a letterless transcript is noise, not speech: ' + JSON.stringify(junk));
    }
    const v3 = makeRemoteVoice({ now: () => t, newId: () => 'x', transcribeOgg: async () => ({ ok: true, text: 'Привет, 你好' }) });
    const intl = await v3.hear('devN', { utt: 'n2', part: 0, frames: Array(10).fill(b64u(SILK_WB_60MS)), frameMs: 60, last: true });
    A.eq(intl.data.text, 'Привет, 你好', 'speech in any script is kept');
    A.ok(!(await voice.hear('devA', { utt: 'u3', part: 0, frames: ['not+base64url'] })).ok, 'a malformed frame is refused');
    A.ok(!(await voice.hear('devA', { utt: 'u3', part: 0, frames: [b64u(Buffer.alloc(2000, 1))] })).ok, 'an oversized frame is refused');
    A.ok(!(await voice.hear('devA', { utt: 'bad id!', part: 0, frames: [] })).ok, 'a bad utterance id is refused');
    A.ok(!(await voice.hear('devA', { utt: 'u4', part: 0, frames: Array.from({ length: 65 }, () => b64u(SILK_WB_60MS)) })).ok, 'too many frames in one part is refused');

    let ok = true;
    for (let p = 0; p * 64 < MAX_FRAMES && ok; p++) ok = (await voice.hear('devA', { utt: 'long', part: p, frames: Array.from({ length: 64 }, () => b64u(SILK_WB_60MS)) })).ok;
    A.ok(!ok, 'an utterance past ' + MAX_FRAMES + ' frames is cut off');
    A.ok(!(await voice.hear('devA', { utt: 'long', part: 99, frames: [], last: true })).ok, 'and forgotten');

    await voice.hear('devB', { utt: 'b1', part: 0, frames: [b64u(SILK_WB_60MS)] });
    t += VOICE_TTL_MS + 1;
    A.ok(!(await voice.hear('devB', { utt: 'b1', part: 1, frames: [], last: true })).ok, 'an abandoned utterance expires');

    // a reply lost on the relay: the device sends its FINAL part again and gets the same transcript back,
    // never a second (paid) STT call and never "start again from part 0"
    {
      let calls = 0, release;
      const gate = new Promise((r) => { release = r; });
      const v4 = makeRemoteVoice({ now: () => t, newId: () => 'x', transcribeOgg: async () => { calls++; await gate; return { ok: true, text: 'what time is it' }; } });
      const frames = Array(10).fill(b64u(SILK_WB_60MS));
      A.ok((await v4.hear('devR', { utt: 'r1', part: 0, frames, frameMs: 60 })).ok, 'retry: part 0 opens the utterance');
      const lastPart = { utt: 'r1', part: 1, frames, frameMs: 60, last: true };
      const first = v4.hear('devR', lastPart);
      const during = v4.hear('devR', lastPart);   // the retry lands while the station is still transcribing
      release();
      const [r1, r2] = await Promise.all([first, during]);
      const r3 = await v4.hear('devR', lastPart);   // and one after it finished
      A.ok(r1.ok && r1.data.text === 'what time is it', 'the final part is transcribed');
      A.ok(r2.ok && r2.data.text === 'what time is it', 'a repeat of the final part during STT gets the same transcript: ' + JSON.stringify(r2));
      A.ok(r3.ok && r3.data.text === 'what time is it', 'a repeat of the final part after STT gets the same transcript: ' + JSON.stringify(r3));
      A.eq(calls, 1, 'one STT call for three deliveries of the final part');
      A.ok(!(await v4.hear('devR', { utt: 'r1', part: 1, frames: frames.slice(0, 9), frameMs: 60, last: true })).ok, 'different audio under the same part number is not a repeat: refused');
      A.ok(!(await v4.hear('devR', { utt: 'r1', part: 2, frames, frameMs: 60, last: true })).ok, 'a later part of a closed utterance is still refused');
      A.ok((await v4.hear('devR', { utt: 'r2', part: 0, frames, frameMs: 60 })).ok, 'a new utterance opens');
      A.ok(!(await v4.hear('devR', lastPart)).ok, 'a new utterance drops the old transcript');
      A.eq(calls, 1, 'still one STT call');
      const v5 = makeRemoteVoice({ now: () => t, newId: () => 'x', transcribeOgg: async () => { calls++; return { ok: true, text: 'lights off' }; } });
      const solo = { utt: 's1', part: 0, frames, frameMs: 60, last: true };
      A.ok((await v5.hear('devS', solo)).ok && (await v5.hear('devS', solo)).data.text === 'lights off', 'a one-part utterance sent twice is one transcript');
      A.eq(calls, 2, 'a one-part repeat never reaches STT again');
      v5.forget('devS');
      A.ok((await v5.hear('devS', solo)).ok && calls === 3, 'a revoke (forget) drops the kept transcript');
      t += VOICE_TTL_MS + 1;
      A.ok((await v5.hear('devS', solo)).ok && calls === 4, 'the kept transcript expires after VOICE_TTL_MS');
      A.eq(v5._sizes().heard, 1, 'one kept transcript per device');
    }
  }

  /* ---------- 3. speak / speech: progressive (sentence by sentence), ADPCM, per device, re-askable, expiring ---------- */
  {
    let t = 5000;
    const settle = () => new Promise((r) => setImmediate(r));
    // each sentence: 1 s of a tone at speech level, as a mono 16-bit WAV
    const sentenceWav = (n) => wav16(24000, 24000, (i) => Math.sin(i / (6 + n)) * 0.2);
    // three sentences of ~150 characters: more than one breath each, so the reply is synthesised in three chunks
    const S150 = (w) => (w + ' ').repeat(30).trim().slice(0, 148) + '.';
    const LONG_REPLY = S150('alpha') + ' ' + S150('bravo') + ' ' + S150('delta');
    const gate = [];   // synthesis of sentences 2+ waits here, so the test can watch the reply grow
    let calls = 0, said = [];
    const pins = [];   // the engine each sentence was pinned to (undefined = the first sentence picks)
    const voice = makeRemoteVoice({
      now: () => t, newId: () => 'r' + (++calls),
      synthesize: async (text, o) => {
        said.push(text);
        pins.push(o && o.provider);
        if (text === 'fail') return { ok: false, reason: 'no engine' };
        if (said.length > 1) await new Promise((r) => gate.push(r));
        return { ok: true, buf: sentenceWav(said.length), mime: 'audio/wav', provider: 'local-kokoro' };
      }
    });
    A.ok(!(await voice.speak('devA', { text: '   ' })).ok, 'nothing to say is refused');
    A.ok(!(await voice.speak('devA', { text: 'x'.repeat(1201) })).ok, 'an over-long reply is refused');
    said = [];
    const failed = await voice.speak('devA', { text: 'fail' });
    A.ok(!failed.ok && /no engine/.test(failed.error), 'an engine failure is reported, not faked: ' + failed.error);

    said = [];
    const s = await voice.speak('devA', { text: LONG_REPLY });
    A.ok(s.ok && s.data.mime === ADPCM_MIME && s.data.sentences === 3, 'speak answers after the FIRST sentence, as ADPCM: ' + JSON.stringify(s.data));
    A.eq(s.data.bytes, 8 + 24000 / 2, 'the first sentence is there already: header + 1 s at 4 bits a sample (12 KB, not 48 KB)');
    const all = [];
    let off = 0;
    let c = voice.speech('devA', { id: s.data.id, offset: off });
    A.ok(c.ok && !c.data.done && c.data.data.length > 0, 'the first sentence can be fetched while the rest are synthesised');
    all.push(Buffer.from(c.data.data, 'base64url')); off += all[0].length;
    c = voice.speech('devA', { id: s.data.id, offset: off });
    A.ok(c.ok && c.data.pending === true && !c.data.done, 'caught up: "pending", not done and not an error');
    for (let guard = 0; (gate.length || said.length < 3) && guard < 200; guard++) { if (gate.length) gate.shift()(); await settle(); }
    for (let i = 0; i < 5; i++) { if (gate.length) gate.shift()(); await settle(); }
    for (let guard = 0; guard < 500; guard++) {
      c = voice.speech('devA', { id: s.data.id, offset: off, length: 5000 });
      A.ok(c.ok, 'chunk at ' + off);
      const b = Buffer.from(c.data.data, 'base64url'); all.push(b); off += b.length;
      if (c.data.done) break;
      if (!b.length) await settle();
    }
    A.eq(pins.slice(-3), [undefined, 'local-kokoro', 'local-kokoro'], 'the first sentence picks the engine; the rest of the reply is pinned to it (one speaker, one format)');
    const decoded = decodeAdpcm(Buffer.concat(all));
    A.eq(decoded.rate, 24000, 'the stream says its rate');
    A.eq(decoded.samples.length, 3 * 24000, 'all three sentences arrive, exactly 3 s of samples');
    let err = 0, sig = 0;
    const ref = [1, 2, 3].map((n) => { const w = sentenceWav(n); const out = []; for (let i = 44; i < w.length; i += 2) out.push(w.readInt16LE(i)); return out; }).flat();
    const gainRef = Math.max(...ref.map(Math.abs)) / 32767;
    for (let i = 0; i < ref.length; i++) { const want = ref[i] * (decoded.samples[i] === 0 && ref[i] === 0 ? 1 : 1); sig += want * want; }
    let peak = 0; for (const v of decoded.samples) peak = Math.max(peak, Math.abs(v));
    A.ok(peak > gainRef * 32767, 'the reply is levelled up for the small speaker (peak ' + peak + ')');
    for (let i = 1; i < decoded.samples.length; i++) err += Math.abs(decoded.samples[i] - decoded.samples[i - 1]) > 30000 ? 1 : 0;
    A.eq(err, 0, 'no clicks at the sentence joins (one encoder state for the whole reply)');
    A.ok(voice.speech('devA', { id: s.data.id, offset: off - all[all.length - 1].length }).ok, 'the last chunk can be asked for again (lost frame)');
    A.ok(voice.speech('devA', { id: s.data.id, offset: 0, length: 10 * MAX_SPEECH_CHUNK }).data.data.length <= Math.ceil(MAX_SPEECH_CHUNK * 4 / 3), 'chunk size is capped');
    A.ok(!voice.speech('devB', { id: s.data.id, offset: 0 }).ok, 'another device cannot read this reply');
    A.ok(!voice.speech('devA', { id: 'nope', offset: 0 }).ok, 'a wrong id is refused');
    A.ok(!voice.speech('devA', { id: s.data.id, offset: off + 1 }).ok, 'past the end is refused');

    said = [];
    const s2 = await voice.speak('devA', { text: 'Second reply. With a tail.' });
    A.ok(!voice.speech('devA', { id: s.data.id, offset: 0 }).ok, 'a new reply replaces the old one');
    A.ok(voice.speech('devA', { id: s2.data.id, offset: 0 }).ok, 'and is readable');
    voice.forget('devA');
    while (gate.length) { gate.shift()(); await settle(); }
    A.ok(!voice.speech('devA', { id: s2.data.id, offset: 0 }).ok, 'forget (revoke) drops it');
    said = [];
    const s3 = await voice.speak('devA', { text: 'Third.' });
    t += VOICE_TTL_MS + 1;
    A.ok(!voice.speech('devA', { id: s3.data.id, offset: 0 }).ok, 'an unread reply expires');

    // sweep() alone (what the store's own timer runs): a device that never calls again does not keep its audio in memory
    let tIdle = 1;
    const idle = makeRemoteVoice({ now: () => tIdle, newId: () => 'i1', synthesize: async () => ({ ok: true, buf: Buffer.from([0xff, 0xfb, 0x90, 0x00]), mime: 'audio/mpeg', provider: 'edge' }) });
    await idle.speak('devZ', { text: 'Hi.' });
    await idle.hear('devZ', { utt: 'z1', part: 0, frames: [b64u(SILK_WB_60MS)] });
    await idle.hear('devY', { utt: 'y1', part: 0, frames: [b64u(SILK_WB_60MS)], last: true });
    A.eq(idle._sizes(), { utterances: 1, replies: 1, heard: 1 }, 'an unfinished utterance, a reply and a kept transcript are held');
    tIdle += VOICE_TTL_MS + 1;
    A.eq(typeof idle.sweep, 'function', 'sweep is exported');
    idle.sweep();
    A.eq(idle._sizes(), { utterances: 0, replies: 0, heard: 0 }, 'sweep alone drops expired audio and transcripts, with no voice verb called');

    // ...and nobody has to remember to call it: the voice store runs sweep on its own unref'd timer, so a companion
    // unplugged mid-reply does not keep its audio or its question in memory until another device speaks
    const timers = [];
    let tTimed = 1;
    const timed = makeRemoteVoice({ now: () => tTimed, newId: () => 't1',
      setInterval: (fn, ms) => { const h = { fn, ms, unrefd: false, unref() { h.unrefd = true; return h; } }; timers.push(h); return h; },
      synthesize: async () => ({ ok: true, buf: Buffer.from([0xff, 0xfb, 0x90, 0x00]), mime: 'audio/mpeg', provider: 'edge' }) });
    A.eq(timers.map((h) => [h.ms, h.unrefd]), [[60 * 1000, true]], 'one sweep timer, once a minute, unref\'d (it never keeps the sidecar alive)');
    await timed.speak('devT', { text: 'Hi.' });
    await timed.hear('devT', { utt: 't1', part: 0, frames: [b64u(SILK_WB_60MS)] });
    await timed.hear('devU', { utt: 'u1', part: 0, frames: [b64u(SILK_WB_60MS)], last: true });
    timers[0].fn();
    A.eq(timed._sizes(), { utterances: 1, replies: 1, heard: 1 }, 'a tick drops nothing that is still fresh');
    tTimed += VOICE_TTL_MS + 1;
    timers[0].fn();
    A.eq(timed._sizes(), { utterances: 0, replies: 0, heard: 0 }, 'a tick after VOICE_TTL_MS drops it all, with no voice verb called');

    // a later sentence that fails ends the reply with what was said, and says why
    let n = 0;
    const flaky = makeRemoteVoice({ now: () => 1, newId: () => 'f1', synthesize: async () => (++n === 2 ? { ok: false, reason: 'engine crashed' } : { ok: true, buf: sentenceWav(n), mime: 'audio/wav' }) });
    const fs1 = await flaky.speak('devA', { text: LONG_REPLY });
    await settle(); await settle();
    const fc = flaky.speech('devA', { id: fs1.data.id, offset: 0 });
    A.ok(fc.data.done && /engine crashed/.test(fc.data.error || ''), 'a failed later sentence ends the reply and reports it');

    // a later sentence in a different engine's voice (same format) ends the reply there: one reply, one speaker
    let k = 0;
    const swap = makeRemoteVoice({ now: () => 1, newId: () => 'p1', synthesize: async () => (++k === 1
      ? { ok: true, buf: Buffer.from([0xff, 0xfb, 0x90, 0x00]), mime: 'audio/mpeg', provider: 'edge' }
      : { ok: true, buf: Buffer.from([0xff, 0xfb, 0x90, 0x01]), mime: 'audio/mpeg', provider: 'openrouter' }) });
    const sw = await swap.speak('devA', { text: LONG_REPLY });
    await settle(); await settle();
    const swc = swap.speech('devA', { id: sw.data.id, offset: 0 });
    A.ok(swc.data.done && swc.data.bytes === 4 && /changed mid-reply/.test(swc.data.error || ''), 'a speaker change mid-reply ends it with what the first voice said: ' + JSON.stringify({ bytes: swc.data.bytes, error: swc.data.error }));

    // the encoder itself: a 440 Hz tone survives ADPCM with good SNR
    const enc = makeAdpcmEncoder();
    const tone = new Int16Array(24000); for (let i = 0; i < tone.length; i++) tone[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 12000);
    const stream = Buffer.concat([Buffer.from('SNA1'), Buffer.from([0xc0, 0x5d, 0, 0]), enc.encode(tone), enc.flush()]);
    const back = decodeAdpcm(stream).samples;
    let e2 = 0, s2s = 0; for (let i = 0; i < tone.length; i++) { e2 += (back[i] - tone[i]) ** 2; s2s += tone[i] ** 2; }
    const snr = 10 * Math.log10(s2s / e2);
    A.ok(snr > 20, 'ADPCM keeps a speech-band tone clean: SNR ' + snr.toFixed(1) + ' dB');

    A.eq(splitSentences('Doing well. The station is up and nothing looks broken. Want a status rundown?'), ['Doing well. The station is up and nothing looks broken. Want a status rundown?'],
      'a short spoken reply is synthesised in one breath, never sentence by sentence');
    const chunks = splitSentences(LONG_REPLY);
    A.eq(chunks.length, 3, 'a long reply is cut at sentence ends into chunks under 240 characters');
    A.ok(chunks.every((c) => c.endsWith('.')), 'each chunk ends on a sentence boundary');
    const long = splitSentences('word '.repeat(120).trim());
    A.ok(long.length >= 2 && long.every((p) => p.length <= 240), 'a run-on is cut at spaces under 240 characters');
    // a decimal, a version or a price is one number, never a sentence end ("3.5" was spoken "three. five")
    const nums = splitSentences('It is 3.5 GB and version 0.13.2 is out. That is $4.99!').join(' | ');
    A.ok(nums.includes('3.5') && nums.includes('0.13.2') && nums.includes('$4.99'), 'numbers stay whole: ' + nums);
    A.ok(!/3\. 5|0\. 13|13\. 2|4\. 99/.test(nums), 'no sentence break inside a number: ' + nums);
    const numChunks = splitSentences(S150('alpha') + ' It weighs 3.5 GB. ' + S150('bravo'));
    A.ok(numChunks.length === 2 && numChunks.every((c) => c.endsWith('.')) && numChunks.join(' ').includes('3.5 GB'), 'a long reply with a decimal is still cut only at sentence ends: ' + JSON.stringify(numChunks.map((c) => c.slice(-24))));
  }

  /* ---------- 3b. speaker levelling: wavToPcm16 is the test seam for the levelling the ADPCM path applies ---------- */
  {
    const rmsOf = (w) => { let e = 0; const n = (w.length - 44) / 2; for (let i = 0; i < n; i++) { const v = w.readInt16LE(44 + i * 2) / 32768; e += v * v; } return Math.sqrt(e / n); };
    const peakOf = (w) => { let p = 0; for (let i = 44; i < w.length; i += 2) p = Math.max(p, Math.abs(w.readInt16LE(i))); return p; };
    // normal speech level (what the local engine writes): lifted toward ~-16 dBFS average for a small speaker
    const speech = wav16(24000, 24000, (i) => Math.sin(i / 9) * (i % 4000 < 2000 ? 0.09 : 0.02));
    const loud = wavToPcm16(speech);
    A.ok(rmsOf(speech) < 0.07 && rmsOf(loud) > rmsOf(speech) * 2, 'quiet speech is made louder: rms ' + rmsOf(speech).toFixed(3) + ' -> ' + rmsOf(loud).toFixed(3));
    A.ok(peakOf(loud) < 32767, 'and never hits full scale');
    const already = wav16(24000, 2400, (i) => Math.sin(i / 5) * 0.5);
    A.ok(Math.abs(rmsOf(wavToPcm16(already)) - rmsOf(already)) < 0.03, 'a take that is already loud is left about as loud');
    const hiss = wav16(24000, 2400, (i) => (i % 2 ? 0.001 : -0.001));
    A.ok(rmsOf(wavToPcm16(hiss)) <= rmsOf(hiss) * 3 + 0.0005, 'near-silence is lifted at most 3x (no hiss pumped up)');
    const mono16 = wav16(24000, 100, (i) => i / 200);
    const frames = 480;
    const fd = Buffer.alloc(frames * 2 * 4);
    for (let i = 0; i < frames; i++) { fd.writeFloatLE(0.5, i * 8); fd.writeFloatLE(-0.25, i * 8 + 4); }
    const stereoFloat = Buffer.concat([wavHeader(3, 2, 24000, 32, fd.length), fd]);
    const out = wavToPcm16(stereoFloat);
    A.ok(out && out.readUInt16LE(20) === 1 && out.readUInt16LE(22) === 1 && out.readUInt16LE(34) === 16, 'float32 stereo becomes PCM16 mono');
    A.eq(out.readUInt32LE(24), 24000, 'the sample rate is kept');
    A.eq(out.readUInt32LE(40), frames * 2, 'one 16-bit sample per frame');
    A.eq(out.readInt16LE(44), Math.round(0.125 * (0.16 / 0.125) * 32767), 'channels are averaged ((0.5 - 0.25) / 2 = 0.125), then levelled to the 0.16 target');
    A.ok(wavToPcm16(Buffer.from('not a wav at all, definitely not')) === null, 'non-WAV bytes are refused');
    const clip = Buffer.alloc(8); clip.writeFloatLE(3.0, 0); clip.writeFloatLE(-3.0, 4);
    const clipped = wavToPcm16(Buffer.concat([wavHeader(3, 1, 16000, 32, 8), clip]));
    A.ok(clipped.readInt16LE(44) === -clipped.readInt16LE(46) - 1 || clipped.readInt16LE(44) === -clipped.readInt16LE(46), 'out-of-range floats stay symmetric (no wrap): ' + clipped.readInt16LE(44) + ' / ' + clipped.readInt16LE(46));
    A.ok(clipped.readInt16LE(44) > 0.8 * 32767 && clipped.readInt16LE(44) < 32767, 'and are bent under full scale by the soft knee, never wrapped or hard-clipped');

    const v = makeRemoteVoice({ now: () => 1, newId: () => 'w1', synthesize: async () => ({ ok: true, buf: stereoFloat, mime: 'audio/wav', provider: 'local-kokoro' }) });
    const sp = await v.speak('devA', { text: 'hi' });
    A.ok(sp.ok && sp.data.mime === ADPCM_MIME && sp.data.bytes === 8 + frames / 2, 'speak turns float stereo WAV into mono ADPCM (8-byte header + 4 bits a sample)');
    const bad = makeRemoteVoice({ now: () => 1, newId: () => 'w2', synthesize: async () => ({ ok: true, buf: Buffer.from('garbage bytes here....'), mime: 'audio/wav' }) });
    A.ok(!(await bad.speak('devA', { text: 'hi' })).ok, 'an unreadable WAV is reported, not sent');
    const mp3 = makeRemoteVoice({ now: () => 1, newId: () => 'm1', synthesize: async () => ({ ok: true, buf: Buffer.from([0xff, 0xfb, 0x90, 0x00]), mime: 'audio/mpeg', provider: 'edge' }) });
    const m = await mp3.speak('devA', { text: 'hi' });
    A.ok(m.ok && m.data.mime === 'audio/mpeg' && m.data.bytes === 4, 'MP3 is passed through as-is');
  }

  /* ---------- 4. the gateway: device identity comes from the session, never from args ---------- */
  {
    const seen = [];
    const voice = {
      hear: async (deviceId, a) => { seen.push(['hear', deviceId, a.deviceId]); return { ok: true, data: { text: 'hi' } }; },
      speak: async (deviceId) => { seen.push(['speak', deviceId]); return { ok: false, error: 'no voice here' }; },
      speech: (deviceId) => { seen.push(['speech', deviceId]); return { ok: true, data: { done: true } }; }
    };
    const gw = makeGateway({ host: {}, approvals: { size: () => 0 }, voice, now: () => 1 });
    A.ok(gw.verbs.includes('hear') && gw.verbs.includes('speak') && gw.verbs.includes('speech'), 'the three voice verbs are on the menu');
    const r = await gw.call({ verb: 'hear', args: { utt: 'u', part: 0, deviceId: 'spoofed' } }, { deviceId: 'devA', sessionId: 's' });
    A.ok(r.ok && r.data.text === 'hi', 'hear answers through the gateway');
    A.eq(seen[0][1], 'devA', 'the session device id is used');
    const sp = await gw.call({ verb: 'speak', args: { text: 'x' } }, { deviceId: 'devA' });
    A.ok(!sp.ok && sp.error === 'no voice here', 'a voice error reaches the device as a sentence');
    const noCtx = await gw.call({ verb: 'speech', args: {} }, {});
    A.ok(!noCtx.ok, 'no session device, no voice');
    const bare = makeGateway({ host: {}, approvals: { size: () => 0 }, now: () => 1 });
    const none = await bare.call({ verb: 'hear', args: {} }, { deviceId: 'devA' });
    A.ok(!none.ok && /cannot do voice/.test(none.error), 'a station without voice says so');
  }

  /* ---------- 4b. every remote speech failure reaches the DEVICE typed: { error, code, terminal, outcome } ----------
     Through the REAL gateway and the REAL remote voice (and the real media-service ladder where the failure starts
     there): the gateway used to rebuild every failure as { ok:false, error } and drop the typed outcome; a thrown
     synthesize, an empty sentence, a failed or thrown transcription carried free text only. */
  {
    const { makeMediaService } = require('../sidecar/media-service.js');
    const os = require('os');
    const path = require('path');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-remote-typed-'));
    let keyThrows = false;
    const media = makeMediaService({
      workspaces: ws, fs, fsp: fs.promises,
      fetch: async () => { throw new Error('unexpected network'); },
      edgetts: { enabled: () => false, resolveVoice: () => 'v', synth: async () => Buffer.alloc(0) },
      localVoice: { status: () => ({ available: false }), defaultVoice: () => 'am_onyx', edgeVoiceFor: () => 'en-US-ChristopherNeural' },
      nativeStt: { status: () => ({ available: false }) },
      readBody: async () => '{}', readBodyBuffer: async () => Buffer.alloc(0),
      providerRuntimeKey: () => { if (keyThrows) throw new TypeError('key store blew up'); return ''; },
      providerRuntimeBaseUrl: () => '', normalizeProviderId: v => String(v || '').toLowerCase(),
      env: () => '', processEnv: {}, redact: String, logger: { error() {}, warn() {}, log() {} }, now: () => 1
    });
    const noText = await media.synthesizeStationVoice('   ');
    A.eq(noText.outcome && [noText.outcome.code, noText.outcome.terminal], ['no_text', true], 'station voice: an empty sentence is typed no_text');
    const agentNoText = await media.synthesizeForAgent({ text: '' });
    A.eq(agentNoText.outcome && agentNoText.outcome.code, 'no_text', 'agent voice: an empty sentence is typed no_text');
    keyThrows = true;
    const thrownStt = await media.transcribeForMime(Buffer.from('ogg bytes'), 'audio/ogg');
    keyThrows = false;
    A.eq(thrownStt.outcome && [thrownStt.outcome.code, thrownStt.outcome.terminal], ['internal_error', true], 'stt: a ladder that THREW is typed internal_error (terminal, named): ' + JSON.stringify(thrownStt));
    A.ok(/key store blew up/.test(String(thrownStt.reason)), 'stt: with the legacy reason kept');
    fs.rmSync(ws, { recursive: true, force: true });

    const gwWith = (voice) => makeGateway({ host: {}, approvals: { size: () => 0 }, voice, now: () => 1 });
    const frames = Array(10).fill(b64u(SILK_WB_60MS));
    // a thrown synthesize, through the real remote voice and the real gateway
    const throwing = gwWith(makeRemoteVoice({ now: () => 1, newId: () => 't1', synthesize: async () => { throw new TypeError('synth exploded'); } }));
    const t1 = await throwing.call({ verb: 'speak', args: { text: 'Say this.' } }, { deviceId: 'devA' });
    A.ok(!t1.ok && /synth exploded/.test(t1.error), 'speak: a thrown synthesize still reaches the device as a sentence: ' + t1.error);
    A.eq([t1.code, t1.terminal], ['internal_error', true], 'speak: and TYPED through the gateway (internal_error, terminal)');
    A.ok(t1.outcome && Array.isArray(t1.outcome.legs) && t1.outcome.legs[0].engine === 'station', 'speak: with the outcome and its legs');
    // the station ladder's own typed failure (the floor refused) passes through the gateway untouched
    const refusedOutcome = { ok: false, terminal: true, retryAfterMs: 0, code: 'refused', engine: 'edge', legs: [{ engine: 'edge', code: 'refused', http: 403, detail: 'edge upgrade refused: HTTP 403' }] };
    const refusing = gwWith(makeRemoteVoice({ now: () => 1, newId: () => 't2', synthesize: async () => ({ ok: false, reason: 'edge: edge upgrade refused: HTTP 403', outcome: refusedOutcome }) }));
    const t2 = await refusing.call({ verb: 'speak', args: { text: 'Say this.' } }, { deviceId: 'devA' });
    A.eq([t2.code, t2.terminal, t2.outcome && t2.outcome.legs[0].http], ['refused', true, 403], 'speak: the ladder\'s typed outcome reaches the device through the gateway');
    // nothing to say (an all-space reply), through the real remote voice and gateway
    const empty = await gwWith(makeRemoteVoice({ now: () => 1, newId: () => 't3', synthesize: async () => ({ ok: true }) })).call({ verb: 'speak', args: { text: '   ' } }, { deviceId: 'devA' });
    A.eq([empty.ok, empty.code], [false, 'no_text'], 'speak: nothing to say is typed no_text');
    // a synthesizer that answered ok with no audio is typed too, never a null outcome
    const silent = await gwWith(makeRemoteVoice({ now: () => 1, newId: () => 't4', synthesize: async () => ({ ok: true, buf: Buffer.alloc(0) }) })).call({ verb: 'speak', args: { text: 'Say this.' } }, { deviceId: 'devA' });
    A.eq(silent.code, 'empty_audio', 'speak: ok-with-no-audio is typed empty_audio');
    // hear: the STT ladder's typed outcome, and a thrown transcription
    const sttOutcome = { ok: false, terminal: true, retryAfterMs: 0, code: 'no_key', engine: 'keyed', legs: [{ engine: 'keyed', code: 'no_key', http: 0, detail: 'no Groq, OpenAI or OpenRouter credential, and no local engine' }] };
    const deaf = gwWith(makeRemoteVoice({ now: () => 1, newId: () => 'h1', transcribeOgg: async () => ({ ok: false, reason: 'no key', outcome: sttOutcome }) }));
    const h1 = await deaf.call({ verb: 'hear', args: { utt: 'h1', part: 0, frames, frameMs: 60, last: true } }, { deviceId: 'devA' });
    A.ok(!h1.ok && /could not transcribe that \(no key\)/.test(h1.error), 'hear: a failed transcription is still a sentence: ' + h1.error);
    A.eq([h1.code, h1.terminal], ['no_key', true], 'hear: and carries the STT ladder\'s typed outcome through the gateway');
    const crashing = gwWith(makeRemoteVoice({ now: () => 1, newId: () => 'h2', transcribeOgg: async () => { throw new Error('unreadable Ogg/Opus audio'); } }));
    const h2 = await crashing.call({ verb: 'hear', args: { utt: 'h2', part: 0, frames, frameMs: 60, last: true } }, { deviceId: 'devA' });
    A.ok(!h2.ok && typeof h2.code === 'string' && h2.code && h2.outcome, 'hear: a THROWN transcription is typed too (' + h2.code + ')');
  }

  /* ---------- 5. a question spoken on a voice-only device gets a reply shaped to be heard ---------- */
  {
    const { withVoiceStyle, VOICE_SURFACE } = require('../sidecar/remote/voice-style.js');
    const sent = [];
    const host = { send: async (o) => { sent.push(o); return { runId: 'r1', streamId: 's1' }; } };
    const gw = makeGateway({ host, approvals: { size: () => 0 }, now: () => 1 });
    await gw.call({ verb: 'send', args: { agentId: 'agent', text: 'what time is it', voice: true } }, { deviceId: 'devA' });
    await gw.call({ verb: 'send', args: { agentId: 'agent', text: 'from the phone' } }, { deviceId: 'devB' });
    await gw.call({ verb: 'send', args: { agentId: 'agent', text: 'sneaky', voice: 'yes' } }, { deviceId: 'devB' });
    A.eq(sent.map((o) => o.voice), [true, false, false], 'only an explicit voice:true marks the run as spoken (a phone is unchanged)');
    const sys = withVoiceStyle('You are NOVA, the overseer.');
    A.ok(sys.startsWith('You are NOVA, the overseer.') && sys.endsWith(VOICE_SURFACE), "the agent's own system prompt is kept, the voice rules follow it");
    A.ok(/first sentence/.test(VOICE_SURFACE) && /markdown/.test(VOICE_SURFACE) && /read aloud/.test(VOICE_SURFACE), 'the rules: answer first, no markdown, it is heard not read');
    A.eq(withVoiceStyle(''), VOICE_SURFACE, 'an agent with no system prompt still gets them');
    const hostSrc = fs.readFileSync(require('path').join(__dirname, '../sidecar/remote/host.js'), 'utf8');
    A.ok(hostSrc.includes('system: o.voice ? withVoiceStyle(cred.system) : cred.system'), 'host.send applies them to the run it starts');
    A.ok(/voiceTurn: o\.voice === true \|\| undefined/.test(hostSrc), 'and marks it a voice turn, so the VOICE CHAT MODEL may answer the companion (a phone is unchanged)');
    // voice-remote-channels-02: the per-reply engine pin (synthOne's { provider }) must reach the station voice, or a model
    // that finishes loading mid-reply answers sentence 2 in another engine and the reply is cut short
    const indexSrc = readSidecarSource();
    A.ok(indexSrc.includes('synthesize: (text, o) => media.synthesizeStationVoice(text, o)'), 'the sidecar passes the per-reply engine pin through to the station voice');
  }

  A.report('remote-voice');
})().catch((e) => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
