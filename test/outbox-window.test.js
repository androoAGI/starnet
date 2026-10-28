/* node test/outbox-window.test.js — the OUTBOX — FINISHED WORK window contract (2026-07-17).

   Andrew-spec accordion, locked so it can't regress: a collapsed row is TITLE + a small description
   that is the agent's REAL recorded output (transcript-derived) + a dim meta line — and NOTHING
   else (no buttons). Clicking the row expands it (one open at a time) into the full breakdown with
   exactly the relevant actions: ↗ OPEN (test in the run's session), ⊕ NEW SESSION (same-agent
   follow-up chat, prefilled composer), and the rate control (collecting the crate). The chute click
   opens THIS window; the digest beat carries a door to it; rating labels name the RUN's agent.

   stationui.js/chat.js are browser-flow (DOM + live stores), not node-loadable — like
   chat-runmeta.test.js we lock the invariants by reading the shipped source. returns.js IS pure and
   node-loadable, so its streamId contract is asserted by execution. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const station = read('frontend/app/windows/outbox.js');   // the OUTBOX window extracted from stationui.js (BUILDERS split)
const chat = read('frontend/app/chat.js');
const rstore = read('frontend/app/returnstore.js');
const app = read('frontend/app/app.js');
const world = read('frontend/app/world.js');
const css = read('frontend/css/app.css');

/* ---- ONE PLACE FOR FINISHED WORK (Andrew 10-02): the list is DELIVERABLES' TO REVIEW section, not a window ----
   Every old door (the digest, chat) still says openTerm('outbox'); the alias lands it in DELIVERABLES. The floor chute does NOT. */
