/* AGENT OS — study.js : the PURE STUDY ENGINE — the dossier's missing Phase B (work → understanding).

   Phase A (dossier.js) is a one-time intake form: the dossier grows ONLY from the Commander's own onboarding
   docs + explicit panel edits (dossierstore.js:9 — "folds nothing automatically"). This engine is Phase B:
   after a SALIENT completed run, the station STUDIES the work (its directive + a transcript slice + the
   existing dossier block) and proposes DOSSIER BELIEF UPDATES, tagged by dimension — observed goals, new pain,
   stack facts, working-style, plus DRIFT/OBSOLETION ("goal X looks shipped — retire it?"). The Commander then
   consents via the same turn-in Keep/Edit/Discard beat (studystore.js + chat.js wire the live half).

   Mirrors sidecar/reflect.js discipline exactly — it is the dossier's counterpart to reflection:
   - PURE + node-testable: `Study` global in the browser, module.exports under node. No IO, no ambient
     time/rng — `clock`, `propose`, and `redact` are INJECTED (deterministic + replay-safe).
   - Reuses reflection's salience philosophy (a real user turn + a reply OR real tool work; recurrence lets a
     terse run through), a value floor, and Jaccard near-dup dedup vs both the existing beliefs AND a permanent
     studyDeclined denylist (the memory-overhaul "discard = never again" rule, applied to the dossier).
   - Auto-proposals are CANDIDATES ONLY — nothing is written until the Commander taps Keep (the consent §5.6).

   Fail-open everywhere: a failed / empty / malformed study yields ZERO proposals and never touches the run. */
