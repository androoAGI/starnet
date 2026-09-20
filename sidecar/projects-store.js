/* sidecar/projects-store.js — the KNOWN-PROJECTS store (NS-5 Project Lens core).

   Every folder the Commander BLESSES as a trusted project root (via the conversational path-trust
   prompt — see pathtrust.js / permissions.js) is durably remembered here, keyed by its normalized
   real path. This is the future AUTONOMY SURFACE: the night shift will only ever revisit blessed
   roots (that consumption lane is NS-5c, NOT this module — here we only make the set readable +
   keep its light metadata fresh). The AUTHORITY over whether a root is *currently* trusted stays
   the standing `path:<root>` grant in permissions.allow.json; this store is metadata, so a revoked
   grant does not delete history — the reader joins the two (GET /api/projects reports `blessed`).

   makeProjectsStore({ records, persist, now }) -> { snapshot, upsert, touch, get, has, remove, roots }
     records : the in-memory array of project rows (injected so the sidecar edge can hydrate from disk
               and share the SAME reference the reader serializes). Rows: { root, displayPath,
               grantedAt, lastTouchedAt, isGitRepo }.
     persist : (records[]) => void  — the durable sink (fsync-before-rename in index.js). Injected;
               THROWS on a real write failure. upsert is persist-before-commit (fail-closed) like the
               grant path; touch is best-effort (lastTouchedAt is soft metadata, never a security boundary,
               so a torn touch keeps the in-memory bump rather than denying).
     now     : injected clock (Date.now at the edge; a fixed stub in tests). Never read from wall-clock here.

   Pure: no IO, no clock, no env — persist + now are injected. Node-testable; UMD so a future frontend
   projects panel can import it. The KEY is the caller-normalized real root (pathtrust.js owns
   normalization so the grant key `path:<root>` and this store key are the SAME string). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).projectsStore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  function makeProjectsStore(opts) {
    opts = opts || {};
    const records = Array.isArray(opts.records) ? opts.records : [];
    const persist = typeof opts.persist === 'function' ? opts.persist : null;
    const now = typeof opts.now === 'function' ? opts.now : (() => null);

    const indexOfRoot = (key) => records.findIndex(r => r && r.root === key);

    // a defensive deep-ish copy so a caller can't mutate the live rows out from under the store.
    const rowView = (r) => ({
      root: r.root,
      displayPath: r.displayPath != null ? r.displayPath : r.root,
      grantedAt: r.grantedAt != null ? r.grantedAt : null,
      lastTouchedAt: r.lastTouchedAt != null ? r.lastTouchedAt : null,
      isGitRepo: !!r.isGitRepo,
      preferredAgents: Array.isArray(r.preferredAgents) ? r.preferredAgents.slice() : []
    });

    function snapshot() {
      // newest-touched first — the autonomy surface cares about "what did the user work on lately".
      return { projects: records.map(rowView).sort((a, b) => (b.lastTouchedAt || 0) - (a.lastTouchedAt || 0)) };
    }

    function get(key) { const i = indexOfRoot(key); return i < 0 ? null : rowView(records[i]); }
    function has(key) { return indexOfRoot(key) >= 0; }
    function roots() { return records.map(r => r.root); }

    // ADD or UPDATE a blessed root's metadata. Persist-before-commit (fail-closed): a thrown persist
    // leaves the in-memory rows untouched and returns ok:false so the caller can deny the bless. An
    // existing row keeps its original grantedAt (a re-bless does not reset provenance) but refreshes
    // isGitRepo/displayPath and bumps lastTouchedAt.
    function upsert(key, meta) {
      if (typeof key !== 'string' || !key) return { ok: false, reason: 'missing root' };
      meta = meta || {};
      const at = now();
      const i = indexOfRoot(key);
      const prev = i < 0 ? null : records[i];
      const nextRow = {
        root: key,
        displayPath: meta.displayPath != null ? String(meta.displayPath) : (prev && prev.displayPath != null ? prev.displayPath : key),
        grantedAt: prev && prev.grantedAt != null ? prev.grantedAt : (meta.grantedAt != null ? meta.grantedAt : at),
        lastTouchedAt: meta.lastTouchedAt != null ? meta.lastTouchedAt : at,
        isGitRepo: meta.isGitRepo != null ? !!meta.isGitRepo : !!(prev && prev.isGitRepo),
        preferredAgents: Array.isArray(meta.preferredAgents) ? [...new Set(meta.preferredAgents.filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)))].slice(0, 80)
          : (prev && Array.isArray(prev.preferredAgents) ? prev.preferredAgents.slice() : [])
      };
      const nextRecords = records.slice();
      if (i < 0) nextRecords.push(nextRow); else nextRecords[i] = nextRow;
      if (persist) {
        try { persist(nextRecords.map(rowView)); }
        catch (e) { return { ok: false, reason: 'could not persist project — denied' }; }
      }
      if (i < 0) records.push(nextRow); else records[i] = nextRow;
      return { ok: true, project: rowView(nextRow) };
    }

    // bump lastTouchedAt on any fs I/O under a KNOWN root. Best-effort: if the root isn't tracked yet it
    // is a no-op (touch never CREATES a row — only a bless does). A torn persist keeps the in-memory bump
    // (soft metadata, never a gate) so a flaky disk can't stall a legitimate read.
    function touch(key, at) {
      const i = indexOfRoot(key);
      if (i < 0) return { ok: false };
      records[i].lastTouchedAt = at != null ? at : now();
      if (persist) { try { persist(records.map(rowView)); } catch (e) { failNote('projects.persist', e); } }
      return { ok: true };
    }

    // REMOVE a project row entirely (hard forget). Persist-before-commit. The permissions revoke path does
    // NOT call this (revoking a grant leaves the metadata/history, just un-blessed); this exists for an
    // explicit "forget this project" action a future UI can offer.
    function remove(key) {
      const i = indexOfRoot(key);
      if (i < 0) return { ok: true };
      const nextRecords = records.slice(); nextRecords.splice(i, 1);
      if (persist) {
        try { persist(nextRecords.map(rowView)); }
        catch (e) { return { ok: false, reason: 'could not persist removal — kept' }; }
      }
      records.splice(i, 1);
      return { ok: true };
    }

    return { snapshot, upsert, touch, get, has, remove, roots };
  }

  return { makeProjectsStore };
});
