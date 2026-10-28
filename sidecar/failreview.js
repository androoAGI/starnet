/* sidecar/failreview.js — the FAILURE-REVIEW aux pass: a PURE "what should the station learn from a run
   that FAILED?" producer. The six existing post-run learning passes all gate on reason 'done', so a run that
   ended error/max_iters/budget/refusal taught the station nothing — even though the run store already persists
   rich failure data (failureStage/failureCode, the tool trace, recovery attempts, uncertain mutations). This
   module closes that loop: given the failed run's outcome + transcript tail and an INJECTED aux-model
   `propose(prompt) -> text`, it builds a bounded prompt asking for at most 3 durable LESSONS, parses the tagged
   reply, and guardrails it (redact, trim, per-lesson char cap, value floor, exact + Jaccard-paraphrase dedup
   vs the existing store and within the batch).

   Lessons are notebook MEMORY, not skills (skillreview.js deliberately refuses transient setup failures — the
   durable "do differently next time" belief lives here). Every proposal carries origin 'failure-review' so a
   record's provenance is visible in the Memory Core panel and the dossier.

   No IO, no ambient time/rng: `clock`, `propose`, and `redact` are injected (lint-determinism gate), so it is
   deterministic and replay-safe. A failed review never hurts anything — propose() failure returns zero
   proposals. Architectural template: reflect.js (same mold, same guard order). */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('../frontend/app/memtruth.js') : root.MemTruth);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).failreview = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MemTruth) {
  'use strict';

  const ORIGIN = 'failure-review';   // the deterministic provenance tag every proposal/record carries
  const MAX_LESSONS = 3;             // a failure teaches a few sharp lessons, never a wall
  const MAX_CONTENT = 280;           // parity with reflect.MAX_CONTENT — a lesson is a short durable belief
  const MIN_CONTENT = 12;            // below this it isn't an actionable lesson
  const MIN_TOKENS = 3;              // a lesson needs a subject, a cause and a correction — not two words
  const TRANSCRIPT_CAP = 8000;       // chars of transcript tail fed to the aux model (bounded prompt)
  const TRACE_MAX = 12;              // last N tool-trace rows shown (the failure is at the tail)
  const TRACE_SUMMARY_CHARS = 100;   // per-row clip for the trace summary line
  const RECOVERY_MAX = 6;            // last N recovery attempts shown
  const SIM_THRESHOLD = MemTruth.SIM_THRESHOLD;   // the shared Jaccard paraphrase-dupe threshold (memtruth.js)

  // which run-end reasons a failure review may learn from. 'done' learns via reflection; 'cancelled' is the
  // Commander's own hand (nothing failed); 'empty'/'clarifying' produced no work to learn from.
  const REVIEW_REASONS = { error: 1, max_iters: 1, budget: 1, refusal: 1 };
  function reviewableReason(reason) { return REVIEW_REASONS[String(reason == null ? '' : reason)] === 1; }

  // SALIENCE FLOOR: don't burn an aux call learning from an instant stub. A failed run is worth a lesson only
  // when it actually did something — reached for at least one tool, or survived at least two model turns.
  function failureSalient(run) {
    run = run || {};
    const trace = Array.isArray(run.toolTrace) ? run.toolTrace.length : 0;
    const turns = Number(run.turns) || 0;
    return trace >= 1 || turns >= 2;
  }

  /* PROVIDER REFUSAL (xai-403-1023): a run the PROVIDER refused teaches nothing, and the review would send the end of that
     same conversation back to it. Its cooldown arms only on a saved lesson, so a doomed review repeated after every
     failed run — the second request of each 403 pair in the cloud logs. Account/credential refusals (auth, billing,
     quota_exhausted) fail any model on the same provider credential; a model refusal (content_policy_blocked,
     model_not_found) fails the same model again, so it skips unless a separate aux model (opts.separateModel) reads it.
     format_error is NOT here: the review is a plain text request without the tools or media a 400 may have refused.
     For the same reason a model_not_found on a PART of the request (run.unsupportedPart — the classifier's fact for
     "No endpoints found that support image input / tool use": a tool screenshot sent to a model that cannot read
     images) keeps its review: the same model answered this run's earlier turns and the review carries no such part. */
  const ACCOUNT_REFUSALS = { auth: 1, billing: 1, quota_exhausted: 1 };
  const MODEL_REFUSALS = { content_policy_blocked: 1, model_not_found: 1 };
  function providerRefused(run, opts) {
    if (!run || String(run.failureStage || '') !== 'provider_stream') return false;
    const code = String(run.failureCode || '');
    if (ACCOUNT_REFUSALS[code] === 1) return true;
    if (code === 'model_not_found' && run.unsupportedPart === true) return false;
    return MODEL_REFUSALS[code] === 1 && !(opts && opts.separateModel);
  }

  const LINE = /^\s*[-*•]?\s*LESSON\s*[:\-—]\s*(.+?)\s*$/i;
  // strip a recall fence the model may have echoed (mirrors reflect.js) — a forged <recalled-memory> block
  // must never be replayed into a durable lesson.
  const RECALL_FENCE = /<(recalled-memory|run_context|crew_call)>[\s\S]*?<\/\1>|<\/?(?:recalled-memory|run_context|crew_call)>/gi;   // + the per-run <run_context> and <crew_call> notes (lean-prompt 2026-10-12)

  /* value-floor regexes — the deterministic backstop for what the prompt alone can't suppress.
     RESTATE: a line that merely restates that the run failed carries no correction — it is the failureCode in
     prose, already persisted in runs.jsonl. BLAME: a lesson assigns no fault (never blame — a "the user should
     have…" line is a complaint, not a reusable correction). TRANSIENT: a one-off blip is noise, not a durable
     belief — unless the line itself describes a recurring/pattern shape, which the second alternative admits. */
  const RESTATE = /^(the\s+)?(run|task|job|attempt|it)\s+(failed|errored|crashed|was\s+(cancelled|aborted)|timed\s+out|hit\s+(the\s+)?(budget|limit|cap|max))\W*$/i;
  const BLAME = /^(the\s+)?(user|commander|model|provider|agent)\s+(should\s+have|shouldn't\s+have|failed\s+to|was\s+(wrong|bad|at\s+fault)|didn'?t|is\s+to\s+blame)\b/i;
  const TRANSIENT = /\b(one[-\s]?off|momentary|temporar(?:y|ily)|transient|blip|glitch|fluke)\b/i;
  const RECURRENT = /\b(recurr?(?:ing|ent|ed)|repeated(?:ly)?|pattern|every\s+(time|attempt|retry)|each\s+(time|attempt|retry)|consistently|again)\b/i;
  /* GATE-SKIP: a lesson that teaches the agent to route around a step the host REQUIRES. The first-hour walk
     (2026-09-28) banked "treat a gating/setup tool as non-blocking and complete the deliverable anyway" and
     "instead of blocking on an optional brief-gate" after a harness bug broke the brief tool — both are wrong
     advice the next run would follow. The host still enforces the gate; the lesson only teaches a worse agent. */
  const GATE_WORD = '(?:gate|gating|task\\s+brief|brief[-_ ]?(?:gate|proceed|ask|update)|approval|consent|permission)';
  const GATE_SKIP = new RegExp('\\b(?:skip|bypass|ignore|route\\s+around|work\\s+around|circumvent|treat)\\b[^.;]{0,80}' + GATE_WORD
    + '|' + GATE_WORD + '[^.;]{0,80}\\b(?:non[-\\s]?blocking|optional|not\\s+required|isn\'?t\\s+required|unnecessary)\\b'
    + '|\\boptional\\b[^.;]{0,30}' + GATE_WORD, 'i');

  // significant-word count for the floor (2-char tech names admitted, reflect parity)
  function floorTokens(s) { return MemTruth.simTokens(s, { minLen: 2 }).size; }
  function lowValue(content) {
    const c = String(content == null ? '' : content).trim();
    if (c.length < MIN_CONTENT) return true;
    if (floorTokens(c) < MIN_TOKENS) return true;
    if (RESTATE.test(c)) return true;                       // a bare restatement of the failure teaches nothing
    if (BLAME.test(c)) return true;                         // never blame
    if (TRANSIENT.test(c) && !RECURRENT.test(c)) return true;   // one-off noise, no recovery pattern named
    const gs = GATE_SKIP.exec(c);                           // never teach routing around a step the host requires —
    if (gs && !/\b(?:don'?t|do\s+not|never|must\s+not|avoid)\s+$/i.test(c.slice(Math.max(0, gs.index - 24), gs.index))) return true;   // ("never skip the approval" is good advice)
    return false;
  }

  const textOf = r => (r && (r.content != null ? r.content : ((r.title || '') + ' ' + (r.body || '')))) || '';
  // paraphrase-dupe similarity: the ONE token-Jaccard every memory writer shares (frontend/app/memtruth.js)
  const jaccard = (a, b) => MemTruth.similarity(a, b);

  // one bounded line per tool-trace row: "name OK|ERR 123ms — summary"
  function traceLines(toolTrace) {
    const rows = Array.isArray(toolTrace) ? toolTrace.slice(-TRACE_MAX) : [];
    const out = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const ok = (r.ok === false || r.isError === true) ? 'ERR' : 'ok';
      const ms = Number(r.ms) > 0 ? (' ' + Math.floor(Number(r.ms)) + 'ms') : '';
      const summary = String(r.summary == null ? '' : r.summary).replace(/\s+/g, ' ').trim().slice(0, TRACE_SUMMARY_CHARS);
      out.push('- ' + String(r.name || 'tool') + ' ' + ok + ms + (summary ? (' — ' + summary) : ''));
    }
    return out;
  }

  function recoveryLines(recoveryAttempts) {
    const rows = Array.isArray(recoveryAttempts) ? recoveryAttempts.slice(-RECOVERY_MAX) : [];
    const out = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      out.push('- ' + String(r.stage || 'stage') + '/' + String(r.action || 'action')
        + (r.reason ? (' (' + String(r.reason).replace(/\s+/g, ' ').slice(0, 80) + ')') : '')
        + (r.attempt != null ? (' attempt ' + r.attempt) : '')
        + (r.model ? (' on ' + String(r.model).slice(0, 60)) : ''));
    }
    return out;
  }

  /* buildPrompt(run, cap) — the bounded failure-review prompt. run: { reason, failureStage, failureCode,
     toolTrace, recoveryAttempts, uncertainMutations, messages, agentContext }. Structured failure facts first
     (they are the part reflection never sees), then the transcript tail, tail-capped so the freshest exchange —
     where the failure actually happened — survives the cap. */
  function buildPrompt(run, cap) {
    run = run || {}; cap = cap || TRANSCRIPT_CAP;
    const head = [];
    head.push('FAILED RUN — reason: ' + String(run.reason || 'error')
      + (run.failureStage ? (', stage: ' + String(run.failureStage).slice(0, 80)) : '')
      + (run.failureCode ? (', code: ' + String(run.failureCode).slice(0, 80)) : ''));
    if (run.agentContext) head.push('AGENT: ' + String(run.agentContext).replace(/\s+/g, ' ').trim().slice(0, 200));
    const trace = traceLines(run.toolTrace);
    if (trace.length) { head.push('TOOL TRACE (last ' + trace.length + '):'); head.push.apply(head, trace); }
    const rec = recoveryLines(run.recoveryAttempts);
    if (rec.length) { head.push('RECOVERY ATTEMPTS:'); head.push.apply(head, rec); }
    const um = Array.isArray(run.uncertainMutations) ? run.uncertainMutations.length : 0;
    if (um) head.push('UNCERTAIN MUTATIONS: ' + um + ' (side effects whose outcome is unproven)');

    const turns = [];
    for (const msg of (Array.isArray(run.messages) ? run.messages : [])) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const c = typeof msg.content === 'string' ? msg.content.replace(RECALL_FENCE, '') : '';
      if (c) turns.push((msg.role === 'user' ? 'USER: ' : 'AGENT: ') + c);
    }
    let body = turns.join('\n');
    if (body.length > cap) body = body.slice(body.length - cap);   // keep the tail — the failure lives there

    return 'This run FAILED. From the failure facts and the transcript tail, list AT MOST ' + MAX_LESSONS +
      ' durable LESSONS worth remembering for future runs — one per line, each tagged LESSON:. A lesson names ' +
      'what failed, why, and what to do differently next time — concrete and reusable, never a restatement of ' +
      'the failure, never blame. Skip one-off transient noise (a single network blip) unless a recovery ' +
      'pattern is visible across attempts. The Commander reads these lessons: write them in plain words about ' +
      'the task, never internal tool names, schemas or error codes. Never advise skipping, bypassing or treating ' +
      'as optional a step the station requires (the task brief, an approval, consent, a permission) — if such a ' +
      'step kept failing, the lesson is how to satisfy it. If nothing durable can be learned, reply NONE.\n\n' +
      head.join('\n') + (body ? ('\n\nTRANSCRIPT TAIL:\n' + body) : '');
  }

  // parse the aux model's reply into lesson strings; untagged lines are ignored (conservative).
  function parse(raw) {
    const out = [];
    for (const ln of String(raw == null ? '' : raw).split('\n')) {
      const m = LINE.exec(ln);
      if (m && m[1].trim()) out.push(m[1].trim());
    }
    return out;
  }

  /* review(run, opts) -> { proposals[], prompt } — the full pass, reflect() mold.
     run:  { agentId, runId, reason, failureStage, failureCode, toolTrace, recoveryAttempts,
             uncertainMutations, messages, agentContext }
     opts: { propose(prompt)->text, clock:{now}, redact, existing:[records], max }
     proposals: { id, kind:'fact', content, scope:'global', streamId:null, sourceRunId, createdAt,
                  origin:'failure-review' } — CANDIDATES for the host's highStakes split; the host owns writes. */
  async function review(run, opts) {
    run = run || {}; opts = opts || {};
    const clock = opts.clock || { now: () => 0 };
    const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const max = Math.min(opts.max || MAX_LESSONS, MAX_LESSONS);
    const propose = opts.propose;
    if (typeof propose !== 'function') return { proposals: [] };

    const seen = {};
    const priorTexts = [];
    for (const r of (Array.isArray(opts.existing) ? opts.existing : [])) {
      const t = textOf(r).trim();
      if (t) { seen[t.toLowerCase()] = 1; priorTexts.push(t); }
    }

    const prompt = buildPrompt(run, TRANSCRIPT_CAP);
    let raw;
    try { raw = await propose(prompt); } catch (_) { return { proposals: [], prompt: prompt }; }   // a failed review never hurts anything
    const now = clock.now();
    const proposals = [];
    for (const cand of parse(raw)) {
      let content = redact(String(cand)).trim();
      if (content.length > MAX_CONTENT) content = content.slice(0, MAX_CONTENT - 1) + '…';
      const key = content.toLowerCase();
      if (!content || seen[key]) continue;        // drop empties + EXACT dupes (vs existing AND earlier lessons)
      if (lowValue(content)) continue;            // drop restatements / blame / one-off noise (the value floor)
      let near = false;                           // drop PARAPHRASE dupes (Jaccard) vs the same corpus
      for (const pt of priorTexts) { if (jaccard(pt, content) >= SIM_THRESHOLD) { near = true; break; } }
      if (near) continue;
      seen[key] = 1; priorTexts.push(content);
      proposals.push({
        id: 'flesson_' + (proposals.length + 1), kind: 'fact', content: content,
        scope: 'global', streamId: null, sourceRunId: run.runId || null, createdAt: now, origin: ORIGIN
      });
      if (proposals.length >= max) break;
    }
    return { proposals: proposals, prompt: prompt };
  }

  return { ORIGIN, MAX_LESSONS, MAX_CONTENT, reviewableReason, failureSalient, providerRefused, buildPrompt, parse, lowValue, review };
});
