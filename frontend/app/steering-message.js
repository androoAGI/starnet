/* Lossless mid-run message transport. One line in the token stream; original text and file refs inside. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SteeringMessage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PREFIX = '@starnet-message-v1:';
  const MAX_TEXT = 100000;
  function normalize(value) {
    if (!value || typeof value !== 'object' || typeof value.text !== 'string' || value.text.length > MAX_TEXT) return null;
    const attachments = Array.isArray(value.attachments) ? value.attachments : [];
    if (attachments.length > 16) return null;
    const refs = [];
    for (const a of attachments) {
      if (!a || typeof a.path !== 'string' || !a.path || a.path.length > 4096) return null;
      const ref = {};
      for (const k of ['id', 'name', 'path', 'mediaType', 'kind']) if (typeof a[k] === 'string') ref[k] = a[k].slice(0, k === 'path' ? 4096 : 512);
      refs.push(ref);
    }
    if (!value.text.trim() && !refs.length) return null;
    const id = typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.id) ? value.id : '';
    return { text: value.text, attachments: refs, ...(id ? { id } : {}) };
  }
  function encode(value) { const m = normalize(value); return m ? PREFIX + JSON.stringify(m) : ''; }
  function decode(wire) {
    if (typeof wire !== 'string' || !wire.startsWith(PREFIX)) return null;
    try { return normalize(JSON.parse(wire.slice(PREFIX.length))); } catch (_) { return null; }
  }
  function sameWire(a, b) {
    if (a === b) return true;
    const left = decode(a), right = decode(b);
    return !!(left && right && left.id && left.id === right.id);
  }
  function containsWire(content, wire) {
    const notes = String(content || '').matchAll(/(?:^|\n)\[steering\] ([^\n]*)/g);
    for (const match of notes) if (sameWire(match[1], wire)) return true;
    return false;
  }
  // Text-only history consumers (the paired device) must never show transport JSON as agent prose.
  function displayRows(rows) {
    const out = [];
    const user = (row, message) => ({ ...row, role: 'user', sys: false, content: message.text, attachments: message.attachments });
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      const direct = decode(row.steeringWire || (row.steerEcho ? String(row.content || '').replace(/^\[steering\] /, '') : ''));
      if (direct) { out.push(user(row, direct)); continue; }
      const text = String(row.content || '');
      if (row.role !== 'assistant' || !text.includes('[steering] ' + PREFIX)) { out.push(row); continue; }
      const parts = text.split(/(?:^|\n)\[steering\] ([^\n]*)\n?/);
      for (let i = 0; i < parts.length; i++) {
        const note = i % 2 ? decode(parts[i]) : null;
        if (note) out.push(user(row, note));
        else if (parts[i].trim()) out.push({ ...row, content: i % 2 ? '[steering] ' + parts[i] : parts[i] });
      }
    }
    return out;
  }
  return { normalize, encode, decode, sameWire, containsWire, displayRows, MAX_TEXT };
});
