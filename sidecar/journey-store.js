/* sidecar/journey-store.js — durable Commander-journey progression.

   This is deliberately NOT XP. XP remains the agent/Commander feedback relationship; this store records the
   separate causal spine the game was missing:

     explicit goal -> verified quest/milestone/metric outcome -> domain mastery -> adaptation receipt ->
     station evolution

   Every outcome carries its authority. Mechanical quest contracts are `harness-contract`; attest quests are
   `commander-confirmed`; goal milestones and metric updates are `commander-client` because their authoritative
   owners currently live in the webview. No bare run, tool count, spend, or model claim can enter this ledger.

   Station evolution is expressive only. It never grants tools, capabilities, permission, or model access. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');

const STORE_KEY = 'station';
const STORE_FILE = '_station.journey.json';
const DOMAINS = ['building', 'research', 'writing', 'growth', 'operations', 'creative', 'planning', 'support'];
const DOMAIN_SET = new Set(DOMAINS);
const OUTCOME_KINDS = new Set(['quest', 'milestone', 'metric', 'goal']);
const TIER_STEPS = [[7, 'proven'], [3, 'practiced'], [1, 'tested']];
const EVOLUTION_NAMES = ['DRIFT', 'VECTOR', 'ORBIT', 'CONSTELLATION', 'DEEP FIELD'];
const METRIC_CAP = 40, OUTCOME_CAP = 300, RECEIPT_CAP = 100, HISTORY_CAP = 24;
const AGENT_RE = /^[A-Za-z0-9_-]{1,40}$/;

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const number = v => {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const stamp = v => Math.max(0, Math.floor(number(v) || 0));
const domain = v => DOMAIN_SET.has(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null;
// __proto__ / constructor / prototype match AGENT_RE but are object-model keys, not agents: rec.suppressed['__proto__']
// IS Object.prototype, so one POST /api/journey adaptation.suppress wrote a domain name onto every object in the
// process. Refuse them wherever an agent id becomes a property key.
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const agent = v => AGENT_RE.test(String(v || '')) && !PROTO_KEYS.has(String(v)) ? String(v) : null;

function tierFor(count) {
  const n = Math.max(0, Number(count) | 0);
  const hit = TIER_STEPS.find(row => n >= row[0]);
  return hit ? hit[1] : 'unproven';
}

// the stage NAME for a given count of distinct goals reached — one formula, so `name` and `next` can never
// drift apart (they were the same expression written twice the moment `next` was added).
function evolutionName(n) {
  const i = Math.max(0, Number(n) | 0);
  return i > 4 ? ('DEEP FIELD ' + (i - 3)) : EVOLUTION_NAMES[Math.min(EVOLUTION_NAMES.length - 1, i)];
}

/* `next` is ADDITIVE (2026-08-14) and exists so a surface can name what finishing the current goal
   advances the station TO, without duplicating EVOLUTION_NAMES in the frontend — the names stay owned
   here, and the UI only ever renders what it is told. Reaching one more DISTINCT goal is exactly what
   moves the stage (see addGoalReached), so `next` is the honest answer to "what does this path lead to".
   Station evolution remains EXPRESSIVE ONLY: naming the next stage is not an unlock claim. */
function evolutionFor(goalsReached) {
  const n = Array.isArray(goalsReached) ? goalsReached.length : 0;
  return { stage: n, name: evolutionName(n), next: evolutionName(n + 1), goalsReached: n };
}

function normMetric(m) {
  if (!m || typeof m !== 'object') return null;
  const id = clip(m.id, 48), label = clip(m.label, 100), baseline = number(m.baseline), target = number(m.target), current = number(m.current);
  if (!id || !label || baseline == null || target == null || current == null || baseline === target) return null;
  const direction = target > baseline ? 'atLeast' : 'atMost';
  const history = (Array.isArray(m.history) ? m.history : []).map(h => {
    const value = number(h && h.value); if (value == null) return null;
    return { at: stamp(h.at), value, note: clip(h.note, 240), source: h.source === 'commander' ? 'commander' : 'migration' };
  }).filter(Boolean).slice(-HISTORY_CAP);
  return {
    id, goalId: clip(m.goalId, 64) || null, label, unit: clip(m.unit, 24), baseline, target, current, direction,
    status: m.status === 'retired' ? 'retired' : 'active', createdAt: stamp(m.createdAt), updatedAt: stamp(m.updatedAt),
    reachedAt: m.reachedAt == null ? null : stamp(m.reachedAt), history
  };
}

