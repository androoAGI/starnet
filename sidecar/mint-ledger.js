/* sidecar/mint-ledger.js — the PURE dedup gate + per-agent mint ledger for agent-initiated creations
   (W6 "mint ledger", docs/AWAY_WORKSHOP_PLAN.md). This is the same disease the memory-question overhaul
   cured for memory proposals: an unattended agent minted TWO near-identical "ULTRON daily operating loop"
   routines because the create choke points deduped only on job UUID, never on NAME. The reference
   implementations this reuses (never reinvents) are the declined ledger in memory-store.js:76-87 and the
   Jaccard near-dup guard in reflect.js:78-93.

   Two responsibilities, both pure (no Date.now / fs / rng — the host injects `now`; persistence is the
   memory-store `minted:<agentId>` key, ambient in index.js exactly like notebook:/todo:/declined:):

     1) THE GATE — `dupOf(candidate, liveJobs)` : does an agent already have this routine?
        A live job for the SAME agent whose normalized name is an EXACT match (fingerprint), OR is a
        NEAR-dup by Jaccard >= 0.6 (reused from reflect), counts as a duplicate. The choke points
        (routine.create tool + POST /api/cron) call this BEFORE creating and, on a hit, return the
        EXISTING job with a plain anti-retry message instead of minting a second one.

     2) THE LEDGER — a per-agent FIFO list of every agent-initiated creation
        `{ fp, kind, title, status:'created'|'declined', at }`. `declined` entries never re-mint (deleting
        a routine the agent made marks it declined — the agent must not resurrect it). A short summary
        ("you already maintain: …") is injected into propose-style prompts / the tool context so the model
        KNOWS what exists (informational → enforced: the gate is the hard stop, the summary reduces the
        model even trying).

   The ledger records are pure data; the reducers below take (ledger, args, { now }) and return a NEW
   array (input never mutated), so this file is headless-testable like cron-store.js / reflect.js. */
