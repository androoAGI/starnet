'use strict';
/* test/station-layout.test.js — station.layout, the lead's read-only view of the floor (2026-09-28; builds on PR #48
   by @mvanhorn; audit fixes the same day). Runs the REAL page verb (frontend/app/stationcommands.js in a vm) over a
   REAL WorldModel station, the REAL Pipeline compiler and the REAL WorkflowLine readers, through the REAL sidecar tool
   (bridge stub + harness-fact stubs), so what the model reads is what the Workflow panel shows. Held to:
     1. order and hand-offs are COMPILED and keyed by BAY; a brief is the text the agent RECEIVES (brief + HANDS OFF);
     2. status is the panel's readiness: the per-BAY workstation gate, a blocking finding ANYWHERE on the floor, crew
        membership, a loop's dead escalation lane and a belt CYCLE are all read, never guessed;
     3. starts come from the panel's three reads; a PAUSED start (E-STOP, scheduler off, a waiting trigger, a
        disconnected channel) is named with its reason, and an UNREAD fact is said, never read as "nothing";
     4. routing is the plan poster's verdict in RUN NOW's order, CONFIRMED against the router's own plan;
     5. Bays on no line, filter rules, the loop's escalation lane, budgets, today's numbers and last runs are reported;
     6. the overview is compact, `line` gives one line in full, and the answer always fits the budget as valid JSON;
     7. it never mutates the station or posts a plan, and every refusal is an answer. */
const A = require('./_assert.js');
const fs = require('node:fs');
const vm = require('node:vm');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');
const WorldModel = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const WorkflowLine = require('../frontend/app/workflowline.js');
const Sprites = require('../frontend/app/propsprites.js');
const Templates = require('../frontend/app/stationtemplates.js');
const commands = fs.readFileSync(require.resolve('../frontend/app/stationcommands.js'), 'utf8');

const LIVE = { station: true, pending: false, errors: [], hash: 'h1', lastHash: 'k1', refusedHash: null, pendingHash: null, inflight: false, retryPending: false, stale: false };
const BUILD = { nagLabel: c => 'LABEL:' + c, nagWhy: c => (c === 'CYCLE' ? 'WHY:' + c : 'LABEL:' + c) };
const QUIET = { '/api/cron': { enabled: true, halted: false, jobs: [] }, '/api/channels/status': {}, '/api/routing/triggers': { triggers: [] } };
const DEFAULT_BUDGET = { maxHops: 6, maxUsdPerMessage: 2, maxUsdPerDay: null, clamped: [] };
const FACTS = { routed: () => ({ hash: 'h1' }), budget: () => DEFAULT_BUDGET, today: () => ({ lines: [], docks: {} }) };
const liveWorld = over => ({ planStatus: () => Object.assign({}, LIVE, over || {}),
  syncPlan: () => { throw new Error('a read must never recompile or post the plan'); } });
const app = (st, agents) => ({ station: () => st, agents: () => agents || [] });

// boot the page verb in a vm; `server` maps GET urls to answers (an Error = network failure, missing = 404)
function boot(o) {
  o = o || {};
  const acks = [], calls = [];
  const server = o.server || QUIET;
  const context = Object.assign({
    App: o.app, WorldModel, Pipeline, WorkflowLine, Build: BUILD, World: o.world === undefined ? liveWorld() : o.world,
    fetch: async (url, init) => {
      calls.push(String(url) + ' ' + ((init && init.method) || 'GET'));
      if (url === '/api/station/ack') { acks.push(JSON.parse(init.body)); return { ok: true }; }
      const v = server[url];
      if (v instanceof Error) throw v;
      if (v === undefined) return { ok: false, status: 404, json: async () => null };
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(v)) };
    },
    document: { addEventListener: () => {} }, console, setTimeout, clearTimeout, AbortController, Intl
  }, o.globals || {});
  vm.createContext(context);
  const S = vm.runInContext(commands + '\nStationCommands;', context);
  const tools = makeStationTools({ station: { request: async (verb, args) => { await S.run('r' + acks.length, verb, args); return acks.at(-1); } },
    layoutFacts: o.facts === undefined ? FACTS : o.facts, now: o.now === undefined ? () => Date.now() : o.now });
  return { tools, calls };
}
async function layout(o, args, ctx) {
  const b = boot(o);
  const out = await b.tools.layoutTool.run(args || {}, ctx || {});
  return { out, calls: b.calls, r: /^REFUSED/.test(out.content) ? null : JSON.parse(out.content) };
}
// the Creative Studio preset: INBOX -> Draft Bay -> Review Bay -> OUTBOX. crew[i] crews bay i; desks = a workstation each.
/* the fixture is a PLAIN two-step line (no roles, no loop), laid the way the Creative Studio preset laid it before the
   2026-09-28 preset reimagining gave that preset a shelf loop line — so these checks never follow preset copy */
