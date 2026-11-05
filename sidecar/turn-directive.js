/* sidecar/turn-directive.js — WHICH turn a run answers, and whether it reuses that turn's directive (turn-identity, commit 3).

   Every surface that takes a turn names it with a turnId (TurnKinds grammar): the desk page mints one per optimistic row, the
   phone host 'ph' + runId, the channel hub one per inbox receipt, the station 'r' + runId for everything else. A resend or a
   retry of a turn carries the same turnId, so the station can find the directive it already wrote and reuse it instead of
   filing the Commander's words twice (bug b30c1c8e: a retry after keys.save wrote a second user row, because the old check
   compared the stored, key-named text with the request's redacted text byte for byte).

   Pure over its arguments: the transcript store, the run's options and injected callbacks. No clock, no fs.

     turnOf(o, runId)                        the ONE resolver of a run's turnId. A recovery continuation answers its consumed
                                             SOURCE turn (o.recovery.sourceTurnId, else 'r' + sourceRunId) and ignores any
                                             turnId/retryOf the page sent; an internal, outputOnly or streamless run never
                                             reuses a directive, so it takes its own mint and ignores a supplied one; any
                                             other run takes a valid o.turnId, else its own mint ('r' + runId)
     reuseByTurn(store, o)                   the EARLY read (index.js, right after turnOf): findTurn for a SUPPLIED turnId.
                                             null without a read for a streamless, internal or recovery run, an invalid
                                             turnId, or one this run minted itself. 'found' by the same agent -> the result;
                                             found by another agent, or 'unknown' (the station cannot place the turn) ->
                                             o.rekey('r' + runId) and null: the run answers as a new turn under its own id,
                                             and the earlier directive never gets a second copy (Q21: re-key, nothing is
                                             refused); 'absent' -> null (a new directive under the supplied turnId)
     reuse(store, o)                         the LATE check (index.js, at the retry block, post-expansion): a found
                                             directive is reused only when the request's words match it key-blind;
                                             otherwise o.rekey('r' + runId) and null. Never throws
     keyBlind(text)                          text with every placeholder the store's redaction emits and every saved-key
                                             label (KeyTools.keyPlaceholder) replaced by one token, whitespace collapsed
     echo(runStartExtra, runTranscript, reused, noteIdentity, noteBrief)
                                             after the directive write: run.start's directiveRowId (the written directive,
                                             else the reused one) and the run record's { turnId, directiveRowId }
                                             (runStore.noteIdentity); noteBrief(rowId), when given, records that row on the
                                             run's task brief (taskBriefStore.noteDirective; a rejection is noted)
     startFields(runStartExtra)              { turnId, directiveRowId } for the lead's own agent.run.start
     interruptedIdentity(meta, store, state) an interrupted run's record identity from its journal: { turnId } plus the
                                             directive's rowId when findTurn's recent or run-rows rungs find it, and the sessions it read
                                             (state.quotes: quotes + quotesAt, quotesSaturatedAt once saturated)
     quoteIdentityOf(entries) / journalQuoteIdentity(state)   a run's quote stamp as its record's fields
     quoteRefusal(result, cause)             the host notice that replaces a read drawn on a session deleted in flight ('deleted') or past the
                                             run's capacity ('overflow'): hostAuthored, isError, none of the read's words

   THE DIRECTIVE IS CAPTURED ONCE, BEFORE EXPANSION (commit 4; bug e7dcb889). runOnceCore reads the newest user message
   before attachments.expandForRun turns its files into text, so every reader of "what the Commander asked" reads the same
   words: never a file's bytes, never the loop's screen-capture turn, never a repair prompt.
     capture(messages, { typedDirective, turnId, recovery })
                                             { text, label, attachments, turnId, typedTitleSource, captured: true }, or
                                             null when there is no user message to read (an internal system-only run, an
                                             assistant-only body). text = the message's own words (UserText DIRECTIVE);
                                             label = '[image: name]' / '[file: name]' per attachment, joined ', ' (<= 600), each
                                             name through the one rule (attachment-name.js; turn-attachment.js labelOf);
                                             attachments = bounded refs (the transcript store's own rule). A recovery
                                             continuation's directive is its SOURCE's title ({ recovered: true }); one
                                             with no title is null (the trunk path reads the recovered prompt)
     typedText(d)                            the typed words only ('' for null): KeyTools.ownerRun, learning's hand-off
     wording(d)                              the one wording: non-blank text, else the label ('' for null)
     row(d, contentBytes, kind)              setDirective's argument: { text, typed, attachments, kind }; contentBytes
                                             itself for null (the trunk string path). A directive that carries attachments
                                             is written CLEAN: text is the captured wording (the typed words, else the
                                             label), never contentBytes, which holds the files' expanded text; the file
                                             rides as an attachment row beside it (sidecar/turn-attachment.js). A directive
                                             without attachments keeps the trunk bytes exactly. When the wording is only the
                                             label the row also says labelOnly: true, and the run transcript stamps it
     labelOnly(d)                            a directive with no typed words whose whole wording is the label of its files
                                             (the names, a third party's text): not the Commander's words, so its row is never
                                             a clean owner row and its run is recorded wordless (index.js)
     install(runTranscript, d, contentBytes, kind, report, reused)
                                             the ONE decision of what a run writes for its directive: a new directive is
                                             row(...) plus the attachment rows of its references (report = attachments.resentOf,
                                             for each file's size and sha256); a REUSED directive (a retry or resend answering
                                             the turn's existing row) writes none of its own and hands the run the references'
                                             attachment rows instead, because a retry retracts the old ones
     title(d, runDirective) / runTitle(source, keys) / interruptedTitle(meta, keys)
                                             a run's title source (runDirective only for a null capture), scrubbed and
                                             key-named the one way (PromptScrub.scrubStored(KeyTools.nameSavedKeys(…)))
     packet(d, { redact, keys, row })        { rowId, text } for the verdict packet, golden and feedback: the wording,
                                             key-named and redacted (the SAFE form); rowId from `row` (the written or
                                             reused directive); null for a null capture

   Counted (failopen tags, ids only, never text): turn.recovery.ids-ignored, turn.id-ignored, turn.reuse.conflict.agent,
   turn.reuse.conflict.input, turn.reuse.horizon. */
