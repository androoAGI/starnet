/* Durable, cross-surface recommendation evidence + verdict ledger.
   One lifecycle replaces browser-only "recent" arrays and per-lane feedback islands. Every entry records what was
   shown, why it was allowed, which evidence supported it, and what happened next. The pure replay() read is the
   offline evaluation contract: identical history -> identical metrics and preference weights. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');
const { stampOf } = require('./forget-registry.js');   // the quote stamp of a record: the sessions its evidence was drawn from (turn identity commit 12)

const STORE_KEY = 'recommendations';
const CAP = 4000;
const STATES = new Set(['shown', 'opened', 'accepted', 'started', 'deferred', 'declined', 'completed']);
const REASONS = new Set(['accepted', 'wrong_thing', 'wrong_time', 'bad_quality', 'already_done', 'not_relevant', 'completed', 'unspecified']);
const TERMINAL = new Set(['declined', 'completed']);
const NEXT = Object.freeze({
  shown: new Set(['opened', 'accepted', 'started', 'deferred', 'declined', 'completed']),
  opened: new Set(['accepted', 'started', 'deferred', 'declined', 'completed']),
  deferred: new Set(['opened', 'accepted', 'started', 'declined', 'completed']),
  accepted: new Set(['started', 'declined', 'completed']),
  started: new Set(['declined', 'completed']),
  declined: new Set(), completed: new Set()
});
const PREF_HALF_LIFE_MS = 45 * 86400000;

function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function fingerprint(title) {
  const toks = clip(title, 300).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
  return Array.from(new Set(toks)).sort().join(' ');
}
function normTraits(raw) {
  return Array.from(new Set((Array.isArray(raw) ? raw : []).map(x => clip(x, 80).toLowerCase()).filter(Boolean))).slice(0, 20);
}
function finite(v, fallback) { return Number.isFinite(Number(v)) ? Number(v) : fallback; }
function normOutcome(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  return {
    runId: clip(x.runId, 120), artifactId: clip(x.artifactId, 240), quality: Math.max(-1, Math.min(1, finite(x.quality, 0))),
    costUsd: Math.max(0, finite(x.costUsd, 0)), interventions: Math.max(0, finite(x.interventions, 0) | 0),
    adopted: x.adopted === true, completedAt: Math.max(0, finite(x.completedAt, 0))
  };
}
function normalizeEntry(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  const state = STATES.has(x.state) ? x.state : 'shown';
  const reason = REASONS.has(x.reason) ? x.reason : (state === 'shown' ? '' : 'unspecified');
  const createdAt = Number(x.createdAt) || 0;
  const updatedAt = Number(x.updatedAt) || createdAt;
  const transitions = Array.isArray(x.transitions) ? x.transitions.map(t => {
    const st = t && STATES.has(t.state) ? t.state : null;
    if (!st) return null;
    return { state: st, reason: REASONS.has(t.reason) ? t.reason : (st === 'shown' ? '' : 'unspecified'), at: Number(t.at) || 0 };
  }).filter(Boolean).slice(-20) : [];
  // Backfill pre-history entries honestly from the timestamps/state already stored.
  if (!transitions.length && createdAt) transitions.push({ state: 'shown', reason: '', at: createdAt });
  if (state !== 'shown' && (!transitions.length || transitions[transitions.length - 1].state !== state)) transitions.push({ state, reason, at: updatedAt });
  return {
    id: clip(x.id, 120), surface: clip(x.surface, 40), kind: clip(x.kind, 60) || 'idea',
    title: clip(x.title, 240), target: clip(x.target, 240), fingerprint: fingerprint(x.fingerprint || x.title),
    evidence: Array.isArray(x.evidence) ? x.evidence.map(e => ({
      id: clip(e && e.id, 120), type: clip(e && e.type, 40), quote: clip(e && (e.quote || e.text), 280)
    })).filter(e => e.id || e.quote).slice(0, 12) : [],
    readiness: x.readiness && typeof x.readiness === 'object' ? {
      ready: !!x.readiness.ready,
      reasons: Array.isArray(x.readiness.reasons) ? x.readiness.reasons.map(r => clip(r, 40)).filter(Boolean).slice(0, 8) : []
    } : null,
    traits: normTraits(x.traits), projectId: clip(x.projectId, 160), goalId: clip(x.goalId, 120), threadId: clip(x.threadId, 120),
    contextId: clip(x.contextId, 120), rank: Number.isFinite(x.rank) ? Math.max(0, x.rank | 0) : null,
    score: Number.isFinite(x.score) ? x.score : null,
    scoreComponents: x.scoreComponents && typeof x.scoreComponents === 'object' ? Object.fromEntries(Object.entries(x.scoreComponents).slice(0, 16).map(([k, v]) => [clip(k, 40), finite(v, 0)])) : {},
    outcome: normOutcome(x.outcome),
    modelVersion: clip(x.modelVersion, 80), state, reason, transitions: transitions.slice(-20),
    createdAt, updatedAt,
    expiresAt: Number(x.expiresAt) || 0, completedAt: Number(x.completedAt) || 0,
    ...stampOf(x)
  };
}
function normalize(raw) {
  const x = raw && typeof raw === 'object' ? raw : {};
  return { v: 1, entries: Array.isArray(x.entries) ? x.entries.map(normalizeEntry).filter(e => e.id && e.title).slice(-CAP) : [] };
}

function replay(raw, opts) {
  opts = opts || {};
  const rows = normalize(raw).entries.filter(e => !opts.surface || e.surface === opts.surface);
  const counts = { shown: rows.length, opened: 0, accepted: 0, started: 0, deferred: 0, declined: 0, completed: 0, evidenced: 0, ready: 0, repeats: 0 };
  const transitions = { shown: rows.length, opened: 0, accepted: 0, started: 0, deferred: 0, declined: 0, completed: 0 };
  const seen = new Set(); const kinds = {}; const traits = {}; const projects = {};
  const now = Number.isFinite(opts.now) ? opts.now : rows.reduce((m, e) => Math.max(m, e.updatedAt || e.createdAt || 0), 0);
  function foldPref(map, key, e) {
    if (!key) return;
    const k = map[key] || (map[key] = { shown: 0, positive: 0, negative: 0, deferred: 0, quality: 0, costUsd: 0, weight: 0 });
    const age = Math.max(0, now - (e.updatedAt || e.createdAt || now));
    const decay = Math.pow(0.5, age / PREF_HALF_LIFE_MS);
    k.shown += decay;
    // Completion proves execution, not usefulness. Negative feedback overrides earlier interest.
    if (e.outcome.quality < 0 || e.reason === 'bad_quality') k.negative += decay;
    else if ((e.outcome.adopted || e.outcome.quality > 0 || e.state === 'accepted' || e.state === 'started') && e.reason !== 'already_done') k.positive += decay;
    else if (e.state === 'declined' && e.reason !== 'wrong_time' && e.reason !== 'already_done') k.negative += decay;
    else if (e.state === 'deferred') k.deferred += decay;
    k.quality += (e.outcome.quality || 0) * decay;
    k.costUsd += (e.outcome.costUsd || 0) * decay;
  }
  for (const e of rows) {
    const ever = new Set((e.transitions || []).map(t => t.state));
    if (ever.has('accepted')) counts.accepted++;
    if (e.state === 'completed') { counts.completed++; counts.started++; }
    else if (e.state === 'started') counts.started++;
    else if (e.state !== 'shown' && e.state !== 'accepted' && counts[e.state] != null) counts[e.state]++;
    for (const st of ever) if (transitions[st] != null && st !== 'shown') transitions[st]++;
    if (e.evidence.length) counts.evidenced++;
    if (e.readiness && e.readiness.ready) counts.ready++;
    if (e.fingerprint) { if (seen.has(e.fingerprint)) counts.repeats++; else seen.add(e.fingerprint); }
    foldPref(kinds, e.kind, e);
    for (const trait of e.traits) foldPref(traits, trait, e);
    if (e.projectId) foldPref(projects, e.projectId, e);
  }
  for (const map of [kinds, traits, projects]) for (const k of Object.keys(map)) {
    const x = map[k];
    // Bayesian-smoothed, bounded preference shift. A few clicks guide; they never freeze the system.
    x.weight = Math.max(-0.75, Math.min(0.75, (x.positive - x.negative + 0.5 * x.quality) / (x.shown + 2)));
    for (const n of ['shown', 'positive', 'negative', 'deferred', 'quality', 'costUsd']) x[n] = Math.round(x[n] * 1000) / 1000;
  }
  const d = Math.max(1, counts.shown);
  return {
    counts, transitions,
    acceptanceRate: (counts.accepted / d), completionRate: (counts.completed / d),
    evidenceCoverage: (counts.evidenced / d), readinessCoverage: (counts.ready / d), repeatRate: (counts.repeats / d),
    kinds, traits, projects
  };
}

function preferenceFor(model, candidate) {
  model = model || {}; candidate = candidate || {};
  let sum = 0, n = 0;
  const take = x => { if (x && Number.isFinite(x.weight)) { sum += x.weight; n++; } };
  take(model.kinds && model.kinds[candidate.kind]);
  if (candidate.projectId) take(model.projects && model.projects[candidate.projectId]);
  for (const t of normTraits(candidate.traits)) take(model.traits && model.traits[t]);
  return n ? Math.max(-0.75, Math.min(0.75, sum / n)) : 0;
}

/* The recommendation ledger is the live preference authority. Older installs may still have night-shift
   archetype weights in nightshift.learn.json, so retain those only as a per-kind fallback until the shared ledger
   has evidence for that kind. Pausing personalization must suppress both sources. */
