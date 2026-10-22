/* AGENT OS — discoverystore.js : the browser's read of ENVIRONMENT DISCOVERY (sidecar/discovery.js's shelf).

   The station's first organ that finds work the Commander never typed: the sidecar scans the BLESSED project
   roots on a slow tick and stages findings whose citations are the repo's own lines. This store is the thin
   wire the bay reads — same discipline as its siblings (recledger/prospectstore):
     · FAIL-OPEN EVERYWHERE: no route, a 500, a hung request → findings() answers [] and the bay simply has no
       discovery shelf. The frontend may never assert discovery state it cannot prove (scoutColdState law).
     · READ-ONLY CITIZEN of the event spine — no bus subscription; renderStage() pulls, decide() pushes.
     · NOTHING RUNS FROM HERE. accept posts the verdict; the caller scaffolds the composer (Chat.prefill) and
       the Commander sends it themselves — propose-and-confirm, the whole product's law. */
'use strict';
const DiscoveryStore = (() => {
  const REFRESH_MIN_MS = 60 * 1000;
  let deps = {};
  let cache = null;      // the last GET /api/discovery payload, or null (never loaded → assert nothing)
  let loadedAt = 0;

  const now = () => { const n = deps && typeof deps.now === 'function' ? Number(deps.now()) : NaN; return Number.isFinite(n) ? n : Date.now(); };
  const api = (u, init) => (deps.fetch ? deps.fetch(u, init)
    : (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(u, init)
    : Promise.reject(new Error('no api fetch')));

  async function refresh(force) {
    if (!force && loadedAt && (now() - loadedAt) < REFRESH_MIN_MS) return false;
    loadedAt = now();
    try {
      const r = await api('/api/discovery', { cache: 'no-store' });
      if (!r || !r.ok) return false;
      const j = await r.json();
      if (j && j.ok) cache = j;
      return true;
    } catch (_) { return false; }   // fail-open: the previous read stands, or nothing does
  }

  function findings() { return (cache && Array.isArray(cache.staged)) ? cache.staged : []; }
  function get(id) { return findings().find(f => f && f.id === String(id || '')) || null; }
  function status() { return cache; }   // null until a real server read — the bay asserts nothing before that

  /* the Commander's verdict. The staged row is dropped LOCALLY first so the shelf answers the click instantly,
     then the server write lands and the coalesced refresh re-syncs — an offline decide degrades to a local
     hide for this session, never a thrown error. */
  function decide(id, decision) {
    const f = get(id);
    if (!f || (decision !== 'accept' && decision !== 'dismiss')) return false;
    if (cache && Array.isArray(cache.staged)) cache.staged = cache.staged.filter(x => x && x.id !== f.id);
    try {
      api('/api/discovery/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: f.id, decision: decision }) })
        .then(() => refresh(true)).catch(() => {});
    } catch (_) {}
    return true;
  }

  // the Commander's own SCAN NOW — forces one server cycle, then re-reads. Resolves to the server's honest
  // answer ({ok:false, reason:'busy'|'personalization-paused'|'disabled'} included), or null when unreachable.
  async function scanNow() {
    try {
      const r = await api('/api/discovery/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!r || !r.ok) return null;
      const j = await r.json();
      await refresh(true);
      return j;
    } catch (_) { return null; }
  }

  function init(opts) { deps = opts || {}; cache = null; loadedAt = 0; refresh(true); }
  function reset() { cache = null; loadedAt = 0; }

  return { init, reset, refresh, findings, get, status, decide, scanNow, REFRESH_MIN_MS, _setCacheForTest: c => { cache = c; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { DiscoveryStore };
