/* test/refit-junction-cards.test.js — the JOINER / LOOP gate cards, the FINISH card's sample readout, and
   the STEP card's plain-language facts (2026-08-22 stranded-user sweep).

   Product bar (Andrew): the conveyor may be complex but must be "perhaps the easiest way to create reliable
   workflows" — every "what does this do / which lane / did that work?" hesitation is a defect.

   Three layers:
     1. PURE — build.js is a browser IIFE, so its two pure helpers live between REFIT-JUNCTION-PURE markers
        and are extracted + evaluated here (the plan-poster idiom): loopExitLabels must label a LOOP gate's
        real exits by direction AND destination off a REAL compiled plan, and sampleResultView must say only
        what the server's answer proves (③ ticks on `delivered`, never on HTTP 200 alone).
     2. MODEL — worldmodel.configureJunction round-trips the gate config the cards write, and the compiler
        carries it into plan.junctions — which is INSIDE plan.hash, so an edit re-POSTs on its own.
     3. SOURCE — the wiring laws (fields present, saved on blur+Enter, closes through the save, the
        checklist follows the focused line, the coach stacks instead of hiding, palette purposes). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const readSourceText = require('./_source-text.js');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');

const src = f => readSourceText(path.join(__dirname, '..', 'frontend', 'app', f));
const build = src('build.js');
const panelSrc = src('workflowpanel.js');   // the JOINER/LOOP/INBOX/STEP editing moved into the docked Workflow panel (2026-09-22)

/* ---------- 1. PURE helpers, extracted from the shipped source ---------- */
const BEGIN = 'REFIT-JUNCTION-PURE-BEGIN', END = 'REFIT-JUNCTION-PURE-END';
const bi = build.indexOf(BEGIN), ei = build.indexOf(END);
A.ok(bi > 0 && ei > bi, 'the pure block is marked in build.js');
const block = build.slice(build.indexOf('*/', bi) + 2, build.lastIndexOf('/*', ei));
const pure = new Function(block + '\nreturn { loopExitLabels, loopBackTxt, sampleResultView };')();
const wbi = build.indexOf('REFIT-WORKFLOW-PURE-BEGIN'), wei = build.indexOf('REFIT-WORKFLOW-PURE-END');
const workflow = new Function(build.slice(build.indexOf('*/', wbi) + 2, build.lastIndexOf('/*', wei)) + '\nreturn workflowReadout;')();
{
  const comp = { intakes: ['in'], bays: [{ propId: 'a', agentId: 'writer' }, { propId: 'b', agentId: 'reviewer' }, { propId: 'c', role: 'Publish' }] };
  const plan = { reach: { writer: true }, chains: { writer: { next: ['reviewer', 'writer'] }, reviewer: { next: [], outbox: true } } };
  const read = workflow(comp, plan, a => a.toUpperCase());
  A.eq(read.steps[0].sends, 'REVIEWER / WRITER', 'branch and loop destinations retain real graph edges, not invented stage order');
  A.eq(read.steps[2].agent, 'Choose an agent', 'unassigned step has an actionable label');
  A.eq(read.steps[2].sends, 'No confirmed onward route', 'unbound steps do not claim routing');
  A.eq(read.result, 'Connected to a results outbox', 'output connection comes from compiled chain');
  A.eq(workflow(comp, null, a => a).result, 'No confirmed route to an outbox', 'missing plan never claims successful result');
  plan.chains.reviewer = { next: [], deadEnd: true };
  A.ok(/Disconnected end/.test(workflow(comp, plan, a => a).steps[1].sends), 'disconnected output names the recovery action');
}

