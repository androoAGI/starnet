/* test/line-names.test.js — ONE line name everywhere (final floor lane, 2026-10-12).

   A line is called by its first NAMED INBOX (Pipeline.lineWord: 'LINE RESEARCH'), else LINE <the letter of its first INBOX> —
   never by a BAY's step name, never by whichever prop keys the line (a line whose first-placed machine is a BAY is keyed by that
   BAY: 'LINE null' / 'LINE DRAFT REVIEW' on LINE WATCH, 'LINE p3' on the FED text). worldmodel.lineName is that rule; every
   surface that names a line reads it, and the duplicate check judges the same shown word (lineNameKey / lineNameTaken). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const LE = require('../frontend/app/lineedit.js');

const plan = s => P.compileRoutingPlan(s.projectGeometry());
function fresh() { const s = WM.create(); s.projectGeometry(); s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 110, y2: 50 } }); return s; }
const add = (s, t, x, y) => s.addProp({ t, x, y, w: 2, h: 2, block: true }).id;
const src = f => fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', f), 'utf8');

/* ---------- A. the model rule ---------- */
// A legacy save whose BAY placed first keyed the line keeps that key through
// migration; its INBOX still names it. New lines use a distinct saved INBOX ID.
let s = fresh();
const B = add(s, 'bay', 42, 4), I = add(s, 'intake', 32, 4), O = add(s, 'outbox', 56, 4);
s.assignPropAgent(B, 'nova');
A.ok(s.connectBelt(I, B).ok && s.connectBelt(B, O).ok, 'a line whose BAY went down first');
const legacy = s.serialize();
for (const prop of legacy.props) delete prop.lineId;
s = WM.deserialize(legacy);
const p0 = plan(s), rec = p0.lines[0];
A.eq(rec.lineId, B, 'rig: migration preserves the legacy BAY key, distinct from its INBOX prop ID');
const letter = s.lineLetter(I);
A.ok(/^[A-Z]+$/.test(letter), 'the INBOX has a letter');
A.eq(s.lineName(rec.lineId), 'LINE ' + letter, 'an unnamed line by its lineId is LINE <its INBOX letter> — never "LINE null"');
A.eq(s.lineName(I), 'LINE ' + letter, '…and by its INBOX the same');
A.eq(s.lineLetter(rec.lineId), null, '(lineLetter of the key BAY is null: the bug every surface hit)');
A.ok(s.setPropLabel(B, 'Draft review').ok, 'the BAY gets a step name');
A.eq(s.lineName(rec.lineId), 'LINE ' + letter, 'a BAY\'s step name never becomes the line\'s name');
A.ok(s.setPropLabel(I, 'Research').ok, 'the INBOX gets a name');
A.eq(s.lineName(rec.lineId), 'LINE RESEARCH', 'a named INBOX names the line');
A.eq(s.lineName('nope'), null, 'an id that names no line is null (the caller says so plainly)');
A.eq(s.lineName(O), null, 'an OUTBOX id is not a line ref (lineName takes a lineId or an INBOX)');
// a second INBOX on the same line: the first NAMED one speaks (the compiled record's own name)
{
  const s2 = fresh(), I1 = add(s2, 'intake', 32, 4), I2 = add(s2, 'intake', 32, 14), B2 = add(s2, 'bay', 44, 8), O2 = add(s2, 'outbox', 58, 8);
  s2.assignPropAgent(B2, 'atlas');
  A.ok(s2.connectBelt(I1, B2).ok && s2.connectBelt(I2, B2).ok && s2.connectBelt(B2, O2).ok, 'a line with two INBOXes');
  A.eq(s2.lineName(I1), 'LINE ' + s2.lineLetter(I1), 'unnamed: the first INBOX\'s letter, from either INBOX');
  A.eq(s2.lineName(I2), 'LINE ' + s2.lineLetter(I1), '…the same line, the same name');
  A.ok(s2.setPropLabel(I2, 'Second door').ok, 'only the second INBOX is named');
  const r2 = plan(s2).lines.find(l => l.intakes.includes(I1));
  A.eq(s2.lineName(I1), 'LINE SECOND DOOR', 'the first NAMED INBOX names the line');
  A.eq(s2.lineName(r2.lineId), P.lineWord(r2.name), '…exactly as the compiled line record names it');
}
// every compiled line: the plan record and lineName agree
{
  const s3 = fresh();
  for (let i = 0; i < 3; i++) A.ok(LE.placeBlueprint(s3, 'research_line', { x: 34, y: 2 + i * 14 }).ok, 'line ' + i);
  const ins = s3.props().filter(p => p.t === 'intake');
  s3.setPropLabel(ins[1].id, 'Line: two');
  const pl = plan(s3);
  for (const r of pl.lines) A.eq(s3.lineName(r.lineId), P.lineWord(r.name, 'LINE ' + s3.lineLetter(r.intakes[0])), 'lineName(' + r.lineId + ') = the record\'s name, else its first INBOX letter');
  const ob = s3.props().find(p => p.t === 'outbox').id;
  for (const c of s3.sendToChoices(ob)) A.eq(c.name, s3.lineName(c.lineId), 'the SEND TO chip names ' + c.lineId + ' by lineName');
  A.eq(s3.lineNameKey('line — Two '), 'LINE TWO', 'lineNameKey is the shown word');
  A.ok(s3.lineNameTaken('two') && s3.lineNameTaken('LINE TWO'), 'a name another INBOX shows is taken');
  A.ok(s3.lineNameTaken(s3.lineLetter(ins[0].id)), 'an unnamed line\'s letter is taken');
  A.ok(!s3.lineNameTaken(s3.lineLetter(ins[1].id)), '…a NAMED line\'s letter is not (it shows its name)');
}
/* ---------- B. paste numbering by the shown word ---------- */
{
  const s4 = fresh();
  const r1 = LE.placeBlueprint(s4, 'research_line', { x: 34, y: 2 }), r2 = LE.placeBlueprint(s4, 'research_line', { x: 34, y: 16 });
  A.ok(r1.ok && r2.ok, 'two lines');
  const i1 = r1.ids.find(id => s4.propById(id).t === 'intake'), i2 = r2.ids.find(id => s4.propById(id).t === 'intake');
  A.ok(s4.setPropLabel(i1, 'Line Alpha').ok && s4.setPropLabel(i2, 'Alpha 2').ok, 'lines named Line Alpha and Alpha 2');
  const c = s4.copyLines(r1.ids.concat(r2.ids)).clip;
  let r = null; for (let y = 30; y <= 40 && !r; y++) for (let x = 32; x <= 60 && !r; x++) if (s4.checkPaste(c, x, y).ok) { const q = s4.pasteLines(c, x, y); if (q.ok) r = q; }
  A.ok(!!r, 'both lines paste together');
  const shown = s4.props().filter(p => p.t === 'intake').map(p => s4.lineName(p.id));
  A.eq(new Set(shown).size, shown.length, 'every INBOX on the floor shows a different line name — ' + JSON.stringify(shown));
  const pasted = r.ids.filter(id => s4.propById(id).t === 'intake').map(id => s4.propById(id).label);
  A.eq(pasted, ['Line Alpha 3', 'Alpha 4'], '\'Line Alpha\' pasted beside \'Alpha 2\' is Line Alpha 3, and the pasted \'Alpha 2\' steps past the copy\'s own LINE ALPHA 3');
}

