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

// the first readable line of a run's delivered text: skip headings/rules/the routine banner, strip markdown marks.
function excerptOf(text) {
  const lines = str(text).split(/\r?\n/);
  for (const raw of lines) {
    let l = raw.trim();
    if (!l) continue;
    if (/^(#{1,6}\s|[-*_]{3,}$|✦\s)/.test(l)) { l = l.replace(/^#{1,6}\s+/, '').replace(/^✦\s+/, ''); if (!l || /^[-*_]{3,}$/.test(l)) continue; }
    l = l.replace(/^[-*•]\s+/, '').replace(/\*\*|__|`/g, '').trim();
    if (l) return clip(l, EXCERPT_MAX);
  }
  return '';
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
function failed(r) { return !!r && r.reason !== 'done'; }
function failWord(r) {
  const code = str(r && (r.failureCode || r.reason)).replace(/[_-]+/g, ' ').trim();
  return code && code !== 'done' ? code : 'did not finish';
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
     jobs   — cron jobs { id, name }   (names the routine rows)
     loops  — { id, name }             (names the loop rows)
     focus  — the resolved night focus { title, why[] } or null (the "next up" line; caller decides relevance) */
function compose(input) {
  const o = input || {};
  const since = Math.max(0, num(o.since));
  const now = Math.max(since, num(o.now));
  const jobName = new Map((Array.isArray(o.jobs) ? o.jobs : []).filter(j => j && j.id).map(j => [str(j.id), clip(j.name, TITLE_MAX)]));
  const loopName = new Map((Array.isArray(o.loops) ? o.loops : []).filter(l => l && l.id).map(l => [str(l.id), clip(l.name, TITLE_MAX)]));
  const inWindow = (t) => t > since && t <= now;

  const routines = new Map();   // key -> { kind:'routine', jobId, name, runs, failed, silent, latest }
  const loops = new Map();
  const failedBuilds = [];
  const runs = (Array.isArray(o.runs) ? o.runs : []).slice().sort((a, b) => endedAt(a) - endedAt(b));   // oldest → newest
  for (const r of runs) {
    const kind = kindOf(r);
    if (!kind || !inWindow(endedAt(r))) continue;
    if (kind === 'routine') {
      const key = str(r.cronJobId) || ('title:' + clip(r.sessionTitle || r.title, TITLE_MAX));
      let g = routines.get(key);
      if (!g) { g = { kind: 'routine', jobId: str(r.cronJobId), name: jobName.get(str(r.cronJobId)) || clip(r.sessionTitle || r.title || 'Routine', TITLE_MAX), runs: 0, failed: 0, silent: 0, latest: null }; routines.set(key, g); }
      g.runs++;
      if (failed(r)) g.failed++;
      else if (isSilent(r.deliveryText)) g.silent++;
      g.latest = { runId: str(r.runId), at: endedAt(r), failed: failed(r), why: failed(r) ? failWord(r) : '', excerpt: failed(r) ? '' : (isSilent(r.deliveryText) ? '' : excerptOf(r.deliveryText)), open: str(r.streamId) || ('cron-' + str(r.runId)) };
    } else if (kind === 'loop') {
      const id = str(r.streamId).slice('loop-'.length);
      let g = loops.get(id);
      if (!g) { g = { kind: 'loop', loopId: id, name: loopName.get(id) || clip(r.sessionTitle || r.title || 'Loop', TITLE_MAX), runs: 0, failed: 0, latest: null }; loops.set(id, g); }
      g.runs++;
      if (failed(r)) g.failed++;
      g.latest = { runId: str(r.runId), at: endedAt(r), failed: failed(r), why: failed(r) ? failWord(r) : '', excerpt: failed(r) ? '' : excerptOf(r.deliveryText), open: str(r.streamId) };
    } else if (kind === 'build' && failed(r)) {
      failedBuilds.push({ kind: 'build-failed', runId: str(r.runId), title: clip(r.sessionTitle || r.title || 'an away build', TITLE_MAX), why: failWord(r), at: endedAt(r) });
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

  // something NEW must have happened inside the window; still-waiting older builds alone never re-brief (anti-nag)
  const hasNews = newBuilds.length || failedBuilds.length || routineList.length || loopList.length || drafts.length;
  const counts = {
    newBuilds: newBuilds.length, waitingBuilds: allBuilds.length, failedBuilds: failedBuilds.length,
    routines: routineList.length, routineRuns: routineList.reduce((n, g) => n + g.runs, 0),
    failed: failedBuilds.length + routineList.reduce((n, g) => n + g.failed, 0) + loopList.reduce((n, g) => n + g.failed, 0),
    loops: loopList.length, drafts: drafts.length
  };
  if (!hasNews) return { empty: true, since, through: now, items: [], counts, text: '' };

  const items = [].concat(newBuilds, failedBuilds, routineList, loopList, drafts);
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
  for (const g of routineList) if (g.latest && g.latest.failed) needs.push('“' + g.name + '” failed' + (g.runs > 1 ? ' (latest of ' + g.runs + ' runs)' : '') + ': ' + g.latest.why + '.');
  if (needs.length) { L.push(''); L.push('**Waiting on you**'); for (const n of needs) L.push('- ' + n); }

  const done = [];
  for (const g of routineList.slice(0, MAX_ROUTINES)) {
    if (g.latest && g.latest.failed) continue;
    const times = g.runs === 1 ? 'ran' : 'ran ' + g.runs + '×';
    if (g.latest && g.latest.excerpt) done.push('“' + g.name + '” ' + times + '. Latest: ' + g.latest.excerpt);
    else if (g.silent === g.runs) done.push('“' + g.name + '” ' + times + ' — nothing new to report.');
    else done.push('“' + g.name + '” ' + times + '.');
  }
  if (routineList.length > MAX_ROUTINES) done.push((routineList.length - MAX_ROUTINES) + ' more routine' + (routineList.length - MAX_ROUTINES === 1 ? '' : 's') + ' ran.');
  for (const g of loopList.slice(0, MAX_LOOPS)) {
    done.push('Loop “' + g.name + '”: ' + g.runs + ' pass' + (g.runs === 1 ? '' : 'es') + (g.failed ? ' (' + g.failed + ' failed)' : '') + (g.latest && g.latest.excerpt ? '. Latest: ' + g.latest.excerpt : '.'));
  }
  if (done.length) { L.push(''); L.push('**Done**'); for (const d of done) L.push('- ' + d); }

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
    else if (it.kind === 'routine') L.push('- routine "' + it.name + '"' + (it.jobId ? ' (job ' + it.jobId + ')' : '') + ': ' + it.runs + ' run(s), ' + it.failed + ' failed; latest run ' + (it.latest ? it.latest.runId : '?') + '.');
    else if (it.kind === 'loop') L.push('- loop "' + it.name + '" (' + it.loopId + '): ' + it.runs + ' pass(es).');
    else if (it.kind === 'draft') L.push('- night-shift idea draft "' + it.title + '" (not built).');
    else if (it.kind === 'builds-waiting') L.push('- ' + it.count + ' earlier undecided build(s): ' + it.runIds.slice(0, 6).map(id => 'workshop/' + id + '/').join(', ') + '.');
  }
  return L.join('\n');
}

module.exports = { compose, contextBlock, kindOf, excerptOf, whenLabel, STREAM_ID, TITLE };
