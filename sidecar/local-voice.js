'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

// Per-user model cache, alongside the rest of the app's data root (%LOCALAPPDATA%\Agent OS on Windows,
// ~/Library/Application Support/Agent OS on macOS — the two platforms we ship). Never inside the repo:
// these are ~150 MB of downloaded weights, and PRIVACY.md documents this path for manual removal.
function defaultCacheRoot() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Agent OS', 'models');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Agent OS', 'models');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'starnet', 'models');
}

const cacheRoot = process.env.STARNET_MODEL_CACHE || defaultCacheRoot();
const state = { asr: 'cold', tts: 'cold', ttsPrecision: '', progress: null, error: '', cacheRoot };
/* THE SPOKEN VOICE OF THE STATION — male by default. The written station voice is "a low, smooth American
   male with a subtle gravelly rasp" (personas.js STATION_VOICE) and the crew sprites read male, so a female
   default was simply wrong. These ids are the engine's own voice files (node_modules/kokoro-js/voices):
   `am_` American male, `bm_` British male, `af_`/`bf_` the female sets. Listed male-first because that is the
   station's character; every one of them is selectable. */
const DEFAULT_LOCAL_VOICE = 'am_onyx';
/* `edge` on every row: the nearest Microsoft Edge read-aloud neural to that voice. This is the built-in
   fallback identity when the bundled offline engine is disabled, damaged, or unavailable, and before this
   mapping existed /api/tts silently fell through to the KEYED provider voice:
   the picker was inert and the station spoke with a completely different identity than the one chosen
   (2026-07-30, found by Andrew's ears on a stale-node_modules dev server that behaved like an installed
   build). The mapping lives ON the catalogue row so a new voice cannot be added without deciding its
   shipped fallback — a test fails on any row without one. Sex and accent are preserved; the Edge free
   set has only ~5 male American neurals for our 8, so some picks share a nearest neighbour — a coarser
   voice on a degraded installation is honest, the WRONG voice is not. */
const LOCAL_VOICES = [
  { id: 'am_onyx', label: 'ONYX', sex: 'male', accent: 'American', edge: 'en-US-ChristopherNeural' },
  { id: 'am_michael', label: 'MICHAEL', sex: 'male', accent: 'American', edge: 'en-US-GuyNeural' },
  { id: 'am_adam', label: 'ADAM', sex: 'male', accent: 'American', edge: 'en-US-RogerNeural' },
  { id: 'am_eric', label: 'ERIC', sex: 'male', accent: 'American', edge: 'en-US-EricNeural' },
  { id: 'am_liam', label: 'LIAM', sex: 'male', accent: 'American', edge: 'en-US-SteffanNeural' },
  { id: 'am_fenrir', label: 'FENRIR', sex: 'male', accent: 'American', edge: 'en-US-ChristopherNeural' },
  { id: 'am_echo', label: 'ECHO', sex: 'male', accent: 'American', edge: 'en-US-GuyNeural' },
  { id: 'am_puck', label: 'PUCK', sex: 'male', accent: 'American', edge: 'en-US-SteffanNeural' },
  { id: 'bm_george', label: 'GEORGE', sex: 'male', accent: 'British', edge: 'en-GB-RyanNeural' },
  { id: 'bm_lewis', label: 'LEWIS', sex: 'male', accent: 'British', edge: 'en-GB-ThomasNeural' },
  { id: 'bm_daniel', label: 'DANIEL', sex: 'male', accent: 'British', edge: 'en-GB-ThomasNeural' },
  { id: 'bm_fable', label: 'FABLE', sex: 'male', accent: 'British', edge: 'en-GB-RyanNeural' },
  { id: 'af_heart', label: 'HEART', sex: 'female', accent: 'American', edge: 'en-US-JennyNeural' },
  { id: 'af_bella', label: 'BELLA', sex: 'female', accent: 'American', edge: 'en-US-AriaNeural' },
  { id: 'af_nova', label: 'NOVA', sex: 'female', accent: 'American', edge: 'en-US-MichelleNeural' },
  { id: 'af_sarah', label: 'SARAH', sex: 'female', accent: 'American', edge: 'en-US-JennyNeural' },
  { id: 'bf_emma', label: 'EMMA', sex: 'female', accent: 'British', edge: 'en-GB-SoniaNeural' },
  { id: 'bf_alice', label: 'ALICE', sex: 'female', accent: 'British', edge: 'en-GB-LibbyNeural' }
];
const localVoiceIds = new Set(LOCAL_VOICES.map(v => v.id));
// Validated, never passed through: an unknown id would fail deep inside the engine with a stack trace
// instead of simply speaking in the default voice.
function normalizeLocalVoice(id) {
  const v = String(id || '').trim();
  return localVoiceIds.has(v) ? v : '';
}
/* The SHIPPED identity of a picked voice: the Edge neural nearest to it (see the catalogue note). An
   unknown/empty pick maps through the default voice, so the answer is always a real Edge voice name —
   the caller never has to invent one, and never falls back to a different provider's identity. */
