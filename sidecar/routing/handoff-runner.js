/* sidecar/routing/handoff-runner.js — SEND TO at run time (2026-10-10, Andrew: "fully polish and integrate this into starnet").

   A line whose OUTBOX sends on (worldmodel setSendTo → plan.sendTo, outside the hash) hands every job it finishes CLEAN to the
   target line's INBOX. The chain runner tells this module when a job left its line clean (chain.js onShipped — every return
   point, never awaited: a chain never gates the reply); this module decides whether a hand-off may go, queues it, and starts
   the target line's OWN job on the trigger proof's path: a channel hub whose ONE resolution is scoped to the target line
   (index.js makeTriggerHub with lineId = the target), so the target's own INBOX picks the dock, the line gate accepts the
   work, and the job runs on the target line's crew under the target line's own stage / $ / day budget (chain.js reads
   lineLimits(lineId) and the day ledger by the TARGET's id — nothing of the sending line's budget carries over). Never through
   the sample route: that caps input at 2000 characters and holds the one-sample-per-station lock.

   GUARDS (each refusal is said on the target line's job record — a failed record "from LINE A", never a silent drop):
     · E-STOP (the durable automation halt) — nothing starts;
     · the target line must still be on the armed floor and reach a crewed dock, and be under its daily $ cap;
     · the sending job must really have finished: every run row of its stream since it started ended `done` (a chain hop
       treats max_iters with some text as a step that answered; a job record would call that a problem, never delivered);
     · NO CIRCLES, NO RUNAWAYS: a job's lineage (streamId -> { lines, depth }, in memory — an in-flight chain is not durable
       either) refuses a line the job already went through, and a 4th hand-off (MAX_DEPTH); the compiler warns SEND_TO_LOOP
       before any run, but the plan can be re-posted mid-run, so the run-time check stands on its own;
     · at most MAX_PENDING hand-offs wait per target line behind the one running (a burst beyond is refused), one in flight.
   Re-checked at dispatch (a waiting hand-off whose gate closed meanwhile is dropped with the reason on record).

   VERDICTS (conveyor-backend-04): the target line's job runs under the SENDING job's entry verdicts — the Commander's own job keeps
   Full Access on the next line exactly as an in-line hop does; a payload-started, forwarded or attachment-started job stays under the
   taint lock and a non-owner sender's job stays withheld. Fail closed: only entryTrusted/hostPowerKept carried as a literal true from the
   hub that ran the job (chain.js shipped) lift either, the weakest along the lineage wins, and anything else is untrusted + withheld.

   THE RECORDS: the target line's job is a line-jobs record of ITS line with from:{ line, jobId, name }, its `text` the job AS IT
   FIRST ARRIVED and `handedIn` what the sending line delivered; the sending job is linked sentTo:{ line, jobId, name } — or,
   refused, sentTo.refused = why (never read as "sent on"). Each line's result stays its own. A job E-STOP killed is `stopped`.
   The crate: workitem.placed { kind:'handoff', lineId: target, fromLine, fromOutbox, toIntake, jobId, streamId } (the frozen
   contract's obj() stanza allows the extra fields), so the floor draws the hand-off from the sending OUTBOX to the target INBOX
   before the job rides the target line, and the page reads back exactly that job when it lands.

   Determinism-clean: the clock and ids are injected (index.js owns timers, fs and the hub). */
'use strict';
const Pipeline = require('../../frontend/app/pipeline.js');
const path = require('node:path');
const RunPaths = require('../run-paths.js');   // producedPath: where a finished run's file is (one base per run)
const { crewedDocksOnLine } = require('./trigger-runner.js');

const MAX_PENDING = 5;   // hand-offs waiting per target line behind the one in flight
const MAX_DEPTH = 4;     // the 4th hand-off of one job is refused (a job crosses at most 4 lines: A → B → C → D)
const MAX_REFUSALS = 20; // recent refusals kept for status() — a diagnostic/test read only: the line-jobs records are what every surface shows

