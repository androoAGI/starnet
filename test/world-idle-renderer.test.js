/* node test/world-idle-renderer.test.js — THE IDLE RENDERER (wave 5, behind a flag: gh#69, gh#114, bug 9256a771, email E55).

   An idle station should cost close to nothing, without lowering the visible frame rate. Three classes, each executed on the
   real code, each failing on the commit below it (c9a51fa73, 0b8441064, and 6b9730864), where the auto-director trailed walkers
   for as long as a window was left open, every material was painted into its own canvas at boot, and a message that started
   no run left the resting station asleep:

     1. THE CINECAM RESTS — with the flag on, a station nobody has touched for the takeover time plus CINE_REST_MS, with no
        run live for CINE_REST_MS, has its auto-director stand down and stay down; a hand on the window or a live run brings
        it back on its own rules. With the flag off (the default) the director is exactly what it was. Nothing here caps a
        frame rate: the visible and motion paces are untouched.
     1b. THE CREW SETTLE — while the station rests, a body's next idle decision starts nothing new and holds it still, the
        frame judge reads the settled floor (crew and hero) as no motion, and the first touch or a live run wakes every settled
        body on that same tick. Fails on 199227f14, where the rested camera still watched the crew wander at ~47 draws/s.
     1c. A MESSAGE THAT STARTS NO RUN ENDS THE REST — one rule for a run and for news: no hand, no live run, no wake event for
        CINE_REST_MS. A channel message the dish only pulses for, a permission prompt, a deliverable, a summon, a routine's report
        or an alert (REST_WAKE_EVENTS) emitted on the real util.js bus ends the rest, wakes every settled body on that same tick
        and lets the rest return CINE_REST_MS later; background chatter (tokens, queue depth, cost, memory, link state, tool
        traffic) never does, and neither does motionWake itself, which polls and reconnects call all day. Every event the world
        hears is classified wake or quiet. Fails on 6b9730864, where only the frame pace woke and the crew stayed asleep.
     2. LAZY ART — with the flag on, no material is painted at boot; one is painted the first time something draws it, at
        most ART_LRU_MAX are held, least recently used out first, and an evicted one is painted again on its next draw. With
        the flag off every material is painted at boot, as before. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), A = require('./_assert');
const ROOT = path.join(__dirname, '..');
const world = fs.readFileSync(path.join(ROOT, 'frontend/app/world.js'), 'utf8');
const texSrc = fs.readFileSync(path.join(ROOT, 'frontend/app/industrialtextures.js'), 'utf8');

/* ---- 1. THE CINECAM RESTS (the real cinecamTick, cineRested and liveRunCount) ---- */
const sliceW = header => { const b = A.fnBody(world, header); A.ok(b.length > 40 && b.length < 8000, header + ' is sliced'); return b; };
const directorSrc = sliceW('  function cinecamTick(') + '\n' + sliceW('  function cineRested(') + '\n' + sliceW('  function liveRunCount(');
const restMs = Number((world.match(/const CINE_REST_MS = ([\d *]+);/) || [])[1] ? eval(world.match(/const CINE_REST_MS = ([\d *]+);/)[1]) : NaN);
A.ok(restMs >= 60000, 'CINE_REST_MS is a real rest (' + restMs + ' ms), not a hair-trigger');
function director(flagOn) {
  return new Function('flagOn', 'REST', `
    const MINZ = 0.5, MAXZ = 6, clampz = (v, a, b) => v < a ? a : v > b ? b : v, U = { irnd: (a, b) => a };
    let camLock = null, camAnim = null, camLerp = null, awakeFrozen = false, cache = {}, chatFocusId = null;
    let camUserAt = 0, cineIdleMs = 120000, cineHoldUntil = 0, cineWalkAt = 0;
    const CINE_REST_MS = REST, reduceMotion = () => false;
    let idleRenderer = flagOn, runSeenAt = 0, cineRestMs = REST;
    const liveRunsByAgent = new Map();
    const crew = [{ id: 'b', agentId: 'b', state: 'walk' }], agent = { id: 'a', agentId: 'a', state: 'idle' };
    const bodyForAgent = id => id === 'a' ? agent : crew.find(c => c.agentId === id) || null;
    ${directorSrc}
    return {
      tick: now => cinecamTick(now), mode: () => camLock ? camLock.source : 'manual',
      touch: now => { camUserAt = now; camLock = null; },
      sessionLock: () => { camLock = { id: 'a', sc: 2, source: 'session' }; }, clearLock: () => { camLock = null; },
      runStart: () => liveRunsByAgent.set('a', new Map([['r1', 0]])), runEnd: () => liveRunsByAgent.delete('a')
    };`)(flagOn, restMs);
}
{
  const MIN = 60000, takeover = 120000;
  const off = director(false);
  off.tick(takeover + 1);
  A.eq(off.mode(), 'cine', 'flag off: the director takes the camera after the hands-off time, as before');
  for (let t = takeover; t < 4 * 3600 * 1000; t += 10 * MIN) off.tick(t);
  A.eq(off.mode(), 'cine', 'flag off: four hours left open, the director is still trailing (nothing changed by default)');

  const on = director(true);
  on.tick(takeover + 1);
  A.eq(on.mode(), 'cine', 'flag on: the director still takes over after the hands-off time (the crew is shown living)');
  on.tick(takeover + restMs - 1);
  A.eq(on.mode(), 'cine', 'flag on: ...and keeps the shot until the rest time has passed');
  on.tick(takeover + restMs + 1);
  A.eq(on.mode(), 'manual', 'flag on: truly idle (no hand, no run) — the director stands down; the camera stays where it is');
  for (let t = takeover + restMs; t < 4 * 3600 * 1000; t += 10 * MIN) on.tick(t);
  A.eq(on.mode(), 'manual', 'flag on: and stays down for as long as the station stays idle (no full-pace camera motion)');
  on.sessionLock(); on.tick(4 * 3600 * 1000);
  A.eq(on.mode(), 'session', 'a session lock still owns the camera outright: the rest never releases it');
  on.clearLock();

  let t = 3 * 3600 * 1000;
  on.runStart(); on.tick(t);
  A.eq(on.mode(), 'cine', 'a live run ends the rest: the director comes back to show the work');
  on.runEnd(); on.tick(t + restMs - 1);
  A.eq(on.mode(), 'cine', 'after the run, the rest waits its full time again');
  on.tick(t + restMs + 1);
  A.eq(on.mode(), 'manual', '...then the floor rests again');

  t += 2 * restMs; on.touch(t); on.tick(t + 1000);
  A.eq(on.mode(), 'manual', 'a hand on the window: the manual camera, as always');
  on.tick(t + takeover + 1);
  A.eq(on.mode(), 'cine', 'and the director takes over again on its own hands-off rule');
}
{
  // the flag: off unless asked; the query wins over the stored value; setIdleRenderer persists it and wakes the floor
  A.ok(/idleRenderer = q != null \? \(q === '1' \|\| q === 'on'\) : \(typeof localStorage !== 'undefined' && localStorage\.getItem\('starnet\.idleRenderer'\) === '1'\);/.test(world), 'world.js: the flag is off unless ?idleRenderer=1 or the stored opt-in');
  const set = sliceW('  function setIdleRenderer(');
  A.ok(/localStorage\.setItem\('starnet\.idleRenderer'/.test(set) && /motionWake\(\);/.test(set), 'setIdleRenderer persists the choice and wakes the floor to judge itself');
  A.ok(/setIdleRenderer, idleRendererOn: \(\) => idleRenderer,/.test(world), 'World exposes the switch for the A/B');
  // never lower the visible frame rate: the paces are the approved ones and the idle code books no cap
  A.ok(/const PACE_VISIBLE_MS = 1000 \/ 60, PACE_MOTION_MS = 1000 \/ 144/.test(world), 'the visible pace stays 60 and the motion pace 144');
  const idleCode = sliceW('  function cineRested(') + sliceW('  function setIdleRenderer(');
  A.ok(!/setFrameCap|frameCapMs|PACE_/.test(idleCode), 'the idle renderer touches no pace and books no frame cap');
}

/* ---- 1b. THE CREW SETTLE (the real crewRestGate, wakeSettledCrew, crewSettledCount, standStill, cineRested, and the frame
   judge itself: bodyStillWhy + heroGlanceAt). A rested camera alone left P7 at ~47 draws/s, because idle crew kept starting
   wanders and social beats on screen. While the station rests, a body's next idle decision settles it still where it stands,
   the judge then reads it as no motion (crew AND hero), and the first touch or a live run hands every settled body its next
   decision on the same tick. ---- */
const lineOf = re => { const m = world.match(re); A.ok(!!m, 'world.js holds ' + re.source.slice(0, 40)); return m ? m[0] : ''; };
const settleSrc = ['  function crewRestGate(', '  function wakeSettledCrew(', '  function crewSettledCount(', '  function standStill(',
  '  function cineRested(', '  function liveRunCount(', '  function heroGlanceAt(', '  function bubbleShown(', '  function bodyStillWhy('].map(sliceW).join('\n');
const settleConsts = [/const CREW_REST_HOLD_MS = \d+;/, /const STILL_MOVE_EPS = [\d.]+;/, /const BODY_CLOCKS = Object\.freeze\(\[[^\]]*\]\);/,
  /const GLANCE_TAIL = [^;]+;/, /const GLANCE_BRANCH = [^;]+;/, /const GLANCE_NONE = [^;]+;/].map(lineOf).join('\n');