'use strict';
const TurnKinds = require('../frontend/app/turnkinds.js');
const UserText = require('../frontend/app/usertext.js');
const KeyTools = require('./tools/builtin/keys.js');
const PromptScrub = require('./prompt-scrub.js');
const TurnAttachment = require('./turn-attachment.js');
const { rowStoresAttachmentText } = require('./taint.js');
const { note: failNote } = require('./failopen.js');

const count = (tag, what) => failNote(tag, new Error(what));
const posInt = v => Number.isSafeInteger(v) && v > 0;
const supplied = v => v !== undefined && v !== null && v !== '';

function turnOf(o, runId) {
  const opts = o || {};
  const own = TurnKinds.runTurnId(runId);
  if (opts.recovery) {
    const src = opts.recovery;
    if (supplied(opts.turnId) || supplied(opts.retryOf)) count('turn.recovery.ids-ignored', 'run ' + String(runId || '') + ' answers its recovery source; the page ids were ignored');
    if (TurnKinds.isTurnId(src.sourceTurnId)) return src.sourceTurnId;
    return TurnKinds.runTurnId(src.sourceRunId) || own;
  }
  if (opts.internal || opts.outputOnly || !opts.streamId) {
    if (supplied(opts.turnId)) count('turn.id-ignored', 'run ' + String(runId || '') + ' cannot reuse a directive; it keeps its own turn id');
    return own;
  }
  return TurnKinds.isTurnId(opts.turnId) ? opts.turnId : own;
}

