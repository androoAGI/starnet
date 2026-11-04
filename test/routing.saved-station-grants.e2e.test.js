/* node test/routing.saved-station-grants.e2e.test.js — a headless run's bay room comes from the SAVED station and from nothing a
   page says, over the REAL sidecar (qa/bugs/a9a4f53c).

   A dev-channel run (the same hub, router.stationFor and runOnce a Telegram message takes) is recorded off the provider
   wire by a mock OpenRouter that keeps each request's `tools`. The saved floor is the routing authority: what a bay's agent may
   use is the room the SAVED station gives that bay, and the default office where the station crews the agent nowhere. A page's
   POST /api/routing is only a question — is this exactly the saved floor? — so a hint that lists more (or fewer) objects than the
   save holds, or names a bay no station holds, is pending (409) and changes nothing, before and after a restart:
     1. with no saved station, a hint naming a bay for the chat's agent grants it no bay: the run keeps the default office, the
        same one before and after the restart, and no routing.plan.json is written;
     2. a saved UNEQUIPPED bay (the floor paints NO COMPUTE) grants no compute: no provider call carries a tool, whatever a hint
        lists for that bay;
     3. a saved station that crews the agent in a compute-only bay hands its run exactly that room, narrower than the default
        office: neither a hint naming another bay nor one listing a CABINET and a DISH for the real bay adds a tool, before or after
        a restart;
     4. a DISH saved into that room reaches the run, and a CABINET nobody saved still does not;
     5. the dish coming off in the save narrows the very next run: the save is the grant, so no lagging page can hand it back.
   fs_write comes only from a cabinet, web_search only from a dish and notebook.* only from a notebook
   (capability/registry.js), so each one is a clean reading of which room the run was handed. In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WM = require('../frontend/app/worldmodel.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { canonical, publishFloor } = require('./helpers/saved-floor.js');

const HOST = '127.0.0.1';

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch (e) { parsed = { parseError: String(e && e.message) }; }
          requests.push(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'listed.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

const toolNamesOf = req => ((req && req.tools) || []).map(t => String((t.function && t.function.name) || t.name || ''));
const sameSet = (a, b) => a.slice().sort().join(',') === b.slice().sort().join(',');
const within = (a, b) => a.every(n => b.indexOf(n) >= 0);
const isMemory = n => /^notebook[._-]?(write|read)$/.test(n);

(async () => {
  const mock = await startMockOpenRouter();
  const fixture = SidecarFixture.create({ prefix: 'sk-saved-station-grants-', env: {
    SKYNET_DEV: '1', SKYNET_QUEST_REFRESH: '0',
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-saved-station-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
  } });
  // one dev-channel task turn -> the tools of the widest provider request it made (a turn may also make toolless aux calls)
  const turn = async (label) => {
    const before = mock.requests.length;
    const r = await fixture.json('POST', '/api/dev/inbound', { chatId: 'auth1', text: 'please run a task: list the files in the workspace' });
    A.eq(r.status, 200, label + ': the dev inbound answers (' + String(r.text).slice(0, 160) + ')');
    const reqs = mock.requests.slice(before);
    A.ok(reqs.length >= 1, label + ': the run reached the provider');
    return reqs.map(toolNamesOf).sort((a, b) => b.length - a.length)[0] || [];
  };
  // one dev-channel task turn that must NOT reach the provider with tools (a compute-less room never makes a model call)
  const toollessTurn = async (label) => {
    const before = mock.requests.length;
    const r = await fixture.json('POST', '/api/dev/inbound', { chatId: 'auth1', text: 'please run a task: list the files in the workspace' });
    A.eq(r.status, 200, label + ': the dev inbound answers (' + String(r.text).slice(0, 160) + ')');
    A.ok(r.body && r.body.isTask === true, label + ': the message ran as a task (' + String(r.text).slice(0, 160) + ')');
    return mock.requests.slice(before).filter(q => toolNamesOf(q).length > 0);
  };
  // a hint a page might hold that is NOT the saved floor: it names a bay and lists room objects the save does not hold. It is only asked about.
  const WIDE = ['computer', 'workbench', 'dish', 'cabinet', 'orchestrator', { objectType: 'connector', connectorId: 'ghost-connector' }];
  const hintOf = (propId, objects) => ({ version: 1, compilerLinks: null,
    plan: { errors: [], hash: 'forged-' + propId, sources: [], belts: [], bays: [{ agentId: 'dev_auth1', propId, objects }], dockBays: [{ agentId: 'dev_auth1', propId, objects }] } });
  const pending = async (hint, label) => {
    const r = await fixture.json('POST', '/api/routing', hint);
    A.eq([r.status, r.body.ok, r.body.pending === true], [409, false, true], label + ' is only pending: the station does not hold that floor (' + r.text.slice(0, 160) + ')');
  };
  // the chat's agent crews a bay; its room holds a PC (not when bare) and a dish (when asked)
  const stationDoc = (opts) => {
    const doc = WM.defaultDoc();
    doc.props.push({ id: 'bay1', t: 'bay', x: 4, y: 1, w: 2, h: 2, agentId: 'dev_auth1' });
    if (!opts.bare) doc.props.push({ id: 'pc1', t: 'console', x: 7, y: 1, w: 2, h: 1, agentId: 'dev_auth1' });
    if (opts.dish) doc.props.push({ id: 'dish1', t: 'comms_dish', x: 10, y: 1, w: 1, h: 1 });
    doc._nid = 4;
    return canonical(doc);
  };
  const oldPlanFile = () => path.join(fixture.workspace, 'routing.plan.json');
  try {
    await fixture.start();

    // ---- 1. no saved station: a hint names no bay for the agent ----
    const base = await turn('baseline');
    A.ok(base.length > 0, 'baseline: the run carries its default office (' + base.length + ' tools)');
    A.ok(base.some(isMemory), 'baseline: the default office carries the NOTEBOOK (' + base.filter(isMemory).join(',') + ')');
    await pending(hintOf('ghost_bay', WIDE), 'a hint naming a bay no station holds');
    const ghost = await turn('ghost bay');
    A.ok(sameSet(ghost, base), 'with no saved station, a hint\'s bay changes nothing: the run keeps the default office (' + ghost.length + ' vs ' + base.length + ' tools)');
    await fixture.restart();
    const ghostReboot = await turn('ghost bay after restart');
    A.ok(sameSet(ghostReboot, base), 'and after a restart, with no page, the run still gets the default office');
    A.ok(!fs.existsSync(oldPlanFile()), 'no routing.plan.json was ever written: a hint is not kept');

    // ---- 2. a saved unequipped bay: no compute, whatever a hint lists ----
    await publishFloor(fixture, stationDoc({ bare: true }), { label: 'an unequipped bay crewed by the chat\'s agent' });
    const bare = await toollessTurn('unequipped saved bay');
    A.eq(bare.length, 0, 'a saved UNEQUIPPED bay grants no compute: the run makes no tooled provider call (and not the full office)');
    await pending(hintOf('bay1', WIDE), 'a hint listing every object for the saved bare bay');
    A.eq((await toollessTurn('unequipped saved bay, wide hint')).length, 0, 'a hint listing everything for it still grants no compute');

    // ---- 3. a saved compute-only bay: no hint widens it ----
    await publishFloor(fixture, stationDoc({}), { label: 'a compute-only bay crewed by the chat\'s agent' });
    const narrow = await turn('saved compute-only bay');
    A.eq(narrow.indexOf('fs_write'), -1, 'saved compute-only bay: no CABINET, no fs_write');
    A.eq(narrow.indexOf('web_search'), -1, 'saved compute-only bay: no DISH, no web_search');
    A.ok(narrow.length > 0 && narrow.length < base.length && within(narrow, base), 'the saved bay room is narrower than the default office (' + narrow.length + ' < ' + base.length + ')');
    await pending(hintOf('ghost_bay', WIDE), 'a hint naming another bay');
    A.ok(sameSet(await turn('saved compute-only bay, ghost hint'), narrow), 'a hint naming another bay adds nothing');
    await pending(hintOf('bay1', ['computer', 'cabinet', 'dish']), 'a hint listing a cabinet and a dish for the saved bay');
    const listed = await turn('saved bay, listed objects');
    A.ok(sameSet(listed, narrow), 'objects a hint lists for the saved bay add nothing (' + listed.length + ' vs ' + narrow.length + ')');
    await fixture.restart();
    const listedReboot = await turn('saved bay after restart');
    A.ok(sameSet(listedReboot, narrow), 'after a restart, before any page posts again, the run gets the same saved room');

    // ---- 4. the saved room IS the grant: a dish saved into it reaches the run, a cabinet nobody saved does not ----
    await publishFloor(fixture, stationDoc({ dish: true }), { label: 'the same bay room with a dish' });
    const dish = await turn('saved bay with a dish');
    A.ok(dish.indexOf('web_search') >= 0, 'the DISH saved into the bay room reaches the run (web_search offered)');
    A.eq(dish.indexOf('fs_write'), -1, 'the cabinet nobody saved grants no fs_write');

    // ---- 5. the save narrows at once: the dish comes off and the next run has none ----
    await publishFloor(fixture, stationDoc({}), { label: 'the bay room with its dish taken off' });
    const lag = await turn('saved bay, dish taken off');
    A.eq(lag.indexOf('web_search'), -1, 'the DISH the save no longer holds is not granted');
    A.ok(sameSet(lag, narrow), 'the run gets the compute-only room again (' + lag.length + ' vs ' + narrow.length + ')');
    A.ok(!fs.existsSync(oldPlanFile()), 'through all of it no routing.plan.json was written');
  } finally {
    await fixture.dispose();
    mock.server.close();
  }
  A.report('routing.saved-station-grants.e2e');
})().catch(e => { console.error(e); process.exitCode = 1; });