/* ---------- C. the lead's words (stationbuilder): an unnamed line is LINE <its letter>, and that resolves (M25 / R62) ---------- */
const SB = require('../frontend/app/stationbuilder.js'), W = require('../frontend/app/workflowline.js'), S = require('../frontend/app/propsprites.js');
WM.setPropRules(t => { const sp = S.spec(t); return sp ? { mount: sp.mount || null, stack: !!sp.stack, surface: !!sp.surface, flat: !!sp.flat } : null; });
const env = { WorldModel: WM, Pipeline: P, WorkflowLine: W, LineEdit: LE, PropSprites: S, crew: [{ id: 'agent', name: 'NOVA' }], heroId: 'agent' };
function twoUnnamed() {
  const st = WM.create(); const z = st.rooms()[0].rects[0];
  A.ok(st.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 50, y2: z.y1 + 40 } }).ok, 'a hall for two lines');
  const L = [];
  for (const i of [0, 1]) {
    const r = LE.run(st, null, 'newLine', { role: 'WRITER' }, { near: { x: z.x2 + 8, y: z.y1 + 4 + i * 12 } });
    A.ok(r.ok, 'line ' + i); const c = P.lineComponents(st.projectGeometry()).find(k => k.props.includes(r.focus));
    st.setPropLabel(c.intakes[0], ''); st.assignPropAgent(c.bays[0].propId, 'agent');
    L.push({ key: c.key, intake: c.intakes[0], outbox: c.outboxes[0] });
  }
  st.ensureWorkstation('agent');
  return { st, a: L[0], b: L[1] };
}
{
  const { st, a, b } = twoUnnamed(), wa = 'LINE ' + st.lineLetter(a.intake), wb = 'LINE ' + st.lineLetter(b.intake);
  A.ok(!st.propById(a.intake).label && !st.propById(b.intake).label && wa !== wb, 'two unnamed lines: ' + wa + ', ' + wb);
  const send = SB.planEdit(st.serialize(), { refit: [{ op: 'send', from: a.outbox, to: b.intake }] }, env);
  A.ok(send.ok, 'the SEND TO plans: ' + (send.error || ''));
  const sum = send.ok ? send.plan.summary : '';
  A.ok(sum.split(wb).length - 1 === 1 && !/unnamed line whose INBOX/.test(sum), 'the card names the target ' + wb + ' exactly once, never "the unnamed line whose INBOX is at" — ' + sum.slice(0, 220));
  const ref = SB.lineRef(st.serialize(), env, wb.toLowerCase());
  A.ok(ref.ok && ref.lineId === b.key && ref.name === wb, 'lineRef("' + wb.toLowerCase() + '") is that line, named as its plate says — ' + JSON.stringify(ref).slice(0, 160));
  A.ok(SB.lineRef(st.serialize(), env, st.lineLetter(b.intake)).ok, '…and its bare letter finds it too');
  const miss = SB.lineRef(st.serialize(), env, 'Newsletter');
  A.ok(!miss.ok && miss.error.indexOf('Lines: ' + wa + ', ' + wb) >= 0, 'a name no line has is refused, listing the lines as the floor names them — ' + miss.error);
  const del = SB.planEdit(st.serialize(), { refit: [{ op: 'delete', line: wb }] }, env);
  A.ok(del.ok, 'refit delete by "' + wb + '" resolves: ' + (del.error || ''));
  if (del.ok) { const before = new Set(st.props().map(p => p.id)); A.ok(SB.apply(st, del.plan, env).ok && !st.propById(b.intake) && st.propById(a.intake), '…and takes up exactly that line'); A.ok(before.size > st.props().length && st.undo().ok, '(undo)'); }
}
/* ---------- D. zone lines get unique names when the plan is made (M22) ---------- */
{
  const RS = require('../frontend/app/roomstyles.js'), LL = require('../frontend/app/linelayout.js'), T = require('../frontend/app/stationtemplates.js');
  const E = Object.assign({}, env, { StationTemplates: T, EquipmentHelp: require('../frontend/app/equipmenthelp.js'), RoomStyles: RS, LineLayout: LL });
  const st = WM.create(WM.starterDoc()); st.ensureWorkstation('agent');
  const one = SB.plan(st.serialize(), { line: 'build_test' }, E);
  A.ok(one.ok && SB.apply(st, one.plan, E).ok, 'BUILD + TEST is on the floor: ' + (one.error || ''));
  const keys = () => st.props().filter(p => p.t === 'intake').map(p => WM.lineNameKey(p.label) || 'LINE ' + st.lineLetter(p.id));
  const zr = SB.planRoom(st.serialize(), { zones: [{ area: 'left side', style: RS.ORDER[0] }, { area: 'right side', line: 'build_test' }] }, E);
  A.ok(zr.ok, 'a room with a build_test zone plans: ' + (zr.error || ''));
  if (zr.ok) {
    A.ok(/BUILD \+ TEST 2/.test(zr.plan.summary), 'the card says the name the zone line will have (BUILD + TEST 2) — ' + zr.plan.summary.slice(0, 200));
    A.ok(SB.apply(st, zr.plan, E).ok, '…and builds');
    A.eq(new Set(keys()).size, keys().length, 'every line shows a different name — ' + JSON.stringify(keys()));
    const rm = SB.planEdit(st.serialize(), { remove: { line: 'BUILD + TEST' } }, E);
    A.ok(rm.ok, 'remove { line: "BUILD + TEST" } resolves exactly one line: ' + (rm.error || ''));
  }
  const two = SB.planRoom(st.serialize(), { zones: [{ area: 'left side', line: 'build_test' }, { area: 'right side', line: 'build_test', name: 'line build + test' }] }, E);
  A.ok(two.ok, 'two build_test zones in one room plan: ' + (two.error || ''));
  if (two.ok) {
    A.ok(SB.apply(st, two.plan, E).ok, '…and build');
    A.eq(new Set(keys()).size, keys().length, 'two zones of one plan never share a name, and "line build + test" is suffixed past BUILD + TEST — ' + JSON.stringify(keys()));
  }
}

