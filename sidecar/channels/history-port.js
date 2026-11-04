/* Canonical chat history. Host-only contexts retain the actual scoped store and its legacy source
   namespace; they are never serialized or reconstructed from a request body. */
'use strict';
const View = require('../turn-view.js');
const Kinds = require('../../frontend/app/turnkinds.js');
const SID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const SHA = /^[a-f0-9]{64}$/;
function held(message) { return Object.assign(new Error(message), { code: 'CHANNEL_HISTORY_UNAVAILABLE' }); }
function keyFor(chatId, prefix) {
  const head = String(prefix || '');
  const tail = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40 - head.length);
  return head + (tail || '0');
}
function resolveStream(channel, chatId, record, options, note) {
  const o = options || {};
  let explicit = '';
  try { if (typeof o.streamIdFor === 'function') explicit = String(o.streamIdFor(chatId) || ''); }
  catch (error) { if (note) note('channels.history.stream', error); }
  if (SID.test(explicit)) return { streamId: explicit, explicit: true };
  if (o.bindChats === false) return { streamId: null, explicit: false };
  const bound = record && typeof record.streamId === 'string' ? record.streamId : '';
  if (SID.test(bound)) return { streamId: bound, explicit: false };
  return { streamId: ('channel_' + channel + '_' + String(chatId)).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64), explicit: false };
}
function makeChannelHistory(d) {
  if (!d || typeof d.view !== 'function' || typeof d.append !== 'function' || typeof d.hash !== 'function' || typeof d.now !== 'function') {
    throw new Error('Channel history needs its Store, hash and clock owners');
  }
  const contexts = new WeakSet(), queues = new WeakMap();
  const note = (tag, error) => { if (typeof d.failNote === 'function') d.failNote(tag, error); };
  function resolve(channel, chatId, record, options) {
    return resolveStream(channel, chatId, record, options, note);
  }
  function streamFor(channel, chatId, record, options) { return resolve(channel, chatId, record, options).streamId; }
  function context(host) {
    const o = host || {}, store = o.store || d.legacyStore;
    if (!store || typeof store.getChatRecord !== 'function' || typeof store.saveChatRecord !== 'function' ||
        typeof o.channel !== 'string' || !o.channel || o.chatId == null || (o.bindChats !== false && !KEY.test(o.legacyKey || ''))) {
      throw held('The chat history context is incomplete');
    }
    const chatId = String(o.chatId), record = store.getChatRecord(chatId, { readOnly: true }) || {};
    const found = resolve(o.channel, chatId, record, o);
    const chat = Object.freeze({ store, channel: o.channel, chatId, legacyKey: o.legacyKey || '',
      bindChats: o.bindChats !== false, streamId: found.streamId, explicit: found.explicit,
      // Agent-bound Telegram bots inherited tg_<chat> files without their chat-record namespace.
      // A nonempty such file cannot prove which bot conversation wrote it.
      legacyIsolated: typeof o.legacyIsolated === 'boolean' ? o.legacyIsolated : !o.channel.startsWith('telegram:') });
    contexts.add(chat); return chat;
  }
  function chatOf(value) {
    const chat = value && value.chat || value;
    if (!chat || !contexts.has(chat)) throw held('A host-owned chat history context is required');
    return chat;
  }
  function serialized(chat, work) {
    let map = queues.get(chat.store);
    if (!map) { map = new Map(); queues.set(chat.store, map); }
    const previous = map.get(chat.chatId) || Promise.resolve();
    const task = previous.then(work, work);
    map.set(chat.chatId, task);
    // This branch handles its own rejection; the returned task preserves it for the visible caller.
    task.then(() => { if (map.get(chat.chatId) === task) map.delete(chat.chatId); },
      () => { if (map.get(chat.chatId) === task) map.delete(chat.chatId); });
    return task;
  }
  function current(chat) {
    const record = chat.store.getChatRecord(chat.chatId, { readOnly: true }) || {};
    if (chat.bindChats && !chat.explicit && record.streamId && record.streamId !== chat.streamId) throw held('The chat moved to a different stream');
    return record;
  }
  function proof(streamId) {
    if (!SID.test(streamId || '')) throw held('The chat has no canonical stream');
    const rows = d.view('proof', streamId, { complete: true });
    if (!Array.isArray(rows)) throw held('Canonical chat history could not be proved');
    const ids = new Set();
    for (const row of rows) {
      if (!row || row.streamId !== streamId || !Number.isSafeInteger(row.rowId) || row.rowId <= 0 || ids.has(row.rowId) || row.idFrom === 'collision') {
        throw held('Canonical chat history identity is ambiguous');
      }
      ids.add(row.rowId);
    }
    const ordered = [...ids];
    for (let offset = 0; offset < ordered.length; offset += 2000) {
      const authority = typeof d.cacheRetractions === 'function' && d.cacheRetractions(streamId, ordered.slice(offset, offset + 2000));
      if (!authority || authority.state !== 'done') throw held('Canonical chat history identity could not be proved globally');
    }
    return rows;
  }
  function saveMarker(chat, marker, extra) {
    const patch = Object.assign({}, extra, { legacyImport: marker });
    chat.store.saveChatRecord(chat.chatId, patch);
    const readback = chat.store.getChatRecord(chat.chatId, { readOnly: true });
    if (!readback || JSON.stringify(readback.legacyImport) !== JSON.stringify(marker) ||
        (extra && extra.streamId !== undefined && readback.streamId !== extra.streamId)) throw held('The history import marker was not durably acknowledged');
    return readback;
  }
  function sourceTags(chat, record) {
    const hops = record.hopKeys === undefined ? [] : record.hopKeys;
    if (!Array.isArray(hops) || hops.length > 32 || hops.some(tag => typeof tag !== 'string' || !/^hop_[a-f0-9]{32}$/.test(tag))) throw held('Legacy hop sources are malformed');
    return [...new Set([chat.legacyKey, ...hops])];
  }
  function sourceRows(chat, tags) {
    if (typeof chat.store.loadHistory !== 'function') throw held('The legacy history reader is unavailable');
    return tags.map(tag => {
      const rows = chat.store.loadHistory(tag, { readOnly: true });
      if (!Array.isArray(rows)) throw held('Legacy history source is unknown');
      if (rows.some(row => !row || !['user', 'assistant', 'system'].includes(row.role) || typeof row.content !== 'string' ||
          row.content.length > Kinds.LEGACY_FINAL_CONTENT_MAX || !Number.isSafeInteger(row.ts) || row.ts < 0)) throw held('Legacy history cannot be preserved as canonical rows');
      if (tag === chat.legacyKey && rows.length && !chat.legacyIsolated) throw held('Legacy chat history has no isolated source namespace');
      return { tag, rows, count: rows.length, sha256: d.hash(JSON.stringify(rows.map(row => [row.role, row.ts, row.content]))) };
    });
  }
  function importedKey(tag, row, index) { return 'lg:' + tag + ':' + index + ':' + d.hash(row.role + '\0' + row.ts + '\0' + row.content).slice(0, 12); }
  function redactedText(text) {
    const result = d.redact ? d.redact(text) : text;
    if (typeof result !== 'string' || result.length > Kinds.LEGACY_FINAL_CONTENT_MAX) throw held('Redacted history cannot be preserved as one canonical row');
    return result;
  }
  function sameRow(row, expected) {
    return !!row && Number.isSafeInteger(row.rowId) && row.rowId > 0 &&
      Object.keys(expected).every(key => row[key] === expected[key]) &&
      Object.keys(row).every(key => key === 'rowId' || Object.prototype.hasOwnProperty.call(expected, key));
  }
  function validImport(marker) {
    return marker && marker.v === 1 && marker.state === 'importing' && Number.isSafeInteger(marker.at) && marker.at >= 0 &&
      Array.isArray(marker.sources) && marker.sources.length > 0 && marker.sources.length <= 33 &&
      marker.sources.every(source => source && KEY.test(source.tag || '') && Number.isSafeInteger(source.count) && source.count >= 0 && SHA.test(source.sha256 || '')) &&
      new Set(marker.sources.map(source => source.tag)).size === marker.sources.length;
  }
  async function ensure(chat, agentId) {
    if (!chat.bindChats) return { state: 'unbound', n: 0 };
    const record = current(chat), marker = record.legacyImport;
    if (marker && (marker.state === 'done' || marker.state === 'abandoned')) {
      if (marker.v !== 1 || !Number.isSafeInteger(marker.at) || marker.at < 0 ||
          (marker.state === 'done' && (!Number.isSafeInteger(marker.n) || marker.n < 0)) ||
          (marker.state === 'abandoned' && !['new', 'forgotten'].includes(marker.reason))) throw held('The completed legacy import marker is malformed');
      return { state: marker.state, n: marker.n || 0 };
    }
    if (typeof d.deletedAt === 'function' && d.deletedAt(chat.streamId) > 0) {
      saveMarker(chat, { v: 1, state: 'abandoned', reason: 'forgotten', at: d.now() });
      return { state: 'abandoned', n: 0 };
    }
    if (marker && !validImport(marker)) throw held('The legacy import marker is malformed');
    const existing = proof(chat.streamId);
    if (!marker && existing.length) {
      saveMarker(chat, { v: 1, state: 'done', reason: 'canonical', at: d.now(), n: 0 });
      return { state: 'done', n: 0 };
    }
    const tags = marker ? marker.sources.map(source => source.tag) : sourceTags(chat, record);
    const sources = sourceRows(chat, tags);
    if (sources.some(source => source.rows.length) && !KEY.test(agentId || '')) throw held('The imported history has no valid agent owner');
    const descriptors = sources.map(({ tag, count, sha256 }) => ({ tag, count, sha256 }));
    if (marker && JSON.stringify(descriptors) !== JSON.stringify(marker.sources)) throw held('Legacy history changed during an incomplete import');
    const importing = marker || { v: 1, state: 'importing', at: d.now(), sources: descriptors };
    if (!validImport(importing)) throw held('Legacy source evidence could not be encoded');
    const expected = new Map();
    for (const source of sources) for (let index = 0; index < source.rows.length; index++) {
      const row = source.rows[index], importKey = importedKey(source.tag, row, index);
      expected.set(importKey, { streamId: chat.streamId, agentId, role: row.role, content: redactedText(row.content),
        ts: row.ts, kind: 'observed', importKey });
    }
    if (!marker) saveMarker(chat, importing);
    const keys = new Set();
    for (const row of existing) {
      if (typeof row.importKey !== 'string' || !expected.has(row.importKey) || keys.has(row.importKey) ||
          !sameRow(row, expected.get(row.importKey))) throw held('Incomplete import contains conflicting canonical rows');
      keys.add(row.importKey);
    }
    let n = 0;
    try {
      for (const source of sources) for (let index = 0; index < source.rows.length; index++) {
        if (typeof d.deletedAt === 'function' && d.deletedAt(chat.streamId) > 0) throw held('The chat was forgotten during import');
        const row = source.rows[index], importKey = importedKey(source.tag, row, index);
        if (!keys.has(importKey)) {
          const stored = await d.append(expected.get(importKey));
          if (!sameRow(stored, expected.get(importKey))) throw held('Imported history has no exact durable acknowledgement');
          keys.add(importKey);
        }
        n++;
      }
      if (typeof d.deletedAt === 'function' && d.deletedAt(chat.streamId) > 0) throw held('The chat was forgotten during import');
      const accepted = proof(chat.streamId), confirmed = new Set();
      for (const row of accepted) {
        if (!expected.has(row.importKey) || confirmed.has(row.importKey) || !sameRow(row, expected.get(row.importKey))) throw held('Accepted import does not match its complete source');
        confirmed.add(row.importKey);
      }
      if (confirmed.size !== expected.size) throw held('Accepted import is incomplete');
      saveMarker(chat, { v: 1, state: 'done', at: importing.at, n });
      return { state: 'done', n };
    } catch (error) { note('channels.import.incomplete', error); throw error; }
  }
  function ensureImported(ctx) {
    const chat = chatOf(ctx);
    if (ctx.streamId != null && ctx.streamId !== chat.streamId) throw held('The requested stream is not this chat history');
    return serialized(chat, () => ensure(chat, ctx.agentId || ''));
  }
  async function importLegacy(ctx) { return (await ensureImported(ctx)).n; }
  async function destination(ctx) {
    await ensureImported(ctx);
    const chat = readyChat(ctx);
    if (!chat.streamId) throw held('The chat has no canonical delivery destination');
    return chat.streamId;
  }
  function readyChat(ctx) {
    const chat = chatOf(ctx);
    current(chat); // /new may have completed while this entry awaited its import owner.
    if (ctx.streamId != null && ctx.streamId !== chat.streamId) throw held('The requested stream is not this chat history');
    return chat;
  }
  function legacyReplay(chat, agentId) {
    if (chat.bindChats || !KEY.test(agentId || '') || typeof chat.store.loadHistory !== 'function') throw held('The unbound history owner is unavailable');
    const rows = chat.store.loadHistory(agentId);
    if (!Array.isArray(rows)) throw held('The unbound history could not be read');
    return rows.map(row => Object.assign({}, row));
  }
  async function replay(ctx) {
    if (!ctx || ctx.shape !== 'pairs') throw new Error('Channel history replay requires the literal pairs shape');
    await ensureImported(ctx);
    const chat = readyChat(ctx);
    if (!chat.streamId) return legacyReplay(chat, ctx.agentId);
    // ctx.forAgent: a line stage reading this chat replays its words, never the tool traffic of the agents before it (TurnKinds.foreignTools)
    const rows = d.view('model-replay', chat.streamId, { complete: true, rows: true, shape: 'pairs', form: 'pre',
      line: ctx.line, excludeTurnId: ctx.excludeTurnId, forAgent: ctx.forAgent });
    if (!Array.isArray(rows)) throw held('Canonical chat replay could not be proved');
    const outcomes = new Map(), unknown = new Set();
    const messages = View.messages(rows, (row, classification) => {
      if (!ctx.line || classification.kind !== 'hop') return true;
      const runId = String(row.sourceRunId || '');
      if (!outcomes.has(runId)) outcomes.set(runId, typeof d.outcomeOf === 'function' ? d.outcomeOf(runId) : null);
      const outcome = outcomes.get(runId);
      if (outcome == null) unknown.add(runId);
      return outcome !== 'failed' && outcome !== 'refused' || row.directive === true;
    });
    if (unknown.size) note('channels.hop.outcome-unknown', new Error(JSON.stringify({ count: unknown.size, runIds: [...unknown].slice(0, 50) })));
    return messages;
  }
  async function count(ctx) { return (await replay(Object.assign({}, ctx, { shape: 'pairs' }))).length; }
  function legacyMirror(agentId, role, text, ctx) {
    const chat = chatOf(ctx);
    if (chat.bindChats || !KEY.test(agentId || '') || typeof chat.store.appendTurn !== 'function') throw held('Legacy writes require an unbound host-owned chat');
    return chat.store.appendTurn(agentId, role, text);
  }
  async function observe(ctx) {
    if (!ctx || !KEY.test(ctx.agentId || '') || typeof ctx.text !== 'string' || ctx.text.length > Kinds.LEGACY_FINAL_CONTENT_MAX ||
        (Object.prototype.hasOwnProperty.call(ctx, 'taint') && ctx.taint !== null && typeof ctx.taint !== 'string')) throw new Error('Invalid channel observation');
    await ensureImported(ctx);
    const chat = readyChat(ctx), text = redactedText(ctx.text);
    if (!chat.streamId) { legacyMirror(ctx.agentId, 'user', text, ctx); return { rowId: null, legacy: true }; }
    const input = { streamId: chat.streamId, agentId: ctx.agentId, role: 'user', kind: 'observed', content: text, ts: d.now() };
    const expected = Object.assign({}, input);
    if (Object.prototype.hasOwnProperty.call(ctx, 'taint')) {
      input.taint = ctx.taint;
      expected.taintKnown = true;
      if (ctx.taint) expected.taint = ctx.taint.slice(0, 200);
    }
    const row = await d.append(input);
    if (!sameRow(row, expected)) throw held('The observed line has no exact durable acknowledgement');
    return { rowId: row.rowId };
  }
  async function deliver(ctx) {
    await ensureImported(ctx);
    const chat = readyChat(ctx);
    if (!chat.streamId || typeof d.writeDelivery !== 'function') throw held('The canonical delivery owner is unavailable');
    return d.writeDelivery(Object.assign({}, ctx, { streamId: chat.streamId, text: d.redact ? d.redact(ctx.text) : ctx.text }));
  }
  function rotate(ctx) {
    const chat = chatOf(ctx);
    return serialized(chat, () => {
      if (!KEY.test(ctx.agentId || '')) throw held('The history being rotated has no valid agent owner');
      const record = current(chat);
      const past = chat.streamId ? d.view('model-replay', chat.streamId, { complete: true, shape: 'pairs', form: 'pre' }) : [];
      if (!Array.isArray(past)) throw held('The history being rotated could not be counted');
      let next = chat.streamId;
      if (chat.streamId && !chat.explicit) {
        if (typeof d.newId !== 'function') throw held('The new stream identity owner is unavailable');
        const suffix = String(d.newId()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
        if (!suffix) throw held('The new stream identity could not be proved');
        const tail = '_n' + suffix, base = ('channel_' + chat.channel + '_' + chat.chatId).replace(/[^A-Za-z0-9_-]/g, '_');
        next = base.slice(0, 64 - tail.length) + tail;
        if (next === chat.streamId) throw held('The new stream identity was reused');
      }
      const marker = { v: 1, state: 'abandoned', reason: 'new', at: d.now() };
      saveMarker(chat, marker); // a stopped partial import can never revive after /new
      if (typeof chat.store.clearHistory !== 'function') throw held('The legacy history clear owner is unavailable');
      let dropped = chat.store.clearHistory(ctx.agentId) || 0;
      const hops = sourceTags(chat, record).filter(tag => tag !== chat.legacyKey);
      for (const tag of hops) dropped += chat.store.clearHistory(tag) || 0;
      if (next !== chat.streamId) saveMarker(chat, marker, { streamId: next });
      return { dropped: Math.max(dropped, past.length), newStreamId: next };
    });
  }
  // Hub consumers are wired only after this owner and its real Store adapter are independently proved.
  return { context, streamFor, ensureImported, importLegacy, destination, replay, count, observe, deliver, rotate, legacyMirror };
}
// Compatibility for hand-built test hubs only. Production's factory requires the canonical port.
// It deliberately identifies every replay as legacy; it never pretends to prove durable row identity.
function legacyPort(store, options) {
  const o = options || {}, contexts = new WeakSet();
  const note = typeof o.failNote === 'function' ? o.failNote : function () {};
  function streamFor(channel, chatId, record, opts) { return resolveStream(channel, chatId, record, opts, note).streamId; }
  function context(host) {
    const h = host || {}, s = h.store || store;
    const record = typeof s.getChatRecord === 'function' ? s.getChatRecord(h.chatId) : null;
    const chat = Object.freeze(Object.assign({}, h, { store: s, streamId: streamFor(h.channel, h.chatId, record, h) }));
    contexts.add(chat); return chat;
  }
  function chatOf(ctx) {
    const chat = ctx && ctx.chat;
    if (!chat || !contexts.has(chat)) throw held('A legacy test chat context is required');
    return chat;
  }
  async function replay(ctx) {
    if (!ctx || ctx.shape !== 'pairs') throw new Error('Channel history replay requires the literal pairs shape');
    const chat = chatOf(ctx);
    note('channels.hub.legacy-history', new Error('A hand-built hub replayed the legacy test store'));
    const rows = chat.store.loadHistory(ctx.legacyKey || ctx.agentId);
    if (!Array.isArray(rows)) throw held('Legacy test history is unavailable');
    return rows.map(row => Object.assign({}, row));
  }
  function legacyMirror(agentId, role, text, ctx) { return chatOf(ctx).store.appendTurn(agentId, role, text); }
  async function count(ctx) { return (await replay(Object.assign({}, ctx, { shape: 'pairs' }))).length; }
  async function observe(ctx) { legacyMirror(ctx.agentId, 'user', ctx.text, ctx); return { rowId: null, legacy: true }; }
  async function rotate(ctx) {
    const chat = chatOf(ctx), s = chat.store;
    let dropped = s.clearHistory(ctx.agentId) || 0;
    const record = typeof s.getChatRecord === 'function' ? s.getChatRecord(chat.chatId) : null;
    for (const key of record && Array.isArray(record.hopKeys) ? record.hopKeys : []) if (KEY.test(key)) dropped += s.clearHistory(key) || 0;
    return { dropped, newStreamId: chat.streamId };
  }
  return { legacy: true, context, streamFor, replay, count, observe, rotate, legacyMirror };
}
module.exports = { make: makeChannelHistory, makeChannelHistory, legacyPort, keyFor };
