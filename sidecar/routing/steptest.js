/* sidecar/routing/steptest.js — the conveyor STEP-THROUGH TEST (Andrew's ruling, 2026-09-22).

   The Commander runs their OWN job through a real work line and the line PAUSES after each dock finishes: they
   see the exact text that would be handed to the next dock, can edit it, re-run the step (after changing the
   bay's brief), rewind to an earlier hop, change where it stops, or stop. "Try this step" in the Workflow panel
   is the same engine with `single:true` — one dock, then done, with the next dock only PREVIEWED.

   NOT A SECOND DIALECT OF THE EXECUTOR. Every decision a hop makes is the chain runner's own (chain.js):
     • the handoff turn          -> hopTurn            (Pipeline.handoffPrompt + the receiver's standing brief +
                                                         the VERDICT-line instruction when a verdict gate is ahead)
     • the loop gate             -> loopDecision       (THE ONE LOOP RULE: passes, max, verdict/tag, escalation)
     • the pre-hop guards        -> preHopRefusal      (re-visit, hop ceiling, $ ceiling, daily cap, empty crate)
     • the line gate's refusal   -> lineRefusalNote
     • the ceilings              -> effectiveLimits    (the line's LINE BUDGET clamped to the station's pool)
   and the routing reads are the router's (chainStep to advance, chainPeek to PREVIEW without moving a splitter's
   round-robin). The only thing this module adds is the PAUSE between hops, and the bookkeeping that makes a
   pause, an edit, a re-run and a rewind honest.

   LAWS
   • THE LINE BUDGET COVERS THE WHOLE SESSION. maxUsdPerMessage is measured against every dollar this test spent —
     re-runs and rewound (dropped) hops included, because that money really left. Checked PRE-run (a run's cost
     is unknowable before it runs), exactly like the executor. A refusal ends in state 'stopped' with an honest
     error; nothing is silently skipped.
   • THE NEXT DOCK IS RESOLVED AT CONTINUE TIME from the CURRENT plan, never frozen at pause time: a bay added on
     the floor while paused (the plan re-posts) receives the crate. The pause only carries a PREVIEW.
   • THE OWNER'S WORDS ARE NEVER AN AGENT'S. A continued handoff whose text differs from what the dock produced is
     stamped `edited:true` on that hop, and the receiving run is told (runDock `edited`) so its run row can say so.
   • A PAUSED SESSION HOLDS NOTHING: no model connection, no spend. Sessions persist through the injected store
     (index.js: steptest.sessions.json via the durable single-file helpers, last 10 kept). After a restart a paused
     session comes back paused; one that was RUNNING comes back 'failed' with an honest error — its run died with
     the process and its result is lost (RE-RUN STEP re-runs that dock).
   • ONE ACTIVE SESSION (running or paused) PER STATION. A second start answers a refusal.
   • FAN-OUT / JOINER lines are refused honestly mid-walk: the step test carries ONE crate at a time, and a
     parallel branch set cannot pause hop by hop without inventing an order the floor does not have.

   • DOCK-KEYED (multi-bay agents, 2026-09-22). One agent may crew several bays, so a stage is a DOCK: startAt
     may name a dockId OR an agentId (an agentId reads its entry dock on this line), the walk and the visited set
     key on docks, every hop records its dockId, and a pause edge may be "<fromDock>><toDock>" — the old
     "<fromAgent>><toAgent>" form is still honoured. A plan seam set without the dock readings (stepDock/peekDock)
     runs the agent-keyed walk exactly as before.

   PURE + INJECTED (sidecar determinism law): no require of index.js, no ambient clock, no ids of its own.
     runDock({ agentId, dockId?, entry, text, streamId, sessionId, signal, edited, lineId, ceilingUsd, from?, fromDock?, preview }) -> { text, usd, tools, runId, error }
     plan  { get, step, peek, stepDock?, peekDock?, dockRef?, entryDock, lineOf, stageBrief, loopGateAfter, lineLimits, shipsToOutbox }
     store { load() -> array|null, save(array) }   poolCap() -> $|null   daySpend { spentToday, note }
     getTag(text)   now()   newId()   label(agentId) -> display name|null */
'use strict';
const Verdict = require('./verdict.js');
const Pipeline = require('../../frontend/app/pipeline.js');
const { effectiveLimits, loopDecision, preHopRefusal, hopTurn, lineRefusalNote, asNode, nodeKey } = require('./chain.js');
const { note: failNote } = require('../failopen.js');

