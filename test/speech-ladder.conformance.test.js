'use strict';
/* test/speech-ladder.conformance.test.js — ONE ladder, ONE splitter, ONE continuity rule (speech-ladder lane, wave 4).

   Desk, Live, the paired device and voice_generate used to run four ladders and cut speech with four splitters. This
   test drives the REAL entry points (media-service handleTts for the desk and Live, synthesizeStationVoice for the
   device, synthesizeForAgent for voice_generate) against the SAME scripted engines under ONE policy, and requires
   the same engine calls (leg order, voice, retries and their spacing, pin) and the same outcome code on every surface.
   The splitter corpus ('v0.13.2 shipped.', 'Dr. Smith…', $4.99, a 1500-character paragraph) must cut at the same
   boundaries in every splitter: the device's, the built-in engine's, the desk's per-request cut and its streamer. */
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ---------------- 1. THE SPLITTER ---------------- */
const SS = require('../sidecar/speech-split.js');
A.eq(read('frontend/app/speech-split.js'), read('sidecar/speech-split.js'), 'the desk runs the sidecar\'s splitter byte for byte (frontend/app/speech-split.js is its mirror)');
A.ok(/<script src="app\/speech-split\.js"><\/script>[\s\S]*<script src="app\/voice\.js"><\/script>/.test(read('frontend/index.html')), 'the page loads the splitter before the voice');

const clean = s => String(s).replace(/\s+/g, ' ').trim();
const filler = [
  'The station logged v0.13.2 shipped at 09:41, and the build cost $4.99 in credits.',
  'Dr. Smith… asked whether Mr. Jones had read section 3.5 of the e.g. clause list.',
  'J. Smith replied that it was fine!',
  'Was it?',
  'Yes, it was; the canary passed, the floor answered, and the tooltip named the real leg — every one of them, without a single retry being wasted on a permanent refusal, which is the whole point of the typed outcome that the desk now reads instead of guessing from a free-text reason string that no regex knew how to classify on the day Microsoft changed its token'
];
let paragraph = '';
for (let i = 0; paragraph.length < 1500; i++) paragraph += (paragraph ? ' ' : '') + filler[i % filler.length] + (i % filler.length === 4 ? '.' : '');
A.ok(paragraph.length >= 1500, 'the paragraph is 1500+ characters (' + paragraph.length + ')');
const CORPUS = ['v0.13.2 shipped.', 'Dr. Smith… is in the lab.', 'It costs $4.99 today.', paragraph];

A.eq(SS.sentences('v0.13.2 shipped.'), ['v0.13.2 shipped.'], 'a version number is one sentence');
A.eq(SS.sentences('Dr. Smith… is in the lab.'), ['Dr. Smith…', 'is in the lab.'], '"Dr." never ends a sentence; an ellipsis before a space does');
A.eq(SS.sentences('It costs $4.99 today.'), ['It costs $4.99 today.'], 'a price is one number');
A.eq(SS.sentences('Ask J. Smith. Then Mr. Jones.'), ['Ask J. Smith.', 'Then Mr. Jones.'], 'an initial and a title keep their names');
A.eq(SS.sentences('Wait... what?! "Go."  Now'), ['Wait...', 'what?!', '"Go."', 'Now'], 'runs, closers and a tail');

// the four splitters
const remote = require('../sidecar/remote/voice.js');
const localVoice = require('../sidecar/local-voice.js');
const deskSrc = read('frontend/app/voice.js');
const deskSplitSrc = A.fnBody(deskSrc, '  function splitForTts(');
A.ok(deskSplitSrc.length > 40 && deskSplitSrc.length < 4000, 'the desk\'s per-request splitter is sliced');
const deskSplit = new Function('Split', 'SpeechSplit', 'return ' + deskSplitSrc.trim())(SS, SS);
const SPLITTERS = {
  device: t => remote.splitSentences(t),
  'built-in engine': t => localVoice._speechPieces(t, 300),
  'desk request': t => deskSplit(clean(t), 1000),
  'desk request (tight)': t => deskSplit(clean(t), 120)
};
const MAX = { device: 240, 'built-in engine': 300, 'desk request': 1000, 'desk request (tight)': 120 };