function floor(flagOn) {
  return new Function('flagOn', 'REST', `
    ${settleConsts}
    const U = { irnd: (a, b) => a }, offbeat = (now, ms) => ms, TALK_SLOT_MS = 1700, TALK_SPEAK_MS = 1150, CURSOR_FRESH_MS = 8000;
    const isTalkKind = k => k === 'huddle' || k === 'border', bodyOnScreen = () => true;
    let camUserAt = 0, cineIdleMs = 120000, idleRenderer = flagOn, runSeenAt = 0, cineRestMs = REST, crewSettling = false;
    let activity = 'idle', overlaysOn = false, hoverAgent = null, socialBeat = null, lastCursor = { t: -1e9 }, stillDueAcc = Infinity;
    const noteDue = (t, now) => { if (t > now && t < stillDueAcc) stillDueAcc = t; };
    const liveRunsByAgent = new Map();
    const mk = id => ({ id, agentId: id, px: 100, py: 100, dir: 'south', state: 'idle', goal: null, glance: null, glanceCd: 0, lookCd: 0,
      idleUntil: 0, _pose: 'set.rot.south', _renderFrame: 0 });
    const agent = mk('a'), crew = [mk('b'), mk('c')];
    let self = null;
    ${settleSrc}
    // the tick ladder reaching a body's idle decision: decideIdle's gate (its order is checked on the source below), else a new beat
    function decide(b, now) { self = b; b.stilling = false; if (crewRestGate(now)) return 'settled'; b.goal = 'wander'; b.state = 'walk'; return 'wander'; }
    return { agent, crew, decide, why: (b, now) => bodyStillWhy(b, now), count: () => crewSettledCount(), wake: now => wakeSettledCrew(now),
      touch: now => { camUserAt = now; }, runStart: () => liveRunsByAgent.set('a', new Map([['r1', 0]])), runEnd: () => liveRunsByAgent.delete('a') };`)(flagOn, restMs);
}
{
  const takeover = 120000, rest = takeover + restMs + 1, H = 3600 * 1000;
  const holdMs = Number((world.match(/const CREW_REST_HOLD_MS = (\d+);/) || [])[1]);
  const off = floor(false);
  A.eq([off.decide(off.crew[0], 4 * H), off.count()], ['wander', 0], 'flag off: four hours untouched, an idle body still starts its next beat (nothing changes by default)');
  const on = floor(true);
  A.eq(on.decide(on.crew[0], rest - 2), 'wander', 'flag on, before the rest: the crew live as before');
  on.crew[0].goal = null; on.crew[0].state = 'idle';
  const all = [on.agent].concat(on.crew);
  A.eq(on.decide(on.crew[0], rest), 'settled', 'flag on, the station rests: the next idle decision starts nothing new');
  const b = on.crew[0];
  A.eq([b.goal, b.state, b.stilling, b.glance, b.idleUntil], [null, 'idle', true, null, rest + holdMs], '...the body holds still where it stands (standStill, no glance) and re-checks after CREW_REST_HOLD_MS');
  A.eq(on.count(), 1, 'a body settles at ITS next decision: the others finish the step they are on first');
  for (const x of all) on.decide(x, rest + 10);
  A.eq(on.count(), 3, 'every body that reaches a decision settles (hero and crew)');
  // the judge: a settled floor is not motion, for ten minutes, crew AND hero (heroGlanceAt mirrors maybeGlance's settle gate)
  let moving = [];
  for (let t = rest + 20; t < rest + 10 * 60000; t += 33) for (const x of all) { const w = on.why(x, t); if (w && t > rest + 60) moving.push(x.id + ':' + w); }
  A.eq([...new Set(moving)], [], 'the frame judge reads a settled floor as still (no full-pace frame from any settled body)');
  A.eq(on.decide(b, rest + holdMs + 5), 'settled', 'a settled body re-checks and stays settled while the rest holds');
  on.wake(rest + holdMs + 6);
  A.eq(on.count(), 3, 'the wake is a no-op while the station still rests');
  // the first touch: every settled body may decide on the SAME tick (now >= idleUntil), and starts its life again
  const touchAt = rest + 20 * 60000;
  on.touch(touchAt); on.wake(touchAt);
  A.eq(on.count(), 0, 'the first touch ends the settle for every body');
  A.ok(all.every(x => x.idleUntil <= touchAt && x.stilling === false && !x.restSettled), '...each is due its next idle decision on that same tick (no wait for the 30 s re-check)');
  A.eq(on.decide(b, touchAt), 'wander', '...and its next decision starts a beat again');
  // a live run ends the rest the same way
  const later = touchAt + takeover + restMs + 1;
  for (const x of all) { x.goal = null; x.state = 'idle'; on.decide(x, later); }
  A.eq(on.count(), 3, 'left alone again, the floor settles again');
  on.runStart(); on.wake(later + 16);
  A.eq(on.count(), 0, 'a live run wakes every settled body (the rest is the camera\'s one rule: no hand AND no run)');
  on.runEnd();

  // the call sites, on the real source: the gate leads decideIdle's choices, the wake runs before any body steps, nothing new is called
  const decideSrc = A.fnBody(world, '  function decideIdle(');
  const gateAt = decideSrc.indexOf('if (crewRestGate(now)) return;');
  A.ok(gateAt > decideSrc.indexOf('if (chatStareHold(now)) return;'), 'decideIdle: the chat stare (a hot COMMS focus) still comes first');
  for (const beat of ['planMourn(now)', 'planInspect(now)', 'maybeQuirk(now)', 'planBedSleep(now)', 'sleep(now)', 'planExplore(now)', 'maybeChase(now)', 'maybeSocial(now)', 'maybeMimic(now)', 'maybeJoinBar(now)', 'maybeRounds(now)'])
    A.ok(gateAt > 0 && gateAt < decideSrc.indexOf(beat), 'decideIdle: the settle gate comes before ' + beat);
  A.ok(/function crewRestGate\(now\) \{[^}]*if \(!cineRested\(now\)\) return false;/.test(world), 'the crew rest is the camera\'s rest (one rule, one flag)');
  const tickSrc = A.fnBody(world, '  function tick(dt, now) {');
  const wakeAt = tickSrc.indexOf('wakeSettledCrew(now);');
  A.ok(wakeAt > 0 && wakeAt < tickSrc.indexOf('stepCrew(dt, now);') && wakeAt < tickSrc.indexOf('decideIdle(now);'), 'tick: the wake runs before the crew step and the hero\'s decision (same-tick wake)');
  A.ok(tickSrc.indexOf('if (!gathering && !cineRested(now)) maybeGather(now);') > 0, 'tick: a resting station calls no new gathering');
  const glanceSrc = A.fnBody(world, '  function maybeGlance(');
  const gGate = glanceSrc.indexOf('if (agent.restSettled && agent.stilling) return;');
  A.ok(gGate > 0 && gGate < glanceSrc.indexOf('THE LOOK-UP'), 'maybeGlance: a settled hero makes no look-up and no swivel');
  A.ok(/crewSettled: crewSettledCount\(\)/.test(world), 'cameraDbg reports how many bodies are settled (perf-idle-ab P7 reads it)');
}

