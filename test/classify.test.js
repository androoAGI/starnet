/* node test/classify.test.js — the TASK-vs-CHAT classifier that gates TOOL AVAILABILITY (the sidecar wires
   tools only when isTask). A missed task leaves the agent tool-less ("I can't reach the web"), so the bias is
   toward TASK and courtesy-wrapped missions MUST classify as tasks. (The visible desk trip is NOT gated here
   anymore — it's reactive, fired by a real tool call in chat.js — so a question handed unused tools simply
   never walks.) This table is the guardrail for the tool-delivery promise. */
'use strict';
const A = require('./_assert.js');
const { isTaskDirective, getTag, stanceFor } = require('../frontend/app/classify.js');

// every one of these is a real mission -> MUST be a task (so the agent is handed tools)
const TASKS = [
  'research the 2026 candle market and write candles.md',
  'Hey, can you research the candle market?',
  'thanks, now find the best budget keyboard',
  'good morning! please summarize the EU AI Act',
  'ok go fetch the latest news on AI',
  'nice, write a report on solar prices',
  'yo research bitcoin price',
  'cool can you look up the weather',
  'summarize the news',
  'find me a good pasta recipe and save it',
  'what are you waiting for? search for X',
  'download the spec and extract the API limits',
  'compare the top 3 GPUs and make a table',
  'build me a landing page',
  'investigate why sales dropped in Q2',
  // an ack-led RETRY / REDIRECT / new topic carries work: the ack word does not make it small talk (the agent was
  // handed zero tools and told the Commander a placed DISH gave it no web tool)
  'ok, try it now', 'cool, try now', 'no, use the dish', 'ok try again', 'ok, versuch es nochmal',
  'sure, latest news?', 'yes, bitcoin price today', 'perfect, now the weather', 'cool, do that'
];

// pure small-talk / questions about the agent / bare acknowledgements -> MUST be chat (no tools, quick reply)
const CHATS = [
  'hi', 'hey there', 'hello!', 'yo', 'how are you?', "how's it going",
  'who are you', 'what is your name', 'what are you', 'are you alive?',
  'thanks!', 'thank you', 'ty', 'nice', 'cool', 'good job', 'well done',
  'ok', 'okay', 'lol', 'nvm', 'bye', 'see ya',
  // broadened: self-questions with a trailing word, and plain acknowledgements / answers ("an answer to
  // something") — these are replies, not missions, so they stay tool-free and never trigger the desk trip
  'how are you today', 'how are you doing today?', 'what are you up to', 'are you busy', 'are you free',
  'yes', 'yeah', 'yep', 'nope', 'nah', 'sure', 'fine', 'correct',
  'sounds good', 'sound good', 'got it', 'will do', 'makes sense', 'perfect', 'exactly', 'agreed',
  'good idea', 'nice one',
  // the pleasantry tail stays chat: every trailing word is itself a pleasantry
  'ok thanks', 'thanks a lot', 'no thanks', 'no worries', 'sure thing', 'no problem', 'thanks for that',
  'thank you so much', 'yes please', 'hey there friend', 'good morning everyone',
  // two acks in a row are still an ack — the head words are tail words too (a task here dropped an INTAKE box on
  // the work-only belt for a closing "ok got it")
  'ok got it', 'ok sounds good', 'sure, sounds good', 'yep got it', 'ok will do', 'yes exactly', 'yes correct',
  'cool makes sense', 'ok makes sense thanks', 'ok np', 'ok thx', 'k thx', 'no worries at all', 'thanks, will do',
  'nice, well done', 'awesome job', 'great work', 'nice work', 'thanks, that worked', 'thanks, appreciate it',
  'bye for now', 'ok understood'
];

for (const t of TASKS) A.ok(isTaskDirective(t) === true, 'TASK: ' + JSON.stringify(t));
for (const c of CHATS) A.ok(isTaskDirective(c) === false, 'chat: ' + JSON.stringify(c));

// edge cases
A.ok(isTaskDirective('') === false, 'empty -> not a task');
A.ok(isTaskDirective('   ') === false, 'whitespace -> not a task');
A.ok(isTaskDirective('how are you, and can you research llamas?') === true, 'courtesy + intent -> task');

/* ---------- getTag — the FILTER content-router input (code | research | general) ---------- */
// code work -> 'code' (so a FILTER sorts it to the coder agent's bay)
const CODE = [
  'debug this python function',
  'fix the bug in app.js',
  'refactor the auth module',
  'write a regex for emails',
  'why does this throw an exception',
  'deploy the api to staging',
  'review my git commit',
  'the build is failing, check the stack trace'
];
// research work -> 'research' (sorts to the researcher agent's bay)
const RESEARCH = [
  'research the 2026 candle market',
  'look up the population of France',
  'find out who won the 2024 election',
  'gather sources on solar pricing',
  'search the latest AI news',
  'survey the competitor landscape',
  'fact-check this headline'
];
// neither signal -> 'general' (the filter's default / catch-all lane, never dropped)
const GENERAL = [
  'help me plan my day',
  'draft a thank-you note',
  'what should I have for lunch',
  'organize my schedule',
  ''
];
for (const t of CODE) A.eq(getTag(t), 'code', 'code: ' + JSON.stringify(t));
for (const t of RESEARCH) A.eq(getTag(t), 'research', 'research: ' + JSON.stringify(t));
for (const t of GENERAL) A.eq(getTag(t), 'general', 'general: ' + JSON.stringify(t));