function edgeVoiceFor(id) {
  const want = normalizeLocalVoice(id) || DEFAULT_LOCAL_VOICE;
  const row = LOCAL_VOICES.find(v => v.id === want) || LOCAL_VOICES[0];
  return row.edge;
}



// ---- installation probe -------------------------------------------------------------------------
// Offline speech needs two npm packages (`@huggingface/transformers` + `kokoro-js`, which drags in
// onnxruntime-node's native binaries). Release builds stage that runtime closure beside `sidecar/`, where
// Node resolves it normally. `status()` must still PROVE the packages are present rather than infer them
// from being packaged: an interrupted/custom install or explicit opt-out must degrade truthfully, and
// before this probe existed the panel showed users a raw "Cannot find module" string.
const REQUIRED_PACKAGES = ['@huggingface/transformers', 'kokoro-js'];
const UNAVAILABLE_REASON =
  'offline speech models are not installed in this build (run "npm install" in a source checkout to enable them)';
let installedCache = null;

function packagePresent(name) {
  try {
    require.resolve(name);
    return true;
  } catch (error) {
    // An ESM-only package whose exports map omits the `require` condition still PROVES it is on disk —
    // resolution got far enough to read its package.json before rejecting the CommonJS condition.
    const code = error && error.code;
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_REQUIRE_ESM') return true;
  }
  // Fallback for any other resolver refusal: look for the package directory itself on the module paths.
  for (const base of module.paths || []) {
    if (fs.existsSync(path.join(base, ...name.split('/'), 'package.json'))) return true;
  }
  return false;
}

/* Kill-switch: STARNET_LOCAL_VOICE=0 (or SKYNET_) forces the engine unavailable even where the packages
   resolve. Two real uses: a user opting out of the on-disk models, and TESTS reproducing the installed-build
   shape (no node_modules) on a dev checkout — the shape the 2026-07-30 keyed-fallthrough bug only showed on.
   Read dynamically (not cached) so a spawned test server's env always wins over require-time state. */
function disabledByEnv() {
  const v = process.env.STARNET_LOCAL_VOICE != null ? process.env.STARNET_LOCAL_VOICE : process.env.SKYNET_LOCAL_VOICE;
  return /^(0|false|no|off)$/i.test(String(v == null ? '' : v).trim());
}

function installed() {
  if (disabledByEnv()) return false;
  if (installedCache === null) installedCache = REQUIRED_PACKAGES.every(packagePresent);
  return installedCache;
}

function requireInstalled() {
  if (!installed()) {
    const error = new Error(UNAVAILABLE_REASON);
    error.unavailable = true;
    throw error;
  }
}
let transformersPromise = null;
let transcriberPromise = null;
let kokoroPromise = null;
let asrTail = Promise.resolve();
let asrBusy = 0;
let lastAsrMs = null;
let ttsTail = Promise.resolve();
let ttsBusy = 0;
let lastTtsMs = null;
const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