/* ---- 1c. A MESSAGE THAT STARTS NO RUN ENDS THE REST (the production wiring: the real util.js U.bus, the tap statements of
   connectChannelBridge, and restWakeOn, both event sets, motionWake, cineRested, crewRestGate and wakeSettledCrew sliced from
   world.js; fakes only for the bodies and the clock). A live run ends the rest by being live. A channel message that starts
   no run (the dish pulses, nothing runs), a permission prompt, a deliverable, a summon or an alert left the camera rested and
   every body settled: only the frame pace woke, for one frame. The wake itself is 1b's (wakeSettledCrew runs in the tick before
   any body steps); this class pins what stamps the rest, and what must never. ---- */
const utilSrc = fs.readFileSync(path.join(ROOT, 'frontend/js/util.js'), 'utf8');
const stripped = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const wcode = stripped(world);
// The product call (Andrew decision 1 of the 11-04 idle-renderer plan; the default taken until he says otherwise): what is news to a
// resting station. Everything else the world hears is chatter.
const WAKE = ['channel.inbound', 'permission.prompt', 'deliverable', 'workitem.placed', 'cron.result', 'capdenied', 'credits.low', 'budget.threshold', 'agent.run.error'];
const CHATTER = ['agent.token', 'queue.status', 'cost.estimate', 'memory.recall', 'channel.connect', 'agent.tool_call', 'task', 'shell.exec', 'verify.result'];
// every event name the world hears: each literal U.bus.on('name', and the one loop over an array of names
const heard = new Set();
{
  let literal = 0, looped = 0;
  for (const m of wcode.matchAll(/U\.bus\.on\('([^']+)'/g)) { heard.add(m[1]); literal++; }
  for (const m of wcode.matchAll(/for \(const (\w+) of \[([^\]]*)\]\) U\.bus\.on\(\1,/g)) { looped++; for (const n of m[2].match(/'[^']+'/g) || []) heard.add(n.slice(1, -1)); }
  A.eq((wcode.match(/U\.bus\.on\(/g) || []).length, literal + looped, 'the walk reads every U.bus.on in world.js (a literal event name, or the one array loop)');
  A.ok(heard.size >= 25 && WAKE.concat(CHATTER).every(n => heard.has(n)), 'the world hears the whole event vocabulary the rest cares about (' + heard.size + ' names)');
}
const namesIn = re => { const m = wcode.match(re); return m ? (m[1].match(/'[^']+'/g) || []).map(s => s.slice(1, -1)) : []; };
const wakeNames = namesIn(/const REST_WAKE_EVENTS = new Set\(\[([\s\S]*?)\]\);/), quietNames = namesIn(/const REST_QUIET_EVENTS = new Set\(\[([\s\S]*?)\]\);/);
{
  A.eq(wakeNames.slice().sort(), WAKE.slice().sort(), 'REST_WAKE_EVENTS is exactly the product call: a message, a prompt, a deliverable, a summon, a routine report, an alert');
  A.eq([...heard].filter(n => !wakeNames.includes(n) && !quietNames.includes(n)).sort(), [], 'every event the world hears is classified wake or quiet: a new event cannot reach the floor unclassified');
  A.eq([...wakeNames, ...quietNames].filter(n => !heard.has(n)), [], 'both sets name only events the world hears (a wake event nobody hears would never reach the bus tap)');
  A.eq(wakeNames.filter(n => quietNames.includes(n)), [], 'no event is both wake and quiet');
  A.eq(new Set(wakeNames.concat(quietNames)).size, wakeNames.length + quietNames.length, 'each event is listed once');
  A.ok(CHATTER.every(n => quietNames.includes(n)), 'tokens, queue depth, cost, memory, link state and tool traffic are quiet');
}
const restConsts = [/const REST_WAKE_EVENTS = new Set\(\[[\s\S]*?\]\);/, /const REST_QUIET_EVENTS = new Set\(\[[\s\S]*?\]\);/, /const CREW_REST_HOLD_MS = \d+;/].map(lineOf).join('\n');
const restSrc = ['  function restWakeOn(', '  function motionWake(', '  function crewRestGate(', '  function wakeSettledCrew(', '  function crewSettledCount(', '  function standStill(',
  '  function cineRested(', '  function liveRunCount('].map(sliceW).join('\n');
// the production wiring: connectChannelBridge's own tap statements, run as written against the real bus
const bridgeSrc = A.fnBody(world, '  function connectChannelBridge(');
A.ok(bridgeSrc.length > 8000 && bridgeSrc.length < world.length / 4 && bridgeSrc.includes("U.bus.on('channel.inbound'"), 'connectChannelBridge is sliced whole (it holds the channel.inbound subscription)');
const tapStmts = bridgeSrc.match(/if \(typeof U\.bus\.tap === 'function'\) U\.bus\.tap\(\w+\);/g) || [];
A.ok(tapStmts.includes("if (typeof U.bus.tap === 'function') U.bus.tap(motionWake);"), 'the bridge still taps motionWake, its line untouched (every harness event wakes the frame pace)');
A.ok(/U\.bus\.tap\(motionWake\);\s*if \(typeof U\.bus\.tap === 'function'\) U\.bus\.tap\(restWakeOn\);/.test(bridgeSrc), 'and taps restWakeOn right after it (the rest is a second tap, not a change to the first)');
function wired(flagOn, unheard) {
  const sb = { console, window: {}, document: {}, navigator: {}, setTimeout, clearTimeout };
  vm.createContext(sb); vm.runInContext(utilSrc + '\nthis.U = U;', sb);
  const U = sb.U, clock = { t: 0 }, reached = [];
  U.irnd = a => a;
  const h = new Function('U', 'flagOn', 'REST', 'clock', `
    const performance = { now: () => clock.t };
    ${restConsts}
    const offbeat = (now, ms) => ms;
    let camUserAt = 0, cineIdleMs = 120000, idleRenderer = flagOn, runSeenAt = 0, cineRestMs = REST, crewSettling = false;
    let stillNow = true, stillKick = false, stillWhy = '', paceWakes = 0;
    function paceWake() { paceWakes++; }
    const liveRunsByAgent = new Map();
    const mk = id => ({ id, agentId: id, px: 100, py: 100, dir: 'south', state: 'idle', goal: null, glance: null, glanceCd: 0, lookCd: 0, idleUntil: 0, _pose: 'set.rot.south', _renderFrame: 0 });
    const agent = mk('a'), crew = [mk('b'), mk('c')], all = [agent].concat(crew);
    let self = null;
    ${restSrc}
    ${tapStmts.join('\n    ')}
    function decide(b, now) { self = b; b.stilling = false; if (crewRestGate(now)) return 'settled'; b.goal = 'wander'; b.state = 'walk'; return 'wander'; }
    return { all, decide, motionWake, restWakeOn: typeof restWakeOn === 'function' ? restWakeOn : null,
      settleAll: now => { clock.t = now; for (const b of all) { b.goal = null; b.state = 'idle'; decide(b, now); } },
      recheck: now => all.map(b => b.idleUntil <= now ? decide(b, now) : 'holding'),
      dueNow: now => all.every(b => b.idleUntil <= now && b.stilling === false && !b.restSettled),
      wake: now => wakeSettledCrew(now), count: () => crewSettledCount(), rested: now => cineRested(now),
      seen: () => runSeenAt, paceWakes: () => paceWakes, framePaceKicked: () => stillNow === false && stillKick === true };`)(U, flagOn, restMs, clock);
  for (const n of heard) if (n !== unheard) U.bus.on(n, () => {});   // the world's own listeners: an emit with none reaches no tap
  U.bus.tap(ev => reached.push(ev));              // a probe AFTER the production taps: the event got as far as the tap stage
  return Object.assign(h, { U, clock, reached });
}
{
  const takeover = 120000, rest = takeover + restMs + 1, wakeAt = rest + 30000;
  for (const ev of WAKE) {
    const w = wired(true);
    w.settleAll(rest);
    A.eq([w.rested(rest), w.count()], [true, 3], ev + ': the station rests and every body (hero and crew) is settled');
    w.clock.t = wakeAt;
    w.U.bus.emit(ev, {});
    A.ok(w.reached.includes(ev), ev + ': the event reached the bus tap stage (the world listens for it)');
    A.eq(w.rested(wakeAt), false, ev + ': a message that starts no run ends the rest');
    w.wake(wakeAt);
    A.eq([w.count(), w.dueNow(wakeAt)], [0, true], ev + ': the next tick wakes every settled body, each due its next decision on that same tick');
    A.eq([w.paceWakes(), w.framePaceKicked()], [1, true], ev + ': and the frame pace wakes through the existing motionWake tap (the next vsync draws it)');
    A.eq([w.rested(wakeAt + restMs - 1), w.rested(wakeAt + restMs)], [false, true], ev + ': the rest holds off for CINE_REST_MS, then returns (the same price a run pays)');
    w.settleAll(wakeAt + restMs);
    A.eq(w.count(), 3, ev + ': left alone again, the floor settles again');
  }
  // a wake event keeps waking: each one pushes the return of the rest out from ITS time
  const again = wired(true);
  again.settleAll(rest);
  again.clock.t = wakeAt; again.U.bus.emit('channel.inbound', {});
  again.clock.t = wakeAt + 4 * 60000; again.U.bus.emit('deliverable', {});
  A.eq([again.rested(wakeAt + restMs), again.rested(wakeAt + 4 * 60000 + restMs - 1), again.rested(wakeAt + 4 * 60000 + restMs)], [false, false, true], 'a second wake event four minutes later restarts the rest clock from its own time');

  // background chatter never ends a rest: every quiet event the world hears, at 1/s for ten simulated minutes
  const chatter = [...new Set(CHATTER.concat(quietNames))];
  const q = wired(true);
  q.settleAll(rest);
  const decisions = new Set();
  for (let s = 1; s <= 600; s++) {
    const t = rest + s * 1000;
    q.clock.t = t;
    q.U.bus.emit(chatter[(s - 1) % chatter.length], {});
    q.wake(t);
    for (const d of q.recheck(t)) decisions.add(d);
  }
  A.eq([q.rested(rest + 600000), q.count(), q.seen()], [true, 3, 0], 'ten minutes of chatter at 1 event/s (' + chatter.length + ' kinds): the station still rests, every body still settled, the rest never stamped');
  A.eq([...decisions].sort(), ['holding', 'settled'], '...every 30 s re-check of a settled body found the rest holding (none started a beat)');
  A.eq([q.reached.length, q.paceWakes()], [600, 600], '...and every one of them reached the bus tap and woke the frame pace, so the guard is not vacuous: the rest is not the frame pace');
  // motionWake alone (the polls, the snapshot reconcile, an SSE reopen, setActivityFor with no run) never ends the rest
  const m = wired(true);
  m.settleAll(rest);
  for (let i = 0; i < 1000; i++) { m.clock.t = rest + i; m.motionWake(); }
  A.eq([m.rested(rest + 1000), m.count(), m.seen(), m.paceWakes()], [true, 3, 0, 1000], 'motionWake called all day wakes the frame pace and nothing else: the rest is not tied to it');
  // the one way a wake event is lost: U.bus.emit returns early when nobody listens, so no tap runs. The ratchet above (both sets
  // name only events the world hears) is what keeps every wake event heard.
  const deaf = wired(true, 'channel.inbound');
  deaf.settleAll(rest);
  deaf.clock.t = wakeAt; deaf.U.bus.emit('channel.inbound', {});
  A.eq([deaf.reached.length, deaf.rested(wakeAt)], [0, true], 'a wake event the world did not listen for reaches no tap and ends no rest (why every wake event must be heard)');

  // the flag off (the default): restWakeOn is inert — nothing is stamped, nobody settles, the crew live as before
  const off = wired(false);
  off.settleAll(rest);
  A.eq([off.count(), off.rested(rest)], [0, false], 'flag off: the station never rests and no body settles');
  for (const ev of WAKE) { off.clock.t = wakeAt; off.U.bus.emit(ev, {}); }
  A.eq([off.seen(), off.rested(wakeAt), off.count()], [0, false, 0], 'flag off: every wake event is heard and stamps nothing (restWakeOn is inert)');
  A.eq(off.decide(off.all[1], wakeAt), 'wander', 'flag off: a body\'s next decision starts its beat, as before');

  // the stamp's writers: its declaration, the live-run stamp in cinecamTick, and restWakeOn. motionWake and paceWake never touch the rest.
  A.eq((wcode.match(/\brunSeenAt\s*=[^=]/g) || []).length, 3, 'runSeenAt has exactly three writers: its declaration, the live-run stamp in cinecamTick, and restWakeOn');
  A.ok(!/runSeenAt|camUserAt/.test(A.fnBody(wcode, '  function motionWake(') + A.fnBody(wcode, '  function paceWake(')), 'motionWake and paceWake do not touch the rest');
}

/* ---- 2. LAZY ART (the real industrialtextures.js in a vm) ---- */
function loadTextures(search, stored) {
  const created = [];
  const canvas = () => {
    const cv = { width: 0, height: 0, getContext: () => ({ filter: 'none', drawImage() {}, fillRect() {}, setTransform() {}, clearRect() {}, getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }) }) };
    created.push(cv); return cv;
  };
  class Image { constructor() { this.width = 8; this.height = 8; } set src(v) { this._src = v; Promise.resolve().then(() => this.onload && this.onload()); } get src() { return this._src; } }
  const store = new Map(stored ? [['starnet.idleRenderer', stored]] : []);
  const ctx = vm.createContext({
    console, Image, Promise, Map, Set, Object, Array, Math, Number, String, JSON, Proxy, Uint8ClampedArray, URLSearchParams,
    location: { search }, localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) },
    document: { createElement: () => canvas(), documentElement: { dataset: {} } }
  });
  vm.runInContext(texSrc + '\nthis.__T = IndustrialTextures;', ctx, { filename: 'industrialtextures.js' });
  return { T: ctx.__T, created };
}
(async () => {
  const lru = Number((texSrc.match(/const ART_LRU_MAX = (\d+);/) || [])[1]);
  A.ok(lru >= 8 && lru <= 64, 'ART_LRU_MAX bounds the painted canvases (' + lru + ')');

  const eager = loadTextures('', null);
  await eager.T.ready;
  const all = eager.T.status().assets;
  A.ok(all.length > lru + 4, 'flag off: every material is painted at boot, as before (' + all.length + ')');
  A.eq(eager.T.status().lazyArt, false, 'flag off is the default');

  const lazy = loadTextures('', '1');
  await lazy.T.ready;
  const st0 = lazy.T.status();
  A.eq([st0.lazyArt, st0.artHeld, st0.artPainted], [true, 0, 0], 'flag on: nothing is painted at boot');
  A.eq(lazy.T.enabled(), true, '...and the pack still reports loaded (the originals are in)');
  A.ok(lazy.T._dbgArtTouch(all[0]) && lazy.T.status().artPainted === 1, 'the first draw of a material paints it');
  lazy.T._dbgArtTouch(all[0]);
  A.eq(lazy.T.status().artPainted, 1, 'a second draw reuses the painted canvas');
  for (const name of all) lazy.T._dbgArtTouch(name);
  const st1 = lazy.T.status();
  A.eq(st1.artHeld, lru, 'drawing every material holds at most ART_LRU_MAX painted canvases');
  A.eq(st1.artEvicted, all.length - lru, 'the rest were let go, least recently used first');
  A.eq(lazy.T.status().assets.length, all.length, 'status().assets still names every material loaded (the leak probe and the audit read it)');
  lazy.T._dbgArtTouch(all[all.length - 1]);
  A.eq(lazy.T.status().artPainted, all.length, 'the newest use is still held (no repaint)');
  A.ok(lazy.T._dbgArtTouch(all[0]) && lazy.T.status().artPainted === all.length + 1, 'the oldest went out first: it is painted again on its next draw');
  A.eq(lazy.T._dbgArtTouch('constructor'), false, 'a prototype name is never a material');
  A.eq(lazy.T._dbgArtTouch('no-such-material'), false, 'an unknown material is still absent (callers keep their fallback)');
  lazy.T.restoreMaterials();
  A.eq(lazy.T.status().artHeld, 0, 'a GPU-loss restore drops the painted canvases; they come back as they are drawn');
  const paintedBefore = eager.T.status().assets.length;
  eager.T.restoreMaterials();
  A.eq(eager.T.status().assets.length, paintedBefore, 'flag off: a restore repaints every material, as before');

  // a material whose paint fails at draw time is a failed material, as a failed paint at load was (the pack turns off if it is a base one)
  const broken = loadTextures('', '1');
  await broken.T.ready;
  broken.created.length = 0;
  const realCreate = broken.created.push.bind(broken.created);
  broken.created.push = cv => { cv.getContext = () => { throw new Error('context lost'); }; return realCreate(cv); };
  A.eq(broken.T._dbgArtTouch('floor'), false, 'a paint that throws gives no canvas');
  A.ok(broken.T.status().failed.includes('floor') && broken.T.enabled() === false, '...it is recorded failed, and a lost base material turns the pack off (callers take their fallback, never a half-drawn frame)');
  A.eq(broken.T._dbgArtTouch('floor'), false, 'and it is not retried on every draw');

  const query = loadTextures('?idleRenderer=0', '1');
  await query.T.ready;
  A.eq(query.T.status().lazyArt, false, '?idleRenderer=0 wins over a stored opt-in');

  /* ---- 3. THE A/B MEASURES A RESTED CAMERA (perf-idle-ab's P7 validity, the real phaseValidity) ---- */
  const ab = fs.readFileSync(path.join(ROOT, 'scripts/perf-idle-ab.mjs'), 'utf8');
  A.ok(/rested: c\.cineRested === true/.test(ab), 'the page probe reads whether the cinecam rests');
  A.ok(/cameraMode: s\.camera\.mode, cineRested: s\.camera\.rested,/.test(ab), '...and hands that reading to the phase validity');
  A.ok(/P7: \{[^}]*rested: true/.test(ab) && /rested: w\.rested/.test(ab), 'P7 is valid only on a rested camera');
  const F = await import(require('url').pathToFileURL(path.join(ROOT, 'scripts/lib/proc-footprint.mjs')).href);
  const base = { hasFocus: true, visibilityState: 'visible', cameraMode: 'manual' };
  const want = { name: 'P7', focus: 'focused', visibility: 'visible', camera: 'manual', rested: true };
  const ok = F.phaseValidity(want, [{ ...base, cineRested: true }]);
  const bad = F.phaseValidity(want, [{ ...base, cineRested: false }]);
  A.ok(!(ok.reasons || []).some(r => /rested/.test(r)), 'a rested camera passes P7');
  A.ok((bad.reasons || []).some(r => /rested/.test(r)), 'a never-engaged director (also manual) does not');
  A.ok(/crewSettled: typeof c\.crewSettled === 'number'/.test(ab) && /crewSettled: s\.camera\.crewSettled/.test(ab), 'P7 records how many bodies are settled at both ends of its window');
  A.ok(/name === 'P7'[^\n]*call\(firstTouchWake\)/.test(ab) && /ok: before\.crewSettled > 0 && after\.cineRested !== true && after\.crewSettled === 0/.test(ab),
    '...and after the window checks that one first touch leaves no body settled a frame later');
  A.report('world-idle-renderer');
})().catch(e => { console.error(e); process.exit(1); });