// a real floor: INBOX → WRITER → LOOP gate; gate E → REVIEWER → OUTBOX, gate S → belt back to WRITER
{
  const s = WM.create();
  A.ok(s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 19 } }).ok, 'deck placed');
  A.ok(s.addProp({ t: 'intake', x: 32, y: 4, w: 2, h: 2 }).ok, 'inbox');
  const writer = s.addProp({ t: 'bay', x: 38, y: 4, w: 2, h: 2, agentId: 'writer' }); A.ok(writer.ok, 'writer bay');
  const reviewer = s.addProp({ t: 'bay', x: 50, y: 4, w: 2, h: 2, agentId: 'reviewer' }); A.ok(reviewer.ok, 'reviewer bay');
  A.ok(s.addProp({ t: 'outbox', x: 58, y: 4, w: 2, h: 2 }).ok, 'outbox');
  // inbox mouth → writer hookup (row 6 under the 2x2s), writer ship → gate at (44,6)
  for (let x = 34; x <= 43; x++) A.ok(s.setBelt(x, 6, 'E').ok, 'belt ' + x);
  A.ok(s.setBelt(44, 6, 'E').ok, 'gate tile belt');
  for (let x = 45; x <= 57; x++) A.ok(s.setBelt(x, 6, 'E').ok, 'belt ' + x);
  // the BACK lane: gate S → down, west, up into the writer's ring
  A.ok(s.setBelt(44, 7, 'S').ok && s.setBelt(44, 8, 'W').ok, 'back lane start');
  for (let x = 43; x >= 39; x--) A.ok(s.setBelt(x, 8, 'W').ok, 'back belt ' + x);
  A.ok(s.setBelt(38, 8, 'N').ok && s.setBelt(38, 7, 'N').ok, 'back lane re-enters at the writer ring');
  const loop = s.addProp({ t: 'loop', x: 44, y: 6, w: 1, h: 1, block: false }); A.ok(loop.ok, 'loop gate on the line');

  const geo = s.projectGeometry();
  const plan = P.compileRoutingPlan(geo);
  const o = geo.origin || { tx: 0, ty: 0 };
  const tile = { x: 44 - o.tx, y: 6 - o.ty };
  A.ok(plan.junctions[tile.x + ',' + tile.y] && plan.junctions[tile.x + ',' + tile.y].kind === 'loop', 'the compiler sees the gate');

  const names = { writer: 'Writer', reviewer: 'Reviewer' };
  const overview = workflow(P.lineComponents(geo).find(c => c.bays.some(b => b.agentId === 'writer')), plan, a => names[a] || a);
  A.ok(overview.steps.some(s => s.label === 'Writer'), 'real compiled floor names its bound step');
  A.ok(overview.steps.some(s => s.sends.includes('Reviewer')), 'real compiled floor exposes onward destination');
  const exits = pure.loopExitLabels(plan, tile, a => names[a] || a);
  const byDir = {}; for (const x of exits) byDir[x.dir] = x;
  A.eq(exits.length, 2, 'the gate has exactly two exits (E onward, S back)');
  A.eq(byDir.E && byDir.E.label, 'E → to REVIEWER', 'the onward lane is labelled by direction AND by the dock it reaches');
  A.eq(byDir.S && byDir.S.label, 'S → to WRITER', 'the back lane names the upstream dock it re-enters');
  A.eq(byDir.S && byDir.S.kind, 'bay', 'destination kind is carried for the BACK sentence');
  A.ok(/BACK lane: S → to WRITER/.test(pure.loopBackTxt(exits, 'E')), 'with DONE = E the card says S is the back lane and where it re-enters');
  A.ok(/BACK lane: E → to REVIEWER/.test(pure.loopBackTxt(exits, 'S')), 'flipping DONE flips the back sentence');
  A.ok(/no BACK lane/.test(pure.loopBackTxt([exits[0]], exits[0].dir)), 'a one-exit gate is told it has no way round');
  A.eq(pure.loopExitLabels(null, tile).length, 0, 'no plan → no exits, never a throw');

  /* ---------- 2. MODEL round-trip: the config the cards write compiles into plan.junctions (inside plan.hash) ---------- */
  const h0 = plan.hash;
  const r1 = s.configureJunction(loop.id, { maxIter: 3, done: 'E', when: 'code' });
  A.ok(r1.ok && r1.maxIter === 3 && r1.done === 'E' && r1.when === 'code', 'configureJunction round-trips maxIter/done/when');
  const plan2 = P.compileRoutingPlan(s.projectGeometry());
  const jc = plan2.junctions[tile.x + ',' + tile.y];
  A.eq(jc.max, 3, 'MAX PASSES compiles to junction.max');
  A.eq(jc.done, 'E', 'DONE lane compiles');
  A.eq(jc.back, 'S', '…and the other exit is the back lane');
  A.eq(jc.when, 'code', 'the verdict tag compiles');
  A.ok(plan2.hash !== h0, 'a gate edit moves plan.hash — it re-POSTs without any poster-key addition');
  A.ok(s.configureJunction(loop.id, { maxIter: 99 }).maxIter == null, 'an out-of-range max is refused by the model (the card clamps to the ceiling first)');
  A.ok(s.configureJunction(loop.id, { maxIter: 20 }).maxIter === 20, 'the ceiling itself is accepted');

  // JOINER timeout round-trip (a joiner off the line is fine for the model law)
  const j = s.addProp({ t: 'joiner', x: 60, y: 12, w: 1, h: 1, block: false }); A.ok(j.ok, 'joiner placed');
  A.eq(s.configureJunction(j.id, { timeoutMin: 45 }).timeoutMin, 45, 'JOINER timeout round-trips');
  A.eq(s.configureJunction(j.id, { timeoutMin: 121 }).timeoutMin, null, 'a timeout over 120 is refused by the model');
}

