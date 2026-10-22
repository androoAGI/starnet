/* AGENT OS — recledger.js : THE SPINE'S HALF OF THE ONE RECOMMENDATION MEMORY.

   THE PROBLEM THIS CLOSES (audit, 2026-08-05). The station kept TWO recommendation memories that never spoke:

     · the DURABLE, CROSS-SURFACE LEDGER (sidecar/recommendation-ledger.js) — what was shown, why it was allowed,
       what happened next. Written by four surfaces (scout/prospect, study, suggest, autojobs) and READ by six
       propose-time filters (reflection, thread mining, quest minting, the scout, the night shift, FOR YOU) plus
       the recruiter's preference model.
     · the BROWSER QUALITY EWMA (recqualitystore.js) — how well each spine channel's accepted offers actually
       turned out. Read by exactly one consumer: the spine.

   So a Commander who declined an idea at a COMMS card had declined it in localStorage only. The night shift could
   build it while they slept; the bay could shelve it the next morning; nothing outside chat.js ever learned that
   this channel's offers keep getting waved off. And the spine — the one place that decides who speaks — could not
   see a single one of the verdicts the rest of the station had been recording for months.

   This module is the missing wire, and it is deliberately THIN: the durable ledger already exists and already has
   the right shape. Everything here is either a write INTO it or a read FROM it.

     WRITE  note(candidate)            — the offer the spine just fired becomes a `shown` row.
            verdict(channel, …)        — the Commander's answer becomes that row's terminal state.
     READ   isDeclined(text)           — did they already wave this exact thing off ANYWHERE?
            preferenceOf(kind, traits) — the ledger's own learned, bounded, decayed preference weight.

   THE LAWS IT HOLDS (each one learned the hard way somewhere else in this repo):

   1. EXACT NORMALIZED MATCH, NEVER FUZZY. normKey() is byte-for-byte the sidecar's declinedindex.js normalization,
      duplicated rather than imported because this file runs in the browser and that one does not. A FALSE
      suppression — silently dropping a legitimately different idea — is worse than an occasional duplicate.
   2. FAIL-OPEN AT EVERY STEP. No fetch, no token, a 500, a hung request: the sets stay empty, isDeclined() answers
      false, preferenceOf() answers 0, and the spine ranks exactly as it did before this module existed. A memory
      the station cannot read is never a reason to go quiet.
   3. NO ROW WITHOUT A TITLE. A candidate that cannot name what it is proposing gets no ledger row — the same
      evidence-or-silence law the spine applies to its own citations, applied to its bookkeeping.
   4. THE CHANNELS THAT ALREADY WRITE THEIR OWN ROWS ARE LEFT ALONE. study (studystore.js) and suggest
      (suggeststore.js) mint their own ids with their own lifecycles; a second row from here would double-count
      every impression and halve their measured acceptance rate. OWN_LEDGER names them, and note() refuses them.
   5. `rate` AND `memory` ARE NOT SUGGESTIONS. The run earns them — the station never chose to interrupt — which is
      the same reason recommend.js exempts both from the ask budget and recqualitystore.js records no outcomes for
      them. They are not offered to the ledger either.

   Discipline mirrors the sibling stores: injectable fetch/clock, node-exportable for its test, READ-ONLY citizen
   of the event spine (it does not subscribe at all — the caller drives it). */
