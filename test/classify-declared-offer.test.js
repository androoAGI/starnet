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
/* KNOWN RESIDUALS (T9s must-fix, 2026-11-16), pinned ON PURPOSE so a later change shows up. Not a claim that the answer is
   right. Each of these is a KNOWN cheap error: an offer phrase, an offer verb (or an action word) after it, and nothing the rule
   reads says it is a report, so an "ok" after it is a task and the run carries a tool set it does not need. */
const KNOWN_TASK_PAST_COULD = ['I could run the tests and they all pass now.', 'I could build it locally and it works.', 'I could find the bug in the parser.', 'I could fix the build yesterday.'];   // a past "I could <verb>" success report
const KNOWN_TASK_NOW_I_CAN = ['Now I can run the full suite without errors.', 'Now I can open the dashboard again.', 'I can now open the dashboard without errors.'];   // a "Now I can <verb>" line
const KNOWN_TASK_ASSURANCE = ['I can assure you the script will run.', 'I can guarantee the script runs on Windows.', 'I can vouch that the fix is saved.'];   // an assurance verb, an action word after it
const KNOWN_TASK_ALL_I_CAN = ['All I can do is describe the steps to run it.', 'All I could do was explain how to fix it.', 'All I can do here is draft the email.'];   // "All I can do is ..."
// ... and the KNOWN miss the other way (A3-F2's open end): a stated offer whose verb no list holds (ACTIONABLE, OFFER_WORK,
// OFFER_ACTION), with no action word after it, is no offer, so "yes please" stays chat and the run gets zero tools. Widen the
// verb lists only together with a guard against past-tense reports.
const KNOWN_CHAT_UNLISTED_VERB = ['I can restart the server for you.', 'I can merge the two branches for you.', 'I can upload the files to the shared drive.', 'I can commit and push the change.',
  'I can refactor that function for you.', 'I can prepare the release notes for you.', 'Happy to put together a summary of the thread.', 'I can go ahead and clean up the old branches.',
  'Not a problem, I can rerun the tests for you.', "If you don't mind waiting a minute I can rebuild it."];
// ... and the hedge and condition rules' own KNOWN trade-offs: a real offer they read as none.
const KNOWN_CHAT_TRADE_OFF = [
  'I need your approval before I can deploy it.', "I'll need your confirmation before I can delete those 40 files.",   // an approval gate in any order: "before I can" is cut
  'Let me know whether I can go ahead and deploy it.',   // "whether" right before the offer phrase is a hedge
  "I can run the migration now, though I don't think it'll need any downtime.", "Although I don't think it's the cause, I can check the logs for you.",   // though/although + "I don't think" reads as taken back
  "Don't worry I can fix that.", "It doesn't need a restart because I can apply the config live.",   // a hedge word with no comma, joining word or opening condition before the offer
  'Ready to send it whenever you are, just say the word or let me know if you need anything else first.',   // "anything else" voids the open invitation's sentence
  'I can delete all build.* files for you.',   // the * _ ~ strip reads a bare ".*" before a space as a sentence end
  'Before I can deploy it, I need your approval.',      // "before I can" is a condition: chat again, as at BASE
  'I am not busy so I can run the full suite now.'      // "not ... so I can" with no comma before "so" reads as hedged ("I am not busy, so I can ..." is an offer)
];
// ... the A3-F1 residual the T9s review found beyond the four kinds above (KNOWN cheap errors): an offer phrase and its verb, then an
// obstacle or a limit the rules do not read, a hedge word OFFER_HEDGED lacks, or a sign-off other than "anything else"
const KNOWN_TASK_OBSTACLE = ["Technically I could delete the branch, but I'd rather not.", 'Normally I could run that for you, but the sandbox is offline today.',
  'I could deploy it, except the runner has been down since this morning.', "It's unlikely I can open that file without the right codec.",
  'Glad I could fix that for you - just say the word if you need anything!'];