// Transformers eagerly loads Sharp even though Agent OS's offline voice paths are audio/text only. Sharp
// <0.35 inherits vulnerable libvips loaders; upstream's documented compatible workaround is to disable
// GIF, TIFF, and VIPS decoding. Apply it before either Transformers copy is imported so future call sites
// cannot accidentally turn an unused image surface into an untrusted-input decoder.
const BLOCKED_SHARP_LOADERS = Object.freeze([
  'VipsForeignLoadNsgif',
  'VipsForeignLoadTiff',
  'VipsForeignLoadVips'
]);
function hardenSharpImageDecoders(sharpImpl = require('sharp')) {
  if (!sharpImpl || typeof sharpImpl.block !== 'function') {
    throw new Error('offline speech image-decoder hardening is unavailable');
  }
  sharpImpl.block({ operation: BLOCKED_SHARP_LOADERS.slice() });
}

async function transformers() {
  if (!transformersPromise) {
    hardenSharpImageDecoders();
    transformersPromise = import('@huggingface/transformers').then(mod => {
      mod.env.cacheDir = path.join(cacheRoot, 'transformers');
      mod.env.allowLocalModels = true;
      mod.env.allowRemoteModels = true;
      return mod;
    });
  }
  return transformersPromise;
}

function onProgress(kind, event) {
  if (!event || typeof event !== 'object') return;
  const pct = Number(event.progress);
  state.progress = {
    kind,
    file: path.basename(String(event.file || event.name || 'model')),
    percent: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null
  };
}

async function loadAsr() {
  if (!transcriberPromise) {
    state.asr = 'loading';
    transcriberPromise = (async () => {
      await fsp.mkdir(path.join(cacheRoot, 'transformers'), { recursive: true });
      const { pipeline } = await transformers();
      const pipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: event => onProgress('asr', event)
      });
      state.asr = 'ready';
      state.progress = null;
      return pipe;
    })().catch(error => {
      state.asr = 'error';
      state.error = String(error && error.message || error);
      transcriberPromise = null;
      throw error;
    });
  }
  return transcriberPromise;
}

/* Which Kokoro precision to load, best first. fp32 is the reference model and only ~20 MB larger than the
   q4 export the engine used to load (326 vs 305 MB — Kokoro is mostly convolution, which q4 leaves alone,
   so q4 bought almost no size while 4-bit MatMuls added an audible buzz). q8 stays out: it fails to
   initialize in onnxruntime-node on some Windows machines. q4 remains the fallback so a machine where fp32
   cannot load still speaks. STARNET_KOKORO_DTYPE pins one precision (no fallback) for diagnosis.
   A machine that already holds the q4 copy (an install from before fp32) and not fp32 keeps speaking from it:
   loading fp32 first would make its next reply wait on a ~326 MB download and keep two copies on disk. */
function kokoroOnnxDir(root) {
  return path.join(root, 'transformers-kokoro', 'onnx-community', 'Kokoro-82M-v1.0-ONNX', 'onnx');
}
function kokoroDtypes(root = cacheRoot) {
  const pinned = String(process.env.STARNET_KOKORO_DTYPE || process.env.SKYNET_KOKORO_DTYPE || '').trim();
  if (pinned) return [pinned];
  const dir = kokoroOnnxDir(root);
  if (fs.existsSync(path.join(dir, 'model_q4.onnx')) && !fs.existsSync(path.join(dir, 'model.onnx'))) return ['q4', 'fp32'];
  return ['fp32', 'q4'];
}

/* Is the Kokoro model this machine would load first already on disk? Then a cold engine loads it in seconds;
   otherwise its first load is a ~326 MB download. The station voice (media-service) waits for a disk load but
   never for a download. Checks the file of the precision kokoroDtypes puts first (the transformers file names). */
const KOKORO_FILE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
function kokoroCached(root = cacheRoot) {
  const first = kokoroDtypes(root)[0];
  if (!Object.prototype.hasOwnProperty.call(KOKORO_FILE_SUFFIX, first)) return false;
  return fs.existsSync(path.join(kokoroOnnxDir(root), 'model' + KOKORO_FILE_SUFFIX[first] + '.onnx'));
}

