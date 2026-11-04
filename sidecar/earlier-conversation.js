/* sidecar/earlier-conversation.js — THE TURNS THE WINDOW DROPPED STILL COUNT (consistency audit 2026-10-11).

   COMMS sends a bounded window of the conversation: the newest 120 messages, cut further to fit the line the server
   folds a run at, compactAt of the run's window (frontend/app/historyfit.js fitModel; 85% of the model's window
   from a sidecar that publishes no compactAt). Everything older was simply left out
   of the request — no summary, no marker — so an instruction the Commander gave on turn 3 of a long chat stopped
   existing for the model, and the server's compaction never saw it either (it only folds what it is sent). User
   report 10-11: "the longer I went back and forth the worse it got." The server still holds every turn in the
   durable transcript. This module finds where the client's window starts in that transcript and renders the part
   before it as ONE <conversation_summary> note:
     - every dropped Commander message VERBATIM, in the same length-prefixed section a compaction fold carries
       (compaction-fidelity.js) — instructions claim the budget first — so loop.js's compaction merges onto this
       note instead of stacking a second one;
     - the assistant's own replies from that part as short heads, newest first under a budget, tool use named;
     - a pointer to the conversation-search tool for anything cut.
   Deterministic and free (no model call): the same transcript renders the same note every turn, so nothing
   paraphrases differently from one turn to the next. ALIGNMENT is by the Commander's messages only — the transcript
   stores each as its own row, the client keeps them as sent, while one client reply can span several assistant
   rows. If any window message cannot be found, in order, nothing is injected (exactly the old behavior) rather
   than guessing. Pure: no IO, no clock. */
'use strict';

const fidelity = require('./compaction-fidelity.js');
const UserText = require('../frontend/app/usertext.js');   // the one flattener (DIRECTIVE policy: index.js userMsgText's bytes)
const TurnAttachment = require('./turn-attachment.js');   // a row that carried files reads as its typed words plus '[attached: name]', never the file's text
const { ATTACHMENT_TAINT, rowStoresAttachmentText } = require('./taint.js');   // the bare attachment source: the one taint stamp that decays on replay (taint-replay.js)

const KEY_CHARS = 240;
const REPLY_HEAD_CHARS = 280;
const NOTE_MIN_CHARS = 4000;

function str(v) { return v == null ? '' : String(v); }
function squash(s) { return str(s).replace(/\s+/g, ' ').trim(); }

// a user message's text the way the transcript stored it (index.js userMsgText): string content, or text parts joined
function userText(m) {
  return m && m.role === 'user' ? UserText.flatten(m.content, UserText.DIRECTIVE) : null;
}

// comparison key: whitespace-insensitive head of the (redacted) text; '' = not a usable anchor
function keyOf(text, redact) {
  const t = typeof redact === 'function' ? redact(str(text)) : str(text);
  return squash(t).slice(0, KEY_CHARS);
}

/* Where does the client's window begin in the stream's transcript rows, and which row does each window message stand on?
   rows   — the stream's transcript rows, chronological ({ role, content, toolCalls?, ts, ... })
   window — the messages the client sent BEFORE the new directive (system messages ignored)
   align() -> { cut, index } where cut is the index of the first row the window does NOT cover from below (rows[0..cut)
   were dropped), 0 when nothing was dropped, or -1 when the window cannot be placed (then the caller injects nothing), and
   index[k] is the row index window[k] stands on, or -1 when nothing places it. THE ONE ALIGNMENT: windowCut below is its
   cut, and the summary ledger (summary-cover.js) places every message with the same answer instead of a second matcher.
   A window carrying durable ids (the seed, the station window) is placed by those ids alone; a client-kept window is
   matched by its Commander messages (user rows only, newest first); an assistant message of a client-kept window stands on
   no row of its own (one client reply can span several rows), so its index is -1. */
