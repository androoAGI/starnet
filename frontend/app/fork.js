/* AGENT OS — fork.js : the PURE engine for MID-TASK PREFERENCE FORKS (R1 — questions that ARE work).

   When an agent hits a genuine fork whose answer is a DURABLE preference (format, tone, ask-first vs
   run-with-it — never a one-off task detail), it may ask ONCE instead of guessing: the question rides its
   normal reply (ending the turn — the honest mechanic; no fake mid-stream pause), the Commander answers via
   chips at the run boundary, and the pick does double duty — it steers the task immediately AND banks into
   the dossier's style dimension as a Commander-authored belief (the highest-quality evidence there is:
   given in context, about a real decision, immediately acted on).

   SELF-RETIRING by construction: the fork instruction only enters the system prompt while the style model's
   confidence is LOW (the same understanding.js floor that aims the VOI question and the belief probes) —
   once the station knows how the Commander likes work done, the forks stop appearing at all. The system
   asks LESS the longer it's used.

   This engine is the pure half: the directive block, the reply-marker parser, the confidence gate, and the
   banked-belief composer. The live wiring (prompt injection, chip render, dossier commit) lives in app.js /
   chat.js. PURE + node-testable, mirroring pitch.js / curiosity.js: a `Fork` global in the browser,
   module.exports under node. No clocks, no randomness. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Fork = api; root.TaskIntent = api.TaskIntent; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONF_FLOOR = 0.45;   // the fork instruction rides only while style confidence sits below this —
                             // the same "real doubt exists" floor understanding-probes use. Above it the
                             // agent is told nothing and forks never appear (self-retiring).
  const MAX_OPTS = 3;        // a fork is 2–3 concrete options, never a menu
  const Q_CHARS = 160;       // the question line is capped (a fork is short or it isn't a fork)
  const OPT_CHARS = 48;      // each option is a compact label, not a paragraph

  // the reply marker the agent is instructed to emit — one line, machine-findable, human-readable:
  //   FORK: terse summary or full detail? || terse | full detail
  /* ONE GRAMMAR FOR BOTH CHOICE MARKERS (rc walk 2026-10-14). Models write the marker the way they write prose: bold-wrapped
     ("**FORK: which angle?** || a | b | c"), bulleted or quoted, or glued onto the end of a sentence ("…one quick
     clarification: TASK_QUESTION: …"). Each of those missed the old line-start parse, so the reply showed raw machine syntax
     in COMMS and no chips. A marker is: the keyword, a colon, the question, `||`, the options — anywhere on its line, with
     markdown decoration around the keyword, the question or the options ignored. Group 1 is the prose before it on the
     same line (kept when the marker is stripped), 2 the question, 3 the options. Prose that merely says "FORK:" has no
     `||` after it and never matches. No lookbehind: older macOS WebKit cannot parse one. */
  const DECO = '[*_`~]*';
  // a list number before the marker ("1. TASK_QUESTION: …") is decoration too — it must never stay behind as a dangling "1."
  function markerSource(key) {
    return '^([^\\n]*?)[ \\t>+-]*(?:\\d{1,2}[.)])?[ \\t]*' + DECO + '[ \\t]*' + key + DECO + '[ \\t]*:' + DECO + '[ \\t]*([^\\n]*?)[ \\t]*' + DECO
      + '[ \\t]*\\|\\|[ \\t]*([^\\n]*?)[ \\t]*$';
  }
  /* ONE CASE RULE (rc review 2026-10-14). The keyword carries its own case, so every regex built from it — here, in the loop's
     "this reply waits on the Commander" check (sidecar/loop.js) and the phone push — agrees on what a marker is. FORK in
     capitals or title case: a lowercase "fork:" is prose or code ("const fork: Fork = a || b"), never a marker. TASK_QUESTION
     in any case: the word is unmistakable. No regex built from these takes the `i` flag. */
  const FORK_KEY = '\\bF(?:ORK|ork)', TASK_KEY = '[Tt][Aa][Ss][Kk]_[Qq][Uu][Ee][Ss][Tt][Ii][Oo][Nn]';
  const MARKER_KEY = '(?:' + FORK_KEY + '|' + TASK_KEY + ')';
  const LINE = new RegExp(markerSource(FORK_KEY), 'm');
  const undeco = s => String(s == null ? '' : s).replace(/^[\s*_`~]+|[\s*_`~]+$/g, '');
  // remove every marker matched by `re` (global): the prose before a marker on its line stays; a line that was only the
  // marker (plus decoration) goes. Byte-identical when nothing matched.
  function stripWith(re, text) {
    const s = String(text == null ? '' : text);
    re.lastIndex = 0;
    if (!re.test(s)) return s;
    re.lastIndex = 0;
    return s.replace(re, (m, pre) => String(pre || '').replace(/[ \t]+$/, '')).replace(/\n{3,}/g, '\n\n').trim();
  }

  // is the fork instruction earned right now? `read` is the understanding read (UnderstandingStore.read()).
  // Fail-closed: no read / malformed → NOT offered (an unearned fork is exactly the interruption Andrew
  // is wary of; when in doubt, the agent just guesses like today).
  function shouldOffer(read) {
    if (!read || !read.dims || !read.dims.style) return false;
    const c = read.dims.style.conf;
    return Number.isFinite(c) && c < CONF_FLOOR;
  }

  // the conditional system-prompt block. Only composed when shouldOffer() said yes — the caller never
  // includes it otherwise, so a well-understood Commander's prompt carries zero fork machinery.
  function directive() {
    return [
      'MID-TASK PREFERENCE FORK (you may use this AT MOST ONCE per task, or not at all):',
      'If — and only if — you hit a genuine fork where the choice reveals a DURABLE preference about how your',
      'Commander likes work done (format, tone, depth, ask-first vs run-with-it), you may ask instead of guessing.',
      'Never use it for one-off task details (which file, which URL — just ask those normally or decide).',
      'To ask, end your reply with exactly one line in this format (2-3 short options, || and | are literal):',
      'FORK: <the question, one short line> || <option A> | <option B> | <option C, optional>',
      'HARD FORMAT RULE while this block is present: if your reply ends by offering the Commander a choice or',
      'asking their preference (formats, tone, length, "want A or B?", "should I keep/save/shorten…?"), that',
      'question MUST be the FORK line — never plain prose. Same question, but the Commander answers with one',
      'tap and the station keeps the answer permanently. A reply that needs no question needs no FORK line.',
      'Example — instead of ending with "Want me to keep this casual, or make it formal?", end with:',
      'FORK: keep this casual, or formal? || casual | formal',
      'Your Commander answers with one tap; their answer arrives as their next message AND the station remembers',
      'it permanently — so never ask a fork twice, and never ask what the briefing above already tells you.'
    ].join('\n');
  }

  // find the fork in an agent reply. Returns { question, options: [2..3] } or null (no marker / malformed /
  // too few options — a broken marker renders as plain text, never a broken chip row).
  function parse(text) {
    const m = LINE.exec(String(text == null ? '' : text));
    if (!m) return null;
    const question = undeco(m[2]).slice(0, Q_CHARS);
    const options = m[3].split('|').map(undeco).filter(Boolean).slice(0, MAX_OPTS)
      .map(s => s.length > OPT_CHARS ? s.slice(0, OPT_CHARS - 1) + '…' : s);
    if (!question || options.length < 2) return null;
    return { question, options };
  }

  // strip the marker line from the rendered reply (the chips replace it; the raw FORK: line never shows).
  // EVERY marker line, not the first: a model that asks twice left the second one printed raw (first-hour walk).
  const LINE_ALL = new RegExp(LINE.source, 'gm');
  function strip(text) { return stripWith(LINE_ALL, text).trim(); }
  /* Both choice markers — FORK: and TASK_QUESTION: — are machine lines for the chip row, never prose. The chat
     rendered them raw in three places (first-hour walk 2026-09-28): every FORK line live (nothing called strip),
     a second TASK_QUESTION line, and all of them again whenever history re-rendered from the server transcript.
     One remover for display, used by the live reply, the saved history row and the history render. */
  function stripMarkers(text) {
    const s = String(text == null ? '' : text);
    const out = stripWith(TASK_LINE_ALL, stripWith(LINE_ALL, s));
    return out === s ? s : out;   // no marker: byte-identical (prose that merely says "FORK:" included)
  }
  /* THE LIVE REPLY NEVER SHOWS A MARKER BEING TYPED (rc walk 2026-10-14). The chat renders a reply while it streams, so a
     marker sat on screen raw until its run ended — and forever, in a paragraph a tool call had already closed. The live
     text drops every complete marker AND the marker still arriving on the last line (its keyword and colon are in, its
     `||` is not yet — or the keyword itself is half-typed). If it never becomes a marker it shows when its line completes. */
  const OPEN_TAIL = new RegExp('(^|\\n)([^\\n]*?)[ \\t>+-]*(?:\\d{1,2}[.)])?[ \\t]*' + DECO + '[ \\t]*' + MARKER_KEY + DECO + '[ \\t]*:[^\\n]*$');
  // a keyword still being typed: capitals ("TASK_QU", "FOR"), "Fork", or any case once it carries the underscore ("task_qu") —
  // never a plain lowercase or title-case word ("for", "For", "task"), which would hold back ordinary prose
  function halfKeyword(w) {
    const up = w.toUpperCase();
    if (w !== up && w !== 'Fork' && w.indexOf('_') < 0) return false;
    return 'TASK_QUESTION:'.indexOf(up) === 0 || ((w === up || w === 'Fork') && 'FORK:'.indexOf(up) === 0);
  }
  function liveText(text) {
    let s = stripMarkers(text);
    const open = OPEN_TAIL.exec(s);
    if (open) return s.slice(0, open.index) + open[1] + open[2].replace(/[ \t]+$/, '');
    const half = /(^|[\s*_`~:>-])([A-Za-z_]{3,13})$/.exec(s);
    if (half && halfKeyword(half[2])) s = s.slice(0, half.index + half[1].length).replace(/[ \t*_`~]+$/, '');
    return s;
  }
  /* A marker nothing turned into a card (a group reply, a channel) still never shows machine syntax: the question reads
     as a line of prose and its options as a short list under it. */
  const ANY_LINE_ALL = new RegExp(markerSource(MARKER_KEY), 'gm');
  function readable(text) {
    const s = String(text == null ? '' : text);
    ANY_LINE_ALL.lastIndex = 0;
    if (!ANY_LINE_ALL.test(s)) return s;
    ANY_LINE_ALL.lastIndex = 0;
    return s.replace(ANY_LINE_ALL, (m, pre, q, opts) => {
      const head = String(pre || '').replace(/[ \t]+$/, '');
      const list = String(opts || '').split('|').map(undeco).filter(Boolean).map(o => '- ' + o).join('\n');
      return (head ? head + '\n' : '') + undeco(q) + (list ? '\n' + list : '');
    });
  }

  // the dossier belief a pick banks: the Commander's answer, with the question kept as context so the
  // belief stays legible in the COMMANDER panel ("bullets — asked: summary format?").
  function beliefText(question, answer) {
    const a = String(answer == null ? '' : answer).trim();
    const q = String(question == null ? '' : question).trim().replace(/\?+$/, '');
    if (!a) return '';
    return q ? (a + ' (asked: ' + q + '?)') : a;
  }

  // TASK CONTEXT is the complementary, task-local decision protocol. It intentionally lives beside durable
  // preference forks so the browser and Node host share one already-shipped decision-protocol module without
  // adding another release-surface path. Unlike FORK, its answers stay in the Task Brief, never the dossier.
  const TASK_LINE = new RegExp(markerSource(TASK_KEY), 'm');   // the shared marker grammar (see markerSource; the key carries its case)
  // An EXCLUSIVE question is a fork: 2-3 options or it is a menu, not a decision. A MULTI-SELECT question
  // is a checklist ("which sources?", "which constraints?") and legitimately runs longer — 3 was starving
  // exactly the question type multi-select exists for, while the clarify card already rendered up to 6.
  const TASK_Q_CHARS = 240, TASK_OPT_CHARS = 72, TASK_MAX_OPTS = 3, TASK_MAX_OPTS_MULTI = 6;
  function taskClean(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max); }
  // Normalizers shared by this browser-side parse and the host policy (taskbrief-policy), so the two option
  // producers can never drift on what counts as "the same option". There are deliberately TWO strengths:
  //
  //   taskLoosen  — for MATCHING a recommendation/answer to an option. Strips case, padding, quotes, trailing
  //                 punctuation and a leading article or list enumerator ("A.", "2)"), all of which are pure
  //                 formatting noise around an otherwise identical choice.
  //   taskSameOption — for DEDUPING one option against another. Strips strictly less: only a leading "the".
  //                 "the doc" vs "a doc" is update-the-existing vs make-a-new-one, a real distinction, and
  //                 folding them collapsed genuine alternatives and then rejected the question as "not a
  //                 decision" — whereas "operators" vs "the operators" is one choice written twice. Dropping
  //                 only the definite article separates those two cases. When in doubt this errs toward
  //                 KEEPING both: a slightly redundant chip is a blemish, destroying a real alternative is a bug.
  //
  // Neither does substring matching: containment inverts negation ("not dark" contains "dark").
  const TASK_QUOTES = /[‘’“”'"`]/g;
  const TASK_ENUM = /^(?:[a-z]|\d{1,2})\s*[.):]\s+/;   // "A. ", "2) ", "iii: " style list markers
  function taskTrim(v) {
    return String(v == null ? '' : v).toLowerCase().replace(TASK_QUOTES, '')
      .replace(/[\s.,;:!?)\]]+$/, '').replace(/^[\s([]+/, '').replace(/\s+/g, ' ').trim();
  }
  function taskLoosen(v) {
    return taskTrim(v).replace(TASK_ENUM, '').replace(/^(?:a|an|the)\s+/, '').trim();
  }
  function taskDedupeKey(v) { return taskTrim(v).replace(/^the\s+/, '').trim(); }
  function taskSameOption(a, b) { const k = taskDedupeKey(a); return !!k && k === taskDedupeKey(b); }
  function taskDedupeOptions(list, max) {
    // Cap BEFORE the O(n^2) pairwise compare: `options` is model-controlled and the wire schema declares no
    // maxItems, so a 4000-entry array used to block the single-process sidecar for seconds. Only the first
    // few can ever be offered anyway, so scan a small bounded window and stop.
    const cap = Math.max(2, Math.min(Number(max) || TASK_MAX_OPTS, TASK_MAX_OPTS_MULTI));
    const seen = [];
    const src = Array.isArray(list) ? list.slice(0, 32) : [];
    for (let i = 0; i < src.length && seen.length < cap; i++) {
      const x = taskClean(src[i], TASK_OPT_CHARS);
      if (!taskTrim(x)) continue;                                  // a punctuation-only "option" is not a choice
      let dup = false;
      for (let j = 0; j < seen.length; j++) if (taskSameOption(seen[j], x)) { dup = true; break; }
      if (!dup) seen.push(x);
    }
    return seen;
  }
  function taskParse(text) {
    const m = TASK_LINE.exec(String(text == null ? '' : text));
    if (!m) return null;
    const question = taskClean(undeco(m[2]), TASK_Q_CHARS);
    const raw = m[3].split('|').map(undeco).join('|');
    if(raw.trim()==='[free text]') return question ? {question,options:[],mode:'conversation'} : null;
    // The marker is the LAST-RESORT path — taken by exactly the models that format badly, and unlike brief_ask
    // it has no retry loop. Returning null here does not mean "fail closed": upstream it means "no question was
    // asked", so the brief completes as done and the raw `TASK_QUESTION: …` line leaks into the transcript and
    // out to channels. So dedupe is best-effort: if it would leave fewer than two choices, keep the raw list
    // rather than destroy a recoverable question.
    const deduped = taskDedupeOptions(raw.split('|'));
    const options = deduped.length >= 2
      ? deduped
      : raw.split('|').map(x => taskClean(x, TASK_OPT_CHARS)).filter(Boolean).slice(0, TASK_MAX_OPTS);
    return question && options.length >= 2 ? { question, options } : null;
  }
  const TASK_LINE_ALL = new RegExp(TASK_LINE.source, 'gm');
  function taskStrip(text) { return stripWith(TASK_LINE_ALL, text).trim(); }
  function taskDirective(contextBlock) {
    const lines = [
      'TASK CONTEXT — LISTEN BEFORE YOU BUILD:',
      'Before consequential work, decide whether the Commander already supplied enough context for the result they actually want.',
      'Proceed immediately when the task is clear. Infer low-impact details with reversible defaults; do not turn a good request into an interview.',
      'Research before asking: inspect the granted project, conversation, task brief, and available sources when they can answer the gap.',
      'Ask only when different plausible answers would materially change the outcome, audience, deliverable, source of truth, safety, or acceptance boundary.',
      'For ambiguous projects or workflows, use brief_ask with mode:conversation. Ask ONE concrete question about their last real example, the step that is frustrating, or an exception. Never ask vague prompts such as "what does good look like?". Options are optional shortcuts, not a required menu.',
      'Listen before choosing the next question. Read the ENTIRE answer: extract volunteered sources, audience, constraints, steps, exceptions and corrections, even when they answer more than you asked. Call brief_update after each conversational answer. Include a complete revised snapshot with verbatim quotes and sourceIds; separate your interpretations from assumptions and unresolved unknowns. Do not ask for information already supplied.',
      'Choose the next move by usefulness: proceed immediately when the next useful action is clear; ask a targeted follow-up only when its answer changes that action; or show a small draft/example using sample in brief_ask when reacting is easier than describing. A sample is provisional text, never a claim of an existing file or completed action.',
      'Conversational discovery normally needs one or two exchanges; six is an emergency ceiling, not a target. Do not fill every field, conduct a generic interview, or keep asking for cosmetic preferences. Use uncertainty about low-impact details as a reason to produce a reversible draft.',
      'Legacy mode:choice remains available for concrete exclusive decisions: 2-3 options (or multiSelect:true up to 6), at most two asking calls. Independent questions can be bundled in also; never pre-bundle exploratory follow-ups that depend on what the Commander says.',
      'If the Commander said "use your judgment", "just do it", or equivalent, choose the most sensible reversible default and act.',
      'When brief_ask, brief_update and brief_proceed are available, use them as the authoritative protocol. through in brief_update is request before any answers, otherwise the latest answered question id. Facts contain dimension, text (your working interpretation), quote (verbatim user words), and sourceId (request or question id). Never invent evidence. Keep this context local to the task, not the global dossier. Call brief_proceed immediately before the first consequential tool; the host blocks writes/executes until you do.',
      'In brief_proceed, every assumption must be a DECISION a reasonable person could have made differently — what you are including, excluding, or treating as the source of truth — and something the Commander could actually overturn.',
      'State a STYLE, TONE, or AESTHETIC assumption ONLY when the task produces an authored artifact whose look or voice you had to choose (a document, deck, page, image, UI, anything another person will read), and then name what you picked AND what you rejected ("gritty and readable, not decorative"). There, guess boldly — a corrected guess teaches more than a hedge. At most ONE such assumption per brief.',
      'NEVER restate your normal defaults as assumptions. "Style: brief and direct", "Tone: friendly", "Aesthetic: plain and readable" are how you always work — they are noise, not decisions, and they bury the one assumption that mattered. A question answered in chat needs no taste assumption at all.',
      'Use brief_ask to pause on a material unknown. It validates the decision dimension, distinct options, recommended default, research status, and whole-task question budget.',
      'To ask, do no consequential mutation first and END your reply with exactly:',
      'TASK_QUESTION: <one concrete question> || <option A> | <option B> | <option C, optional>',
      'For an open-ended fallback use: TASK_QUESTION: <one concrete question> || [free text]',
      'You may inspect/read before asking. Do not emit TASK_QUESTION when you can responsibly proceed. Never repeat a question already answered in the task brief.'
    ];
    const cx = String(contextBlock || '').trim();
    if (cx) lines.push(cx);
    return lines.join('\n');
  }
  function taskAnswerMessage(question, answer) {
    const a = taskClean(answer, 500);
    if (!a) return 'Use your judgment. Choose the most sensible reversible default and continue the original task.';
    return a;
  }
  function taskRouteReply(text) {
    const raw = taskClean(text, 4000);
    if (/^\s*(cancel|stop|never\s*mind|nevermind|forget\s+(?:it|that)|drop\s+(?:it|that))\s*[.!]?\s*$/i.test(raw)) return { action: 'cancel', text: raw };
    const m = /^\s*(?:new\s+task\s*:|instead\s*,?|forget\s+that\s*[,;:]?|change\s+of\s+plan\s*[:,]?)\s*(.+)$/i.exec(raw);
    return m && taskClean(m[1], 4000) ? { action: 'replace', text: taskClean(m[1], 4000) } : { action: 'answer', text: raw };
  }
  const TaskIntent = {
    parse: taskParse, strip: taskStrip, directive: taskDirective, answerMessage: taskAnswerMessage, routeReply: taskRouteReply,
    loosen: taskLoosen, dedupeOptions: taskDedupeOptions, sameOption: taskSameOption,
    MAX_QUESTION: TASK_Q_CHARS, MAX_OPTION: TASK_OPT_CHARS, MAX_OPTIONS: TASK_MAX_OPTS, MAX_OPTIONS_MULTI: TASK_MAX_OPTS_MULTI,
    // one place decides how many options a question may carry, so policy / store / card can never drift
    maxOptionsFor: (multiSelect) => (multiSelect === true ? TASK_MAX_OPTS_MULTI : TASK_MAX_OPTS),
    /* THE BRIEF GATE'S PAUSE IS NOT A FAILURE (rc walk 2026-10-14). A consequential call made before the Task Brief settles
       is held by the host and NOT run; the model settles the brief and makes the call again. The tool result has to stay
       an error for the model, but every surface drew it as a red "✗ failed" chip. The host stamps this one summary on that
       result (sidecar/index.js) and the chat reads it back to draw the held call as the neutral, not-run state it is. */
    GATE_HELD: 'not run yet — waiting on the task brief',
    isGateHeld: ev => !!(ev && ev.isError && ev.summary === 'not run yet — waiting on the task brief'),
    // the held result's TEXT (a reloaded transcript keeps the content, not the summary): the host opens it with this lead
    GATE_HELD_LEAD: 'Task Brief gate: nothing ran.',
    isGateHeldBody: body => /^(?:ERROR: )?Task Brief gate: nothing ran\./.test(String(body == null ? '' : body))
  };

  return { shouldOffer, directive, parse, strip, stripMarkers, liveText, readable, beliefText, CONF_FLOOR, MAX_OPTS, MARKER_KEY, TaskIntent };
});
