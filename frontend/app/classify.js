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
  const CHATTY = /^(hi+|hey+|hello|yo|sup|hiya|howdy|gm|good (morning|evening|night|afternoon)|good (idea|one|call)|thanks?|thank you|ty|np|nice( one)?|cool|awesome|great( job)?|good job|well done|perfect|exactly|agreed|makes sense|sounds? good|got it|will do|right|correct|ok(ay)?|k|yes|ya|yeah|yep|yup|no|nope|nah|sure|fine|lol|haha|nvm|never ?mind|bye|cya|see ya)([\s,!.?]+(?:there|again|so|much|a|lot|very|man|bro|dude|friend|guys|mate|buddy|all|everyone|then|too|thanks?|thank|you|ty|lol|haha|bye|for|that|this|the|it|help|anyway|worries|problem|prob|thing|by|me|works|is|does|not|yet|i|agree|good|great|cool|nice|ok(?:ay)?|yes|yeah|no|nope|sure|fine|perfect|one|morning|evening|night|afternoon|please|pls)\b){0,3}[\s!.?]*$/;
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
  const AFFIRM = /^(y(es|ea|eah|ep|up)?|sure|ok(ay)?|k|alright|please|please do|do it|go( for it| ahead)?|let'?s do it|let'?s go|sounds good|absolutely|definitely|of course|yes please|why not|proceed|continue|carry on)([\s,!.]+(please|do it|go ahead|go for it|sure|yes|that'?d be great|sounds good|let'?s do it|proceed))*[\s!.]*$/;
  const OFFER = /\b(shall i|should i|want me to|would you like( me)? to|do you want( me)? to|like me to|can i go ahead|ok(ay)? to (go|proceed|start)|go ahead and|ready (for me )?to|i can (go ahead|start|do|draft|write|build|run|set))\b/;
  function isAffirmation(text) {
    const t = String(text == null ? '' : text).trim().toLowerCase();
    return !!t && t.length <= 60 && AFFIRM.test(t);
  }
  function offeredWork(agentText) {
    const t = String(agentText == null ? '' : agentText).trim().toLowerCase();
    if (!t) return false;
    const tail = t.slice(-400);                     // the offer is the reply's closing question, not something said mid-way
    return /\?\s*[)"'*_`]*\s*$/.test(tail) && OFFER.test(tail.slice(tail.lastIndexOf('\n') + 1) || tail);
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