/* ---------- F. every surface reads the one name (source locks: these live inside the page IIFEs) ---------- */
{
  const world = src('world.js'), panel = src('workflowpanel.js'), build = src('build.js'), sb = src('stationbuilder.js'), sc = src('stationcommands.js');
  const fn = (code, head) => { const i = code.indexOf(head); return i < 0 ? '' : code.slice(i, code.indexOf('\n  }', i) + 4); };
  const lw = fn(world, '  function lwLineName(lineId) {');
  // (merge with the release-review lane 10-12: the key resolves to its compiled record first — a retired key goes through its
  // prop's current line — and the record's key is what the one rule names)
  A.ok(/station\.lineName\((rec\.)?lineId\)/.test(lw) &&/'UNNAMED LINE'/.test(lw) && !/lineLetter\(lineId\)/.test(lw) && !/ip\.label/.test(lw), 'LINE WATCH / crate cards: lwLineName is station.lineName (never lineLetter of the key prop, never its label: M17 / M23)');
  A.ok(/'SENDS TO ' \+ \(\(station && station\.lineName \? station\.lineName\(st\.toLine\)/.test(world), 'the OUTBOX SENDS TO plate names its target by lineName');
  A.ok(/const incomingNames = incoming\.map\(s => \{ const st = H\.station\(\); return \(st && st\.lineName \? st\.lineName\(s\.fromLine\) : null\) \|\| 'another line'; \}\);/.test(panel) && !/'LINE ' \+ s\.fromLine/.test(panel), 'the INBOX FED text names the sending line by lineName, never "LINE p3"');
  A.ok(/function sendName\(intakeId\) \{\s*const ip = station\.propById\(intakeId\);\s*return ip \? lineWordOf\(ip\) : 'A REMOVED LINE';/.test(build) && /station\.lineName\(id\)/.test(fn(build, '  function lineWordOf(ip) {')), 'Build: the SEND TO name and an INBOX\'s machine name read lineName');
  // (repair: lineWordOf takes the prop, its id or a preview entry's propId — `id` — so the lock reads lineName(id))
  A.ok(!/'LINE ' \+ p\.id\)|'LINE ' \+ l\.id\)|'LINE ' \+ ps\[0\]\.id\)|'LINE '\s*\+\s*c\.key/.test(build), 'Build never shows a raw prop id or line key as a line name');
  A.ok(/st\.lineName\(ip\.id\)/.test(fn(sb, '  function lineWordFor(st, P, ip) {')) && !/'the unnamed line whose INBOX is at/.test(sb), 'the lead\'s cards: lineWordFor reads lineName, the doubled "(its INBOX at …)" is gone');
  A.ok(/const floorWord = id => \(typeof st\.lineName === 'function' \? st\.lineName\(id\) : null\);/.test(sc), 'station.layout names an unnamed line by lineName');
  // PRIVATE FILES (M19 / M29): no floor nag at rest — neither nag table carries it; the OUTBOX card says it, only where it is true
  const table = (code, name) => { const i = code.indexOf('const ' + name + ' = {'); return code.slice(i, code.indexOf('\n  };', i)); };
  A.ok(!/SEND_TO_PRIVATE_FILES/.test(table(build, 'VAL_LABEL')) && !/SEND_TO_PRIVATE_FILES/.test(table(world, 'NAG_LABEL')), 'PRIVATE FILES is never painted on the floor at rest');
  A.ok(!/sendToFileAdvice|SEND_TO_PRIVATE_FILES/.test(panel), 'the OUTBOX card no longer claims handed files are unreadable');
  A.ok(!/sendToFileAdvice|SEND_TO_PRIVATE_FILES/.test(sc), 'station.layout no longer claims handed files are unreadable');
}

