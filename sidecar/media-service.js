'use strict';

/* Station media composition. The HTTP routes, agent voice tool, and messaging-channel
   voice-note ingest all use this one implementation so their provider/fallback ladders
   cannot drift. Ambient state is injected by sidecar/index.js. */

const path = require('node:path');
const crypto = require('node:crypto');
const SO = require('./speech-outcome.js');
const SL = require('./speech-ladder.js');

const TTS_DEFAULT_MODEL = 'google/gemini-3.1-flash-tts-preview';
const TTS_KEY_PROVIDERS = ['openrouter', 'gemini', 'openai'];
const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = 'onyx';
const EL_TTS_MODEL = 'eleven_multilingual_v2';
const STT_MAX_BYTES = 10 * 1024 * 1024;
const STT_PROMPT = 'Transcribe this audio verbatim. Output ONLY the transcribed words, nothing else. If there is no speech, output nothing.';
const STT_GROQ_MODEL = 'whisper-large-v3-turbo';
const STT_OPENAI_MODEL = 'whisper-1';
/* VERSIONED voice-cache keys (bug 81812888). Before 0efc04afe an Edge stream cut before turn.end was cached as a
   whole clip under the full sentence's key and replayed cut in half for good. The fix stopped new truncations but
   left every poisoned clip on disk, so each key now starts with a version segment: a clip written under an older
   key is never read again, the sentence is synthesized whole, and the old file ages out of the LRU sweep. Bump a
   segment whenever a leg could have cached audio the current code would not produce. local-kokoro/v2 is its own. */
const VOICE_CACHE_EDGE = 'edge/v2';
const VOICE_CACHE_KEYED = 'keyed/v2';
const VOICE_CACHE_ELEVENLABS = 'elevenlabs/v2';
/* ONE DEADLINE PER SENTENCE. The desk sends the time it has left for a sentence (body.deadlineMs, or the
   X-Speech-Deadline-Ms header), and every leg of the ladder is capped by what remains of it, so the sidecar answers
   with a typed outcome BEFORE the desk gives up — a keyed call no longer runs 60 s behind a 30 s client ceiling.
   Clamped; absent = each leg's own cap (an older desk). */
const SPEECH_DEADLINE_MIN_MS = 500;
const SPEECH_DEADLINE_MAX_MS = 120000;
const SPEECH_LEG_FLOOR_MS = 250;        // less than this left: the leg is not started, it is reported as a timeout
const KEYED_LEG_CAP_MS = 60000;
const EDGE_LEG_CAP_MS = 15000;
// A paid keyed call every waiting request abandoned is aborted after this grace: long enough for the desk's spaced
// retry (0.4 s / 1.2 s) to JOIN the running call instead of paying for the sentence twice (bug df610df1).
// The sentence DEADLINE never aborts it: a request whose deadline passes is answered with a typed timeout while the
// call runs on to KEYED_LEG_CAP_MS and caches its clip, so a provider slower than the deadline is paid for once and
// the next request for that clip joins the call or hits the cache.
const KEYED_ABANDON_GRACE_MS = 2500;
// the server-side surfaces' whole-sentence budgets (speech-ladder.js retries never outlive them): voice_generate's tool
// gives up at 60 s (tools/builtin/voice.js SYNTH_TIMEOUT_MS), a device sentence gets the desk's 30 s (voice.js TTS_TIMEOUT_MS)
const AGENT_SPEECH_BUDGET_MS = 60000;
const DEVICE_SPEECH_BUDGET_MS = 30000;
function speechDeadlineMs(req, body) {
  const raw = (body && body.deadlineMs != null) ? body.deadlineMs : (req && req.headers && req.headers['x-speech-deadline-ms']);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(SPEECH_DEADLINE_MIN_MS, Math.min(SPEECH_DEADLINE_MAX_MS, Math.floor(n)));
}

let oggOpusDecoderModulePromise = null;

/* Telegram voice notes are Ogg/Opus. The offline Whisper pipeline consumes 16 kHz Float32 PCM, so decode
   that container in-process instead of depending on a machine-global ffmpeg install. Keep the ESM decoder
   lazy: a damaged/custom installation must still boot and can truthfully fall through to keyed STT. */
async function oggOpusToMono16kFloat32(buf, loadModule) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.toString('latin1', 0, 4) !== 'OggS') {
    throw new Error('unreadable Ogg/Opus audio');
  }
  const loader = typeof loadModule === 'function'
    ? loadModule
    : () => {
        if (!oggOpusDecoderModulePromise) oggOpusDecoderModulePromise = import('ogg-opus-decoder');
        return oggOpusDecoderModulePromise;
      };
  const mod = await loader();
  if (!mod || typeof mod.OggOpusDecoder !== 'function') throw new Error('Ogg/Opus decoder is unavailable');
  const decoder = new mod.OggOpusDecoder({ sampleRate: 16000 });
  try {
    await decoder.ready;
    const decoded = await decoder.decodeFile(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const channels = Array.isArray(decoded && decoded.channelData) ? decoded.channelData : [];
    const samples = Number(decoded && decoded.samplesDecoded) || 0;
    if (!samples || !channels.length) {
      const first = decoded && Array.isArray(decoded.errors) && decoded.errors[0];
      throw new Error((first && first.message) || 'Ogg/Opus audio contained no decodable samples');
    }
    const usable = channels.filter(ch => ch && typeof ch.length === 'number');
    if (!usable.length) throw new Error('Ogg/Opus audio contained no decodable channels');
    const count = Math.min(samples, ...usable.map(ch => ch.length));
    const mono = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (const ch of usable) sum += Number(ch[i]) || 0;
      mono[i] = sum / usable.length;
    }
    return mono;
  } finally {
    try { decoder.free(); } catch (_) {}
  }
}