'use strict';
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('../frontend/app/memtruth.js') : root.MemTruth);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).mintLedger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (MemTruth) {
  'use strict';

  const LEDGER_CAP = 100;                 // FIFO ceiling — a long-lived station keeps the last N mints, not forever
  const SIM_THRESHOLD = MemTruth.SIM_THRESHOLD;   // near-dup cutoff — the SAME shared value memory dedup uses (memtruth.js)
  // stopwords for token-jaccard: the shared memory stoplist plus the cadence words a routine NAME carries ("daily",
  // "every", "each") — passed to the one similarity function as this ledger's own stoplist.
  const SIM_STOP = new Set(MemTruth.SIM_STOP_WORDS.split(/\s+/).concat(['daily', 'every', 'each']));

  // normalize a routine/quest NAME to a stable exact-match fingerprint: lowercase, strip non-alphanumerics to
  // single spaces, collapse+trim whitespace. "ULTRON daily operating loop" and "  Ultron  Daily Operating Loop "
  // fingerprint identically, so the exact-match arm of the gate catches the trivial-restatement dup.
  function normName(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // the Jaccard near-dup arm (>= 3-char tokens of the normalized name, this ledger's stoplist dropped) — the ONE
  // similarity function memory dedup uses too (frontend/app/memtruth.js), with the stoplist as a parameter.
  function jaccard(a, b) { return MemTruth.similarity(a, b, { stop: SIM_STOP, normalize: normName }); }

  // is `name` a duplicate of `otherName`? EXACT normalized-name match OR Jaccard >= threshold. Empty names never
  // match (a nameless routine isn't a dup of another nameless one — the gate only fires on real, named overlap).
  function isDup(name, otherName) {
    const a = normName(name), b = normName(otherName);
    if (!a || !b) return false;
    if (a === b) return true;
    return jaccard(name, otherName) >= SIM_THRESHOLD;
  }

  /* dupOf(name, liveJobs) — the GATE. `liveJobs` is the agent's OWN live jobs ([{ name, ... }], already
     filtered to the target agentId by the caller). Returns the FIRST existing job that duplicates `name`
     (exact or near), or null. The caller returns that job + the anti-retry message instead of minting. */
  function dupOf(name, liveJobs) {
    const list = Array.isArray(liveJobs) ? liveJobs : [];
    for (const j of list) {
      if (!j) continue;
      if (isDup(name, j.name)) return j;
    }
    return null;
  }

  // the plain-language anti-retry line handed back to the model on a duplicate — like permissions ANTI_RETRY,
  // it tells the model NOT to loop on recreating what already exists (no jargon, one obvious meaning).
  const ANTI_RETRY = 'this routine already exists — do not recreate it';

  // ---- THE LEDGER (pure reducers over the `minted:<agentId>` array) ----

  function normEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const fp = normName(e.fp != null ? e.fp : e.title);
    if (!fp) return null;
    const status = e.status === 'declined' ? 'declined' : 'created';
    return {
      fp: fp,
      kind: String(e.kind || 'routine'),
      title: String(e.title || ''),
      status: status,
      at: Number.isFinite(Number(e.at)) ? Number(e.at) : 0
    };
  }

  // load whatever came off disk into a clean, FIFO-capped ledger array (drops malformed records, keeps last CAP).
  function load(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const e of arr) { const n = normEntry(e); if (n) out.push(n); }
    return out.length > LEDGER_CAP ? out.slice(out.length - LEDGER_CAP) : out;
  }

  // find the ledger entry whose fingerprint matches `name` (exact-normalized), or null. Used to check `declined`
  // (never re-mint a declined creation) and to flip an entry's status on deletion.
  function findByName(ledger, name) {
    const fp = normName(name);
    if (!fp) return null;
    const list = Array.isArray(ledger) ? ledger : [];
    for (const e of list) if (e && e.fp === fp) return e;
    return null;
  }

  // has the agent DECLINED (deleted) a creation with this normalized name? A declined entry must never re-mint.
  function isDeclined(ledger, name) {
    const e = findByName(ledger, name);
    return !!(e && e.status === 'declined');
  }

  /* record — append (or refresh) a `created` mint. If a same-fp entry exists it is MOVED to the tail with the
     new timestamp (FIFO recency) and flipped back to `created` only if it wasn't declined — a declined entry
     stays declined here (the gate/isDeclined path is what blocks re-mint; recording a create for a declined fp
     is a no-op on status so a resurrected name can't silently re-created itself through this reducer). Returns a
     NEW capped array. */
  function record(ledger, entry, ctx) {
    const now = (ctx && ctx.now) || 0;
    const n = normEntry(Object.assign({ status: 'created', at: now }, entry || {}));
    if (!n) return Array.isArray(ledger) ? ledger.slice() : [];
    const kept = (Array.isArray(ledger) ? ledger : []).filter(e => e && e.fp !== n.fp);
    // preserve a prior declined verdict (deletion is sticky); otherwise this is a fresh/created entry.
    const prior = findByName(ledger, n.fp);
    if (prior && prior.status === 'declined') n.status = 'declined';
    kept.push(n);
    return kept.length > LEDGER_CAP ? kept.slice(kept.length - LEDGER_CAP) : kept;
  }

  /* markDeclined — the user deleted an agent-created routine: flip its entry to `declined` (or append a declined
     stub if none exists) so the agent never resurrects it. Returns a NEW array. `title`/`kind` optional (used
     only when appending a stub for a name the ledger never recorded). */
  function markDeclined(ledger, name, ctx) {
    const now = (ctx && ctx.now) || 0;
    const fp = normName(name);
    if (!fp) return Array.isArray(ledger) ? ledger.slice() : [];
    const list = (Array.isArray(ledger) ? ledger : []).map(e => e);
    let hit = false;
    const out = list.map(e => {
      if (e && e.fp === fp) { hit = true; return Object.assign({}, e, { status: 'declined', at: now }); }
      return e;
    });
    if (!hit) {
      out.push(normEntry({ fp: fp, kind: (ctx && ctx.kind) || 'routine', title: (ctx && ctx.title) || name, status: 'declined', at: now }));
      return out.length > LEDGER_CAP ? out.slice(out.length - LEDGER_CAP) : out;
    }
    return out;
  }

  /* summary — the short "you already maintain: …" line injected into propose prompts / tool context so the model
     knows what exists BEFORE it tries to mint a dup. Lists only `created` (live) titles, newest first, capped. */
  function summary(ledger, opts) {
    const max = (opts && Number.isFinite(opts.max)) ? opts.max : 8;
    const titles = [];
    const list = Array.isArray(ledger) ? ledger : [];
    for (let i = list.length - 1; i >= 0 && titles.length < max; i--) {
      const e = list[i];
      if (e && e.status === 'created' && e.title) titles.push(e.title);
    }
    if (!titles.length) return '';
    return 'You already maintain these routines — do not recreate them: ' + titles.join('; ') + '.';
  }

  /* sweepDuplicates(jobs) — the one-time boot cleanup. Collapse jobs that are IDENTICAL in
     (agentId, normalized name, prompt), keeping the OLDEST (earliest createdAt; ties keep the earliest in array
     order). This is the exact-triple collapse the plan specifies — NOT the fuzzy gate — so it only ever removes
     a true accidental double-mint (same agent, same name, same instruction), never two deliberately-distinct
     routines. Returns { jobs: keptJobs, removed: [job,…] } (input never mutated). The host logs each removal
     plainly and persists the kept set. This is what cleans Andrew's existing "ULTRON daily operating loop" pair. */
  function sweepDuplicates(jobs) {
    const list = Array.isArray(jobs) ? jobs.slice() : [];
    const keyOf = (j) => normName(j.agentId) + '\u0000' + normName(j.name) + '\u0000' + normName(j.prompt);
    // stable order by createdAt (oldest first), preserving original index for ties so "keep the oldest" is deterministic.
    const indexed = list.map((j, i) => ({ j: j, i: i }));
    indexed.sort((a, b) => {
      const ta = Date.parse(a.j && a.j.createdAt) || 0, tb = Date.parse(b.j && b.j.createdAt) || 0;
      return ta !== tb ? ta - tb : a.i - b.i;
    });
    const seen = new Set();
    const keepIdx = new Set();
    const removed = [];
    for (const { j, i } of indexed) {
      if (!j) { keepIdx.add(i); continue; }
      const k = keyOf(j);
      if (seen.has(k)) { removed.push(j); continue; }   // a later (newer) identical triple — drop it
      seen.add(k); keepIdx.add(i);
    }
    // rebuild in ORIGINAL array order, dropping the removed ones (kept set stays stable for the store).
    const kept = list.filter((_, i) => keepIdx.has(i));
    return { jobs: kept, removed: removed };
  }

  return {
    normName: normName,
    jaccard: jaccard,
    isDup: isDup,
    dupOf: dupOf,
    sweepDuplicates: sweepDuplicates,
    ANTI_RETRY: ANTI_RETRY,
    load: load,
    record: record,
    markDeclined: markDeclined,
    isDeclined: isDeclined,
    findByName: findByName,
    summary: summary,
    LEDGER_CAP: LEDGER_CAP,
    SIM_THRESHOLD: SIM_THRESHOLD
  };
});
