/* sidecar/cross-run-replay.js — CROSS-RUN REPLAY (W1.8, cost plan 2026-11-08).

   A run that continues a conversation replays its earlier runs from the durable transcript in the 'pairs' shape (calls and their
   results), and three paths do it: the terminal CLI's resume seed (one user message and a streamId: index.js runOnceCore), the
   queued re-seed (a turn that waited behind its stream's run, or a coordinated worker's: index.js runOnceQueued, turn-window.js
   reseed) and channel history (a chat's whole stream since /new: channels/history-port.js replay). Each of them carried every
   earlier tool result WHOLE on every later message: a 20,000-character file read cost ~5.6k tokens on every follow-up for the
   rest of the conversation, and a channel chat, which had no window at all, grew quadratically (every round re-sent every
   earlier round's output).

   ONE RESOLVER for the three, at the one seam they share: runOnceCore, after the replayed-taint proof has read the replay as it
   came, before the earlier-conversation note places the window. It acts only on messages a 'pairs' view shaped (TurnView
   replayedOf: the row each stands on and the row's own word on itself), so the run's new directive, a page's posted window and a
   recovery checkpoint (never resolved: index.js) are untouched.

   1. AN EARLIER RESULT RIDES AS A HEAD AND A HANDLE. A replayed tool result over the 240-character head becomes the stub
      history-edit.js elideToolResult builds (W1.7, the one stub/handle builder: never a second format): the head, the byte
      count and an fs.read call naming a file that gives the replayed bytes back. The file is parked by its BYTES (the host parker
      in replay mode, index.js capCtx.parkOutput: `[untrusted-]<tool>-replay-<16 hex of sha256>` in the agent's .output, written
      once by outputArtifacts.parkOnce), so the same body names the same file on every later request and in every later run: the
      stub is the same bytes each time, the cached prefix behind it holds, and nothing is written twice.
   2. PROVENANCE IS THE ROW'S. A replayed result has no tool origin (loop.js toolOrigin lives one run), so the row's own stored
      word decides, read by the store's one rule (transcriptstore rowTaint):
      - TAINT. A row stamped with a source, or with no provenance at all (unverifiable = tainted), is parked as untrusted-*, and an
        fs.read of an untrusted park latches taint (taint.js isUntrustedSource), so following the handle in a later run is reading
        the source again. The bare attachment stamp decays here exactly as it does in transcriptStore.taintOf (its bytes are not
        in a tool result's row). The replaying run's own taint is not the row's and is never used: it would give the same bytes
        another name in another run. The replayed-taint proof is untouched (it runs first, and matches a result by its call id).
      - QUOTED WORDS ARE NEVER PARKED. The result of a quoting tool (recall_conversation, session.peek), a result on a row stamped
        with the sessions its run had read (row quotes), and a result whose call the replay does not hold (no tool name, nothing
        to rule it out) get the stub with the old wording ("re-run the tool for the full output") and no handle: a workspace file
        would outlive a forget of the quoted session, while the row itself (and with it the stub) is hidden by the forget rule.
        The same no-handle stub stands when a park fails or the file at the content name holds other bytes.
   3. INSIDE A ROW AND TOKEN WINDOW. The replayed block is fitted the way the page fits its own window (frontend/app/historyfit.js:
      the newest HISTORY_CAP messages, the wire byte cap, then uncalibratedBudget of the run's window at the fold share), measured
      on the stubs it will send. A cut lands on a user turn, so no result is ever left without its call, and moves in STEPS: it
      starts at the first user turn at or after the next multiple of a quarter of the row cap, counted from the first replayed
      message, so the window's first message (and the cached prefix behind it) stays put for many turns instead of sliding every
      turn. What a cut leaves out is carried by the earlier-conversation note (index.js), as for the page's own window.

   KILL SWITCH: STARNET_CROSS_RUN_REPLAY=0 (index.js) replays every earlier result whole and unwindowed, as before.
   Pure apart from the injected parker. */
'use strict';
const HistoryEdit = require('./history-edit.js');
const TurnView = require('./turn-view.js');
const Fit = require('../frontend/app/historyfit.js');
const { rowTaint } = require('./transcriptstore.js');
const { ATTACHMENT_TAINT } = require('./taint.js');

const STEP_SHARE = 0.25;   // a cut moves in steps of a quarter of the row cap (30 messages of the 120)
// tools whose result is another session's words (wire names: dots become underscores on every provider)
const QUOTING_TOOLS = new Set(['recall_conversation', 'session_peek']);
const wireName = name => String(name || '').replace(/\./g, '_');

// the row's own word on a replayed result: { tool, taintedBy (a source, or null for a clean row), quoted }
function provenanceOf(tag) {
  let taintedBy = rowTaint(tag);
  if (taintedBy && ATTACHMENT_TAINT && taintedBy === ATTACHMENT_TAINT) taintedBy = null;
  const tool = wireName(tag && tag.tool);
  return { tool, taintedBy, quoted: !!(tag && tag.quoted === true) || !tool || QUOTING_TOOLS.has(tool) };
}

// a copy keeps the original's off-wire marks (the replay tag, a row tag): they are non-enumerable, so a spread drops them
function carryMarks(from, to) {
  for (const key of Object.getOwnPropertySymbols(from)) {
    const d = Object.getOwnPropertyDescriptor(from, key);
    if (d && !d.enumerable) Object.defineProperty(to, key, d);
  }
  return to;
}