const KEEP = 10;                // sessions kept on disk (active + most recent finished)
const TEXT_MAX = 4000;          // the job a session starts with (same bound as the sample hub's messages)
const EDIT_MAX = 200000;        // an owner-edited handoff (a dock's output can be long; this is a sanity bound)
const PAUSE_EDGES_MAX = 64;
const FANOUT = 'this line fans out into parallel branches here — the step-through test carries one crate at a time, so it stops before the split (use SEND A REAL JOB to prove a fan-out line)';
const JOINER = 'this line meets a joiner here — the step-through test carries one crate at a time, so it stops before the join (use SEND A REAL JOB to prove a joined line)';
const ACTIVE = { running: true, paused: true };

const clone = v => JSON.parse(JSON.stringify(v));
const num = v => (typeof v === 'number' && isFinite(v) && v > 0) ? v : 0;
const round6 = v => Math.round(v * 1e6) / 1e6;

/* pause rule: 'every' | 'none' | ["from>to" | "from>outbox", ...] -> normalized, or null when invalid */
function normPause(p) {
  if (p === undefined || p === null) return 'every';
  if (p === 'every' || p === 'none') return p;
  if (!Array.isArray(p) || p.length > PAUSE_EDGES_MAX) return null;
  const out = [];
  for (const e of p) {
    if (typeof e !== 'string') return null;
    const k = e.trim();
    if (!/^[^>\s]{1,100}>[^>\s]{1,100}$/.test(k)) return null;
    if (out.indexOf(k) < 0) out.push(k);
  }
  return out;
}
const edgeKey = (from, next) => String(from) + '>' + ((next && next.kind === 'agent') ? next.agentId : 'outbox');
// the DOCK form of an edge (multi-bay): "<fromDock>><toDock|outbox>"; null when either end has no dock
const dockEdgeKey = (fromDock, next) => (fromDock && (!next || next.kind !== 'agent' || next.dockId)) ? String(fromDock) + '>' + ((next && next.kind === 'agent') ? next.dockId : 'outbox') : null;
function pausesOn(rule, key, alt) {
  if (rule === 'every') return true;
  if (rule === 'none') return false;
  return Array.isArray(rule) && (rule.indexOf(key) >= 0 || (alt != null && rule.indexOf(alt) >= 0));
}

