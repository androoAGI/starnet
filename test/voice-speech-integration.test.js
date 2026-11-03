'use strict';
// Real page-order Voice/VoiceState/SpeechSplit and the real Chat speech closure. Only transport completion is controlled.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const { liveWindow, chatReply, VOICE_SCRIPTS } = require('./helpers/voice-rig.js');
const Split = require('../frontend/app/speech-split.js');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const audio = (text, engine) => ({ ok: true, status: 200,
  headers: { get: key => /content-type/i.test(key) ? 'audio/mpeg' : /x-voice-provider/i.test(key) ? engine : '' },
  blob: async () => ({ size: 64, text }) });
function setup() {
  const requests = [], timers = new Map(); let nextTimer = 0;
  const env = liveWindow({ configure(sandbox) {
    const fallback = sandbox.fetch;
    sandbox.fetch = (url, opts) => {
      if (String(url) !== '/api/tts') return fallback(url, opts);
      return new Promise(resolve => requests.push({ body: JSON.parse(opts.body), signal: opts.signal, resolve }));
    };
    // Delayed retries remain observable and cannot run merely because this machine was slow.
    sandbox.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
    sandbox.clearTimeout = id => timers.delete(id);
  } });
  env.Voice.init({ name: 'Agent', personaId: 'professional' });
  env.Voice.setSpeakReplies(true);
  return Object.assign(env, { requests, timers, reply: () => env.Voice.openReply({ owner: 'ws-a', agentId: 'agent' }),
    answer: (i, engine) => requests[i].resolve(audio(requests[i].body.text, engine)) });
}

(async () => {
  for (const page of ['frontend/index.html', 'frontend/agent-station-demo.html']) {
    const scripts = [...read(page).matchAll(/<script\b[^>]*\bsrc="app\/([^"/]+)"/g)].map(m => m[1]);
    for (const dependency of ['speech-split.js', 'voice-state.js']) {
      A.eq(scripts.filter(name => name === dependency).length, 1, page + ': one actual ' + dependency);
      A.ok(scripts.indexOf(dependency) < scripts.indexOf('voice.js'), page + ': ' + dependency + ' precedes its consumer');
    }
  }
  A.ok(VOICE_SCRIPTS.includes('speech-split.js'), 'the shared rig follows the page splitter entry, not the fallback');
  {
    const e = setup();
    A.eq(typeof e.SpeechSplit.pack, 'function', 'the real page graph exposes SpeechSplit');
    const run = chatReply(e.Voice);
    run.say('Dr.');
    A.eq(e.requests.length, 0, 'actual Chat closure holds an abbreviation rather than using the stripped-page fallback');
    run.close('Smith shipped v0.13.2 for $4.99.');
    A.eq(e.requests.map(r => r.body.text), ['Dr. Smith shipped v0.13.2 for $4.99.'], 'same handle carries the complete number-safe sentence');
    e.answer(0, 'gemini'); await flush();
    e.Voice.endSession('disconnect');
  }
  {
    const e = setup(), text = ('Dr. Smith shipped v0.13.2 for $4.99. Another complete sentence follows. ').repeat(35).trim();
    const reply = e.reply(); e.Voice.speakChunk(reply, text, 'agent'); e.Voice.endReply(reply);
    A.eq(e.requests.map(r => r.body.text), Split.pack(text, 1000).slice(0, 2), 'actual Voice packing uses the shared rule for the prefetched long reply');
    A.eq(e.requests.length, 2, 'keyed speech preserves its existing two-chunk prefetch');
    e.Voice.endSession('disconnect');
    e.requests.forEach((r, i) => e.answer(i, 'gemini')); await flush();
  }
  {
    const e = setup(), reply = e.reply();
    e.Voice.speakChunk(reply, 'First keyed sentence.', 'agent');
    e.answer(0, 'gemini'); await flush();
    e.Voice.speakChunk(reply, 'Second keyed sentence.', 'agent'); e.Voice.endReply(reply);
    A.eq(e.requests.map(r => r.body.pin), ['', 'gemini'], 'recognized keyed engine pins later chunks of this exact reply');
    A.eq(e.requests.map(r => [r.body.persona, r.body.surface]), [['professional', 'desk'], ['professional', 'desk']], 'ladder retains the persona and surface alongside reply ownership');
    e.answer(1, 'gemini'); await flush(); e.Voice.endSession('disconnect');
  }
  {
    const e = setup(); e.Voice.setLocalTts(true);
    const old = e.reply(); e.Voice.speakChunk(old, 'Old local sentence.', 'agent');
    e.Voice.cancelReply(old, 'superseded');
    const fresh = e.reply(); e.Voice.speakChunk(fresh, 'New local first.', 'agent'); e.Voice.speakChunk(fresh, 'New local second.', 'agent');
    A.eq(e.requests.length, 2, 'first unpinned local sentence is alone even across cancellation');
    e.answer(0, 'edge:en-US-ChristopherNeural'); await flush();
    A.eq(e.requests.length, 2, 'late cancelled response cannot pin the shared Live identity or dispatch its waiting chunk');
    e.answer(1, 'local-kokoro'); await flush();
    A.eq(e.requests.map(r => r.body.pin), ['', '', 'local-kokoro'], 'only the current reply response unlocks the local pin and next chunk');
    A.ok(e.requests[0].signal.aborted, 'the cancelled request retains its own abort');
    A.eq(fresh.state, 'open', 'old response cannot close the new reply');
    e.answer(2, 'local-kokoro'); await flush(); e.Voice.endReply(fresh); e.Voice.endSession('disconnect');
  }
  {
    const e = setup(), reply = e.reply();
    e.Voice.speakChunk(reply, 'A server-exhausted sentence.', 'agent'); e.Voice.endReply(reply);
    e.requests[0].resolve({ ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ fallback: true, retried: true, reason: 'temporary outage', outcome: { code: 'network', terminal: false, engine: 'edge' } }) });
    await flush();
    A.eq(e.requests.length, 1, 'server-exhausted reply spends one client request');
    A.eq([...e.timers.values()].filter(t => t.ms === 400 || t.ms === 1200).length, 0, 'the merged retry owner does not schedule a second ladder');
    A.eq(reply.state, 'done', 'typed exhaustion still completes this reply rather than stranding its handle');
    e.Voice.endSession('disconnect');
  }
  A.report('voice-speech-integration');
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
