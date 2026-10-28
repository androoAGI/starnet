/* test/roster-push-base.test.js — the PAGE half of the roster's revision check (save-latch-kill, review 10-27). The station
   refuses a roster push built on an older station revision unless it can merge it row by row (sidecar handleRoster,
   mergeRosterRows; roster-cas.http.test.js proves the station side). That only holds if the page SENDS what it is built on:
   app.js pushRoster must carry the station revision its crew view is built on (CloudSave.revision()), the window it writes
   as (CloudSave.writerId()), and rosterBase — the rows of its last ACCEPTED push and the rows it changed since. Without
   them every page push falls back to the page-clock stamp and the newest clock wins again. And a control the station did
   not record says what the station said, never "try again once the station is reachable" when it answered.
   The real pushRoster / rosterRefusalWords / setAgentApproval run in a vm against a recorded fetch. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fnBody } = require('./_fnbody.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
const slice = h => { const b = fnBody(app, h); A.ok(b.startsWith(h) && b.length > 50 && b.length < 8000, 'sliced exactly ' + h + ' (' + b.length + ' chars)'); return b; };
const src = ['function pushRoster()', 'function rosterRefusalWords()', 'function setAgentApproval(agentId, mode, opts)'].map(slice).join('\n');

(async () => {
  const posts = [];
  let answer = { ok: true };
  const crew = [{ id: 'agent', name: 'NOVA', systemPrompt: 's', approvalMode: 'ask' }, { id: 'c1', name: 'Ada', systemPrompt: 's1', approvalMode: 'ask' }];
  const notes = [];
  const ctx = vm.createContext({
    console: { info() {}, warn() {}, log() {} }, JSON, Map, Set, Array, Promise, Date, String, Object,
    fetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); const a = answer; return { ok: true, status: 200, json: async () => a }; },
    CloudSave: { revision: () => 41, writerId: () => 'win-1', markDegraded() {} },
    Harness: { getProv: () => 'openrouter' },
    StationUI: { setRoster() {}, notify: (m, k) => notes.push(m) },
    liveAgents: () => crew, stationDefaultWire: () => ({ provider: 'openrouter' }), rosterRole: () => 'r', executionProfileOf: () => 'standard', rosterTrack: () => '',
    agents: new Map(crew.map(a => [a.id, a])), agent: crew[0], persist: () => true
  });
  vm.runInContext('let lastRosterPush = Promise.resolve(); let rosterPushFailed = false; let rosterRefusal = null; let rosterAccepted = new Map();\n' + src +
    '\nthis.api = { pushRoster, rosterRefusalWords, setAgentApproval };', ctx);
  const api = ctx.api;

  A.eq(await api.pushRoster(), true, 'the first push lands');
  const p1 = posts[0].body;
  A.eq([p1.saveRevision, p1.saveClient], [41, 'win-1'], 'the push carries the station revision this crew view is built on, and the window (CloudSave.revision / writerId)');
  A.eq([p1.rosterBase && p1.rosterBase.known, p1.rosterBase && p1.rosterBase.changed], [[], ['agent', 'c1']], 'the first push: nothing accepted before, every row is new');
  crew[1].name = 'Ada Prime';
  A.eq(await api.pushRoster(), true, 'a second push lands');
  const p2 = posts[1].body;
  A.eq([p2.rosterBase.known, p2.rosterBase.changed], [['agent', 'c1'], ['c1']], 'the next push names the rows of the last accepted push, and only the row it changed since');
  // the station refuses one: the reverted control says what the station said
  answer = { ok: false, stale: true, behind: true };
  api.setAgentApproval('c1', 'full');
  await new Promise(r => setTimeout(r, 20));
  A.eq(crew[1].approvalMode, 'ask', 'a refused approval change is put back');
  A.ok(notes.length === 1 && /Another window saved newer station changes/.test(notes[0]) && !/reachable/.test(notes[0]), 'and the notice says why the station refused it, never "once the station is reachable" (' + notes[0] + ')');
  answer = { ok: true };
  crew[1].name = 'Ada II';
  await api.pushRoster();
  A.eq(posts[posts.length - 1].body.rosterBase.changed.sort(), ['c1'], 'after a refusal, the base is still the last ACCEPTED push (the refused one changed nothing on the station)');
  A.report('roster-push-base');
})().catch(e => { console.log('FAIL: unhandled ' + (e && e.stack || e)); process.exit(1); });
