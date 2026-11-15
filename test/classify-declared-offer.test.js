/* node test/classify-declared-offer.test.js — a "yes" to the agent's own DECLARED offer to act is a task (T9, W12).
   Red at 45e7ee302: offeredWork() required the agent's reply to END WITH "?", so after "I can write that script
   for you." the Commander's "yes please" was classified as chat and the run got ZERO tools (the sidecar wires tools
   only when isTask) — the agent could only paste the code or promise the work.
   The rule under test: the reply's LAST SENTENCE states an offer (DECLARED_OFFER), names an action, and is not a
   refusal ("I can't ..."). Callers are unchanged: isTaskDirective already checks isAffirmation && offeredWork first.
   Runs against both trees (frontend/app and its website mirror). */
'use strict';
const path = require('path');
const A = require('./_assert.js');

const ROOTS = ['frontend/app/classify.js', 'website/app/app/classify.js'];

for (const rel of ROOTS) {
  const { isTaskDirective, isAffirmation, offeredWork } = require(path.join('..', rel));
  const tag = ' [' + rel.split('/')[0] + ']';

  // ---- RED at base: a yes to a declarative offer is a task ----
  A.eq(isTaskDirective('yes please', { priorAgentTurn: 'I can write that script for you.' }), true, '"yes please" after "I can write that script for you." is a task' + tag);
  A.eq(isTaskDirective('sure', { priorAgentTurn: "Let me know if you'd like me to set it up." }), true, '"sure" after "Let me know if you\'d like me to set it up." is a task' + tag);
  A.eq(isTaskDirective('ok', { priorAgentTurn: 'If you want, I can draft the email now.' }), true, '"ok" after "If you want, I can draft the email now." is a task' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'The report is ready. I\'d be happy to send it to the team.' }), true, 'the offer is the LAST sentence of a longer reply' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'Here is the plan:\n1. A\n2. B\n\nJust say the word and I\'ll run it.' }), true, 'the offer is on the last line, after a list' + tag);
  A.eq(isTaskDirective('go ahead', { priorAgentTurn: 'I could build the landing page for you!' }), true, 'an exclamation closes the offer' + tag);
  A.eq(isTaskDirective('yes please', { priorAgentTurn: 'I can write that script for you — let me know if you’d like me to do it.' }), true, 'a typographic apostrophe is the same apostrophe' + tag);
  A.ok(offeredWork('I can write that script for you.'), 'offeredWork: declarative offer' + tag);
  A.ok(offeredWork('**Happy to write it up if you want, I will save it as notes.md.**'), 'offeredWork: markdown-wrapped offer' + tag);

  // ---- LIVENESS: what was chat or not-an-offer stays so ----
  A.eq(isTaskDirective('yes please', { priorAgentTurn: "I can't do that." }), false, '"I can\'t do that." is not an offer' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'I could not find it.' }), false, '"I could not find it." is not an offer' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: "I couldn't write the file." }), false, '"I couldn\'t write the file." is not an offer' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'I cannot run that here. I can write it for you.' }), true, 'a refusal followed by a real offer: the last sentence decides' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'I can write it for you. I cannot run it here.' }), false, 'a real offer followed by a refusal: the last sentence decides' + tag);
  A.eq(offeredWork('Happy to help.'), false, '"Happy to help." has no action verb' + tag);
  A.eq(offeredWork('Happy to help with anything else?'), false, '"Happy to help with anything else?" is not an offer to act' + tag);
  A.eq(offeredWork('Here it is.'), false, '"Here it is." is not an offer' + tag);
  A.eq(offeredWork('Should I have used tabs? Anyway, the file is saved.'), false, 'a question mid-way, closing statement is not an offer' + tag);
  A.eq(offeredWork('I can write that script for you. Done, it is saved.'), false, 'an offer said earlier, not in the last sentence' + tag);
  A.eq(offeredWork('The tests pass and the file is saved.'), false, 'a plain statement is not an offer' + tag);
  A.eq(offeredWork(''), false, 'empty reply' + tag);
  A.eq(offeredWork(null), false, 'null reply' + tag);
  A.eq(isTaskDirective('ok thanks', { priorAgentTurn: 'I can write that script for you.' }), false, '"ok thanks" after an offer is an acknowledgement, not a go' + tag);
  A.eq(isTaskDirective('thanks', { priorAgentTurn: 'I can write that script for you.' }), false, '"thanks" is not a yes' + tag);
  A.eq(isTaskDirective('yes'), false, 'context-free "yes" is chat' + tag);
  A.eq(isTaskDirective('yes please'), false, 'context-free "yes please" is chat' + tag);
  A.ok(isAffirmation('yes please'), 'isAffirmation is unchanged' + tag);

  // the question rule still works
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'Want me to draft it?' }), true, 'the question rule is unchanged' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'Anything else?' }), false, 'a plain question stays chat' + tag);

  // every producer of the context passes the agent's text unchanged: a long reply only its last 400 chars count
  const long = 'x '.repeat(500) + 'Let me know if you would like me to save it.';
  A.eq(offeredWork(long), true, 'the offer is found in the 400-char tail of a long reply' + tag);
}

// the two trees are the same file
{
  const fs = require('fs');
  A.ok(fs.readFileSync(path.join(__dirname, '..', ROOTS[0])).equals(fs.readFileSync(path.join(__dirname, '..', ROOTS[1]))), 'website mirror is byte-identical to frontend/app/classify.js');
}

A.report('classify-declared-offer.test');
