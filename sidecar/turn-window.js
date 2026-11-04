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
  function apply(messages, o, ctx) {
    if (!eligible(o) || !ctx || !ctx.directive) return messages;
    const mode = dual.modes().window;
    if (mode === 'legacy') return messages;
    const src = Array.isArray(messages) ? messages : [], newestAt = src.map(m => m && m.role).lastIndexOf('user');
    if (newestAt < 0) return messages;
    const system = src.filter(m => m && m.role === 'system'), newest = src[newestAt];
    const foreign = Fit.hasForeign(src, o.streamId) || src.some(row => row && row.foreign);
    const required = o.windowFrom === 'station';
    const record = data => dual.record('window', Object.assign({ caller: 'desk', streamId: o.streamId, runId: ctx.runId,
      degraded: required && !postedHistory({ messages: src }) }, data));
    try {
      const rows = store.view('model-replay', o.streamId, { form: 'pre', shape: 'prose', complete: true,
        excludeTurnId: ctx.directive.turnId, beforeRowId: ctx.reused && ctx.reused.directive && ctx.reused.directive.rowId });
      const carried = mode === 'id' && !foreign ? carry(src.slice(0, newestAt), o, ctx) : [];
      const combined = View.concat(carried, rows, [newest]);
      const limit = Number.isFinite(o.windowTokens) ? 0 : typeof d.limitOf === 'function' ? d.limitOf(o) : 0;
      const budget = Number.isFinite(o.windowTokens) ? Math.max(1, o.windowTokens)
        : Number.isFinite(limit) && limit > 0 ? Fit.uncalibratedBudget(limit) : null;
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
