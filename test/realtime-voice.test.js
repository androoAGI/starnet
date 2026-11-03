'use strict';

const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL,
  VOICES,
  normalizeVoice,
  sessionConfig,
  safetyIdentifier,
  makeRealtimeVoice
} = require('../sidecar/realtime-voice.js');

(async () => {
  const config = sessionConfig();
  assert.equal(config.type, 'realtime');
  assert.equal(config.model, DEFAULT_MODEL);
  assert.deepEqual(config.output_modalities, ['audio']);
  assert.equal(config.audio.input.turn_detection.type, 'semantic_vad');
  assert.equal(config.audio.input.turn_detection.interrupt_response, true);
  // Male by default — the written station voice is a low American male and the crew sprites read male.
  assert.equal(config.audio.output.voice, 'ash');
  // …but the voice is a CHOICE: a requested one must be honoured, and an unknown one must fall back to the
  // default rather than being passed through into the session payload.
  assert.equal(sessionConfig({ voice: 'cedar' }).audio.output.voice, 'cedar');
  assert.equal(normalizeVoice('CEDAR'), 'cedar');
  assert.equal(normalizeVoice('not-a-voice'), '');
  assert.ok(VOICES.length > 1, 'a single hardcoded voice is what made this feel unchangeable');
  assert.ok(config.tools.some(tool => tool.name === 'start_starnet_task'));
  assert.ok(config.tools.some(tool => tool.name === 'interrupt_starnet_task'));

  const a = safetyIdentifier('same-install');
  const b = safetyIdentifier('same-install');
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);

  const unavailable = makeRealtimeVoice({ resolveKey: () => '' });
  assert.equal(unavailable.status().available, false);
  const noKey = await unavailable.createCall('v=0\r\n');
  assert.equal(noKey.status, 409);
  // ⛔ The refusal must never name an API KEY. Live voice rides the provider the Commander already
  // connected; telling a ChatGPT-subscription user to go find an API key is the exact failure this fixes.
  assert.match(noKey.body, /connect an AI provider or subscription/);
  assert.equal(/API key/i.test(noKey.body), false, 'a subscription user must not be sent hunting for a key');

  // THE SUBSCRIPTION PATH: no API key anywhere, only an async credential (a ChatGPT access token, which
  // needs a refresh round-trip). It must be usable, and it must reach the wire as the bearer.
  let subUrl = null, subAuth = null;
  const subscription = makeRealtimeVoice({
    hasCredential: () => true,
    resolveCredential: async () => 'chatgpt-access-token',
    fetch: async (url, init) => {
      subUrl = url; subAuth = init.headers.Authorization;
      return { ok: true, status: 201, headers: { get: () => 'application/sdp' }, text: async () => 'v=0\r\no=answer' };
    }
  });
  assert.equal(subscription.status().available, true, 'a connected subscription IS a credential');
  const subCall = await subscription.createCall('v=0\r\no=offer');
  assert.equal(subCall.status, 201);
  assert.equal(subUrl, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(subAuth, 'Bearer chatgpt-access-token');

  // A refresh that FAILS is not "nothing connected" — 401 (reconnect), never 409 (connect something).
  const expired = makeRealtimeVoice({
    hasCredential: () => true,
    resolveCredential: async () => { throw new Error('ChatGPT sign-in expired'); }
  });
  const expiredCall = await expired.createCall('v=0\r\no=offer');
  assert.equal(expiredCall.status, 401);
  assert.match(expiredCall.body, /expired/);

  let captured = null;
  const live = makeRealtimeVoice({
    resolveKey: () => 'test-secret',
    safetySeed: 'install-1',
    fetch: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 201,
        headers: { get: name => name === 'content-type' ? 'application/sdp' : null },
        text: async () => 'v=0\r\no=answer'
      };
    }
  });
  assert.equal(live.status().available, true);
  const result = await live.createCall('v=0\r\no=offer');
  assert.equal(result.status, 201);
  assert.equal(result.contentType, 'application/sdp');
  assert.equal(captured.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer test-secret');
  assert.match(captured.init.headers['OpenAI-Safety-Identifier'], /^[a-f0-9]{64}$/);
  // newline-completed, not verbatim: an SDP whose last line has no terminator is unparseable at the far end.
  assert.equal(captured.init.body.get('sdp'), 'v=0\r\no=offer\r\n');
  const sentSession = JSON.parse(captured.init.body.get('session'));
  assert.equal(sentSession.model, DEFAULT_MODEL);
  assert.equal(sentSession.audio.input.transcription.model, 'gpt-4o-mini-transcribe');
  assert.equal(captured.init.headers.Authorization.includes('test-secret'), true);
  assert.equal(JSON.stringify(sentSession).includes('test-secret'), false);

  /* ⛔ REGRESSION: the SDP must reach the wire with its final CRLF intact. A `.trim()` here cost hours — the
     offer was valid and the credential was valid, but the provider answered `failed to unmarshal SDP: EOF`
     because the last line had no terminator. Byte-identical bodies: 201 posted directly, 400 through us. */
  let sentSdp = null;
  const OFFER_WITH_CRLF = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n';
  const keepsNewline = makeRealtimeVoice({
    hasCredential: () => true,
    resolveCredential: async () => 'k',
    fetch: async (url, init) => {
      sentSdp = init.body.get('sdp');
      return { ok: true, status: 201, headers: { get: () => 'application/sdp' }, text: async () => 'v=0\r\n' };
    }
  });
  await keepsNewline.createCall(OFFER_WITH_CRLF);
  assert.equal(sentSdp, OFFER_WITH_CRLF, 'the SDP must go out byte-for-byte, trailing CRLF included');
  assert.match(sentSdp, /\r\n$/, 'an SDP stripped of its final newline is unparseable at the far end');
  // and one that arrives WITHOUT a terminator gets one added rather than being sent broken
  await keepsNewline.createCall('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111');
  assert.match(sentSdp, /\r\n$/, 'a terminator-less offer is completed, not forwarded broken');
  // whitespace-only is still rejected, so dropping trim() did not open a hole
  const blank = await keepsNewline.createCall('   \r\n  ');
  assert.equal(blank.status, 400);

  const failed = makeRealtimeVoice({
    resolveKey: () => 'key',
    fetch: async () => { throw new Error('network details that should not leak'); }
  });
  const failure = await failed.createCall('v=0\r\n');
  assert.equal(failure.status, 502);
  assert.equal(failure.body.includes('network details'), false);

  /* A KEY GOES ONLY WHERE IT WAS SAVED (credential-store lane, decision 6). The native call goes to one fixed URL, so a credential
     saved with another endpoint is not sent there: its status says composed and why, createCall refuses before the credential is
     even resolved, and composed voice serves. test/credential-store.no-crossing.test.js drives this through the real store. */
  let dialed = 0, resolved = 0;
  const sentence = 'native Live Voice is not offered for this OpenAI key: it was saved with another endpoint';
  const gateway = makeRealtimeVoice({
    hasCredential: () => true,
    nativeVoiceBlocker: () => sentence,
    resolveCredential: async () => { resolved++; return 'gateway-key'; },
    fetch: async () => { dialed++; throw new Error('this key must not leave'); }
  });
  const composed = gateway.status('openai');
  assert.deepEqual([composed.mode, composed.available, composed.connected, composed.note, composed.model, composed.voices], ['composed', false, true, sentence, '', []],
    'the status names why native voice is not offered, and the provider stays connected');
  const refusedCall = await gateway.createCall('v=0\r\n', 'openai');
  assert.equal(refusedCall.status, 501);
  assert.deepEqual(JSON.parse(refusedCall.body), { error: sentence, mode: 'composed' });
  assert.deepEqual([dialed, resolved], [0, 0], 'the credential is neither resolved nor sent');
  const noBlocker = makeRealtimeVoice({ resolveKey: () => 'k', nativeVoiceBlocker: () => '' }).status('openai');
  assert.deepEqual([noBlocker.mode, noBlocker.available, 'note' in noBlocker], ['native', true, false], 'an empty answer leaves native voice as it was, and adds no field');

  console.log('realtime-voice.test.js: ok');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
