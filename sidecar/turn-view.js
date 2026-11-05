/* Pure transcript visibility and output shapes. Raw IO and durable proofs belong to transcriptstore. */
'use strict';
const Kinds = require('../frontend/app/turnkinds.js');
const ROW_IDS = Symbol('starnet.transcript.row-ids');
// One message's place in the canonical rows, set by the HOST at assembly (summary-cover.js) and read when a fold must say which
// rows it summarized. Non-enumerable and symbol-keyed: it never reaches a wire, a JSON copy or a spread, and an elided copy
// inherits it through the loop's carryMarkers.
const ROW_TAG = Symbol('starnet.transcript.row-tag');
// non-enumerable side channel on a display result: { keys: [[streamId, rowId]...], runIds: [...] } of the rows the quote rule hid.
// A REGISTERED symbol (Symbol.for): index.js's transcriptProjection reads it by the registry key, so that function needs no TurnView in scope
// (test/transcript-perf-paths evaluates it on its own with a fixed dependency list).
const FORGOTTEN = Symbol.for('starnet.transcript.forgotten');
const FORGOTTEN_KEYS_MAX = 2000, FORGOTTEN_RUNS_MAX = 200;
const hasId = row => row && Number.isSafeInteger(row.rowId) && row.rowId > 0;
const text = row => typeof row.content === 'string' ? row.content : '';

