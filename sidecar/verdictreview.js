/* sidecar/verdictreview.js — VERDICT-TRIGGERED SKILL REVIEW (consistency loop, slice 1, 2026-08-22).

   The background skill review (skillreview.js) fires on run SIZE — ≥4 tool calls, ≥8 turns, ≥5000 chars. The
   Commander's own verdict on the work was never an input: a small run rated `miss` taught the skillbase nothing,
   which is exactly the consistency complaint ("it did it wrong, and next week it does it wrong again").

   This module is the pure half of the fix. At run end, a run that did NOT earn a size-review gets a compact
   REVIEW PACKET parked here (the transcript + the aux provider handles the review would need). When a verdict
   arrives on POST /api/growth/ratings and it is `ok` or `miss`, the packet is TAKEN (once) and index.js runs the
   same quiet review loop with the verdict in the prompt. `great` never triggers — praise is not a lesson.

   Bounded by construction: a capped LRU (oldest evicted), a TTL so a stale packet never reviews a run the
   Commander rated long after against a skillbase that has since moved, and take() deletes. Durable since
   2026-10-01: onChange/restore round-trip a compacted, provider-free packet across restarts, and a run that
   ended in failure (max_iters/budget/refusal) is parked too: a `miss` on failed work is a lesson as well. Pure + clock-injected
   (node-testable); index.js owns the provider objects and the loop. */
'use strict';

const { buildLearningEvidence } = require('./learningevidence.js');
const { note: failNote } = require('./failopen.js');   // a swallowed error stays visible (repo fail-open ratchet)

const VERDICTS_THAT_TEACH = new Set(['ok', 'miss']);

// reviewPassFinished — the host launcher's answer to fireHeld (true = finished, false = retry later). A pass that
// reached one of its OWN stops (done/empty, its per-pass $ cap, its turn ceiling, its deadline) or that changed the
// skillbase already did its work: a retry re-pays the same pass and stages a further revision of the same candidate
// under a fresh run id. Only a pass that FAILED (reason 'error') before it changed anything earns another attempt —
// and so does a pass its DEADLINE cancelled before the model produced anything (a cold local model still loading,
// a provider that hung once): it did no work and billed nothing, and the bounded retry likely meets a warm model.
// "Produced" is read off the loop's own result: any spend, any assistant text, tool call or reasoning. A result
// without a message list cannot prove it produced nothing, so it counts as done (no paid re-run on a guess).
function modelProduced(result) {
  if (Number(result.usd) > 0 || Number(result.tokens) > 0 || !Array.isArray(result.messages)) return true;
  return result.messages.some(m => m && m.role === 'assistant' && (String(m.content == null ? '' : m.content).trim()
    || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || (Array.isArray(m.reasoning) && m.reasoning.length > 0)));
}
function reviewPassFinished(result, changedSkillbase) {
  if (!result || typeof result !== 'object') return false;
  if (changedSkillbase === true) return true;
  if (result.reason === 'error') return false;
  return !(result.reason === 'cancelled' && !modelProduced(result));
}

