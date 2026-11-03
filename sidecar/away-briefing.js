/* sidecar/away-briefing.js — THE ONE RETURN REPORT (pure). "While you were away", composed from durable truth.

   THE PROBLEM THIS CLOSES (2026-10-04 audit). Unattended work started from ~8 triggers and landed on ~10
   surfaces: a fresh rail session per routine fire, one per away build, a COMMS digest that skipped every
   cron/workshop/night-shift run (the `internal` stream-prefix fold), a morning report that knew only the night
   shift, a drafts nudge, a workshop reveal, toasts. Coming back meant opening each one and stitching the story
   together yourself. This module folds ALL of it into ONE briefing — delivered as one assistant turn into ONE
   durable session (stream 'briefing'), so the Commander reads one message and replying continues from it.

   PURE: no IO, no clock, no fs. The host (index.js) gathers the inputs from the real stores (runStore rows,
   validated pending workshop manifests, night-shift drafts, cron jobs, the resolved night focus) and owns the
   durable "briefed through" stamp. Every line in the text maps to an input row — truthful telemetry: a count is
   a count of real rows, an excerpt is the run's own recorded delivery text, nothing is synthesized or padded.
   Nothing to say → empty:true and NO briefing (never nag). */
'use strict';

// TYPED OUTCOMES: a run's success is the outcome its row records (frontend/app/runoutcome.js), never its bare reason — a reply
// the provider cut and a question nobody was there to answer both end 'done' and were briefed under Done as "ran"
const RunOutcome = require('../frontend/app/runoutcome.js');
// a routine record's receipt of its last fire (pure: cron-store's reducers do no IO)
const { firesOf } = require('./cron-store.js');

const STREAM_ID = 'briefing';
const TITLE = 'While you were away';
const EXCERPT_MAX = 140;
const TITLE_MAX = 80;
const MAX_ROUTINES = 6;
const MAX_BUILDS = 4;
const MAX_DRAFTS = 3;
const MAX_LOOPS = 4;

