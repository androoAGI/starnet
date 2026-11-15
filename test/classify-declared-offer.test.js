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

  // ---- COMPLETION (wave 4): negations in other forms, status lines, open questions ----
  // a refusal written with a space or another form is a refusal, so an "ok" after it is an acknowledgement
  for (const refusal of ['I can not run that here.', 'I can no longer write to that folder.', 'Unfortunately I am unable to install it.', "I'm unable to run it.", 'I am not able to save it.', "I'm not able to send it.",
    "I won't be able to run that; I can only describe it.", 'I will not be able to build it.', 'I could not write the file.', "I couldn't write the file.", 'I cannot run that here.']) {
    A.eq(offeredWork(refusal), false, 'a refusal is not an offer: ' + refusal + tag);
    A.eq(isTaskDirective('ok', { priorAgentTurn: refusal }), false, '"ok" after a refusal is an acknowledgement: ' + refusal + tag);
  }
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'I can not run that here. I can write it for you.' }), true, 'a spaced refusal followed by a real offer: the last sentence decides' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'I am unable to run it here. I can write it for you.' }), true, '"unable to" followed by a real offer: the last sentence decides' + tag);
  A.eq(isTaskDirective('yes', { priorAgentTurn: "I can write it for you. I'm not able to run it here." }), false, 'a real offer followed by "not able to": the last sentence decides' + tag);

  // a status or perception statement ("I can see / confirm / tell ...") says what the agent knows, it offers nothing
  for (const status of ['I can see the build is green.', 'I can confirm the tests run clean.', 'I can tell that the file is saved.', 'I could see that the script runs.', 'I can verify the update was applied.']) {
    A.eq(offeredWork(status), false, 'a status line is not an offer: ' + status + tag);
    A.eq(isTaskDirective('yes', { priorAgentTurn: status }), false, '"yes" after a status line is chat: ' + status + tag);
  }
  // real offers still count, including one that shares a sentence with a status clause
  for (const offer of ['I can write that script for you.', 'I could set that up.', "I'll draft it if you like.", 'I will save it if you want.', 'I can see the build is green, and I can fix the lint warning.', 'The build is green. I can run the full suite too.']) {
    A.eq(offeredWork(offer), true, 'a real offer: ' + offer + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: offer }), true, '"yes please" after a real offer is a task: ' + offer + tag);
  }

  // a reply that ends with an OPEN question ("what would you like?") is asking for content: a bare yes answers nothing,
  // so it is not an offer to act even when it opens with "Happy to ...". A yes/no confirmation of the offer still is.
  for (const open of ['Happy to make changes - what would you like?', 'Happy to make changes. What would you like?', 'Happy to write that script for you - which file name do you want?', 'Happy to build it for you, but how should it look?']) {
    A.eq(offeredWork(open), false, 'an open question is not an offer: ' + open + tag);
    A.eq(isTaskDirective('yes', { priorAgentTurn: open }), false, '"yes" to an open question stays chat: ' + open + tag);
  }
  for (const confirm of ['I can draft it for you - sound good?', 'I could set that up for you, okay?',
    'I can fix that for you - how does that sound?', 'Happy to draft the email for you - what do you think?', "I'd be happy to update the config, how about it?", 'I can create the file for you, what do you say?',
    'I could generate the report for you. How would that sound?', 'I can save it for you, how’s that?']) {
    A.eq(offeredWork(confirm), true, 'a yes/no confirmation of a declared offer: ' + confirm + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: confirm }), true, '"yes please" after a sounding-out closer is a task: ' + confirm + tag);
  }
  // a sentence that only STARTS with a sounding-out phrase but carries the offer itself is the offer, not a closer to drop
  for (const lead of ['Here is the issue. How about this: I can write a fix for you.', 'The build broke. What do you think? I could update the config for you.',
    'Found it. What do you say, I can fix it for you now.', 'Found it. How about it, I can run the migration for you.', 'Got it. What about this? I can draft the reply for you.']) {
    A.eq(offeredWork(lead), true, 'an offer introduced by a sounding-out phrase: ' + lead + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: lead }), true, '"yes please" is a task: ' + lead + tag);
  }
  // a sounding-out closer after something that is NOT an offer stays chat
  A.eq(offeredWork('The build is green - what do you think?'), false, 'a sounding-out closer without an offer is not an offer' + tag);
  A.eq(offeredWork('I cannot run that here - what do you think?'), false, 'a sounding-out closer after a refusal is not an offer' + tag);
  A.eq(offeredWork('I cannot run it here. How does that sound?'), false, 'a separate sounding-out sentence after a refusal is not an offer' + tag);
  A.eq(offeredWork('The report is saved. What do you think?'), false, 'a separate sounding-out sentence after a plain statement is not an offer' + tag);
  A.eq(offeredWork('I can see the build is green - what do you think?'), false, 'a sounding-out closer after a status line is not an offer' + tag);

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
