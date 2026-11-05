'use strict';
/* node test/reflect.dedup-only.test.js - A DECLINED TEXT ONLY SUPPRESSES; IT IS NEVER SHOWN TO THE MODEL (turn identity commit 15, Q5).

   The Commander's declined list is plain strings kept on disk and in host dedup so a rejected proposal is never made again. A declined text
   was once a proposal the reflection pass made from a conversation, so it may quote a session the Commander has since deleted. From the first
   delete the host passes every declined text to reflect() as opts.dedupOnly, which:

     feeds   the exact-duplicate set, the near-duplicate loop and MemTruth.relate - so a rejected belief, a paraphrase of it and a restatement
             of it are still dropped from the aux model's answer
     never   buildPrompt (the aux prompt lists what is already remembered; a declined text is not in it), a replacement target (a declined
             text is not a record: no UPDATE can name it, no proposal carries its id)
   Before any delete the declined list rides in `existing` exactly as before (the prompt lists it: the model is told not to propose it again).
   RED at the previous commit: reflect() had no dedupOnly, so a declined text passed that way neither suppressed nor stayed out of the prompt. */
const A = require('./_assert.js');
const { reflect } = require('../sidecar/reflect.js');
const { makeClock } = require('../shared/clock-rng.js');
const { redact } = require('../sidecar/context.js');

const run = { agentId: 'ag', runId: 'run_9', messages: [
  { role: 'user', content: 'I am planning the quokka sanctuary fundraiser and I always schedule it for the third Friday of March' },
  { role: 'assistant', content: 'Noted: the quokka sanctuary fundraiser is on the third Friday of March.' }
] };
const DECLINED = ['quokka sanctuary fundraiser is held on the third Friday of March', 'prefers the wombat theme for every poster'];
const answer = 'FACT: quokka sanctuary fundraiser is held on the third Friday of March\n' +
  'FACT: the quokka sanctuary fundraiser takes place on the third Friday of March\n' +
  'PREFERENCE: prefers the wombat theme for every poster\n' +
  'FACT: the sanctuary treasurer is based in Perth';

(async () => {
  const seen = [];
  const propose = async prompt => { seen.push(prompt); return answer; };
  const opts = extra => Object.assign({ propose, clock: makeClock(100), redact, existing: [{ id: 'note_1', content: 'the commander keeps a notebook', createdAt: 1 }] }, extra);

  // before any delete: the declined list rides in `existing` (the prompt lists it, the filter drops it)
  seen.length = 0;
  const before = await reflect(run, opts({ existing: [{ id: 'note_1', content: 'the commander keeps a notebook', createdAt: 1 }].concat(DECLINED.map(t => ({ content: t }))) }));
  A.ok(/ALREADY REMEMBERED/.test(seen[0]) && seen[0].includes(DECLINED[1]), 'before a delete the declined text is in the prompt (the model is told not to propose it)');
  A.eq(before.proposals.map(p => p.content), ['the sanctuary treasurer is based in Perth'], 'before a delete the declined belief, its paraphrase and the wombat preference are dropped');

  // after the first delete: dedupOnly - same suppression, no word of it in the prompt
  seen.length = 0;
  const after = await reflect(run, opts({ dedupOnly: DECLINED }));
  A.eq(after.proposals.map(p => p.content), ['the sanctuary treasurer is based in Perth'], 'dedupOnly: the exact declined text, its paraphrase and the wombat preference are still dropped');
  A.ok(!seen[0].includes('wombat') && !seen[0].includes(DECLINED[0]) && !seen[0].includes(DECLINED[1]), 'dedupOnly: no declined text is in the aux prompt');
  A.ok(/the commander keeps a notebook/.test(seen[0]), '...while a held belief still is (the prompt lists what is remembered)');

  // a declined text is never a replacement target: an UPDATE naming it (or sharing its subject) does not carry its id
  const upd = await reflect(run, opts({ dedupOnly: ['the sanctuary treasurer is based in Sydney'], propose: async () => 'FACT: the sanctuary treasurer is based in Perth' }));
  A.ok(upd.proposals.every(p => !p.replaceId), 'a claim on the subject of a declined text is dropped as a near duplicate or proposed new - never as a replacement of it');
  const held = await reflect(run, opts({ existing: [{ id: 'note_4', content: 'the sanctuary treasurer is based in Sydney', createdAt: 1 }], propose: async () => 'FACT: the sanctuary treasurer is based in Perth' }));
  A.ok(held.proposals.length === 1 && held.proposals[0].replaceId === 'note_4', 'control: the same claim against a HELD belief replaces it (so the previous assertion proves dedupOnly is not a record)');

  // plain strings and { content } wrappers both work; junk entries are ignored
  const mixed = await reflect(run, opts({ dedupOnly: [{ content: DECLINED[0] }, DECLINED[1], '', null, 7] }));
  A.eq(mixed.proposals.map(p => p.content), ['the sanctuary treasurer is based in Perth'], 'dedupOnly takes plain strings and { content } wrappers and ignores junk');

  // no dedupOnly, no declined: the first three would be proposed
  const none = await reflect(run, opts());
  A.eq(none.proposals.length >= 2, true, 'control: with no declined list the declined texts are proposed again');
  A.report('reflect.dedup-only');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
