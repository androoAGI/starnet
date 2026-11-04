/* sidecar/taskbrief-store.js — durable per-conversation task briefs for intent elicitation.

   The brief is execution context, not chain-of-thought: original directive, visible question/answer,
   explicit assumptions, and lifecycle. It survives restart so a question asked tonight can be answered
   tomorrow without losing the task it belonged to. Task-specific choices never enter the global dossier. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');
const Policy = require('./taskbrief-policy.js');
const Context = require('./taskbrief-context.js');

const STORE_KEY = 'task-briefs';
const CAP = 500;
// Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
// silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
const STATES = new Set(['ready', 'clarifying', 'executing', 'done', 'cancelled']);

function bounded(s, n) { return String(s == null ? '' : s).trim().slice(0, n); }
function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const text = bounded(q.text || q.question, 240);
  // The cap is PER QUESTION KIND. A flat slice(0,3) here silently ate options 4-6 of a validated
  // multi-select on the way to disk — the policy accepted six, the card offered six, and the durable
  // record (which the end-run fallback re-reads) kept three.
  const multiSelect = q.multiSelect === true;
  const cap = Policy.maxOptionsFor ? Policy.maxOptionsFor(multiSelect) : (multiSelect ? 6 : 3);
  const options = Array.isArray(q.options) ? q.options.map(x => bounded(x, 72)).filter(Boolean).slice(0, cap) : [];
  if (!text) return null;
  return {
    id: bounded(q.id, 80), text, options, dimension: bounded(q.dimension, 24),
    recommended: bounded(q.recommended, 72), reason: bounded(q.reason, 240), newBlocker: q.newBlocker === true,
    multiSelect,
    mode:q.mode === 'conversation' ? 'conversation' : 'choice', sample:bounded(q.sample,2400),
    answer: bounded(q.answer, q.mode === 'conversation' ? 4000 : 500), askedAt: Number(q.askedAt) || 0, answeredAt: Number(q.answeredAt) || 0
  };
}
function normalizeBrief(b) {
  const x = b && typeof b === 'object' ? b : {};
  return {
    id: bounded(x.id, 100), key: bounded(x.key, 160), streamId: bounded(x.streamId, 80),
    // Completion updates runId; the original owner occurrence remains immutable across clarification/recovery.
    ...(x.originalRunId ? { originalRunId: bounded(x.originalRunId, 100) } : {}),
    // the transcript row of the directive the brief was opened on (turn identity; noteDirective). Absent on older briefs.
    ...(Number.isSafeInteger(x.directiveRowId) && x.directiveRowId > 0 ? { directiveRowId: x.directiveRowId } : {}),
    agentId: bounded(x.agentId || 'agent', 40), source: bounded(x.source || 'interactive', 24),
    originalDirective: bounded(x.originalDirective, 4000), currentInput: bounded(x.currentInput, 4000),
    status: STATES.has(x.status) ? x.status : 'ready',
    questions: Array.isArray(x.questions) ? x.questions.map(normalizeQuestion).filter(Boolean).slice(-16) : [],
    context: x.context ? Context.normalize(x.context) : null,
    // Ask-call budget (batching, 2026-08-14): pre-batching briefs stored one question per call, so for
    // them the question count IS the call count — the fallback keeps their budget honest after upgrade.
    askCalls: Number(x.askCalls) > 0 ? Number(x.askCalls) : (Array.isArray(x.questions) ? x.questions.filter(q => q && (q.text || q.question)).length : 0),
    assumptions: Array.isArray(x.assumptions) ? x.assumptions.map(v => bounded(v, 300)).filter(Boolean).slice(-12) : [],
    settled: x.settled && typeof x.settled === 'object' ? {
      objective: bounded(x.settled.objective, 500), deliverable: bounded(x.settled.deliverable, 500),
      audience: bounded(x.settled.audience, 500), success: bounded(x.settled.success, 500),
      assumptions: Array.isArray(x.settled.assumptions) ? x.settled.assumptions.map(v => bounded(v, 300)).filter(Boolean).slice(0, 8) : [],
      sources: Array.isArray(x.settled.sources) ? x.settled.sources.map(v => bounded(v, 300)).filter(Boolean).slice(0, 8) : []
    } : null,
    createdAt: Number(x.createdAt) || 0, updatedAt: Number(x.updatedAt) || Number(x.createdAt) || 0,
    completedAt: Number(x.completedAt) || 0, runId: bounded(x.runId, 100)
  };
}
function normalize(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  return { briefs: Array.isArray(x.briefs) ? x.briefs.map(normalizeBrief).filter(b => b.id && b.key).slice(-CAP) : [] };
}

// The literal deferral the UI sends when the Commander taps "use your judgment" (fork.js taskAnswerMessage),
// and what a channel user types when they take the same escape hatch ('Reply with a choice, or say "use your
// judgment."'). It must match ONLY a pure deferral: "Use your judgment, but keep it under 3 pages" hands over
// the choice yet still states a real constraint, so counting it as a skip would suppress a dimension the
// Commander is actively steering. Anchored at both ends, with the canned tail optional.
const SKIP_ANSWER = /^\s*use your judgment\b[\s.!,;:—-]*(?:choose the most sensible reversible default and continue the original task\.?)?\s*$/i;

function fingerprintQuestion(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3)
    .filter(t => !/^(this|that|with|from|what|which|should|would|could|your|their|about)$/.test(t))
    .filter((t, i, a) => a.indexOf(t) === i).sort().join(' ');
}

function makeTaskBriefStore(deps) {
  deps = deps || {};
  const pathMod = deps.path, workspaces = deps.workspaces;
  if (!pathMod || !workspaces) throw new Error('makeTaskBriefStore: path + workspaces required');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: pathMod, fileFor: () => pathMod.join(workspaces, 'task-briefs.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};
  // deps.forgotten(brief) -> bool: the forget registry's read-time belt (turn identity commit 12). A brief whose session was deleted never
  // feeds patterns(), whatever the purge has reached yet.
  const forgotten = typeof deps.forgotten === 'function' ? deps.forgotten : () => false;
  function read() { try { return normalize(durable.get(STORE_KEY)); } catch (e) { warn('[taskbrief] read failed', e); return normalize(null); } }
  function list(opts) {
    opts = opts || {}; let rows = read().briefs;
    if (opts.key) rows = rows.filter(b => b.key === String(opts.key));
    if (opts.status) rows = rows.filter(b => b.status === String(opts.status));
    rows = rows.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    return Number.isFinite(opts.limit) ? rows.slice(0, Math.max(0, opts.limit)) : rows;
  }
  function active(key) { return list({ key, limit: 1 })[0] || null; }

  function prepare(input, now) {
    input = input || {}; const key = bounded(input.key, 160); const text = bounded(input.text, 4000);
    if (!key || !text) return Promise.resolve(null);
    let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const ts = Number(now) || 0;
      const prior = rec.briefs.filter(b => b.key === key).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      // A journal continuation contains old user text, not a new answer. Preserve the durable brief.
      if (input.resumeOnly && prior) { out = prior; return undefined; }
      if (prior && prior.status === 'clarifying') {
        const routed = Policy.routeReply(text, input.taskAction);
        if (routed.action === 'cancel') {
          prior.status = 'cancelled'; prior.currentInput = text; prior.updatedAt = ts;
          out = Object.assign({}, prior, { inputAction: 'cancel' }); return rec;
        }
        if (routed.action === 'replace') {
          prior.status = 'cancelled'; prior.updatedAt = ts;
          out = normalizeBrief({
            id: bounded(input.id, 100) || ('tb_' + bounded(input.runId, 80)), key,
            streamId: bounded(input.streamId, 80), agentId: bounded(input.agentId || prior.agentId || 'agent', 40),
            source: bounded(input.source || prior.source || 'interactive', 24), originalDirective: routed.text, currentInput: routed.text,
            status: 'ready', createdAt: ts, updatedAt: ts, runId: bounded(input.runId, 100), originalRunId: bounded(input.runId, 100)
          });
          rec.briefs.push(out); while (rec.briefs.length > CAP) rec.briefs.shift();
          out = Object.assign({}, out, { inputAction: 'replace' }); return rec;
        }
        // FIRST unanswered, not last: a batched ask can leave several open questions when the Commander
        // walks away mid-batch; the durable fallback re-asks them in order, so the reply belongs to the
        // earliest open one. For legacy single-question briefs the two are the same question.
        const q = prior.questions.find(x => !x.answer);
        const prevInput = prior.currentInput;
        if (q) { q.answer = q.mode === 'conversation' ? text : routed.text; q.answeredAt = ts; }
        prior.currentInput = text; prior.status = 'ready'; prior.updatedAt = ts; out = prior;
        // The answer is only SPENT once a model run actually reads it. The returned copy (never the persisted
        // record) names what this call consumed, so a run refused or failed before any model output can hand
        // the question back with reopenAnswer() instead of stranding the original task behind a 'ready' brief.
        if (q) out = Object.assign({}, prior, { inputAction: 'answer', answered: { index: prior.questions.indexOf(q), at: ts, prevInput } });
      } else {
        out = normalizeBrief({
          id: bounded(input.id, 100) || ('tb_' + bounded(input.runId, 80)), key,
          streamId: bounded(input.streamId, 80), agentId: bounded(input.agentId || 'agent', 40),
          source: bounded(input.source || 'interactive', 24), originalDirective: text, currentInput: text,
          status: 'ready', createdAt: ts, updatedAt: ts, runId: bounded(input.runId, 100), originalRunId: bounded(input.runId, 100)
        });
        rec.briefs.push(out); while (rec.briefs.length > CAP) rec.briefs.shift();
      }
      return rec;
    }).then(() => out);
  }

  function ask(id, question, now, opts) {
    const key = String(id || ''); const fromMarker = !!(opts && opts.source === 'marker'); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      // Snapshot the call count BEFORE pushing: askCallsOf's legacy fallback counts questions, so reading
      // it after the push would double-count the question just added.
      const spentCalls = Policy.askCallsOf(b);
      let fields;
      if (fromMarker) {
        // Marker path: the model asked via the plain TASK_QUESTION reply line, so only the question and
        // options actually exist. Record exactly that — an empty dimension/recommended/reason is honest;
        // stamping placeholder values would let an unvalidated question masquerade as a host-validated one
        // (and a fabricated recommendation would surface in the UI). The whole-task question budget still holds.
        const base = normalizeQuestion(question); if (!base || (base.options.length < 2 && base.mode !== 'conversation')) return undefined;
        if (Policy.askCallsOf(b) >= 2) return undefined;
        if (b.questions.some(x => !x.answer)) return undefined;
        fields = { text: base.text, options: base.options, mode:base.mode };
      } else {
        const checked = Policy.validateQuestion(question, b); if (!checked.ok) return undefined;
        fields = checked.question;
      }
      const q = normalizeQuestion(Object.assign({ id: key + '_q' + (b.questions.length + 1), askedAt: now }, fields));
      b.questions.push(q); b.askCalls = spentCalls + 1;
      b.status = 'clarifying'; b.updatedAt = Number(now) || b.updatedAt; out = b; return rec;
    }).then(() => out);
  }

  /* askMany(id, candidate, now) — the batched sibling of ask() (2026-08-14). One brief_ask call may bundle
     up to three host-validated questions on distinct dimensions; the whole batch is validated and stored
     atomically and spends ONE ask call of the two-call budget. Returns the advanced brief or null. */
  function askMany(id, candidate, now) {
    const key = String(id || ''); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      const spentCalls = Policy.askCallsOf(b);   // before the pushes — the legacy fallback counts questions
      const checked = Policy.validateQuestions(candidate, b); if (!checked.ok) return undefined;
      for (const fields of checked.questions) {
        b.questions.push(normalizeQuestion(Object.assign({ id: key + '_q' + (b.questions.length + 1), askedAt: now }, fields)));
      }
      b.askCalls = spentCalls + 1;
      b.status = 'clarifying'; b.updatedAt = Number(now) || b.updatedAt; out = b; return rec;
    }).then(() => out);
  }

  /* answerInTurn(id, text, now) — a mid-run answer delivered over the live clarify channel (2026-07-31,
     Hermes-parity). Mirrors exactly what prepare()'s answer branch does for the next-run path (stamp the
     open question's answer, status back to 'ready') WITHOUT minting a new brief or touching currentInput:
     the directive didn't change, only the open question got its answer — so every restart/reconnect
     fallback that reads the durable 'clarifying' record keeps working untouched. Refuses anything but
     the open-question state (a second answer, a settled brief) so a stale POST can't rewrite history. */
  function answerInTurn(id, text, now, questionId) {
    const key = String(id || ''); const ans = bounded(text, 4000); let out = null;
    if (!key || !ans) return Promise.resolve(null);
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      if (b.status !== 'clarifying') return undefined;
      // Batched asks answer one SPECIFIC question per round-trip; without an id, the first unanswered
      // question is the target (identical to the old last-question behavior for single-question briefs).
      const q = questionId
        ? b.questions.find(x => x.id === String(questionId))
        : b.questions.find(x => !x.answer);
      if (!q || q.answer) return undefined;
      q.answer = ans; q.answeredAt = Number(now) || 0;
      // 'ready' only when the whole batch is settled — a half-answered batch must keep its durable
      // 'clarifying' state so a walk-away mid-batch still resumes on the remaining question.
      if (!b.questions.some(x => !x.answer)) b.status = 'ready';
      b.updatedAt = Number(now) || b.updatedAt; out = b; return rec;
    }).then(() => out);
  }

  /* reopenAnswer(id, answered, now) — undo ONE prepare() answer that no model run ever read. The run that
     carried the Commander's answer was refused before the model (a dead sign-in, a tool-less model, a journal
     failure) or the provider failed on turn 0, so nothing acted on the answer; leaving the brief 'ready' made
     the re-sent answer mint a NEW brief whose ORIGINAL REQUEST was the one-word answer (and a "yes"/"no" ran
     as tool-less chat). Restores exactly the pre-answer state. Refuses (null, record untouched) whenever
     anything moved since that answer: a proceed/ask/update/complete on this brief, or a newer brief on the key. */
  function reopenAnswer(id, answered, now) {
    const key = String(id || ''); const a = answered && typeof answered === 'object' ? answered : null; let out = null;
    if (!key || !a || !(Number(a.at) > 0) || !Number.isInteger(a.index) || a.index < 0) return Promise.resolve(null);
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      if (b.status !== 'ready' || b.updatedAt !== Number(a.at)) return undefined;
      const q = b.questions[a.index];
      if (!q || !q.answer || q.answeredAt !== Number(a.at)) return undefined;
      if (rec.briefs.some(x => x !== b && x.key === b.key && (x.updatedAt >= b.updatedAt || x.createdAt > Number(a.at)))) return undefined;
      q.answer = ''; q.answeredAt = 0;
      b.status = 'clarifying'; b.currentInput = bounded(a.prevInput, 4000); b.updatedAt = Number(now) || b.updatedAt;
      out = b; return rec;
    }).then(() => out);
  }

  function proceed(id, candidate, now) {
    const key = String(id || ''); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      const checked = Policy.validateProceed(candidate); if (!checked.ok || b.status === 'clarifying' || b.status === 'done' || b.status === 'cancelled') return undefined;
      if(b.questions.some(q=>q.mode==='conversation' && q.answer) && !Context.current(b)) return undefined;
      b.settled = checked.brief; b.assumptions = checked.brief.assumptions;
      b.status = 'executing'; b.updatedAt = Number(now) || b.updatedAt; out = b; return rec;
    }).then(() => out);
  }

  /* THE BRIEF NAMES ITS DIRECTIVE ROW (turn identity, commit 4): once the run that OPENED the brief has written (or reused)
     its directive, that row's id is recorded on the brief, once. A later run of the same brief (an answer, a resume) never
     moves it. Resolves the updated brief, or null when nothing changed. */
  function noteDirective(id, rowId, runId) {
    const key = String(id || ''); const run = bounded(runId, 100); let out = null;
    if (!key || !run || !(Number.isSafeInteger(rowId) && rowId > 0)) return Promise.resolve(null);
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key);
      if (!b || b.directiveRowId || b.originalRunId !== run) return undefined;
      b.directiveRowId = rowId; out = b; return rec;
    }).then(() => out);
  }

  function updateContext(id, candidate, now) {
    let out=null;
    return durable.update(STORE_KEY,cur=>{
      const rec=normalize(cur), b=rec.briefs.find(x=>x.id===String(id));
      if(!b || ['done','cancelled','clarifying'].includes(b.status)) return undefined;
      const checked=Context.validate(candidate,b); if(!checked.ok) throw new Error(checked.error);
      b.context=checked.context; b.updatedAt=Number(now)||b.updatedAt; out=b; return rec;
    }).then(()=>out);
  }

  /* SCRUB A SAVED KEY (keys.save, 2026-10-25): the brief captured the Commander's message — a pasted key included —
     before the agent could store that key in KEYS. fn(text) -> text names it; every brief's directive, input and
     answers pass through it. The store snapshots the PRIOR value to .bak on each write, so a changed store is written
     twice: once scrubbed, once more so the .bak holds the scrubbed copy too. Resolves true iff anything changed. */
  function scrubText(fn) {
    let changed = false;
    const pass = t => { const s = fn(String(t || '')); if (s !== String(t || '')) changed = true; return s; };
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      for (const b of rec.briefs) {
        b.originalDirective = pass(b.originalDirective);
        b.currentInput = pass(b.currentInput);
        for (const q of b.questions) q.answer = pass(q.answer);
      }
      return changed ? rec : undefined;
    }).then(() => changed ? durable.update(STORE_KEY, cur => normalize(cur)).then(() => true) : false);
  }

  /* forget(match) -> Promise<number>: the forget registry's purge. Every brief `match(brief)` names (its session was deleted, or its run
     quoted one) goes, with the directive and the answers it kept. The store keeps the prior value as its .bak, so a changed store is
     written twice (as scrubText does): the second write puts the purged copy in the .bak too. */
  function forget(match) {
    let n = 0;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      const keep = rec.briefs.filter(b => !match(b));
      n = rec.briefs.length - keep.length;
      if (!n) return undefined;
      rec.briefs = keep; return rec;
    }).then(() => (n ? durable.update(STORE_KEY, cur => normalize(cur)).then(() => n) : 0));
  }

  function complete(id, runId, now, assumptions) {
    const key = String(id || ''); let out = null;
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const b = rec.briefs.find(x => x.id === key); if (!b) return undefined;
      b.status = 'done'; b.runId = bounded(runId, 100); b.completedAt = Number(now) || 0; b.updatedAt = b.completedAt;
      if (Array.isArray(assumptions)) b.assumptions = assumptions.map(x => bounded(x, 300)).filter(Boolean).slice(-12);
      out = b; return rec;
    }).then(() => out);
  }

  // Weak relationship evidence only: the same concrete question answered the same way at least twice.
  // The prompt labels these OBSERVED PATTERNS, never standing orders, so they cannot override the current task.
  // The bin key is dimension AND question fingerprint: dimension alone merged unrelated questions that
  // happened to share an answer, and a marker-path question (empty dimension) still bins by its text.
  function patterns(limit) {
    const bins = {};
    for (const b of list({ limit: 200 })) {
      if (b.status !== 'done' || forgotten(b)) continue;
      for (const q of b.questions) {
      if (!q.answer) continue; const fpText = fingerprintQuestion(q.text); const ans = q.answer.toLowerCase(); if (!fpText || !ans) continue;
      const fp = (q.dimension ? 'dimension:' + q.dimension + ':' : '') + fpText;
      const k = fp + '::' + ans; if (!bins[k]) bins[k] = { question: q.text, answer: q.answer, count: 0, updatedAt: q.answeredAt || b.updatedAt };
      bins[k].count++; bins[k].updatedAt = Math.max(bins[k].updatedAt, q.answeredAt || b.updatedAt);
      }
    }
    return Object.values(bins).filter(x => x.count >= 2).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Number.isFinite(limit) ? limit : 5);
  }

  // GROUNDED RECOMMENDATION (2026-07-24). patterns() already knows which answer the Commander keeps choosing
  // for a given question — that is the one suggestion on this surface that is PROVABLE rather than a model
  // guess, and until now it was only whispered into the prompt as weak prose while the UI threw it away.
  // Same question (fingerprint) + an answer that resolves to one of THIS question's options + chosen >= 2
  // times => a suggestion we can defend with a count. Returns canonical option text, or null. Never a guess:
  // if nothing was observed twice, this returns null and the model's own recommendation stands.
  function groundedFor(question, pool) {
    const q = question && typeof question === 'object' ? question : null;
    if (!q || q.answer || !Array.isArray(q.options) || q.options.length < 2) return null;
    const fpText = fingerprintQuestion(q.text);
    if (!fpText) return null;
    // A MULTI-SELECT answer is a SET ("billing exports, the run ledger"), and whole-string equality can
    // never resolve it — so the one PROVABLE suggestion on this surface was permanently dead for exactly
    // the question kind multi-select exists for. Split into parts and tally each independently.
    // Splitting stays OFF for exclusive questions: there, today's strict equality is what keeps a free-text
    // answer from being mined for a word that happens to name an option.
    const multi = q.multiSelect === true;
    const tally = {};
    for (const p of (Array.isArray(pool) ? pool : patterns(50))) {
      if (fingerprintQuestion(p.question) !== fpText) continue;
      // A DEFERRAL is not a choice. "Use your judgment…" is a stored answer like any other, and letting it
      // through produced "you chose this N times before" about an option the Commander declined to pick.
      if (SKIP_ANSWER.test(p.answer)) continue;
      // EQUALITY ONLY — never the rescue matcher. This resolves the COMMANDER'S OWN free text, where a loose
      // match does not merely mis-suggest, it misquotes them: substring matching turned "not operators" into
      // a gold "you chose operators" claim. If their words are not one of these options, there is nothing
      // provable to say.
      const parts = multi ? String(p.answer).split(',') : [p.answer];
      const hits = [];
      for (const part of parts) {
        const option = Policy.matchOption(q.options, part);
        if (option && hits.indexOf(option) < 0) hits.push(option);   // one answer counts an option ONCE
      }
      if (!hits.length) continue;
      for (const option of hits) {
        // Fold counts across spellings of the SAME option, so history split over "operators"/"operators." is
        // not understated (patterns() bins on the raw answer string; the canonical option is the real key).
        const t = tally[option] || (tally[option] = { option, count: 0, lastAt: 0 });
        t.count += Number(p.count) || 0;
        t.lastAt = Math.max(t.lastAt, Number(p.updatedAt) || 0);
      }
    }
    const ranked = Object.values(tally).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
    const top = ranked[0];
    if (!top || top.count < 2) return null;
    if (multi) {
      // A SET has no dead heat to break: options are independent, so "you usually pick these two" is the
      // literal truth. Keep every option they chose at least twice, in the question's own option order.
      const strong = ranked.filter(t => t.count >= 2).map(t => t.option);
      const options = q.options.filter(o => strong.indexOf(o) >= 0);
      return options.length ? { option: top.option, options, count: top.count, multi: true } : null;
    }
    // A DEAD HEAT IS NOT A PREFERENCE. 2x "operators" against 2x "executives" is the Commander having no
    // settled habit; presenting either as "you chose this 2 times before" would dress a coin flip as proof.
    if (ranked[1] && ranked[1].count === top.count) return null;
    return { option: top.option, options: [top.option], count: top.count, lastAt: top.lastAt };
  }

  // ASK-WORTHINESS (2026-07-24). Every "use your judgment" tap is ALREADY persisted as a real answer string
  // (fork.js taskAnswerMessage), so the Commander's own "stop asking me this" signal has been sitting on disk
  // all along, uninterpreted. A dimension they habitually defer is one the agent should decide itself — and
  // then state as a correctable assumption in the read card — rather than burn one of its two questions on.
  // Deliberately CONSERVATIVE: suppressing a question is more consequential than merely suggesting a default,
  // because a false suppression silently guesses at something the Commander cared about. So it needs real
  // repetition (>=3) AND deferrals to be at least half of what they did with that dimension. Marker-path
  // questions carry no dimension and are attributed to none.
  function dimensionDeferrals() {
    const tally = {};
    const done = list({ limit: 200 }).filter(b => b.status === 'done');   // list() sorts newest-first
    done.forEach((b, age) => {                                            // age 0 = most recent completed task
      for (const q of b.questions) {
        const dim = bounded(q.dimension, 24);
        if (!dim || !q.answer) continue;
        const t = tally[dim] || (tally[dim] = { dimension: dim, deferred: 0, answered: 0, lastAskedAge: age, lastAt: -1, lastWasDeferral: false });
        const deferral = SKIP_ANSWER.test(q.answer);
        t.answered++;
        t.lastAskedAge = Math.min(t.lastAskedAge, age);
        if (deferral) t.deferred++;
        const at = Number(q.answeredAt) || Number(q.askedAt) || 0;
        if (at >= t.lastAt) { t.lastAt = at; t.lastWasDeferral = deferral; }
      }
    });
    return Object.values(tally);
  }
  // How many completed tasks may pass before a suppressed dimension is allowed ONE question again.
  const PROBE_GAP = 8;
  function deferredDimensions() {
    return dimensionDeferrals()
      .filter(t => t.deferred >= 3 && t.deferred * 2 >= t.answered)
      // RECOVERY, and it is not optional. Suppression blocks brief_ask, which is the only path that records a
      // dimension at all (marker questions carry none) — so without a way out the latch is permanent BY
      // CONSTRUCTION: no question -> no new answer -> the ratio can never change, and there is no reset route,
      // setting, or UI. A Commander who deferred during two busy tasks would be locked out forever. Two ways
      // back, so recovery never depends on out-waiting a 200-brief history window:
      //   1. a probe: after PROBE_GAP completed tasks with no question here, let one through;
      //   2. the LATEST signal wins: the moment they actually answer one, stop suppressing. Ratio alone would
      //      need four more real answers to outvote three old deferrals — i.e. ~32 tasks at one probe per 8.
      .filter(t => t.lastAskedAge < PROBE_GAP && t.lastWasDeferral)
      .map(t => t.dimension);
  }

  return { read, list, active, prepare, reopenAnswer, ask, askMany, answerInTurn, updateContext, noteDirective, proceed, complete, scrubText, forget, patterns, groundedFor, dimensionDeferrals, deferredDimensions, fingerprintQuestion, _durable: durable };
}

module.exports = { makeTaskBriefStore, normalize, normalizeBrief, normalizeQuestion, fingerprintQuestion };