async function loadTts() {
  if (!kokoroPromise) {
    state.tts = 'loading';
    kokoroPromise = (async () => {
      await fsp.mkdir(path.join(cacheRoot, 'transformers'), { recursive: true });
      await transformers();
      // kokoro-js 1.2 checks a free `__dirname` before import.meta.dirname when locating its bundled voice
      // vectors. A CommonJS host exposes that name globally to the ESM bundle, so point it at Kokoro's dist
      // directory instead of the app entry point.
      const kokoroEntry = require.resolve('kokoro-js');
      global.__dirname = path.dirname(kokoroEntry);
      // Kokoro currently carries Transformers v3 while ASR uses v4. Configure that nested copy separately
      // so both model families live in the per-user cache rather than inside the repository.
      const kokoroTransformersEntry = require.resolve('@huggingface/transformers', {
        paths: [path.dirname(kokoroEntry)]
      });
      const kokoroTransformers = await import(pathToFileURL(kokoroTransformersEntry).href);
      (kokoroTransformers.env || kokoroTransformers.default.env).cacheDir =
        path.join(cacheRoot, 'transformers-kokoro');
      const { KokoroTTS } = await import('kokoro-js');
      let model = null, lastError = null;
      for (const dtype of kokoroDtypes()) {
        try {
          model = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
            dtype,
            device: 'cpu',
            progress_callback: event => onProgress('tts', event)
          });
          state.ttsPrecision = dtype;
          break;
        } catch (error) { lastError = error; }
      }
      if (!model) throw lastError || new Error('no Kokoro precision could be loaded');
      state.tts = 'ready';
      state.progress = null;
      return model;
    })().catch(error => {
      state.tts = 'error';
      state.error = String(error && error.message || error);
      kokoroPromise = null;
      throw error;
    });
  }
  return kokoroPromise;
}

async function warm(options = {}) {
  requireInstalled();
  const jobs = [];
  if (options.asr !== false) jobs.push(loadAsr());
  if (options.tts !== false) jobs.push(loadTts());
  const results = await Promise.allSettled(jobs);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return status();
}

async function transcribe(buffer, options = {}) {
  const checkAbort = () => {
    if (options.signal && options.signal.aborted) {
      const error = new Error('transcription cancelled'); error.name = 'AbortError'; throw error;
    }
  };
  checkAbort();
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length % 4) {
    throw new Error('invalid 16 kHz Float32 PCM payload');
  }
  // Availability is checked BEFORE the silence gate: a build that cannot hear must say so, never return
  // an empty transcript that reads as "you said nothing".
  requireInstalled();
  const samples = new Float32Array(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  );
  let energy = 0;
  for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
  const rms = Math.sqrt(energy / samples.length);
  if (rms < 0.0025) return options.words ? { text: '', chunks: [] } : '';
  const run = async () => {
    checkAbort();
    asrBusy++;
    const started = monotonicMs();
    try {
      const pipe = await loadAsr();
      checkAbort();
      const result = await pipe(samples, { chunk_length_s: 20, stride_length_s: 3,
        ...(options.words ? { return_timestamps: 'word' } : {}) });
      checkAbort();
      let text = String(result && result.text || '').replace(/\[(?:blank_audio|blank audio|silence|music)\]/ig, '').trim();
      if (rms < 0.006 && /^(?:you|thank you|thanks for watching|the end)[.!]?$/i.test(text)) text = '';
      return options.words ? { text, chunks: text ? result.chunks || [] : [] } : text;
    } finally {
      lastAsrMs = monotonicMs() - started;
      asrBusy = Math.max(0, asrBusy - 1);
    }
  };
  // ONNX sessions are not safely concurrent on every Windows CPU backend. Serialize partial/final requests;
  // the browser permits only one partial in flight, so a final turn waits behind at most one preview.
  const queued = asrTail.then(run, run);
  asrTail = queued.catch(() => {});
  return queued;
}