function reuseByTurn(store, o) {
  const a = o || {};
  if (!a.streamId || a.internal || a.recovery) return null;
  if (!TurnKinds.isTurnId(a.turnId) || TurnKinds.ownMint(a.turnId, a.runId)) return null;
  if (!store || typeof store.findTurn !== 'function') return null;
  const own = TurnKinds.runTurnId(a.runId);
  const rekey = () => { if (own && typeof a.rekey === 'function') a.rekey(own); };
  let found;
  try { found = store.findTurn(String(a.streamId), a.turnId, { turnAt: a.turnAt, turnRowId: a.turnRowId }); }
  catch (e) { failNote('turn.findTurn', e); found = { state: 'unknown' }; }
  const state = found && found.state;
  if (state === 'absent') return null;
  if (state === 'found' && found.directive) {
    if (String(found.directive.agentId || '') === String(a.agentId || '')) return found;
    count('turn.reuse.conflict.agent', 'run ' + String(a.runId || '') + ': the turn belongs to another agent; re-keyed');
    rekey();
    return null;
  }
  count('turn.reuse.horizon', 'run ' + String(a.runId || '') + ': the station cannot place the turn; re-keyed');
  rekey();
  return null;
}

// every placeholder the store's redaction writes (sidecar/context.js) and every saved-key label (keys.js keyPlaceholder)
const BLIND_RE = /\[redacted-(?:key|secret|token|jwt|private-key)\]|\[[^\[\]\n]{1,120} saved in API KEYS\]/g;
function keyBlind(text) {
  return String(text == null ? '' : text).replace(BLIND_RE, '\u0000').replace(/\s+/g, ' ').trim();
}

// the request's words in the store's own form: key-named, then redacted
function storedForm(text, a) {
  const named = KeyTools.nameSavedKeys(text, a.keys);
  return typeof a.redact === 'function' ? a.redact(named) : named;
}
function refIds(list) {
  return (Array.isArray(list) ? list : []).map(r => String((r && (r.id || r.path)) || '')).sort().join('\u0000');
}
// the key-blind input check: a row that carries `typed` (the redacted wording) is compared on it, any other row on its
// content (trunk's basis: the expanded words, or the label of a captionless turn); a row that names attachments also
// needs the same attachment ids. A row that keeps attachment references and no `typed` is the CLEAN directive (row() below):
// its content IS the captured wording, so it is compared on that, never on the expanded text of the request (which holds the
// files' bytes). A null capture never matches (the turn's words are unknown: an input conflict).
function sameInput(row, a) {
  const d = a.directive;
  if (!d) return false;
  if (Array.isArray(row.attachments) && refIds(row.attachments) !== refIds(d.attachments)) return false;
  if (row.typed != null) return keyBlind(row.typed) === keyBlind(storedForm(wording(d), a));
  if (Array.isArray(row.attachments) && row.attachments.length && Array.isArray(d.attachments) && d.attachments.length) return keyBlind(row.content) === keyBlind(storedForm(wording(d), a));
  const latest = typeof a.latestUserText === 'function' ? a.latestUserText(a.messages) : '';
  return keyBlind(row.content) === keyBlind(storedForm(latest || d.label || '', a));
}

