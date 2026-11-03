/* Pure transcript visibility and output shapes. Raw IO and durable proofs belong to transcriptstore. */
'use strict';
const Kinds = require('../frontend/app/turnkinds.js');
const ROW_IDS = Symbol('starnet.transcript.row-ids');
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
function messages(rows, c, o) {
  const out = [], ids = [];
  for (const row of rows) {
    const classification = Kinds.classify(row, c);
    let role = row.role, content = !o.legacy && o.form === 'pre' && row.role === 'user' && classification.cell !== 'dispatch-prompt' ? row.typed ?? row.content : row.content;
    if (!o.legacy && classification.kind === 'steer') { role = 'user'; content = text(row).startsWith('[steering] ') ? text(row) : '[steering] ' + text(row); }
    let message;
    if (role === 'user') {
      message = { role, content };
      if (!o.legacy && o.form === 'pre' && classification.cell !== 'dispatch-prompt' && Array.isArray(row.attachments) && row.attachments.length) message.attachments = row.attachments.map(a => Object.assign({}, a));
    } else if (role === 'assistant') {
      message = { role, content: content || '' };
      if (o.shape === 'pairs' && row.toolCalls && classification.cell !== 'dispatch-final') {
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
function project(name, input, ctx, opts) {
  if (!Kinds.VIEWS.includes(name)) throw new Error('unknown transcript view: ' + name);
  const o = opts || {}, raw = (Array.isArray(input) ? input : []).filter(hasId);
  if (name === 'model-replay' && o.shape !== 'prose' && o.shape !== 'pairs') throw new Error('model-replay requires a literal prose or pairs shape');
  // Proof sees append-only forgotten/retracted evidence, but an id-less RAM write is never durable proof.
  if (name === 'proof') return raw.map(row => Object.assign({}, row));
  const c = context(raw, ctx || {});
  const targets = retractions(raw, c.retractions);
  let rows = raw.filter(row => !(typeof c.forgotten === 'function' && c.forgotten(row)) && row.kind !== 'retract' &&
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
  return name === 'model-replay' && o.rows !== true ? messages(rows, c, o) : rows.map(row => Object.assign({}, row));
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
module.exports = { ROW_IDS, project, ownerRow, slice, concat };