/* ---------- G. the lead's refit card says PRIVATE FILES before approval — only where it is true (M26) ---------- */
{
  const { st, a, b } = twoUnnamed();
  const same = SB.planEdit(st.serialize(), { refit: [{ op: 'send', from: a.outbox, to: b.intake }] }, env);
  A.ok(same.ok && !/no project folder/.test(same.plan.summary), 'one agent on both lines: no files warning on the card — ' + (same.ok ? same.plan.summary.slice(0, 160) : same.error));
  const bayB = st.props().find(p => p.t === 'bay' && P.lineComponents(st.projectGeometry()).find(c => c.key === b.key).props.includes(p.id));
  st.assignPropAgent(bayB.id, 'rex');
  const two = SB.planEdit(st.serialize(), { refit: [{ op: 'send', from: a.outbox, to: b.intake }] }, env);
  A.ok(two.ok && !/cannot open the files|only the finished text rides on/.test(two.plan.summary),
    'a different crew next: the refit card no longer makes the retired file-access claim — ' + (two.ok ? two.plan.summary : two.error));
  const SV = Object.assign({}, env, { services: { projects: [{ name: 'starnet', root: 'C:/code/starnet' }] } });
  const both = SB.planEdit(st.serialize(), { refit: [{ op: 'send', from: a.outbox, to: b.intake }, { op: 'folder', prop: a.intake, project: 'starnet' }] }, SV);
  A.ok(both.ok && !/no project folder/.test(both.plan.summary), 'a folder op in the same refit takes the warning away — ' + (both.ok ? 'ok' : both.error));
  st.setSendTo(a.outbox, b.intake);
  const again = SB.planEdit(st.serialize(), { refit: [{ op: 'label', prop: b.intake, text: 'Next' }] }, env);
  A.ok(again.ok && !/no project folder/.test(again.plan.summary), 'an existing private hand-off is not re-announced by an unrelated edit');
}