function normOutcome(o) {
  if (!o || typeof o !== 'object') return null;
  const sourceId = clip(o.sourceId, 120), kind = String(o.kind || '');
  if (!sourceId || !OUTCOME_KINDS.has(kind)) return null;
  return {
    id: clip(o.id, 48), sourceId, kind, goalId: clip(o.goalId, 64) || null,
    milestoneId: clip(o.milestoneId, 80) || null, questId: clip(o.questId, 48) || null,
    agentId: agent(o.agentId), domain: domain(o.domain), title: clip(o.title, 140), evidence: clip(o.evidence, 1000),
    verifiedBy: ['harness-contract', 'commander-confirmed', 'commander-client'].includes(o.verifiedBy) ? o.verifiedBy : 'commander-client',
    goalDone: !!o.goalDone, at: stamp(o.at)
  };
}

function normGoal(g) {
  if (!g || typeof g !== 'object') return null;
  const id = clip(g.id, 64), text = clip(g.text, 280), successCondition = clip(g.successCondition, 1000);
  if (!id || !text || !successCondition) return null;
  return { id, text, successCondition, status: g.status === 'achieved' ? 'achieved' : 'active',
    createdAt: stamp(g.createdAt), updatedAt: stamp(g.updatedAt), achievedAt: g.achievedAt == null ? null : stamp(g.achievedAt),
    evidence: clip(g.evidence, 1000), verifiedBy: g.status === 'achieved' ? 'commander-confirmed' : null };
}

function normAchievement(a) {
  if (!a || typeof a !== 'object' || !['quest', 'milestone', 'metric', 'goal'].includes(a.kind)) return null;
  const key = clip(a.key, 200), goalId = clip(a.goalId, 64);
  if (!key || !goalId) return null;
  return { key, goalId, kind: a.kind, points: a.kind === 'goal' ? 100 : 10, title: clip(a.title, 140),
    evidence: clip(a.evidence, 1000), verifiedBy: a.verifiedBy === 'commander-confirmed' ? 'commander-confirmed' : 'commander-client', at: stamp(a.at) };
}

function progressionFor(rec) {
  const points = rec.commanderPoints;
  const level = Math.floor(points / 100) + 1;
  return { level, points, levelStartsAt: (level - 1) * 100, nextLevelAt: level * 100,
    pointsToNextLevel: level * 100 - points, achievements: rec.achievements.slice(-30) };
}

function award(rec, input, now) {
  const a = normAchievement(Object.assign({}, input, { at: now }));
  if (!a || rec.achievementKeys.includes(a.key) || !rec.goals.some(g => g.id === a.goalId)) return null;
  rec.achievementKeys.push(a.key); rec.commanderPoints += a.points;
  rec.achievements.push(a);
  if (rec.achievements.length > OUTCOME_CAP) rec.achievements.shift();
  return a;
}

function normMastery(m) {
  if (!m || typeof m !== 'object') return null;
  const aid = agent(m.agentId), d = domain(m.domain), count = Math.max(0, Number(m.count) | 0);
  if (!aid || !d || !count) return null;
  return { agentId: aid, domain: d, count, tier: tierFor(count), lastAt: stamp(m.lastAt), lastOutcomeId: clip(m.lastOutcomeId, 48) || null };
}

