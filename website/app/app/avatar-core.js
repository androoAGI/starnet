/* frontend/app/avatar-core.js — the pure decisions behind the video call (frontend/app/avatar-call.js).

   Everything here is timing, thresholds and text rules: no DOM, no audio APIs, no network. That is on purpose —
   these are exactly the rules that are easy to get subtly wrong and impossible to eyeball in a live call, so they
   live where test/avatar-core.test.js can drive them with synthetic input.

   THE RULE THAT MATTERS MOST: the avatar is interrupted by WORDS, never by SOUND. Energy-based barge-in (cut the
   speaker the instant the mic level rises) is what made hosted avatar demos stop mid-sentence for a cough, a
   keyboard or a chair. Here a sound only ever starts a candidate utterance; the avatar keeps talking until a
   transcript of that utterance proves the Commander actually said something — and a backchannel ("yeah",
   "mm-hmm", "right") is not something. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvatarCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── speaking: what the model writes → what the voice says ────────────────────────────────────────────
  const FIRST_CHUNK_MIN = 18;   // chars before the first clause may be spoken — the time-to-first-word lever
  const CHUNK_MIN = 70;         // later pieces wait for a sentence end past this
  const CHUNK_MAX = 320;        // hard cut at a word boundary so a run-on never stalls speech

  // Strip anything a TTS would read out as symbols.
  function speakable(text) {
    return String(text || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'the link')
      .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
      .replace(/[*_~#>|]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Cut streamed text into speakable pieces. The FIRST piece may end at a clause (comma, colon, dash) once it
     has a few words, so the avatar starts talking almost immediately; later pieces wait for sentence ends,
     which gives the TTS whole sentences to phrase naturally. Returns { pieces, rest }. */
  function drain(buf, first) {
    const out = [];
    buf = String(buf || '');
    for (;;) {
      const opening = first && !out.length;
      const min = opening ? FIRST_CHUNK_MIN : CHUNK_MIN;
      const re = opening ? /[.!?…](?=\s)|[,;:—–](?=\s)|\n/g : /[.!?…](?=\s)|\n/g;
      let cut = -1, m;
      re.lastIndex = min;
      if (buf.length > min && (m = re.exec(buf))) cut = m.index + 1;
      if (cut < 0 && buf.length > CHUNK_MAX) {
        const sp = buf.lastIndexOf(' ', CHUNK_MAX);
        cut = sp > min ? sp : CHUNK_MAX;
      }
      if (cut < 0) break;
      const piece = buf.slice(0, cut).trim();
      buf = buf.slice(cut);
      if (piece) out.push(piece);
    }
    return { pieces: out, rest: buf };
  }

  // ── hearing: which transcripts count as the Commander talking ────────────────────────────────────────
  // Whisper-family models famously "hear" these in noise and silence. Alone, they are not speech.
  const HALLUCINATIONS = [
    'thank you', 'thanks', 'thank you very much', 'thanks for watching', 'thank you for watching',
    'please subscribe', 'subscribe', 'you', 'bye', 'bye bye', 'okay', 'ok', 'so', 'the', 'a', 'i',
    'music', 'applause', 'laughter', 'silence', 'noise', 'inaudible', 'blank audio', 'no speech'
  ];
  // Listening noises: a person saying these while someone talks is AGREEING, not interrupting.
  const BACKCHANNEL = new Set(['yeah', 'yes', 'yep', 'yup', 'ok', 'okay', 'right', 'sure', 'uh', 'um', 'uhm', 'erm',
    'hmm', 'hm', 'mm', 'mhm', 'mmhmm', 'uhhuh', 'ah', 'oh', 'aha', 'huh', 'wow', 'cool', 'nice', 'great', 'got', 'it', 'i', 'see', 'true', 'exactly', 'totally', 'alright', 'good']);
  // Short phrases that ARE an interruption even alone.
  const STOP_RE = /^(?:stop|wait|hold on|hang on|hold up|pause|sorry|excuse me|no no|no wait|actually|shut up|quiet|enough|one sec(?:ond)?|let me)\b/;

  function normalize(text) {
    return String(text || '').toLowerCase()
      .replace(/[\[\](){}<>*"“”„«»]/g, ' ')
      .replace(/[^a-z0-9'\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function words(text) { return normalize(text).split(' ').filter(Boolean); }

  function isHallucination(text) {
    const n = normalize(text).replace(/[-']/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n) return true;
    return HALLUCINATIONS.indexOf(n) >= 0 || /^(?:subtitles?|captions?) by\b/.test(n);
  }
  function isStopIntent(text) { return STOP_RE.test(normalize(text)); }
  // Content words: what is left after listening noises. "yeah right okay" → 0; "wait what about Berlin" → 3.
  function contentWords(text) {
    return words(text).map(w => w.replace(/[-']/g, '')).filter(w => w && !BACKCHANNEL.has(w)).length;
  }

  /* Is `heard` just the avatar's own voice leaking back through the speakers? Echo cancellation catches most
     of it; this catches the rest by comparing against what was said recently. */
  function isEcho(heard, recentSpoken) {
    const h = words(heard);
    if (h.length < 2) return false;
    const pool = new Set(words((recentSpoken || []).join(' ')));
    if (!pool.size) return false;
    let hit = 0;
    for (const w of h) if (pool.has(w)) hit++;
    return hit / h.length >= 0.7;
  }

  /* Should an utterance the Commander is making (or just made) stop the avatar?
       mode 'words' (default) — yes on a stop phrase, or on two or more content words.
       mode 'stop'            — only on an explicit stop phrase; everything else waits its turn.
     Never on silence, noise, a hallucinated transcript, a backchannel or an echo. */
  function shouldInterrupt(text, opts) {
    opts = opts || {};
    if (!text || isHallucination(text)) return false;
    if (isEcho(text, opts.recentSpoken)) return false;
    if (isStopIntent(text)) return true;
    if (opts.mode === 'stop') return false;
    return contentWords(text) >= 2;
  }

  /* Is a finished utterance a turn to answer? While the avatar is idle, any real transcript is. While it is
     busy, only what would also have interrupted it — "yeah" said over the avatar is not a question. */
  function isTurn(text, opts) {
    opts = opts || {};
    if (!text || !String(text).trim()) return false;
    if (isEcho(text, opts.recentSpoken)) return false;
    if (opts.avatarBusy) return shouldInterrupt(text, opts);
    // A bare "thank you" in a quiet room is usually Whisper, not the Commander; a long one is real.
    if (isHallucination(text)) return !!normalize(text) && (opts.voicedMs || 0) >= 1200;
    return true;
  }

  // ── the crew has the floor: another agent's voice is playing through the chat speaker ──────────────
  /* While any other agent is being spoken aloud (Voice, frontend/app/voice.js), the video call must neither
     talk over it nor take what its microphone hears — that agent's voice — for the Commander. This tracks
     "the crew is speaking" from the chat voice's state, with:
       - the gaps between chunks covered (pending chunks count, not just audible ones);
       - a grace period after the last chunk, so the tail of the audio still in the room is not a turn;
       - a stale guard: a reply that stays "pending" without any audible speech for staleMs is treated as
         over, so a producer that never closed its reply cannot mute the call forever.
     update() returns { crewSpeaking, ended } — `ended` is true exactly once, on the tick the floor frees. */
  function makeCrewGate(o) {
    o = Object.assign({ graceMs: 700, staleMs: 20000 }, o || {});
    let lastAudible = -Infinity, lastActive = -Infinity, pendingSince = null, was = false;
    function update(s) {
      const now = +s.now || 0, speaking = !!s.speaking, pending = !!s.pending;
      if (speaking) lastAudible = now;
      if (speaking || pending) { if (pendingSince == null) pendingSince = now; } else pendingSince = null;
      // Stale = pending with nothing audible for staleMs, timed from whichever is later: the last audible
      // moment or the moment it went pending (a reply that never became audible must not hold forever).
      const stale = !speaking && pending && (now - Math.max(lastAudible, pendingSince)) > o.staleMs;
      if ((speaking || pending) && !stale) lastActive = now;
      const crewSpeaking = (now - lastActive) < o.graceMs;
      const ended = was && !crewSpeaking;
      was = crewSpeaking;
      return { crewSpeaking, ended };
    }
    return { update, isSpeaking: () => was };
  }

  // Unmistakable "be quiet" commands. Short on purpose: said DURING another agent's speech, only a short,
  // leading command counts — a crew sentence that merely contains "stop" is echo, not an order.
  const CREW_STOP_RE = /^(?:(?:ok(?:ay)?|hey|please|no)[, ]+)?(?:stop(?: (?:it|that|talking|speaking|please))?|enough(?: of that)?|that'?s enough|be quiet|quiet(?: please)?|shut up|silence|hush|shush|cut it|mute)(?: please)?$/;
  function isCrewStop(text) {
    const n = normalize(text).replace(/[-]/g, ' ').replace(/\s+/g, ' ').trim();
    return !!n && n.split(' ').length <= 5 && CREW_STOP_RE.test(n);
  }

  /* What to do with something the mic heard. While the crew has the floor everything is ignored — never a
     turn, never history, never a barge-in — except a clear stop command, which silences the crew voice.
     Returns { ignore, stopCrew }. */
  function shouldIgnoreMic(s) {
    s = s || {};
    if (!s.crewSpeaking) return { ignore: false, stopCrew: false };
    const text = String(s.text || '');
    const stopCrew = isCrewStop(text) && !isEcho(text, s.recentSpoken);
    return { ignore: true, stopCrew };
  }

  /* Announcements (finished work, waiting approvals) wait for a free floor: never over the crew, never over
     the avatar itself, never while the Commander is mid-sentence. offer() returns what may be said now;
     release() hands back the oldest held one once the floor is free. Nothing is dropped. */
  function makeNoticeQueue() {
    let held = [];
    const blocked = f => !!(f && (f.crewSpeaking || f.avatarBusy || f.hearing));
    return {
      offer(text, floor) { if (!text) return null; if (blocked(floor) || held.length) { held.push(text); return null; } return text; },
      release(floor) { return blocked(floor) || !held.length ? null : held.shift(); },
      clear() { held = []; },
      size: () => held.length
    };
  }

  // ── voice activity: sound → candidate utterances ────────────────────────────────────────────────────
  /* Adaptive-threshold VAD. It tracks the room's noise floor while nobody is talking and listens a margin above
     it, so a fan or a café does not read as speech. `strict` (the avatar is talking) raises the bar further so
     residual echo cannot open an utterance. Feed it { rms, ms, strict } per audio frame; it returns an event:
       'start'  — speech began (the caller keeps the pre-roll it buffered)
       'end'    — speech ended normally; { voicedMs, totalMs }
       'abort'  — it was too short to be speech (a click, a cough); discard it
       null     — nothing changed */
  function makeVad(o) {
    o = Object.assign({
      startMs: 160,        // sustained voice before an utterance opens
      endMs: 750,          // silence that closes it
      minVoicedMs: 300,    // shorter than this is a noise, not a word
      maxMs: 30000,        // hard cap on one utterance
      floorInit: 0.004, floorMin: 0.002, floorAlpha: 0.04,
      ratio: 3, strictRatio: 5, minAbs: 0.012, strictMinAbs: 0.03, hold: 0.7,
      calibrateMs: 500
    }, o || {});
    let floor = o.floorInit, calibrated = 0, inSpeech = false, run = 0, voiced = 0, silence = 0, total = 0;
    function threshold(strict) {
      return strict ? Math.max(o.strictMinAbs, floor * o.strictRatio) : Math.max(o.minAbs, floor * o.ratio);
    }
    function frame(f) {
      const rms = Math.max(0, +f.rms || 0), ms = Math.max(0, +f.ms || 0), th = threshold(!!f.strict);
      if (calibrated < o.calibrateMs) {
        calibrated += ms;
        floor = Math.max(o.floorMin, floor * (1 - 0.2) + rms * 0.2);
        return null;
      }
      if (!inSpeech) {
        if (rms > th) {
          run += ms;
          if (run >= o.startMs) { inSpeech = true; voiced = run; silence = 0; total = run; run = 0; return { type: 'start' }; }
        } else {
          run = 0;
          floor = Math.max(o.floorMin, floor * (1 - o.floorAlpha) + rms * o.floorAlpha);
        }
        return null;
      }
      total += ms;
      if (rms > th * o.hold) { voiced += ms; silence = 0; }
      else silence += ms;
      if (silence >= o.endMs || total >= o.maxMs) {
        inSpeech = false;
        const out = { type: voiced >= o.minVoicedMs ? 'end' : 'abort', voicedMs: voiced, totalMs: total };
        voiced = silence = total = 0;
        return out;
      }
      return null;
    }
    function reset() { inSpeech = false; run = voiced = silence = total = 0; }
    return { frame, reset, state: () => ({ inSpeech, voicedMs: voiced, floor, calibrated: calibrated >= o.calibrateMs }) };
  }

  // ── audio plumbing ──────────────────────────────────────────────────────────────────────────────────
  function rms(frame) {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    return frame.length ? Math.sqrt(s / frame.length) : 0;
  }
  // Box-filter downsample (the same approach Local Live uses): good enough for speech, cheap, no aliasing spikes.
  function resample(input, fromRate, toRate) {
    if (!input || !input.length) return new Float32Array(0);
    if (fromRate === toRate) return Float32Array.from(input);
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(input.length / ratio));
    if (ratio >= 1) {
      for (let i = 0; i < out.length; i++) {
        const a = Math.floor(i * ratio), b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
        let sum = 0;
        for (let j = a; j < b; j++) sum += input[j];
        out[i] = sum / (b - a);
      }
    } else {
      for (let i = 0; i < out.length; i++) {
        const x = i * ratio, a = Math.floor(x), b = Math.min(input.length - 1, a + 1), t = x - a;
        out[i] = input[a] * (1 - t) + input[b] * t;
      }
    }
    return out;
  }
  // Float32 [-1,1] → PCM16 little-endian bytes (what Simli ingests).
  function toPcm16(f32) {
    const out = new Uint8Array(f32.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return out;
  }
  // PCM16 bytes → a WAV file (what /api/stt accepts).
  function wav(pcm16, rate) {
    const out = new Uint8Array(44 + pcm16.length);
    const v = new DataView(out.buffer);
    const tag = (at, s) => { for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i)); };
    tag(0, 'RIFF'); v.setUint32(4, 36 + pcm16.length, true); tag(8, 'WAVE');
    tag(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    tag(36, 'data'); v.setUint32(40, pcm16.length, true);
    out.set(pcm16, 44);
    return out;
  }
  function concat(frames) {
    let n = 0;
    for (const f of frames) n += f.length;
    const out = new Float32Array(n);
    let at = 0;
    for (const f of frames) { out.set(f, at); at += f.length; }
    return out;
  }

  return {
    FIRST_CHUNK_MIN, CHUNK_MIN, CHUNK_MAX,
    speakable, drain,
    normalize, isHallucination, isStopIntent, contentWords, isEcho, shouldInterrupt, isTurn,
    makeCrewGate, isCrewStop, shouldIgnoreMic, makeNoticeQueue,
    makeVad, rms, resample, toPcm16, wav, concat
  };
});
