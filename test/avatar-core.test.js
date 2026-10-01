'use strict';

// frontend/app/avatar-core.js — the video call's pure decisions. The headline rule: interrupted by WORDS,
// never by noise.
const assert = require('node:assert/strict');
const C = require('../frontend/app/avatar-core.js');

// ── interruption: words interrupt, noise / backchannels / echo do not ──
{
  const recentSpoken = ['The launch is on track and the landing page ships Thursday.'];
  const words = { mode: 'words', recentSpoken };
  assert.equal(C.shouldInterrupt('', words), false, 'silence never interrupts');
  assert.equal(C.shouldInterrupt('Thank you.', words), false, 'a Whisper noise hallucination never interrupts');
  assert.equal(C.shouldInterrupt('[MUSIC]', words), false);
  assert.equal(C.shouldInterrupt('yeah', words), false, 'a backchannel is agreement, not an interruption');
  assert.equal(C.shouldInterrupt('mm-hmm, right, okay', words), false);
  assert.equal(C.shouldInterrupt('the landing page ships Thursday', words), false, 'the avatar hearing itself is echo');
  assert.equal(C.shouldInterrupt('wait', words), true, 'a stop phrase interrupts on its own');
  assert.equal(C.shouldInterrupt('hold on a second', words), true);
  assert.equal(C.shouldInterrupt('what about the Berlin office', words), true, 'real words interrupt');

  const stopOnly = { mode: 'stop', recentSpoken };
  assert.equal(C.shouldInterrupt('what about the Berlin office', stopOnly), false, '"only when I say stop" ignores other speech');
  assert.equal(C.shouldInterrupt('stop, stop', stopOnly), true);
}

// ── turns: while idle any real speech is a turn; while busy only what would interrupt ──
{
  assert.equal(C.isTurn('How is the launch going?', { avatarBusy: false }), true);
  assert.equal(C.isTurn('Thank you.', { avatarBusy: false, voicedMs: 400 }), false, 'a short "thank you" in a quiet room is Whisper, not a turn');
  assert.equal(C.isTurn('Thank you.', { avatarBusy: false, voicedMs: 1500 }), true, 'a long, clearly voiced one is real');
  assert.equal(C.isTurn('yeah', { avatarBusy: true, mode: 'words' }), false, '"yeah" over the avatar is not a question');
  assert.equal(C.isTurn('what about Berlin', { avatarBusy: true, mode: 'words' }), true);
  assert.equal(C.isTurn('   ', { avatarBusy: false }), false);
}

// ── VAD: a click or cough aborts; sustained speech opens and closes an utterance; the floor adapts ──
{
  const frames = (vad, rms, ms, n, strict) => { const out = []; for (let i = 0; i < n; i++) { const e = vad.frame({ rms, ms, strict }); if (e) out.push(e); } return out; };
  const vad = C.makeVad();
  frames(vad, 0.003, 40, 20);                                    // calibrate on a quiet room
  assert.equal(vad.state().calibrated, true);
  let ev = frames(vad, 0.2, 40, 5).concat(frames(vad, 0.002, 40, 25));   // 200 ms burst: opens, but too short
  assert.deepEqual(ev.map(e => e.type), ['start', 'abort'], 'a cough-length burst is discarded, not transcribed');
  ev = frames(vad, 0.2, 40, 30).concat(frames(vad, 0.002, 40, 25));      // 1.2 s of speech then silence
  assert.deepEqual(ev.map(e => e.type), ['start', 'end']);
  assert.ok(ev[1].voicedMs >= 1000);
  // A level that opens an utterance normally does NOT while the avatar is talking (echo residue).
  const v2 = C.makeVad();
  frames(v2, 0.003, 40, 20);
  assert.equal(frames(v2, 0.02, 40, 20, true).length, 0, 'strict mode ignores echo-level sound');
  assert.equal(frames(C.makeVad(), 0.02, 40, 40).length > 0, false, 'nothing fires during calibration');
  // A noisy room raises the floor so steady noise stops reading as speech.
  const noisy = C.makeVad();
  frames(noisy, 0.015, 40, 200);
  assert.equal(frames(noisy, 0.02, 40, 20).length, 0, 'a steady fan is not speech once the floor has adapted');
}

// ── speaking: the first clause goes out fast, later text waits for sentences ──
{
  let d = C.drain('Sure, the launch is on track', true);
  assert.deepEqual(d.pieces, [], 'a clause too short to say ("Sure,") waits for more words');
  assert.equal(d.rest, 'Sure, the launch is on track');
  d = C.drain('Right now the launch is on track, and the page ships Thursday. More', true);
  assert.equal(d.pieces[0], 'Right now the launch is on track,', 'the first piece may end at a clause');
  d = C.drain('This is a much longer second sentence that keeps going past the minimum, and then some more. Next', false);
  assert.equal(d.pieces.length, 1);
  assert.ok(/\.$/.test(d.pieces[0]), 'later pieces end on a sentence');
  assert.equal(d.rest.trim(), 'Next');
  d = C.drain('word '.repeat(100), false);
  assert.ok(d.pieces.length >= 1 && d.pieces.every(p => p.length <= C.CHUNK_MAX), 'a run-on is cut at a word boundary');
  assert.equal(C.speakable('**Bold** see [docs](https://x.y) and `code`\n- item'), 'Bold see docs and code item');
}