// ... and the A3-F2 miss of OFFER_NEGATED, which vetoes the whole sentence: the alternative offered after "I can't" is never read
const KNOWN_CHAT_NEGATED_ALTERNATIVE = ["I can't push to main, but I can open a PR instead."];
const ACKS = ['ok', 'yes', 'sounds good'];

/* ---- T9s MUST-FIX: A HEDGE IS NO OFFER (2026-11-16) ----
   Red at d0d85ac23 (the T9s lane as merged, 395c61d60): the rule read only what FOLLOWS the offer phrase, so the commonest way
   an agent says no ("I don't think I can open that drive from here.") still read as an offer, and so did a refusal with one word
   in *italics*, a result line signed off "just say the word if you need anything else", "I'd need the API key before I can run
   it." and an offer taken back with "though" or "however". A bare "ok" after any of them ran with the whole tool set (on the real
   sidecar about 56 KB a request instead of about 2.3 KB, and a promise in the model's answer ended the run red: work incomplete).
   The rule under test: a hedge or a negation before the offer phrase, in its own clause, takes the offer back (a clause that opens
   with if / since / when / once / unless / because / after / "as soon as" negates its condition, not the offer); * _ ~ marks are
   not words; though / although / however take an offer back as "but" does, and so does "I'd advise against it"; an invitation
   that names no work of its own ("anything else") offers nothing; "before / until / unless / once / now that / so that I can" is
   a condition or a purpose. The rows are the decider's must-fix list (review-fix decide-T9s). */
