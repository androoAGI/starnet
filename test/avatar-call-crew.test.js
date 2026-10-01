'use strict';

/* frontend/app/avatar-call.js — while ANOTHER agent's voice is playing through the chat speaker, the video call
   must neither talk over it nor take what the microphone hears (that agent) for the Commander.

   Runs the real module in a VM with stand-ins for the DOM, the microphone (a ScriptProcessor we feed frames
   into), the Simli face, the chat voice (Voice) and the sidecar routes. The crew gate runs on wall-clock time,
   so the scenarios wait out its real 700 ms grace period. */
const assert = require('node:assert/strict');
const { harness, sleep } = require('./_avatar-harness.js');

(async () => {
  const h = harness();
  const call = h.call();
  await call.start();
  assert.equal(call.isActive(), true, 'the call is up');
  h.mic(0.003, 700);                       // let the VAD calibrate on a quiet room
  await sleep(400);                        // the greeting plays out (0.1 s of audio) and the floor is free
  const baseTts = h.log.tts.length;

  // 1) Crew speaking + mic speech → no user turn, no history entry.
  h.voice.speaking = true; h.voice.pending = true; h.voice.text = 'The Berlin numbers are in and they look strong.';
  await sleep(200);                        // a crew tick sees it
  assert.equal(call._test.crewSpeaking(), true, 'the call sees the crew speaking');
  await h.speak('what about the Berlin office');
  await sleep(100);
  assert.equal(h.log.reply.length, 0, 'crew speech + mic speech → no reply requested');
  assert.equal(call._test.history().length, 0, 'crew speech + mic speech → nothing in the call history');

  // 4) The gaps between crew chunks do not let the mic through (queued, not audible).
  h.voice.speaking = false; h.voice.pending = true;
  await sleep(200);
  await h.speak('can you hear me now');
  assert.equal(h.log.reply.length, 0, 'a gap between chunks is not silence');
  assert.equal(call._test.history().length, 0);

  // 3) An announce() during crew speech is held, then spoken once the crew is done.
  h.voice.speaking = true;
  call._test.announce('Heads up: the Berlin report just finished.');
  assert.equal(call._test.noticeCount(), 1, 'the announcement is queued, not spoken over the crew');
  await sleep(250);
  assert.equal(h.log.tts.slice(baseTts).some(t => /Berlin report/.test(t)), false, 'nothing of it was synthesized while the crew spoke');

  // 2) A stop command during crew speech stops the crew voice.
  await h.speak('stop');
  await sleep(50);
  assert.equal(h.log.crewStops, 1, '"stop" silences the crew voice');
  assert.equal(h.log.reply.length, 0, 'the stop command is not a turn for the avatar');
  assert.equal(call._test.history().length, 0);

  // Within the grace period after the crew stops, the mic is still not the Commander (the audio's tail).
  await sleep(200);
  await h.speak('tail of the crew audio');
  assert.equal(h.log.reply.length, 0, 'the grace period swallows the tail of the crew audio');

  // …then the floor frees: the held announcement is spoken.
  await sleep(900);
  assert.equal(call._test.crewSpeaking(), false, 'the floor is free after the grace period');
  assert.equal(call._test.noticeCount(), 0, 'the held announcement was released');
  assert.ok(h.log.tts.some(t => /Berlin report/.test(t)), 'and spoken after the crew finished');
  await sleep(400);                        // let the announcement itself play out

  // 5) After crew speech + grace, a normal utterance is a turn again.
  await h.speak('how is the launch going');
  await sleep(150);
  assert.equal(h.log.reply.length, 1, 'a normal utterance reaches the agent again');
  const hist = call._test.history();
  assert.ok(hist.some(m => m.role === 'user' && m.content === 'how is the launch going'), 'and enters the history');
  assert.equal(hist.some(m => /Berlin office|hear me now|tail of the crew/.test(m.content)), false, 'nothing heard during crew speech ever reached the history');

  // The avatar's own reply is held (not dropped) while the crew speaks, and resumes after.
  h.voice.speaking = true; h.voice.pending = true;
  await sleep(200);
  const before = h.log.sent;
  call._test.announce('One more thing.');
  await sleep(300);
  assert.equal(h.log.sent, before, 'no audio reaches the face while the crew has the floor');
  h.voice.speaking = false; h.voice.pending = false;
  await sleep(1200);
  assert.ok(h.log.sent > before, 'held speech resumes once the crew is done');

  call.end();
  console.log('avatar-call-crew: ok');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
