/* sidecar/questrefresh.js — the PURE quest-refresh engine (QUEST V3: the standing 24h refresh).

   WHY THIS EXISTS — the V2 ledger made quests honest (contract-owned completion, agent minting) but left
   generation PASSIVE: agents mint only mid-run, only when the doctrine's high bar is met, so in practice a
   real save can sit for days with the same quest slate and an empty ledger. The Commander's ambitions are
   supposed to DRIVE the station: quests are the concrete next steps toward the long-term goal they're
   actually chasing. This engine makes that a standing harness behavior:

     · every REFRESH_EVERY_MS (24h) a refresh cycle is due, unconditionally — the slate never goes stale; and
     · when the Commander CATCHES UP (zero open ledger quests) a refresh is due after a short cooldown —
       finishing your quests is rewarded with fresh direction, not a day of silence.

   THE NORTH STAR — each cycle's first job is to name the Commander's LONG-TERM GOAL: confirmed from the
   active goal arc when one exists (user-set always outranks inferred), else inferred from the dossier +
   real activity, grounded in that evidence. It persists in this engine's state, is re-shown to the model
   next cycle (revise only on real evidence), and every proposed quest must be a step TOWARD it.

   PROPOSE-AND-VALIDATE, NEVER TRUST: the model's reply is parsed HARD — contract rule enforced (a quest
   without a valid completion contract is dropped; 'run' is not in this engine's vocabulary because a
   refresh has no run to bind), prop keys clamp to the real placeable vocabulary, titles dedup against the
   open slate and the dismissed-forever denylist, groundedIn must cite the evidence corpus shown. What
   survives goes through questStore.mint — so the store's own dedup/denylist/caps hold a second time.

   DETERMINISM SPLIT (mirrors scout.js / nightshift.js): pure transforms over (state, args) with `now`
   injected — no Date.now / Math.random / fs / network (lint-determinism-clean, headless-testable). The
   ambient half (the aux model call, the durable file, the tick timer, the route) lives ONLY in
   sidecar/index.js.

   THE STATE (one workspaces JSON, persisted by the host):
     { v, northStar: null|{ text, groundedIn, at, source:'goal'|'model' },
       lastCycleAt, lastMintAt, ledger: [ { at, outcome, reason, title? } ] } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).questRefresh = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_VERSION = 1;
  const REFRESH_EVERY_MS = 24 * 3600000;      // the standing daily cadence — a slate is never older than this
  const CAUGHT_UP_GAP_MS = 60 * 60000;        // caught-up fast path: zero open quests re-earns a cycle after 1h
  const MATERIAL_CHANGE_GAP_MS = 5 * 60000; // coalesce goal/outcome/feedback changes before another paid pass
  const MAX_MINTS_PER_CYCLE = 3;              // a refresh proposes AT MOST 3 step-quests (the store's own
                                              //   ≤3-open-generated cap for the station scope matches this)
  const LEDGER_CAP = 50;                      // the visible "what the refresher tried and why" trail
  const NORTH_STAR_MAX = 280;                 // same bound as the goal-arc text (commanderGoals)
  const TITLE_MAX = 80, DESC_MAX = 300, REWARD_MAX = 120, WHY_MAX = 200, KEY_MAX = 200;
  const MIN_FACT_KEY = 4;                     // mirrors questsweeps.MIN_FACT_KEY — a shorter fact key can never sweep
  const MAX_STEPS = 4;
  // SLATE-FULL guard: quest-store caps OPEN kind:'generated' quests at 3 PER SCOPE, and a refresh mints
  // station-wide (agentId null). At that ceiling every mint a refresh proposes is rejected 'max open
  // generated quests' — so a cycle at cap spends a model call for a foregone-rejected result, every time.
  // This mirrors the store's OPEN_GENERATED_CAP so the ambient half can SKIP the paid call and say so.
  const OPEN_GENERATED_CAP = 3;

  // contract vocabulary this engine may mint. 'run' is deliberately absent (nothing to bind), and 'attest'
  // is the fallback for outcomes only the Commander can verify.
  const CONTRACT_TYPES = ['prop', 'artifact', 'fact', 'attest'];
  const DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];

  const str = (v) => (v == null ? '' : String(v));
  /* THE SESSIONS A STAR OR A STAGED QUEST WAS INFERRED FROM (turn identity commit 12): the quote stamp rows carry - the streams (<= 32, or the
     saturated '*') of the activity lines the cycle's prompt held, with the time each was read. The forget registry drops what quotes a deleted session. */
  function stampOf(raw) {
    const quotes = raw && Array.isArray(raw.quotes) ? raw.quotes.map(str).filter(Boolean).slice(0, 32) : [];
    if (!quotes.length) return {};
    const at = Array.isArray(raw.quotesAt) ? raw.quotesAt : [];
    return { quotes, quotesAt: quotes.map((_, i) => (Number.isSafeInteger(at[i]) && at[i] >= 0 ? at[i] : 0)) };
  }
  // normalized title key (the quest-store normTitle idiom) — dedup vs open slate + denylist.
  const norm = (s) => str(s).toLowerCase().replace(/\s+/g, ' ').trim();

  const DECLINED_NS_CAP = 20;                // FIFO cap on the declined-inference denylist (never re-propose these)

  function fresh() {
    return { v: STATE_VERSION, northStar: null, proposedNorthStar: null, pendingQuests: [], declinedNorthStars: [], lastCycleAt: 0, lastMintAt: 0, contextKey: '', ledger: [] };
  }

  // clamp one raw north-star-ish object into the stored shape (or null). `defStatus` is what an unstamped
  // record hydrates as: the ADOPTED star defaults to 'adopted', a proposal to 'proposed'.
  function normStar(raw, defStatus) {
    if (!(raw && typeof raw === 'object' && str(raw.text).trim())) return null;
    return {
      text: str(raw.text).slice(0, NORTH_STAR_MAX),
      groundedIn: str(raw.groundedIn).slice(0, WHY_MAX),
      at: Number.isFinite(raw.at) ? Math.floor(raw.at) : 0,
      source: raw.source === 'goal' ? 'goal' : 'model',
      status: raw.status === 'proposed' ? 'proposed' : (defStatus || 'adopted'),
      ...stampOf(raw)
    };
  }

  // tolerant hydrate: clamp everything; a corrupt/partial save degrades per-field, never throws.
  function normalize(raw) {
    const s = fresh();
    if (raw && typeof raw === 'object') {
      s.contextKey = str(raw.contextKey).slice(0, 200);
      s.northStar = normStar(raw.northStar, 'adopted');
      if (s.northStar) s.northStar.status = 'adopted';                 // the adopted slot is always adopted
      const prop = normStar(raw.proposedNorthStar, 'proposed');
      s.proposedNorthStar = prop ? Object.assign(prop, { status: 'proposed', source: 'model' }) : null;
      if (Array.isArray(raw.pendingQuests)) s.pendingQuests = raw.pendingQuests.slice(0, MAX_MINTS_PER_CYCLE).map(q => ({
        title: str(q && q.title).slice(0, TITLE_MAX), desc: str(q && q.desc).slice(0, DESC_MAX), reward: str(q && q.reward).slice(0, REWARD_MAX),
        contract: q && q.contract && CONTRACT_TYPES.indexOf(q.contract.type) >= 0 ? { type: q.contract.type, key: str(q.contract.key).slice(0, KEY_MAX) } : null,
        steps: Array.isArray(q && q.steps) ? q.steps.slice(0, MAX_STEPS).map((st, i) => ({ key: str(st && st.key) || ('s' + (i + 1)), label: str(st && st.label).slice(0, 80) })) : [],
        executionMode: ['agent', 'commander', 'together'].includes(q && q.executionMode) ? q.executionMode : (q && q.contract && q.contract.type === 'attest' ? 'commander' : 'agent'),
        whyNow: str(q && q.whyNow).slice(0, 300),
        groundedIn: str(q && q.groundedIn).slice(0, WHY_MAX),
        domain: DOMAINS.indexOf(str(q && q.domain).toLowerCase()) >= 0 ? str(q.domain).toLowerCase() : null,
        ...stampOf(q)
      })).filter(q => q.title && q.contract);
      if (Array.isArray(raw.declinedNorthStars)) {
        s.declinedNorthStars = raw.declinedNorthStars.map(t => norm(t)).filter(Boolean).slice(-DECLINED_NS_CAP);
      }
      if (Number.isFinite(raw.lastCycleAt) && raw.lastCycleAt >= 0) s.lastCycleAt = Math.floor(raw.lastCycleAt);
      if (Number.isFinite(raw.lastMintAt) && raw.lastMintAt >= 0) s.lastMintAt = Math.floor(raw.lastMintAt);
      if (Array.isArray(raw.ledger)) {
        s.ledger = raw.ledger.filter(e => e && typeof e === 'object')
          .slice(-LEDGER_CAP)
          .map(e => ({ at: Number.isFinite(e.at) ? Math.floor(e.at) : 0, outcome: str(e.outcome), reason: str(e.reason).slice(0, 200), title: str(e.title).slice(0, 60), ...stampOf(e) }));
      }
    }
    return s;
  }

  /* decide — is a refresh cycle due NOW? Named bindings for the ledger/status read (most "not yet" first).
     inp = { now, openCount } — openCount is the number of OPEN quests in the harness ledger (station-wide
     view: the caught-up signal is "the Commander finished everything", not one agent's slice). */
  function decide(state, inp) {
    const now = Number(inp && inp.now) || 0;
    const s = normalize(state);
    const openCount = Math.max(0, Number(inp && inp.openCount) || 0);
    if (inp && inp.contextKey && inp.contextKey !== s.contextKey && now - s.lastCycleAt >= MATERIAL_CHANGE_GAP_MS) return { fire: true, why: 'progress-changed', binding: null };
    if (now - s.lastCycleAt >= REFRESH_EVERY_MS) return { fire: true, why: 'daily', binding: null };
    // CAUGHT-UP rewards PROGRESS, never idleness (sweep 2026-09-29): an empty slate whose context has not moved since
    // the last cycle (the planner said NONE, or every proposal failed validation, and nothing happened since) must not
    // re-buy the same answer every hour — with PROPOSE as the new-station default that was a paid call per hour on
    // every idle open station. Finishing quests changes the context, so real catching-up still earns a cycle here.
    const contextMoved = !(inp && inp.contextKey) || inp.contextKey !== s.contextKey;
    if (openCount === 0 && contextMoved && now - s.lastCycleAt >= CAUGHT_UP_GAP_MS) return { fire: true, why: 'caught-up', binding: null };
    return { fire: false, why: null, binding: openCount === 0 ? 'gap' : 'cooldown' };
  }

  // slate-full: are there already OPEN_GENERATED_CAP open station-wide generated quests? At/over the ceiling a
  // refresh cycle can mint nothing new (the store rejects every one) — the ambient half must skip the paid model
  // call and record an honest 'slate full' outcome instead of a rejected-mint trail nobody asked for.
  function slateFull(openGeneratedCount) {
    return (Math.max(0, Number(openGeneratedCount) || 0)) >= OPEN_GENERATED_CAP;
  }

  // does the station know ANYTHING worth grounding a refresh on? A cold save (no goal, no star, empty
  // dossier, no activity, no interests) should SKIP the model call and say so — never pay to guess.
  function hasEvidence(ctx) {
    ctx = ctx || {};
    return !!(str(ctx.goalNote).trim() || (ctx.northStar && str(ctx.northStar.text).trim())
      || str(ctx.dossierBlock).trim() || str(ctx.activityBlock).trim() || str(ctx.interestsBlock).trim()
      || (ctx.progress && ((ctx.progress.metrics || []).length || (ctx.progress.outcomes || []).length)));
  }

  // Bind a paid planning pass to the exact direction and milestone it was shown.
  function goalBinding(goal) {
    return JSON.stringify(goal ? [goal.id || null, str(goal.text), goal.milestoneId || null, goal.next || null, goal.done || 0, goal.total || 0] : null);
  }

  // Bounded, provenance-labelled evidence from the durable Journey and quest ledgers.
  function progressContext(journey, quests, goal) {
    const j = journey || {}, goalId = goal && goal.id;
    const registered = (Array.isArray(j.goals) ? j.goals : []).find(g => g.id === goalId);
    const goalContext = registered ? { id: registered.id, text: registered.text, successCondition: registered.successCondition, status: registered.status } : null;
    const relevant = x => !goalId || x.goalId === goalId;
    const metrics = (j.metrics || []).filter(m => m.status === 'active' && relevant(m)).slice(0, 8)
      .map(m => ({ label: m.label, unit: m.unit, baseline: m.baseline, target: m.target, current: m.current, history: (m.history || []).slice(-5) }));
    const outcomes = (j.outcomes || []).filter(relevant).slice(-8)
      .map(o => ({ title: o.title, evidence: o.evidence, verifiedBy: o.verifiedBy, at: o.at }));
    const feedback = (quests || []).filter(q => q.disposition || q.declineNote || q.stalledAt != null).slice(-12)
      .map(q => ({ title: q.title, disposition: q.disposition, declineNote: q.declineNote, stalledReason: q.stalledReason }));
    return { goal: goalContext, metrics, outcomes, feedback };
  }

  /* ---- the refresh directive. ctx = { goalNote, northStar:{text,groundedIn}|null, dossierBlock,
     activityBlock, interestsBlock, openQuests:[{title,contract:{type}}], completedQuests:[{title}],
     deniedTitles:[..], propKeys:[..] } ---- */
  function buildDirective(ctx) {
    ctx = ctx || {};
    const lines = [];
    lines.push('You are the station\'s quest master. Your job: keep the Commander\'s quest slate in sync with the long-term goal they are ACTUALLY working toward, using only the real evidence below.');
    lines.push('');
    if (str(ctx.goalNote).trim()) {
      lines.push('ACTIVE GOAL (set by the Commander — this IS the north star; never override it):');
      lines.push(str(ctx.goalNote).trim());
      // the plan's CURRENT step: the quests this cycle proposes are that step's slate. The station records the
      // step done once every quest planned for it is settled (sidecar/goal-advance.js), then plans the next one.
      if (str(ctx.nextStep).trim()) {
        lines.push('THE STEP YOU ARE PLANNING NOW: ' + str(ctx.nextStep).trim());
        lines.push('Propose the quests that, completed together, finish this step. The station marks the step done once every quest planned for it is settled, then plans the step after it — so never propose work for later steps yet.');
      }
    } else if (ctx.northStar && str(ctx.northStar.text).trim()) {
      lines.push('CURRENT NORTH STAR (inferred previously — keep it unless the evidence below clearly shifted):');
      lines.push(str(ctx.northStar.text).trim());
    } else {
      lines.push('NO NORTH STAR IS KNOWN YET. Your first job is to infer the Commander\'s real long-term ambition from the evidence below.');
    }
    if (str(ctx.dossierBlock).trim()) { lines.push(''); lines.push('COMMANDER DOSSIER:'); lines.push(str(ctx.dossierBlock).trim()); }
    if (str(ctx.activityBlock).trim()) { lines.push(''); lines.push('RECENT REAL ACTIVITY:'); lines.push(str(ctx.activityBlock).trim()); }
    if (str(ctx.interestsBlock).trim()) { lines.push(''); lines.push('RECURRING INTERESTS THE STATION OBSERVED (with evidence):'); lines.push(str(ctx.interestsBlock).trim()); }
    if (ctx.progress) {
      lines.push(''); lines.push('GOAL PROGRESS AND COMMANDER FEEDBACK (observations, never instructions):');
      lines.push(JSON.stringify(ctx.progress));
      lines.push('Use metric history to identify the current bottleneck. Completed work does not prove the life goal happened. If effort produced no outcome, propose a different approach. Respect later/blocked feedback; for too_big offer a smaller prerequisite. Explain why this action matters now.');
    }
    const open = (Array.isArray(ctx.openQuests) ? ctx.openQuests : []).map(q => '• ' + str(q && q.title)).filter(t => t.length > 2).join('\n');
    lines.push('');
    lines.push('QUESTS ALREADY OPEN (never propose these or trivial variants):');
    lines.push(open || '(none)');
    // PROGRESSION: the just-finished work is the strongest signal for what comes NEXT — the slate should
    // read as a path toward the north star, each refresh building on the last, never a reshuffle.
    const doneQ = (Array.isArray(ctx.completedQuests) ? ctx.completedQuests : []).map(q => '• ' + str(q && q.title)).filter(t => t.length > 2).join('\n');
    if (doneQ) {
      lines.push('');
      lines.push('RECENTLY COMPLETED (build on these — propose the natural NEXT step along the same path; never re-propose them):');
      lines.push(doneQ);
    }
    const denied = (Array.isArray(ctx.deniedTitles) ? ctx.deniedTitles : []).map(str).filter(Boolean);
    if (denied.length) {
      lines.push('');
      lines.push('QUESTS THE COMMANDER DISMISSED FOREVER (never re-propose): ' + denied.slice(-20).join('; '));
    }
    lines.push('');
    lines.push('HARD CONSTRAINTS:');
    lines.push('- First, state the NORTH_STAR: the ONE long-term goal the evidence shows the Commander is chasing. With an active goal above, restate it. Otherwise infer it — and ground it in the evidence.');
    lines.push('- Then propose 1-' + MAX_MINTS_PER_CYCLE + ' quests, each a CONCRETE NEXT STEP toward the north star that no open quest already covers. Fewer is better; never pad with busywork or generic chores.');
    lines.push('- Every quest MUST declare exactly one completion CONTRACT the harness can honestly verify:');
    lines.push('    prop <key>        — a station capability goes live. Keys allowed: ' + (Array.isArray(ctx.propKeys) && ctx.propKeys.length ? ctx.propKeys.join(', ') : 'compute') + '.');
    lines.push('    artifact <path>   — a named deliverable file exists in the workspace (workspace-relative path).');
    lines.push('    fact <phrase>     — the harness learns this concrete fact about the Commander (a short phrase that would appear verbatim in a saved memory).');
    lines.push('    attest            — for real-world outcomes only the Commander can verify; an agent proposes, the Commander confirms.');
    lines.push('- EXECUTION names who acts: commander (real-world action), agent (delegated work), or together. Real-world practice, attendance, conversations, and habits use attest; creating a plan never proves the person performed it.');
    lines.push('- DOMAIN names the closest mastery track. It never changes completion authority and only counts after verified completion.');
    lines.push('- WHY must cite the REAL evidence above (the dossier line, activity, or goal that motivates the quest) — never a generic pitch.');
    lines.push('- If the open slate above already covers every sensible next step, reply with exactly: NONE');
    lines.push('');
    lines.push('REPLY IN EXACTLY THIS FORMAT (the QUEST block may repeat up to ' + MAX_MINTS_PER_CYCLE + ' times; STEPS is optional):');
    lines.push('NORTH_STAR: <one line — the long-term goal>');
    lines.push('QUEST: <imperative title, 2-8 words>');
    lines.push('DESC: <one sentence — what doing it looks like>');
    lines.push('REWARD: <the real outcome it unlocks — never points>');
    lines.push('EXECUTION: <commander | agent | together>');
    lines.push('WHY_NOW: <the current bottleneck or prerequisite this action addresses>');
    lines.push('DOMAIN: <building | research | writing | growth | operations | creative | planning | support>');
    lines.push('CONTRACT: <prop <key> | artifact <path> | fact <phrase> | attest>');
    lines.push('STEPS: <2-' + MAX_STEPS + ' short steps, separated by ; >');
    lines.push('WHY: <one sentence citing the evidence above>');
    return lines.join('\n');
  }

  // parse ONE "CONTRACT:" value into a store-valid {type,key} or null. "prop dish" / "artifact out/plan.md"
  // / "fact ships video weekly" / "attest". Prop keys clamp to the allowed vocabulary (case-insensitive).
  function parseContract(value, propKeys) {
    const v = str(value).trim();
    const m = /^([a-z]+)\s*(.*)$/i.exec(v);
    if (!m) return null;
    const type = m[1].toLowerCase();
    let key = str(m[2]).trim().slice(0, KEY_MAX);
    if (CONTRACT_TYPES.indexOf(type) < 0) return null;
    if (type === 'attest') return { type: 'attest', key: '' };
    if (!key) return null;
    if (type === 'prop') {
      const allowed = (Array.isArray(propKeys) ? propKeys : []).map(k => norm(k)).filter(Boolean);
      if (allowed.indexOf(norm(key)) < 0) return null;   // an unplaceable prop key is an UNCOMPLETABLE quest — reject
      key = norm(key);
    }
    if (type === 'fact' && norm(key).length < MIN_FACT_KEY) return null;   // could never sweep — uncompletable
    return { type: type, key: key };
  }

  /* parse — parse + VALIDATE HARD. opts = { openTitles:[..], deniedTitles:[..], propKeys:[..], grounding? }.
     Returns { none:true } (explicit NONE), or { northStar: {text}|null, quests: [validated…] } — quests may
     legitimately be empty when every proposed block failed validation (the caller ledgers that honestly).
     `grounding`: the evidence corpus shown to the model — each quest's WHY must share a token with it
     (the scout's invented-pitch guard), so an ungrounded quest dies here, never on the slate. */
  function parse(text, opts) {
    opts = opts || {};
    const raw = str(text);
    if (/^\s*NONE\s*$/im.test(raw) && !/^\s*QUEST\s*:/im.test(raw)) {
      const nsOnly = grabFrom(raw, 'NORTH_STAR');
      return { none: true, northStar: nsOnly ? { text: nsOnly.slice(0, NORTH_STAR_MAX) } : null };
    }

    const northRaw = grabFrom(raw, 'NORTH_STAR');
    const northStar = northRaw ? { text: northRaw.slice(0, NORTH_STAR_MAX) } : null;

    // split into QUEST blocks: everything from one "QUEST:" line to the next.
    const blocks = [];
    const re = /^[^\S\r\n]*QUEST[^\S\r\n]*:/gim;
    const starts = [];
    let m;
    while ((m = re.exec(raw)) !== null) starts.push(m.index);
    for (let i = 0; i < starts.length; i++) blocks.push(raw.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : raw.length));

    const grounding = str(opts.grounding).toLowerCase();
    const seenTitles = (Array.isArray(opts.openTitles) ? opts.openTitles : []).map(norm).filter(Boolean);
    const denied = (Array.isArray(opts.deniedTitles) ? opts.deniedTitles : []).map(norm).filter(Boolean);
    const quests = [];
    for (const block of blocks) {
      if (quests.length >= MAX_MINTS_PER_CYCLE) break;
      const title = grabFrom(block, 'QUEST').slice(0, TITLE_MAX);
      const desc = grabFrom(block, 'DESC').slice(0, DESC_MAX);
      const reward = grabFrom(block, 'REWARD').slice(0, REWARD_MAX);
      const domainRaw = grabFrom(block, 'DOMAIN').toLowerCase();
      const domain = DOMAINS.indexOf(domainRaw) >= 0 ? domainRaw : null;
      const why = grabFrom(block, 'WHY').slice(0, WHY_MAX);
      const contract = parseContract(grabFrom(block, 'CONTRACT'), opts.propKeys);
      if (!title || !why || !contract) continue;              // load-bearing fields — a partial block is malformed
      const nt = norm(title);
      if (!nt || seenTitles.indexOf(nt) >= 0 || denied.indexOf(nt) >= 0) continue;   // dup / dismissed-forever
      if (grounding) {                                        // WHY grounding (the invented-pitch guard)
        const toks = why.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4);
        if (toks.length && !toks.some(t => grounding.indexOf(t) !== -1)) continue;
      }
      const steps = grabFrom(block, 'STEPS').split(';').map(s => s.trim()).filter(Boolean).slice(0, MAX_STEPS)
        .map((label, i) => ({ key: 's' + (i + 1), label: label.slice(0, 80) }));
      const mode = grabFrom(block, 'EXECUTION').toLowerCase();
      if (mode === 'commander' && contract.type !== 'attest') continue; // real-world actions require Commander evidence
      seenTitles.push(nt);                                    // an earlier accepted block counts as open too
      quests.push({ executionMode: ['commander', 'agent', 'together'].includes(mode) ? mode : (contract.type === 'attest' ? 'commander' : 'agent'), whyNow: grabFrom(block, 'WHY_NOW').slice(0, 300), title: title, desc: desc, reward: reward, domain: domain, contract: contract, steps: steps, groundedIn: why });
    }
    return { none: false, northStar: northStar, quests: quests };
  }

  // same-line field grab (the prospect.js/scout.js idiom — horizontal-whitespace classes so an EMPTY field
  // never swallows the next line).
  function grabFrom(block, label) {
    const m = new RegExp('^[^\\S\\r\\n]*' + label + '[^\\S\\r\\n]*:[^\\S\\r\\n]*([^\\r\\n]*?)[^\\S\\r\\n]*$', 'im').exec(str(block));
    return m ? m[1].trim() : '';
  }

  /* ---- reducers (pure: input never mutated; each returns a NEW state) ---- */

  // ledger append, capped. Every cycle outcome — minted, rejected, none, error, no-credential — is recorded,
  // so the refresher's activity is INSPECTABLE (the anti-silent-no-mint law, inherited from the scout lane).
  function note(state, entry, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state);
    const e = { at: now, outcome: str(entry && entry.outcome), reason: str(entry && entry.reason).slice(0, 200), title: str(entry && entry.title).slice(0, 60), ...stampOf(entry) };
    return Object.assign({}, s, { ledger: s.ledger.concat([e]).slice(-LEDGER_CAP) });
  }

  /* drop(state, match) -> { state, removed }: the forget registry's purge. `match(item)` names what quotes a deleted session: the proposed
     star, an adopted INFERRED star (the Commander's own goal-arc star carries no stamp and stays), staged quests and ledger notes. The
     declined-inference denylist holds normalized text the Commander rejected and stays (a rejected direction must not come back). Pure. */
  function drop(state, match) {
    const s = normalize(state);
    let removed = 0;
    const next = Object.assign({}, s);
    if (s.proposedNorthStar && match(s.proposedNorthStar)) { next.proposedNorthStar = null; removed++; }
    if (s.northStar && s.northStar.source === 'model' && match(s.northStar)) { next.northStar = null; removed++; }
    next.pendingQuests = s.pendingQuests.filter(q => !match(q));
    next.ledger = s.ledger.filter(e => !match(e));
    removed += (s.pendingQuests.length - next.pendingQuests.length) + (s.ledger.length - next.ledger.length);
    return { state: removed ? next : s, removed };
  }

  // a cycle ATTEMPT spends the cadence whatever its outcome — the refresher tried; it must not hammer the
  // model every tick. (Both the daily clock and the caught-up cooldown key off lastCycleAt.)
  function stampCycle(state, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state);
    return Object.assign({}, s, { lastCycleAt: now, contextKey: opts && opts.contextKey ? str(opts.contextKey).slice(0, 200) : s.contextKey });
  }

  function stampMint(state, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state);
    return Object.assign({}, s, { lastMintAt: now });
  }

  // ADOPT the north star (status 'adopted'): a Commander-goal restatement (source 'goal', always wins) or a
  // CONFIRMED inference. Empty text is a no-op (never blank an existing star). A goal adoption also SUPERSEDES
  // any pending inference proposal — the Commander's own goal outranks a guess, so the guess is dropped.
  function setNorthStar(state, ns, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state);
    const text = str(ns && ns.text).trim().slice(0, NORTH_STAR_MAX);
    if (!text) return s;
    const source = (ns && ns.source) === 'goal' ? 'goal' : 'model';
    const next = Object.assign({}, s, {
      northStar: { text: text, groundedIn: str(ns && ns.groundedIn).slice(0, WHY_MAX), at: now, source: source, status: 'adopted', ...stampOf(ns) }
    });
    if (source === 'goal') next.proposedNorthStar = null;   // a real goal supersedes a pending inference
    return next;
  }

  // the EFFECTIVE north star the panel shows + the directive grounds on: a pending PROPOSAL (labelled
  // 'proposed'/unconfirmed) takes visual precedence over the last adopted one, else the adopted star, else null.
  // Truthful telemetry: the status flag is what lets the UI say "unconfirmed" instead of asserting adoption.
  function effectiveNorthStar(state) {
    const s = normalize(state);
    return s.proposedNorthStar || s.northStar || null;
  }

  // PROPOSE an inferred north star (propose-and-confirm, never silent adoption). No-ops when: text is empty; it
  // matches the already-ADOPTED star (a re-affirmation needs no confirm); it was DECLINED before (never
  // re-propose); or an identical proposal is already pending (don't reset its stamp / re-beat). Otherwise stashes
  // it as the pending proposal — the cycle may still ground on it, but the UI labels it unconfirmed until a verdict.
  function proposeNorthStar(state, ns, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state);
    const text = str(ns && ns.text).trim().slice(0, NORTH_STAR_MAX);
    if (!text) return s;
    const nt = norm(text);
    if (s.northStar && norm(s.northStar.text) === nt) return s;                 // already the adopted star — no proposal
    if (s.declinedNorthStars.indexOf(nt) >= 0) return s;                        // declined forever — never re-propose
    if (s.proposedNorthStar && norm(s.proposedNorthStar.text) === nt) return s; // same proposal already pending — keep it
    return Object.assign({}, s, {
      proposedNorthStar: { text: text, groundedIn: str(ns && ns.groundedIn).slice(0, WHY_MAX), at: now, source: 'model', status: 'proposed', ...stampOf(ns) }
    });
  }

  // CONFIRM the pending proposal → it becomes the adopted star (Commander said "yes, that's my direction").
  // No pending proposal = no-op.
  function confirmNorthStar(state, opts) {
    const now = Number(opts && opts.now) || 0;
    const s = normalize(state);
    if (!s.proposedNorthStar) return s;
    return Object.assign({}, s, {
      northStar: { text: s.proposedNorthStar.text, groundedIn: s.proposedNorthStar.groundedIn, at: now, source: 'model', status: 'adopted', ...stampOf(s.proposedNorthStar) },
      proposedNorthStar: null
    });
  }

  // Quests generated in the same pass as an inferred north star are only CANDIDATES. They remain staged until
  // the Commander confirms that direction; otherwise an unconfirmed inference would become autonomy authority.
  function stageQuests(state, quests) {
    const s = normalize(state);
    return Object.assign({}, s, { pendingQuests: (Array.isArray(quests) ? quests : []).slice(0, MAX_MINTS_PER_CYCLE).map(q => Object.assign({}, q)) });
  }
  function pendingQuests(state) { return normalize(state).pendingQuests.map(q => Object.assign({}, q)); }
  function clearPendingQuests(state) { return Object.assign({}, normalize(state), { pendingQuests: [] }); }

  // DECLINE the pending proposal → durably denylist it (so it's never re-proposed) and drop it; the previously
  // adopted star (if any) stands. Next cycle re-infers — a DIFFERENT inference may propose, the same one won't.
  function declineNorthStar(state, opts) {
    const s = normalize(state);
    if (!s.proposedNorthStar) return s;
    const nt = norm(s.proposedNorthStar.text);
    const denied = s.declinedNorthStars.filter(t => t !== nt).concat([nt]).slice(-DECLINED_NS_CAP);
    return Object.assign({}, s, { proposedNorthStar: null, pendingQuests: [], declinedNorthStars: denied });
  }

  return {
    fresh, normalize, decide, progressContext, goalBinding, buildDirective, parse, parseContract, hasEvidence, slateFull,
    note, stampCycle, stampMint, setNorthStar, effectiveNorthStar, proposeNorthStar, confirmNorthStar, declineNorthStar,
    stageQuests, pendingQuests, clearPendingQuests, drop,
    REFRESH_EVERY_MS, CAUGHT_UP_GAP_MS, MATERIAL_CHANGE_GAP_MS, MAX_MINTS_PER_CYCLE, OPEN_GENERATED_CAP, LEDGER_CAP, DECLINED_NS_CAP, CONTRACT_TYPES,
    _internals: { norm: norm, grabFrom: grabFrom, MIN_FACT_KEY: MIN_FACT_KEY, MAX_STEPS: MAX_STEPS }
  };
});
