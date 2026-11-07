/* node test/routing.held-floor-away.e2e.test.js — A HELD SAVED FLOOR REFUSES UNATTENDED WORK AND COSTS IT NOTHING, over a REAL sidecar.

   The saved floor is the routing authority (sidecar/routing/saved-authority.js). When it cannot be proved right now (corrupt, from a newer
   StarNet, not vouched for, waiting for a migration, a primary gone beside its backup), nothing may be dispatched from it, and a refusal is
   not a failure: it has to leave every durable counter exactly where it was. Four unattended seams read the agent's bay room off the floor
   (admit.stationFor) and used to read it INSIDE their run, so the typed hold landed in the failure path:
     · the workshop shift     released its claim as a FAILED build: two refusals PARKED a queued item that nothing had ever tried
     · the Implement press    queued its synthetic row, claimed it, failed it the same way
     · the night-shift act    paid for its reason-only calls, queued a row and failed it (and the driver spent a leash unit on it)
     · the standing loop      took its iteration slot, failed "before launch" in the router's raw words, and the third in a row PAUSED
                              the objective
   Held to, for EVERY row of the held-status table:
     1. each seam answers "routing-held" with the hold's own words (the shift's lastShift says so too: held, not broken);
     2. the provider is never called — not a build, not a reason-only propose;
     3. the durable state is untouched: every backlog item is still queued with 0 attempts and no claim, no row was added by the press or
        the beat, and the night shift's status declines BEFORE the leash with binding 'routing-held' (a good floor says nothing blocks it,
        and a reason-only draft at reach observe is not stood down: it names no room);
     4. a loop stood down by a held floor has no iteration, no claim and no failure streak after more ticks than the failure pause counts,
        and is not paused;
     5. the file coming back is all it takes: the same item is built (attempt 1, a call on the wire) and the same loop fires, with no
        resume and no re-queue.
   In test/http.list (a child-process boot test does not gate test:fast). The loop phase waits on the loop driver's own 5 s tick (its floor): 17-21 s standalone. */
'use strict';

const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { lineStation, seedSavedFloor, savePath, clone } = require('./helpers/saved-floor.js');
const { heldWhy } = require('../sidecar/routing/saved-hold.js');

const HOST = '127.0.0.1';
const HELD_SAID = /^the saved floor is .+; routing is held until it is readable$/;
const WORKSHOP_MARK = '[WORKSHOP_SHIFT]';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a mock OpenRouter that COUNTS every model call by what it was asked. A reason-only PROPOSE gets a grounded job (so a night shift that is
// not held would go on to build it); everything else gets a plain reply that builds nothing.
function startMockProvider(calls) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) { body = {}; }
        const users = (body.messages || []).filter(m => m && m.role === 'user');
        const words = users.length ? userWords(users[users.length - 1]) : '';
        const propose = /JOB:/.test(words) && /GROUNDS:/.test(words);
        calls.push({ kind: propose ? 'propose' : words.indexOf(WORKSHOP_MARK) === 0 ? 'workshop' : /^\[IMPLEMENT_BUILD\]/.test(words) ? 'implement' : /^\[NIGHTSHIFT_ACT\]/.test(words) ? 'act' : 'other', words: words.slice(0, 80) });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const reply = propose
          ? ['JOB: Release checklist tool', 'KIND: advance-goal', 'GROUNDS: ship the StarNet beta to 100 users', 'CONFIDENCE: high', 'SPEC: a small script that helps ship the beta'].join('\n')
          : 'I could not build that.';
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// a HOT dossier snapshot: goals (the keystone) + 4 usable, freshly stamped dims -> readiness tier 'hot' (the night shift's act path needs it)
function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return { known: ['goals', 'pain', 'stack', 'ambition'], beliefs: { goals: b('ship the StarNet beta to 100 users'), pain: b('manual release notes eat my fridays'), stack: b('node and a pixel-art canvas'), ambition: b('a living agent station people watch') } };
}

