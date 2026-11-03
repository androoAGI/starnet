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
     echo(runStartExtra, runTranscript, reused, noteIdentity, brief)
                                             after the directive write: run.start's directiveRowId (the written directive,
                                             else the reused one) and the run record's { turnId, directiveRowId }
                                             (runStore.noteIdentity). `brief` is the run's task brief (commit 4 records the
                                             directive row on it)
     startFields(runStartExtra)              { turnId, directiveRowId } for the lead's own agent.run.start
     interruptedIdentity(meta, store, state) an interrupted run's record identity from its journal: { turnId } plus the
                                             directive's rowId when findTurn's recent or run-rows rungs find it

   Counted (failopen tags, ids only, never text): turn.recovery.ids-ignored, turn.id-ignored, turn.reuse.conflict.agent,
   turn.reuse.conflict.input, turn.reuse.horizon. */
'use strict';
const TurnKinds = require('../frontend/app/turnkinds.js');
const KeyTools = require('./tools/builtin/keys.js');
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

function reuse(store, o) {
  const a = o || {};
  const found = a.found;
  if (!found || found.state !== 'found' || !found.directive) return null;
  const row = found.directive;
  const latest = typeof a.latestUserText === 'function' ? a.latestUserText(a.messages) : '';
  const named = KeyTools.nameSavedKeys(latest, a.keys);
  const asked = typeof a.redact === 'function' ? a.redact(named) : named;
  if (keyBlind(row.content) === keyBlind(asked)) return row;
  count('turn.reuse.conflict.input', 'run ' + String(a.runId || '') + ': the words differ from the turn\'s directive; re-keyed');
  const own = TurnKinds.runTurnId(a.runId);
  if (own && typeof a.rekey === 'function') a.rekey(own);
  return null;
}

function startFields(runStartExtra) {
  const x = runStartExtra || {};
  const out = {};
  if (TurnKinds.isTurnId(x.turnId)) out.turnId = x.turnId;
  if (posInt(x.directiveRowId)) out.directiveRowId = x.directiveRowId;
  return out;
}

function echo(runStartExtra, runTranscript, reused, noteIdentity, brief) {   // brief: read from commit 4 (the task brief's directive row)
  const x = runStartExtra || {};
  let row = null;
  try { row = runTranscript && typeof runTranscript.directiveRow === 'function' ? runTranscript.directiveRow() : null; }
  catch (e) { failNote('turn.echo', e); row = null; }
  const rowId = row && posInt(row.rowId) ? row.rowId : (reused && posInt(reused.rowId) ? reused.rowId : 0);
  if (rowId) x.directiveRowId = rowId;
  const fields = startFields(x);
  if (Object.keys(fields).length && typeof noteIdentity === 'function') {
    try { noteIdentity(fields); } catch (e) { failNote('turn.echo', e); }
  }
  return fields;
}

// The journal is the durable source for a run that never reached run end (runStore.noteIdentity is in memory). Only a
// FOUND directive is used, so the absence rung (which needs a turn time) is never asked for.
function interruptedIdentity(meta, store, state) {   // state: the journal inspection (its quotes join in commit 11)
  const m = meta || {};
  if (!TurnKinds.isTurnId(m.turnId)) return {};
  const out = { turnId: m.turnId };
  const sid = String(m.streamId || '');
  if (!sid || !store || typeof store.findTurn !== 'function') return out;
  let found = null;
  try { found = store.findTurn(sid, m.turnId, {}); } catch (e) { failNote('turn.findTurn', e); found = null; }
  if (found && found.state === 'found' && found.directive && posInt(found.directive.rowId)) out.directiveRowId = found.directive.rowId;
  return out;
}

module.exports = { turnOf, reuseByTurn, reuse, keyBlind, echo, startFields, interruptedIdentity };