function effectivePreferenceWeights(model, legacyWeights, enabled) {
  if (enabled === false) return {};
  const out = {};
  for (const [key, value] of Object.entries(legacyWeights && typeof legacyWeights === 'object' ? legacyWeights : {})) {
    const n = Number(value);
    if (key && Number.isFinite(n)) out[key] = Math.max(-0.75, Math.min(0.75, n));
  }
  const kinds = model && model.kinds && typeof model.kinds === 'object' ? model.kinds : {};
  for (const [key, value] of Object.entries(kinds)) {
    const n = Number(value && value.weight);
    if (key && Number.isFinite(n)) out[key] = Math.max(-0.75, Math.min(0.75, n));
  }
  return out;
}

// contextpack only needs the direction of each learned preference; derive that view from the same effective model.
function preferenceTallies(weights) {
  const out = {};
  for (const [key, value] of Object.entries(weights && typeof weights === 'object' ? weights : {})) {
    const n = Number(value);
    if (!key || !Number.isFinite(n) || n === 0) continue;
    out[key] = n > 0 ? { up: n, down: 0 } : { up: 0, down: -n };
  }
  return out;
}

/* One outcome-aware utility function for every recommendation family. Policy/eligibility remains a caller concern;
   this ranks only candidates the surface is allowed to show or execute. All terms are normalized 0..1. */
