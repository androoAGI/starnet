'use strict';

/* frontend/app/avatar-call.js — the call's voice. ElevenLabs (VOICE → ELEVENLABS in CALL SETTINGS) speaks with
   the Commander's own voice id on the Flash model; if ElevenLabs refuses, each sentence falls back to the
   built-in voice instead of going silent. Without ElevenLabs picked, nothing changes. */
const assert = require('node:assert/strict');
const { harness, sleep } = require('./_avatar-harness.js');

const EL = { configured: true, voiceId: '', model: 'eleven_flash_v2_5' };
const PICK_EL = { 'starnet.avatarCall.voice.v1': 'elevenlabs', 'starnet.avatarCall.elevenlabsVoice.v1': 'MyVoice123456' };

async function greeting(opts) {
  const h = harness(opts);
  await h.call().start();
  await sleep(250);                      // the greeting is synthesized and fed to the face
  h.call().end();
  return h;
}

(async () => {
  // 1) Picked + key present → the greeting goes to ElevenLabs with the Commander's voice id on the Flash model.
  {
    const h = await greeting({ storage: PICK_EL, session: { elevenlabs: EL } });
    const req = h.log.ttsBodies[0];
    assert.equal(req.provider, 'elevenlabs', 'ElevenLabs speaks when picked');
    assert.equal(req.voiceId, 'MyVoice123456', 'with the voice id from CALL SETTINGS');
    assert.equal(req.modelId, 'eleven_flash_v2_5', 'on the Flash model (built for real-time)');
    assert.equal('elKey' in req || 'key' in req, false, 'no key travels from the page — the sidecar holds it');
    assert.ok(h.log.sent > 0, 'the audio reached the face');
  }

  // 2) ElevenLabs refuses → the same sentence falls back to the built-in voice, never silence.
  {
    const h = await greeting({ storage: PICK_EL, session: { elevenlabs: EL }, elevenlabsFails: true });
    assert.deepEqual(h.log.ttsBodies.map(b => b.provider || (b.local ? 'builtin' : 'station')), ['elevenlabs', 'builtin'], 'one ElevenLabs attempt, then the built-in voice');
    assert.equal(h.log.ttsBodies[0].text, h.log.ttsBodies[1].text, 'the SAME sentence is retried, not dropped');
    assert.ok(h.log.sent > 0, 'the Commander still hears it');
  }

  // 3) Picked but no key yet → the built-in voice, no ElevenLabs request at all.
  {
    const h = await greeting({ storage: PICK_EL, session: { elevenlabs: { configured: false, voiceId: '', model: 'eleven_flash_v2_5' } } });
    assert.equal(h.log.ttsBodies.some(b => b.provider === 'elevenlabs'), false, 'no key → no ElevenLabs call');
    assert.ok(h.log.sent > 0);
  }

  // 4) Picked, key present, no voice id in the panel → the station-wide STARNET_AVATAR_ELEVENLABS_VOICE_ID is used.
  {
    const h = await greeting({ storage: { 'starnet.avatarCall.voice.v1': 'elevenlabs' }, session: { elevenlabs: Object.assign({}, EL, { voiceId: 'StationVoice99' }) } });
    assert.equal(h.log.ttsBodies[0].voiceId, 'StationVoice99');
  }

  // 5) Not picked → unchanged: the built-in voice matched to the face.
  {
    const h = await greeting({ session: { elevenlabs: EL } });
    const req = h.log.ttsBodies[0];
    assert.equal(req.provider, undefined);
    assert.equal(req.local, true);
    assert.equal(req.localVoice, 'af_heart', 'the face-matched built-in voice, as before');
  }

  // 6) A sidecar that predates this feature reports nothing about ElevenLabs → picked + id is still tried
  //    (/api/tts holds the key and answers either way).
  {
    const h = await greeting({ storage: PICK_EL });
    assert.equal(h.log.ttsBodies[0].provider, 'elevenlabs', 'unknown key state + explicit pick → try ElevenLabs');
  }

  // 7) AUTO + a station voice id + a key → ElevenLabs with zero panel setup; AUTO + station id but no key → built-in.
  {
    const h = await greeting({ session: { elevenlabs: { configured: true, voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_flash_v2_5' } } });
    assert.equal(h.log.ttsBodies[0].provider, 'elevenlabs', 'the station voice speaks by default');
    assert.equal(h.log.ttsBodies[0].voiceId, 'EXAVITQu4vr4xnSDxMaL');
    const off = await greeting({ session: { elevenlabs: { configured: false, voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_flash_v2_5' } } });
    assert.equal(off.log.ttsBodies[0].provider, undefined, 'no key → the built-in voice, no failed request');
  }

  // 9) A voice ID typed in CALL SETTINGS wins even under AUTO (the station voice is only the default), and a
  //    built-in voice picked on purpose sets ElevenLabs aside.
  {
    const station = { elevenlabs: { configured: true, voiceId: 'EXAVITQu4vr4xnSDxMaL', model: 'eleven_flash_v2_5' } };
    const auto = await greeting({ storage: { 'starnet.avatarCall.elevenlabsVoice.v1': '9FuMHon7Kyk1AGgnR8C2' }, session: station });
    assert.equal(auto.log.ttsBodies[0].provider, 'elevenlabs');
    assert.equal(auto.log.ttsBodies[0].voiceId, '9FuMHon7Kyk1AGgnR8C2', 'the typed ID beats the station default under AUTO');
    const builtin = await greeting({ storage: { 'starnet.avatarCall.voice.v1': 'af_bella', 'starnet.avatarCall.elevenlabsVoice.v1': '9FuMHon7Kyk1AGgnR8C2' }, session: station });
    assert.equal(builtin.log.ttsBodies[0].provider, undefined, 'a built-in voice picked on purpose is used');
    assert.equal(builtin.log.ttsBodies[0].localVoice, 'af_bella');
  }

  // 8) "no elevenlabs key" → the rest of the call stops asking ElevenLabs (no wasted round-trip per sentence).
  {
    const h = harness({ storage: PICK_EL, elevenlabsFails: 'no elevenlabs key' });
    await h.call().start();
    await sleep(700);                    // the greeting (and its fallback) has played out; the floor is free
    h.call()._test.announce('Second sentence.');
    await sleep(300);
    h.call().end();
    const providers = h.log.ttsBodies.map(b => b.provider || 'builtin');
    assert.deepEqual(providers, ['elevenlabs', 'builtin', 'builtin'], 'tried once, then built-in for the rest of the call');
  }

  console.log('avatar-call-voice: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
