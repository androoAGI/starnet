/* node test/questrefresh.e2e.test.js — TRUE end-to-end proof of the QUEST REFRESH orchestration (QUEST V3).

   questrefresh.test.js proves the pure gates/parse; this suite boots the REAL sidecar with a mock OpenRouter
   and asserts the whole ambient chain in sidecar/index.js: boot catch-up tick → decide (never-cycled = due)
   → the ONE aux model call → parse → questStore.mint → the quests visible at GET /api/quests + the north
   star + attempt ledger at GET /api/quests/refresh + the durable files on disk.

   RESTART WAIT — a due save persisted at effective posture WAIT boots twice with zero provider calls and byte-for-
     byte unchanged quest/refresh stores; an explicit manual refresh still launches and mints afterward.

   BOOT 1 — THE HAPPY CHAIN: a never-refreshed save with a dossier + active goal boots; the due cycle fires
     off the boot look, the mock's grounded QUEST reply mints station-wide generated quests with real
     contracts, the north star adopts the Commander's ACTIVE GOAL (user-set outranks inferred), and both
     `_station.quests.json` and `_station.questrefresh.json` persist.

   BOOT 2 — THE HONEST-FAILURE CHAIN: a well-formed reply whose WHY cites nothing observed is rejected by
     the grounding guard — ZERO quests minted, a visible 'rejected' ledger note (never a silent no-mint),
     and the cycle still spends the cadence (no tick-hammering).

   ZERO network, zero real key (SKYNET_OPENROUTER_KEY is a fake routed to the mock). Part of test:http. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- the mock OpenRouter: the quest-master system marker routes to the canned refresh reply ---- */
function startMock(refreshReply) {
  return new Promise((resolve) => {
    const calls = { model: 0, quest: 0 };
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          calls.model++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const text = t => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          if (body.indexOf('quest master') >= 0) { calls.quest++; Promise.resolve(typeof refreshReply === 'function' ? refreshReply(body) : refreshReply).then(text); }   // runQuestRefreshCycle's system marker
          else text('ok, done.');
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1', calls }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

// seed the evidence the directive shows the model: a dossier + the Commander's ACTIVE goal arc.
function seedEvidence(ws) {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, '_commander.dossier.json'), JSON.stringify({
    block: 'COMMANDER DOSSIER\n- Goals: grow the youtube channel to sustainable income\n- Stack: davinci resolve, notion'
  }));
  fs.writeFileSync(path.join(ws, '_commander.goals.json'), JSON.stringify({
    goal: { text: 'Grow the channel to 10k subs', done: 1, total: 4, pct: 25, next: 'publish episode 3' }
  }));
}

function seedAutonomy(ws, initiative) {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, '_commander.autonomy.json'), JSON.stringify({
    v: 1,
    posture: { v: 1, initiative: initiative || 'propose', reach: 'observe', leashPerDay: 3 },
    beliefs: null
  }));
}

async function pollRefresh(B, token, pred, label, ms) {
  const until = Date.now() + (ms || 20000);
  let last = null;
  while (Date.now() < until) {
    try { last = await (await fetch(B + '/api/quests/refresh', { headers: { 'X-StarNet-Token': token, Origin: B } })).json(); } catch (_) {}
    if (last && pred(last)) return last;
    await sleep(300);
  }
  throw new Error('timed out waiting for: ' + label + '\nlast /api/quests/refresh: ' + JSON.stringify(last));
}

const QUIET = { SKYNET_THREAD_MINE: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_SCOUT: '0' };
// the cycle's standalone provider seam: env key + default model route the aux call to the mock.
const CRED = { SKYNET_OPENROUTER_KEY: 'sk-or-v1-questrefresh-fake', SKYNET_DEFAULT_MODEL: 'test/model' };

