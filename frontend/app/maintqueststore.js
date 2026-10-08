/* STARNET — maintqueststore.js : the live wiring around the pure MaintQuests engine (G1c).

   The maintenance-quest generator, wired to real signals. It owns everything the pure engine can't touch:
     • the SLAG SIGNAL — on every sync it re-reads the live SlagLog ring (World.slagPostmortems) and tallies it
       by cause. A cause biting at least MaintQuests.MIN_HITS times mints ONE fix-it quest carrying the
       diagnosis + the actionable fix. It clears (honest completion) the instant the cause falls back below the
       threshold in the ring — the operator fixed the line — and a clean finish by the failing agent settles its
       earlier post-mortems (the ring holds only failures, so nothing else ever pushes them out). Threshold-gated (a one-off never nags), deduped (one
       quest per cause), dismissible forever.
     • the CRON-JAM SIGNAL (feature 4a) — subscribes to `cron.skipped` on U.bus (the tick driver broadcasts it
       over SSE; it already reaches the browser, no tee change). A routine skipped REPEATEDLY (backlogged /
       at-capacity) pins an amber JAM stub on the MISSION BOARD (world.js reads jammedJobs()) AND mints a
       maintenance quest with the reason. The jam is per-jobId; it clears when the routine stops being skipped
       (its skip streak decays after a quiet window, or a clean cron.fire/cron.result lands for it).

   Self-persists the SLAG quests to its own localStorage key (rides the backup prefix, like queststatestore /
   stationqueststore — no save.js change). The CRON-JAM tally is IN-MEMORY only (a live-session signal — a
   backlog is a now-problem, not a durable one). The projection (quests()) is joined into QuestStore.view, so
   these ride the EXACT same quest-log render + QuestState fold as every other quest — one shape, and completion
   gets G1a's gold celebration for free. NOTHING MINTS XP (the xp.js law): a maintenance quest pays out the line
   running clean again, plus the shared celebration — never points. NEVER emits on U.bus (subscription only). */