function creative(crew, desks) {
  const st = WorldModel.create(Templates.build('default', WorldModel, Sprites));
  const room = (name, kind, x, y, hall) => {
    A.ok(st.addRoom({ kind, name, rect: { x1: x, y1: y, x2: x + 17, y2: y + 10 } }).ok, 'fixture: room ' + name);
    A.ok(st.placeHallway({ rect: hall }).ok, 'fixture: a hallway to ' + name);
  };
  room('DESIGN STUDIO', 'lab', 0, -14, { x1: 7, y1: -3, x2: 10, y2: -1 });
  room('DRAFT & REVIEW', 'hab', 21, 0, { x1: 18, y1: 4, x2: 20, y2: 6 });
  const put = (t, x) => st.addProp({ t, x: 21 + x, y: 1, w: 2, h: 2 }).id;
  const inbox = put('intake', 1), bays = [put('bay', 5), put('bay', 10)]; put('outbox', 15);
  for (const x of [3, 4, 7, 8, 9, 12, 13, 14]) st.setBelt(21 + x, 2, 'E');
  st.setPropLabel(inbox, 'CREATIVE · DRAFT & REVIEW');
  st.setPropBrief(bays[0], 'Draft a response to the incoming creative brief. Follow its audience, format, tone, and constraints.');
  st.setPropBrief(bays[1], 'Review the incoming draft against the original creative brief. Return the finished version.');
  if (desks) for (const a of new Set(crew.filter(Boolean))) A.ok(st.ensureWorkstation(a).ok, 'fixture: a desk for ' + a);
  // assign in REVERSE prop order: the answer must follow the compiled hand-offs, never the saved array
  for (let i = crew.length - 1; i >= 0; i--) if (crew[i]) A.ok(st.assignPropAgent(bays[i], crew[i]).ok, 'fixture: ' + crew[i] + ' crews bay ' + (i + 1));
  return { st, bays };
}
// a shelf blueprint stamped into a big fresh room (the workflow-line test's helper); bays crewed a1, a2… when `bind`
function stamp(bp, bind, desks) {
  const s = WorldModel.create(); const z = s.rooms()[0].rects[0];
  s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
  let ok = null;
  for (let y = z.y1; y < z.y1 + 25 && !ok; y++) for (let x = z.x1; x < z.x2 + 30 && !ok; x++) { const r = s.stampBlueprint(bp, x, y); if (r.ok) ok = r; }
  A.ok(!!ok, 'fixture: ' + bp + ' stamps');
  let n = 0;
  if (bind) for (const p of s.props()) if (p.t === 'bay') { const aid = 'a' + (++n); s.assignPropAgent(p.id, aid); if (desks) s.ensureWorkstation(aid); }
  return s;
}
// hand-built floor in a fresh lab room: props [{name,t,x,y,w,h,agentId}] + belts [[x,y,dir]] relative to the room corner
function build(props, belts, s) {
  s = s || WorldModel.create();
  const z = s.rooms()[0].rects[0];
  s.addRoom({ kind: 'lab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 50, y2: z.y1 + 30 } });
  const R = s.rooms().find(r => r.kind === 'lab').rects[0], ox = R.x1 + 5, oy = R.y1 + 5, ids = {};
  for (const p of props) {
    const q = Object.assign({}, p, { x: ox + p.x, y: oy + p.y }); delete q.name; delete q.agentId;
    const r = s.addProp(q); A.ok(!!(r && r.id), 'fixture: prop ' + p.t);
    ids[p.name] = r.id;
    if (p.agentId) s.assignPropAgent(r.id, p.agentId);
  }
  for (const [x, y, d] of belts) A.ok(s.setBelt(ox + x, oy + y, d).ok, 'fixture: belt ' + [x, y, d]);
  return { s, ids };
}
const beltRun = (a, b, d) => { const out = []; if (d === 'E') for (let x = a[0]; x <= b[0]; x++) out.push([x, a[1], 'E']);
  if (d === 'W') for (let x = a[0]; x >= b[0]; x--) out.push([x, a[1], 'W']); if (d === 'S') for (let y = a[1]; y <= b[1]; y++) out.push([a[0], y, 'S']); return out; };
const lineKeyOf = st => Pipeline.lineComponents(st.projectGeometry()).find(c => c.bays.length).key;
const refs = list => list.map(x => typeof x === 'string' ? x : x.step + ':' + x.agent);
const detail = async (o, line) => (await layout(o, { line: line || 'draft & review' })).r.line;

(async () => {
  /* ---- 1. the OVERVIEW: compact, confirmed, read-only ---- */
  {
    const { st, bays } = creative(['drafter', 'reviewer'], true);
    const agents = [{ id: 'drafter', name: 'Ada' }, { id: 'reviewer', name: 'Rex' }];
    const before = JSON.stringify(st.serialize());
    const { out, r, calls } = await layout({ app: app(st, agents) });
    A.ok(!!r, 'the layout answers: ' + out.content.slice(0, 160));
    A.eq(JSON.stringify(st.serialize()), before, 'reading the layout never mutates the station');
    A.ok(!calls.some(c => /\/api\/routing (POST|PUT)/.test(c)), 'and never posts a routing plan');
    A.eq(calls.filter(c => / GET$/.test(c)).sort(), ['/api/channels/status GET', '/api/cron GET', '/api/routing/triggers GET'], 'it reads exactly the three facts the Workflow panel reads');
    A.eq(out.summary, '"CREATIVE · DRAFT & REVIEW": READY TO RUN · routing live', 'a one-line floor: the summary names the line and its pill');
    A.eq([r.routing.state, r.routing.confirmed, 'planHash' in r.routing], ['live', true, false], 'routing is live AND confirmed against the router\'s own plan');
    A.eq(r.automation, { scheduler: 'on' }, 'the scheduler state rides along');
    const L = r.lines[0];
    A.eq([L.name, L.status, L.ready], ['CREATIVE · DRAFT & REVIEW', 'READY TO RUN', true], 'name, the panel\'s pill, ready');
    A.ok(/^It runs when you send it a job\. ADA works on it then REX works on it; the result goes to the OUTBOX\.$/.test(L.howItRuns), 'the panel sentence, verbatim: ' + L.howItRuns);
    A.eq(L.steps.map(s => [s.step, s.propId, s.agent, s.room]), [[1, bays[0], 'Ada', 'DRAFT & REVIEW'], [2, bays[1], 'Rex', 'DRAFT & REVIEW']], 'compact steps in compiled order');
    A.ok(L.steps.every(s => !('brief' in s) && !('tools' in s)), 'the overview carries no briefs or tool lists (that is what `line` is for)');
    A.eq(L.budget, { maxHops: 6, maxUsdPerMessage: 2, maxUsdPerDay: null }, 'each line carries the runner\'s effective budget');
    A.eq(L.today, null, 'no numbers are claimed for a line the router reports nothing on');
    A.ok(/call station\.layout with line/.test(r.more), 'the overview says how to get one line in full');
    A.ok(r.rooms.indexOf('DRAFT & REVIEW') >= 0 && r.rooms.length === 3, 'rooms by name, corridors left out: ' + JSON.stringify(r.rooms));
    A.eq(r.workstations.filter(w => w.type === 'desk').map(w => w.agent).sort(), ['Ada', 'Rex'], 'workstations name their holders');
    A.ok(!('loneBays' in r) && !('otherIssues' in r), 'nothing empty is sent');
  }

  /* ---- 2. `line`: one line in FULL — received briefs, compiled hand-offs, tools, gates, filters ---- */
  {
    const { st, bays } = creative(['drafter', 'reviewer'], true);
    const L = await detail({ app: app(st, [{ id: 'drafter', name: 'Ada' }, { id: 'reviewer', name: 'Rex' }]) });
    const [s1, s2] = L.steps;
    A.ok(/^Draft a response/.test(s1.brief) && /^Review the incoming draft/.test(s2.brief), 'each step carries the brief its agent receives');
    A.eq([s1.fedByInbox, s2.fedByInbox], [true, false], 'only step 1 is fed by the Inbox');
    A.eq([refs(s1.getsWorkFrom), refs(s1.sendsTo), refs(s2.getsWorkFrom), refs(s2.sendsTo)], [['INBOX'], ['2:REX'], ['1:ADA'], ['OUTBOX']], 'compiled hand-offs, both ways');
    A.ok(s1.tools.indexOf('computer') >= 0, 'a crewed step lists the tools its run gets there');
    A.eq([L.gates, L.filters, L.issues], [[], [], []], 'no gates, filters or issues on a plain line');
    A.eq(L.steps.map(s => s.propId), bays, 'step order is the Draft Bay then the Review Bay');
  }

  /* ---- 3. ONE agent crewing BOTH Bays (multi-bay): each Bay reports its OWN compiled hand-off ---- */
  {
    const { st, bays } = creative(['writer', 'writer'], true);
    const L = await detail({ app: app(st, [{ id: 'writer', name: 'Wren' }]) });
    const [s1, s2] = L.steps;
    A.eq([s1.fedByInbox, s2.fedByInbox, refs(s1.sendsTo), refs(s2.sendsTo)], [true, false, ['2:WREN'], ['OUTBOX']], 'per-Bay reach and hand-offs');
    const plan = Pipeline.compileRoutingPlan(st.projectGeometry());
    for (const s of L.steps) A.eq(s.fedByInbox, !!plan.reachDock[s.propId], 'fedByInbox is the compiler\'s own dock reach (' + s.propId + ')');
    A.eq(L.steps.map(s => s.propId), bays, 'two Bays, two steps');
  }

  /* ---- 4. HANDS OFF: the brief is what the agent RECEIVES ---- */
  {
    const { st, bays } = creative(['drafter', 'reviewer'], true);
    A.ok(st.setPropHands(bays[0], 'a 200-word draft').ok, 'fixture: a HANDS OFF phrase');
    const L = await detail({ app: app(st, []) });
    A.ok(/\n\nWhen you're done, hand off: a 200-word draft$/.test(L.steps[0].brief), 'the brief includes the HANDS OFF phrase');
    A.ok(/DRAFTER works on it, handing off a 200-word draft/.test(L.howItRuns), 'and the sentence says the hand-off');
  }

  /* ---- 5. the WORKSTATION gate — and it is per BAY (router.stationFor isolates by the dock a run is at) ---- */
  {
    const { st } = creative(['drafter', 'reviewer'], false);
    const L = (await layout({ app: app(st, []) })).r.lines[0];
    A.eq([L.status, L.blocking], ['2 TO FIX · BAY 1 NEEDS A WORKSTATION', ['BAY 1 needs a workstation', 'BAY 2 needs a workstation']], 'no desks: both Bays blocked');
    // one desk-less agent, bays in two rooms, a computer only in the first: the second Bay's run has none
    const s = WorldModel.create(); const z = s.rooms()[0].rects[0]; const X = z.x2 + 1, Y = z.y1;
    s.addRoom({ kind: 'lab', rect: { x1: X, y1: Y, x2: X + 14, y2: Y + 10 } });
    s.addRoom({ kind: 'hab', rect: { x1: X + 15, y1: Y, x2: X + 30, y2: Y + 10 } });
    s.addProp({ t: 'intake', x: X + 1, y: Y + 4, w: 2, h: 2 });
    const a = s.addProp({ t: 'bay', x: X + 6, y: Y + 4, w: 2, h: 2 }).id;
    s.addProp({ t: 'desk', x: X + 2, y: Y + 1, w: 2, h: 1 });
    const b = s.addProp({ t: 'bay', x: X + 20, y: Y + 4, w: 2, h: 2 }).id;
    s.addProp({ t: 'outbox', x: X + 26, y: Y + 4, w: 2, h: 2 });
    s.assignPropAgent(a, 'sam'); s.assignPropAgent(b, 'sam');
    for (const [p, q] of [[X + 3, X + 5], [X + 8, X + 19], [X + 22, X + 25]]) for (let x = p; x <= q; x++) s.setBelt(x, Y + 5, 'E');
    A.eq([s.bayObjects('sam', a).indexOf('computer') >= 0, s.bayObjects('sam', b).indexOf('computer') >= 0], [true, false], 'fixture: only the first Bay\'s room computes');
    const S2 = (await layout({ app: app(s, [{ id: 'sam', name: 'Sam' }]) })).r.lines[0];
    A.ok(!S2.ready && S2.blocking.indexOf('BAY 2 needs a workstation') >= 0, 'the second Bay is blocked, never READY TO RUN: ' + JSON.stringify(S2.blocking));
    A.ok(S2.blocking.indexOf('BAY 1 needs a workstation') < 0, 'and the first is not');
  }

  /* ---- 6. uncrewed Bays: listed, with the floor's own issue labels ---- */
  {
    const { st } = creative([null, null], false);
    const L = (await layout({ app: app(st, []) })).r.lines[0];
    A.ok(L.steps.every(s => s.agent === null && /^no agent yet/.test(s.note)), 'unassigned steps are listed with a note');
    A.eq(L.issues.map(i => [i.code, i.label, i.blocking]), [['UNBOUND_BAY', 'LABEL:UNBOUND_BAY', false], ['UNBOUND_BAY', 'LABEL:UNBOUND_BAY', false]], 'issues carry the floor\'s own label');
    A.ok(/^\d+ TO FIX · BAY 1 NEEDS AN AGENT$/.test(L.status), 'the pill names the missing agent: ' + L.status);
  }

  /* ---- 7. what STARTS the line, and what is PAUSED — never "nothing starts it" over a stopped start ---- */
  {
    const { st } = creative(['drafter', 'reviewer'], true);
    const key = lineKeyOf(st), agents = [{ id: 'drafter', name: 'Ada' }, { id: 'reviewer', name: 'Rex' }];
    const job = { id: 'j1', name: 'Morning run', agentId: 'drafter', runsLine: true, enabled: true, scheduleDisplay: 'daily 09:00', prompt: 'x' };
    const folder = { id: 't1', lineId: key, kind: 'folder', enabled: true, blockedBy: null, config: { path: 'C:\\Drops' } };
    const live = await layout({ app: app(st, agents), server: { '/api/cron': { enabled: true, halted: false, jobs: [job] },
      '/api/channels/status': { telegram: { configured: true, connected: true, agentName: 'Ada' } }, '/api/routing/triggers': { triggers: [folder] } } });
    const L = live.r.lines[0];
    A.eq([L.starts.schedules, L.starts.channels, L.starts.events, L.starts.paused], [['daily 09:00'], ['Telegram'], ['when a file lands in C:\\Drops'], []], 'live starts, nothing paused');
    A.ok(/^Daily 09:00, when a Telegram message arrives or when a file lands in C:\\Drops, ADA works on it/.test(L.howItRuns), 'the sentence leads with the starts');
    const D = await detail({ app: app(st, agents), server: { '/api/cron': { enabled: true, halted: false, jobs: [job] }, '/api/channels/status': { telegram: { configured: true, connected: true, agentName: 'Ada' } }, '/api/routing/triggers': { triggers: [folder] } } });
    A.eq(D.starts.routines.map(x => [x.name, x.agent, x.startsLine]), [['Morning run', 'ADA', true]], 'the detail lists the routines');
    A.ok(D.starts.routines.every(x => !('prompt' in x)), 'routine prompts are never copied into the answer');
    // E-STOP: the scheduler is frozen, the trigger waits, the channel is down — the answer names every one
    const halted = await layout({ app: app(st, agents), server: { '/api/cron': { enabled: true, halted: true, jobs: [job] },
      '/api/channels/status': { telegram: { configured: true, connected: false, agentName: 'Ada' } },
      '/api/routing/triggers': { triggers: [Object.assign({}, folder, { blockedBy: 'automation is stopped (E-STOP) — resume it and this trigger fires again' })] } } });
    const H = halted.r.lines[0];
    A.eq(halted.r.automation, { scheduler: 'stopped by E-STOP' }, 'the answer says the scheduler is stopped by E-STOP');
    A.eq([H.starts.schedules, H.starts.channels, H.starts.events], [[], [], []], 'nothing starts it right now');
    A.eq(H.starts.paused, ['its folder trigger (C:\\Drops) is waiting: automation is stopped (E-STOP) — resume it and this trigger fires again',
      'its routine "Morning run" (daily 09:00) is saved but the scheduler is stopped (E-STOP)', 'its Telegram channel answers as its first step but is not connected'], 'each paused start is named with its reason');
    A.ok(/^Nothing starts it right now \(its folder trigger .*E-STOP.*; its routine "Morning run" .* stopped \(E-STOP\); its Telegram channel .* not connected\); it runs when you send it a job\./.test(H.howItRuns), 'the sentence says why nothing starts it: ' + H.howItRuns);
    A.ok(H.hints.some(h => /^nothing starts it right now: /.test(h)) && !H.hints.some(h => /no schedule, channel, folder or webhook/.test(h)), 'the hint names the pause, never "no schedule"');
    const off = (await layout({ app: app(st, agents), server: { '/api/cron': { enabled: false, halted: false, jobs: [job] }, '/api/channels/status': {}, '/api/routing/triggers': { triggers: [] } } })).r;
    A.eq([off.automation, off.lines[0].starts.paused], [{ scheduler: 'off' }, ['its routine "Morning run" (daily 09:00) is saved but the scheduler is off']], 'a disabled scheduler reads "off"');
  }

  /* ---- 8. an UNREAD fact is said, never turned into "nothing starts it" ---- */
  {
    const { st } = creative(['drafter', 'reviewer'], true);
    const L = (await layout({ app: app(st, []), server: { '/api/cron': new Error('down'), '/api/routing/triggers': { triggers: [] } } })).r.lines[0];
    A.eq(L.startsUnread, ['routines', 'channels'], 'the unread facts are named');
    A.ok(/^What starts it could not be fully read right now \(routines, channels unavailable\); /.test(L.howItRuns), 'the sentence says so: ' + L.howItRuns);
    A.ok(!L.hints.some(h => /^nothing starts it/.test(h)) && L.hints.some(h => /could not be read/.test(h)), 'and so do the hints');
  }

  /* ---- 9. ROUTING: RUN NOW's order, confirmed against the router ---- */
  {
    const { st } = creative(['drafter', 'reviewer'], true);
    const a = app(st, []);
    const at = async (world, facts) => (await layout({ app: a, world, facts })).r.routing;
    const off = await at(liveWorld({ errors: [{ code: 'CYCLE' }], refusedHash: 'k1' }));
    A.ok(off.state === 'off' && /OFF for the whole station/.test(off.note) && /LABEL:CYCLE/.test(off.note), 'a refused floor is off for the whole station: ' + off.note);
    A.eq((await at(liveWorld({ errors: [{ code: 'CYCLE' }], stale: true }))).state, 'unconfirmed', 'a FAILED post of a broken floor is unconfirmed — the router may still run the previous floor');
    A.eq((await at(liveWorld({ errors: [{ code: 'CYCLE' }], inflight: true }))).state, 'unconfirmed', 'so is one still in flight');
    A.eq((await at(liveWorld({ errors: [{ code: 'CYCLE' }] }))).state, 'off', 'blocking errors on the posted floor: off');
    A.eq((await at(liveWorld({ lastHash: null }))).state, 'unknown', 'no answer yet: unknown');
    const pend = await at(liveWorld({ pending: true }));
    A.ok(pend.state === 'live' && pend.pendingEdits && /running the floor as last sent\./.test(pend.note) && /newer edits the router has not received yet/.test(pend.note), 'unsent edits: ' + pend.note);
    const pendOff = await at(liveWorld({ pending: true, errors: [{ code: 'CYCLE' }], refusedHash: 'k1' }));
    A.ok(/they are checked when sent\./.test(pendOff.note) && !/routes by/.test(pendOff.note), 'off + unsent edits never claims work routes: ' + pendOff.note);
    A.eq((await at(null)).state, 'unknown', 'no world: unknown, never live');
    const none = await at(undefined, Object.assign({}, FACTS, { routed: () => null }));
    A.ok(none.state === 'off' && none.confirmed === false && /holds no routing plan/.test(none.note), 'the router holds nothing: OFF, whatever the page believed');
    const other = await at(undefined, Object.assign({}, FACTS, { routed: () => ({ hash: 'someone-else' }) }));
    A.ok(other.state === 'unconfirmed' && /different version of the floor/.test(other.note), 'the router holds another floor: unconfirmed');
    // the SAVED floor is the router's authority: a floor it cannot prove right now is HELD, in its words
    const heldFloor = await at(undefined, Object.assign({}, FACTS, { routed: () => ({ state: 'held', status: 'corrupt', why: 'the saved floor is corrupt; routing is held until it is readable' }) }));
    A.ok(heldFloor.state === 'off' && heldFloor.confirmed === false && /the saved floor is corrupt; routing is held until it is readable/.test(heldFloor.note) && /no line routes work/.test(heldFloor.note),
      'a held saved floor: OFF, with the reason, whatever the page believed — ' + heldFloor.note);
    // the saved floor routes by its topology hash AND an identity (saved-plan-v1:...): the page only knows the hash, so that is what is compared
    const sameBelts = await at(undefined, Object.assign({}, FACTS, { routed: () => ({ state: 'ok', hash: 'h1', identity: 'saved-plan-v1:' + 'a'.repeat(64) }) }));
    A.ok(sameBelts.state === 'live' && sameBelts.confirmed === true && !('planHash' in sameBelts), 'the saved floor holds the same belts the page shows: live and confirmed');
    const otherBelts = await at(undefined, Object.assign({}, FACTS, { routed: () => ({ state: 'ok', hash: 'someone-else', identity: 'saved-plan-v1:' + 'b'.repeat(64) }) }));
    A.ok(otherBelts.state === 'unconfirmed' && /different version of the floor/.test(otherBelts.note), 'the saved floor under other belts than the page shows: unconfirmed');

    /* THE MERGE LAW of the routing readout, over the whole family: the page's account (the poster's verdict, and the edits Build mode holds back
       from it) against the router's (what the SAVED floor holds). Whatever the poster says and whatever the router answers, the readout keeps
       what only the page knows, never claims more than the router confirmed, and never reads a held-back edit as "another open page".
       The router routes by the floor the station SAVED, and the page saves every edit at once while it publishes none of them until Build mode
       closes, so the floor the page last sent is bound to lag the router's while edits are held back (the station-layout e2e, in a real page). */
    const ROUTER = {
      same: { routed: () => ({ state: 'ok', hash: 'h1', identity: 'saved-plan-v1:' + 'a'.repeat(64) }) },
      other: { routed: () => ({ state: 'ok', hash: 'someone-else', identity: 'saved-plan-v1:' + 'b'.repeat(64) }) },
      none: { routed: () => null },
      held: { routed: () => ({ state: 'held', status: 'corrupt', why: 'the saved floor is corrupt; routing is held until it is readable' }) }
    };
    const POSTER = { live: {}, 'live + edits held back': { pending: true }, unconfirmed: { stale: true }, 'unconfirmed + edits held back': { stale: true, pending: true } };
    for (const [posterName, over] of Object.entries(POSTER)) {
      for (const [routerName, facts] of Object.entries(ROUTER)) {
        const out = await at(liveWorld(over), Object.assign({}, FACTS, facts));
        const tag = ' — the poster is ' + posterName + ', the router answers ' + routerName + ': ' + out.note;
        A.eq(!!out.pendingEdits, !!over.pending, 'the readout keeps the page\'s held-back edits and invents none' + tag);
        A.eq(out.confirmed === true, routerName === 'same', 'confirmed only when the router holds the floor the page last sent' + tag);
        if (routerName === 'none' || routerName === 'held') A.eq(out.state, 'off', 'a router with no routable saved floor is OFF, whatever the page believed' + tag);
        if (routerName === 'other') {
          A.eq(out.state, 'unconfirmed', 'a router on another floor than the page last sent is unconfirmed' + tag);
          A.ok(/different version of the floor/.test(out.note) && !/Routing is live|running the floor as last sent/.test(out.note), 'and never says the router runs the floor the page sent' + tag);
        }
        if (over.pending && out.state !== 'off') A.ok(/newer edits/.test(out.note), 'a readout that still says the router routes also says the page holds newer edits' + tag);
      }
    }
  }

  /* ---- 10. one blocking finding ANYWHERE: every line is not ready, and the pill says why ---- */
  {
    const { s } = build(
      [{ name: 'IN', t: 'intake', x: 0, y: 2, w: 2, h: 2 }, { name: 'A', t: 'bay', x: 5, y: 2, w: 2, h: 2, agentId: 'ann' }, { name: 'B', t: 'bay', x: 11, y: 2, w: 2, h: 2, agentId: 'bob' }],
      [].concat(beltRun([2, 2], [4, 2], 'E'), beltRun([7, 2], [10, 2], 'E'), beltRun([13, 3], [13, 4], 'S'), beltRun([13, 5], [5, 5], 'W'), [[4, 5, 'N'], [4, 4, 'N']]));
    const z = s.rooms()[0].rects[0];
    let ok = null; for (let y = z.y1; y < z.y2 && !ok; y++) for (let x = z.x1; x < z.x2 && !ok; x++) { const r = s.stampBlueprint('front_desk', x, y); if (r.ok) ok = r; }
    s.setPropLabel(ok.ids.find(id => s.propById(id).t === 'intake'), 'SUPPORT');
    s.assignPropAgent(ok.ids.map(id => s.propById(id)).find(p => p.t === 'bay').id, 'cat');
    for (const a of ['ann', 'bob', 'cat']) s.ensureWorkstation(a);
    const plan = Pipeline.compileRoutingPlan(s.projectGeometry());
    A.ok(plan.errors.some(e => e.code === 'CHAIN_CYCLE') && !Pipeline.ok(plan), 'fixture: a CHAIN_CYCLE elsewhere makes the router refuse the floor');
    const L = await detail({ app: app(s, []), world: liveWorld({ errors: plan.errors.filter(e => !e.warn), refusedHash: 'k1' }) }, 'SUPPORT');
    A.eq(L.ready, false, 'the healthy-looking line is NOT ready');
    A.ok(/^routing is off for the whole station until this is fixed: LABEL:CHAIN_CYCLE$/.test(L.blocking[0]), 'its first blocker is the station-wide one: ' + JSON.stringify(L.blocking));
    A.ok(/^1 TO FIX · ROUTING IS OFF FOR THE WHOLE STATION/.test(L.status), 'and the pill says so: ' + L.status);
  }

  /* ---- 11. a stray belt CYCLE: the loop is the finding, never "not connected" / "not fed" ---- */
  {
    const s = stamp('front_desk', true, true);
    const z = s.rooms()[0].rects[0];
    s.addRoom({ kind: 'lab', rect: { x1: z.x1, y1: z.y2 + 60, x2: z.x1 + 10, y2: z.y2 + 70 } });
    const lab = s.rooms().find(r => r.kind === 'lab').rects[0], x = lab.x1 + 3, y = lab.y1 + 3;
    for (const [bx, by, d] of [[x, y, 'E'], [x + 1, y, 'S'], [x + 1, y + 1, 'W'], [x, y + 1, 'N']]) A.ok(s.setBelt(bx, by, d).ok, 'fixture: loop belt');
    const r = (await layout({ app: app(s, []), world: liveWorld({ errors: [{ code: 'CYCLE' }], refusedHash: 'k1' }) })).r;
    const L = r.lines[0];
    A.ok(/^\[a belt LOOP on the floor stops all routing: break the circle, then this line can run\]/.test(L.howItRuns), 'the sentence names the loop: ' + L.howItRuns);
    A.ok(!L.blocking.some(b => /not connected/.test(b)), 'no Bay is called "not connected" on a guess: ' + JSON.stringify(L.blocking));
    A.ok(/whole station until this is fixed: WHY:CYCLE/.test(L.blocking[0]), 'the loop is the first blocker, in the panel\'s fix words: ' + L.blocking[0]);
    const cyc = (r.otherIssues || []).find(i => i.code === 'CYCLE');
    A.ok(cyc && cyc.blocking && cyc.fix === 'WHY:CYCLE' && !!cyc.room, 'the CYCLE is reported with its fix and WHERE it is: ' + JSON.stringify(cyc));
    A.ok(!JSON.stringify(r).includes('BAY_NOT_FED'), 'and no bay is shamed BAY_NOT_FED');
  }

  /* ---- 12. the LOOP's ESCALATION lane: conditional, never "then"; dead when the loop has no pass condition ---- */
  {
    const s = stamp('fire_escape', true, true);
    const r = await layout({ app: app(s, []) });
    const L = r.r.lines[0];
    A.ok(/A2 reviews it and sends it back to A1 until it is approved \(3 tries max\); if it is still not approved after 3 tries, A3 fixes what the loop could not; the result goes to the OUTBOX\.$/.test(L.howItRuns), 'escalation is conditional in the sentence: ' + L.howItRuns);
    const D = await detail({ app: app(s, []) }, L.lineId);
    const rev = D.steps.find(x => x.role === 'REVIEWER'), fix = D.steps.find(x => x.role === 'FIXER');
    A.eq(refs(rev.sendsTo), ['OUTBOX'], 'the reviewer hands off to the OUTBOX only — the fixer is not a plain next step');
    A.eq(rev.escalatesTo.map(e => [e.agent, e.runs, e.when]), [['A3', true, 'if it is still not approved after 3 tries']], 'it ESCALATES to the fixer, with the condition');
    A.ok(/^runs only on the LOOP's escalation lane: if it is still not approved after 3 tries$/.test(fix.note) && fix.getsWorkFrom.some(g => g.onEscalation), 'the fixer says when it runs: ' + fix.note);
    A.eq([D.gates[0].escalatesTo.agent, D.gates[0].escalation], ['A3', 'if it is still not approved after 3 tries'], 'the gate names its escalation lane');
    // the same floor with the pass condition cleared: the runner never escalates (chain.js loopDecision needs `when`)
    const loop = s.props().find(p => p.t === 'loop');
    A.ok(s.configureJunction(loop.id, { done: 'E', esc: 'S', maxIter: 3 }).ok, 'fixture: clear the loop\'s pass condition');
    const dead = (await layout({ app: app(s, []) })).r.lines[0];
    A.ok(/sends it back to A1 every pass \(3 tries max\); \[A3 on the escalation lane never runs: the LOOP has no pass condition\]/.test(dead.howItRuns), 'a dead escalation lane is said to be dead: ' + dead.howItRuns);
    A.ok(dead.hints.some(h => /escalation lane never runs: give the LOOP a pass condition/.test(h)), 'and the hint says how to fix it');
    const DD = await detail({ app: app(s, []) }, dead.lineId);
    A.eq(DD.steps.find(x => x.role === 'FIXER').routed, false, 'the dead lane\'s fixer is not routed');
  }

  /* ---- 13. "connect a belt" is never said about a belt that exists ---- */
  {
    const { st } = creative(['drafter', null], true);
    const L = await detail({ app: app(st, []) });
    A.eq(L.steps[0].note, 'its belt leads on to step 2, which has no agent yet', 'the missing piece is an agent, not a belt');
  }

  /* ---- 14. a Bay crewed by an id that is not on the crew still runs — on the station's default identity ---- */
  {
    const { st } = creative(['ghost1', 'reviewer'], true);
    const agents = [{ id: 'reviewer', name: 'Rex' }];
    const r = (await layout({ app: app(st, agents) })).r;
    A.eq(r.lines[0].steps[0].agent, 'ghost1 (not on the crew)', 'the overview flags it');
    A.ok(r.lines[0].hints.some(h => /BAY 1's agent "ghost1" is not on the crew: its runs use the station's default identity/.test(h)), 'and the hints say what that means');
    const D = await detail({ app: app(st, agents) });
    A.eq(D.steps[0].agent, { agentId: 'ghost1', name: 'ghost1', onCrew: false }, 'the detail marks it off the crew');
  }

  /* ---- 15. Bays on NO line are listed — a crewed lone BAY is a complete dock ---- */
  {
    const plain = WorldModel.create(Templates.build('default', WorldModel, Sprites));
    const rect = plain.rooms()[0].rects[0];
    const place = t => { for (let y = rect.y1; y <= rect.y2; y++) for (let x = rect.x1; x <= rect.x2; x++) { const res = plain.addProp({ t, x, y }); if (res && res.ok !== false && res.id) return res.id; } return null; };
    const lone = place('bay'), empty = place('bay');
    A.ok(lone && empty, 'fixture: two beltless bays');
    plain.assignPropAgent(lone, 'ada'); plain.setPropBrief(lone, 'Answer every support ticket.');
    const r = (await layout({ app: app(plain, [{ id: 'ada', name: 'Ada' }]) })).r;
    A.eq(r.lines, [], 'no belts, no lines');
    const l = r.loneBays.find(b => b.propId === lone), e = r.loneBays.find(b => b.propId === empty);
    A.ok(l && l.agent === 'Ada' && /^not on a belt line: work addressed to ADA arrives at this BAY directly/.test(l.note) && l.brief === 'Answer every support ticket.', 'the crewed lone Bay is listed with its brief: ' + JSON.stringify(l));
    A.ok(e && e.agent === null && /^no agent and not on a belt line/.test(e.note), 'the uncrewed one says it does nothing');
  }

  /* ---- 16. FILTER rules: which tagged work goes to which step ---- */
  {
    const s = stamp('triage_desk', true, true);
    const L = await detail({ app: app(s, []) }, lineKeyOf(s));
    const f = L.filters[0], roleAt = rf => (L.steps.find(x => x.propId === rf.propId) || {}).role;
    A.ok(!!f, 'the filter is reported');
    A.eq(f.rules.map(x => [x.tag, x.goesTo.map(roleAt)]), [['code', ['ENGINEER']], ['research', ['RESEARCHER']]], 'each tag names the step it goes to');
    A.eq(f.otherwise.map(roleAt), ['GENERALIST'], 'and the rest takes the default lane');
  }

  /* ---- 17. the harness facts: budget, today's numbers, each Bay's last run ---- */
  {
    const { st, bays } = creative(['drafter', 'reviewer'], true);
    const key = lineKeyOf(st), now = Date.now();
    const facts = { routed: FACTS.routed, budget: id => (id === key ? { maxHops: 4, maxUsdPerMessage: 1, maxUsdPerDay: 5, clamped: [] } : null),
      today: () => ({ lines: [{ lineId: key, runs: 3, shipped: 1, failed: 1, unfinished: 1, tests: 2, usdToday: 0.1234, capUsdPerDay: 5, medianMs: 42000, spendDay: 'utc' }],
        docks: { [bays[0]]: { runId: 'r1', reason: 'budget', failed: true, ts: now - 5 * 60000 } } }) };
    const L = (await layout({ app: app(st, []), facts })).r.lines[0];
    A.eq(L.budget, { maxHops: 4, maxUsdPerMessage: 1, maxUsdPerDay: 5 }, 'the effective budget');
    A.eq(L.today, { runs: 3, shipped: 1, failed: 1, unfinished: 1, tests: 2, usd: 0.1234, capUsdPerDay: 5, medianMs: 42000, day: 'UTC day' }, 'today\'s numbers, with the day they are counted in');
    A.eq(L.steps[0].lastRun, 'budget, 5m ago', 'the Bay\'s last run, as the lamp reads it');
    A.eq((await layout({ app: app(st, []), facts, now: null })).r.lines[0].steps[0].lastRun, 'budget', 'with no injected clock, "how long ago" is never guessed');
    const D = await detail({ app: app(st, []), facts });
    A.eq([D.steps[0].lastRun.result, D.steps[0].lastRun.failed, D.steps[0].lastRun.unfinished, D.steps[0].lastRun.runId], ['budget', false, true, 'r1'], 'the detail carries the run id to look it up, and a spend cap is unfinished, as the line counts it');
    // the detail's flags are the line's counts: a dead run that failed, one a limit ended with its outcome on the dock, and a cut bay, dead to neither
    const dock = async d => (await detail({ app: app(st, []), facts: Object.assign({}, facts, { today: () => ({ lines: [], docks: { [bays[0]]: d } }) }) })).steps[0].lastRun;
    const crash = await dock({ runId: 'r2', reason: 'error', outcome: 'failed', failed: true, ts: now });
    A.eq([crash.result, crash.failed, crash.unfinished], ['error', true, undefined], 'a failed bay is failed, never unfinished');
    const capped = await dock({ runId: 'r3', reason: 'error', outcome: 'out_of_budget', failed: true, ts: now });
    A.eq([capped.failed, capped.unfinished], [false, true], 'the dock\'s own outcome decides, not its word');
    const cut = await dock({ runId: 'r4', reason: 'done', outcome: 'cut_short', failed: false, ts: now });
    A.eq([cut.result, cut.failed, cut.unfinished], ['cut_short', false, undefined], 'a cut bay is neither: the line counts it in neither');
    const r = (await layout({ app: app(st, []), facts: {} })).r;
    A.eq(r.todayUnread, true, 'no stats reader: today is said to be unread, never zero');
    // (runtime audit 2026-10-12) an unreadable shipment history: SHIPPED is unknown (null + why), the other numbers still stand
    const why = 'shipment history unreadable: shipment history could not be read (invalid)';
    const unread = { routed: FACTS.routed, budget: facts.budget,
      today: () => ({ lines: [{ lineId: key, runs: 3, shipped: null, shippedUnknown: why, failed: 1, unfinished: 0, tests: 0, usdToday: 0.5, capUsdPerDay: 5, medianMs: null, spendDay: 'utc' }], docks: {}, shippedUnknown: why }) };
    const U = (await layout({ app: app(st, []), facts: unread })).r.lines[0];
    A.eq(U.today, { runs: 3, shipped: null, failed: 1, unfinished: 0, tests: 0, usd: 0.5, capUsdPerDay: 5, medianMs: null, day: 'UTC day', shippedUnknown: why }, 'an unknown SHIPPED is said with its reason, never as 0, and the rest still counts');
    // (runtime repair 2026-10-12) a LOWER BOUND (some of today's shipped jobs have no saved record) is said, never as the exact count
    const low = { routed: FACTS.routed, budget: facts.budget,
      today: () => ({ lines: [{ lineId: key, runs: 3, shipped: 5000, shippedAtLeast: true, failed: 0, unfinished: 0, tests: 0, usdToday: 0.5, capUsdPerDay: 5, medianMs: null, spendDay: 'utc' }], docks: {}, shippedAtLeast: true }) };
    const Lo = (await layout({ app: app(st, []), facts: low })).r.lines[0];
    A.eq(Lo.today, { runs: 3, shipped: 5000, failed: 0, unfinished: 0, tests: 0, usd: 0.5, capUsdPerDay: 5, medianMs: null, day: 'UTC day', shippedAtLeast: true }, 'a lower-bound SHIPPED reaches the lead marked as at least');
  }

  /* ---- 18. the answer FITS the model's budget, as valid JSON, and names what it left out ---- */
  {
    const { st, bays } = creative(['drafter', 'reviewer'], true);
    A.ok(st.setPropBrief(bays[0], 'Draft carefully. ' + 'x'.repeat(1900)).ok, 'fixture: a long brief');
    const big = await layout({ app: app(st, []) }, { line: 'draft & review' });
    A.eq(big.r.line.steps[0].brief.length, 1917, 'with room to spare, `line` returns the brief in full');
    const tight = await layout({ app: app(st, []) }, { line: 'draft & review' }, { outputMax: 3000 });
    A.ok(tight.out.content.length <= 3000 && tight.r.shortened === true, 'a tight budget is honored: ' + tight.out.content.length);
    const [t1, t2] = tight.r.line.steps;
    A.ok(t1.briefTruncated === true && t1.brief.length <= 601 && /…$/.test(t1.brief), 'the LONG brief is cut first, and says so: ' + t1.brief.length);
    A.ok(!t2.briefTruncated && /^Review the incoming draft/.test(t2.brief), 'a short brief is left whole');
    // a two-line floor squeezed hard: whole lines kept from the front, the rest NAMED
    const s = stamp('front_desk', true, true);
    const z = s.rooms()[0].rects[0];
    s.addRoom({ kind: 'lab', rect: { x1: z.x1, y1: z.y2 + 40, x2: z.x1 + 40, y2: z.y2 + 70 } });
    const lab = s.rooms().find(rm => rm.kind === 'lab').rects[0];
    let ok = null; for (let y = lab.y1; y < lab.y2 && !ok; y++) for (let x = lab.x1; x < lab.x2 && !ok; x++) { const res = s.stampBlueprint('research_line', x, y); if (res.ok) ok = res; }
    A.ok(!!ok, 'fixture: a second line');
    const small = await layout({ app: app(s, []) }, {}, { outputMax: 1200 });
    let parsed = null; try { parsed = JSON.parse(small.out.content); } catch (_) { parsed = null; }
    A.ok(!!parsed && small.out.content.length <= 2000 && parsed.shortened === true, 'even a tiny budget gets valid JSON: ' + small.out.content.length);
    A.ok(!parsed.omittedLines || parsed.omittedLines.every(n => typeof n === 'string' && /\(/.test(n)), 'anything left out is named');
  }

  /* ---- 19. refusals are answers, never an empty success ---- */
  {
    const { st } = creative(['drafter', 'reviewer'], true);
    A.ok(/^REFUSED: the station layout is not ready yet/.test((await layout({ app: { agents: () => [] } })).out.content), 'no station on the page');
    A.ok(/^REFUSED: workflow routing is not loaded/.test((await layout({ app: app(st, []), globals: { Pipeline: undefined } })).out.content), 'no compiler');
    A.ok(/^REFUSED: the workflow line reader is not loaded/.test((await layout({ app: app(st, []), globals: { WorkflowLine: undefined } })).out.content), 'no line reader');
    A.ok(/^REFUSED: .*no station bridge/.test((await makeStationTools({}).layoutTool.run({})).content), 'no bridge');
    const miss = (await layout({ app: app(st, []) }, { line: 'nope' })).out.content;
    A.ok(/^REFUSED: there is no line called "nope"\. Lines: CREATIVE · DRAFT & REVIEW \(/.test(miss), 'an unknown line is refused with the real names: ' + miss);
  }

  /* ---- 20. the capability registry is an allowlist: declared read-only and consent-free ---- */
  {
    const registry = fs.readFileSync(require.resolve('../sidecar/capability/registry.js'), 'utf8');
    A.ok(/capId: 'orchestrator', tool: 'station\.layout', scope: 'read', requiresConsent: false, network: false/.test(registry), 'station.layout is an allowlisted orchestrator read');
    const t = makeStationTools({}).layoutTool;
    A.eq([t.name, t.capability, t.scope, t.requiresConsent], ['station.layout', 'orchestrator', 'read', false], 'and the tool declares the same');
  }

  /* ---- 21. SEND TO (2026-10-10): the lead is told where a line's finished work goes after its OUTBOX ---- */
  {
    const LE = require('../frontend/app/lineedit.js');
    const s = WorldModel.create(); const z = s.rooms()[0].rects[0];
    A.ok(s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } }).ok, 'fixture: a hall for two lines');
    const ids = [];
    for (const [i, nm] of [[0, 'A'], [1, 'B']]) {
      const r = LE.run(s, null, 'newLine', { role: 'WRITER' }, { near: { x: z.x2 + 6, y: z.y1 + 3 + i * 8 } });
      A.ok(r.ok, 'fixture: line ' + nm);
      const c = Pipeline.lineComponents(s.projectGeometry()).find(cc => cc.props.indexOf(r.focus) >= 0);
      const intake = c.intakes[0], outbox = c.outboxes[0], bay = c.bays[0].propId;
      s.setPropLabel(intake, nm); s.assignPropAgent(bay, 'w' + nm); s.ensureWorkstation('w' + nm);
      ids.push({ intake, outbox, bay });
    }
    A.ok(s.setSendTo(ids[0].outbox, ids[1].intake).ok, 'fixture: A sends to B');
    const agents = [{ id: 'wA', name: 'Ann' }, { id: 'wB', name: 'Bo' }];
    const { r } = await layout({ app: app(s, agents) });
    const LA = r.lines.find(l => l.name === 'A'), LB = r.lines.find(l => l.name === 'B');
    A.ok(/Then every job it finishes cleanly is sent on to LINE B \(SEND TO\), whose own crew works it next\.$/.test(LA.howItRuns), 'the overview sentence says where A’s work goes next: ' + LA.howItRuns);
    A.eq([LA.sendsWorkTo, LB.getsWorkFromLines, LB.sendsWorkTo], [['LINE B'], ['LINE A'], undefined], 'and names the lines on each end');
    const D = (await layout({ app: app(s, agents) }, { line: 'A' })).r.line;
    A.ok(D.steps[0].sendsTo.some(x => /^OUTBOX, then on to LINE B \(SEND TO/.test(String(x))), 'one line in full: its last step hands to the OUTBOX, then on to LINE B — ' + JSON.stringify(D.steps[0].sendsTo));
    // (10-11 repair) a SECOND OUTBOX on LINE A that sends nowhere: the lead is never told "every job it finishes cleanly" rides on
    const ox = s.addProp({ t: 'outbox', x: z.x2 + 30, y: z.y1 + 1, w: 2, h: 2 });
    A.ok(ox.ok && s.connectBelt(ids[0].bay, ox.id).ok, 'fixture: LINE A gets a second OUTBOX that sends nowhere');
    const L2 = (await layout({ app: app(s, agents) })).r.lines.find(l => l.name === 'A');
    A.ok(!/every job it finishes/.test(L2.howItRuns) && new RegExp('a job that lands in its OUTBOX ' + ids[0].outbox + '[^;]* is sent on to LINE B').test(L2.howItRuns) && /a job that lands in another of its 2 OUTBOXes stops there\.$/.test(L2.howItRuns),
      'two OUTBOXes, one sending: the sentence names the OUTBOX that sends — ' + L2.howItRuns);
  }

  {
    const LE = require('../frontend/app/lineedit.js'), s = WorldModel.create(), z = s.rooms()[0].rects[0], ids = [];
    s.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 40, y2: z.y1 + 30 } });
    for (const i of [0, 1]) {
      const r = LE.run(s, null, 'newLine', { role: 'WRITER' }, { near: { x: z.x2 + 6, y: z.y1 + 3 + i * 8 } });
      const c = Pipeline.lineComponents(s.projectGeometry()).find(cc => cc.props.indexOf(r.focus) >= 0);
      s.setPropLabel(c.intakes[0], ''); ids.push(c);
    }
    s.setSendTo(ids[0].outboxes[0], ids[1].intakes[0]);
    const result = (await layout({ app: app(s, []) })).r;
    const source = result.lines.find(l => l.sendsWorkTo);
    // final floor lane M25 / R62: the unnamed target is named as the floor's plate and SEND TO chip name it (LINE <its INBOX letter>,
    // worldmodel.lineName), and keeps its actionable lineId — 'an unnamed line' named nothing the Commander could see
    const shown = 'LINE ' + s.lineLetter(ids[1].intakes[0]);
    A.ok(source && source.sendsWorkTo[0] === shown + ' (lineId ' + ids[1].key + ')', 'unlabeled SEND TO says the floor name and keeps its actionable lineId — ' + JSON.stringify(source && source.sendsWorkTo));
    A.ok(source && new RegExp('sent on to ' + shown + ' [(]lineId ').test(source.howItRuns), '…and so does howItRuns — ' + (source && source.howItRuns));
    const target = result.lines.find(l => l.lineId === ids[1].key);
    A.ok(target && target.name === null && target.word === shown, 'each line carries the floor word for it (name stays the INBOX label, null here)');
    const picked = (await layout({ app: app(s, []) }, { line: shown.toLowerCase() })).r;
    A.ok(picked && picked.line && picked.line.lineId === ids[1].key, 'station.layout line="' + shown.toLowerCase() + '" resolves the unnamed line the floor calls ' + shown + ' — ' + JSON.stringify(picked && picked.line && picked.line.lineId));
    // the tool's own summary line names it the same way (repair: its head said '"unnamed line": …' while its word said LINE F)
    const said = (await layout({ app: app(s, []) }, { line: shown.toLowerCase() })).out.summary;
    A.ok(said.indexOf('"' + shown + '": ') === 0, 'the one-line summary names the unnamed line ' + shown + ' — ' + said);
  }

  A.report('station-layout');
})().catch(e => { console.error(e); process.exit(1); });