// a route that streams NDJSON frames { name, payload }: the frame carrying the named result
const frameOf = (r, name) => {
  const frames = String(r.text).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const f = frames.find(x => x && (x.name === name || x.event === name));
  return (f && f.payload) || null;
};

(async () => {
  const calls = [];
  const mock = await startMockProvider(calls);
  const fx = SidecarFixture.create({ prefix: 'sk-held-away-', timeoutMs: 30000, env: {
    SKYNET_DEV: '1', STARNET_DEV: '1',
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-held-away-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '',
    // the loop driver's own floor is a 5 s tick; the night shift never ticks on its own here (its status is read, its beat is forced), but the Commander
    // counts as away after 1 ms so the status read reaches the precheck
    SKYNET_LOOP_TICK_MS: '5000', STARNET_LOOP_TICK_MS: '5000',
    SKYNET_NIGHTSHIFT_AWAY_MS: '1', STARNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_TICK_MS: '3600000', STARNET_NIGHTSHIFT_TICK_MS: '3600000',
    // no background learning pass spends a model call of its own between the doors (an aux budget of 0 is UNLIMITED)
    SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_SCOUT: '0', SKYNET_QUEST_REFRESH: '0'
  } });
  const ws = fx.workspace, primary = savePath(ws);
  let mtime = 1800000000;
  // an edit from OUTSIDE the sidecar (a restore, a sync client, an editor), given its own mtime so the stamp always moves
  const outside = bytes => { fs.writeFileSync(primary, bytes); mtime += 2; fs.utimesSync(primary, mtime, mtime); };
  const backlog = async () => (await fx.json('GET', '/api/workshop/backlog?agent=agent')).body;
  // the durable facts a refusal must leave alone: every item with its state and its attempts, and nothing else on the list
  const shape = b => JSON.stringify((b.items || []).map(i => [i.id, i.state, i.attempts || 0]).sort());
  const shiftNow = async () => frameOf(await fx.json('POST', '/api/workshop/shift', { agentId: 'agent' }), 'workshop.shift.result');
  const beatNow = async () => frameOf(await fx.json('POST', '/api/nightshift/beat', { agentId: 'agent' }), 'nightshift.beat.result');
  const press = async runId => frameOf(await fx.json('POST', '/api/workshop/implement', { agentId: 'agent', runId }), 'workshop.implement.result');
  try {
    seedSavedFloor(ws, lineStation());
    await fx.start();
    A.eq((await fx.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false })).status, 200, 'no memory pass spends a call of its own');
    const good = fs.readFileSync(primary);
    const wrapper = JSON.parse(good.toString('utf8'));
    const edited = fn => { const w = clone(wrapper); fn(w); return Buffer.from(JSON.stringify(w)); };

    // ---- the station: two queued builds, a plan to implement, the night shift ready to build ----
    A.eq((await fx.json('POST', '/api/workshop/grant', { agentId: 'agent', on: true })).status, 200, 'the away workshop is granted');
    for (const title of ['Build a tiny haiku generator', 'Build a small unit converter']) {
      const q = await fx.json('POST', '/api/workshop/queue', { agentId: 'agent', title, detail: 'one file' });
      A.ok(q.body && q.body.ok === true, 'queued: ' + title);
    }
    const PLAN = '11111111-2222-4333-8444-555555555555';
    fs.mkdirSync(path.join(ws, 'agent', 'workshop', PLAN), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'workshop', PLAN, 'plan.md'), '# Plan\n\n1. A haiku generator.\n');
    fs.writeFileSync(path.join(ws, 'agent', 'workshop', PLAN, 'deliverable.json'), JSON.stringify({ v: 1, runId: PLAN, agentId: 'agent', backlogId: '', title: 'A plan worth building', kind: 'doc', planOnly: true,
      summary: 'A plan.', files: [{ path: 'plan.md', bytes: 30 }], howToUse: 'Read it.', notVerified: [] }));
    const posture = await fx.json('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 12 }, beliefs: hotBeliefs(Date.now()) });
    A.ok(posture.body && posture.body.ok === true, 'the night shift is armed at reach sandbox with a hot dossier');
    await sleep(60);   // the 1 ms away threshold elapses, so the pure gates get PAST 'present' and the status read reaches the precheck
    const before = await backlog();
    A.eq((before.items || []).length, 2, 'fixture: two queued items');
    const baseline = shape(before);
    const goodStatus = (await fx.json('GET', '/api/nightshift/status')).body;
    A.eq(goodStatus.binding, null, 'control: on a good floor nothing blocks the next beat (binding null) — ' + JSON.stringify([goodStatus.binding, goodStatus.buildMode]));

    // ---- 1-3. INVARIANT: for every held status, the away seams refuse, the provider is never called, the durable state does not move ----
    const table = [
      ['corrupt', () => outside('{ not a save'), 'corrupt'],
      ['future wrapper', () => outside(edited(w => { w.version = 2; })), 'future'],
      ['unvouched writer', () => outside(edited(w => { w.client = 'another-window'; })), 'unvouched'],
      ['legacy station', () => outside(edited(w => { w.doc.station.version = 1; })), 'migration-required'],
      ['primary gone beside its backup', () => { fs.writeFileSync(primary + '.bak', good); fs.unlinkSync(primary); }, 'absent']
    ];
    for (const [label, spoil, status] of table) {
      spoil();
      const mark = calls.length;
      // the workshop shift: twice, because two failed attempts used to PARK the item (MAX_BUILD_ATTEMPTS 2)
      for (let i = 1; i <= 2; i++) {
        const r = await shiftNow();
        A.ok(r && r.fired === false && r.reason === 'routing-held' && HELD_SAID.test(r.why || ''), label + ': workshop shift #' + i + ' is held, in the hold\'s words, and fired nothing — ' + JSON.stringify(r));
      }
      let b = await backlog();
      A.eq(shape(b), baseline, label + ': the workshop shifts counted no attempt, claimed nothing and parked nothing');
      A.ok(b.lastShift && b.lastShift.reason === 'routing-held', label + ': and the away card\'s last shift says held, not broken — ' + JSON.stringify(b.lastShift));
      // the Implement press
      const impl = await press(PLAN);
      A.ok(impl && impl.fired === false && impl.reason === 'routing-held' && HELD_SAID.test(impl.why || ''), label + ': the Implement press is held, in the hold\'s words — ' + JSON.stringify(impl));
      A.eq(shape(await backlog()), baseline, label + ': the press queued no synthetic row, claimed none and counted no attempt');
      // the night-shift act
      const beat = await beatNow();
      A.ok(beat && beat.delivered === false && beat.reason === 'routing-held' && HELD_SAID.test(beat.why || ''), label + ': the night-shift beat is held, in the hold\'s words — ' + JSON.stringify(beat));
      b = await backlog();
      A.eq(shape(b), baseline, label + ': the beat queued no row of its own');
      const status2 = (await fx.json('GET', '/api/nightshift/status')).body;
      A.eq(status2.binding, 'routing-held', label + ': the night shift\'s status declines BEFORE the leash, binding routing-held (' + status + ')');
      A.eq(calls.length, mark, label + ': NOTHING reached the provider — no build, no reason-only propose (' + JSON.stringify(calls.slice(mark)) + ')');
      // the file comes back
      outside(good); try { fs.unlinkSync(primary + '.bak'); } catch (_) { /* only the absent row has one */ }
    }

    // ---- 5. the file is back: the same queued item is built, with no re-queue ----
    const mark1 = calls.length;
    const ran = await shiftNow();
    A.ok(ran && ran.fired === true && ran.reason === 'no-manifest', 'restored: the shift picks the top item up and builds it (the mock builds nothing) — ' + JSON.stringify(ran));
    A.eq(calls.slice(mark1)[0] && calls.slice(mark1)[0].kind, 'workshop', 'and the first call on the wire is the shift\'s own build prompt (a finished task then reflects once, as any run does)');
    const after = await backlog();
    A.eq((after.items || []).map(i => i.attempts || 0).sort().join(), '0,1', 'one item has its first honest attempt on the record, the other none');

    // ---- the night shift's precheck asks only of a beat that would BUILD: at reach observe a beat is a reason-only draft, which names no room ----
    await fx.json('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'observe', leashPerDay: 12 }, beliefs: hotBeliefs(Date.now()) });
    outside('{ not a save');
    const draft = (await fx.json('GET', '/api/nightshift/status')).body;
    A.ok(draft.buildMode === 'draft' && draft.binding !== 'routing-held', 'a held floor does not stand a reason-only draft down: the beat names no room — ' + JSON.stringify([draft.buildMode, draft.binding]));
    outside(good);

    // ---- 4. a standing loop on a held floor ----
    outside('{ not a save');
    const mark2 = calls.length;
    const created = await fx.json('POST', '/api/loops', { objective: 'find bugs in the station', agentId: 'agent', name: 'held loop' });
    A.ok(created.body && created.body.ok === true, 'a standing objective is created while the floor is held: ' + String(created.text).slice(0, 200));
    const loopId = created.body.loop.id;
    const loopRow = async () => ((await fx.json('GET', '/api/loops')).body.loops || []).find(l => l.id === loopId);
    // the host's gate, for EVERY held status: the LOOPS window renders the same precheck the driver stands down on, so it needs no tick. The floor
    // goes from one held state straight to the next (never through a good one), so no tick can land on a floor that routes.
    for (const [label, spoil, status] of table) {
      spoil();
      const held = await loopRow();
      A.ok(held && held.binding === 'precheck' && held.bindingDetail === heldWhy(status) && held.wouldFire === false, label + ': the loop is waiting, in the hold\'s words, never ready to fire — ' + JSON.stringify(held && { b: held.binding, d: held.bindingDetail, w: held.wouldFire }));
    }
    await sleep(11500);   // two driver ticks (5 s) and then some, on the last held state: the failure pause counts three
    let row = await loopRow();
    A.ok(row && !row.iterationCount && !row.failStreak && row.state === 'idle' && row.enabled !== false && !row.stopReason,
      'two ticks on a held floor: no iteration was taken, nothing failed, the loop is not paused — ' + JSON.stringify(row && { s: row.state, n: row.iterationCount, f: row.failStreak, e: row.enabled, why: row.stopReason, b: row.binding }));
    A.ok(row && row.binding === 'precheck' && HELD_SAID.test(row.bindingDetail || row.detail || ''), 'and the LOOPS window shows it waiting, in the hold\'s words, not ready to fire — ' + JSON.stringify(row && { b: row.binding, d: row.bindingDetail || row.detail }));
    A.eq(calls.length, mark2, 'the loop never reached the provider');
    outside(good); try { fs.unlinkSync(primary + '.bak'); } catch (_) { /* only the absent row has one */ }
    let fired = null;
    for (let i = 0; i < 24 && !fired; i++) { await sleep(500); row = await loopRow(); if (row && row.iterationCount >= 1) fired = row; }
    A.ok(fired && !fired.failStreak && fired.enabled !== false, 'the file is back: the very next tick fires the loop, with no resume — ' + JSON.stringify(fired && { n: fired.iterationCount, f: fired.failStreak, s: fired.state }));
    for (let i = 0; i < 40 && calls.length <= mark2; i++) await sleep(250);   // an iteration counts when it starts; its call follows
    A.ok(calls.length > mark2, 'and that iteration is a call on the wire');
  } finally {
    await fx.dispose().catch(() => {});
    await new Promise(r => mock.server.close(r));
  }
  A.report('routing.held-floor-away.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