const stationui = read('frontend/app/stationui.js');
A.ok(!/registerWindow\('outbox'/.test(station), 'OUTBOX is no longer a window of its own (no second place for finished work)');
A.ok(/window\.OutboxView = \{[\s\S]{0,80}build: buildOutbox/.test(station), 'the list exports OutboxView.build for DELIVERABLES to mount');
A.ok(/outbox:\s*\{ term: 'deliverables', section: 'review'/.test(stationui), "TERM_ALIAS routes 'outbox' to DELIVERABLES § review");
A.ok(/deliverables:\['DELIVERABLES',[\s\S]{0,600}OutboxView\.build\(host\)/.test(stationui), 'the DELIVERABLES window mounts TO REVIEW above its library');
A.ok(!/\{ id: 'outbox', k: 'outbox'/.test(stationui), 'MY WORK carries no OUTBOX tab');
/* A FLOOR OUTBOX IS ITS OWN LINE'S (Andrew 10-03: "the outbox should only show output of the specific conveyor system, it
   should never link back to deliverables"): the chute click opens the workflow that ships into THAT outbox, never the
   station-wide DELIVERABLES; its pallet stacks only that line's shipped jobs (the INBOX plate's own number). */
const onOb = (app.match(/World\.setOnOutbox\(([^\n]*)\);/) || [])[1] || '';
A.ok(/WorkflowsWindow\.openOutbox\(ob && ob\.id\)/.test(onOb), "the world's OUTBOX click opens its own line (WorkflowsWindow.openOutbox with the clicked prop)");
A.ok(!/openTerm\('outbox'\)|deliverables/i.test(onOb), 'the floor OUTBOX never opens DELIVERABLES / the station-wide TO REVIEW list');
const wfw = read('frontend/app/windows/workflows.js');
const openOb = wfw.slice(wfw.indexOf('function openOutbox'), wfw.indexOf("UI().registerWindow('workflows'"));
A.ok(/x\.outbox === propId \|\| \(x\.outboxes \|\| \[\]\)\.indexOf\(propId\)/.test(openOb), 'openOutbox finds the line by THIS outbox prop');
A.ok(/view: 'line', line: l\.key/.test(openOb) && /line-jobs\?line='/.test(openOb), "openOutbox opens that line and reads only that line's jobs");
A.ok(!/deliverables|navigateWork/i.test(openOb.replace(/^\s*\/\*[\s\S]*?\*\//m, '')), 'openOutbox never routes through DELIVERABLES');
A.ok(/openOutbox,/.test(wfw), 'WorkflowsWindow exports openOutbox');
const pallet = world.slice(world.indexOf('function drawShippedPallet'), world.indexOf('function drawPallet'));
A.ok(/routingPlan\.lineOfProp\[ob\.id\]/.test(pallet) && /lineStats\.byLine\[lid\]/.test(pallet) && /\.shipped/.test(pallet), "each OUTBOX's pallet = its own line's SHIPPED (the line plate's number)");
A.ok(!/shipStats/.test(pallet), 'the pallet never stacks the station-wide shipped count');
A.ok(!/reviewNext\(\)/.test(app), 'app.js no longer drives the one-crate-at-a-time review beat from the chute');

/* ---- collapsed row = title + real-output description + meta, and NOTHING else ---- */
const buildFn = station.slice(station.indexOf('function buildOutbox'), station.indexOf('window.OutboxView = {'));
A.ok(buildFn.length > 200, 'buildOutbox body located');
A.ok(/ReturnStore\.pendingRows/.test(buildFn) || /RS\.pendingRows/.test(buildFn), 'rows come only from the durable pending ledger (ReturnStore.pendingRows)');
const headHtml = /'<div class="ob-head"[\s\S]*?<\/div>'\s*\+\s*'<div class="ob-body"/.exec(buildFn);
A.ok(headHtml, 'the collapsed head block is distinct from the expandable body');
A.ok(!/<button/.test(headHtml[0]), 'the collapsed head carries NO buttons (title + desc + meta only — the Andrew law)');
// the description is the agent's recorded output: the last real assistant turn, [SILENT] excluded
A.ok(/role === 'assistant'/.test(buildFn) && /\[SILENT\]/.test(buildFn), 'the description derives from real assistant output (transcript), [SILENT] excluded');
A.ok(/routine \? \(/.test(buildFn) || /rw\.routine \?/.test(buildFn), 'a routine-fired run is titled by the routine name');
A.ok(/users\[0\]\.content, 64/.test(buildFn), "a non-routine title comes from the transcript's real first ask (never the stored prompt+reply title mush)");

/* ---- expanded breakdown: ONE GRAMMAR with the DELIVERABLES drawer (2026-08-13) ----
   The drawer speaks the library's exact language — what you asked for, what came back, the files —
   so OUTBOX reads as the "awaiting your verdict" door into the same system, not a second one. */
A.ok(/ob-sec">WHAT YOU ASKED FOR</.test(buildFn), 'expanded body shows WHAT YOU ASKED FOR (the library grammar, not THE ASK)');
A.ok(/ob-sec">WHAT CAME BACK</.test(buildFn), 'expanded body shows WHAT CAME BACK (the library grammar, not WHAT THE AGENT DID)');
/* ---- FILES: the library's own index and seams, never a second bookkeeping ---- */
A.ok(/api\/deliverables/.test(buildFn), 'files come from ONE fetch of the library index (/api/deliverables), folded by runId');
A.ok(/class="dlv-files"/.test(buildFn), 'files render with the library’s own markup (dlv-files — the two drawers share one look)');
A.ok(/DLV\.handleOpenClick\(ev, dlvRows, openState/.test(buildFn), 'OPEN rides Deliverables.handleOpenClick (the one desktop-confirm/safe-preview seam)');
A.ok(/d && d\.files\.length/.test(buildFn), 'a run the index doesn’t know shows NO files section (never invented)');
// The library door now navigates with a return route instead of stacking another window.
// Invoke the actual empty-Outbox handlers; the invariant is the destination, not an opener's name.
const navCalls = [], doorClicks = {};
const emptyBody = {
  innerHTML: '',
  querySelector: selector => selector === '#ob-list' ? { innerHTML: '' } : {
    addEventListener: (event, fn) => { doorClicks[selector] = fn; }
  }
};
// This builder contains quoted regex literals; use its registration boundary rather
// than fnBody's deliberately limited brace scanner.
vm.runInNewContext('const mounted = new Set();\n' + buildFn + '\nbuildOutbox(body);', {
  body: emptyBody, ReturnStore: { pendingRows: () => [] }, H: { navigateWork: (...args) => navCalls.push(args) }
});
A.eq(emptyBody.hidden, true, 'nothing waiting = the TO REVIEW section steps aside (the library below is always there)');
doorClicks['#ob-logbook']();
A.eq(navCalls, [['deliverables', 'logbook']],
  'the run-history door returns to DELIVERABLES (where TO REVIEW lives), never a dead OUTBOX window');
A.ok(!('#ob-library' in doorClicks), 'no DELIVERABLES door duplicating the MY WORK tab');
A.ok(/class="consent-btn ob-open">↗ OPEN/.test(buildFn), 'action: ↗ OPEN (test it in the session)');
A.ok(/class="consent-btn ob-fork">⊕ NEW SESSION/.test(buildFn), 'action: ⊕ NEW SESSION (expand on this)');
A.ok(/closeOthers\(/.test(buildFn), 'accordion: opening a row closes the others');
A.ok(/RS\.openWork\s*\?\s*await RS\.openWork\(rw\)/.test(buildFn) || /await RS\.openWork\(rw\)/.test(buildFn), '↗ OPEN rides ReturnStore.openWork (the one transcript-session join)');
A.ok(/w\.create\(\('follow-up: [\s\S]{0,120}agentId:\s*rw\.agentId/.test(buildFn), '⊕ NEW SESSION binds the follow-up chat to the RUN’s agent');
A.ok(/App\.openWorkstream\(ws\.id\)/.test(buildFn), '⊕ NEW SESSION opens the fresh session');
A.ok(/Chat\.prefill\(/.test(buildFn), '⊕ NEW SESSION prefills the composer naming the task (no fabricated turns)');
A.ok(/✓ mark reviewed/.test(buildFn), 'an already-judged run still offers a plain mark-reviewed (a crate can never wedge)');
// honest failure copy — a missing/unreachable transcript never renders as a silent blank
A.ok(/no transcript recorded for this run/.test(buildFn), 'a run with no transcript says so honestly');
A.ok(/wasn’t reachable|couldn’t read the result/.test(buildFn), 'a FAILED transcript fetch is distinguished from an empty one');

/* ---- rating: the label names the RUN's agent, and awayRate guards double-judging ---- */
A.ok(/App\.agentName\(agentId \|\| 'agent'\)/.test(chat), "workRateControl labels the verdict with the RUN's agent (App.agentName(agentId)), never whoever the active chat is bound to");
const awayRate = chat.slice(chat.indexOf('function awayRate'), chat.indexOf('function awayRate') + 600);
A.ok(/workRatedRuns\.has\(rw\.runId\)/.test(awayRate), 'awayRate refuses to re-mount for an already-judged run (returns false → caller collects)');
A.ok(/\bawayRate\b/.test(chat.slice(chat.lastIndexOf('return {'))), 'Chat exports awayRate (the OUTBOX window mounts the real XP-law control)');

/* ---- store contract: ledger copies, openWork joins, open window stays fresh ---- */
A.ok(/function pendingRows\(\)[^\n]*\n?.*Object\.assign\(\{\}, r\)/.test(rstore) || /pendingRows[\s\S]{0,200}Object\.assign\(\{\}, r\)/.test(rstore), 'pendingRows hands out COPIES (a render can never mutate durable state)');
A.ok(/revive:\s*true/.test(rstore), 'openWork adopt rides revive:true (the tombstone lane’s ONE deliberate revive path)');
A.ok(/OutboxView\.refresh\(\)/.test(rstore), 'a digest fold refreshes every mounted TO REVIEW section (no stale list)');
A.ok(/\bpendingRows\b/.test(rstore.slice(rstore.lastIndexOf('return {'))), 'ReturnStore exports pendingRows');

/* ---- world: the chute is always clickable while placed; hover names the click ---- */
const outboxAtFn = world.slice(world.indexOf('function outboxAt'), world.indexOf('function outboxAt') + 700);
A.ok(!/returnCrates\(\)\s*<=\s*0/.test(outboxAtFn), 'outboxAt has NO crate-count gate (the window has honest content in every state — mirrors the MISSION BOARD)');
A.ok(/function drawOutboxHoverTag/.test(world) && /drawOutboxHoverTag\(now\)/.test(world), 'the hover-glance tag draws each frame while a chute is hovered');
A.ok(/TO REVIEW — CLICK/.test(world) && /THIS LINE’S RESULTS — CLICK/.test(world) && /NOT ON A WORKFLOW/.test(world), 'hover copy names the click in every state (its line’s crates pending / its line’s results / on no line)');
const hoverFn = world.slice(world.indexOf('function drawOutboxHoverTag'), world.indexOf('function drawBeltHoverTag'));
A.ok(/outboxCrateMap\(\)\[hoverOutbox\.id\]/.test(hoverFn) && !/returnCrates\(\)/.test(hoverFn), 'the hover count is THIS chute’s line crates, never the station-wide pending count');
// each chute stacks only its OWN line's waiting results (a pending row proven a line job's by its stream); the rest wait in DELIVERABLES
const crateFn = world.slice(world.indexOf('function outboxCrateMap'), world.indexOf('function pollLineJobStreams'));
A.ok(/lineJobStream\[r\.streamId\]/.test(crateFn) && /routingPlan\.lineOfProp\[p\.id\]/.test(crateFn), 'per-outbox crates join pending rows to a line through the line-job stream record');
A.ok(/setOutboxCrates\(outboxCrateMap\(\)\)/.test(world) && !/setOutboxCrates\(returnCrates\(\)\)/.test(world), 'the chute sprites get the per-outbox map, never the station-wide count');
const ps = read('frontend/app/propsprites.js');
A.ok(/outboxCrates\[f\.id\]/.test(ps), 'PropSprites reads each outbox’s own crate count by prop id');
// …and every finished workflow job is ALSO filed in DELIVERABLES (Andrew 10-03): one library row per job, text-only results included
const sidecar = readSidecarSource();
const dRows = sidecar.slice(sidecar.indexOf('async function deliverableRows'), sidecar.indexOf('function deliverableProjectFacet'));
A.ok(/lineJobs\.jobs/.test(dRows) && /id: 'line:' \+ job\.id/.test(dRows) && /kind: 'workflow'/.test(dRows) && /output: output/.test(dRows), 'DELIVERABLES lists every finished workflow job as its own row with the delivered output');
A.ok(/jobOfRun\.get\(run\.runId\)/.test(dRows), 'a workflow stage’s files fold into its job row (never double-listed as loose run rows)');
const dlv = read('frontend/app/deliverables.js');
A.ok(/r\.output/.test(dlv) && /data-act="workflow"/.test(dlv) && /dataset\.act === 'workflow'/.test(dlv), 'the DELIVERABLES drawer shows a job’s output and opens it in WORKFLOWS');

/* ---- digest beat: the always-available door ---- */
const digestFn = chat.slice(chat.indexOf('function awayDigest'), chat.indexOf('function awayReview'));
A.ok(/openTerm\('outbox'\)/.test(digestFn), 'the while-you-were-away digest carries the ▸ open the OUTBOX door (works with no prop placed)');

/* ---- CSS layer exists (the round-2 cram regression stays dead) ---- */
A.ok(/\.ob-head \{/.test(css) && /\.ob-desc \{/.test(css) && /\.ob-acts \{/.test(css), 'the ob-* layout layer ships in css/app.css');
A.ok(/-webkit-line-clamp:\s*2/.test(css), 'collapsed descriptions clamp to 2 lines');

/* ---- the pure engine: digest rows carry the transcript join (executed, not grepped) ---- */
const R = require('../frontend/app/returns.js');
let s = R.heartbeat(R.hydrate(null), 1000);
const rows = R.unattended(s, [{ runId: 'r1', agentId: 'a1', reason: 'done', ts: 2000, title: 't', streamId: 'cron-r1' }], 1000);
A.eq(rows.length, 1, 'engine digests the unattended run');
A.eq(rows[0].streamId, 'cron-r1', 'the digest row carries streamId (the crate→transcript join the whole window stands on)');
s = R.fold(s, rows);
A.eq(R.hydrate(JSON.parse(JSON.stringify(s))).pending[0].streamId, 'cron-r1', 'streamId SURVIVES the persist/hydrate round trip (a reload cannot orphan a crate from its transcript)');

/* ---- M28 (2026-10-12): TO REVIEW's FROM / SENT ON TO names the line the way the floor does ----
   Job records carry from/sentTo as { line, jobId, name } — never lineId — so an unnamed sending line read FROM ANOTHER LINE while
   its plate said LINE C. Repair pass (2026-10-12): the name comes from ONE resolver, the floor's rule (World.lineName — its first
   NAMED INBOX, else LINE <its first INBOX's letter>), not a private copy that took intakes[0]'s label and recompiled the whole
   station per mention; and the ASK block's "handed on from …" reads the same record, never the frame's empty name ('another
   line'). The REAL helpers (outbox.js handoffLineWord over world.js lineNameOf), against a real station and its compiled plan. */
{
  const WM = require('../frontend/app/worldmodel.js'), P = require('../frontend/app/pipeline.js'), LE = require('../frontend/app/lineedit.js');
  const st = WM.create(); st.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 90, y2: 40 } });
  const a = LE.placeBlueprint(st, 'research_line', { x: 40, y: 4 }), b = LE.placeBlueprint(st, 'research_line', { x: 40, y: 22 });
  A.ok(a.ok && b.ok, 'fixture: two lines');
  const ia = a.ids.find(id => st.propById(id).t === 'intake'), ib = b.ids.find(id => st.propById(id).t === 'intake');
  st.setPropLabel(ib, 'Editing');
  // a second INBOX on line A, belted into its BAY — the line now has two INBOXes
  const bayA = a.ids.find(id => st.propById(id).t === 'bay'), i1 = st.propById(ia);
  let i2 = null;
  for (const [dx, dy] of [[-6, 0], [0, -6], [0, 6], [-6, 4], [-6, -4]]) {
    const r = st.addProp({ t: 'intake', x: i1.x + dx, y: i1.y + dy, w: i1.w || 2, h: i1.h || 2 });
    if (!r.ok) continue;
    const c = st.connectBelt(r.id, bayA); if (c && c.ok) { i2 = r.id; break; }
    st.removeProp(r.id);
  }
  const keyOf = iid => P.lineComponents(st.projectGeometry()).find(c => c.intakes.includes(iid)).key;
  // (merge 10-12: ONE helper — outbox.js lineOfEnd, the floor lane's rule: the floor's CURRENT name for the line (worldmodel
  // lineName — its first NAMED INBOX, else LINE <its first INBOX's letter>), the record's own name only when the line is gone.
  // The agent lane's second helper (record name first) was folded into it: a renamed line reads as its plate does.)
  const at = station.indexOf('  function lineOfEnd(e) {'), end = station.indexOf('\n  }\n', at) + 4;
  A.ok(at > 0 && end > at, 'the provenance words come from one helper');
  const ctx = vm.createContext({ App: { station: () => st }, Pipeline: P });
  vm.runInContext(station.slice(at, end) + '; globalThis.word = lineOfEnd;', ctx);
  const lineA = keyOf(ia), firstA = P.lineComponents(st.projectGeometry()).find(c => c.key === lineA).intakes[0];
  A.eq(ctx.word({ line: lineA, jobId: 'j', name: '' }), 'LINE ' + st.lineLetter(firstA), 'an unnamed sending line reads by its first INBOX\'s letter (the floor plate\'s word), never ANOTHER LINE');
  A.eq(ctx.word({ line: keyOf(ib), jobId: 'j', name: '' }), 'LINE EDITING', 'a named line with no recorded name reads by its INBOX label');
  A.eq(ctx.word({ line: lineA, jobId: 'j', name: 'Research' }), 'LINE ' + st.lineLetter(firstA), 'the floor\'s current name wins over a name the record kept (a renamed line reads as its plate does)');
  A.eq(ctx.word({ line: 'p-gone', jobId: 'j', name: '' }), 'ANOTHER LINE', 'a line no longer on the floor is ANOTHER LINE');
  A.eq(ctx.word({ line: 'p-gone', jobId: 'j', name: 'Research' }), 'LINE RESEARCH', '…unless its record kept a name');
  // the review's probe: two INBOXes, the one that is NOT the first is named — the floor says LINE RESEARCH, so must TO REVIEW
  A.ok(i2 && P.lineComponents(st.projectGeometry()).find(c => c.key === lineA).intakes.length === 2, 'fixture: line A has two INBOXes');
  const other = firstA === ia ? i2 : ia;
  st.setPropLabel(other, 'Research');
  A.eq(ctx.word({ line: lineA, jobId: 'j', name: '' }), 'LINE RESEARCH', 'a line is named by its first NAMED INBOX, as the floor names it (not intakes[0]\'s label or letter)');
  A.eq(st.lineName(lineA), 'LINE RESEARCH', '…the same word the station gives every other surface');
  A.ok(/word = e => lineOfEnd\(e\)/.test(station) && !/handoffLineWord/.test(station) && !/e && e\.lineId \?/.test(station), 'TO REVIEW reads the record\'s line key through the one helper, never the lineId records never carry');
  A.ok(!/lineComponents|projectGeometry/.test(station.slice(at, end)), 'the helper compiles nothing per mention (the floor already holds its lines)');
  // the ASK block's "handed on from …" is built AFTER the job record is read, from the record's FROM end
  const rr = station.slice(station.indexOf('let fromWord = hand && hand.sent'), station.indexOf('ask.textContent = askFull'));
  A.ok(/if \(sj && sj\.from && hand && hand\.sent\) fromWord = word\(sj\.from\);/.test(rr) && /'\\n\\n— handed on from ' \+ fromWord \+ ':/.test(rr),
    'the ASK block names the sending line from the job record (the frame\'s own empty name only when there is no record)');
  A.ok(!/handed on from ' \+ Pipeline\.lineWord\(hand\.sent\.fromName/.test(station), '…never straight from the frame\'s name');
  // the hand-off crate riding into the receiving INBOX is titled by the floor's word too (world.js intakeMessage)
  A.ok(/if \(p\.kind === 'handoff' && p\.fromLine\) \{ const nm = lineNameOf\(p\.fromLine\); if \(nm\) p\.preview = \('FROM ' \+ nm\)\.slice\(0, 40\); \}/.test(world),
    'a hand-off crate is re-titled FROM <the floor\'s name> before LINE WATCH keeps its title');
  const reg = world.indexOf("U.bus.on('workitem.placed', p => intakeMessage(p));"), lw = world.indexOf("for (const n of ['workitem.placed'");
  A.ok(reg > 0 && lw > reg, '…intakeMessage hears workitem.placed before LINE WATCH does');
}
A.report('outbox-window.test');