function reuse(store, o) {
  const a = o || {};
  const found = a.found;
  if (!found || found.state !== 'found' || !found.directive) return null;
  const row = found.directive;
  if (sameInput(row, a)) {
    if (a.retryOf === row.turnId && TurnKinds.isTurnId(row.turnId)) {
      let result;
      try {
        result = store && typeof store.retract === 'function' ? store.retract({ streamId: a.streamId, agentId: a.agentId,
          turnId: row.turnId, directiveRowId: row.rowId, runId: a.runId, reason: 'retry' }) : null;
      } catch (error) {
        // A failed strict write is a persistence failure, never evidence of a different turn. The
        // host must settle this failure before any fallback or provider call; reuse itself stays no-throw.
        failNote('turn.retract.persist', error);
        if (typeof a.onRetractFailure === 'function') a.onRetractFailure(error);
        return null;
      }
      if (!result || result.state !== 'done') {
        count('turn.reuse.horizon', 'run ' + String(a.runId || '') + ': retract targets are unproven; re-keyed without mutation');
        const own = TurnKinds.runTurnId(a.runId);
        if (own && typeof a.rekey === 'function') a.rekey(own);
        return null;
      }
    }
    return row;
  }
  count('turn.reuse.conflict.input', 'run ' + String(a.runId || '') + ': the words differ from the turn\'s directive; re-keyed');
  const own = TurnKinds.runTurnId(a.runId);
  if (own && typeof a.rekey === 'function') a.rekey(own);
  return null;
}

/* ---- the directive, captured once before expansion (commit 4) ---- */
const ATTACH_MAX = 16;
const REF_LIMITS = [['id', 64], ['name', 200], ['path', 300], ['mediaType', 100], ['kind', 20]];   // transcriptstore attachmentRefs
// the newest user message a run can read: its content flattens, or it carries attachments (latestUserText's walk)
function newestUser(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    if (UserText.flatten(m.content, UserText.DIRECTIVE) != null || (Array.isArray(m.attachments) && m.attachments.length)) return m;
  }
  return null;
}
// the label of a turn sent with no words: '[file: name]' per attachment, the names through the one rule (turn-attachment.js labelOf)
const labelOf = atts => TurnAttachment.labelOf(atts);
function refsOf(atts) {
  const out = [];
  for (const a of atts) {
    if (out.length >= ATTACH_MAX) break;
    if (!a || typeof a !== 'object' || typeof a.path !== 'string' || a.path.indexOf('.attachments/') !== 0) continue;
    const ref = {};
    for (const [k, max] of REF_LIMITS) { const v = typeof a[k] === 'string' ? a[k].slice(0, max) : ''; if (v) ref[k] = v; }
    out.push(ref);   // a reference only: never the attachment's bytes
  }
  return out;
}
function capture(messages, opts) {
  const c = opts || {};
  const turnId = TurnKinds.isTurnId(c.turnId) ? c.turnId : '';
  if (c.recovery) {
    const title = String(c.recovery.title || '');
    if (!title) return null;
    return { text: title, label: '', attachments: [], turnId, typedTitleSource: title, recovered: true, captured: true };
  }
  const m = newestUser(messages);
  if (!m) return null;
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const text = UserText.flatten(m.content, UserText.DIRECTIVE) || '';
  const d = { text, label: labelOf(atts), attachments: refsOf(atts), turnId, typedTitleSource: '', captured: true };
  const typed = typeof c.typedDirective === 'string' && c.typedDirective.trim() ? c.typedDirective : '';
  d.typedTitleSource = typed || wording(d);
  return d;
}
function typedText(d) { return d ? String(d.text || '') : ''; }
function wording(d) {
  if (!d) return '';
  const t = String(d.text || '');
  return t.trim() ? t : String(d.label || '');
}
// the content a turn that carried files stores as its directive row (the wording, never the expanded text); '' for a turn without files or a null capture
function attachedWording(d) { return d && Array.isArray(d.attachments) && d.attachments.length ? wording(d) : ''; }
// A directive with no typed words whose whole wording is the label of its files: the Commander said nothing, and the names in the label are
// a third party's text. Its row must never be taken for the Commander's words (owner evidence, ambient activity, interests, briefs), and
// the run that answered it must not be either (the run record says so: wordless). false for a null capture, a recovery and any typed words.
function labelOnly(d) { return !!d && !String(d.text || '').trim() && !!String(d.label || ''); }
function row(d, contentBytes, kind) {
  if (!d) return contentBytes;
  const only = labelOnly(d) ? { labelOnly: true } : null;
  // THE CLEAN DIRECTIVE: with attachments the row's content is the Commander's wording, never contentBytes (the expanded text,
  // whose file bytes are a third party's words). The files ride as attachment rows (install); the refs stay for the thumbnails.
  // With no typed words the wording is the label of the files: the row says so (labelOnly) and the run transcript stamps it.
  if (Array.isArray(d.attachments) && d.attachments.length) return Object.assign({ text: wording(d), typed: wording(d), attachments: d.attachments, kind }, only);
  // a recovery continuation that must write the directive its source never wrote reads the SOURCE's expanded prompt: when that
  // holds a file's text the row keeps the source's title instead (the same fallback a missing directive takes at run end)
  const expanded = d.recovered === true && rowStoresAttachmentText({ role: 'user', content: contentBytes });
  return Object.assign({ text: expanded ? wording(d) : (contentBytes || d.label), typed: wording(d), attachments: d.attachments, kind }, only);
}
// what the run writes for its directive and the files it carried (see the header): runTranscript is makeRunTranscript's;
// reused is the directive ROW the run answers when it reuses one (its turn is the one the files are recorded under)
function install(runTranscript, d, contentBytes, kind, report, reused) {
  if (!runTranscript || typeof runTranscript.setDirective !== 'function') return;
  const refs = d && Array.isArray(d.attachments) ? d.attachments : [];
  if (reused) {
    // the files are recorded under the REUSED directive's turn; a reused row that names none (a legacy row of an older build, found
    // by run id) has no turn to hang them on, and writing them under this run's own turn would orphan them
    const items = TurnKinds.isTurnId(reused.turnId) ? TurnAttachment.rowsFor(refs, report) : [];
    if (items.length && typeof runTranscript.setAttachments === 'function') runTranscript.setAttachments(items, reused.turnId);
    return;
  }
  const r = row(d, contentBytes, kind);
  if (r && typeof r === 'object' && refs.length) r.attachmentRows = TurnAttachment.rowsFor(refs, report);
  runTranscript.setDirective(r);
}
function title(d, runDirective) { return d ? String(d.typedTitleSource || '') : runDirective; }
function runTitle(source, keys) { return PromptScrub.scrubStored(KeyTools.nameSavedKeys(source, keys), { whole: true }); }
function interruptedTitle(meta, keys) {
  const m = meta || {};
  return runTitle(String(m.directiveTitle || m.userTitle || ''), keys);
}
function packet(d, o) {
  if (!d) return null;
  const a = o || {};
  let text = '';
  try { text = String(storedForm(wording(d), a)); }
  catch (e) { failNote('turn.packet', e); text = ''; }   // fail closed: never the raw words
  const r = a.row;
  return { rowId: r && posInt(r.rowId) ? r.rowId : 0, text };
}

