/* sidecar/commander-context.js — bounded server-side context composer for ordinary task runs.

   This is the common seam interactive COMMS and messaging channels can share. It composes only durable,
   provenance-labelled facts the harness can prove: active task brief, explicit dossier/goal text, and repeated
   task-decision patterns. It does not infer certainty and does not duplicate a dossier already present in the
   caller's system prompt.

   SECRETS (context-key-redact, 2026-10-28): every field is stored text the Commander or a model wrote, and some of it
   holds a key the Commander pasted once (a run title, a brief's request, an evidence quote). Each one goes through
   prompt-scrub's scrubStored BEFORE it is clipped — the clip is what turns a whole, matchable key into an unmatchable
   fragment. There is no opt-out: a caller cannot hand compose() a field that skips it. */
'use strict';
const { scrubStored } = require('./prompt-scrub.js');

function clip(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
// scrub the raw stored field, THEN clip it (never the other way round)
function sc(s, n) { return clip(scrubStored(s == null ? '' : String(s)), n); }
function compose(input) {
  input = input || {}; const lines = [];
  const b = input.brief;
  if (b && b.originalDirective) {
    lines.push('<task_brief id="' + sc(b.id, 100).replace(/["<>]/g, '') + '" status="' + sc(b.status, 20) + '">');
    lines.push('ORIGINAL REQUEST: ' + sc(b.originalDirective, 4000));
    for (const q of (b.questions || []).slice(-6)) {
      lines.push('DECISION: ' + sc(q.text, 240) + (q.answer ? (' => ' + sc(q.answer, q.mode==='conversation' ? 4000 : 500)) : ' => unanswered') + (q.mode==='conversation' ? ' [sourceId: '+scrubStored(String(q.id))+']' : ''));
    }
    // the JSON is scrubbed as one text: the placeholders hold no quote, so it stays valid JSON
    if(b.context) lines.push('WORKING UNDERSTANDING (model interpretation with user quotations; assumptions are not confirmed facts): '+scrubStored(JSON.stringify(b.context)));
    for (const a of (b.assumptions || []).slice(-6)) lines.push('ASSUMPTION: ' + sc(a, 300));
    lines.push('Continue this same task. Do not re-ask answered decisions. Verify the result against the original request and decisions.');
    lines.push('</task_brief>');
  }
  // TASK BRIEF v2 — recipe intake: the launching recipe's DECLARED material decisions (normalized by
  // recipes.js — dimension ∈ the taskbrief-policy set). Aims any mid-run question at the right dimension
  // even when the Commander skipped the launch chips; launch-tapped answers already ride the directive.
  const intake = Array.isArray(input.recipeIntake) ? input.recipeIntake.slice(0, 3) : [];
  if (intake.length) {
    lines.push('<recipe_intake provenance="recipe-declared">');
    lines.push('MATERIAL DECISIONS for this task type — resolve each from the request, launch decisions, or dossier before consequential work; if one is genuinely unresolved and material, it is THE thing to ask about. Default everything else:');
    for (const e of intake) {
      lines.push('- ' + sc(e.dimension, 24) + ': ' + sc(e.question, 160) + ' [' + (Array.isArray(e.options) ? e.options.map(o => sc(o, 72)).join(' | ') : '') + ']'
        + (e.recommended ? ' (suggested: ' + sc(e.recommended, 72) + (e.reason ? ' — ' + sc(e.reason, 160) : '') + ')' : ''));
    }
    lines.push('</recipe_intake>');
  }
  // a dossier the caller's system prompt already carries (raw or scrubbed) is never repeated
  const dossierRaw = clip(input.dossier, 5000), dossier = sc(input.dossier, 5000), existing = String(input.existingSystem || '');
  if (dossier && existing.indexOf(dossier) < 0 && existing.indexOf(dossierRaw) < 0) lines.push('<commander_context provenance="commander-dossier">\n' + dossier + '\n</commander_context>');
  const goal = input.goal && (input.goal.title || input.goal.text || input.goal.goal);
  if (goal) lines.push('<active_goal provenance="commander-confirmed">' + sc(goal, 500) + '</active_goal>');
  // ONE evidence projection for every execution lane. These are weak/observed signals: they may help prioritize
  // and personalize, but never override the current request or masquerade as a stated belief.
  const evidence = [];
  const topics = Array.isArray(input.topics) ? input.topics.slice(0, 6) : [];
  for (const t of topics) {
    if (!t || !(t.label || t.topic)) continue;
    evidence.push('TOPIC: ' + sc(t.label || t.topic, 80) + ' (seen ' + Math.max(0, Number(t.count) || 0) + '×)'
      + ((t.evidence && t.evidence[0]) ? ' — evidence: "' + sc(t.evidence[0], 140) + '"' : ''));
  }
  const threads = Array.isArray(input.threads) ? input.threads.slice(0, 5) : [];
  for (const t of threads) if (t && t.title) evidence.push('OPEN THREAD: ' + sc(t.title, 160) + (t.spec ? ' — ' + sc(t.spec, 180) : ''));
  if (input.worksignal) evidence.push('WORKFLOW: ' + sc(input.worksignal, 400));
  const verdicts = input.verdicts && input.verdicts.kinds && typeof input.verdicts.kinds === 'object' ? input.verdicts.kinds : {};
  const prefs = [];
  for (const k of Object.keys(verdicts).slice(0, 8)) {
    const v = verdicts[k] || {}; const w = Number(v.weight) || 0;
    if (w) prefs.push(sc(k, 80) + '=' + (w > 0 ? '+' : '') + Math.round(w * 100) / 100 + ' (' + (Number(v.positive) || 0) + ' kept/' + (Number(v.negative) || 0) + ' declined)');
  }
  if (prefs.length) evidence.push('VERDICT PATTERNS: ' + prefs.join(', '));
  const activity = Array.isArray(input.activity) ? input.activity.slice(0, 6) : [];
  for (const a of activity) if (a) evidence.push('RECENT ACTIVITY: ' + sc(a, 180));
  // TRACK RECORD (outcome learning, 2026-08-30): what this station's runs actually produce — pre-composed by
  // outcomes.js, every number a literal count of recent runs. Rides the same weak-evidence fence: it may steer
  // what to propose and how to shape work, never override the current request. Pushed LAST deliberately
  // (consistency sweep, 2026-08-30): the block's 20-line cap truncates from the tail, and on a warm station
  // (6 topics + 5 threads + workflow + verdicts + 6 activity = 19) the original pre-activity position pushed
  // up to 3 RECENT ACTIVITY lines out — trading the freshest grounding for a statistic, the exact inversion
  // of the contextpack doctrine. Now the statistic is what truncates first.
  const track = Array.isArray(input.trackRecord) ? input.trackRecord.slice(0, 4) : [];
  for (const t of track) if (t) evidence.push('TRACK RECORD: ' + sc(t, 200));
  if (evidence.length) {
    lines.push('<commander_evidence provenance="observed; weak; never override the current request">');
    for (const e of evidence.slice(0, 20)) lines.push('- ' + e);
    lines.push('</commander_evidence>');
  }
  // ASK-WORTHINESS: dimensions the Commander has repeatedly waved off with "use your judgment". The tool gate
  // (taskbrief-tools) refuses these outright; saying so here spends no turn discovering that, and names the
  // honest alternative — decide it, then surface the choice as a correctable assumption.
  const deferred = Array.isArray(input.deferredDimensions) ? input.deferredDimensions.slice(0, 8) : [];
  if (deferred.length) {
    lines.push('<deferred_decisions provenance="commander-observed">');
    lines.push('The Commander has repeatedly answered "use your judgment" on these decision dimensions: '
      + deferred.map(d => sc(d, 24)).join(', ') + '. Do NOT ask about them. Choose the most sensible reversible default and state it as a correctable assumption in brief_proceed.');
    lines.push('</deferred_decisions>');
  }
  // AUTOMATION ASK (2026-10-01): the request itself asks for recurring / scheduled / automated work. Live runs
  // answered "set up automations for my shop" by pitching integrations it did not have and interviewing the
  // Commander — creating nothing. Only present when the ask is about automation (see automationIntent()).
  if (input.automationAsk) {
    lines.push('<automation_request provenance="the current request asks for automation">');
    lines.push('Turn this into StarNet routines now. Settle the Task Brief with brief_proceed (state your assumptions: focus, times) instead of asking, then call routine_create in the same turn. Do not interview the Commander.');
    lines.push('- Build routines your own tools can run today (web research, watching public pages, drafting, summaries, checklists, reminders). Never wait on a connection or API key: create the runnable version and mention any upgrade in one line.');
    lines.push('- A broad goal ("help me run my shop") gets 2-5 distinct routines at sensible times. Plain-English schedules work: "weekdays at 8am", "mondays at 9am", "1st of every month".');
    lines.push('- Every run must deliver something useful on its own (fresh findings, a ready draft, a short decision list), never a blank template or generic advice. Each prompt is self-contained: task, sources, output format, what to flag. Results come back to this chat by default. Check routine_list first; never duplicate.');
    lines.push('- End by listing each routine (name, when, what it delivers) and say they can pause or edit them in AUTOMATE › SCHEDULES. With no routine_create tool, point them there instead.');
    lines.push('</automation_request>');
  }
  // STANDING WORK (repeat sense, 2026-10-01): this request is the same work the Commander already had completed on
  // separate earlier days (workflow-takeover.js notice()). The agent may OFFER a routine — never create one unasked.
  const sw = input.standingWork;
  if (sw && Number(sw.count) >= 3 && Array.isArray(sw.dates)) {
    const day = t => { const d = new Date(Number(t)); return isFinite(d.getTime()) ? d.toDateString() : ''; };
    lines.push('<standing_work_notice provenance="observed: completed task history">');
    lines.push('The Commander has now asked for this same work ' + Number(sw.count) + ' times on separate days (earlier: '
      + sw.dates.slice(-4).map(day).filter(Boolean).join('; ') + ').'
      + (Array.isArray(sw.quotes) && sw.quotes.length ? ' Earlier wording: ' + sw.quotes.map(q => '"' + sc(q, 160) + '"').join(' / ') + '.' : ''));
    lines.push('Do the current task fully first. Then, at the very END of your reply, offer ONCE in one short sentence to take it off their plate as a standing routine'
      + (sw.suggest && sw.suggest.display ? ' — suggest ' + sc(sw.suggest.display, 60) + ' (' + sc(sw.suggest.why, 80) + ')' : ' — ask when it should run')
      + '. Create nothing unless they say yes. On yes: call routine.list, then routine.create with a self-contained prompt (the full instruction, sources, format and choices they made) and the agreed schedule, deliver "origin" so results come back here. If you have no routine.create tool, say AUTOMATE › SCHEDULES can set it up in one step. If they decline or ignore it, drop it.');
    lines.push('</standing_work_notice>');
  }
  const patterns = Array.isArray(input.patterns) ? input.patterns : [];
  if (patterns.length) {
    lines.push('<observed_task_patterns strength="weak; never override current instructions">');
    for (const p of patterns.slice(0, 5)) lines.push('- ' + sc(p.question, 180) + ' => ' + sc(p.answer, 240) + ' (' + Number(p.count || 0) + ' times)');
    lines.push('</observed_task_patterns>');
  }
  return lines.join('\n\n');
}

/* automationIntent(text) — does a request ask for recurring / scheduled / automated work? Deliberately about the
   ASK ("automate", "every morning", "remind me", "weekly report"), not a topic: "what is cron?" or "summarize
   this automation article" do not trigger it. Pure. */
const AUTOMATION_RE = /\b(?:automat(?:e|es|ed|ing|ion|ions)\b(?! (?:article|post|video|tool|software|testing))|set up (?:a |some |an )?(?:routines?|reminders?|schedules?)|(?:make|turn) (?:this|it|that) (?:into )?(?:a )?(?:routine|daily|weekly|recurring|regular)|on a schedule|recurring|remind me|every (?:single )?(?:day|morning|afternoon|evening|night|weekday|weekend|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+ ?(?:min(?:ute)?s?|hours?|days?|weeks?))|each (?:day|morning|evening|week|month)|(?:daily|weekly|monthly|nightly|hourly) (?:report|digest|summary|brief|briefing|check|update|recap|reminder|roundup|email|post)s?|keep (?:an eye on|tabs on|track of)|(?:watch|monitor) (?:for|my|the)\b)/i;
function automationIntent(text) {
  const s = String(text == null ? '' : text).slice(0, 4000);
  if (!s.trim() || /^\s*(?:what|how|why|explain)\b[^.?!]*\b(?:cron|automation|routine)s?\b[^.?!]*\?\s*$/i.test(s)) return false;
  return AUTOMATION_RE.test(s);
}

module.exports = { compose, automationIntent };
