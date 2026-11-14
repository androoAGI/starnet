/* sidecar/slim-note.js — THE SLIM PER-RUN NOTE (cost lane, 2026-11-14). STARNET_SLIM_NOTE=1; off by default.

   Every message a person sends starts a run, and the run's first request carries the host's <run_context> note beside the
   newest user turn (index.js runOnceCore: the Task Brief, commander evidence, the run's skill index, [RUNTIME], the open
   quests). The note is new on every message, so no provider ever reads it from cache: its bytes are paid in full on
   every message, on every route. Measured through the real sidecar it was 2.4 to 3.1 KB a message on a station with
   nothing saved, and 4.6 to 5.9 KB on one with a dossier, saved skills and a quest. Some of those bytes buy nothing by
   riding there:

     1. THE SAME ASK, TWICE. The commander evidence lists recent activity from the context pack (contextpack.js), whose
        pool holds a finished task twice: once as its task brief's request ("X (today)") and once as the chat line that
        asked for it ("\"X\" (today)"). Both name the same transcript row. activityLines() keeps the first line of each
        row, which is the brief's: the whole request on one line (220 characters), where the chat line is its first line
        only (140). A line with no row behind it, and a pack that does not carry its sources, pass as they came. The
        block's own bounds are untouched (8 lines read, 6 shown, 180 characters each).

   The host reads the switch at one place (index.js slimNoteOn) and calls this module only when it is on. Pure: no
   clock, no fs, no env. */
'use strict';

// '1' (true, yes, on) is on; '0', anything else and unset are off
function on(value) { return /^(1|true|yes|on)$/i.test(String(value == null ? '' : value).trim()); }

/* activityLines(pack) -> the pack's recent-activity lines with a transcript row stated once.
   pack.activity is the pool with its sources ({ line, src: { streamId, runId, rowId } }), in the pool's order: completed
   task briefs first, then chat lines (contextpack.js assemble). pack.activityLines is the same pool as plain lines. */
function activityLines(pack) {
  const lines = pack && Array.isArray(pack.activityLines) ? pack.activityLines : [];
  const pool = pack && Array.isArray(pack.activity) ? pack.activity : null;
  // the two lists are one pool: anything else is not a pack this rule knows, so its lines pass as they came
  if (!pool || pool.length !== lines.length || pool.some((e, i) => !e || e.line !== lines[i])) return lines;
  const seen = new Set(), out = [];
  for (const e of pool) {
    const src = e.src;
    const row = src && src.streamId && Number.isSafeInteger(src.rowId) && src.rowId > 0 ? String(src.streamId) + '\u0000' + src.rowId : '';
    if (row && seen.has(row)) continue;
    if (row) seen.add(row);
    out.push(e.line);
  }
  return out;
}

module.exports = { on, activityLines };
