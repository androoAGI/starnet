'use strict';
/* node test/routing.saved-seams.test.js — HOW THE HOST ASKS THE ROUTER once the saved floor is its authority
   (sidecar/routing/saved-seams.js, router.js savedHost, chain.js).

   The REAL save owner, the REAL authority, the REAL router and the REAL chain runner; the only fakes are bytes written to the
   primary the way an outside edit, a restore or a bad disk writes them. Held to:
     1. a new install (no floor at all) answers every reader as a router with no plan did; nothing throws, nothing is held;
     2. a floor that routes answers about things it does not hold (an agent with no bay, a stale dock, an unknown line) with
        null, [] or false, never with a throw, and a stale dock still falls back to the agent's entry dock;
        the STRICT router (no savedHost) still throws for each of them, because the line-hold lane reads it that way;
     3. a floor the compiler refuses routes nothing but still answers the room, brief and limit it holds;
     4. INVARIANT held-is-never-routable: for every held floor (corrupt, future, unvouched, migration-required, a primary gone
        beside its backup, unreadable) EVERY reader through admit throws a typed hold with its words and EVERY reader through
        observe answers what a router with no plan answers; nothing is served from the floor that was good a moment before;
        a restored file routes again with no restart; hold() says the same sentence;
     5. observe swallows nothing but a hold; admit swallows nothing;
     6. with no authority (a pure-router fixture over the posted-plan router; the host always has one) both objects are the router itself;
     7. a floor that goes held between two hops stops the work line with the existing 'refused' stop and the hold's words,
        and ships nothing as if the line were finished;
     8. a real hub over the real router refuses a message whose floor is held, in words, runs nothing, and settles a job it had
        opened for that message as the existing 'refused' stop; the file coming back routes again with no restart;
     9. INVARIANT held-never-runs, for EVERY hop profile (channel, schedule, manual, steptest — a new profile must be added to the
        table): a hop whose room or brief is asked of a held floor calls runOnce never, hands the stage no default office, and fails
        in the hold's own words. (The step-through test's profile used to swallow the hold: its hop ran in the WHOLE default office.);
    10. the step-through test over the real authority: a floor that goes held mid-test ENDS it 'stopped' with the chain's refused stop
        and the hold's words (never 'done' after the first stage, never "no work line is armed"); a start while held is refused in
        the same words and makes no session; a paused test stays paused and CONTINUE refuses until the file is back;
    11. INVARIANT held-says-how: a table names every hold status; a hold the person can end (migration-required: open StarNet once;
        future: update StarNet) says that step in the one sentence every refusal reads, both from heldWhy and from the hold a real
        read of a real spoiled floor throws; every sentence still keeps the one grammar. */
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeSavedAuthority } = require('../sidecar/routing/saved-authority.js');
const { makeRouterSeams, READERS, MUTATORS, EMPTY } = require('../sidecar/routing/saved-seams.js');
const { HOLD_STATUSES, heldWhy } = require('../sidecar/routing/saved-hold.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const LineRunner = require('../sidecar/routing/line-runner.js');
const LineJobs = require('../sidecar/routing/linejobs.js');
const { lineStation, seedSavedFloor, savePath, clone } = require('./helpers/saved-floor.js');

const HELD_SAID = /^the saved floor is .+; routing is held until it is readable$/;
const caught = fn => { try { fn(); return null; } catch (e) { return e; } };

// plausible arguments for every reader, so the whole interface is asked, not a favourite few
const ASKS = {
  getPlan: [], hasPlan: [], getStation: [],
  resolveTarget: [{ tag: 'general', text: 'hello' }], resolveDock: [{ tag: 'general', text: 'hello' }],
  dockOf: ['alpha', 'b1'], entryDockOf: ['alpha'], docksOf: ['alpha'], agentOfDock: ['b1'], lineOfDock: ['b1'], dockRef: ['alpha'],
  lineOfAgent: ['alpha', 'b1'], lineOriginFor: ['alpha', 'b1'], intakeReceiptFor: [{ agentId: 'alpha', dockId: 'b1' }], lineLimits: ['line-one'],
  chainNext: ['alpha', { lineId: 'line-one', tag: 'general' }], chainStep: ['alpha', { lineId: 'line-one', tag: 'general' }],
  chainPeek: ['alpha', { lineId: 'line-one', tag: 'general' }], fanSiblings: ['alpha'], loopGateAfter: ['alpha', 'line-one', 'b1'],
  chainShipsToOutbox: ['alpha', 'b1'], stationFor: ['alpha', 'b1'], stageBrief: ['alpha', 'b1'],
  chainNextDock: ['b1', { lineId: 'line-one', tag: 'general' }], chainStepDock: ['b1', { lineId: 'line-one', tag: 'general' }],
  chainPeekDock: ['b1', { lineId: 'line-one', tag: 'general' }], fanSiblingsDock: ['b1']
};
A.eq(Object.keys(ASKS).sort(), READERS.slice().sort(), 'fixture: every reader the seams know is asked below');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-seams-'));
const primary = savePath(root);
let locked = false;
const io = Object.create(fs);
io.readFileSync = (file, ...args) => {
  if (locked && path.resolve(String(file)) === primary) throw Object.assign(new Error('fixture locked primary'), { code: 'EACCES' });
  return fs.readFileSync(file, ...args);
};
const store = makeSaveStore({ fs: io, pathMod: path, root, clock: { now: () => Date.now() } });
const authority = makeSavedAuthority({ read: { agentId: 'agent', stamp: () => store.stamp('agent'),
  loadPrimaryState: () => store.loadPrimaryState('agent'), hasRecoveryCopy: () => store.hasRecoveryCopy('agent') } });
const router = makeRouter({ savedProjection: authority.projection, savedHost: true });
const strict = makeRouter({ savedProjection: authority.projection });
const heldSeen = [];
const seams = makeRouterSeams({ router, authority, onHold: (h, reader) => heldSeen.push([h.status, reader]) });
const { admit, observe } = seams;
let mtime = 1900000000;
const outside = bytes => { fs.writeFileSync(primary, bytes); mtime += 2; fs.utimesSync(primary, mtime, mtime); };
const empties = () => READERS.map(name => [name, JSON.stringify(EMPTY[name]())]);

(async () => {
  try {
    // ---- the interface ----
    A.eq(Object.keys(admit).sort(), READERS.slice().sort(), 'admit is the router\'s readers');
    A.eq(Object.keys(observe).sort(), READERS.slice().sort(), 'observe is the same readers');
    for (const m of MUTATORS) A.ok(!(m in admit) && !(m in observe), m + ' is on neither seam: a posted plan cannot be installed through one');
    A.ok(Object.isFrozen(seams) && Object.isFrozen(admit) && Object.isFrozen(observe), 'the seams are immutable');
    A.throws(() => makeRouterSeams({}), 'the seams need the router');
    A.throws(() => makeRouterSeams({ router: {} }), 'and a router that has every reader');
    A.throws(() => makeRouter({ savedHost: true }), 'savedHost without the saved-floor reader is a wiring slip');
    A.eq(HOLD_STATUSES.slice().sort(), ['absent', 'changed', 'corrupt', 'future', 'invalid', 'migration-required', 'unavailable', 'unreadable', 'unstamped', 'unsupported-geometry', 'unvouched'],
      'the holds: every status that is neither routable, nor refused-by-the-compiler, nor a new install');
    for (const s of HOLD_STATUSES) A.ok(HELD_SAID.test(heldWhy(s)), s + ': one sentence, in plain words — ' + heldWhy(s));

    // ---- 1. a new install: nothing saved, nothing wrong ----
    A.eq(authority.status().state, 'unfloored', 'fixture: nothing saved');
    for (const [name, want] of empties()) {
      A.eq(JSON.stringify(admit[name](...ASKS[name])), want, 'unfloored: admit.' + name + ' answers as a router with no plan');
      A.eq(JSON.stringify(observe[name](...ASKS[name])), want, 'unfloored: observe.' + name + ' answers the same');
    }
    A.eq([seams.hold(), heldSeen.length], [null, 0], 'a new install is not held, and nothing was said about one');

    // ---- 2. a floor that routes ----
    seedSavedFloor(root, lineStation());
    A.eq(authority.status().state, 'ok', 'fixture: a saved line routes');
    A.eq(admit.resolveDock({ tag: 'general', text: 'hi' }), { agentId: 'alpha', dockId: 'b1' }, 'the saved line\'s door is alpha\'s bay');
    A.eq([admit.lineOfAgent('alpha', 'b1'), admit.lineOriginFor('alpha', 'b1'), admit.entryDockOf('beta'), admit.chainShipsToOutbox('beta', 'b2')], ['line-one', 'line-one', 'b2', true], 'the line, its door, the entry dock and the OUTBOX are read off the saved floor');
    A.eq(admit.chainStepDock('b1', { lineId: 'line-one', tag: 'general' }).agentId, 'beta', 'the walk goes alpha to beta');
    A.ok(admit.stationFor('alpha').rooms.bay.objects.length >= 1 && admit.stageBrief('alpha', 'b1') === 'Stage 1 of the saved line', 'alpha\'s bay room and brief are the saved ones');
    const ghosts = [['dockOf', ['ghost']], ['docksOf', ['ghost']], ['agentOfDock', ['nope']], ['lineOfDock', ['nope']], ['lineOfAgent', ['ghost']], ['lineOriginFor', ['ghost']],
      ['stationFor', ['ghost']], ['stageBrief', ['ghost']], ['entryDockOf', ['ghost']], ['dockRef', ['ghost']], ['chainStep', ['ghost', { lineId: 'line-one' }]],
      ['chainNext', ['ghost', { lineId: 'line-one' }]], ['chainStepDock', ['nope', { lineId: 'line-one' }]], ['fanSiblings', ['ghost']], ['lineLimits', ['no-such-line']],
      ['resolveDock', [{ boundAgentId: 'ghost' }]], ['resolveDock', [{ lineId: 'no-such-line', text: 'x' }]], ['intakeReceiptFor', [{ agentId: 'ghost' }]], ['chainShipsToOutbox', ['ghost']]];
    /* THE ORACLE: the posted-plan router, handed the very plan the saved floor compiled to. The host reads the saved floor the way the
       sidecar always read a posted plan, so every question — about the floor's own things and about things it does not hold — gets the
       answer the posted-plan router gave, not a throw and not a new rule. */
    const proved = authority.projection(), legacy = makeRouter({}), posted = Object.assign({}, proved.plan);
    Object.defineProperty(posted, 'links', { value: proved.compilerLinks, enumerable: false });
    A.ok(legacy.setPlan(posted).ok, 'fixture: the posted-plan router accepts the same compiled plan');
    for (const name of READERS.filter(r => r !== 'getStation')) {
      A.eq(JSON.stringify(admit[name](...ASKS[name])), JSON.stringify(legacy[name](...ASKS[name])), 'the floor\'s own things: admit.' + name + ' answers what the posted-plan router answers');
    }
    for (const [name, args] of ghosts) {
      A.eq(caught(() => admit[name](...args)), null, 'the saved floor does not hold it: admit.' + name + '(' + JSON.stringify(args[0]) + ') does not throw');
      A.eq(JSON.stringify(admit[name](...args)), JSON.stringify(legacy[name](...args)), 'and answers what the posted-plan router answers: ' + name + '(' + JSON.stringify(args[0]) + ')');
    }
    for (const [name, args] of [['dockOf', ['ghost']], ['stationFor', ['ghost']], ['lineOfAgent', ['ghost']], ['entryDockOf', ['ghost']], ['stageBrief', ['ghost']], ['lineLimits', ['no-such-line']]]) {
      const e = caught(() => strict[name](...args));
      A.ok(e && e.code && !e.held, 'the STRICT router (no savedHost) still throws a typed error for ' + name + ': the line-hold lane reads the floor that way');
    }
    A.eq(admit.dockOf('alpha', 'a-bay-that-was-removed'), 'b1', 'a stale dock falls back to the agent\'s entry dock, never to nothing');
    A.eq(admit.stationFor('alpha', 'a-bay-that-was-removed').floor.dockId, 'b1', 'and its room is the entry dock\'s room');

    // ---- 3. a floor the compiler refuses ----
    const loopRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-seams-loop-'));
    seedSavedFloor(loopRoot, lineStation({ cyclic: true }));   // a saved floor the compiler refuses, written by the real save owner
    const loopBytes = fs.readFileSync(savePath(loopRoot));
    const goodBytes = fs.readFileSync(primary);
    outside(loopBytes);
    A.eq(authority.status().state, 'unroutable', 'fixture: the looped line is saved whole and not routable');
    A.eq([admit.resolveDock({ tag: 'general', text: 'hi' }), admit.getPlan(), admit.hasPlan(), admit.chainStep('alpha', { lineId: 'line-one' }), admit.lineOfAgent('alpha', 'b1'), admit.entryDockOf('alpha')],
      [null, null, false, null, null, null], 'it routes nothing: every routing reader answers as no plan');
    A.ok(admit.stationFor('alpha', 'b1').rooms.bay.objects.length >= 1 && admit.stageBrief('alpha', 'b1') === 'Stage 1 of the saved line' && admit.dockOf('alpha') === 'b1',
      'but what the floor holds is still true: alpha\'s room, its brief, its bay (a refused floor never hands out the default office)');
    A.eq(seams.hold(), null, 'an unroutable floor is not a held one');
    outside(goodBytes);
    A.eq(authority.status().state, 'ok', 'saving the line again routes again');

    // ---- 4. INVARIANT held-is-never-routable ----
    const wrapper = JSON.parse(goodBytes.toString('utf8'));
    const edited = fn => { const w = clone(wrapper); fn(w); return Buffer.from(JSON.stringify(w)); };
    A.ok(admit.resolveDock({ tag: 'general', text: 'warm' }), 'the memo is warm on a good floor before each row');
    const table = [
      ['corrupt', () => outside('{ not a save'), 'corrupt'],
      ['future wrapper', () => outside(edited(w => { w.version = 2; })), 'future'],
      ['unvouched writer', () => outside(edited(w => { w.client = 'another-window'; })), 'unvouched'],
      ['legacy station', () => outside(edited(w => { w.doc.station.version = 1; })), 'migration-required'],
      ['primary gone beside its backup', () => { fs.writeFileSync(primary + '.bak', goodBytes); fs.unlinkSync(primary); }, 'absent'],
      ['unreadable', () => { locked = true; mtime += 2; fs.utimesSync(primary, mtime, mtime); }, 'unreadable']
    ];
    for (const [label, spoil, status] of table) {
      A.ok(admit.resolveDock({ tag: 'general', text: 'warm' }), label + ': warm on a good floor');
      spoil();
      heldSeen.length = 0;
      for (const name of READERS) {
        const e = caught(() => admit[name](...ASKS[name]));
        A.ok(e && e.held === true && e.status === status && HELD_SAID.test(e.why || ''), label + ': admit.' + name + ' throws the hold, ' + status + ' — ' + (e && (e.status || e.message)));
        A.eq(JSON.stringify(observe[name](...ASKS[name])), JSON.stringify(EMPTY[name]()), label + ': observe.' + name + ' answers as no plan, never from the earlier good floor');
      }
      A.eq(heldSeen.length, READERS.length, label + ': every degraded read was reported once, with its reason');
      A.eq([...new Set(heldSeen.map(x => x[0]))], [status], label + ': and the reason is the hold\'s');
      A.eq(seams.hold(), { status, why: heldWhy(status) }, label + ': hold() is the same sentence');
      A.eq(authority.status().routingOk, false, label + ': the authority reports nothing routable');
      locked = false;
      outside(goodBytes); try { fs.unlinkSync(primary + '.bak'); } catch (_) { /* only the absent row has one */ }
      A.eq([seams.hold(), (admit.resolveDock({ tag: 'general', text: 'again' }) || {}).agentId], [null, 'alpha'], label + ': the file is back and routes again, with no restart');
    }

    // ---- 5. observe swallows only a hold; admit swallows nothing ----
    {
      const fakeHeld = Object.assign(new Error('held'), { held: true, status: 'corrupt', why: heldWhy('corrupt') });
      const fake = {}; for (const name of READERS) fake[name] = () => { throw fakeHeld; };
      const s = makeRouterSeams({ router: fake, authority });
      A.eq(s.observe.getPlan(), null, 'a hold degrades an observe read');
      A.eq(caught(() => s.admit.getPlan()), fakeHeld, 'and is handed up unchanged by admit');
      const bug = new TypeError('a bug, not a hold');
      const buggy = {}; for (const name of READERS) buggy[name] = () => { throw bug; };
      const b = makeRouterSeams({ router: buggy, authority });
      A.eq(caught(() => b.observe.getPlan()), bug, 'a bug is never read as a hold: observe rethrows it');
      const lazy = Object.assign(new Error('x'), { code: 'EROUTING_SAVED_UNKNOWN-AGENT', status: 'unknown-agent' });
      const asked = {}; for (const name of READERS) asked[name] = () => { throw lazy; };
      A.eq(caught(() => makeRouterSeams({ router: asked, authority }).observe.dockOf('x')), lazy, 'nor is a caller\'s mismatch (the strict router\'s unknown-agent) a hold');
      const blind = makeRouterSeams({ router, authority: { status() { throw new Error('the authority is down'); } } });
      A.eq(blind.hold(), { status: 'unreadable', why: heldWhy('unreadable') }, 'an authority that cannot answer is a hold, never a pass');
    }

    // ---- 6. no authority: the seams are the router ----
    {
      const legacy = makeRouter({});
      const plain = makeRouterSeams({ router: legacy });
      for (const name of READERS) A.ok(plain.admit[name] === legacy[name] && plain.observe[name] === legacy[name], 'no authority: admit.' + name + ' and observe.' + name + ' are the router\'s own');
      A.eq(plain.hold(), null, 'and nothing is ever held');
    }

    // ---- 7. a floor that goes held between two hops stops the line, visibly ----
    {
      const ran = [];
      const deps = spoilBefore => ({
        nextAgent: (a, ctx) => admit.chainNext(a, ctx), stepAgent: (a, ctx) => admit.chainStep(a, ctx), stepDock: (d, ctx) => admit.chainStepDock(d, ctx),
        peekDock: (d, ctx) => admit.chainPeekDock(d, ctx), entryDockOf: a => admit.entryDockOf(a), fanSiblings: a => admit.fanSiblings(a), fanSiblingsDock: d => admit.fanSiblingsDock(d),
        lineOfAgent: (a, d) => admit.lineOfAgent(a, d), stageBrief: (a, d) => admit.stageBrief(a, d), lastStage: (a, d) => admit.chainShipsToOutbox(a, d),
        runAgent: async h => { ran.push(h.agentId); if (spoilBefore === ran.length) outside('{ not a save'); return { text: h.agentId.toUpperCase() + ' did its stage' }; },
        now: () => 0, newId: () => 'wi_1'
      });
      outside(goodBytes);
      const clean = await makeChainRunner(deps(0)).advance({ agentId: 'alpha', dockId: 'b1', text: 'draft', lineId: 'line-one' });
      A.ok(!clean.stop && !clean.stopped && ran.join() === 'beta' && /BETA/.test(clean.text), 'control: on a good floor the line runs beta and ships clean — ' + JSON.stringify([clean.stop, ran]));
      // held before the first next-step read: nothing runs
      ran.length = 0; outside('{ not a save' );
      const early = await makeChainRunner(deps(0)).advance({ agentId: 'alpha', dockId: 'b1', text: 'draft', lineId: 'line-one' });
      A.ok(early.stop && early.stop.code === 'refused' && HELD_SAID.test(early.stop.why) && ran.length === 0 && early.stopped === early.stop.why,
        'held before the first hop: the line stops "refused" in the hold\'s words and runs nothing — ' + JSON.stringify([early.stop, ran]));
      A.eq(early.text, 'draft', 'and the work it was handed is what it hands back (a chain never gates the reply)');
      // held after beta ran, before the line could say it was over: stopped, never "finished"
      outside(goodBytes); ran.length = 0;
      const late = await makeChainRunner(deps(1)).advance({ agentId: 'alpha', dockId: 'b1', text: 'draft', lineId: 'line-one' });
      A.ok(ran.join() === 'beta' && late.stop && late.stop.code === 'refused' && HELD_SAID.test(late.stop.why),
        'held after a stage ran: the line says it could not tell where the work goes next, in the hold\'s words — ' + JSON.stringify([late.stop, ran]));
      A.ok(/BETA/.test(late.text), 'and the last good output is kept');
    }

    // ---- 8. the hub: a message the floor cannot route is refused in words and runs nothing; a job opened for it settles as the existing 'refused' stop ----
    {
      outside(goodBytes);
      let jobState = { jobs: [] }, seq = 0;
      const J = { get: id => LineJobs.get(jobState, id),
        start: r => { const x = LineJobs.start(jobState, r); if (x.job) jobState = x.state; return x.job; },
        finish: (id, r) => { const x = LineJobs.finish(jobState, id, r); if (x.job) jobState = x.state; return x.job; } };
      const ran = [], said = [], settledJobs = [];
      let preJobId = null, spoilAfterRoute = false, spoilAfterOrigin = false;
      // one fake run for the entry and for every hop: it records who ran and ends the way a clean run does
      const runOnce = async o => {
        ran.push(o.agentId);
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'an answer' });
        const end = { agentId: o.agentId, runId: o.runId, reason: 'done', outcome: 'succeeded', turns: 1, usd: 0 };
        o.emit('agent.run.end', end);
        return Object.assign({ text: o.agentId.toUpperCase() + ' answer' }, end);
      };
      // the REAL chain runner over the admit seams, exactly the dispatch seams index.js hands it
      const chain = makeChainRunner({
        nextAgent: (a, ctx) => admit.chainNext(a, ctx), stepAgent: (a, ctx) => admit.chainStep(a, ctx), stepDock: (d, ctx) => admit.chainStepDock(d, ctx),
        peekDock: (d, ctx) => admit.chainPeekDock(d, ctx), entryDockOf: a => admit.entryDockOf(a), fanSiblings: a => admit.fanSiblings(a), fanSiblingsDock: d => admit.fanSiblingsDock(d),
        lineOfAgent: (a, d) => admit.lineOfAgent(a, d), stageBrief: (a, d) => admit.stageBrief(a, d), lastStage: (a, d) => admit.chainShipsToOutbox(a, d),
        now: () => 1000, newId: () => 'wi' + (++seq)
      });
      const book = LineRunner.makeLineRunner({ chain, runOnce, now: () => 1000, newId: () => 'id' + (++seq), jobs: J });
      const turns = new Map();
      const hub = makeChannelHub({ channel: 'sample', ownerSurface: true, bindChats: false, textBatchWaitMs: 0, now: () => 1000, newId: () => 'hub-' + (++seq),
        runOnce,
        lineRunner: book, jobId: () => preJobId, jobEntry: 'sample', onJobSettled: r => settledJobs.push(r),
        store: { loadHistory: a => turns.get(a) || [], appendTurn: (a, role, content) => { const list = turns.get(a) || []; list.push({ role, content }); turns.set(a, list); return list; }, getChatRecord: () => null },
        secrets: () => ({ key: 'synthetic', model: 'fixture' }), resolveEntryRunConfig: () => ({ key: 'synthetic', model: 'fixture' }), resolveRunConfig: () => ({ key: 'synthetic', model: 'fixture' }),
        resolveAgent: ctx => { const routed = admit.resolveDock(ctx); if (spoilAfterRoute) { spoilAfterRoute = false; outside('{ not a save'); } return routed; },
        lineOriginFor: (a, d) => { const origin = admit.lineOriginFor(a, d); if (spoilAfterOrigin) { spoilAfterOrigin = false; outside('{ not a save'); } return origin; },
        stageBriefFor: (a, d) => admit.stageBrief(a, d), resolveStation: (a, d) => admit.stationFor(a, d),
        classify: () => true, emit: () => {}, send: async (_chat, text) => { said.push(String(text)); return { ok: true }; } });
      try {
        await hub.onInbound({ chatId: 'c-good', userId: 'u1', text: 'write the summary', chatType: 'dm' });
        A.eq(ran, ['alpha', 'beta'], 'control: on a good floor the hub routes the message to the saved line\'s first bay and the line runs the second');
        ran.length = 0; said.length = 0; settledJobs.length = 0;   // the control message settled a job of its own
        outside('{ not a save');
        preJobId = book.open({ line: 'line-one', entry: 'sample', text: 'write the summary', streamId: 'sample-held' }).id;
        const seen = [];
        await hub.onInbound({ chatId: 'c-held', userId: 'u1', text: 'write the summary again', chatType: 'dm' }, { onSettled: s => seen.push(s) });
        A.eq(ran, [], 'a held floor: the hub ran nothing, not a fallback agent and not the one it routed to a moment ago');
        A.ok(said.length === 1 && /did not run this message: the saved floor is corrupt; routing is held until it is readable/.test(said[0]), 'the chat is told in words: ' + said.join(' | '));
        A.ok(seen.length === 1 && seen[0].ok === false && seen[0].held && seen[0].held.status === 'corrupt' && HELD_SAID.test(seen[0].held.why), 'the settlement says it typed, beside ok:false — ' + JSON.stringify(seen));
        const stop = settledJobs[0] && settledJobs[0].stop;
        A.ok(settledJobs.length === 1 && stop && stop.code === 'refused' && /the saved floor is corrupt; routing is held until it is readable/.test(stop.why || ''), 'the job opened for the message settled as the existing refused stop, in the hold\'s words — ' + JSON.stringify(settledJobs));
        const record = J.get(preJobId);
        A.ok(record && record.status !== 'running' && record.stop && record.stop.code === 'refused', 'and its durable record says so — ' + JSON.stringify(record && { status: record.status, stop: record.stop }));
        outside(goodBytes);
        preJobId = null; said.length = 0;
        await hub.onInbound({ chatId: 'c-back', userId: 'u1', text: 'write the summary once more', chatType: 'dm' });
        A.eq(ran, ['alpha', 'beta'], 'the file is back: the same hub routes again, with no restart');
        // an outside edit lands AFTER the message was routed and before its line is asked: the same refusal, in words, nothing run, nothing lost
        ran.length = 0; said.length = 0; spoilAfterRoute = true;
        await hub.onInbound({ chatId: 'c-race', userId: 'u1', text: 'write the summary a last time', chatType: 'dm' });
        A.eq(ran, [], 'a floor that goes held after the message was routed: still nothing runs');
        A.ok(said.length === 1 && /did not run this message: the saved floor is corrupt; routing is held until it is readable/.test(said[0]), 'and the chat is told in the same words, not left waiting: ' + said.join(' | '));
        outside(goodBytes);
        // the LAST window: the floor goes held after the message was routed AND its line was read, before the hub asks for the dock's brief and
        // its room. Neither read may be swallowed into a run with no brief and the default office: the message is refused, in words, nothing runs,
        // and the job the hub itself opened for it settles as the existing refused stop
        ran.length = 0; said.length = 0; settledJobs.length = 0; spoilAfterOrigin = true; preJobId = null;
        const lateSeen = [];
        await hub.onInbound({ chatId: 'c-late', userId: 'u1', text: 'write the summary one more time', chatType: 'dm' }, { onSettled: s => lateSeen.push(s) });
        A.eq(ran, [], 'a floor that goes held after the line was read: nothing runs, not even stage one with no brief and the whole default office');
        A.ok(said.length === 1 && /did not run this message: the saved floor is corrupt; routing is held until it is readable/.test(said[0]), 'and the chat is told in the same words: ' + said.join(' | '));
        const lateStop = settledJobs[0] && settledJobs[0].stop;
        A.ok(settledJobs.length === 1 && lateStop && lateStop.code === 'refused' && /the saved floor is corrupt; routing is held until it is readable/.test(lateStop.why || ''), 'the job the hub opened settles as the existing refused stop, in the hold\'s words — ' + JSON.stringify(settledJobs));
        A.ok(lateSeen.length === 1 && lateSeen[0].ok === false, 'the settlement is told exactly once — ' + JSON.stringify(lateSeen.map(x => ({ ok: x.ok, held: x.held, stop: x.result && x.result.stop }))));
        outside(goodBytes);
      } finally { hub.close(); }
    }

    // ---- 9. INVARIANT held-never-runs: every hop profile, built by its production factory over the real seams ----
    const cfg = () => ({ ok: true, key: 'k', model: 'm', provider: 'openrouter', configured: true });
    const bayOf = o => (o && o.station && o.station.rooms && o.station.rooms.bay) ? 'bay' : 'NO ROOM (the whole default office)';
    {
      const room = (a, d) => admit.stationFor(a, d), brief = (a, d) => admit.stageBrief(a, d);
      const profiles = {
        channel: () => LineRunner.profiles.channel({ channel: 'sample', chatId: 'c1', streamId: 's1', config: cfg, persona: () => 'p', station: room }),
        schedule: () => LineRunner.profiles.schedule({ streamId: 's1', config: cfg, system: () => 'p', routine: {}, station: room }),
        manual: () => LineRunner.profiles.manual({ streamId: 's1', config: cfg, system: () => 'p', routine: {}, station: room }),
        steptest: () => LineRunner.profiles.steptest({ config: cfg, persona: 'p', brief, dockSystem: (p, b) => p + (b ? ' | ' + b : ''), station: room, emit() {}, redact: x => x, stoppedByYou: () => false })
      };
      A.eq(Object.keys(profiles).sort(), Object.keys(LineRunner.profiles).sort(), 'fixture: every hop profile the executor has is asked below (a new profile must be added to this table to land)');
      for (const name of Object.keys(profiles)) {
        for (const entry of [true, false]) {
          const label = name + (entry ? ' entry hop' : ' later hop');
          const seen = [];
          const lr = LineRunner.makeLineRunner({ now: () => 1000, runOnce: async o => { seen.push(o); return { reason: 'done', outcome: 'succeeded', text: 'a stage output', runId: o.runId }; } });
          const hop = () => lr.hopRunner(profiles[name]())({ agentId: 'alpha', dockId: 'b1', entry, text: 'a job', from: 'beta', streamId: 's1', sessionId: 'x', signal: new AbortController().signal,
            lineId: 'line-one', runId: '00000000-0000-4000-8000-000000000001' });
          outside(goodBytes);
          const good = await hop();
          A.ok(seen.length === 1 && bayOf(seen[0]) === 'bay' && !good.error && /a stage output/.test(good.text), label + ': control: on a good floor the stage runs in alpha\'s bay room — ' + JSON.stringify({ n: seen.length, room: bayOf(seen[0]), error: good.error }));
          outside('{ not a save'); seen.length = 0;
          const held = await hop();
          A.eq(seen.length, 0, label + ': a held floor: runOnce is never called — not in a fallback room, not in the whole default office');
          A.ok(HELD_SAID.test(held.error || '') && held.stopCode === 'stage_failed' && !held.text, label + ': the stage fails in the hold\'s own words — ' + JSON.stringify([held.error, held.stopCode]));
          outside(goodBytes);
        }
      }
      // the dock's brief is asked of the floor too: a hold there ends the hop, but any OTHER brief failure still degrades to "no brief" (narrower, as before)
      const holdErr = Object.assign(new Error('Saved routing authority is held: corrupt'), { held: true, status: 'corrupt', code: 'EROUTING_SAVED_CORRUPT', why: heldWhy('corrupt') });
      for (const [what, err, runs] of [['a hold', holdErr, false], ['a bug', new TypeError('a bug in the brief read'), true]]) {
        const seen = [];
        const lr = LineRunner.makeLineRunner({ now: () => 1000, runOnce: async o => { seen.push(o); return { reason: 'done', outcome: 'succeeded', text: 'a stage output', runId: o.runId }; } });
        const r = await lr.hopRunner(LineRunner.profiles.steptest({ config: cfg, persona: 'p', brief: () => { throw err; }, dockSystem: (p, b) => p + (b ? ' | ' + b : ' | NO BRIEF'),
          station: () => ({ agents: {}, rooms: { bay: { id: 'bay', objects: [] } } }), emit() {}, redact: x => x, stoppedByYou: () => false }))(
          { agentId: 'alpha', dockId: 'b1', entry: true, text: 'a job', streamId: 's1', sessionId: 'x', signal: new AbortController().signal, lineId: 'line-one', runId: '00000000-0000-4000-8000-000000000002' });
        if (runs) A.ok(seen.length === 1 && /NO BRIEF/.test(seen[0].system) && !r.error, 'steptest: ' + what + ' reading the brief is not a hold: the entry hop runs with no brief — ' + JSON.stringify([seen.length, r.error]));
        else A.ok(seen.length === 0 && HELD_SAID.test(r.error || ''), 'steptest: ' + what + ' reading the brief ends the hop, in the hold\'s words, before runOnce — ' + JSON.stringify([seen.length, r.error]));
      }
    }

    // ---- 10. the step-through test over the real authority ----
    {
      const { makeStepTest } = require('../sidecar/routing/steptest.js');
      const ran = [];
      let spoilAfter = 0, spoilAtPreflight = false;
      const lineRunner = LineRunner.makeLineRunner({ now: () => 1000, runOnce: async o => {
        ran.push({ agentId: o.agentId, room: bayOf(o) });
        if (spoilAfter === ran.length) outside('{ not a save');   // the floor goes held while this stage runs
        return { reason: 'done', outcome: 'succeeded', text: 'output of ' + o.agentId, runId: o.runId, usd: 0 };
      } });
      const runDock = h => lineRunner.hopRunner(LineRunner.profiles.steptest({ config: cfg, persona: 'p', brief: (a, d) => admit.stageBrief(a, d), dockSystem: (p, b) => p + (b ? ' | ' + b : ''),
        station: (a, d) => admit.stationFor(a, d), emit() {}, redact: x => x, stoppedByYou: () => false }))(h);
      // the plan seams exactly as index.js getStepTest hands them: admit for every routing decision, observe for the limit
      const plan = { get: () => admit.getPlan(), step: (a, c) => admit.chainStep(a, c), peek: (a, c) => admit.chainPeek(a, c), stepDock: (d, c) => admit.chainStepDock(d, c),
        peekDock: (d, c) => admit.chainPeekDock(d, c), dockRef: (r, l) => admit.dockRef(r, l),
        entryDock: (line, text) => { const r = admit.resolveDock({ text, lineId: line }); return (r && admit.lineOriginFor(r.agentId, r.dockId) === line) ? r : null; },
        lineOf: (a, d) => admit.lineOfAgent(a, d), stageBrief: (a, d) => admit.stageBrief(a, d), loopGateAfter: (a, l, d) => admit.loopGateAfter(a, l, d),
        lastStage: (a, d) => admit.chainShipsToOutbox(a, d), lineLimits: l => observe.lineLimits(l), shipsToOutbox: (a, d) => admit.chainShipsToOutbox(a, d) };
      let seq = 0;
      const mk = () => makeStepTest({ lineRunner, runDock, plan, preflight: () => { if (spoilAtPreflight) outside('{ not a save'); return null; }, poolCap: () => null,
        getTag: () => undefined, label: id => id, now: () => 1000, newId: () => 'st_' + (++seq) });
      const walk = async (st, body) => { const r = st.start(body); if (!r.ok) return { r, s: null }; await st.settled(r.session.id); return { r, s: st.get(r.session.id).session }; };
      const HELD_TEST = /^the test stopped: the saved floor is corrupt; routing is held until it is readable$/;

      outside(goodBytes); ran.length = 0;
      let x = await walk(mk(), { line: 'line-one', text: 'carry this job', pause: 'none' });
      A.ok(x.s.state === 'done' && x.s.error === null && x.s.hops.length === 2 && ran.map(r => r.agentId + '@' + r.room).join() === 'alpha@bay,beta@bay',
        'control: on a good floor the test walks both stages, each in its bay room — ' + JSON.stringify([x.s.state, x.s.error, ran]));

      // the floor goes held while stage one runs, with the test set to run straight through
      outside(goodBytes); ran.length = 0; spoilAfter = 1;
      x = await walk(mk(), { line: 'line-one', text: 'carry this job', pause: 'none' });
      spoilAfter = 0;
      A.ok(x.s.state === 'stopped' && x.s.stop && x.s.stop.code === 'refused' && HELD_TEST.test(x.s.error || '') && x.s.stop.why === heldWhy('corrupt'),
        'a floor that goes held after stage one ENDS the test: stopped, the refused stop, the hold\'s words — never "done" with no word of it — ' + JSON.stringify([x.s.state, x.s.stop, x.s.error]));
      A.ok(x.s.hops.length === 1 && ran.length === 1 && x.s.hops[0].output === 'output of alpha', 'stage one\'s work is kept, and stage two never ran');

      // the floor goes held between the plan reads that START the test and its first stage
      outside(goodBytes); ran.length = 0; spoilAtPreflight = true;
      x = await walk(mk(), { line: 'line-one', text: 'carry this job', pause: 'none' });
      spoilAtPreflight = false;
      A.eq(ran.length, 0, 'a floor held at the instant of the first stage: nothing ran — not in the whole default office, not with no brief');
      A.ok(x.s.state === 'failed' && /the saved floor is corrupt; routing is held until it is readable/.test(x.s.error || '') && x.s.stop && x.s.stop.code === 'stage_failed',
        'and the stage fails in the hold\'s words — ' + JSON.stringify([x.s.state, x.s.error, x.s.stop]));

      // a start while the floor is held (the route gates first; the engine must not depend on it)
      outside('{ not a save'); ran.length = 0;
      const direct = mk(), refusedStart = direct.start({ line: 'line-one', text: 'carry this job', pause: 'none' });
      A.ok(refusedStart.ok === false && HELD_SAID.test(refusedStart.error) && refusedStart.stop && refusedStart.stop.code === 'refused' && direct._sessions().length === 0 && ran.length === 0,
        'a start on a held floor is refused in the hold\'s words, typed refused: no session, nothing run — not "no work line is armed" — ' + JSON.stringify(refusedStart));

      // a paused test: held floor keeps it paused; CONTINUE refuses; the file coming back resumes it
      outside(goodBytes); ran.length = 0;
      const stp = mk(), begun = stp.start({ line: 'line-one', text: 'carry this job', pause: 'every' });
      await stp.settled(begun.session.id);
      const id = begun.session.id;
      A.eq([stp.get(id).session.state, stp.get(id).session.paused.next.kind, ran.length], ['paused', 'agent', 1], 'control: the test pauses after stage one, with stage two next');
      outside('{ not a save');
      const look = stp.get(id);
      A.ok(look.ok && look.session.state === 'paused' && look.session.paused.next.kind === 'agent' && look.session.paused.next.agentId === 'beta',
        'a held floor does not rewrite what a paused test shows next (a read never throws, and never says "no work line is armed") — ' + JSON.stringify(look.session.paused.next));
      const go = stp.continue(id, {});
      A.ok(go.ok === false && HELD_SAID.test(go.error) && go.stop && go.stop.code === 'refused' && ran.length === 1 && stp.get(id).session.state === 'paused',
        'CONTINUE on a held floor refuses in the hold\'s words and the test stays paused — ' + JSON.stringify(go));
      outside(goodBytes);
      const resumed = stp.continue(id, {}); await stp.settled(id);
      A.ok(resumed.ok && ran.length === 2 && ran[1].agentId === 'beta' && ran[1].room === 'bay', 'the file is back: CONTINUE runs stage two in its bay room, with no restart — ' + JSON.stringify([resumed.ok, ran]));
      outside(goodBytes);
    }

    // ---- 11. INVARIANT held-says-how: a hold the person can end tells them the step, in the sentence every refusal reads ----
    {
      /* That sentence is the one place a chat reply, a routine's blocked row, Run Now's 409, a line's stop, the away card and the LOOPS window
         all read, so a step that ends a hold has to be said THERE. STEP is the holds the person can end, each with the step its words must
         name; NO_STEP is the holds with no single step to name (the file is gone, damaged, locked, mid-save or unproved), whose words say only
         what is wrong and that routing waits. THE TABLE NAMES EVERY STATUS: a hold added to HOLD_STATUSES lands only with a row here. */
      const STEP = {
        'migration-required': /open StarNet once/,   // the page migrates a save one version behind, and saves it, when it opens (frontend/app/save.js)
        future: /update StarNet/                       // a save a newer StarNet wrote is read by that StarNet, never migrated down
      };
      const NO_STEP = ['absent', 'corrupt', 'unreadable', 'unavailable', 'unstamped', 'invalid', 'unvouched', 'unsupported-geometry', 'changed'];
      A.eq(Object.keys(STEP).concat(NO_STEP).sort(), HOLD_STATUSES.slice().sort(), 'the table names every hold status exactly once (a new hold must be added to it, endable or not, to land)');
      for (const status of HOLD_STATUSES) {
        const said = heldWhy(status);
        A.ok(HELD_SAID.test(said), status + ': one sentence in the one grammar — ' + said);
        if (STEP[status]) A.ok(STEP[status].test(said), status + ': the person can end this hold, so the sentence says how — ' + said);
      }
      // and the words reach the person through the real read, not only through heldWhy: section 4's spoiled floors, for each hold with a step
      const rows = table.filter(row => STEP[row[2]]);
      A.eq(rows.map(row => row[2]).sort(), Object.keys(STEP).sort(), 'fixture: section 4 spoils a real saved floor into every hold the person can end');
      for (const [label, spoil, status] of rows) {
        outside(goodBytes);
        A.ok(admit.resolveDock(...ASKS.resolveDock), label + ': warm on a good floor');
        spoil();
        const e = caught(() => admit.resolveDock(...ASKS.resolveDock));
        A.ok(e && e.held === true && e.status === status && STEP[status].test(e.why || ''), label + ': the hold a real read throws says the step — ' + (e && (e.why || e.message)));
        const now = seams.hold();
        A.ok(now && now.status === status && STEP[status].test(now.why), label + ': hold() says it too — ' + JSON.stringify(now));
        outside(goodBytes);
        A.eq(seams.hold(), null, label + ': the file is back and the hold is gone, with no restart');
      }
    }
  } finally {
    locked = false;
    for (const d of fs.readdirSync(os.tmpdir())) if (/^saved-seams-/.test(d)) { try { fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true }); } catch (_) { /* temp */ } }
  }
  A.report('routing.saved-seams');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
