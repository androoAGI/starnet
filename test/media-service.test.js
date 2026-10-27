'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  makeMediaService, pcmToWav, float32PcmToWav, wavToMono16kFloat32, oggOpusToMono16kFloat32, sttMultipartBody
} = require('../sidecar/media-service.js');

// 80 ms mono Opus tone in a real Ogg container. Generated once with libopus; checked in as text so the
// test proves the shipped WASM decoder without requiring ffmpeg on a developer or release machine.
const OGG_OPUS = Buffer.from(
  'T2dnUwACAAAAAAAAAAC36uPZAAAAACvBgEwBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAALfq49kBAAAAq9xArgE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAAQ4EAAAAAAAALfq49kCAAAABkcHRAVFOzI3H3iCAbdsRyTqAkZv+rYDjIE01uheAesbsV7vyXgY8gqzIUHM0aaf4Yqbhp1rgeoEnutAiitHUCgJ0EZTAHRNtp96w/QA+XijP/esmIUDXCYKV5+K8o09bIVMwBPqQbZh53f7dxTMWHWvNRLH9wshBXhb4UZ4svXifY+1ePppKdPLeJujElFFAKzjUZtzIbzvkYf9xoYkZjRJyLfYYOyuGQ16hsiSDl+FlUmChd1GPvaUKYt4m6MRtBy/UiiBezmWuWR9rnAX1N7fcFaVORBbFQ/O0UoSEsPPQg+XUCym9WlXzffTW861RJUCeAZq5oQF8SsdLTmsuzQSGw7LXdkN4omo7g5at9f8/g==',
  'base64'
);

const roots = [];

async function make(overrides) {
  const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-media-'));
  roots.push(workspaces);
  const opts = Object.assign({
    workspaces,
    fs,
    fsp,
    fetch: async () => { throw new Error('unexpected network'); },
    edgetts: { enabled: () => false, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => Buffer.alloc(0) },
    localVoice: {
      status: () => ({ available: false }),
      defaultVoice: () => 'af_heart',
      edgeVoiceFor: () => 'en-US-ChristopherNeural',
      synthesize: async () => { throw new Error('local unavailable'); },
      transcribe: async () => ''
    },
    nativeStt: { status: () => ({ available: false }), recognize: async () => ({ ok: false, text: '' }) },
    readBody: async () => '{}',
    readBodyBuffer: async () => Buffer.alloc(0),
    providerRuntimeKey: () => '',
    providerRuntimeBaseUrl: () => '',
    normalizeProviderId: value => String(value || '').toLowerCase(),
    getRuntimeKey: () => '',
    env: () => '',
    processEnv: {},
    redact: String,
    logger: { error() {}, warn() {} },
    now: () => 1234,
    randomUUID: () => 'uuid',
    randomBytes: n => Buffer.alloc(n, 0xab)
  }, overrides || {});
  return makeMediaService(opts);
}

async function invokeTts(overrides, body) {
  const service = await make(Object.assign({}, overrides || {}, {
    readBody: async () => JSON.stringify(body || {})
  }));
  const response = { status: 0, headers: {}, body: Buffer.alloc(0) };
  await service.handleTts({}, {
    headersSent: false,
    writeHead(status, headers) { response.status = status; response.headers = headers || {}; this.headersSent = true; },
    end(value) { response.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value || '')); }
  });
  return response;
}