function startFields(runStartExtra) {
  const x = runStartExtra || {};
  const out = {};
  if (TurnKinds.isTurnId(x.turnId)) out.turnId = x.turnId;
  if (posInt(x.directiveRowId)) out.directiveRowId = x.directiveRowId;
  return out;
}

function echo(runStartExtra, runTranscript, reused, noteIdentity, noteBrief) {
  const x = runStartExtra || {};
  let written = null;
  try { written = runTranscript && typeof runTranscript.directiveRow === 'function' ? runTranscript.directiveRow() : null; }
  catch (e) { failNote('turn.echo', e); written = null; }
  const rowId = written && posInt(written.rowId) ? written.rowId : (reused && posInt(reused.rowId) ? reused.rowId : 0);
  if (rowId) x.directiveRowId = rowId;
  const fields = startFields(x);
  if (Object.keys(fields).length && typeof noteIdentity === 'function') {
    try { noteIdentity(fields); } catch (e) { failNote('turn.echo', e); }
  }
  if (rowId && typeof noteBrief === 'function') {
    try {
      const p = noteBrief(rowId);
      if (p && typeof p.then === 'function') p.then(null, e => failNote('turn.echo.brief', e));
    } catch (e) { failNote('turn.echo.brief', e); }
  }
  return fields;
}