// ── audio plumbing ──
{
  const pcm = C.toPcm16(new Float32Array([0, 1, -1, 2]));
  const v = new DataView(pcm.buffer);
  assert.equal(pcm.length, 8);
  assert.equal(v.getInt16(2, true), 32767);
  assert.equal(v.getInt16(4, true), -32768);
  assert.equal(v.getInt16(6, true), 32767, 'clipped, not wrapped');
  const w = C.wav(pcm, 16000);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(w.buffer).getUint32(24, true), 16000);
  assert.equal(C.resample(new Float32Array(48000), 48000, 16000).length, 16000);
  assert.equal(C.resample(new Float32Array(22050), 22050, 16000).length, 16000);
  assert.equal(C.concat([new Float32Array(3), new Float32Array(2)]).length, 5);
  assert.ok(Math.abs(C.rms(new Float32Array([0.5, -0.5])) - 0.5) < 1e-9);
}

// ── the crew has the floor: another agent's voice is playing through the chat speaker ──
{
  const g = C.makeCrewGate({ graceMs: 700, staleMs: 20000 });
  const at = (now, speaking, pending) => g.update({ now, speaking, pending });
  assert.equal(at(0, false, false).crewSpeaking, false, 'silence is a free floor');
  assert.equal(at(100, true, true).crewSpeaking, true, 'an audible chunk takes the floor');
  assert.equal(at(600, false, true).crewSpeaking, true, 'the gap between chunks (queued, not audible) still holds it');
  assert.equal(at(900, true, true).crewSpeaking, true);
  let r = at(1200, false, false);
  assert.deepEqual(r, { crewSpeaking: true, ended: false }, 'the grace period covers the tail still in the room');
  r = at(1850, false, false);
  assert.deepEqual(r, { crewSpeaking: false, ended: true }, 'the floor frees after the grace period, reported once');
  assert.equal(at(2000, false, false).ended, false, '`ended` fires exactly once');

  const stale = C.makeCrewGate({ graceMs: 700, staleMs: 1000 });
  stale.update({ now: 0, speaking: false, pending: true });
  assert.equal(stale.update({ now: 500, speaking: false, pending: true }).crewSpeaking, true);
  assert.equal(stale.update({ now: 2000, speaking: false, pending: true }).crewSpeaking, false, 'a reply that never closes cannot mute the call forever');
}
{
  for (const t of ['stop', 'Stop!', 'okay, stop talking', 'enough', "that's enough", 'be quiet', 'be quiet please', 'shut up', 'hush']) {
    assert.equal(C.isCrewStop(t), true, 'stop command: ' + t);
  }
  for (const t of ['we should stop the Berlin campaign', 'stop the task and research competitors', 'what about Berlin', '', 'enough budget left for the launch?']) {
    assert.equal(C.isCrewStop(t), false, 'not a stop command: ' + t);
  }
  assert.deepEqual(C.shouldIgnoreMic({ crewSpeaking: false, text: 'how is the launch going' }), { ignore: false, stopCrew: false }, 'a free floor ignores nothing');
  assert.deepEqual(C.shouldIgnoreMic({ crewSpeaking: true, text: 'how is the launch going' }), { ignore: true, stopCrew: false }, 'during crew speech anything else is ignored');
  assert.deepEqual(C.shouldIgnoreMic({ crewSpeaking: true, text: 'be quiet' }), { ignore: true, stopCrew: true }, 'a stop command silences the crew');
  assert.equal(C.shouldIgnoreMic({ crewSpeaking: true, text: 'stop', recentSpoken: ['we need to stop'] }).stopCrew, true, 'one-word echo cannot be told apart, and stop is harmless');
  assert.equal(C.shouldIgnoreMic({ crewSpeaking: true, text: 'stop talking', recentSpoken: ['please stop talking about it'] }).stopCrew, false, 'the crew saying "stop talking" is echo, not an order');
}
{
  const q = C.makeNoticeQueue();
  assert.equal(q.offer('A', { crewSpeaking: true }), null, 'held while the crew speaks');
  assert.equal(q.offer('B', {}), null, 'a later notice queues behind the held one (order kept)');
  assert.equal(q.release({ crewSpeaking: true }), null);
  assert.equal(q.release({ avatarBusy: true }), null, 'never over the avatar');
  assert.equal(q.release({ hearing: true }), null, 'never while the Commander is mid-sentence');
  assert.equal(q.release({}), 'A');
  assert.equal(q.release({}), 'B');
  assert.equal(q.release({}), null);
  assert.equal(q.offer('C', {}), 'C', 'a free floor speaks at once');
}

console.log('avatar-core: ok');
