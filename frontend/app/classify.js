/* STARNET — classify.js : is the Commander assigning a TASK (go act, with real tools) or just TALKING?
   Pure + testable (UMD: a `Classify` global in the browser, module.exports under node).

   isTaskDirective gates ONE thing now: TOOL AVAILABILITY (the sidecar wires tools only when isTask). It no
   longer forces the agent to run to its workstation — that desk trip is REACTIVE, fired by a real tool call
   (see chat.js walkToDesk). So the bias stays deliberately toward TASK: a missed task would hand the agent
   ZERO tools ("I can't reach the web / files"), whereas a missed chat only offers unused tools that the
   reactive walk keeps invisible until something is actually used. Explicit actionable intent ALWAYS wins,
   even wrapped in courtesy ("hey, could you research…", "thanks, now find…"); pleasantries, simple
   acknowledgements, and questions about the agent itself stay casual (no tools, no work framing). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Classify = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // a verb the agent can carry out (or a filename) -> TASK, regardless of any courtesy wrapper
  const ACTIONABLE = /\b(research|search|google|find|look ?up|fetch|scrape|crawl|download|browse|visit|go to|read|open|write|save|create|generate|build|make|draft|compile|summari[sz]e|report|list|extract|analy[sz]e|investigate|compare|check|calculate|translate|plan|schedule|email|post|send)\b|\.(md|txt|js|ts|py|csv|json|html?|pdf)\b/;
  // pure pleasantries / acknowledgements / short answers — a greeting or ack word, optionally trailed by a
  // few tokens that are THEMSELVES pleasantries ("hey there", "thanks a lot", "sounds good", "good morning friend")
  // over the WHOLE message -> CHAT. (ACTIONABLE is tested first, so a greeting that carries a real instruction —
  // "sure, send it" — never reaches here.) Acks like "yes / got it / sounds good" are answers, not missions.
  // Any other trailing word carries work and falls through to TASK: a retry ("ok, try it now"), a redirect
  // ("no, use the dish") or a new topic ("yes, bitcoin price today") was chat while the tail took ANY three words,
  // so the run got zero tools and the agent told the Commander it had no web tool with a DISH placed.
  // ACK is shared by the head AND the tail, so two acks in a row ("ok got it", "sure, sounds good", "ok thx") stay
  // chat — a task there drops an INTAKE box on the work-only belt and mints a recurring job from a closing ack.
  // Trade-off: an agent's name after a greeting ("hey nova", "thanks claude") is not a pleasantry word -> TASK.
  const ACK = "hi+|hey+|hello|yo|sup|hiya|howdy|gm|good (?:morning|evening|night|afternoon)|good (?:idea|one|call)|thanks?|thank you|ty|thx|np|nice(?: one)?|cool|awesome|great(?: job)?|good job|well done|perfect|exactly|agreed|makes sense|sounds? good|got it|will do|understood|right|correct|ok(?:ay)?|k|yes|ya|yeah|yep|yup|no|nope|nah|sure|fine|lol|haha|nvm|never ?mind|bye|cya|see ya";
  const CHATTY = new RegExp('^(?:' + ACK + ')([\\s,!.?]+(?:' + ACK + '|there|again|so|much|a|lot|very|man|bro|dude|friend|guys|mate|buddy|all|everyone|then|too|thank|you|for|that|this|the|it|help|anyway|worries|problem|prob|thing|by|me|works|worked|work|job|is|does|not|yet|i|agree|good|great|one|morning|evening|night|afternoon|please|pls|appreciated?|now|at|love)\\b){0,3}[\\s!.?]*$');
  // questions ABOUT the agent itself (the WHOLE message; a few trailing words allowed — "how are you today")
  // -> CHAT
  const ABOUT_SELF = /^(how are you|how('?s| is) it going|how do you feel|how'?s your day|who are you|what('?s| is) your name|what are you|are you (ok|okay|alright|there|conscious|sentient|alive|real|happy|sure|awake|busy|free))([\s,!.?]+\w+){0,3}[\s!.?]*$/;

  // ctx.priorAgentTurn (optional): the agent's last reply in this conversation — a bare "yes" that answers its offer
  // to act is the task itself (see isAffirmation/offeredWork below). Absent = the text alone decides, as before.
  function isTaskDirective(text, ctx) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (!t) return false;
    if (ACTIONABLE.test(t)) return true;            // explicit intent beats a courtesy prefix
    if (ctx && ctx.priorAgentTurn && isAffirmation(t) && offeredWork(ctx.priorAgentTurn)) return true;   // "yes" to "want me to draft it?"
    if (CHATTY.test(t) || ABOUT_SELF.test(t)) return false;   // greetings / acks / self-questions: no tools, no work framing
    return true;                                    // default: keep TOOLS available (the desk trip is reactive, so an
                                                    // unused toolset stays invisible — a real task is never left tool-less)
  }

  /* "YES" TO AN OFFER IS A GO (2026-10-01). An ack alone is chat ("thanks", "got it") — but when the agent's last
     turn OFFERED to do work ("Want me to draft it?", "Shall I go ahead?"), the Commander's "yes" / "sure" / "do it"
     IS the task directive. Classified as chat it ran with no tools, so the agent could only promise the work.
     isAffirmation: the WHOLE message is a yes (a few trailing words allowed: "yes please", "sure, go for it").
     offeredWork: the agent's reply ends on a question that offers to act. Both must hold. */
  const AFFIRM = /^(y(es|ea|eah|ep|up|a)?|sure|ok(ay)?|k|alright|please|please do|do it|go( for it| ahead)?|let'?s do it|let'?s go|sounds good|absolutely|definitely|of course|yes please|why not|proceed|continue|carry on)([\s,!.]+(please|do it|go ahead|go for it|sure|yes|that'?d be great|sounds good|let'?s do it|proceed))*[\s!.]*$/;
  // a yes that also says thanks, or an ok with one short positive word ("yes thanks", "yes, thank you", "ok great"), is
  // still the yes. "ok thanks" is left out on purpose: it closes a conversation, it accepts nothing.
  const AFFIRM_WARM = /^(?:(?:y(?:es|ea|eah|ep|up|a)?|sure|absolutely|definitely|of course)(?:[\s,!.]+please)?[\s,!.]+(?:thanks|thank you|thx|ty|great|perfect|awesome|cool|nice)|ok(?:ay)?[\s,!.]+(?:great|perfect|awesome|cool|nice))[\s!.]*$/;
  const OFFER = /\b(shall i|should i|want me to|would you like( me)? to|do you want( me)? to|like me to|can i go ahead|ok(ay)? to (go|proceed|start)|go ahead and|ready (for me )?to|i can (go ahead|start|do|draft|write|build|run|set))\b/;
  function isAffirmation(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    return !!t && t.length <= 60 && (AFFIRM.test(t) || AFFIRM_WARM.test(t));
  }
  function offeredWork(agentText) {
    const t = String(agentText == null ? '' : agentText).trim().toLowerCase();
    if (!t) return false;
    const tail = t.slice(-400);                     // the offer is the reply's closing question, not something said mid-way
    const lastLine = tail.slice(tail.lastIndexOf('\n') + 1) || tail;
    const endsQ = /\?\s*[)"'*_`]*\s*$/.test(tail);
    if (endsQ && OFFER.test(lastLine)) return true;
    if (endsQ && openQuestion(lastLine)) return false;   // "Happy to make changes - what would you like?" asks for content; a bare yes answers nothing
    return declaredOffer(lastLine, tail.slice(0, tail.length - lastLine.length));
  }
  /* An OPEN question (the reply's closing clause opens with what / which / where / when / who / how / why) is no offer
     to act: the Commander's answer is the content, not a yes. A yes/no confirmation of a declared offer ("I can draft it
     for you - sound good?") is not open, so it still reaches declaredOffer. Decided on the closing clause only. */
  /* A SOUNDING-OUT closer asks yes/no about an offer just made ("how does that sound?", "what do you think?",
     "how about it?", "what do you say?"). It opens with how / what but it confirms, it does not ask for content,
     so it is not an open question and the declared-offer check still reads the line. */
  const SOUNDING_OUT = /^\s*(?:(?:and|but|so|or)\s+)?(?:how (?:does|do|would) (?:that|this|it) sound|how(?:'s| is| about) (?:that|this|it)|what do you (?:think|say)|what about (?:that|this|it))\b/;
  function openQuestion(line) {
    const clauses = String(line).replace(/\u2019/g, "'").split(/[,;:\u2013\u2014]|\s-\s|[.!?]\s+/).filter(function (p) { return p.trim(); });
    const last = clauses.length ? clauses[clauses.length - 1] : '';
    if (SOUNDING_OUT.test(last)) return false;
    return /^\s*(?:(?:and|but|so|or)\s+)?(?:what|which|where|when|who|whom|whose|how|why)\b/.test(last);
  }
  /* A DECLARED offer ("I can write that script for you.", "Let me know if you'd like me to set it up.") is an offer
     too, with or without a "?": its "yes" was chat and the run got zero tools. Decided on the reply's LAST SENTENCE
     only: it states the offer, names an action, and is not a refusal ("I can't ..."). No lookbehind (webkit floor).

     AN OFFER IS AN OFFER (2026-11-15). The action had only to be a word SOMEWHERE in the sentence, so "Glad I could fix
     that for you." and "I can only describe the steps, I have no way to run them." read as offers and an "ok" after
     them ran with the whole tool set, while "I can search the web for the latest numbers." was no offer at all. So:
     1. THE VERB BELONGS TO THE OFFER: it follows the offer phrase ("i can <verb>", "happy to <verb>", "want me to
        <verb>", "i'll <verb> ... if you like"), a short adverb or "go ahead and" between them at most (OFFER_LEAD).
        When a verb no list knows stands there ("I can go through the code and fix the warnings."), an action word a
        few words on in the same clause still counts, unless a word between them says it is no offer (OFFER_STATUS).
     2. REFUSALS AND REPORTS ARE NOT OFFERS: "i wish i could", "all i could", "glad i could", "was happy to" and their
        kin are cut out of the sentence before it is read (OFFER_NOT); a status verb in the verb's place offers
        nothing (OFFER_STATUS); "i could <verb> ... and it passed" reports (OFFER_REPORTED).
     3. ORDINARY VERBS COUNT: the file's own ACTIONABLE verbs and the work verbs of OFFER_WORK are offer verbs too,
        each only in the verb's place.
     A false task stays the cheap error: a sentence the rules cannot tell from an offer is an offer. */
  const OFFER_ACTION = /\b(write|draft|create|build|run|make|set (?:it |this |that )?up|save|send|generate|fix|update|implement|execute|install|start|apply|code|script|do (?:it|that|this))\b/;
  // the plain work verbs neither OFFER_ACTION nor ACTIONABLE holds; a split phrasal verb ("set the cron job up", "look that up") is the verb
  const OFFER_WORK = /^(?:delete|deploy|test|add|rename|pull|look in ?to|dig in ?to|(?:set|look) (?:[\w'-]+ ){1,4}up)\b/;
  // group 1 is the offer phrase; what follows the match is its complement, where the verb must stand
  const OFFER_LEAD = /\b(i (?:can|could)(?: do(?: \w+){0,2}(?: is(?: to)?|:))?|happy to|(?:want|like) me to|i(?:'ll| will))\s+(?:(?:also|then|now|just|certainly|definitely|easily|quickly|happily|gladly|always|go ahead and|help you|help|try to)\s+){0,2}/g;
  // "i'll <verb>" alone is a promise; it is an offer when the sentence asks first
  const OFFER_IF = /\bif (?:you(?:'d| would)? (?:like|want|prefer)|that (?:works|helps))\b|\bsay (?:the word|go|yes) and\b/;
  // an open invitation names the work anywhere in its sentence ("The draft is ready to send, just say the word.")
  const OFFER_SAY = /\b(?:just say (?:the word|go|yes)|say (?:the word|go|yes) and i(?:'ll| will))\b/;
  const OFFER_NEGATED = /\bi(?: (?:can(?: ?not|'t| no longer)|could(?:n'?t| not)|am (?:unable|not able) to|(?:won'?t|will not) be able to)|'m (?:unable|not able) to)\b/;
  // an offer taken back in its own sentence ("I could write it, but I don't think that is wise."), and work put off to no
  // set time ("Happy to make more changes anytime!", "I can fix that next time.") leave a bare yes nothing to accept
  const OFFER_WITHDRAWN = /\b(?:but|though|although|however)(?:,? (?:honestly|frankly|personally|really))?,? i(?: (?:really|honestly|personally|just))? (?:don't|do not|wouldn't|would not)(?: \w+)? (?:think|recommend|advise|suggest)\b|\b(?:but|though|although|however),? i(?:'d| would)(?: \w+)? (?:advise|recommend) against\b|\b(?:any ?time|next time)\b/;
  // a hedge or negation BEFORE the offer phrase in its own clause ("I don't think I can fix
  // that from here.", "That's not something I can run.", "I doubt I could build it.") is no offer. The clause starts
  // after , ; : ? an ellipsis, a dash or a joining word, so "Not sure it helps, but I can write a script." and "Didn't
  // get the email? I can send it again." still offer. "whether" hedges only right before the offer phrase ("I wonder
  // whether I can run it."), so "Let me know whether you'd like me to run it." still offers.
  const OFFER_HEDGED = /\b(?:not|never|nothing|doubt|unsure|whether(?=\s*$)|hardly|barely|no(?! (?:problem|worries|sweat|trouble|issues?|matter|rush|need)\b))\b|n't\b/;
  const OFFER_JOIN = /[,;:?\u2026–—]| - |\b(?:and|but|or|then|plus)\b/;
  // a clause that opens with a condition ("If it's not urgent I can schedule it.") negates the condition, not the offer
  const OFFER_COND = /^\s*(?:if|since|when|once|unless|because|after|as soon as)\b/;
  function hedgedBefore(s, at) { const head = s.slice(Math.max(0, at - 80), at).split(OFFER_JOIN); const h = head[head.length - 1]; return OFFER_HEDGED.test(h) && !OFFER_COND.test(h); }
  // a generic sign-off ("just say the word if you need anything else") names no work of its own
  const OFFER_ELSE = /\b(?:anything|something) (?:else|more)\b/;
  /* REFUSALS AND REPORTS that hold an offer phrase. Each is cut out of the sentence before it is read, so a real offer
     beside one still counts ("Glad I could fix that for you, and I can update the docs too."). */
  const OFFER_NOT = new RegExp('\\b(?:' + [
    "(?:wish|if|if only)(?: that)? i could",                                              // "I wish I could run that for you.", "If I could run it I would."
    "(?:before|until|unless|once|now that|so that) i (?:can|could)",                      // a condition or a purpose, not an offer: "I would need the key before I can run it."
    "(?:glad|happy|pleased|relieved)(?: that)? i (?:can|could)",                          // "Glad I could fix that for you."
    "(?:nothing|anything|everything|whatever|everywhere|wherever|much|little)(?: more| else| that)? i (?:can|could)",   // "That is everything I could fix in this pass."
    "what i (?:can|could)(?! do(?: \\w+){0,2}(?: is\\b|:))",                              // "beyond what I can build here"; "What I can do is write it." stays an offer
    "as (?:far|much|best|well|soon|long)(?: as)? i (?:can|could)",                        // "as far as I can make out", "as much as I could"
    "the (?:only|best|most|least)(?: [\\w-]+){0,2} i (?:can|could)",                      // "the only change I could make", "the best check I can run"
    "(?:is|was|are|were|be|did|do|done|'s) all(?: that)? i (?:can|could)",                // "That is all I could write today."
    "(?:was|were|been)(?: [\\w-]+){0,2} happy to",                                        // "I was happy to update the config."
    "(?:i could|happy to) have",                                                          // "I could have run the build first.", "I am happy to have fixed it."
    "(?:don't|do not|didn't|did not|doesn't|does not|wouldn't|would not|never) (?:want|like) me to"     // "It sounds like you don't want me to delete them."
  ].join('|') + ')\\b', 'g');
  /* STATUS / PERCEPTION / LIMIT ("I can see the build is green.", "I can also confirm the tests run clean.", "Happy to
     report the update went through.", "I can hardly run that.") says what the agent knows or cannot do, it offers no
     work: one of these words in the verb's place, or between the offer phrase and the action word, is no offer.
     "I can see the build is green, and I can fix the lint warning." still offers the fix. */
  const OFFER_STATUS = /\b(?:see|confirm|tell|say|verify|hear|notice|observe|understand|imagine|assume|report|be|feel|think|guess|believe|appreciate|wait|no|not|nothing|none|only|never|without|hardly|barely)\b|n't\b/;
  // "I could find no errors.", "I could check only the first two pages." report a limit ("I can fix that no problem." does not)
  const OFFER_LIMITED = /^(?: (?:it|them|that|this))? (?:only (?:(?:the|a|an|one|two|three|half|part|some)\b|[0-9])|no\b(?! (?:problem|worries|sweat|trouble|issues?|matter)\b)|nothing\b|none\b)/;
  // "I could run the full suite this time and everything passed." reports a result
  const OFFER_REPORTED = /\band (?:it|they|that|this|these|those|everything|all|nothing|both|each|none|(?:the|all|every|each|both) [\w-]+)(?: [\w-]+)? (?:[a-z]{2,}ed|was|were|went|came|ran|did|got|held|broke)\b/;
  const OFFER_CLAUSE = /[,;:\u2013\u2014]| - /;
  // does the work the agent offers stand at `at`, right after an offer phrase? Reads the clause there, 64 characters at most
  function offersAt(s, at, could) {
    if (could && OFFER_REPORTED.test(s.slice(at))) return false;
    let clause = s.substr(at, 64);
    if (s.length > at + 64 && clause.lastIndexOf(' ') > 0) clause = clause.slice(0, clause.lastIndexOf(' '));   // never judge a word cut in half
    clause = clause.split(OFFER_CLAUSE)[0];
    const near = OFFER_ACTION.exec(clause);
    let verb = OFFER_WORK.exec(clause) || (near && near.index === 0 ? near : null);
    if (!verb) { const plain = ACTIONABLE.exec(clause); if (plain && plain.index === 0 && !OFFER_STATUS.test(plain[0])) verb = plain; }
    if (verb) return !OFFER_LIMITED.test(s.slice(at + verb[0].length));
    return !!near && !OFFER_STATUS.test(clause.slice(0, near.index));   // an unknown verb first: the action word a few words on, nothing between them that says no
  }
  function statesOffer(sentence) {
    if (OFFER_NEGATED.test(sentence) || OFFER_WITHDRAWN.test(sentence)) return false;
    const s = sentence.replace(OFFER_NOT, ' ');
    if (OFFER_SAY.test(s) && OFFER_ACTION.test(s) && !OFFER_ELSE.test(s)) return true;
    const asks = OFFER_IF.test(s);
    OFFER_LEAD.lastIndex = 0;
    for (let m = OFFER_LEAD.exec(s); m; m = OFFER_LEAD.exec(s)) {
      const promise = m[1] === "i'll" || m[1] === 'i will';
      if ((asks || !promise) && offersAt(s, OFFER_LEAD.lastIndex, m[1].indexOf('i could') === 0) && !hedgedBefore(s, m.index)) return true;
    }
    return false;
  }
  /* A CLOSER hands the decision to the sentence before it: a sounding-out question ("How does that sound?", "Sound
     good?") or an open invitation ("Just say the word.", "Let me know!", "Let me know if that works."). A sentence that
     opens like a closer but says more of its own ("How about this: I can write a fix for you.", "What do you think? I
     can't run it.") is read as itself. "Let me know which tone you want." asks for content, so it is no closer. */
  const OFFER_CLOSER = /^[\s*_"'`(]*(?:(?:so|and|or)\s+)?(?:(?:just\s+)?(?:say the word|let me know(?:\s+if\b[^.!?]*)?)[\s.!*_"'`)]*|(?:sounds? good|ok(?:ay)?)\s*\?[\s*_"'`)]*)$/;
  const OFFER_PHRASE = /\b(?:i (?:can|could)|happy to|say (?:the word|go|yes)\b)/;
  function closes(sentence) { return OFFER_CLOSER.test(sentence) || (SOUNDING_OUT.test(sentence) && !(OFFER_PHRASE.test(sentence) && OFFER_ACTION.test(sentence))); }
  function sentencesOf(line) { return String(line).replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[*_~]+/g, '').replace(/\s+/g, ' ').split(/[.!]\s+/).filter(function (p) { return p.trim(); }); }
  // `before` is the reply's text above the last line: a closer that stands on a line of its own closes the line above it
  function declaredOffer(line, before) {
    let pieces = sentencesOf(line);
    if (pieces.length === 1 && before && closes(pieces[0])) { const above = String(before).trim(); pieces = sentencesOf(above.slice(above.lastIndexOf('\n') + 1)).concat(pieces); }
    const last = pieces.length ? pieces[pieces.length - 1] : '';
    if (statesOffer(last)) return true;
    return pieces.length > 1 && closes(last) && statesOffer(pieces[pieces.length - 2]);
  }

  /* CONTENT TAG — what KIND of work is this, so a FILTER junction can sort it to the right agent's bay.
     This is the conveyor's content-router input: getTag(text) -> the tag a work-item box carries, which a
     filter routes by (config.routes[tag] || config.def). Pure + deterministic + case-insensitive.

     'code' wins over 'research' when both signal (a "look up how to refactor this .ts" IS coding work),
     because a code task misrouted to a researcher loses the toolchain; an ambiguous prompt defaults to
     'general' (the filter's catch-all lane) so nothing is ever dropped. Keep both sets CONSERVATIVE —
     over-tagging mis-sorts work; the default lane is the safe sink. Mirror any change in a filter's routes. */
  const CODE = /\b(code|coding|program(?:ming)?|script(?:ing)?|function|class|method|variable|module|bug|debug|refactor|compile|deploy|commit|rebase|repo(?:sitory)?|git|api|endpoint|database|query|sql|regex|stack ?trace|exception|crash|typescript|javascript|python|rust|golang|css|html|react|node|npm|webpack|lint|unit ?test)\b|\.(?:js|ts|tsx|jsx|py|rs|go|java|cpp?|cs|css|html?|json|ya?ml|sh|sql)\b/;
  const RESEARCH = /\b(research|investigate|look ?up|search|google|web ?search|browse|sources?|cite|citations?|references?|study|survey|literature|paper|articles?|news|headlines?|wikipedia|market|trends?|competitors?|background|find out|gather|fact[ -]?check)\b/;

  // the content tag a work-item carries: 'code' | 'research' | 'general' (the default / catch-all lane)
  function getTag(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    if (!t) return 'general';
    if (CODE.test(t)) return 'code';                // code intent wins (misrouted code loses its toolchain)
    if (RESEARCH.test(t)) return 'research';
    return 'general';                               // ambiguous -> the filter's default lane, never dropped
  }

  /* THE AGENT'S BASELINE STANCE for a turn, from whether the message is a task: a task's baseline is 'task'
     (work pose), chatter's is 'talk' (face the Commander). NOTE: chat.js no longer applies this PREEMPTIVELY
     to start the walk — the live desk trip is reactive (it fires when a real tool runs; see walkToDesk). This
     pure mapping is kept as the canonical task->stance contract and as a regression guard.

     The speaker/voice setting (or any other UI state) MUST NEVER enter this decision. It once did — voice
     defaulting on forced every task to 'talk' — and that exact regression is what this signature forbids:
     stanceFor takes ONLY isTask, so nothing else can flip it. Do NOT add parameters or branches here.
     Locked by classify.test.js. */
  function stanceFor(isTask) { return isTask ? 'task' : 'talk'; }

  return { isTaskDirective, isAffirmation, offeredWork, getTag, stanceFor };
});