// EVERY offer verb of classify.js: its ACTIONABLE, OFFER_WORK and OFFER_ACTION alternatives, as the file writes them. The module
// does not export them, so they are copied here, and the tree loop checks the copy against the file's own source: a verb added
// there fails this test until it has its rows here.
const OFFER_VERB_LISTS = {
  ACTIONABLE: ['research', 'search', 'google', 'find', 'look ?up', 'fetch', 'scrape', 'crawl', 'download', 'browse', 'visit', 'go to', 'read', 'open', 'write', 'save', 'create', 'generate', 'build',
    'make', 'draft', 'compile', 'summari[sz]e', 'report', 'list', 'extract', 'analy[sz]e', 'investigate', 'compare', 'check', 'calculate', 'translate', 'plan', 'schedule', 'email', 'post', 'send'],
  OFFER_WORK: ['delete', 'deploy', 'test', 'add', 'rename', 'pull', 'look in ?to', 'dig in ?to', "(?:set|look) (?:[\\w'-]+ ){1,4}up"],
  OFFER_ACTION: ['write', 'draft', 'create', 'build', 'run', 'make', 'set (?:it |this |that )?up', 'save', 'send', 'generate', 'fix', 'update', 'implement', 'execute', 'install', 'start', 'apply',
    'code', 'script', 'do (?:it|that|this)']
};
// each alternative as an agent says it, [with an object, alone]: a plain verb takes "that", a pattern every spelling it reads
const VERB_SPELLINGS = {
  'look ?up': [['look up that', 'look up'], ['lookup that', 'lookup']],
  'summari[sz]e': [['summarize that', 'summarize'], ['summarise that', 'summarise']],
  'analy[sz]e': [['analyze that', 'analyze'], ['analyse that', 'analyse']],
  'look in ?to': [['look into that', 'look into'], ['look in to that', 'look in to']],
  'dig in ?to': [['dig into that', 'dig into'], ['dig in to that', 'dig in to']],
  "(?:set|look) (?:[\\w'-]+ ){1,4}up": [['set the nightly backup up', 'set up'], ['look the latest numbers up', 'look up']],
  'set (?:it |this |that )?up': [['set that up', 'set up'], ['set it up', 'set up']],
  'do (?:it|that|this)': [['do that', 'do'], ['do it', 'do']]
};
const OFFER_VERBS = [];
for (const alt of [].concat(...Object.values(OFFER_VERB_LISTS))) for (const said of VERB_SPELLINGS[alt] || [[alt + ' that', alt]]) if (!OFFER_VERBS.some(v => v[0] === said[0])) OFFER_VERBS.push(said);
// every frame once with every verb, each sentence once
const framed = (frames) => [...new Set([].concat(...frames.map(frame => OFFER_VERBS.map(frame))))];
// the must-fix list's five hedge frames, the first and the third also with a typographic apostrophe
const HEDGED = framed([
  v => "I don't think I can " + v[0] + ' for you.',
  v => 'I don' + Q + 't think I can ' + v[0] + ' for you.',
  v => "I'm not sure I can " + v[0] + ' for you.',
  v => "That's not something I can " + v[1] + ' for you.',
  v => 'That' + Q + 's not something I can ' + v[1] + ' for you.',
  v => "There's no way I can " + v[0] + ' for you.',
  v => 'I doubt I can ' + v[0] + ' for you.'
]).concat([   // ... and the decider's own natural hedges
  "I don't think I can open that drive from here.", "I'm not sure I can send email from this station.", "I'm not certain I could run that script safely.",
  'I really doubt I can fix that without the original files.', "That's not something I can install for you, unfortunately.", "There's no way I could build that before the deadline.",
  "Honestly, I don't believe I can deploy that from this machine.", "I'm not convinced I can write a script that handles every edge case.", "That's not a page I can open from this sandbox.",
  "It's not something I could run without admin rights.", "I don't know whether I can download files that large.", "I'm unsure whether I could update the firmware remotely.",
  "I'm not so sure I can fix that one.", "Unfortunately I don't think I could search that site, it blocks automated access.", "I'm afraid it's not a file I can read in this chat.",
  "I don't see how I could test that without a staging server.", "I'm not 100% sure I can build it on Windows.", "That isn't something I could schedule from here.",
  "Honestly? I don't think I can open that drive from here.", "Run it on prod? That's not something I can do from here.", "Not sure\u2026 I don't think I can write to that folder.",
  "Can I fix it? I'm not sure I can fix that from here.", 'Whether I can fix it depends on the logs.', 'I wonder whether I can run it from here.',
  'I *really* wish I could run that for you.', "I don't think I can **fix** that from here."
]);
// its condition frame, "I'd need X before I can", also with "could"
const CONDITIONED = framed([
  v => "I'd need the API key before I can " + v[0] + ' for you.',
  v => 'I would need admin rights before I could ' + v[0] + ' for you.'
]).concat([   // ... and the decider's own status lines with a condition or a purpose
  "I'd need the API key before I can run it.", 'I would need admin rights before I could install it.', 'It took a while before I could fix the build.', 'I restarted the service so that I can build again.', 'Before I could run it, the server timed out.', 'Now that I can run the build, the tests pass.'
]);
// an offer taken back in its own sentence: "though I don't think", "but honestly I don't think", "however I'd advise against it"
const WITHDRAWN = framed([
  v => 'I could ' + v[0] + ", though I don't think it is worth it.",
  v => 'I could ' + v[0] + ", but honestly I don't think it is worth it.",
  v => 'I could ' + v[0] + ", however I'd advise against it."
]).concat([   // ... and each other spelling the rule reads, once
  "I could run it, although I don't think it is safe.", "I could run it, but I really don't think it is safe.", "I could run it, but frankly, I wouldn't recommend it.",
  'I could deploy it now, though I would advise against it.', "I could delete those files, however I'd recommend against it.", "I could run it, however, I don't think it is wise.",
  'I could write that script for you, though I don' + Q + 't think that is wise.'
]);
// the confirmed A3-F1 rows (the attacker's refusals and status lines, the skeptic's results and refusals) with ONE word in
// *italics*, **bold** or _underscores_ (each word in turn, each mark), and each with "just say the word if you need anything else"
const A3_F1_ROWS = [...new Set(REFUSALS.concat(STATUS_LINES, SKEPTIC_RESULTS, SKEPTIC_REFUSALS))];
const MARKS = [w => '*' + w + '*', w => '**' + w + '**', w => '_' + w + '_'];
function marked(row) {
  const words = row.split(' '), out = [];
  words.forEach((token, i) => {
    const m = /^([^A-Za-z0-9]*)(\S*[A-Za-z0-9])([^A-Za-z0-9]*)$/.exec(token);   // the word, without the punctuation around it
    if (m) for (const mark of MARKS) out.push(words.slice(0, i).concat(m[1] + mark(m[2]) + m[3], words.slice(i + 1)).join(' '));
  });
  return out;
}
const EMPHASISED = [].concat(...A3_F1_ROWS.map(marked));
const SIGNED_OFF = A3_F1_ROWS.map(row => row.replace(/([.!]?)$/, (end) => ', just say the word if you need anything else' + (end || '.'))).concat([   // ... and the decider's own
  'Glad I could fix that for you - just say the word if you need anything else!', 'All done, the report is saved; just say the word if you need anything else.',
  'The fix is live. Just say the word if you need anything else.', 'Updated the docs as well, so just say the word if anything else comes up.'
]);
// the offers beside them stay offers: a hedge word inside a condition, "no problem", a hedge before a comma or a joining word,
// and a condition before a real offer. The must-fix list's five first, then the decider's own.
const HEDGE_OFFER_CONTROLS = [
  "If you haven't sent it yet, I can draft a reply.", 'No problem I can update the config for you.', 'Not sure if this helps, but I can write a quick script for it.',
  "If it's not urgent I can schedule it for tonight.", "Since the tests didn't run I can run them again now.",
  "If you haven't sent it yet I can draft a reply.", "Since the tests didn't run, I can run them again now.", "It didn't save, but I can write it to a new file.",
  "There's no need to wait - I can run it right now.", 'I am not busy, so I can run the full suite now.', 'No problem, I can update the config for you.',
  "If you don't mind, I can restart the build now.", "If you'd rather not do it by hand, I can write a script for it.", "Don't worry, I can fix that.",
  "There's no rush, but I can start on the draft now.", 'No need to do it by hand, I can generate the report.', "It's no trouble, I can write it now.", "It's no trouble I can write it now.",
  "Nothing's been sent yet, so I can still update the wording.", "If that doesn't work, I can write a fallback script.", "If that doesn't work I can write a fallback script.",
  'Whether or not it passes, I can send you the full log.', "When you're not around I can run the backups for you.",
  'Once I can reach the server I can deploy it.', 'Until I can reproduce it, I can add more logging to the script.', 'Now that I can access the repo, I can fix the bug for you.',
  "I'll set up a test database so that I can run the full suite, if you like.", 'I can fix it now so that you can test it tonight.', 'Once you approve, I can deploy it.',
  "Didn't get the email? I can send it again.", 'Not what you wanted? I can write a new version.', 'Still not loading? I can check the server logs for you.',
  "That didn't work\u2026 I can run it again with verbose logging.", "Let me know whether you'd like me to run the migration.", 'Tell me whether you want me to delete the old drafts.',
  'As soon as the build finishes I can run the tests.', 'I can deploy it as soon as you approve.'
];

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
  // the KNOWN residuals of the T9s must-fix, pinned on purpose (see the tables): a later change to any of them shows up here
  for (const [kind, rows] of [['a past "I could <verb>" report', KNOWN_TASK_PAST_COULD], ['a "Now I can <verb>" line', KNOWN_TASK_NOW_I_CAN], ['an assurance verb', KNOWN_TASK_ASSURANCE], ['"All I can do is ..."', KNOWN_TASK_ALL_I_CAN]]) {
    for (const prior of rows) A.eq(isTaskDirective('ok', { priorAgentTurn: prior }), true, 'known cheap error, ' + kind + ' reads as an offer: ' + prior + tag);
  }
  for (const prior of KNOWN_CHAT_UNLISTED_VERB) {
    A.eq(offeredWork(prior), false, 'known miss, a verb no list holds is not read as an offer: ' + prior + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: prior }), false, 'known miss, "yes please" after it stays chat: ' + prior + tag);
  }
  for (const prior of KNOWN_CHAT_TRADE_OFF) for (const reply of ['ok', 'yes please']) {
    A.eq(isTaskDirective(reply, { priorAgentTurn: prior }), false, 'known trade-off of the hedge and condition rules, ' + JSON.stringify(reply) + ' after an offer they read as none stays chat: ' + prior + tag);
  }
  for (const prior of KNOWN_TASK_OBSTACLE) A.eq(isTaskDirective('ok', { priorAgentTurn: prior }), true, 'known cheap error, an obstacle or limit after the offer is not read: ' + prior + tag);
  for (const prior of KNOWN_CHAT_NEGATED_ALTERNATIVE) {
    A.eq(offeredWork(prior), false, 'known miss, the alternative after "I can\'t" is not read: ' + prior + tag);
    A.eq(isTaskDirective('yes please', { priorAgentTurn: prior }), false, 'known miss, "yes please" after it stays chat: ' + prior + tag);
  }

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

  // ---- T9s MUST-FIX: a hedge, a condition, a marked word, a sign-off and a withdrawal offer nothing ----
  // the verbs the rows use are the module's own lists (copied above, checked here against this tree's source)
  {
    const src = require('fs').readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const listIn = (re) => {   // the pattern's top-level alternatives
      const m = re.exec(src); if (!m) return null;
      const out = []; let depth = 0, cur = '';
      for (const ch of m[1]) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === '|' && !depth) { out.push(cur); cur = ''; } else cur += ch; }
      return out.concat(cur);
    };
    A.eq(listIn(/const ACTIONABLE = \/\\b\(([^)]*)\)\\b/), OFFER_VERB_LISTS.ACTIONABLE, 'the ACTIONABLE verbs of the must-fix rows are classify.js\'s own' + tag);
    A.eq(listIn(/const OFFER_WORK = \/\^\(\?:(.*)\)\\b\/;/), OFFER_VERB_LISTS.OFFER_WORK, 'the OFFER_WORK verbs of the must-fix rows are classify.js\'s own' + tag);
    A.eq(listIn(/const OFFER_ACTION = \/\\b\((.*)\)\\b\/;/), OFFER_VERB_LISTS.OFFER_ACTION, 'the OFFER_ACTION verbs of the must-fix rows are classify.js\'s own' + tag);
  }
  // an "ok", "yes" or "sounds good" after each stays chat
  for (const [kind, rows] of [['a hedge before the offer phrase', HEDGED], ['a condition ("before I can")', CONDITIONED], ['a refusal or result line with one word marked', EMPHASISED],
    ['a refusal or result line with a sign-off', SIGNED_OFF], ['an offer taken back', WITHDRAWN]]) {
    for (const prior of rows) {
      A.eq(offeredWork(prior), false, kind + ' is not an offer: ' + JSON.stringify(prior) + tag);
      for (const ack of ACKS) A.eq(isTaskDirective(ack, { priorAgentTurn: prior }), false, JSON.stringify(ack) + ' after ' + kind + ' stays chat: ' + JSON.stringify(prior) + tag);
    }
  }
  // the offers beside them stay offers
  for (const prior of HEDGE_OFFER_CONTROLS) {
    A.eq(offeredWork(prior), true, 'still an offer: ' + JSON.stringify(prior) + tag);
    for (const reply of ['yes please', 'ok', 'yes', 'sounds good']) A.eq(isTaskDirective(reply, { priorAgentTurn: prior }), true, JSON.stringify(reply) + ' after it is a task: ' + JSON.stringify(prior) + tag);
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
