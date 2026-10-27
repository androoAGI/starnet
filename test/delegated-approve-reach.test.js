/* node test/delegated-approve-reach.test.js — a background worker's Approve once / Deny on its DELEGATED row (soak 10-15).

   The soak clicked a background worker's Approve once key 240 times while its fs.write waited (09:49:56Z–09:59:56Z); the
   ask expired on its own and the file was never written. The clicks never reached the key: the soak's probe scrolled the
   key to the log's centre without a gesture, COMMS' follow pinned the log back to the bottom in the next frame, and the
   press landed on the row under the old point (proven with the real delegated.js + the lifted follow code in headless
   Chrome; see the lane report). This file pins what the ROW owes once a click does reach it:
     · the key answers the waiting ask with the ask's own runId (the lead's answer slot — its reply ended long ago) and
       promptId, through the approval card's own path (Chat.answerConsent, via 'row');
     · a key whose ask this page no longer holds never sits there doing nothing: the card repaints to what the ask became;
     · an ask the STATION no longer holds (answered elsewhere, expired or withdrawn while this page was not listening)
       never reads "try again": the keys leave and the row says the approval is no longer waiting — your answer was not
       applied (no decision is claimed for it);
     · a transport failure (the station did not answer) keeps the keys, so the Commander can answer again.
   And chat.js answerConsent: the consent route's `gone` answer clears this page's record of the ask, its bell entry and
   its card (in neutral words), and rejects with gone:true — never the "Please try again" a refused answer gets. */
'use strict';
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const flush = () => new Promise(r => setTimeout(r, 0));