function normReceipt(r) {
  if (!r || typeof r !== 'object') return null;
  const id = clip(r.id, 48), aid = agent(r.agentId), d = domain(r.domain);
  if (!id || !aid || !d) return null;
  return {
    id, agentId: aid, domain: d, tier: tierFor(r.count), count: Math.max(1, Number(r.count) | 0),
    text: clip(r.text, 360), outcomeId: clip(r.outcomeId, 48) || null, at: stamp(r.at),
    dismissedAt: r.dismissedAt == null ? null : stamp(r.dismissedAt)
  };
}

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const allMetrics = (Array.isArray(r.metrics) ? r.metrics : []).map(normMetric).filter(Boolean);
  // Retired rows are expendable history; active Commander metrics are not. A malformed/legacy file with more
  // than the nominal cap must preserve every active row rather than silently deleting user-entered truth.
  const activeMetrics = allMetrics.filter(m => m.status === 'active');
  const retiredKeep = new Set(allMetrics.filter(m => m.status === 'retired').slice(-Math.max(0, METRIC_CAP - activeMetrics.length)));
  const metrics = allMetrics.filter(m => m.status === 'active' || retiredKeep.has(m));
  const outcomes = (Array.isArray(r.outcomes) ? r.outcomes : []).map(normOutcome).filter(Boolean).slice(-OUTCOME_CAP);
  // Visible outcome rows are bounded, but their idempotency authority is lifetime state. Without this separate
  // key ledger, replaying an old completed quest after 300 newer outcomes increments mastery a second time.
  const outcomeKeys = [...new Set((Array.isArray(r.outcomeKeys) ? r.outcomeKeys : []).map(v => clip(v, 120)).filter(Boolean)
    .concat(outcomes.map(o => o.sourceId)))];
  const mastery = (Array.isArray(r.mastery) ? r.mastery : []).map(normMastery).filter(Boolean);
  const receipts = (Array.isArray(r.receipts) ? r.receipts : []).map(normReceipt).filter(Boolean).slice(-RECEIPT_CAP);
  // A completed life goal is rare, compact, and permanent. Keep exact ids so evolution stays uncapped and a very
  // old goal can never become "new" again merely because it fell out of a display-oriented window.
  const goalsReached = [...new Set((Array.isArray(r.goalsReached) ? r.goalsReached : []).map(v => clip(v, 64)).filter(Boolean))];
  const suppressed = {};
  if (r.suppressed && typeof r.suppressed === 'object') {
    for (const [aid, dims] of Object.entries(r.suppressed)) {
      if (!agent(aid) || !dims || typeof dims !== 'object') continue;
      const clean = {};
      for (const [d, at] of Object.entries(dims)) if (domain(d)) clean[d] = stamp(at);
      if (Object.keys(clean).length) suppressed[aid] = clean;
    }
  }
  const goals = (Array.isArray(r.goals) ? r.goals : []).map(normGoal).filter(Boolean);
  const achievements = (Array.isArray(r.achievements) ? r.achievements : []).map(normAchievement).filter(Boolean).slice(-OUTCOME_CAP);
  const achievementKeys = [...new Set((Array.isArray(r.achievementKeys) ? r.achievementKeys : []).map(v => clip(v, 200)).filter(Boolean).concat(achievements.map(a => a.key)))];
  const commanderPoints = Math.max(achievements.reduce((sum, a) => sum + a.points, 0), Math.max(0, Math.floor(number(r.commanderPoints) || 0)));
  return { goals, achievements, achievementKeys, commanderPoints, v: 1, seq: Math.max(0, Number(r.seq) | 0), commanderEpoch: stamp(r.commanderEpoch), startedAt: stamp(r.startedAt), metrics, outcomes, outcomeKeys, mastery, receipts, goalsReached, suppressed };
}

function reached(metric) {
  return metric.direction === 'atMost' ? metric.current <= metric.target : metric.current >= metric.target;
}

function addGoalReached(rec, goalId) {
  const id = clip(goalId, 64);
  if (id && rec.goalsReached.indexOf(id) < 0) {
    rec.goalsReached.push(id);
  }
}

function adaptationText(m, outcome) {
  const title = clip(outcome && outcome.title, 90) || 'verified work';
  const posture = m.tier === 'proven' ? 'reuse established patterns'
    : m.tier === 'practiced' ? 'prefer relevant repeated patterns while stating uncertainty'
      : 'consider the early pattern but verify it before relying on it';
  return 'Because ' + m.agentId + ' completed ' + m.count + ' verified ' + m.domain + ' outcome' + (m.count === 1 ? '' : 's')
    + ' (latest: ' + title + '), Agent OS will ' + posture + ' for this agent and surface uncertainty outside that track.';
}

