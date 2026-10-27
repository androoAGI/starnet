/* node test/voice-cache-key-version.test.js — a clip cached under an OLD voice-cache key is never served again.

   bug 81812888 (sweep/voice 2026-10-20): before 0efc04afe, an Edge read-aloud stream cut before `Path:turn.end` was
   resolved as a whole clip and written to the voice cache under the FULL sentence's key, so that sentence replayed
   cut in half from disk for good, Edge healthy or not. The fix stopped new truncations; it did not purge the clips an
   install had already poisoned. Every voice-cache key now carries a version segment (edge/v2, keyed/v2,
   elevenlabs/v2), so a clip written under the pre-fix key is unreachable: the request is a MISS, the whole clip is
   synthesized again and cached under the new key, and the old file ages out of the cache's LRU sweep.

   The test plants a "truncated" clip under each exact pre-fix key (the sha1 strings media-service.js used up to
   this commit) and proves /api/tts no longer answers with it. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeMediaService } = require('../sidecar/media-service.js');

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const roots = [];

async function service(overrides) {
  const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-voicecache-'));
  roots.push(workspaces);
  return {
    dir: path.join(workspaces, 'voice-cache'),
    svc: makeMediaService(Object.assign({
      workspaces, fs, fsp,
      fetch: async () => { throw new Error('unexpected network'); },
      edgetts: { enabled: () => false, resolveVoice: () => 'en-US-ChristopherNeural', synth: async () => Buffer.alloc(0) },
      localVoice: { status: () => ({ available: false }), defaultVoice: () => 'af_heart', edgeVoiceFor: () => 'en-US-ChristopherNeural' },
      nativeStt: { status: () => ({ available: false }) },
      readBody: async () => '{}', readBodyBuffer: async () => Buffer.alloc(0),
      providerRuntimeKey: () => '', providerRuntimeBaseUrl: () => '',
      normalizeProviderId: v => String(v || '').toLowerCase(),
      env: () => '', processEnv: {}, redact: String, logger: { error() {}, warn() {}, log() {} },
      now: () => 1784000000000, randomUUID: () => crypto.randomUUID()
    }, overrides || {}))
  };
}

async function tts(svc, body) {
  const out = { status: 0, headers: {}, body: Buffer.alloc(0) };
  await svc.handleTts({ headers: {} }, {
    headersSent: false,
    writeHead(status, headers) { out.status = status; out.headers = headers || {}; this.headersSent = true; },
    end(value) { out.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value || '')); }
  });
  return out;
}

(async () => {
  const TEXT = 'Standing by, commander.';
  const VOICE = 'en-US-ChristopherNeural';

  // ---- the Edge floor: the pre-fix key was sha1('edge|' + voice + '|' + text) ----
  {
    let synths = 0;
    const { svc, dir } = await service({
      readBody: async () => JSON.stringify({ text: TEXT }),
      edgetts: { enabled: () => true, resolveVoice: () => VOICE, synth: async () => { synths++; return Buffer.from('FULL-EDGE-CLIP'); } }
    });
    await fsp.mkdir(dir, { recursive: true });
    const oldKey = sha1('edge|' + VOICE + '|' + TEXT);
    await fsp.writeFile(path.join(dir, oldKey + '.mp3'), 'TRUNCATED-HALF-CLIP');
    const r = await tts(svc);
    A.eq(r.body.toString(), 'FULL-EDGE-CLIP', 'a clip cached under the pre-fix Edge key is NOT served (got "' + r.body.toString() + '")');
    A.eq(r.headers['X-Voice-Cache'], 'miss', 'the request is a cache miss, so Edge synthesizes the whole clip again');
    A.eq(synths, 1, 'Edge was asked once');
    const again = await tts(svc);
    A.eq(again.headers['X-Voice-Cache'], 'hit', 'the whole clip is cached under the NEW key and served from it next time');
    A.eq(again.body.toString(), 'FULL-EDGE-CLIP', 'the cached clip is the whole one');
    A.eq(synths, 1, 'the second request did not synthesize again');
    const files = fs.readdirSync(dir).filter(n => n.endsWith('.mp3'));
    A.ok(files.some(n => n !== oldKey + '.mp3'), 'the new clip sits under a different (versioned) key than the poisoned one: ' + files.join(','));
  }

  // ---- the keyed tier (OpenRouter/Gemini): the pre-fix key was sha1(model|voice|style|text) ----
  {
    let calls = 0;
    const MODEL = 'google/gemini-3.1-flash-tts-preview';
    const { svc, dir } = await service({
      readBody: async () => JSON.stringify({ text: TEXT, model: MODEL, voice: 'Umbriel', style: '' }),
      providerRuntimeKey: p => (p === 'openrouter' ? 'sk-or-test' : ''),
      fetch: async (url) => {
        calls++;
        A.ok(/openrouter\.ai\/api\/v1\/audio\/speech$/.test(String(url)), 'the keyed leg calls OpenRouter speech');
        return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('FULL-KEYED-CLIP') };
      }
    });
    await fsp.mkdir(dir, { recursive: true });
    const oldKey = sha1(MODEL + '|Umbriel||' + TEXT);
    await fsp.writeFile(path.join(dir, oldKey + '.mp3'), 'STALE-KEYED-CLIP');
    await fsp.writeFile(path.join(dir, oldKey + '.wav'), 'STALE-KEYED-WAV');
    const r = await tts(svc);
    A.eq(r.body.toString(), 'FULL-KEYED-CLIP', 'a clip cached under the pre-fix keyed key is NOT served (got "' + r.body.toString() + '")');
    A.eq(calls, 1, 'the keyed provider synthesized the clip again');
  }

  // ---- OpenAI's keyed leg: the pre-fix key was sha1('openai/' + model + '|' + voice + '|' + style + '|' + text) ----
  {
    let calls = 0;
    const { svc, dir } = await service({
      readBody: async () => JSON.stringify({ text: TEXT }),
      providerRuntimeKey: p => (p === 'openai' ? 'sk-openai-test' : ''),
      fetch: async () => { calls++; return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('FULL-OPENAI-CLIP') }; }
    });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, sha1('openai/gpt-4o-mini-tts|onyx||' + TEXT) + '.mp3'), 'STALE-OPENAI-CLIP');
    const r = await tts(svc);
    A.eq(r.body.toString(), 'FULL-OPENAI-CLIP', 'a clip cached under the pre-fix OpenAI key is NOT served');
    A.eq(calls, 1, 'OpenAI synthesized the clip again');
  }

  // ---- ElevenLabs: the pre-fix key was sha1('elevenlabs/' + modelId + '|' + voiceId + '||' + text) ----
  {
    let calls = 0;
    const VOICE_ID = 'AbCdEf0123456789';
    const { svc, dir } = await service({
      readBody: async () => JSON.stringify({ provider: 'elevenlabs', text: TEXT, voiceId: VOICE_ID, elKey: 'el-test' }),
      fetch: async () => { calls++; return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('FULL-EL-CLIP') }; }
    });
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, sha1('elevenlabs/eleven_multilingual_v2|' + VOICE_ID + '||' + TEXT) + '.mp3'), 'STALE-EL-CLIP');
    const r = await tts(svc);
    A.eq(r.body.toString(), 'FULL-EL-CLIP', 'a clip cached under the pre-fix ElevenLabs key is NOT served');
    A.eq(calls, 1, 'ElevenLabs synthesized the clip again');
  }

  for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp dir */ } }
  A.report('voice-cache-key-version');
})().catch(e => { console.error(e); process.exit(1); });
