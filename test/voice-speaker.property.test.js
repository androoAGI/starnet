'use strict';
/* node test/voice-speaker.property.test.js — I2: the speaker's saved setting is only ever the Commander's own choice, and
   a voice session only borrows the speaker.

   THE PROPERTY. Seeded op sequences (shared/clock-rng.js makeRng) over the real voice-state.js, voice.js and
   voice-live.js, booted in frontend/index.html order in the window test/helpers/voice-rig.js fabricates (fakes only at
   fetch, Audio, AudioContext, SpeechRecognition, getUserMedia and localStorage). Every op is an entry point that exists
   on 0b8441064 too: the speaker key (its click handler), /voice on and /voice off (chat.js voiceCommand, run from its
   source), Local Live opened on the models leg, on the dictation leg and with the microphone refused, Local Live ended,
   the legacy hands-free loop on and off, Esc (the page's own keydown handlers), DISCONNECT (the voice lines of chat.js
   abort(), run from its source), Voice.init, a reply whose sentence cannot be played (it raises the speech note), and a
   reload (a fresh window over the same storage). After every op, against a model {lastExplicit, leases}:
     (1) the saved 'starnet.voice.speak' is the last explicit choice ('1'/'0'; absent is off)
     (2) Voice.isOn() is that choice, or a session holding the speaker (after a reload: the choice alone)
     (3) a muted speaker never shows the speech note or an ON tooltip
     (4) every write of the key is made by voice-state.js, and no other frontend/app file names the key
   THE MODULE. Leases taken and given back by different owners commute (the state is each owner's last word), an explicit
   choice ends every lease and is the only thing written, and blocked storage reads as off without throwing.
   On 0b8441064 a mute, then Local Live, then a reload came back speaking ('1' saved, though the last choice was off), and
   Local Live opened over a legacy hands-free loop over a mute came up muted (forceSpeakOn found the speaker on, then
   stopConvo restored the mute). */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeRng } = require('../shared/clock-rng.js');
const { chatReply, liveWindow } = require('./helpers/voice-rig.js');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const KEY = 'starnet.voice.speak';
// one turn of the event loop (microtasks, then any timer due): a sleep would cost a whole timer tick on Windows
const turn = () => new Promise(r => setImmediate(r));
async function until(pred, ms) { for (const end = Date.now() + ms; !pred() && Date.now() < end;) await turn(); return pred(); }