'use strict';
(function (root, factory) {
  const beatCard = (typeof module !== 'undefined' && module.exports) ? require('./beatcard.js') : root.BeatCard;
  const api = factory(beatCard);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Study = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (BeatCard) {
  'use strict';

  // the dossier dimensions the study may tag a proposal with — MUST match dossier.js DIM_KEYS (kept inline so
  // study stays standalone + node-loadable without a hard dossier.js dependency; a mismatch is caught by test).
  const DIMS = ['identity', 'stack', 'goals', 'style', 'standing_orders', 'pain', 'ambition', 'people', 'schedule'];
  const DIM_SET = new Set(DIMS);
  // the model tags a line "<DIM> <ADD|RETIRE>: <text>". ADD = a new belief; RETIRE = drift/obsoletion of an
  // existing one ("this goal looks shipped"). Anything else is ignored (conservative, like reflect.parse).
  const LINE = /^\s*[-*•]?\s*(identity|stack|goals?|style|standing[_\s-]?orders?|pain|ambition|ambitions?|people|audience|schedule|cadence)\s+(add|retire|new|drift|done|shipped|obsolete)\s*[:\-—]\s*(.+?)\s*$/i;
  // normalise the model's loose dimension word to a canonical DIM key.
  const DIM_ALIAS = { goal: 'goals', ambitions: 'ambition', 'standing order': 'standing_orders', 'standingorders': 'standing_orders', 'standing-orders': 'standing_orders', audience: 'people', cadence: 'schedule' };
  // which tag words mean "retire this belief" vs "add a new one".
  const RETIRE_WORDS = new Set(['retire', 'drift', 'done', 'shipped', 'obsolete']);

  const MAX_CONTENT = 280;        // a belief is a short durable line, not a transcript (mirrors dossier.TEXT_CHARS)
  const MIN_CONTENT = 8;          // below this it isn't a durable belief — a value floor against trivia
  const MIN_TOKENS = 2;           // a belief needs at least this many significant words
  const DEFAULT_MAX = 3;          // study is RARER than reflection — never dump a wall (anti-nag; host shows ≤1/run)
  const PROMPT_CAP = 3000;        // chars of directive + transcript slice fed to the aux model
  const SIM_THRESHOLD = 0.6;      // Jaccard near-dup floor — same as reflect.js

  // run-specific narration openers (dropped by the floor) — a study belief is durable, never "in this run…".
  const TRANSIENT = /^(the user (said|asked|wanted|mentioned|requested)|we (discussed|talked|covered|went over)|in this (run|task|session|conversation)|this (run|task|session)|today (i|we)|the (task|conversation) (was|is))\b/i;
  const RECALL_FENCE = /<(recalled-memory|run_context|crew_call)>[\s\S]*?<\/\1>|<\/?(?:recalled-memory|run_context|crew_call)>/gi;   // + the per-run <run_context> and <crew_call> notes (lean-prompt 2026-10-12)

  const SIM_STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they').split(/\s+/));
  function simTokens(s) {
    const set = new Set();
    for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !SIM_STOP.has(t)) set.add(t);
    return set;
  }
  function jaccard(a, b) {
    const A = simTokens(a), B = simTokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }
  // significant-word count for the FLOOR (admits 2-char tech names Go/AI/ML/Vi, like reflect.floorTokens).
  function floorTokens(s) {
    const set = new Set();
    for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 2 && !SIM_STOP.has(t)) set.add(t);
    return set.size;
  }
  function lowValue(content) {
    const c = String(content == null ? '' : content).trim();
    if (c.length < MIN_CONTENT) return true;
    if (floorTokens(c) < MIN_TOKENS) return true;
    if (TRANSIENT.test(c)) return true;
    return false;
  }

  // canonicalise the model's dimension word to a DIM key, or null if it isn't a real dimension.
  function canonDim(word) {
    let w = String(word == null ? '' : word).toLowerCase().trim().replace(/[\s-]+/g, '_');
    if (DIM_ALIAS[w]) w = DIM_ALIAS[w];
    if (w === 'goal') w = 'goals';
    if (w === 'ambitions') w = 'ambition';
    return DIM_SET.has(w) ? w : null;
  }

  // did the run do REAL WORK — a tool-role result or an assistant turn carrying tool_calls (the project's honest
  // "real work" signal). Mirrors reflect.usedTools so study fires on the SAME notion of a substantive run.
  function usedTools(messages) {
    for (const m of (Array.isArray(messages) ? messages : [])) {
      if (!m) continue;
      if (m.role === 'tool') return true;
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    }
    return false;
  }

  // SALIENCE GATE — the SAME philosophy as reflect.reflectSalient (a real user turn + a reply OR real tool work;
  // recurrence lets a terse run through), so study fires on the worth of the work, never a raw char count. Kept
  // deliberately identical so study and reflection agree on "was this run substantive?".
  const MIN_STUDY_CHARS = 200;
  function studySalient(messages, recurring) {
    const arr = Array.isArray(messages) ? messages : [];
    let chars = 0, hasUser = false, hasAgent = false;
    for (const m of arr) {
      if (!m || typeof m.content !== 'string') continue;
      if (m.role === 'user') { hasUser = true; chars += m.content.length; }
      else if (m.role === 'assistant') { hasAgent = true; chars += m.content.length; }
    }
    const tools = usedTools(arr);
    if (!hasUser || (!hasAgent && !tools)) return false;
    if (recurring) return true;
    if (tools) return true;
    return chars >= MIN_STUDY_CHARS;
  }

  // the study PROMPT: the run's directive + a recent transcript slice + the current dossier block, asking the
  // model to propose dossier belief updates as tagged lines. Terse (constraint: keep aux prompts short).
  function buildPrompt(o) {
    o = o || {};
    const directive = String(o.directive == null ? '' : o.directive).replace(RECALL_FENCE, '').trim();
    const block = String(o.dossierBlock == null ? '' : o.dossierBlock).trim();
    const turns = [];
    for (const msg of (Array.isArray(o.messages) ? o.messages : [])) {
      if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
      const c = typeof msg.content === 'string' ? msg.content.replace(RECALL_FENCE, '') : '';
      if (c) turns.push((msg.role === 'user' ? 'USER: ' : 'AGENT: ') + c);
    }
    let body = turns.join('\n');
    const cap = Number.isFinite(o.cap) ? o.cap : PROMPT_CAP;
    if (body.length > cap) body = body.slice(body.length - cap);   // keep the most recent exchange
    return 'You just finished a task for your Commander. From the WORK below, update what the station believes ' +
      'about them. Propose ONLY durable, evidenced belief changes — one per line, tagged with a dimension and ' +
      'ADD (a new belief) or RETIRE (a belief that now looks stale/shipped), plus a short VERBATIM evidence quote. Dimensions: goals, pain, ambition, ' +
      'stack, style, identity, standing_orders, people, schedule. Examples:\n' +
      'goals ADD: shipping a local-first agent harness | EVIDENCE: "ship the local-first harness"\n' +
      'style ADD: prefers terse, verified answers | EVIDENCE: "keep the answer terse and verify it"\n' +
      'goals RETIRE: ship the dossier | EVIDENCE: "the dossier is shipped"\n' +
      'Skip anything transient, guessed, or already known. If nothing changed, reply NONE.\n\n' +
      (block ? 'WHAT THE STATION ALREADY BELIEVES:\n' + block + '\n\n' : '') +
      (directive ? 'THE DIRECTIVE:\n' + directive + '\n\n' : '') +
      'THE WORK:\n' + body;
  }

  // parse the aux reply into { dim, kind:'add'|'retire', text } candidates; untagged / unknown-dim lines ignored.
  function parse(raw) {
    const out = [];
    for (const ln of String(raw == null ? '' : raw).split('\n')) {
      const m = LINE.exec(ln);
      if (!m) continue;
      const dim = canonDim(m[1]);
      if (!dim) continue;
      const kind = RETIRE_WORDS.has(String(m[2]).toLowerCase()) ? 'retire' : 'add';
      let text = m[3].trim(), evidence = '';
      const em = /\s*\|\s*EVIDENCE\s*[:\-—]\s*["“]?(.+?)["”]?\s*$/i.exec(text);
      if (em) { evidence = em[1].trim().replace(/^["“]|["”]$/g, ''); text = text.slice(0, em.index).trim(); }
      if (text) out.push({ dim: dim, kind: kind, text: text, evidence: evidence });
    }
    return out;
  }

  // read every existing belief's text out of a { dim: [{text}] } beliefs map (for dedup vs what's already known).
  function existingTexts(beliefs) {
    const out = [];
    if (!beliefs || typeof beliefs !== 'object') return out;
    for (const k of DIMS) {
      const arr = beliefs[k];
      if (!Array.isArray(arr)) continue;
      for (const b of arr) { const t = b && (typeof b === 'string' ? b : b.text); if (t) out.push(String(t).trim()); }
    }
    return out;
  }

  // study(run, opts) -> { proposals[], prompt }.
  //   run: { agentId, runId, directive, messages }
  //   opts: { propose(prompt)->text, clock:{now()}, redact(s)->s, beliefs:{dim:[{text}]}, declined:[text], max }
  //   proposals: { id, dim, kind:'add'|'retire', text, evidence, source:'study', sourceRunId, createdAt }
  // 'add' dedups vs existing beliefs + the declined denylist (Jaccard). 'retire' must MATCH an existing belief
  //   (you can't retire a belief the station doesn't hold) and is deduped only vs the declined list.
  async function study(run, opts) {
    run = run || {}; opts = opts || {};
    const clock = opts.clock || { now: () => 0 };
    const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
    const max = opts.max || DEFAULT_MAX;
    const propose = opts.propose;
    if (typeof propose !== 'function') return { proposals: [] };

    const prompt = buildPrompt({ directive: run.directive, messages: run.messages, dossierBlock: opts.dossierBlock });
    let raw;
    try { raw = await propose(prompt); } catch (_) { return { proposals: [], prompt: prompt }; }   // a failed study never hurts the run

    const beliefTexts = existingTexts(opts.beliefs);
    const evidenceHay = String(run.directive || '') + '\n' + (Array.isArray(run.messages) ? run.messages.map(m => (m && typeof m.content === 'string') ? m.content : '').join('\n') : '');
    const normEvidence = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
    const evidenceBlob = normEvidence(evidenceHay);
    /* ONLY THE COMMANDER'S OWN WORDS ARE SAID BACK AS THEIRS (2026-09-30). A quote found in a reply or a tool result is grounded — it
       really is in the run — but it is not «you said»: it falls back to the directive receipt below, stamped kind:'directive'. The
       spoken words are the directive and the run's USER turns (threadmine's user-only rule). */
    const spokenBlob = normEvidence(String(run.directive || '') + '\n' + (Array.isArray(run.messages) ? run.messages.filter(m => m && m.role === 'user').map(m => (typeof m.content === 'string') ? m.content : '').join('\n') : ''));
    const declined = (Array.isArray(opts.declined) ? opts.declined : []).map(t => String(t).trim()).filter(Boolean);
    const now = clock.now();
    const seen = {};                 // exact-text dedup within the batch (keyed dim+text)
    const acceptedTexts = [];        // near-dup dedup vs earlier accepted proposals in THIS batch
    const proposals = [];
    for (const cand of parse(raw)) {
      let text = redact(String(cand.text)).trim();
      if (text.length > MAX_CONTENT) text = text.slice(0, MAX_CONTENT - 1) + '…';
      if (!text) continue;
      let evidence = redact(String(cand.evidence || '')).trim();
      // New-format proposals must ground their quote in the real run. Old-format replies remain compatible and
      // fall back to the directive receipt while providers roll onto the stricter prompt.
      if (evidence && (evidence.length < 6 || evidenceBlob.indexOf(normEvidence(evidence)) < 0)) continue;
      if (evidence && spokenBlob.indexOf(normEvidence(evidence)) < 0) evidence = '';   // in the run, but not in the Commander's words
      const spoken = !!evidence;
      // FALLBACK GROUNDING: no located quote → cite the run's DIRECTIVE instead, stamped kind:'directive' below so
      // the card never presents a (possibly machine-composed) task as the Commander's own speech. A cut directive
      // ends in an ellipsis so the quote can never read as a complete sentence the Commander never finished.
      if (!evidence) {
        const dir = (typeof run.directive === 'string' && run.directive) ? String(run.directive) : '';
        evidence = dir.length > 140 ? (dir.slice(0, 139) + '…') : dir;
      }
      if (lowValue(text)) continue;                       // trivia / run-narration floor
      const key = cand.dim + '::' + text.toLowerCase();
      if (seen[key]) continue;
      // permanently-declined (studyDeclined denylist): never re-propose a belief the Commander rejected.
      let killed = false;
      for (const d of declined) { if (jaccard(d, text) >= SIM_THRESHOLD) { killed = true; break; } }
      if (killed) continue;
      if (cand.kind === 'add') {
        // an ADD the station already believes (exact or paraphrase) is redundant — drop it.
        let dup = false;
        for (const bt of beliefTexts) { if (bt.toLowerCase() === text.toLowerCase() || jaccard(bt, text) >= SIM_THRESHOLD) { dup = true; break; } }
        if (dup) continue;
      } else {
        // a RETIRE must reference a belief the station ACTUALLY holds (evidence of what's being retired). Without a
        // match it's a hallucinated retraction — drop it (you can't retire what isn't there).
        let matches = false;
        for (const bt of beliefTexts) { if (jaccard(bt, text) >= SIM_THRESHOLD) { matches = true; break; } }
        if (!matches) continue;
      }
      // near-dup vs earlier accepted proposals in this batch (a reworded repeat).
      let near = false;
      for (const at of acceptedTexts) { if (jaccard(at, text) >= SIM_THRESHOLD) { near = true; break; } }
      if (near) continue;
      seen[key] = 1; acceptedTexts.push(text);
      proposals.push({
        id: 'study_' + (proposals.length + 1), dim: cand.dim, kind: cand.kind, text: text,
        evidence: evidence.slice(0, 280), evidenceRef: { runId: run.runId || null, kind: spoken ? 'verbatim' : 'directive' },
        source: 'study', sourceRunId: run.runId || null, createdAt: now
      });
      if (proposals.length >= max) break;
    }
    return { proposals: proposals, prompt: prompt };
  }

  // ---- RATINGS → TASTE (mission §4): consecutive 👍/👎 on the same archetype mints ONE style-dim study proposal.
  // Pure decision over a persisted per-archetype tally { archetype: { up, down, upMinted, downMinted } }. The host
  // (studystore.js) supplies the archetype + verdict + the tally; this returns a proposal to raise (or null), and
  // the caller marks the archetype minted so it can never re-mint (once per archetype ever, per direction). ----
  const STREAK_N = 3;   // three consecutive same-direction verdicts on one archetype = a real taste signal
  // fold one verdict into a tally entry, resetting the OTHER direction's streak (consecutive, not cumulative).
  function foldRating(entry, verdict) {
    const e = entry || { up: 0, down: 0, upMinted: false, downMinted: false };
    if (verdict === 'great') { e.up = (e.up || 0) + 1; e.down = 0; }
    else if (verdict === 'miss') { e.down = (e.down || 0) + 1; e.up = 0; }
    else { e.up = 0; e.down = 0; }   // 'ok' (👌) breaks BOTH streaks — it's neither a like nor a dislike
    return e;
  }
  // given an archetype + its (already-folded) tally entry, mint ONE style proposal iff a fresh 3-streak crossed
  // and that direction hasn't minted before. Returns { proposal, mintedKey } or null.
  function tasteProposal(archetype, entry, clock) {
    if (!archetype || !entry) return null;
    const now = (clock && clock.now) ? clock.now() : 0;
    if ((entry.up || 0) >= STREAK_N && !entry.upMinted) {
      return { mintedKey: 'upMinted', proposal: {
        id: 'taste_up_' + archetype, dim: 'style', kind: 'add',
        text: 'Commander consistently likes ' + archetype + ' work — lean into it.',
        evidence: STREAK_N + ' consecutive 👍 on ' + archetype, source: 'study', sourceRunId: null, createdAt: now
      } };
    }
    if ((entry.down || 0) >= STREAK_N && !entry.downMinted) {
      return { mintedKey: 'downMinted', proposal: {
        id: 'taste_down_' + archetype, dim: 'style', kind: 'add',
        text: 'Commander has been unhappy with ' + archetype + ' work — take extra care there (verify before turning it in).',
        evidence: STREAK_N + ' consecutive 👎 on ' + archetype, source: 'study', sourceRunId: null, createdAt: now
      } };
    }
    return null;
  }

  // classify a run's DIRECTIVE into a coarse, stable work "archetype" label — the streak key for the taste path.
  // Deliberately simple + deterministic (keyword buckets, first match wins) so the same kind of ask always tallies
  // to the same bucket. 'general' is the honest fallback (an unclassifiable ask still streaks as 'general work').
  const ARCH_BUCKETS = [
    { id: 'writing',  re: /\b(write|writing|draft|email|blog|post|copy|essay|article|letter|caption|script|newsletter)\b/i },
    { id: 'coding',   re: /\b(code|coding|debug|refactor|function|bug|script|api|test|compile|deploy|program|implement)\b/i },
    { id: 'research', re: /\b(research|find|search|look up|investigate|compare|summariz|analyz|explore|gather)\b/i },
    { id: 'planning', re: /\b(plan|planning|schedule|organiz|outline|roadmap|strategy|prioriti|breakdown|steps)\b/i },
    { id: 'design',   re: /\b(design|layout|mockup|ui|ux|style|palette|logo|graphic|visual|wireframe)\b/i },
    { id: 'data',     re: /\b(data|spreadsheet|csv|table|chart|graph|metric|number|calculate|report|dashboard)\b/i }
  ];
  function classifyArchetype(directive) {
    const s = String(directive == null ? '' : directive);
    for (const b of ARCH_BUCKETS) if (b.re.test(s)) return b.id;
    return 'general';
  }

  // near-dup helper exposed so studystore can dedup a taste/study proposal vs the live studyDeclined list too.
  function isDeclined(text, declined) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return false;
    for (const d of (Array.isArray(declined) ? declined : [])) { if (jaccard(String(d), t) >= SIM_THRESHOLD) return true; }
    return false;
  }

  /* ---- THE BEAT SLOT — a COMPATIBILITY SHIM. The real arbiter lives elsewhere now. ----

     WHERE THE TRUTH IS (as of the recommendation spine, 2026-08-03):
       • frontend/app/recommend.js — THE RELEVANCE BAR. Pure scorer + one-voice arbiter over every proactive
         channel (memory > study > arc > trust > thread > rate > suggest > seed > routine > recruit >
         curiosity). It also enforces evidence-or-silence: a candidate that cannot cite real state is dropped.
       • frontend/app/beatcard.js — THE SLOT MACHINERY. One visible beat, reservations, run dedupe, FIFO
         deferral, expiry/vanish, and the generation tokens that make late async completions inert.
       • frontend/app/chat.js — recommendPass(): ONE agent.run.end listener, ONE arm point. Every channel
         offers a candidate built from its own sync predicate; the spine picks one; that channel's existing
         render path fires. Nothing else arms a proactive beat.

     This function is kept ONLY so older callers and the focused study.test slot suite keep exercising the
     shared arbiter: it returns beatcard.js's makeSlot() unchanged. The 4-kind state machine this comment
     used to describe (visible ∈ {null,'memory','study','arc'} + a hand-rolled pendingMemory set) no longer
     exists here — it was absorbed into beatcard.js's generic priority slot. MEMORY STILL WINS: reflection
     reserves 'memory' the moment memory.proposed arrives (before its fetch), and every lower-priority
     candidate stands down while that reservation is held.

     DO NOT re-add arbitration logic to this file. study.js is a PURE ENGINE (parse / salience / dedup /
     ratings-taste / archetype); who speaks is not its job. */
  function makeBeatSlot() {
    const shared = BeatCard || (typeof globalThis !== 'undefined' && globalThis.BeatCard);
    if (!shared || typeof shared.makeSlot !== 'function') throw new Error('BeatCard must load before Study.makeBeatSlot');
    return shared.makeSlot();
  }

  return {
    study, buildPrompt, parse, studySalient, usedTools, lowValue, canonDim, jaccard,
    foldRating, tasteProposal, isDeclined, existingTexts, classifyArchetype, makeBeatSlot,
    DIMS, STREAK_N, SIM_THRESHOLD, DEFAULT_MAX
  };
});
