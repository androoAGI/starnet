/* node test/routing.persist.e2e.test.js — POST /api/routing over the REAL sidecar: a post is a question, it persists nothing, and
   a restart re-reads only the SAVED floor (the boot/live parity law, audit 2026-08-04, kept on the saved authority).

   The old law: an accepted plan persisted to routing.plan.json and re-armed at boot, a refused one persisted itself as the capability
   view, an empty post cleared the file. That made the LAST PLAN A PAGE POSTED the routing authority across a restart, which is the
   defect qa/bugs/a9a4f53c and the saved-floor lane retired: the floor the user SAVED is the only record that survives a restart, a
   second window and a page that never opens. What is locked here, with no page and no plan ever installed:
     1. nothing saved yet: a page's hint is pending (409) and nothing routes;
     2. save the floor and publish its hint: 200, the saved floor's own identity, routing armed, and routing.plan.json never written;
     3. a restart re-arms the very same line from the saved floor alone: no plan is restored from disk, there is no file to restore;
     4. the hint of a floor that is NOT saved (a looped one), a bare plan body and an empty post (the old CLEAR) are all pending and
        change nothing: live routing stays armed, no file is written, a page cannot unarm the station;
     5. SAVE the loop: its exact hint answers 422 unroutable and live routing is unarmed (dispatch falls back), and a restart matches
        it (boot/live parity): the refused floor does not re-arm at boot;
     6. saving the good floor again re-arms at once, with no restart;
     7. a routing.plan.json an older version left (a plan of other agents, in its pre-line-identity shape) is ignored at boot: never
        read, rewritten or deleted, and it names no line the station routes.
   Boot pattern per cron.run-now.e2e.test.js. In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { lineStation, hintFor, planOf, publishFloor, fetchApi, clone } = require('./helpers/saved-floor.js');
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
    child.on('close', code => { if (!settled) { settled = true; reject(new Error('sidecar exited before it was up (' + code + ')' + ':\n' + out)); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 30000).unref();
  });
}

async function stop(b) { try { b.child.kill(); } catch (_) {} await sleep(200); }

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routing-persist-'));
  const FILE = path.join(ws, 'routing.plan.json');
  const env = { SKYNET_WORKSPACES: ws };
  // A deployable two-stage floor, and the same floor with its last bay fed back into its first: a REAL blocker (a closed belt loop is an
  // infinite paid run), compiled by the same compiler, never a hand-forged errors array.
  const AGENTS = ['stage-one', 'stage-two'];
  const good = lineStation({ agents: AGENTS }), looped = lineStation({ agents: AGENTS, cyclic: true });
  const goodHint = hintFor(good), loopHint = hintFor(looped);
  A.ok(Pipeline.ok(planOf(goodHint)), 'fixture: the two-stage floor is deployable');
  A.eq((planOf(goodHint).chains['stage-one'] || {}).next, ['stage-two'], 'fixture: the floor chains the two docks');
  A.ok(planOf(loopHint).errors.some(e => e.code === 'CHAIN_CYCLE' && !e.warn), 'fixture: the looped floor is non-deployable for a REAL reason (a belt loop)');
  const LINE_ID = Pipeline.lineOf(planOf(goodHint), 'stage-one');
  A.ok(!!LINE_ID, 'fixture: the two-stage floor names the line its docks belong to');
  const stale = () => fs.existsSync(FILE);   // a routing.plan.json on disk: nothing the station does may leave one (section 7 plants one itself)
  let b = await boot(await allocatePort(), env, 20);
  try {
    let B = 'http://' + HOST + ':' + b.port;
    let token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const api = fetchApi(() => B, () => headers);
    const rebootTo = async () => {
      await stop(b);
      b = await boot(b.port, env, 20);
      B = 'http://' + HOST + ':' + b.port;
      token = await bootToken(B, B);
      headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    };
    // Stats lists a line ONLY while routing is armed, so the named line proves what routes, live and after a restart.
    const armedLines = async () => {
      const r = await api.json('GET', '/api/routing/lines/stats');
      A.eq(r.status, 200, 'armed-line probe answers');
      return (r.body.lines || []).map(x => x.lineId);
    };
    const post = body => api.json('POST', '/api/routing', body);

    // ---- 1. nothing saved yet: a hint is pending, nothing routes ----
    const p0 = await post(goodHint);
    A.eq([p0.status, p0.body.ok, p0.body.pending === true], [409, false, true], 'with no floor saved the page\'s hint is pending (409): ' + p0.text.slice(0, 160));
    A.eq(await armedLines(), [], 'and nothing routes: no line is listed');
    A.ok(!stale(), 'and nothing was written');

    // ---- 2. save the floor, publish its hint: 200, armed, still nothing persisted by the post ----
    const first = await publishFloor(api, good, { label: 'the two-stage floor' });
    A.eq(first.receipt.ok, true, 'a deployable floor is accepted (200)');
    A.ok(/^saved-plan-v1:[a-f0-9]{64}$/.test(first.receipt.identity || ''), 'with the saved floor\'s own identity: ' + first.receipt.identity);
    A.ok(!('plan' in first.receipt) && !('hash' in first.receipt), 'and nothing it was sent comes back');
    A.eq(await armedLines(), [LINE_ID], 'live routing is armed (the named line is listed)');
    A.ok(!stale(), 'the POST persisted nothing: there is no routing.plan.json');

    // ---- 3. restart: the saved floor re-arms by itself ----
    await rebootTo();
    A.ok(b.out().indexOf('routing plan restored') < 0, 'boot restores no plan: there is none to restore');
    A.eq(await armedLines(), [LINE_ID], 're-armed routing lists the same line identity after restart, with no page');
    A.eq((await post(goodHint)).body.identity, first.receipt.identity, 'and the same hint proves the same identity');
    A.ok(!stale(), 'still no routing.plan.json');

    // ---- 4. what is NOT the saved floor changes nothing, and a page cannot unarm the station ----
    for (const [what, body] of [['the hint of a looped floor that was never saved', loopHint], ['a bare plan body', clone(goodHint.plan)], ['an empty post (the old CLEAR)', undefined]]) {
      const r = await post(body);
      A.eq([r.status, r.body.ok, r.body.pending === true], [409, false, true], what + ' is pending (409): ' + r.text.slice(0, 160));
      A.eq(await armedLines(), [LINE_ID], what + ' leaves live routing armed');
      A.ok(!stale(), what + ' wrote nothing');
    }
    const clear = await fetch(B + '/api/routing', { method: 'POST', headers, body: '' });
    A.eq(clear.status, 409, 'a raw empty body is the same pending answer, not a clear');

    // ---- 5. SAVE the loop: its exact hint is unroutable, live routing unarms, and a restart matches ----
    const loop = await publishFloor(api, looped, { label: 'the looped floor', expect: 422 });
    A.eq([loop.receipt.ok, loop.receipt.unroutable], [false, true], 'the exact hint of a floor the compiler refuses answers 422 unroutable');
    A.ok(/^saved-plan-v1:[a-f0-9]{64}$/.test(loop.receipt.identity || '') && loop.receipt.identity !== first.receipt.identity, 'with that floor\'s own identity');
    A.eq(await armedLines(), [], 'live routing is unarmed after the refusal (dispatch falls back)');
    A.eq((await post(goodHint)).status, 409, 'and the good floor\'s hint is now only pending: it is not what is saved');
    await rebootTo();
    A.ok(b.out().indexOf('routing plan restored') < 0, 'boot restores no plan after the refusal either');
    A.eq(await armedLines(), [], 'post-restart routing matches live: unarmed (boot/live parity) — a refused floor cannot re-arm dispatch at boot');
    A.ok(!stale(), 'and nothing was persisted along the way');

    // ---- 6. saving the good floor again re-arms at once, no restart ----
    const again = await publishFloor(api, good, { label: 'the two-stage floor again' });
    A.eq(again.receipt.identity, first.receipt.identity, 'the same floor, the same identity');
    A.eq(await armedLines(), [LINE_ID], 'armed again with no restart');

    /* ---- 7. A routing.plan.json AN OLDER VERSION LEFT IS IGNORED ----
       An older station persisted the last plan a page posted and re-armed it at boot (and healed a plan that predated line identity
       from its own geometry). Written straight to disk in that pre-arc shape, a plan of OTHER agents, and booted cold: it is never read, so
       it routes nothing; never rewritten and never deleted, so a downgrade finds it as it was. */
    await stop(b);
    const old = clone(hintFor(lineStation({ agents: ['gamma', 'delta'] })).plan);
    delete old.lines; delete old.lineOfProp; delete old.lineOfAgent;
    for (const d of (old.dockBays || [])) delete d.lineId;
    A.eq(old.lineOfAgent, undefined, 'fixture: the left-behind plan carries no line map at all');
    const oldBytes = JSON.stringify(old);
    fs.writeFileSync(FILE, oldBytes);
    b = await boot(b.port, env, 20);
    B = 'http://' + HOST + ':' + b.port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    A.ok(/routing\.plan\.json is ignored/.test(b.out()), 'boot says the old routing.plan.json is ignored');
    A.ok(b.out().indexOf('routing plan restored') < 0, 'and restores nothing from it');
    A.eq(await armedLines(), [LINE_ID], 'the station routes by its saved floor alone: the old plan\'s agents name no line');
    A.eq((await post(goodHint)).status, 200, 'the saved floor\'s hint still proves it');
    A.eq(fs.readFileSync(FILE, 'utf8'), oldBytes, 'the old routing.plan.json is byte-identical: not read, not rewritten, not deleted');
  } finally {
    await stop(b);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.persist.e2e');
})().catch(e => { console.log('FAIL: routing.persist.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