for (const text of CORPUS) {
  const c = clean(text);
  const bounds = new Set(SS.boundaries(c));
  const sents = SS.sentences(c);
  // where each sentence starts and ends in the cleaned text
  const spans = []; let at = 0;
  for (const s of sents) { const i = c.indexOf(s, at); spans.push([i, i + s.length]); at = i + s.length; }
  const longSentenceAt = end => spans.some(([a, b]) => end > a && end < b && b - a > 0);
  for (const [name, split] of Object.entries(SPLITTERS)) {
    const pieces = split(text);
    A.eq(pieces.join(' '), c, name + ': nothing is lost or reordered (' + c.slice(0, 24) + '…)');
    let pos = 0, stray = [];
    for (const p of pieces) {
      const i = c.indexOf(p, pos), end = i + p.length;
      pos = end;
      if (end === c.length || bounds.has(end)) continue;
      // a cut inside a sentence is allowed only when that sentence is longer than this splitter's cap
      const span = spans.find(([a, b]) => end > a && end < b);
      if (!(span && span[1] - span[0] > MAX[name] && longSentenceAt(end))) stray.push(c.slice(Math.max(0, end - 12), end + 4));
      if (/(?:\bDr|\bMr|\bv0|\$4|\b3)\.$/.test(c.slice(0, end))) stray.push('cut at a protected dot: ' + c.slice(Math.max(0, end - 12), end));
    }
    A.eq(stray, [], name + ': every cut is a shared sentence boundary (' + c.slice(0, 24) + '…)');
  }
}
// the desk's STREAMER: tokens arrive a few characters at a time; every cut it makes is a shared boundary
{
  const chatSrc = read('frontend/app/chat.js');
  // sliced by markers, not fnBody: the closure holds a quote inside a regex class (see test/_fnbody.js)
  const pushAt = chatSrc.indexOf('    const pushSpeech = (');
  const push = chatSrc.slice(pushAt, chatSrc.indexOf('\n    try {', pushAt));
  A.ok(push.length > 100 && push.length < 6000, 'the streamer is sliced');
  A.ok(/Split\.lastBoundary\(pending\)/.test(push) && /Split\.stallCut\(pending\)/.test(push), 'the streamer cuts by the shared splitter (sentence ends, and the stall flush)');
  A.ok(!/Mr\|Mrs\|Ms\|Dr/.test(push), '...and keeps no abbreviation list of its own');
  const c = clean(paragraph), bounds = new Set(SS.boundaries(c)), cuts = [];
  let spoken = 0;
  for (let n = 7; n <= c.length + 7; n += 7) {
    const acc = c.slice(0, Math.min(n, c.length));
    const pending = acc.slice(spoken);
    const cut = SS.lastBoundary(pending);
    if (cut > 0) { spoken += cut; cuts.push(spoken); }
  }
  const off = cuts.filter(x => !bounds.has(c.slice(0, x).replace(/\s+$/, '').length));
  A.eq(off, [], 'streamed in 7-character tokens, the desk speaks at exactly the shared boundaries');
  A.eq(SS.lastBoundary('It is 3.'), -1, 'an unconfirmed end ("3." may become "3.5") waits for the next token');
  // the production closure itself (chat.js pushSpeech) in a vm, fed 7-character tokens, with a clock that never stalls
  const vm = require('node:vm');
  const start = chatSrc.indexOf('    let speechClosed = false;'), end = chatSrc.indexOf('\n    try {', start);
  A.ok(start > 0 && end > start, 'the streamer closure is sliced');
  const spokenChunks = [];
  const ctx = { SpeechSplit: require('../frontend/app/speech-split.js'), Voice: { speakChunk: (reply, s) => spokenChunks.push(s), endReply() {} }, willSpeak: true,
    speechOwner: () => true, speakSafe: s => s, spokenIdx: 0, acc: '', name: 'agent', speech: {}, Date: { now: () => 10000 },
    setTimeout: () => 0, clearTimeout() {} };
  vm.createContext(ctx); vm.runInContext(chatSrc.slice(start, end) + '\nthis.push = pushSpeech;', ctx);
  for (let i = 0; i < c.length; i += 7) { ctx.acc = c.slice(0, i + 7); ctx.push(false); }
  ctx.push(true, c);
  let pos = 0; const strayEnds = [];
  for (const ch of spokenChunks) { pos += ch.length; const e = c.slice(0, pos).replace(/\s+$/, '').length; if (e !== c.length && !bounds.has(e)) strayEnds.push(c.slice(Math.max(0, e - 12), e)); }
  A.eq(spokenChunks.join(''), c, 'the real streamer speaks the whole paragraph once, in order');
  A.eq(strayEnds, [], 'the real streamer (chat.js) cuts only at the shared boundaries');
  A.ok(spokenChunks.length > 5, '...and it does cut (' + spokenChunks.length + ' chunks)');
}

