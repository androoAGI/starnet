/* Permanent enrollment facts shared by the existing LineJobs and line-spend owners.
   Pure schema only: no storage, initialization, runtime permission or new registry. */
'use strict';
const FIELD = 'continuationAccounting';
const owns = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x)
  && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(id);
function inspect(root, owner) {
  if (!owns(root, FIELD)) return { ok: true, value: null };
  const property = Object.getOwnPropertyDescriptor(root, FIELD), value = property.value;
  const fields = plain(value) ? Object.getOwnPropertyDescriptors(value) : {};
  const valid = owns(property, 'value') && property.enumerable && plain(value)
    && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(fields).length === 3
    && ['version', 'ledgerId', 'state'].every(k => owns(fields, k) && owns(fields[k], 'value') && fields[k].enumerable)
    && fields.version.value === 1 && validId(fields.ledgerId.value)
    && (fields.state.value === 'confirmed' || (owner === 'jobs' && fields.state.value === 'prepared'));
  return valid ? { ok: true, value: { version: 1, ledgerId: value.ledgerId, state: value.state } }
    : { ok: false, value, issue: 'unsupported or malformed permanent accounting enrollment' };
}
function demand(root, owner) {
  const r = inspect(root, owner);
  if (!r.ok) { const e = new Error('line accounting: ' + r.issue + '; original data must be preserved'); e.code = 'ELINE_ACCOUNTING_READONLY'; throw e; }
  return r.value;
}
// Negative memory at each existing canonical owner: an observed identity may
// advance prepared -> confirmed, but a later read cannot silently erase/replace
// it. Call only after primary provenance has been proved; an intended write is
// not an observation and never grants positive initialization authority.
function observe(previous, root, owner) {
  const current = demand(root, owner);
  if (previous && (!current || previous.ledgerId !== current.ledgerId
    || (previous.state === 'confirmed' && current.state !== 'confirmed'))) {
    const e = new Error('line accounting: observed enrollment disappeared, changed identity or moved backwards');
    e.code = 'ELINE_ACCOUNTING_CHANGED'; throw e;
  }
  return current;
}
function preserve(source, target) {
  if (owns(source, FIELD)) Object.defineProperty(target, FIELD, Object.getOwnPropertyDescriptor(source, FIELD));
  return target;
}
function put(source, metadata) {
  const next = Object.assign({}, source);
  Object.defineProperty(next, FIELD, { value: metadata, enumerable: true, writable: true, configurable: true });
  return next;
}
module.exports = { FIELD, owns, inspect, demand, observe, preserve, put, validId };
