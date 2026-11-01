/* node test/remote-sessions.test.js — frontend/app/remotesessions.js with the desk's globals faked.
   A conversation held from a phone must become a desk session, show busy only while the station says its run is
   live, and reload the open session when a phone turn lands in it — and never resurrect a deleted session. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');

const sessions = new Map();
const deleted = new Set(['remote_forge_deleted']);
const busy = new Map();
const loads = [];
let activeId = null, railRefreshes = 0, persists = 0;
let routes = {};

globalThis.Workstreams = {
  get: (id) => sessions.get(id) || null,
  adopt: (o) => { if (sessions.has(o.id)) return sessions.get(o.id); if (deleted.has(o.id)) return null; const w = Object.assign({ lastActiveAt: 0 }, o); sessions.set(o.id, w); return w; },
  activeId: () => activeId
};
globalThis.Channels = {
  isBusy: (id) => busy.has(id), begin: (id, ts) => busy.set(id, { ts, status: '', runId: null }),
  setStatus: (id, s) => { if (busy.has(id)) busy.get(id).status = s; }, end: (id) => busy.delete(id),
  runIdOf: (id) => (busy.get(id) || {}).runId || null
};
globalThis.Chat = { load: (ws) => loads.push(ws.id) };
globalThis.App = { refreshRail: () => { railRefreshes++; }, persist: () => { persists++; } };
const handlers = {};
globalThis.U = { bus: { on: (n, fn) => { (handlers[n] = handlers[n] || []).push(fn); } } };
globalThis.fetch = async (url) => { const body = routes[String(url).split('?')[0]]; return body === undefined ? { ok: false, json: async () => null } : { ok: true, json: async () => body }; };

const { RemoteSessions } = require('../frontend/app/remotesessions.js');
const I = RemoteSessions._internals;

(async () => {
  // a live phone run on a stream the desk has never seen -> adopted, busy, titled with what was said
  routes['/api/remote/recent'] = { ok: true, runs: [{ runId: 'r1', agentId: 'forge', streamId: 'remote_forge_a1', title: '  tighten   the hero copy ', startedAt: 1000, endedAt: null, live: true }] };
  await I.sync(false);
  const ws = sessions.get('remote_forge_a1');
  A.ok(!!ws, 'a phone-started conversation is adopted as a desk session');
  A.eq(ws && ws.title, 'tighten the hero copy', 'titled with what the Commander said');
  A.eq(ws && ws.agentId, 'forge', 'bound to the agent that ran it');
  A.eq(ws && ws.history, [], 'no dialogue is invented: the transcript comes from the normal session load');
  A.ok(busy.has('remote_forge_a1'), 'it shows busy while the station says the run is live');
  A.ok(/phone/.test(busy.get('remote_forge_a1').status), 'and says where the work came from');
  A.eq(loads.length, 0, 'adopting never steals focus');
  A.ok(railRefreshes >= 1 && persists >= 1, 'the rail repaints and the session is persisted');

  // the run ends while that session is on screen -> busy clears, the session reloads (merging the transcript)
  activeId = 'remote_forge_a1';
  routes['/api/remote/recent'] = { ok: true, runs: [{ runId: 'r1', agentId: 'forge', streamId: 'remote_forge_a1', title: 'tighten the hero copy', startedAt: 1000, endedAt: 9000, live: false }] };
  await I.sync(false);
  A.ok(!busy.has('remote_forge_a1'), 'busy clears when the station says the run ended');
  A.eq(loads, ['remote_forge_a1'], 'the open session is reloaded so the reply appears');
  A.eq(ws.lastActiveAt, 9000, 'its last-active time is the run end');
  await I.sync(false);
  A.eq(loads.length, 1, 'an already-applied run end is not applied again');

  // a phone turn into an EXISTING desk session that is not on screen: no reload, no adopt, busy handled
  sessions.set('ws_desk1', { id: 'ws_desk1', title: 'Launch plan', agentId: 'forge', lastActiveAt: 5 });
  activeId = 'something_else';
  routes['/api/remote/recent'] = { ok: true, runs: [{ runId: 'r2', agentId: 'forge', streamId: 'ws_desk1', title: 'what is the code word', startedAt: 10000, endedAt: null, live: true }] };
  await I.sync(false);
  A.ok(busy.has('ws_desk1'), 'a desk session a phone is working in shows busy');
  A.eq(sessions.get('ws_desk1').title, 'Launch plan', 'and keeps its own title');
  routes['/api/remote/recent'] = { ok: true, runs: [{ runId: 'r2', agentId: 'forge', streamId: 'ws_desk1', startedAt: 10000, endedAt: 12000, live: false }] };
  await I.sync(false);
  A.ok(!busy.has('ws_desk1'), 'then clears');
  A.eq(loads.length, 1, 'a session that is not on screen is not reloaded (the normal open merges it)');

  // the desk's own run is never ended by this module
  busy.set('ws_desk1', { ts: 1, status: 'thinking', runId: 'page-run-1' });
  I.applyRun({ runId: 'r3', agentId: 'forge', streamId: 'ws_desk1', endedAt: 13000, live: false });
  A.ok(busy.has('ws_desk1'), 'a busy state owned by the page\'s own run is left alone');
  busy.delete('ws_desk1');

  // deleted stays deleted; junk ids and unknown desk streams are ignored
  A.eq(I.applyRun({ runId: 'r4', agentId: 'forge', streamId: 'remote_forge_deleted', title: 'x', live: true }), false, 'a session the Commander deleted is not resurrected');
  A.ok(!sessions.has('remote_forge_deleted'), 'and no row is made');
  A.eq(I.applyRun({ runId: 'r5', agentId: 'forge', streamId: '../etc', live: true }), false, 'a bad stream id is ignored');
  A.eq(I.applyRun({ runId: 'r6', agentId: 'forge', streamId: 'ws_unknown', live: true }), false, 'an unknown non-phone stream is not adopted');
  A.ok(!sessions.has('ws_unknown'), 'no row for it');

  // boot backfill: phone conversations held while the desk was closed appear from run history
  routes['/api/remote/recent'] = { ok: true, runs: [] };
  routes['/api/runs'] = { runs: [
    { runId: 'h2', agentId: 'scout', streamId: 'remote_scout_b2', title: 'second message', endedAt: 2000 },
    { runId: 'h1', agentId: 'scout', streamId: 'remote_scout_b2', title: 'first message', endedAt: 1500 },
    { runId: 'c1', agentId: 'scout', streamId: 'cron-abc', title: 'routine', endedAt: 1200 }
  ] };
  await I.sync(true);
  const back = sessions.get('remote_scout_b2');
  A.ok(!!back, 'a phone conversation from run history is adopted at boot');
  A.eq(back && back.title, 'first message', 'titled by its first message');
  A.ok(!sessions.has('cron-abc'), 'routine streams are left to autosessions');
  A.ok(!busy.has('remote_scout_b2'), 'a finished run is never shown busy');

  // fail-open: a dead route changes nothing and throws nothing
  routes = {};
  const n = sessions.size;
  await I.sync(true);
  A.eq(sessions.size, n, 'an unreachable station changes nothing');

  A.eq(I.titleOf(''), 'From your phone', 'an empty title still reads honestly');

  // a QUESTION answered from the phone settles the desk's card too (sweep 2026-10-01): the sidecar tells the run's
  // stream, and the question card listens the way the approval card does
  {
    const rd = p => require('fs').readFileSync(require('path').join(__dirname, '..', p), 'utf8');
    const idx = readSidecarSource(), chat = rd('frontend/app/chat.js');
    A.ok(/const viaRemote = \(d\) => \{ orig\(d\); const decision = typeof d === 'string' \? [^;]+: \(d && d\.__clarify \? 'once' : null\);/.test(idx), 'a phone reply to a question emits permission.response on the desk run');
    const clar = chat.slice(chat.indexOf('function clarifyRow('), chat.indexOf('function permissionRow('));
    A.ok(/U\.bus\.on\('permission\.response', onElsewhere\)/.test(clar) && /'✓ answered' \+ settledWhere\(resp\)/.test(clar) && /resp\.via \? '' : ' from your phone'/.test(chat) &&/Channels\.clearPending\(ws\.id, Date\.now\(\), p\.promptId\)/.test(clar), 'the question card settles to "answered from your phone" and clears only its own prompt');
  }
  A.report('remote-sessions');
})().catch((e) => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
