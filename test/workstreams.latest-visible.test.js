/* node test/workstreams.latest-visible.test.js — the rail's receipt line reads the newest visible message from the
   END of a history (Workstreams.latestVisibleMessage) instead of filtering a copy of the whole history twice a second
   per row (2026-10-07 station performance lane). It must pick exactly the message the old full filter picked:
   visibleMessages(w).slice().reverse().find(m => m.content.trim()). Seeded random histories, every message shape. */
'use strict';
const A = require('./_assert.js');
const W = require('../frontend/app/workstreams.js');

let seed = 1007;
const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
const shapes = [
  () => ({ role: 'user', content: 'hello there' }),
  () => ({ role: 'assistant', content: 'Done. Next step.' }),
  () => ({ role: 'assistant', content: '   \n  ' }),                   // blank text never counts
  () => ({ role: 'assistant', content: '' }),
  () => ({ role: 'assistant', content: 'tool chatter', hidden: true }),
  () => ({ role: 'assistant', content: 'system line', sys: true }),
  () => ({ role: 'user', content: 'internal nudge', internal: true }),
  () => ({ role: 'tool', content: 'a tool result' }),
  () => ({ role: 'assistant', content: null }),
  () => ({ role: 'assistant' }),
  () => null,
];
const old = w => W.visibleMessages(w).slice().reverse().find(m => m.content.trim()) || null;
let same = 0, total = 0;
for (let t = 0; t < 4000; t++) {
  const n = rnd(12), history = [];
  for (let i = 0; i < n; i++) { const m = shapes[rnd(shapes.length)](); if (m) m.i = i; history.push(m); }
  const w = { history };
  total++; if (W.latestVisibleMessage(w) === old(w)) same++;
}
A.eq(same, total, 'the tail scan picks the same message as the full visible filter in every history');
A.eq(W.latestVisibleMessage({}), null, 'a stream with no history has no latest message');
A.eq(W.latestVisibleMessage(null), null, 'a missing stream has no latest message');
A.eq(W.latestVisibleMessage({ history: 'nope' }), null, 'a malformed history is not read');
A.report('workstreams.latest-visible');