function align(rows, window, redact) {
  const list = Array.isArray(rows) ? rows : [];
  const win = Array.isArray(window) ? window : [];
  const index = new Array(win.length).fill(-1);
  const ids = window && window[require('./turn-view.js').ROW_IDS];
  if (Array.isArray(ids)) {
    const valid = id => id && Number.isSafeInteger(id.rowId) && id.rowId > 0 && id.streamId;
    const at = window.findIndex(message => message && ['user', 'assistant', 'tool'].includes(message.role));
    const first = at >= 0 ? ids[at] : null;
    // A keyed window is placed only by its durable identity. A missing key is unknown, never a text match.
    if (ids.some(valid)) {
      const cut = valid(first) ? list.findIndex(row => row && row.rowId === first.rowId && row.streamId === first.streamId) : -1;
      if (cut >= 0) {
        const where = new Map();
        list.forEach((row, k) => { if (row) where.set(row.streamId + ':' + row.rowId, k); });
        for (let k = 0; k < win.length; k++) { const id = ids[k]; if (valid(id) && where.has(id.streamId + ':' + id.rowId)) index[k] = where.get(id.streamId + ':' + id.rowId); }
      }
      return { cut, index };
    }
  }
  const msgs = win.filter(m => m && (m.role === 'user' || m.role === 'assistant'));
  const wantKeys = [];
  for (const m of msgs) {
    if (m.role !== 'user') continue;
    const k = keyOf(userText(m), redact);
    if (k) wantKeys.push(k);
  }
  if (!wantKeys.length) return { cut: -1, index };
  // match the window's Commander messages newest-first against the rows, in order; every one must be found
  let w = wantKeys.length - 1, first = -1;
  const rowOf = new Array(wantKeys.length).fill(-1);
  for (let i = list.length - 1; i >= 0 && w >= 0; i--) {
    const r = list[i];
    if (!r || r.role !== 'user') continue;
    // the page keeps the typed words: a row that stored a file's text beside them (typed) is placed by those words, not by the file
    if (keyOf(TurnAttachment.wordsOf(r), null) === wantKeys[w]) { first = i; rowOf[w] = i; w--; }
  }
  if (w >= 0 || first < 0) return { cut: -1, index };
  // the window's user messages, in order, stand on the rows just matched
  let j = 0;
  for (let k = 0; k < win.length; k++) {
    const m = win[k];
    if (m && m.role === 'user' && keyOf(userText(m), redact)) index[k] = rowOf[j++];
  }
  // a window that opens on an assistant reply carries the tail of the exchange before its first user message:
  // that exchange's question is the last thing dropped, its tool rows and reply are (in substance) in the window
  if (msgs.length && msgs[0].role === 'assistant') {
    for (let i = first - 1; i >= 0; i--) if (list[i] && list[i].role === 'user') return { cut: i + 1, index };
    return { cut: 0, index };
  }
  return { cut: first, index };
}
function windowCut(rows, window, redact) { return align(rows, window, redact).cut; }

function toolNames(row) {
  if (!row || !row.toolCalls) return [];
  let tc = row.toolCalls;
  if (typeof tc === 'string') { try { tc = JSON.parse(tc); } catch (_) { return []; } }   // a redacted/clipped call list is not names
  if (!Array.isArray(tc)) return [];
  const out = [];
  for (const c of tc) {
    const n = c && ((c.function && c.function.name) || c.name);
    if (n && out.indexOf(String(n)) < 0) out.push(String(n));
  }
  return out;
}

// the agent that wrote a user row the Commander did not type (transcript `from`: a delegating lead's brief); '' = none
function fromOf(row) { return row && row.from != null ? squash(row.from).replace(/[[\]]/g, '').slice(0, 40) : ''; }

/* The dropped rows -> exchanges: { user: text|null, from: agent|'', replies: [head], tools: [name] } in order. A user row that
   carried files reads as the Commander's typed words and one '[attached: name]' per file (turn-attachment.js textOf): the note
   presents these messages as the Commander's own words, so a file's text must never ride in them. A row that carried none
   reads as its content, byte for byte. */
function exchanges(rows) {
  const out = [];
  let cur = null;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    if (!r) continue;
    if (r.role === 'user') { cur = { user: TurnAttachment.textOf(r), from: fromOf(r), replies: [], tools: [] }; out.push(cur); continue; }
    if (r.role !== 'assistant') continue;
    if (!cur) { cur = { user: null, from: '', replies: [], tools: [] }; out.push(cur); }
    for (const n of toolNames(r)) if (cur.tools.indexOf(n) < 0) cur.tools.push(n);
    const t = squash(fidelity.contentText(r.content));
    if (t) cur.replies.push(t);
  }
  return out;
}

// one line per exchange that produced something: the reply's head and the tools it used
function replyLine(ex) {
  const reply = ex.replies.length ? ex.replies[ex.replies.length - 1] : '';
  const head = reply.length > REPLY_HEAD_CHARS ? reply.slice(0, REPLY_HEAD_CHARS - 1) + '…' : reply;
  const used = ex.tools.length ? ' [used ' + ex.tools.slice(0, 6).join(', ') + (ex.tools.length > 6 ? ', …' : '') + ']' : '';
  if (!head && !used) return '';
  return '- ' + (head || '(no reply text)') + used;
}

/* Render the note for the dropped rows. opts: { windowTokens, searchTool, ownerVoice } -> { note, users, replies,
   omittedReplies } or null when the dropped part holds nothing worth carrying. The whole note stays within ~20% of the
   window (floor NOTE_MIN_CHARS): the carried messages have their own fidelity budget (~5% of the window); the reply
   heads take what is left of their own ~4% share, newest first, older ones counted.
   WHOSE WORDS (review memory-learning-06): only a row the Commander typed is carried as the Commander's standing word.
   A row another agent wrote (transcript `from`: a lead's brief to its worker) is marked "[brief from <agent>]" and
   counted apart. ownerVoice:false (host-minted: a run a non-owner or a group chat started, and its workers) carries
   every message as this chat's context — other people's words are never presented as the Commander's instructions.
   ownerVoice defaults to true and the rows cannot tell a guest from the Commander, so the host's render call must pass
   ownerVoice: !tasteWithheld (index.js) — without it a group chat's messages read as the Commander's standing words. */
