/* sidecar/priorwork.js — the night shift's MEMORY OF PRIOR BUILDS + the host-enforced near-duplicate veto.

   THE PROBLEM THIS CLOSES (2026-10-05 audit item 1): each night's propose step saw only TONIGHT's drafts, and the
   candidate filter dropped only exact-title DECLINED ideas. Earlier nights' builds — undecided ones waiting on the
   desk, kept ones — were invisible, so live data showed "Playable parkour prototype" built three times and a
   speedrun timer three times (12 backlog items, 9 built, 0 decided). This module:
     · collect()  — gathers the last ~14 days of workshop builds / backlog items / desk drafts for the night-shift
                    agent (title + status undecided|kept|discarded|implemented|failed|queued|building|drafted + where
                    its files live), scoped to the focus when an item recorded one;
     · promptLines() — renders them as the "already built — continue or improve, don't rebuild" block;
     · veto()     — the HOST-ENFORCED guard: a candidate whose title is a near-duplicate (normalized-token Jaccard
                    ≥ 0.6) of a prior build is CONVERTED into "Continue: <that build>" when the newest matching
                    build is still undecided (iterate on the work already on the desk), and DROPPED otherwise (it
                    was kept, discarded, already queued, or failed twice — re-making it is duplicate work).

   PURE: no clock, rng or fs — `now` is injected, every input is a plain array the host already holds. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).priorwork = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;
  const WINDOW_DAYS = 14;
  const DUP_THRESHOLD = 0.6;
  const MAX_ITEMS = 12;
  const CONTINUE_PREFIX = 'Continue: ';

  const num = (v) => ((typeof v === 'number' && isFinite(v)) ? v : 0);
  const str = (v) => (v == null ? '' : String(v));

  // words that never make two titles "the same work" (articles, iteration markers, generic build verbs).
  const STOP = {};
  ('a an the and or of for to in on at by with from into my your our their this that it its '
    + 'continue continued continuing iteration iterate next version v1 v2 v3 v4 improved improve improvement '
    + 'new better build built make create simple basic small quick first draft').split(/\s+/).forEach(w => { if (w) STOP[w] = 1; });
  function stem(w) {
    if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
    return w;
  }
  function titleTokens(s) {
    const out = new Set();
    for (const w of str(s).toLowerCase().match(/[a-z0-9]+/g) || []) {
      if (w.length < 2 || STOP[w]) continue;
      out.add(stem(w));
    }
    return out;
  }
  // normalized-token Jaccard similarity in [0,1]. Two empty token sets are NOT similar (0) — an untitled item
  // must never veto anything.
  function similarity(a, b) {
    const A = titleTokens(a), B = titleTokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / (A.size + B.size - inter);
  }
  // strip any leading "Continue: " so a continuation of a continuation stays one level deep.
  function baseTitle(t) {
    let s = str(t).trim();
    while (/^continue\s*:\s*/i.test(s)) s = s.replace(/^continue\s*:\s*/i, '');
    return s;
  }
  function sameRef(a, b) { return str(a).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '') === str(b).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); }

  /* collect — the prior-work list, newest first. inp: {
       backlog:      workshop backlog items [{ id, title, ts, builtRunId?, builtAt?, buildingRunId?, attempts?, focusRef?, source? }]
       deliverables: lifecycle rows [{ agentId, runId, title, status, createdAt, updatedAt, summary? }]
       drafts:       night-shift desk drafts [{ title, at, wrote? }]
       agentId, focusRef?, now, windowDays? }
     An item that RECORDED a focusRef different from the current one is excluded (another project's work); an item
     with no recorded focus is included (legacy items predate the field — over-including only costs a prompt line). */
  function collect(inp) {
    inp = inp || {};
    const now = num(inp.now);
    const since = now - (num(inp.windowDays) || WINDOW_DAYS) * DAY_MS;
    const agentId = str(inp.agentId);
    const focusRef = str(inp.focusRef);
    const inWindow = (t) => num(t) > 0 && num(t) >= since && (!now || num(t) <= now + DAY_MS);
    const onFocus = (ref) => !focusRef || !str(ref) || sameRef(ref, focusRef);
    const out = [], runIds = new Set();
    for (const it of (Array.isArray(inp.backlog) ? inp.backlog : [])) {
      if (!it || !str(it.title) || !onFocus(it.focusRef)) continue;
      let status, at, runId = '';
      if (str(it.builtRunId)) { status = 'undecided'; runId = str(it.builtRunId); at = num(it.builtAt) || num(it.ts); }
      else if (str(it.buildingRunId)) { status = 'building'; runId = str(it.buildingRunId); at = num(it.ts); }
      else if (num(it.attempts) >= 2) { status = 'failed'; at = num(it.ts); }
      else { status = 'queued'; at = num(it.ts); }
      if (!inWindow(at)) continue;
      if (runId) runIds.add(runId);
      out.push({ title: str(it.title).slice(0, 200), status, at, runId, where: runId ? 'workshop/' + runId + '/' : '', backlogId: str(it.id), focusRef: str(it.focusRef) });
    }
    for (const r of (Array.isArray(inp.deliverables) ? inp.deliverables : [])) {
      if (!r || !str(r.title) || (agentId && str(r.agentId) !== agentId)) continue;
      if (str(r.runId) && runIds.has(str(r.runId))) continue;   // a live pending backlog item is the truth for that run
      const at = num(r.updatedAt) || num(r.createdAt);
      if (!inWindow(at)) continue;
      const status = ['kept', 'discarded', 'implemented', 'failed'].indexOf(r.status) >= 0 ? r.status : 'failed';
      if (str(r.runId)) runIds.add(str(r.runId));
      out.push({ title: str(r.title).slice(0, 200), status, at, runId: str(r.runId), where: str(r.runId) ? 'workshop/' + str(r.runId) + '/' : '', summary: str(r.summary).slice(0, 240) });
    }
    // reason-only desk drafts: only those that are NOT the desk copy of a build already listed above.
    const seenTitles = new Set(out.map(o => baseTitle(o.title).toLowerCase()));
    for (const d of (Array.isArray(inp.drafts) ? inp.drafts : [])) {
      if (!d || !str(d.title) || !inWindow(d.at)) continue;
      if (d.wrote && d.wrote.path) continue;                     // a build's desk copy — the build row covers it
      const k = baseTitle(d.title).toLowerCase();
      if (seenTitles.has(k)) continue;
      seenTitles.add(k);
      out.push({ title: str(d.title).slice(0, 200), status: 'drafted', at: num(d.at), runId: '', where: 'desk draft' });
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, num(inp.max) || MAX_ITEMS);
  }

  const STATUS_WORDS = {
    undecided: 'UNDECIDED — built, waiting on your review', kept: 'kept by the Commander', discarded: 'discarded by the Commander',
    implemented: 'implemented into the project', failed: 'failed to build', queued: 'queued, not built yet',
    building: 'being built', drafted: 'drafted (text only)'
  };
  function ago(at, now) {
    const t = num(at), n = num(now);
    if (!t || !n || n < t) return '';
    const days = Math.floor((n - t) / DAY_MS);
    return days <= 0 ? 'today' : (days === 1 ? 'yesterday' : days + 'd ago');
  }
  // one prompt line per prior item: "Title" — status (when) — files: where
  function promptLines(list, now) {
    return (Array.isArray(list) ? list : []).filter(Boolean).map(p => {
      const when = ago(p.at, now);
      return '"' + str(p.title).replace(/\s+/g, ' ').trim().slice(0, 120) + '" — ' + (STATUS_WORDS[p.status] || p.status)
        + (when ? ' (' + when + ')' : '') + (p.where ? ' — files: ' + p.where : '');
    });
  }

  /* veto — the host-enforced near-duplicate guard. Returns { candidates, dropped:[{title, matched, status, sim}],
     continued:[{title, of, runId}] }. The input candidates are not mutated. A candidate that already continues a
     build (continueOf set, or a "Continue:" title) is matched on its base title like any other. */
  /* opts.mode: 'build' (default — the jailed tool-run path) or 'draft' (the reason-only path).
       · a text DRAFT is not a build: on the build path a near-duplicate of a drafted item is NOT vetoed (building
         the thing a draft described is progress); on the draft path it becomes "Continue: <that draft>".
       · KEPT / IMPLEMENTED work is done: a plain re-proposal is dropped, but an EXPLICIT "Continue: X" (the model
         following the no-rebuild rule to improve it) is honored as a continuation of that build.
       · DISCARDED, QUEUED, BUILDING, FAILED → dropped (rejected, already lined up, or doomed). */
  function veto(candidates, prior, opts) {
    opts = opts || {};
    const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DUP_THRESHOLD;
    const mode = opts.mode === 'draft' ? 'draft' : 'build';
    const list = Array.isArray(prior) ? prior.filter(p => p && str(p.title) && !(mode === 'build' && p.status === 'drafted')) : [];
    const out = [], dropped = [], continued = [];
    for (const c0 of (Array.isArray(candidates) ? candidates : [])) {
      if (!c0) continue;
      const base = baseTitle(c0.title);
      const explicitContinue = /^\s*continue\s*:/i.test(str(c0.title));
      const matches = list.map(p => ({ p, sim: similarity(base, baseTitle(p.title)) })).filter(m => m.sim >= threshold);
      if (!matches.length) { out.push(c0); continue; }
      // prefer CONTINUING the newest matching undecided build (its files are on the desk, unreviewed); then (draft
      // path) the newest matching draft; then an explicitly-requested continuation of kept/implemented work.
      const newest = (pred) => matches.filter(m => pred(m.p)).sort((a, b) => b.p.at - a.p.at)[0];
      const undecided = newest(p => p.status === 'undecided' && p.runId)
        || (mode === 'draft' ? newest(p => p.status === 'drafted') : null)
        || (explicitContinue ? newest(p => (p.status === 'kept' || p.status === 'implemented') && p.runId) : null);
      if (undecided) {
        const p = undecided.p;
        const c = Object.assign({}, c0, {
          title: (CONTINUE_PREFIX + baseTitle(p.title)).slice(0, 80),
          continueOf: { runId: p.runId, title: p.title, where: p.where, at: p.at, backlogId: p.backlogId || '' }
        });
        out.push(c);
        continued.push({ title: str(c0.title), of: p.title, runId: p.runId });
        continue;
      }
      const best = matches.sort((a, b) => (b.sim - a.sim) || (b.p.at - a.p.at))[0];
      dropped.push({ title: str(c0.title), matched: best.p.title, status: best.p.status, sim: Math.round(best.sim * 100) / 100 });
    }
    // two candidates continuing the SAME build collapse to the first (one continuation per build per beat).
    const seenRun = new Set(), final = [];
    for (const c of out) {
      if (c.continueOf) { const k = c.continueOf.runId || ('draft:' + baseTitle(c.continueOf.title).toLowerCase()); if (seenRun.has(k)) continue; seenRun.add(k); }
      final.push(c);
    }
    return { candidates: final, dropped, continued };
  }

  return { collect, promptLines, veto, similarity, titleTokens, baseTitle, WINDOW_DAYS, DUP_THRESHOLD, MAX_ITEMS, CONTINUE_PREFIX };
});