(async () => {
  // Automatic and manual auxiliary work share the station's persisted spending pools.
  for (const scope of ['day', 'global', 'unknown']) {
    const mock = await startMock('NONE');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-budget-'));
    seedEvidence(ws); seedAutonomy(ws, 'propose');
    fs.writeFileSync(path.join(ws, 'ledger.jsonl'), scope === 'unknown' ? 'not valid ledger JSON\n'
      : JSON.stringify({ runId: 'spent', agentId: 'station', usd: 1.25, turns: 1, tokens: 10, model: 'fixture', ts: Date.now() }) + '\n');
    let child = null;
    try {
      const up = await boot(await allocatePort(), Object.assign({}, CRED, QUIET, {
        SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base,
        SKYNET_BUDGET_PER_DAY: scope !== 'global' ? '1' : '0', SKYNET_BUDGET_GLOBAL: scope === 'global' ? '1' : '0'
      }), 20); child = up.child;
      const base = 'http://' + HOST + ':' + up.port, token = await bootToken(base, base);
      const headers = { Origin: base, 'X-StarNet-Token': token, 'Content-Type': 'application/json' };
      const post = async (route, body) => (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body || {}) })).json();
      const first = await pollRefresh(base, token, s => !s.inFlight && s.ledger.length > 0, 'budget boot decision');
      A.eq(mock.calls.quest, 0, scope + ': boot refresh does not buy a request');
      A.ok(first.ledger.some(e => e.outcome === 'skipped' && /spend|budget/i.test(e.reason)), scope + ': visible spending stand-down');
      await post('/api/quests/refresh/run');
      await pollRefresh(base, token, s => !s.inFlight && s.ledger.length > first.ledger.length, 'manual budget decision');
      A.eq(mock.calls.quest, 0, scope + ': manual refresh is not a budget resume');
      if (scope !== 'unknown') {
        await post('/api/budget/resume', { scope });
        await post('/api/quests/refresh/run');
        await pollRefresh(base, token, s => !s.inFlight && s.ledger.some(e => e.outcome === 'none'), 'resumed refresh');
        A.eq(mock.calls.quest, 1, scope + ': explicit budget resume restores the request');
      }
    } finally {
      if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      await new Promise(resolve => mock.server.close(resolve));
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
  /* ===== RESTART WAIT: no background provider call or quest mutation; manual refresh survives ===== */
  {
    const mock = await startMock([
      'NORTH_STAR: Grow the channel to sustainable income',
      'QUEST: Publish episode 3',
      'DESC: Finish the edit and get episode 3 live.',
      'REWARD: a published episode moving the channel forward',
      'CONTRACT: attest',
      'WHY: your active goal names publish episode 3 as the next step'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-wait-restart-'));
    seedEvidence(ws);
    seedAutonomy(ws, 'wait');
    const questFile = path.join(ws, '_station.quests.json');
    const refreshFile = path.join(ws, '_station.questrefresh.json');
    const seededQuests = JSON.stringify({ v: 1, seq: 0, quests: [], deniedTitles: [] });
    const seededRefresh = JSON.stringify({ v: 1, state: { v: 1, lastCycleAt: 0, lastMintAt: 0, northStar: null, proposedNorthStar: null, pendingQuests: [], declinedNorthStars: [], ledger: [] } });
    fs.writeFileSync(questFile, seededQuests);
    fs.writeFileSync(refreshFile, seededRefresh);
    let child = null;
    let B = '';
    let token = '';
    try {
      for (let restart = 0; restart < 2; restart++) {
        const up = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
        child = up.child;
        B = 'http://' + HOST + ':' + up.port;
        token = await bootToken(B, B);
        await sleep(3800);   // cross the real three-second boot catch-up on both the original boot and restart
        const posture = await (await fetch(B + '/api/autonomy/posture', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
        A.eq(posture.summary.initiative, 'wait', 'restart ' + (restart + 1) + ': the effective server posture is WAIT');
        A.eq(mock.calls.model, 0, 'restart ' + (restart + 1) + ': WAIT made zero background provider calls');
        A.eq(mock.calls.quest, 0, 'restart ' + (restart + 1) + ': WAIT made zero background quest-provider calls');
        A.eq(fs.readFileSync(questFile, 'utf8'), seededQuests, 'restart ' + (restart + 1) + ': WAIT made zero quest-ledger mutations');
        A.eq(fs.readFileSync(refreshFile, 'utf8'), seededRefresh, 'restart ' + (restart + 1) + ': WAIT made zero refresh-state mutations');
        try { child.kill(); } catch (_) {}
        child = null;
        await sleep(200);
      }

      const up = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
      child = up.child;
      B = 'http://' + HOST + ':' + up.port;
      token = await bootToken(B, B);
      const runRes = await (await fetch(B + '/api/quests/refresh/run', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.ok(runRes.ok && runRes.started, 'WAIT preserves explicit manual REFRESH QUESTS authority');
      await pollRefresh(B, token, p => (p.ledger || []).some(e => e.outcome === 'minted'), 'the WAIT-posture manual refresh minting');
      A.eq(mock.calls.model, 1, 'manual refresh made exactly one provider call after two WAIT boots');
      A.eq(mock.calls.quest, 1, 'manual refresh made exactly one quest-provider call after two WAIT boots');
      const quests = JSON.parse(fs.readFileSync(questFile, 'utf8'));
      A.eq((quests.quests || []).filter(q => q.createdBy === 'system:quest-refresh').length, 1, 'manual refresh may mutate the quest ledger at WAIT');
    } finally {
      try { if (child) child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // Direct Commander life-action reporting, durable pauses, and restart reconciliation through real routes.
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-life-quest-'));
    seedEvidence(ws); seedAutonomy(ws, 'wait');
    let child = null;
    try {
      let up = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws }, CRED, QUIET), 20);
      child = up.child;
      let base = 'http://' + HOST + ':' + up.port, token = await bootToken(base, base);
      const post = async (route, body) => (await fetch(base + route, { method: 'POST', headers: { Origin: base, 'X-StarNet-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      const minted = await post('/api/quests/mint', { title: 'Attend a practice class', contract: { type: 'attest', key: '' }, domain: 'growth', executionMode: 'commander' });
      A.ok(minted.ok, 'real route creates a Commander action');
      const unauthorized = await fetch(base + '/api/quests/report', { method: 'POST', headers: { Origin: 'https://hostile.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: minted.id, evidence: 'Unauthorized completion claim' }) });
      A.eq(unauthorized.status, 403, 'completion route rejects an untrusted origin');
      const paused = await post('/api/quests/disposition', { id: minted.id, disposition: 'too_big', reason: 'Need a beginner class first' });
      A.ok(paused.ok && paused.quest.disposition.type === 'too_big', 'real route retains a too-big reason');
      child.kill(); await new Promise(resolve => child.once('exit', resolve)); child = null;
      up = await boot(up.port, Object.assign({ SKYNET_WORKSPACES: ws }, CRED, QUIET), 20); child = up.child;
      base = 'http://' + HOST + ':' + up.port; token = await bootToken(base, base);
      const persisted = await (await fetch(base + '/api/quests', { headers: { Origin: base, 'X-StarNet-Token': token } })).json();
      A.eq(persisted.quests.find(q => q.id === minted.id).disposition.reason, 'Need a beginner class first', 'pause survives sidecar restart');
      A.ok((await post('/api/quests/disposition', { id: minted.id, disposition: 'resume' })).ok, 'real route resumes the action');
      const report = await post('/api/quests/report', { id: minted.id, evidence: 'I attended the beginner class this morning' });
      A.ok(report.ok && report.quest.status === 'done' && report.quest.attest.source === 'commander', 'only Commander report completes real-world action with source');
      const journey = await (await fetch(base + '/api/journey', { headers: { Origin: base, 'X-StarNet-Token': token } })).json();
      A.ok(journey.journey.outcomes.some(o => o.questId === minted.id && o.verifiedBy === 'commander-confirmed'), 'life action folds into Journey with Commander-confirmed provenance');
      child.kill(); await new Promise(resolve => child.once('exit', resolve)); child = null;
      up = await boot(up.port, Object.assign({ SKYNET_WORKSPACES: ws }, CRED, QUIET), 20); child = up.child;
      base = 'http://' + HOST + ':' + up.port; token = await bootToken(base, base);
      const final = await (await fetch(base + '/api/quests', { headers: { Origin: base, 'X-StarNet-Token': token } })).json();
      const done = final.quests.find(q => q.id === minted.id);
      A.ok(done.status === 'done' && done.attest.confirmed && done.attest.evidence.includes('beginner class'), 'completion evidence survives second sidecar restart');
    } finally {
      if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  // Goal-focused capacity and in-flight direction changes use the real planner/provider/store boundary.
  {
    let release = null, delayed = false, replyIndex = 0;
    const mock = await startMock(async () => {
      if (delayed) await new Promise(resolve => { release = resolve; });
      return ['NORTH_STAR: Grow the channel', 'QUEST: Focused episode action ' + (++replyIndex), 'DESC: Publish the next episode.', 'CONTRACT: attest', 'WHY: the active channel goal needs an episode'].join('\n');
    });
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-focus-'));
    seedEvidence(ws); seedAutonomy(ws, 'wait');
    let child = null;
    try {
      const up = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20); child = up.child;
      const base = 'http://' + HOST + ':' + up.port, token = await bootToken(base, base);
      const headers = { Origin: base, 'X-StarNet-Token': token, 'Content-Type': 'application/json' };
      const post = async (route, body) => (await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body || {}) })).json();
      const list = async () => (await (await fetch(base + '/api/quests', { headers })).json()).quests;
      for (let i = 0; i < 3; i++) A.ok((await post('/api/quests/mint', { title: 'Old focus episode ' + i, kind: 'generated', goalId: 'old', contract: { type: 'attest', key: '' } })).ok, 'old focused goal fills its slate');
      let goal = { id: 'new', text: 'Grow the channel with episodes', milestoneId: 'm1', next: 'Publish episode', done: 0, total: 3 };
      await post('/api/goals', { goal });
      A.ok((await post('/api/quests/refresh/run')).started, 'new focus starts a refresh despite old full slate');
      await pollRefresh(base, token, st => !st.inFlight && st.ledger.some(e => e.outcome === 'minted'), 'new focused goal mint');
      let rows = await list();
      A.eq(rows.filter(q => q.goalId === 'new').length, 1, 'new focus receives its own quest');
      A.eq(rows.filter(q => q.goalId === 'old').length, 3, 'previous goal quests are retained');
      for (const change of [{ id: 'newer' }, { milestoneId: 'm2', next: 'Publish another episode' }, { text: 'Grow the channel through interviews' }]) {
        const before = rows.length;
        delayed = true; release = null;
        A.ok((await post('/api/quests/refresh/run')).started, 'delayed planning pass begins');
        const until = Date.now() + 5000;
        while (!release && Date.now() < until) await sleep(25);
        if (!release) throw new Error('mock provider never reached delayed response');
        goal = { ...goal, ...change };
        await post('/api/goals', { goal });
        release(); delayed = false;
        await pollRefresh(base, token, st => !st.inFlight, 'stale response rejected');
        rows = await list();
        A.eq(rows.length, before, 'changed goal/milestone prevents stale response mint');
        const st = await (await fetch(base + '/api/quests/refresh', { headers })).json();
        A.ok(st.ledger[st.ledger.length - 1].reason.includes('changed during planning'), 'stale planning has an honest visible skipped reason');
      }
      A.ok((await post('/api/quests/refresh/run')).started, 'fresh direction can plan after stale response');
      await pollRefresh(base, token, st => !st.inFlight && st.ledger[st.ledger.length - 1].outcome === 'minted', 'fresh direction receives new quest');
      rows = await list();
      const latest = rows[rows.length - 1];
      A.eq(latest.goalId, goal.id, 'fresh quest binds to the captured goal');
      A.eq(latest.milestoneId, goal.milestoneId, 'fresh quest binds to the captured milestone');
    } finally {
      if (release) release();
      if (child) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
      mock.server.close(); fs.rmSync(ws, { recursive: true, force: true });
    }
  }

  /* ================= BOOT 1 — the happy chain ================= */
  {
    const mock = await startMock([
      'NORTH_STAR: Grow the channel to sustainable income',
      'QUEST: Publish episode 3',
      'DESC: Finish the edit and get episode 3 live.',
      'REWARD: a published episode moving the channel forward',
      'CONTRACT: attest',
      'STEPS: final cut; thumbnail; upload',
      'WHY: your active goal names publish episode 3 as the next step',
      'QUEST: Put guest research on tap',
      'DESC: Bring the web dish online so an agent compiles guest research for every episode.',
      'REWARD: research on tap for every episode',
      'CONTRACT: prop dish',
      'WHY: growing the youtube channel needs recurring guest research'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);   // NO _station.questrefresh.json: a never-cycled state is due at the boot look
    seedAutonomy(ws);
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);

      // the boot look fires the due cycle; poll the STATUS route until the mints land in its ledger.
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'minted'),
        'the boot-look refresh cycle minting quests');
      A.ok(true, 'ORCHESTRATION: a due refresh fired off the boot look and minted end-to-end');
      A.ok(st.northStar && st.northStar.text === 'Grow the channel to 10k subs', 'the north star is the Commander\'s ACTIVE GOAL (user-set outranks the model line)');
      A.eq(st.northStar.source, 'goal', 'the star carries source:goal');
      A.ok(st.lastCycleAt > 0, 'the cycle spent the cadence (lastCycleAt stamped)');
      A.eq(st.ledger.filter(e => e.outcome === 'minted').length, 2, 'both grounded quests minted');

      // the quests are REAL ledger quests (GET /api/quests), station-wide, contract-carrying.
      const q = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const minted = (q.quests || []).filter(x => x.createdBy === 'system:quest-refresh');
      A.eq(minted.length, 2, 'GET /api/quests serves the two minted quests');
      const ep = minted.find(x => x.title === 'Publish episode 3');
      A.ok(ep && ep.contract.type === 'attest' && ep.agentId === null && ep.kind === 'generated', 'attest quest: station-wide, kind generated');
      A.eq(ep.steps.map(s => s.label), ['final cut', 'thumbnail', 'upload'], 'steps rode through the store');
      const dish = minted.find(x => x.title === 'Put guest research on tap');
      A.ok(dish && dish.contract.type === 'prop' && dish.contract.key === 'dish', 'prop quest carries the placeable contract key');
      A.ok(ep.groundedIn && ep.groundedIn.indexOf('episode 3') >= 0, 'groundedIn cites the real evidence');

      // durable truth on disk (restart-safety is the point of the harness-owned ledger).
      const onDiskQuests = JSON.parse(fs.readFileSync(path.join(ws, '_station.quests.json'), 'utf8'));
      A.ok(JSON.stringify(onDiskQuests).indexOf('Publish episode 3') >= 0, '_station.quests.json persisted the mint');
      const onDiskState = JSON.parse(fs.readFileSync(path.join(ws, '_station.questrefresh.json'), 'utf8'));
      A.ok(onDiskState.state && onDiskState.state.northStar && onDiskState.state.northStar.source === 'goal', '_station.questrefresh.json persisted the north star');

      // MANUAL OVERRIDE: POST /refresh/run fires a real cycle NOW (gates bypassed). The mock replays the
      // same two quests — both titles are now OPEN, so the parse dedup drops them and the cycle records an
      // honest 'rejected' (proving the route ran a full real cycle, and dup-mint spam is impossible).
      const runRes = await (await fetch(B + '/api/quests/refresh/run', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.ok(runRes.ok && runRes.started, 'the manual refresh route launches a cycle');
      const st2 = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'rejected'),
        'the manual cycle deduping the replayed quests');
      A.eq(st2.ledger.filter(e => e.outcome === 'minted').length, 2, 'the manual re-run minted NOTHING new (dedup held)');
      const q2 = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((q2.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 2, 'still exactly two quests on the ledger');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 2 — the honest-failure chain (anti-silent-no-mint) ================= */
  {
    const mock = await startMock([
      'NORTH_STAR: Achieve maximum synergy',
      'QUEST: Embrace the grindset',
      'DESC: A quest citing nothing the station observed.',
      'REWARD: vibes',
      'CONTRACT: attest',
      'WHY: hustle culture demands relentless morning routines'   // ungroundable: cites nothing real
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);
    seedAutonomy(ws);
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'rejected'),
        "a visible 'rejected' ledger note for the ungrounded reply");
      A.ok(true, 'HONEST FAILURE: the ungrounded reply was rejected AND the ledger says so');
      A.ok(!(st.ledger || []).some(e => e.outcome === 'minted'), 'nothing minted from the invented pitch');
      A.ok(st.lastCycleAt > 0, 'the failed attempt still spent the cadence (no tick-hammering)');
      const q = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((q.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 0, 'the quest ledger stayed clean');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 3 — the cold-save guard (no evidence → no model call, honest skip) ================= */
  {
    const mock = await startMock('NORTH_STAR: should never be requested');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    // NO dossier, NO goal, NO activity: the due boot-look cycle must SKIP before spending the model call.
    seedAutonomy(ws);
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'skipped' && /not enough is known/.test(e.reason)),
        "the cold-save 'skipped' ledger note");
      A.ok(true, 'COLD SAVE: the due cycle skipped honestly instead of paying to guess');
      A.ok(!(st.ledger || []).some(e => e.outcome === 'minted' || e.outcome === 'rejected'), 'no model round-trip happened on the cold save');
      A.ok(!st.northStar, 'no invented north star on a cold save');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ================= BOOT 4 — the SLATE-FULL fast path (cost + honesty, QUEST V3 slice 2) ================= */
  {
    // the model must NEVER be called: if it were, this reply would mint. The skip happens before the call.
    const mock = await startMock(['NORTH_STAR: should never be requested', 'QUEST: Should never mint', 'CONTRACT: attest', 'WHY: grow the youtube channel'].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);   // full evidence — proving the skip is the SLATE-FULL guard, not the cold-save guard
    seedAutonomy(ws);
    // seed the store already at the cap: 3 OPEN station-wide (agentId:null) generated quests.
    fs.writeFileSync(path.join(ws, '_station.quests.json'), JSON.stringify({ v: 1, seq: 3, quests: [1, 2, 3].map(i => ({
      id: 'q:' + i, title: 'Seeded generated ' + i, kind: 'generated', agentId: null, createdBy: 'system:quest-refresh',
      contract: { type: 'attest', key: '' }, status: 'open', createdAt: 1
    })) }));
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'skipped' && /slate full/i.test(e.reason)),
        "the slate-full 'skipped' ledger note");
      A.ok(true, 'SLATE FULL: a cycle at the open-generated cap skipped honestly instead of paying for foredoomed mints');
      A.ok(!(st.ledger || []).some(e => e.outcome === 'minted' || e.outcome === 'rejected'), 'no model round-trip happened at the cap (no minted/rejected trail)');
      A.eq(st.openCount, 3, 'the three seeded generated quests are the open slate');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ============ BOOT 5 — north-star PROPOSE-AND-CONFIRM from inference (QUEST V3 slice 3) ============ */
  {
    const STAR = 'Become a full-time independent creator';
    const mock = await startMock([
      'NORTH_STAR: ' + STAR,
      'QUEST: Storyboard the next series',
      'DESC: Plan the arc of the next three episodes.',
      'REWARD: a clear production runway',
      'CONTRACT: attest',
      'WHY: growing the youtube channel needs a planned series'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    // dossier ONLY — NO goal file, so the north star comes from INFERENCE (the propose-and-confirm path).
    seedAutonomy(ws);
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, '_commander.dossier.json'), JSON.stringify({
      block: 'COMMANDER DOSSIER\n- Goals: grow the youtube channel to sustainable income\n- Stack: davinci resolve, notion'
    }));
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    const post = (body) => fetch(B + '/api/quests/refresh/northstar', { method: 'POST', headers: { 'X-StarNet-Token': token, Origin: B, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    let token;
    try {
      token = await bootToken(B, B);
      const st = await pollRefresh(B, token,
        p => p.northStar && p.northStar.text === STAR,
        'the inferred north star surfacing as a proposal');
      // NOT silently adopted: it's a PROPOSAL awaiting the Commander's verdict (truthful telemetry).
      A.eq(st.northStar.source, 'model', 'the inferred star carries source:model');
      A.eq(st.northStar.status, 'proposed', 'an inference is labelled unconfirmed, never silently adopted');
      A.eq(st.northStarProposed, true, 'the status route flags a pending north-star proposal');
      // The model's inferred direction is not authority to create work. Its quest batch is durable but staged;
      // only the Commander's confirm may turn it into the open quest ledger.
      A.ok((st.ledger || []).some(e => e.outcome === 'staged'), 'quests inferred under the proposal remain staged');
      A.eq(st.pendingQuestCount, 1, 'status exposes the pending quest count without claiming an open quest');
      const beforeQuests = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((beforeQuests.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 0, 'no quest mints before direction confirmation');
      // on-disk: the proposal is durable, the adopted star is still empty (nothing silently persisted as adopted).
      const disk = JSON.parse(fs.readFileSync(path.join(ws, '_station.questrefresh.json'), 'utf8')).state;
      A.ok(disk.proposedNorthStar && disk.proposedNorthStar.text === STAR, 'the proposal persisted to disk');
      A.ok(!disk.northStar, 'nothing was silently adopted');

      // CONFIRM → the proposal becomes the adopted star.
      const cRes = await post({ decision: 'confirm' });
      A.ok(cRes.ok && cRes.applied, 'the confirm verdict applied');
      A.eq(cRes.minted, 1, 'confirm mints the staged quest batch');
      A.eq(cRes.northStarProposed, false, 'after confirm no proposal is pending');
      const recs = await (await fetch(B + '/api/recommendations', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const adoptedDirection = (recs.entries || []).find(e => e.surface === 'northstar' && e.title === STAR);
      A.ok(adoptedDirection && adoptedDirection.outcome.adopted === true, 'confirmed northstar records explicit adoption');
      A.eq(adoptedDirection && adoptedDirection.outcome.quality, 0, 'northstar confirmation does not invent satisfaction');
      const after = await (await fetch(B + '/api/quests/refresh', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq(after.northStar.status, 'adopted', 'the confirmed star reads adopted');
      A.eq(after.northStar.text, STAR, 'the adopted star is the one the Commander confirmed');
      A.eq(after.northStarProposed, false, 'no proposal pending after confirm');
      A.eq(after.pendingQuestCount, 0, 'the staged quest batch clears after confirm');
      const afterQuests = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      A.eq((afterQuests.quests || []).filter(x => x.createdBy === 'system:quest-refresh').length, 1, 'the quest becomes open only after confirmation');
      const disk2 = JSON.parse(fs.readFileSync(path.join(ws, '_station.questrefresh.json'), 'utf8')).state;
      A.ok(disk2.northStar && disk2.northStar.text === STAR && !disk2.proposedNorthStar, 'confirm persisted the adoption + cleared the proposal');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* ===== BOOT 6 — the SHARED DECLINED INDEX cross-wire: a decline in ANOTHER engine suppresses a quest re-propose ===== */
  {
    // the mock proposes TWO grounded quests. One title ("Publish episode 3") was DECLINED as a thread in a DIFFERENT
    // engine (seeded threads.json below); the shared declined index must suppress ONLY it, letting the other mint.
    const mock = await startMock([
      'NORTH_STAR: Grow the channel to sustainable income',
      'QUEST: Publish episode 3',
      'DESC: Finish the edit and get episode 3 live.',
      'REWARD: a published episode moving the channel forward',
      'CONTRACT: attest',
      'WHY: your active goal names publish episode 3 as the next step',
      'QUEST: Put guest research on tap',
      'DESC: Bring the web dish online so an agent compiles guest research for every episode.',
      'REWARD: research on tap for every episode',
      'CONTRACT: prop dish',
      'WHY: growing the youtube channel needs recurring guest research'
    ].join('\n'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-qrefresh-e2e-'));
    seedEvidence(ws);
    seedAutonomy(ws);
    // the CROSS-ENGINE decline: "Publish episode 3" is a DECLINED thread (a different engine's store). The quest
    // refresher never consults threads for dedup on its own — only the shared declined index bridges them.
    fs.writeFileSync(path.join(ws, 'threads.json'), JSON.stringify({
      threads: [{ id: 't:1', title: 'Publish episode 3', spec: '', state: 'declined', declineReason: 'not now', createdAt: 1, updatedAt: 1 }],
      declined: []
    }));
    const { child, port } = await boot(await allocatePort(), Object.assign({ SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, CRED, QUIET), 20);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      // wait for the cycle to settle: at least one mint landed (the non-declined quest).
      const st = await pollRefresh(B, token,
        p => (p.ledger || []).some(e => e.outcome === 'minted'),
        'the cross-wire cycle minting the non-declined quest');
      A.ok((st.ledger || []).some(e => e.outcome === 'rejected' && /declined elsewhere/i.test(e.reason) && e.title === 'Publish episode 3'),
        "CROSS-WIRE: the quest whose title was declined as a thread is rejected 'declined elsewhere'");
      A.eq(st.ledger.filter(e => e.outcome === 'minted').length, 1, 'exactly one quest minted (the cross-engine decline suppressed the other)');
      const q = await (await fetch(B + '/api/quests', { headers: { 'X-StarNet-Token': token, Origin: B } })).json();
      const minted = (q.quests || []).filter(x => x.createdBy === 'system:quest-refresh');
      A.eq(minted.length, 1, 'GET /api/quests serves only the non-declined quest');
      A.ok(minted.some(x => x.title === 'Put guest research on tap'), 'the non-declined quest minted');
      A.ok(!minted.some(x => x.title === 'Publish episode 3'), 'the thread-declined quest was never minted');
    } finally {
      try { child.kill(); } catch (_) {}
      try { mock.server.close(); } catch (_) {}
      await sleep(150);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('questrefresh.e2e.test');
})().catch(e => { console.log('FAIL: questrefresh.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
