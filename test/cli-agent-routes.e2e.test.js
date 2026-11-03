'use strict';
/* node test/cli-agent-routes.e2e.test.js — the terminal's /yolo, /personality and /model routes (POST /api/agent/approval,
   /api/agent/personality, /api/agent/model) against a REAL sidecar (hermetic SidecarFixture: temp workspace + profile, no
   provider, zero spend). Locks the re-cut reviews' approval-safety findings (review 10-24):
     0. only a StarNet PAGE counts as an open app: the page's EventSource signs in with an SSE ?ticket=, while a Node
        client on the same feed (the MCP bridge, sidecar/mcp/serve.js, sends the header token) is not a page — with only
        that attached, the routes take the no-page path at once (they used to wait 6 s and answer "a page is open");
     A. a StarNet page that is connected but never answers (its save takes longer than the bridge's 6 s) gets NO second
        write from a snapshot taken before the wait: the route answers 409 "the app did not confirm", the page's newer
        roster stands, and an agent the page deleted in that window is not brought back with full access. The reply says
        what the station's roster holds NOW (the page applies a change before it proves its save, so an unconfirmed
        /yolo may already be in force) — never "nothing was changed";
     B. /yolo off with no page open writes "ask" into the app's save too (the field the page hydrates and pushes back
        when it opens), so FULL ACCESS does not silently return; when the save cannot take it (damaged, missing, a newer
        StarNet's) the roster still asks first and the reply says the save did not take it — never refused while /yolo
        on would be allowed; /yolo on stays roster-only. Part of test:http. */
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const apitickets = require('../sidecar/apitickets.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a listener on the station's bus; onCommand sees each station.command. A PAGE signs in as the app's EventSource does
// (a single-use SSE ticket, no header: ApiTicket.sseUrl); a node client sends the header token (the MCP bridge's shape)
function listen(fixture, onCommand, asPage) {
  const p = asPage ? '/api/channels/events?ticket=' + encodeURIComponent(apitickets.mint(fixture.token, 'sse', apitickets.SCOPE_SSE, { now: Date.now() })) : '/api/channels/events';
  const headers = Object.assign({ Accept: 'text/event-stream', Origin: fixture.baseUrl }, asPage ? {} : { 'X-StarNet-Token': fixture.token });
  let status = 0;
  const req = http.request({ host: '127.0.0.1', port: fixture.port, path: p, method: 'GET', headers }, res => {
    status = res.statusCode;
    res.setEncoding('utf8'); let buf = '';
    res.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const b = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = b.split('\n').filter(l => l.indexOf('data: ') === 0).map(l => l.slice(6)).join('\n');
        if (!data) continue;
        try { const j = JSON.parse(data); if (j && j.name === 'station.command') onCommand(j.payload || {}); } catch (_) {}
      }
    });
  });
  req.on('error', () => {}); req.end();
  return { status: () => status, close: () => { try { req.destroy(); } catch (_) {} } };
}
const page = (fixture, onCommand) => listen(fixture, onCommand, true);
const row = (id, system, profile, extra) => Object.assign({ agentId: id, system, name: id.toUpperCase(), model: 'test/model', provider: 'openrouter', role: '', approvalMode: 'ask', executionProfile: profile, skills: [], reasoningEffort: null, track: '' }, extra || {});
const ENV = { STARNET_REMOTE_RELAY: 'off', SKYNET_REMOTE_RELAY: 'off',
  // a key so /model's provider check passes (no request is ever made: the base is a closed port)
  SKYNET_OPENROUTER_KEY: 'sk-or-v1-routes-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-routes-fake', SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:9/api/v1', STARNET_OPENROUTER_BASE: 'http://127.0.0.1:9/api/v1' };

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'sk-cli-agent-routes-', env: ENV });
  try {
    seedActiveStation(fixture.workspace);
    await fixture.start();
    const rosterFile = path.join(fixture.workspace, 'agent.roster.json');
    const onDisk = id => { try { return (JSON.parse(fs.readFileSync(rosterFile, 'utf8')).agents || []).find(a => a.agentId === id) || null; } catch (_) { return null; } };
    const runtime = async id => ((await fixture.json('GET', '/api/runtime/agent')).body.agents || []).find(a => a.agentId === id) || null;
    const push = agents => fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() });
    const timed = async (method, route, body) => { const t0 = Date.now(); const r = await fixture.json(method, route, body); r.ms = Date.now() - t0; return r; };

    /* ---- 0. a node client on the feed (the MCP bridge) is not an open app ---------------------------------------------- */
    {
      await push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK', 'station-gear', { approvalMode: 'full' })]);
      const asked = [];
      const mcp = listen(fixture, c => asked.push(c), false);
      await sleep(400);
      A.eq(mcp.status(), 200, 'the header-token listener is on the feed');
      const off = await timed('POST', '/api/agent/approval', { agentId: 'rook', mode: 'ask' });
      A.eq([off.status, off.body && off.body.via], [200, 'roster'], 'MCP attached, no page: /yolo off takes the no-page path — ' + JSON.stringify(off.body));
      A.ok(off.ms < 3000, 'at once, not after the bridge\'s 6 s wait: ' + off.ms + ' ms');
      A.eq((await runtime('rook')).approvalMode, 'ask', 'and the station holds rook to ask first (power CAN be taken away from the terminal)');
      const mr = await timed('POST', '/api/agent/model', { agentId: 'rook', model: 'test/other', provider: 'openrouter' });
      A.eq([mr.status, mr.body && mr.body.via, (await runtime('rook')).model], [200, 'roster', 'test/other'], '/model too');
      const pr = await timed('POST', '/api/agent/personality', { agentId: 'rook', personality: 'blunt', system: 'ROOK-BLUNT' });
      A.eq([pr.status, pr.body && pr.body.via], [200, 'roster'], '/personality too');
      A.ok(!asked.some(c => c.verb === 'station.control'), 'and no station command was sent to a page that is not there');
      mcp.close();
      await sleep(200);
    }

    /* ---- A1. a page pushes a newer roster for the agent in the window, then never acks ------------------------------ */
    {
      await push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK-V1', 'trusted-project')]);
      let seen = 0;
      const p = page(fixture, () => {
        if (seen++) return;
        // the page applied it and its roster push lands (recomposed prompt; the Commander narrowed the reach meanwhile)
        push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK-V2-NEWER', 'safe-cell', { approvalMode: 'full' })]);
        // …and its proveCrewSaved takes longer than the bridge's 6 s: no ack
      });
      await sleep(400);
      A.eq(p.status(), 200, 'the page signs in with an SSE ticket');
      const y = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'full' });
      p.close();
      A.eq(y.status, 409, 'a connected page that never answers: 409, no second write — ' + JSON.stringify(y.body));
      A.ok(y.body && y.body.pageOpen === true && y.body.unanswered === true && y.body.via !== 'roster', 'it says a page is open and did not answer (never "no app is open")');
      A.ok(!/nothing was changed/i.test(String(y.body && y.body.error)) && /may still/i.test(String(y.body && y.body.error)), 'and never "nothing was changed": the app may still be applying it — ' + (y.body && y.body.error));
      A.eq(y.body && y.body.station && y.body.station.approvalMode, 'full', 'the reply says what the station holds NOW, read after the wait: the page\'s push already put rook on full');
      const r = onDisk('rook');
      A.eq([r && r.system, r && r.executionProfile], ['ROOK-V2-NEWER', 'safe-cell'], 'the page\'s newer roster stands (the stale snapshot no longer overwrites it)');
    }

    /* ---- A2. the page deletes the agent in the window: it is not brought back ---------------------------------------- */
    {
      await push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK', 'station-gear'), row('scout', 'SCOUT', 'this-computer')]);
      let seen = 0;
      const p = page(fixture, () => { if (!seen++) push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK', 'station-gear')]); });
      await sleep(400);
      const y = await fixture.json('POST', '/api/agent/approval', { agentId: 'scout', mode: 'full' });
      p.close();
      A.eq([y.status, y.body && y.body.gone], [409, true], 'deleted in the window: 409, and the reply says it is gone from the roster');
      A.eq([onDisk('scout'), await runtime('scout')], [null, null], 'and the deleted agent stays deleted (not resurrected with full access)');
    }

    /* ---- A3. /personality and /model: the same rule ------------------------------------------------------------------ */
    {
      await push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK-P1', 'station-gear')]);
      let seen = 0;
      const p = page(fixture, () => { if (!seen++) push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK-P2-NEWER', 'station-gear')]); });
      await sleep(400);
      const pr = await fixture.json('POST', '/api/agent/personality', { agentId: 'rook', personality: 'blunt', system: 'ROOK-FROM-THE-TERMINAL' });
      p.close();
      A.eq([pr.status, pr.body && pr.body.unanswered], [409, true], '/personality with a page that never answers: 409, unconfirmed');
      A.eq(onDisk('rook') && onDisk('rook').system, 'ROOK-P2-NEWER', 'and the page\'s newer prompt stands');
      const p2 = page(fixture, () => {});
      await sleep(400);
      const mr = await fixture.json('POST', '/api/agent/model', { agentId: 'rook', model: 'test/other', provider: 'openrouter' });
      p2.close();
      A.ok(mr.status === 409 && mr.body && mr.body.pageOpen === true, '/model with a page that never answers: 409, a page is open: ' + mr.status + ' ' + JSON.stringify(mr.body));
      A.eq([mr.body && mr.body.station && mr.body.station.model, mr.body && mr.body.station && mr.body.station.provider], ['test/model', 'openrouter'], 'and the reply says the model the station holds now');
      A.eq(onDisk('rook') && onDisk('rook').model, 'test/model', 'and the roster keeps its model');
    }
    await sleep(300);   // the pages' SSE sockets close

    /* ---- B. /yolo off with no page: durable where the app reads it back ---------------------------------------------- */
    {
      await push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK', 'station-gear', { approvalMode: 'full' })]);
      // the app's save (what it hydrates its crew from when it opens): rook on FULL ACCESS
      const cur = await fixture.json('GET', '/api/save?agent=agent');
      const rev = Number(cur.body && cur.body.save && cur.body.save._saveRevision) || 0;
      const t0 = Date.now();
      const saved = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: 6, _saveRevision: rev, updatedAt: t0, agent: { id: 'agent', name: 'HERO', createdAt: 1, approvalMode: 'ask' },
        agents: [{ id: 'rook', name: 'ROOK', approvalMode: 'full', executionProfile: 'station-gear' }] });
      A.ok(saved.body && saved.body.ok === true, 'the app\'s save landed: ' + JSON.stringify(saved.body));
      const off = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'ask' });
      A.eq([off.status, off.body && off.body.via, off.body && off.body.save], [200, 'roster', 'patched'], '/yolo off with no page: the roster AND the app\'s save take it — ' + JSON.stringify(off.body));
      const after = (await fixture.json('GET', '/api/save?agent=agent')).body.save || {};
      const savedRook = (after.agents || []).find(a => a && a.id === 'rook') || {};
      A.eq(savedRook.approvalMode, 'ask', 'the app\'s save now says ask first for rook');
      A.ok(Number(after.updatedAt) > t0 && Number(after._saveRevision) > rev, 'on a newer copy the app adopts when it opens (updatedAt and revision moved)');
      A.eq([after.agent && after.agent.name, savedRook.name, savedRook.executionProfile], ['HERO', 'ROOK', 'station-gear'], 'nothing else in the save changed');
      A.eq((await runtime('rook')).approvalMode, 'ask', 'the station holds rook to ask first');
      await fixture.restart();
      A.eq((await runtime('rook')).approvalMode, 'ask', 'and still after a restart');
      const again = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'ask' });
      A.eq(again.body && again.body.save, 'agrees', 'a second /yolo off finds the save already agrees (no write)');
      // /yolo on stays roster-only: the app's own (safer) saved setting applies again when it opens
      const on = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'full' });
      A.eq([on.status, on.body && on.body.via, on.body && on.body.save], [200, 'roster', undefined], '/yolo on with no page: roster only');
      const after2 = (await fixture.json('GET', '/api/save?agent=agent')).body.save || {};
      A.eq(((after2.agents || []).find(a => a && a.id === 'rook') || {}).approvalMode, 'ask', 'and the save is left as the app last saved it');
      // an agent the save does not hold: said as such
      await push([row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK', 'station-gear', { approvalMode: 'full' }), row('nova', 'NOVA', 'station-gear', { approvalMode: 'full' })]);
      const nova = await fixture.json('POST', '/api/agent/approval', { agentId: 'nova', mode: 'ask' });
      A.eq([nova.status, nova.body && nova.body.save, (await runtime('nova')).approvalMode], [200, 'no-record', 'ask'], 'an agent with no row in the save: the roster asks first, and the reply says the save has no record of it');
      // a torn station save (no clean .bak): it holds nothing, so it is never reported as holding the change — and the
      // roster still asks first (taking power away is never refused)
      const main = path.join(fixture.workspace, 'agent.save.json');
      fs.writeFileSync(main, '{"version":1,"doc":{"agent":');
      try { fs.unlinkSync(main + '.bak'); } catch (_) {}
      const torn = await fixture.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'ask' });
      A.eq([torn.status, torn.body && torn.body.via, torn.body && torn.body.save], [200, 'roster', 'not-saved'], 'a damaged save: the roster takes it, the save did not — ' + JSON.stringify(torn.body));
      A.ok(/damaged/.test(String(torn.body && torn.body.saveError)), 'and the reply says why: ' + (torn.body && torn.body.saveError));
      A.eq((await runtime('rook')).approvalMode, 'ask', 'the station asks first for rook now');
    }
  } catch (e) {
    A.ok(false, 'cli-agent-routes e2e threw: ' + ((e && e.stack) || e));
  } finally {
    await fixture.dispose();
  }

  /* ---- D. a workspace a newer StarNet wrote: /yolo off is never refused where /yolo on is allowed ----------------------- */
  const degraded = SidecarFixture.create({ prefix: 'sk-cli-agent-routes-degraded-', env: ENV });
  try {
    fs.writeFileSync(path.join(degraded.workspace, '.schema-version.json'), JSON.stringify({ version: 1, schemaVersion: 99, stampedAt: Date.now() }));
    fs.writeFileSync(path.join(degraded.workspace, 'agent.roster.json'), JSON.stringify({ version: 1, updatedAt: Date.now() - 1000, agents: [row('agent', 'HERO', 'station-gear'), row('rook', 'ROOK', 'station-gear')] }));
    await degraded.start();
    const runtime = async id => ((await degraded.json('GET', '/api/runtime/agent')).body.agents || []).find(a => a.agentId === id) || null;
    const on = await degraded.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'full' });
    A.eq([on.status, (await runtime('rook')).approvalMode], [200, 'full'], 'degraded: /yolo on lands on the roster');
    const off = await degraded.json('POST', '/api/agent/approval', { agentId: 'rook', mode: 'ask' });
    A.eq([off.status, off.body && off.body.save, (await runtime('rook')).approvalMode], [200, 'not-saved', 'ask'], 'degraded: /yolo off lands too (it was refused while /yolo on went through), and says the save did not take it — ' + JSON.stringify(off.body));
    A.ok(/newer StarNet/.test(String(off.body && off.body.saveError)), 'with the reason');
  } catch (e) {
    A.ok(false, 'cli-agent-routes degraded e2e threw: ' + ((e && e.stack) || e));
  } finally {
    await degraded.dispose();
  }
  A.report('cli-agent-routes.e2e.test');
})();
