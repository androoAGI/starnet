/* sidecar/memcore.js — Cortex M-mem.6 "Memory Core": the PURE reductions + record ops behind the
   provenance panel. The stored per-record stats (useCount / lastUsedAt / trust) are a REDUCTION over the
   real memory.* event log — never invented — folded onto the §5.2 record as those events arrive. pin / edit
   / forget are pure array transforms the host binds to the notebook store. No IO, no ambient time: `now`
   is injected, so this is deterministic + lint-determinism-clean (only sidecar/index.js, the composition
   root, may read the wall clock and pass it in). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).memcore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TRUST_STEP = 0.15;   // each signed memory.feedback delta nudges trust by delta*step, clamped to [0,1]
  const TRUST_HALFLIFE_MS = 2592e6;   // 30d: an UNREINFORCED endorsement decays to half its weight (parity with the reference harness' trust decay)
  const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

  // fold ONE memory.feedback delta into a record's [0,1] trust. Honest: a clamped sum of the REAL deltas
  // (keep +2 / edit +1 / discard -1), no invented prior — a record with no feedback sits at 0, climbing only
  // as the user endorses it. The STORED value is the raw earned trust; decayTrust() applies time-fade at read.
  function nextTrust(prev, delta) {
    const t = (typeof prev === 'number' && isFinite(prev)) ? prev : 0;
    const d = (typeof delta === 'number' && isFinite(delta)) ? delta : 0;
    return clamp01(t + d * TRUST_STEP);
  }

  // decayTrust(stored, lastReinforcedAt, now, halfLifeMs) -> [0,1] : the effective trust at `now`. A record's
  // EARNED trust fades toward 0 the longer it goes without re-endorsement — so a single stale "keep" from months
  // ago no longer props a memory up forever (the reference harness filters low-trust facts from recall; we de-weight them, never
  // silently drop them — pinned/relevance still win, so this only shifts ties). PURE: `now` is injected, no decay
  // when the reinforcement time is unknown/in the future (returns the raw value). This is the canonical fade math;
  // context.rank() mirrors it inline for the recall score — keep the two in sync.
  function decayTrust(stored, lastReinforcedAt, now, halfLifeMs) {
    const t = clamp01(Number(stored) || 0);
    const ref = Number(lastReinforcedAt) || 0;
    const n = Number(now) || 0;
    if (t <= 0 || ref <= 0 || n <= ref) return t;
    const hl = (Number(halfLifeMs) > 0) ? Number(halfLifeMs) : TRUST_HALFLIFE_MS;
    return clamp01(t * Math.pow(0.5, (n - ref) / hl));
  }

  // ---- near-duplicate detection (parity with the reference harness: Jaccard token overlap, dependency-free) ----
  // catches PARAPHRASE dupes that exact-text equality misses ("the user prefers npm start" vs "prefers npm start
  // over serve"), so reflection doesn't clutter the turn-in beat and the panel can flag redundant beliefs.
  const SIM_STOP = new Set(('a an the of to in on for and or but is are was were be been it its this that with as at by from your you i we they').split(/\s+/));
  function simTokens(s) {   // mirrors context.tokenize (3+ char alnum, stopword-stripped) — kept inline so memcore stays standalone
    const set = new Set();
    for (const t of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3 && !SIM_STOP.has(t)) set.add(t);
    return set;
  }
  function tokenJaccard(a, b) {
    const A = simTokens(a), B = simTokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0; for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }
  // first existing record whose text is >= threshold-similar to `text` (the near-dupe it would shadow), or null.
  function findSimilar(records, text, opts) {
    const threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : 0.6;
    for (const r of (Array.isArray(records) ? records : [])) {
      if (!r) continue;
      const rt = r.content != null ? r.content : ((r.title || '') + ' ' + (r.body || ''));
      if (tokenJaccard(rt, text) >= threshold) return r;
    }
    return null;
  }

  // ---- ORIGIN: which surface a memory was formed on ----
  // Memory used to form ONLY on the watched browser run, so every record was self-evidently the Commander's own
  // conversation. Now that unattended runs reflect too, a belief can be learned from a scheduled routine, a
  // night-shift shift, or a messaging channel — and the Commander must be able to SEE that, because "the agent
  // believes this about me" and "someone in a group chat said this" are different claims. Channel DMs are
  // owner-gated upstream (channels/adapter.js ownerOk), so the real exposure is a whitelisted group chat; either
  // way the honest answer is to record where the belief came from rather than to flatten it.
  // PURE + total: an unknown/absent run context is 'commander' (the historical meaning of an untagged record).
  const ORIGIN_MAX = 24;
  function originOf(run) {
    run = run || {};
    const src = String(run.taskSource == null ? '' : run.taskSource).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const trigger = String(run.trigger == null ? '' : run.trigger).toLowerCase();
    if (src === 'interactive') return 'commander';   // the browser COMMS run — the Commander in person
    if (src === 'api') return 'api';                 // the local OpenAI-compatible endpoint
    if (src) return 'channel:' + src.slice(0, ORIGIN_MAX);   // telegram / discord / … — the channel names itself
    if (trigger === 'nightshift') return 'nightshift';
    if (trigger === 'schedule') return 'schedule';   // cron fire, Run Now, and the away-workshop shift
    return 'commander';
  }

  // collision-proof record id: one past the HIGHEST existing note_N — NOT positional ('note_'+list.length),
  // which reuses a freed slot after a forget and produces a DUPLICATE id (then every id-keyed op corrupts or
  // deletes the wrong record). Pure + deterministic; shared by both writers (the turn-in keep + notebook.write).
  function nextNoteId(records) {
    let max = 0;
    for (const r of (Array.isArray(records) ? records : [])) {
      const m = /^note_(\d+)$/.exec(r && r.id);
      if (m) { const n = +m[1]; if (n > max) max = n; }
    }
    return 'note_' + (max + 1);
  }

  // reduceStats(records, event, {now}) -> records' : fold ONE memory.* event onto the matching record.
  //   memory.used     -> useCount++ + lastUsedAt = now   (surfacing a record into a prompt IS a use)
  //   memory.feedback -> trust = nextTrust(trust, delta)
  // PURE: returns NEW record objects for what changed, and the SAME array ref when nothing changed (so the
  // host can skip a store write). An unknown event/id is a safe no-op. FIRST match only — so a pre-existing
  // duplicate id (e.g. from an old save written under the positional scheme) can never multi-mutate.
  function reduceStats(records, event, opts) {
    const recs = Array.isArray(records) ? records : [];
    const ev = event || {}, p = ev.payload || {}, name = ev.name;
    const now = (opts && opts.now != null) ? opts.now : 0;
    const id = p.id;
    if (!id || (name !== 'memory.used' && name !== 'memory.feedback')) return recs;
    let changed = false;
    const out = recs.map(r => {
      if (changed || !r || r.id !== id) return r;   // first match only
      changed = true;
      if (name === 'memory.used') return Object.assign({}, r, { useCount: (r.useCount || 0) + 1, lastUsedAt: now });
      // memory.feedback: nudge trust AND stamp the reinforcement clock so decayTrust() measures fade from the
      // LAST endorsement, not creation — a re-kept belief regains full weight; an un-touched one fades.
      return Object.assign({}, r, { trust: nextTrust(r.trust, p.delta), lastFeedbackAt: now });
    });
    return changed ? out : recs;
  }

  // ---- pure record-array ops for the Memory Core management UI (pin / edit / forget) ----
  // each returns { records: newArray, found: bool }; never mutates the input array or any record object.
  function applyPin(records, id, pinned) {
    let found = false;
    const out = (Array.isArray(records) ? records : []).map(r => {
      if (!found && r && r.id === id) { found = true; return Object.assign({}, r, { pinned: !!pinned }); }
      return r;
    });
    return { records: out, found };
  }
  // edit the belief text: mirror it into BOTH `content` (the §5.2 field rank() reads for typed records) and
  // `body` (the legacy field notes + recall + the dossier render). Provenance (sourceRunId / createdAt / kind
  // / title) is preserved — an edit refines a belief, it doesn't change which run earned it.
  function applyEdit(records, id, content) {
    const c = String(content == null ? '' : content);
    let found = false;
    const out = (Array.isArray(records) ? records : []).map(r => {
      if (!found && r && r.id === id) { found = true; return Object.assign({}, r, { content: c, body: c }); }
      return r;
    });
    return { records: out, found };
  }
  function applyForget(records, id) {
    let found = false;
    const out = (Array.isArray(records) ? records : []).filter(r => {
      if (!found && r && r.id === id) { found = true; return false; }   // first match only — never delete a dup too
      return true;
    });
    return { records: out, found };
  }

  // the FULL §5.2 view for the Memory Core panel (the slim /api/notebook projection drops everything but
  // id/title/body/ts). Pure shaping only — the host applies redact() before it leaves the process. When `now`
  // is passed, also surfaces `effectiveTrust` (the time-decayed trust the recall ranker actually uses) +
  // `lastFeedbackAt` so the panel can show "earned X, now weighs Y" — the provenance/trust story made visible.
  function projectRecord(r, now) {
    r = r || {};
    const text = r.content != null ? r.content : (r.body != null ? r.body : '');
    const trust = clamp01(Number(r.trust) || 0);
    const out = {
      id: r.id || '', kind: r.kind || 'note',
      title: String(r.title || ''), body: String(text || ''),
      scope: r.scope || 'global', streamId: r.streamId || null,
      ...(r.projectRoot ? { projectRoot: r.projectRoot } : {}),
      sourceRunId: r.sourceRunId || null,
      // an untagged legacy record predates unattended memory, so it can only have come from the Commander's own
      // COMMS run — 'commander' is the honest default, not a guess.
      origin: r.origin || 'commander',
      createdAt: r.createdAt || r.ts || 0, lastUsedAt: r.lastUsedAt || null,
      lastFeedbackAt: r.lastFeedbackAt || null,
      useCount: r.useCount || 0, trust: trust, pinned: !!r.pinned
    };
    if (now != null) out.effectiveTrust = decayTrust(trust, r.lastFeedbackAt || r.createdAt || r.ts || 0, now);
    if (r.revision) { out.revision = r.revision; out.updatedAt = r.updatedAt; out.updatedSourceRunId = r.updatedSourceRunId; }
    return out;
  }

  return { TRUST_STEP, TRUST_HALFLIFE_MS, clamp01, nextTrust, decayTrust, tokenJaccard, findSimilar, nextNoteId, originOf, reduceStats, applyPin, applyEdit, applyForget, projectRecord };
});