// Mutates a normalized record inside the durable store update. sourceId is the idempotency authority.
function foldOutcome(rec, input, now) {
  const d = normOutcome(Object.assign({}, input, { at: stamp(now) }));
  if (!d || rec.outcomeKeys.indexOf(d.sourceId) >= 0) return { changed: false, outcome: null, receipt: null };
  d.id = 'jo:' + (++rec.seq);
  rec.outcomeKeys.push(d.sourceId);
  rec.outcomes.push(d);
  while (rec.outcomes.length > OUTCOME_CAP) rec.outcomes.shift();
  // Work completion never proves a whole life goal. Only confirmGoal can evolve the station.

  let receipt = null;
  if (d.agentId && d.domain) {
    let m = rec.mastery.find(x => x.agentId === d.agentId && x.domain === d.domain);
    const before = m ? m.tier : 'unproven';
    if (!m) { m = { agentId: d.agentId, domain: d.domain, count: 0, tier: 'unproven', lastAt: 0, lastOutcomeId: null }; rec.mastery.push(m); }
    m.count += 1; m.tier = tierFor(m.count); m.lastAt = d.at; m.lastOutcomeId = d.id;
    if (m.tier !== before) {
      receipt = { id: 'jr:' + (++rec.seq), agentId: m.agentId, domain: m.domain, tier: m.tier, count: m.count,
        text: adaptationText(m, d), outcomeId: d.id, at: d.at, dismissedAt: null };
      rec.receipts.push(receipt);
      while (rec.receipts.length > RECEIPT_CAP) rec.receipts.shift();
    }
  }
  return { changed: true, outcome: d, receipt };
}