/* ---------------- 2. THE LADDER ---------------- */
const SL = require('../sidecar/speech-ladder.js');
const { makeMediaService } = require('../sidecar/media-service.js');
const SO = require('../sidecar/speech-outcome.js');

A.eq(SL.STATION_VOICE.voice, 'Algenib', 'the station voice');
{
  const personas = new Function(read('frontend/app/personas.js') + '\nreturn Personas;')();
  A.eq([personas.STATION_VOICE.ttsVoice, personas.STATION_VOICE.ttsStyle], [SL.STATION_VOICE.voice, SL.STATION_VOICE.style], 'the desk\'s copy of the station voice is the sidecar\'s (personas.js)');
  const gaps = (/const RETRY_GAP_MS = \[(\d+), (\d+)\]/.exec(deskSrc) || []).slice(1).map(Number);
  A.eq(gaps, SL.RETRY_GAP_MS.slice(), 'the ladder\'s spaced retry is the desk\'s (400 ms, then 1200 ms)');
  A.eq(Number((/const RETRY_WAIT_MAX_MS = (\d+);/.exec(deskSrc) || [])[1]), SL.MAX_RETRY_WAIT_MS, 'the longest Retry-After worth waiting for is the desk\'s');
  A.ok(/const retryableVerdict = v => [^\n]*!v\.retried/.test(deskSrc), 'the desk never retries a sentence the ladder already retried (no 3 x 3 attempts)');
  A.ok(/persona: activePersonaId \|\| 'station', surface: job\.voice\.local \? 'live' : 'desk', pin: job\.voice\.engine \|\| ''/.test(deskSrc), 'the desk sends a persona, its surface and the reply\'s pin; the sidecar picks the voice');
}
// a spend default is a visible, tested decision (changing one is Andrew's call)
A.eq(JSON.parse(JSON.stringify(SL.SURFACE_DEFAULTS)), {
  desk: { engine: 'keyed', policy: { walkKeyed: false, keyedAfterFloor: false, localWaitsForModel: true, cache: true } },
  live: { engine: 'local', policy: { walkKeyed: false, keyedAfterFloor: false, localWaitsForModel: true, cache: true } },
  device: { engine: 'local', policy: { walkKeyed: true, keyedAfterFloor: true, localWaitsForModel: false, cache: false } },
  agent: { engine: 'keyed', policy: { walkKeyed: true, keyedAfterFloor: false, localWaitsForModel: true, cache: false } }
}, 'each surface\'s defaults are today\'s behaviour, declared in one table');

