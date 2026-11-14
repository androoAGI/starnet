/* sidecar/providers/cli-replay-ledger.js — THE CLAUDE CODE REPLAY LEDGER (cost lane W3.7, 2026-11-14).

   On the Claude sign-in route (claude-cli.js) every new message of a conversation is a new run with a new `claude` child,
   and the child is given the whole conversation again. The CLI caches a request up to its LAST block and the API finds an
   earlier entry only where an earlier request ended. Run N's first request ends with ask N carrying the host notes that
   were placed with it (<run_context>, <recalled-memory>, <crew_call>); run N+1 replays ask N bare. The bytes differ at that
   block, so run N+1 reads only the system prompt from cache and WRITES the whole conversation again, on every message
   (audit cache:cli-fresh-child-per-message: about 90-290k extra tokens per 20-message chat).

   The ledger keeps, per stream, the entries a run's first request was SENT with, and the next run of that stream sends
   those entries again VERBATIM: the new request then starts with the exact bytes the last one ended on, and only the
   last reply and the new message are new. Nothing is added to the conversation: an entry of today's history is swapped
   for the text that same entry went out with, and only when today's entry is byte for byte what that text was made from.

   ONE RESOLVER: plan(entries, ctx). claude-cli.js calls it wherever it renders a whole transcript (a one-shot child, a
   fresh or a warm persistent child); nothing else decides a replay.

   WHAT A REPLAY MAY NEVER DO (docs/DECISIONS.md; the audit's laws for this fix):
     - THE NEWEST RUN'S OWN NOTES RIDE AS THEY ARE. The entry of today's request that carries the <run_context> note is
       the newest message's (index.js places that note, recall and the crew call with it). It is never swapped, so the
       newest feedback, learned tail, ids and date are exactly what the host wrote for this run.
     - PAST NOTES NEVER SIT AFTER THE NEWEST RUN'S IDS. Only entries BEFORE that entry are swapped, and a request with no
       such entry is left alone ('nonote').
     - HISTORY STAYS PROSE. A record ends at the newest message's entry of a run's FIRST request; the tool turns a later
       request of the same run holds are never recorded, so they are never replayed.
     - STALE BYTES ARE NEVER REPLAYED. A record belongs to one lineage: the account, the model, the effort and the exact
       system prompt (the tool list rides it) of the child that was sent it. Another lineage has no record ('none') and
       gets today's bytes. An entry is swapped only while today's entry equals the bare text the record kept for it, in
       order from the first one: an edited, dropped or slid history stops the replay where it differs ('part'), and a
       first entry that differs replays nothing ('history'). An entry with an image is never recorded or swapped, and
       nothing after it is.
     - OLD NOTES DO NOT PILE UP. The audit warned that this pays only while the per-run note is slim. It is not: measured
       on a fresh station (no saved skills, no memories, no quests) a COMMS task's note is 2.4-3.0 KB, and every replayed
       turn keeps its own. So the notes a request may replay are capped (noteMax, 24,000 characters, about 6k tokens: what
       a 20-message chat of the audit's 300-token notes would hold). Past the cap the request is today's bytes, with no
       past note at all ('notes'), and the record starts again from it: one message in several pays today's price and
       the stale notes are gone. A single note over the cap therefore never replays: the route behaves as it does today.
     - A NOTE THE CACHE CANNOT GIVE BACK IS NOT SENT. A replayed note is read from cache only where a request ended on it
       and the API still finds that entry:
         'expired'  the record is older than a cache entry lives (the API-key tier keeps one 5 minutes, a subscription 1
                    hour; setTtl says which once the child has named its sign-in, and until then the short one is assumed);
         'far'      the last request end among the replayed entries is more than LOOKBACK blocks before this request's
                    end (the API looks back about 20 blocks from the breakpoint: claude-cli.js PROMPT CACHE). An image
                    counts three blocks, and what the caller appends after the entries counts too.
       Either way the notes would only be written again, so the request is today's bytes.
     - WHAT WAS FORGOTTEN IS NOT REPLAYED (docs/DECISIONS.md, What a deleted session leaves behind). A past note is a copy
       of what the host knew when it was written: recalled memories, the Commander's recent activity, a task brief. A
       session deleted or a memory forgotten since then must not come back through it. Every request carries the host's
       forget epoch (index.js cliReplayEpoch: the newest session delete and the count of forgotten memories); a record
       made under another epoch is dropped, here and on every other stream, the moment a request shows the new one
       ('forgotten'), and the request is today's bytes.
   Whatever the verdict, the caller gets a list to send: the swapped one on 'hit' / 'part', today's own otherwise. The
   caller wraps the call so that a throw here is today's bytes too (claude-cli.js: failNote 'claudecli.replay').

   BOUNDED, IN MEMORY, LOST ON RESTART. At most maxStreams streams, maxLineages lineages each (a chat turn and a task
   turn of one conversation have different system prompts), maxBytes characters in all; the least recently used stream
   goes first, and a record that alone is over the limit is not kept. After a restart there is no record: the first
   message is today's bytes and the ledger starts from it.

   Entries are claude-cli.js transcriptEntries objects: { text, bare?, runNote? }. `bare` is set on a user entry that
   carries host notes (its text without them); runNote says one of them is the run-context note.

   makeReplayLedger({ maxStreams?, maxLineages?, maxBytes?, noteMax?, lookback? }) -> {
     plan(entries, { stream, lineage, runId, epoch?, at?, images?, tail? }) -> { entries, verdict, replayed, noteBytes, record }
       verdict   'hit' (every recorded entry replayed) | 'part' (the first `replayed` of them) | 'none' | 'history' |
                 'notes' | 'expired' | 'far' | 'forgotten' | 'nonote'
       epoch     the host's forget epoch (a string); a record made under another one is never replayed
       replayed  entries sent from the record; noteBytes: the past notes among them (characters)
       record    the record now kept for this lineage (null when none is), for setTtl
       at        the request's time in ms (the loop's clock); absent = no age check
       images    text -> how many images an entry carries (an entry with one is never recorded or swapped)
       tail      blocks the caller appends after the entries (a tool-reveal note)
     setTtl(record, ms)   how long the cache entry this record stands for lives
     stats() -> { streams, lineages, bytes }
     clear()
   }
   Pure: no clock, no environment, no I/O (lint-determinism). The switch is the host's (index.js cliReplayStream). */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.cliReplayLedger = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // a cache entry's life by tier, less a tenth: the record's time is when the request was built, not when it was cached
  const KEY_TTL_MS = 270000;             // an API-key sign-in: the 5-minute tier
  const SUBSCRIPTION_TTL_MS = 3240000;   // a subscription sign-in: the 1-hour tier
  const DEFAULTS = { maxStreams: 24, maxLineages: 3, maxBytes: 8 * 1024 * 1024, noteMax: 24000, lookback: 18 };

  const pos = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0) ? Math.floor(v) : d;
  const bareOf = r => (r.bare === undefined ? r.sent : r.bare);   // what a later run's history carries for a recorded entry

  function makeReplayLedger(opts) {
    const o = opts || {};
    const maxStreams = pos(o.maxStreams, DEFAULTS.maxStreams);
    const maxLineages = pos(o.maxLineages, DEFAULTS.maxLineages);
    const maxBytes = pos(o.maxBytes, DEFAULTS.maxBytes);
    const lookback = pos(o.lookback, DEFAULTS.lookback);
    const noteMax = (typeof o.noteMax === 'number' && Number.isFinite(o.noteMax) && o.noteMax >= 0) ? Math.floor(o.noteMax) : DEFAULTS.noteMax;
    const streams = new Map();   // stream -> Map(lineage -> record); both least recently used first
    let bytes = 0;
    let epochSeen = null;        // the forget epoch of the last request: a new one drops every record made under another

    function forget(stream, lineage) {
      const lines = streams.get(stream);
      if (!lines) return;
      const rec = lines.get(lineage);
      if (rec) { bytes -= rec.bytes; lines.delete(lineage); }
      if (!lines.size) streams.delete(stream);
    }
    function dropStream(stream) {
      const lines = streams.get(stream);
      if (!lines) return;
      for (const rec of lines.values()) bytes -= rec.bytes;
      streams.delete(stream);
    }
    // the stream and its lineage move to the newest end
    function touch(stream, lineage) {
      const lines = streams.get(stream);
      if (!lines) return;
      streams.delete(stream); streams.set(stream, lines);
      const rec = lines.get(lineage);
      if (rec) { lines.delete(lineage); lines.set(lineage, rec); }
    }
    function keep(stream, lineage, rec) {
      forget(stream, lineage);
      if (rec.bytes > maxBytes) return null;   // a conversation that alone is over the limit is not kept
      let lines = streams.get(stream);
      if (!lines) { lines = new Map(); streams.set(stream, lines); }
      lines.set(lineage, rec); bytes += rec.bytes;
      touch(stream, lineage);
      while (lines.size > maxLineages) forget(stream, lines.keys().next().value);
      while (streams.size > maxStreams || bytes > maxBytes) {
        const oldest = streams.keys().next().value;
        if (oldest !== stream) { dropStream(oldest); continue; }
        if (lines.size > 1) { forget(stream, lines.keys().next().value); continue; }   // only this stream is left: its older lineages go
        break;   // ...and its newest record fits by itself (checked above)
      }
      return rec;
    }

    function plan(entries, ctx) {
      const c = ctx || {};
      const list = Array.isArray(entries) ? entries : [];
      const stream = String(c.stream == null ? '' : c.stream), lineage = String(c.lineage == null ? '' : c.lineage), runId = String(c.runId == null ? '' : c.runId);
      const imagesOf = typeof c.images === 'function' ? c.images : null;
      const images = e => { const k = imagesOf ? Number(imagesOf(e.text)) : 0; return k > 0 ? Math.floor(k) : 0; };
      const at = (typeof c.at === 'number' && Number.isFinite(c.at)) ? c.at : null;
      const none = verdict => ({ entries, verdict, replayed: 0, noteBytes: 0, record: null });
      // a new forget epoch drops every record made under another one, on every stream, before anything is read
      const epoch = String(c.epoch == null ? '' : c.epoch);
      const was = streams.get(stream);
      const forgotten = !!(was && was.get(lineage) && was.get(lineage).epoch !== epoch);
      if (epoch !== epochSeen) {
        for (const [s, ls] of Array.from(streams)) for (const [l, r] of Array.from(ls)) if (r.epoch !== epoch) forget(s, l);
        epochSeen = epoch;
      }
      // the newest message's own entry: the first one that carries the run-context note
      let q = -1;
      for (let i = 0; i < list.length; i++) if (list[i] && list[i].runNote === true && typeof list[i].bare === 'string' && typeof list[i].text === 'string') { q = i; break; }
      if (!stream || !lineage || !runId || q < 0) return none('nonote');
      const lines = streams.get(stream);
      const rec = (lines && lines.get(lineage)) || null;
      let verdict = forgotten ? 'forgotten' : 'none', out = entries, replayed = 0, noteBytes = 0;
      if (rec) {
        if (at != null && rec.at != null && at - rec.at > rec.ttlMs) verdict = 'expired';
        else {
          let p = 0, notes = 0, end = -1;   // end: the last replayed entry a request ended on (it carries that run's notes)
          const n = Math.min(q, rec.entries.length);
          for (; p < n; p++) {
            const e = list[p], r = rec.entries[p];
            if (!e || typeof e.text !== 'string' || images(e) > 0) break;
            if (e.text !== bareOf(r)) break;
            if (r.bare !== undefined) { notes += r.sent.length - r.bare.length; end = p; }
          }
          // a later request of the run that made the record carries that run's own newest entry itself, byte for byte:
          // the record's last entry is then today's, and this run's first request ended on it
          const own = rec.runId === runId && p === q && q === rec.entries.length - 1 && list[q].text === rec.entries[q].sent;
          if (!p && !own) verdict = 'history';
          else if (notes > noteMax) verdict = 'notes';
          else {
            let after = Math.max(0, Math.floor(Number(c.tail) || 0));
            for (let i = (own ? q : end) + 1; i < list.length; i++) after += list[i] && typeof list[i].text === 'string' ? 1 + 3 * images(list[i]) : 1;
            if (notes > 0 && after > lookback) verdict = 'far';
            else {
              verdict = (p === rec.entries.length || own) ? 'hit' : 'part';
              replayed = p; noteBytes = notes;
              if (notes > 0) out = list.map((e, i) => (i < p && rec.entries[i].bare !== undefined) ? Object.assign({}, e, { text: rec.entries[i].sent }) : e);
            }
          }
        }
      }
      // A run's FIRST request is what the next run replays. A later request of the same run (a replacement child, a
      // one-shot turn after a tool call) reads the same record and so renders the same history; it records nothing.
      if (rec && rec.runId === runId) { touch(stream, lineage); return { entries: out, verdict, replayed, noteBytes, record: rec }; }
      const kept = [];
      let size = 0;
      for (let i = 0; i <= q; i++) {
        const e = out[i];
        if (!e || typeof e.text !== 'string' || images(e) > 0) break;
        const bare = i === q ? list[q].bare : list[i].text;
        if (e.text === bare) { kept.push({ sent: e.text }); size += e.text.length; }
        else { kept.push({ sent: e.text, bare }); size += e.text.length + bare.length; }
      }
      if (!kept.length) { forget(stream, lineage); return { entries: out, verdict, replayed, noteBytes, record: null }; }
      const record = keep(stream, lineage, { runId, at, epoch, ttlMs: KEY_TTL_MS, entries: kept, bytes: size });
      return { entries: out, verdict, replayed, noteBytes, record };
    }

    function setTtl(record, ms) {
      if (record && typeof record === 'object' && typeof ms === 'number' && Number.isFinite(ms) && ms > 0) record.ttlMs = ms;
    }
    function stats() {
      let lineages = 0;
      for (const lines of streams.values()) lineages += lines.size;
      return { streams: streams.size, lineages, bytes };
    }
    function clear() { streams.clear(); bytes = 0; epochSeen = null; }

    return { plan, setTtl, stats, clear };
  }

  return { makeReplayLedger, DEFAULTS, KEY_TTL_MS, SUBSCRIPTION_TTL_MS };
});
