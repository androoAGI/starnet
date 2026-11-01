/* node test/routing.persist.e2e.test.js — POST /api/routing over the REAL sidecar: refusal, persistence,
   and the boot/live parity law (audit 2026-08-04).

   The bug (2026-08-04): an accepted plan persisted to routing.plan.json and re-armed at boot, but a REFUSED
   (422) plan only cleared the IN-MEMORY plan — the previous accepted plan stayed on disk, so live behavior
   (unrouted fallback) and post-restart behavior (the OLD floor's routing) diverged for the same posted state.
   The bug's bug (2026-08-10 audit #1): persisting the CLEAR on refusal threw away the CAPABILITY view too —
   capsPlan was memory-only, so a refusal + headless restart handed bay-bound cron/routed runs the FULL default
   office while the floor still painted bay restrictions. A refusal now persists the REFUSED plan itself; boot
   replays it through setPlan, which re-refuses routing AND restores the bay projection — boot matches live for
   BOTH facts. Boot pattern per cron.run-now.e2e.test.js.
   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, {
        SKYNET_PORT: String(port),
        // zero network dependence: no provider keys → the catalog warm fails closed offline
        OPENROUTER_KEY: '', OPENROUTER_API_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
        STARNET_OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_API_KEY: ''
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, out: () => out }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    // 20s upper bound (not a sleep): a COLD first boot on a loaded box (parallel agent gates) has been
    // observed to blow the 9s the other e2e boots use; the settled path returns the moment the URL prints.
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 20000);
  });
}

async function stop(b) { try { b.child.kill(); } catch (_) {} await sleep(200); }

// a deployable two-stage floor: INTAKE -> bay(stage-one) -> bay(stage-two) -> OUTBOX. The chain edge
// (stage-one -> stage-two) is the live probe: /api/routing/chain answers it ONLY while routing is armed.
function goodPlan() {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'stage-one' },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'stage-two' },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  });
  A.ok(Pipeline.ok(plan), 'fixture: the two-stage floor is deployable');
  A.eq((plan.chains['stage-one'] || {}).next, ['stage-two'], 'fixture: the floor chains the two docks');
  return plan;
}

// a genuinely NON-deployable floor: a closed belt loop (an infinite paid runOnce) — a REAL blocker,
// compiled by the same compiler, never a hand-forged errors array.
function cyclicPlan() {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 4, w: 1, h: 1, agentId: 'stage-one' }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'S'), belt(2, 1, 'W'), belt(1, 1, 'N')]
  });
  A.ok(plan.errors.some(e => e.code === 'CYCLE' && !e.warn), 'fixture: the broken floor is non-deployable for a REAL reason (CYCLE)');
  return plan;
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routing-persist-'));
  const FILE = path.join(ws, 'routing.plan.json');
  const env = { SKYNET_WORKSPACES: ws };
  const readFile = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
  let b = await boot(await allocatePort(), env, 20);
  try {
    let B = 'http://' + HOST + ':' + b.port;
    let token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    /* The probe carries the LINE the work entered on (work belongs to a line, 2026-08-07) — a dock only
       advances its line for the line's own work, so an origin-less probe is terminal by design and would
       answer null whether routing was armed or not. Carrying it makes this a stronger liveness probe: the
       restored-from-disk plan must still NAME the line, so line identity is proven to survive a restart. */
    const LINE_ID = Pipeline.lineOf(goodPlan(), 'stage-one');
    A.ok(!!LINE_ID, 'fixture: the two-stage floor names the line its docks belong to');
    const chainNext = async () => {
      const r = await fetch(B + '/api/routing/chain?agentId=stage-one&lineId=' + encodeURIComponent(LINE_ID), { headers });
      A.eq(r.status, 200, 'chain probe answers');
      return ((await r.json()) || {}).next || null;
    };

    // ---- accept: 200, persisted, live-armed ----
    const good = goodPlan();
    const p1 = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(good) });
    A.eq(p1.status, 200, 'a deployable plan is accepted (200)');
    A.ok(((await p1.json()) || {}).ok, 'the accept body says ok');
    A.eq(readFile().hash, good.hash, 'the ACCEPTED plan is persisted to routing.plan.json');
    A.eq(await chainNext(), 'stage-two', 'live routing is armed (the chain edge answers)');

    // ---- restart: the accepted plan re-arms at boot (existing behavior, kept) ----
    await stop(b);
    b = await boot(b.port, env, 20);
    B = 'http://' + HOST + ':' + b.port;
    A.ok(b.out().indexOf('routing plan restored from disk') >= 0, 'boot log confirms the accepted plan re-armed');
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    A.eq(await chainNext(), 'stage-two', 'the re-armed routing answers the same chain edge after restart');

    /* ---- refuse: 422 unarms LIVE routing but KEEPS the refused plan as the capability view ----
       (2026-08-10 audit #1). The 2026-08-04 fix persisted the CLEAR on refusal so stale routing could not
       re-arm at boot — but that threw away the CAPABILITY view with it: capsPlan was memory-only, so a
       refusal followed by a headless restart handed every bay-bound cron/routed run the FULL default office
       while the floor still painted bay restrictions. Now the refusal persists the REFUSED plan itself; boot
       replays it through the same setPlan, which re-refuses routing AND restores the bay projection. The
       stale-routing law still holds: the OLD accepted floor never survives a refusal on disk. */
    const bad = cyclicPlan();
    const p2 = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(bad) });
    A.eq(p2.status, 422, 'a non-deployable plan is refused (422)');
    const refusal = await p2.json();
    A.ok(!refusal.ok && Array.isArray(refusal.codes) && refusal.codes.indexOf('CYCLE') >= 0, 'the refusal names the blocker (CYCLE)');
    A.ok(refusal.caps === true, 'the refusal says the plan was KEPT as the capability view (caps: true)');
    A.eq(await chainNext(), null, 'live routing is unarmed after the refusal (dispatch falls back)');
    A.eq(readFile().hash, bad.hash, 'the refusal persists the REFUSED plan itself — and the old accepted floor no longer sits on disk');

    // ---- restart after refusal: boot matches live for BOTH facts — routing unarmed, bays still isolated ----
    await stop(b);
    b = await boot(b.port, env, 20);
    B = 'http://' + HOST + ':' + b.port;
    A.ok(b.out().indexOf('routing plan restored for CAPABILITY only') >= 0, 'boot restores the refused plan as the CAPABILITY view (bays stay isolated after a headless restart)');
    A.ok(b.out().indexOf('routing plan restored from disk') < 0, '...but never as ROUTING — a refused floor cannot re-arm dispatch at boot');
    A.ok(b.out().indexOf('persisted plan refused at boot') < 0, '...and the malformed-plan warn does not fire — this is the deliberate capability restore, not an error');
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    A.eq(await chainNext(), null, 'post-restart routing matches live: unarmed (boot/live parity)');

    // ---- an explicit CLEAR (empty body) persists too ----
    const p3 = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(goodPlan()) });
    A.eq(p3.status, 200, 're-arm before the clear');
    A.eq(await chainNext(), 'stage-two', 'armed again');
    const p4 = await fetch(B + '/api/routing', { method: 'POST', headers, body: '' });
    A.eq(p4.status, 200, 'an empty post is an accepted clear');
    A.ok(((await p4.json()) || {}).cleared, 'the clear body says cleared');
    A.eq(await chainNext(), null, 'the clear unarms live routing');
    A.eq(readFile(), null, 'the clear is persisted (boot will match)');

    /* ---- A PLAN THAT PREDATES LINE IDENTITY SELF-HEALS AT BOOT (2026-08-07) ----
       The floor's line map (which physical line a dock belongs to) is compiled by the browser and rides the
       posted plan; the chain gate reads a MISSING map as "every dock is terminal". On a desktop that heals
       the moment the app opens and re-posts — but a HEADLESS sidecar taking Telegram + routine traffic has
       no browser, so every multi-stage line ran stage one and nothing else, silently and forever. The router
       now derives the map from the restored plan's OWN geometry (sidecar/routing/planlines.js). Written
       straight to disk in its pre-arc shape and booted cold: no browser is involved anywhere in this block. */
    await stop(b);
    const preArc = JSON.parse(JSON.stringify(goodPlan()));
    delete preArc.lines; delete preArc.lineOfProp; delete preArc.lineOfAgent;
    for (const d of (preArc.dockBays || [])) delete d.lineId;
    A.eq(preArc.lineOfAgent, undefined, 'fixture: the persisted plan carries no line map at all');
    fs.writeFileSync(FILE, JSON.stringify(preArc));
    b = await boot(b.port, env, 20);
    B = 'http://' + HOST + ':' + b.port;
    A.ok(b.out().indexOf('routing plan restored from disk') >= 0, 'the pre-arc plan is still accepted at boot');
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    A.eq(await chainNext(), 'stage-two', 'a RESTORED pre-arc plan advances its multi-stage line with no browser ever opening');
    // healing fills a hole; it does not open a door — the gate still refuses foreign and origin-less work
    const askWith = async (q) => {
      const r = await fetch(B + '/api/routing/chain?agentId=stage-one' + q, { headers });
      return ((await r.json()) || {}).next || null;
    };
    A.eq(await askWith(''), null, 'a direct order at the same dock is STILL terminal on a healed plan');
    A.eq(await askWith('&lineId=some-other-line'), null, 'and a foreign line id still buys nothing');
  } finally {
    await stop(b);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.persist.e2e');
})().catch(e => { console.log('FAIL: routing.persist.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