'use strict';
const MaintQuestStore = (() => {
  const KEY = 'starnet.maintquests.v1';
  const JAM_MIN_SKIPS = 3;       // a routine must be skipped at least this many times before it reads as JAMMED (anti-blip)
  const JAM_WINDOW_MS = 90000;   // a skip older than this no longer counts toward the jam (a stale backlog clears itself)
  let state = null;
  let bound = false;
  const jamByJob = new Map();    // jobId -> { skips: [ms], reason } — the live cron-skip streak per routine (in-memory)

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof MaintQuests !== 'undefined' && state;
  const nowMs = () => (typeof Date !== 'undefined' ? Date.now() : 0);
  const MIN = () => (typeof MaintQuests !== 'undefined' && MaintQuests.MIN_HITS) || 2;

  // if the log is open, refresh it so the new/cleared row lands immediately (a no-op when closed).
  function poke() { try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false); } catch (_) {} }

  /* ---------- the SLAG source: tally the live ring, mint recurring causes, clear cleared ones ---------- */
  function ring() { try { return (typeof World !== 'undefined' && World.slagPostmortems) ? (World.slagPostmortems() || []) : []; } catch (_) { return []; } }

  /* SETTLED post-mortems: the ring records ONLY unproductive runs, so a clean run never pushed a failure out of
     it and a fix-it quest could never clear — three billing errors from days earlier still read "3 runs errored
     out" on a station whose runs had long since been finishing (2026-10-07). A clean finish (`done`) by an agent
     now settles every earlier post-mortem of THAT agent (an entry with no agent settles on any clean run). The
     ring itself is untouched — the LOGBOOK's SLAG tab still shows the history; only the live tally forgets. */
  let settled = new WeakSet();
  function onRunEnd(p) {
    if (!p || p.reason !== 'done') return;
    let any = false;
    for (const d of ring()) {
      if (!d || typeof d !== 'object' || settled.has(d)) continue;
      if (d.agentId && p.agentId && d.agentId !== p.agentId) continue;
      settled.add(d); any = true;
    }
    if (any) sync();
  }
  const liveRing = () => ring().filter(d => !(d && typeof d === 'object' && settled.has(d)));

  // the current per-cause tally of the live ring — the mint threshold + the completion predicate both read it.
  function slagTally() { return (typeof MaintQuests !== 'undefined' && MaintQuests.tally) ? MaintQuests.tally(liveRing()) : {}; }

  /* ---------- the CRON-JAM source (feature 4a): a repeatedly-skipped routine ----------
     Every cron.skipped stamps the routine's skip streak. A streak of ≥ JAM_MIN_SKIPS recent skips reads as a
     JAM: an amber board stub (world.js) + a maintenance quest ('cron-jam:<jobId>'). A clean fire/result for the
     job, or the streak ageing past the window, clears it. */
  function pruneJam(now) {
    for (const [job, j] of jamByJob) {
      j.skips = j.skips.filter(t => (now - t) < JAM_WINDOW_MS);
      if (!j.skips.length) jamByJob.delete(job);
    }
  }
  function onCronSkipped(p) {
    if (!p || p.jobId == null) return;
    const now = nowMs();
    const job = String(p.jobId);
    let j = jamByJob.get(job);
    if (!j) { j = { skips: [], reason: '' }; jamByJob.set(job, j); }
    j.skips.push(now);
    j.reason = String(p.reason || j.reason || 'backlogged');
    pruneJam(now);
    sync();   // a fresh skip may cross the jam threshold → mint immediately
  }
  // a routine actually fired / finished this pass → it isn't jammed anymore; drop its streak.
  function onCronCleared(p) { if (p && p.jobId != null) { jamByJob.delete(String(p.jobId)); sync(); } }

  // the routines currently JAMMED (skip streak ≥ threshold within the window) — world.js reads this to pin the
  // amber board stub. Returns [{ jobId, reason, skips }]. Pruned lazily on read.
  function jammedJobs() {
    const now = nowMs();
    pruneJam(now);
    const out = [];
    for (const [job, j] of jamByJob) if (j.skips.length >= JAM_MIN_SKIPS) out.push({ jobId: job, reason: j.reason, skips: j.skips.length });
    return out;
  }

  // a human name for a jammed routine. cron.skipped carries only { jobId, reason } (the frozen contract), and
  // resolving the name would need an async /api/cron fetch off the sync path — not worth the churn. The card
  // reads honestly as "a routine" (the ROUTINES panel is one click away to see WHICH). Kept a seam so a future
  // cheap name cache can slot in without touching the wording.
  function jobName(_jobId) { return 'a routine'; }
  const JAM_REASON_WORD = {
    'already-running': 'the previous run is still going',
    'caught-up': 'it is firing faster than it can finish',
    'no-capability': 'its agent has no model/credential to run',
    'disabled': 'it is disabled',
    'stale-lock-reclaimed': 'a stuck run had to be reclaimed'
  };

  /* ---------- the heartbeat: mint recurring causes, clear cleared ones. Driven by the 1s station tick +
     every quest-log render (mirrors StationQuestStore.sync). Idempotent + side-effect-light. ---------- */
  function sync() {
    if (!ready()) return;
    const min = MIN();
    // MaintQuests.record returns the id for an UNCHANGED repeat too (an idempotent label refresh), so "record
    // returned an id" is not "something changed". Compare the persisted slice instead: an idle sync with the same
    // recurring cause must not save + poke, or the 1s tick (and every quest-log build, which calls sync) repaints
    // the open log forever — the 2026-10-07 QUEST LOG lag.
    const before = JSON.stringify(state.quests);

    // 1) SLAG causes over threshold → mint (record dedups; the store passes hits so the card reads "N runs …").
    const t = slagTally();
    for (const reason of Object.keys(t)) {
      const c = t[reason];
      if (c.count < min) continue;
      const title = c.title ? (c.count + ' runs ' + firstWordLower(c.title)) : (c.count + ' runs died on ' + reason);
      MaintQuests.record(state, { cause: 'slag:' + reason, title, fix: c.fix, hits: c.count }, nowMs());
    }

    // 2) CRON-JAM causes → mint (a jammed routine is a live maintenance issue, folded through the same engine).
    for (const jam of jammedJobs()) {
      const why = JAM_REASON_WORD[jam.reason] || String(jam.reason || 'backlogged');
      const title = jobName(jam.jobId) + ' keeps getting skipped — ' + why;
      const fix = 'the routine is backed up (' + why + '). space its schedule out, or raise the concurrency cap.';
      MaintQuests.record(state, { cause: 'cron-jam:' + jam.jobId, title, fix, hits: jam.skips }, nowMs());
    }

    // 3) resolve OPEN quests against the live signal → flip cleared ones done (the celebration rides QuestState).
    const jammedSet = new Set(jammedJobs().map(j => 'cron-jam:' + j.jobId));
    const closed = MaintQuests.refresh(state, entry => {
      const cause = String(entry.cause || '');
      if (cause.indexOf('cron-jam:') === 0) return jammedSet.has(cause);   // still jammed? (a live signal, not the ring)
      if (cause.indexOf('slag:') === 0) {                                  // still recurring in the ring?
        const reason = cause.slice(5);
        const now = slagTally();
        return !!(now[reason] && now[reason].count >= min);
      }
      return true;   // unknown cause shape → keep it open (never a false "fixed!")
    }, nowMs());
    if (closed.length || JSON.stringify(state.quests) !== before) { save(); poke(); }
  }

  // "looped without finishing" → "looped without finishing" (already lower); guard the leading capital of a
  // slag title so "N runs Looped without finishing" reads naturally.
  function firstWordLower(s) { s = String(s || ''); return s ? (s.charAt(0).toLowerCase() + s.slice(1)) : s; }

  /* ---------- the projection consumed by QuestStore.view (so these ride the shared render + fold) ---------- */
  function quests() { return ready() ? MaintQuests.project(state) : []; }
  function openCount() { return ready() ? MaintQuests.openCount(state) : 0; }

  // wave a maintenance quest off forever (always dismissible — the sandbox law). Routed from the quest-log ✕.
  function dismiss(id) {
    if (!ready() || !id) return false;
    const ok = MaintQuests.dismiss(state, id, nowMs());
    if (ok) { save(); }
    return ok;
  }
  const isDismissed = id => ready() ? MaintQuests.isDismissed(state, id) : false;

  /* ---------- lifecycle ---------- */
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('cron.skipped', onCronSkipped);   // subscription only — NEVER an emit (the frozen contract stands)
      U.bus.on('cron.fire', onCronCleared);
      U.bus.on('cron.result', onCronCleared);
      U.bus.on('agent.run.end', onRunEnd);       // a clean finish settles that agent's earlier post-mortems
      bound = true;
    }
  }
  function init() {
    state = (typeof MaintQuests !== 'undefined') ? MaintQuests.hydrate(load()) : null;
    jamByJob.clear();
    bind();
    sync();
  }

  // a NEW AGENT starts with no maintenance history (own key — Save.clear() only wipes starnet.save; mirrors
  // StationQuestStore.reset). The next init() hydrates clean.
  function reset() { state = null; jamByJob.clear(); settled = new WeakSet(); try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, sync, quests, openCount, dismiss, isDismissed, jammedJobs, reset,
    // exposed for tests: the pure-ish seams the browser flow drives
    _onCronSkipped: onCronSkipped, _onRunEnd: onRunEnd, _slagTally: slagTally };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { MaintQuestStore };