'use strict';
const RecLedger = (() => {
  const SURFACE = 'spine';
  const DECLINED_CAP = 250;      // the tail the browser keeps in memory — the ledger itself is capped at 4000
  const ROW_CAP = 20;            // channel → live row memory; there are ten channels, so this never evicts in practice
  /* HOW LONG AN UNANSWERED IMPRESSION MAY SIT ON THE LEDGER (dead-wires lane, 2026-08-28). The server's expiry
     sweep existed and ran on every GET, but NO writer ever set `expiresAt` — so a card the Commander simply never
     clicked stayed a `shown` row forever, quietly depressing acceptanceRate for an offer nobody could act on any
     more. Every row this module mints now declares one. The sweep's own law is unchanged and matters here: an
     expiry is NEVER a verdict — only rows still sitting at `shown`/`opened` drop, and a dropped row feeds nothing
     (it never enters the declined memory). 14 days matches the scout's draft TTL: the one other place the station
     already decided how long an un-answered proposal stays answerable. */
  const SHOWN_TTL_MS = 14 * 86400000;
  /* Channels whose rows are minted elsewhere (law 4) and channels that are not offers at all (law 5). Both lists
     are stated here rather than at the call sites so a new channel author reads one place and gets it right. */
  const OWN_LEDGER = { study: 1, suggest: 1 };
  const NOT_AN_OFFER = { rate: 1, memory: 1 };

  let deps = {};
  let declined = new Set();      // normalized keys of every EXPLICITLY declined title, from every surface
  let model = null;              // the ledger's replay preference model { kinds, traits, projects } or null
  let rows = new Map();          // channel → { id, target, title } — the offer currently awaiting a verdict
  let awaiting = new Map();      // channel → { id } — an ACCEPTED offer awaiting the outcome its work produces
  let seq = 0;
  let loadedAt = 0;

  const now = () => { const n = deps && typeof deps.now === 'function' ? Number(deps.now()) : NaN; return Number.isFinite(n) ? n : Date.now(); };
  const api = (u, init) => (deps.fetch ? deps.fetch(u, init)
    : (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(u, init)
    : Promise.reject(new Error('no api fetch')));

  /* THE SHARED MATCH KEY. Identical to sidecar/declinedindex.js normKey — lowercase, every non-alphanumeric run to
     one space, collapsed, trimmed. If these two ever drift, the browser starts suppressing things the server does
     not (or worse, the reverse), so the duplication is deliberate and the test locks both against each other. */
  function normKey(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // the ledger's own fingerprint shape for `target`: sorted significant tokens. Stable across sessions and across
  // trivial rewording, which is what makes a row findable later by the evaluation replay.
  function fingerprint(text) {
    const toks = String(text == null ? '' : text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ').slice(0, 200);
  }

  function post(body) {
    try { api('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch (_) {}
  }

  /* ── THE READ ────────────────────────────────────────────────────────────────────────────────────────────
     ONE request answers both questions the spine needs: what has been explicitly declined anywhere, and what has
     the Commander's history taught the ledger about each kind. Called at init and after each verdict the spine
     records (cheap, coalesced by REFRESH_MIN_MS) — never on a timer.

     WHY DECLINES ARE READ EVEN WHEN PERSONALIZATION IS PAUSED: a decline is not a learned preference, it is an
     instruction. `model` is the learned half and the server already withholds it (returns null) when the
     Commander has paused personalization; this module simply carries whatever the server chose to send. */
  const REFRESH_MIN_MS = 60 * 1000;
  async function refresh(force) {
    if (!force && loadedAt && (now() - loadedAt) < REFRESH_MIN_MS) return false;
    loadedAt = now();
    try {
      const r = await api('/api/recommendations?state=declined&limit=' + DECLINED_CAP, { cache: 'no-store' });
      if (!r || !r.ok) return false;
      const j = await r.json();
      const next = new Set();
      for (const e of (Array.isArray(j && j.entries) ? j.entries : [])) {
        const k = normKey(e && e.title);
        if (k) next.add(k);
      }
      declined = next;
      model = (j && j.model && typeof j.model === 'object') ? j.model : null;
      return true;
    } catch (_) { return false; }   // fail-open: the previous read stands, or nothing does
  }

  // did the Commander explicitly wave this exact thing off, on ANY surface? Empty/unparseable → never a hit.
  function isDeclined(text) { const k = normKey(text); return !!k && declined.has(k); }

  /* the ledger's learned weight for a candidate, −0.75..+0.75, or 0 when there is nothing to read.
     This is the browser's copy of sidecar/recommendation-ledger.js preferenceFor(), duplicated for the same
     reason normKey is: that module is a node require and this one is a script tag. Same clamp, same average-of-
     available-terms shape, so the number the spine reads is the number the server computed. */
  function preferenceOf(kind, traits) {
    if (!model) return 0;
    let sum = 0, n = 0;
    const take = x => { const w = Number(x && x.weight); if (Number.isFinite(w)) { sum += w; n++; } };
    take(model.kinds && model.kinds[String(kind || '')]);
    const list = Array.isArray(traits) ? traits : [];
    for (const t of list) { const k = String(t || '').toLowerCase(); if (k) take(model.traits && model.traits[k]); }
    if (!n) return 0;
    const avg = sum / n;
    return avg < -0.75 ? -0.75 : avg > 0.75 ? 0.75 : avg;
  }

  /* ── THE WRITE ───────────────────────────────────────────────────────────────────────────────────────────
     note(candidate) — the spine fired this offer; put it on the ledger as `shown` and remember the row so the
     Commander's answer can find it. Returns the row id, or '' when this candidate does not get one (no title,
     a channel that mints its own, or one of the two that are not offers at all).

     The row carries the candidate's OWN citation as `rationale`-typed evidence, never `quote`-typed: the why line
     is composed by the station from real state, and W3 established that calling composed prose a quote is the
     ledger lying about its own provenance. Where a channel really does carry the Commander's verbatim words it
     may pass evidenceKind:'verbatim' and the row says so honestly. */
  function note(candidate) {
    const c = candidate && typeof candidate === 'object' ? candidate : null;
    if (!c) return '';
    const channel = String(c.kind || '').slice(0, 40);
    if (!channel || OWN_LEDGER[channel] || NOT_AN_OFFER[channel]) return '';
    const title = String(c.title == null ? '' : c.title).trim().slice(0, 240);
    if (!title) return '';                       // law 3: no name, no row
    const target = String(c.target || fingerprint(title)).slice(0, 240);
    const id = 'spine:' + channel + ':' + target.slice(0, 60) + ':' + now() + ':' + (++seq);
    rows.set(channel, { id: id, target: target, title: title });
    while (rows.size > ROW_CAP) { const k = rows.keys().next().value; rows.delete(k); }
    const why = String(c.why == null ? '' : c.why).trim().slice(0, 280);
    const evidenceKind = c.evidenceKind === 'verbatim' ? 'quote' : 'rationale';
    post({
      id: id, surface: SURFACE, kind: channel, title: title, target: target,
      traits: [channel].concat(c.dim ? ['dim:' + String(c.dim)] : []),
      evidence: why ? [(evidenceKind === 'quote' ? { id: 'cite', type: 'quote', quote: why } : { id: 'cite', type: 'rationale', text: why })] : [],
      contextId: SURFACE + ':minute:' + Math.floor(now() / 60000), modelVersion: 'spine-v1',
      expiresAt: now() + SHOWN_TTL_MS
    });
    return id;
  }

  /* verdict(channel, state, reason) — the Commander answered. Posts the terminal state onto the row note() minted
     and drops it, so a second answer for the same channel can never re-verdict a row that is already closed (the
     ledger itself refuses that too; this just stops the pointless request).
     Returns true only when a row was actually found and answered — the caller may treat false as "nothing to
     record", never as a failure to report. */
  function verdict(channel, state, reason) {
    const ch = String(channel || '').slice(0, 40);
    const row = ch ? rows.get(ch) : null;
    if (!row) return false;
    rows.delete(ch);
    post({ id: row.id, state: String(state || ''), reason: String(reason || '') });
    /* an ACCEPT is not the end of the row's story — the work it spawns still owes the ledger its outcome
       (settle() below). Every other verdict is terminal for this module's bookkeeping. */
    if (state === 'accepted') {
      awaiting.set(ch, { id: row.id });
      while (awaiting.size > ROW_CAP) { const k = awaiting.keys().next().value; awaiting.delete(k); }
    }
    return true;
  }

  /* ── THE OUTCOME WIRE (dead-wires lane, 2026-08-28) ──────────────────────────────────────────────────────
     STATED HONESTLY (adversarial review, 2026-08-30): this wire is MECHANISM, currently DORMANT in production.
     settle() needs an `awaiting` row (a channel note() minted, then accepted) AND a forwarded run outcome
     (an accept armed with spawnsWork:true) — and today no spine channel does both: `suggest` spawns runs but
     mints its OWN ledger rows (OWN_LEDGER refuses it here), while every channel note() serves (arc/trust/
     thread/curiosity/recruit/seed/routine) accepts with spawnsWork:false, because their accepts ARE their
     outcomes. The wire goes live the day any row-minting channel starts launching work from its accept — do
     NOT delete it as dead, and do not claim it carries traffic until such a channel exists.
     The browser quality EWMA (recqualitystore.js) has known for weeks whether an accepted spine offer's run
     really finished and how the Commander rated it — and none of that ever reached the durable ledger, so for
     surface `spine` the server's replay() quality term was structurally zero and every channel's earned record
     died with the browser profile. settle() is the missing half of the accept: recqualitystore forwards each
     outcome it folds, and this module translates the ones the ledger can hold.

       completed    → the accepted row advances to state `completed` (the state machine allows it; the row is
                      KEPT here, because the Commander's rating usually lands after the finish).
       great/ok/miss→ the Commander's own verdict becomes the row's outcome.quality — the same ±1 vocabulary
                      suggeststore already posts — and closes this module's interest in the row.
       deferred     → the accept produced no run inside the attribution window. The ledger's state machine has
                      no accepted→deferred edge (correctly — the accept was real), so nothing is posted; the row
                      is dropped so a much-later unrelated rating can never be attributed to it.
     Everything else (engaged / declined) is already recorded by the verdict path and is refused here. Fail-open
     like every write in this file: no row awaiting → nothing to say. */
  const OUTCOME_QUALITY = { great: 1, ok: 0.25, miss: -1 };
  function settle(channel, outcome, runId) {
    const ch = String(channel || '').slice(0, 40);
    const row = ch ? awaiting.get(ch) : null;
    if (!row) return false;
    if (outcome === 'completed') { post({ id: row.id, state: 'completed', reason: 'completed' }); return true; }
    if (Object.prototype.hasOwnProperty.call(OUTCOME_QUALITY, String(outcome || ''))) {
      awaiting.delete(ch);
      post({ id: row.id, outcome: { quality: OUTCOME_QUALITY[outcome], runId: String(runId || ''), completedAt: now() } });
      return true;
    }
    if (outcome === 'deferred') { awaiting.delete(ch); return false; }
    return false;
  }
  // the accept/decline the spine's channels record, in the ledger's own vocabulary. `deferred` is the mild timing
  // signal ("not now"); a plain decline is a verdict about the thing itself.
  function accepted(channel) { return verdict(channel, 'accepted', 'accepted'); }
  function declinedVerdict(channel, deferred) {
    return deferred ? verdict(channel, 'deferred', 'wrong_time') : verdict(channel, 'declined', 'wrong_thing');
  }

  function init(opts) {
    deps = opts || {};
    declined = new Set(); model = null; rows = new Map(); awaiting = new Map(); seq = 0; loadedAt = 0;
    refresh(true);
  }
  function reset() { declined = new Set(); model = null; rows = new Map(); awaiting = new Map(); loadedAt = 0; }

  return { init, reset, refresh, isDeclined, preferenceOf, note, verdict, accepted, declined: declinedVerdict, settle,
    normKey, fingerprint, SURFACE, OWN_LEDGER, NOT_AN_OFFER, SHOWN_TTL_MS,
    _rows: () => rows, _awaiting: () => awaiting, _model: () => model, _declinedKeys: () => Array.from(declined), _setModelForTest: m => { model = m; } };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { RecLedger };
