/* sidecar/slim-note.js — THE SLIM PER-RUN NOTE (cost lane, 2026-11-14). STARNET_SLIM_NOTE=1; off by default.

   Every message a person sends starts a run, and the run's first request carries the host's <run_context> note beside the
   newest user turn (index.js runOnceCore: the Task Brief, commander evidence, the run's skill index, [RUNTIME], the open
   quests). The note is new on every message, so no provider ever reads it from cache: its bytes are paid in full on
   every message, on every route. Measured through the real sidecar it was 2.4 to 3.1 KB a message on a station with
   nothing saved, and 4.6 to 5.9 KB on one with a dossier, saved skills and a quest. Two kinds of bytes in it buy nothing
   by riding there:

     1. THE SAME ASK, TWICE. The commander evidence lists recent activity from the context pack (contextpack.js), whose
        pool holds a finished task twice: once as its task brief's request ("X (today)") and once as the chat line that
        asked for it ("\"X\" (today)"). Both name the same transcript row. activityLines() keeps the first line of each
        row, which is the brief's: the whole request on one line (220 characters), where the chat line is its first line
        only (140). A line with no row behind it, and a pack that does not carry its sources, pass as they came. The
        block's own bounds are untouched (8 lines read, 6 shown, 180 characters each).

     2. TEXT THAT IS THE SAME ON EVERY MESSAGE. plan() takes paragraphs out of the note and hands them back as one text
        for the system prompt's per-conversation tail, which every route reads from cache:
          - the first-skill line an agent with no saved skills gets (skills/runtime.js emptyGuide), whole;
          - the quest how-to and the minting doctrine (questinject.js split), leaving the list of open quests, or the
            line saying there are none, in the note.
        Each is moved whole. The doctrine points at the quest list ("open quest above"), so it says where that list now
        is; those are the only words that differ. The saved-skill index keeps its own heading (it says "scan this skill
        index" and sits on the index), and nothing learned or recalled is touched.

   The host reads the switch at one place (index.js slimNoteOn) and calls this module only when it is on. Pure: no
   clock, no fs, no env. */
'use strict';
const QuestInject = require('./questinject.js');
const RuntimeSkills = require('./skills/runtime.js');

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

/* plan({ skills, quests }) -> { skills, quests, stable }
   The blocks as runOnceCore composed them (runtimeSkillBlock, questsBlock) go in; they come out without their constant
   paragraphs, and `stable` is those paragraphs as one text ('' when nothing moved), opening with a blank line like
   every block of the system prompt. A block this rule does not recognise comes back as it went in. */
function plan(blocks) {
  const b = blocks || {};
  let skills = b.skills == null ? '' : String(b.skills);
  let quests = b.quests == null ? '' : String(b.quests);
  const moved = [];
  if (RuntimeSkills.isEmptyGuide(skills)) { moved.push(skills.trim()); skills = ''; }
  const q = quests ? QuestInject.split(quests) : null;
  if (q) { moved.push(q.guide); quests = q.list; }
  return { skills, quests, stable: moved.length ? '\n\n' + moved.join('\n\n') : '' };
}

module.exports = { on, activityLines, plan };