// chat.js's own speaker writers, run from its source inside the window: /voice (voiceCommand) and DISCONNECT (abort()'s
// voice lines)
const chat = read('frontend/app/chat.js');
const command = A.fnBody(chat, '  function voiceCommand(args) {');
const disconnect = A.fnBody(chat, '  function abort() {').split('\n').filter(l => /^\s*if \(typeof Voice(?:Live)? !== 'undefined'/.test(l));
A.ok(command.length > 200 && command.length < 4000, 'chat.js still carries voiceCommand (' + command.length + ' chars)');
A.eq(disconnect.length, 2, 'chat.js abort() tears voice down in two lines: Local Live, then Voice');
const COMMAND = new vm.Script(command + '\nthis.__voiceCommand = voiceCommand;', { filename: 'chat.js voiceCommand' });
const DISCONNECT = new vm.Script(disconnect.join('\n'), { filename: 'chat.js abort()' });

const FAIL = 'This sentence cannot be played.';
// a page as it boots: the Live panel at DOMContentLoaded, then the game's voice (the speaker key, Esc)
async function open(store) {
  const env = liveWindow({ store });
  env.sandbox.localLine = () => {};
  COMMAND.runInContext(env.sandbox);
  env.VoiceLive.init();
  env.Voice.init({ name: 'Tester' });
  env.w.failClips.add(FAIL);
  await turn();   // init's STT provider probe answers
  return env;
}

// what the speaker SHOULD be: the Commander's last explicit choice, and the sessions holding it on
function model() {
  return { lastExplicit: false, leases: new Set(), live: false, convo: false,
    on() { return this.lastExplicit || this.leases.size > 0; },
    choose(on) { this.lastExplicit = on; this.leases.clear(); },
    endCall() { this.live = false; this.convo = false; this.leases.clear(); } };
}
// the cases that give the laws teeth, counted so a sequence set that never reaches them fails instead of passing empty
const reached = { 'a note raised': 0, 'muted over a raised note': 0, 'a reload over a held speaker': 0, 'a call over a mute': 0, 'a call over hands-free': 0 };
const calling = s => { if (!s.m.lastExplicit) reached['a call over a mute']++; if (s.m.convo) reached['a call over hands-free']++; };
// each op drives the page, then says what it means for the model; false: it does not apply here (pick another)
const OPS = {
  'speaker key': async s => { s.env.press('voice-toggle'); s.m.choose(!s.m.on()); },
  '/voice on': async s => { s.env.sandbox.__voiceCommand('on'); s.m.choose(true); },
  '/voice off': async s => { s.env.sandbox.__voiceCommand('off'); s.m.endCall(); s.m.choose(false); },
  'Local Live (models)': async s => {
    if (s.m.live) return false;
    calling(s);
    s.env.w.leg = 'models'; await s.env.VoiceLive.start(false);
    s.m.convo = false; s.m.leases.delete('handsfree'); s.m.leases.add('live'); s.m.live = true;   // a legacy loop closes
  },
  'Local Live (dictation)': async s => {
    if (s.m.live) return false;
    calling(s);
    s.env.w.leg = 'dictation'; await s.env.VoiceLive.start(false);
    s.m.live = true; s.m.leases.add('live'); s.m.convo = true; s.m.leases.add('handsfree');   // its listen loop is hands-free
  },
  'Local Live, microphone refused': async s => {
    if (s.m.live) return false;
    s.env.w.leg = 'models'; s.env.w.denyMic = true;
    await s.env.VoiceLive.start(false);
    s.env.w.denyMic = false;
    s.m.endCall();   // the failed call gives back what it took, and the legacy loop it closed stays closed
  },
  'Local Live ends': async s => { if (!s.m.live) return false; s.env.VoiceLive.end(); s.m.endCall(); },
  'hands-free on': async s => { if (s.m.convo) return false; s.env.Voice.toggleVoiceMode(); s.m.convo = true; s.m.leases.add('handsfree'); },
  'hands-free off': async s => { if (!s.m.convo) return false; s.env.Voice.toggleVoiceMode(); s.m.convo = false; s.m.leases.delete('handsfree'); },
  'Esc': async s => {
    s.env.w.key('Escape');
    if (s.m.live) s.m.endCall(); else if (s.m.convo) { s.m.convo = false; s.m.leases.delete('handsfree'); }
  },
  'DISCONNECT': async s => { DISCONNECT.runInContext(s.env.sandbox); s.m.endCall(); },
  'Voice.init': async s => { s.env.Voice.init({ name: 'Tester' }); s.m.convo = false; s.m.leases.delete('handsfree'); },
  'a sentence that cannot be played': async s => {
    const run = chatReply(s.env.Voice);
    run.say(FAIL); run.close('');
    await until(() => !s.env.Voice.isReplyPending(), 400);
    if (s.env.node('voice-interruption').textContent) reached['a note raised']++;
  },
  'reload': async s => {
    if (s.m.leases.size) reached['a reload over a held speaker']++;
    s.env = await open(s.store); s.m.live = false; s.m.convo = false; s.m.leases.clear();
  }
};
const NAMES = Object.keys(OPS);

// the laws, checked after every op. A sequence runs to its end and keeps the FIRST break of each law (a later break may
// only echo an earlier one), so one broken law never hides another.
const LAWS = {
  '(1)': 'the saved speaker setting is the last explicit choice',
  '(2)': 'the speaker is that choice, or a session holding it',
  '(3)': 'a muted speaker shows no speech note and no ON tooltip',
  '(4)': 'every write of the speaker key is made by voice-state.js',
  holders: 'speakerState() names the sessions the model says hold the speaker',
  threw: 'no op throws'
};
// the file of the first frame outside the rig's fake localStorage: who wrote the key
function writer(stack) {
  const frame = String(stack).split('\n').slice(1).map(l => l.trim()).find(l => !/voice-rig\.js/.test(l)) || '';
  const m = /([\w.-]+\.js):\d+:\d+\)?$/.exec(frame);
  return m ? m[1] : frame || 'unknown';
}
function check(s) {
  const e = s.env, m = s.m, broke = [];
  if (!e.Voice.isOn() && s.noted) reached['muted over a raised note']++;
  s.noted = e.Voice.isOn() && !!e.node('voice-interruption').textContent;
  const saved = Object.prototype.hasOwnProperty.call(s.store, KEY) ? s.store[KEY] : null;
  if (!(saved === (m.lastExplicit ? '1' : '0') || (saved === null && !m.lastExplicit))) {
    broke.push(['(1)', 'saved ' + JSON.stringify(saved) + ', the last explicit choice ' + (m.lastExplicit ? 'on' : 'off')]);
  }
  if (e.Voice.isOn() !== m.on()) {
    broke.push(['(2)', 'the speaker is ' + (e.Voice.isOn() ? 'on' : 'off') + ', expected ' + (m.on() ? 'on' : 'off') +
      ' (last choice ' + (m.lastExplicit ? 'on' : 'off') + ', held by ' + JSON.stringify(Array.from(m.leases)) + ')']);
  }
  if (!e.Voice.isOn()) {
    const note = e.node('voice-interruption').textContent, title = e.node('voice-toggle').title;
    if (note) broke.push(['(3)', 'muted, with the speech note up: ' + note]);
    if (title !== 'agent voice: OFF — click to unmute') broke.push(['(3)', 'muted, with the tooltip: ' + title]);
  }
  for (const write of e.w.writes.filter(x => x.key === KEY)) {
    const by = writer(write.stack);
    if (by !== 'voice-state.js') broke.push(['(4)', 'saved ' + JSON.stringify(write.value) + ' from ' + by]);
  }
  e.w.writes.length = 0;
  if (e.Voice.speakerState) {
    const held = e.Voice.speakerState().leases.slice().sort(), want = Array.from(m.leases).sort();
    if (JSON.stringify(held) !== JSON.stringify(want)) broke.push(['holders', JSON.stringify(held) + ', expected ' + JSON.stringify(want)]);
  }
  return broke;
}
// one sequence from a fresh station (nothing saved): the ops it ran, and each law's first break
async function sequence(next, steps) {
  const s = { store: {}, m: model(), env: null }, trail = [], first = {};
  const note = broke => { for (const [law, why] of broke) if (!first[law]) first[law] = (trail.join(' -> ') || 'boot') + ': ' + why; };
  s.env = await open(s.store);
  note(check(s));
  for (let tries = 0; trail.length < steps && tries < steps * 20; tries++) {
    const name = next(trail.length);
    if (!name) break;
    let applies;
    try { applies = await OPS[name](s); } catch (e) { trail.push(name); note([['threw', String(e && e.message || e)]]); break; }
    if (applies === false) continue;
    trail.push(name);
    note(check(s));
  }
  return { trail, first };
}

