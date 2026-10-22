/* AGENT OS — discovery.js : THE ENVIRONMENT DISCOVERY ENGINE (pure reducers; the ambient half lives in index.js).

   THE PRODUCT GAP THIS CLOSES (rec-system audit, 2026-08-28). Agent OS's whole promise is that it finds the work —
   yet every proactive surface studied only what the Commander TYPED (transcripts, run titles, interview answers).
   The station never once looked at the projects the Commander had explicitly blessed it into. This module is the
   missing organ: it turns a bounded projectscan snapshot of a BLESSED root into candidate work items the existing
   recommendation surfaces can offer — each one carrying the repo's own line as its verbatim citation.

   THE LAWS IT INHERITS (all load-bearing, all learned elsewhere in this repo):
   1. DISCOVERY IS NOT AUTHORITY (project-discovery.js). This module never touches the grant store and its host
      tick scans NOTHING that isBlessedRoot does not already answer true for. A finding is a candidate, never an
      action: propose-and-confirm, always (the scout's law).
   2. EVIDENCE OR SILENCE, BY CONSTRUCTION. There is NO model call here. A finding exists only where the scan
      produced a real line (a TODO marker, a porcelain status row), and that line — verbatim, already clamped by
      projectscan's oneLine — IS the citation. Nothing is paraphrased, so nothing can be hallucinated.
   3. EVERY OUTCOME IS RECORDED (scout.js anti-silent-no-mint). A cycle that stages nothing writes a note saying
      so and why; the SCOUT-LOG discipline, applied to a second engine.
   4. AN EXPIRY IS NEVER A VERDICT (declinedindex / recommendation-ledger). Sweep drops an undecided finding after
      its TTL and releases the fingerprint, so a still-real chore may return later. Only DISMISS denylists.
   5. DETERMINISM SPLIT: pure fold, `now` always injected, no fs/exec/rng — lint-determinism clean. The host owns
      the clock, the scanner, the persistence and the tick.

   THE STATE (one workspaces JSON, persisted by the host):
     { v, staged: [ { id, root, displayPath, kind:'todo'|'wip', title, quote, fingerprint, at } ],
       denylist: [fp], resolved: [fp], ledger: [ { at, outcome, reason, title? } ],
       perRoot: { root: { lastScanAt } }, lastCycleAt } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).discovery = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATE_VERSION = 1;
  const CYCLE_MIN_GAP_MS = 10 * 60 * 1000;   // never two cycles within ten minutes, whatever arms them
  const ROOT_SCAN_GAP_MS = 60 * 60 * 1000;   // a given root is re-scanned at most hourly — repos don't churn faster
  const ROOTS_PER_CYCLE = 4;                 // bounded IO per tick: the stalest-scanned roots go first
  const TODO_PER_ROOT = 3;                   // at most 3 TODO findings staged per root per scan (the repo may hold hundreds)
  const STAGED_CAP = 12;                     // the shelf memory, across all roots
  const FINDING_TTL_MS = 14 * 86400000;      // undecided findings age out on the scout's own 14-day horizon
  const LEDGER_CAP = 50;
  const DENYLIST_CAP = 120;
  const RESOLVED_CAP = 120;
  const KINDS = ['todo', 'wip', 'client-update'];
  const TITLE_MAX = 90, QUOTE_MAX = 200, REASON_MAX = 200;

  const str = (v) => (v == null ? '' : String(v));
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const clip = (v, n) => str(v).replace(/\s+/g, ' ').trim().slice(0, n);

  // the shared match shape: root + the cited line, normalized the declinedindex way (exact, never fuzzy).
  function fingerprint(rootReal, quote) {
    return (str(rootReal).toLowerCase() + '|' + str(quote).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 240);
  }

  const baseName = (p) => {
    const parts = str(p).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : str(p);
  };

  /* ── THE EXTRACTION ──────────────────────────────────────────────────────────────────────────────────────
     scan → findings. Consumes projectscan's section contract ({label, lines[]}, lines already oneLine-clamped)
     and refuses to invent: an empty or failed scan yields []. Two kinds in v1, both mechanically checkable:
       'wip'  — the working tree holds uncommitted changes (git status --porcelain rows). ONE finding per root;
                its quote cites the first changed paths, its title carries the honest count.
       'todo' — a TODO/FIXME/XXX/HACK marker the repo's own author left (git grep rows, `path:line:text`).
                The top TODO_PER_ROOT stage; the marker line is the citation, verbatim. */
  function extractFindings(scan, meta) {
    meta = meta || {};
    const now = num(meta.now);
    const rootReal = str(meta.root);
    if (!scan || scan.ok !== true || !rootReal) return [];
    const displayPath = str(meta.displayPath) || rootReal;
    const base = baseName(displayPath);
    const out = [];
    const sections = Array.isArray(scan.sections) ? scan.sections : [];
    const sec = (label) => {
      const s = sections.find(x => x && str(x.label) === label);
      return s && Array.isArray(s.lines) ? s.lines.map(l => clip(l, QUOTE_MAX)).filter(Boolean) : [];
    };

    const status = sec('Uncommitted changes (working tree)');
    if (status.length) {
      const quote = status.slice(0, 3).join(' · ');
      out.push({
        id: 'wip:' + fingerprint(rootReal, base + ' wip').slice(0, 80) + ':' + now,
        root: rootReal, displayPath, kind: 'wip',
        title: clip('uncommitted work sitting in ' + base + ' (' + status.length + (status.length >= 24 ? '+' : '') + ' file' + (status.length === 1 ? '' : 's') + ')', TITLE_MAX),
        quote, fingerprint: fingerprint(rootReal, 'wip ' + quote), at: now
      });
    }

    const todos = sec('TODO / FIXME markers');
    for (const line of todos.slice(0, TODO_PER_ROOT)) {
      out.push({
        id: 'todo:' + fingerprint(rootReal, line).slice(0, 80) + ':' + now,
        root: rootReal, displayPath, kind: 'todo',
        title: clip('a marker your code left in ' + base + ': ' + line.replace(/^[^:]*:\d+:\s*/, ''), TITLE_MAX),
        quote: line, fingerprint: fingerprint(rootReal, line), at: now
      });
    }
    return out;
  }

  /* ---- state ---- */
  function normalize(raw) {
    const x = raw && typeof raw === 'object' ? raw : {};
    const staged = (Array.isArray(x.staged) ? x.staged : []).map(f => {
      if (!f || typeof f !== 'object') return null;
      const kind = KINDS.indexOf(str(f.kind)) >= 0 ? str(f.kind) : '';
      const id = str(f.id), rootReal = str(f.root), fp = str(f.fingerprint);
      const title = clip(f.title, TITLE_MAX), quote = clip(f.quote, QUOTE_MAX);
      if (!id || !kind || !rootReal || !fp || !title || !quote) return null;   // no citation, no row
      const row = { id, root: rootReal, displayPath: str(f.displayPath) || rootReal, kind, title, quote, fingerprint: fp, at: num(f.at) };
      if (kind === 'client-update') {
        row.sourceId = 'client-update';
        row.evidence = (Array.isArray(f.evidence) ? f.evidence : []).slice(0, 6)
          .map(e => ({ path: str(e.path).slice(0, 500), line: Math.max(1, num(e.line)), quote: clip(e.quote, QUOTE_MAX), modifiedAt: num(e.modifiedAt) }))
          .filter(e => e.path && e.quote);
        if (!row.evidence.length) return null;
      }
      return row;
    }).filter(Boolean).slice(-STAGED_CAP);
    const caplist = (v, cap) => (Array.isArray(v) ? v : []).map(s => str(s).slice(0, 240)).filter(Boolean).slice(-cap);
    const perRoot = {};
    if (x.perRoot && typeof x.perRoot === 'object') {
      for (const k of Object.keys(x.perRoot).slice(0, 64)) {
        const r = x.perRoot[k];
        if (r && typeof r === 'object') perRoot[str(k)] = { lastScanAt: num(r.lastScanAt) };
      }
    }
    return {
      v: STATE_VERSION, staged,
      denylist: caplist(x.denylist, DENYLIST_CAP),
      resolved: caplist(x.resolved, RESOLVED_CAP),
      ledger: (Array.isArray(x.ledger) ? x.ledger : []).filter(e => e && typeof e === 'object')
        .map(e => ({ at: num(e.at), outcome: clip(e.outcome, 24), reason: clip(e.reason, REASON_MAX), title: clip(e.title, TITLE_MAX) }))
        .slice(-LEDGER_CAP),
      sources: (Array.isArray(x.sources) ? x.sources : []).filter(s => s && s.id === 'client-update' && typeof s.root === 'string' && s.root)
        .slice(0, 1).map(s => ({ id: 'client-update', kind: 'client-update', root: s.root, enabled: s.enabled === true,
          lookbackDays: 7, lastScanAt: num(s.lastScanAt), status: clip(s.status, 80) || 'not-scanned' })),
      perRoot, lastCycleAt: num(x.lastCycleAt)
    };
  }

  function note(state, entry, o) {
    const s = normalize(state);
    s.ledger = s.ledger.concat([{ at: num(o && o.now), outcome: clip(entry && entry.outcome, 24), reason: clip(entry && entry.reason, REASON_MAX), title: clip(entry && entry.title, TITLE_MAX) }]).slice(-LEDGER_CAP);
    return s;
  }

  // may this finding be staged? One predicate, so the host and the reducer can never disagree.
  function eligible(state, finding) {
    const s = normalize(state);
    const fp = str(finding && finding.fingerprint);
    if (!fp) return false;
    if (s.staged.some(f => f.fingerprint === fp)) return false;         // already on offer
    if (s.denylist.indexOf(fp) >= 0) return false;                      // the Commander said no — forever
    if (s.resolved.indexOf(fp) >= 0) return false;                      // already picked up — don't re-nag
    return s.staged.length < STAGED_CAP;
  }

  function stage(state, finding, o) {
    const s = normalize(state);
    if (!eligible(s, finding)) return s;
    const rows = normalize({ staged: [finding] }).staged;
    if (!rows.length) return s;
    s.staged = s.staged.concat(rows).slice(-STAGED_CAP);
    return note(s, { outcome: 'staged', reason: rows[0].kind, title: rows[0].title }, o);
  }

  function markScanned(state, rootReal, o) {
    const s = normalize(state);
    s.perRoot[str(rootReal)] = { lastScanAt: num(o && o.now) };
    s.lastCycleAt = num(o && o.now);
    return s;
  }

  // DISMISS is a verdict: the fingerprint is denylisted for good. ACCEPT resolves it: picked up, don't re-mint.
  function dismiss(state, id, o) {
    const s = normalize(state);
    const row = s.staged.find(f => f.id === str(id));
    if (!row) return s;
    s.staged = s.staged.filter(f => f.id !== row.id);
    s.denylist = s.denylist.concat([row.fingerprint]).slice(-DENYLIST_CAP);
    return note(s, { outcome: 'dismissed', reason: 'commander', title: row.title }, o);
  }
  function accept(state, id, o) {
    const s = normalize(state);
    const row = s.staged.find(f => f.id === str(id));
    if (!row) return s;
    s.staged = s.staged.filter(f => f.id !== row.id);
    s.resolved = s.resolved.concat([row.fingerprint]).slice(-RESOLVED_CAP);
    return note(s, { outcome: 'accepted', reason: 'commander', title: row.title }, o);
  }

  // TTL sweep: an undecided finding ages out AND releases its fingerprint (an expiry is never a verdict) —
  // a chore the repo still carries may honestly return on a later scan.
  function sweep(state, now) {
    const s = normalize(state);
    const cut = num(now) - FINDING_TTL_MS;
    const dead = s.staged.filter(f => f.at < cut);
    if (!dead.length) return s;
    s.staged = s.staged.filter(f => f.at >= cut);
    let out = s;
    for (const f of dead) out = note(out, { outcome: 'expired', reason: 'aged out undecided', title: f.title }, { now: num(now) });
    return out;
  }

  /* decide: may a cycle run now, and which roots does it scan? Named bindings, scout-style, so the status route
     can say WHY the engine is quiet instead of just being quiet. */
  function decide(state, o) {
    o = o || {};
    const s = normalize(state);
    const now = num(o.now);
    const roots = Array.isArray(o.roots) ? o.roots.map(str).filter(Boolean) : [];
    if (!roots.length) return { fire: false, binding: 'no-roots', roots: [] };
    if (s.lastCycleAt && now - s.lastCycleAt < CYCLE_MIN_GAP_MS && !o.force) return { fire: false, binding: 'cooldown', roots: [] };
    const due = roots
      .map(r => ({ root: r, lastScanAt: num(s.perRoot[r] && s.perRoot[r].lastScanAt) }))
      .filter(r => o.force || now - r.lastScanAt >= ROOT_SCAN_GAP_MS)
      .sort((a, b) => a.lastScanAt - b.lastScanAt)
      .slice(0, ROOTS_PER_CYCLE)
      .map(r => r.root);
    if (!due.length) return { fire: false, binding: 'all-fresh', roots: [] };
    return { fire: true, binding: null, roots: due };
  }

  // the night-focus join: the freshest staged findings for one root, as bounded citation lines (max 2 —
  // normFocus keeps only 6 why lines total and the project's own evidence must survive alongside these).
  function findingsForRoot(state, rootReal, limit) {
    const s = normalize(state);
    const cap = Number.isFinite(limit) && limit > 0 ? limit : 2;
    return s.staged.filter(f => f.root === str(rootReal)).slice(-cap)
      .map(f => ({ quote: (f.kind === 'todo' ? 'its own code says: "' : f.kind === 'client-update' ? 'a selected document says: ' : 'the working tree holds ') + (f.kind === 'todo' ? f.quote + '"' : f.quote) }));
  }

  return {
    STATE_VERSION, CYCLE_MIN_GAP_MS, ROOT_SCAN_GAP_MS, ROOTS_PER_CYCLE, TODO_PER_ROOT,
    STAGED_CAP, FINDING_TTL_MS, LEDGER_CAP, DENYLIST_CAP, RESOLVED_CAP, KINDS,
    fingerprint, baseName, extractFindings, normalize, note, eligible, stage, markScanned,
    dismiss, accept, sweep, decide, findingsForRoot
  };
});
