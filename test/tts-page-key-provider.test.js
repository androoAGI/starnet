/* node test/tts-page-key-provider.test.js — a page key reaches a voice provider ONLY as the provider it is named for.

   POST /api/tts takes the page's credential as {key, keyProvider}. handleTts used to re-label any key whose
   keyProvider was missing or not a voice provider as 'openrouter' and send it to openrouter.ai/api/v1/audio/speech as
   a Bearer token — the same leak QW5 closed for STT (an Anthropic or OpenAI secret shipped to a third party). The
   sidecar now uses a page key only with the TTS provider it is NAMED for; a legacy body that names none is trusted
   only for an sk-or- key; anything else is ignored, and the station's own keys or the free floor answer instead. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeMediaService } = require('../sidecar/media-service.js');

const roots = [];
async function service(calls, stationKeys) {
  const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-ttskey-'));
  roots.push(workspaces);
  const keys = stationKeys || {};
  return makeMediaService({
    workspaces, fs, fsp,
    fetch: async (url, init) => {
      const h = (init && init.headers) || {};
      calls.push({ url: String(url), auth: String(h.Authorization || h['x-goog-api-key'] || '') });
      return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('KEYED-CLIP'),
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('pcm').toString('base64'), mimeType: 'audio/L16;rate=24000' } }] } }] }) };
    },
    edgetts: { enabled: () => false, resolveVoice: () => 'v', synth: async () => Buffer.alloc(0) },
    localVoice: { status: () => ({ available: false }), defaultVoice: () => 'v', edgeVoiceFor: () => 'v' },
    nativeStt: { status: () => ({ available: false }) },
    readBody: async req => req.__body,
    readBodyBuffer: async () => Buffer.alloc(0),
    providerRuntimeKey: p => keys[p] || '', providerRuntimeBaseUrl: () => '',
    normalizeProviderId: v => String(v || '').trim().toLowerCase(),
    env: () => '', processEnv: {}, redact: String, logger: { error() {}, warn() {}, log() {} },
    now: () => 1784000000000, monotonicNow: () => performance.now(), randomUUID: () => crypto.randomUUID()
  });
}
async function tts(svc, body) {
  const out = { status: 0, ct: '', body: Buffer.alloc(0) };
  await svc.handleTts({ headers: {}, __body: JSON.stringify(Object.assign({ text: 'A sentence for the key test ' + crypto.randomUUID() }, body)) }, {
    headersSent: false, writableEnded: false, destroyed: false, on() {},
    writeHead(status, headers) { out.status = status; out.ct = String((headers && headers['Content-Type']) || ''); this.headersSent = true; },
    end(value) { out.body = Buffer.isBuffer(value) ? value : Buffer.from(String(value || '')); this.writableEnded = true; }
  });
  out.json = /json/.test(out.ct) ? JSON.parse(out.body.toString('utf8')) : null;
  return out;
}
const toOpenRouter = calls => calls.filter(c => /openrouter\.ai/.test(c.url));

(async () => {
  const leaks = [
    { name: 'an Anthropic key named as anthropic', body: { key: 'sk-ant-api03-SECRET', keyProvider: 'anthropic' } },
    { name: 'a legacy body sending an OpenAI key with no provider', body: { key: 'sk-proj-SECRET' } },
    { name: 'a legacy body sending an Anthropic key with no provider', body: { key: 'sk-ant-api03-SECRET' } },
    { name: 'a key named for an unknown provider', body: { key: 'xai-SECRET', keyProvider: 'xai' } }
  ];
  for (const c of leaks) {
    const calls = [];
    const r = await tts(await service(calls), c.body);
    A.eq(r.status, 200, c.name + ': the 200-always media contract holds');
    A.eq(toOpenRouter(calls).length, 0, c.name + ': NOTHING is sent to openrouter.ai (' + JSON.stringify(calls.map(x => x.auth)) + ')');
    A.eq(calls.length, 0, c.name + ': no network call at all (the station holds no voice key of its own, the floor is off)');
    A.eq(r.json && r.json.outcome && r.json.outcome.code, 'no_key', c.name + ': the outcome is no_key, named — the page key was not a voice credential');
    // the station's OWN key still answers: the ignored page key never blocks it
    const own = [];
    const r2 = await tts(await service(own, { openrouter: 'sk-or-v1-STATION' }), c.body);
    A.eq(own.map(x => x.auth), ['Bearer sk-or-v1-STATION'], c.name + ': with a station key, only the STATION\'s OpenRouter key is used');
    A.eq(r2.body.toString(), 'KEYED-CLIP', c.name + ': and the sentence is spoken');
  }
  const good = [
    { name: 'an OpenRouter key named as openrouter', body: { key: 'sk-or-v1-PAGE', keyProvider: 'openrouter' }, url: /openrouter\.ai/, auth: 'Bearer sk-or-v1-PAGE' },
    { name: 'a legacy body sending an sk-or- key with no provider', body: { key: 'sk-or-v1-PAGE' }, url: /openrouter\.ai/, auth: 'Bearer sk-or-v1-PAGE' },
    { name: 'an OpenAI key named as openai', body: { key: 'sk-proj-PAGE', keyProvider: 'openai' }, url: /api\.openai\.com/, auth: 'Bearer sk-proj-PAGE' },
    { name: 'a Gemini key named as gemini', body: { key: 'AIza-PAGE', keyProvider: 'gemini' }, url: /generativelanguage\.googleapis\.com/, auth: 'AIza-PAGE' }
  ];
  for (const c of good) {
    const calls = [];
    const r = await tts(await service(calls), c.body);
    A.eq(calls.length, 1, c.name + ': one call');
    A.ok(calls[0] && c.url.test(calls[0].url), c.name + ': to the provider the key is named for (' + (calls[0] && calls[0].url) + ')');
    A.eq(calls[0] && calls[0].auth, c.auth, c.name + ': carrying that key');
    A.ok(/^audio\//.test(r.ct), c.name + ': and the sentence is spoken (' + r.ct + ')');
  }
  for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp dir */ } }
  A.report('tts-page-key-provider');
})().catch(e => { console.error(e); process.exit(1); });