/* ---- how a reply becomes natural-sounding Kokoro audio ------------------------------------------------
   Kokoro reads at most 510 phoneme tokens per call and SILENTLY DROPS the rest: a 1000-character chunk lost
   its back half. It also phrases best one or two sentences at a time. So a request is cut into sentence-
   sized pieces (never mid-number: a boundary is terminal punctuation FOLLOWED BY a space), each piece is
   generated on its own, its edge silence is trimmed, and the pieces are joined with a pause that matches
   the punctuation that ended them — the rhythm a person leaves, rather than whatever silence each call
   happened to carry. The clip's level is evened out so consecutive replies do not jump in loudness. */
const PIECE_MAX = 300;          // characters; English runs ~1 phoneme token per character, well under 510
const SR_FALLBACK = 24000;
const LEAD_S = 0.03;            // kept ahead of the first voiced sound (no clipped consonant, no dead air)
const TAIL_S = 0.05;            // kept after the last voiced sound (lets the final syllable decay)
const GAP_S = { sentence: 0.24, clause: 0.14, word: 0.06 };

function speechPieces(text, max = PIECE_MAX) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = [];
  const boundary = /[.!?…]+["'”’)\]]*(?= |$)/g;
  let start = 0, m;
  while ((m = boundary.exec(clean))) {
    const end = m.index + m[0].length;
    const s = clean.slice(start, end).trim();
    if (s) sentences.push(s);
    start = end;
  }
  if (start < clean.length && clean.slice(start).trim()) sentences.push(clean.slice(start).trim());
  const pieces = [];
  let cur = '';
  for (const sentence of sentences) {
    let s = sentence;
    if (cur && cur.length + 1 + s.length <= max) { cur += ' ' + s; continue; }
    if (cur) { pieces.push(cur); cur = ''; }
    // One sentence over the cap: break at its last clause mark inside the window, else its last space.
    while (s.length > max) {
      const window = s.slice(0, max);
      let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '),
        window.lastIndexOf(' — '), window.lastIndexOf(' – '));
      if (cut < max * 0.4) cut = window.lastIndexOf(' ');
      if (cut <= 0) cut = max - 1;
      pieces.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    cur = s;
  }
  if (cur) pieces.push(cur);
  return pieces;
}

