/* Exact metadata for a routine's captured destination and canonical publication.
   These receipts never authorize transport or transcript writes on their own. */
'use strict';
const Kinds = require('../../frontend/app/turnkinds.js');
const { isDeepStrictEqual } = require('node:util');
const owns = (o, key) => !!o && Object.prototype.hasOwnProperty.call(o, key);
const plain = o => !!o && typeof o === 'object' && !Array.isArray(o) &&
  (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);
const exact = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every(k => owns(o, k));
const bounded = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;
const stream = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
const agent = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s);
const uint = n => Number.isSafeInteger(n) && n >= 0;
const same = (a, b) => isDeepStrictEqual(a, b);
function refuse(message) { throw Object.assign(new Error(message), { code: 'CHANNEL_HISTORY_UNPROVEN' }); }
function destination(raw) {
  if (!exact(raw, ['v', 'streamId', 'jobId', 'target']) || raw.v !== 1 || !stream(raw.streamId) ||
      !bounded(raw.jobId, 200) || !bounded(raw.target, 200)) refuse('The saved delivery destination could not be confirmed');
  return { v: 1, streamId: raw.streamId, jobId: raw.jobId, target: raw.target };
}
function binding(d) {
  if (!plain(d) || !bounded(d.id, 1024) || !bounded(d.channel, 200) || !bounded(d.chatId, 200) ||
      !bounded(d.runId, 200) || !Kinds.runTurnId(d.runId) || !agent(d.agentId) || d.kind !== 'routine' ||
      d.release !== 'caller' || (owns(d, 'chat') && d.chat !== d.channel + '|' + d.chatId)) {
    refuse('The saved delivery identity could not be confirmed');
  }
  const dest = destination(d.historyDestination);
  if (d.id !== 'routine:' + dest.jobId + ':' + d.runId + ':' + dest.target) refuse('The saved delivery does not match its captured target');
  return dest;
}
function acknowledgement(raw, d) {
  const dest = binding(d);
  if (d.state !== 'done' || !exact(raw, ['v', 'at', 'streamId', 'rowId', 'turnId']) || raw.v !== 2 || !uint(raw.at) ||
      !Number.isSafeInteger(raw.rowId) || raw.rowId <= 0 || raw.streamId !== dest.streamId || raw.turnId !== Kinds.runTurnId(d.runId)) {
    refuse('The saved publication acknowledgement could not be confirmed');
  }
  return { v: 2, at: raw.at, streamId: raw.streamId, rowId: raw.rowId, turnId: raw.turnId };
}
function hasMetadata(d) {
  return owns(d, 'historyDestination') || (d && plain(d.sessionTurns) && owns(d.sessionTurns, 'v'));
}
function record(d) {
  const dest = binding(d);
  if (!['queued', 'done'].includes(d.state) || !Array.isArray(d.parts) || !d.parts.length) refuse('The saved delivery parts could not be confirmed');
  const numbers = new Set();
  for (const p of d.parts) {
    if (!plain(p) || !uint(p.n) || numbers.has(p.n) || typeof p.sent !== 'boolean' || !['text', 'file', 'note'].includes(p.kind) ||
        (p.kind === 'text' && typeof p.text !== 'string') || (p.kind === 'file' && !bounded(p.path, 1000)) ||
        (p.kind === 'note' && !Array.isArray(p.missed)) || (d.state === 'done' && !p.sent)) refuse('The saved delivery parts are ambiguous');
    numbers.add(p.n);
  }
  // An old truthy marker is retained, but it supplies no canonical acknowledgement.
  if (d.sessionTurns && owns(d.sessionTurns, 'v')) acknowledgement(d.sessionTurns, d);
  return dest;
}
function receipt(raw, expected) {
  if (!exact(raw, ['v', 'target', 'deliveryId', 'channel', 'chatId', 'streamId', 'agentId', 'runId', 'rowId', 'turnId']) || raw.v !== 1 ||
      !bounded(raw.target, 200) || !bounded(raw.deliveryId, 1024) || !bounded(raw.channel, 200) || !bounded(raw.chatId, 200) ||
      !stream(raw.streamId) || !agent(raw.agentId) || !bounded(raw.runId, 200) || !Kinds.runTurnId(raw.runId) ||
      !Number.isSafeInteger(raw.rowId) || raw.rowId <= 0 || raw.turnId !== Kinds.runTurnId(raw.runId)) refuse('The saved routine publication could not be confirmed');
  // This is only a shape check: delimiters cannot prove job/target identity when both
  // may contain colons. Authority-bearing callers compare the independently captured binding.
  const suffix = ':' + raw.runId + ':' + raw.target;
  if (!raw.deliveryId.startsWith('routine:') || !raw.deliveryId.endsWith(suffix) || raw.deliveryId.length <= 'routine:'.length + suffix.length) {
    refuse('The saved routine publication target does not match its delivery');
  }
  const o = expected || {};
  if ((o.runId !== undefined && raw.runId !== o.runId) || (o.agentId !== undefined && raw.agentId !== o.agentId) ||
      (o.targets && !o.targets.includes(raw.target)) || (o.jobId !== undefined && raw.deliveryId !== 'routine:' + o.jobId + ':' + raw.runId + ':' + raw.target)) {
    refuse('The saved routine publication belongs to another result');
  }
  return { v: 1, target: raw.target, deliveryId: raw.deliveryId, channel: raw.channel, chatId: raw.chatId,
    streamId: raw.streamId, agentId: raw.agentId, runId: raw.runId, rowId: raw.rowId, turnId: raw.turnId };
}
function receipts(raw, expected) {
  if (!Array.isArray(raw) || raw.length > 16) refuse('The saved routine publications could not be confirmed');
  const targets = new Set(), ids = new Set(), out = [];
  for (const value of raw) {
    const r = receipt(value, expected);
    if (targets.has(r.target) || ids.has(r.deliveryId)) refuse('The saved routine publications contain conflicting destinations');
    targets.add(r.target); ids.add(r.deliveryId); out.push(r);
  }
  return out;
}
module.exports = { owns, same, hasMetadata, destination, binding, record, acknowledgement, receipt, receipts, refuse };
