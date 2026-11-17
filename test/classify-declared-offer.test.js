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

/* ---- T9s: AN OFFER IS AN OFFER (2026-11-15) ----
   Red at 8ca33b1a6 (the 0.15.2 candidate): declaredOffer accepted any last sentence that held "i can / i could / happy to"
   plus one of 19 action words ANYWHERE in it. So refusals and result lines read as offers ("Glad I could fix that for
   you." then "ok" was a task: the run carried the full tool set), while most stated offers were still chat (only 17 verbs,
   the offer had to be the very last sentence, "yes thanks" was not a yes).
   The rule under test: the verb is what the agent offers to do (it follows the offer phrase), refusals and reports are not
   offers, the file's ACTIONABLE verbs and the plain work verbs count, a closing "just say the word" / "let me know" hands
   the decision to the sentence before it, and a yes with thanks is still the yes.
   The tables are the adversarial pass's own (attack A3: t9-truth.js, verify-A3-F1/probe-classify.js,
   verify-A3-F2/probe-classify.js), copied here as fixtures. */
const Q = '’';
// the attacker's 12 refusals: an "ok" after each stays chat
const REFUSALS = [
  'I can' + Q + 't run that here.',
  'I wish I could run that for you.',
  'If I could run it I would, but the sandbox blocks it.',
  'I can only describe the steps, I have no way to run them.',
  'Sorry, that is beyond what I can do without a build tool.',
  'There is nothing more I can do to fix that.',
  'I don' + Q + 't have a tool to send email, but happy to help in other ways.',
  'I canʼt run that here.',
  'I can`t run that here.',
  'I can hardly run that without network access.',
  'I could write that script for you, but I don' + Q + 't think that is wise.',
  'Running it is not something I can do; you would have to start it yourself.'
];
// the attacker's 10 status lines
const STATUS_LINES = [
  'I can see the build is green.',
  'I can now see the build is green.',
  'I can also confirm the tests run clean.',
  'I can already see the fix is live.',
  'Glad I could fix that for you.',
  'Done. I was happy to update the config.',
  'That was as much as I could do before the build finished.',
  'All set - happy to report the update went through.',
  'The build is green as far as I can make out.',
  'Saved. Happy to make more changes anytime!'
];
// the skeptic's 36 sentences that are not offers (20 result lines, 16 refusals)
const SKEPTIC_RESULTS = [
  'Glad I could fix that for you.',
  'Glad I could help.',
  'Happy to help!',
  'All done. Let me know if you need anything else.',
  'The build is green now.',
  'I was able to run the tests and they all pass.',
  'I could run the full suite this time and everything passed.',
  'That is everything I could fix in this pass.',
  'It was the only change I could make without touching the config.',
  'As far as I can tell the update went through.',
  'I can see the build is green.',
  'I can now see the build is green.',
  'I can confirm the script ran clean.',
  'I can also confirm the script ran clean.',
  'Done - I was happy to update it.',
  'From what I can see, the fix is live and the build passes.',
  'So that is as far as I can take it; the build is green.',
  'The tests pass, which is the best check I can run from here.',
  'Now I can start from a clean state next time.',
  'I did what I could to make the page load faster.'
];
const SKEPTIC_REFUSALS = [
  'I can\'t run that here.',
  'I cannot send email from this station.',
  'I am not able to run it from here.',
  'I can only describe the steps, I have no way to run them.',
  'I can only explain how to fix it, not change the file myself.',
  'I wish I could run that for you.',
  'There is nothing more I can do to fix that.',
  'That is all I can do without a tool to run code.',
  'Without access to the server there is not much I can do to fix it.',
  'I don\'t have a way to send it, sorry.',
  'Unfortunately I couldn\'t build it.',
  'I have no tool to create files in this chat.',
  'If I could run it I would.',
  'I could not find a way to make it work.',
  'I can no longer update that file.',
  'Sadly that is beyond what I can build here.'
];
// the attacker's 35 stated offers, each with the reply the attacker gave it. 32 are offers this rule can read ...
const STATED_OFFERS = [
  ['I can write that script for you.', 'yes please'],
  ['I can draft the email for you. Just say the word.', 'yes'],
  ['I can write that script for you. Let me know!', 'yes please'],
  ['I can fix that for you. Just let me know.', 'ok'],
  ['I can update the config for you.\n\nJust say the word.', 'yes'],
  ['I can write that script for you.\n\nLet me know if you' + Q + 'd like any changes first.', 'yes'],
  ['I can search the web for the latest numbers.', 'yes please'],
  ['I can look that up for you.', 'yes'],
  ['I can check the logs for you.', 'sure'],
  ['I can research that for you if you' + Q + 'd like.', 'yes please'],
  ['I can delete the old drafts for you.', 'ok'],
  ['I can schedule that for you.', 'yes'],
  ['I can summarize the thread for you.', 'yes please'],
  ['I can deploy it now if you want.', 'yes'],
  ['I can test it for you.', 'sure'],
  ['I can email the report to the team.', 'yes'],
  ['I can add that to the calendar for you.', 'yes please'],
  ['I can rename the files for you.', 'ok'],
  ['I can download the dataset and take a look.', 'yes'],
  ['I can open the page and read it for you.', 'yes'],
  ['I' + Q + 'd be happy to look into it.', 'yes please'],
  ['Happy to dig into the logs if that helps.', 'yes'],
  ['If you want, I can pull the numbers.', 'sure'],
  ['I' + Q + 'll go ahead and draft it if that works for you.', 'yes'],
  ['Let me know if you want me to set it up.', 'yes'],
  ['I can set the cron job up for you.', 'ok'],
  ['I can write that script for you 🙂', 'yes'],
  ['**I can write that script for you.**', 'yes please'],
  ['I can write that script for you.', 'yes thanks'],
  ['I can write that script for you.', 'yes, thank you'],
  ['I can write that script for you.', 'ok great'],
  ['I can write that script for you.', 'ya']
];
// ... and 3 are offers in another language. No rule reads them (the lists are English); they stay chat, as at the candidate.
// Pinned so a change is seen, not because chat is right.
const STATED_OFFERS_NOT_READ = [
  ['Ich kann das Skript für dich schreiben.', 'ok'],
  ['Soll ich das für dich schreiben?', 'ok'],
  ['¿Quieres que lo escriba?', 'ok']
];
// the second skeptic's 16 sentences that are not offers but hold one of the ordinary verbs (the cost of counting those
// verbs): 11 stay chat. 5 read as offers: the verb does follow the offer phrase and nothing in the sentence says it is a
// report, so the cheap error (a task) is kept. Pinned so a change is seen.
const ORDINARY_VERB_NOT_OFFERS = [
  'I could find no errors in the log.',
  'Happy to report the deploy went through.',
  'That is everything I could find.',
  'That is the best plan I could come up with.',
  'I could check only the first two pages before the limit.',
  'Glad I could find it for you.',
  'I could not be happier to report that it passed.',
  'As far as I can check, nothing else changed.',
  'I searched everywhere I could search.',
  'I could download only half of it.',
  'This is all I could extract from the scan.'
];
const ORDINARY_VERB_KEPT_AS_TASK = [
  'I can read the file fine now.',
  'I could open the page without trouble.',
  'I can list three reasons this failed.',
  'I can compare them all day, but the answer stays the same.',
  'Happy to post an update when it lands.'
];
const ACKS = ['ok', 'yes', 'sounds good'];

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

  // ---- T9s: AN OFFER IS AN OFFER ----
  // refusals, status lines and result lines are not offers: a bare acknowledgement after one stays chat
  for (const [kind, rows] of [['refusal', REFUSALS], ['status line', STATUS_LINES], ['result line', SKEPTIC_RESULTS], ['limit', SKEPTIC_REFUSALS], ['report with an ordinary verb', ORDINARY_VERB_NOT_OFFERS]]) {
    for (const prior of rows) {
      A.eq(offeredWork(prior), false, 'a ' + kind + ' is not an offer: ' + prior + tag);
      for (const ack of ACKS) A.eq(isTaskDirective(ack, { priorAgentTurn: prior }), false, JSON.stringify(ack) + ' after a ' + kind + ' stays chat: ' + prior + tag);
    }
  }
  // a stated offer is an offer: the attacker's reply to it, and a plain "yes please", are tasks
  for (const [prior, reply] of STATED_OFFERS) {
    A.eq(offeredWork(prior), true, 'a stated offer: ' + JSON.stringify(prior) + tag);
    A.eq(isTaskDirective(reply, { priorAgentTurn: prior }), true, JSON.stringify(reply) + ' after a stated offer is a task: ' + JSON.stringify(prior) + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: prior }), true, '"yes please" after a stated offer is a task: ' + JSON.stringify(prior) + tag);
  }
  for (const [prior, reply] of STATED_OFFERS_NOT_READ) A.eq(isTaskDirective(reply, { priorAgentTurn: prior }), false, 'known gap, an offer in another language is not read: ' + prior + tag);
  for (const prior of ORDINARY_VERB_KEPT_AS_TASK) A.eq(isTaskDirective('ok', { priorAgentTurn: prior }), true, 'known cheap error, the verb follows the offer phrase: ' + prior + tag);

  // RULE 1, the verb belongs to the offer: it follows the offer phrase, it is not a word somewhere else in the sentence
  for (const elsewhere of ['I can also confirm the tests run clean.', 'I can hardly run that without network access.', 'I can only describe the steps, I have no way to run them.',
    'I can imagine the build will start soon.', 'Happy to hear the script works.', 'I could tell the update was a fix.', 'I can clearly see the build is green.', 'I can wait for the build to finish.',
    'I can think of two ways to fix it.', 'I can be sure the build passes now.', 'I can do no more to fix it.', 'I can do without the build step.', 'I can describe the steps, but you would have to run them.',
    'I don' + Q + 't have a tool to send email, but I can describe the steps.', 'The script is ready to run and I can see no errors.']) {
    A.eq(offeredWork(elsewhere), false, 'the action word is not what the agent offers: ' + elsewhere + tag);
    A.eq(isTaskDirective('ok', { priorAgentTurn: elsewhere }), false, '"ok" after it stays chat: ' + elsewhere + tag);
  }
  for (const follows of ['I can also run the full suite.', 'I could just write it for you.', 'I can go ahead and draft it.', 'I can help you set it up.', 'Happy to go ahead and fix it.', 'I can now run the full suite if you like.',
    'What I can do is write the script for you.', 'What I can do is search the web for you.', 'Here is what I can do: draft the email and send it to the team.', 'Tell me if you want me to run it.',
    'If you would like, I will send it now.', 'Just say the word and I will build it.', 'The draft is ready to send, just say the word.', 'I can fix that no problem.']) {
    A.eq(offeredWork(follows), true, 'the verb follows the offer phrase: ' + follows + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: follows }), true, '"yes please" is a task: ' + follows + tag);
  }
  // a verb no list knows stands in the verb's place: an action word a few words on, in the same clause, still makes the
  // offer (every one of these was a task at 8ca33b1a6 and must stay one)
  for (const unknown of ['I can refactor the code for you.', 'I can rewrite the script so it handles empty files.', 'I can go through the code and fix the warnings.', 'I can quickly put together a draft.',
    'I can take care of the update for you.', 'I can work on the script next.', 'I can turn this into a script.', 'I can get the build running again.', 'Happy to help with the build.',
    'I can have the script email you when it finishes.', 'I' + Q + 'd be happy to put together a draft.']) {
    A.eq(offeredWork(unknown), true, 'an unknown verb, then the action word in the same clause: ' + unknown + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: unknown }), true, '"yes please" is a task: ' + unknown + tag);
  }
  // "I'll <verb>" alone is a promise, not an offer (unchanged); it is an offer when the sentence asks ("if you like", "if that works")
  A.eq(offeredWork('I will draft it now.'), false, 'a promise without a condition is not an offer' + tag);
  A.eq(offeredWork('I will be here if you want to run it later.'), false, '"I will be here if you want ..." offers no work' + tag);

  // RULE 2, refusals and reports are not offers, each shape on its own
  for (const shape of ['I can only run it locally.', 'I wish I could send it for you.', 'If I could build it I would.', 'If only I could run it here.', 'There is nothing I can fix here.',
    'There is nothing else I can run.', 'That is all I could write today.', 'That is everything I can send.', 'I did as much as I could fix.', 'Glad I could build that for you.',
    'Happy I could fix it.', 'I was more than happy to write it.', 'I am happy to have fixed it.', 'I could build it this time and it worked.', 'I could run the tests and all of them passed.',
    'I was able to fix it.', 'I can now see the update.', 'I can already tell the fix works.', 'I can also report the build passed.', 'The best I could do was write a summary.',
    'Here is what I could find.', 'It sounds like you do not want me to delete them.', 'Happy to run through it again anytime!', 'I can fix that next time.', 'I could have run the build first.',
    'I am happy to have run the build for you.', 'I could run it, but I would not recommend it.', 'I can hardly run that.', 'I can never run that build without errors.', 'I could find no bug in the script.']) {
    A.eq(offeredWork(shape), false, 'a refusal or a report is not an offer: ' + shape + tag);
    A.eq(isTaskDirective('ok', { priorAgentTurn: shape }), false, '"ok" after it stays chat: ' + shape + tag);
  }
  // ... and a real offer in the same sentence, or right after one of them, still counts
  for (const offer of ['Glad I could fix that for you, and I can update the docs too.', 'I could run the suite and send you the output.', 'That is all I could find. I can search again for you.',
    'I can only describe it here, but I can write it to a file for you.']) {
    A.eq(offeredWork(offer), true, 'a real offer beside a report: ' + offer + tag);
  }

  // RULE 3, ordinary verbs count, each only where the agent offers it
  for (const verb of ['research', 'search', 'find', 'look up', 'fetch', 'download', 'read', 'open', 'compile', 'summarise', 'list', 'extract', 'analyze', 'investigate', 'compare', 'check', 'calculate', 'translate',
    'plan', 'schedule', 'email', 'post', 'delete', 'deploy', 'test', 'add', 'rename']) {
    A.eq(isTaskDirective('yes please', { priorAgentTurn: 'I can ' + verb + ' that for you.' }), true, 'an ordinary verb is an offer verb: ' + verb + tag);
    A.eq(offeredWork('The ' + verb + ' is all I can see.'), false, 'the same word away from the offer phrase is not an offer: ' + verb + tag);
  }
  // a closer hands the decision to the sentence before it, on the same line or on the line above
  for (const closer of ['Just say the word.', 'Just say the word!', 'Let me know.', 'Let me know!', 'Just let me know.', 'So just let me know!', 'Let me know if that works.', '**Just say the word.**', 'Sound good?', 'Okay?']) {
    A.eq(offeredWork('I can draft the email for you. ' + closer), true, 'an offer, then a closer: ' + closer + tag);
    A.eq(offeredWork('I can draft the email for you.\n\n' + closer), true, 'an offer, then a closer on its own line: ' + closer + tag);
    A.eq(offeredWork('The email is drafted. ' + closer), false, 'a closer after a plain statement is not an offer: ' + closer + tag);
    A.eq(offeredWork('I can only describe the steps.\n\n' + closer), false, 'a closer on its own line after a refusal is not an offer: ' + closer + tag);
    A.eq(offeredWork(closer), false, 'a closer alone is not an offer: ' + closer + tag);
  }
  A.eq(offeredWork('I can update the config for you.\n\nHow does that sound?'), true, 'a sounding-out closer on its own line reads the line above' + tag);
  A.eq(offeredWork('I can draft the email for you. Let me know which tone you want.'), false, '"let me know which ..." asks for content, it is not a closer' + tag);
  A.eq(offeredWork('I can draft the email for you. The tests pass. Just say the word.'), false, 'a closer reads the ONE sentence before it' + tag);
  // a split phrasal verb is the verb
  for (const split of ['I can set the cron job up for you.', 'I could set a nightly backup up.', 'I can look that up for you.', 'Happy to look the latest numbers up.']) A.eq(offeredWork(split), true, 'a split phrasal verb: ' + split + tag);
  A.eq(offeredWork('I can set expectations with the whole team so that morale stays up.'), false, 'a far "up" does not make a phrasal verb' + tag);
  // an acknowledgement with thanks or a short positive word after a recognised offer is the acknowledgement
  for (const warm of ['yes thanks', 'yes, thank you', 'Yes please, thanks!', 'sure, thanks', 'yep thx', 'ok great', 'okay perfect', 'ya']) {
    A.ok(isAffirmation(warm), 'a yes with thanks is a yes: ' + warm + tag);
    A.eq(isTaskDirective(warm, { priorAgentTurn: 'I can write that script for you.' }), true, JSON.stringify(warm) + ' after a stated offer is a task' + tag);
    A.eq(isTaskDirective(warm, { priorAgentTurn: 'Want me to draft it?' }), true, JSON.stringify(warm) + ' after a question offer is a task' + tag);
    A.eq(isTaskDirective(warm, { priorAgentTurn: 'Glad I could fix that for you.' }), false, JSON.stringify(warm) + ' after a result line stays chat' + tag);
    A.eq(isTaskDirective(warm), false, JSON.stringify(warm) + ' with no prior turn stays chat' + tag);
  }
  for (const closing of ['ok thanks', 'ok, thanks', 'okay thank you', 'thanks', 'great', 'no thanks', 'ok no', 'sure?', 'no']) {
    A.eq(isTaskDirective(closing, { priorAgentTurn: 'I can write that script for you.' }), false, JSON.stringify(closing) + ' after an offer is not a yes' + tag);
  }

  // RULE 4, nothing else moves: the answer without a prior agent turn is the text's own, whatever the affirmation lists say
  for (const [text, want] of [['yes', false], ['ok', false], ['yes thanks', false], ['ok great', false], ['ya', false], ['yes please', false], ['sounds good', false], ['search the web', true], ['ok, try it now', true]]) {
    A.eq(isTaskDirective(text), want, 'no prior turn, unchanged: ' + JSON.stringify(text) + tag);
    A.eq(isTaskDirective(text, { priorAgentTurn: '' }), want, 'an empty prior turn, unchanged: ' + JSON.stringify(text) + tag);
  }
}