// compactPacket — the persistable half of a review packet: no provider/cost objects (they are live handles, and a
// provider can carry a credential), and only the transcript the review prompt can actually read (skillreview's
// transcript() tail-caps at 12k chars) plus the run's directive, so a packet on disk stays a few KB.
const PERSIST_CHARS = 16000;
const PER_MESSAGE_CHARS = 4000;
// the FINAL answer is kept whole (up to this cap): a `great` rating after a restart mints a golden from it, and a
// golden measured against a truncated output would flag every faithful later run as off-length.
const FINAL_CHARS = 60000;
// redact (optional): the host's secret scrub — a tool that read a .env or an API response put that text in the
// transcript, and a packet on disk must never hold it in cleartext (every other durable transcript store redacts).
function compactPacket(p, redact) {
  p = p || {};
  const scrub = typeof redact === 'function' ? (t) => { try { return String(redact(t)); } catch (e) { failNote('verdict.compact', e); return ''; } } : (t) => t;   // fail closed, never silent
  const learningEvidence = buildLearningEvidence(p, redact);
  const msgs = learningEvidence.trustedOnly ? [] : (Array.isArray(p.messages) ? p.messages : []);
  let finalAt = -1;
  for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) { finalAt = i; break; } }
  const keep = [];
  let used = 0;
  for (let i = msgs.length - 1; i >= 0 && used < PERSIST_CHARS; i--) {
    const m = msgs[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) continue;
    const c = typeof m.content === 'string' ? scrub(m.content.slice(0, i === finalAt ? FINAL_CHARS : PER_MESSAGE_CHARS)) : '';
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.map(tc => ({ function: { name: String((tc && tc.function && tc.function.name) || '') } })).filter(tc => tc.function.name) : [];
    if (!c && !calls.length) continue;
    keep.unshift(calls.length ? { role: m.role, content: c, tool_calls: calls } : { role: m.role, content: c });
    if (i !== finalAt) used += c.length;   // the final answer never crowds the transcript tail out
  }
  // the directive (latest user turn) anchors the review's memory ranking: keep it even when the tail cut it off
  if (!keep.some(m => m.role === 'user')) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) { keep.unshift({ role: 'user', content: scrub(m.content.slice(0, PER_MESSAGE_CHARS)) }); break; }
    }
  }
  const skillRefs = list => (Array.isArray(list) ? list : []).map(s => s && ({ id: s.id, target: s.target, name: s.name, summary: s.summary, action: s.action })).filter(Boolean);
  // the run's directive as the station captured it before expansion (TurnDirective.packet: { rowId, text }, text already
  // safe; re-scrubbed here as a belt) and its stream, so a rating after a restart reads the same directive. Absent on a
  // packet that never carried them (the persisted shape is then unchanged).
  const d = p.directive && typeof p.directive === 'object' ? p.directive : null;
  const directive = d ? { rowId: Number.isSafeInteger(d.rowId) && d.rowId > 0 ? d.rowId : 0, text: scrub(String(d.text == null ? '' : d.text).slice(0, PER_MESSAGE_CHARS)) } : null;
  return {
    learningEvidence,
    agentId: String(p.agentId || 'agent'), messages: keep, model: p.model ? String(p.model) : '',
    loadedSkills: skillRefs(p.loadedSkills), managedSkills: skillRefs(p.managedSkills), unmetered: !!p.unmetered, failed: !!p.failed,
    // the run's outcome rides beside its reason (typed outcomes): runOnceCore's stash hands the lead's outcome-aware reason and its outcome
    reason: String(p.reason || ''), outcome: String(p.outcome || '').slice(0, 40), correctionSource: String(p.correctionSource || ''),
    ...(directive ? { directive } : {}), ...(p.streamId ? { streamId: String(p.streamId).slice(0, 200) } : {})
  };
}

