/* node test/world-await-tags.test.js — the floor's waiting and run tags say what is true and stay readable (live walk 2026-10-14).
     · the AWAITING plate read "AWAITING APPROVAL" while the agent waited on a QUESTION (brief.ask) — it now says it waits on
       your answer; an approval still reads AWAITING APPROVAL;
     · after STOP the hero's plate lingered until the 11-minute TTL or the next snapshot: the hero's last live run ending
       now clears it (a stopped stream loses its run.end, but World.dropRun still runs);
     · RUN clocks at neighbouring desks ran together into one string ("RUN 2:54 RUN 2:14"): a tag that would touch one
       already drawn this frame steps up a line. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs'), path = require('path'), A = require('./_assert');
const src = fs.readFileSync(path.join(__dirname, '../frontend/app/world.js'), 'utf8');
const fn = n => A.fnBody(src, 'function ' + n + '(');

// ── 1. question vs approval, hero and crew ──
{
  const tags = [];
  const ctx = { save() {}, restore() {}, measureText() { return { width: 20 }; }, fillRect() {}, fillText: t => tags.push(t) };
  const mk = awaitPrompt => Function('ctx', 'crewIsAwaiting', 'awaitPrompt',
    `const AWAIT_FONT='test',agent={unplaced:false},bodyPosX=b=>b.px,bodyPosY=b=>b.py,rposX=()=>0,rposY=()=>0;${fn('drawAwaitTag')};return drawAwaitTag;`)(ctx, b => !!(b.pendingApprovals && b.pendingApprovals.size), awaitPrompt);
  mk({ promptId: 'q', question: true })(1000);
  mk({ promptId: 'a' })(1000);
  A.eq(tags, ['AWAITING YOUR ANSWER', 'AWAITING APPROVAL'], 'the hero\'s plate says whether it waits on an answer or an approval');
  tags.length = 0;
  const draw = mk(null);
  draw(1000, { px: 1, py: 1, pendingApprovals: new Map([['q', { question: true }]]) });
  draw(1000, { px: 1, py: 1, pendingApprovals: new Map([['q', { question: true }], ['a', {}]]) });
  A.eq(tags, ['AWAITING YOUR ANSWER', 'AWAITING APPROVAL'], 'a crew body waiting only on questions says answer; any approval among its waits says approval');
  A.ok(/enterAwait\(\{ promptId: p\.promptId \|\| '', agentId: p\.agentId \|\| \(agent && agent\.id\), question: p\.tool === 'brief\.ask' \}\)/.test(src), 'the live prompt carries whether it is a question to the hero');
  A.ok(/b\.pendingApprovals\.set\(p\.promptId, \{ at: now, runId: p\.runId \|\| null, question: p\.tool === 'brief\.ask' \}\)/.test(src), '...and to a crew body');
  A.ok(/if \(mine\) enterAwait\(\{ promptId: mine\.promptId \|\| '', agentId: mine\.agentId \|\| \(agent && agent\.id\), question: mine\.tool === 'brief\.ask' \}\)/.test(src), '...and a reconnect snapshot does too');
  const idx = readSidecarSource();
  A.ok(/const row = \{ runId: runId, agentId: \(ask && ask\.workerAgentId\) \|\| agentId, promptId: promptId \};\s*if \(ask && ask\.tool\) row\.tool = ask\.tool;/.test(idx), 'the snapshot names what each open ask is (additive), so a reloaded floor words it right');
}

// ── 2. the hero's plate clears when its last live run ends (STOP's lost run.end included) ──
{
  const rt = Function(`let fnow=0,cleared=0;const performance={now:()=>0},recentRunEnds=new Map(),RECENT_END_TTL_MS=35000,liveRunsByAgent=new Map(),agent={id:'agent'};let awaitPrompt={promptId:'p'};function clearAwait(){cleared++;awaitPrompt=null;}
    ${fn('noteRunStart')}${fn('noteRunEnd')}return {start:noteRunStart,end:noteRunEnd,cleared:()=>cleared,arm:()=>{awaitPrompt={promptId:'p'};}};`)();
  rt.start('agent', 'r1'); rt.start('agent', 'r2');
  rt.end('agent', 'r1');
  A.eq(rt.cleared(), 0, 'another live run of the hero may still be the one waiting: the plate stays');
  rt.end('agent', 'r2');
  A.eq(rt.cleared(), 1, 'the hero\'s last live run ended: nothing can still wait on you for it, the plate clears');
  rt.arm(); rt.start('crew1', 'c1'); rt.end('crew1', 'c1');
  A.eq(rt.cleared(), 1, 'a crewmate\'s run ending never clears the hero\'s plate');
}

// ── 3. neighbouring RUN clocks never run together ──
{
  const drawn = [];
  const ctx = { save() {}, restore() {}, font: '', measureText: t => ({ width: t.length * 4 }), fillText: (t, x, y) => drawn.push({ t, x, y }), set textAlign(v) {}, set textBaseline(v) {}, set shadowBlur(v) {}, set shadowColor(v) {}, set fillStyle(v) {}, set globalAlpha(v) {} };
  const bodies = { a: { agentId: 'a', working: true }, b: { agentId: 'b', working: true }, c: { agentId: 'c', working: true } };
  // desks a and b sit side by side (2 tiles each); c is far away on the same row
  const desks = { a: { x: 2, y: 3, w: 2 }, b: { x: 4, y: 3, w: 2 }, c: { x: 20, y: 3, w: 2 } };
  const draw = Function('ctx', 'bodies', 'desks', `const T=16,RUN_FONT='7px x',linkStaleDim=false,agent=null,desk=null,CrewClock=undefined,
    runStartByAgent=new Map([['a',0],['b',0],['c',0]]),bodyForAgent=id=>bodies[id],crewIsAwaiting=()=>false,deskPropFor=id=>desks[id];
    ${fn('clearOfTags')}${fn('drawRunClocks')};return drawRunClocks;`)(ctx, bodies, desks);
  draw(154000);
  A.eq(drawn.length, 3, 'every working desk still gets its clock');
  const box = d => ({ x0: d.x, x1: d.x + d.t.length * 4, y: d.y });
  const [a, b, c] = drawn.map(box);
  const touch = (p, q) => Math.abs(p.y - q.y) < 9 && p.x0 < q.x1 + 4 && q.x0 < p.x1 + 4;
  A.ok(!touch(a, b), 'the two neighbouring clocks no longer touch: ' + JSON.stringify(drawn));
  A.eq(drawn[0].y, 3 * 16 + 3, 'the first clock keeps its place at its desk\'s crown');
  A.eq(c.y, a.y, 'a far-away desk\'s clock is not moved');
}

// ── 4. the station's own side prompts never light the hero as working (and so never hold it "working" after STOP) ──
// Live (2026-10-14, isolated station): opening a new session fired the INTERNAL session-recommendations prompt; the 30 s
// snapshot reconcile read that run as an orphan live run of NOVA, sat it at its desk WORKING with a RUN clock, and the
// leaked refcount then kept NOVA working past a STOP of its real run until the next reconcile.
{
  const norm = Function(`${fn('normalizeSnapshot')}return normalizeSnapshot;`)();
  const out = norm({ ts: 10000, runs: [
    { runId: 'side', agentId: 'agent', startedAt: 9000, internal: true },
    { runId: 'real', agentId: 'agent', startedAt: 8000 }
  ], prompts: [] });
  A.eq(out.activeRuns.map(r => r.runId), ['real'], 'a self-talk run (internal) is not a live run of the agent; the real one is');
}

A.report('world-await-tags.test');