// TIMING: a hostile prior agent turn cannot stall the send. Every pattern reads the 400-character tail only, so a 50 KB
// and a 1 MB turn cost the same pattern work. Best of 7 calls per shape (the best run is free of the machine's load).
{
  const { isTaskDirective, offeredWork } = require(path.join('..', ROOTS[0]));
  const fill = (unit, bytes) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);
  const SHAPES = ['i can ', 'i could set a b c d ', "i'll x if you ", 'happy to look a b c d ', 'as far as i can ', 'the only a b i could ', 'i could run it and the x y ', 'let me know if ',
    'just say the word. ', 'want me to ', 'what i can do a b is ', '? ', ', ; : - ', 'a. b! c? ', 'how about it, what do you think? ', "i can't i cannot i'm unable to ", '’', 'a', 'x\n', ' ',
    'write draft create build run make set it up save send ', "i can write, i could - how about it? i'll run. if you like; i can't! happy to, just say the word and i'll "];
  const ENDS = ['', ' i can write that for you.', ' what would you like?', '\njust say the word.'];
  let worst = 0, worstAt = '';
  for (const bytes of [50 * 1024, 1024 * 1024]) for (const unit of SHAPES) for (const end of ENDS) {
    const prior = 'x ' + fill(unit, bytes) + end;
    let best = Infinity;
    for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); isTaskDirective('yes', { priorAgentTurn: prior }); best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6); }
    if (best > worst) { worst = best; worstAt = JSON.stringify(unit) + ' x ' + bytes + ' B, end ' + JSON.stringify(end); }
  }
  A.ok(worst < 5, 'a hostile prior turn of 50 KB or 1 MB costs under 5 ms a call (worst ' + worst.toFixed(2) + ' ms: ' + worstAt + ')');
  // the patterns alone, on the 400-character tail each shape leaves: 500 calls per shape, under 0.2 ms a call
  let slow = 0, slowAt = '';
  for (const unit of SHAPES) {
    const tail = fill(unit, 400);
    const t0 = process.hrtime.bigint(); for (let i = 0; i < 500; i++) offeredWork(tail); const per = Number(process.hrtime.bigint() - t0) / 1e6 / 500;
    if (per > slow) { slow = per; slowAt = JSON.stringify(unit); }
  }
  A.ok(slow < 0.2, 'the offer patterns cost under 0.2 ms a call on a hostile 400-character tail (slowest ' + (slow * 1000).toFixed(0) + ' microseconds: ' + slowAt + ')');
}

// the two trees are the same file
{
  const fs = require('fs');
  A.ok(fs.readFileSync(path.join(__dirname, '..', ROOTS[0])).equals(fs.readFileSync(path.join(__dirname, '..', ROOTS[1]))), 'website mirror is byte-identical to frontend/app/classify.js');
}

A.report('classify-declared-offer.test');