(async () => {

/* ---------------- 1. the DELEGATED row's keys (the real delegated.js click handler) ---------------- */
{
  const W = require('../frontend/app/workstreams.js');
  const C = require('../frontend/app/channels.js'); C.reset();
  W.init({ generalId: 'ws_lead', activeId: 'ws_lead', workstreams: [
    { id: 'ws_lead', title: 'Poem hand-off', agentId: 'agent', history: [] },
    { id: 'ws_copy', title: 'Write a two-line poem about the station', agentId: 'copywriter', parentStreamId: 'ws_lead', worker: true, createdAt: 1000, history: [] }
  ] });
  global.Workstreams = W; global.Channels = C;
  global.Overseer = { snapshot: () => ({ threads: [{ id: 'ws_copy', leadRunId: 'lead1', slot: 0, call: 'c1' }],
    workers: [{ id: 'sub1', streamId: 'ws_copy', runId: 'w1', status: 'running', parentStreamId: 'ws_lead', parentRunId: 'lead1', agentId: 'copywriter', startedAt: Date.now() - 5000 }] }),
    fresh: () => true, unreachable: () => false };
  global.App = { agents: () => [{ id: 'agent', name: 'NOVA' }, { id: 'copywriter', name: 'COPY' }], agentName: id => ({ agent: 'NOVA', copywriter: 'COPY' })[id] || id };
  const notes = [];
  global.StationUI = { notify: (text, kind) => notes.push(kind + ':' + text) };
  let click = null, repaints = 0;
  global.document = { addEventListener: (name, fn) => { if (name === 'click') click = fn; }, getElementById: id => { if (id === 'chat-log') repaints++; return null; } };
  const D = require('../frontend/app/delegated.js');
  D.presentFor();   // wires the real click delegation
  A.ok(typeof click === 'function', 'fixture: the row keys are wired through the document click handler');
  const L = D._internals;
  const ask = (id) => ({ promptId: id, agentId: 'agent', tool: 'fs.write', argsSummary: '{"path":"soak-poem.txt"}', runId: 'lead1',
    workerAgentId: 'copywriter', workerRunId: 'w1', workerStreamId: 'ws_copy', askedAt: Date.now(), background: true });
  // what the page files for a background ask (chat.js fileBackgroundAsk): the ask's own runId, never the conversation's live one
  C.setPending('ws_lead', ask('p-live'));
  const press = (decision, promptId) => {
    const key = { dataset: { dgConsent: decision, dgWs: 'ws_copy', dgPrompt: promptId }, disabled: false };
    click({ target: { closest: sel => sel === '#chat-log [data-dg-consent]' ? key : null }, preventDefault() {} });
    return key;
  };
  const rowHtml = () => L.lineHtml(D.batches('ws_lead')[0], 'ws_lead');
  A.ok(/data-dg-consent="once" data-dg-ws="ws_copy" data-dg-prompt="p-live"/.test(rowHtml()), 'fixture: the waiting worker\'s row offers Approve once for its ask');

  // a click that reaches the key answers THAT ask, on the lead's answer slot
  const answered = [];
  global.Chat = { consentPhrase: () => 'write soak-poem.txt', answerConsent: (p, ws, decision, via) => {
    answered.push({ runId: p.runId, promptId: p.promptId, decision, via, ws: ws && ws.id });
    C.clearPending(ws.id, Date.now(), p.promptId);
    return Promise.resolve({ appliedDecision: decision });
  } };
  press('once', 'p-live'); await flush();
  A.eq(answered, [{ runId: 'lead1', promptId: 'p-live', decision: 'once', via: 'row', ws: 'ws_lead' }],
    'Approve once answers the waiting ask with its own runId (the lead\'s slot, after its reply ended) through the card\'s own path');
  A.ok(!/data-dg-consent=/.test(rowHtml()), 'answered: the row keeps no key that answers nothing');

  // a stale key (its ask was settled and this page already knows it): the card repaints to what the ask became
  repaints = 0; answered.length = 0;
  press('once', 'p-live'); await flush();
  A.eq(answered.length, 0, 'a key whose ask is no longer filed here sends nothing');
  A.ok(repaints > 0, 'and the card repaints at once, so a key that answers nothing never stays on screen doing nothing');

  // the STATION no longer holds the ask (answered on another surface whose word never reached this page, expired, withdrawn):
  // answerConsent clears the page's record and rejects with gone:true (part 2 pins that end)
  C.setPending('ws_lead', ask('p-gone'));
  notes.length = 0;
  global.Chat.answerConsent = (p, ws) => {
    C.clearPending(ws.id, Date.now(), p.promptId);
    const e = new Error('that approval is no longer waiting, so your answer was not applied'); e.gone = true;
    return Promise.reject(e);
  };
  press('once', 'p-gone'); await flush(); await flush();
  const goneRow = rowHtml();
  A.ok(!/data-dg-consent=/.test(goneRow), 'a gone ask leaves no Approve once / Deny on its row');
  A.ok(/no longer waiting/i.test(goneRow) && /not applied/i.test(goneRow), 'the row says the approval is no longer waiting and the answer was not applied: ' + goneRow.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  A.ok(!/approved|denied|declined/i.test(goneRow.replace(/<[^>]+>/g, ' ')), 'and claims no decision for it (this page does not know what settled it)');
  A.ok(notes.length === 1 && /COPY/.test(notes[0]) && /no longer waiting/.test(notes[0]), 'one toast names the worker and says so: ' + notes.join(' | '));
  A.ok(!notes.some(n => /try again|could not send/i.test(n)), 'never "try again" for an ask nothing can answer any more');

  // the worker asks again later: the new ask is what the row shows (the old note does not linger over a live ask)
  C.setPending('ws_lead', ask('p-next'));
  const next = rowHtml();
  A.ok(/data-dg-prompt="p-next"/.test(next) && !/no longer waiting/i.test(next), 'a new ask on the row replaces the old note with its own keys');

  // the station did not answer (unreachable): the ask may still wait, so its keys stay and the toast says it was not sent
  notes.length = 0;
  global.Chat.answerConsent = () => Promise.reject(new Error('The station did not confirm that answer. Please try again.'));
  press('deny', 'p-next'); await flush(); await flush();
  A.ok(/data-dg-consent="deny" data-dg-ws="ws_copy" data-dg-prompt="p-next"(?![^>]*disabled)/.test(rowHtml()), 'a transport failure keeps the row\'s keys live (the ask may still wait)');
  A.ok(notes.length === 1 && /Could not send that answer/.test(notes[0]), 'and says the answer was not sent');

  delete global.Chat; delete global.StationUI; delete global.App; delete global.Overseer; delete global.document; delete global.Workstreams; delete global.Channels;
  C.reset();
}

/* ---------------- 2. chat.js answerConsent: the consent route's `gone` answer ---------------- */
{
  const ch = rd('frontend/app/chat.js');
  const a = ch.indexOf('  const settledPromptNotices = new Set();'), b = ch.indexOf('  // the channel\'s record of an ask', a);
  const g = ch.indexOf('  /* AN ASK THE STATION NO LONGER HOLDS (soak 10-15).'), h = ch.indexOf('  function permissionRow(p, ws) {', g);
  A.ok(a > 0 && b > a && g > 0 && h > g, 'fixture: answerConsent and the gone-ask helper are where this test lifts them from');
  const Channels = require('../frontend/app/channels.js'); Channels.reset();
  const emitted = [], retired = [], settled = [], rerendered = [];
  let consentReply = null;
  const ctx = vm.createContext({ console, Promise, Date, Number, String, Object, Set, Map, Array, Error,
    Channels,
    Harness: { consent: async (runId, promptId, decision) => { emitted.push('POST:' + runId + ':' + promptId + ':' + decision); return consentReply; } },
    U: { bus: { emit: (n, p) => emitted.push(n + ':' + p.promptId), on: () => {} } },
    StationUI: { notify: () => {}, settleNotifs: key => settled.push(key) },
    Workstreams: { get: id => ({ id, agentId: 'agent' }) },
    App: {}, isActiveWs: () => true, renderPresence: () => {}, syncStatus: () => {}, askerName: () => 'COPY', actionPhrase: () => 'write soak-poem.txt',
    retireConsentCard: (id, text) => { retired.push(id + ':' + text); return true; },
    Delegated: { repaint: () => rerendered.push('delegated') }, NeedsYou: { render: () => rerendered.push('needs') } });
  vm.runInContext(ch.slice(a, b) + ch.slice(g, h) + '\n;this.__answer = answerConsent;', ctx, { filename: 'chat-answer-consent.js' });
  const p = { promptId: 'p9', agentId: 'agent', tool: 'fs.write', runId: 'lead1', background: true, workerAgentId: 'copywriter', workerStreamId: 'ws_copy' };
  Channels.setPending('ws_lead', Object.assign({}, p));
  Channels.setPending('ws_lead', { promptId: 'p10', agentId: 'agent', tool: 'fs.write', runId: 'lead1', background: true, workerAgentId: 'strategist', workerStreamId: 'ws_strat' });

  consentReply = { ok: false, decision: 'deny', gone: true };
  let err = null;
  try { await ctx.__answer(p, { id: 'ws_lead', agentId: 'agent' }, 'once', 'row'); } catch (e) { err = e; }
  A.ok(!!err && err.gone === true, 'a gone answer rejects marked gone');
  A.ok(!!err && !/try again/i.test(err.message) && /no longer waiting/i.test(err.message), 'in words that never ask for a retry: ' + (err && err.message));
  A.eq(emitted, ['POST:lead1:p9:once'], 'it was sent to the ask\'s own run, and no decision is announced on the bus for it');
  A.eq(Channels.pendingAllOf('ws_lead').map(x => x.promptId), ['p10'], 'this page lets go of exactly that ask (a sibling still waits)');
  A.eq(retired, ['p9:■ no longer waiting on you'], 'its card (if one is drawn) retires in neutral words');
  A.ok(rerendered.includes('delegated') && rerendered.includes('needs'), 'the worker\'s row and NEEDS YOU repaint for it');
  A.eq(settled.length, 0, 'the conversation\'s bell entry stays while a sibling ask still waits');

  // a refused answer the station still holds (not gone): unchanged — the ask stays filed, the answer can be sent again
  consentReply = { ok: false, decision: 'deny' };
  emitted.length = 0; retired.length = 0;
  const q = { promptId: 'p10', agentId: 'agent', tool: 'fs.write', runId: 'lead1', background: true };
  let err2 = null;
  try { await ctx.__answer(q, { id: 'ws_lead', agentId: 'agent' }, 'deny', 'row'); } catch (e) { err2 = e; }
  A.ok(!!err2 && !err2.gone, 'a refused answer is not "gone"');
  A.eq(Channels.pendingAllOf('ws_lead').map(x => x.promptId), ['p10'], 'and its ask stays filed');
  A.eq(retired.length, 0, 'its card stays live');

  // the last ask goes: the conversation's bell entry settles with it
  consentReply = { ok: false, decision: 'deny', gone: true };
  try { await ctx.__answer(q, { id: 'ws_lead', agentId: 'agent' }, 'once', 'needs-you'); } catch (_) { /* gone: asserted below */ }
  A.eq(Channels.pendingAllOf('ws_lead').length, 0, 'the last gone ask leaves nothing filed');
  A.eq(settled, ['needs:ws_lead'], 'and the conversation\'s bell entry settles');
  Channels.reset();
}

/* ---------------- 3. wiring ---------------- */
{
  const ch = rd('frontend/app/chat.js');
  // the COMMS card itself: a gone answer has already retired it in neutral words, so its keys are not handed back
  A.ok(/catch \(e\) \{\s*submitting = false;[\s\S]{0,200}if \(e && e\.gone\) \{\s*if \(!decided\) \{ decided = true; btns\.remove\(\);[\s\S]{0,260}'■ no longer waiting on you'[\s\S]{0,80}\}\s*return;\s*\}\s*if \(received && applyElsewhere\)/.test(ch),
    'the approval card never re-arms its keys for an ask the station no longer holds (it retires in neutral words)');
}

A.report('delegated-approve-reach.test');
})().catch(e => { console.log('FAIL: delegated-approve-reach.test threw - ' + (e && e.stack || e)); process.exit(1); });