function gapAfter(piece) {
  const t = String(piece || '').trim();
  if (/[.!?…]["'”’)\]]*$/.test(t)) return GAP_S.sentence;
  if (/[,;:—–-]$/.test(t)) return GAP_S.clause;
  return GAP_S.word;
}

// [first, last) sample span that carries voice: 5 ms windows above about -46 dBFS RMS, plus lead/tail.
function voicedSpan(samples, rate) {
  const win = Math.max(1, Math.round(rate * 0.005)), n = samples.length;
  let first = -1, last = -1;
  for (let i = 0; i < n; i += win) {
    let e = 0; const end = Math.min(n, i + win);
    for (let j = i; j < end; j++) e += samples[j] * samples[j];
    if (Math.sqrt(e / (end - i)) > 0.005) { if (first < 0) first = i; last = end; }
  }
  if (first < 0) return null;
  return [Math.max(0, first - Math.round(rate * LEAD_S)), Math.min(n, last + Math.round(rate * TAIL_S))];
}

// Join generated pieces: trim each, 4 ms fade-in / 12 ms fade-out at the cut edges (no clicks), the
// punctuation pause after every piece (the last one becomes the gap before the NEXT chunk the page
// plays), then one gain for the whole clip toward a speech-level RMS, never past a 0.95 peak.
function assembleClip(clips, pieces) {
  const rate = (clips.find(c => c && c.sampling_rate) || {}).sampling_rate || SR_FALLBACK;
  const parts = [];
  let total = 0;
  clips.forEach((clip, i) => {
    const samples = clip && clip.audio;
    if (!samples || !samples.length) return;
    const span = voicedSpan(samples, rate);
    if (!span) return;
    const body = Float32Array.from(samples.subarray(span[0], span[1]));
    const fin = Math.min(body.length, Math.round(rate * 0.004)), fout = Math.min(body.length, Math.round(rate * 0.012));
    for (let k = 0; k < fin; k++) body[k] *= k / fin;
    for (let k = 0; k < fout; k++) body[body.length - 1 - k] *= k / fout;
    const gap = Math.round(rate * gapAfter(pieces[i]));
    parts.push(body, new Float32Array(gap));
    total += body.length + gap;
  });
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  let peak = 0, energy = 0, voiced = 0;
  const win = Math.max(1, Math.round(rate * 0.02));
  for (let i = 0; i < out.length; i += win) {
    let e = 0; const end = Math.min(out.length, i + win);
    for (let j = i; j < end; j++) { const v = out[j]; e += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    if (Math.sqrt(e / (end - i)) > 0.01) { energy += e; voiced += end - i; }
  }
  if (voiced && peak) {
    const rms = Math.sqrt(energy / voiced);
    const gain = Math.min(0.95 / peak, Math.max(0.5, Math.min(2, 0.1 / rms)));
    if (Math.abs(gain - 1) > 0.01) for (let i = 0; i < out.length; i++) out[i] *= gain;
  }
  return { samples: out, rate };
}

// 16-bit PCM mono WAV: half the bytes of the engine's float32 WAV, and every webview decodes it.
function wav16(samples, rate) {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// The engine-independent half of synthesis, so a test can drive it with a stub model.
async function renderSpeech(model, text, options = {}) {
  const pieces = speechPieces(String(text || '').slice(0, 1200));
  if (!pieces.length) throw new Error('nothing to say');
  const voice = normalizeLocalVoice(options.voice) || DEFAULT_LOCAL_VOICE;
  const speed = Number(options.speed) || 1;
  const clips = [];
  for (const piece of pieces) clips.push(await model.generate(piece, { voice, speed }));
  const { samples, rate } = assembleClip(clips, pieces);
  if (!samples.length) throw new Error('the voice engine returned silence');
  return wav16(samples, rate);
}

async function synthesize(text, options = {}) {
  requireInstalled();
  const run = async () => {
    ttsBusy++;
    const started = monotonicMs();
    try {
      return await renderSpeech(await loadTts(), text, options);
    } finally {
      lastTtsMs = monotonicMs() - started;
      ttsBusy = Math.max(0, ttsBusy - 1);
    }
  };
  const queued = ttsTail.then(run, run);
  ttsTail = queued.catch(() => {});
  return queued;
}

function status() {
  const ready = installed();
  return {
    available: ready,
    reason: ready ? '' : UNAVAILABLE_REASON,
    // 'unavailable' rather than 'cold': cold promises a warm-up that will never come.
    asr: ready ? state.asr : 'unavailable',
    tts: ready ? state.tts : 'unavailable',
    // the Kokoro precision that ACTUALLY loaded ('' until one has) — never the one we merely asked for
    ttsPrecision: ready ? state.ttsPrecision : '',
    progress: ready ? state.progress : null,
    error: ready ? state.error : UNAVAILABLE_REASON,
    cacheRoot: state.cacheRoot,
    voice: DEFAULT_LOCAL_VOICE,
    voices: LOCAL_VOICES.slice(),
    asrBusy,
    lastAsrMs,
    ttsBusy,
    lastTtsMs
  };
}

module.exports = { warm, transcribe, synthesize, status, ttsCached: () => kokoroCached(), voices: () => LOCAL_VOICES.slice(), defaultVoice: () => DEFAULT_LOCAL_VOICE, normalizeLocalVoice, edgeVoiceFor, _hardenSharpImageDecoders: hardenSharpImageDecoders,
  _speechPieces: speechPieces, _renderSpeech: renderSpeech, _kokoroDtypes: kokoroDtypes, _kokoroCached: kokoroCached };
