/* sidecar/transcriptstore.js — durable per-workstream conversation transcript (P0.1).

   The spend ledger records the COST of a run; runstore.js records the OUTCOME (one line per finished
   run). NEITHER keeps WHAT was said: `runstore.js`'s own header notes "the full message log is discarded
   once the SSE stream closes." So a sidecar restart wipes the agent's memory of the actual dialogue — the
   single most jarring day-to-day regression vs a production-class agent (which resumes its transcript). This
   module closes that: an append-only, per-stream conversation log on the sidecar's own disk (the app-data
   WORKSPACES dir that survives a browser wipe), so a restart can reload the recent dialogue per workstream.

   Same discipline as its siblings (runstore/ledger): PURE given an injected `io` (readAll/append — the host
   owns the fsync'd disk append) and `clock`. No ambient time/IO, so it passes lint-determinism and tests
   headlessly with an in-memory io. A missing/corrupt store -> empty history (fail-open; a run is NEVER
   crashed by an unreadable transcript). Content is run through the injected `redact` on write so a
   secret-shaped token can't be laundered into a durable file (consistent with the SSE/NDJSON redaction).

   It lives under <root>/transcript-history-v2/ — a SIBLING of the fs jail (<root>/<agentId>/), so the
   agent's own fs.* tools can neither read nor corrupt the record of its own conversations. Legacy
   transcript.jsonl(.1) inputs remain in place after import. It holds no key (those are stored separately).

     makeTranscriptStore({ io, clock, redact?, limit?, deletedAt?, latestDeleteAt? }) -> {   // deletedAt, latestDeleteAt: the deleted-session ledger (see below)
       append({ streamId, agentId, role, content }) -> entry,   // stamps ts, redacts content, appends, returns it
       history(streamId, { limit }?) -> entry[],   // CHRONOLOGICAL (oldest-first) for replay; last `limit` of that stream
       all() -> entry[],   count() -> int,   // all() is the RAM mirror: the newest rows only
       eachRow(visit, { claims }?) -> { doubted, unread }   // every durable row once; a claim a damaged line or a missing segment may hold comes back doubted (throws TRANSCRIPT_UNVOUCHED only while the disk cannot be vouched for)
     } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).transcriptstore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };
  // the turnId grammar, row kinds and quote stamp (frontend/app/turnkinds.js, the same module the page loads)
  const TurnKinds = (typeof require === 'function') ? require('../frontend/app/turnkinds.js') : ((typeof globalThis !== 'undefined' && globalThis.TurnKinds) || null);
  // the one flattener of a message's text parts (frontend/app/usertext.js; this store's join is its STORED policy)
  const UserText = (typeof require === 'function') ? require('../frontend/app/usertext.js') : ((typeof globalThis !== 'undefined' && globalThis.UserText) || null);
  const TurnView = (typeof require === 'function') ? require('./turn-view.js') : ((typeof globalThis !== 'undefined' && globalThis.TurnView) || null);
  // the bare attachment source: the one taint stamp that decays on replay (taint-replay.js). Unknown here = nothing decays.
  const Taint = (typeof require === 'function') ? require('./taint.js') : ((typeof globalThis !== 'undefined' && globalThis.SK && globalThis.SK.taint) || null);
  const ATTACHMENT_TAINT = (Taint && Taint.ATTACHMENT_TAINT) || '';
  const storesExpansion = (Taint && Taint.rowStoresAttachmentText) || (() => false);
  // the validator of an 'attachment' row's `attachment` field (sidecar/turn-attachment.js). Unknown here = the field is not kept.
  const TurnAttachment = (typeof require === 'function') ? require('./turn-attachment.js') : ((typeof globalThis !== 'undefined' && globalThis.SK && globalThis.SK.turnattachment) || null);

  const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;   // same workstream grammar index.js validates streamId against
  // Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
  // silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
  const ROLES = new Set(['user', 'assistant', 'tool', 'system']);
  const DEFAULT_LIMIT = 400;        // a sane cap so history() never returns an unbounded transcript
  const FINAL_CONTENT_MAX = 1048576; // matches the structured result validator; final writes reject oversize, never truncate
  const CONTENT_MAX = TurnKinds.LEGACY_FINAL_CONTENT_MAX; // unchanged byte limit, shared with the final-row verifier
  const RAM_ROWS_MAX = 3000;        // global ceiling across many short streams; disk keeps lifetime truth
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }

  /* ROW IDENTITY (turn-identity). A copy of a stored row is matched by (streamId, rowId): rowIds are global and unique
     by the durable io's contract, and a row of another stream is never the same row. '' = the row has no identity. */
  function rowKeyOf(row) {
    if (!row || typeof row !== 'object') return '';
    const sid = str(row.streamId), id = row.rowId;
    if (!sid || id == null || id === '' || !(Number(id) > 0)) return '';
    return 'r:' + sid + ':' + id;
  }

  /* ADDITIVE TURN FIELDS (turn-identity commit 1). Every field is optional and validated; an invalid value is dropped,
     never thrown, and a row given none of them is byte-identical to before (the keys are appended after taintKnown).
     Nothing in production passes them yet. */
  const TURN_FIELDS_ATTACH_MAX = 16;
  const TARGETS_MAX = 500;
  const NOTE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const IMPORT_KEY_RE = /^lg:[A-Za-z0-9_-]{1,40}:[0-9]{1,10}:[a-f0-9]{12}$/;
  const ATTACH_LIMITS = [['id', 64], ['name', 200], ['path', 300], ['mediaType', 100], ['kind', 20]];
  function isSafeNonNeg(v) { return Number.isSafeInteger(v) && v >= 0; }
  function attachmentRefs(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const a of list) {
      if (out.length >= TURN_FIELDS_ATTACH_MAX) break;
      if (!a || typeof a !== 'object' || typeof a.path !== 'string' || a.path.indexOf('.attachments/') !== 0) continue;
      const ref = {};
      for (const [k, max] of ATTACH_LIMITS) { const v = typeof a[k] === 'string' ? a[k].slice(0, max) : ''; if (v) ref[k] = v; }
      out.push(ref);   // a reference only: never the attachment's bytes
    }
    return out.length ? out : null;
  }
  // quotes + quotesAt as one aligned list: ids are stream ids (or the '*' marker); more than QUOTES_MAX distinct ids, or
  // the marker, is the saturated stamp ['*'] (never a silent truncation). A quotesAt that is not one non-negative safe
  // integer per given quote is dropped whole (every quote time then counts as 0).
  function quoteFields(quotes, quotesAt) {
    if (!Array.isArray(quotes) || !quotes.length) return null;
    const timed = Array.isArray(quotesAt) && quotesAt.length === quotes.length && quotesAt.every(isSafeNonNeg);
    const ids = [], at = new Map();
    let saturated = false, minAt = Infinity;
    quotes.forEach((q, i) => {
      if (typeof q !== 'string' || (q !== '*' && !SID_RE.test(q))) return;
      const t = timed ? quotesAt[i] : 0;
      if (t < minAt) minAt = t;
      if (q === '*') { saturated = true; return; }
      if (!at.has(q)) { at.set(q, t); ids.push(q); } else if (t < at.get(q)) at.set(q, t);
    });
    const max = TurnKinds ? TurnKinds.QUOTES_MAX : 32;
    if (saturated || ids.length > max) {
      failNote('turn.quotes.saturated', new Error((saturated ? 'saturated marker' : ids.length + ' quoted streams') + ' stored as the saturated stamp'));
      return timed ? { quotes: ['*'], quotesAt: [minAt] } : { quotes: ['*'] };
    }
    if (!ids.length) return null;
    return timed ? { quotes: ids, quotesAt: ids.map(id => at.get(id)) } : { quotes: ids };
  }

  /* ROW PROVENANCE — the one rule for reading a stored row's taint (review memory-learning-07; docs/DECISIONS.md).
     A row with `taint` was written by a run that had read untrusted content: that is its source. A row whose writer
     passed a taint value (null included) carries the clean stamp, taintKnown (buildEntry), and is clean. Any other row
     has no provenance — written before the clean stamp existed, or by a writer that passed no taint value — and its
     age proves nothing (an older build kept writing un-stamped tainted rows after the stamping release for anyone who
     upgraded late), so it is unverifiable, never clean. A browse preview reads the same way through
     { taint: previewTaint, taintKnown: previewTaintKnown }. */
  const UNVERIFIED_ROW = 'historical conversation (taint unverifiable: missing row provenance)';
  function rowTaint(row) {
    if (!row || typeof row !== 'object') return UNVERIFIED_ROW;
    if (row.taint) return str(row.taint).slice(0, 200);
    return row.taintKnown === true ? null : UNVERIFIED_ROW;
  }

  // an OpenAI-format message's content is either a plain string or a multimodal parts array. BYTE-FROZEN (UserText.STORED):
  // markRecorded and taintOf compare against rows this join already wrote
  function flattenContent(c) {
    return UserText.flatten(c, UserText.STORED);
  }

  /* H1.1 BOUNDARY MARKER — why this is not just an integer.

     appendTurns() takes a POSITIONAL `fromIndex`, which is only sound while the loop's messages array grows
     MONOTONICALLY. It does not: on compaction loop.js REBUILDS that array in place and SHORTER (older turns
     fold into a single summary note). A boundary captured before the loop then points PAST the new end, the
     append loop runs zero times, and the run's ENTIRE dialogue is dropped with no error and no log line.
     It fails worst exactly where the transcript matters most — long, resumed sessions, which are both the
     likeliest to compact and the ones whose history recall_conversation is meant to search.

     A per-message marker survives the fold, because compaction reuses the same message OBJECTS in the prefix
     and kept tail rather than cloning them. Symbol-keyed and non-enumerable, so it is invisible to
     JSON.stringify — it never reaches disk, and never rides out to a provider on the wire. */
  const PERSISTED = Symbol('skynet.transcript.persisted');

  // Mark messages as already-recorded. The host calls this on the prompt BEFORE the loop runs, so whatever the
  // loop appends afterwards is exactly that run's new dialogue. Returns how many were newly marked.
  function markPersisted(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) {
      if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
      try { Object.defineProperty(m, PERSISTED, { value: true, enumerable: false, configurable: true, writable: true }); n++; }
      catch (_) { /* frozen/sealed message: it just stays eligible — a duplicate row beats a lost transcript */ }
    }
    return n;
  }

  // Conversation display uses the finalized dispatch answer; run-specific reads keep raw execution evidence.
  // Durable row markers stay authoritative after the bounded run log expires. A final transcript projection
  // retains the complete answer, independently of the run envelope's 24k delivery-text cap.
  function conversationPreview(row) {
    if (!row) return '';
    if (row.dispatchState === 'final') return str(row.dispatchPrompt);
    return !row.dispatchState && row.role === 'user' ? str(row.content) : '';
  }
  function isFinalDeliveryRow(row, hash, expected) {
    return TurnKinds.isFinalDeliveryRow(row, hash, expected);
  }
  function projectConversation(turns, readRun, hash) {
    const rows = Array.isArray(turns) ? turns : [];
    const finals = new Map(), records = new Map(), prompts = new Set(), emitted = new Set();
    const record = id => { if (!records.has(id)) records.set(id, typeof readRun === 'function' ? readRun(id) : null); return records.get(id); };
    for (const row of rows) {
      const id = String(row.sourceRunId || '');
      if (row.dispatchState === 'final') { if (!finals.has(id)) finals.set(id, row); }
    }
    const out = [];
    const closedAfter = new Map();   // runId -> out index just past that run's last row (page-closed line goes there)
    for (const row of rows) {
      const id = String(row.sourceRunId || '');
      if (row.dispatchState === 'final') { if (isFinalDeliveryRow(row, hash, (record(id) || {}).dispatchDelivery) && !emitted.has(id)) { out.push(row); emitted.add(id); } continue; }
      const run = id ? record(id) : null, delivery = run && run.dispatchDelivery;
      const state = row.dispatchState || (delivery && delivery.state);
      if (!state) { out.push(row); if (pageClosedLine(run)) closedAfter.set(id, out.length); continue; } // pre-envelope history keeps its exact existing shape
      if (state === 'internal') continue;
      const final = finals.get(id);
      // A run StarNet stopped before it finished was never finalized and never will be. Show its directive and one
      // plain interrupted line, so the thread is not silently empty; its raw partial output stays hidden. A run whose
      // record still says pending may be mid-finalize, so it stays hidden until its accepted answer lands.
      // The line is the station's, re-sent on every read: transcriptPending tells the desk and phone merges
      // (chat.js mergeCanonicalHistory, remote/host.js mergeCanonical) to drop their saved copy and take this one,
      // so reopening the thread never stacks it, and it goes away once the station stops reporting it.
      if (!final && run && run.reason === 'interrupted' && !(delivery && (delivery.state === 'final' || delivery.state === 'pending'))) {
        if (row.role === 'user' && !prompts.has(id)) {
          out.push(row); prompts.add(id);
          out.push({ streamId: row.streamId, agentId: row.agentId, role: 'assistant', sys: true, error: true, transcriptPending: true, sourceRunId: id,
            dispatchState: 'interrupted', ts: row.ts, content: str(run.error) || (run.continuedRunId
              ? 'interrupted: StarNet stopped before this delegated run finished; it was continued as another run'
              : 'interrupted: StarNet stopped before this delegated run finished; no result was accepted') });
        }
        continue;
      }
      const finalPrompt = final ? final.dispatchPrompt : delivery && delivery.state === 'final' && run.deliveryPrompt;
      if (row.role === 'user' && finalPrompt && !prompts.has(id)) {
        const prompt = Object.assign({}, row, { content: finalPrompt });
        if (final && isFinalDeliveryRow(final, hash, (record(id) || {}).dispatchDelivery)) prompt.displayOf = 'final';
        else delete prompt.displayOf; // legacy display fallback does not prove an accepted recall/replay prompt
        out.push(prompt); prompts.add(id);
      }
    }
    // THE PAGE WENT AWAY MID-ASK (rc-walk #60): one station line after the run's last row, saying it ended there and
    // that nothing it waited on was approved. Same shape and rule as the interrupted line above (transcriptPending: the
    // merges take the station's copy on every read, so it never stacks). Inserted back to front so indexes stay true.
    const at = Array.from(closedAfter.entries()).sort((a, b) => b[1] - a[1]);
    for (const [id, idx] of at) {
      const run = record(id), last = out[idx - 1] || {};
      out.splice(idx, 0, { streamId: last.streamId, agentId: last.agentId, role: 'assistant', sys: true, error: true, transcriptPending: true, sourceRunId: id,
        dispatchState: 'page-closed', ts: num(run.pageClosed.at) || num(run.endedAt) || num(last.ts), content: pageClosedLine(run) });
    }
    return out;
  }
  // the line for a desk run cancelled because its page closed while approvals waited ('' = no line: nothing waited,
  // or the run was not cancelled). Words come from the run record only (runstore `pageClosed`), never from the page.
  function pageClosedLine(run) {
    const pc = run && run.reason === 'cancelled' && run.pageClosed;
    const waiting = pc && Array.isArray(pc.waitingOn) ? pc.waitingOn.map(str).filter(Boolean) : [];
    if (!waiting.length) return '';
    // "reconnected": the page's own teardown (App.disconnect → Chat.abort, then re-entry) drops the stream like a reload does
    return '■ the run ended when this page closed, reloaded or reconnected while it waited for ' + waiting.join(' and ') + ' — nothing was approved';
  }

  function makeTranscriptStore(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const redact = typeof opts.redact === 'function' ? opts.redact : (s) => s;
    const cap = num(opts.limit) || DEFAULT_LIMIT;
    // PER-STREAM RAM ceiling: history()/reconstruct() read at most `cap` (≤400) turns of ONE stream. Keep ~3x
    // headroom per stream so one chatty workstream can't evict another stream's turns below its own query
    // horizon (the fairness the plan calls for). Bound is PER streamId, not global, so N idle streams keep their
    // recent history while a firehose stream self-trims. Disk keeps the full append-only segmented history;
    // the host adapter loads only recent rows here and answers lifetime recall lazily from per-segment indexes.
    const ramPerStream = num(opts.ramPerStream) > 0 ? num(opts.ramPerStream) : Math.max(cap * 3, 1200);
    const ramMax = num(opts.ramMax) > 0 ? num(opts.ramMax) : RAM_ROWS_MAX;
    /* A DELETED SESSION IS NOT READ BACK (qa/bugs/3e926b6a). opts.deletedAt(streamId) -> ms (0 = never deleted) is the
       host's session tombstone ledger (session-tombstones.js). A row of a deleted session stamped at or before its
       delete is FORGOTTEN: every read that hands rows on (history, reconstruct, search, streams, around, all) answers
       as if it were not on disk, so resume, recall, cross-session reads and the evidence pack can never hand it to a
       model. The bytes stay in the append-only segments; a session re-opened under the same id hears only what is
       said after the delete. Writes and counts are untouched. taintOf is the one reader that still sees every row: it
       returns only a taint source, never a word of dialogue, and a copy of the history held elsewhere still carries
       whatever taint its rows had. */
    const deletedAt = typeof opts.deletedAt === 'function' ? opts.deletedAt : null;
    /* QUOTE PROVENANCE (turn identity commit 11). opts.latestDeleteAt() -> ms is the ledger's newest NON-ADOPTED delete (0 = none):
       the only thing the saturated stamp ['*'] reads. A row is also forgotten when it QUOTES a session deleted at or after the
       read that put the words in it (TurnKinds.quotesForgotten: the row's quotes + quotesAt against the ledger). That rule never
       reads row.ts, so a row drained after the delete (a held write, a text-only answer deferred to run end) is forgotten like
       one written before it. ONE predicate: every legacy reader below, TurnView's ctx.forgotten and isForgotten are this function. */
    const latestDeleteAt = typeof opts.latestDeleteAt === 'function' ? opts.latestDeleteAt : null;
    function quoteForgotten(r) {
      return !!deletedAt && !!r && Array.isArray(r.quotes) && r.quotes.length > 0 && TurnKinds.quotesForgotten(r, deletedAt, latestDeleteAt);
    }
    function forgotten(r) {
      if (!deletedAt || !r) return false;
      const at = num(deletedAt(r.streamId));
      if (at > 0 && num(r.ts) <= at) return true;
      return quoteForgotten(r);
    }
    function keep(list) { return deletedAt ? list.filter(r => !forgotten(r)) : list; }
    function viewContext() {
      return { forgotten, quoteForgotten, runOf: opts.runOf, hash: opts.hash, projectConversation,
        isCollided: rowId => typeof io.isCollided === 'function' && io.isCollided(rowId),
        isFinalDeliveryRow: row => isFinalDeliveryRow(row, opts.hash, ((typeof opts.runOf === 'function' && opts.runOf(row.sourceRunId)) || {}).dispatchDelivery),
        rowTaint, quotedMaterial: opts.quotedMaterial, live: typeof opts.live === 'function' ? opts.live() : opts.live,
        selfTalkRuns, note: failNote };
    }
    /* THE POSTED WINDOW'S FORGET FLOOR (commit 11). A page or phone that posts its own copy of the history cannot be trusted to
       have heard of a delete yet, so the host drops a posted row only on THIS store's proof: which of one stream's rowIds does
       the predicate above forget? Each is looked up in the RAM mirror, else read by id from disk (a proof read: forgotten rows
       included). Answers a Map(rowId -> true | false | null): true = the stored row is forgotten (tombstone or quote rule),
       false = it is not, null = the row cannot be read at all. Never returns a row's text. */
    function forgetVerdicts(streamId, rowIds) {
      const out = new Map(), want = new Set(), sid = str(streamId);
      for (const id of Array.isArray(rowIds) ? rowIds : []) if (Number.isSafeInteger(id) && id > 0) want.add(id);
      if (!want.size || !SID_RE.test(sid)) return out;
      const held = new Map();
      for (const r of rows) if (r.streamId === sid && want.has(r.rowId)) held.set(r.rowId, r);
      const missing = [...want].filter(id => !held.has(id));
      if (missing.length && typeof io.readByIds === 'function') {
        try {
          const found = io.readByIds(missing);
          if (found instanceof Map) for (const [id, row] of found) if (row && row.streamId === sid) held.set(Number(id), row);
        } catch (error) { failNote('transcript.forget-floor', error); }
      }
      for (const id of want) out.set(id, held.has(id) ? forgotten(held.get(id)) : null);
      return out;
    }
    function ownerProof(rowIds) {
      if (!TurnView || typeof io.readByIds !== 'function') return new Map();
      let found;
      try { found = io.readByIds(rowIds); }
      catch (error) { failNote('transcript.owner-proof', error); return new Map(); }
      if (!(found instanceof Map) || found.proofComplete !== true || !(found.retractions instanceof Map)) return new Map();
      const proven = TurnView.project('owner-evidence', [...found.values()], Object.assign(viewContext(), { retractions: found.retractions }), {});
      return new Map(proven.map(row => [row.rowId, row]));
    }
    /* THE STATION'S SELF-TALK IS NOT DIALOGUE (bug 4dee26ba). A reason-only internal call with no workstream (the quiet
       title, the goal judge, pitch, autopilot, …) is filed in 'global'. Its rows are stamped dispatchState 'internal'
       (runOnce), and the readers that hand rows to a model as conversation (search, around) skip them, so recall never
       quotes them as the Commander's words — and a deleted session's opening lines never live on there through the
       title prompt. Rows a station wrote before the stamp existed are recognised by the fixed shapes of those prompts,
       in 'global' only (the same words in a named session are the Commander's). Nothing is deleted. */
    function legacyPrompt(r) {
      return TurnKinds.legacyPrompt(r);
    }
    /* A pre-stamp self-talk REPLY (the title itself, the goal judge's verdict restating the goal) has no shape of its
       own: it is known by its run, the sourceRunId of a recognised prompt. Learned from every row this store loads,
       appends or reads back, and once from disk (learnFromDisk) before the first search or scroll that can reach
       'global' rows RAM never held. */
    const selfTalkRuns = new Set();
    function learn(r) { if (r && r.sourceRunId && legacyPrompt(r)) selfTalkRuns.add(str(r.sourceRunId)); }
    let learnedFromDisk = false;
    function learnFromDisk() {
      if (learnedFromDisk || typeof io.search !== 'function') return;
      learnedFromDisk = true;
      // the segment index offers every 'global' row holding one of the prompts' fixed words to `exclude` before it
      // ranks it: exclude learns it and declines it, so nothing is ranked or returned
      try { io.search('global', 'context internal satisfied', { limit: 1, scope: 'stream', exclude: r => { learn(r); return true; } }); }
      catch (e) { failNote('transcript.io', e); }
    }
    function selfTalk(r) {
      if (!r) return false;
      if (r.dispatchState === 'internal') return true;
      if (r.streamId === 'global' && r.sourceRunId && selfTalkRuns.has(str(r.sourceRunId))) return true;
      return legacyPrompt(r);
    }
    function hidden(r) { return forgotten(r) || selfTalk(r); }

    // in-memory mirror loaded once; append keeps RAM + disk in lockstep so history() is O(n) over RAM.
    let rows = [];
    // Streams whose RAM rows can differ from their durable rows: RAM dropped some of them (trimmed), or an append to
    // them failed in this process (a fail-open write keeps its row in RAM only; a failed rollback can leave one on
    // disk only). history() answers those from disk, as it always did.
    const ramGaps = new Set();
    try {
      const raw = typeof io.readRecent === 'function' ? io.readRecent({ perStream: ramPerStream, globalLimit: ramMax }) : io.readAll();
      if (Array.isArray(raw)) rows = raw.filter(r => r && typeof r === 'object');
    }
    catch (e) { rows = []; }
    // trim the boot load per-stream too, so a huge bounded-boot load of one stream can't start us over the cap.
    for (const r of rows) learn(r);   // before the trims: a prompt the boot load held still names its run's reply
    trimStreamRam();   // no arg => sweep every over-cap stream once
    trimGlobalRam();

    function trimGlobalRam() {
      if (rows.length <= ramMax) return;
      for (const r of rows.splice(0, rows.length - ramMax)) ramGaps.add(r.streamId);
    }

    // drop the OLDEST rows of `streamId` when that stream exceeds ramPerStream. Splices only that stream's rows,
    // so other streams are untouched (per-stream fairness). Called after each append for the appended stream; the
    // boot-time call (streamId undefined) sweeps every over-cap stream once.
    function trimStreamRam(streamId) {
      const streams = streamId == null ? Array.from(new Set(rows.map(r => r.streamId))) : [streamId];
      for (const sid of streams) {
        const idxs = [];
        for (let i = 0; i < rows.length; i++) if (rows[i].streamId === sid) idxs.push(i);
        const over = idxs.length - ramPerStream;
        if (over <= 0) continue;
        ramGaps.add(sid);
        const drop = new Set(idxs.slice(0, over));   // the oldest `over` rows of this stream
        rows = rows.filter((_, i) => !drop.has(i));
      }
    }

    // a bad/missing streamId collapses to 'global' — exactly index.js's rule (bad streamId -> the global stream).
    function normStream(v) { const s = str(v); return SID_RE.test(s) ? s : 'global'; }
    function tokenize(s) {
      const normalized = str(s).normalize('NFKC').toLowerCase();
      const cjk = /^(?:\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul})$/u;
      const out = [];
      for (const word of (normalized.match(/[\p{L}\p{N}]+/gu) || [])) {
        let run = '';
        for (const char of word) {
          if (!cjk.test(char)) { run += char; continue; }
          if (run) { out.push(run); run = ''; }
          out.push(char);
        }
        if (run) out.push(run);
      }
      return out;
    }

    // H1.3: keyword recall over the transcript — the substrate for the agent-callable recall_conversation tool,
    // so it can find weeks-old dialogue no longer in context. Lightweight BM25-ish: rank a row by how many
    // DISTINCT query terms it contains (primary), then total term frequency, then recency. Dependency-free + pure.
    //
    // SCOPE (parity with the reference harness, whose session search spans every session, not just the open one):
    // o.scope === 'all' searches EVERY workstream; anything else keeps the historical single-stream behaviour, so
    // the existing call shape search(streamId, q, {limit}) is byte-for-byte unchanged. Every hit now carries its
    // OWN streamId — without it a cross-stream result is unattributable, and the agent would quote another
    // workstream's decision as if it belonged to this one.
    function search(streamId, query, o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? Math.min(num(o.limit), 50) : 10;
      const terms = Array.from(new Set(tokenize(query)));
      if (!terms.length) return [];
      const all = o.scope === 'all';
      const want = normStream(streamId);
      if (typeof io.search === 'function') {
        // the segment index ranks among the rows it may return (exclude), so a deleted session or self-talk never takes a slot
        if (all || want === 'global') learnFromDisk();
        try { return (io.search(want, query, { limit: limit, scope: all ? 'all' : 'stream', exclude: hidden }) || []).filter(r => !hidden(r)); } catch (e) { failNote('transcript.io', e); }
      }
      const scored = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!all && r.streamId !== want) continue;
        if (hidden(r)) continue;
        // a null-prototype map: `{}`['constructor'] is Object, so that query word "matched" every row with a string score
        const tf = Object.create(null); for (const t of tokenize(r.content)) tf[t] = (tf[t] || 0) + 1;
        let distinct = 0, freq = 0;
        for (const t of terms) { if (tf[t]) { distinct++; freq += tf[t]; } }
        if (distinct) scored.push(Object.assign({}, r, { idx: i, score: distinct * 1000 + freq, taint: r.taint || '', taintKnown: r.taintKnown === true || !!r.taint }));
      }
      scored.sort((a, b) => (b.score - a.score) || (b.ts - a.ts) || (b.idx - a.idx));
      return scored.slice(0, limit).map(x => { const row = Object.assign({}, x); delete row.idx; return row; });
    }

    // BROWSE (reference-harness parity: "list recent sessions"): every workstream present in the transcript, with its
    // turn count, last-activity stamp, and the most recent USER line as a preview — so an agent that does not know
    // WHICH workstream holds an answer can look before it searches. Newest-active first; deterministic tiebreak by
    // id so two streams stamped in the same millisecond never reorder between calls.
    function streams(o) {
      o = o || {};
      const limit = num(o.limit) > 0 ? Math.min(num(o.limit), 100) : 20;
      const previewMax = num(o.previewChars) > 0 ? num(o.previewChars) : 160;
      if (typeof io.streams === 'function') {
        // the segment summaries count and preview every row: a deleted session drops out, and one re-opened after its
        // delete is listed from the rows said since (history() already forgets the rest)
        try { return globalPreview(deletedAt ? liveStreams(io.streams({ limit: 100, previewChars: previewMax }) || [], previewMax).slice(0, limit) : (io.streams({ limit: limit, previewChars: previewMax }) || []), previewMax); } catch (e) { failNote('transcript.io', e); }
      }
      const by = new Map();
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (forgotten(r)) continue;
        let e = by.get(r.streamId);
        if (!e) { e = { streamId: r.streamId, turns: 0, lastAt: 0, preview: '' }; by.set(r.streamId, e); }
        e.turns++;
        if (r.ts >= e.lastAt) e.lastAt = r.ts;
        const preview = selfTalk(r) ? '' : conversationPreview(r);
        if (preview) {
          e.preview = preview.replace(/\s+/g, ' ').trim().slice(0, previewMax);
          e.previewTaint = r.taint || ''; e.previewTaintKnown = r.taintKnown === true || !!r.taint;
        }
      }
      const out = Array.from(by.values());
      out.sort((a, b) => (b.lastAt - a.lastAt) || (a.streamId < b.streamId ? -1 : a.streamId > b.streamId ? 1 : 0));
      return out.slice(0, limit);
    }
    /* 'global' is where the station's self-talk is filed, so its listing preview is never the segment summary's: that
       keeps the latest user row cut to 160 characters, and a pre-stamp title prompt or goal judge whose opening is a long
       first message loses the very marker that names it as self-talk — the listing then quoted that session's opening
       line, even a deleted session's. The preview is re-read from the stream's own newest rows (deletes honoured), the
       newest that is not self-talk; none among them lists with no preview. */
    const GLOBAL_PREVIEW_SCAN = 200;
    function globalPreview(list, previewMax) {
      return list.map(s => {
        if (!s || s.streamId !== 'global') return s;
        const e = Object.assign({}, s, { preview: '', previewTaint: '', previewTaintKnown: false });
        const recent = history('global', { limit: GLOBAL_PREVIEW_SCAN });
        for (let i = recent.length - 1; i >= 0; i--) {
          const r = recent[i];
          const preview = selfTalk(r) ? '' : conversationPreview(r);
          if (!preview) continue;
          // the segment summary's own bound (160), so a listing reads the same as before for every ordinary row
          e.preview = preview.replace(/\s+/g, ' ').trim().slice(0, Math.min(160, previewMax));
          e.previewTaint = r.taint || ''; e.previewTaintKnown = r.taintKnown === true || !!r.taint;
          break;
        }
        return e;
      });
    }
    function liveStreams(list, previewMax) {
      const out = [];
      for (const s of list) {
        const at = s && num(deletedAt(s.streamId));
        if (!s || !(at > 0)) { if (s) out.push(s); continue; }
        if (num(s.lastAt) <= at) continue;   // nothing said since the delete
        const kept = history(s.streamId, { limit: cap });
        if (!kept.length) continue;
        const e = { streamId: s.streamId, turns: kept.length, lastAt: 0, preview: '' };
        for (const r of kept) {
          if (num(r.ts) >= e.lastAt) e.lastAt = num(r.ts);
          const preview = conversationPreview(r);
          if (preview) { e.preview = preview.replace(/\s+/g, ' ').trim().slice(0, previewMax); e.previewTaint = r.taint || ''; e.previewTaintKnown = r.taintKnown === true || !!r.taint; }
        }
        out.push(e);
      }
      return out;
    }

    // SCROLL (reference-harness parity: anchored drill-down): the window of turns around a point in ONE stream, so a
    // search hit can be READ IN CONTEXT instead of as an isolated line. Anchored on a TIMESTAMP rather than a row
    // index or a synthetic id — ts is the only anchor that stays valid after trimStreamRam() splices older rows out
    // from under us, which is exactly when a drill-down is most likely to be attempted.
    function around(streamId, ts, o) {
      o = o || {};
      const win = num(o.window) > 0 ? Math.min(num(o.window), 50) : 6;
      const want = normStream(streamId);
      const at = num(ts);
      if (typeof io.around === 'function') {
        if (want === 'global') learnFromDisk();
        try { const got = io.around(want, ts, { window: win, rowId: o.rowId }) || []; got.forEach(learn); return got.filter(r => !hidden(r)); } catch (e) { failNote('transcript.io', e); }
      }
      const mine = [];
      for (let i = 0; i < rows.length; i++) { if (rows[i].streamId === want && !hidden(rows[i])) mine.push(rows[i]); }
      if (!mine.length) return [];
      // the row closest to the anchor (mine is append-ordered, so ties resolve to the earliest match — stable).
      let anchor = 0, best = Infinity;
      for (let i = 0; i < mine.length; i++) {
        const d = Math.abs(num(mine[i].ts) - at);
        if (d < best) { best = d; anchor = i; }
      }
      const from = Math.max(0, anchor - win);
      const to = Math.min(mine.length, anchor + win + 1);
      return mine.slice(from, to).map(r => Object.assign({}, r));
    }

    function buildEntry(e) {
      e = e || {};
      const final = e.dispatchState === 'final';
      let content = final ? str(e.content) : str(e.content).slice(0, CONTENT_MAX);
      try { content = str(redact(content)); } catch (error) { if (final) throw error; failNote('transcript.redact', error); }
      if (final && content.length > FINAL_CONTENT_MAX) throw new Error('Final dispatch transcript exceeds the 1 MiB persistence limit');
      if (!final) content = content.slice(0, CONTENT_MAX);
      const entry = {
        streamId: normStream(e.streamId),
        agentId: str(e.agentId),
        role: ROLES.has(e.role) ? e.role : 'user',     // clamp to the known enum
        content: content,
        ts: typeof e.importKey === 'string' && IMPORT_KEY_RE.test(e.importKey) && isSafeNonNeg(e.ts) ? e.ts : num(e.ts) || clock.now()
      };
      if (e.role === 'user' && typeof e.steeringWire === 'string') entry.steeringWire = str(redact(e.steeringWire)).slice(0, 700000);
      // H1.1: optional structured fields so a RESUME can rebuild the EXACT OpenAI-format turn — an assistant's
      // tool_calls and a tool result's tool_call_id. Redacted like content; absent fields => byte-identical to before.
      if (e.toolCalls != null) {
        let tc = '';
        try { tc = str(redact(typeof e.toolCalls === 'string' ? e.toolCalls : JSON.stringify(e.toolCalls))).slice(0, CONTENT_MAX); } catch (e) { failNote('transcript.redact', e); }
        if (tc) entry.toolCalls = tc;
      }
      if (e.toolCallId != null) { const id = str(e.toolCallId).slice(0, 200); if (id) entry.toolCallId = id; }
      // Recovery provenance is deliberately an opaque run id, never tool arguments. It lets boot reconciliation
      // prove that a journal's final rows already reached durable transcript storage before retiring the journal.
      if (e.sourceRunId != null) { const id = str(e.sourceRunId).slice(0, 200); if (id) entry.sourceRunId = id; }
      if (['pending', 'internal', 'final'].includes(e.dispatchState)) entry.dispatchState = e.dispatchState;
      if (e.dispatchState === 'final') {
        entry.dispatchPrompt = str(redact(str(e.dispatchPrompt))).slice(0, 4000);
        entry.dispatchReason = str(e.dispatchReason).slice(0, 80);
        entry.dispatchRepairRunId = str(e.dispatchRepairRunId).slice(0, 100);
        if (Number.isSafeInteger(e.textLength) && /^[a-f0-9]{64}$/.test(str(e.textSha256))) {
          entry.textLength = e.textLength; entry.textSha256 = e.textSha256;
        }
      }
      // WHO wrote a user-role row that the Commander did not type: the agent that delegated this run (display only —
      // the row stays a user turn for the model). Absent on every Commander turn.
      if (e.from != null) { const f = str(e.from).slice(0, 80); if (f) entry.from = f; }
      // UNTRUSTED-CONTENT TAINT (additive, sec-taint 09-25): the writing run's taint source at the moment this row
      // was written. A later run that REPLAYS this row replays untrusted content, so it must start tainted (taintOf).
      if (e.taint) { const t = str(e.taint).slice(0, 200); if (t) entry.taint = t; }
      // Distinguish the host explicitly checking a clean row from legacy/missing provenance.
      // Never infer clean merely because old storage omitted its taint field.
      if (Object.prototype.hasOwnProperty.call(e, 'taint')) entry.taintKnown = true;
      if (TurnKinds) turnFields(entry, e);
      return entry;
    }
    // the additive turn fields (ADDITIVE TURN FIELDS above), appended in this order after every existing key
    function turnFields(entry, e) {
      if (TurnKinds.isTurnId(e.turnId)) entry.turnId = e.turnId;
      if (TurnKinds.isKind(e.kind)) {
        entry.kind = e.kind;
        // a kind an older reader would misread is stored as a system row, whatever role the writer passed (M2)
        if (TurnKinds.SYSTEM_KINDS.indexOf(e.kind) >= 0) entry.role = 'system';
      }
      if (e.directive === true && entry.role === 'user' && entry.turnId) entry.directive = true;
      if (e.typed != null) {
        // the pre-expansion words of a directive: redacted like content, kept only when they differ from it
        let typed = str(e.typed).slice(0, CONTENT_MAX), ok = true;
        try { typed = str(redact(typed)).slice(0, CONTENT_MAX); }
        catch (error) { ok = false; failNote('transcript.redact', error); }   // never stored unredacted
        if (ok && typed && typed !== entry.content) entry.typed = typed;
      }
      const attachments = attachmentRefs(e.attachments);
      if (attachments) entry.attachments = attachments;
      if (e.kind === 'attachment' && TurnAttachment) { const attached = TurnAttachment.fieldOf(e.attachment, s => str(redact(s))); if (attached) entry.attachment = attached; }   // the record of ONE file (turn-attachment.js): validated, its name redacted
      if (typeof e.line === 'string') { const line = e.line.slice(0, 120); if (line) entry.line = line; }
      const quoted = quoteFields(e.quotes, e.quotesAt);
      if (quoted) { entry.quotes = quoted.quotes; if (quoted.quotesAt) entry.quotesAt = quoted.quotesAt; }
      if (Array.isArray(e.targets)) {
        const targets = Array.from(new Set(e.targets.filter(t => Number.isSafeInteger(t) && t > 0))).slice(0, TARGETS_MAX);
        if (targets.length) entry.targets = targets;
      }
      if (e.kind === 'retract' && (e.reason === 'retry' || e.reason === 'undo')) entry.reason = e.reason;
      if (typeof e.noteId === 'string' && NOTE_ID_RE.test(e.noteId)) entry.noteId = e.noteId;
      if (typeof e.carriedBy === 'string') { const by = e.carriedBy.slice(0, 200); if (by) entry.carriedBy = by; }
      if (typeof e.importKey === 'string' && IMPORT_KEY_RE.test(e.importKey)) entry.importKey = e.importKey;
      /* A FILE ROW'S ADDRESS (commit 10): kind 'deliverable' only; any other kind drops the field. TurnKinds.deliverableFields is the one
         grammar (exact relative path, enum media, agent workspace, bounded root, event-style artifactId) and an invalid value is dropped
         whole, never repaired or shortened. Only the display name is redacted; the path is an address and stays exactly as written. */
      if (e.kind === 'deliverable') {
        const d = TurnKinds.deliverableFields(e.deliverable);
        if (d) {
          try { d.name = str(redact(d.name)).slice(0, 200); }
          catch (error) { d.name = ''; failNote('transcript.redact', error); }   // never stored unredacted
          entry.deliverable = d;
        }
      }
    }

    function persistEntry(entry, strict) {
      let stored = entry;
      try {
        const writer = strict && typeof io.appendDurable === 'function' ? io.appendDurable : io.append;
        const persisted = writer.call(io, entry);
        if (persisted && typeof persisted === 'object') stored = persisted;
      } catch (e) {
        ramGaps.add(entry.streamId);
        if (strict) throw e;
        /* ordinary transcript writes remain fail-open; recovery-owned finalization uses appendStrict below */
      }
      rows.push(stored);
      learn(stored);
      trimStreamRam(stored.streamId);   // bound THIS stream's RAM only (per-stream fairness; disk keeps full log)
      trimGlobalRam();                  // and bound the aggregate across thousands of short streams
      return stored;
    }

    function append(e) { return persistEntry(buildEntry(e), false); }
    function appendStrict(e) { return persistEntry(buildEntry(e), true); }

    // H1.1: append a SLICE of an OpenAI-format messages array (a run's new turns) as full transcript rows —
    // user / assistant (with tool_calls) / tool (with tool_call_id). Skips injected 'system' fences (recall,
    // loop-guard, compaction) so the transcript stays the real dialogue. Returns the count appended. PURE +
    // testable: the host passes result.messages + the pre-loop boundary index.
    function appendTurns(streamId, agentId, messages, fromIndex) {
      if (!Array.isArray(messages)) return 0;
      let n = 0;
      for (let i = Math.max(0, num(fromIndex)); i < messages.length; i++) {
        const m = messages[i];
        if (!m || !ROLES.has(m.role) || m.role === 'system') continue;
        append({ streamId: streamId, agentId: agentId, role: m.role, content: flattenContent(m.content), steeringWire: m.steeringWire, toolCalls: m.tool_calls, toolCallId: m.tool_call_id });
        n++;
      }
      return n;
    }

    // H1.1, compaction-safe: append every message NOT yet carrying the persisted marker, marking as it goes.
    // This is the boundary appendTurns' positional `fromIndex` could not express — see PERSISTED above. Same row
    // shape and same skip rule (injected 'system' fences are not dialogue), so the durable file is unchanged;
    // only WHICH messages are considered new differs. Idempotent: appending the same array twice writes once,
    // which also makes it safe to drain mid-run (at a compaction) and again at run end.
    /* TURN STAMPS ON A DRAIN (turn-identity). opts.turnId / line / quotes / quotesAt ride every row written;
       opts.kindOf(m) gives each row its kind. Only with kindOf, a system message tagged with a SYSTEM kind
       (TurnKinds.tag: a folded steer note, …) is a row of its own, stored as role 'system' with that kind and noteId;
       every other system message stays a skipped fence, exactly as without kindOf. Returns null for a skipped one.
       A mid-task user message folded into the model's context (loop.js foldSteerNotes) is a user-role message tagged
       'steer': it is filed as that steer row too (role system, its noteId), keeping its steeringWire for the display. */
    function systemRowTag(m, opts) {
      if (!opts || typeof opts.kindOf !== 'function' || !TurnKinds || (m.role !== 'system' && m.role !== 'user')) return null;
      const t = TurnKinds.tagOf(m);
      if (!t || TurnKinds.SYSTEM_KINDS.indexOf(t.kind) < 0) return null;
      return m.role === 'user' && t.kind !== 'steer' ? null : t;
    }
    /* A STEER ROW HOLDS THE NOTE, NOT THE LOOP'S WRAPPER. The loop hands the model a folded note as '<steering_note>…</steering_note>'
       (loop.js foldSteerNotes) and tags that message steer; its row is the Commander's words alone, so a replay says
       '[steering] <words>' once and the page's echo of the note (the same words) binds to it. Any other content is kept as it is. */
    const STEER_WIRE = /^<steering_note>([\s\S]*)<\/steering_note>$/;
    function rowContent(m, sysTag) {
      const text = flattenContent(m.content);
      if (!sysTag || sysTag.kind !== 'steer') return text;
      const wrapped = STEER_WIRE.exec(text);
      return wrapped ? wrapped[1] : text;
    }
    function turnStamps(m, opts, sysTag) {
      if (!opts) return {};
      const out = {};
      if (opts.turnId !== undefined) out.turnId = opts.turnId;
      if (opts.line !== undefined) out.line = opts.line;
      if (opts.quotes !== undefined) { out.quotes = opts.quotes; out.quotesAt = opts.quotesAt; }
      if (typeof opts.kindOf === 'function') {
        const t = sysTag || (TurnKinds ? TurnKinds.tagOf(m) : null);
        out.kind = sysTag ? sysTag.kind : opts.kindOf(m);
        if (t && t.noteId != null) out.noteId = t.noteId;
      }
      return out;
    }

    function appendNew(streamId, agentId, messages, opts) {
      if (!Array.isArray(messages)) return 0;
      const taint = opts && opts.taint ? opts.taint : null;
      let n = 0;
      for (const m of messages) {
        if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
        markPersisted([m]);                                    // mark BEFORE the role filter so fences aren't re-checked
        const sysTag = systemRowTag(m, opts);
        if (!ROLES.has(m.role) || (m.role === 'system' && !sysTag)) continue;
        append(Object.assign({ streamId: streamId, agentId: agentId, role: m.role, content: rowContent(m, sysTag), steeringWire: m.steeringWire, toolCalls: m.tool_calls, toolCallId: m.tool_call_id, taint: taint, sourceRunId: opts && opts.sourceRunId, dispatchState: opts && opts.dispatchState }, turnStamps(m, opts, sysTag)));
        n++;
      }
      return n;
    }

    // Recovery-owned drain: every visible row must be fsync'd/read-back proven before its message receives the
    // PERSISTED marker. A failure throws and leaves the remaining messages eligible; the run journal stays the
    // source of truth instead of being marked committed optimistically.
    function appendNewStrict(streamId, agentId, messages, opts) {
      if (!Array.isArray(messages)) return 0;
      opts = opts || {};
      let n = 0;
      for (const m of messages) {
        if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
        const sysTag = systemRowTag(m, opts);
        if (!ROLES.has(m.role) || (m.role === 'system' && !sysTag)) { markPersisted([m]); continue; }
        appendStrict(Object.assign({ streamId: streamId, agentId: agentId, role: m.role, content: rowContent(m, sysTag), steeringWire: m.steeringWire, toolCalls: m.tool_calls, toolCallId: m.tool_call_id, sourceRunId: opts.sourceRunId, dispatchState: opts.dispatchState, taint: opts.taint || null }, turnStamps(m, opts, sysTag)));
        markPersisted([m]);
        n++;
      }
      return n;
    }

    /* H2 RECOVERY RECONCILIATION — which recovered turns does the transcript ALREADY hold?
       A recovery continuation starts from the run journal's provider-valid checkpoint of an interrupted run. The
       interrupted run wrote its turns to this transcript as it went (per-turn persistence), but not necessarily
       ALL of them: a hard kill can land between the journal checkpoint and the transcript write, a parallel tool
       batch's results can be journaled but not yet checkpointed, and the recovery planner adds its own pairing
       results for calls that never returned. Marking the whole recovered prompt persisted (the old rule) dropped
       those rows forever; appending it all again would duplicate everything the source run did write.
       markRecorded() marks exactly the recovered messages that `rows` (the source run's own transcript rows)
       already prove durable, by IDENTITY rather than position — the source may have compacted, so the recovered
       working set is not a positional copy of what it wrote: a tool result by its tool_call_id, an assistant
       tool-call turn by its call ids, any other turn by role + stored (redacted, capped) content. Multiset:
       each recorded row vouches for ONE message. Everything left unmarked is genuinely missing and is appended
       by the next appendNewStrict — in order, strictly. System fences are marked (they are never dialogue). */
    function callIdsKey(ids) { return ids.map(id => str(id).slice(0, 200)).join('\u0001'); }
    function rowIdentity(r) {
      if (!r || typeof r !== 'object') return '';
      if (r.role === 'tool') return 'tool\u0000' + str(r.toolCallId);
      if (r.role === 'assistant' && r.toolCalls) {
        let ids = null;
        try { const tc = JSON.parse(r.toolCalls); if (Array.isArray(tc) && tc.length) ids = tc.map(c => c && c.id); }
        catch (e) { failNote('transcript.rowIdentity', e); }   // a capped/unparsable call list falls back to content
        if (ids) return 'calls\u0000' + callIdsKey(ids);
      }
      return str(r.role) + '\u0000' + str(r.content);
    }
    function messageIdentity(m) {
      if (m.role === 'tool') return 'tool\u0000' + str(m.tool_call_id).slice(0, 200);
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return 'calls\u0000' + callIdsKey(m.tool_calls.map(c => c && c.id));
      // a user message tagged 'steer' is stored as a system row (turnFields), so it is vouched for as one
      const tag = m.role === 'user' && TurnKinds ? TurnKinds.tagOf(m) : null;
      return (tag && tag.kind === 'steer' ? 'system' : str(m.role)) + '\u0000' + buildEntry({ content: flattenContent(m.content) }).content;
    }
    function markRecorded(messages, recordedRows) {
      if (!Array.isArray(messages)) return 0;
      const vouch = new Map();
      for (const r of (Array.isArray(recordedRows) ? recordedRows : [])) {
        const k = rowIdentity(r);
        if (k) vouch.set(k, (vouch.get(k) || 0) + 1);
      }
      let n = 0;
      for (const m of messages) {
        if (!m || typeof m !== 'object' || m[PERSISTED]) continue;
        if (!ROLES.has(m.role) || m.role === 'system') { markPersisted([m]); continue; }
        const k = messageIdentity(m);
        const left = vouch.get(k) || 0;
        if (!left) continue;
        vouch.set(k, left - 1);
        markPersisted([m]);
        n++;
      }
      return n;
    }

    /* REPLAYED TAINT (sec-taint 09-25). Does replaying `messages` (a run's prior context on `streamId`) bring back
       rows a TAINTED run wrote? Two independent proofs, either suffices:
         1. IDENTITY — a replayed message matches a stored tainted row (same identity markRecorded uses: tool result
            by call id, tool-call turn by call ids, anything else by role + redacted content).
         2. WINDOW — a caller-held history (the browser's own copy) may not be byte-identical to the stored rows, so
            the stream's newest rows covering as many user/assistant turns as were replayed are checked too.
       Decay is structural, never silent: once tainted rows fall outside what is replayed (a new session, a history
       window that no longer reaches them) the next run starts clean, because the untrusted text is no longer in its
       context. Returns the first taint source found, else null.
       Only an explicit `taint` counts here: a replayed row with no provenance (rowTaint's unverifiable case — all
       history from before the clean stamp) does not taint the run, or every older conversation would start tainted
       after an update. recall_conversation does treat it as unverifiable; docs/DECISIONS.md records the split.
       ATTACHMENT DECAY (taint-replay.js): a row stamped with EXACTLY the bare attachment source (taint.js ATTACHMENT_TAINT)
       was written while the run held an attachment's bytes, and those bytes are accounted for by the run that re-sends
       them, so the stamp alone taints nothing. Any other stamp counts, including one a run wrote after it ALSO read a page
       (index.js rowTaint keeps the first non-attachment source). The one exception is the identity proof for a row that
       STORES the expansion itself (taint.js rowStoresAttachmentText: a user row whose content holds the file text, in the
       11-02 shape with references and typed words, or the 0.14.2 shape with the "[Attached file: " header and neither
       field): replaying that very row replays the file text. */
    function taintOf(streamId, messages, o) {
      o = o || {};
      const prior = (Array.isArray(messages) ? messages : []).filter(m => m && typeof m === 'object' && ROLES.has(m.role) && m.role !== 'system');
      if (!prior.length) return null;
      // every row, deleted or not: forgetting a session never clears the taint of text that is replayed from it
      const rowsNow = readHistory(streamId, { limit: num(o.limit) > 0 ? num(o.limit) : 1200 }, false);
      if (!rowsNow.some(r => r && r.taint)) return null;          // the common case: this stream never carried taint
      const bare = (r) => !!ATTACHMENT_TAINT && r.taint === ATTACHMENT_TAINT;
      const tainted = new Map();
      for (const r of rowsNow) if (r && r.taint && (!bare(r) || storesExpansion(r))) { const k = rowIdentity(r); if (k && !tainted.has(k)) tainted.set(k, str(r.taint)); }
      for (const m of prior) { const hit = tainted.get(messageIdentity(m)); if (hit) return hit; }
      let turns = prior.filter(m => m.role === 'user' || m.role === 'assistant').length;
      for (let i = rowsNow.length - 1; i >= 0 && turns > 0; i--) {
        const r = rowsNow[i];
        if (r && r.taint && !bare(r)) return str(r.taint);
        if (r && (r.role === 'user' || r.role === 'assistant')) turns--;
      }
      return null;
    }

    /* RAM ANSWERS WHEN IT HOLDS THE WHOLE STREAM (perf review 2026-10-19, #5). Every row RAM holds is a durable row
       (read back at boot, or the proven copy an append returned), in the same order. So when the count RAM holds for
       a stream equals the count the durable summaries record for it (io.streamRows), RAM holds every one of them and
       the segment scan would return exactly these rows. A stream RAM has trimmed, or whose append failed this process,
       is never answered here; neither is a host that cannot count (no streamRows, or -1). null = ask the disk. */
    function ramHistory(want, limit, sourceRunId, dispatchState) {
      if (ramGaps.has(want) || typeof io.streamRows !== 'function') return null;
      let held = 0;
      const out = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        if (r.streamId !== want) continue;
        held++;
        if (out.length < limit && (!sourceRunId || r.sourceRunId === sourceRunId) && (!dispatchState || r.dispatchState === dispatchState)) out.push(Object.assign({}, r));
      }
      let durable;
      try { durable = io.streamRows(want); } catch (e) { failNote('transcript.io', e); return null; }
      if (typeof durable !== 'number' || durable < 0 || durable !== held) return null;
      return out.reverse();
    }

    // the recent dialogue for ONE workstream, oldest-first (ready to replay back into COMMS). We keep the LAST
    // `limit` turns of that stream (the most recent), then return them in chronological order.
    /* A PROOF READ (o.proof === true) sees a deleted session's rows. It answers only "is this row already durable?" —
       a dispatch delivery's accepted answer (dispatch-delivery.js), a recovery continuation's source rows (index.js
       transcriptRecoveryTail → markRecorded) — and never hands a row to a model or the page. Forgetting them there made
       boot never settle a deleted session's pending delivery, let a second accepted answer be appended after the delete
       stamp, and made a continuation re-append every source turn: the deleted words came back, duplicated. */
    function history(streamId, o) { return readHistory(streamId, o, !(o && o.proof === true)); }
    // honorDeletes=false is taintOf's read and a proof read: neither hands a row on
    function readHistory(streamId, o, honorDeletes) {
      o = o || {};
      const kept = honorDeletes ? keep : (list => list);
      const gone = honorDeletes ? forgotten : (() => false);
      const limit = num(o.limit) > 0 ? num(o.limit) : cap;
      const want = normStream(streamId);
      const sourceRunId = String(o.sourceRunId || '');
      // Segmented hosts retain lifetime rows outside the bounded RAM working set. Ask the
      // durable index/segments first so an old, idle conversation still resumes exactly —
      // unless RAM provably holds every durable row of this stream (ramHistory), which is the
      // same answer without reading and parsing segments 2-4 times per run. A strict read
      // always proves the bytes on disk.
      if (typeof io.history === 'function') {
        // a deleted session's rows are all older than anything said after its delete, so the newest `limit` rows
        // minus the forgotten ones are exactly the newest `limit` rows that remain
        const held = o.strict ? null : ramHistory(want, limit, sourceRunId, o.dispatchState);
        if (held) return kept(held);
        try {
          const found = io.history(want, { limit, sourceRunId, dispatchState: o.dispatchState, strict: o.strict, since: num(o.since) });
          if (Array.isArray(found)) return kept(found).map(r => Object.assign({}, r));
        } catch (e) { if (o.strict) throw e; failNote('transcript.io', e); }
      }
      const out = [];
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
        if (rows[i].streamId === want && (!sourceRunId || rows[i].sourceRunId === sourceRunId) && (!o.dispatchState || rows[i].dispatchState === o.dispatchState) && !gone(rows[i])) out.push(Object.assign({}, rows[i]));
      }
      out.reverse();   // newest-first scan -> chronological for replay
      return out;
    }

    /* FIND A TURN BY ITS turnId (turn-identity, A2-ID-04): { state: 'found', directive, rows } | { state: 'absent' } |
       { state: 'unknown' }. The directive is ONLY the `directive: true` row of that turnId (a capture or repair row is
       user-role and carries the turnId too, and is never taken for it). Rungs 1-3 only ever PROVE 'found': a read that
       misses something (a RAM fallback, a skipped segment) just falls through. 'absent' comes only from rung 4, a read
       that provably covers every row of the stream written since `since` — never from readHistory, whose RAM fallback
       and non-strict segment reads can silently return fewer rows, and never from io.history's `since`, which only
       skips segments. Whether the caller minted the turnId itself is the caller's question (TurnKinds.ownMint). */
    const FIND_RECENT = 1200, FIND_RUN_ROWS = 5000, FIND_RUNS_MAX = 4, FIND_COVER = 5000, FIND_SLACK_MS = 10 * 60 * 1000;
    function retractTargets(list, into) {
      const out = into || new Set();
      for (const r of list) if (r && r.kind === 'retract' && Array.isArray(r.targets)) for (const t of r.targets) out.add(num(t));
      return out;
    }
    function findTurn(streamId, turnId, o, batch) {
      o = o || {};
      if (!TurnKinds || !TurnKinds.isTurnId(turnId) || !SID_RE.test(str(streamId))) return { state: 'absent' };
      const want = str(streamId);
      const ofTurn = r => r && r.streamId === want && r.turnId === turnId;
      const isDirective = r => ofTurn(r) && r.directive === true && r.role === 'user';
      const byRowId = (a, b) => num(a.rowId) - num(b.rowId);
      // 1. the newest rows of the stream (deletes honoured: a tombstoned directive is never found), retracts applied
      const recent = batch ? batch.recent : history(want, { limit: FIND_RECENT });
      const retracted = retractTargets(recent);
      const live = r => !retracted.has(num(r.rowId));
      const seen = recent.filter(r => ofTurn(r) && live(r));
      const found = (directive, list) => {
        // A row-id lookup may reach older than the newest suffix. Its later undo still decides
        // authority, even when that retract row was not returned alongside the original directive.
        let context;
        try { context = projectionContext(list.concat([directive])); }
        catch (error) { failNote('transcript.findTurn.retract', error); return { state: 'unknown' }; }
        if (context.retractions instanceof Map) for (const id of context.retractions.keys()) retracted.add(id);
        if (!live(directive)) return { state: 'unknown' };
        const all = new Map();
        for (const r of list.concat([directive])) if (ofTurn(r) && live(r)) all.set(num(r.rowId) || ('x' + all.size), r);
        return { state: 'found', directive: Object.assign({}, directive), rows: Array.from(all.values()).sort(byRowId).map(r => Object.assign({}, r)) };
      };
      let directive = seen.find(isDirective);
      if (directive) return found(directive, seen);
      // 2. T's rows are here without their directive: each run that wrote them wrote its directive first
      if (seen.length) {
        const runs = Array.from(new Set(seen.map(r => str(r.sourceRunId)).filter(Boolean))).slice(0, FIND_RUNS_MAX);
        for (const runId of runs) {
          const runRows = history(want, { sourceRunId: runId, limit: FIND_RUN_ROWS });
          retractTargets(runRows, retracted);
          directive = runRows.find(r => isDirective(r) && live(r));
          if (directive) return found(directive, seen.concat(runRows.filter(ofTurn)));
        }
      }
      // 3. the client named the directive's rowId: prove it by reading that row
      if (o.turnRowId != null && num(Number(o.turnRowId)) > 0) {
        let row = null;
        try {
          if (typeof io.readById === 'function') row = io.readById(Number(o.turnRowId));
          else row = rows.find(r => num(r.rowId) === Number(o.turnRowId)) || null;
        } catch (e) { failNote('transcript.findTurn', e); row = null; }
        if (row && isDirective(row) && !forgotten(row) && live(row)) return found(row, seen);
      }
      if (seen.length) return { state: 'unknown' };   // T's rows exist, but no rung could find its directive
      // 4. the absence proof: every row of the stream written since `since` was read, and none is T's
      const turnAt = o.turnAt;
      if (!(Number.isSafeInteger(turnAt) && turnAt >= 0)) return { state: 'unknown' };
      const since = batch ? batch.since : Math.min(turnAt, num(clock.now())) - FIND_SLACK_MS;
      if (batch && batch.coverRead) return batch.cover && !batch.cover.some(r => r && r.turnId === turnId) ? { state: 'absent' } : { state: 'unknown' };
      if (batch) batch.coverRead = true;
      let cover = null;
      if (typeof io.streamRows === 'function' && !ramGaps.has(want)) {
        // (a) RAM holds the whole stream (ramHistory's own test): a short stream, no disk read
        let durable = -1;
        try { durable = io.streamRows(want); } catch (e) { failNote('transcript.findTurn', e); durable = -1; }
        const held = rows.filter(r => r.streamId === want);
        if (typeof durable === 'number' && durable >= 0 && durable === held.length) cover = held;
      }
      if (!cover && typeof io.history === 'function') {
        // (b) a VOUCHED read of raw rows, directly (no RAM, no fallback, no forget filter: forgotten rows count)
        let got;
        try { got = io.history(want, { limit: FIND_COVER, since, vouch: batch ? { claims: batch.claims } : { claim: turnId } }); }
        catch (e) { failNote('transcript.findTurn', e); return { state: 'unknown' }; }
        if (!Array.isArray(got)) return { state: 'unknown' };
        const complete = got.length < FIND_COVER || num(got[0] && got[0].ts) < since;
        if (!complete) return { state: 'unknown' };
        cover = got;
      }
      if (!cover) return { state: 'unknown' };
      if (batch) batch.cover = cover;
      return cover.some(r => r && r.turnId === turnId) ? { state: 'unknown' } : { state: 'absent' };
    }
    // One assembly owns this coverage, never a reusable caller token or a global proof cache. All
    // carried turns share the oldest requested horizon, and damaged lines are checked against ALL ids.
    function findTurns(streamId, requests) {
      if (!SID_RE.test(str(streamId)) || !Array.isArray(requests) || requests.length > 8 || requests.some(r =>
        !r || !TurnKinds.isTurnId(r.turnId) || !Number.isSafeInteger(r.turnAt) || r.turnAt < 0)) throw new Error('invalid carried-turn proof batch');
      const out = new Map();
      if (!requests.length) return out;
      const batch = { recent: history(streamId, { limit: FIND_RECENT }), claims: [...new Set(requests.map(r => r.turnId))],
        since: Math.min(num(clock.now()), ...requests.map(r => r.turnAt)) - FIND_SLACK_MS, coverRead: false, cover: null };
      for (const r of requests) if (!out.has(r.turnId)) out.set(r.turnId, findTurn(streamId, r.turnId, { turnAt: r.turnAt, turnRowId: r.turnRowId }, batch));
      return out;
    }

    // H1.2: rebuild the recent dialogue for a stream as an OpenAI-format messages array, so a fresh run (empty
    // browser history) can RESUME exact prior state. Pairing-safe: a tool message needs its assistant tool_call,
    // so we drop a leading orphaned 'tool' (truncated-slice start) and strip tool_calls off a trailing assistant
    // whose results got cut — keeping the array valid for the provider.
    function reconstruct(streamId, o) {
      const rows = history(streamId, o);   // chronological, capped
      const out = [];
      for (const r of rows) {
        if (r.dispatchState === 'final') continue; // display projection; the execution already appears above
        if (r.role === 'user') out.push({ role: 'user', content: r.content });
        else if (r.role === 'assistant') {
          const m = { role: 'assistant', content: r.content || '' };
          if (r.toolCalls) { try { const tc = JSON.parse(r.toolCalls); if (Array.isArray(tc) && tc.length) m.tool_calls = tc; } catch (_) {} }
          out.push(m);
        } else if (r.role === 'tool') {
          out.push({ role: 'tool', content: r.content, tool_call_id: str(r.toolCallId) });
        }
      }
      while (out.length && out[0].role === 'tool') out.shift();                 // orphaned tool at a truncated start
      const last = out[out.length - 1];
      if (last && last.role === 'assistant' && last.tool_calls) delete last.tool_calls;   // results cut off the end
      return out;
    }

    function unvouched(message) {
      const error = new Error('Transcript history cannot be vouched for: ' + message);
      error.code = 'TRANSCRIPT_UNVOUCHED';
      return error;
    }
    function completeRows(streamId) {
      const want = normStream(streamId);
      let durable;
      try { durable = typeof io.streamRows === 'function' ? io.streamRows(want) : -1; }
      catch (error) { throw unvouched(error.message); }
      if (!Number.isSafeInteger(durable) || durable < 0) throw unvouched('durable row count is unknown');
      const held = rows.filter(row => row.streamId === want);
      if (!ramGaps.has(want) && held.length === durable) return held.map(row => Object.assign({}, row));
      if (!durable) return [];
      if (typeof io.history !== 'function') throw unvouched('complete disk reader is unavailable');
      let found;
      try { found = io.history(want, { limit: durable + 1, strict: true }); }
      catch (error) { throw unvouched(error.message); }
      if (!Array.isArray(found) || found.length !== durable) throw unvouched('durable row count changed during the read');
      return found.map(row => Object.assign({}, row));
    }
    /* eachRow(visit, { claims }?) - EVERY DURABLE ROW ONCE, a deleted session's rows among them (the caller asks isForgotten), for the
       one pass that must prove a fact about the whole history: forget-wiring.js attachment-files keeps an upload that any live row still
       names, and the RAM mirror (all()) holds only the newest rows. The visitor reads each row and never keeps or changes it. Returns
       { doubted, unread } from the io: the claims a damaged line or a segment gone for good may hold, which the caller keeps. Throws
       TRANSCRIPT_UNVOUCHED when the io cannot walk the history at all: no whole-history reader, or a view it cannot vouch for now. A
       visitor's own error is its caller's, never the history's: it propagates as itself. */
    function eachRow(visit, o) {
      if (typeof visit !== 'function') throw new Error('eachRow needs a visitor');
      if (typeof io.eachRow !== 'function') throw unvouched('the whole-history reader is unavailable');
      let own = null;
      const guarded = row => { try { visit(row); } catch (error) { own = { error }; throw error; } };
      let out;
      try { out = io.eachRow(guarded, o && Array.isArray(o.claims) ? o.claims : []); }
      catch (error) {
        if (own) throw own.error;
        if (error && error.code === 'TRANSCRIPT_UNVOUCHED') throw error;
        failNote('transcript.eachRow', error);
        throw unvouched((error && error.message) || 'the whole-history read failed');
      }
      const list = v => (Array.isArray(v) ? v.slice() : []);
      return { doubted: list(out && out.doubted), unread: list(out && out.unread) };
    }
    function projectionContext(list) {
      const context = viewContext(), ids = list.map(row => row.rowId).filter(id => Number.isSafeInteger(id) && id > 0);
      if (ids.length && typeof io.retractionsFor === 'function') {
        const proof = io.retractionsFor(ids);
        if (!proof || proof.proofComplete !== true || !(proof.retractions instanceof Map)) throw unvouched('retract context is unknown');
        context.retractions = proof.retractions;
      }
      return context;
    }
    // A bounded, affirmative removal proof for one reader's actual cache. A newest transcript tail
    // cannot tell a stale cache whether an older row was undone. Return IDs only, never stored text.
    function cacheRetractions(streamId, rowIds) {
      if (!SID_RE.test(str(streamId)) || !Array.isArray(rowIds) || rowIds.length > 2000 ||
          rowIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return { state: 'invalid' };
      const result = cacheRetractionsBatch(rowIds.map(rowId => ({ streamId, rowId })));
      return result.state === 'done' ? { state: 'done', retracted: result.retracted.map(row => row.rowId) } : result;
    }
    function cacheRetractionsBatch(requests) {
      if (!Array.isArray(requests) || requests.length > 2000) return { state: 'invalid' };
      const streams = new Map();
      for (const request of requests) {
        if (!request || !SID_RE.test(str(request.streamId)) || !Number.isSafeInteger(request.rowId) || request.rowId <= 0 ||
            (streams.has(request.rowId) && streams.get(request.rowId) !== request.streamId)) return { state: 'invalid' };
        streams.set(request.rowId, request.streamId);
      }
      const ids = [...streams.keys()];
      if (!ids.length) return { state: 'done', retracted: [] };
      let proof;
      try { proof = typeof io.readByIds === 'function' ? io.readByIds(ids) : null; }
      catch (error) { failNote('transcript.retract.cache', error); return { state: 'unknown' }; }
      if (!(proof instanceof Map) || proof.proofComplete !== true || !(proof.retractions instanceof Map)) return { state: 'unknown' };
      for (const id of ids) {
        const row = proof.get(id);
        if (!row || row.streamId !== streams.get(id) || (typeof io.isCollided === 'function' && io.isCollided(id))) return { state: 'unknown' };
      }
      return { state: 'done', retracted: ids.filter(id => proof.retractions.get(id) === 'undo').map(rowId => ({ streamId: streams.get(rowId), rowId })) };
    }
    // A mutation needs a complete target set, not findTurn's useful but possibly partial window.
    // One bounded suffix must reach the original directive. An assistant-only undo instead requires
    // that same strict read to cover the entire vouched stream. Every target is then proved from disk
    // before a single strict append; unknown authority and invalid input never write partial retracts.
    function retract(o) {
      const a = o || {}, streamId = str(a.streamId), reason = a.reason;
      const unknown = why => ({ state: 'unknown', why, targets: [] });
      const invalid = why => ({ state: 'invalid', why, targets: [] });
      if (!SID_RE.test(streamId) || (reason !== 'retry' && reason !== 'undo')) return invalid('invalid stream or reason');
      const byTurn = TurnKinds.isTurnId(a.turnId);
      if ((byTurn && a.rowIds != null) || (!byTurn && (a.turnId != null || reason === 'retry'))) return invalid('invalid target selector');
      let targets, directive = null;
      if (byTurn) {
        let suffix, durableBefore = -1;
        try {
          if (typeof io.streamRows === 'function') durableBefore = io.streamRows(streamId);
          if (typeof io.history === 'function') suffix = io.history(streamId, { limit: 5001, strict: true, maxSegments: 8 });
          else { suffix = completeRows(streamId); if (suffix.length > 5001) return unknown('turn exceeds read horizon'); }
        } catch (error) { failNote('transcript.retract.suffix', error); return unknown('turn suffix is unproven'); }
        if (!Array.isArray(suffix)) return unknown('turn suffix is unavailable');
        const own = suffix.filter(row => row && row.streamId === streamId && row.turnId === a.turnId);
        const directives = own.filter(row => row.directive === true && row.role === 'user');
        if (directives.length > 1) return unknown('original directive is not unique in the suffix');
        directive = directives[0] || null;
        if (!directive) {
          let durableAfter = -1;
          try { if (typeof io.streamRows === 'function') durableAfter = io.streamRows(streamId); }
          catch (error) { failNote('transcript.retract.coverage', error); }
          if (reason !== 'undo' || a.directiveRowId != null || !own.length || !Number.isSafeInteger(durableBefore) ||
              durableBefore < 0 || durableBefore !== durableAfter || suffix.length !== durableBefore ||
              suffix.some(row => !row || row.streamId !== streamId)) return unknown('directive-free turn coverage is unproven');
        }
        if (directive && (!Number.isSafeInteger(directive.rowId) || directive.rowId <= 0 || forgotten(directive) ||
            (a.directiveRowId != null && a.directiveRowId !== directive.rowId) || (a.agentId && a.agentId !== directive.agentId))) return unknown('original directive is unproven');
        const selected = own.filter(row => row.kind !== 'retract' && (reason === 'undo' || row.rowId > directive.rowId));
        if (selected.some(row => !Number.isSafeInteger(row.rowId) || row.rowId <= 0) || new Set(selected.map(row => row.rowId)).size !== selected.length)
          return unknown('turn target identities are unproven');
        targets = selected.map(row => row.rowId);
      } else {
        if (!Array.isArray(a.rowIds) || !a.rowIds.length || a.rowIds.length > TARGETS_MAX ||
            a.rowIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return invalid('invalid target row ids');
        targets = [...new Set(a.rowIds)];
      }
      const prove = [...new Set(targets.concat(directive ? [directive.rowId] : []))];
      let proof;
      try { proof = typeof io.readByIds === 'function' ? io.readByIds(prove) : null; }
      catch (error) { failNote('transcript.retract.targets', error); return unknown('target read failed'); }
      if (!(proof instanceof Map) || proof.proofComplete !== true || !(proof.retractions instanceof Map)) return unknown('target proof is unavailable');
      let live;
      try { live = typeof opts.live === 'function' ? opts.live() : opts.live; }
      catch (error) { failNote('transcript.retract.live', error); return unknown('live-run authority is unavailable'); }
      for (const id of prove) {
        const row = proof.get(id);
        if (!row || row.streamId !== streamId || row.kind === 'retract' || forgotten(row) ||
            (typeof io.isCollided === 'function' && io.isCollided(id)) || (byTurn && row.turnId !== a.turnId)) return unknown('target does not belong to this turn and stream');
        if (live && live.has(String(row.sourceRunId || '')) && row.sourceRunId !== a.runId) return unknown('target run is still active');
      }
      if (directive && reason === 'retry' && proof.retractions.has(directive.rowId)) return unknown('original directive was retracted');
      targets = targets.filter(id => !proof.retractions.has(id) || (reason === 'undo' && proof.retractions.get(id) !== 'undo'));
      if (targets.length > TARGETS_MAX) return unknown('turn exceeds retract capacity');
      if (!targets.length) return { state: 'done', targets: [], rowId: null };
      const row = appendStrict({ streamId, agentId: a.agentId || (directive && directive.agentId) || '', role: 'system', kind: 'retract',
        content: '', targets, reason, turnId: byTurn ? a.turnId : undefined,
        sourceRunId: a.runId || (directive && directive.sourceRunId) || '' });
      if (!row || !Number.isSafeInteger(row.rowId) || row.rowId <= 0) throw unvouched('retract append has no durable identity');
      return { state: 'done', targets, rowId: row.rowId };
    }
    function projectView(name, list, o, sharedContext) {
      // Boot recovery reads durable proof before live/display owners are initialized. Proof must not
      // consult visibility callbacks at all, including a live-set thunk whose binding is still in its TDZ.
      const context = name === 'proof' ? {} : sharedContext || projectionContext(list);
      const current = () => TurnView.project(name, list, context, o);
      const surface = name === 'display' ? 'display' : name === 'model-replay' ? 'replay' : null;
      return surface && typeof opts.pick === 'function'
        ? opts.pick(surface, () => TurnView.project(name, list, context, Object.assign({}, o, { legacy: true })), current)
        : current();
    }
    // At most 32 segment visits for a listing: 24 across all bounded previews, then the separate
    // eight-segment retract-context budget. Sparse streams cannot turn a row limit into an unbounded scan.
    const LISTING_PREVIEW_SEGMENTS = 24;
    function listingCandidates(o) {
      if (typeof io.streams !== 'function') return streams(o); // bounded RAM adapter; no segment IO
      const limit = num(o.limit) > 0 ? Math.min(num(o.limit), 100) : 20;
      const list = io.streams({ limit, previewChars: 1 }) || [];
      return list.filter(candidate => {
        if (typeof io.streamRows !== 'function' || io.streamRows(candidate.streamId) < 0) throw unvouched('listing metadata is unknown');
        const at = deletedAt ? num(deletedAt(candidate.streamId)) : 0;
        return !(at > 0 && num(candidate.lastAt) <= at);
      });
    }
    function listingTail(streamId, budget) {
      if (typeof io.preview === 'function') return io.preview(streamId, { limit: GLOBAL_PREVIEW_SCAN, budget });
      // Test/legacy in-memory adapters may supply only readAll. A partial RAM tail is a preview, never
      // complete history, and no unbounded history fallback is allowed at this listing boundary.
      return rows.filter(row => row.streamId === streamId).slice(-GLOBAL_PREVIEW_SCAN).map(row => Object.assign({}, row));
    }
    // This is the production read boundary. Raw readers remain private backends (and the named channel
    // rollback adapter until its port); callers select visibility, never reconstruct it from raw rows.
    function view(name, streamId, options) {
      if (!TurnKinds.VIEWS.includes(name)) throw new Error('unknown transcript view: ' + name);
      const o = Object.assign({}, options, { streamId: normStream(streamId) });
      if (name === 'model-replay' && o.shape !== 'prose' && o.shape !== 'pairs') throw new Error('model-replay requires a literal prose or pairs shape');
      if ((name === 'recall' || name === 'display') && o.op === 'streams') {
        const candidates = listingCandidates(o), out = [], previewMax = num(o.previewChars) > 0 ? num(o.previewChars) : 160;
        const previewBudget = { remaining: LISTING_PREVIEW_SEGMENTS };
        const tails = candidates.map(candidate => listingTail(candidate.streamId, previewBudget));
        // A listing is not complete:true: it carries the existing durable metadata count and timestamp,
        // with a bounded visible preview. A hidden-only tail has no preview, not proof of no older dialogue.
        // One context lookup for the whole listing shares the same eight-segment cold-summary budget.
        const context = projectionContext(tails.flat());
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          const projected = projectView(name, tails[i], Object.assign({}, o, { streamId: candidate.streamId, limit: undefined }), context);
          const entry = Object.assign({}, candidate, { preview: '', previewTaint: '', previewTaintKnown: false });
          for (const row of projected) {
            if (row.agentId) entry.agentId = row.agentId;
            const preview = conversationPreview(row);
            if (preview) { entry.preview = preview.replace(/\s+/g, ' ').trim().slice(0, previewMax); entry.previewTaint = row.taint || ''; entry.previewTaintKnown = row.taintKnown === true || !!row.taint; }
          }
          out.push(entry);
        }
        return out.sort((a, b) => b.lastAt - a.lastAt || a.streamId.localeCompare(b.streamId));
      }
      if (name === 'recall' && (o.op === 'search' || o.op === 'around')) {
        const found = o.op === 'search' ? search(o.streamId, o.query, o) : around(o.streamId, o.anchor, { window: o.window || o.limit, rowId: o.rowId });
        // A search hit alone cannot prove an accepted dispatch prompt. Supply its actual same-run rows
        // to the common projector, then return only hits/anchor rows that survived that projection.
        const byId = new Map(found.map(row => [row.rowId, row])), runs = new Set();
        for (const row of found) if (row.sourceRunId && (row.dispatchState === 'pending' || row.dispatchState === 'final')) {
          const key = JSON.stringify([row.streamId, row.sourceRunId]);
          if (runs.has(key)) continue;
          runs.add(key);
          for (const contextRow of readHistory(row.streamId, { sourceRunId: row.sourceRunId, limit: 5000 }, false)) if (!byId.has(contextRow.rowId)) byId.set(contextRow.rowId, contextRow);
        }
        const projected = projectView(name, [...byId.values()].sort((a, b) => num(a.rowId) - num(b.rowId)), Object.assign({}, o, { limit: undefined }));
        const visible = new Map(projected.map(row => [row.rowId, row]));
        return found.filter(row => visible.has(row.rowId)).map(row => Object.assign({}, visible.get(row.rowId), row.score == null ? null : { score: row.score }));
      }
      const list = viewRows(name, streamId, o);
      return projectView(name, list, o);
    }
    function viewRows(name, streamId, o) {
      let list;
      if (name === 'owner-evidence' && streamId == null) list = Number.isSafeInteger(o.limit) && o.limit >= 0
        ? (o.limit ? rows.slice(-o.limit) : []) : rows.slice();
      else if (o.complete === true) list = completeRows(o.streamId);
      else list = readHistory(o.streamId, Object.assign({}, o, { sourceRunId: o.run || o.sourceRunId,
        limit: name === 'proof' ? o.limit : (num(o.limit) > 0 ? num(o.limit) : cap) + 500 }), false);
      if (o.run || o.sourceRunId) list = list.filter(row => row.sourceRunId === (o.run || o.sourceRunId));
      if (o.dispatchState) list = list.filter(row => row.dispatchState === o.dispatchState);
      if (o.turnId) list = list.filter(row => row.turnId === o.turnId);
      if (name !== 'proof' && num(o.since) > 0) list = list.filter(row => num(row.ts) >= num(o.since));
      if (!Object.prototype.hasOwnProperty.call(o, 'limit') && !(name === 'owner-evidence' && streamId == null) && !o.complete) o.limit = cap;
      return list;
    }
    // One synchronous consumer assembly: fresh retract authority is read once and never retained across
    // calls. This is the same projection as view(), with bounded per-stream rows and shared context IO.
    function viewMany(name, streamIds, options) {
      if (name !== 'model-replay') throw new Error('batched transcript view requires model-replay');
      if (!Array.isArray(streamIds) || streamIds.length > 500) throw new Error('batched transcript view accepts at most 500 streams');
      if (!options || (options.shape !== 'pairs' && options.shape !== 'prose')) throw new Error('model-replay requires a literal prose or pairs shape');
      if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 400) throw new Error('batched transcript view requires a row limit from 1 to 400');
      const unique = [...new Set(streamIds.map(normStream))], out = new Map();
      if (!unique.length) return out;
      const batches = unique.map(streamId => {
        const o = Object.assign({}, options, { streamId });
        if (o.complete === true) throw new Error('batched transcript view requires bounded reads');
        return { streamId, o, rows: viewRows(name, streamId, o) };
      });
      const context = projectionContext(batches.flatMap(batch => batch.rows));
      for (const batch of batches) out.set(batch.streamId, projectView(name, batch.rows, batch.o, context));
      return out;
    }

    /* A STREAM READ BY CURSOR AND BY ROW ID (save-history-by-reference). The page keeps its rows as a cache of this
       transcript, so it needs two reads view('display') cannot give: every row after the one it already holds, however
       long the stream, and exactly the rows it names. Both answer from DISK (io.pageAfter / io.readByIds), never from
       the RAM mirror, and both go through the ONE display projection (projectView), so a hidden kind, an undone or
       forgotten row, a deleted session's row and a live run's row are exactly as invisible here as in a GET. */
    const PAGE_MAX = 500, PAGE_DEFAULT = 200, ROWS_BY_IDS_MAX = 1000, ROWS_STREAMS_MAX = 50, READ_SEGMENTS = 8, RUN_CONTEXT_MAX = 16;
    const byRowId = (a, b) => num(a.rowId) - num(b.rowId);
    function badRead(message) { return Object.assign(new Error(message), { code: 'TRANSCRIPT_BAD_REQUEST' }); }
    /* THE RUN AROUND A ROW. projectConversation reads a dispatch run as one unit (the stored prompt, its execution rows
       and its accepted final), so a read that cuts through the run would hide or decorate its rows differently from a
       read of the whole stream (a prompt whose final lies on the next page would not be shown). The same-run rows of a
       dispatch row are supplied to the projection as context and are never returned (recall's search does the same),
       read from the run's own start on (the run record's time, when the host has it). Ordinary turns carry no
       dispatchState and cost no read. One request loads the context of at most RUN_CONTEXT_MAX runs (`state` carries the
       count across a batch); the dispatch rows of any later run are `unproven`: a page ends before the first of them and
       a by-id read names them missing, so a row is never shown with less of its run than a whole-stream read gives it. */
    function runStart(runId) {
      const run = typeof opts.runOf === 'function' ? opts.runOf(runId) : null;
      const at = [run && run.startedAt, run && run.ts].map(Number).filter(v => Number.isFinite(v) && v > 0);
      return at.length ? Math.min.apply(null, at) : 0;
    }
    function runContext(list, state) {
      const have = new Set(list.map(row => row.rowId)), extra = [], unproven = new Set();
      for (const row of list) {
        // only a stored prompt (a pending user row) and a final can be shown by a dispatch run; its other pending rows
        // are never shown, whatever the run holds, so they need no context and spend none of the budget
        if (!row.sourceRunId || !(row.dispatchState === 'final' || (row.dispatchState === 'pending' && row.role === 'user'))) continue;
        const key = JSON.stringify([row.streamId, row.sourceRunId]);
        if (!state.loaded.has(key)) {
          if (state.loaded.size >= RUN_CONTEXT_MAX) { unproven.add(row.rowId); continue; }
          state.loaded.add(key);
          for (const sibling of readHistory(row.streamId, { sourceRunId: row.sourceRunId, limit: 5000, since: runStart(row.sourceRunId) }, false))
            if (!have.has(sibling.rowId)) { have.add(sibling.rowId); extra.push(sibling); }
        }
      }
      return { extra, unproven };
    }
    /* pageAfter(streamId, afterRowId, limit) -> { rows, last, more }: the visible rows of the stream after `afterRowId`,
       oldest first, from a window of the NEXT `limit` (<= 500) durable rows of the stream. `last` is the newest row id the
       window decided (shown, or hidden for good), so reading on from `last` returns every visible row exactly once, in
       rowId order, even when a whole window is hidden. `more` = the stream has rows past `last` to read now. A run still
       writing is not visible yet (H2): the window stops before its first row and `more` is false, so `last` never passes a
       row a later read will show. A page also ends early (more stays true) before the dispatch rows of the 17th run it
       would have to load, so no request loads more than RUN_CONTEXT_MAX runs. Every row returned has a durable rowId;
       the station's own lines (interrupted, page closed) are derived on each ordinary read and are not part of this one.
       A view that cannot be vouched for throws TRANSCRIPT_UNVOUCHED, never an empty page. */
    function pageAfter(streamId, afterRowId, limit) {
      if (!Number.isSafeInteger(afterRowId) || afterRowId < 0) throw badRead('a cursor read needs a row id of zero or more');
      const want = normStream(streamId), size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, PAGE_MAX) : PAGE_DEFAULT;
      if (typeof io.pageAfter !== 'function') throw unvouched('the cursor reader is unavailable');
      let read;
      try { read = io.pageAfter(want, afterRowId, { limit: size, maxSegments: READ_SEGMENTS }); }
      catch (error) {
        if (error && error.code === 'TRANSCRIPT_UNVOUCHED') throw error;
        failNote('transcript.pageAfter', error);
        throw unvouched((error && error.message) || 'the cursor read failed');
      }
      if (!read || !Array.isArray(read.rows)) throw unvouched('the cursor reader answered nothing');
      let window = read.rows.filter(row => row && Number.isSafeInteger(row.rowId) && row.rowId > afterRowId), more = read.more === true;
      const live = viewContext().live;
      if (live && live.size) {
        const at = window.findIndex(row => live.has(str(row.sourceRunId)));
        if (at >= 0) { window = window.slice(0, at); more = false; }
      }
      if (!window.length) return { rows: [], last: afterRowId, more };
      const around = runContext(window, { loaded: new Set() }), cut = window.findIndex(row => around.unproven.has(row.rowId));
      if (cut > 0) { window = window.slice(0, cut); more = true; }   // the run-context budget is spent: a short page, not a wrong row
      const list = window.concat(around.extra).sort(byRowId), wanted = new Set(window.map(row => row.rowId));
      const projected = projectView('display', list, { streamId: want }, projectionContext(list)), shownRows = projected.filter(row => wanted.has(row.rowId));
      // the quote rule's affirmative drop proof (TurnView.FORGOTTEN, by its registry key) rides the page, for this window's rows only
      const marker = projected[Symbol.for('starnet.transcript.forgotten')];
      if (marker) Object.defineProperty(shownRows, Symbol.for('starnet.transcript.forgotten'), { enumerable: false,
        value: { keys: (marker.keys || []).filter(k => wanted.has(k[1])), runIds: marker.runIds || [] } });
      return { rows: shownRows, last: window[window.length - 1].rowId, more };
    }
    /* rowsByIds(streamId, rowIds) -> { rows, missing, retracted, forgotten }: exactly the rows asked for (<= 1000 ids),
       as the display view shows them, in the ORDER ASKED (an id asked twice is answered once, where it was first asked).
       Every id lands in one list: rows (shown), forgotten (a deleted session's row), retracted (undone by a later retract
       row), or missing = the station cannot return it and cannot prove it gone: no such row, another stream's row (never
       returned), a collided or hidden-kind row, a live run's row, a row beyond the read's eight-segment budget, or a
       dispatch row of a 17th run (the request's run-context budget). Ask again with only the missing ids to read on:
       each round reads the next segments and runs. rowsByIdsBatch(requests) answers several streams from
       ONE proof read, so a request still touches at most eight segments, however many streams it names. A proof that
       is incomplete throws TRANSCRIPT_UNVOUCHED: never every id as missing. */
    function rowsByIds(streamId, rowIds) { return rowsByIdsBatch([{ streamId, rowIds }])[0]; }
    function rowsByIdsBatch(requests) {
      if (!Array.isArray(requests) || requests.length > ROWS_STREAMS_MAX) throw badRead('rows by id: at most ' + ROWS_STREAMS_MAX + ' streams');
      const asks = [], union = new Set();
      for (const request of requests) {
        const streamId = request && request.streamId, rowIds = request && request.rowIds;
        if (typeof streamId !== 'string' || !SID_RE.test(streamId) || !Array.isArray(rowIds) || rowIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw badRead('rows by id: a stream id and positive row ids are required');
        const ids = Array.from(new Set(rowIds));
        for (const id of ids) union.add(id);
        asks.push({ streamId, ids });
      }
      if (union.size > ROWS_BY_IDS_MAX) throw badRead('rows by id: at most ' + ROWS_BY_IDS_MAX + ' row ids');
      let proof = new Map();
      if (union.size) {
        if (typeof io.readByIds !== 'function') throw unvouched('the row reader is unavailable');
        try { proof = io.readByIds(Array.from(union).sort((a, b) => a - b)); }
        catch (error) { failNote('transcript.rowsByIds', error); throw unvouched((error && error.message) || 'the row read failed'); }
        if (!(proof instanceof Map) || proof.proofComplete !== true || !(proof.retractions instanceof Map)) throw unvouched('the row proof is incomplete');
      }
      const owned = asks.map(ask => new Map(ask.ids.filter(id => proof.has(id) && proof.get(id).streamId === ask.streamId).map(id => [id, proof.get(id)])));
      const state = { loaded: new Set() }, unproven = new Set();
      const lists = owned.map(map => {
        const rows = Array.from(map.values()), around = runContext(rows, state);
        for (const id of around.unproven) unproven.add(id);
        return rows.concat(around.extra).sort(byRowId);
      });
      const every = new Map();
      for (const list of lists) for (const row of list) every.set(row.rowId, row);
      const context = every.size ? projectionContext(Array.from(every.values())) : null;
      return asks.map((ask, i) => {
        const shown = new Map(lists[i].length ? projectView('display', lists[i], { streamId: ask.streamId }, context).filter(row => owned[i].has(row.rowId) && !unproven.has(row.rowId)).map(row => [row.rowId, row]) : []);
        const out = { rows: [], missing: [], retracted: [], forgotten: [] };
        for (const id of ask.ids) {
          const row = owned[i].get(id), why = context && context.retractions instanceof Map ? context.retractions.get(id) : undefined;
          if (shown.has(id)) out.rows.push(shown.get(id));
          else if (row && forgotten(row)) out.forgotten.push(id);
          else if (row && why && why !== 'retry') out.retracted.push(id);
          else out.missing.push(id);
        }
        return out;
      });
    }

    return {
      append, appendStrict, appendTurns, appendNew, appendNewStrict, markPersisted, markRecorded, history, reconstruct, taintOf, search, streams, around,
      view, viewMany, pageAfter, rowsByIds, rowsByIdsBatch, findTurn, findTurns, ownerProof, retract, cacheRetractions, cacheRetractionsBatch, isForgotten: forgotten, isQuoteForgotten: quoteForgotten, forgetVerdicts, eachRow,
      all() { return keep(rows).map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      _internals: { normStream, SID_RE }
    };
  }

  return { makeTranscriptStore, projectConversation, conversationPreview, isFinalDeliveryRow, markPersisted, rowTaint, rowKeyOf, UNVERIFIED_ROW, _internals: { SID_RE, ROLES, PERSISTED, flattenContent } };
});