(async () => {
  // ---- (4) the key has one writer: only voice.js names it, and hands it to voice-state.js ----
  const APP = fs.readdirSync(path.join(ROOT, 'frontend', 'app')).filter(f => f.endsWith('.js'));
  A.eq(APP.filter(f => read('frontend/app/' + f).indexOf(KEY) >= 0), ['voice.js'], 'only voice.js names the speaker key');
  const voice = read('frontend/app/voice.js');
  A.eq((voice.match(/\bLS_SPEAK\b/g) || []).length, 2, 'voice.js names LS_SPEAK twice: its value, and the speaker it hands to voice-state.js');
  A.ok(/VoiceState\.speaker\(\{ key: LS_SPEAK\b/.test(voice), 'voice.js keeps the speaker in voice-state.js (VoiceState.speaker)');

  // ---- THE MODULE ----
  let VS = null;
  try { VS = require('../frontend/app/voice-state.js'); } catch (_) {}
  A.ok(!!(VS && VS.speaker && VS.SPEAKER_LEASES), 'voice-state.js models the speaker (speaker, SPEAKER_LEASES)');
  if (VS && VS.speaker) {
    const memory = store => () => ({ getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } });
    const rng = makeRng('speaker-module');
    let commute = 0, cleared = 0, unwritten = 0;
    for (let n = 0; n < 200; n++) {
      const store = {}, sp = VS.speaker({ key: 'k', storage: memory(store) });
      const pref = rng.next() < 0.5, last = {};
      sp.apply({ pref });
      for (let i = rng.int(1, 6); i > 0; i--) {
        const owner = rng.pick(VS.SPEAKER_LEASES), take = rng.next() < 0.5;
        sp.apply(take ? { lease: owner } : { release: owner });
        last[owner] = take;
      }
      const held = VS.SPEAKER_LEASES.filter(owner => last[owner]);
      if (JSON.stringify(sp.state().leases.slice().sort()) === JSON.stringify(held.slice().sort()) && sp.isOn() === (pref || held.length > 0)) commute++;
      if (store.k === (pref ? '1' : '0')) unwritten++;
      const choice = rng.next() < 0.5;
      sp.apply({ pref: choice });
      if (sp.state().leases.length === 0 && sp.isOn() === choice && store.k === (choice ? '1' : '0')) cleared++;
    }
    A.eq(commute, 200, 'leases commute across owners: the speaker is each owner\'s last word, in any interleaving');
    A.eq(unwritten, 200, 'a lease taken or given back is never written: the saved key is the explicit choice');
    A.eq(cleared, 200, 'an explicit choice ends every lease and is saved as the choice');
    const blocked = VS.speaker({ key: 'k', storage: () => { throw new Error('SecurityError'); } });
    A.eq(blocked.isOn(), false, 'blocked storage reads as off');
    A.eq(blocked.apply({ pref: true }).on, true, 'and a choice made there still holds for the page, unsaved');
    const stranger = VS.speaker({ key: 'k', storage: memory({}) });
    A.eq(stranger.apply({ lease: 'nobody' }).on, false, 'only a known session (handsfree, live) can hold the speaker');
  }

  // ---- THE PROPERTY: the two sequences 0b8441064 broke, then seeded ones ----
  const named = [
    ['speaker key', 'speaker key', 'Local Live (models)', 'reload'],   // on, mute, a call, a reload
    ['hands-free on', 'Local Live (models)']                           // a call opened over hands-free over a mute
  ];
  const SEEDS = 40, STEPS = 24;
  const started = Date.now();
  const broken = {};   // law -> the first break of it in each sequence that broke it
  const run = async (label, next, steps) => {
    const r = await sequence(next, steps);
    for (const [law, why] of Object.entries(r.first)) (broken[law] = broken[law] || []).push(label + ': ' + why);
    return r;
  };
  for (const [i, ops] of named.entries()) await run('named ' + (i + 1), n => ops[n], ops.length);
  for (let seed = 1; seed <= SEEDS; seed++) { const rng = makeRng('speaker-' + seed); await run('seed ' + seed, () => rng.pick(NAMES), STEPS); }
  for (const [law, what] of Object.entries(LAWS)) {
    const list = broken[law] || [];
    A.ok(list.length === 0, law + ' ' + what + ': broken in ' + list.length + ' of ' + (named.length + SEEDS) + ' sequences' +
      (list.length ? '; first: ' + list.slice(0, 2).join(' | ') : ''));
  }
  for (const [what, n] of Object.entries(reached)) A.ok(n >= 3, 'the sequences reach ' + what + ' (' + n + ' times)');
  A.report('voice-speaker.property (' + (Date.now() - started) + ' ms of sequences; reached ' + JSON.stringify(reached) + ')');
})().catch(e => { console.log('FAIL: harness threw — ' + (e && e.stack || e)); process.exit(1); });