function makeVerdictReview(opts) {
  opts = opts || {};
  const cap = Number.isFinite(opts.cap) && opts.cap > 0 ? Math.floor(opts.cap) : 40;
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : 6 * 60 * 60 * 1000;
  const now = typeof opts.now === 'function' ? opts.now : () => 0;   // clock is INJECTED (repo determinism law); index.js passes the real one
  const held = new Map();
  const packets = new Map();   // runId -> { at, packet }  (Map keeps insertion order = LRU by arrival)
  // DURABILITY (2026-10-01): a verdict given after a restart used to find no packet and teach nothing. onChange
  // hands the caller a compacted, provider-free snapshot to persist; restore() reloads it on boot. A restored
  // packet has no live provider: the caller rebuilds one for the agent when the review fires.
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  // meta.ack:false marks a save no caller waits on (stash, take): the host may batch it. Every other transition
  // (arm, correct, fire, retry, complete) acts on the result, so it stays a synchronous, verified save.
  function changed(meta) {
    if (!onChange) return true;
    try { const result = onChange(snapshot(), meta || { ack: true }); if (result === false || (result && typeof result.then === 'function')) throw new Error('review persistence must complete synchronously'); return true; } catch (e) { failNote('verdictreview.persist', e); return false; }
  }
  // Each row is compacted once, not on every save: a run end used to recompact and re-scrub every parked packet.
  // A parked packet never changes after stash; a held row is recompacted only when its verdict or correction does.
  // The rows share these cached objects, so a caller treats a snapshot as read-only.
  // The cache never freezes redaction: redact() also scrubs the exact secrets the station holds, read live, so the
  // host's known-secret generation (opts.redactGeneration) keys every cached row. A token stored to the station after
  // its run ended leaves every saved row at the next save. A generation that cannot be read forces a fresh compaction.
  const redactGeneration = typeof opts.redactGeneration === 'function' ? opts.redactGeneration : null;
  let unreadGenerations = 0;
  function secretGeneration() {
    if (!redactGeneration) return '';
    try { return 'g:' + String(redactGeneration()); } catch (e) { failNote('verdictreview.redactGeneration', e); return 'unread:' + (++unreadGenerations); }
  }
  function parkedCompact(row, gen) {
    if (!row.compact || row.compactGen !== gen) { row.compact = compactPacket(row.packet, opts.redact); row.compactGen = gen; }
    return row.compact;
  }
  function heldCompact(h, runId, gen) {
    const key = JSON.stringify([runId, gen, h.verdict, h.correction, h.correctionOriginalChars, h.correctionTruncated, h.correctionSource || '']);
    if (h.compactKey !== key) { h.compact = compactPacket(jobFor(h, runId, 'snapshot'), opts.redact); h.compactKey = key; }
    return h.compact;
  }
  function snapshot() {
    const rows = [], gen = secretGeneration();
    for (const [runId, row] of packets) rows.push({ runId, at: row.at, packet: parkedCompact(row, gen) });
    for (const [runId, h] of held) {
      const packet = heldCompact(h, runId, gen);
      const correction = packet.learningEvidence && packet.learningEvidence.correction;
      rows.push({ runId, at: h.at, ratedAt: h.ratedAt, state: 'held', reviewStatus: h.status, dueAt: h.dueAt, attempts: h.attempts, persistenceFailures: h.persistenceFailures || 0, persistenceBlocked: h.persistenceBlocked === true,
        verdict: h.verdict, correction: correction ? correction.text : '', correctionSource: h.correctionSource,
        correctionOriginalChars: correction ? correction.originalChars : 0, correctionTruncated: !!(correction && correction.truncated), packet });
    }
    return rows;
  }
  function restore(rows) {
    let n = 0;
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String((r && r.runId) || '').trim();
      if (!id || !r.packet || typeof r.packet !== 'object' || !Number.isFinite(r.at)) continue;
      if (r.state === 'held') {
        if (!VERDICTS_THAT_TEACH.has(r.verdict) || r.reviewStatus === 'completed') continue;
        held.set(id, { at: r.at, ratedAt: Number.isFinite(r.ratedAt) ? r.ratedAt : r.at, packet: Object.assign({}, r.packet, { restored: true }), verdict: r.verdict,
          ...correctionParts(r.correction, r.correctionOriginalChars, r.correctionTruncated), correctionSource: String(r.correctionSource || ''),
          dueAt: r.reviewStatus === 'running' ? now() + retryMs : (Number.isFinite(r.dueAt) ? r.dueAt : now() + graceMs),
          // A held row on disk proves a later save succeeded, so a storage block never outlives the boot it happened
          // in: fireHeld re-verifies durability before dispatch, and the retry bound applies again from zero.
          persistenceFailures: 0, persistenceBlocked: false,
          attempts: Math.max(0, Number(r.attempts) || 0), status: r.reviewStatus === 'retry-exhausted' ? 'retry-exhausted' : 'pending', timer: null, fire: null });
      } else packets.set(id, { at: r.at, packet: Object.assign({}, r.packet, { restored: true }) });
      n++;
    }
    sweep();
    return n;
  }

  // An ARMED review (running, or pending with an attempt left and storage working) is a lesson the rating route
  // already reported armed: the cap never counts or evicts it, so an unrelated run ending inside its grace or retry
  // window cannot drop it. Only parked packets and dormant held rows (retry-exhausted, storage-blocked) are capped.
  function liveHeld(r) { return r.status === 'running' || (r.status === 'pending' && !r.persistenceBlocked && r.attempts < maxAttempts); }
  /* A held job ages from its RUN (`at`), exactly like a parked packet: the TTL is what keeps a review from running
     against a skillbase that moved long after the work. The one allowance: an ARMED job rated near that edge keeps
     its own bounded schedule — the grace window plus its retries, counted from the rating — so a review the rating
     route reported armed is not aged out mid-grace. A dormant row (retry-exhausted, storage-blocked) gets none, so a
     later correction cannot revive a run past its TTL; and nothing stretches the age by a full TTL from the rating. */
  function heldExpired(h, t) {
    if (t - h.at <= ttlMs) return false;
    const ratedAt = Number.isFinite(h.ratedAt) ? h.ratedAt : h.at;
    return !(liveHeld(h) && t - ratedAt <= graceMs + maxAttempts * retryMs);
  }
  function sweep() {
    const t = now();
    const before = packets.size + held.size;
    for (const [id, row] of packets) if (t - row.at > ttlMs) packets.delete(id);
    for (const [id, row] of held) if (row.status !== 'running' && heldExpired(row, t)) { clearT(row.timer); held.delete(id); }
    for (;;) {
      const candidates = [...packets].map(([id, r]) => ({ id, at: r.at, held: false })).concat([...held].filter(([, r]) => !liveHeld(r)).map(([id, r]) => ({ id, at: r.at, held: true }))).sort((a, b) => a.at - b.at);
      if (candidates.length <= cap) break;
      const oldest = candidates[0];
      if (oldest.held) { clearT(held.get(oldest.id).timer); held.delete(oldest.id); } else packets.delete(oldest.id);
    }
    return packets.size + held.size !== before;
  }

  // park a run's review packet. Only runs that were NOT already reviewed belong here (the caller decides);
  // a second stash for the same runId replaces the first (latest state wins).
  function stash(runId, packet) {
    const id = String(runId || '').trim();
    if (!id || !packet || typeof packet !== 'object' || held.has(id)) return false;
    packets.delete(id);
    packets.set(id, { at: now(), packet });
    sweep();
    changed({ ack: false });
    return true;
  }

  // does this verdict earn a review? praise never does; only a real run (reason done) with a packet on file.
  function shouldTrigger(runId, verdict) {
    const id = String(runId || '').trim();
    if (!id || !VERDICTS_THAT_TEACH.has(String(verdict || ''))) return false;
    sweep();
    return packets.has(id);
  }

  // take the packet (once). Returns null when there is none or the verdict does not teach.
  function take(runId, verdict) {
    if (!shouldTrigger(runId, verdict)) return null;
    const id = String(runId).trim();
    const row = packets.get(id);
    packets.delete(id);
    changed({ ack: false });
    return row ? row.packet : null;
  }

  function size() { sweep(); return packets.size; }
  function has(runId) { sweep(); return packets.has(String(runId || '').trim()); }

  /* ---- CORRECTION GRACE (slice 2, 2026-08-22) ----
     A verdict alone says "this fell short"; the Commander's NEXT words say HOW. Firing the review the instant the
     verdict lands threw those words away. arm() takes the packet and holds it for `graceMs`; correct() attaches
     the Commander's correction — a chip tap (final:false) keeps waiting for the typed message, a typed message
     (final:true) fires the review NOW with their words; the timer fires with whatever arrived. One review per
     run either way (held map is keyed by runId; fire is single-shot). Timers are INJECTED (determinism law). */
  const setT = typeof opts.setTimeout === 'function' ? opts.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof opts.clearTimeout === 'function' ? opts.clearTimeout : (h) => clearTimeout(h);
  const graceMs = Number.isFinite(opts.graceMs) && opts.graceMs >= 0 ? opts.graceMs : 90 * 1000;
  const retryMs = Number.isFinite(opts.retryMs) && opts.retryMs > 0 ? opts.retryMs : 60000;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && opts.maxAttempts > 0 ? opts.maxAttempts : 3;
  const maxPersistenceAttempts = Number.isInteger(opts.maxPersistenceAttempts) && opts.maxPersistenceAttempts > 0 ? opts.maxPersistenceAttempts : 3;
  function correctionParts(value, originalChars, truncated) {
    const full = String(value || '').replace(/\s+/g, ' ').trim();
    return { correction: full.slice(0, 600), correctionOriginalChars: Math.max(full.length, Number(originalChars) || 0),
      correctionTruncated: truncated === true || full.length > 600 || (Number(originalChars) || 0) > full.length };
  }
  function jobFor(h, id, why) {
    return Object.assign({}, h.packet, { runId: id, verdict: h.verdict, correction: h.correction,
      correctionOriginalChars: h.correctionOriginalChars, correctionTruncated: h.correctionTruncated,
      correctionSource: h.correctionSource || '', firedBy: why, reviewAttempt: h.attempts });
  }
  function scheduleHeld(id) {
    const h = held.get(id);
    if (!h || typeof h.fire !== 'function' || h.status !== 'pending' || h.attempts >= maxAttempts || h.persistenceBlocked) return false;
    if (h.timer) clearT(h.timer);
    h.timer = setT(() => fireHeld(id, 'grace'), Math.max(1, h.dueAt - now()));
    if (h.timer && h.timer.unref) h.timer.unref();
    return true;
  }
  // Storage retries have their own bound and never count as model attempts. The
  // continuation must re-save its state before it can dispatch or drop a review.
  function retryPersistenceOnly(id, continuation) {
    const h = held.get(id); if (!h) return;
    if (h.timer) clearT(h.timer);
    h.timer = null;
    h.persistenceFailures = (h.persistenceFailures || 0) + 1;
    h.persistenceBlocked = h.persistenceFailures >= maxPersistenceAttempts;
    h.dueAt = now() + retryMs;
    if (h.persistenceBlocked) return;
    h.timer = setT(() => { h.timer = null; if (held.get(id) === h) continuation(); }, retryMs);
    if (h.timer && h.timer.unref) h.timer.unref();
  }
  function persistenceSucceeded(h) { h.persistenceFailures = 0; h.persistenceBlocked = false; }
  function persistRetryState(id) {
    const h = held.get(id); if (!h) return;
    if (changed()) { persistenceSucceeded(h); scheduleHeld(id); }
    else retryPersistenceOnly(id, () => persistRetryState(id));
  }
  function retryHeld(id, error) {
    const h = held.get(id); if (!h) return;
    if (error) failNote('verdictreview.fire', error);
    h.status = h.attempts >= maxAttempts ? 'retry-exhausted' : 'pending';
    h.dueAt = now() + retryMs;
    persistRetryState(id);
  }
  function completeHeld(id) {
    const h = held.get(id); if (!h) return;
    // Persist completion before dropping the in-memory job. This is at-least-once
    // recovery; the host must deduplicate side effects by runId when needed.
    h.status = 'completed';
    if (changed()) held.delete(id);
    else retryPersistenceOnly(id, () => completeHeld(id));
  }
  function fireHeld(id, why) {
    const h = held.get(id); if (!h || h.status === 'running' || h.status === 'completed' || h.persistenceBlocked || typeof h.fire !== 'function') return false;
    if (heldExpired(h, now())) { held.delete(id); changed(); return false; }
    try { clearT(h.timer); } catch (e) { failNote('verdictreview.clearTimer', e); }
    h.timer = null; h.status = 'running'; h.attempts++;
    if (!changed()) { h.status = 'pending'; h.attempts--; retryPersistenceOnly(id, () => fireHeld(id, 'persistence-retry')); return false; }
    persistenceSucceeded(h);
    let result;
    try { result = h.fire(jobFor(h, id, why)); }
    catch (e) { retryHeld(id, e); return false; }
    if (result && typeof result.then === 'function') result.then(value => value === false ? retryHeld(id) : completeHeld(id), error => retryHeld(id, error));
    else if (result === false) retryHeld(id);
    else completeHeld(id);
    return true;
  }
  function arm(runId, verdict, fire, initialCorrection) {
    const id = String(runId || '').trim();
    if (typeof fire !== 'function' || held.has(id) || !shouldTrigger(id, verdict)) return false;
    const row = packets.get(id);
    // `at` stays the RUN's (the TTL's anchor); `ratedAt` only bounds the armed grace/retry schedule (heldExpired)
    const h = { at: row.at, ratedAt: now(), packet: row.packet, verdict: String(verdict), ...correctionParts(initialCorrection),
      correctionSource: initialCorrection ? 'verdict' : '', timer: null, fire, dueAt: now() + graceMs, attempts: 0, persistenceFailures: 0, persistenceBlocked: false, status: 'pending' };
    packets.delete(id); held.set(id, h);
    if (!changed()) { held.delete(id); packets.set(id, row); return false; }
    if (graceMs === 0) fireHeld(id, 'immediate'); else scheduleHeld(id);
    return true;
  }
  function correct(runId, text, final, source) {
    const id = String(runId || '').trim(), h = held.get(id);
    if (!h || h.status === 'running' || h.status === 'completed') return { ok: false, reason: 'nothing held for this run' };
    // judged BEFORE a final correction resets the attempts: a dormant row past its run's TTL is gone, not revived
    if (heldExpired(h, now())) { clearT(h.timer); held.delete(id); changed(); return { ok: false, reason: 'nothing held for this run' }; }
    const previous = { ...h }, incoming = correctionParts(text);
    if (incoming.correction) {
      const parts = h.correction && !final ? correctionParts(h.correction + ' · ' + incoming.correction,
        h.correctionOriginalChars + 3 + incoming.correctionOriginalChars, h.correctionTruncated || incoming.correctionTruncated) : incoming;
      Object.assign(h, parts, { correctionSource: String(source || (final ? 'message' : 'chip')) });
    }
    if (final) { h.attempts = 0; h.status = 'pending'; persistenceSucceeded(h); }
    if (!changed()) { Object.assign(h, previous); return { ok: false, reason: 'review correction could not be persisted' }; }
    if (final) return { ok: true, fired: fireHeld(id, 'correction') };
    return { ok: true, fired: false };
  }
  // Restore stores held jobs without dispatching during module construction. The
  // composition root supplies its current promise-returning launcher after boot.
  function resumeHeld(fire) {
    if (typeof fire !== 'function') return 0;
    sweep(); let count = 0;
    for (const [id, h] of held) { h.fire = fire; if (scheduleHeld(id)) count++; }
    return count;
  }
  function holding(runId) { return held.has(String(runId || '').trim()); }
  /* forget(match) -> number: the forget registry's purge. Every parked packet and every held review `match(runId, packet, at)` names goes -
     a held one has its timer cleared first, so a rating given before a session was deleted fires no review of it afterwards (a review
     already RUNNING finishes on its own copy: completeHeld finds nothing held and returns). Persisted at once, acknowledged. */
  function forget(match) {
    let n = 0;
    for (const [id, row] of Array.from(packets)) if (match(id, row.packet, row.at)) { packets.delete(id); n++; }
    for (const [id, h] of Array.from(held)) if (match(id, h.packet, h.at)) { clearT(h.timer); h.timer = null; held.delete(id); n++; }
    if (n) { changed(); changed(); }   // twice: the store keeps the previous value as its .bak, and the second save puts the purged copy there too
    return n;
  }
  // peek: read a parked packet WITHOUT consuming it (slice 4: a `great` verdict reads which skills the run loaded
  // to mint a golden; it never spends the packet — praise is not a review).
  function peek(runId) { sweep(); const row = packets.get(String(runId || '').trim()); return row ? row.packet : null; }

  return { stash, shouldTrigger, take, size, has, cap, ttlMs, arm, correct, holding, peek, graceMs, snapshot, restore, resumeHeld, forget };
}

module.exports = { makeVerdictReview, VERDICTS_THAT_TEACH, compactPacket, reviewPassFinished };
