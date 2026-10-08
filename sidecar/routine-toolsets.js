/* sidecar/routine-toolsets.js — the ONE reader of a routine's enabledToolsets list (create, update, routine.manage,
   and every load of cron.jobs.json).

   A routine's enabledToolsets is a restriction-only list of toolset FAMILY ids (inputpolicy enforceEnabledToolsets):
   null = the station grant unchanged; a list = only those families plus the computer freebies. Before 0.13.2 the
   list was only pattern-filtered, so the TOOLSETS console label a user copied ('WEB & BROWSER') was dropped to []
   and a tool name ('web_request') or 'Web' was kept as an unknown family — each stored as "restrict to (almost)
   nothing", and the routine fired with no web tools (#58). Create/update now normalize, but a routine saved before
   that kept its broken list forever: every fire path reads the stored list raw, and no UI edits toolsets.

     strict(v)  -> null | family ids     create/update: an unknown entry THROWS (refused by name, never dropped)
     lenient(v) -> { list, dropped }     a list already on disk: an unknown entry is DROPPED and reported, never
                                         thrown — a stored routine is never made unloadable by its own field
     healJobs(jobs) -> { jobs, healed }  lenient() over every stored routine; `healed` names each one that changed

   One contract for both: a family id (any case), a console label, or a tool name maps to its family; an empty list
   is NO restriction (null) — "nothing listed" is never "restrict to nothing". Naming only freebies (the computer's
   own tools, which no switch can turn off) keeps those freebie ids, so a stored [] can only ever mean a list that
   lost its entries — which is what lets a load heal [] to null without widening a real restriction. A freebie named
   beside a real family adds nothing and is dropped. lenient(strict(v)) === strict(v): healing is idempotent.

   Pure: same registry -> same answers. The registry, the TOOLSETS rows, the toggleable set and the freebies are
   injected by sidecar/index.js. */
'use strict';

function makeRoutineToolsets(deps) {
  const d = deps || {};
  const capRegistry = d.capRegistry || {};
  const freebies = d.freebies instanceof Set ? d.freebies : new Set(d.freebies || []);
  let index = null;
  function ix() {
    if (index) return index;
    const valid = (typeof d.toggleableCaps === 'function' ? d.toggleableCaps(capRegistry) : []).concat(['connectors']);
    const byLabel = new Map(), byTool = new Map();
    for (const row of (typeof d.toolsetRows === 'function' ? d.toolsetRows(capRegistry) : [])) byLabel.set(String(row.label).toLowerCase(), row.id);
    for (const objectType of Object.keys(capRegistry)) {
      for (const g of (capRegistry[objectType] || [])) {
        const t = String((g && g.tool) || '').toLowerCase();
        if (t && !byTool.has(t)) { byTool.set(t, g.capId); byTool.set(t.replace(/\./g, '_'), g.capId); }
      }
    }
    index = { valid, validSet: new Set(valid), byLabel, byTool };
    return index;
  }
  // one entry -> { family, free } | null (unknown). `free` marks the compute gate + the computer freebies.
  function familyOf(raw) {
    const k = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!k) return null;
    const x = ix();
    // a freebie's own family id is accepted too: it is what a freebies-only list stores, so a load must read it back
    let family = (x.validSet.has(k) || k === 'compute' || freebies.has(k)) ? k : (x.byLabel.get(k) || x.byTool.get(k) || '');
    if (!family && /^(mcp|plugin)[:_]/.test(k)) family = 'connectors';
    if (family === 'compute' || freebies.has(family)) return { family, free: true };
    return x.validSet.has(family) ? { family, free: false } : null;
  }
  function build(entries) {
    const out = [], free = [];
    let named = false;
    for (const raw of entries) {
      if (!String(raw == null ? '' : raw).trim()) continue;
      named = true;
      const f = familyOf(raw);
      const into = f.free ? free : out;
      if (into.indexOf(f.family) < 0) into.push(f.family);
      if (out.length >= 16 || free.length >= 16) break;
    }
    if (!named) return null;
    return out.length ? out : free;
  }
  function strict(v) {
    if (v == null) return null;
    if (!Array.isArray(v)) throw new Error('enabledToolsets must be a list of toolset ids');
    for (const raw of v) {
      const s = String(raw == null ? '' : raw).trim();
      if (s && !familyOf(s)) throw new Error('unknown toolset "' + s.slice(0, 80) + '" — valid: ' + ix().valid.join(', '));
    }
    return build(v);
  }
  function lenient(v) {
    if (v == null || !Array.isArray(v)) return { list: null, dropped: [] };   // the fire paths already read a non-list as null
    const kept = [], dropped = [];
    for (const raw of v) {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) continue;
      if (familyOf(s)) kept.push(s); else dropped.push(s.slice(0, 80));
    }
    return { list: build(kept), dropped };
  }
  const same = (a, b) => JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b);
  function healJobs(jobs) {
    const healed = [];
    const next = (Array.isArray(jobs) ? jobs : []).map(job => {
      if (!job || typeof job !== 'object' || !Object.prototype.hasOwnProperty.call(job, 'enabledToolsets') || job.enabledToolsets == null) return job;
      const r = lenient(job.enabledToolsets);
      if (same(r.list, job.enabledToolsets)) return job;
      const out = Object.assign({}, job, { enabledToolsets: r.list });
      // An unknown entry is dropped, not guessed at: say so on the routine's own row (the ROUTINES window shows
      // lastError) unless that row is already reporting a real failure, which stays the louder truth.
      if (r.dropped.length && !job.lastError) {
        out.lastError = 'toolset list repaired: dropped unknown ' + (r.dropped.length === 1 ? 'entry' : 'entries') + ' ' +
          r.dropped.map(s => '"' + s + '"').join(', ') + ' — this routine now runs with ' +
          (r.list ? 'only ' + r.list.join(', ') : 'its agent\'s full station tools');
      }
      healed.push({ id: job.id, from: job.enabledToolsets, to: r.list, dropped: r.dropped });
      return out;
    });
    return { jobs: next, healed };
  }
  return { strict, lenient, healJobs };
}

module.exports = { makeRoutineToolsets };
