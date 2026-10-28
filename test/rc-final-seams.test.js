/* node test/rc-final-seams.test.js — the open RC-walk seams (qa/evidence/rc-walk-1013/FINDINGS.md), each locked where the
   Commander reads it. The panels' OWN functions are sliced out of the shipped files (A.fnBody) and run in a vm over stubs, or
   the UMD module is required directly:
     #30  the Workflow panel's ✓ DELIVERED says when the job was NOT counted in SHIPPED (the server's per-job answer), and a
          settled job re-reads TODAY at once, so the card and the plate agree
     #44  "Delegated to RESEARCH, COPY and COPY" — each agent is named once in the card header
     #48  DELIVERABLES: a summary reads as plain words (no **marks**), WHAT CAME BACK is rendered, and an unnamed file carries
          no "the agent did not name this one" apology
     ---  only the General home reads "General" in the session rail; an untitled other session is a "New session"
     #29  a toast never covers an open dock menu: the rack seats above a menu that reaches into its column
     #21  the world RUN x:xx tag reads CREW's clock (approval waits excluded)
     #41  the lead hands over the deliverable as a thing to OPEN, never a list of file names or an offer to fetch it
   The live proof of each is in the lane report (isolated station, scripted model). */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const rd = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const strip = h => String(h).replace(/<[^>]+>/g, '');