const roots = [];
// scripted engines: each call takes the next verdict for that engine; every call and every wait is logged in order
function station(script, policy) {
  const log = [], queue = {};
  for (const k of Object.keys(script)) queue[k] = script[k].slice();
  const next = e => (queue[e] && queue[e].length ? queue[e].shift() : 'ok');
  const keyedResponse = (engine, verdict) => {
    if (verdict === 'ok') {
      if (engine === 'gemini') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('pcm-audio').toString('base64'), mimeType: 'audio/L16;rate=24000' } }] } }] }) };
      return { ok: true, status: 200, headers: { get: k => (k === 'content-type' ? 'audio/mpeg' : null) }, arrayBuffer: async () => Buffer.from(engine + '-mp3') };
    }
    if (verdict === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const status = Number(verdict);
    return { ok: false, status, headers: { get: () => null }, text: async () => (status === 402 ? 'insufficient credits' : 'busy') };
  };
  const fetch = async (url, init) => {
    const engine = /openrouter\.ai/.test(url) ? 'openrouter' : /generativelanguage/.test(url) ? 'gemini' : 'openai';
    const b = JSON.parse(init.body);
    const voice = engine === 'gemini' ? b.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName : b.voice;
    const input = engine === 'gemini' ? b.contents[0].parts[0].text : b.input;
    log.push(engine + ' voice=' + voice + (/^Say the following in A low, smooth American male voice/.test(input) ? ' +station-style' : ''));
    return keyedResponse(engine, next(engine));   // (a 'timeout' verdict throws, as an aborted fetch does)
  };
  const edgetts = {
    enabled: () => true, resolveVoice: () => 'en-US-AndrewNeural',
    synth: async (text, o) => {
      log.push('edge voice=' + (o && o.voice || ''));
      const v = next('edge');
      if (v === 'ok') return Buffer.from('edge-mp3');
      throw Object.assign(new Error('edge ' + v), { speechCode: v === 'timeout' ? 'timeout' : 'refused', http: v === 'timeout' ? 0 : 403 });
    }
  };
  const localVoice = {
    status: () => ({ available: true, tts: 'ready' }), defaultVoice: () => 'am_onyx', ttsCached: () => true,
    edgeVoiceFor: () => 'en-US-ChristopherNeural', transcribe: async () => '', warm: async () => ({}),
    synthesize: async (text, o) => {
      log.push('local voice=' + (o && o.voice));
      const v = next('local');
      if (v === 'ok') return Buffer.from('RIFF-local-wav');
      throw new Error('engine hiccup');
    }
  };
  return {
    log,
    make: async () => {
      const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-ladder-'));
      roots.push(workspaces);
      let body = '{}';
      const media = makeMediaService({
        workspaces, fs, fsp, fetch, edgetts, localVoice,
        nativeStt: { status: () => ({ available: false }), recognize: async () => ({ ok: false, text: '' }) },
        readBody: async () => body, readBodyBuffer: async () => Buffer.alloc(0),
        providerRuntimeKey: p => (p === 'openrouter' || p === 'gemini' ? 'key-' + p : ''),
        // Match the current media credential-pair contract. Every request is intercepted by fetch above.
        endpointFor: (p, key) => key === 'key-' + p ? ({ openrouter: 'https://openrouter.ai/api/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta' }[p] || '') : '',
        normalizeProviderId: v => String(v || '').toLowerCase(), env: () => '', processEnv: {}, redact: String,
        logger: { error() {}, warn() {}, log() {} }, now: () => 1234, randomUUID: () => 'u' + Math.random().toString(36).slice(2),
        sleep: async ms => { log.push('wait ' + ms); },
        speechPolicy: policy
      });
      const tts = async b => {
        body = JSON.stringify(b);
        const out = { headers: {}, body: Buffer.alloc(0) };
        await media.handleTts({ headers: {} }, { writeHead(s, h) { out.status = s; out.headers = h || {}; }, end(v) { out.body = Buffer.isBuffer(v) ? v : Buffer.from(String(v || '')); } });
        let j = null; try { j = JSON.parse(out.body.toString()); } catch (_) {}
        return j && j.fallback ? { ok: false, code: j.outcome.code, retried: j.retried, reason: j.reason } : { ok: true, engine: String(out.headers['X-Voice-Provider'] || '').split(':')[0], cache: out.headers['X-Voice-Cache'] };
      };
      return {
        _media: media,
        raw: b => tts(b),
        deviceRaw: async (text, o) => { const r = await media.synthesizeStationVoice(text, o); return r; },
        agentRaw: async a => media.synthesizeForAgent(a),
        desk: (text, pin) => tts({ text, persona: 'composed', surface: 'desk', pin }),
        live: (text, pin) => tts({ text, local: true, localVoice: 'am_onyx', surface: 'live', pin }),
        agent: async (text, pin) => { const r = await media.synthesizeForAgent({ text, only: pin }); return r.ok ? { ok: true, engine: r.provider } : { ok: false, code: r.outcome.code }; },
        device: async (text, pin) => { const r = await media.synthesizeStationVoice(text, pin ? { provider: pin } : undefined); return r.ok ? { ok: true, engine: r.provider } : { ok: false, code: r.outcome.code }; }
      };
    }
  };
}

// ONE policy for every surface: then every surface must make the SAME calls
const SAME = { walkKeyed: true, keyedAfterFloor: true, localWaitsForModel: true, cache: false };
const UNIFORM = { desk: SAME, live: SAME, device: SAME, agent: SAME };

async function across(surfaces, script, pin, policy) {
  const out = {};
  for (const s of surfaces) {
    const st = station(script, policy === undefined ? UNIFORM : policy);
    const api = await st.make();
    const r = await api[s]('Hello there.', pin);
    out[s] = { result: r.ok ? 'spoke:' + r.engine : 'failed:' + r.code, calls: st.log.slice() };
  }
  return out;
}
function same(label, out) {
  const names = Object.keys(out), first = out[names[0]];
  for (const n of names.slice(1)) A.eq(out[n], first, label + ': ' + n + ' makes the same calls and ends the same way as ' + names[0]);
  return first;
}

