/* One pre-expansion desk window. History authority stays in Store; fitting stays in shared HistoryFit. */
'use strict';
const crypto = require('node:crypto');
const Fit = require('../frontend/app/historyfit.js');
const Kinds = require('../frontend/app/turnkinds.js');
const Merge = require('../frontend/app/turnmerge.js');
const View = require('./turn-view.js');
const TurnAttachment = require('./turn-attachment.js');
const { ATTACHMENT_TAINT } = require('./taint.js');
const hash = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const positiveId = n => Number.isSafeInteger(n) && n > 0;
function callerOf(body) {
  return body && Kinds.isTurnId(body.turnId) && (Number.isFinite(body.windowTokens) || body.windowFrom === 'station') ? 'desk' : undefined;
}
function eligible(o) {
  return !!(o && o.windowCaller === 'desk' && o.streamId && !o.internal && !o.outputOnly && !o.recovery &&
    !o.groupTools && !o.lineHop && !o.parentRunId && o.resumeSeed !== false);
}
function postedHistory(body) { return !!(body && Array.isArray(body.messages) && body.messages.filter(m => m && m.role !== 'system').length > 1); }
function historyUnavailable(cause) { return Object.assign(new Error('history unavailable'), { code: 'HISTORY_UNAVAILABLE', cause }); }
function identities(messages, streamId) {
  const ids = messages && messages[View.ROW_IDS];
  return (messages || []).map((row, i) => Object.assign({}, row, Array.isArray(ids) && ids[i] || {}, { streamId: row.streamId || streamId }));
}
function compare(posted, canonical, streamId) {
  const a = identities(posted, streamId), b = identities(canonical, streamId), counts = {}, keys = {};
  const add = (name, row) => { counts[name] = (counts[name] || 0) + 1; if (row) (keys[name] || (keys[name] = [])).push(JSON.stringify([row.streamId, row.rowId || row.turnId || '', row.role])); };
  const key = row => positiveId(row.rowId) ? JSON.stringify([row.streamId, row.rowId]) : '';
  const bytes = row => JSON.stringify([row.role, row.content, row.attachments || []]);
  const foreign = row => row.streamId !== streamId || row.foreign;
  const same = (left, right) => !foreign(left) && !foreign(right) && bytes(left) === bytes(right) && (key(left) || left.turnId || '') === (key(right) || right.turnId || '');
  if (a.length === b.length && a.every((row, i) => same(row, b[i]))) return { counts, keys };
  // Only affirmative, disjoint keyed prefixes may be called a fit boundary. A reordered key or
  // changed byte at a shared key must remain order/bytes, never be explained away by suffix matching.
  let suffix = 0;
  while (suffix < Math.min(a.length, b.length) && same(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix++;
  const leftPrefix = a.slice(0, a.length - suffix), rightPrefix = b.slice(0, b.length - suffix);
  if (suffix && leftPrefix.length && rightPrefix.length && leftPrefix.concat(rightPrefix).every(row => key(row) && !foreign(row)) &&
      !leftPrefix.some(left => rightPrefix.some(right => key(left) === key(right)))) {
    counts.fit_boundary = 1;
    keys.fit_boundary = leftPrefix.concat(rightPrefix).map(key);
    return { counts, keys, fitBoundaryDepth: Math.max(leftPrefix.length, rightPrefix.length) };
  }
  const paired = new Map();
  for (const row of b) { const k = key(row); if (k) (paired.get(k) || (paired.set(k, []), paired.get(k))).push(row); }
  const matched = new Set(), orderA = [], orderB = [];
  for (const row of a) {
    // Branch copies stay page-authoritative; byte equality cannot turn their provenance into this stream's.
    if (foreign(row)) { add('foreign', row); continue; }
    const k = key(row), matches = k && paired.get(k), other = matches && matches.shift();
    if (other) { matched.add(other); orderA.push(k); if (bytes(row) !== bytes(other)) add('bytes', row); continue; }
    // A byte-identical legacy row proves only an id-less comparison, never a durable binding.
    const legacyMatch = !k && b.find(r => !matched.has(r) && bytes(r) === bytes(row));
    if (legacyMatch) { matched.add(legacyMatch); if (!(row.turnId && row.turnId === legacyMatch.turnId)) add('idless', row); continue; }
    if (!k && Kinds.isTurnId(row.turnId) && row.role === 'user') add('pending', row);
    else if (!k) add('idless', row);
    else add('unexplained', row);
  }
  for (const row of b) {
    if (!matched.has(row)) add('late', row);
    else if (key(row) && orderA.includes(key(row))) orderB.push(key(row));
  }
  if (orderA.length === orderB.length && orderA.some((k, i) => k !== orderB[i])) add('order');
  return { counts, keys };
}
function make(d) {
  const store = d.transcriptStore, dual = d.turnDual;
  const note = (tag, error) => { if (typeof d.failNote === 'function') d.failNote(tag, error); };
  function reseed(o) { return store.view('model-replay', o.streamId, { limit: o.coordinatedSession && o.parentRunId ? 80 : 100, shape: 'pairs', form: 'pre' }); }
  function vouched(streamId) {
    if (typeof streamId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(streamId)) return false;
    try { store.view('model-replay', streamId, { complete: true, shape: 'prose', form: 'pre' }); return true; }
    catch (error) { note('turn.window.unvouched', error); return false; }
  }
  function carry(messages, o, ctx) {
    const clock = o.clientClock || {}, seen = new Set(), candidates = [];
    for (const row of messages) {
      if (!row || row.role !== 'user' || positiveId(row.rowId) || !Kinds.isTurnId(row.turnId) ||
          [o.turnId, o.retryOf, ctx.directive.turnId].includes(row.turnId) || seen.has(row.turnId) ||
          (row.streamId && row.streamId !== o.streamId) || Merge.localKind(row) !== 'pending') continue;
      const turnAt = Kinds.stationTime(row.turnAt, clock.clientNow, clock.at);
      if (!Number.isSafeInteger(turnAt) || turnAt < 0) continue;
      seen.add(row.turnId); candidates.push({ row, turnId: row.turnId, turnAt });
    }
    if (!candidates.length) return [];
    if (candidates.length > 8 || Fit.utf8Bytes(JSON.stringify(candidates.map(c => c.row))) > 64 * 1024) throw new Error('carried-turn proof exceeds its bounded batch');
    const proof = store.findTurns(o.streamId, candidates.map(c => ({ turnId: c.turnId, turnAt: c.turnAt })));
    const out = [];
    for (const c of candidates) if (proof.get(c.turnId)?.state === 'absent') {
      // These proved-absent rows are unadmitted typed input: the Commander's words, written CLEAN (taint null) whatever
      // provenance the page claimed. A file the turn carried is recorded beside it as an attachment row (turn-attachment.js:
      // no size or sha256, no read happened here) stamped with the attachment source, which is where that provenance lives
      // now; taint follows the bytes a run actually re-sends (attachments.resentOf), never a reference's presence.
      const row = store.appendStrict({ streamId: o.streamId, agentId: ctx.agentId, role: 'user', content: c.row.content,
        typed: typeof c.row.typedText === 'string' ? c.row.typedText : c.row.content, attachments: c.row.attachments,
        kind: 'turn', turnId: c.turnId, directive: true, carriedBy: ctx.runId, taint: null });
      if (!row || !positiveId(row.rowId)) throw new Error('carried turn was not durably acknowledged');
      const items = TurnAttachment.rowsFor(c.row.attachments, null);
      if (items.length) {
        // provenance only: a failure is noted and never loses the carried directive or the window
        const wrote = TurnAttachment.write(store, { items, streamId: o.streamId, agentId: ctx.agentId, turnId: c.turnId, runId: ctx.runId, taint: ATTACHMENT_TAINT });
        if (wrote.failure) note('turn.window.attachment', wrote.failure);
      }
      out.push(Object.assign({}, c.row, { rowId: row.rowId, streamId: o.streamId }));
    }
    return out;
  }
  /* THE POSTED WINDOW'S FORGET FLOOR (commit 11, A2-MIG-02). A page that posts its own copy of the history may not have heard of a
     delete yet, so before any mode and before the gate (eligible request or not) an inbound history message is dropped on the store's
     own proof, mirroring TurnMerge R2/R4: (i) a message carrying a key is dropped when the stored row of that key is one the
     predicate forgets (a key whose stored row cannot be read at all falls to (ii) and is counted unvouched); (ii) an id-less, or
     unreadable-key, ASSISTANT message (reply, partial, stopped) is dropped when the run it names (sourceRunId) is quote-forgotten.
     An id-less USER message is never dropped by the run rule: the run's own directive and the Commander's typed words predate any
     read, and a user row is never a copy a run took by reading a session. So the window keeps exactly the keyed rows model-replay
     keeps, and a row the store keeps is never removed. Returns the same array when nothing was dropped. */
  function forgetFloor(messages, o) {
    const none = { messages, dropped: 0, unvouched: 0 };
    if (!Array.isArray(messages) || !o || !o.streamId || typeof store.forgetVerdicts !== 'function') return none;
    const keyedHere = m => !!m && m.role !== 'system' && positiveId(m.rowId) && (!m.streamId || m.streamId === o.streamId) && m.idFrom !== 'collision';
    const keys = messages.filter(keyedHere).map(m => m.rowId);
    let verdicts = new Map();
    if (keys.length) { try { verdicts = store.forgetVerdicts(o.streamId, keys); } catch (error) { note('turn.window.forgotten', error); } }
    const ids = messages[View.ROW_IDS], kept = [], keptIds = [];
    let dropped = 0, unvouched = 0;
    messages.forEach((m, i) => {
      let drop = false;
      if (m && m.role !== 'system') {
        const keyed = keyedHere(m), verdict = keyed ? verdicts.get(m.rowId) : undefined;
        const proven = verdict === true || verdict === false;
        if (verdict === true) drop = true;
        else if (!proven && m.role === 'assistant' && m.sourceRunId && typeof d.runForgotten === 'function') {
          try { drop = d.runForgotten(String(m.sourceRunId)) === true; } catch (error) { note('turn.window.forgotten', error); }
        }
        if (keyed && !proven) unvouched++;
      }
      if (drop) dropped++; else { kept.push(m); if (Array.isArray(ids)) keptIds.push(ids[i]); }
    });
    if (!dropped) return Object.assign(none, { unvouched });
    if (Array.isArray(ids)) Object.defineProperty(kept, View.ROW_IDS, { value: keptIds, enumerable: false });
    note('turn.window.forgotten', new Error(dropped + ' posted history row(s) quote a deleted session and were left out of the window'));
    return { messages: kept, dropped, unvouched };
  }
  function apply(messages, o, ctx) {
    const floored = forgetFloor(messages, o);
    messages = floored.messages;
    if (!eligible(o) || !ctx || !ctx.directive) return messages;
    const mode = dual.modes().window;
    if (mode === 'legacy') return messages;
    const src = Array.isArray(messages) ? messages : [], newestAt = src.map(m => m && m.role).lastIndexOf('user');
    if (newestAt < 0) return messages;
    const system = src.filter(m => m && m.role === 'system'), newest = src[newestAt];
    const foreign = Fit.hasForeign(src, o.streamId) || src.some(row => row && row.foreign);
    const required = o.windowFrom === 'station';
    const record = data => dual.record('window', Object.assign({ caller: 'desk', streamId: o.streamId, runId: ctx.runId,
      degraded: required && !postedHistory({ messages: src }) }, data, floored.dropped ? { classes: [...(data && data.classes || []), 'forgotten'], counts: Object.assign({}, data && data.counts, { forgotten: floored.dropped }) } : null));
    try {
      const rows = store.view('model-replay', o.streamId, { form: 'pre', shape: 'prose', complete: true,
        excludeTurnId: ctx.directive.turnId, beforeRowId: ctx.reused && ctx.reused.directive && ctx.reused.directive.rowId });
      const carried = mode === 'id' && !foreign ? carry(src.slice(0, newestAt), o, ctx) : [];
      const combined = View.concat(carried, rows, [newest]);
      const limit = Number.isFinite(o.windowTokens) ? 0 : typeof d.limitOf === 'function' ? d.limitOf(o) : 0;
      // The page's own budget wins. Without one the fallback fits to the same line the page does: limitOf is already the run's window
      // (index.js turnWindowLimitOf stops it at the price tier) and d.compactAt is the share the server folds at (RUN_CONTEXT_DEFAULTS,
      // injected by index.js; a caller that injects none keeps the former share).
      const budget = Number.isFinite(o.windowTokens) ? Math.max(1, o.windowTokens)
        : Number.isFinite(limit) && limit > 0 ? Fit.uncalibratedBudget(limit, d.compactAt) : null;
      let fitted = Fit.fitHistoryBytes(combined.slice(-Fit.HISTORY_CAP), Fit.HISTORY_WIRE_MAX_BYTES);
      if (budget !== null) fitted = Fit.fitHistoryTokens(fitted, budget);
      const window = View.slice(combined, combined.length - fitted.length);
      record(compare(src.filter(m => m && m.role !== 'system'), window, o.streamId));
      const selected = !foreign && (mode === 'id' || required) ? View.concat(system, window) : messages;
      const selectedIds = identities(selected, o.streamId).filter(r => r.streamId === o.streamId && positiveId(r.rowId)).map(r => r.rowId);
      if (typeof d.noteIdentity === 'function') d.noteIdentity(ctx.runId, { windowRowIds: {
        first: selectedIds[0] || 0, last: selectedIds.at(-1) || 0, count: selectedIds.length, sha256: hash(JSON.stringify(selectedIds)) } });
      return selected;
    } catch (error) {
      note('turn.window.unvouched', error); record({ classes: ['unvouched'] });
      if (required && !postedHistory({ messages: src })) throw historyUnavailable(error);
      return messages;
    }
  }
  return { apply, reseed, vouched };
}
module.exports = { make, callerOf, eligible, postedHistory, historyUnavailable, compare };
