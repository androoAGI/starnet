/* sidecar/quest-store.js — the station-wide, harness-owned, agent-aware QUEST LEDGER (QUEST V2, plan §A).

   Quests are Agent OS's retention spine: the game's progression must stay in sync with the Commander's REAL
   progression (goals, aspirations, work to automate). The v1 system was a frontend-only read projection with
   two fatal holes: completions celebrated unreliably, and any quest that wasn't mechanically observable was
   architecturally UNCOMPLETABLE (the agent couldn't even see it). V2 moves the ledger into the sidecar and
   makes THE CONTRACT RULE the heart of the design: a quest cannot be minted without a valid completion
   contract — so "sits there forever, uncompletable" is impossible by construction.

   One durable single-file store for the whole station — `_station.quests.json` under WORKSPACES — built on
   makeDurableJsonStore (crash-safe fsync + .bak last-known-good, per-key async mutex + re-read-under-lock).
   Pure + node-testable over an injected fs/path: NO ambient clock/rng — every timestamp is passed in by the
   caller (`now`), matching the workshop-store / memory-store discipline.

   Quest record (plan §A):
     { id:'q:<seq>', title, desc, reward, kind:'generated'|'work'|'user', createdBy, agentId (nullable=station),
       contract:{type:'prop'|'run'|'fact'|'artifact'|'attest', key}, steps:[{key,label,done,note?}],
       status:'open'|'done'|'dismissed', attest: null|{agentId,runId,evidence,at,confirmed:null},
       declineNote: null|{at,note}, groundedIn: null|string, domain, goalId, milestoneId, completedBy,
       runId (bound run), stalledAt, stalledReason,
       createdAt, completedAt, dismissedAt }

   Completion is CONTRACT-OWNED, never a claim:
     • prop / fact / artifact → completeByContract(type,key) when the harness proves the capability/fact/file.
     • run  → completeByContract('run', runId) when the bound run ends 'done'; a non-'done' end → stallRun.
     • attest → the agent PROPOSES with evidence (attest); the Commander confirms (confirmAttest). Agent claim
       alone NEVER completes. Confirm → done. Decline → attest cleared, declineNote stamped, quest stays open.
   Steps are PROGRESS DISPLAY only: ticking every step does NOT auto-complete a quest — the contract owns done. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

const STORE_KEY = 'station';               // single-file store: one logical key
const STORE_FILE = '_station.quests.json'; // under WORKSPACES
const CONTRACT_TYPES = ['prop', 'run', 'fact', 'artifact', 'attest'];
const KINDS = ['generated', 'work', 'user'];
const DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DENIED_CAP = 500;   // FIFO cap on the permanent dismissed-title denylist (anti-nag: dismiss = forever)
const QUEST_CAP = 300;    // FIFO cap on total quests — drop the OLDEST terminal (done/dismissed), never an open one
const OPEN_GENERATED_CAP = 3;   // ≤3 open kind:'generated' quests per agent (generative-minting guardrail, plan §E)
const DISPOSITIONS = ['later', 'blocked', 'too_big'];
const MIN_EVIDENCE = 10;  // an attest_complete needs real evidence (chars after trim), never an empty claim

const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
function num(v) { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function numOr(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clipKind(k) { return KINDS.indexOf(k) >= 0 ? k : 'user'; }
function agentIdOrNull(a) { if (a == null) return null; const s = String(a); return ID_RE.test(s) ? s : null; }
function domainOrNull(d) { const s = String(d || '').toLowerCase(); return DOMAINS.indexOf(s) >= 0 ? s : null; }

// normalized title key for duplicate detection (workshop-store idiom): lowercase, trim, collapse whitespace.
// An empty normalized key means "no title" — never used for dedup.
function normTitle(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }

// THE CONTRACT RULE, validated. A quest cannot exist without a valid completion contract. Returns a clean
// {type,key} or null (reject). Mechanical types (prop/run/fact/artifact) REQUIRE a non-empty key; only 'attest'
// may carry key '' (its completion is the Commander's confirm, not a keyed sweep).
function validContract(c) {
  if (!c || typeof c !== 'object') return null;
  const type = String(c.type || '');
  if (CONTRACT_TYPES.indexOf(type) < 0) return null;
  const key = clip(c.key, 200);
  if (type !== 'attest' && !key.trim()) return null;
  return { type: type, key: key };
}

// optional steps → validated {key,label,done:false, note?}. Entries without a key are dropped (never a crash).
function validSteps(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(s => s && typeof s === 'object' && s.key != null)
    .map(s => {
      const st = { key: clip(s.key, 40), label: clip(s.label != null ? s.label : s.key, 80), done: !!s.done };
      if (s.note != null) st.note = clip(s.note, 240);
      return st;
    })
    .filter(s => s.key);
}

function actionable(q, now) {
  return q.status === 'open' && (!q.disposition || (q.disposition.type === 'later' && q.disposition.snoozeUntil != null && q.disposition.snoozeUntil <= now));
}
function dispositionOrNull(d) {
  return d && DISPOSITIONS.includes(d.type) ? { type: d.type, reason: clip(d.reason, 500), at: numOr(d.at, 0), snoozeUntil: num(d.snoozeUntil) } : null;
}
function executionMode(d, contract) {
  return ['commander', 'agent', 'together'].includes(d) ? d : (contract.type === 'attest' ? 'commander' : 'agent');
}

// rebuild ONE quest defensively from a persisted/legacy/junk entry. A quest with no id or no valid contract is
// dropped (the contract rule holds even on hydration — a contractless record could never have been minted).
function normQuest(r) {
  if (!r || typeof r !== 'object') return null;
  const id = clip(r.id, 40);
  if (!id) return null;
  const contract = validContract(r.contract);
  if (!contract) return null;
  const status = ['open', 'done', 'dismissed'].indexOf(r.status) >= 0 ? r.status : 'open';
  const steps = Array.isArray(r.steps)
    ? r.steps.map(st => {
        if (!st || st.key == null) return null;
        const o = { key: clip(st.key, 40), label: clip(st.label != null ? st.label : st.key, 80), done: !!st.done };
        if (st.note != null) o.note = clip(st.note, 240);
        return o;
      }).filter(st => st && st.key)
    : [];
  const attest = (r.attest && typeof r.attest === 'object') ? {
    source: r.attest.source === 'commander' ? 'commander' : 'agent',
    agentId: agentIdOrNull(r.attest.agentId),
    runId: r.attest.runId == null ? null : clip(r.attest.runId, 80),
    evidence: clip(r.attest.evidence, 2000),
    at: num(r.attest.at),
    confirmed: r.attest.confirmed === true ? true : (r.attest.confirmed === false ? false : null)
  } : null;
  const declineNote = (r.declineNote && typeof r.declineNote === 'object')
    ? { at: num(r.declineNote.at), note: clip(r.declineNote.note, 240) }
    : null;
  return {
    id: id,
    title: clip(r.title, 80),
    desc: clip(r.desc, 2000),
    reward: clip(r.reward, 200),
    kind: clipKind(r.kind),
    createdBy: r.createdBy == null ? 'system' : clip(r.createdBy, 60),
    agentId: agentIdOrNull(r.agentId),
    contract: contract,
    steps: steps,
    status: status,
    executionMode: executionMode(r.executionMode, contract),
    whyNow: clip(r.whyNow, 300),
    disposition: dispositionOrNull(r.disposition),
    dispositionHistory: (Array.isArray(r.dispositionHistory) ? r.dispositionHistory : []).map(dispositionOrNull).filter(Boolean).slice(-20),
    attest: attest,
    declineNote: declineNote,
    groundedIn: r.groundedIn == null ? null : clip(r.groundedIn, 200),
    domain: domainOrNull(r.domain),
    goalId: r.goalId == null ? null : clip(r.goalId, 64),
    milestoneId: r.milestoneId == null ? null : clip(r.milestoneId, 80),
    completedBy: agentIdOrNull(r.completedBy),
    runId: r.runId == null ? null : clip(r.runId, 80),
    stalledAt: num(r.stalledAt),
    stalledReason: r.stalledReason == null ? null : clip(r.stalledReason, 24),
    createdAt: numOr(r.createdAt, 0),
    completedAt: num(r.completedAt),
    dismissedAt: num(r.dismissedAt)
  };
}

// the on-disk shape, normalized so a partial/legacy/absent file always loads to a full, safe record.
function normalize(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  const seq = Math.max(0, Number(s.seq) | 0);
  const quests = (Array.isArray(s.quests) ? s.quests : []).map(normQuest).filter(Boolean);
  const deniedTitles = Array.isArray(s.deniedTitles)
    ? s.deniedTitles.filter(x => x != null).map(String).filter(Boolean)
    : [];
  return { v: 1, seq: seq, quests: quests, deniedTitles: deniedTitles };
}

// FIFO cap on the total ledger: drop the OLDEST terminal (done/dismissed) quest first; NEVER evict an open one
// (an open quest is live direction — losing it silently would resurface the "uncompletable/vanished" class).
function capQuests(rec) {
  while (rec.quests.length > QUEST_CAP) {
    const idx = rec.quests.findIndex(q => q.status !== 'open');
    if (idx < 0) break;   // all open — refuse to evict; the cap yields to the no-silent-loss law
    rec.quests.splice(idx, 1);
  }
}

function makeQuestStore(deps) {
  deps = deps || {};
  const pathMod = deps.path;
  const workspaces = deps.workspaces;
  if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeQuestStore: path module required');
  if (!workspaces) throw new Error('makeQuestStore: workspaces path required');

  const durable = makeDurableJsonStore({
    fs: deps.fs,
    path: pathMod,
    fileFor: () => pathMod.join(workspaces, STORE_FILE),
    writeDurable: deps.writeDurable,
    onRecover: deps.onRecover,
    onCorrupt: deps.onCorrupt
  });
  const warn = typeof deps.warn === 'function' ? deps.warn : function () {};

  // ---- reads (sync, recovery-aware) ----
  function read() {
    try { return normalize(durable.get(STORE_KEY)); }
    catch (e) { warn('[quests] read failed:', (e && e.message) || e); return normalize(null); }
  }
  function list() { return read().quests; }
  function get(id) { return read().quests.find(q => q.id === String(id)) || null; }
  // open quests an agent should see in its prompt: its OWN quests + station-wide (agentId null) ones.
  function openForAgent(agentId, now) {
    const aid = agentIdOrNull(agentId);
    return read().quests.filter(q => actionable(q, numOr(now, 0)) && (q.agentId == null || q.agentId === aid));
  }

  // ---- MINT (contract-enforced, title-deduped, per-agent capped) ----
  // d = { title, desc?, reward?, contract:{type,key}, steps?, agentId?, kind?, createdBy?, groundedIn? }.
  // Returns a Promise<{ ok, id?, error? }>. Rejections are honest {ok:false,error} (never a throw for a bad
  // contract/title/dup/cap — the route surfaces error as a 400 message).
  function mint(d, now) {
    d = d || {};
    const contract = validContract(d.contract);
    if (!contract) return Promise.resolve({ ok: false, error: 'a quest needs a valid completion contract' });
    const title = String(d.title == null ? '' : d.title).trim();
    if (!title) return Promise.resolve({ ok: false, error: 'a quest needs a title' });
    const nt = normTitle(title);
    const kind = clipKind(d.kind);
    const agentId = agentIdOrNull(d.agentId);
    const goalId = d.goalId == null ? null : clip(d.goalId, 64);
    const createdBy = d.createdBy != null ? clip(d.createdBy, 60) : (agentId ? 'agent:' + agentId : 'system');
    let out = { ok: false, error: 'mint failed' };
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      // dismissed forever (anti-nag): a title the Commander waved off can never be re-minted.
      if (nt && rec.deniedTitles.indexOf(nt) >= 0) { out = { ok: false, error: 'that quest was dismissed before and will not be offered again' }; return undefined; }
      // title-dedup vs OPEN quests — never re-mint a quest that is already live.
      if (nt) {
        const dup = rec.quests.find(q => q.status === 'open' && normTitle(q.title) === nt);
        if (dup) { out = { ok: false, error: 'that quest is already open', id: dup.id }; return undefined; }
      }
      // Generative guardrail: at most three actionable generated quests per agent + goal.
      // Legacy unbound quests retain their original null-goal scope.
      if (kind === 'generated') {
        const openGen = rec.quests.filter(q => actionable(q, numOr(now, 0)) && q.kind === 'generated' && q.agentId === agentId && (q.goalId || null) === (goalId || null)).length;
        if (openGen >= OPEN_GENERATED_CAP) { out = { ok: false, error: 'this agent already has the max open generated quests' }; return undefined; }
      }
      const id = 'q:' + (++rec.seq);
      const q = {
        id: id,
        title: clip(title, 80),
        desc: clip(d.desc, 2000),
        reward: clip(d.reward, 200),
        kind: kind,
        createdBy: createdBy,
        agentId: agentId,
        contract: contract,
        steps: validSteps(d.steps),
        status: 'open',
        executionMode: executionMode(d.executionMode, contract),
        whyNow: clip(d.whyNow, 300),
        disposition: null, dispositionHistory: [],
        attest: null,
        declineNote: null,
        groundedIn: d.groundedIn == null ? null : clip(d.groundedIn, 200),
        domain: domainOrNull(d.domain),
        goalId: goalId,
        milestoneId: d.milestoneId == null ? null : clip(d.milestoneId, 80),
        completedBy: null,
        runId: null,
        stalledAt: null,
        stalledReason: null,
        createdAt: numOr(now, 0),
        completedAt: null,
        dismissedAt: null
      };
      rec.quests.push(q);
      capQuests(rec);
      out = { ok: true, id: id };
      return rec;
    }).then(() => out);
  }

  // ---- tickStep: flip a NAMED open step done (idempotent). Progress display only — NEVER completes the quest
  //      (completion is contract-owned: completeByContract for mechanical, confirmAttest for attest). ----
  function tickStep(id, stepKey, note, now) {
    let out = false;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status !== 'open') return undefined;
      const st = q.steps.find(s => s.key === String(stepKey));
      if (!st || st.done) return undefined;   // unknown/already-done step → idempotent no-op
      st.done = true;
      if (note != null) st.note = clip(note, 240);
      out = true;
      return rec;
    }).then(() => out);
  }

  // bind the concrete run building a run-contract quest, so completeByContract('run', runId) can find it. A fresh
  // binding clears any prior stall (the build is live again). Returns true only if a runId was actually bound.
  function bindRun(id, runId, agentId) {
    let out = false;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status !== 'open') return undefined;
      q.runId = String(runId == null ? '' : runId) || null;
      if (q.runId && agentIdOrNull(agentId)) q.completedBy = agentIdOrNull(agentId);
      if (q.runId && q.stalledAt != null) { q.stalledAt = null; q.stalledReason = null; }
      out = !!q.runId;
      return rec;
    }).then(() => out);
  }

  // MECHANICAL SWEEP: complete EVERY open quest whose contract matches (type,key). Returns the completed ids.
  //   run → matches contract.key===key OR the bound runId===key (the run finishing 'done' is the done-signal).
  //   prop/fact/artifact → matches contract.key===key (harness proved the capability/fact/deliverable).
  //   attest → NEVER completed here (attest completion is the Commander's confirm alone).
  function completeByContract(type, key, now) {
    const t = String(type || '');
    const k = String(key == null ? '' : key);
    const ids = [];
    if (t === 'attest' || CONTRACT_TYPES.indexOf(t) < 0) return Promise.resolve(ids);
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      let changed = false;
      for (const q of rec.quests) {
        if (q.status !== 'open' || !q.contract || q.contract.type !== t) continue;
        const match = (t === 'run') ? (q.contract.key === k || q.runId === k) : (q.contract.key === k);
        if (!match) continue;
        q.status = 'done';
        q.completedAt = numOr(now, 0);
        if (!q.completedBy && q.agentId) q.completedBy = q.agentId;
        q.stalledAt = null;
        q.stalledReason = null;
        ids.push(q.id);
        changed = true;
      }
      return changed ? rec : undefined;
    }).then(() => ids);
  }

  // STALL: a bound run ended WITHOUT finishing (error/budget/max_iters/refusal — never 'done'). Mirrors
  // workquests.js stall semantics: stamp stalledAt + reason (for the card copy), RELEASE the binding (so a
  // stale/reused runId can't later "complete" the quest), leave steps as-is. A later re-launch re-binds +
  // un-stalls. Returns the stalled ids. Matches by bound runId OR a run-contract keyed to this runId.
  function stallRun(runId, reason, now) {
    const rid = String(runId == null ? '' : runId);
    const ids = [];
    if (!rid) return Promise.resolve(ids);
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      let changed = false;
      for (const q of rec.quests) {
        if (q.status !== 'open') continue;
        const bound = q.runId === rid || (q.contract && q.contract.type === 'run' && q.contract.key === rid);
        if (!bound) continue;
        q.stalledAt = numOr(now, 0);
        q.stalledReason = clip(reason || 'error', 24) || 'error';
        q.runId = null;   // release the binding — only a fresh launch re-claims this build
        ids.push(q.id);
        changed = true;
      }
      return changed ? rec : undefined;
    }).then(() => ids);
  }

  // ATTEST: the agent PROPOSES completion with evidence (attest contracts only). Never completes — sets a
  // pending attest the Commander confirms. Rejects a mechanical contract, a missing/short evidence, and a
  // quest that already has a pending attest. Returns { ok, error? }.
  function attest(id, d, now) {
    d = d || {};
    const evidence = String(d.evidence == null ? '' : d.evidence).trim();
    let out = { ok: false, error: 'attest failed' };
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status !== 'open') { out = { ok: false, error: 'no such open quest' }; return undefined; }
      if (!q.contract || q.contract.type !== 'attest') { out = { ok: false, error: 'this quest completes mechanically, not by attestation' }; return undefined; }
      if (q.attest && q.attest.confirmed == null) { out = { ok: false, error: 'this quest is already awaiting the Commander\'s confirmation' }; return undefined; }
      if (evidence.length < MIN_EVIDENCE) { out = { ok: false, error: 'attesting completion needs real evidence of what was done' }; return undefined; }
      q.attest = {
        agentId: agentIdOrNull(d.agentId),
        runId: d.runId == null ? null : clip(d.runId, 80),
        evidence: clip(evidence, 2000),
        at: numOr(now, 0),
        confirmed: null
      };
      out = { ok: true };
      return rec;
    }).then(() => out);
  }

  // CONFIRM the attest verdict (Commander only). ok=true → done + completedAt (attest.confirmed=true kept for
  // audit). ok=false → attest cleared, declineNote stamped (the agent sees it next run), quest STAYS open.
  // Returns true only when it actually resolved a pending attest.
  function confirmAttest(id, ok, note, now) {
    let out = false;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status !== 'open' || !q.attest || q.attest.confirmed != null) return undefined;
      if (ok) {
        q.attest.confirmed = true;
        q.status = 'done';
        q.completedAt = numOr(now, 0);
        q.completedBy = agentIdOrNull(q.attest.agentId) || q.agentId;
      } else {
        q.attest = null;
        q.declineNote = { at: numOr(now, 0), note: clip(note, 240) };
      }
      out = true;
      return rec;
    }).then(() => out);
  }

  // Commander feedback is durable; paused quests stay in the ledger and title dedup set.
  function setDisposition(id, d, now) {
    d = d || {};
    const type = String(d.disposition || '');
    if (!DISPOSITIONS.includes(type) && type !== 'resume') return Promise.resolve({ ok: false, error: 'unknown disposition' });
    const at = numOr(now, 0);
    if (type === 'later' && d.snoozeUntil != null && (num(d.snoozeUntil) == null || num(d.snoozeUntil) <= at)) return Promise.resolve({ ok: false, error: 'snoozeUntil must be a future timestamp' });
    let out = { ok: false, error: 'no such open quest' };
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur), q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status !== 'open') return undefined;
      if (type === 'resume') q.disposition = null;
      else {
        q.disposition = { type, reason: clip(d.reason, 500), at, snoozeUntil: type === 'later' ? (num(d.snoozeUntil) || at + 86400000) : null };
        q.dispositionHistory = q.dispositionHistory.concat([q.disposition]).slice(-20);
      }
      out = { ok: true, quest: q };
      return rec;
    }).then(() => out);
  }

  // Owner HTTP surface only. Agent tools still require attest -> Commander confirm.
  function reportCompletion(id, evidence, now) {
    const text = String(evidence || '').trim();
    if (text.length < MIN_EVIDENCE) return Promise.resolve({ ok: false, error: 'describe what you did (at least 10 characters)' });
    let out = { ok: false, error: 'no such open quest' };
    return durable.update(STORE_KEY, cur => {
      const rec = normalize(cur), q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status !== 'open') return undefined;
      if (q.contract.type !== 'attest') { out = { ok: false, error: 'this quest requires its harness completion contract' }; return undefined; }
      q.attest = { source: 'commander', agentId: null, runId: null, evidence: clip(text, 2000), at: numOr(now, 0), confirmed: true };
      q.status = 'done'; q.completedAt = numOr(now, 0); q.completedBy = null; q.disposition = null;
      out = { ok: true, quest: q };
      return rec;
    }).then(() => out);
  }

  // DISMISS forever (anti-nag): status → dismissed AND the normalized title is denylisted permanently, so the
  // same quest can never be re-minted. Returns true only when it actually took (a known, not-already-dismissed).
  function dismiss(id, now) {
    let out = false;
    return durable.update(STORE_KEY, (cur) => {
      const rec = normalize(cur);
      const q = rec.quests.find(x => x.id === String(id));
      if (!q || q.status === 'dismissed') return undefined;
      q.status = 'dismissed';
      q.dismissedAt = numOr(now, 0);
      const nt = normTitle(q.title);
      if (nt && rec.deniedTitles.indexOf(nt) < 0) {
        rec.deniedTitles.push(nt);
        while (rec.deniedTitles.length > DENIED_CAP) rec.deniedTitles.shift();
      }
      out = true;
      return rec;
    }).then(() => out);
  }

  return {
    read, list, get, openForAgent,
    mint, setDisposition, reportCompletion, tickStep, bindRun, completeByContract, stallRun, attest, confirmAttest, dismiss,
    _durable: durable
  };
}

module.exports = { makeQuestStore, normalize, DOMAINS, actionable, _internals: { validContract, normTitle, validSteps, normQuest, domainOrNull } };
