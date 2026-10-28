/* node test/stt-openrouter-key-only.test.js — a page credential reaches openrouter.ai ONLY when it IS an OpenRouter key.

   The desk's push-to-talk sent `Harness.getKey()` — the key of whatever provider the page RUNS on — as
   `X-OpenRouter-Key`, and /api/stt used any such header as a Bearer token on openrouter.ai/api/v1/chat/completions.
   A browser-mode station running on OpenAI or Anthropic therefore shipped that provider's secret to a third party
   on every spoken sentence (and the call failed anyway). The page now sends an explicit {provider, key} pair (as the
   TTS path already does with keyProvider), and the sidecar uses a page key for OpenRouter only when the pair names
   openrouter. A legacy page that names no provider is trusted only for an `sk-or-` key. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { makeMediaService } = require('../sidecar/media-service.js');

const roots = [];
async function service(calls) {
  const workspaces = await fsp.mkdtemp(path.join(os.tmpdir(), 'starnet-sttkey-'));
  roots.push(workspaces);
  return makeMediaService({
    workspaces, fs, fsp,
    fetch: async (url, init) => {
      calls.push({ url: String(url), auth: String((init && init.headers && init.headers.Authorization) || '') });
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ choices: [{ message: { content: 'heard you' } }] }) };
    },
    edgetts: { enabled: () => false, resolveVoice: () => 'v', synth: async () => Buffer.alloc(0) },
    localVoice: { status: () => ({ available: false }), defaultVoice: () => 'v', edgeVoiceFor: () => 'v' },
    nativeStt: { status: () => ({ available: false }) },
    readBody: async () => '{}',
    readBodyBuffer: async req => req.__body,
    providerRuntimeKey: () => '', providerRuntimeBaseUrl: () => '',
    normalizeProviderId: v => String(v || '').trim().toLowerCase(),
    getRuntimeKey: () => '',
    env: () => '', processEnv: {}, redact: String, logger: { error() {}, warn() {}, log() {} },
    now: () => 1784000000000
  });
}

async function stt(svc, req) {
  const out = { status: 0, body: null };
  await svc.handleStt(req, {
    headersSent: false,
    writeHead(status) { out.status = status; this.headersSent = true; },
    end(value) { out.body = JSON.parse(String(value || '{}')); }
  });
  return out;
}
const raw = (headers) => ({ headers: Object.assign({ 'content-type': 'audio/webm' }, headers), __body: Buffer.from('fake opus bytes') });
const json = (body) => ({ headers: { 'content-type': 'application/json' }, __body: Buffer.from(JSON.stringify(Object.assign({ audio: Buffer.from('fake').toString('base64'), format: 'webm' }, body))) });
const toOpenRouter = calls => calls.filter(c => /openrouter\.ai/.test(c.url));

(async () => {
  const cases = [
    { name: 'raw: an Anthropic key named as anthropic', req: raw({ 'x-openrouter-key': 'sk-ant-api03-SECRET', 'x-speech-key-provider': 'anthropic' }), reaches: false },
    { name: 'raw: an OpenAI key named as openai', req: raw({ 'x-openrouter-key': 'sk-proj-SECRET', 'x-speech-key-provider': 'openai' }), reaches: false },
    { name: 'raw: a legacy page sending an OpenAI key with no provider', req: raw({ 'x-openrouter-key': 'sk-proj-SECRET' }), reaches: false },
    { name: 'json: an Anthropic key named as anthropic', req: json({ key: 'sk-ant-api03-SECRET', keyProvider: 'anthropic' }), reaches: false },
    { name: 'json: a legacy body sending an OpenAI key with no provider', req: json({ key: 'sk-proj-SECRET' }), reaches: false },
    { name: 'raw: an OpenRouter key named as openrouter', req: raw({ 'x-openrouter-key': 'sk-or-v1-GOOD', 'x-speech-key-provider': 'openrouter' }), reaches: true },
    { name: 'raw: a legacy page sending an sk-or- key with no provider', req: raw({ 'x-openrouter-key': 'sk-or-v1-GOOD' }), reaches: true },
    { name: 'json: an OpenRouter key named as openrouter', req: json({ key: 'sk-or-v1-GOOD', keyProvider: 'openrouter' }), reaches: true }
  ];
  for (const c of cases) {
    const calls = [];
    const r = await stt(await service(calls), c.req);
    A.eq(r.status, 200, c.name + ': the 200-always media contract holds');
    const sent = toOpenRouter(calls);
    if (c.reaches) {
      A.ok(sent.length >= 1 && sent.every(s => s.auth === 'Bearer sk-or-v1-GOOD'), c.name + ': the OpenRouter key reaches openrouter.ai (' + JSON.stringify(sent) + ')');
      A.eq(r.body.text, 'heard you', c.name + ': and transcribes');
    } else {
      A.eq(sent.length, 0, c.name + ': NOTHING is sent to openrouter.ai (' + JSON.stringify(sent.map(s => s.auth)) + ')');
      A.eq(calls.length, 0, c.name + ': no network call at all — the station has no other transcription credential');
      A.ok(/no key/i.test(String(r.body.reason || '')), c.name + ': the degrade names the missing transcription key: ' + r.body.reason);
    }
  }
  for (const root of roots) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp dir */ } }
  A.report('stt-openrouter-key-only');
})().catch(e => { console.error(e); process.exit(1); });