/* ---------- 1b. the sample readout says ONLY what the server proved ---------- */
{
  const nameOf = a => ({ writer: 'Writer', reviewer: 'Reviewer' })[a] || a;
  const ok = pure.sampleResultView({
    ok: true, delivered: { runId: 'r2' }, totalUsd: 0.0123,
    runs: [{ agentId: 'reviewer', reason: 'done', usd: 0.01 }, { agentId: 'writer', reason: 'done', usd: 0.0023 }],   // newest-first, as the route answers
    replies: ['first draft', 'Approved. The line summarizes work in three sentences and ships it to the outbox for the Commander to read later on.']
  }, 200, nameOf);
  A.ok(ok.ok, 'delivered → ok');
  A.eq(ok.stages.join('>'), 'Writer>Reviewer', 'stages read in LINE order (the route lists runs newest-first)');
  A.eq(ok.usd, 0.0123, 'the total is the server\'s totalUsd, never re-summed locally');
  A.ok(ok.reply.length <= 81 && ok.reply.endsWith('…') && ok.reply.startsWith('Approved.'), 'the reply is the LAST delivered text, cut to ~80 chars');
  A.eq(ok.reason, null, 'no reason on success');

  const notDelivered = pure.sampleResultView({ ok: true, delivered: null, runs: [], replies: [], totalUsd: 0 }, 200, nameOf);
  A.ok(!notDelivered.ok, 'HTTP 200 without `delivered` does NOT tick ③ — the card asserts only what the harness proved');

  const refused = pure.sampleResultView({ ok: false, error: 'line "x" routes this job to no dock — crew a bay on that line' }, 409, nameOf);
  A.ok(!refused.ok && /routes this job to no dock/.test(refused.reason), 'a refusal surfaces the server\'s own reason');
  const dead = pure.sampleResultView(null, 502, nameOf);
  A.ok(!dead.ok && /HTTP 502/.test(dead.reason), 'an unparseable answer names the status, never invents a reason');
}