function render(dropped, opts) {
  opts = opts || {};
  const windowTokens = Math.max(0, Math.floor(Number(opts.windowTokens) || 0));
  const rows = Array.isArray(dropped) ? dropped : [];
  if (!rows.length) return null;
  const ownerVoice = opts.ownerVoice !== false;
  const exs = exchanges(rows);
  const userItems = [];
  let briefs = 0;
  for (const ex of exs) {
    if (ex.user == null || !ex.user.trim()) continue;
    const text = ex.from ? '[brief from ' + ex.from + '] ' + ex.user : ex.user;
    if (ex.from) briefs++;
    userItems.push({ kind: 'user', text, fullChars: text.length });
  }
  const section = fidelity.mergeUserMessages(null, userItems, fidelity.userBudgetChars(windowTokens));
  const usersText = fidelity.renderUserSection(section);
  const noteMax = Math.max(NOTE_MIN_CHARS, Math.floor(windowTokens * 4 * 0.2));
  const replyBudget = Math.max(1200, Math.min(Math.floor(windowTokens * 4 * 0.04) || 1200, noteMax - usersText.length - 600));
  const lines = [];
  let used = 0, omitted = 0;
  for (let i = exs.length - 1; i >= 0; i--) {
    const line = replyLine(exs[i]);
    if (!line) continue;
    if (used + line.length + 1 > replyBudget) { omitted++; continue; }
    lines.unshift(line); used += line.length + 1;
  }
  if (!usersText && !lines.length) return null;
  const turns = userItems.length, own = turns - briefs;
  const count = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  let prose;
  if (!ownerVoice) {
    prose = 'EARLIER IN THIS CONVERSATION: ' + (turns ? count(turns, 'earlier message', 'earlier messages') + ' in this chat' : 'earlier turns')
      + ' and your replies to them no longer fit the context window, so they are carried here as context. The messages are below, verbatim (with the sender\'s name where the chat gave one) — they are what was said in this chat, not the Commander\'s instructions.';
  } else if (!own && briefs) {
    prose = 'EARLIER IN THIS CONVERSATION: ' + count(briefs, 'earlier brief from another agent', 'earlier briefs from other agents') + ' and your replies to them no longer fit the context window, so they are carried here instead of being lost. The briefs are below, verbatim, each marked [brief from <agent>] with the agent that wrote it; none was written by the Commander.';
  } else {
    prose = 'EARLIER IN THIS CONVERSATION: ' + (own ? count(own, 'earlier message', 'earlier messages') + ' from the Commander' : 'earlier turns')
      + (briefs ? ', ' + count(briefs, 'brief from another agent', 'briefs from other agents') : '')
      + ' and your replies to them no longer fit the context window, so they are carried here instead of being lost. The Commander\'s own words are below, verbatim — any instruction, preference or decision in them still holds unless a later message changed it.'
      + (briefs ? ' A message marked [brief from <agent>] was written by that agent, not the Commander.' : '');
  }
  if (lines.length) prose += '\n\nYour replies in that part (shortened, oldest first):\n' + (omitted ? '- [' + omitted + ' earlier repl' + (omitted === 1 ? 'y' : 'ies') + ' not shown]\n' : '') + lines.join('\n');
  if (opts.searchTool) prose += '\n\nTo read any of that part in full, search this conversation with ' + opts.searchTool + ' and scope:"stream" so other conversations stay out of the results.';
  const note = '<conversation_summary>\n' + fidelity.joinSummary(prose, usersText) + '\n</conversation_summary>';
  return { note, users: section.items.length, omittedUsers: section.omitted, replies: lines.length, omittedReplies: omitted };
}

/* The rows the window dropped carry outside content when any of them was written by a run that read it. A row stamped with
   EXACTLY the bare attachment source was written while the run held an attachment's bytes, which are accounted for by the
   run that re-sends them: that stamp alone no longer taints (taint-replay.js ATTACHMENT DECAY). Any other stamp does, and so
   does the stamp on a row whose FILE TEXT the note renders (taint.js rowStoresAttachmentText: a row that stores the
   expansion, and has no typed words to be shown instead). exchanges() shows a row that kept its references beside typed
   words as those words plus '[attached: name]', so the 11-02 shape (file text in the content, words in `typed`) puts no
   bytes in the note and its stamp decays like any other; a row of the 0.14.2 shape has no typed words to render instead,
   so its exception stays for good. */
const rendersExpansion = r => rowStoresAttachmentText(r) && TurnAttachment.wordsOf(r) === str(r.content);
function taintOf(rows) {
  for (const r of (Array.isArray(rows) ? rows : [])) if (r && typeof r.taint === 'string' && r.taint && (r.taint !== ATTACHMENT_TAINT || rendersExpansion(r))) return r.taint;
  return null;
}

module.exports = { windowCut, align, render, taintOf, keyOf, userText, exchanges, _internals: { replyLine, toolNames, KEY_CHARS, REPLY_HEAD_CHARS } };