(async () => {
  // keyed identity (the desk, voice_generate): a blip on the first account is retried, spaced, in the station's voice
  let r = same('a 429 then audio', await across(['desk', 'agent'], { openrouter: ['429', 'ok'] }));
  A.eq(r.calls, ['openrouter voice=Algenib +station-style', 'wait 400', 'openrouter voice=Algenib +station-style'], 'retried once after 400 ms, in the station voice');
  A.eq(r.result, 'spoke:openrouter', '...and the reply speaks');
  r = same('an empty wallet', await across(['desk', 'agent'], { openrouter: ['402'] }));
  A.eq(r.calls, ['openrouter voice=Algenib +station-style', 'gemini voice=Algenib +station-style'], 'a terminal refusal is never retried; the policy walks to the next account');
  r = same('every leg down', await across(['desk', 'agent'], { openrouter: ['402'], gemini: ['402'], edge: ['timeout', 'timeout', 'timeout'] }));
  A.eq(r.calls.filter(c => /^wait/.test(c)), ['wait 400', 'wait 1200'], 'the transient floor is retried twice, 400 ms then 1200 ms apart');
  A.eq(r.result, 'failed:billing', 'the outcome names the empty wallet on every surface');
  // pinned: only that leg, never another speaker
  r = same('pinned to gemini', await across(['desk', 'agent'], { gemini: ['500', '500', '500'] }, 'gemini'));
  A.eq(r.calls.filter(c => !/^wait/.test(c)), ['gemini voice=Algenib +station-style', 'gemini voice=Algenib +station-style', 'gemini voice=Algenib +station-style'], 'a pinned reply tries only its own engine (retried), never Edge');
  A.eq(r.result, 'failed:upstream_unavailable', '...and fails typed rather than change speaker');

  // local identity (Live, the device): the built-in voice, its mapped Edge voice, then the station's keyed voice
  r = same('a built-in hiccup', await across(['live', 'device'], { local: ['x', 'x', 'x'], edge: ['ok'] }));
  A.eq(r.calls, ['local voice=am_onyx', 'wait 400', 'local voice=am_onyx', 'wait 1200', 'local voice=am_onyx', 'edge voice=en-US-ChristopherNeural'],
    'the built-in engine is retried twice, then its mapped Edge voice speaks');
  r = same('the floor refuses too', await across(['live', 'device'], { local: ['x', 'x', 'x'], edge: ['refused'], openrouter: ['ok'] }));
  A.eq(r.calls.slice(-1), ['openrouter voice=Algenib +station-style'], 'the keyed tail speaks the station voice (never a stock voice)');
  r = same('pinned to edge', await across(['live', 'device'], { edge: ['refused'] }, 'edge'));
  A.eq(r.calls, ['edge voice=en-US-ChristopherNeural'], 'an Edge-pinned sentence tries only Edge, in the mapped voice');
  A.eq(r.result, 'failed:refused', '...and fails typed');

  // the device's keyed voice is the desk's: the same identity on every surface that speaks keyed
  {
    const d = await across(['desk', 'device'], { local: ['x', 'x', 'x'], edge: ['refused'] }, 'openrouter');
    A.eq(d.desk.calls, d.device.calls, 'a reply pinned to OpenRouter sends the same voice and style from the desk and the device');
  }

  // DEFAULT policies, as shipped: the desk spends one account, the device and voice_generate walk (Andrew's spend call)
  {
    const shipped = await across(['desk', 'agent'], { openrouter: ['402'] }, '', null);
    A.eq(shipped.desk.calls, ['openrouter voice=Algenib +station-style', 'edge voice=en-US-AndrewNeural'], 'the desk, as shipped: one keyed account, then the free floor');
    A.eq(shipped.agent.calls, ['openrouter voice=Algenib +station-style', 'gemini voice=Algenib +station-style'], 'voice_generate, as shipped: it walks to the next keyed account');
    const devLive = await across(['live', 'device'], { local: ['x', 'x', 'x'], edge: ['refused'] }, '', null);
    A.eq(devLive.live.calls.filter(c => /openrouter|gemini/.test(c)), [], 'Live, as shipped: a station that chose the built-in voice never spends on a keyed one');
    A.eq(devLive.device.calls.filter(c => /openrouter/.test(c)).length, 1, 'the device, as shipped: its keyed tail is tried');
  }

  // an older desk (no persona: it sends the station voice, style and model itself) hits the SAME cached clip as a new one
  {
    const st = station({}, null);
    const api = await st.make();
    const personas = new Function(read('frontend/app/personas.js') + '\nreturn Personas;')();
    const media = api._media;
    const first = await api.desk('Cache me once.');
    const old = await api.raw({ text: 'Cache me once.', model: 'google/gemini-3.1-flash-tts-preview', voice: personas.STATION_VOICE.ttsVoice, style: personas.STATION_VOICE.ttsStyle });
    A.eq([first.ok, old.ok, old.cache], [true, true, 'hit'], 'a persona request and an older desk\'s request share one cache key (no clip is paid for twice across the upgrade)');
    A.eq(st.log.filter(l => /^openrouter/.test(l)).length, 1, '...one paid synthesis in all');
    void media;
  }
  // the device: a reply that was replaced stops spending at once (no retry, no next leg)
  {
    const st = station({ local: ['x', 'x', 'x'], edge: ['ok'] }, null);
    const api = await st.make();
    let replaced = false;
    const r = await api.deviceRaw('Hello there.', { gone: () => { const was = replaced; replaced = true; return was; } });
    A.eq(r.ok, false, 'a replaced device reply is not spoken');
    A.eq(st.log, ['local voice=am_onyx'], 'after the first attempt nothing more is tried or waited on');
  }
  // voice_generate: a named Edge voice is spoken by Edge first, even when a keyed account exists
  {
    const st = station({}, null);
    const api = await st.make();
    const r = await api.agentRaw({ text: 'Narrate this.', voice: 'en-US-AriaNeural' });
    A.eq([r.ok, r.provider], [true, 'edge'], 'the Edge voice the agent named speaks the clip');
    A.eq(st.log, ['edge voice=en-US-AriaNeural'], '...without a keyed call in the station voice first');
  }
  // a server-side keyed call that ran to its cap may have been billed: it is never asked again inside the sentence
  {
    const st = station({ openrouter: ['timeout'], gemini: ['ok'] }, null);
    const api = await st.make();
    const r = await api.agent('Hello there.');
    A.eq(st.log.filter(l => /^openrouter|^wait/.test(l)), ['openrouter voice=Algenib +station-style'], 'a keyed timeout on voice_generate is not retried (no second bill)');
    A.eq(r.ok, true, '...the next account speaks');
  }

  // the desk is told the ladder already retried (so it does not retry again)
  {
    const st = station({ openrouter: ['500', '500', '500'], gemini: ['500', '500', '500'], edge: ['timeout', 'timeout', 'timeout'] }, UNIFORM);
    const api = await st.make();
    const res = await api.desk('Hello there.');
    A.eq([res.ok, res.retried], [false, true], 'the failure envelope says retried:true');
  }

  // the plan itself: leg order is a function of identity, pin and policy, never of the surface
  {
    const keyed = [{ provider: 'openrouter', key: 'k' }, { provider: 'gemini', key: 'k' }];
    const ids = { engine: 'keyed', voice: 'Algenib', model: 'm', style: 's', edgeVoice: 'e' };
    A.eq(SL.plan({ identity: ids, policy: { walkKeyed: false }, keyed }).map(l => l.engine), ['openrouter', 'edge'], 'one account, then the floor');
    A.eq(SL.plan({ identity: ids, policy: { walkKeyed: true }, keyed }).map(l => l.engine), ['openrouter', 'gemini', 'edge'], 'walking is the policy field');
    A.eq(SL.plan({ identity: ids, policy: {}, keyed: [] }).map(l => l.engine), ['keyed', 'edge'], 'no credential: a structural no_key, then the floor');
    A.eq(SL.plan({ identity: ids, pin: 'openai', policy: {}, keyed }).map(l => [l.engine, !!l.missing]), [['openai', true]], 'a pin to an account this station lacks is that account\'s no_key, never another');
    A.eq(SL.retryWaitMs({ leg: SO.leg('edge', 'rate_limited', { retryAfterMs: 3000 }) }, 0, () => 10000), 3000, 'a Retry-After longer than the gap is honoured');
    A.eq(SL.retryWaitMs({ leg: SO.leg('gemini', 'rate_limited', { retryAfterMs: 23000 }) }, 0, () => 1e9), -1, 'a provider asking for 23 s is not waited on inside the sentence');
    A.eq(SL.retryWaitMs({ leg: SO.leg('edge', 'timeout') }, 0, () => 1300), -1, 'no retry the sentence\'s deadline cannot afford');
    A.eq(SL.retryWaitMs({ leg: SO.leg('edge', 'cancelled') }, 0, () => 1e9), -1, 'a cancellation is never retried');
  }

  for (const d of roots) { try { await fsp.rm(d, { recursive: true, force: true }); } catch (_) {} }
  A.report('speech-ladder.conformance');
})().catch(e => { console.error(e); process.exit(1); });