function makeHandoffRunner(deps) {
  const d = deps || {};
  const now = d.now, newId = d.newId;
  if (typeof now !== 'function' || typeof newId !== 'function') throw new Error('handoff-runner: now/newId are required');
  if (typeof d.makeHub !== 'function') throw new Error('handoff-runner: makeHub is required');
  const warn = typeof d.warn === 'function' ? d.warn : function () {};
  const emit = typeof d.emit === 'function' ? d.emit : function () {};
  const bumpQueue = typeof d.bumpQueue === 'function' ? d.bumpQueue : function () { return 0; };
  const halted = typeof d.halted === 'function' ? d.halted : function () { return false; };
  /* faulted() -> the halt is the station's OWN process-fault containment, not the Commander's E-STOP (wave 2 review,
     conveyor-backend-08): halted() stays the one gate, this only picks the words — a record never blames an E-STOP nobody pressed */
  const faulted = typeof d.faulted === 'function' ? d.faulted : function () { return false; };
  const dayCap = typeof d.dayCap === 'function' ? d.dayCap : function () { return { cap: null, spent: 0 }; };
  const runsFor = typeof d.runsFor === 'function' ? d.runsFor : function () { return []; };
  const workspaceOf = typeof d.workspaceOf === 'function' ? d.workspaceOf : function () { return null; };
  const shipsToOutbox = typeof d.shipsToOutbox === 'function' ? d.shipsToOutbox : function () { return false; };
  const planOf = typeof d.plan === 'function' ? d.plan : function () { return null; };
  const jobs = d.jobs || {};
  const J = {
    byStream: s => { try { return typeof jobs.byStream === 'function' ? jobs.byStream(s) : null; } catch (e) { warn('[handoff] job lookup: ' + ((e && e.message) || e)); return null; } },
    start: r => { try { return typeof jobs.start === 'function' ? jobs.start(r) : null; } catch (e) { warn('[handoff] job start: ' + ((e && e.message) || e)); return null; } },
    finish: (id, r) => { try { return typeof jobs.finish === 'function' ? jobs.finish(id, r) : null; } catch (e) { warn('[handoff] job finish: ' + ((e && e.message) || e)); return null; } },
    link: (id, to) => { try { return typeof jobs.link === 'function' ? jobs.link(id, to) : null; } catch (e) { warn('[handoff] job link: ' + ((e && e.message) || e)); return null; } },
    latest: line => { try { return typeof jobs.latest === 'function' ? jobs.latest(line) : null; } catch (e) { warn('[handoff] job read: ' + ((e && e.message) || e)); return null; } },
    again: (id, at) => { try { return typeof jobs.again === 'function' ? jobs.again(id, at) : null; } catch (e) { warn('[handoff] job count: ' + ((e && e.message) || e)); return null; } }
  };

  // streamId -> { lines:[lineId…], depth, original } — the lines a job's work has been through, and the job AS IT FIRST ARRIVED
  // (a line further down is handed that, never the frame the line before it was handed: A → B → C must not nest frames)
  const lineage = new Map();
  const live = new Map();      // target lineId -> { queue:[], busy, hub, current }
  const refused = [];          // [{ at, fromLine, toLine, error }] newest last
  // the station is quitting (haltAll(why, { close: true })): every later hand-off is refused with this reason, never queued in a
  // memory that is about to exit (wave 2 repair, conveyor-backend-03) — null while the station takes work
  let closing = null;

  const lineRec = (plan, id) => ((plan && Array.isArray(plan.lines)) ? plan.lines : []).find(l => l && String(l.lineId) === String(id)) || null;
  // a line as the floor names it (Pipeline.lineNames over the plan's own line records: its first named INBOX, else LINE <its first
  // INBOX's letter>, never two lines alike) — the word the plates and the Workflows window say; null when the plan has no such line
  const floorWord = (plan, id) => { const W = typeof Pipeline.lineNames === 'function' ? Pipeline.lineNames((plan && Array.isArray(plan.lines)) ? plan.lines : []) : {}; return W[id] || null; };
  /* the name a hand-off and its job records carry: the line's own name, else the floor's word for it (wave 2, worldmodel-08 — an
     unnamed line was '' here, so the next crew was told the work came from "the line before this one" and the records had no
     name while every plate said LINE N; Pipeline.lineWord is idempotent on 'LINE N', so nothing reads it doubled) */
  const nameOf = (plan, id) => { const l = lineRec(plan, id); return (l && typeof l.name === 'string' && l.name.trim()) ? l.name : (floorWord(plan, id) || ''); };
  const say = (plan, id) => floorWord(plan, id) || Pipeline.lineWord(nameOf(plan, id), 'the next line');
  function stateOf(line) {
    let s = live.get(line);
    if (!s) { s = { queue: [], busy: false, hub: null, current: null }; live.set(line, s); }
    return s;
  }
  const newJobId = () => 'job-' + String(newId()).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12).padEnd(8, '0');
  const newStream = () => 'handoff-' + String(newId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

  /* can the TARGET line take work right now? (no side effects) — the trigger preflight's questions, asked of the target */
  function preflight(plan, toLine) {
    // (bare reasons — wave 2 review, conveyor-backend-09: the record's 'not sent on: ' and every sender surface already say it was not sent)
    if (halted()) return faulted() ? 'the station hit an internal fault and stopped its background work' : 'automation is stopped (E-STOP)';
    if (closing) return closing;
    if (!plan) return 'no work line is armed';
    if (!lineRec(plan, toLine)) return 'the line it sends to is no longer on the floor — set its SEND TO again';
    if (!crewedDocksOnLine(plan, toLine).length) return say(plan, toLine) + ' routes work to no crewed dock — assign an agent to its first step';
    let cap = null;
    try { cap = dayCap(toLine); } catch (e) { cap = null; warn('[handoff] day-cap read failed: ' + ((e && e.message) || e)); }
    if (cap && typeof cap.cap === 'number' && cap.cap > 0 && (cap.spent || 0) >= cap.cap) return say(plan, toLine) + ' reached its $' + cap.cap.toFixed(2) + ' daily limit';
    return null;
  }

  /* a refusal is SAID on the target line: a failed job record "from LINE A" with the reason. The sending job is linked with
     sentTo.refused = why — never a plain sentTo, which every surface reads as "SENT ON TO LINE B". A STANDING refusal (the target's
     newest record is already this refusal: same sending line, same reason) is counted on that record instead of a new one — a
     folder trigger firing into a capped line would otherwise push every line's job history out of the store. */
  function refuse(item, why) {
    const at = now(), plan = planOf(), error = 'not sent on: ' + why;
    refused.push({ at, fromLine: item.fromLine, toLine: item.toLine, error: why });
    if (refused.length > MAX_REFUSALS) refused.shift();
    let yj = null;
    /* (fix-runtime 54) ONLY ON A LINE THE FLOOR STILL HAS: a target line deleted (or rebuilt under a new key) while the hand-off
       waited gets no record — one keyed by its dead lineId would sit in line-jobs.json where no window ever shows it. The refusal
       then lands on the SENDER alone (sentTo.refused below, with no job to open). */
    if (lineRec(plan, item.toLine)) {
      const last = J.latest(item.toLine);
      if (last && last.status === 'failed' && last.from && String(last.from.line) === String(item.fromLine) && last.error === String(error).slice(0, 400)) yj = J.again(last.id, at);
      if (!yj) {
        yj = J.start({ id: newJobId(), line: item.toLine, name: nameOf(plan, item.toLine) || item.toName, text: item.original, handedIn: item.output, streamId: '', at,
          from: Object.assign({ line: item.fromLine, jobId: item.fromJobId, name: item.fromName }, item.unapproved ? { unapproved: item.unapproved } : null) });
        if (yj) J.finish(yj.id, { at, status: 'failed', usd: 0, output: '', runs: [], error });
      }
    }
    if (item.fromJobId) J.link(item.fromJobId, { line: item.toLine, jobId: yj ? yj.id : null, name: item.toName, refused: why });
    warn('[handoff] ' + item.fromLine + ' → ' + item.toLine + ' refused: ' + why);
    return { ok: false, error: why, jobId: yj ? yj.id : null };
  }

  /* onShipped(rec) — the chain runner's hook (chain.js): a job left line rec.lineId clean at a stage that ships to the OUTBOX.
     Decides synchronously whether a hand-off may go and queues it; the target line's job is pumped on its own. */
  function onShipped(rec) {
    const r = rec || {};
    if (!r.lineId) return { ok: false, code: 'none' };
    const plan = planOf();
    // the OUTBOX the job landed in (the chain's terminal walk) decides — a line with two OUTBOXes hands on only from the one that sends
    const st = plan ? Pipeline.sendToOf(plan, r.lineId, r.dockId, r.outboxId) : null;
    if (!st) return { ok: false, code: 'none' };   // this line sends nowhere (the common case)
    const lin = (r.streamId && lineage.get(String(r.streamId))) || null;   // this job was itself handed on (B → C): its lineage
    const from = lin || { lines: [String(r.lineId)], depth: 0 };
    const lines = from.lines.indexOf(String(r.lineId)) >= 0 ? from.lines.slice() : from.lines.concat([String(r.lineId)]);
    const fromJob = r.streamId ? J.byStream(String(r.streamId)) : null;
    // THE JOB AS IT FIRST ARRIVED: a handed-on job's own "original" is the frame it was handed — carry the first job's text down
    // the lineage (and, if that is gone, read it back out of the frame), so line C is never handed B's frame as "the job"
    const inner = (from.original == null) ? Pipeline.parseHandoffInput(r.originalText) : null;
    const original = from.original != null ? String(from.original) : (inner && inner.original) ? inner.original : String(r.originalText == null ? '' : r.originalText);
    const item = {
      rec: r, fromLine: String(r.lineId), toLine: st.toLine, fromOutbox: st.outboxId, toIntake: st.intakeId,
      fromName: nameOf(plan, r.lineId), toName: nameOf(plan, st.toLine), fromJobId: fromJob ? fromJob.id : null,
      lines, depth: from.depth + 1, at: now(), original, output: String(r.text == null ? '' : r.text),
      /* THE SENDING JOB'S VERDICTS (conveyor-backend-04): positive only, and only when the chain carried them on this shipment (the hub
         that ran the job established them) AND every earlier line of its lineage held them too — a hand-off is never more trusted than
         the job that produced it, and the weakest verdict along A → B → C wins. Missing anywhere = untrusted entry + host power withheld. */
      entryTrusted: r.entryTrusted === true && (!lin || lin.entryTrusted === true),
      hostPowerKept: r.hostPowerKept === true && (!lin || lin.hostPowerKept === true)
    };
    /* an UNAPPROVED job (chain out.unapproved: a review loop used all its passes without the verdict it waits for, GitHub #122) IS handed
       on — the LOOP sent it on, and SEND TO follows the line — but the frame the next line reads and its job record say nobody approved it */
    if (r.unapproved) item.unapproved = String(r.unapproved).slice(0, 300);
    // a PARTIAL joined job (chain out.partial: a COPY branch failed or never reached the JOINER) is not handed on as a finished
    // result — said on the next line, like a job with a failed step (runtime repair 2026-10-12: a hop refused before it ran left
    // no run row, so the dispatch check below could not see it)
    if (r.partial) return refuse(item, say(plan, r.lineId) + '’s job did not finish cleanly (its joiner sent on without every branch: ' + String(r.partial).slice(0, 200) + ')');
    if (lines.indexOf(st.toLine) >= 0) return refuse(item, 'this job already went through ' + say(plan, st.toLine) + ' — sending it on again would send it round in a circle');
    if (item.depth >= MAX_DEPTH) return refuse(item, 'this job has already been handed on ' + from.depth + ' times — a job crosses at most ' + MAX_DEPTH + ' lines');
    const pf = preflight(plan, st.toLine);
    if (pf) return refuse(item, pf);
    const s = stateOf(st.toLine);
    if (s.queue.length >= MAX_PENDING) return refuse(item, say(plan, st.toLine) + ' already has ' + s.queue.length + ' hand-offs waiting behind the one running');
    s.queue.push(item);
    const position = s.queue.length + (s.busy ? 1 : 0);
    pump(st.toLine);
    return { ok: true, queued: position, toLine: st.toLine };
  }

  function pump(line) {
    const s = stateOf(line);
    if (s.busy || !s.queue.length) return;
    const item = s.queue.shift();
    s.busy = true;
    /* a dispatch that THREW (makeHub, the hub's own entry) is said like every other drop — this module's rule (wave 2 review,
       conveyor-backend-11: it was a console line only). A target record it already started says why instead of staying "running";
       before that, the refusal path writes one on both lines. */
    /* (wave 2 repair) the SENDING job is told too: dispatch links it "sent on" as soon as the target record starts, so a throw before
       the target line was entered (makeHub, the hub's own entry) re-links it NOT sent on, with why — its card read "Sent on to LINE B —
       that line works on this result next" for a hand-off that never started. A throw AFTER the line was entered is said as such: the
       work did reach that line, so the sender keeps its plain link to the record that says what happened. */
    Promise.resolve().then(() => dispatch(item, s)).catch(e => {
      const msg = String((e && e.message) || e).slice(0, 200);
      const why = item.entered ? 'the hand-off broke after it started (' + msg + ')' : 'the hand-off could not start (' + msg + ')';
      warn('[handoff] dispatch failed: ' + ((e && e.message) || e));
      try {
        if (item.startedJobId) {
          J.finish(item.startedJobId, { at: now(), status: 'failed', usd: 0, output: '', runs: [], error: why });
          if (!item.entered && item.fromJobId) J.link(item.fromJobId, { line: item.toLine, jobId: item.startedJobId, name: item.toName, refused: why });
        } else refuse(item, why);
      } catch (e2) { warn('[handoff] the failed dispatch could not be recorded: ' + ((e2 && e2.message) || e2)); }
    }).then(() => { s.busy = false; s.current = null; pump(line); });
  }

  function hubFor(line, s) {
    if (s.hub) return s.hub;
    s.hub = d.makeHub({
      lineId: () => line,
      onRouted: (r) => { if (s.current) s.current.routed = r || null; return r; },
      entryAllowed: (agentId) => !!(s.current && s.current.routed && s.current.routed.agentId === agentId),
      onResolved: (info) => { if (s.current && !s.current.resolved) s.current.resolved = info; },
      onLineOutcome: (info) => { if (s.current) s.current.lineOutcome = info; },
      /* SEND TO VERDICTS (conveyor-backend-04): the target line's job runs under the SENDING job's verdicts (index.js makeTriggerHub
         forwards these to hub.js) — FAIL CLOSED: only a positive verdict carried from the job that established it lifts either one; no
         job in hand, a legacy shipment or a lineage without them = untrusted entry + host power withheld. */
      entryUntrusted: () => !(s.current && s.current.entryTrusted === true),
      senderWithheld: () => !(s.current && s.current.hostPowerKept === true),
      streamId: () => (s.current && s.current.streamId) || undefined,
      turns: (agentId) => { if (!s.current) return []; const k = String(agentId || ''); return s.current.turns[k] || (s.current.turns[k] = []); },
      /* once the station is stopped (E-STOP, or its own fault containment) nothing more is this job's output: the hub's "⏹ Stopped —
         E-STOP was pressed…" courtesy notice for a real chat came through here and the STOPPED card showed it under "What came out",
         with NEEDS CHANGES offered against it (wave 2 repair, conveyor-backend-08 — the sample route's own rule). What was said
         before the stop stays. */
      send: (text) => { if (s.current && !halted()) { s.current.replies.push(String(text == null ? '' : text)); if (s.current.replies.length > 20) s.current.replies.shift(); } }
    });
    return s.hub;
  }

  // the sending job's own run rows (its stream, from its entry run's start UP TO the moment it shipped — a channel chat's stream
  // carries the next message's runs too, which must never refuse this job or lend it their files): did every step end `done`?
  // + the files it made
  function sendingRuns(rec, until) {
    if (!rec.streamId) return { known: false, rows: [] };
    let rows = [];
    try { rows = (runsFor(String(rec.streamId)) || []).filter(x => x && String(x.streamId || rec.streamId) === String(rec.streamId)); }
    catch (e) { warn('[handoff] run read-back failed: ' + ((e && e.message) || e)); return { known: false, rows: [] }; }
    if (typeof rec.since === 'number') rows = rows.filter(x => typeof x.startedAt !== 'number' || x.startedAt >= rec.since - 1);
    if (typeof until === 'number') rows = rows.filter(x => typeof x.startedAt !== 'number' || x.startedAt <= until);
    return { known: true, rows };
  }

  async function dispatch(item, s) {
    // THE GATES AGAIN AT DISPATCH: the item may have waited; E-STOP, the cap, the floor or the SEND TO itself may have changed
    const plan = planOf();
    if (!plan) return refuse(item, 'no work line is armed');
    const still = Pipeline.sendToOf(plan, item.fromLine, item.rec.dockId, item.fromOutbox);
    /* (fix-runtime 54) THE TARGET LINE ITSELF FIRST: DELETE LINE prunes the pointer too, so "the SEND TO changed" was said for a
       line that went. A line rebuilt under a new key (its oldest machine removed) still has the INBOX this pointer names — that
       waiting hand-off's line is gone all the same: said as rebuilt, never sent into a line it was not checked against */
    if (!lineRec(plan, item.toLine)) {
      const rekeyed = !!(still && String(still.intakeId) === String(item.toIntake) && lineRec(plan, still.toLine));
      return refuse(item, rekeyed ? say(plan, still.toLine) + ' was rebuilt while the hand-off waited — send the job again'
        : 'the line it sends to is no longer on the floor');
    }
    if (!still || still.toLine !== item.toLine) return refuse(item, 'the SEND TO changed before the hand-off ran');
    const pf = preflight(plan, item.toLine);
    if (pf) return refuse(item, pf);
    const sr = sendingRuns(item.rec, item.at);
    if (sr.known && sr.rows.some(x => x.reason !== 'done')) {
      const bad = sr.rows.find(x => x.reason !== 'done');
      return refuse(item, say(plan, item.fromLine) + '’s job did not finish cleanly (a step ended “' + (bad.reason || 'unknown') + '”)');
    }
    const files = [];
    // A relative file belongs to its PRODUCING run, never to the receiving line's project or agent: the run's ONE base
    // (its project root, else its agent's workspace), by the same rule every reader of a finished run's file uses
    // (sidecar/run-paths.js producedPath). Absolute paths from either platform (UNC included) are kept as named; a name
    // with no known base, a drive-relative one or one that climbs out of its base is omitted and said, never guessed.
    for (const x of sr.rows) for (const a of (Array.isArray(x.artifacts) ? x.artifacts : [])) {
      if (!a || !a.path) continue;
      const named = String(a.path);
      let jail = '';
      if (!(typeof x.projectRoot === 'string' && x.projectRoot.trim()) && !path.win32.isAbsolute(named) && !path.posix.isAbsolute(named)) {
        try { jail = workspaceOf(x.agentId) || ''; }
        catch (e) { warn('[handoff] source workspace unavailable: ' + ((e && e.message) || e)); }
      }
      const at = RunPaths.producedPath(named, { projectRoot: x.projectRoot, jail });
      if (!at.path) {
        warn(at.reason === 'escapes' ? '[handoff] omitted file that leaves its source folder: ' + named : '[handoff] omitted file with unknown source folder: ' + named);
        continue;
      }
      if (files.indexOf(at.path) < 0) files.push(at.path);
    }
    const input = Pipeline.handoffInput({ fromName: item.fromName, original: item.original, output: item.output, files, unapproved: item.unapproved });

    const startedAt = now(), streamId = newStream();
    lineage.set(streamId, { lines: item.lines.concat([item.toLine]), depth: item.depth, original: item.original,
      entryTrusted: item.entryTrusted === true, hostPowerKept: item.hostPowerKept === true });   // line C inherits this job's verdicts
    if (lineage.size > 500) lineage.delete(lineage.keys().next().value);
    // the record keeps the job as it first arrived (`text`) and what the sending line delivered (`handedIn`) apart — never the
    // whole frame, which the record's 2000 characters would cut through what was delivered
    const yj = J.start({ id: newJobId(), line: item.toLine, name: nameOf(plan, item.toLine) || item.toName, text: item.original, handedIn: item.output, streamId, at: startedAt,
      from: Object.assign({ line: item.fromLine, jobId: item.fromJobId, name: item.fromName }, item.unapproved ? { unapproved: item.unapproved } : null) });
    if (yj) item.startedJobId = yj.id;   // (a throw from here on finishes THIS record — pump)
    if (yj && item.fromJobId) J.link(item.fromJobId, { line: item.toLine, jobId: yj.id, name: item.toName });

    s.current = { streamId, routed: null, resolved: null, lineOutcome: null, replies: [], turns: {},
      entryTrusted: item.entryTrusted === true, hostPowerKept: item.hostPowerKept === true };   // what hubFor's verdict hooks answer
    const hub = hubFor(item.toLine, s);
    const settled = Promise.resolve(hub.onInbound({ chatId: 'hof-' + item.toLine, userId: 'handoff', text: input, chatType: 'dm' }))
      .catch(e => ({ error: (e && e.message) || String(e) }));
    item.entered = true;   // the target line has the work from here (a throw after this is said as "broke after it started" — pump)
    // resolution lands in onInbound's first synchronous slice (the one-resolver law); the crate follows it
    const info = s.current.resolved;
    let workitemId = '', agentId = '';
    if (info && info.agentId && s.current.routed && s.current.routed.agentId === info.agentId) {
      agentId = String(info.agentId);
      workitemId = String(newId());
      const depth = bumpQueue(agentId, +1);
      // jobId / streamId (additive, obj() latitude): the receiving job's own record, so the page reads back exactly THAT job when
      // the crate lands — never "the line's newest", which a queued hand-off or a refusal can already have replaced
      emit('workitem.placed', { workitemId, queueId: agentId, agentId, kind: 'handoff', lineId: info.lineId || item.toLine, dockId: info.dockId || undefined,
        fromLine: item.fromLine, fromOutbox: item.fromOutbox, toIntake: item.toIntake, jobId: yj ? yj.id : undefined, streamId,
        preview: ('FROM ' + (floorWord(plan, item.fromLine) || Pipeline.lineWord(item.fromName, 'ANOTHER LINE'))).slice(0, 40), queueDepth: depth, ts: startedAt });
      emit('queue.status', { queueId: agentId, depth, maxCapacity: d.queueCap || 64, nextAdvanceAt: 0 });
    }
    const threw = await settled;
    let runs = [];
    try { runs = (runsFor(streamId) || []).filter(x => x && String(x.streamId || streamId) === streamId); } catch (e) { runs = []; warn('[handoff] run read-back failed: ' + ((e && e.message) || e)); }
    const lo = s.current.lineOutcome;
    const onLine = !!(info && String(info.lineId || '') === String(item.toLine));
    const allDone = runs.length > 0 && runs.every(x => x.reason === 'done');
    // a PARTIAL joined job (chain out.partial) is not clean, even when every run row that exists ended done (runtime repair 2026-10-12)
    const ships = !!(lo && !lo.stopped && !lo.partial && shipsToOutbox(lo.agentId, lo.dockId));
    const completed = onLine && allDone && ships;
    const usd = runs.reduce((a, x) => a + ((typeof x.usd === 'number' && isFinite(x.usd)) ? x.usd : 0), 0);
    if (workitemId) {
      const dep = bumpQueue(agentId, -1);
      // (GitHub #122, additive) THIS line's own review loop ran out of passes: delivered, said as unapproved
      if (completed) emit('workitem.delivered', Object.assign({ workitemId, finalQueueId: 'outbox', agentId, box: '', ms: now() - startedAt, ts: now() }, lo.unapproved ? { unapproved: String(lo.unapproved) } : null));
      emit('queue.status', { queueId: agentId, depth: dep, maxCapacity: d.queueCap || 64, nextAdvanceAt: 0 });
    }
    let err = '';
    // E-STOP killed it: the Commander stopped this job (the sample route's STOPPED), never "a step did not finish cleanly" — or the
    // station's own fault containment did, which says so rather than naming an E-STOP nobody pressed
    const stopped = !completed && halted();
    if (stopped) err = faulted() ? 'the station hit an internal fault and stopped this job' : 'E-STOP stopped this job';
    else if (!completed) {
      if (threw && threw.error) err = 'the line failed: ' + threw.error;
      else if (!info || !info.agentId || !s.current.routed || s.current.routed.agentId !== info.agentId) err = 'the line routed this work to no dock';
      else if (!onLine) err = 'the work did not enter through this line';
      // no run row, but the hub said why (the day cap reached between the preflight and the run): that reason, never a bare
      // "no step ran" — the trigger runner's pattern
      else if (!runs.length) err = (s.current.replies.find(x => /^⚠/.test(String(x).trim())) || '').trim().replace(/^⚠\s*/, '').trim() || 'no step ran';
      else if (!allDone) err = 'a step did not finish cleanly';
      else if (lo && lo.stopped) err = 'the line stopped early: ' + lo.stopped;
      else if (lo && lo.partial) err = 'the joiner sent on without every branch (' + lo.partial + ')';
      else err = 'the line did not reach its OUTBOX';
    }
    if (yj) J.finish(yj.id, { at: now(), usd, output: s.current.replies.join(''), status: completed ? 'delivered' : stopped ? 'stopped' : runs.length ? 'problem' : 'failed', error: err, unapproved: (completed && lo.unapproved) ? String(lo.unapproved) : '',
      runs: runs.map(x => ({ runId: x.runId, agentId: x.agentId, dockId: x.dockId || null, reason: x.reason, usd: x.usd })) });
    return { ok: completed, streamId, jobId: yj ? yj.id : null, runs: runs.length, usd, error: err || null };
  }

  /* E-STOP: drop every waiting hand-off; the host kills the in-flight runs through the hubs' inflight maps.
     (fix-runtime 24) A drop is SAID, never silent: each dropped hand-off goes through refuse() — the target line gets the failed
     "not sent on" record (a burst counted on ONE record, the standing-refusal rule) and every dropped sending job reads NOT sent
     on, with why. `why` names a stop that was not the Commander's E-STOP (the process-fault containment says its own).
     opts.close (the station is QUITTING — gracefulShutdown; wave 2 repair, conveyor-backend-03): admission closes as well. A
     hub-driven job on another line can still finish inside the shutdown window; its hand-off is then refused with the same reason
     (preflight), never queued into a memory that process.exit drops. An E-STOP never closes admission: RESUME lets work go again. */
  function haltAll(why, opts) {
    const reason = (typeof why === 'string' && why.trim()) ? why.trim() : 'automation is stopped (E-STOP)';
    if (opts && opts.close) closing = reason;
    let n = 0;
    for (const s of live.values()) { const q = s.queue.splice(0); n += q.length; for (const it of q) refuse(it, reason); }
    return n;
  }
  function inflights() { const out = []; for (const s of live.values()) if (s.hub && s.hub._internals && s.hub._internals.inflight) out.push(s.hub._internals.inflight); return out; }
  /* status() — a DIAGNOSTIC / TEST read (no route or panel shows it): what waits per line and the last MAX_REFUSALS refusals. Every
     refusal is also on the line-jobs records, which are what the Commander reads. */
  function status() {
    const lines = [];
    for (const [line, s] of live) lines.push({ line, queued: s.queue.length, running: !!s.busy, streamId: (s.current && s.current.streamId) || null });
    return { lines, refused: refused.slice().reverse() };
  }

  return { onShipped, haltAll, inflights, status, _internals: { dispatch, live, lineage, MAX_PENDING, MAX_DEPTH } };
}

module.exports = { makeHandoffRunner, MAX_PENDING, MAX_DEPTH };