function rankCandidates(candidates, model, opts) {
  opts = opts || {};
  return (Array.isArray(candidates) ? candidates : []).map((raw, idx) => {
    const c = Object.assign({}, raw); const f = c.features || {};
    const components = {
      relevance: finite(f.relevance, 0.5), impact: finite(f.impact, 0.5), success: finite(f.success, 0.5),
      timeliness: finite(f.timeliness, 0.5), novelty: finite(f.novelty, 0.5), preference: preferenceFor(model, c),
      cost: finite(f.cost, 0), risk: finite(f.risk, 0), interruption: finite(f.interruption, 0), duplicate: finite(f.duplicate, 0)
    };
    const utility = components.relevance * 2 + components.impact * 1.5 + components.success + components.timeliness
      + components.novelty * 0.5 + components.preference
      - components.cost * 0.75 - components.risk * 1.5 - components.interruption - components.duplicate * 2;
    c.utility = Math.round(utility * 1000) / 1000; c.scoreComponents = components; c._idx = idx; return c;
  }).sort((a, b) => (b.utility - a.utility) || (a._idx - b._idx)).map((c, rank) => { delete c._idx; c.rank = rank + 1; return c; });
}

function makeRecommendationLedger(deps) {
  deps = deps || {};
  if (!deps.path || !deps.workspaces) throw new Error('makeRecommendationLedger: path + workspaces required');
  const learningEnabled = () => { try { return !deps.learningEnabled || deps.learningEnabled() !== false; } catch (_) { return false; } };
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: deps.path,
    fileFor: () => deps.path.join(deps.workspaces, 'recommendations.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });
  function read() { return normalize(durable.get(STORE_KEY)); }
  function list(opts) {
    opts = opts || {}; let rows = read().entries.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (opts.surface) rows = rows.filter(e => e.surface === String(opts.surface));
    if (opts.state) rows = rows.filter(e => e.state === String(opts.state));
    return rows.slice(0, Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 100);
  }
  function record(input, now) {
    if (!learningEnabled()) return Promise.resolve(null);
    const at = Number(now) || 0;
    const rec = normalizeEntry(Object.assign({}, input, { createdAt: at, updatedAt: at, state: 'shown', transitions: [{ state: 'shown', reason: '', at }] }));
    if (!rec.id || !rec.title) return Promise.resolve(null);
    let out = null;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur); const prior = s.entries.find(e => e.id === rec.id);
      if (prior) { out = prior; return undefined; }
      s.entries.push(rec); while (s.entries.length > CAP) s.entries.shift(); out = rec; return s;
    }).then(() => out);
  }
  function verdict(id, state, reason, now) {
    if (!learningEnabled()) return Promise.resolve(null);
    const sid = clip(id, 120); const st = STATES.has(state) && state !== 'shown' ? state : null;
    if (!sid || !st) return Promise.resolve(null);
    let out = null;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur); const e = s.entries.find(x => x.id === sid); if (!e) return undefined;
      if (e.state === st) { out = e; return undefined; }
      if (TERMINAL.has(e.state) || !NEXT[e.state] || !NEXT[e.state].has(st)) { out = null; return undefined; }
      const why = REASONS.has(reason) ? reason : (st === 'deferred' ? 'wrong_time' : st === 'completed' ? 'completed' : (st === 'accepted' || st === 'started') ? 'accepted' : 'unspecified');
      e.state = st; e.reason = why; e.updatedAt = Number(now) || e.updatedAt;
      if (!Array.isArray(e.transitions)) e.transitions = [];
      const prior = e.transitions[e.transitions.length - 1];
      if (!prior || prior.state !== st || prior.reason !== why) e.transitions.push({ state: st, reason: why, at: e.updatedAt });
      e.transitions = e.transitions.slice(-20);
      if (st === 'completed') e.completedAt = e.updatedAt; out = e; return s;
    }).then(() => out);
  }
  function verdictTarget(surface, target, state, reason, now) {
    const row = list({ surface, limit: CAP }).find(e => e.target === clip(target, 240) && !TERMINAL.has(e.state));
    return row ? verdict(row.id, state, reason, now) : Promise.resolve(null);
  }
  function outcome(id, patch, now) {
    if (!learningEnabled()) return Promise.resolve(null);
    const sid = clip(id, 120); let out = null;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur); const e = s.entries.find(x => x.id === sid); if (!e) return undefined;
      e.outcome = normOutcome(Object.assign({}, e.outcome, patch || {})); e.updatedAt = Number(now) || e.updatedAt; out = e; return s;
    }).then(() => out);
  }
  /* THE EXPIRY SWEEP (one-memory lane, 2026-08-05). `expiresAt` was normalized and stored on every row and then
     consulted by NOTHING — a surface could declare "this offer stops being answerable at T" and the ledger kept
     the un-answered impression forever, quietly depressing acceptanceRate for an offer nobody could act on.
     The sweep DROPS a row only when ALL THREE hold: it declared an expiry, the expiry has passed, and it was
     never answered (still `shown`/`opened`). An expiry is NEVER a verdict — deferred/accepted/declined/completed
     rows are the Commander's real answers and are kept regardless (the declinedindex law: TTL expiries never
     feed suppression, and a dropped row feeds nothing at all). Rows that declared no expiry are untouched. */
  function sweep(now) {
    const at = Number(now) || 0;
    if (!at) return Promise.resolve(0);
    let dropped = 0;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur);
      const keep = s.entries.filter(e => !(e.expiresAt > 0 && at > e.expiresAt && (e.state === 'shown' || e.state === 'opened')));
      dropped = s.entries.length - keep.length;
      if (!dropped) return undefined;
      s.entries = keep; return s;
    }).then(() => dropped);
  }
  function clear() { return durable.update(STORE_KEY, () => ({ v: 1, entries: [] })).then(() => true); }
  /* forget(match) -> Promise<number>: a deleted session's words leave the ledger (the forget registry; match(entry) reads the entry's own
     quote stamp). An entry the Commander DECLINED keeps its decision - the reject list the host dedups against, and the preference model's
     sample - but loses the evidence quotes; any other entry goes whole. */
  function forget(match) {
    let changed = 0;
    return durable.update(STORE_KEY, cur => {
      const s = normalize(cur);
      const next = [];
      for (const e of s.entries) {
        if (!match(e)) { next.push(e); continue; }
        changed++;
        if (e.state === 'declined') next.push(Object.assign({}, e, { evidence: [], quotes: undefined, quotesAt: undefined }));
      }
      if (!changed) return undefined;
      s.entries = next; return s;
    }).then(() => (changed ? durable.update(STORE_KEY, cur => normalize(cur)).then(() => changed) : 0));   // written twice: the .bak keeps the previous value
  }
  /* every text a declined row can be recognized by: the title AND the target (one-memory lane, 2026-08-05).
     A shelf decline's target is the recipe/class id; a spine decline's is a token fingerprint of the proposal.
     The shared declined index normalizes both, so a re-proposal that matches EITHER exactly is suppressed —
     and one that matches neither never is (the index's own false-suppression bar, unchanged). */
  function declinedTexts() {
    const out = [];
    for (const e of read().entries) {
      if (e.state !== 'declined') continue;
      out.push(e.title);
      if (e.target && e.target !== e.title) out.push(e.target);
    }
    return out;
  }
  function summary(opts) { return replay(read(), opts); }
  return { read, list, record, verdict, verdictTarget, outcome, sweep, clear, forget, declinedTexts, summary, _durable: durable };
}

module.exports = { makeRecommendationLedger, normalize, normalizeEntry, replay, fingerprint, preferenceFor,
  effectivePreferenceWeights, preferenceTallies, rankCandidates, STATES, REASONS, NEXT, TERMINAL };