function makeJourneyStore(deps) {
  deps = deps || {};
  if (!deps.path || !deps.workspaces) throw new Error('makeJourneyStore requires path + workspaces');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: deps.path, fileFor: () => deps.path.join(deps.workspaces, STORE_FILE),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });

  function read() {
    const r = durable.readKey(STORE_KEY);
    if (r.status === 'ok' || r.status === 'recovered') return normalize(r.value);
    if (r.status === 'absent') return normalize(null);
    const e = new Error('journey ledger is ' + r.status);
    e.code = r.status === 'unreadable' ? 'ESTORE_UNREADABLE' : 'ESTORE_CORRUPT';
    throw e;
  }

  function snapshot(activeGoal) {
    const rec = read();
    return {
      v: rec.v,
      activeGoal: activeGoal && typeof activeGoal === 'object' ? {
        id: clip(activeGoal.id, 64) || null, text: clip(activeGoal.text, 280), done: Math.max(0, Number(activeGoal.done) | 0),
        total: Math.max(0, Number(activeGoal.total) | 0), next: clip(activeGoal.next, 200) || null
      } : null,
      goals: rec.goals, progression: progressionFor(rec),
      metrics: rec.metrics.filter(m => m.status !== 'retired'),
      outcomes: rec.outcomes.slice(-50), mastery: rec.mastery.slice(), receipts: rec.receipts.slice(-20),
      // every recorded plan-step completion (not only the last 50 outcomes): the webview folds these onto its
      // goal tree, so a step the sidecar settled while the window was closed shows done when it reopens.
      milestones: rec.outcomes.filter(o => o.kind === 'milestone').slice(-100)
        .map(o => ({ goalId: o.goalId, milestoneId: o.milestoneId, evidence: o.evidence, verifiedBy: o.verifiedBy, at: o.at })),
      suppressed: rec.suppressed, evolution: evolutionFor(rec.goalsReached)
    };
  }

  // lifetime set of completed plan steps, keyed goalId + ':' + milestoneId (the outcome rows are capped for
  // display; the source-key ledger is not, so an old completion can never read as open again).
  function milestoneDoneKeys() {
    const rec = read();
    return new Set(rec.outcomeKeys.filter(k => k.indexOf('milestone:') === 0).map(k => k.slice('milestone:'.length)));
  }

  async function recordQuest(q, activeGoal, now) {
    if (!q || !q.id || q.status !== 'done') return { ok: false, error: 'a completed quest is required' };
    const attest = q.attest && q.attest.confirmed === true ? q.attest : null;
    if (q.contract && q.contract.type === 'attest' && !attest) return { ok: false, error: 'attest completion requires Commander-confirmed evidence' };
    const aid = attest && attest.source === 'commander' ? null : (agent(q.completedBy) || agent(attest && attest.agentId) || agent(q.agentId));
    const proof = q.contract && q.contract.type === 'attest' ? 'commander-confirmed' : 'harness-contract';
    const evidence = attest && attest.evidence
      ? attest.evidence
      : ((q.contract && q.contract.type) ? (q.contract.type + ':' + String(q.contract.key || '')) : 'verified quest completion');
    let result = null;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      if (rec.startedAt > 0 && stamp(q.completedAt) < rec.startedAt) {
        result = { changed: false, skipped: true, outcome: null, receipt: null }; return undefined;
      }
      result = foldOutcome(rec, {
        sourceId: 'quest:' + q.id, kind: 'quest', questId: q.id, goalId: q.goalId,
        milestoneId: q.milestoneId, agentId: aid, domain: q.domain, title: q.title, evidence, verifiedBy: proof, goalDone: false
      }, now);
      if (result.changed && proof === 'commander-confirmed' && rec.goals.some(g => g.id === clip(q.goalId, 64) && g.status === 'active')) {
        const milestoneId = clip(q.milestoneId, 80);
        award(rec, { key: milestoneId ? 'milestone:' + clip(q.goalId, 64) + ':' + milestoneId : 'quest:' + q.id,
          kind: 'quest', goalId: q.goalId, title: q.title, evidence, verifiedBy: proof }, now);
      }
      return result.changed ? rec : undefined;
    });
    return { ok: true, duplicate: !result.changed && !result.skipped, skipped: !!result.skipped, outcome: result.outcome, receipt: result.receipt };
  }

  // opts.authority (sidecar-internal ONLY — the POST /api/journey route never passes a third argument, so a client
  // can never claim it): the step was settled by the harness from its quest slate (sidecar/goal-advance.js), which
  // names the honest authority — 'harness-contract' when a mechanical contract completed work, 'commander-confirmed'
  // when every completed quest was the Commander's own report.
  async function recordMilestone(d, now, opts) {
    d = d || {}; let result = null;
    const sourceId = 'milestone:' + clip(d.goalId, 64) + ':' + clip(d.milestoneId, 80);
    if (!clip(d.goalId, 64) || !clip(d.milestoneId, 80) || clip(d.evidence, 1000).length < 4) return { ok: false, error: 'goal, milestone, and evidence are required' };
    const internal = opts && ['harness-contract', 'commander-confirmed'].indexOf(opts.authority) >= 0 ? opts.authority : null;
    const verifiedBy = internal || (d.source === 'commander' ? 'commander-confirmed' : 'commander-client');
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      result = foldOutcome(rec, {
        sourceId, kind: 'milestone', goalId: d.goalId, milestoneId: d.milestoneId, agentId: d.agentId,
        domain: d.domain, title: d.milestoneText || d.goalText, evidence: d.evidence, verifiedBy, goalDone: false
      }, now);
      if (result.changed) award(rec, { key: sourceId, goalId: d.goalId, kind: 'milestone',
        title: d.milestoneText || d.goalText, evidence: d.evidence, verifiedBy: d.source === 'commander' ? 'commander-confirmed' : 'commander-client' }, now);
      return result.changed ? rec : undefined;
    });
    return { ok: true, duplicate: !result.changed, outcome: result.outcome, receipt: result.receipt };
  }

  async function registerGoal(d, now) {
    d = d || {};
    const id = clip(d.id, 64), text = clip(d.text, 280), successCondition = clip(d.successCondition, 1000);
    if (typeof d.id !== 'string' || typeof d.text !== 'string' || typeof d.successCondition !== 'string' || !id || d.id.length > 64 || !text || !successCondition) return { ok: false, error: 'goal id, text, and success condition are required' };
    let goal = null, error = null;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); goal = rec.goals.find(g => g.id === id);
      if (goal && goal.status === 'achieved') {
        if (goal.text !== text || goal.successCondition !== successCondition) error = 'an achieved goal cannot be redefined';
        return undefined;
      }
      if (goal) Object.assign(goal, { text, successCondition, updatedAt: stamp(now) });
      else { goal = normGoal({ id, text, successCondition, createdAt: now, updatedAt: now }); rec.goals.push(goal); }
      return rec;
    });
    return error ? { ok: false, error } : { ok: true, goal };
  }

  async function confirmGoal(d, now) {
    d = d || {}; const id = clip(d.id, 64), evidence = clip(d.evidence, 1000);
    if (typeof d.id !== 'string' || typeof d.evidence !== 'string' || !id || d.id.length > 64 || !evidence) return { ok: false, error: 'goal id and Commander evidence are required' };
    let goal = null, outcome = null, duplicate = false;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); goal = rec.goals.find(g => g.id === id);
      if (!goal) return undefined;
      if (goal.status === 'achieved') { duplicate = true; return undefined; }
      Object.assign(goal, { status: 'achieved', achievedAt: stamp(now), updatedAt: stamp(now), evidence, verifiedBy: 'commander-confirmed' });
      outcome = foldOutcome(rec, { sourceId: 'goal:' + id + ':confirmed', kind: 'goal', goalId: id,
        title: goal.text, evidence, verifiedBy: 'commander-confirmed', goalDone: true }, now).outcome;
      addGoalReached(rec, id);
      award(rec, { key: 'goal:' + id + ':confirmed', kind: 'goal', goalId: id,
        title: goal.text, evidence, verifiedBy: 'commander-confirmed' }, now);
      return rec;
    });
    return goal ? { ok: true, duplicate, goal, outcome } : { ok: false, error: 'register a goal with a success condition first' };
  }

  async function createMetric(d, now) {
    d = d || {}; const label = clip(d.label, 100), baseline = number(d.baseline), target = number(d.target);
    if (!label || baseline == null || target == null || baseline === target) return { ok: false, error: 'label and distinct numeric baseline/target are required' };
    let metric = null;
    let error = '';
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur);
      if (rec.metrics.filter(m => m.status === 'active').length >= METRIC_CAP) {
        error = 'retire an active metric before adding another'; return undefined;
      }
      // Reclaim retired display history first; never shift an active metric to make room.
      while (rec.metrics.length >= METRIC_CAP) {
        const retired = rec.metrics.findIndex(m => m.status === 'retired');
        if (retired < 0) break;
        rec.metrics.splice(retired, 1);
      }
      const id = 'jm:' + (++rec.seq);
      metric = normMetric({ id, goalId: d.goalId, label, unit: d.unit, baseline, target, current: baseline,
        status: 'active', createdAt: now, updatedAt: now, reachedAt: null, history: [{ at: now, value: baseline, note: 'baseline', source: 'commander' }] });
      rec.metrics.push(metric); while (rec.metrics.length > METRIC_CAP) rec.metrics.shift();
      return rec;
    });
    return metric ? { ok: true, metric } : { ok: false, error: error || 'metric was not created' };
  }

  async function updateMetric(d, now) {
    d = d || {}; const id = clip(d.id, 48), value = number(d.current); let metric = null, outcome = null;
    if (!id || value == null) return { ok: false, error: 'metric id and numeric current value are required' };
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); const m = rec.metrics.find(x => x.id === id && x.status === 'active');
      if (!m) return undefined;
      m.current = value; m.updatedAt = stamp(now);
      m.history.push({ at: stamp(now), value, note: clip(d.note, 240), source: 'commander' });
      while (m.history.length > HISTORY_CAP) m.history.shift();
      if (reached(m) && m.reachedAt == null) {
        m.reachedAt = stamp(now);
        outcome = foldOutcome(rec, { sourceId: 'metric:' + m.id + ':reached', kind: 'metric', goalId: m.goalId,
          title: m.label + ' reached ' + m.target + (m.unit ? ' ' + m.unit : ''), evidence: 'Commander recorded ' + value + (m.unit ? ' ' + m.unit : ''),
          verifiedBy: 'commander-client', goalDone: false }, now);   // one metric target proves itself, never the whole life goal
      }
      // Goal-scoped high-water checkpoints survive metric retirement/replacement and regressions.
      // They describe a Commander-reported metric improvement, never a percentage of the life goal.
      const progress = (m.current - m.baseline) / (m.target - m.baseline);
      for (const checkpoint of [25, 50, 75, 100]) {
        if (progress * 100 >= checkpoint) award(rec, { key: 'goal:' + m.goalId + ':metric:' + checkpoint,
          kind: 'metric', goalId: m.goalId, title: m.label + ': ' + checkpoint + '% of metric target',
          evidence: 'Commander recorded ' + value + (m.unit ? ' ' + m.unit : '') + (d.note ? ' — ' + clip(d.note, 240) : ''),
          verifiedBy: 'commander-client' }, now);
      }
      metric = Object.assign({}, m); return rec;
    });
    return metric ? { ok: true, metric, outcome: outcome && outcome.outcome } : { ok: false, error: 'no such active metric' };
  }

  async function retireMetric(id, now) {
    let changed = false;
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur), m = rec.metrics.find(x => x.id === String(id) && x.status === 'active');
      if (!m) return undefined; m.status = 'retired'; m.updatedAt = stamp(now); changed = true; return rec;
    });
    return { ok: changed };
  }

  async function setSuppressed(agentId, d, on, now) {
    const aid = agent(agentId), dom = domain(d); if (!aid || !dom) return { ok: false, error: 'valid agent and domain required' };
    await durable.update(STORE_KEY, cur => {
      const rec = normalize(cur); rec.suppressed[aid] = rec.suppressed[aid] || {};
      if (on) rec.suppressed[aid][dom] = stamp(now); else delete rec.suppressed[aid][dom];
      if (!Object.keys(rec.suppressed[aid]).length) delete rec.suppressed[aid];
      for (const r of rec.receipts) if (r.agentId === aid && r.domain === dom) r.dismissedAt = on ? stamp(now) : null;
      return rec;
    });
    return { ok: true, suppressed: !!on };
  }

  function currentEpoch(fallback) {
    return Math.max(1, read().commanderEpoch || stamp(fallback) || 1);
  }

  async function reset(now, commanderEpoch) {
    await durable.update(STORE_KEY, () => Object.assign(normalize(null), {
      commanderEpoch: Math.max(1, stamp(commanderEpoch) || 1), startedAt: stamp(now)
    }));
    return { ok: true };
  }

  /* opts.counts === false: the TIER-ONLY form for the cache-stable system prompt (index.js CACHE-STABLE PREFIX). A count
     changes with every verified outcome, so a counted line re-wrote the cached prefix mid-conversation; this form names
     domain + tier + instruction, ordered by tier then domain, and changes only when a tier is crossed or a domain is
     added or muted. Default: the counted lines, ordered by count (the STARNET_STABLE_PREFIX=0 prompt, unchanged). */
  const TIER_RANK = { proven: 3, practiced: 2, tested: 1 };
  function adaptationBlock(agentId, opts) {
    const counts = !(opts && opts.counts === false);
    const aid = agent(agentId); if (!aid) return '';
    const rec = read(), muted = rec.suppressed[aid] || {};
    // WHICH five: always the most-practised (by count), in both forms (review 2026-10-12: picking the five by tier, then
    // name, let a tier-mate that sorts first push out the agent's most-practised domain). The tier-only form then RENDERS
    // them by tier and domain, so its bytes change only when the 5th and 6th swap, a tier is crossed, or a domain is
    // added or muted.
    const byCount = (a, b) => b.count - a.count || a.domain.localeCompare(b.domain);
    const byTier = (a, b) => (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0) || a.domain.localeCompare(b.domain);
    const top = rec.mastery.filter(m => m.agentId === aid && !muted[m.domain]).sort(byCount).slice(0, 5);
    if (!top.length) return '';
    const rows = counts ? top : top.slice().sort(byTier);
    const lines = ['<VERIFIED_JOURNEY_ADAPTATION>', 'Use this agent\'s verified outcome history as a planning prior, never as permission or proof about a new task:'];
    for (const m of rows) {
      const instruction = m.tier === 'proven' ? 'Reuse established patterns.'
        : m.tier === 'practiced' ? 'Prefer relevant repeated patterns, while stating uncertainty.'
          : 'Treat this as early evidence; consider the pattern but verify it.';
      lines.push('- ' + m.domain + (counts ? ': ' + m.count + ' verified outcome' + (m.count === 1 ? '' : 's') : '') + ' (' + m.tier + '). ' + instruction + ' State uncertainty outside this track.');
    }
    lines.push('</VERIFIED_JOURNEY_ADAPTATION>');
    return lines.join('\n');
  }

  return { read, snapshot, milestoneDoneKeys, currentEpoch, registerGoal, confirmGoal, recordQuest, recordMilestone, createMetric, updateMetric, retireMetric, setSuppressed, reset, adaptationBlock, _durable: durable };
}

module.exports = { makeJourneyStore, normalize, tierFor, evolutionFor, progressionFor, DOMAINS, _internals: { normMetric, normOutcome, reached, foldOutcome } };