// The journal is the durable source for a run that never reached run end (runStore.noteIdentity is in memory). Only a
// FOUND directive is used, so the absence rung (which needs a turn time) is never asked for.
/* A run's quote stamp as its RECORD's fields (runStore.noteIdentity): quotes + quotesAt in the row-stamp form (TurnKinds.quoteStamp: up to
   32 streams with their read times, or the saturated ['*'] + [satAt]) and quotesSaturatedAt once saturated. entries: [{ id, at }], the
   saturated marker '*' included (execution.quotes()). {} for a run that read nothing. */
function quoteIdentityOf(entries) {
  const stamp = TurnKinds.quoteStamp(entries);
  if (!stamp.quotes) return {};
  const out = { quotes: stamp.quotes, quotesAt: stamp.quotesAt };
  if (stamp.quotes[0] === TurnKinds.SATURATED) out.quotesSaturatedAt = stamp.quotesAt[0];
  return out;
}
// the same, from a journal inspection (state.quotes [{ id, at }], state.quotesSaturatedAt): what an interrupted run's record carries
function journalQuoteIdentity(state) {
  if (!state || typeof state !== 'object') return {};
  const entries = Array.isArray(state.quotes) ? state.quotes.slice() : [];
  if (Number.isSafeInteger(state.quotesSaturatedAt) && state.quotesSaturatedAt >= 0) entries.push({ id: TurnKinds.SATURATED, at: state.quotesSaturatedAt });
  return quoteIdentityOf(entries);
}
/* A READ THE HOST REFUSES (commit 11): a tool result that drew on a session deleted while the read was in flight, or on more sessions
   than one run may hold, is replaced WHOLE by a host-authored notice before it reaches the messages, the journal or the rows - so the
   deleted session's words never enter the run. Counted by the caller (failNote turn.quotes.<reason>). */
const QUOTE_REFUSALS = {
  deleted: 'This read drew on a session that was deleted while the read was in flight, so none of it was kept. Read again: a deleted session no longer appears.',
  overflow: 'One run may read at most 32 sessions, and this read would pass that, so none of it was kept. Continue in a new run, or narrow the read.',
  journal: 'This read could not be recorded durably, so none of it was kept. Try again.'
};
// the words a reader gives for a session it will not read because the run has read as many as one run may
const QUOTE_ROOM_NOTE = 'One run may read at most 32 sessions, and this run has read that many. Continue in a new run.';
function quoteRefusal(result, cause) {
  const text = QUOTE_REFUSALS[cause] || QUOTE_REFUSALS.overflow;
  return { ok: false, isError: true, hostAuthored: true, summary: cause === 'deleted' ? 'read refused: session deleted' : cause === 'journal' ? 'read refused: not recorded' : 'read refused: too many sessions', content: text };
}
function interruptedIdentity(meta, store, state) {   // state: the journal inspection (its quotes join the record)
  const m = meta || {};
  const quoted = journalQuoteIdentity(state);
  if (!TurnKinds.isTurnId(m.turnId)) return quoted;
  const out = Object.assign({ turnId: m.turnId }, quoted);
  const sid = String(m.streamId || '');
  if (!sid || !store || typeof store.findTurn !== 'function') return out;
  let found = null;
  try { found = store.findTurn(sid, m.turnId, {}); } catch (e) { failNote('turn.findTurn', e); found = null; }
  if (found && found.state === 'found' && found.directive && posInt(found.directive.rowId)) out.directiveRowId = found.directive.rowId;
  return out;
}

module.exports = {
  turnOf, reuseByTurn, reuse, keyBlind, echo, startFields, interruptedIdentity, quoteIdentityOf, journalQuoteIdentity, quoteRefusal, QUOTE_ROOM_NOTE,
  capture, typedText, wording, attachedWording, labelOnly, row, install, title, runTitle, interruptedTitle, packet
};
