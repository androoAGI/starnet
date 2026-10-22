/* AGENT OS — projects.js : pure display helpers for the PROJECTS rail view (NS-5c).

   The Projects rail is the SESSIONS↔PROJECTS toggle's second face. It renders GET /api/projects — every folder
   the Commander has blessed as a trusted project root (the NS-5 known-projects store, joined against the live
   path:<root> grant). This module owns ONLY the pure shaping so it is unit-testable headless like workstreams.js /
   classify.js: turning the API rows into rail rows, and the toggle's show/hide truth table. The DOM wiring
   (fetch, render, click→jump, remove→revoke, add→bless) lives in app.js.

   TRUTHFUL TELEMETRY: a row with blessed:false is NEVER hidden — it renders as REVOKED. The list mirrors exactly
   what the grant layer believes; a remembered-but-un-blessed root is shown as such, not silently dropped.

   Pure + dependency-free (Projects global in the browser; module.exports under node). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Projects = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // last path segment of a win32 OR posix absolute path (C:\a\b -> b, /a/b/ -> b). Trailing separators ignored.
  function basename(p) {
    const s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
    if (!s) return '';
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  }

  // compact right-edge stamp — the SAME vocabulary the sessions rail uses (now · 2m · 1h · 3d). Injected clock so
  // the test is deterministic; a null/0 timestamp reads '' (an un-touched project has no honest "last worked").
  function relTime(ms, nowMs) {
    if (!ms) return '';
    const now = (typeof nowMs === 'number') ? nowMs : Date.now();
    const d = now - ms;
    if (d < 60000) return 'now';
    const m = Math.floor(d / 60000);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }

  // map the GET /api/projects rows -> rail display rows. Server order is preserved (already newest-touched first).
  // blessed defaults TRUE only when the field is literally absent (older payloads); an explicit false stays false.
  function toRows(projects, nowMs) {
    return (Array.isArray(projects) ? projects : []).map(function (p) {
      p = p || {};
      const displayPath = (p.displayPath != null ? p.displayPath : (p.path != null ? p.path : p.root)) || '';
      const blessed = p.blessed !== false;
      return {
        root: p.root || displayPath,
        name: basename(displayPath) || String(p.root || ''),
        path: displayPath,
        blessed: blessed,
        state: blessed ? 'blessed' : 'revoked',
        isGitRepo: !!p.isGitRepo,
        lastTouchedAt: (typeof p.lastTouchedAt === 'number' && p.lastTouchedAt > 0) ? p.lastTouchedAt : null,
        rel: relTime((typeof p.lastTouchedAt === 'number' && p.lastTouchedAt > 0) ? p.lastTouchedAt : null, nowMs)
      };
    });
  }

  // two stored roots name the same folder? Separators unified and case folded — Windows paths are
  // case-insensitive, and the two anchor doors ("Work here" stores the server row's root; the path.trust
  // "Always" card stores the prompt's proposed root) may differ only in case/slash shape for the same folder.
  function sameRoot(a, b) {
    const norm = function (p) {
      let s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
      // Windows-shaped (drive letter or backslashes): separators unify and case folds — win32 paths are
      // case-insensitive. A posix path keeps its case (case-SENSITIVE filesystems) and only sheds the tail slash.
      if (/^[A-Za-z]:/.test(s) || s.indexOf('\\') >= 0) s = s.replace(/\//g, '\\').toLowerCase();
      return s;
    };
    const na = norm(a), nb = norm(b);
    return !!na && na === nb;
  }

  // the sessions attached to ONE project root — a REAL stored link (w.projectRoot, stamped when "Work here"
  // creates/joins a session or when a path.trust "Always" blesses mid-chat), never a title guess (truthful
  // telemetry: a listed session provably works in that root). Archived sessions are excluded; most-recently-
  // active first (the sessions rail's own order). Null-title records read as the General stream's display name.
  function sessionsFor(root, workstreams, nowMs) {
    if (root == null || root === '') return [];
    return (Array.isArray(workstreams) ? workstreams : [])
      .filter(function (w) { return w && !w.archived && sameRoot(w.projectRoot, root); })
      .slice()
      .sort(function (a, b) { return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); })
      .map(function (w) {
        return { id: w.id, title: (w.title != null && w.title !== '') ? w.title : (typeof Workstreams !== 'undefined' && Workstreams.titleOf ? Workstreams.titleOf(w) : 'General'), rel: relTime(w.lastActiveAt || 0, nowMs) };
      });
  }

  // the toggle's show/hide truth table (pure — app.js applies these to the real `hidden` flags). PROJECTS view
  // swaps the sessions list + its NEW action for the projects list + its ADD action, and vice-versa. The archived
  // reveal is NOT a head action — it's a footer row INSIDE #workstreams, so it follows sessionsList for free.
  function panels(view) {
    const projects = view === 'projects';
    return {
      sessionsList: !projects,   // #workstreams
      projectsList: projects,    // #projects
      newBtn: !projects,         // #ws-new
      addBtn: projects           // #ws-addproject
    };
  }

  return { basename, relTime, toRows, sameRoot, sessionsFor, panels };
});