function makeStepTest(o) {
  o = o || {};
  if (typeof o.runDock !== 'function') throw new Error('makeStepTest: runDock is required');
  const runDock = o.runDock;
  const plan = o.plan || {};
  const call = (fn, ...a) => { if (typeof fn !== 'function') return null; try { return fn(...a); } catch (e) { failNote('steptest.plan', e); return null; } };
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  let seq = 0;
  const newId = typeof o.newId === 'function' ? o.newId : function () { return 'st' + (++seq); };
  const getTag = typeof o.getTag === 'function' ? o.getTag : function () { return undefined; };
  const getVerdict = typeof o.getVerdict === 'function' ? o.getVerdict : Verdict.parseVerdict;
  const poolCap = typeof o.poolCap === 'function' ? o.poolCap : function () { return null; };
  const daySpend = (o.daySpend && typeof o.daySpend.spentToday === 'function' && typeof o.daySpend.note === 'function') ? o.daySpend : null;
  const store = (o.store && typeof o.store.load === 'function' && typeof o.store.save === 'function') ? o.store : null;
  const label = typeof o.label === 'function' ? o.label : function () { return null; };
  const preflight = typeof o.preflight === 'function' ? o.preflight : function () { return null; };
  const newRunId = typeof o.newRunId === 'function' ? o.newRunId : null;   // the host's run id (persisted before the run starts)
  const runRow = typeof o.runRow === 'function' ? o.runRow : null;         // runId -> its run row { usd, spendUnknown } | null
  // every sentence the OWNER reads names an agent by its display name, never its raw id (sweep 2026-09-25: "the belt
  // from agent does not reach the OUTBOX") — the id stays in the machine fields (hops[].agentId, running.agentId)
  const who = id => { let n = null; try { n = label(id); } catch (e) { failNote('steptest.label', e); } return n ? String(n) : String(id); };

  let sessions = [];                 // oldest first
  const inflight = new Map();        // sessionId -> { abort, superseded, halted, agentId } — halt.js-compatible (E-STOP)
  const drives = new Map();          // sessionId -> the drive promise (tests await it; routes never do)

  /* ---- persistence ---- */
  function persist() {
    if (!store) return;
    try { store.save(sessions.map(s => { const c = clone(s); delete c._stop; return c; })); }
    catch (e) { failNote('steptest.persist', e); }
  }
  // boot: a session that was RUNNING died with the process — say so; a paused one comes back exactly as it was
  if (store) {
    let raw = null;
    try { raw = store.load(); } catch (e) { failNote('steptest.load', e); raw = null; }
    if (Array.isArray(raw)) {
      sessions = raw.filter(s => s && typeof s === 'object' && typeof s.id === 'string' && Array.isArray(s.hops) && s._w).slice(-KEEP);
      let changed = false;
      for (const s of sessions) {
        if (s.state === 'running') {
          const deadId = (s.running && s.running.agentId) || (s._pending && s._pending.job && s._pending.job.agentId) || null;
          const whoDied = deadId ? who(deadId) : 'a dock';
          /* ITS SPEND IS NOT FORGOTTEN (sweep 2026-09-25): the step's cost used to be noted only after the run returned,
             so a restart mid-run dropped it from the session's LINE BUDGET and the line's day ledger. The running
             step persisted its run id; if that run's row recorded a cost, it is counted now. An interrupted run's
             spend is unknown to the row (the station settles it separately) — the session says so, never $0. */
          const rid = s.running && s.running.runId;
          let row = null;
          if (rid && runRow) { try { row = runRow(rid); } catch (e) { failNote('steptest.runRow', e); row = null; } }
          const usd = row && !row.spendUnknown ? num(row.usd) : 0;
          let costNote;
          if (usd > 0) {
            s._spent = (s._spent || 0) + usd; s.totalUsd = round6(s._spent);
            if (daySpend) { try { daySpend.note(s.lineId, usd); } catch (e) { failNote('steptest.dayLedger.boot', e); } }
            costNote = ' It had already cost $' + usd.toFixed(4) + ' — counted against this test and the line\'s daily budget.';
          } else {
            s.spendUnknown = true;
            costNote = ' What it spent before the restart is not known to this test.';
          }
          s.state = 'failed'; s.running = null; s.paused = null; s.updatedAt = now();
          s.error = 'the sidecar restarted while ' + whoDied + ' was working on this step — that run died with it and its result was lost. RE-RUN STEP runs ' + whoDied + ' again.' + costNote;
          changed = true;
        }
      }
      if (changed) persist();
    }
  }

  /* ---- helpers ---- */
  const byId = id => sessions.find(s => s.id === String(id)) || null;
  const active = () => sessions.find(s => ACTIVE[s.state]) || null;
  function view(s) {
    if (!s) return null;
    const out = {};
    for (const k of Object.keys(s)) if (k[0] !== '_') out[k] = s[k];
    out.hops = (s.hops || []).map(h => { const c = {}; for (const k of Object.keys(h)) if (k[0] !== '_') c[k] = h[k]; return c; });
    return clone(out);
  }
  function limitsNow(s) {
    let pool = null; try { pool = poolCap(); } catch (_) { pool = null; }
    const lim = effectiveLimits(call(plan.lineLimits, s.lineId), {}, pool);
    s.limits = { maxUsdPerMessage: lim.maxUsd, spent: round6(s._spent || 0), maxUsdPerDay: lim.maxUsdPerDay };
    return lim;
  }
  function touch(s) { s.updatedAt = now(); s.totalUsd = round6(s._spent || 0); if (s.limits) s.limits.spent = s.totalUsd; }
  function finish(s, state, error) {
    s.state = state; s.running = null; s.paused = null;
    if (error !== undefined) s.error = error;
    touch(s); persist();
  }
  function trim() {
    while (sessions.length > KEEP) {
      const i = sessions.findIndex(s => !ACTIVE[s.state]);
      if (i < 0) break;
      sessions.splice(i, 1);
    }
  }
  // passes are counted per DOCK when the hop has one (writer@A and writer@C are two stages, not two passes)
  const passFor = (s, agentId, dockId) => 1 + s.hops.filter(h => (dockId ? h.dockId === dockId : h.agentId === agentId) && !h.rerun).length;

  /* resolveNext(s, editedText, advance) — what the last dock's output meets NEXT on the current plan. PREVIEW
     (advance=false) reads chainPeek and moves nothing; CONTINUE (advance=true) reads chainStep, the same
     counter-advancing read the executor takes. The decision itself is chain.js's: loopDecision for a gate,
     preHopRefusal for the guards. An owner edit is what the routing reads (a FILTER/verdict gate judges the text
     that is really handed on) and is handed on verbatim — the loop annotation it was shown is already in it. */
  function resolveNext(s, editedText, advance) {
    const W = s._w, cur = W.cur, curDock = W.curDock || null, raw = W.out || '';
    const basis = editedText != null ? editedText : raw;
    const ctx = { tag: getTag(basis), verdict: getVerdict(basis), lineId: s.lineId, fromTile: null, via: null };
    const dockFn = advance ? plan.stepDock : plan.peekDock;
    const step = (curDock && typeof dockFn === 'function') ? call(dockFn, curDock, ctx) : call(advance ? plan.step : plan.peek, cur, ctx);
    if (step && step.branches) return { next: { kind: 'end', reason: FANOUT }, text: raw, halt: FANOUT };
    if (step && step.join) return { next: { kind: 'end', reason: JOINER }, text: raw, halt: JOINER };
    /* THE OPEN GATES (wave 2 review, conveyor-backend-02 — chain.js openLoops, 2026-10-10): two review loops in a row stopped the
       test on the outer gate's second pass, because the inner gate letting work out lowered the ONE looping flag while the outer
       gate's re-run was still under way. A gate closes only its own pass. Kept as a plain object: _w is JSON-cloned and persisted
       (a Set would not survive). A session persisted before this (no openLoops) keeps reading its old single flag until a gate
       decides, and only then starts tracking its gates: its openLoops stays UNSET (undefined, never {}) on every other hop — an
       empty object would read as "no gate open" and stop a pass the old flag still carries (wave 2 repair, 2026-10-12). */
    const legacy = W.openLoops == null;
    const open = Object.assign({}, W.openLoops || {});
    let target = null, text = raw, again = false, loopKey = null, n = 0, exhausted = false, looping = legacy ? !!W.looping : Object.keys(open).length > 0;
    let gateDecided = false;
    if (step && step.loop) {
      gateDecided = true;
      loopKey = step.loop; n = W.iter[step.loop] || 0;
      // a gate whose back lane re-enters the dock that just ran: W.handed is that dock's previous loop turn, not a draft (chain.js)
      const selfLoop = !!step.backTo && nodeKey(asNode(step.backTo)) === nodeKey({ agentId: cur, dockId: curDock });
      const d = loopDecision(step, ctx, n, W.visited, raw, selfLoop ? '' : W.handed);
      target = asNode(d.target); text = d.text; again = d.again; exhausted = d.exhausted;
      if (d.again) open[step.loop] = true; else delete open[step.loop];
      looping = Object.keys(open).length > 0;
    } else if (step && (step.dockId || step.agentId)) target = asNode(step);
    if (!target) {
      if (curDock ? call(plan.shipsToOutbox, cur, curDock) : call(plan.shipsToOutbox, cur)) return { next: { kind: 'outbox' }, text };
      const why = lineRefusalNote(plan.lineOf, cur, s.lineId, curDock)
        || (call(plan.get) ? 'the belt from ' + who(cur) + ' does not reach the OUTBOX — the line ends at this bay' : 'no work line is armed any more — the line ends at this bay');
      return { next: { kind: 'end', reason: why }, text, end: why };
    }
    const loopHop = !!looping;
    const lim = limitsNow(s);
    const targetKey = nodeKey(target);
    const refusal = preHopRefusal({ visited: W.visited, target: target.agentId, targetKey, loopHop, hop: W.hop + 1, loopHops: W.loopHops + (loopHop ? 1 : 0),
      lim, spent: s._spent || 0, dayLedger: daySpend, lineId: s.lineId, text: editedText != null ? editedText : text, cur });
    const next = { kind: 'agent', agentId: target.agentId, back: !!again };
    if (target.dockId) next.dockId = target.dockId;   // additive: WHICH bay the crate goes to (multi-bay)
    if (refusal) next.blocked = refusal;   // additive: continuing here will stop, and this is why
    return { next, text, target: target.agentId, targetDock: target.dockId || null, targetKey, again, loopKey, n, exhausted, looping, openLoops: (legacy && !gateDecided) ? undefined : open, loopHop, refusal };
  }

  /* advanceFrom(s, editedText) — CONTINUE: resolve the real next step, stamp the last hop's handoff, commit the
     walk (visited / hop counters / loop passes — exactly the executor's bookkeeping) and return the next job, or
     finish the session and return null. */
  function advanceFrom(s, editedText) {
    const last = s.hops[s.hops.length - 1];
    const nx = resolveNext(s, editedText, true);
    const edited = editedText != null;
    if (nx.halt) { finish(s, 'stopped', 'the test stopped: ' + nx.halt); return null; }
    if (nx.next.kind === 'outbox') {
      last.sent = edited ? editedText : nx.text; last.edited = edited;
      s.final = last.sent; s.ended = null;
      finish(s, 'done', null); return null;
    }
    if (nx.next.kind === 'end') { s.ended = nx.end; finish(s, 'done', null); return null; }
    if (nx.refusal) { finish(s, 'stopped', 'the test stopped before ' + who(nx.target) + ': ' + nx.refusal); return null; }
    const W = s._w;
    last.sent = edited ? editedText : nx.text; last.edited = edited;
    W.hop += 1;
    if (nx.loopHop) W.loopHops += 1; else W.visited[nx.targetKey] = true;
    if (nx.again) W.iter[nx.loopKey] = nx.n + 1;
    W.looping = nx.looping;
    if (nx.openLoops !== undefined) W.openLoops = nx.openLoops;   // a legacy session stays legacy until a gate decides
    if (nx.exhausted) W.loopExhausted = true;
    const job = { agentId: nx.target, input: last.sent, entry: false, from: W.cur, hop: W.hop, edited, rerun: false };
    if (nx.targetDock) { job.dockId = nx.targetDock; job.fromDock = W.curDock || null; }
    return job;
  }

  /* kick(s, job) — start running one dock in the background; the route answers at once and the panel polls. */
  function kick(s, job) {
    s.state = 'running'; s.paused = null; s.error = null; s.final = null; s.ended = null;
    s.running = job.dockId ? { agentId: job.agentId, dockId: job.dockId, since: now() } : { agentId: job.agentId, since: now() };
    s._pending = { job: clone(job), before: clone(s._w) };
    touch(s); persist();
    const p = drive(s).catch(e => {
      failNote('steptest.drive', e);
      if (s.state === 'running') finish(s, 'failed', 'the step-through test crashed: ' + ((e && e.message) || String(e)));
    }).then(() => { if (drives.get(s.id) === p) drives.delete(s.id); });
    drives.set(s.id, p);
  }

  async function drive(s) {
    for (let guard = 0; guard < 200; guard++) {
      const pend = s._pending, job = pend.job;   // captured: a later verb may install a new pending job
      // THE LINE BUDGET, PRE-run, over the WHOLE session (re-runs + dropped hops included) — preHopRefusal's
      // $ and daily guards, the executor's own words.
      const lim = limitsNow(s);
      const refused = preHopRefusal({ visited: {}, target: job.agentId, loopHop: true, hop: 0, loopHops: 0, lim, spent: s._spent || 0, dayLedger: daySpend, lineId: s.lineId, text: job.input, cur: s._w.cur || job.agentId });
      if (refused) { s._pending = null; finish(s, 'stopped', 'the test stopped before ' + who(job.agentId) + ' ran: ' + refused + ' (this test has spent $' + (s._spent || 0).toFixed(2) + ', re-runs included)'); return; }

      const W = s._w;
      const turn = job.entry ? String(job.input) : hopTurn({ handoffText: o.handoffPrompt, stageBrief: plan.stageBrief, loopGateAfter: plan.loopGateAfter, lastStage: plan.lastStage,
        originalText: W.original, from: job.from, upstream: job.input, hop: job.hop, target: job.agentId, targetDock: job.dockId || null, lineId: s.lineId });
      const pass = job.rerun && job.pass ? job.pass : passFor(s, job.agentId, job.dockId || null);
      const ac = new AbortController();
      const rec = { abort: ac, superseded: false, halted: false, agentId: job.agentId, startedAt: now() };
      inflight.set(s.id, rec);
      const t0 = now();
      let r = null;
      try {
        const dr = { agentId: job.agentId, entry: !!job.entry, text: turn, streamId: s.streamId, sessionId: s.id, signal: ac.signal, edited: !!job.edited, lineId: s.lineId };
        // what is LEFT of the line budget rides the step as its own lower-only $ cap — the executor's hop rule (chain.js
        // call.ceilingUsd): the pre-run check alone let one own-key step spend far past the LINE BUDGET (quick win 28)
        dr.ceilingUsd = Math.max(0, lim.maxUsd - (s._spent || 0));
        // the run's id is chosen HERE and persisted with the running step before it starts, so a restart mid-run can
        // find that run's row and count what it cost (sweep 2026-09-25) — see the boot reconcile above
        const runId = newRunId ? String(newRunId() || '') : '';
        if (runId) { dr.runId = runId; if (s.running) { s.running.runId = runId; persist(); } }
        if (job.dockId) dr.dockId = job.dockId;
        // LINE WATCH (additive): WHO handed this dock its crate, so the host can ride the handoff crate from that bay
        if (!job.entry && job.from) dr.from = job.from;
        if (!job.entry && job.fromDock) dr.fromDock = job.fromDock;
        dr.preview = String(job.input == null ? '' : job.input);   // LINE WATCH: what the dock was HANDED (never the composed turn)
        r = await runDock(dr);
      } catch (e) { r = { error: (e && e.message) || String(e || 'run failed') }; }
      if (inflight.get(s.id) === rec) inflight.delete(s.id);
      r = r || {};
      const usd = num(r.usd);
      s._spent = (s._spent || 0) + usd;
      if (daySpend && usd) { try { daySpend.note(s.lineId, usd); } catch (e) { failNote('steptest.dayLedger', e); } }
      const output = typeof r.text === 'string' ? r.text : '';
      // (wave 2 repair) the station's own process-fault containment marks the run faulted before killing it: said as that fault
      const stoppedBy = rec.halted ? (rec.faulted ? 'the station hit an internal fault — the test stopped mid-run' : 'E-STOP was pressed — the test stopped mid-run')
        : (s._stop ? 'stopped by you mid-run' : null);
      const err = stoppedBy || (r.error ? who(job.agentId) + ' failed: ' + r.error : (!output.trim() ? who(job.agentId) + ' returned nothing' : null));
      s.hops.push({
        i: s.hops.length, agentId: job.agentId, dockId: job.dockId || null, agentLabel: call(label, job.agentId) || null, pass,
        input: String(job.input), output, usd: round6(usd), ms: Math.max(0, (typeof r.ms === 'number' && isFinite(r.ms)) ? r.ms : now() - t0),
        tools: (typeof r.tools === 'number' && r.tools > 0) ? r.tools : 0, runId: r.runId || null, streamId: s.streamId,
        denied: Array.isArray(r.denied) ? r.denied.filter(x => typeof x === 'string').slice(0, 6) : [],   // tools the consent gate refused in this step (additive)
        verdict: getVerdict(output), rerun: !!job.rerun, edited: false, sent: null, error: err,
        turn, _job: pend.job, _before: pend.before
      });
      if (s._pending === pend) s._pending = null;
      if (s._stop || rec.halted || s.state !== 'running') {
        delete s._stop;
        if (s.state === 'running' || s.state === 'stopped') finish(s, 'stopped', rec.halted ? stoppedBy : (s.error || null));
        return;
      }
      if (err) { finish(s, 'failed', err); return; }
      W.cur = job.agentId; W.curDock = job.dockId || null; W.out = output;
      W.handed = String(job.input == null ? '' : job.input);   // what this step was handed: a loop-back shows it (chain.js loopDecision)

      const nx = resolveNext(s, null, false);
      const afterHop = s.hops.length - 1;
      if (s.single) {
        // TRY THIS STEP: one dock, then done. The next dock is only PREVIEWED (additive `preview`, since `paused`
        // is null outside state 'paused'); its output is what the panel offers the next bay as a test input.
        s.preview = { afterHop, text: nx.text, next: nx.next };
        finish(s, 'done', null); return;
      }
      if (nx.halt || pausesOn(s.pause, edgeKey(job.agentId, nx.next), dockEdgeKey(job.dockId, nx.next))) {
        s.state = 'paused'; s.running = null;
        s.paused = { afterHop, text: nx.text, next: nx.next };
        touch(s); persist(); return;
      }
      const job2 = advanceFrom(s, null);
      if (!job2) return;
      s.running = job2.dockId ? { agentId: job2.agentId, dockId: job2.dockId, since: now() } : { agentId: job2.agentId, since: now() };
      s._pending = { job: clone(job2), before: clone(s._w) };
      touch(s); persist();
    }
    finish(s, 'stopped', 'the test ran past its step ceiling');
  }

  /* ---- the verbs (each returns { ok:true, session } or { ok:false, error } — the route maps a refusal to 409) ---- */
  const refuse = error => ({ ok: false, error });
  const answer = s => ({ ok: true, session: view(s) });
  function otherActive(s) { const a = active(); return a && a !== s ? a : null; }
  // a stopped step whose run is still unwinding (the abort is in flight) owns the session until it lands
  const unwinding = s => inflight.has(s.id) ? refuse('the stopped step is still winding down — try again in a moment.') : null;
  const busy = a => 'a step-through test is already ' + (a.state === 'paused' ? 'paused' : 'running') + ' on this station — continue or stop it first.';

  function start(body) {
    const b = body && typeof body === 'object' ? body : {};
    const a = active();
    if (a) return refuse(busy(a));
    const line = String(b.line == null ? '' : b.line).trim().slice(0, 200);
    if (!line) return refuse('name the work line to test (line).');
    if (typeof b.text !== 'string' || !b.text.trim()) return refuse('give the test a job to carry (text).');
    if (b.text.length > TEXT_MAX) return refuse('the test job is too long (' + b.text.length + ' chars; the limit is ' + TEXT_MAX + ').');
    const text = b.text;
    const pause = normPause(b.pause);
    if (pause == null) return refuse('pause must be "every", "none", or a list of edges like "agentA>agentB" / "agentA>outbox".');
    const single = b.single === true;
    const p = call(plan.get);
    if (!p) return refuse('no work line is armed — draw a complete line (INBOX → belts → a crewed dock) and it arms itself.');
    if (!((Array.isArray(p.lines) ? p.lines : []).some(l => l && String(l.lineId) === line))) {
      return refuse('no armed work line is named "' + line + '" — the floor changed since this panel was drawn; re-open the line and try again.');
    }
    const topologyRefusal = !single && Pipeline.stepTestRefusal(p, line);
    if (topologyRefusal) return refuse(topologyRefusal);
    let agentId = null, dockId = null, entry = true;
    if (b.startAt != null && String(b.startAt).trim()) {
      /* startAt names a DOCK or an AGENT (multi-bay). dockRef resolves either: a dockId is that bay; an agentId
         is its entry dock — or its oldest dock ON this line when the entry dock sits elsewhere. */
      const ref = String(b.startAt).trim();
      const node = typeof plan.dockRef === 'function' ? asNode(call(plan.dockRef, ref, line)) : null;
      agentId = node && node.agentId ? node.agentId : ref;
      dockId = node && node.dockId ? node.dockId : null;
      const onLine = dockId ? call(plan.lineOf, agentId, dockId) : call(plan.lineOf, agentId);
      if (String(onLine || '') !== line) return refuse((dockId && dockId === ref ? 'bay ' + ref : agentId) + ' does not crew a dock on line "' + line + '".');
      // a dock the line's INBOX feeds runs as stage one; any later dock is handed the text
      entry = dockId && p.reachDock ? !!p.reachDock[dockId] : !!(p.reach && p.reach[agentId]);
    } else {
      const node = asNode(call(plan.entryDock, line, text));
      agentId = node ? node.agentId : null; dockId = node ? node.dockId : null;
      if (!agentId) return refuse('line "' + line + '" routes this job to no dock — crew a bay on that line (bind an agent to it) and try again.');
    }
    const pre = call(preflight, agentId);
    if (pre) return refuse(String(pre));
    const id = String(newId());
    // the stage that hands this dock its input: by DOCK when the plan has the dock layer (never the other bay of a
    // multi-dock agent's own name by accident), else the agent-keyed chains
    const upDock = (!entry && dockId && p.dockChains) ? Object.keys(p.dockChains).sort().find(k => ((p.dockChains[k] || {}).next || []).indexOf(dockId) >= 0) : null;
    const upstream = entry ? null : ((upDock && p.agentOfDock && p.agentOfDock[upDock]) || Object.keys(p.chains || {}).sort().find(k => ((p.chains[k] || {}).next || []).indexOf(agentId) >= 0) || 'the upstream stage');
    const original = entry ? text : ((typeof b.original === 'string' && b.original.trim()) ? b.original.slice(0, TEXT_MAX) : null);
    const s = {
      id, lineId: line, state: 'running', createdAt: now(), updatedAt: now(), input: text, single, pause, startAt: agentId, startDock: dockId || null,
      hops: [], running: null, paused: null, preview: null, final: null, ended: null,
      totalUsd: 0, droppedUsd: 0, limits: null, error: null, streamId: 'steptest-' + id,
      _spent: 0,
      _w: { cur: null, curDock: null, out: null, visited: { [dockId || agentId]: true }, iter: {}, looping: false, openLoops: {}, loopHops: 0, hop: entry ? 0 : 1, original, loopExhausted: false }
    };
    limitsNow(s);
    sessions.push(s); trim();
    const job0 = { agentId, input: text, entry, from: upstream, hop: entry ? 0 : 1, edited: false, rerun: false };
    if (dockId) job0.dockId = dockId;
    if (!entry && upDock) job0.fromDock = upDock;   // LINE WATCH: the handoff crate leaves the bay that feeds this one
    kick(s, job0);
    return answer(s);
  }

  /* THE PREVIEW IS READ NOW, NOT AT PAUSE TIME (sweep 2026-09-25): a bay added / crewed on the floor while paused
     changes what the paused crate meets next. CONTINUE already resolves it from the current plan; the paused view
     re-reads the same side-effect-free preview (chainPeek) on every GET, so the panel never shows "EXACT TEXT <the
     old next dock> WILL GET" after the floor changed. The paused text itself is untouched. */
  function freshPreview(s) {
    if (!s || s.state !== 'paused' || !s.paused || !s._w) return;
    const nx = resolveNext(s, null, false);
    if (nx && nx.next) s.paused.next = nx.next;
  }
  function get(id) {
    if (id == null) { const a = active(); freshPreview(a); return { ok: true, session: view(a || sessions[sessions.length - 1] || null) }; }
    const s = byId(id);
    if (s) freshPreview(s);
    return s ? answer(s) : refuse('no step-through test with id "' + String(id).slice(0, 80) + '" — it finished long ago or never existed.');
  }

  function cont(id, body) {
    const s = byId(id); if (!s) return get(id);
    if (s.state !== 'paused' || !s.paused) return refuse('this test is ' + s.state + ', not paused — there is nothing waiting to continue.');
    const b = body && typeof body === 'object' ? body : {};
    let edited = null;
    if (b.text != null) {
      if (typeof b.text !== 'string') return refuse('text must be a string.');
      if (b.text.length > EDIT_MAX) return refuse('the edited handoff is too long (' + b.text.length + ' chars; the limit is ' + EDIT_MAX + ').');
      if (!b.text.trim()) return refuse('the edited handoff is empty — the next dock would have nothing to work on.');
      if (b.text !== s.paused.text) edited = b.text;
    }
    const job = advanceFrom(s, edited);
    if (job) kick(s, job);
    return answer(s);
  }

  function rerun(id) {
    const s = byId(id); if (!s) return get(id);
    if (s.state === 'running') return refuse('this test is running — wait for the step to finish, then re-run it.');
    { const u = unwinding(s); if (u) return u; }
    const a = otherActive(s); if (a) return refuse(busy(a));
    let job = null, before = null;
    if (s._pending) { job = s._pending.job; before = s._pending.before; }   // a step the sidecar restart killed mid-run
    else {
      const last = s.hops[s.hops.length - 1];
      if (!last) return refuse('nothing has run yet — there is no step to re-run.');
      job = Object.assign({}, last._job, { pass: last.pass }); before = last._before;
    }
    s._w = clone(before);
    s.preview = null;
    kick(s, Object.assign({}, job, { rerun: true }));
    return answer(s);
  }

  function rewind(id, body) {
    const s = byId(id); if (!s) return get(id);
    if (s.state === 'running') return refuse('this test is running — wait for the step to finish, then rewind.');
    { const u = unwinding(s); if (u) return u; }
    const a = otherActive(s); if (a) return refuse(busy(a));
    const k = body && body.hop;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 0 || k >= s.hops.length) return refuse('hop must be the index of a step that ran (0…' + Math.max(0, s.hops.length - 1) + ').');
    const dropped = s.hops.splice(k);
    s.droppedUsd = round6((s.droppedUsd || 0) + dropped.reduce((t, h) => t + num(h.usd), 0));   // spent stays spent
    s._pending = null;
    s._w = clone(dropped[0]._before);
    s.preview = null;
    const job = Object.assign({}, dropped[0]._job, { rerun: false });
    delete job.pass;
    kick(s, job);
    return answer(s);
  }

  function stop(id) {
    const s = byId(id); if (!s) return get(id);
    if (!ACTIVE[s.state]) return refuse('this test already ended (' + s.state + ').');
    if (s.state === 'running') {
      s._stop = true;
      const rec = inflight.get(s.id);
      if (rec && rec.abort) { try { rec.abort.abort(); } catch (e) { failNote('steptest.stop.abort', e); } }
    }
    finish(s, 'stopped', null);
    return answer(s);
  }

  function setPause(id, body) {
    const s = byId(id); if (!s) return get(id);
    if (!ACTIVE[s.state]) return refuse('this test already ended (' + s.state + ').');
    const rule = normPause(body && body.pause);
    if (rule == null || (body && body.pause == null)) return refuse('pause must be "every", "none", or a list of edges like "agentA>agentB" / "agentA>outbox".');
    s.pause = rule; touch(s); persist();
    return answer(s);
  }

  // test seam: resolves when the session's background drive settles (routes never await it)
  function settled(id) { return drives.get(String(id)) || Promise.resolve(); }

  return { start, get, continue: cont, rerun, rewind, stop, pause: setPause, settled, inflight, _sessions: () => sessions };
}

module.exports = { makeStepTest, normPause, KEEP };
