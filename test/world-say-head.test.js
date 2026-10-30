/* node test/world-say-head.test.js — the speech bubble costs the same on token 10 and token 10,000 of a reply.

   perf p5 (2026-10-20, a user: "eats my PC's resources"): chat.js calls World.say(acc) with the WHOLE reply so far on every
   streamed token of a chat reply, and say() folded every whitespace run of it before keeping the first 160 characters —
   O(reply) per token, O(n²) per answer. Locked by EXECUTING world.js's own say() (sliced with A.fnBody):
     1. the bubble text is exactly what folding the whole reply gave, on random text heavy in every kind of whitespace;
     2. saying a 5 MB reply twenty times costs what saying a 50 KB one does, and less than folding it once;
     3. an ambient remark still mutters its whole folded line. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const sayFn = A.fnBody(src, 'function say(text, opts)'), headFn = A.fnBody(src, 'function bubbleText(text)');
A.ok(sayFn.length > 50 && sayFn.length < 3000 && headFn.length > 50 && headFn.length < 3000, 'world.js still defines say() and bubbleText() (sliced cleanly)');
const muttered = [];
const env = { agent: null };
// eslint-disable-next-line no-new-func
const make = new Function('env', 'performance', 'Voice', headFn + '\n' + sayFn.replace(/\bagent\b/g, 'env.agent') + '\nreturn say;');
const say = make(env, { now: () => 0 }, { mutter: t => muttered.push(t) });
const old = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);   // what say() kept before

/* ---------- 1. the same bubble ---------- */
let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const BITS = ['word', 'x', 'é', '😀', ' ', '  ', '\n', '\n\n', '\r\n', '\t', ' ', '﻿', ' ', '　', '   \n   ', ' '.repeat(300), '\n'.repeat(900)];
let diffs = 0, first = '';
for (let k = 0; k < 3000; k++) {
  let s = '';
  const target = Math.floor(rnd() * 6000);
  while (s.length < target) s += BITS[Math.floor(rnd() * BITS.length)];
  if (rnd() < 0.2) s = ' '.repeat(Math.floor(rnd() * 2100)) + s;   // a head that is mostly whitespace
  env.agent = { say: null };
  say(s);
  if (env.agent.say.text !== old(s)) { diffs++; if (!first) first = JSON.stringify(s.slice(0, 80)); }
}
A.eq(diffs, 0, 'the bubble reads exactly as folding the whole reply did' + (first ? ' — first difference on ' + first : ''));
env.agent = { say: null }; say(null); A.eq(env.agent.say.text, '', 'nothing said → an empty bubble');
env.agent = null; A.eq(say('hi'), undefined, 'no hero body → nothing to say');

/* ---------- 2. cost ----------
   Judged against this machine, never a fixed count of ms (a fixed 60 ms failed on a slow Linux CI runner at 62 ms,
   2026-10-29). The bug is ANY pass over the whole reply on every call, so the lock is size independence: twenty says
   of a 5 MB reply may cost at most 4x twenty says of a 50 KB one (a hundredth as long), plus a two-hundredth of one
   whole-reply fold for timer noise. The two sizes are timed side by side, the best of five rounds each, so a slow or
   busy machine slows both alike. A whole-reply pass makes the big side over ten times the small one; even one as
   cheap as looking for a '\r' anywhere in the reply (about a thousandth of a fold) fails. And twenty says must
   still cost less than folding the reply ONCE, which is what every call cost before p5. The replies are slices of one
   flat string, so the clock times say() alone: they were `big + k`, a rope V8 copies flat on its first read, and that
   copy was over 90% of what the old clock timed. */
const big = ('a streamed reply keeps growing\n\n- with **markdown**   and spaces\t\t\n').repeat(80000);   // ~5 MB
const SMALL = 50000;   // the 50 KB reply: still over bubbleText's 2048-character head, so both take the same path
const clock = (f) => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6; };
const foldOnce = Math.min(clock(() => old(big.slice(1))), clock(() => old(big.slice(2))));   // the first also flattens big
env.agent = { say: null };
let large = Infinity, small = Infinity, last = big;
for (let round = 0; round < 5; round++) {
  small = Math.min(small, clock(() => { for (let k = 0; k < 20; k++) say(big.slice(round * 20 + k, round * 20 + k + SMALL)); }));
  large = Math.min(large, clock(() => { for (let k = 0; k < 20; k++) say(last = big.slice(round * 20 + k)); }));
}
const noise = foldOnce / 200;
A.ok(large <= 4 * small + noise, 'saying a 5 MB reply twenty times cost ' + large.toFixed(2) + ' ms, against ' + small.toFixed(2)
  + ' ms for a 50 KB one (' + (large / small).toFixed(1) + 'x; may be 4x plus ' + noise.toFixed(2) + ' ms): no pass over the whole reply');
A.ok(large < foldOnce, 'saying a 5 MB reply twenty times cost ' + large.toFixed(2) + ' ms, less than folding all of it once: ' + foldOnce.toFixed(1) + ' ms (what every call cost before)');
A.eq(env.agent.say.text, old(last), 'and still shows its first 160 folded characters');

/* ---------- 3. ambient remarks ---------- */
env.agent = { say: null }; muttered.length = 0;
say('  the reactor   hums\n tonight  ', { ambient: true });
A.eq(muttered, ['the reactor hums tonight'], 'an ambient remark is muttered whole, folded');
say('hmm', { ambient: true }); say('...', { ambient: true });
A.eq(muttered.length, 1, 'filler stays a silent bubble');

A.report('world-say-head.test');