// The existing clean-owner rule, with its provenance/quote predicates supplied by their owners. A view
// lacking any of that proof returns no owner evidence; content shape or a recent run can never substitute.
function ownerRow(row, ctx) {
  const c = ctx || {}, m = row;
  if (!m || m.role !== 'user' || typeof c.rowTaint !== 'function' || c.rowTaint(m) !== null || m.from ||
      typeof m.content !== 'string' || !m.content.trim() || typeof c.quotedMaterial !== 'function' || c.quotedMaterial(m.content)) return false;
  const r = typeof c.runOf === 'function' ? c.runOf(m.sourceRunId) : null;
  return !!(r && r.ownerDirective === true && r.internal === false && !r.parentRunId && !r.delegatedBy && !r.cronJobId && !r.recoveryOf &&
    r.agentId === m.agentId && (r.streamId || 'global') === m.streamId && !/^(?:nightshift-|cron-|workshop-)/i.test(r.streamId || ''));
}
function retractions(rows, supplied) {
  const targets = new Map(supplied instanceof Map ? supplied : []);
  for (const row of rows) if (row.kind === 'retract' && Array.isArray(row.targets)) {
    for (const id of row.targets) if (Number.isSafeInteger(id) && id > 0) {
      // An undo remains hidden even if a later retry also targets the same immutable row.
      if (!targets.has(id) || row.reason === 'undo') targets.set(id, row.reason || 'undo');
    }
  }
  return targets;
}
function context(rows, ctx) {
  const c = Object.assign({}, ctx), selfTalkRuns = new Set(c.selfTalkRuns || []), hopRuns = new Set(c.hopRuns || []);
  for (const row of rows) {
    if (row.sourceRunId && Kinds.legacyPrompt(row)) selfTalkRuns.add(String(row.sourceRunId));
    if (row.sourceRunId && Kinds.legacyKind(row, c) === 'hop') hopRuns.add(String(row.sourceRunId));
  }
  c.selfTalkRuns = selfTalkRuns; c.hopRuns = hopRuns;
  return c;
}
function permitted(name, row, classification, c, o) {
  // A disavowed durable key cannot become activity/brief provenance, even when its row content and
  // host run otherwise look like a clean owner turn. This precedes both user and steer owner rules.
  if (name === 'owner-evidence' && (row.idFrom === 'collision' || (typeof c.isCollided === 'function' && c.isCollided(row.rowId)))) return false;
  if (name === 'model-replay') return Kinds.replayable(row, Object.assign({}, o, { ctx: c }));
  const rule = Kinds.MATRIX[classification.cell][name];
  if (typeof rule === 'boolean') return rule;
  if (rule === 'owner') {
    if (classification.kind !== 'steer') return ownerRow(row, c);
    // Steer rows are system-role; their host-proven owner run supplies the identity, never row content.
    const run = typeof c.runOf === 'function' ? c.runOf(row.sourceRunId) : null;
    return !!(run && run.ownerDirective === true && run.internal === false && !run.parentRunId && !run.delegatedBy &&
      !run.cronJobId && !run.recoveryOf && run.agentId === row.agentId && (run.streamId || 'global') === row.streamId);
  }
  if (rule === 'own-stream') return !!o.streamId && row.streamId === o.streamId;
  return false;
}
const PROJECTED_ROWS = Symbol('turn-view.projected-rows');
function messages(rows, c, o, accept) {
  const out = [], ids = [];
  for (const row of rows) {
    const classification = Kinds.classify(row, c);
    if (typeof accept === 'function' && !accept(row, classification)) continue;
    let role = row.role, content = !o.legacy && o.form === 'pre' && row.role === 'user' && classification.cell !== 'dispatch-prompt' ? row.typed ?? row.content : row.content;
    if (!o.legacy && classification.kind === 'steer') { role = 'user'; content = text(row).startsWith('[steering] ') ? text(row) : '[steering] ' + text(row); }
    let message;
    if (role === 'user') {
      message = { role, content };
      if (!o.legacy && o.form === 'pre' && classification.cell !== 'dispatch-prompt' && Array.isArray(row.attachments) && row.attachments.length) message.attachments = row.attachments.map(a => Object.assign({}, a));
    } else if (role === 'assistant') {
      message = { role, content: content || '' };
      // A call that carried words (cell 'assistant') keeps only its words for a reader whose results are not its own (forAgent): the replay
      // rule dropped those results and a call must never stay without them. Tool-only call turns were dropped whole, with their results.
      // The legacy projection has no such rule: it keeps every result, so it keeps every call.
      const resultsGone = !o.legacy && classification.cell === 'assistant' && Kinds.foreignTools(row, o, c);
      if (o.shape === 'pairs' && row.toolCalls && classification.cell !== 'dispatch-final' && !resultsGone) {
        try { const calls = JSON.parse(row.toolCalls); if (Array.isArray(calls) && calls.length) message.tool_calls = calls; }
        catch (error) { if (typeof c.note === 'function') c.note('turn-view.tool-calls', error); }
      }
    } else if (role === 'tool' && o.shape === 'pairs') message = { role, content, tool_call_id: String(row.toolCallId || '') };
    if (!message) continue;
    out.push(message); ids.push({ streamId: row.streamId, rowId: row.rowId });
  }
  // Preserve reconstruct's pairing boundary: no orphaned leading result or unfinished trailing call.
  while (out.length && out[0].role === 'tool') { out.shift(); ids.shift(); }
  const last = out[out.length - 1];
  if (last && last.role === 'assistant' && last.tool_calls) delete last.tool_calls;
  Object.defineProperty(out, ROW_IDS, { value: ids, enumerable: false });
  return out;
}
// the identity block's forgotten list from the rows the quote rule hid: keys (stream + rowId) and the runs those rows came from
function forgottenOf(hidden) {
  const keys = [], runIds = [], seenRuns = new Set();
  for (const row of hidden) {
    if (keys.length < FORGOTTEN_KEYS_MAX && hasId(row)) keys.push([row.streamId, row.rowId]);
    const run = row.sourceRunId ? String(row.sourceRunId) : '';
    if (run && runIds.length < FORGOTTEN_RUNS_MAX && !seenRuns.has(run)) { seenRuns.add(run); runIds.push(run); }
  }
  return { keys, runIds };
}
function project(name, input, ctx, opts) {
  if (!Kinds.VIEWS.includes(name)) throw new Error('unknown transcript view: ' + name);
  const o = opts || {}, raw = (Array.isArray(input) ? input : []).filter(hasId);
  if (name === 'model-replay' && o.shape !== 'prose' && o.shape !== 'pairs') throw new Error('model-replay requires a literal prose or pairs shape');
  // Proof sees append-only forgotten/retracted evidence, but an id-less RAM write is never durable proof.
  if (name === 'proof') return raw.map(row => Object.assign({}, row));
  const c = context(raw, ctx || {});
  const targets = retractions(raw, c.retractions);
  // the rows the QUOTE rule hid (a row that quotes a session deleted since): the page's affirmative drop proof (identity.forgotten)
  const hiddenByQuote = [];
  const forgottenRow = row => {
    if (typeof c.forgotten !== 'function' || !c.forgotten(row)) return false;
    if (typeof c.quoteForgotten === 'function' && c.quoteForgotten(row)) hiddenByQuote.push(row);
    return true;
  };
  let rows = raw.filter(row => !forgottenRow(row) && row.kind !== 'retract' &&
    (!targets.has(row.rowId) || (name === 'display' && targets.get(row.rowId) === 'retry' && o.hideRetry !== true)) &&
    !(o.excludeTurnId && row.turnId === o.excludeTurnId) &&
    !(Number.isSafeInteger(o.beforeRowId) && row.rowId >= o.beforeRowId) &&
    (!c.live || !c.live.has(String(row.sourceRunId || '')) || (name === 'display' && o.liveDirective === true && row.directive === true)));
  // Recall shares the accepted-dispatch projection too: the visibility matrix admits its accepted
  // prompt/final while excluding unaccepted execution. Raw pending state cannot supply that proof.
  if (name === 'display' || (name === 'model-replay' && !o.legacy) || name === 'recall') {
    if (typeof c.projectConversation !== 'function') throw new Error('transcript projection owner is required');
    rows = c.projectConversation(rows, c.runOf, c.hash);
  }
  c.finalRuns = new Set(rows.filter(row => typeof c.isFinalDeliveryRow === 'function' && c.isFinalDeliveryRow(row)).map(row => String(row.sourceRunId || '')));
  rows = rows.filter(row => o.legacy && name === 'display' ? true : o.legacy && name === 'model-replay'
    ? row.dispatchState !== 'final' && (row.role === 'user' || row.role === 'assistant' || (o.shape === 'pairs' && row.role === 'tool'))
    : permitted(name, row, Kinds.classify(row, c), c, o));
  if (o.delivery === true) rows = rows.filter(row => c.isFinalDeliveryRow(row));
  if (Number.isSafeInteger(o.limit) && o.limit >= 0) rows = o.limit ? rows.slice(-o.limit) : [];
  if (name === 'model-replay' && o.rows !== true) return messages(rows, c, o);
  const out = rows.map(row => Object.assign({}, row));
  if (name === 'model-replay') Object.defineProperty(out, PROJECTED_ROWS, { value: { context: c, options: o } });
  if (name === 'display') Object.defineProperty(out, FORGOTTEN, { value: forgottenOf(hiddenByQuote), enumerable: false });
  return out;
}
// Channel hop admission filters one already-visible assembly. Keep its classifier context (accepted
// final, typed directive and steer rules) private and use this same shaper; never re-read or re-project.
function projectedMessages(rows, accept) {
  const projection = rows && rows[PROJECTED_ROWS];
  if (!projection) throw new Error('message shaping requires model-replay rows from this view');
  return messages(rows, projection.context, projection.options, accept);
}
function slice(messages, start, end) {
  const out = messages.slice(start, end);
  if (Array.isArray(messages[ROW_IDS])) Object.defineProperty(out, ROW_IDS, { value: messages[ROW_IDS].slice(start, end), enumerable: false });
  return out;
}
function concat(...arrays) {
  const out = [].concat(...arrays);
  if (arrays.some(array => Array.isArray(array[ROW_IDS]))) Object.defineProperty(out, ROW_IDS, {
    value: arrays.flatMap(array => Array.isArray(array[ROW_IDS]) ? array[ROW_IDS] : array.map(() => null)), enumerable: false });
  return out;
}
// the durable identity ({ streamId, rowId }) of the i-th message of a model-replay assembly, or null (no ids, no id for it)
function rowIdOf(messages, i) {
  const ids = messages && messages[ROW_IDS];
  const id = Array.isArray(ids) ? ids[i] : null;
  return id && Number.isSafeInteger(id.rowId) && id.rowId > 0 && id.streamId ? id : null;
}
function tag(message, value) {
  if (message && typeof message === 'object' && value) Object.defineProperty(message, ROW_TAG, { value: Object.freeze(Object.assign({}, value)), enumerable: false, configurable: true, writable: true });
  return message;
}
function tagOf(message) { return message && typeof message === 'object' && message[ROW_TAG] || null; }
module.exports = { ROW_IDS, FORGOTTEN, ROW_TAG, project, ownerRow, slice, concat, messages: projectedMessages, rowIdOf, tag, tagOf };