function load(src, headers, globals, extra) {
  const body = headers.map(h => { const b = A.fnBody(src, h); A.ok(b.length > 20 && b.length < 20000, 'sliced ' + h + ' (' + b.length + ' chars)'); return b; }).join('\n');
  const names = headers.map(h => /function (\w+)\(/.exec(h)[1]);
  const ctx = vm.createContext(Object.assign({ esc, console, JSON, Math, Date, String, Object, Array, Promise, Number, isFinite }, globals));
  return vm.runInContext((extra || '') + '\n' + body + '\n({ ' + names.join(', ') + ' })', ctx);
}

/* ---------- #30: DELIVERED and SHIPPED say one thing ---------- */
{
  const panel = rd('frontend/app/workflowpanel.js'), build = rd('frontend/app/build.js');
  const tipLine = (/\n  const NOT_SHIPPED_RULE = [^\n]*\n/.exec(panel) || [''])[0];
  A.ok(/tool succeeded or a file was saved/.test(tipLine), 'the not-shipped tip states the SHIPPED rule');
  const fns = load(panel, ['function jobResultHTML(mine, f)', 'function loopNotes(text)', 'function notShippedNote(mine)'], {
    prop: () => null, nameOf: a => String(a).toUpperCase(), stepText: () => 'reply', stepOut: {}, H: { sampleHTML: () => '', plan: () => ({}) }, WL: () => null,
    S: {}, exampleKept: () => false, notRightHTML: () => '', Pipeline: undefined, runEnd: r => r
  }, "const LOOP_NOTE = /^\\[LOOP — (exhausted|escalated): (\\d+) pass(?:es)? round the gate[^\\n]*\\]\\s*/gm;" + tipLine);
  const runs = [{ runId: 'r1', agentId: 'agent', reason: 'done', usd: 0.04 }];
  const card = (shipped, shippedWhy) => fns.jobResultHTML({ view: { ok: true, usd: 0.0405 }, runs, output: '**TEASER 1:** hi', stamp: 1, folded: true, shipped, shippedWhy }, null);
  const talk = card(false, 'no-proven-work');
  A.ok(/✓ DELIVERED · 1 step · \$0\.0405 · waiting in DELIVERABLES › TO REVIEW · a text answer: not counted in SHIPPED/.test(strip(talk)), 'a job the server PROVED did no tool work says "a text answer" beside DELIVERED: ' + strip(talk).slice(0, 120));
  A.ok(/class="wf-noship" data-tip="NOT IN SHIPPED/.test(talk) && /No step of this job had a tool succeed or saved a file/.test(talk), '…with the SHIPPED rule and the proven reason as its tip');
  // (review of #30) shipped:false alone proves only "no receipt": an empty final text or an unmatched run row is not a text answer
  const bare = card(false, null);
  A.ok(/· waiting in DELIVERABLES › TO REVIEW · not counted in SHIPPED/.test(strip(bare)) && !/text answer/.test(strip(bare)), 'no proven reason: the card says only "not counted in SHIPPED": ' + strip(bare).slice(0, 120));
  A.ok(/The station holds no SHIPPED receipt for this job/.test(bare) && !/answered in text/.test(bare), '…and its tip claims no reason the server did not send');
  A.ok(/ · <span class="wf-job-where"><button[^>]*data-to-review[^>]*>waiting in DELIVERABLES › TO REVIEW<\/button> · <span class="wf-noship"[^>]*>[^<]*not counted in SHIPPED<\/span><\/span><\/div>/.test(talk), '(org D9 polish) where the job waits and the SHIPPED note wrap as one unit, never one stranded fragment');
  // (org P14) the folded job's place is a door into DELIVERABLES › TO REVIEW — never "in the OUTBOX" — and only while it still waits
  A.ok(/<button type="button" class="wf-link" data-to-review[^>]*>waiting in DELIVERABLES › TO REVIEW<\/button>/.test(talk) && !/in the OUTBOX/.test(strip(talk)), 'the folded job names where it waits, as a door: ' + strip(talk).slice(0, 120));
  {
    const led = load(panel, ['function jobResultHTML(mine, f)', 'function loopNotes(text)', 'function notShippedNote(mine)'], {
      prop: () => null, nameOf: a => String(a).toUpperCase(), stepText: () => 'reply', stepOut: {}, H: { sampleHTML: () => '', plan: () => ({}) }, WL: () => null,
      S: {}, exampleKept: () => false, notRightHTML: () => '', Pipeline: undefined, runEnd: r => r, ReturnStore: { pendingRows: () => [{ runId: 'r9' }] }
    }, "const LOOP_NOTE = /^\\[LOOP — (exhausted|escalated): (\\d+) pass(?:es)? round the gate[^\\n]*\\]\\s*/gm;" + tipLine);
    const on = (rs, folded) => strip(led.jobResultHTML({ view: { ok: true, usd: 0.01 }, runs: rs, output: 'x', stamp: 3, folded, shipped: true }, null));
    A.ok(!/TO REVIEW/.test(on(runs, true)), 'a job already rated (its run is no longer pending) says nothing about TO REVIEW');
    A.ok(/waiting in DELIVERABLES › TO REVIEW/.test(on([{ runId: 'r9', agentId: 'agent', reason: 'done', usd: 0.01 }], true)), '…one whose run is still pending says it waits there');
    A.ok(!/TO REVIEW/.test(on([{ runId: 'r9', agentId: 'agent', reason: 'done', usd: 0.01 }], false)), '…and a job never folded never claims it');
  }
  A.ok(/\$\$\('\[data-to-review\]'\)[^\n]*H\.openTerm\('outbox'\)/.test(panel), 'the door opens the TO REVIEW deep link (the outbox key)');
  A.ok(!/text answer/.test(strip(card(false, 'something-else'))), 'an unknown reason word is never read as a text answer');
  A.ok(!/not counted/.test(strip(card(true))), 'a shipped job adds nothing (DELIVERED and SHIPPED already agree)');
  A.ok(!/not counted/.test(strip(card(null))) && !/not counted/.test(strip(card(undefined))), 'an unknown answer is never said as "not counted"');
  A.ok(!/not counted/.test(strip(fns.jobResultHTML({ view: { ok: false, usd: 0.01 }, runs: [{ runId: 'r1', agentId: 'agent', reason: 'error', usd: 0.01 }], output: 'x', stamp: 2, shipped: false }, null))), 'a job with a problem is not a delivered job: no SHIPPED words');
  A.ok(/shipped: response && typeof response\.shipped === 'boolean' \? response\.shipped : null/.test(build), 'the panel keeps the server\'s own per-job answer (never guessed from the reply)');
  A.ok(/shippedWhy: response && response\.shipped === false && typeof response\.shippedWhy === 'string' \? response\.shippedWhy : null/.test(build), '…and the server\'s reason, only beside a false');
  const host = readSidecarSource().replace(/\r\n/g, '\n'), sample = A.fnBody(host, 'async function runSampleJob(readArgs)');
  A.ok(sample.length > 2000 && sample.length < host.length / 4, 'sliced runSampleJob (' + sample.length + ' chars)');
  A.ok(/anyProvenWork = rows\.some\(provenWork\)/.test(sample) && /shippedWhy = \(shipped === false && runs\.length && anyProvenWork === false\) \? 'no-proven-work' : null/.test(sample), 'the route says no-proven-work only when its own run rows prove it (the receipt rule\'s provenWork)');
  const upd = A.fnBody(panel, 'function jobUpdate()');
  A.ok(/paint\(false\)/.test(upd) && /!sr\.pending && sr\.view\) refreshToday\(\)/.test(upd), 'a settled job re-reads TODAY at once, so RUNS / SHIPPED match the card');
  A.eq((panel.match(/onUpdate: jobUpdate/g) || []).length, 3, 'every way the panel sends a job (SEND, RUN AGAIN, TEST) settles through jobUpdate');
  A.ok(!/onUpdate: \(\) => paint\(false\)/.test(panel), '…none still repaints without re-reading TODAY');
}

/* ---------- #44: each agent named once ---------- */
{
  global.Channels = { pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
  global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
  global.App = { agentName: id => ({ researcher: 'RESEARCH', copywriter: 'COPY' })[id] || id };
  global.document = undefined;
  const D = require('../frontend/app/delegated.js');
  const ws = o => Object.assign({ history: [], runIds: ['r'], lastRunReason: 'done' }, o);
  const rows = [{ ws: ws({ id: 'k1', agentId: 'researcher', title: 'Find 3 competitor launch emails' }), worker: null },
    { ws: ws({ id: 'k2', agentId: 'copywriter', title: 'Draft the launch email' }), worker: null },
    { ws: ws({ id: 'k3', agentId: 'copywriter', title: 'Draft a short variant' }), worker: null }];
  D._internals.opened.add('dup1');
  const html = D._internals.lineHtml({ lead: 'dup1', rows }, 'home');
  A.ok(/Delegated to <b>RESEARCH and COPY<\/b>/.test(html), 'a re-dispatch names its agent once: ' + (/Delegated to <b>[^<]*<\/b>/.exec(html) || [''])[0]);
  A.eq((html.match(/data-dg-row=/g) || []).length, 3, '…and still lists every task as its own row');
  A.ok(/all 3 done/.test(html), 'the header count is still every task');
}

/* ---------- #48: DELIVERABLES read as words ---------- */
{
  const D = require('../frontend/app/deliverables.js');
  A.eq(D.plainLine('**TEASER 1:** Your _agents_ never sleep. ## Subject - [Read more](https://x.test) and `code`'), 'TEASER 1: Your agents never sleep. Subject - Read more and code', 'a summary loses its markdown marks, keeps its words');
  A.eq(D.plainLine('# Launch email\n\n- one-line subjects\n- a single call to action'), 'Launch email one-line subjects a single call to action', 'headings and list marks drop on a multi-line summary');
  A.eq(D.plainLine(''), '', 'nothing stays nothing');
  const src = rd('frontend/app/deliverables.js');
  const fns = load(src, ['function cardHtml(r, i, now)', 'function detailHtml(r)'], {
    plainLine: D.plainLine, safeMarkdown: D.safeMarkdown, pillOf: s => ({ cls: s, label: String(s).toUpperCase() }), crewHtml: () => '', agoOf: () => 'now',
    fmtSize: n => n + ' B', fileHref: () => '#', openHref: () => '#'
  });
  const job = fns.cardHtml({ title: 'Launch kit — write it', authored: false, summary: '**TEASER 1:** a text-only answer ## Notes Nothing was saved.', status: 'produced', files: [], output: '**TEASER 1:** a text-only answer\n\n## Notes\nNothing was saved.', jobId: 'job-1' }, 0, 0);
  A.ok(/<p class="dlv-sum">TEASER 1: a text-only answer Notes Nothing was saved\.<\/p>/.test(job), 'a workflow job\'s glance is plain words: ' + (/<p class="dlv-sum">[^<]*/.exec(job) || [''])[0]);
  A.ok(/<div class="dlv-said md"><p><strong>TEASER 1:<\/strong> a text-only answer<\/p><h2>Notes<\/h2><p>Nothing was saved\.<\/p><\/div>/.test(job), 'WHAT CAME BACK is rendered (bold, heading, paragraphs) through the safe renderer');
  const file = fns.cardHtml({ title: 'competitor-launch-emails.md', authored: false, summary: '', status: 'produced', files: [{ path: 'competitor-launch-emails.md', bytes: 120, openUrl: '/api/file?path=x' }] }, 1, 0);
  A.ok(!/did not name/.test(file) && !/dlv-sum/.test(file), 'an unnamed file says nothing under its name (no apology line)');
  A.ok(/dlv-title plain">competitor-launch-emails\.md</.test(file), '…its name is the plain fact');
  A.ok(!/<script>/.test(fns.cardHtml({ title: 'x', authored: true, summary: '<script>alert(1)</script>', status: 'produced', files: [], output: '<script>alert(1)</script>' }, 2, 0)), 'agent text is still escaped on the glance and in the drawer');
}

/* ---------- session titles: one "General" ---------- */
{
  const W = require('../frontend/app/workstreams.js');
  W.init({ generalId: 'home', activeId: 'home', workstreams: [
    { id: 'home', title: null, agentId: 'agent', history: [] },
    { id: 'blank', title: null, agentId: 'agent', history: [], kind: 'chat' },
    { id: 'named', title: 'Launch prep', agentId: 'agent', history: [{ role: 'user', content: 'Launch prep' }] }] });
  A.eq(['home', 'blank', 'named'].map(id => W.titleOf(id)), ['General', 'New session', 'Launch prep'], 'only the General home reads "General"; an untitled other session is a "New session"');
  const fresh = W.startSession({ reuseActive: false });
  A.eq(W.titleOf(fresh), 'New session', '+ NEW reads "New session", never a second "General"');
  A.ok(W.autoTitle(fresh.id, 'Draft the launch email') && W.titleOf(fresh) === 'Draft the launch email', '…until its first message names it');
  // the exported file and search read the same name (the export heading said "General" for any untitled session)
  const md = W.exportConversation('blank', 'markdown', { exportedAt: 1 });
  A.ok(/^# New session$/m.test(md.text) && md.filename === 'starnet-new-session.md', 'an untitled session exports as "New session": ' + md.filename);
  A.ok(/^# General$/m.test(W.exportConversation('home', 'markdown', { exportedAt: 1 }).text), '…the General home exports as "General"');
  A.eq(W.search('general').map(h => h.id), ['home'], 'searching "general" finds the General home only, not every untitled session');
  // the voice call hears the rail's names: one "General", the untitled session as "New session"
  const voice = rd('frontend/app/voice-live.js');
  const nameLine = (/\n  const sessionName = [^\n]*\n/.exec(voice) || [''])[0];
  A.ok(/Workstreams\.titleOf\(ws\)/.test(nameLine), 'the voice context names sessions with Workstreams.titleOf');
  const P = vm.runInNewContext(rd('frontend/app/personas.js') + '\nPersonas;');
  const instructions = A.fnBody(voice, 'function voiceInstructions() {');
  const spoken = new Function('Personas', 'Workstreams', 'stationContext', nameLine + instructions + '; return voiceInstructions();')(P, W,
    () => ({ agent: { name: 'NOVA' }, crew: [], streams: [W.get('home'), W.get('blank'), W.get('named')], activeWs: W.get('blank') }));
  A.ok(/Open sessions: General; New session; Launch prep\./.test(spoken), 'the voice model hears one General: ' + (/Open sessions: [^\n.]*\./.exec(spoken) || [''])[0]);
  A.ok(/The active session is "New session"\./.test(spoken), '…and the active untitled session by the rail\'s name');
  A.ok(!/\btitle \|\| 'General'/.test(voice), 'voice-live never falls back to "General" for an untitled session');
  W.init({});
  const app = rd('frontend/app/app.js');
  A.ok(!/w\.title \|\| 'General'/.test(app) && !/\(hit\.title \|\| 'General'\)/.test(app), 'the session rail never falls back to "General" for any untitled session');
  A.ok(/const baseTitles = rows\.map\(w => Workstreams\.titleOf\(w\)\)/.test(A.fnBody(app, 'function renderRail()')), 'the rail row reads Workstreams.titleOf (org D12: a repeated untitled name then gains its agent)');
  A.ok(/Workstreams\.titleOf\(w\)/.test(A.fnBody(app, 'function railRowTip(w, st, project = false)')) && /Workstreams\.titleOf\(w\)/.test(A.fnBody(app, 'function railRowLabel(w, st, project = false)')), '…and so do its tip and its spoken label');
}

/* ---------- #29: a toast never covers an open dock menu ---------- */
{
  const ui = rd('frontend/app/stationui.js'), nav = rd('frontend/app/navdock.js');
  const rect = (l, t, w, h) => ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h });
  // layout: the menu's resting box (transforms ignored) — its dock group's rect, the group's local height and the menu's offsetTop
  function seat(menuRect, layout) {
    const props = {};
    const stack = { style: { setProperty: (k, v) => { props[k] = v; } } };
    const els = { 'screen-game': { classList: { contains: () => true } }, bottombar: { getBoundingClientRect: () => rect(11, 846, 1418, 46) }, 'stage-wrap': { getBoundingClientRect: () => rect(11, 40, 1418, 796) } };
    const menu = menuRect ? { getBoundingClientRect: () => menuRect } : null;
    if (menu && layout) { menu.offsetTop = layout.offsetTop; menu.offsetParent = { getBoundingClientRect: () => layout.group, offsetHeight: layout.groupLocalH }; }
    const menus = menu ? [menu] : [];
    const fns = load(ui, ['function menuRestTop(menu, mr)', 'function seatToastRack(stack)'], {
      document: { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: sel => (/\.bb-group\.open \.bb-menu/.test(sel) ? menus : []) },
      window: { innerHeight: 900 }, uiZoom: () => 1
    });
    fns.seatToastRack(stack);
    return parseFloat(props['--toast-b']);
  }
  const base = seat(null);
  A.eq(base, 64, 'no menu open: the rack sits on the stage floor line (900 - 836)');
  const raised = seat(rect(220, 560, 300, 280));   // the BUILD menu opening upward into the rack's 356px column
  A.eq(raised, 900 - 560 + 6, 'an open dock menu in the rack\'s column lifts the rack above the menu\'s top (6px clear)');
  A.eq(seat(rect(900, 560, 300, 280)), base, 'a menu clear of the rack\'s column leaves it where it was');
  // (review of #29) mid pop-in the painted rect sits ~5px low and a hair small; the rack seats on the menu's RESTING top, so a toast
  // already up never overlaps the opening menu, and nothing jumps at animationend
  const group = rect(214, 847, 120, 44);   // the BUILD dock group; the menu rests 7px above it, 281px tall: top 559
  const opening = seat(rect(216, 566, 297, 278), { group, groupLocalH: 44, offsetTop: -288 });
  A.eq(opening, 900 - 559 + 6, 'an OPENING menu (painted top 566) lifts the rack above where its top will rest (559): ' + opening);
  A.eq(seat(rect(214, 559, 300, 281), { group, groupLocalH: 44, offsetTop: -288 }), 900 - 559 + 6, '…the same seat once it has settled (no jump at animationend)');
  A.eq(seat(rect(216, 566, 297, 278), { group: rect(214, 847, 120, 55), groupLocalH: 44, offsetTop: -230.4 }), 900 - 559 + 6, 'a text-size zoom (visual 55 / local 44) scales the offset by the group\'s own ratio');
  A.eq(seat(rect(220, 560, 300, 280), { group: null, groupLocalH: 0, offsetTop: -280 }), 900 - 560 + 6, 'an unreadable layout falls back to the painted rect');
  A.ok(/registerWindow, h, motionRestState, reseatToasts \}/.test(ui), 'StationUI exposes reseatToasts');
  const toggle = A.fnBody(nav, 'function toggle(g, viaKeyboard)'), closeAll = A.fnBody(nav, 'function closeAll(except)');
  A.ok(/requestAnimationFrame\(reseatToasts\)/.test(toggle) && /else reseatToasts\(\)/.test(toggle), 'a dock menu opening or closing re-seats a toast already up');
  A.ok(/reseatToasts\(\);\s*\}$/.test(closeAll.trim()), 'closing every menu (an item picked, a click away) re-seats it too');
}

/* ---------- #21 #27: the world's RUN tag reads CREW's clock ---------- */
{
  const world = rd('frontend/app/world.js');
  const clocks = A.fnBody(world, 'function drawRunClocks(now)');
  A.ok(/CrewClock\.elapsedOf\(aid, wallNow\)/.test(clocks) && /CrewClock\.frameNow\(now\) : Date\.now\(\)/.test(clocks), 'the desk tag asks CrewClock for this agent\'s run at the frame\'s one wall instant (CrewClock.frameNow of the rAF timestamp — the instant CREW paints its turn from)');
  A.ok(/typeof crewMs === 'number' && isFinite\(crewMs\) \? crewMs : \(now - t0\)/.test(clocks), '…and falls back to the run\'s own start only when CREW has no live run for it');
  const crew = rd('frontend/app/crewcards.js');
  A.ok(/window\.CrewClock = \{\s*elapsedOf:/.test(crew) && /elapsedOfRun: \(runId, now\)/.test(crew) && /msToNextSecond: \(now\)/.test(crew), 'CrewClock is the one clock CREW, the DELEGATED row and the world read (per agent, per run, and when it next turns)');
  // (review of #21) CREW paints when its clock turns, never on a free-running interval at the page's own phase
  A.ok(!/setInterval\(paint, 1000\)/.test(crew) && /requestAnimationFrame\(step\)/.test(A.fnBody(crew, 'function rideTurn(turnAt)')), 'CREW repaints in the frame its clock turns (crew-cards.test steps it frame by frame)');
  // the DELEGATED row: a worker on the station's ledger reads its own run's CREW clock (waits excluded), and ticks on the same turn
  {
    const D = require('../frontend/app/delegated.js');
    const saved = { Channels: global.Channels, Overseer: global.Overseer, CrewClock: global.CrewClock };
    global.Channels = { pendingOf: () => null, pendingAllOf: () => [], isBusy: () => false, elapsedOf: () => NaN, runIdOf: () => '' };
    global.Overseer = { snapshot: () => ({ workers: [], threads: [] }), fresh: () => true };
    const row = { ws: { id: 'k9', agentId: 'researcher', history: [], runIds: ['run-9'] }, worker: { status: 'running', runId: 'run-9', agentId: 'researcher', startedAt: Date.now() - 100000, streamId: 'k9' } };
    global.CrewClock = { elapsedOfRun: id => (id === 'run-9' ? 41500 : null), elapsedOf: () => null, msToNextSecond: () => 500 };
    A.eq(D.stateOf(row, 'home', 'lead').t, '0:41', 'a ledger worker\'s row reads its run\'s CREW clock (41.5 s, the 58.5 s it waited on you excluded), not the ledger\'s wall clock 1:40');
    global.CrewClock = { elapsedOfRun: () => null, elapsedOf: () => null, msToNextSecond: () => 500 };
    A.eq(D.stateOf(row, 'home', 'lead').t, '1:40', 'a run this page never saw start falls back to the ledger\'s start');
    Object.assign(global, saved);
    const dsrc = rd('frontend/app/delegated.js');
    A.ok(!/setInterval\(repaint, 1000\)/.test(dsrc) && /CrewClock\.atNextTurn\(fire\)/.test(dsrc), 'the DELEGATED clock tick rides CREW\'s turn (the same frame)');
  }
}

/* ---------- #41: a deliverable is a thing to OPEN ---------- */
{
  const host = readSidecarSource().replace(/\r\n/g, '\n');
  A.ok(/name the deliverable and say it is ready to open on its card \(every file a worker saved is one\) — never answer with only a list of file names, and never ask whether to show or fetch it/.test(host), 'the lead\'s YOUR TEAM line hands over the deliverable to open');
  A.ok(/A saved file is ready to open on its card; never offer to fetch, pull or paste it\. /.test(A.fnBody(host, 'function delegatedReportPrompt(live, waiting, followUp)')), 'the background report says the same');
}

A.report();