function pcmToWav(pcm, sampleRate, channels) {
  const bits = 16;
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(blockAlign, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// The standard voice button captures mono 16 kHz Float32 PCM so the exact two-click take can be handed to
// Windows System.Speech. Convert it to the PCM16 WAV container that SetInputToWaveFile accepts.
function float32PcmToWav(buf, sampleRate) {
  if (!Buffer.isBuffer(buf) || !buf.length || buf.length % 4) return null;
  const pcm16 = Buffer.alloc(buf.length / 2);
  for (let src = 0, dst = 0; src < buf.length; src += 4, dst += 2) {
    const n = buf.readFloatLE(src);
    const clamped = Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
    pcm16.writeInt16LE(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), dst);
  }
  return pcmToWav(pcm16, sampleRate || 16000, 1);
}

function wavToMono16kFloat32(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(pos + 8),
        ch: buf.readUInt16LE(pos + 10),
        rate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22)
      };
    } else if (id === 'data') {
      dataOff = pos + 8;
      dataLen = Math.min(size, buf.length - dataOff);
      break;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !dataOff || !dataLen || !fmt.ch || !fmt.rate) return null;
  const bytesPer = fmt.bits / 8;
  const frames = Math.floor(dataLen / bytesPer / fmt.ch);
  if (!frames) return null;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const off = dataOff + (i * fmt.ch + c) * bytesPer;
      sum += bytesPer === 4 ? buf.readFloatLE(off) : buf.readInt16LE(off) / 32768;
    }
    mono[i] = sum / fmt.ch;
  }
  if (fmt.rate === 16000) return mono;
  const ratio = fmt.rate / 16000;
  const out = new Float32Array(Math.floor(mono.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(mono.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += mono[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function sttMultipartBody(audioBuf, filename, contentType, fields, randomBytes) {
  const rand = typeof randomBytes === 'function' ? randomBytes : crypto.randomBytes;
  const boundary = '----StarNetSTT' + rand(16).toString('hex');
  const parts = [];
  for (const k of Object.keys(fields || {})) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(fields[k]) + '\r\n', 'utf8'));
  }
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + filename + '"\r\nContent-Type: ' + contentType + '\r\n\r\n', 'utf8'));
  parts.push(audioBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

function makeMediaService(options) {
  const o = options || {};
  const fsp = o.fsp;
  const fetchFn = o.fetch;
  const edgetts = o.edgetts;
  const localVoice = o.localVoice;
  const nativeStt = o.nativeStt;
  const readBody = o.readBody;
  const readBodyBuffer = o.readBodyBuffer;
  /* THE CREDENTIALS (sidecar/credential-store.js consumerDeps().media; S6): providerRuntimeKey(provider, '') is the
     station's own key, credentialFor(provider) the station's own credential with its endpoint and rank, and
     endpointFor(provider, key) the endpoint saved with the key a leg is about to send. Every keyed leg dials that
     endpoint, never a host of its own and never the endpoint of another key (a page key sent with one request gets its
     own). Every voice provider has a default in the registry, so a leg always has one; absent these, its URL is relative
     and fetch refuses it before a key goes anywhere. */
  const providerRuntimeKey = o.providerRuntimeKey;
  const endpointFor = typeof o.endpointFor === 'function' ? o.endpointFor : () => '';
  const credentialFor = typeof o.credentialFor === 'function' ? o.credentialFor : () => ({ key: '', baseUrl: '', rank: 'gap' });
  const normalizeProviderId = o.normalizeProviderId;
  const env = typeof o.env === 'function' ? o.env : (() => '');
  const processEnv = o.processEnv || {};
  const redact = typeof o.redact === 'function' ? o.redact : String;
  const logger = o.logger || console;
  const decodeOggOpus = typeof o.decodeOggOpus === 'function' ? o.decodeOggOpus : oggOpusToMono16kFloat32;
  // The host owns wall time. A missing clock degrades deterministically instead of smuggling ambient time into
  // backend policy (tests and alternate compositions can then reproduce cache decisions exactly).
  const now = typeof o.now === 'function' ? o.now : (() => 0);
  const randomUUID = typeof o.randomUUID === 'function' ? o.randomUUID : crypto.randomUUID;
  const monotonicNow = typeof o.monotonicNow === 'function' ? o.monotonicNow : now;
  // the ladder's spaced retry waits on this (tests inject an instant one); a host may set each surface's speech policy
  // (not unref'd: a pending wait must keep the process alive, or a headless caller exits mid-ladder; it is at most 3 s)
  const sleep = typeof o.sleep === 'function' ? o.sleep : (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const speechPolicy = o.speechPolicy && typeof o.speechPolicy === 'object' ? o.speechPolicy : null;
  const voiceStreams = require('./voice-stream.js').makeVoiceStreams({
    localVoice, now, monotonicNow, uuid: randomUUID
  });
  // The last outcome of every speech leg any ladder tried (GET /api/tts/status): what the speaker tooltip names.
  const speechStatus = SO.makeSpeechStatus({ now });
  const voiceCacheDir = path.join(o.workspaces, 'voice-cache');
  const keyedInFlight = new Map();   // voice-cache key -> the one keyed synthesis running for that clip
  const sttModels = String(env('STT_MODELS') || 'google/gemini-3.1-flash-lite-preview,google/gemini-2.5-flash')
    .split(',').map(s => s.trim()).filter(Boolean);
  // the endpoint a keyed leg dials: the one saved with the key it sends, without a trailing slash ('' = none)
  const legBase = (provider, key) => String(endpointFor(provider, key) || '').trim().replace(/\/+$/, '');
  // STARNET_/SKYNET_GROQ_BASE and _OPENAI_BASE: the operator's own transcription endpoint, for STT alone. A deployment choice
  // ahead of the provider's endpoint, as at trunk: dropped, a station's speech would silently leave for the public host.
  const sttEnvBase = { groq: String(env('GROQ_BASE') || '').trim(), openai: String(env('OPENAI_BASE') || '').trim() };
  let ttsMissCount = 0;
  let evictingVoiceCache = false;
  let voiceDispatcher = null;

  try { o.fs.mkdirSync(voiceCacheDir, { recursive: true }); } catch (_) {}
  Promise.resolve().then(() => import('undici')).then(u => {
    if (u && u.Agent) voiceDispatcher = new u.Agent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000, connections: 8 });
  }).catch(() => { voiceDispatcher = null; });

  function voiceFetchOpts(base, timeoutMs) {
    base = base || {};
    if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = (base.signal && typeof AbortSignal.any === 'function') ? AbortSignal.any([base.signal, timeout]) : timeout;
      base = Object.assign({}, base, { signal });
    }
    return voiceDispatcher ? Object.assign({ dispatcher: voiceDispatcher }, base) : base;
  }

  async function maybeEvictVoiceCache() {
    if (evictingVoiceCache) return;
    evictingVoiceCache = true;
    try {
      const names = await fsp.readdir(voiceCacheDir);
      const at = now();
      const audio = [];
      let total = 0;
      for (const n of names) {
        const fp = path.join(voiceCacheDir, n);
        let st; try { st = await fsp.stat(fp); } catch (_) { continue; }
        if (!st.isFile()) continue;
        if (n.endsWith('.tmp')) {
          if (at - st.mtimeMs > 5 * 60 * 1000) { try { await fsp.unlink(fp); } catch (_) {} }
          continue;
        }
        audio.push({ fp, mtime: st.mtimeMs, size: st.size });
        total += st.size;
      }
      const maxFiles = 600;
      const maxBytes = 200 * 1024 * 1024;
      const low = 0.8;
      if (audio.length <= maxFiles && total <= maxBytes) return;
      audio.sort((a, b) => a.mtime - b.mtime);
      let files = audio.length, bytes = total;
      for (const item of audio) {
        if (files <= maxFiles * low && bytes <= maxBytes * low) break;
        try { await fsp.unlink(item.fp); files--; bytes -= item.size; } catch (_) {}
      }
    } catch (_) {}
    finally { evictingVoiceCache = false; }
  }

  function sweepMaybe() {
    if (++ttsMissCount % 32 === 0) setImmediate(() => { maybeEvictVoiceCache().catch(() => {}); });
  }

  /* One keyed synthesis. A failure is { ok:false, reason, leg }: `leg` is the typed verdict (status and body read ONCE,
     here, by SO.httpLeg), `reason` the legacy text an older desk still reads. args.signal aborts it (every request
     waiting on it went away); args.timeoutMs caps it at what is left of the sentence's deadline. It dials the endpoint
     saved with args.key, which used to be https://openrouter.ai for every OpenRouter key and the STATION key's endpoint
     for a key the page sent with this request. */
  async function ttsSynthKeyed(ttsProvider, args) {
    const { model, voice, input, text, style, key } = args;
    const base = legBase(ttsProvider, key);
    const capMs = args.timeoutMs > 0 ? Math.min(KEYED_LEG_CAP_MS, args.timeoutMs) : KEYED_LEG_CAP_MS;
    const callOpts = init => voiceFetchOpts(args.signal ? Object.assign({ signal: args.signal }, init) : init, capMs);
    const thrown = (error, prefix) => ({
      ok: false, reason: prefix + ((error && error.message) || error),
      leg: SO.errorLeg(ttsProvider, error, { cancelled: !!(args.signal && args.signal.aborted) })
    });
    const refused = async (response, label) => {
      let detail = '';
      try { detail = (await response.text()).slice(0, 300); } catch (_) { detail = ''; }
      const reason = label + ' ' + response.status + (detail ? ' — ' + detail : '');
      return { ok: false, reason, leg: SO.httpLeg(ttsProvider, response.status, detail, response.headers, reason) };
    };
    const unusable = (reason, code) => ({ ok: false, reason, leg: SO.leg(ttsProvider, code, { detail: reason }) });
    if (ttsProvider === 'gemini') {
      const nativeModel = model.replace(/^google\//, '');
      let response;
      try {
        response = await fetchFn(base + '/models/' + encodeURIComponent(nativeModel) + ':generateContent', callOpts({
          method: 'POST',
          headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: input }] }],
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
          })
        }));
      } catch (error) { return thrown(error, 'network: '); }
      if (!response.ok) return refused(response, 'gemini');
      let json; try { json = await response.json(); } catch (_) { return unusable('gemini: bad json', 'bad_response'); }
      const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
      const part = parts && parts.find(p => p && p.inlineData && p.inlineData.data);
      if (!part) return unusable('gemini: no audio in response', 'bad_response');
      let buf; try { buf = Buffer.from(part.inlineData.data, 'base64'); } catch (_) { return unusable('gemini: bad audio data', 'bad_response'); }
      if (!buf.length) return unusable('empty audio', 'empty_audio');
      const mime = String(part.inlineData.mimeType || '').toLowerCase();
      const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1], 10) || 24000;
      return { ok: true, buf: pcmToWav(buf, rate, 1), outType: 'audio/wav', ext: 'wav' };
    }
    if (ttsProvider === 'openai') {
      const payload = { model: OPENAI_TTS_MODEL, input: text, voice: OPENAI_TTS_VOICE, response_format: 'mp3' };
      if (style) payload.instructions = style;
      let response;
      try {
        response = await fetchFn(base + '/audio/speech', callOpts({
          method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        }));
      } catch (error) { return thrown(error, 'network: '); }
      if (!response.ok) return refused(response, 'openai');
      let buf; try { buf = Buffer.from(await response.arrayBuffer()); } catch (error) { return thrown(error, 'read: '); }
      if (!buf.length) return unusable('empty audio', 'empty_audio');
      return { ok: true, buf, outType: 'audio/mpeg', ext: 'mp3' };
    }
    const payload = { model, input, voice, response_format: 'pcm' };
    let response;
    try {
      response = await fetchFn(base + '/audio/speech', callOpts({
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost', 'X-Title': 'STARNET' },
        body: JSON.stringify(payload)
      }));
    } catch (error) { return thrown(error, 'network: '); }
    if (!response.ok) return refused(response, 'openrouter');
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let buf; try { buf = Buffer.from(await response.arrayBuffer()); } catch (error) { return thrown(error, 'read: '); }
    if (!buf.length) return unusable('empty audio', 'empty_audio');
    if (/pcm|octet-stream/.test(contentType) || /rate=|channels=/.test(contentType)) {
      const rate = parseInt((contentType.match(/rate=(\d+)/) || [])[1], 10) || 24000;
      const channels = parseInt((contentType.match(/channels=(\d+)/) || [])[1], 10) || 1;
      return { ok: true, buf: pcmToWav(buf, rate, channels), outType: 'audio/wav', ext: 'wav' };
    }
    if (/mpeg|mp3/.test(contentType)) return { ok: true, buf, outType: 'audio/mpeg', ext: 'mp3' };
    if (/wav/.test(contentType)) return { ok: true, buf, outType: 'audio/wav', ext: 'wav' };
    if (/ogg/.test(contentType)) return { ok: true, buf, outType: 'audio/ogg', ext: 'ogg' };
    return unusable('unexpected content-type: ' + contentType, 'bad_response');
  }

  // nothing to say is the REQUEST's failure, typed like every other (it says nothing about an engine)
  const noTextOutcome = () => SO.outcome([SO.leg('request', 'no_text', { detail: 'no text' })]);

  // ONE clip write for every leg: a temp file renamed into place, so a reader never sees half a clip
  async function readClip(file) { try { return await fsp.readFile(path.join(voiceCacheDir, file)); } catch (_) { return null; } }
  async function writeClip(file, buf) {
    try {
      const fp = path.join(voiceCacheDir, file), tmp = fp + '.' + randomUUID() + '.tmp';
      await fsp.writeFile(tmp, buf); await fsp.rename(tmp, fp);
    } catch (_) {}
  }
  const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
  const errText = e => (e && e.message) || String(e);

  /* ---------------- THE LADDER (sidecar/speech-ladder.js holds the rule; this is its engines) ----------------
     synthesize(text, run) -> { ok:true, buf, mime, ext, engine, cache, edgeVoice? } | { ok:false, reason, outcome, gone? }
     run = { surface, identity, pin, keyed:[{provider,key,source}], policy, signal?, deadlineMs?, desk?, source, pinned? }
     Every surface calls it: handleTts (desk and Live), synthesizeStationVoice (paired device), synthesizeForAgent
     (voice_generate). The legacy `reason` text of each leg is the one that surface always wrote (kept one release). */
  function keyedCandidates(prefer, explicit) {
    const station = (TTS_KEY_PROVIDERS.includes(prefer) ? [prefer].concat(TTS_KEY_PROVIDERS.filter(p => p !== prefer)) : TTS_KEY_PROVIDERS)
      .map(provider => ({ provider, key: providerRuntimeKey(provider, ''), source: 'station' })).filter(k => !!k.key);
    if (!explicit) return station;
    return [{ provider: explicit.provider, key: explicit.key, source: 'page' }].concat(station.filter(k => k.provider !== explicit.provider));
  }
  // the station's keyed voice, unless a caller that may name a voice (voice_generate) named one
  function keyedIdentity(named) {
    const n = named || {};
    if (n.voice) return { model: TTS_DEFAULT_MODEL, voice: n.voice, style: n.style || '' };
    return { model: TTS_DEFAULT_MODEL, voice: SL.STATION_VOICE.voice, style: n.style || SL.STATION_VOICE.style };
  }
  const resolveEdgeVoice = () => { try { return typeof edgetts.resolveVoice === 'function' ? String(edgetts.resolveVoice() || '') : ''; } catch (_) { return ''; } };

  async function attemptLocal(leg, text, run) {
    const LOCAL = 'local-kokoro';
    const label = s => (run.desk ? 'local voice engine: ' : 'local: ') + s;
    const voiceId = leg.voice || localVoice.defaultVoice();
    const speed = Math.max(0.5, Math.min(2, Number(leg.speed) || 1));
    if (!leg.waitsForModel) {
      // a model that must still be DOWNLOADED is never waited on: it loads in the background and this sentence moves on
      let st = null;
      try { st = localVoice.status() || null; }
      catch (error) { return { ok: false, leg: SO.leg(LOCAL, 'internal_error', { detail: errText(error) }), text: 'local status: ' + errText(error), retry: false }; }
      if (!st || !st.available) {
        return run.pinned ? { ok: false, leg: SO.leg(LOCAL, 'local_unavailable', { detail: 'unavailable' }), text: 'local: unavailable' } : { ok: false, skip: true };
      }
      let onDisk = false;
      if (st.tts === 'cold' || st.tts === 'loading') {
        try { onDisk = typeof localVoice.ttsCached === 'function' && !!localVoice.ttsCached(); }
        catch (error) { return { ok: false, leg: SO.leg(LOCAL, 'internal_error', { detail: errText(error) }), text: 'local cache: ' + errText(error), retry: false }; }
      }
      if (!(st.tts === 'ready' || run.pinned || onDisk)) {
        if (st.tts !== 'loading') {
          Promise.resolve().then(() => localVoice.warm({ asr: false }))
            .catch(error => logger.error('[local-voice] warm failed:', errText(error)));
        }
        // a model still loading (or retried in the background after a failed load) may answer the NEXT sentence
        const why = st.tts === 'error' ? 'voice model failed to load' : 'voice model still loading';
        return { ok: false, leg: SO.leg(LOCAL, 'local_failed', { detail: why }), text: 'local: ' + why, retry: false };
      }
    }
    // v2 = sentence pieces + trimmed edges + punctuation pauses + 16-bit (local-voice.js renderSpeech); a v1 clip never answers
    const file = 'local-' + sha1(`local-kokoro/v2|${voiceId}|${speed}|${text}`) + '.wav';
    if (run.cache) { const hit = await readClip(file); if (hit) return { ok: true, buf: hit, mime: 'audio/wav', ext: 'wav', cache: 'hit' }; }
    let buf;
    try { buf = await localVoice.synthesize(text, { voice: voiceId, speed }); }
    catch (error) {
      return { ok: false, leg: SO.leg(LOCAL, error && error.unavailable ? 'local_unavailable' : 'local_failed', { detail: errText(error) }), text: label(errText(error)) };
    }
    if (!buf || !buf.length) return { ok: false, leg: SO.leg(LOCAL, 'empty_audio', { detail: 'empty audio' }), text: label('empty audio') };
    // A Kokoro miss writes a clip to the same cache every other leg sweeps (unswept, the offline voice grew the folder ~120 MB a day)
    if (run.cache) { await writeClip(file, buf); sweepMaybe(); }
    return { ok: true, buf, mime: 'audio/wav', ext: 'wav', cache: 'miss' };
  }

  async function attemptEdge(leg, text, run, state) {
    if (!edgetts.enabled()) {
      // the desk's legacy reason for a ladder that tried nothing else is the bare 'no key'
      const legacy = run.desk ? (state.failures.some(f => f.text) ? 'edge floor disabled' : 'no key') : 'edge: disabled';
      return { ok: false, leg: SO.leg('edge', 'disabled', { detail: 'the free Edge voice is switched off' }), text: legacy };
    }
    const voice = leg.voice || resolveEdgeVoice();
    const file = voice ? sha1(VOICE_CACHE_EDGE + '|' + voice + '|' + text) + '.mp3' : '';
    if (run.cache && file) { const hit = await readClip(file); if (hit) return { ok: true, buf: hit, mime: 'audio/mpeg', ext: 'mp3', cache: 'hit', edgeVoice: voice }; }
    const capMs = run.legCap(EDGE_LEG_CAP_MS);
    if (capMs <= 0) return { ok: false, leg: SO.leg('edge', 'timeout', { detail: 'the sentence deadline ran out before this leg could start' }), text: 'edge: deadline spent', stop: true };
    const opts = { nowMs: now(), timeoutMs: capMs };
    if (voice) opts.voice = voice;
    if (run.signal) opts.signal = run.signal;
    let buf;
    try { buf = await edgetts.synth(text, opts); }
    catch (error) { return { ok: false, leg: SO.errorLeg('edge', error, { cancelled: !!(run.signal && run.signal.aborted) }), text: 'edge: ' + errText(error) }; }
    if (!buf || !buf.length) return { ok: false, leg: SO.leg('edge', 'empty_audio', { detail: 'empty audio' }), text: 'edge: empty audio' };
    if (run.cache && file) { await writeClip(file, buf); sweepMaybe(); }
    return { ok: true, buf, mime: 'audio/mpeg', ext: 'mp3', cache: 'miss', edgeVoice: voice };
  }

  async function attemptKeyed(leg, text, run) {
    if (leg.missing) {
      // the keyed tier held no credential: a STRUCTURAL leg (no legacy text, the reason never said it) unless pinned
      if (run.pinned && leg.engine !== 'keyed') return { ok: false, leg: SO.leg(leg.engine, 'no_key', { detail: 'no key' }), text: leg.engine + ': no key' };
      return { ok: false, leg: SO.leg('keyed', 'no_key', { detail: run.desk ? 'no OpenRouter, Gemini or OpenAI credential' : 'no keyed voice credential' }) };
    }
    const provider = leg.engine;
    const model = leg.model || TTS_DEFAULT_MODEL, voice = leg.voice || SL.STATION_VOICE.voice, style = leg.style || '';
    const input = style ? ('Say the following in ' + style + ': ' + text) : text;
    const label = s => run.desk ? s : provider + ': ' + s;
    const cacheKey = provider === 'openai'
      ? sha1(VOICE_CACHE_KEYED + '|openai/' + OPENAI_TTS_MODEL + '|' + OPENAI_TTS_VOICE + '|' + style + '|' + text)
      : sha1(VOICE_CACHE_KEYED + '|' + model + '|' + voice + '|' + style + '|' + text);
    if (run.cache) {
      for (const ext of ['wav', 'mp3']) {
        const hit = await readClip(cacheKey + '.' + ext);
        if (hit) return { ok: true, buf: hit, mime: ext === 'mp3' ? 'audio/mpeg' : 'audio/wav', ext, cache: 'hit' };
      }
    }
    const waitMs = run.legCap(KEYED_LEG_CAP_MS);
    if (waitMs <= 0) return { ok: false, leg: SO.leg(provider, 'timeout', { detail: 'the sentence deadline ran out before this leg could start' }), text: provider + ': deadline spent', stop: true };
    const args = { model, voice, input, text, style, key: leg.key };
    const failed = r => ({ ok: false, leg: (r && r.leg) || SO.leg(provider, 'internal_error', { detail: (r && r.reason) || 'failed' }), text: label((r && r.reason) || 'failed') });
    if (!run.signal) {
      // a server-side surface (the device, voice_generate): one call, capped by what is left of its budget
      let r;
      try { r = await ttsSynthKeyed(provider, Object.assign({ timeoutMs: waitMs }, args)); }
      catch (error) { r = { ok: false, reason: errText(error), leg: SO.errorLeg(provider, error) }; }
      if (!(r && r.ok && r.buf && r.buf.length)) {
        const f = failed(r);
        // no in-flight join here: a provider that ran to the cap may have billed the clip, so it is not asked again
        if (f.leg && f.leg.code === 'timeout') f.retry = false;
        return f;
      }
      if (run.cache) { await writeClip(cacheKey + '.' + r.ext, r.buf); sweepMaybe(); }
      return { ok: true, buf: r.buf, mime: r.outType, ext: r.ext, cache: 'miss' };
    }
    /* THE DESK: ONE paid synthesis per clip (bug df610df1). A request whose clip is already in flight JOINS that call.
       The call runs to its OWN cap (KEYED_LEG_CAP_MS), never a request's sentence deadline: a request whose deadline
       passes is answered with a typed timeout and the call runs on, so a provider slower than the deadline is paid for
       once, its clip lands in the cache, and the next request for it joins the call or hits the cache. It is aborted
       only once EVERY waiting request has gone away (a closed page, a barge-in) and a short grace has passed, and never
       once a request timed out on it (that clip is still wanted). */
    // the desk went away before the call started: never start a paid call for nobody
    if (run.gone()) return { ok: false, stop: true, gone: true };
    let entry = keyedInFlight.get(cacheKey);
    if (!entry) {
      const fresh = { waiters: 0, wanted: false, ac: new AbortController(), timer: null, promise: null };
      fresh.promise = ttsSynthKeyed(provider, Object.assign({ signal: fresh.ac.signal }, args))
        .catch(error => ({ ok: false, reason: errText(error), leg: SO.errorLeg(provider, error) }))
        .then(async result => { if (result.ok) await writeClip(cacheKey + '.' + result.ext, result.buf); return result; })
        .finally(() => {
          if (fresh.timer) clearTimeout(fresh.timer);
          if (keyedInFlight.get(cacheKey) === fresh) keyedInFlight.delete(cacheKey);
        });
      keyedInFlight.set(cacheKey, fresh);
      entry = fresh;
    }
    const joined = entry;
    joined.waiters++;
    if (joined.timer) { clearTimeout(joined.timer); joined.timer = null; }
    let departed = false;
    const leave = () => {
      departed = true;
      joined.waiters--;
      if (joined.waiters > 0 || joined.timer || joined.wanted) return;
      joined.timer = setTimeout(() => {
        if (joined.waiters > 0 || joined.wanted) { joined.timer = null; return; }
        // a request for this clip that arrives after the abort starts its own call, never joins a dying one
        if (keyedInFlight.get(cacheKey) === joined) keyedInFlight.delete(cacheKey);
        joined.ac.abort();
      }, KEYED_ABANDON_GRACE_MS);
      if (joined.timer && typeof joined.timer.unref === 'function') joined.timer.unref();
    };
    run.signal.addEventListener('abort', leave, { once: true });
    // this request waits at most what is left of ITS sentence's deadline (no deadline: the call's own cap)
    let deadlineTimer = null;
    const keyed = !run.deadlineMs ? await joined.promise : await Promise.race([
      joined.promise,
      new Promise(resolve => { deadlineTimer = setTimeout(() => resolve(null), waitMs); })
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    run.signal.removeEventListener('abort', leave);
    if (keyed === null) {
      if (departed) return { ok: false, stop: true, gone: true };   // the desk left first: the abandonment path owns the call
      // the deadline passed with the call still running: it runs on and caches its clip (paid for once), and this
      // request answers with a typed timeout the desk can act on before its own ceiling
      joined.wanted = true;
      joined.waiters--;
      if (joined.timer) { clearTimeout(joined.timer); joined.timer = null; }
      if (run.gone()) return { ok: false, stop: true, gone: true };
      return { ok: false, leg: SO.leg(provider, 'timeout', { detail: 'no audio within the sentence deadline (the call runs on; a clip it returns is cached)' }),
        text: provider + ': no audio within the sentence deadline' };
    }
    if (run.gone()) return { ok: false, stop: true, gone: true };   // this desk went away while the call ran
    if (keyed.ok) { sweepMaybe(); return { ok: true, buf: keyed.buf, mime: keyed.outType, ext: keyed.ext, cache: 'miss' }; }
    return failed(keyed);
  }

  // a server-side surface's whole-sentence budget: every leg is capped by what is left, and no retry outlives it
  function budgeted(ms) {
    const startedAt = monotonicNow();
    const left = () => ms - (monotonicNow() - startedAt);
    return { budgetLeft: left, legCap: cap => { const l = Math.floor(left()); return l < SPEECH_LEG_FLOOR_MS ? 0 : Math.min(cap, l); } };
  }

  async function synthesize(text, run) {
    const legs = SL.plan({ identity: run.identity, pin: run.pin, policy: run.policy, keyed: run.keyed });
    const r = Object.assign({ legCap: c => c, gone: () => false, pinned: !!run.pin }, run);
    if (r.noEdge) legs.splice(0, legs.length, ...legs.filter(l => l.kind !== 'edge'));
    const result = await SL.run(legs, (leg, state) => (
      leg.kind === 'local' ? attemptLocal(leg, text, r) : leg.kind === 'edge' ? attemptEdge(leg, text, r, state) : attemptKeyed(leg, text, r)
    ), { sleep, gone: r.gone, budgetLeft: r.budgetLeft });
    const tries = result.tries;
    if (result.ok) {
      if (result.result.cache !== 'hit') speechStatus.record(SO.success(result.leg.engine), r.source);
      return Object.assign({ engine: result.leg.engine, tries }, result.result);
    }
    const failures = result.failures.filter(f => !f.gone);
    const legsOut = failures.map(f => f.leg).filter(Boolean);
    const outcome = SO.outcome(legsOut.length ? legsOut : [SO.leg('station', 'internal_error', { detail: 'no leg was tried' })]);
    if (legsOut.length) speechStatus.record(outcome, r.source);
    const reason = failures.map(f => f.text).filter(Boolean).join('; ');
    return { ok: false, gone: !!(result.gone || result.failures.some(f => f.gone)), reason, outcome, tries, retried: tries.some(t => t.waitMs > 0) };
  }

  /* voice_generate's synthesizer (and any server-side caller): the 'agent' surface. args.voice / args.style name a
     voice for this clip; without one it is the station's voice. args.only pins one engine; args.noEdge drops the floor. */
  async function synthesizeForAgent(args) {
    const a = args || {};
    const text = String(a.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, reason: 'no text', outcome: noTextOutcome() };
    const style = String(a.style || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const wantVoice = String(a.voice || '').trim();
    const edgeNamed = /^[a-z]{2}-[A-Za-z]{2,8}-\w+$/.test(wantVoice);
    const named = wantVoice && !edgeNamed ? { voice: wantVoice, style } : (style ? { style } : null);
    const surface = 'agent';
    const policy = SL.policyFor(surface, speechPolicy);
    // an Edge neural voice named for the clip is spoken by Edge first (a keyed provider cannot speak it)
    const identity = Object.assign({ engine: edgeNamed && !a.noEdge ? 'edge' : 'keyed', edgeVoice: edgeNamed ? wantVoice : '' }, keyedIdentity(named));
    const r = await synthesize(text, Object.assign({ surface, identity, pin: String(a.only || ''), keyed: keyedCandidates(''), policy, cache: policy.cache,
      source: String(a.source || 'agent'), noEdge: !!a.noEdge, gone: typeof a.gone === 'function' ? a.gone : undefined }, budgeted(AGENT_SPEECH_BUDGET_MS)));
    if (r.ok) return { ok: true, buf: r.buf, ext: r.ext, mime: r.mime, provider: r.engine, tries: r.tries };
    const fallback = a.noEdge ? 'no keyed voice provider' : 'this station holds no voice-capable credential';
    return { ok: false, reason: r.reason || fallback, outcome: r.outcome, tries: r.tries };
  }

  /* The spoken voice for a paired device (remote/voice.js `speak`): the 'device' surface. Its identity is the built-in
     engine's DEFAULT voice (am_onyx), then that voice's mapped Edge neural voice, then the station's keyed voice
     (policy.keyedAfterFloor). Voice picks (station and per-agent) live in the desk page's storage and `speak` carries
     no agentId, so the companion does not follow them. Never throws.
     opts.provider pins one reply to the engine that spoke its first sentence (the one continuity rule). The built-in
     engine answers once its model is READY, or while it is cold or loading when its model is already on disk; a model
     that must still be DOWNLOADED (~326 MB) is never waited on (policy.localWaitsForModel is off here). */
  async function synthesizeStationVoice(text, opts) {
    const said = String(text || '').replace(/\s+/g, ' ').trim();
    if (!said) return { ok: false, reason: 'no text', outcome: noTextOutcome() };
    const surface = 'device';
    const policy = SL.policyFor(surface, speechPolicy);
    let voiceId = '', mapped = '';
    try { voiceId = localVoice.defaultVoice(); mapped = localVoice.edgeVoiceFor(voiceId); } catch (_) {}
    const identity = Object.assign({ engine: 'local', localVoice: voiceId, mappedEdgeVoice: mapped, speed: 1 }, keyedIdentity(null));
    // opts.gone: the device's reply was replaced, forgotten or revoked: stop spending on it (no retry, no next leg)
    const gone = opts && typeof opts.gone === 'function' ? opts.gone : undefined;
    const r = await synthesize(said, Object.assign({ surface, identity, pin: String((opts && opts.provider) || ''), keyed: keyedCandidates(''), policy, cache: policy.cache,
      source: 'remote', gone }, budgeted(DEVICE_SPEECH_BUDGET_MS)));
    if (r.ok) return { ok: true, buf: r.buf, mime: r.mime, ext: r.ext, provider: r.engine, tries: r.tries };
    return { ok: false, reason: r.reason || 'no voice', outcome: r.outcome, tries: r.tries };
  }
  // CERTAIN-availability probe for voice_generate (runOnce's tool footprint): false only when synthesizeForAgent
  // above has no leg it could even try — no keyed TTS provider AND the keyless Edge floor switched off. Reads the
  // same provider list and the same switch as the ladder itself, so the two cannot disagree.
  function voiceRouteAvailable() {
    return TTS_KEY_PROVIDERS.some(provider => !!providerRuntimeKey(provider, '')) || !!edgetts.enabled();
  }

  async function ttsElevenLabs(res, body, text, t) {
    const key = String((body && body.elKey) || '').trim() || String(processEnv.ELEVENLABS_API_KEY || '').trim();
    const voiceId = String((body && body.voiceId) || '').trim();
    const modelId = String((body && body.modelId) || EL_TTS_MODEL).trim();
    const EL = 'elevenlabs';
    if (!/^[A-Za-z0-9]{8,48}$/.test(voiceId)) return t.refuse('bad_input', 'bad voiceId');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(modelId)) return t.refuse('bad_input', 'bad modelId');
    if (!key) { t.lad.fail(SO.leg(EL, 'no_key', { detail: 'no elevenlabs key' }), 'no elevenlabs key'); return t.answerFailure(); }
    const cacheKey = crypto.createHash('sha1').update(VOICE_CACHE_ELEVENLABS + '|' + modelId + '|' + voiceId + '||' + text).digest('hex');
    try {
      const buf = await fsp.readFile(path.join(voiceCacheDir, cacheKey + '.mp3'));
      return t.answerAudio(buf, { 'Content-Type': 'audio/mpeg', 'X-Voice-Cache': 'hit' });
    } catch (_) {}
    const capMs = t.legCap(KEYED_LEG_CAP_MS);
    if (capMs <= 0) return t.deadlineSpent(EL);
    let response;
    try {
      response = await fetchFn('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId), voiceFetchOpts({
        method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ text, model_id: modelId }),
        signal: t.signal
      }, capMs));
    } catch (error) { t.lad.fail(SO.errorLeg(EL, error, { cancelled: t.signal.aborted }), 'network: ' + ((error && error.message) || error)); return t.answerFailure(); }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 300); } catch (_) { detail = ''; }
      const reason = 'elevenlabs ' + response.status + (detail ? ' — ' + detail : '');
      t.lad.fail(SO.httpLeg(EL, response.status, detail, response.headers, reason), reason);
      return t.answerFailure();
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    let buf;
    try { buf = Buffer.from(await response.arrayBuffer()); }
    catch (error) { t.lad.fail(SO.errorLeg(EL, error, { cancelled: t.signal.aborted }), 'read: ' + ((error && error.message) || error)); return t.answerFailure(); }
    if (!buf.length) { t.lad.fail(SO.leg(EL, 'empty_audio', { detail: 'empty audio' }), 'empty audio'); return t.answerFailure(); }
    if (!/mpeg|mp3/.test(contentType)) { t.lad.fail(SO.leg(EL, 'bad_response', { detail: 'unexpected content-type: ' + contentType }), 'unexpected content-type: ' + contentType); return t.answerFailure(); }
    await writeClip(cacheKey + '.mp3', buf);
    speechStatus.record(SO.success(EL), 'tts');
    t.answerAudio(buf, { 'Content-Type': 'audio/mpeg', 'X-Voice-Cache': 'miss' }); sweepMaybe();
  }

  /* POST /api/tts — the desk's sentence ('desk' surface; 'live' when the desk speaks in a built-in voice). Every failure
     answers the 200 envelope
       { fallback:true, reason, outcome, retried }
     where `outcome` is the typed SpeechOutcome (sidecar/speech-outcome.js), `reason` the legacy string an older desk
     reads (kept for one release), and `retried` says the ladder already spent the one retry rule on it (the desk does
     not retry it again). Each leg is capped by what is left of the sentence's deadline (body.deadlineMs or
     X-Speech-Deadline-Ms), and a desk that goes away (barge-in, a closed page) cancels the legs it was waiting on.
     IDENTITY is the sidecar's: a desk that sends `persona` gets the station voice whatever voice, style or model it
     also sends (an older desk sends only those, and they are honoured for one release). `pin` (or the older
     `localEngine`) is the engine that spoke the reply's first sentence: the one continuity rule. */
  async function handleTts(req, res) {
    const lad = SO.ladder();
    const ac = new AbortController();
    if (res && typeof res.on === 'function') res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const gone = () => ac.signal.aborted || !!(res && res.destroyed);
    const answerFailure = () => {
      const outcome = lad.outcome();
      const reason = lad.reason('voice synthesis failed');
      speechStatus.record(outcome, 'tts');
      if (gone()) return;   // nobody is waiting for this answer
      logger.error('[tts] fallback →', reason);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ fallback: true, reason, outcome }));
    };
    const refuse = (code, detail) => { lad.fail(SO.leg('request', code, { detail }), detail); return answerFailure(); };
    const answerAudio = (buf, headers) => {
      if (gone()) return;
      res.writeHead(200, Object.assign({ 'Cache-Control': 'no-store' }, headers));
      res.end(buf);
    };
    let body;
    try { body = JSON.parse(await readBody(req, 1 << 16)); } catch (_) { return refuse('bad_input', 'bad json'); }
    // a desk that left while its body was still arriving is waiting for nothing: no leg is started for it
    if (gone()) return;
    const text = String((body && body.text) || '').replace(/\s+/g, ' ').trim();
    // Over the cap is REFUSED, never truncated: speaking only the first ~1200 characters and answering 200 audio
    // told the caller the whole script was said (voice_generate refuses the same way; the desk splits at 1000).
    if (text.length > 1200) return refuse('text_too_long', 'text is ' + text.length + ' characters; the per-request cap is 1200 — split it into sentences');
    const style = String((body && body.style) || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return refuse('no_text', 'no text');
    // ONE deadline for the whole sentence: every leg gets at most what is left of it (and never more than its own cap)
    const deadlineMs = speechDeadlineMs(req, body);
    const startedAt = monotonicNow();
    const legCap = cap => {
      if (!deadlineMs) return cap;
      const left = Math.floor(deadlineMs - (monotonicNow() - startedAt));
      return left < SPEECH_LEG_FLOOR_MS ? 0 : Math.min(cap, left);
    };
    const deadlineSpent = engine => {
      lad.fail(SO.leg(engine, 'timeout', { detail: 'the sentence deadline ran out before this leg could start' }), engine + ': deadline spent');
      return answerFailure();
    };
    const t = { lad, signal: ac.signal, refuse, answerFailure, answerAudio, legCap, deadlineSpent };
    if (String((body && body.provider) || '').trim().toLowerCase() === 'elevenlabs') return ttsElevenLabs(res, body, text, t);

    const live = !!(body && body.local);
    const surface = live ? 'live' : 'desk';
    const policy = SL.policyFor(surface, speechPolicy);
    let identity;
    if (live) {
      const localVoiceId = String(body.localVoice || localVoice.defaultVoice());
      let mapped = '';
      try { mapped = localVoice.edgeVoiceFor(localVoiceId); } catch (error) { logger.error('[tts] no mapped Edge voice for ' + localVoiceId + ':', errText(error)); }
      identity = Object.assign({ engine: 'local', localVoice: localVoiceId, mappedEdgeVoice: mapped, speed: Number(body.speed) || 1 }, keyedIdentity(null));
    } else if (body && typeof body.persona === 'string' && body.persona.trim()) {
      identity = Object.assign({ engine: 'keyed', edgeVoice: '' }, keyedIdentity(null));
    } else {
      // an older desk: the voice, style and model it sent (one release)
      identity = { engine: 'keyed', edgeVoice: '', model: String((body && body.model) || TTS_DEFAULT_MODEL).trim(), voice: String((body && body.voice) || 'Umbriel').trim(), style };
    }
    const pin = String((body && (body.pin || (live ? body.localEngine : ''))) || '').trim().toLowerCase();
    const prefer = normalizeProviderId(String((body && body.preferProvider) || ''));
    const r = await synthesize(text, {
      surface, identity, pin: SL.KEYED_ENGINES.concat(['edge', 'local-kokoro']).indexOf(pin) >= 0 ? pin : '',
      keyed: keyedCandidates(prefer, ttsPageKey(body && body.key, body && body.keyProvider)), policy, cache: policy.cache,
      signal: ac.signal, deadlineMs, gone, legCap, desk: true, source: 'tts',
      budgetLeft: () => deadlineMs ? deadlineMs - (monotonicNow() - startedAt) : Infinity
    });
    if (r.ok) {
      const provider = r.engine === 'edge' ? 'edge:' + r.edgeVoice : r.engine;
      answerAudio(r.buf, { 'Content-Type': r.mime, 'X-Voice-Provider': provider, 'X-Voice-Cache': r.cache || 'miss' });
      return;
    }
    if (r.gone || gone()) return;   // the desk went away: nobody is waiting (its legs are already in /api/tts/status)
    logger.error('[tts] fallback →', r.reason || 'voice synthesis failed');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ fallback: true, reason: r.reason || 'voice synthesis failed', outcome: r.outcome, retried: !!r.retried }));
  }

  // GET /api/tts/status — the last outcome of every speech leg (no secrets: engine, code, HTTP status, a short
  // detail, when, and which ladder tried it), plus whether the free floor is switched on.
  function ttsStatus() {
    const snap = speechStatus.snapshot();
    let edgeOn = false;
    try { edgeOn = !!edgetts.enabled(); } catch (_) { edgeOn = false; }
    return Object.assign({ edge: { enabled: edgeOn }, keyed: TTS_KEY_PROVIDERS.filter(p => !!providerRuntimeKey(p, '')) }, snap);
  }
  function handleTtsStatus(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(ttsStatus()));
  }

  /* STARTUP SELF-PROBE of the free floor: one short synth a little after boot, recorded as the edge leg's outcome
     (source 'self-probe') and logged in one line, so a floor Microsoft stopped answering (10-26: HTTP 403 on every
     request) is visible in the boot log and in /api/tts/status BEFORE a user meets a silent reply. Off when the floor
     is off, when it is aimed at a test host, or with SKYNET_EDGE_TTS_PROBE=0. Never throws; the timer is unref'd. */
  async function probeFloor(opts) {
    const o2 = opts || {};
    try {
      const buf = await edgetts.synth(String(o2.text || 'StarNet voice check.'), { nowMs: now(), timeoutMs: o2.timeoutMs || EDGE_LEG_CAP_MS });
      if (!buf || !buf.length) throw Object.assign(new Error('edge: empty audio'), { speechCode: 'empty_audio' });
      speechStatus.record(SO.success('edge'), 'self-probe');
      if (typeof logger.log === 'function') logger.log('  · voice floor: the free Edge voice answered its startup check (' + buf.length + ' bytes)');
      return { ok: true, bytes: buf.length };
    } catch (error) {
      const l = SO.errorLeg('edge', error);
      speechStatus.record(SO.outcome([l]), 'self-probe');
      logger.warn('[voice] the free Edge voice failed its startup check: ' + l.code + (l.http ? ' (HTTP ' + l.http + ')' : '') + ' — '
        + l.detail + '. A station with no OpenRouter, Gemini or OpenAI key will be silent until it answers.');
      return { ok: false, leg: l };
    }
  }
  function startFloorProbe(opts) {
    const o2 = opts || {};
    const off = /^(0|false|no|off)$/i.test(String(env('EDGE_TTS_PROBE') || '').trim());
    if (off || !edgetts.enabled() || String(env('EDGE_TTS_HOST') || '').trim()) return false;
    const timer = setTimeout(() => { probeFloor().catch(error => logger.warn('[voice] floor probe:', (error && error.message) || error)); }, o2.delayMs > 0 ? o2.delayMs : 15000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return true;
  }

  async function sttTranscribe(baseUrl, apiKey, whisperModel, audioBuf, filename, contentType, engine) {
    const multipart = sttMultipartBody(audioBuf, filename, contentType, { model: whisperModel }, o.randomBytes);
    let response;
    try {
      response = await fetchFn(baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', voiceFetchOpts({
        method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': multipart.contentType }, body: multipart.body
      }, 120000));
    } catch (error) { return { ok: false, reason: 'network: ' + ((error && error.message) || error), leg: SO.errorLeg(engine, error) }; }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch (_) { detail = ''; }
      const reason = whisperModel + ' ' + response.status + (detail ? ' — ' + detail : '');
      return { ok: false, reason, leg: SO.httpLeg(engine, response.status, detail, response.headers, reason) };
    }
    let json; try { json = await response.json(); } catch (_) { return { ok: false, reason: 'bad json from ' + whisperModel, leg: SO.leg(engine, 'bad_response', { detail: 'bad json from ' + whisperModel }) }; }
    return { ok: true, text: String((json && json.text) || '').trim() };
  }

  // One truthful capability snapshot for the classic push-to-talk button. The client cannot infer these
  // from browser APIs: desktop WebViews have MediaRecorder even when the only usable engine is native
  // Windows dictation, while the bundled local engine accepts PCM rather than the recorder's WebM/MP4.
  // Return booleans only — never provider credentials or paths. `cloud` counts the station's OpenRouter credential from
  // every source (a key a browser page saved used to read false, probe P2), and so does `available`: a station whose only
  // engine is that key can transcribe. `preferred` is the rule it always was over the credentials it always counted: a
  // 'gap' credential (decision 1) never changes which engine the desk prefers, so a station that preferred its local or
  // native engine, or the browser's own, keeps it and nobody's speech billing moves.
  function sttStatus() {
    const or = credentialFor('openrouter');
    const primary = !!(providerRuntimeKey('groq', '') || providerRuntimeKey('openai', '') || (or.key && or.rank !== 'gap'));
    const cloud = primary || !!or.key;
    const local = (() => { try { return !!localVoice.status().available; } catch (_) { return false; } })();
    const native = (() => { try { return !!nativeStt.status().available; } catch (_) { return false; } })();
    const preferred = primary ? 'cloud' : local ? 'local' : native ? 'native' : 'none';
    return { available: preferred !== 'none' || cloud, preferred, cloud, local, native };
  }

  /* The STT ladder (Groq whisper → OpenAI whisper → OpenRouter audio-in chat → the local engine → a 'gap' OpenRouter
     credential). A failure is { ok:false, reason, outcome }: `outcome` is the typed SpeechOutcome over every leg tried;
     `reason` stays the LAST leg's legacy text (what callers have always shown). `apiKey`: an OpenRouter key the page sent
     with this request (openRouterPageKey), which goes where the station's own credential would have gone and to the
     endpoint that key resolves to. Otherwise the OpenRouter leg is the station's credential (credentialFor), placed by its
     rank: a 'primary' one (the keychain's, the branded export: what the alias covered) before the local engine, as it
     always ran; a 'gap' one (a key a page saved, a bare OPENROUTER_API_KEY) after it, so a station whose local engine
     transcribes keeps transcribing for free. Every leg dials the endpoint saved with the key it sends. */
  async function transcribeAudioBuffer(audioBuf, format, apiKey) {
    const lad = SO.ladder();
    let lastReason = 'no transcription';
    const failed = reason => {
      const outcome = lad.outcome();
      speechStatus.record(outcome, 'stt');
      return { ok: false, reason, outcome };
    };
    const heard = (engine, text) => { speechStatus.record(SO.success(engine), 'stt'); return { ok: true, text: String(text || '') }; };
    if (!audioBuf || !audioBuf.length) { lad.fail(SO.leg('request', 'no_text', { detail: 'no audio' })); return failed('no audio'); }
    const pageKey = String(apiKey || '').trim();
    const station = pageKey ? null : credentialFor('openrouter');
    const key = pageKey || (station ? station.key : '');
    const keyFirst = !!pageKey || (!!key && station.rank !== 'gap');
    const groqKey = providerRuntimeKey('groq', '');
    const openaiKey = providerRuntimeKey('openai', '');
    const localReady = (() => { try { return !!localVoice.status().available; } catch (_) { return false; } })();
    if (!groqKey && !openaiKey && !key && !localReady) {
      lad.fail(SO.leg('keyed', 'no_key', { detail: 'no Groq, OpenAI or OpenRouter credential, and no local engine' }));
      return failed('no key');
    }
    format = (format === 'x-wav' || format === 'wave') ? 'wav' : (format || 'webm');
    const filename = 'audio.' + format;
    const contentType = 'audio/' + format;
    // a Whisper leg: the operator's transcription endpoint, else the one saved with that provider's key
    const whisper = async (engine, k, model) => {
      const result = await sttTranscribe(sttEnvBase[engine] || legBase(engine, k), k, model, audioBuf, filename, contentType, engine);
      if (result.ok) return heard(engine, result.text);
      lastReason = engine + ': ' + result.reason;
      lad.fail(result.leg);
      return null;
    };
    // the OpenRouter leg: audio-in chat at the endpoint saved with `key`
    const openRouter = async () => {
      const base = legBase('openrouter', key);
      const audio = audioBuf.toString('base64');
      for (const model of sttModels) {
        let response;
        try {
          response = await fetchFn(base + '/chat/completions', voiceFetchOpts({
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://localhost', 'X-Title': 'STARNET' },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: [
              { type: 'input_audio', input_audio: { data: audio, format } }, { type: 'text', text: STT_PROMPT }
            ] }] })
          }, 120000));
        } catch (error) { lastReason = 'network: ' + ((error && error.message) || error); lad.fail(SO.errorLeg('openrouter', error)); continue; }
        if (!response.ok) {
          let detail = '';
          try { detail = (await response.text()).slice(0, 200); } catch (_) { detail = ''; }
          lastReason = model + ' → openrouter ' + response.status + (detail ? ' — ' + detail : '');
          lad.fail(SO.httpLeg('openrouter', response.status, detail, response.headers, lastReason));
          continue;
        }
        let json; try { json = await response.json(); } catch (_) { lastReason = 'bad json from ' + model; lad.fail(SO.leg('openrouter', 'bad_response', { detail: lastReason })); continue; }
        const text = String((json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '').trim();
        return heard('openrouter', text);
      }
      return null;
    };
    const viaGroq = groqKey ? await whisper('groq', groqKey, STT_GROQ_MODEL) : null;
    if (viaGroq) return viaGroq;
    const viaOpenAI = openaiKey ? await whisper('openai', openaiKey, STT_OPENAI_MODEL) : null;
    if (viaOpenAI) return viaOpenAI;
    const viaOpenRouter = key && keyFirst ? await openRouter() : null;
    if (viaOpenRouter) return viaOpenRouter;
    if (localReady) {
      if (/^(?:wav|ogg|opus)$/i.test(format)) {
        try {
          const pcm = /^wav$/i.test(format)
            ? wavToMono16kFloat32(audioBuf)
            : await decodeOggOpus(audioBuf);
          if (pcm) {
            const text = await localVoice.transcribe(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
            return heard('local', text);
          }
          lastReason = 'local: unreadable ' + format;
          lad.fail(SO.leg('local', 'bad_input', { detail: 'unreadable ' + format }));
        } catch (error) {
          lastReason = 'local: ' + ((error && error.message) || error);
          lad.fail(SO.leg('local', error && error.unavailable ? 'local_unavailable' : 'local_failed', { detail: (error && error.message) || error }));
        }
      } else {
        lastReason = lastReason === 'no transcription'
          ? 'local engine cannot decode ' + format
          : lastReason + '; local engine cannot decode ' + format;
        lad.fail(SO.leg('local', 'bad_input', { detail: 'the local engine cannot decode ' + format }));
      }
    }
    const viaGap = key && !keyFirst ? await openRouter() : null;   // a 'gap' credential only fills a gap
    if (viaGap) return viaGap;
    return failed(lastReason);
  }

  async function transcribeForMime(buffer, mime) {
    const match = /(webm|wav|mp3|mpeg|m4a|mp4)/.exec(String(mime || ''));
    const format = /ogg|opus/.test(String(mime || '')) ? 'ogg' : (match ? match[1] : 'ogg');
    try { return await transcribeAudioBuffer(buffer, format === 'mpeg' ? 'mp3' : format); }
    catch (error) {
      // the ladder itself threw (it never should): typed and named, never a bare string
      const outcome = SO.outcome([SO.errorLeg('station', error)]);
      speechStatus.record(outcome, 'stt');
      return { ok: false, reason: (error && error.message) || 'transcribe failed', outcome };
    }
  }

  /* A page credential reaches the OpenRouter leg ONLY when it IS an OpenRouter key. The desk used to send its RUN
     provider's key (Harness.getKey()) as X-OpenRouter-Key, so a browser-mode OpenAI or Anthropic station shipped that
     secret to openrouter.ai as a Bearer token on every spoken sentence. The page now names the pair ({key, keyProvider}
     in a JSON body, X-Speech-Key-Provider beside the raw-bytes header), as the TTS route's keyProvider already does. A
     legacy page that names no provider is trusted only for an sk-or- key; any other pair is not used at all. The leg
     then dials the endpoint that key resolves to (the credential store's endpointFor), never another key's. */
  function openRouterPageKey(key, provider) {
    const k = String(key || '').trim();
    if (!k) return '';
    const named = String(provider || '').trim();
    if (named) return normalizeProviderId(named) === 'openrouter' ? k : '';
    return /^sk-or-/i.test(k) ? k : '';
  }

  /* The same rule for the desk's spoken sentence (POST /api/tts {key, keyProvider}): a page key is used only with the
     TTS provider it is NAMED for. A key named for a provider that has no voice (an Anthropic key), or a legacy body
     that names none, used to be re-labelled 'openrouter' and sent to openrouter.ai as a Bearer token; now an unnamed
     key is trusted only when it is an sk-or- key, and anything else is ignored (the station's own keys and the free
     floor answer instead). A page key dials the endpoint IT resolves to (ttsSynthKeyed), which used to be the endpoint of
     the station's own key for that provider. */
  function ttsPageKey(key, provider) {
    const k = String(key || '').trim();
    if (!k) return null;
    const named = String(provider || '').trim();
    if (named) {
      const p = normalizeProviderId(named);
      return TTS_KEY_PROVIDERS.includes(p) ? { key: k, provider: p } : null;
    }
    return /^sk-or-/i.test(k) ? { key: k, provider: 'openrouter' } : null;
  }

  async function handleStt(req, res) {
    const ok = text => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ text: String(text || '') }));
    };
    // the 200 degrade envelope: the legacy reason plus the typed outcome (sidecar/speech-outcome.js)
    const degrade = (reason, outcome) => {
      logger.warn('[stt] →', reason);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ text: '', reason, outcome: outcome || SO.outcome([SO.leg('request', 'bad_input', { detail: reason })]) }));
    };
    const requestType = String(req.headers['content-type'] || '').toLowerCase();
    let audioB64 = '', format = '', key = '';
    try {
      if (requestType.startsWith('application/json')) {
        const raw = await readBodyBuffer(req, Math.ceil(STT_MAX_BYTES * 1.4)).catch(() => Buffer.alloc(0));
        const body = JSON.parse(raw.toString('utf8') || '{}');
        audioB64 = String((body && body.audio) || '').replace(/^data:[^,]*,/, '');
        format = String((body && body.format) || '').trim();
        key = openRouterPageKey(body && body.key, body && body.keyProvider);
      } else {
        const buf = await readBodyBuffer(req, STT_MAX_BYTES);
        audioB64 = buf.toString('base64');
        const match = requestType.match(/audio\/(?:x-)?([a-z0-9]+)/);
        format = match ? match[1] : '';
        key = openRouterPageKey(req.headers['x-openrouter-key'], req.headers['x-speech-key-provider']);
      }
    } catch (error) { return degrade('body: ' + ((error && error.message) || error)); }
    if (!audioB64) return degrade('no audio', SO.outcome([SO.leg('request', 'no_text', { detail: 'no audio' })]));
    const result = await transcribeAudioBuffer(Buffer.from(audioB64, 'base64'), format, key);
    return result.ok ? ok(result.text) : degrade(result.reason, result.outcome);
  }

  function handleSttStatus(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(sttStatus()));
  }

  function handleNativeSttStatus(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(nativeStt.status()));
  }

  async function handleNativeStt(req, res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let pcm = Buffer.alloc(0);
    try { pcm = await readBodyBuffer(req, 4 * 16000 * 120, res); }
    catch (_) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, text: '', error: 'invalid audio payload' }));
    }
    const audioWav = pcm.length ? float32PcmToWav(pcm, 16000) : null;
    const result = pcm.length && !audioWav
      ? { ok: false, text: '', error: 'invalid audio payload' }
      : await nativeStt.recognize({ signal: ac.signal, audioWav });
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  }

  function handleLocalVoiceStatus(req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...localVoice.status(), streaming: true }));
  }

  async function handleLocalVoiceStream(req, res) {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const action = query.get('action');
    let result;
    try {
      if (action === 'open') result = voiceStreams.open();
      else {
        const bytes = action === 'audio' ? await readBodyBuffer(req, 64000, res) : undefined;
        result = await voiceStreams.action(query.get('id'), action, bytes);
      }
    } catch (e) { result = { error: String(e.message || e) }; }
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  }

  async function handleLocalVoiceWarm(req, res) {
    const json = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const current = localVoice.status();
    if (!current.available) return json(501, current);
    localVoice.warm({ tts: new URL(req.url, 'http://localhost').searchParams.get('tts') !== '0' }).catch(error => logger.error('[local-voice] warm failed:', (error && error.message) || error));
    json(202, current);
  }

  async function handleLocalVoiceTranscribe(req, res) {
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    const json = (code, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    let pcm;
    try { pcm = await readBodyBuffer(req, 4 * 16000 * 120, res); }
    catch (error) { if (!res.headersSent) json(error && error.tooLarge ? 413 : 400, { error: 'invalid audio payload' }); return; }
    try { json(200, { ok: true, text: await localVoice.transcribe(pcm, { signal: ac.signal }) }); }
    catch (error) { json(error && error.unavailable ? 501 : 503, { ok: false, error: String((error && error.message) || error) }); }
  }

  function ttsFailOpenPolicy(res, error) {
    try {
      if (!res.headersSent) {
        // the SAME envelope every other TTS failure answers ({fallback, reason}): a body with only `error` left the desk
        // no reason to read, so it saw 'http 200' and retried a crashed handler as if it were a network blip
        const reason = redact('tts failure: ' + ((error && error.message) || error));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        const outcome = SO.outcome([SO.leg('station', 'internal_error', { detail: reason })]);   // a bug, not a blip: terminal, named
        speechStatus.record(outcome, 'tts');
        res.end(JSON.stringify({ fallback: true, reason, error: reason, outcome }));
      } else res.end();
    } catch (_) { try { res.end(); } catch (_) {} }
  }

  function sttFailOpenPolicy(res, error) {
    try {
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        const reason = redact('stt failure: ' + ((error && error.message) || error));
        res.end(JSON.stringify({ text: '', reason, outcome: SO.outcome([SO.leg('station', 'internal_error', { detail: reason })]) }));
      } else res.end();
    } catch (_) { try { res.end(); } catch (_) {} }
  }

  return {
    synthesizeForAgent,
    synthesizeStationVoice,
    voiceRouteAvailable,
    sttStatus,
    transcribeAudioBuffer,
    transcribeForMime,
    handleTts,
    handleSttStatus,
    handleStt,
    handleNativeSttStatus,
    handleNativeStt,
    handleLocalVoiceStatus,
    handleLocalVoiceWarm,
    handleLocalVoiceTranscribe,
    handleLocalVoiceStream,
    ttsFailOpenPolicy,
    sttFailOpenPolicy,
    ttsStatus,
    handleTtsStatus,
    probeFloor,
    startFloorProbe,
    _internals: { ttsSynthKeyed, sttTranscribe, maybeEvictVoiceCache, voiceCacheDir }
  };
}

module.exports = {
  makeMediaService,
  pcmToWav,
  float32PcmToWav,
  wavToMono16kFloat32,
  oggOpusToMono16kFloat32,
  sttMultipartBody,
  constants: { TTS_DEFAULT_MODEL, TTS_KEY_PROVIDERS, STT_MAX_BYTES, STT_GROQ_MODEL, STT_OPENAI_MODEL }
};
