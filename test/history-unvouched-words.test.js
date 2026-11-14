/* node test/history-unvouched-words.test.js — a history the station cannot vouch for never says "try again in a moment".

   Review R56-1-D3 (stabilization plan C0-5, condition 3; the copy from 257147c37, #178). When a send is held because the
   conversation's history could not be read back, chat.js's ensureHistoryReady said, for every 5xx: "the station answered but
   could not read it just now. Your message is kept; try sending again in a moment." For a history the station cannot vouch for
   (503 TRANSCRIPT_UNVOUCHED: a damaged line it kept, the known shapes 1c/1d) every resend is refused the same way, and the send
   has already asked once more (PG5: no permanent hold says "try again"). The 0.15.1 copy fix (c517bf240) dropped the promise;
   here the page reads the station's code: an unvouched history says sending again will not help and names what to do (a
   restart, then a diagnostic readout); any other 5xx keeps its words, and so does an unanswered read.
   Through the real page read seam (test/helpers/seal-rig.js: Workstreams, HistoryRef, the Harness.api client and chat.js's
   hydrateHistory / reconcileServerHistory / ensureHistoryReady), over a station that answers each route as the case says. Both trees. */
'use strict';
const A = require('./_assert.js');
const Rig = require('./helpers/seal-rig.js');
const { answer } = require('./helpers/harness-api.js');

const UNVOUCHED = { error: 'The station could not prove this history yet.', code: 'TRANSCRIPT_UNVOUCHED' };
const record = (id, history) => ({ id, title: 'session ' + id, agentId: 'agent', kind: 'chat', lane: 'active', history, runIds: [], createdAt: 1800000000000, lastActiveAt: 1800000000000, lastReadAt: 1800000000001 });
const slice = rec => ({ workstreams: [rec], activeId: rec.id, generalId: rec.id });
const plainRows = [{ role: 'user', content: 'question one', ts: 1 }, { role: 'assistant', content: 'answer one', ts: 2 }];
// rows the page already numbered: a GET that does not return them makes the page ask the cached-row proof about them
const numberedRows = [{ streamId: 'talk', rowId: 7, role: 'user', content: 'question one', ts: 1 }, { streamId: 'talk', rowId: 8, role: 'assistant', content: 'answer one', ts: 2 }];

// a station that answers the GET, the cached-row proof and the by-id read as told; down: nothing answers
function station(o) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    const u = new URL(url, 'http://station.test'), method = (init && init.method) || 'GET';
    calls.push(method + ' ' + u.pathname);
    if (o.down) throw new TypeError('Failed to fetch');
    if (method === 'GET' && u.pathname === '/api/transcript') return o.get ? answer(o.get[0], o.get[1]) : answer(200, { turns: [] });
    if (u.pathname === '/api/turn-identity/retractions') return answer(o.proof[0], o.proof[1]);
    if (u.pathname === '/api/transcript/rows') return answer(o.rows[0], o.rows[1]);
    return answer(404, { error: 'no route' });
  } };
}
async function refusalOn(T, rows, o) {
  const tp = station(o);
  const p = Rig.page({ tree: T, tp, init: slice(record('talk', rows)) });
  A.eq(await p.load('talk'), false, 'fixture: the page does not claim a restore (' + JSON.stringify(o) + ')');
  let refused = null;
  try { await p.api.ensureHistoryReady(p.W.get('talk'), new AbortController().signal); } catch (e) { refused = e; }
  A.ok(refused && refused.code === 'HISTORY_UNAVAILABLE', 'fixture: the send is held with HISTORY_UNAVAILABLE');
  return String((refused && refused.message) || '');
}
const promisesRetry = s => /try (sending )?again|in a moment/i.test(s);

(async () => {
  for (const root of ['frontend/app', 'website/app/app']) {
    const T = Rig.tree(root), t = root + ': ';
    // 1. the GET answers 503 TRANSCRIPT_UNVOUCHED
    {
      const said = await refusalOn(T, plainRows, { get: [503, UNVOUCHED] });
      A.ok(/history could not be restored/.test(said) && !/connection returns/.test(said), t + 'unvouched GET: said as a station that answered (' + said + ')');
      A.ok(!promisesRetry(said), t + 'unvouched GET: it never says to try again or wait a moment');
      A.ok(/sending again will not help/.test(said) && /Your message is kept/.test(said), t + 'it says sending again will not help, and the message is kept');
      A.ok(/Restart StarNet once/.test(said) && /SETTINGS › APP & BACKUP › COPY DIAGNOSTICS/.test(said), t + 'and names what to do: a restart, then a diagnostic readout from where it is');
    }
    // 2. the GET answers, but the proof of the page's cached rows answers 503 TRANSCRIPT_UNVOUCHED
    {
      const said = await refusalOn(T, numberedRows, { get: [200, { turns: [] }], proof: [503, { error: 'Cached transcript identity could not be proved.', code: 'TRANSCRIPT_UNVOUCHED' }] });
      A.ok(!promisesRetry(said) && /sending again will not help/.test(said), t + 'unvouched cached-row proof: the same words (' + said + ')');
    }
    // 3. a packed history whose by-id read answers 503 TRANSCRIPT_UNVOUCHED
    {
      const seals = new Map(numberedRows.map(r => [T.HR.keyOf('talk', r.rowId), JSON.parse(JSON.stringify(r))]));
      const packed = T.HR.pack(JSON.parse(JSON.stringify(numberedRows)), { streamId: 'talk', seal: k => seals.get(k) || null });
      A.ok(T.HR.hasRef(packed), t + 'fixture: the history is packed');
      const said = await refusalOn(T, packed, { rows: [503, { error: 'The station could not prove these rows.', code: 'TRANSCRIPT_UNVOUCHED' }] });
      A.ok(!promisesRetry(said) && /sending again will not help/.test(said), t + 'unvouched by-id read: the same words (' + said + ')');
    }
    // 4. any other 5xx keeps its words: a broken read may answer on the next try
    {
      const said = await refusalOn(T, plainRows, { get: [500, { error: 'transcript read failed' }] });
      A.ok(/try sending again in a moment/.test(said) && !/will not help/.test(said), t + 'a 500 with no code keeps "try sending again in a moment" (' + said + ')');
      const said503 = await refusalOn(T, plainRows, { get: [503, { error: 'busy' }] });
      A.ok(/try sending again in a moment/.test(said503), t + 'and so does a 503 that names no unvouched history');
    }
    // 5. an unanswered read still blames the connection, as before
    {
      const said = await refusalOn(T, plainRows, { down: true });
      A.ok(/try again when the connection returns/.test(said), t + 'an unanswered read keeps its words (' + said + ')');
    }
  }
  A.report('history-unvouched-words.test (R56-1-D3)');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