(async () => {
  // PCM wrapping and the local-ASR decoder remain exact inverses at their shared boundary.
  const pcm = Buffer.alloc(4 * 2 * 2);
  for (let frame = 0; frame < 4; frame++) {
    const sample = frame < 2 ? 32767 : -32768;
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const wav = pcmToWav(pcm, 32000, 2);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 32000);
  assert.equal(wav.readUInt16LE(22), 2);
  const decoded = wavToMono16kFloat32(wav);
  assert.equal(decoded.length, 2, '32 kHz stereo is downsampled to 16 kHz mono');
  assert.ok(decoded[0] > 0.99);
  assert.equal(decoded[1], -1);
  assert.equal(wavToMono16kFloat32(Buffer.from('not wav')), null);

  const captured = new Float32Array([1, -1, 0.5, -0.5]);
  const nativeWav = float32PcmToWav(Buffer.from(captured.buffer), 16000);
  const nativeDecoded = wavToMono16kFloat32(nativeWav);
  assert.equal(nativeDecoded.length, captured.length, 'a click-bounded Float32 take becomes a complete mono WAV');
  assert.ok(nativeDecoded[0] > 0.99 && nativeDecoded[1] === -1, 'native WAV conversion preserves sample polarity and bounds');
  assert.equal(float32PcmToWav(Buffer.from([1, 2, 3]), 16000), null, 'a partial Float32 sample is rejected');

  const decodedOgg = await oggOpusToMono16kFloat32(OGG_OPUS);
  assert.ok(decodedOgg.length >= 1200 && decodedOgg.length <= 1500, 'real Ogg/Opus is decoded and resampled to 16 kHz');
  assert.ok(decodedOgg.some(sample => Math.abs(sample) > 0.01), 'decoded Ogg/Opus contains audible PCM');

  // Multipart construction preserves the audio byte-for-byte and names the Whisper model/file parts.
  const audio = Buffer.from([0, 1, 2, 255, 13, 10]);
  const multipart = sttMultipartBody(audio, 'clip.webm', 'audio/webm', { model: 'whisper-test' }, n => Buffer.alloc(n, 7));
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----StarNetSTT/);
  assert.ok(multipart.body.includes(Buffer.from('name="model"')));
  assert.ok(multipart.body.includes(Buffer.from('whisper-test')));
  assert.ok(multipart.body.includes(Buffer.from('name="file"; filename="clip.webm"')));
  assert.ok(multipart.body.includes(audio), 'multipart body carries the original audio bytes');

  // No credentials and no local engine is an honest terminal capability result.
  const keyless = await make();
  assert.deepEqual(await keyless.transcribeAudioBuffer(Buffer.from('audio'), 'webm'), { ok: false, reason: 'no key' });
  assert.deepEqual(keyless.sttStatus(), {
    available: false, preferred: 'none', cloud: false, local: false, native: false
  });
  assert.match((await keyless.synthesizeForAgent({ text: 'hello' })).reason, /edge: disabled/);

  const nativeOnly = await make({ nativeStt: { status: () => ({ available: true }), recognize: async () => ({ ok: true, text: 'native' }) } });
  assert.deepEqual(nativeOnly.sttStatus(), {
    available: true, preferred: 'native', cloud: false, local: false, native: true
  });

  let nativeParams = null;
  const capturedPcm = Buffer.from(new Float32Array([0.2, -0.2]).buffer);
  const capturedNative = await make({
    readBodyBuffer: async () => capturedPcm,
    nativeStt: {
      status: () => ({ available: true }),
      recognize: async params => { nativeParams = params; return { ok: true, text: 'two clicks' }; }
    }
  });
  const nativeResponse = { status: 0, body: '' };
  await capturedNative.handleNativeStt({}, {
    destroyed: false, writableEnded: false, headersSent: false,
    on() {},
    writeHead(status) { nativeResponse.status = status; this.headersSent = true; },
    end(value) { nativeResponse.body = String(value || ''); this.writableEnded = true; }
  });
  assert.equal(nativeResponse.status, 200, 'captured native STT keeps the media 200-always contract');
  assert.equal(JSON.parse(nativeResponse.body).text, 'two clicks');
  assert.equal(nativeParams.audioWav.toString('ascii', 0, 4), 'RIFF', 'the native recognizer receives the captured take as WAV');

  {
    let signal, release;
    const service = await make({
      readBodyBuffer: async () => capturedPcm,
      localVoice: { transcribe: async (_pcm, opts) => {
        signal = opts.signal;
        return new Promise(resolve => { release = resolve; });
      } }
    });
    const response = new (require('node:events').EventEmitter)();
    response.destroyed = false; response.writableEnded = false;
    response.writeHead = () => assert.fail('must not write to a disconnected preview');
    response.end = () => assert.fail('must not send a stale preview');
    const pending = service.handleLocalVoiceTranscribe({}, response);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, false);
    response.destroyed = true; response.emit('close');
    assert.equal(signal.aborted, true, 'cancelling a preview reaches the ASR queue');
    release('stale preview'); await pending;
  }

  // A keyed TTS failure falls through to the free Edge floor instead of committing a hard failure.
  let ttsFetches = 0;
  const edge = await make({
    providerRuntimeKey: provider => provider === 'openrouter' ? 'key' : '',
    fetch: async url => {
      ttsFetches++;
      assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech');
      return { ok: false, status: 402, text: async () => 'credits exhausted' };
    },
    edgetts: { enabled: () => true, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => Buffer.from('edge-mp3') }
  });
  const spoken = await edge.synthesizeForAgent({ text: 'fallback line', voice: 'Umbriel' });
  assert.equal(ttsFetches, 1);
  assert.equal(spoken.ok, true);
  assert.equal(spoken.provider, 'edge');
  assert.equal(spoken.buf.toString(), 'edge-mp3');

  // Dedicated ASR preserves the Groq -> OpenAI order and continues after a failed first tier.
  const asrCalls = [];
  const asr = await make({
    providerRuntimeKey: provider => provider === 'groq' ? 'groq-key' : (provider === 'openai' ? 'openai-key' : ''),
    providerRuntimeBaseUrl: provider => 'https://' + provider + '.invalid/v1',
    fetch: async (url, init) => {
      asrCalls.push({ url, init });
      if (url.startsWith('https://groq.invalid/')) return { ok: false, status: 503, text: async () => 'busy' };
      return { ok: true, status: 200, json: async () => ({ text: 'heard by openai' }) };
    }
  });
  assert.deepEqual(await asr.transcribeAudioBuffer(audio, 'webm'), { ok: true, text: 'heard by openai' });
  assert.equal(asrCalls.length, 2);
  assert.match(asrCalls[0].url, /groq\.invalid\/v1\/audio\/transcriptions$/);
  assert.match(asrCalls[1].url, /openai\.invalid\/v1\/audio\/transcriptions$/);
  assert.ok(asrCalls[0].init.body.includes(audio));
  assert.ok(asrCalls[1].init.body.includes(Buffer.from('whisper-1')));

  // The keyless local floor receives decoded/resampled Float32 PCM, never compressed container bytes.
  let localPcm = null;
  const local = await make({
    localVoice: {
      status: () => ({ available: true }),
      transcribe: async bytes => { localPcm = Buffer.from(bytes); return 'local words'; },
      defaultVoice: () => 'af_heart', edgeVoiceFor: () => 'en-US-ChristopherNeural',
      synthesize: async () => { throw new Error('unused'); }
    }
  });
  assert.deepEqual(await local.transcribeAudioBuffer(wav, 'wav'), { ok: true, text: 'local words' });
  assert.deepEqual(local.sttStatus(), {
    available: true, preferred: 'local', cloud: false, local: true, native: false
  });
  assert.equal(localPcm.length, decoded.length * 4);
  localPcm = null;
  assert.deepEqual(await local.transcribeAudioBuffer(OGG_OPUS, 'ogg'), { ok: true, text: 'local words' });
  assert.equal(localPcm.length, decodedOgg.length * 4, 'Telegram Ogg/Opus reaches local ASR as 16 kHz Float32 PCM');
  assert.match((await local.transcribeAudioBuffer(Buffer.from('compressed'), 'webm')).reason, /local engine cannot decode webm/);

  // Local Live chooses its serving engine once. An Edge-pinned session bypasses Kokoro, while a
  // Kokoro-pinned session fails silent instead of changing to a different voice for one sentence.
  {
    let localCalls = 0, edgeCalls = 0, edgeVoice = '';
    const engines = {
      localVoice: {
        status: () => ({ available: true }), defaultVoice: () => 'am_onyx',
        edgeVoiceFor: () => 'en-US-ChristopherNeural', transcribe: async () => '',
        synthesize: async () => { localCalls++; throw new Error('temporary local failure'); }
      },
      edgetts: {
        enabled: () => true, resolveVoice: () => 'en-US-ChristopherNeural',
        synth: async (_text, options) => { edgeCalls++; edgeVoice = options.voice; return Buffer.from('edge-audio'); }
      }
    };
    const edgePinned = await invokeTts(engines, { text: 'same speaker', local: true, localVoice: 'am_onyx', localEngine: 'edge' });
    assert.equal(edgePinned.headers['X-Voice-Provider'], 'edge:en-US-ChristopherNeural', 'an Edge-pinned session names and keeps its mapped voice');
    assert.equal(localCalls, 0, 'an Edge-pinned session never probes Kokoro between sentences');
    assert.equal(edgeVoice, 'en-US-ChristopherNeural', 'the pinned Edge engine uses the selected voice mapping');

    const localPinned = await invokeTts(engines, { text: 'do not switch', local: true, localVoice: 'am_onyx', localEngine: 'local-kokoro' });
    assert.match(localPinned.headers['Content-Type'], /application\/json/, 'a failed Kokoro-pinned chunk degrades without returning another voice');
    assert.equal(edgeCalls, 1, 'a Kokoro-pinned session never falls through to Edge mid-conversation');
  }

  // The companion's voice (remote/voice.js `speak`) never waits on a first-time voice-model download: a cold
  // built-in engine starts loading in the background and THIS reply speaks in the mapped Edge voice at once.
  // A reply that began in one engine is pinned to it (the provider option), so it never changes speaker.
  {
    let tts = 'cold', localFails = false, localCalls = 0, edgeCalls = 0;
    const warms = [];
    const station = await make({
      localVoice: {
        status: () => ({ available: true, tts }), defaultVoice: () => 'am_onyx', ttsCached: () => false,
        edgeVoiceFor: () => 'en-US-ChristopherNeural', transcribe: async () => '',
        warm: async opts => { warms.push(opts); return {}; },
        synthesize: async () => { localCalls++; if (localFails) throw new Error('engine hiccup'); return Buffer.from('kokoro-wav'); }
      },
      edgetts: { enabled: () => true, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => { edgeCalls++; return Buffer.from('edge-mp3'); } }
    });
    const first = await station.synthesizeStationVoice('hello there');
    assert.equal(first.provider, 'edge', 'a cold voice model never blocks the reply: the mapped Edge voice answers');
    assert.equal(localCalls, 0, 'the model download is not waited on');
    assert.deepEqual(warms, [{ asr: false }], 'the voice model starts loading in the background (speech only)');
    tts = 'loading';
    assert.equal((await station.synthesizeStationVoice('still loading')).provider, 'edge', 'while it loads, Edge keeps answering');
    assert.equal(warms.length, 1, 'a load already under way is not started again');
    tts = 'ready';
    assert.equal((await station.synthesizeStationVoice('now ready')).provider, 'local-kokoro', 'once ready, the built-in engine speaks');
    assert.equal((await station.synthesizeStationVoice('same reply', { provider: 'edge' })).provider, 'edge', 'a reply that began in Edge stays in Edge');
    assert.equal(localCalls, 1, 'an Edge-pinned sentence never probes the built-in engine');
    localFails = true;
    const edgeBefore = edgeCalls;
    const pinned = await station.synthesizeStationVoice('do not switch', { provider: 'local-kokoro' });
    assert.equal(pinned.ok, false, 'a built-in-pinned sentence that fails is reported, not re-voiced');
    assert.equal(edgeCalls, edgeBefore, 'and never falls through to a different speaker');
  }

  // A voice model already ON DISK is not a download. The engine starts cold on every launch; with the model cached
  // it loads in seconds, so the companion's first reply waits for it: the same speaker as every later reply, the
  // text stays on this machine, and an offline station without keys still speaks. A failed load says so.
  {
    let tts = 'cold', localCalls = 0, edgeCalls = 0, edgeOn = true;
    const warms = [];
    const station = await make({
      localVoice: {
        status: () => ({ available: true, tts }), defaultVoice: () => 'am_onyx', ttsCached: () => true,
        edgeVoiceFor: () => 'en-US-ChristopherNeural', transcribe: async () => '',
        warm: async opts => { warms.push(opts); return {}; },
        synthesize: async () => { localCalls++; return Buffer.from('kokoro-wav'); }
      },
      edgetts: { enabled: () => edgeOn, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => { edgeCalls++; return Buffer.from('edge-mp3'); } }
    });
    const first = await station.synthesizeStationVoice('first reply after a launch');
    assert.equal(first.provider, 'local-kokoro', 'a cold engine whose model is on disk loads it and speaks');
    assert.equal(edgeCalls, 0, 'the reply is not sent to Edge while the built-in voice can answer');
    tts = 'loading';
    assert.equal((await station.synthesizeStationVoice('while it loads')).provider, 'local-kokoro', 'a disk load under way is waited on too');
    assert.equal(localCalls, 2);
    assert.equal(warms.length, 0, 'no separate background load is started');
    tts = 'error'; edgeOn = false;
    const failedLoad = await station.synthesizeStationVoice('after a failed load');
    assert.equal(failedLoad.ok, false);
    assert.match(failedLoad.reason, /local: voice model failed to load/, 'a failed load is named as a failure');
    assert.doesNotMatch(failedLoad.reason, /still loading/, 'never as "still loading"');
    assert.equal(localCalls, 2, 'a failed load is not retried inside the reply (it may need a download)');
    assert.deepEqual(warms, [{ asr: false }], 'it is retried in the background instead');
  }

  // Edge is tried ONCE per station-voice sentence (in the mapped voice), never a second time in its default voice
  // through the keyed ladder's own Edge floor; a keyed-pinned reply tries only that provider.
  {
    let edgeCalls = 0, fetches = 0;
    const offline = await make({
      localVoice: {
        status: () => ({ available: false }), defaultVoice: () => 'am_onyx',
        edgeVoiceFor: () => 'en-US-ChristopherNeural', transcribe: async () => '', synthesize: async () => { throw new Error('unused'); }
      },
      edgetts: { enabled: () => true, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => { edgeCalls++; throw new Error('offline'); } },
      providerRuntimeKey: provider => provider === 'openrouter' ? 'key' : '',
      fetch: async () => { fetches++; return { ok: false, status: 402, text: async () => 'credits exhausted' }; }
    });
    const failed = await offline.synthesizeStationVoice('hello');
    assert.equal(failed.ok, false);
    assert.equal(edgeCalls, 1, 'an offline station waits through one Edge attempt, not two');
    assert.equal(fetches, 1, 'the keyed ladder still gets its turn');
    assert.match(failed.reason, /edge: offline/);
    fetches = 0; edgeCalls = 0;
    const keyedPin = await offline.synthesizeStationVoice('same speaker', { provider: 'gemini' });
    assert.equal(keyedPin.ok, false, 'a reply pinned to a keyed provider this station cannot reach fails');
    assert.equal(fetches + edgeCalls, 0, 'without paying another provider or switching to Edge');
  }

  // Over the cap is REFUSED, never truncated (sweep/voice 2026-10-20): /api/tts spoke the first ~1200 characters of a
  // longer script and answered 200 audio, so the caller had no way to know the rest was never said.
  {
    const said = [];
    const edgeOn = { enabled: () => true, resolveVoice: () => 'en-US-ChristopherNeural', synth: async (t) => { said.push(t); return Buffer.from('edge-mp3'); } };
    const long = 'A sentence that pads the script out. '.repeat(40).trim();
    const over = await invokeTts({ edgetts: edgeOn }, { text: long });
    let j = {}; try { j = JSON.parse(over.body.toString()); } catch (_) { j = { servedAudioBytes: over.body.length }; }
    assert.equal(over.status, 200, 'the 200-always contract holds for a refusal');
    assert.equal(j.fallback, true, 'a ' + long.length + '-character script is refused, not served');
    assert.match(String(j.reason), /cap/, 'the refusal names the cap: ' + j.reason);
    assert.equal(said.length, 0, 'no engine was asked to speak a truncated head of the script');
    const atCap = await invokeTts({ edgetts: edgeOn }, { text: 'x'.repeat(1199) + '.' });
    assert.match(String(atCap.headers['Content-Type']), /audio/, 'a script exactly at the cap is still spoken');
    assert.equal(said[0].length, 1200, 'and spoken whole');
  }

  // One sentence, one paid synthesis (sweep/voice 2026-10-20): the desk gives up on a request at 30s and retries,
  // while the sidecar's keyed call runs on for up to 60s — so a provider slower than 30s was paid TWICE for the same
  // sentence (live: keyed calls at 19 ms and 30432 ms, sentence played at 61.6 s from the first call's cache). A
  // request for a clip whose synthesis is already in flight joins it instead of buying another.
  {
    let calls = 0, release = null;
    const gate = new Promise(r => { release = r; });
    const slow = {
      providerRuntimeKey: provider => provider === 'openrouter' ? 'key' : '',
      fetch: async () => { calls++; await gate; return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('keyed-mp3') }; }
    };
    const a = { status: 0, headers: {}, body: Buffer.alloc(0) }, b = { status: 0, headers: {}, body: Buffer.alloc(0) };
    const res = r => ({ headersSent: false, writeHead(s, h) { r.status = s; r.headers = h || {}; this.headersSent = true; }, end(v) { r.body = Buffer.isBuffer(v) ? v : Buffer.from(String(v || '')); } });
    const shared = await make(Object.assign({}, slow, { readBody: async () => JSON.stringify({ text: 'one slow sentence' }) }));
    const first = shared.handleTts({}, res(a));
    await new Promise(r => setTimeout(r, 20));
    const second = shared.handleTts({}, res(b));   // the desk's retry, while the first synthesis is still running
    await new Promise(r => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1, 'a retry for a clip already being synthesized does not pay for it again (calls=' + calls + ')');
    assert.equal(b.body.toString(), 'keyed-mp3', 'the retry is answered with the one synthesis');
    assert.equal(a.body.toString(), 'keyed-mp3', 'and so is the original request');
  }

  // The offline (Kokoro) leg sweeps the voice cache like every other leg (memory lane 2026-10-20): its miss branch
  // wrote a clip per new sentence and never called the sweep, so the folder grew ~120 MB a day at 500 sentences.
  {
    let n = 0;
    const service = await make({
      readBody: async () => JSON.stringify({ text: 'kokoro sentence ' + (++n), local: true, localVoice: 'af_heart', localEngine: 'local-kokoro' }),
      localVoice: {
        status: () => ({ available: true }), defaultVoice: () => 'af_heart', edgeVoiceFor: () => 'en-US-ChristopherNeural',
        transcribe: async () => '', synthesize: async () => Buffer.from('kokoro-wav')
      }
    });
    const dir = path.join(roots[roots.length - 1], 'voice-cache');
    for (let i = 0; i < 640; i++) await fsp.writeFile(path.join(dir, 'seed-' + i + '.mp3'), 'x');   // over the 600-clip cap
    let served = 0;
    for (let i = 0; i < 32; i++) {
      const r = { headers: {} };
      await service.handleTts({}, { headersSent: false, writeHead(s, h) { r.headers = h || {}; }, end(v) { if (r.headers['X-Voice-Cache'] === 'miss' && String(v) === 'kokoro-wav') served++; } });
    }
    assert.equal(served, 32, 'every request was a Kokoro cache miss that served audio');
    let files = (await fsp.readdir(dir)).length;
    for (let i = 0; i < 100 && files > 480; i++) { await new Promise(r => setTimeout(r, 10)); files = (await fsp.readdir(dir)).length; }
    assert.ok(files <= 480, 'the 32nd Kokoro miss sweeps the cache back under its cap (' + files + ' clips left of ' + (640 + 32) + ')');
  }

  // A THROWN /api/tts handler still answers the 200 media envelope the desk reads: {fallback:true, reason}. It used to
  // write {error} only, so the desk found no reason, saw 'http 200', and retried a crash as if it were a network blip.
  {
    const service = await make({ redact: s => String(s).replace(/sk-[A-Za-z0-9-]+/g, '[redacted]') });
    const r = { status: 0, headers: {}, body: '' };
    service.ttsFailOpenPolicy({ headersSent: false, writeHead(s, h) { r.status = s; r.headers = h || {}; }, end(v) { r.body = String(v || ''); } },
      new Error('Cannot read properties of undefined (key sk-or-v1-LEAK)'));
    const j = JSON.parse(r.body);
    assert.equal(r.status, 200, 'a crashed TTS handler keeps the 200-always contract');
    assert.equal(j.fallback, true, 'the crash body is the fallback envelope the desk reads');
    assert.match(String(j.reason), /^tts failure: Cannot read properties of undefined/, 'and it carries the crash as its reason: ' + j.reason);
    assert.doesNotMatch(String(j.reason), /sk-or-v1-LEAK/, 'redacted');
  }

  console.log('media-service: OK (51 assertions)');
})().finally(async () => {
  for (const root of roots) await fsp.rm(root, { recursive: true, force: true });
}).catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
