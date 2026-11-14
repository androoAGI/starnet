'use strict';
/* A long desk chat driven through the production window seam (sidecar/turn-window.js apply) on a memory transcript store, for
   the window-step tests (cost lane W2.6). The page is modelled the way chat.js keeps and posts a long chat: the newest 120
   rows (HistoryFit.HISTORY_CAP), fitted to its budget by the shared fit, each row carrying the durable id the station gave it. */
const Fit = require('../../frontend/app/historyfit.js');
const Store = require('../../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../../sidecar/transcript-history.js');
const Dual = require('../../sidecar/turn-dual.js');

const NOW = 1000000;
const turnId = k => 'step_turn_' + String(k).padStart(6, '0');
// row sizes measured on a real station's chats (cost audit 2026-11-08): a message ~352 characters, a reply ~1,175
const ask = k => 'ask ' + k + ' ' + 'q'.repeat(352), reply = k => 'reply ' + k + ' ' + 'a'.repeat(1175);

function makeChat(options) {
  const o = options || {}, streamId = o.streamId || 's';
  let mode = o.mode || 'shadow';
  const records = [];
  const dual = Dual.make({ now: () => NOW, hash: x => x, env: key => key === 'STARNET_TURNID_WINDOW' ? mode : undefined });
  const recordOwner = dual.record; dual.record = (surface, event) => { records.push({ surface, event }); recordOwner(surface, event); };
  const store = Store.makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => NOW }, pick: (...args) => dual.pick(...args) });
  const page = [];   // the page's copies of the durable rows, oldest first
  let sent = 0;      // exchanges the stream holds
  const pageRow = row => ({ role: row.role, content: row.content, rowId: row.rowId, streamId, turnId: row.turnId });
  // one finished exchange: the directive row and the reply, as a run writes them
  function finish(k) {
    page.push(pageRow(store.appendStrict({ streamId, agentId: 'a', role: 'user', content: (o.ask || ask)(k), turnId: turnId(k), directive: true })));
    page.push(pageRow(store.appendStrict({ streamId, agentId: 'a', role: 'assistant', content: (o.reply || reply)(k), turnId: turnId(k) })));
    sent = k + 1;
  }
  const newest = k => ({ role: 'user', content: (o.ask || ask)(k), turnId: turnId(k), turnAt: NOW });
  // what the page posts for send k: its system row, the rows the shared fit keeps of its newest 120, the new directive last
  function posted(k, budget) {
    let rows = Fit.fitHistoryBytes(page.concat([newest(k)]).slice(-Fit.HISTORY_CAP), Fit.HISTORY_WIRE_MAX_BYTES);
    if (Number.isFinite(budget)) rows = Fit.fitHistoryTokens(rows, budget);
    return [{ role: 'system', content: 'SYSTEM' }].concat(rows);
  }
  const request = (k, budget, extra) => Object.assign({ streamId, agentId: 'a', turnId: turnId(k), windowCaller: 'desk',
    clientClock: { clientNow: NOW, at: NOW } }, Number.isFinite(budget) ? { windowTokens: budget } : null, extra);
  const context = k => ({ agentId: 'a', runId: 'run-' + k, directive: { turnId: turnId(k) } });
  // the canonical replayable rows of the stream as the station's view shapes them, with send k's directive last (the posted
  // message itself): what a window is a suffix of, and what the station measures
  const canonical = k => page.map(row => ({ role: row.role, content: row.content })).concat([newest(k)]);
  return { store, dual, records, page, finish, newest, posted, request, context, canonical, streamId,
    setMode: next => { mode = next; }, get sent() { return sent; } };
}
// the history a window sends, as the bytes a provider would be handed: every non-system message's role and content, in order
const dialogue = messages => (Array.isArray(messages) ? messages : []).filter(m => m && m.role !== 'system');
const wire = messages => dialogue(messages).map(m => JSON.stringify({ role: m.role, content: m.content }));
// how many leading bytes two sends share, counted in whole messages and then inside the first one that differs
function sharedBytes(a, b) {
  let bytes = 0, i = 0;
  for (; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) bytes += Buffer.byteLength(a[i]) + 1;
  if (i < Math.min(a.length, b.length)) { const x = Buffer.from(a[i]), y = Buffer.from(b[i]); let j = 0; while (j < Math.min(x.length, y.length) && x[j] === y[j]) j++; bytes += j; }
  return bytes;
}
const totalBytes = lines => lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
module.exports = { makeChat, dialogue, wire, sharedBytes, totalBytes, turnId, ask, reply, NOW };
