/* AGENT OS — agentid.js : allocate a stable, unique agentId for a SUMMONED agent.

   The backend keys notebooks, the fs jail, checkpoints, cost and the run loop by agentId, and the
   wire grammar for those paths is ^[A-Za-z0-9_-]{1,40}$ (sidecar/tools/builtin/fs.js + index.js
   notebookFile). The hero is the reserved id 'agent'; every summoned agent must get a DIFFERENT,
   conforming, collision-free id. This is the one pure rule worth unit-testing on its own (summon
   itself is DOM-coupled), so it lives in its own zero-dep UMD module like workstreams.js.

   AgentId.alloc(seed, taken) -> a valid id derived from `seed`, never 'agent', unique vs `taken`
   (a Set/Map or anything with .has). AgentId.slug(seed) -> the sanitized base. AgentId.RE -> the
   backend's id grammar (exported so callers/tests assert against the SAME source of truth). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AgentId = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RE = /^[A-Za-z0-9_-]{1,40}$/;
  const NAME_MAX = 18;
  // Station-owned directories under WORKSPACES (codex/, channels/, connectors/, plugins/ …): an agent with one
  // of these ids would get that credential/code directory as its private file jail. The sidecar refuses them
  // (sidecar/workspace-reserved.js — test/workspace-reserved.test.js keeps the two lists identical); allocate
  // around them so a custom agent named "Codex" becomes codex-2 instead of a broken agent.
  const RESERVED = new Set(['_archive', 'channels', 'codex', 'grok', 'kimi', 'connectors', 'plugins', 'plugin-data', 'plugin-drafts', 'apps', 'app-data', 'skill-packages', 'skill-market',
    'transcript-history-v2', 'con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8',
    'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

  // sanitize any seed (specialty id/name) into a valid base: lowercase, non-id chars → '-', trim
  // stray dashes, cap at 32 so a '-N' disambiguator can never push the result past the 40-char limit.
  function slug(seed) {
    const s = String(seed == null ? '' : seed).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    return s || 'agent';
  }

  // allocate a unique id from `seed`: the slug, then '-2', '-3', … until it is neither 'agent' (the
  // hero's reserved id) nor already present in `taken`. Always matches RE (base≤32 + '-' + a small int).
  function alloc(seed, taken) {
    const has = (taken && typeof taken.has === 'function') ? (id => taken.has(id)) : (() => false);
    const base = slug(seed);
    let id = base, n = 1;
    while (id === 'agent' || RESERVED.has(id) || has(id)) { id = base + '-' + (++n); }
    return id;
  }

  function normalizeName(name) {
    return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
  }

  function nameIssue(name) {
    const n = normalizeName(name);
    if (!n) return 'empty';
    if (n.length > NAME_MAX) return 'too-long';
    return '';
  }

  function namesOf(taken) {
    if (!taken) return [];
    if (Array.isArray(taken)) return taken;
    if (taken instanceof Map) return Array.from(taken.values());
    if (typeof taken.values === 'function') return Array.from(taken.values());
    return [];
  }

  function nameConflict(name, taken) {
    const key = normalizeName(name);
    return !!key && namesOf(taken).some(a => normalizeName(a && (a.name || a)) === key);
  }

  function allocName(seed, taken) {
    const raw = normalizeName(seed) || 'AGENT';
    const base = raw.slice(0, NAME_MAX);
    if (!nameConflict(base, taken)) return base;
    for (let n = 2; n < 10000; n++) {
      const suffix = ' ' + n;
      const candidate = base.slice(0, NAME_MAX - suffix.length).trimEnd() + suffix;
      if (!nameConflict(candidate, taken)) return candidate;
    }
    return ('AGENT ' + Date.now()).slice(0, NAME_MAX);
  }

  return { slug, alloc, normalizeName, nameIssue, nameConflict, allocName, RE, NAME_MAX, RESERVED };
});