/* ---------- 3. SOURCE wiring laws ---------- */
const flow = panelSrc.slice(panelSrc.indexOf('  function paintTrigger('), panelSrc.indexOf('  /* ===== THE STEP TEST'));
A.ok(/jnField\('jn-timeout', '[^']+', 1, 120, 1, [^,]+, '10'\)/.test(flow), 'JOINER card: a TIMEOUT number field, 1–120, default 10 as its placeholder');
A.ok(/type="number" min="' \+ min \+ '" max="' \+ max \+ '"/.test(flow), 'the gate number field is a .refit-num with min/max (never OS paint)');
A.ok(/marked PARTIAL/.test(flow), 'JOINER card explains what partial release means');
A.ok(/jnField\('loop-max', 'MAX PASSES', 1, loopMaxCeil, 1, [^,]+, String\(loopMaxDef\)\)/.test(flow), 'LOOP card: MAX PASSES field, 1..compiler ceiling, compiler default as placeholder');
A.ok(/class="bb sm loop-exit/.test(flow) && /H\.loopExits\(p\.id\)/.test(flow) && /loopExitLabels\(valPlan/.test(build.slice(build.indexOf('loopExits: id =>'), build.indexOf('loopExits: id =>') + 400)), 'LOOP card: DONE lane picker lists the compiled plan\'s real exits (build.js hands the panel loopExitLabels over valPlan)');
A.ok(/loop-when/.test(flow) && /\['code', 'CODE'\], \['research', 'RESEARCH'\], \['general', 'GENERAL'\]/.test(flow),
  'LOOP verdict tag is a pick of the ONLY tags the classifier can produce (a typed "approved" could never match)');
A.ok(/\['approved', 'APPROVED'\], \['revise', 'REVISE'\]/.test(flow) && /loop-verdict/.test(flow), 'LOOP verdict picks: APPROVED / REVISE (the words routing/verdict.js parses) sit beside the classifier tags (2026-08-22)');
A.ok(/loopRuleTxt\(p\.when, p\.maxIter \|\| loopMaxDef\)/.test(flow) && /loopRuleTxt\(res\.when/.test(flow), 'the card copy and saved-note use the same rule, including the saved pass limit');
A.ok(/goes round until the reviewer’s last line says VERDICT: ' \+ when/.test(build) && /or MAX PASSES/.test(build) && /marked unapproved/.test(build), 'the verdict rule copy: round until VERDICT: <word> or MAX PASSES, then DONE marked unapproved — what chain.js runs');
A.ok(/goes round again ONLY while the reviewer’s output reads as/.test(build), 'the classifier-tag rule copy is unchanged: the tag keeps it looping, anything else leaves on DONE');
A.ok(/station\(\)\.configureJunction\(p\.id, Object\.keys\(cfg\)\.length \? cfg : null\)/.test(flow), 'gate saves go through configureJunction (the validated model path)');
A.ok(/el\._saveGate = saveGate;/.test(flow) && /if \(el\._saveGate\) el\._saveGate\(\);/.test(panelSrc), 'closing the panel saves the gate config (ESC never discards it)');
A.ok(/for \(const n of \[jnTimeout, loopMax\]\)[\s\S]{0,300}addEventListener\('blur', saveGate\)[\s\S]{0,200}e\.key === 'Enter'/.test(flow), 'number fields save on blur AND Enter');
A.ok(/lbNote\.textContent = \(res\.limits \? '✓ line budget saved/.test(flow), 'LINE BUDGET confirms ON THE CARD after a save (blur or Enter)');
A.ok(!/JSON\.stringify\(plan\.(junctions|gate)/.test(src('world.js')), 'nothing was added to the plan-poster key — junction config rides plan.hash already');

// palette purposes: every WORKFLOW machine has a one-line purpose in the tile tooltip
const pm = build.slice(build.indexOf('const PALETTE_PURPOSE'), build.indexOf('const THUMB_PAD'));
for (const id of ['intake', 'bay', 'filter', 'merger', 'splitter', 'joiner', 'loop', 'outbox']) A.ok(new RegExp('\\b' + id + ': \'').test(pm), 'palette purpose for ' + id);
A.ok(/b\.setAttribute\('aria-description', c\.label[^\n]*purpose/.test(build), 'the tile accessible description carries the purpose');
const tile = build.slice(build.indexOf('function propTile('), build.indexOf('function renderPropPreview('));
A.ok(/setAttribute\('data-tip'/.test(tile) && !/b\.title\s*=|setAttribute\('data-no-tip'/.test(tile), 'catalog tiles use the shared brief tooltip without a native bubble');
A.ok(/wait here/i.test(pm) && /straight through/.test(pm), 'MERGER (rides straight through) vs JOINER (branches wait) are distinguishable by tooltip alone');

// sample-run feedback: rendered on the card, scoped to its line, ③ ticks only on delivered
const fin = build.slice(build.indexOf('function renderFinCard'), build.indexOf('function positionFinCard'));
A.ok(/finSampleRes\.key === c\.key/.test(fin), 'the readout belongs to the line it rode');
A.ok(/sampleResultView\(j, r\.status, agentLabel\)/.test(fin), 'the response is parsed through the pure view (never discarded)');
A.ok(/sr && sr\.view && sr\.view\.ok \? ' done' : ''/.test(fin), '③ ticks only on the view\'s ok (= server `delivered`)');
A.ok(/SAMPLE RIDING THE LINE/.test(fin), 'an in-flight sample is shown as in flight, not as done');
A.ok(/finSampleHTML\(sr\.view\)/.test(fin) && /fl-result/.test(fin), 'the result block is rendered into the card');
A.ok(!/sample job dispatched — watch the line/.test(fin), 'the old fire-and-forget flash is gone');

// STEP (the panel's BAY editor): live line facts, compute rule, display names
A.ok(/data-live="gets"/.test(panelSrc) && /data-live="to"/.test(panelSrc) && /function refreshLineFacts/.test(build) && /WorkflowPanel\.refresh\(\)/.test(build), 'the GETS/TO line facts are addressable and refresh off the recompiled plan');
A.ok(/renderFinCard\(\);\n\s*refreshLineFacts\(\);/.test(build), 'line facts refresh after every plan recompile (click-connect lands on the open panel)');
A.ok(/esc\(nameOf\(p\.agentId\)\) \+ ' needs an assigned workstation in this room/.test(panelSrc), 'the workstation requirement names the assigned agent and room');
A.ok(/station\.addProp\(\{ t: 'desk', x, y, w: 2, h: 1, agentId: p\.agentId \}\)/.test(build) && /H\.requisitionPcFor\(S\.sel\)/.test(panelSrc), 'the one-click fix places a real desk in the room, bound to the agent (object=capability)');
A.ok(/esc\(String\(a\.name \|\| a\.id\)\.toUpperCase\(\)\)/.test(panelSrc) && /H\.flashTip\('bay → ' \+ nameOf\(b\.dataset\.aid\)/.test(panelSrc), 'assignment shows the display name, never the raw id');

// FINISH card follows the focused line; coach bubbles stack
A.ok(/function finFocusLine\(propId\)/.test(build), 'a focus-line helper exists');
A.ok(/cardCloseAll\(\);[^\n]*\n\s*finFocusLine\(bayId\);/.test(build), 'opening a STEP card focuses its line');
A.ok(/cardCloseAll\(\);\s*\n\s*finFocusLine\(propId\);/.test(build), 'opening a flow card focuses its line');
const pos = build.slice(build.indexOf('function positionFinCard'), build.indexOf('function noteLineDelivered'));
A.ok(!/tutorialCoaching\(\) \|\| \(root && root\.querySelector\('\.refit-firstrun'\)\)\) \{ finCardEl\.style\.display = 'none'/.test(pos), 'a coach bubble no longer hides the checklist');
A.ok(/coach\.bottom \+ 10/.test(pos), '…it stacks the checklist under the bubble instead');
A.ok(/querySelector\('\.refit-firstrun'\)\) \{ finCardEl\.style\.display = 'none'/.test(pos), 'the first-run guide (the whole-screen card) still hides it');

A.report('refit-junction-cards');
