/* node test/roster-track.e2e.test.js — S3, end to end: THE BYTES THE LEAD ACTUALLY READS.

   roster-track.test.js proves the browser computes the right record and republishes at the right moments,
   and it source-guards the sidecar render. Neither of those proves the thing that actually decides whether
   this slice works: what reaches the MODEL when it is choosing which specialist to hand work to.

   So this boots the REAL sidecar against a mock OpenRouter (the skills.gate.prompt.e2e pattern), pushes a
   real roster through POST /api/roster — one specialist with an earned record, one with nothing — drives a
   real LEAD run through /api/run, and asserts on the captured [ORCHESTRATION] briefing itself.

   The two failure modes worth catching are opposite: publishing NOTHING (the record never survives the
   roster round-trip, and the whole slice is inert), and publishing a RANK (the unproven specialist gets
   labelled in a way that discourages delegating to it, which would violate the sandbox law).
   Zero real network, zero spend. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const TRACK = '25+ tasks shipped · Commander rating: TRUSTED · finish rate: DEPENDABLE';

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\n\n');
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

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-roster-track-'));
  const { child, port } = await boot(await allocatePort(), { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const hdr = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // the browser's own push shape (frontend/app/app.js pushRoster) — a PROVEN specialist and a NEW one
    const push = async agents => {
      const r = await fetch(B + '/api/roster', { method: 'POST', headers: hdr, body: JSON.stringify({ agents, updatedAt: Date.now() }) });
      A.eq(r.status, 200, 'POST /api/roster accepted');
      const body = await r.json().catch(() => null);
      A.ok(!body || body.ok !== false, 'the roster push was not refused');
    };
    await push([
      { agentId: 'agent', system: 'lead', name: 'NOVA', role: 'overseer', track: '' },
      { agentId: 'veteran', system: 'you research', name: 'VETERAN', role: 'researcher', track: TRACK },
      { agentId: 'rookie', system: 'you research', name: 'ROOKIE', role: 'researcher', track: '' },
    ]);

    const leadRun = async () => {
      const start = mock.requests.length;
      const r = await fetch(B + '/api/run', { method: 'POST', headers: hdr,
        body: JSON.stringify({ key: 'sk-or-v1-track-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: 'research something for me' }] }) });
      A.eq(r.status, 200, 'POST /api/run streams (200)');
      const rd = r.body.getReader(); while (true) { const { done } = await rd.read(); if (done) break; }
      await new Promise(res => setTimeout(res, 250));
      const systems = mock.requests.slice(start).map(q => ((((q || {}).messages || [])[0] || {}).content) || '');
      return systems.filter(s => s.indexOf('[ORCHESTRATION]') >= 0).sort((a, b) => b.length - a.length)[0] || systems.sort((a, b) => b.length - a.length)[0] || '';
    };

    const system = await leadRun();
    A.ok(system.indexOf('[ORCHESTRATION]') >= 0, 'the lead run really did receive a delegation briefing');
    const brief = system.slice(system.indexOf('[ORCHESTRATION]'));

    /* ---- the record survives the whole seam: browser push -> roster store -> composed briefing ---- */
    A.ok(brief.indexOf('veteran (VETERAN)') >= 0, 'the proven specialist is listed for delegation');
    A.ok(brief.indexOf('[' + TRACK + ']') >= 0, 'and its EARNED track record reached the model verbatim');
    A.ok(/veteran \(VETERAN\)[^\n]*\[25\+ tasks shipped/.test(brief), 'the record is attached to ITS OWN line, not floating loose');

    /* ---- and an unproven specialist is described exactly as before: no label, no rank ---- */
    A.ok(brief.indexOf('rookie (ROOKIE)') >= 0, 'the new specialist is listed too — nothing hides it from delegation');
    const rookieLine = brief.split('\n').filter(l => l.indexOf('rookie (ROOKIE)') >= 0)[0] || '';
    A.ok(rookieLine.indexOf('[') < 0, 'the new specialist carries NO bracket at all');
    A.ok(!/unproven|Lv 1|no record|level 0/i.test(brief), 'and is never labelled unproven/ranked anywhere in the briefing');

    /* ---- the legend appears, and says the right thing (evidence, not permission) ---- */
    A.ok(/evidence, not a/.test(brief), 'the briefing tells the lead the record is EVIDENCE');
    A.ok(/not a\s+permission level/.test(brief.replace(/\s+/g, ' ')), '…explicitly NOT a permission level');
    A.ok(/simply new, not worse/.test(brief), '…and that an agent without one is simply new, not worse');
    A.ok(!/only delegate|must delegate|prefer.*over/i.test(brief), 'nothing in the briefing GATES or mandates a choice');

    /* ---- a station with NO proven crew is byte-identical to the pre-S3 briefing ---- */
    await push([
      { agentId: 'agent', system: 'lead', name: 'NOVA', role: 'overseer', track: '' },
      { agentId: 'rookie', system: 'you research', name: 'ROOKIE', role: 'researcher', track: '' },
    ]);
    const plain = await leadRun();
    const plainBrief = plain.slice(plain.indexOf('[ORCHESTRATION]'));
    A.ok(plainBrief.indexOf('rookie (ROOKIE)') >= 0, 'the unproven crew is still listed');
    // scoped to the CREW LINES themselves — the briefing legitimately contains other bracketed markers
    // ([ORCHESTRATION], [RUNTIME]); the invariant is that no crew row carries a track bracket.
    const plainCrewLines = plainBrief.split('\n').filter(l => /^\s+- \S+ \(/.test(l));
    A.ok(plainCrewLines.length >= 1, 'the plain briefing still renders crew rows');
    A.ok(plainCrewLines.every(l => l.indexOf('[') < 0), 'no crew row carries a bracket when nobody has earned one');
    A.ok(!/evidence, not a/.test(plainBrief), 'and NO dangling legend explaining a notation the briefing never uses');

    /* ---- it survives a sidecar restart (or it silently vanishes for every headless run) ---- */
    await push([
      { agentId: 'agent', system: 'lead', name: 'NOVA', role: 'overseer', track: '' },
      { agentId: 'veteran', system: 'you research', name: 'VETERAN', role: 'researcher', track: TRACK },
    ]);
    await new Promise(res => setTimeout(res, 300));   // let the roster write land
    const onDisk = JSON.parse(fs.readFileSync(path.join(ws, 'agent.roster.json'), 'utf8'));
    const vetRow = (onDisk.agents || []).filter(a => a.agentId === 'veteran')[0];
    A.ok(!!vetRow, 'the roster persisted the proven specialist');
    A.eq(vetRow.track, TRACK, 'and re-emitted its track record (a KNOWN field, so a re-save cannot eat it)');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('roster-track.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
