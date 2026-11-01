/* node test/routing.chain-seam.e2e.test.js - real sidecar proof for GET /api/routing/chain.

   This is the ONE seam the browser's COMMS work line runs on (frontend/app/chat.js nextStageOf): the
   in-app turn streams to the browser, so the browser asks the sidecar's router where the dock's output
   goes and drives the hops itself. Until now this route had zero coverage. Boots the actual sidecar and
   proves: the route is behind the per-launch token gate, answers null with no posted floor, names the
   downstream agent once a chained plan deploys, and answers null for a terminal dock / unknown agent. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-chain-seam-'));
  const env = { SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    /* `lineId` = the line the browser's work ENTERED on (work belongs to a line, 2026-08-07). Every ask
       below that expects a hop carries it, because only work fed in through a line's own trigger may run
       that line; the no-lineId case gets its own block (§6). */
    const chainAsk = async (agentId, tag, lineId) => {
      const r = await fetch(B + '/api/routing/chain?agentId=' + encodeURIComponent(agentId)
        + '&tag=' + encodeURIComponent(tag || '') + '&lineId=' + encodeURIComponent(lineId || ''), { headers });
      A.eq(r.status, 200, 'chain seam answers 200 for ' + agentId);
      return r.json();
    };
    const chainOf = async (agentId, tag, lineId) => (await chainAsk(agentId, tag, lineId)).next;

    // ---- 1. the seam is behind the SAME per-launch token gate as every /api route (not TOKEN_EXEMPT) ----
    const bare = await fetch(B + '/api/routing/chain?agentId=research-agent', { headers: { Origin: B } });
    A.eq(bare.status, 403, 'no token -> 403 (the browser seam is token-gated)');

    // ---- 2. no posted floor: every dock is terminal ----
    A.eq(await chainOf('research-agent'), null, 'no routing plan -> next is null');

    // ---- 3. deploy a two-stage line (INTAKE -> research-agent -> writer-agent -> OUTBOX) ----
    const Pipeline = require('../frontend/app/pipeline.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent', brief: 'Draft the result in press style.' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    A.eq(plan.chains['research-agent'].next, ['writer-agent'], 'the drawn floor chains the two docks');
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(plan) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');

    // ---- 4. a dock with a chain edge names its downstream agent; a terminal dock answers null ----
    // (+ step editor: the answer carries the NEXT dock's standing brief, so the browser's work line
    //    composes the same handoff turn the sidecar executor does — chat.js nextStageOf reads it.)
    const lineId = plan.lineOfAgent['research-agent'];
    A.ok(!!lineId && lineId === plan.lineOfAgent['writer-agent'], 'the compiled plan puts both docks on ONE line');
    const hop = await chainAsk('research-agent', '', lineId);
    A.eq(hop.next, 'writer-agent', 'chained dock -> the downstream agent');
    A.eq(hop.brief, 'Draft the result in press style.', 'and the RECEIVING dock\'s standing brief rides the answer');
    // sweep 2026-10-01: the rest of hopTurn's turn — the writer's reply LEAVES the line, so the COMMS work line tells it so
    A.eq([hop.last, hop.verdict], [true, null], 'the answer says the next stage is the LAST (its reply is the result), with no verdict gate');
    const Chat = require('fs').readFileSync(require('path').join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    A.ok(/Pipeline\.handoffPrompt\(seed\.originalText, cur, out\.text, hop, nxr\.brief, nxr\.verdict, nxr\.last\)/.test(Chat), 'the COMMS work line composes the same 7-part turn the sidecar chain runner does');
    A.eq(await chainOf('writer-agent', '', lineId), null, 'terminal dock -> null');
    A.eq(await chainOf('no-such-agent', '', lineId), null, 'unknown agent -> null');

    /* ---- 6. WORK BELONGS TO A LINE: an ad-hoc turn at the SAME dock advances nothing ----
       Andrew's ruling (2026-08-07): the conveyor should run only when its own workflow is running. A COMMS
       directive did not come in through this line's trigger, so chat.js sends no lineId and the sidecar
       must refuse the hop — otherwise a one-off task handed to a docked agent silently buys a run on every
       later dock. The refusal is decided by the compiled plan, so a forged id cannot buy them either. */
    A.eq(await chainOf('research-agent'), null, 'NO lineId (a direct COMMS order) -> terminal, no downstream stage');
    A.eq(await chainOf('research-agent', '', 'not-a-real-line'), null, 'a lineId the plan does not know -> still terminal');
    A.eq(await chainOf('research-agent', '', 'writer-agent'), null, 'and an agent id in the lineId slot is not a skeleton key');
    A.eq((await chainAsk('research-agent', '', lineId)).next, 'writer-agent', 'while the line’s own trigger still runs it — the gate narrows, it never breaks the line');

    // ---- 5. clearing the floor makes every dock terminal again (the browser line honestly stops) ----
    const cleared = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(null) });
    A.eq(cleared.status, 200, 'the floor clears');
    A.eq(await chainOf('research-agent', '', lineId), null, 'cleared floor -> next is null again');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.chain-seam.e2e.test');
})().catch(e => { console.log('FAIL: routing.chain-seam.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
