/* node test/crew-call.test.js — CREW CALL: a request that names a crew member and asks for work closes the lead's
   prompt with who was asked for and the exact team.dispatch call (2026-10-11: a qwen3:8b lead asked "Have Ada …"
   did the work itself about half the time). Wiring is pinned against index.js's grant gate. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { crewMentions, crewCallNote } = require('../sidecar/crew-call.js');

const crew = new Map([
  ['chiefops', { name: 'Chief Operations Manager' }],
  ['researcher', { name: 'Ada' }],
  ['writer', { name: 'Quill' }],
  ['ada-aux', { name: 'Ada-Aux' }],
  ['night-shift', { name: 'Night Shift' }],
  ['james', { name: 'James' }],
  ['agent', { name: 'NOVA' }]
]);
const ids = (t) => crewMentions(t, crew, 'chiefops').map(m => m.agentId);

A.eq(ids('Have Ada research three facts about JWST and report back.'), ['researcher'], 'a display name + "have" is a crew call');
A.eq(ids('Ask the researcher to check the numbers'), ['researcher'], 'an agentId used as a noun + "ask" is a crew call');
A.eq(ids('Ada, find me three sources on this.'), ['researcher'], '"Name, …" up front addresses the agent without a verb');
A.eq(ids('get ada and quill on the launch post'), ['researcher', 'writer'], 'case-insensitive, several members at once');
A.eq(ids('What did Ada Lovelace invent?'), [], 'a name in a question that asks for no work is not a crew call');
A.eq(ids('Have an agent look at this'), [], 'the generic id "agent" never counts as naming NOVA');
A.eq(ids('Tell NOVA to summarize the inbox'), ['agent'], 'the hero is still reachable by its NAME');
A.eq(ids('Have the Chief Operations Manager plan it'), [], 'the lead never delegates to itself');
A.eq(ids('Have Adam research it'), [], 'whole words only: Adam is not Ada');
A.eq(crewCallNote('', crew, 'chiefops'), '', 'empty request -> no note');
for (const text of ['Do not ask Ada. Answer yourself.', "Don't delegate this to Ada.", "Summarize Ada's report and use bullets.", 'If needed, ask Ada for help.', 'The note says: have Ada research the topic.', 'Have Ada review it. Actually, do not delegate this.'])
  A.eq(crewCallNote(text, crew, 'chiefops'), '', 'no invented delegation directive: ' + text);

for (const text of [
  "Use Ada's report to write the summary.", 'Use Ada’s report to write the summary.',
  "Have Ada's report ready by Monday.", 'Have Ada’s report ready by Monday.',
  "Use the researcher's report.", 'Ask the researcher’s assistant.',
  "Use Ada's and Quill's reports.", 'Use Ada’s and Quill’s reports.',
  "Have Ada and Quill's report ready.", 'Have Ada and Quill’s report ready.',
  "Use Ada, Quill's notes.", 'Use Ada & Quill’s notes.',
  "Have James' report ready.", 'Have James’ report ready.',
  "Use Night Shift's report.", 'Use night-shift’s report.',
  "Use Ada-Aux's draft.", 'Use Ada-Aux’s draft.',
  'Have Ada-Lovelace review it.',
  'Have Ada and Unknown review it.', 'Have Ada AND Unknown review it.',
  'Have Ada And Quill-Lovelace review it.',
  'Ada: no delegation; answer yourself.', 'Ask Ada? No, answer yourself.',
  'Have Ada review it. Cancel that; answer yourself.', 'Have Ada review it. No need to delegate.'
]) A.eq(crewCallNote(text, crew, 'chiefops'), '', 'no invented delegation for a target reference or reversal: ' + text);
for (const [text, expected] of [
  ["Have Ada review Quill's report.", ['researcher']],
  ['Ada, review Quill’s report.', ['researcher']],
  ['Use Ada as the reviewer.', ['researcher']],
  ['Have Ada and Quill review it.', ['researcher', 'writer']],
  ['Have Ada AND Quill review it.', ['researcher', 'writer']],
  ['Have Ada-Aux review the plan.', ['ada-aux']],
  ['Have Ada and Ada-Aux review the plan.', ['researcher', 'ada-aux']],
  ['Ask the night-shift to review it.', ['night-shift']]
]) A.eq(ids(text), expected, 'only the exact affirmative targets receive the directive: ' + text);
// an ordinary task word ("if", "without"), a reassurance ("no rush") or a polite opener is still an ordinary delegation
// (10-11: 0/4 -> 4/4 needs the note; review 2026-10-12: the lane's whole-message veto on "if"/"no" and its start-of-message
// anchor had undone it)
for (const text of [
  'Have Ada check if the tests pass', 'Have Ada write the report, no rush', 'Have Ada see if the API works',
  'Have Ada write it without jargon', "Have Ada draft it, I'll review it after.",
  'Can you have Ada research three facts about JWST?', 'Could you ask Ada to research three facts about JWST',
  'Could you get Ada to look into this?', 'Hey, ask Ada to summarize the paper', 'I want you to have Ada draft the summary'
]) A.eq(ids(text), ['researcher'], 'an ordinary delegation request still gets the note: ' + text);
// FAIL CLOSED: a negation, hedge or quote ANYWHERE vetoes the directive, even one that only qualifies the task. A missed
// note leaves the lead to decide (it can still dispatch); a wrong one tells it to delegate against the Commander's wish —
// and no word list tells "not Hubble" from "actually, not her" reliably (two review rounds tried and opened new holes).
for (const text of [
  'Have Ada research JWST, not Hubble', 'Have Ada find out whether the API is down or not', 'Ask Ada to compare "React" and "Vue"',
  'Please have Ada run `npm test`', "Have Ada research JWST. Don't use tables.", "Have Ada research it, don't do it yourself",
  'Have Ada check if the API is down or not', "Have Ada draft the email to Bob. Don't tell him about the price.",
  'Have Ada review the PRs that are not yet merged', 'Have Ada research JWST, no need for citations'
]) A.eq(crewCallNote(text, crew, 'chiefops'), '', 'fail closed: a negation or quote anywhere adds no directive: ' + text);
// …while a qualifier on the DELEGATION itself, anywhere in the message, still vetoes it
for (const text of [
  'Ask Ada for help if needed.', 'Have Ada review it unless you already know.', 'Maybe ask Ada.',
  'Have Ada review it. Actually, no.', "Have Quill draft it. Don't ask Ada.", 'Have Ada review it, never mind.',
  'Have Ada research it," he said.', 'Should I ask Ada?', 'Did you ask Ada?', "Have Ada review it. Actually, I'll do it myself.",
  'Answer without asking Ada.', 'Have Ada review it, or just do it yourself.', 'Have Ada review it. Scratch that.'
]) A.eq(crewCallNote(text, crew, 'chiefops'), '', 'a negated, conditional or quoted delegation adds no directive: ' + text);
// a retraction ANYWHERE after the ask still vetoes it: a negation with nothing after it points back at the request
for (const text of [
  "Have Ada review it, actually don't", 'Have Ada review it. Actually, no need.', "Have Ada review it. No wait, I'll do it.",
  "Have Ada review it — actually don't.", "Have Ada review it. On second thought, don't.", 'Have Ada review it. Hmm, no.',
  "Have Ada review it. Don't bother.", 'Have Ada review it -- no.', 'Have Ada not do it', 'Have Ada review it, or not.',
  'Have Ada not review it', 'Have Ada review it, scratch that', "Have Ada review it. Actually, I'll do it.", 'Have Ada review it. Nah.',
  'Have Ada review it. Changed my mind.', 'Have Quill draft it, not Ada.', 'Have Ada review it. Not needed.', 'Have Ada review it. No need to ask her.'
]) A.eq(crewCallNote(text, crew, 'chiefops'), '', 'a retraction after the delegation adds no directive: ' + text);
// the reviewer's wider retraction set (2026-10-12): every one of these is vetoed by the same fail-closed rule
for (const tail of [
  "You don't need Ada.", 'No need for Ada.', "I don't want Ada on this.", "Actually, we don't need Ada for this.", 'No need for that.',
  "Actually don't do that.", "Don't make her do it.", "Actually, don't loop her in.", 'Not today.', 'Not needed after all.',
  'Actually, not her.', "Actually, Ada doesn't need to do that.", "Don't have her review it.", "I won't need her.", 'No need for her.',
  "Actually, don't worry about it.", "I don't need her help.", "Don't send it to her."
]) A.eq(crewCallNote('Have Ada review it. ' + tail, crew, 'chiefops'), '', 'a later retraction adds no directive: ' + tail);
// linear: the veto never backtracks over long unpunctuated text (round two's lookbehind took 30 s on this)
{
  const t0 = process.hrtime.bigint();
  crewMentions('Have Ada review this ' + 'x or no y '.repeat(50000), crew, 'chiefops');
  crewMentions('Have Ada review ' + 'word '.repeat(100000), crew, 'chiefops');
  A.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'a 500 KB request is classified in well under a second');
}

const note = crewCallNote('Have Ada research three facts about JWST', crew, 'chiefops');
A.ok(/^\n\n\[CREW CALL\] The Commander named Ada \(agentId researcher\)/.test(note), 'the note names the member and its agentId');
A.ok(/team\.dispatch, workers:\[\{agentId:"researcher"/.test(note), 'the note spells out the exact call');
A.ok(/only if the dispatch is refused/.test(note), 'advisory: the lead may still answer if the dispatch fails');

// unnamed delegation gets nothing: measured to change nothing on a small model (see crew-call.js)
A.eq(crewCallNote('Delegate this to the other agents: find three facts about JWST', crew, 'chiefops'), '', 'an unnamed "delegate this" adds no prompt text');

/* INTO THIS CHAT (rc walk 10-14): a named ask that says WHERE the crew should be is a seat, never a dispatch. "get ROOK in
   here" used to close the prompt with "Hand that part to them with team.dispatch" — a background worker in its own thread. */
{
  const both = { dispatch: true, seat: true };
  for (const [text, want] of [
    ['get Ada in here', ['researcher']], ['Bring Ada and Quill into this chat to help me write the launch post', ['researcher', 'writer']],
    ['add Quill to this chat', ['writer']], ['Can you get Ada in here to help?', ['researcher']], ['invite Ada to join us', ['researcher']],
    ['have Quill join the conversation', ['writer']]
  ]) {
    const seat = crewCallNote(text, crew, 'chiefops', both);
    A.ok(/^\n\n\[CREW CALL\] The Commander wants .* IN THIS CHAT with them\. Seat them with station\.control \{"action": "group\.add", "args": \{"agents": \[/.test(seat), 'a seat ask names group.add: ' + text + ' -> ' + seat);
    A.eq(JSON.parse(seat.match(/"agents": (\[[^\]]*\])/)[1]), want, 'and exactly who was asked for: ' + text);
    A.ok(!/team\.dispatch, workers|Hand that part/.test(seat) && /team\.dispatch never puts anyone in this chat/.test(seat), 'never a dispatch directive: ' + text);
    A.eq(crewCallNote(text, crew, 'chiefops', { dispatch: true, seat: false }), '', 'fail closed: without station.control a seat ask gets NO note (never the dispatch one): ' + text);
    A.eq(crewCallNote(text, crew, 'chiefops'), '', 'and the legacy two-argument call never turns a seat ask into a dispatch: ' + text);
  }
  for (const text of ["Don't bring Ada in here", 'Maybe get Ada in here', 'no, get Ada in here later'])
    A.eq(crewCallNote(text, crew, 'chiefops', both), '', 'the same veto holds for a seat: ' + text);
  A.eq(crewCallNote('bring two crew in here', crew, 'chiefops', both), '', 'an unnamed seat ask adds no note (the briefing and tool descriptions carry it)');
  /* WHERE THE RESULT LANDS IS NOT A SEAT (review 10-14): the where-clause counts only when it is the named target's OWN
     verb phrase ("get Ada in here"). An ordinary hand-off that says where the RESULT should go still gets the measured
     dispatch note (0/4 -> 4/4 on qwen3:8b) — a seat note there would turn a delegation into a chat conversion. */
  for (const text of [
    'Have Ada research JWST and post the results in this chat', 'Have Ada summarize the report in this chat',
    'Get Quill to write the launch post and paste it in here', 'have Quill draft the tagline in this conversation',
    'Let Ada handle the research in the thread', 'Ask Ada to research JWST and reply in this thread',
    'Have Ada join the two tables and post the summary', 'get Ada to bring the numbers in here'
  ]) {
    const n = crewCallNote(text, crew, 'chiefops', both);
    A.ok(/team\.dispatch, workers:\[\{agentId:"(?:researcher|writer)"/.test(n) && !/IN THIS CHAT|group\.add/.test(n), 'a result that lands here is still a dispatch: ' + text + ' -> ' + n.slice(0, 80));
  }
  // and a bare "the thread" is never here: a worker's own thread is "the thread"
  A.eq(crewCallNote('get Ada in the thread', crew, 'chiefops', both).indexOf('IN THIS CHAT'), -1, 'bare "the thread" is not a seat');
  // a seat ask with a filler word before WHERE still seats ("bring Ada in to this chat", "get Ada over here too")
  for (const text of ['bring Ada in to this chat', 'get Ada over here', 'bring Ada and Quill in here too', 'add Ada into the chat'])
    A.ok(/IN THIS CHAT/.test(crewCallNote(text, crew, 'chiefops', both)), 'a seat with a filler word: ' + text);
  // a seat ask that goes on after WHERE is still a seat (live 10-14, Haiku: "get FORGE in here, I want to talk through the
  // release checklist with both of you" got the DISPATCH note — the list-continuation check read the comma after "here")
  for (const [text, want] of [['get Ada in here, I want to talk it through with both of you', ['researcher']],
    ['bring Ada and Quill into this chat, and let us plan the launch', ['researcher', 'writer']], ['add Quill to this chat & start drafting', ['writer']]]) {
    const n = crewCallNote(text, crew, 'chiefops', both);
    A.ok(/IN THIS CHAT/.test(n) && !/Hand that part/.test(n), 'a seat that goes on after WHERE: ' + text + ' -> ' + n.slice(0, 70));
    A.eq(JSON.parse(n.match(/"agents": (\[[^\]]*\])/)[1]), want, 'and seats exactly who was named: ' + text);
  }
  const t0 = process.hrtime.bigint();
  crewMentions('bring Ada ' + 'in '.repeat(100000), crew, 'chiefops', 'seat');
  crewMentions('bring Ada and Quill and '.repeat(20000) + 'here', crew, 'chiefops', 'seat');
  A.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, 'the seat parse stays linear on a long request');
  A.ok(/team\.dispatch, workers:\[\{agentId:"researcher"/.test(crewCallNote('Have Ada research three facts about JWST', crew, 'chiefops', both)), 'a delegation with no WHERE still gets the dispatch note');
  A.eq(crewCallNote('Have Ada research three facts about JWST', crew, 'chiefops', { dispatch: false, seat: true }), '', 'and needs team.dispatch granted');
}

// wiring: composed only behind the run's own grants (team.dispatch for a dispatch, station.control for a seat), placed after
// the cached prefix (request-specific).
const idx = readSidecarSource();
A.ok(/const crewCallTools = resolved && Array\.isArray\(resolved\.tools\) \? \{ dispatch: resolved\.tools\.includes\('team\.dispatch'\), seat: resolved\.tools\.includes\('station\.control'\) \} : null;\s*if \(commanderWords && !internal && isTask && crewCallTools && \(crewCallTools\.dispatch \|\| crewCallTools\.seat\)\) \{\s*try \{ crewCallNote = CrewCall\.crewCallNote\(latestUserText\(messages\), agentRoster, agentId, crewCallTools\);/.test(idx), 'composed only for owner provenance and a task holding the tool its note names');
A.ok(/\+ deliverableNote \+ crewCallNote \+ runtimeBlock/.test(idx), 'rides the request-specific tail of the prompt, never the cached prefix');

A.report('crew-call.test');