// precedence + robustness
A.eq(getTag('research how to refactor this typescript module'), 'code', 'code intent wins over a research verb');
A.eq(getTag(null), 'general', 'null -> general (default lane, never throws)');
A.eq(getTag('   '), 'general', 'whitespace -> general');
A.eq(getTag('Build the API'), getTag('build the api'), 'case-insensitive + deterministic (replay-stable)');

/* ---------- stanceFor — the canonical task->stance mapping (+ regression guard) ----------
   stanceFor maps a turn's task-ness to its BASELINE stance. The live desk trip is now reactive (chat.js fires
   it on a real tool call), so stanceFor no longer drives the walk preemptively — but it stays locked as the
   contract and as a guard against the old regression: the speaker/voice toggle once leaked into the stance, so
   an on-speaker task was answered one-on-one. These assertions keep stanceFor reading NOTHING but isTask. */
A.eq(stanceFor(true), 'task', 'a TASK -> task stance (its baseline work pose)');
A.eq(stanceFor(false), 'talk', 'a non-task -> talk stance (face the Commander one-on-one)');
// structural guarantee: stanceFor reads NOTHING but isTask, so no voice/speaker/mic/UI state can ever turn a
// task into a one-on-one chat. Any extra argument is ignored — the desk trip cannot be suppressed.
A.eq(stanceFor(true, { voiceOn: true }), 'task', 'voice ON must NOT change a task (extra args ignored)');
A.eq(stanceFor(true, true, 'anything'), 'task', 'no other input can suppress a task’s desk trip');
A.eq(stanceFor(false, { voiceOn: true }), 'talk', 'voice ON must NOT promote a chat into a desk trip');
// every real mission classifies as a task (baseline stance 'task'); small talk maps to 'talk' — end-to-end
for (const t of TASKS) A.eq(stanceFor(isTaskDirective(t)), 'task', 'mission -> task stance: ' + JSON.stringify(t));
for (const c of CHATS) A.eq(stanceFor(isTaskDirective(c)), 'talk', 'small talk -> one-on-one: ' + JSON.stringify(c));

// "YES" TO AN OFFER IS A GO: a bare yes is still chat on its own, but accepts an agent's offer to act.
{
  const { isAffirmation, offeredWork } = require('../frontend/app/classify.js');
  for (const y of ['yes', 'Yes please', 'sure, go for it', 'ok do it', 'go ahead', 'do it', 'yep', 'sounds good', 'please do', 'yes!', 'absolutely'])
    A.ok(isAffirmation(y), 'a bare yes is an affirmation: ' + JSON.stringify(y));
  for (const y of ['yes', 'Yes please', 'sure', 'ok', 'yep', 'sounds good'])
    A.ok(!isTaskDirective(y), 'on its own it is still chat (the gap the offer check closes): ' + JSON.stringify(y));
  for (const n of ['thanks', 'no', 'nope', 'got it', 'hello', 'not now', 'yes but make it shorter and add the quarterly chart', ''])
    A.ok(!isAffirmation(n), 'not a bare yes: ' + JSON.stringify(n));
  for (const o of ['Here is the plan. Want me to draft it?', 'Shall I go ahead and send it?', 'Would you like me to create the file?', 'Should I proceed?', 'I can draft the email now — should I?'])
    A.ok(offeredWork(o), 'an offer to act: ' + JSON.stringify(o));
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'Want me to draft it?' }), true, 'isTaskDirective: "yes" answering an offer is a task');
  A.eq(isTaskDirective('yes', { priorAgentTurn: 'Anything else?' }), false, 'isTaskDirective: "yes" to a plain question stays chat');
  A.eq(isTaskDirective('thanks', { priorAgentTurn: 'Want me to draft it?' }), false, 'isTaskDirective: "thanks" is not a yes');
  A.eq(isTaskDirective('ok thanks', { priorAgentTurn: 'Would you like me to change anything?' }), false, 'isTaskDirective: "ok thanks" is an acknowledgement, not a go');
  A.eq(offeredWork('Happy to help with anything else?'), false, '"happy to help?" is not an offer to act');
  A.eq(isTaskDirective('yes'), false, 'isTaskDirective: no context = unchanged');
  for (const o of ['Done! Anything else?', 'I found 3 options:\n1. A\n2. B\nWhich do you prefer?', 'Here it is.', 'Should I have used tabs? Anyway, the file is saved.', '', null])
    A.ok(!offeredWork(o), 'not an offer to act: ' + JSON.stringify(o));
}

A.report('classify.test');