/* ---------- H. REPAIR: no two lines ever SHOW the same name, and a name is judged per LINE ----------
   (1) A line named 'F' — the letter the next INBOX gets — and then a new line left unnamed: both read LINE F, and the lead's
   lineRef said 'More than one line is called F' even by room. The unnamed one is LINE F 2 (Pipeline.lineNames, the floor's and the
   sidecar's one rule). (2) Clearing a name skipped the check. (3) A hidden second INBOX's letter refused a name no plate showed,
   and the lead's lists named a two-INBOX line twice. */
{
  const E2 = Object.assign({}, env);
  const st = WM.create(); const z = st.rooms()[0].rects[0];
  A.ok(st.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 50, y2: z.y1 + 40 } }).ok, 'a hall for lines');
  const mk = (s, i) => { const r = LE.run(s, null, 'newLine', { role: 'WRITER' }, { near: { x: z.x2 + 8, y: z.y1 + 4 + i * 12 } }); A.ok(r.ok, 'a new line ' + i); const c = P.lineComponents(s.projectGeometry()).find(k => k.props.includes(r.focus)); s.setPropLabel(c.intakes[0], ''); return c; };
  const c1 = mk(st, 0);
  const probe = WM.deserialize(JSON.parse(JSON.stringify(st.serialize()))), next = mk(probe, 1).intakes[0], L = WM.lineLetterOf(next);
  A.ok(st.setPropLabel(c1.intakes[0], L).ok, 'line 1 is named "' + L + '" — the letter the next INBOX (' + next + ') will get');
  const c2 = mk(st, 1);
  A.eq(c2.intakes[0], next, 'rig: line 2\'s INBOX is ' + next + ' (letter ' + L + ')');
  A.eq([st.lineName(c1.key), st.lineName(c2.key)], ['LINE ' + L, 'LINE ' + L + ' 2'], 'the unnamed line is LINE ' + L + ' 2, never a second LINE ' + L);
  A.eq(st.lineName(c2.intakes[0]), 'LINE ' + L + ' 2', '…by its INBOX the same');
  const pl = plan(st), side = P.lineNames(pl.lines);
  for (const r of pl.lines) A.eq(side[r.lineId], st.lineName(r.lineId), 'the sidecar\'s words (Pipeline.lineNames over the compiled plan) = the floor\'s for ' + r.lineId);
  const r1 = SB.lineRef(st.serialize(), E2, 'LINE ' + L), r2 = SB.lineRef(st.serialize(), E2, 'line ' + L.toLowerCase() + ' 2');
  A.ok(r1.ok && r1.lineId === c1.key, 'the lead\'s "LINE ' + L + '" is the line named ' + L + ' — ' + JSON.stringify(r1).slice(0, 140));
  A.ok(r2.ok && r2.lineId === c2.key && r2.name === 'LINE ' + L + ' 2', '…and "line ' + L.toLowerCase() + ' 2" is the unnamed one, called as its plate calls it — ' + JSON.stringify(r2).slice(0, 140));
  const ch = st.sendToChoices(c1.outboxes[0]).map(c => c.name);
  A.ok(ch.indexOf('LINE ' + L + ' 2') >= 0, 'the SEND TO chip says LINE ' + L + ' 2 — ' + JSON.stringify(ch));
  A.eq(st.setPropLabel(c2.intakes[0], L + ' 2').ok, true, 'the unnamed line may take its own shown name');
  A.ok(st.setPropLabel(c2.intakes[0], '').ok && st.setPropLabel(c1.intakes[0], '').ok, 'both names cleared');
  A.eq([st.lineName(c1.key), st.lineName(c2.key)], ['LINE ' + WM.lineLetterOf(c1.intakes[0]), 'LINE ' + L], 'cleared, each line is its own letter again');
}
{
  // (2) clearing a name: I1 'Research', I2 named I1's own letter (allowed: no plate shows it), then I1 cleared
  const s5 = fresh(), I1 = add(s5, 'intake', 32, 4), B1 = add(s5, 'bay', 42, 4), O1 = add(s5, 'outbox', 56, 4), I2 = add(s5, 'intake', 32, 20), B2 = add(s5, 'bay', 42, 20), O2 = add(s5, 'outbox', 56, 20);
  A.ok(s5.connectBelt(I1, B1).ok && s5.connectBelt(B1, O1).ok && s5.connectBelt(I2, B2).ok && s5.connectBelt(B2, O2).ok, 'two lines');
  const l1 = s5.lineLetter(I1);
  A.ok(s5.setPropLabel(I1, 'Research').ok && s5.setPropLabel(I2, l1).ok, 'I1 is Research, I2 takes I1\'s letter ' + l1);
  A.ok(s5.setPropLabel(I1, '').ok, 'I1\'s name is cleared');
  A.ok(s5.lineName(I1) !== s5.lineName(I2), 'the two lines never show the same name — ' + s5.lineName(I1) + ' / ' + s5.lineName(I2));
  A.eq(s5.lineName(I1), 'LINE ' + l1 + ' 2', '…the cleared line steps past the named LINE ' + l1);
}
{
  // (3) one line, two INBOXes, only the first named: the second's letter is no one's name, and the line is listed once
  const s6 = fresh(), I1 = add(s6, 'intake', 32, 4), I2 = add(s6, 'intake', 32, 14), B = add(s6, 'bay', 44, 8), O = add(s6, 'outbox', 58, 8);
  s6.assignPropAgent(B, 'agent');
  A.ok(s6.connectBelt(I1, B).ok && s6.connectBelt(I2, B).ok && s6.connectBelt(B, O).ok && s6.setPropLabel(I1, 'Research').ok, 'Research, with a second unnamed INBOX');
  const L2 = add(s6, 'intake', 32, 40), B2 = add(s6, 'bay', 44, 40), O2 = add(s6, 'outbox', 58, 40); s6.assignPropAgent(B2, 'agent');
  A.ok(s6.connectBelt(L2, B2).ok && s6.connectBelt(B2, O2).ok, 'a second line');
  const hidden = s6.lineLetter(I2);
  A.eq(s6.lineName(I2), 'LINE RESEARCH', 'the second INBOX shows its line\'s name, never LINE ' + hidden);
  A.ok(!s6.lineNameTaken(hidden), 'so "' + hidden + '" is no one\'s name');
  const nm = s6.setPropLabel(L2, hidden);
  A.ok(nm.ok, 'the other line may be called "' + hidden + '" (it was refused: "Another line is already called LINE ' + hidden + '") — ' + (nm.msg || ''));
  A.ok(s6.setPropLabel(L2, '').ok, '(cleared again)');
  const miss = SB.lineRef(s6.serialize(), env, 'Newsletter');
  A.ok(!miss.ok && /Lines: Research, LINE [A-Z]+\.$/.test(miss.error) && !/LINE RESEARCH/.test(miss.error), 'the lead\'s list names the two-INBOX line once — ' + miss.error);
  const m = SB.mapOf(s6.serialize(), env), room = m.ok && m.map.rooms.find(r => (r.lines || []).indexOf('Research') >= 0);
  A.ok(room && room.lines.filter(x => /RESEARCH/i.test(x)).length === 1, 'station.map lists it once in its room — ' + JSON.stringify(room && room.lines));
}
{
  // (4) the placement ghost: connectionPreview entries carry propId, not id — "WILL CONNECT TO LINE null" (M17's symptom)
  const build = src('build.js'), grab = head => { const i = build.indexOf(head); return build.slice(i, build.indexOf('\n  }', i) + 4); };
  const s7 = fresh(), I = add(s7, 'intake', 32, 4);
  A.ok(s7.placeBeltRun({ tx: 34, ty: 4 }, { tx: 40, ty: 4 }).ok, 'a loose belt out of an unnamed INBOX');
  const links = s7.connectionPreview({ props: [{ t: 'bay', x: 41, y: 4, w: 2, h: 2 }] });
  A.ok(links.length === 1 && links[0].propId === I && links[0].id === undefined, 'rig: the preview names the INBOX by propId');
  const ctx = vm.createContext({ station: s7, Pipeline: P, agentLabelFor: a => a, propLabel: t => t });
  vm.runInContext(grab('  function lineWordOf(ip) {') + '\n' + grab('  function linkNames(links) {'), ctx);
  A.eq(ctx.linkNames(links), s7.lineName(I), 'the ghost says WILL CONNECT TO ' + s7.lineName(I) + ' — never LINE null');
  A.eq(ctx.lineWordOf(I), s7.lineName(I), '…lineWordOf takes a bare INBOX id too');
  // FIRST SHIP: the toast names the line by lineName (its first NAMED INBOX), never the first INBOX in geo order or a raw key.
  // (conveyor-final merge, decision d: FIRST SHIP comes from the executor's shipment receipt — world.js noteFirstShip calls
  // build.js noteLineShipped(outboxId, lineId) — and the old crate-animation noteLineDelivered(wtx, wty) is gone on purpose)
  const s8 = fresh(), J1 = add(s8, 'intake', 32, 4), J2 = add(s8, 'intake', 32, 14), JB = add(s8, 'bay', 44, 8), JO = add(s8, 'outbox', 58, 8);
  A.ok(s8.connectBelt(J1, JB).ok && s8.connectBelt(J2, JB).ok && s8.connectBelt(JB, JO).ok && s8.setPropLabel(J2, 'Second door').ok, 'a line whose SECOND INBOX is named');
  const shipSrc = grab('  function noteLineShipped(outboxId, lineId) {');
  A.ok(shipSrc.length > 200 && shipSrc.length < 4000, 'sliced noteLineShipped (' + shipSrc.length + ' chars)');
  const fin = {}, nctx = vm.createContext({ station: null, opts: { getStation: () => s8 }, Pipeline: P, finRead: () => fin, finMark: (st, k, f) => { fin[k] = Object.assign({}, fin[k], { [f]: 1 }); }, running: false, renderFinCard() {} });
  vm.runInContext(shipSrc, nctx);
  const geo = s8.projectGeometry(), c = P.lineComponents(geo)[0];
  A.ok(c && c.outboxes.includes(JO) && c.intakes.includes(J1) && c.intakes.includes(J2), 'rig: one line, two INBOXes, its OUTBOX');
  A.eq(s8.lineName(c.key), 'LINE SECOND DOOR', 'rig: the floor calls the line by its first NAMED INBOX');
  A.eq(nctx.noteLineShipped(JO, 'p-elsewhere'), null, 'a receipt whose OUTBOX now ends ANOTHER line claims nothing');
  A.eq(nctx.noteLineShipped('p-gone', c.key), null, 'a receipt whose OUTBOX is no longer on the floor claims nothing');
  const rec = nctx.noteLineShipped(JO, c.key);
  A.ok(rec && rec.first && rec.name === 'LINE SECOND DOOR', 'FIRST SHIP · LINE SECOND DOOR (it said LINE <the first INBOX\'s letter>) — ' + JSON.stringify(rec && rec.name));
  A.ok(rec && rec.name === s8.lineName(c.key), '…the very word the floor shows (station.lineName), never the first INBOX in geo order (J1 is unnamed)');
  A.ok(fin[c.key] && fin[c.key].shipped === 1, 'the line\'s FIRST SHIP is spent in the finish register');
  A.eq(nctx.noteLineShipped(JO, c.key), null, 'a second receipt of the same line: no second FIRST SHIP');
  A.ok(!/'LINE '\s*\+\s*c\.key/.test(shipSrc), '…and never a raw line key');
  A.ok(!/function noteLineDelivered\(/.test(build), 'the crate-animation FIRST SHIP (noteLineDelivered) is gone — a crate reaching the OUTBOX is no shipment');
  const world = src('world.js'), fsAt = world.indexOf('  function noteFirstShip(p) {'), firstShip = fsAt < 0 ? '' : world.slice(fsAt, world.indexOf('\n  }', fsAt) + 4);
  A.ok(/Build\.noteLineShipped\(p\.outboxId, id\)/.test(firstShip) && /p\.box !== 'line-output'/.test(firstShip), 'world.js asks noteLineShipped only from the executor\'s line-output receipt (its OUTBOX, its line)');
  A.ok(/'FIRST SHIP · ' \+ \(lineNameOf\(id\) \|\| receipt\.name\)/.test(firstShip), 'the toast says the floor\'s name for the line');
}
{
  // (5) a job's FROM / SENT ON TO end ({ line, jobId, name } — no lineId) is named by the floor: Workflows window, DELIVERABLES, the crate
  const wfw = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'workflows.js'), 'utf8');
  const ob = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'outbox.js'), 'utf8');
  const hr = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'routing', 'handoff-runner.js'), 'utf8');
  A.ok(/const lineWord = e => \{ const st = stationOf\(\), w = e && e\.line != null && st && st\.lineName \? st\.lineName\(e\.line\) : null; return w \|\| P\(\)\.lineWord\(e && e\.name, 'another line'\); \};/.test(wfw) && !/e\.lineId/.test(wfw), 'Workflows window: a job end by st.lineName(e.line) (e.lineId never existed)');
  A.ok(/const w = e && e\.line != null && st && typeof st\.lineName === 'function' \? st\.lineName\(e\.line\) : null;/.test(ob) && /word = e => lineOfEnd\(e\)/.test(ob) && !/e\.lineId/.test(ob), 'DELIVERABLES: FROM / SENT ON TO by the floor\'s line name');
  A.ok(/preview: \('FROM ' \+ \(floorWord\(plan, item\.fromLine\) \|\| Pipeline\.lineWord\(item\.fromName, 'ANOTHER LINE'\)\)\)/.test(hr) && /P?ipeline\.lineNames\(/.test(hr), 'the hand-off crate says FROM <the floor\'s word> (Pipeline.lineNames over the plan)');
}