// one replayed result -> { message, saved } (the stub, and whether it names a file) or null (the head keeps it whole)
async function stubOf(m, tag, o) {
  const p = provenanceOf(tag);
  const meta = {};
  if (p.quoted) meta.quotedStreams = ['*'];   // elideToolResult never parks quoted words (nor does the host parker)
  if (p.taintedBy) meta.taintedBy = p.taintedBy;
  const stub = await HistoryEdit.elideToolResult(m.content, { name: p.tool || 'tool', park: p.quoted ? null : o.park, parkMeta: meta });
  if (!stub) return null;
  return { message: carryMarks(m, Object.assign({}, m, { content: stub.content })), saved: !!stub.handle };
}

/* where a cut starts in the replayed block: the first user turn at or after `from`, moved on to the first one at or after the
   next step mark (a multiple of `step` messages from the block's start) when there is one, so it changes only when the fit
   passes a mark. block.length = nothing of the block fits. */
function startOf(block, from, step) {
  if (from <= 0) return 0;
  const userFrom = at => { for (let i = at; i < block.length; i++) if (block[i] && block[i].role === 'user') return i; return -1; };
  const marked = userFrom(Math.ceil(from / step) * step);
  if (marked >= 0) return marked;
  const first = userFrom(from);
  return first >= 0 ? first : block.length;
}

/* resolve(list, o) -> Promise<{ messages, stubbed, saved, dropped }>
   list          the run's conversation before the system prompt (index.js convo): leading system messages, the replayed
                 block, the new directive. Returned as it is when no message of it was replayed.
   o.park        async (text, meta) -> { path } | null: the host parker in replay mode (index.js capCtx.parkOutput)
   o.limit       the run's context window in tokens (index.js ctxMgr.contextLimit); absent = no token fit
   o.compactAt   the share of it the run folds at (context.js RUN_CONTEXT_DEFAULTS.compactAt)
   o.rows        the row cap (default: historyfit HISTORY_CAP, the page's)
   o.note        (tag, error) -> void, for a result that could not be stubbed (it rides whole: fail open)
   messages keeps the input's row ids (TurnView.ROW_IDS) for what it keeps. stubbed: results cut to a stub; saved: those whose
   stub names a file; dropped: replayed messages the window left out. Only the first run of replayed messages is windowed, and
   only when nothing replayed follows it; a result anywhere is stubbed. */
async function resolve(list, o) {
  o = o || {};
  const src = Array.isArray(list) ? list : [];
  const tags = src.map(m => TurnView.replayedOf(m));
  const lo = tags.findIndex(Boolean);
  if (lo < 0) return { messages: list, stubbed: 0, saved: 0, dropped: 0 };
  let hi = lo;
  while (hi + 1 < src.length && tags[hi + 1]) hi++;
  const windowed = !tags.slice(hi + 1).some(Boolean);
  const blockLen = hi - lo + 1;
  const rowCap = Math.max(1, Math.floor(Number(o.rows) || Fit.HISTORY_CAP));
  const step = Math.max(1, Math.floor(rowCap * STEP_SHARE));
  // the row cap needs no stub to count: nothing before it is stubbed
  let from = windowed ? Math.max(0, blockLen - rowCap) : 0;
  const replaced = new Map();   // index -> { message, saved }
  for (let i = windowed ? lo + from : 0; i < src.length; i++) {
    const m = src[i], tag = tags[i];
    if (!tag || !m || m.role !== 'tool' || HistoryEdit.isElided(m)) continue;
    try {
      const stub = await stubOf(m, tag, o);
      if (stub) replaced.set(i, stub);
    } catch (error) { if (typeof o.note === 'function') o.note('turn.replay.stub', error); }
  }
  const sent = i => replaced.has(i) ? replaced.get(i).message : src[i];
  let start = 0;
  if (windowed) {
    // the byte and token fit, on what will be sent; what follows the block (the directive) is never cut
    const tail = [];
    for (let i = lo + from; i < src.length; i++) tail.push(sent(i));
    let kept = Fit.fitHistoryBytes(tail, Fit.HISTORY_WIRE_MAX_BYTES).length;
    const limit = Number(o.limit);
    if (limit > 0) kept = Fit.fitHistoryTokens(tail.slice(tail.length - kept), Fit.uncalibratedBudget(limit, o.compactAt)).length;
    from = Math.max(from, blockLen - Math.max(0, kept - (src.length - hi - 1)));
    start = startOf(src.slice(lo, hi + 1), from, step);
  }
  const keep = [];
  for (let i = 0; i < src.length; i++) if (i < lo || i >= lo + start) keep.push(i);
  const out = keep.map(sent);
  const ids = src[TurnView.ROW_IDS];
  if (Array.isArray(ids)) Object.defineProperty(out, TurnView.ROW_IDS, { value: keep.map(i => ids[i]), enumerable: false });
  let stubbed = 0, saved = 0;
  for (const i of keep) if (replaced.has(i)) { stubbed++; if (replaced.get(i).saved) saved++; }
  return { messages: out, stubbed, saved, dropped: start };
}

module.exports = { resolve, provenanceOf, QUOTING_TOOLS, STEP_SHARE, _internals: { startOf, stubOf, carryMarks } };
