/* speech-split.js — THE sentence splitter for everything StarNet says aloud (speech-ladder lane, wave 4).

   Four splitters used to cut the same reply four ways: the desk's streamer (chat.js) knew abbreviations, the desk's
   per-request cut (voice.js splitForTts) cut "v0.13.2" and "$4.99" at their dots once a reply passed 1000 characters,
   the paired device (remote/voice.js) and the built-in engine (local-voice.js) were number-safe but read "Dr. Smith"
   as two sentences. This module is the one rule; the sidecar owns it and frontend/app/speech-split.js is its
   byte-identical mirror (test/speech-ladder.conformance.test.js holds the two together).

   A sentence ENDS at a run of terminal marks (. ! ? …) and any closing quotes or brackets, FOLLOWED BY whitespace or the
   end of the text, unless the word before the mark is a known abbreviation (Mr. Mrs. Ms. Dr. Prof. Sr. Jr. St. vs.
   etc. e.g. i.e.) or a single capital initial ("J. Smith"). So:
     "v0.13.2 shipped."  one sentence (no space after the inner dots)
     "Dr. Smith… is in."  "Dr." never ends one; the ellipsis followed by a space does
     "$4.99"               one number, never "four. ninety-nine"
   pack(text, max) joins sentences into pieces of at most `max` characters (a voice engine reads a run of sentences in
   one breath, which sounds less stilted than one announcement per sentence) and cuts a single sentence longer than
   `max` at its last clause mark (, ; : — –) inside the window when that keeps at least 40% of it, else at its last
   space, else hard. Pure: no I/O, no clock. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SpeechSplit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TERMINAL = /[.!?…]+["'”’)\]]*/g;
  // titles are capitalised ("300 ms. Then" ends a sentence); the Latin ones are not (vs. etc. e.g. i.e.)
  const ABBREVIATION = /(?:^|[\s(["'“‘])(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|[Vv]s|[Ee]tc|[Ee]\.g|[Ii]\.e)\.$/;
  // a single capital initial, also inside a dotted run ("J. Smith", "U.S. Army")
  const INITIAL = /(?:^|[\s(["'“‘.])[A-Z]\.$/;
  const CLAUSE_MARKS = [', ', '; ', ': ', ' — ', ' – '];

  const clean = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

  // is the terminal run ending at `end` (exclusive) in `s` a sentence end? `atEnd` = the end of the text counts.
  function endsSentence(s, start, end, atEnd) {
    const next = s.charAt(end);
    if (next ? !/\s/.test(next) : !atEnd) return false;
    // only a run that is a single '.' can be an abbreviation's or an initial's dot ("etc..." still ends a sentence)
    const run = s.slice(start, end);
    if (/^\.["'”’)\]]*$/.test(run)) {
      const prefix = s.slice(0, start + 1);
      if (ABBREVIATION.test(prefix) || INITIAL.test(prefix)) return false;
    }
    return true;
  }

  // offsets just past every sentence end (the terminal run and its closers), in order
  function boundaries(text, opts) {
    const s = String(text == null ? '' : text);
    const atEnd = !(opts && opts.streaming);
    const out = [];
    TERMINAL.lastIndex = 0;
    let m;
    while ((m = TERMINAL.exec(s))) {
      const end = m.index + m[0].length;
      if (endsSentence(s, m.index, end, atEnd)) out.push(end);
    }
    return out;
  }

  function sentences(text) {
    const s = clean(text);
    if (!s) return [];
    const out = [];
    let start = 0;
    for (const end of boundaries(s)) {
      const part = s.slice(start, end).trim();
      if (part) out.push(part);
      start = end;
    }
    const tail = s.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }

  // one sentence longer than max: the cut index inside s.slice(0, max)
  function cutLong(s, max) {
    const window = s.slice(0, max);
    let cut = -1;
    for (const mark of CLAUSE_MARKS) {
      const i = window.lastIndexOf(mark);
      if (i >= 0) cut = Math.max(cut, i + mark.trimEnd().length);
    }
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    return cut;
  }

  function pack(text, max) {
    const limit = Math.max(20, Math.floor(Number(max) || 0) || 1000);
    const pieces = [];
    let cur = '';
    for (let s of sentences(text)) {
      if (cur && cur.length + 1 + s.length <= limit) { cur += ' ' + s; continue; }
      if (cur) { pieces.push(cur); cur = ''; }
      while (s.length > limit) {
        const cut = cutLong(s, limit);
        const head = s.slice(0, cut).trim();
        if (head) pieces.push(head);
        s = s.slice(cut).trim();
      }
      cur = s;
    }
    if (cur) pieces.push(cur);
    return pieces;
  }

  /* STREAMING: the desk speaks a reply while it is still arriving. lastBoundary(pending) is the offset just past the
     last sentence end that is CONFIRMED (whitespace after it: "3." may still become "3.5"), including that whitespace,
     or -1. stallCut(pending) is the offset of a clause to flush when tokens stall: the last clause mark at or past 60
     characters, else the last space once 100 characters wait, else -1. */
  function lastBoundary(pending) {
    const s = String(pending == null ? '' : pending);
    const b = boundaries(s, { streaming: true });
    if (!b.length) return -1;
    let end = b[b.length - 1];
    while (end < s.length && /\s/.test(s.charAt(end))) end++;
    return end;
  }
  function stallCut(pending) {
    const s = String(pending == null ? '' : pending);
    const clause = /[,;:—–]\s/g;
    let cut = -1, m;
    while ((m = clause.exec(s))) { if (m.index >= 60) cut = clause.lastIndex; }
    if (cut < 0 && s.length >= 100) cut = s.lastIndexOf(' ');
    return cut;
  }

  return { boundaries, sentences, pack, lastBoundary, stallCut };
});