/* ---------- E. the Workflows window names a new line by the floor's own key, and says the name it STORED (M18) ---------- */
(async () => {
  const st = WM.create(WM.starterDoc()), z = st.rooms()[0].rects[0];
  A.ok(st.addRoom({ kind: 'hab', rect: { x1: z.x2 + 1, y1: z.y1, x2: z.x2 + 70, y2: z.y1 + 50 } }).ok, 'room for several lines');
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Set, Map, encodeURIComponent,
    U: { bus: { on: () => {} } }, module: { exports: {} }, window: {}, document: { activeElement: null, querySelector: () => null },
    StationUI: { registerWindow: () => {}, openTerm: () => {}, h: { present: [{ id: 'nova', name: 'NOVA' }], sfx() {}, notify() {}, navigateWork() {} } },
    App: { station: () => st }, Pipeline: P, WorkflowLine: W, LineEdit: LE, WorldModel: WM,
    Build: { nagWhy: c => c, lineSchematic: () => null, machineStill: () => '', lineWords: () => ({ plain: { research_line: 'Research + write' }, purpose: {} }) },
    World: { syncPlan: () => Promise.resolve({ errors: [] }), bayLive: () => null },
    ReturnStore: { foldRow: () => true, pendingRows: () => [] },
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, jobs: [] }) }),
  });
  require('./helpers/frontend-esc.js').installEsc(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'workflows.js'), 'utf8'), ctx, { filename: 'workflows.js' });
  const WW = ctx.module.exports, S = WW._state;
  const make = name => { WW._pick('research_line'); S.draft.name = name; const had = new Set(st.props().map(p => p.id)); WW._create(); return st.props().find(p => p.t === 'intake' && !had.has(p.id)); };
  const r1 = make('Research');
  A.ok(r1 && r1.label === 'Research', 'a line called Research');
  const r2 = make('Line Research');
  A.ok(r2 && r2.label === 'Line Research 2', '"Line Research" beside Research is Line Research 2 (both would SHOW as LINE RESEARCH) — ' + (r2 && r2.label));
  A.ok(S.msg && /^✓ Line Research 2 is on your floor/.test(S.msg.text), '…and the window says the name the floor stored — ' + (S.msg && S.msg.text));
  const r3 = make('Spare'); A.ok(r3 && st.setPropLabel(r3.id, '').ok, 'a line left unnamed');
  const letter = st.lineLetter(r3.id);
  const r4 = make(letter);
  A.ok(r4 && r4.label === letter + ' 2', 'a new workflow named "' + letter + '" beside the unnamed LINE ' + letter + ' is ' + letter + ' 2 — ' + (r4 && r4.label));
  const shown = st.props().filter(p => p.t === 'intake').map(p => st.lineName(p.id));
  A.eq(new Set(shown).size, shown.length, 'every line shows a different name — ' + JSON.stringify(shown));
  A.report('line-names.test');
})().catch(e => { console.error(e); process.exit(1); });

