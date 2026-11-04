'use strict';
/* node test/transcript-cursor.http.test.js — the cursor and by-id reads over a REAL sidecar (save-history-by-reference, S1).

   GET /api/transcript?stream=<id>&after=<rowId>&limit=<n> reads a stream forward and adds `cursor` { last, count, more }
   to the reply; POST /api/transcript/rows { streams: [{ streamId, rowIds }] } returns the rows a page names, in the
   order asked, and names every id it did not return (missing, retracted, forgotten). Seeded on disk before the sidecar
   boots (the transcript is the station's own durable file), read through the token gate, and checked against the
   old reads:
     · every old query string (limit, default, clamp, runId, delivery, view=model-replay, an unknown stream) answers with
       exactly the fields it always had, no `cursor`, and the turns of an `after` read are the turns of the old read;
     · a malformed `after`, or `after` beside runId/delivery/view, is refused with a 400, never read as 0;
     · rows by id are the very turn objects a GET returns, never another stream's row, hidden and undone rows are named
       rather than returned, a deleted session's rows are forgotten, bad bodies are refused, and the route sits behind the
       token gate;
     · all of it holds after the sidecar restarts on the same workspace. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const History = require('../sidecar/transcript-history.js');

const ids = rows => rows.map(r => r.rowId);
(async () => {
  const fixture = SidecarFixture.create({ prefix: 'transcript-cursor-http-', env: { STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0' } });
  try {
    // ---- seed: stream 'cur' has exactly 60 durable rows (hidden, undone and retried ones among them); 'other' and 'gone' have their own ----
    const quick = Object.create(fs); quick.fsyncSync = () => {};
    const seed = History.makeSegmentedTranscriptIo({ fs: quick, path, root: path.join(fixture.workspace, 'transcript-history-v2'), segmentBytes: 4096 });
    let ts = 1000;
    const cur = [], live = [], undone = [];
    const put = (extra, stream) => { const row = seed.appendDurable(Object.assign({ streamId: stream || 'cur', agentId: 'agent', role: 'user', kind: 'turn', taintKnown: true, ts: ++ts }, extra)); if (!stream) cur.push(row); return row; };
    const gone = [1, 2, 3].map(i => put({ role: i % 2 ? 'user' : 'assistant', content: 'GONE_ROW_' + i }, 'gone'));
    let station, other;
    for (let i = 0; cur.length < 60; i++) {
      if (i % 5 === 2) other = put({ content: 'OTHER_STREAM_ROW_' + i }, 'other');
      if (i % 10 === 9) { const row = put({ role: 'assistant', kind: 'station', content: 'HIDDEN_STATION_' + i }); station = station || row; continue; }
      if (i === 20 || i === 55) {
        const target = i === 20 ? live.pop() : live[2];
        put({ role: 'system', kind: 'retract', targets: [target], reason: 'undo', content: '' });
        if (i === 55) live.splice(2, 1);
        undone.push(target); continue;
      }
      if (i === 40) { put({ role: 'system', kind: 'retract', targets: [live[live.length - 1]], reason: 'retry', content: '' }); continue; }
      const row = put({ role: i % 2 ? 'assistant' : 'user', content: 'cur row ' + i });
      live.push(row.rowId);
    }
    seed.close();
    A.eq(cur.length, 60, 'the seeded stream has exactly 60 durable rows');
    A.ok(live.length > 40 && undone.length === 2, 'live rows and two undone rows (' + live.length + ' live)');
    const byId = new Map(cur.map(r => [r.rowId, r]));
    const liveRows = live.map(id => byId.get(id));

    await fixture.start();
    const json = (method, route, body) => fixture.json(method, route, body);
    const get = route => json('GET', route);
    const OLD_KEYS = ['stream', 'turns', 'identity'];

    async function everything(label) {
      // ---- the old reads are untouched ----
      const old = await get('/api/transcript?stream=cur&limit=200');
      A.eq(old.status, 200, label + ': the old read answers');
      A.eq(Object.keys(old.body), OLD_KEYS, label + ': the old read has exactly its old fields, no cursor');
      A.eq(old.body.turns, liveRows, label + ': the old read is the live rows of the stream');
      A.eq(Object.keys(old.body.identity).slice(0, 4), ['v', 'streamId', 'fromRowId', 'liveRunIds'], label + ': the old identity is as it was');
      const five = await get('/api/transcript?stream=cur&limit=5');
      A.eq([Object.keys(five.body), ids(five.body.turns)], [OLD_KEYS, ids(liveRows.slice(-5))], label + ': limit=5 is the newest five, old shape');
      const dflt = await get('/api/transcript?stream=cur');
      A.eq([Object.keys(dflt.body), dflt.body.turns], [OLD_KEYS, liveRows], label + ': no limit is the default, old shape');
      const clamp = await get('/api/transcript?agent=agent&stream=cur&limit=100000');
      A.eq([Object.keys(clamp.body), clamp.body.turns], [OLD_KEYS, liveRows], label + ': a huge limit clamps at 500 and answers, old shape');
      A.eq(Object.keys((await get('/api/transcript?stream=cur&runId=nobody&limit=10')).body), OLD_KEYS, label + ': a runId read is old shape');
      A.eq(Object.keys((await get('/api/transcript?stream=cur&runId=nobody&delivery=1')).body), OLD_KEYS, label + ': a delivery read is old shape');
      A.eq(Object.keys((await get('/api/transcript?stream=cur&view=model-replay&limit=10')).body), OLD_KEYS, label + ': a model-replay read is old shape');
      const nobody = await get('/api/transcript?stream=nobody');
      A.eq([nobody.status, nobody.body.turns, Object.keys(nobody.body)], [200, [], OLD_KEYS], label + ': an unknown stream is empty, old shape');

      // ---- the cursor read ----
      const pages = [];
      for (let after = 0, guard = 0; guard < 10; guard++) {
        const page = await get('/api/transcript?stream=cur&after=' + after + '&limit=20');
        A.eq(page.status, 200, label + ': page after ' + after + ' answers');
        pages.push(page.body); after = page.body.cursor.last;
        if (!page.body.cursor.more) break;
      }
      A.eq(pages.length, 3, label + ': 60 durable rows by pages of 20 are three pages');
      A.eq(pages.map(p => p.cursor.last), [cur[19].rowId, cur[39].rowId, cur[59].rowId], label + ': each cursor ends at the last durable row of its window');
      A.eq(pages.map(p => p.cursor.more), [true, true, false], label + ': more until the last window');
      A.ok(pages.every(p => p.cursor.count === p.turns.length), label + ': count is the number of turns in the reply');
      A.ok(pages.every(p => JSON.stringify(Object.keys(p)) === JSON.stringify(['stream', 'turns', 'identity', 'cursor'])), label + ': the cursor rides after the old fields');
      A.eq(pages.every(p => p.stream === 'cur'), true, label + ': the reply names the stream');
      A.eq(pages.flatMap(p => p.turns), liveRows, label + ': the pages are the live rows once each, in order, the old read\'s turns');
      A.ok(!JSON.stringify(pages).includes('HIDDEN_STATION_') && !JSON.stringify(pages).includes('OTHER_STREAM_ROW_') && !JSON.stringify(pages).includes('GONE_ROW_'), label + ': no hidden, other-stream or deleted row in any page');
      const one = await get('/api/transcript?stream=cur&after=0&limit=500');
      A.eq([one.body.turns, one.body.identity, one.body.cursor], [old.body.turns, old.body.identity, { last: cur[59].rowId, count: liveRows.length, more: false }], label + ': one page of 500 is the old read plus its cursor');
      const over = await get('/api/transcript?stream=cur&after=100000&limit=5');
      A.eq([over.status, over.body.turns, over.body.cursor], [200, [], { last: 100000, count: 0, more: false }], label + ': a cursor past the end is empty and stays put');
      A.eq((await get('/api/transcript?stream=cur&after=' + cur[40].rowId + '&limit=100000')).body.cursor.more, false, label + ': a limit past 500 clamps and still ends');
      for (const query of ['after=abc', 'after=-1', 'after=1.5', 'after=', 'after=1e3', 'after=1234567890123456', 'after=0&runId=r1', 'after=0&delivery=1', 'after=0&view=model-replay']) {
        const refused = await get('/api/transcript?stream=cur&' + query);
        A.eq([refused.status, typeof refused.body.error, refused.body.turns], [400, 'string', undefined], label + ': ?' + query + ' is refused, not read as 0');
      }

      // ---- rows by id ----
      const names = [liveRows[30].rowId, liveRows[0].rowId, station.rowId, undone[0], other.rowId, 999999, liveRows[0].rowId, liveRows[45].rowId];
      const read = await json('POST', '/api/transcript/rows', { streams: [{ streamId: 'cur', rowIds: names }] });
      A.eq(read.status, 200, label + ': the rows read answers');
      A.eq(Object.keys(read.body), ['streams'], label + ': the reply is { streams }');
      const mine = read.body.streams[0];
      A.eq(Object.keys(mine), ['streamId', 'turns', 'missing', 'retracted', 'forgotten'], label + ': one entry per stream asked');
      A.eq([mine.streamId, ids(mine.turns)], ['cur', [liveRows[30].rowId, liveRows[0].rowId, liveRows[45].rowId]], label + ': the rows come back in the order asked, once each');
      A.eq(mine.turns, [liveRows[30], liveRows[0], liveRows[45]], label + ': they are the very turn objects a GET returns');
      A.eq([mine.missing, mine.retracted, mine.forgotten], [[station.rowId, other.rowId, 999999], [undone[0]], []], label + ': a hidden row, another stream\'s row and an unknown id are missing; an undone one is retracted');
      A.ok(!JSON.stringify(read.body).includes('HIDDEN_STATION_') && !JSON.stringify(read.body).includes('OTHER_STREAM_ROW_'), label + ': nothing hidden or foreign is returned');
      const many = await json('POST', '/api/transcript/rows', { agent: 'agent', streams: [{ streamId: 'cur', rowIds: ids(liveRows.slice(0, 10)) }, { streamId: 'other', rowIds: [other.rowId, liveRows[0].rowId] }, { streamId: 'nobody', rowIds: [liveRows[1].rowId] }] });
      A.eq(many.status, 200, label + ': several streams in one request');
      A.eq(many.body.streams.map(s => [s.streamId, ids(s.turns), s.missing]), [['cur', ids(liveRows.slice(0, 10)), []], ['other', [other.rowId], [liveRows[0].rowId]], ['nobody', [], [liveRows[1].rowId]]], label + ': each stream is read as itself');
      return { old: old.body, pages, read: read.body, many: many.body };
    }

    const first = await everything('first boot');

    // ---- a deleted session is forgotten ----
    const saved = await json('POST', '/api/save', { agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: 0,
      workstreams: [{ id: 'cur', title: 'Cursor', history: [] }], deletedIds: ['gone'], forgetIds: ['gone'] });
    A.eq(saved.status === 200 && saved.body && saved.body.ok, true, 'the save that deletes the session lands: ' + JSON.stringify(saved.body));
    const goneCursor = await get('/api/transcript?stream=gone&after=0&limit=50');
    A.eq([goneCursor.status, goneCursor.body.turns, goneCursor.body.cursor], [200, [], { last: gone[2].rowId, count: 0, more: false }], 'a deleted session reads empty by cursor, which passes its forgotten rows');
    const goneRows = await json('POST', '/api/transcript/rows', { streams: [{ streamId: 'gone', rowIds: ids(gone) }] });
    A.eq([goneRows.status, goneRows.body.streams[0].turns, goneRows.body.streams[0].forgotten, goneRows.body.streams[0].missing], [200, [], ids(gone), []], 'a deleted session\'s rows are named forgotten by id and never returned');
    A.ok(!JSON.stringify([goneCursor.body, goneRows.body]).includes('GONE_ROW_'), 'no deleted word leaves the station');

    // ---- the by-id route refuses what it cannot read, and sits behind the gate ----
    const post = (body, headers) => fixture.request('/api/transcript/rows', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body });
    const refused = async (label, response, status, field) => {
      const text = await response.text();
      A.eq(response.status, status, label + ' -> ' + status + ' (' + text.slice(0, 120) + ')');
      if (field) A.ok(text.includes(field), label + ' names ' + field);
    };
    await refused('malformed json', await post('{not json'), 400);
    await refused('no streams', await post('{}'), 400);
    await refused('empty streams', await post(JSON.stringify({ streams: [] })), 400);
    await refused('streams is not a list', await post(JSON.stringify({ streams: 'cur' })), 400);
    await refused('a bad agent id', await post(JSON.stringify({ agent: 'bad id!', streams: [{ streamId: 'cur', rowIds: [1] }] })), 400, 'bad_agent_id');
    await refused('a bad stream id', await post(JSON.stringify({ streams: [{ streamId: 'a b', rowIds: [1] }] })), 400);
    await refused('a path as a stream id', await post(JSON.stringify({ streams: [{ streamId: '../x', rowIds: [1] }] })), 400);
    await refused('a numeric stream id', await post(JSON.stringify({ streams: [{ streamId: 7, rowIds: [1] }] })), 400);
    await refused('a zero row id', await post(JSON.stringify({ streams: [{ streamId: 'cur', rowIds: [0] }] })), 400);
    await refused('a string row id', await post(JSON.stringify({ streams: [{ streamId: 'cur', rowIds: ['3'] }] })), 400);
    await refused('row ids that are not a list', await post(JSON.stringify({ streams: [{ streamId: 'cur', rowIds: 5 }] })), 400);
    await refused('1001 row ids', await post(JSON.stringify({ streams: [{ streamId: 'cur', rowIds: Array.from({ length: 1001 }, (_, i) => i + 1) }] })), 400);
    await refused('51 streams', await post(JSON.stringify({ streams: Array.from({ length: 51 }, () => ({ streamId: 'cur', rowIds: [1] })) })), 400);
    await refused('an oversized body', await post(JSON.stringify({ streams: [{ streamId: 'cur', rowIds: [1], pad: 'x'.repeat(70000) }] })), 413);
    await refused('a wrong token', await post(JSON.stringify({ streams: [{ streamId: 'cur', rowIds: [1] }] }), { 'X-StarNet-Token': 'not-this-launch' }), 403);
    const thousand = await json('POST', '/api/transcript/rows', { streams: [{ streamId: 'cur', rowIds: Array.from({ length: 1000 }, (_, i) => i + 1) }] });
    A.eq([thousand.status, thousand.body.streams[0].turns.length], [200, liveRows.length], 'exactly 1000 ids is allowed');

    // ---- and all of it after a restart on the same workspace ----
    await fixture.restart();
    const second = await everything('after restart');
    A.eq(second.pages, first.pages, 'the cursor pages are byte-for-byte the same after a restart');
    A.eq(second.read, first.read, 'and so are the rows by id');
  } finally {
    await fixture.dispose();
  }
  A.report('transcript-cursor.http');
})().catch(error => { A.ok(false, error.stack || String(error)); A.report('transcript-cursor.http'); });