const str = (v) => (v == null ? '' : String(v));
const num = (v) => ((typeof v === 'number' && isFinite(v)) ? v : (Number.isFinite(Number(v)) ? Number(v) : 0));
function clip(s, max) {
  const t = str(s).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const RULE_LINE = /^[-*_]{3,}$/;
const HEADING_LINE = /^#{1,6}\s/;
const FENCE_LINE = /^(`{3,}|~{3,})/;
// a pipe-table row or its |---|:--| separator — cells, never a sentence
const TABLE_LINE = /^\||^:?-{3,}:?\s*\|/;
/* A LEAD-IN IS NOT AN OUTCOME (live walk 10-14: "Latest: COPY's draft is in the context at the top. Let me analyze it
   now." — a worker's opening line, quoted as what the job produced). Decided by the text's STRUCTURE, never by its
   words: the opening paragraph is a lead-in when the next block is a rule or a heading (the answer starts there), or
   when it ends in a colon AND the block after it opens with a sentence (review 10-14: a colon before a code fence, a
   table or a list of bare names introduces material, not an outcome — quoting "python" or "| a | b |" is worse than
   the lead-in). Only the FIRST paragraph, and only when something follows. */
function afterLeadIn(lines) {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const first = lines[i] == null ? '' : lines[i].trim();
  if (!first || HEADING_LINE.test(first) || RULE_LINE.test(first) || FENCE_LINE.test(first) || /^✦\s/.test(first)) return lines;
  let end = i;
  while (end < lines.length && lines[end].trim()) end++;   // end = the first blank line after the opening paragraph
  let next = end;
  while (next < lines.length && !lines[next].trim()) next++;
  if (next >= lines.length || next === end) return lines;   // nothing follows it: the paragraph is all there is
  const after = lines[next].trim();
  const handsOver = RULE_LINE.test(after) || HEADING_LINE.test(after)
    || (/:$/.test(lines[end - 1].trim()) && isSentence(readableLine(after)));
  return handsOver ? lines.slice(next) : lines;
}
// one line's readable words: heading/banner/list/quote marks and **, __, ` dropped; '' for a rule, fence or table row
function readableLine(raw) {
  let l = String(raw || '').trim();
  if (!l || RULE_LINE.test(l) || FENCE_LINE.test(l) || TABLE_LINE.test(l)) return '';
  l = l.replace(/^(>\s?)+/, '').trim();
  l = l.replace(/^#{1,6}\s+/, '').replace(/^✦\s+/, '');
  if (!l || RULE_LINE.test(l)) return '';
  return l.replace(/^[-*•]\s+/, '').replace(/\*\*|__|`/g, '').trim();
}
// a sentence, structurally: at least two words with a letter among them (a bare file name or one token is a label)
function isSentence(l) { return /\S\s+\S/.test(l) && /\p{L}/u.test(l); }
function firstReadable(lines) {
  let fenced = false;
  for (const raw of lines) {
    const t = String(raw || '').trim();
    if (FENCE_LINE.test(t)) { fenced = !fenced; continue; }   // code is material, never the outcome sentence
    if (fenced) continue;
    const l = readableLine(t);
    if (l) return clip(l, EXCERPT_MAX);
  }
  return '';
}
// the first readable line of a run's delivered text: skip a lead-in, headings/rules/the routine banner, strip markdown
// marks. A lead-in with nothing readable after it is all the text there is, so it stays.
function excerptOf(text) {
  const lines = str(text).split(/\r?\n/);
  return firstReadable(afterLeadIn(lines)) || firstReadable(lines);
}
function isSilent(text) { return str(text).trim() === '[SILENT]'; }

/* which kind of UNATTENDED work a run row is — or null when it isn't away work at all.
   Interactive runs, delegated children (their parent is the unit of work), reason-only internal self-talk
   (explicit row.internal — recommendations, night-shift planning) and unknown streams are never briefed. */
function kindOf(r) {
  if (!r || typeof r !== 'object' || !r.runId) return null;
  if (r.internal === true) return null;
  if (r.surface === 'interactive') return null;
  if (r.parentRunId) return null;
  const sid = str(r.streamId);
  if (sid.indexOf('cron-') === 0 || (r.cronJobId && sid.indexOf('workshop-') !== 0)) return 'routine';
  if (sid.indexOf('workshop-') === 0 || sid.indexOf('nightshift-act-') === 0) return 'build';
  if (sid.indexOf('loop-') === 0) return 'loop';
  return null;
}
function endedAt(r) { return num(r && (r.endedAt || r.ts)); }
/* A STOP IS ITS OWN OUTCOME (review r7, the family law): a run someone stopped (Stop, pausing its routine mid-run, E-STOP, a STOP on its
   work line) is never briefed as a failure ("(1 failed)", "“digest” failed: cancelled." under Waiting on you, counts.failed) and never as
   a success ("ran"): it is counted and said apart, as a stop. The loop store already charges a cancelled pass to no streak. */
function stopped(r) { return !!r && RunOutcome.ofRow(r).outcome === 'stopped'; }
function failed(r) { return !!r && !RunOutcome.ofRow(r).ok && !stopped(r); }
const STOP_WORDS = 'stopped before it finished';
/* review r8: an unsuccessful run that did not FAIL — it asked a question, was cut short, hit a spend or step limit, sent back nothing, was
   refused or held. Still counted beside the failures (the ok arithmetic), but said and tallied as what it was: "“digest” failed: clarifying."
   briefed a question as a failure, and failWord printed the raw 'budget' / 'max iters' */
function unfinishedRow(r) { return failed(r) && RunOutcome.ofRow(r).outcome !== 'failed'; }
// a group's FAILED runs: g.failed less the share that only did not finish (review r8)
function failedOnly(g) { return Math.max(0, (g.failed || 0) - (g.unfinished || 0)); }
function failWord(r) {
  const oc = RunOutcome.ofRow(r || {});
  if (!oc.ok && oc.outcome !== 'failed') return RunOutcome.line(oc);   // review r8: the outcome's words, never the raw end word
  const code = str(r && (r.failureCode || r.reason)).replace(/[_-]+/g, ' ').trim();
  if (code && code !== 'done') return code;
  // a 'done' row that did not succeed names its outcome ("the reply was cut short", "asked a question")
  return oc.ok ? 'did not finish' : RunOutcome.line(oc);
}

// local wall-clock label "Sun 11:40 PM" — tzOffsetMin = minutes to ADD to UTC (the negative of getTimezoneOffset).
function whenLabel(ms, tzOffsetMin) {
  if (!(ms > 0)) return '';
  const d = new Date(ms + num(tzOffsetMin) * 60000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let h = d.getUTCHours(); const m = d.getUTCMinutes(); const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return days[d.getUTCDay()] + ' ' + h + ':' + (m < 10 ? '0' : '') + m + ' ' + ap;
}

/* compose(input) -> { empty, since, through, items[], counts{}, text }
   input = { since, now, tzOffsetMin, runs[], builds[], drafts[], jobs[], loops[], focus }
     runs   — runStore rows (any order); only unattended kinds that ENDED in (since, now] are briefed
     builds — validated, still-UNDECIDED workshop deliverables { runId, agentId, title, summary, builtAt }
     drafts — night-shift drafts { title, at }
     jobs   — cron jobs { id, name, lastRunId, lastOutcome, lastFailureCode, lastFire, fireReceipts }   (names the routine rows; its fires' outcomes)
     loops  — { id, name }             (names the loop rows)
     focus  — the resolved night focus { title, why[] } or null (the "next up" line; caller decides relevance)
     threads — worker threads { id, parentStreamId } + conversations { id, title } (names the delegated rows: a
               delegated worker is briefed as part of the CONVERSATION that asked for it, never on its own) */
function compose(input) {
  const o = input || {};
  const since = Math.max(0, num(o.since));
  const now = Math.max(since, num(o.now));
  const jobName = new Map((Array.isArray(o.jobs) ? o.jobs : []).filter(j => j && j.id).map(j => [str(j.id), clip(j.name, TITLE_MAX)]));
  const loopName = new Map((Array.isArray(o.loops) ? o.loops : []).filter(l => l && l.id).map(l => [str(l.id), clip(l.name, TITLE_MAX)]));
  const inWindow = (t) => t > since && t <= now;
  // a routine's LAST fire reads the outcome its record settled (review 5.2: a job's lastRunId / lastOutcome / lastFailureCode): a line
  // a reviewer held ends its entry run 'succeeded', and that row alone briefed the held fire under Done as "ran". Review 6.1: the record's
  // receipt of that fire (cron-store lastFireOf), which a config block or an unfireable mark never clears as it clears lastOutcome. Review
  // 6.2: and an OLDER fire's — a held fire read "ran" once its routine fired again; the record keeps each fire's receipt (cron-store firesOf)
  const fireOf = new Map([].concat(...(Array.isArray(o.jobs) ? o.jobs : []).map(firesOf)).filter(f => f && RunOutcome.isOutcome(f.outcome)).map(f => [str(f.runId), f]));
  const asFire = (r) => { const f = fireOf.get(str(r && r.runId)); return f ? Object.assign({}, r, { outcome: f.outcome, failureCode: str(f.failureCode) }) : r; };

  const threadRows = Array.isArray(o.threads) ? o.threads : [];
  const parentOf = new Map(threadRows.filter(t => t && t.id && t.parentStreamId).map(t => [str(t.id), str(t.parentStreamId)]));
  const titleOf = new Map(threadRows.filter(t => t && t.id).map(t => [str(t.id), clip(t.title, TITLE_MAX)]));
  const delegated = new Map();   // parent conversation id -> { kind:'delegated', parentId, name, runs, failed, latest }
  const routines = new Map();   // key -> { kind:'routine', jobId, name, runs, failed, silent, latest }
  const fires = new Map();      // a routine fire's runId -> { g, failed, silent } (its work line's stages read it)
  const loops = new Map();
  const failedBuilds = [];
  const stoppedBuilds = [];
  const runs = (Array.isArray(o.runs) ? o.runs : []).slice().sort((a, b) => endedAt(a) - endedAt(b));   // oldest → newest
  for (const r of runs) {
    // DELEGATED WORK (2026-10-09): a worker the overseer dispatched ran in its own thread under a conversation; it is
    // briefed as that conversation's work ("Launch planning: 3 delegated jobs finished"), opened at the conversation.
    const parent = r && r.delegatedBy && r.internal !== true && r.surface !== 'interactive' ? parentOf.get(str(r.streamId)) : '';
    if (parent && inWindow(endedAt(r))) {
      let g = delegated.get(parent);
      if (!g) { g = { kind: 'delegated', parentId: parent, name: titleOf.get(parent) || 'a conversation', runs: 0, failed: 0, stopped: 0, latest: null, open: parent }; delegated.set(parent, g); }
      g.runs++;
      // A worker's outcome is its FINAL delivery when it has one: a run can end 'done' with an output that failed its
      // result contract, and a repaired answer differs from the raw execution text. Pending/absent → the execution row.
      const dd = r.dispatchDelivery && r.dispatchDelivery.state === 'final' ? r.dispatchDelivery : null;
      // (a final delivery that says 'done' of an UNREPAIRED run reads that run's own outcome: a cut worker's reply is not done)
      // a worker stopped (its lead was stopped: the delivery's reason 'cancelled', or its own row's outcome) was stopped, never failed (review r7)
      const halted = dd ? str(dd.reason) === 'cancelled' : stopped(r);
      const bad = !halted && (dd ? (str(dd.reason) !== 'done' || (!str(dd.repairRunId) && failed(r))) : failed(r));
      /* review 8.1: which unsuccessful end it was — the delivery's own reason when it names one (deliveryReasonOf: outcome-aware), else the
         run's row. A worker that asked a question, was cut short or hit a limit is g.unfinished (g.asked for a question): still in g.failed
         for the ok arithmetic, as a routine's are, but never counted, briefed or handed to the model as a failure */
      const badKind = !bad ? '' : (dd && str(dd.reason) !== 'done') ? RunOutcome.ofWord(dd.reason).outcome : RunOutcome.ofRow(r).outcome;
      if (bad) g.failed++;
      else if (halted) g.stopped++;
      if (bad && badKind !== 'failed') g.unfinished = (g.unfinished || 0) + 1;
      if (bad && badKind === 'asked') g.asked = (g.asked || 0) + 1;
      // The delivery's reason says why when it adds something (an invalid result); one that only repeats the run's
      // own reason ('error') says less than the run's failure code ('rate limit').
      const ddWhy = dd && str(dd.reason) !== str(r.reason) ? str(dd.reason).replace(/[_-]+/g, ' ').trim() : '';
      g.latest = { runId: str(r.runId), at: endedAt(r), failed: bad, kind: badKind, stopped: halted,
        why: bad ? (badKind !== 'failed' ? RunOutcome.line({ outcome: badKind }) : (ddWhy || failWord(r))) : halted ? STOP_WORDS : '',
        excerpt: (bad || halted) ? '' : excerptOf(dd ? dd.text : r.deliveryText), open: str(r.streamId) };
      // the latest failed worker's why and the latest unfinished one's, each said beside its own count (review 8.1)
      if (bad && badKind === 'failed') g.failedWhy = g.latest.why;
      else if (bad && badKind !== 'asked') g.unfinishedWhy = g.latest.why;
      continue;
    }
    const kind = kindOf(r);
    if (!kind || !inWindow(endedAt(r))) continue;
    if (kind === 'routine') {
      /* A WORK LINE'S STAGE IS NO ROUTINE OF ITS OWN (review 5.3). A line's hops run on their fire's stream ('cron-<the fire's runId>') with
         no cronJobId, so each was grouped by its own handoff prompt as a separate "routine": a held fire's reviewer hop, whose own run
         succeeded, briefed the held fire under Done. The fire is briefed by its entry row and its record; a stage that did not succeed
         stopped its line, so its fire did not deliver. */
      const sid = str(r.streamId);
      const fireId = !r.cronJobId && sid.indexOf('cron-') === 0 ? sid.slice('cron-'.length) : '';
      if (fireId && fireId !== str(r.runId)) {
        const f = fires.get(fireId);
        if (f && !f.failed && !f.stopped && failed(r)) {
          f.failed = true; f.g.failed++;
          if (unfinishedRow(r)) f.g.unfinished = (f.g.unfinished || 0) + 1;   // review r8: a stage that did not finish is no failed stage
          if (f.silent) f.g.silent--;
          // the fire is said by its STAGE's outcome (review r8): a failed stage failed it, a cut or limited one left it unfinished
          if (f.g.latest && f.g.latest.runId === fireId) f.g.latest = Object.assign({}, f.g.latest, { failed: true, kind: RunOutcome.ofRow(r).outcome, why: 'its work line stopped at a stage (' + failWord(r) + ')', excerpt: '' });
        } else if (f && !f.failed && !f.stopped && stopped(r)) {
          // a stage SOMEONE STOPPED stopped its fire's line (review r7): the fire was stopped — never "failed: its work line stopped at a stage
          // (cancelled)" while its record, the HUD and its delivery say stopped (the fire's record reads 'stopped' since r7: RunOutcome.ofLine)
          f.stopped = true; f.g.stopped++;
          if (f.silent) f.g.silent--;
          if (f.g.latest && f.g.latest.runId === fireId) f.g.latest = Object.assign({}, f.g.latest, { stopped: true, why: 'its work line was stopped at a stage', excerpt: '' });
        }
        continue;
      }
      const key = str(r.cronJobId) || ('title:' + clip(r.sessionTitle || r.title, TITLE_MAX));
      let g = routines.get(key);
      if (!g) { g = { kind: 'routine', jobId: str(r.cronJobId), name: jobName.get(str(r.cronJobId)) || clip(r.sessionTitle || r.title || 'Routine', TITLE_MAX), runs: 0, failed: 0, stopped: 0, silent: 0, latest: null }; routines.set(key, g); }
      g.runs++;
      const fire = asFire(r);
      const halted = stopped(fire);
      if (failed(fire)) g.failed++;
      else if (halted) g.stopped++;
      if (unfinishedRow(fire)) g.unfinished = (g.unfinished || 0) + 1;   // review r8: the share of g.failed that did not fail (tallied apart)
      else if (isSilent(r.deliveryText)) g.silent++;
      fires.set(str(r.runId), { g, failed: failed(fire), stopped: halted, silent: !failed(fire) && !halted && isSilent(r.deliveryText) });
      g.latest = { runId: str(r.runId), at: endedAt(r), failed: failed(fire), kind: RunOutcome.ofRow(fire).outcome, stopped: halted, why: failed(fire) ? failWord(fire) : halted ? STOP_WORDS : '', excerpt: (failed(fire) || halted) ? '' : (isSilent(r.deliveryText) ? '' : excerptOf(r.deliveryText)), open: str(r.streamId) || ('cron-' + str(r.runId)) };
    } else if (kind === 'loop') {
      const id = str(r.streamId).slice('loop-'.length);
      let g = loops.get(id);
      if (!g) { g = { kind: 'loop', loopId: id, name: loopName.get(id) || clip(r.sessionTitle || r.title || 'Loop', TITLE_MAX), runs: 0, failed: 0, stopped: 0, latest: null }; loops.set(id, g); }
      g.runs++;
      if (failed(r)) g.failed++;
      else if (stopped(r)) g.stopped++;   // an E-STOPped or paused pass: neutral, as the loop store charges it (review r7)
      if (unfinishedRow(r)) g.unfinished = (g.unfinished || 0) + 1;   // review r8: the share of g.failed that did not fail
      g.latest = { runId: str(r.runId), at: endedAt(r), failed: failed(r), stopped: stopped(r), why: failed(r) ? failWord(r) : stopped(r) ? STOP_WORDS : '', excerpt: (failed(r) || stopped(r)) ? '' : excerptOf(r.deliveryText), open: str(r.streamId) };
    } else if (kind === 'build' && failed(r)) {
      failedBuilds.push({ kind: 'build-failed', runId: str(r.runId), title: clip(r.sessionTitle || r.title || 'an away build', TITLE_MAX), why: failWord(r), at: endedAt(r), unfinished: unfinishedRow(r) });
    } else if (kind === 'build' && stopped(r)) {
      // an away build someone stopped (E-STOP, a desk STOP) did not finish and did not fail: said apart, never under Waiting on you (review r7)
      stoppedBuilds.push({ kind: 'build-stopped', runId: str(r.runId), title: clip(r.sessionTitle || r.title || 'an away build', TITLE_MAX), at: endedAt(r) });
    }
  }

  const allBuilds = (Array.isArray(o.builds) ? o.builds : []).filter(b => b && b.runId)
    .map(b => ({ kind: 'build', runId: str(b.runId), agentId: str(b.agentId) || 'agent', title: clip(b.title || 'a deliverable', TITLE_MAX), summary: clip(b.summary, EXCERPT_MAX), builtAt: num(b.builtAt), isNew: inWindow(num(b.builtAt)), open: 'workshop-' + str(b.runId) }))
    .sort((a, b) => b.builtAt - a.builtAt);
  const newBuilds = allBuilds.filter(b => b.isNew);
  const olderBuilds = allBuilds.filter(b => !b.isNew);
  const buildTitles = new Set(allBuilds.map(b => b.title.toLowerCase()));
  const drafts = (Array.isArray(o.drafts) ? o.drafts : []).filter(d => d && inWindow(num(d.at)) && str(d.title).trim() && !buildTitles.has(clip(d.title, TITLE_MAX).toLowerCase()))
    .sort((a, b) => num(b.at) - num(a.at)).map(d => ({ kind: 'draft', title: clip(d.title, TITLE_MAX), at: num(d.at) }));

  const routineList = Array.from(routines.values()).sort((a, b) => (b.failed - a.failed) || ((b.latest && b.latest.at) - (a.latest && a.latest.at)));
  const loopList = Array.from(loops.values()).sort((a, b) => (b.latest && b.latest.at) - (a.latest && a.latest.at));
  const delegatedList = Array.from(delegated.values()).sort((a, b) => (b.failed - a.failed) || ((b.latest && b.latest.at) - (a.latest && a.latest.at)));

  // something NEW must have happened inside the window; still-waiting older builds alone never re-brief (anti-nag)
  const hasNews = newBuilds.length || failedBuilds.length || stoppedBuilds.length || routineList.length || loopList.length || delegatedList.length || drafts.length;
  const counts = {
    newBuilds: newBuilds.length, waitingBuilds: allBuilds.length, failedBuilds: failedBuilds.length,
    routines: routineList.length, routineRuns: routineList.reduce((n, g) => n + g.runs, 0),
    // review r8: counts.failed is FAILED runs; a run that asked, was cut short or hit a limit is counts.unfinished
    failed: failedBuilds.filter(b => b.kind === 'build-failed' && !b.unfinished).length + routineList.reduce((n, g) => n + failedOnly(g), 0) + loopList.reduce((n, g) => n + failedOnly(g), 0) + delegatedList.reduce((n, g) => n + failedOnly(g), 0),
    unfinished: failedBuilds.filter(b => b.unfinished).length + routineList.reduce((n, g) => n + (g.unfinished || 0), 0) + loopList.reduce((n, g) => n + (g.unfinished || 0), 0)
      + delegatedList.reduce((n, g) => n + (g.unfinished || 0), 0),   // review 8.1: a delegated worker that asked or did not finish too
    // (additive, review r7) the runs someone stopped: never in failed
    stopped: stoppedBuilds.length + routineList.reduce((n, g) => n + g.stopped, 0) + loopList.reduce((n, g) => n + g.stopped, 0) + delegatedList.reduce((n, g) => n + g.stopped, 0),
    loops: loopList.length, drafts: drafts.length,
    delegated: delegatedList.reduce((n, g) => n + g.runs, 0)
  };
  if (!hasNews) return { empty: true, since, through: now, items: [], counts, text: '' };

  const items = [].concat(newBuilds, failedBuilds, stoppedBuilds, routineList, loopList, delegatedList, drafts);
  if (olderBuilds.length) items.push({ kind: 'builds-waiting', count: olderBuilds.length, runIds: olderBuilds.map(b => b.runId), open: olderBuilds[0].open });

  // ---- the text: needs-you first, then what got done, then ideas, then what's next. Plain words. ----
  const L = [];
  const sinceLabel = whenLabel(since, o.tzOffsetMin);
  L.push('**' + TITLE + '**' + (sinceLabel ? ' · since ' + sinceLabel : ''));
  const needs = [];
  for (const b of newBuilds.slice(0, MAX_BUILDS)) needs.push('Built “' + b.title + '”' + (b.summary ? ' — ' + b.summary.replace(/[.!…\s]+$/, '') : '') + '. It’s waiting on you: open it to keep it or toss it.');
  if (newBuilds.length > MAX_BUILDS) needs.push((newBuilds.length - MAX_BUILDS) + ' more new build' + (newBuilds.length - MAX_BUILDS === 1 ? '' : 's') + ' waiting.');
  if (olderBuilds.length) needs.push(olderBuilds.length + ' earlier build' + (olderBuilds.length === 1 ? ' is' : 's are') + ' still waiting on a decision.');
  for (const f of failedBuilds.slice(0, 2)) needs.push('An away build (“' + f.title + '”) didn’t finish: ' + f.why + '.');
  // review r8: each said as what it was — a question waits on you ("asked you a question"), a cut reply or a limit did not finish, a failure failed
  for (const g of routineList) if (g.latest && g.latest.failed) needs.push('“' + g.name + '” ' + (g.latest.kind === 'asked' ? 'asked you a question' : g.latest.kind && g.latest.kind !== 'failed' ? 'did not finish' : 'failed') + (g.runs > 1 ? ' (latest of ' + g.runs + ' runs)' : '') + (g.latest.kind === 'asked' ? ' — answer it in its session.' : ': ' + g.latest.why + '.'));
  // review 8.1: a delegated worker that FAILED, one that did not finish and one that asked a question, each said as itself
  const jobs = n => n + ' delegated job' + (n === 1 ? '' : 's');
  for (const g of delegatedList) {
    const nFailed = failedOnly(g), nAsked = g.asked || 0, nShort = (g.unfinished || 0) - nAsked;
    if (nFailed) needs.push(jobs(nFailed) + ' in “' + g.name + '” failed' + (g.failedWhy ? ': ' + g.failedWhy : '') + '.');
    if (nShort) needs.push(jobs(nShort) + ' in “' + g.name + '” did not finish' + (g.unfinishedWhy ? ': ' + g.unfinishedWhy : '') + '.');
    if (nAsked) needs.push(jobs(nAsked) + ' in “' + g.name + '” asked you a question — answer it in that conversation.');
  }
  if (needs.length) { L.push(''); L.push('**Waiting on you**'); for (const n of needs) L.push('- ' + n); }

  // an earlier run that failed or was stopped is said beside the count, each as what it was (review r7: a stop read "(1 failed)")
  const tally = g => [failedOnly(g) ? failedOnly(g) + ' failed' : '', g.unfinished ? g.unfinished + ' did not finish' : '', g.stopped ? g.stopped + ' stopped' : ''].filter(Boolean).join(', ');
  const tallied = g => (tally(g) ? ' (' + tally(g) + ')' : '');
  const done = [], halted = [];
  for (const f of stoppedBuilds.slice(0, 2)) halted.push('An away build (“' + f.title + '”) was ' + STOP_WORDS + '.');
  for (const g of routineList.slice(0, MAX_ROUTINES)) {
    if (g.latest && g.latest.failed) continue;
    // a routine whose LATEST fire was stopped is said as the stop, under Stopped — never under Waiting on you as "failed", never as "ran"
    if (g.latest && g.latest.stopped) { halted.push('“' + g.name + '” was ' + STOP_WORDS + (g.runs > 1 ? ' (latest of ' + g.runs + ' runs' + (failedOnly(g) ? ', ' + failedOnly(g) + ' failed' : '') + (g.unfinished ? ', ' + g.unfinished + ' did not finish' : '') + ')' : '') + '.'); continue; }
    // an earlier fire that did not finish is said beside the count, as a loop's are (review 6.2: a held fire read "ran 2×." once its routine
    // fired again cleanly — its latest fire clean, the routine is briefed under Done)
    const times = (g.runs === 1 ? 'ran' : 'ran ' + g.runs + '×') + tallied(g);
    if (g.latest && g.latest.excerpt) done.push('“' + g.name + '” ' + times + '. Latest: ' + g.latest.excerpt);
    else if (g.silent === g.runs) done.push('“' + g.name + '” ' + times + ' — nothing new to report.');
    else done.push('“' + g.name + '” ' + times + '.');
  }
  if (routineList.length > MAX_ROUTINES) done.push((routineList.length - MAX_ROUTINES) + ' more routine' + (routineList.length - MAX_ROUTINES === 1 ? '' : 's') + ' ran.');
  for (const g of loopList.slice(0, MAX_LOOPS)) {
    done.push('Loop “' + g.name + '”: ' + g.runs + ' pass' + (g.runs === 1 ? '' : 'es') + tallied(g) + (g.latest && g.latest.excerpt ? '. Latest: ' + g.latest.excerpt : (g.latest && g.latest.stopped ? '. Latest: ' + STOP_WORDS + '.' : '.')));
  }
  for (const g of delegatedList) {
    const ok = g.runs - g.failed - g.stopped;
    if (ok > 0) done.push('“' + g.name + '”: ' + ok + ' delegated job' + (ok === 1 ? '' : 's') + ' finished' + (g.latest && g.latest.excerpt ? '. Latest: ' + g.latest.excerpt : '.'));
    if (g.stopped) halted.push(g.stopped + ' delegated job' + (g.stopped === 1 ? '' : 's') + ' in “' + g.name + '” ' + (g.stopped === 1 ? 'was' : 'were') + ' ' + STOP_WORDS + '.');
  }
  if (done.length) { L.push(''); L.push('**Done**'); for (const d of done) L.push('- ' + d); }
  // the runs someone STOPPED (review r7): neither Waiting on you (no failure) nor Done (no success)
  if (halted.length) { L.push(''); L.push('**Stopped**'); for (const d of halted) L.push('- ' + d); }

  if (drafts.length) {
    L.push(''); L.push('**Ideas drafted**');
    for (const d of drafts.slice(0, MAX_DRAFTS)) L.push('- ' + d.title);
    if (drafts.length > MAX_DRAFTS) L.push('- …and ' + (drafts.length - MAX_DRAFTS) + ' more');
  }

  const focus = o.focus && str(o.focus.title).trim() ? o.focus : null;
  if (focus) {
    const why = Array.isArray(focus.why) ? clip(focus.why[0], EXCERPT_MAX) : '';
    L.push(''); L.push('**Next up:** ' + clip(focus.title, TITLE_MAX) + (why ? ' — ' + why : ''));
  }
  L.push(''); L.push('Reply here to keep, change, or continue any of it.');

  return { empty: false, since, through: now, items, counts, text: L.join('\n') };
}

/* absence({ through, now, seen, minAwayMs, firstWindowMs }) -> { brief, since?, through }
   THE ABSENCE (live walk 10-14). `through` is the moment the Commander was last told OR last seen present. A page that
   reloaded mid-session briefed everything that had ended since the PREVIOUS briefing — work the Commander had watched
   land — as a new "While you were away", took the screen off the conversation whose approval was still waiting, and a
   restart twelve minutes later appended a second one. Now the page stamps its presence (seen:true) while the Commander
   is here, and a delivery names the page's own away threshold (minAwayMs): a stamp fresher than that is a reload or a
   restart, not an absence — nothing is briefed and the stamp moves to now. The stamp never moves backwards.
   No threshold named → the original contract (brief whatever ended since the stamp). */
function absence(o) {
  o = o || {};
  const through = Math.max(0, num(o.through)), now = Math.max(0, num(o.now));
  const next = Math.max(through, now);
  if (o.seen === true) return { brief: false, why: 'seen', through: next };
  const min = Math.max(0, Math.min(24 * 3600 * 1000, num(o.minAwayMs)));
  if (min > 0 && through > 0 && now - through < min) return { brief: false, why: 'present', through: next };
  return { brief: true, why: 'away', since: through || Math.max(0, now - Math.max(0, num(o.firstWindowMs))), through: now };
}

/* contextBlock(items) — the agent-facing reference for a run in the briefing session: WHERE each briefed thing
   actually lives, so "apply that build to the game" / "redo the news routine" starts from the work, not from
   scratch. Facts only (ids + jail paths the agent can read with its own tools). Bounded. */
function contextBlock(briefing) {
  const items = briefing && Array.isArray(briefing.items) ? briefing.items : [];
  if (!items.length) return '';
  const L = ['[AWAY BRIEFING CONTEXT] This session is the station\'s "' + TITLE + '" report. The Commander is replying to it. What each item refers to:'];
  for (const it of items.slice(0, 16)) {
    if (it.kind === 'build') L.push('- build "' + it.title + '": files in your workspace at workshop/' + it.runId + '/ (deliverable.json lists them). Still undecided — the Commander keeps/discards it from its session; you may read, extend, or copy it where they ask.');
    else if (it.kind === 'build-failed') L.push('- unfinished build "' + it.title + '" (run ' + it.runId + '): ' + it.why + '. Partial files may be in workshop/' + it.runId + '/.');
    else if (it.kind === 'build-stopped') L.push('- build "' + it.title + '" (run ' + it.runId + ') was stopped before it finished. Partial files may be in workshop/' + it.runId + '/.');
    else if (it.kind === 'routine') L.push('- routine "' + it.name + '"' + (it.jobId ? ' (job ' + it.jobId + ')' : '') + ': ' + it.runs + ' run(s), ' + failedOnly(it) + ' failed' + (it.unfinished ? ', ' + it.unfinished + ' did not finish' : '') + (it.stopped ? ', ' + it.stopped + ' stopped' : '') + '; latest run ' + (it.latest ? it.latest.runId : '?') + '.');
    else if (it.kind === 'loop') L.push('- loop "' + it.name + '" (' + it.loopId + '): ' + it.runs + ' pass(es).');
    else if (it.kind === 'draft') L.push('- night-shift idea draft "' + it.title + '" (not built).');
    // review 8.1: K failed is the FAILED workers alone; one that asked a question or did not finish is said apart, as a routine's are
    else if (it.kind === 'delegated') L.push('- conversation "' + it.name + '" (' + it.parentId + '): ' + it.runs + ' delegated job(s), ' + failedOnly(it) + ' failed'
      + ((it.unfinished || 0) - (it.asked || 0) ? ', ' + ((it.unfinished || 0) - (it.asked || 0)) + ' did not finish' : '') + (it.asked ? ', ' + it.asked + ' asked a question' : '')
      + (it.stopped ? ', ' + it.stopped + ' stopped' : '') + '; each worker\'s work is on that conversation\'s delegation card.');
    else if (it.kind === 'builds-waiting') L.push('- ' + it.count + ' earlier undecided build(s): ' + it.runIds.slice(0, 6).map(id => 'workshop/' + id + '/').join(', ') + '.');
  }
  return L.join('\n');
}

module.exports = { compose, contextBlock, kindOf, excerptOf, absence, whenLabel, STREAM_ID, TITLE };
