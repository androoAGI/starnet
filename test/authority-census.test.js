/* node test/authority-census.test.js — the surface x origin x role x tool authority matrix, ONE projection, and declared
   impact (authority-census lane, TIER 1: zero authority change; 2026-10-30. Re-captured on the v0.14.2 merge-back,
   2026-11-01, for one recorded move: Andrew kept 0.14.2's stricter readers, A5-Q2/Q3).

   WHAT IS LOCKED
   1. SNAPSHOT. test/fixtures/authority-matrix.json is the matrix captured on 9d5481215d84c29da105ed7216964d216bb13ecd
      (the v0.14.2 release merged back into trunk d0e579a61): 71 scenarios — every origin that starts a run (the call
      site each copies is named in test/helpers/authority-census.js ORIGINS) x ASK / FULL POWER, plus host-fact variants —
      and for each one the ordered grant, the ordered advertised and deferred wire lists, which withheld tools carry an
      explanation, which are certainly unavailable, and one row per tool the room offered: state (advertised / deferred /
      granted / withheld), impact class, consent class, grant source and limiting reason. Nothing was transcribed by hand:
      it is cellsFromRunOnce(runOnceMatrix) of every scenario through encodeMatrix, as JSON.stringify(x, null, 1).
      HISTORY. test/fixtures/authority-matrix.748b0462595.json is the capture it replaced, unchanged and pinned by hash: the
      same matrix on 748b0462595530c190acda10b703243d413939b4 (run-wire's final tip, before this lane moved anything). The
      snapshot cuts a runOnceCore that already asks projectTools, so alone it could not show the move was faithful. The
      history still does: THE RECORDED MOVE below requires history + the list = snapshot, with an empty diff.
      WHAT WAS EXECUTED ON THE BASE, AND WHAT WAS NOT. In the history, the ordered lists, the room and the step that put
      each object in it come from EXECUTING the base runOnceCore tool assembly: cut out of that tree's sidecar/index.js
      between fixed anchors and run in a vm with each scenario's host facts over the base's own tool factories
      (runOnceMatrix). The per-tool ROWS do not: 748b0462595 has no row classifier, so each row's state, consent class,
      limiting reason, why and grant source is this lane's rowsOf (capability/project-tools.js: consentClassOf, limitOf)
      applied to those base-executed outputs (cellsFromRunOnce). The row half of the empty diff below therefore compares the
      lane's classifier with itself, and cannot catch a defect that was already in rowsOf when the history was captured.
      What holds the rows to policy independently of rowsOf: (a) ROWS AGREE WITH THE LISTS, in every scenario of both
      captures (a row's state is the list it sits in, a `why` is exactly a withheld explanation, an unavailable reason is
      exactly an unavailable tool); (b) named rows pinned to literal values hand-checked against the declarations
      (tools/builtin shell.js, terminal.js, web.js, comms.js, fs.js: 748b0's, and 0.14.2's for the four readers), the broker
      key (permissions.js dangerKey, unchanged since 748b0 but for its export) and the run authority (inputpolicy.js
      makeRunAuthority, unchanged since 748b0, asked directly below, not through limitOf).
   2. ONE PURE PROJECTION. sidecar/capability/project-tools.js projectTools(agent, origin, role, facts) is that assembly,
      moved; runOnceCore, GET /api/toolsets (its `run` preview) and a channel's /tools now ask it. This test recomputes the
      whole matrix twice — through projectTools directly, and through THIS tree's runOnceCore cut (which now calls it) —
      and requires both to equal the snapshot cell for cell. An empty diff is the whole claim: any non-empty cell is a bug,
      or a policy change nobody recorded; one needs Andrew's ruling and a re-capture that records its list, as below.
      Three mutations prove the instruments bite (a declaration, a runOnce source edit and a wrong move list).
   3. THE DECLARED CATALOGUE. sidecar/tools/catalog.js — the host tools a readout projects over — is locked to the
      factories runOnceCore actually calls. (Declared impact and register()'s refusal: test/register-impact.test.js.)

   PRESERVED (A5 preserve list): FULL POWER host-wide semantics and origin withholding (channel.guest / facts.bypass.guest
   keep the unattended floor); delegated ASK worker shell policy (worker@ask: no shell.exec, and since the recorded move no
   terminal reads either); per-routine and per-key grants (routine.schedule.granted); owner direct orchestration; run-wire's
   manual-routine identity (routine.manual: routine.notepad is a routine run); group/widget scope; connector provenance
   (mcp__/plugin__ tools keep external-unknown, fail closed). The one thing that moved on purpose is below.

   ---- MERGED WITH agent/release-0142: THE RECORDED MOVE (re-captured 2026-11-01, Andrew's A5-Q2/Q3 ruling) ----
   0.14.2 declares terminal.read, terminal.status, shell.bg.read and channel.targets external-unknown (2aff904d5, the lane
   they fell into in 0.14.1). The history has them impact none, which is looser and never shipped. Andrew ruled that trunk
   keeps the release's class, so the snapshot takes it: a watched run asks an exact per-call confirmation, an unattended ASK
   run is not offered them (a routine granted the terminal included), and an owner DM or Full Access keeps them.
   From the history to the snapshot, 281 cells moved in 69 scenarios, all on those four tools: 247 rows and 34 lists.
   desktop.bare@ask and widget.update@ask did not move: their rooms offer none of the four.
   - CLASS ONLY, still offered in the same state, in 50 scenarios each (200 rows): impact none -> external-unknown, consent
     none -> exact:workbench:read (the three workbench readers) / exact:comms:read (channel.targets).
   - WITHHELD, the same class move and advertised -> withheld, reason authority:external-unknown (43 rows): terminal.read,
     terminal.status and shell.bg.read in facts.profile.trusted@ask, line.hop.guest@ask / @full, routine.bay@ask,
     routine.line.hop@ask, routine.manual@ask, routine.schedule.granted@ask, worker@ask and worker.builder@ask (9 each);
     channel.targets in the same ones except routine.line.hop@ask (no dish there), plus api.v1@ask, channel.guest@ask
     / @full, facts.bypass.guest@ask, loop@ask, routine.schedule@ask, routine.widget@ask and trigger.entry@ask (16).
   - ALREADY WITHHELD, in routine.schedule.toolsets@ask (all four, 4 rows): the same class move, reason routine-toolsets ->
     authority:external-unknown, because the run authority now removes them first.
   - LISTS: granted and advertised in each of the 17 scenarios above that lost a reader (34 lists), which only lose it.
   Nothing else moved, and the check named THE RECORDED MOVE below applies exactly this list to the history and requires an
   empty diff with the snapshot: another move is a finding for Andrew, never a reason to capture again. What pins the class:
   the worker@ask and desktop.floor@ask terminal.read named cells, the reader pins in (b), check (c) and MUTATION 1, which
   declares terminal.read none again and must put back the history's row. test/register-impact.test.js holds every
   declaration to the snapshot's class, and to the history's for every tool but these four.

   ---- TIER-2 PROPOSAL FOR ANDREW (NOT CODE: no cell below is changed by this lane) ----
   Computed by projecting the same 71 scenarios with each rule applied to a scratch copy of the projection, diffed against
   the history, before the recorded move.

   A. Spec step 6 — derive orchestrator authority from the run's ROLE (owner-DM direct keeps it; line stages and hops drop
      it; narrowing only). Exactly four cells move; nothing is gained anywhere:
        line.entry.owner@ask, line.entry.owner@full, line.hop@ask, line.hop@full each LOSE the 33 orchestrator tools —
        team.dispatch / spawn / summon / subagents / steer / interrupt / resume, routine.list / create / manage,
        session.list / create / peek / focus, task.list / create / manage, team.config / configure, station.status /
        layout / map / plan / build / make_prop / test_line / start_line / settings / control / power, loop.list /
        create / manage.
      Unchanged: channel.owner* and channel.bay (owner DM direct), remote.phone* , desktop / editor / group leads, every
      worker (already lead-less), every routine. Under FULL POWER the same 33 drop for a line role (the sweep's
      `role.lead || ownerTrusted` clause would read the role, not the ingress). Today a line stage reached through an owner
      DM can re-delegate and reconfigure the station because hub.js carries ownerTrusted into it (a5 R4).
   B. Spec step 4 — an origin table on the SAVED floor instead of the hard-coded offices (A5-Q4). Today every headless
      origin (channel.*, line.*, routine.*, loop, api.v1, trigger.entry, worker*) is handed office/composeOffice's full
      default office — computer, dish, cabinet, notebook, studio, jukebox — whatever the agent's saved floor holds: 76 tools
      in ASK (75 since the recorded move, which withholds channel.targets there), 86 when the jukebox clears (owner DM,
      FULL POWER). The editor / CLI copy a coding office (acp/serve.js, bin/lib/cli-core.js: computer, cabinet, workbench,
      dish, notebook) and a worker its WORKER_KIT. A saved-floor-only table would replace each with the agent's saved
      placement, so for an agent with an empty saved floor a scheduled routine would lose web (dish: 42 tools incl.
      web_request and the browser), files (cabinet: 7), memory (notebook: 10), studio (6) and jukebox (8); the editor would
      lose its terminal unless a workbench is placed. Which origins keep which exception (CLI/editor, headless, worker,
      owner DM, group) is Andrew's call; the per-agent diff is the matrix this test prints with the rule applied.
   C. Not proposed here (OUT OF SCOPE until Andrew answers): A5-Q1 AUTO terminology, Q6 exact-call Always / session / Full
      choices. Q2/Q3, the four readers' class, is answered: the recorded move above. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const C = require('./helpers/authority-census.js');
const { sidecarTopLevelFunction, readSidecarIndex } = require('./helpers/source');
const { IMPACTS } = require('../sidecar/inputpolicy.js');
const Catalog = require('../sidecar/tools/catalog.js');

const ROOT = path.resolve(__dirname, '..');

// the four readers of THE RECORDED MOVE (see the header), and the exact confirmation each one asks a watched run for
const READER_CONSENT = { 'terminal.read': 'exact:workbench:read', 'terminal.status': 'exact:workbench:read', 'shell.bg.read': 'exact:workbench:read', 'channel.targets': 'exact:comms:read' };
const READERS = Object.keys(READER_CONSENT);

(async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'authority-matrix.json'), 'utf8'));
  A.eq(fixture.capturedOn, '9d5481215d84c29da105ed7216964d216bb13ecd', 'the snapshot was captured on the v0.14.2 merge-back (the release merged into trunk d0e579a61)');
  const snapshot = C.decodeMatrix(fixture);
  A.eq(fixture.history, 'authority-matrix.748b0462595.json', 'the snapshot names the capture it replaced');
  const historyFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', fixture.history), 'utf8'));
  A.eq(historyFixture.capturedOn, '748b0462595530c190acda10b703243d413939b4', 'the history was captured on run-wire\'s final tip, before this lane moved anything');
  A.eq(crypto.createHash('sha256').update(JSON.stringify(historyFixture)).digest('hex'), '5f421654398905b414ff78681b8732ea19e727126ade768d4c506fa129387481', '...and is kept unchanged');
  const history = C.decodeMatrix(historyFixture);
  const ids = C.scenarios().map(s => s.id);
  A.eq(Object.keys(snapshot).sort(), ids.slice().sort(), 'the snapshot holds every scenario the census defines (' + ids.length + ')');
  A.ok(ids.length >= 70, 'the matrix covers every origin x posture plus the host-fact variants');
  A.eq(C.diffMatrix(snapshot, C.decodeMatrix(C.encodeMatrix(snapshot, {}))), [], 'the fixture packing round-trips');

  // ---- 2. the move: the projection and this tree's runOnce both reproduce every cell ----
  const viaProjection = {}, viaRunOnce = {};
  for (const s of C.scenarios()) {
    viaProjection[s.id] = await C.projectMatrix(ROOT, s);
    const cap = await C.runOnceMatrix(ROOT, s);
    A.eq(cap.failNotes, [], s.id + ': the runOnce assembly ran without a fail-open note');
    A.ok(cap.out.projection && cap.out.projection.rows, s.id + ': this tree\'s runOnceCore decides its tools through ProjectTools.projectTools');
    viaRunOnce[s.id] = C.cellsFromRunOnce(cap, ROOT);
  }
  const d1 = C.diffMatrix(snapshot, viaProjection);
  A.eq(d1.length, 0, 'projectTools reproduces the captured matrix: an EMPTY diff (' + d1.slice(0, 6).join(' | ') + ')');
  const d2 = C.diffMatrix(snapshot, viaRunOnce);
  A.eq(d2.length, 0, 'runOnceCore (which now calls projectTools) reproduces it too: an EMPTY diff (' + d2.slice(0, 6).join(' | ') + ')');

  // ---- THE RECORDED MOVE: the history plus the header's list IS the snapshot, so nothing else can ride a re-capture ----
  {
    const WORKBENCH_WITHHELD = ['facts.profile.trusted@ask', 'line.hop.guest@ask', 'line.hop.guest@full', 'routine.bay@ask', 'routine.line.hop@ask', 'routine.manual@ask', 'routine.schedule.granted@ask', 'worker@ask', 'worker.builder@ask'];
    const DISH_WITHHELD = WORKBENCH_WITHHELD.filter(id => id !== 'routine.line.hop@ask').concat(['api.v1@ask', 'channel.guest@ask', 'channel.guest@full', 'facts.bypass.guest@ask', 'loop@ask', 'routine.schedule@ask', 'routine.widget@ask', 'trigger.entry@ask']);
    A.eq([WORKBENCH_WITHHELD.length, DISH_WITHHELD.length], [9, 16], 'the list withholds the workbench readers in 9 scenarios and channel.targets in 16');
    const authorityReason = 'authority:' + IMPACTS.EXTERNAL_UNKNOWN;
    const applyMove = (matrix, forgotten) => {
      const out = JSON.parse(JSON.stringify(matrix));
      for (const id of Object.keys(out)) for (const name of READERS) {
        const row = out[id].rows[name];
        if (!row) continue;
        row.impact = IMPACTS.EXTERNAL_UNKNOWN;
        row.consent = READER_CONSENT[name];
        if (id !== forgotten && (name === 'channel.targets' ? DISH_WITHHELD : WORKBENCH_WITHHELD).indexOf(id) >= 0) {
          row.state = 'withheld';
          row.reason = authorityReason;
          out[id].granted = out[id].granted.filter(n => n !== name);
          out[id].advertised = out[id].advertised.filter(n => n !== name);
        } else if (row.reason === 'routine-toolsets') {
          row.reason = authorityReason;
        }
      }
      return out;
    };
    const d = C.diffMatrix(applyMove(history), snapshot);
    A.eq(d.length, 0, 'the history plus the recorded move is the snapshot: an EMPTY diff (' + d.slice(0, 6).join(' | ') + ')');
    const moved = C.diffMatrix(history, snapshot);
    A.eq(moved.length, 281, 'history -> snapshot moved 281 cells');
    A.eq(new Set(moved.map(l => l.split(' ')[0])).size, 69, '...in 69 scenarios');
    A.eq(moved.filter(l => !/^\S+ (?:granted|advertised|terminal\.read|terminal\.status|shell\.bg\.read|channel\.targets):/.test(l)), [], '...each a row of the four readers, or a grant or advertised list that lost one');
    const wrongList = C.diffMatrix(applyMove(history, 'worker@ask'), snapshot);
    A.ok(wrongList.some(l => /^worker@ask /.test(l)), 'MUTATION 3 (a move list that forgets worker@ask) is a non-empty diff: ' + wrongList.slice(0, 2).join(' | '));
  }

  // the cells that carry the preserved policy, named so a reader sees what the empty diff protects
  const cell = (id, name) => snapshot[id].rows[name] || { state: 'absent' };
  A.eq(cell('worker@ask', 'shell.exec').state, 'withheld', 'delegated ASK worker: no shell, WORKBENCH or not');
  A.eq(cell('worker@ask', 'shell.exec').reason, 'authority:workspace-process', '...withheld by the run authority, and explained');
  A.ok(/delegated by leadagent/.test(cell('worker@ask', 'shell.exec').why || ''), '...with the delegated-command-gap remedy (issue #77)');
  A.eq(cell('worker@ask', 'terminal.read').state, 'withheld', 'delegated ASK worker: no terminal readers either (0.14.2\'s class, Andrew\'s A5-Q2/Q3 ruling)');
  A.eq(cell('worker@ask', 'terminal.read').reason, 'authority:external-unknown', '...withheld by the run authority as an unknown external effect');
  A.eq(cell('routine.schedule.granted@ask', 'shell.exec').state, 'advertised', 'a routine granted the terminal gets shell.exec');
  A.eq(cell('routine.schedule@ask', 'shell.exec').state, 'absent', '...and an ungranted one does not (its office has no workbench to grant one)');
  A.eq(cell('routine.bay@ask', 'shell.exec').reason, 'authority:workspace-process', '...nor does one whose bay holds a workbench: the run authority withholds it');
  A.eq(cell('routine.schedule.granted@ask', 'mcp__gh__create_issue').state, 'advertised', 'the connectors grant reaches real connector tools');
  A.eq(cell('routine.schedule@ask', 'mcp__gh__create_issue').reason, 'authority:external-unknown', '...an ungranted routine never does');
  A.eq(cell('channel.guest@full', 'shell.exec').state, 'absent', 'FULL POWER follows the owner: a channel guest on a Full Access agent has no terminal');
  A.eq(cell('facts.bypass.guest@ask', 'shell.exec').state, 'absent', '...nor under the station master bypass');
  A.eq(cell('channel.owner@ask', 'team.dispatch').state, 'deferred', 'owner DM direct keeps lead orchestration (deferred while crewless)');
  A.ok(['advertised', 'deferred'].indexOf(cell('line.hop@ask', 'team.dispatch').state) >= 0, 'a hop of an owner-DM line still holds it (Tier-2 proposal A, unchanged here)');
  A.eq(cell('routine.manual@ask', 'routine.notepad').state, 'advertised', 'a Run Now routine is a routine run (run-wire\'s manual-routine identity)');
  A.eq(cell('desktop.floor@ask', 'routine.notepad').reason, 'unavailable:routine-run', '...a desk run is not');
  A.eq(cell('desktop.bare@ask', 'computer.use').state, 'absent', 'no physical input without the desktop lease');
  A.eq(cell('remote.phone.desktop@ask', 'computer.use').source, 'desktop-lease', 'the paired owner phone\'s lease is a host injection');
  A.eq(cell('group.lead@ask', 'team.dispatch').state, 'absent', 'a group turn trades team.*/session.* for its own scoped closures');
  A.eq(cell('group.lead@ask', 'group.handoff').source, 'group-turn', '...whose source is the live group turn');
  A.eq(cell('widget.update@ask', 'widget.set').source, 'widget-scope', 'the widget\'s own run gets its two widget tools');
  A.eq(cell('facts.plugin@ask', 'plugin__p1__ping').impact, 'external-unknown', 'a plugin tool keeps the connector trust class');
  A.eq(cell('desktop.floor@ask', 'channel.send').consent, 'exact:comms:execute', 'channel.send is an exact per-call confirmation');
  A.eq(cell('desktop.floor@ask', 'mcp__gh__create_issue').consent, 'broker:mcp:gh:execute', 'a real connector rides the standing-grant broker');
  A.eq(cell('desktop.floor@ask', 'terminal.read').impact, IMPACTS.EXTERNAL_UNKNOWN, 'terminal.read is external-unknown (0.14.2\'s class, Andrew\'s A5-Q2/Q3 ruling)');
  A.eq(cell('desktop.floor@ask', 'terminal.read').consent, 'exact:workbench:read', '...so a watched run asks an exact per-call confirmation for it');

  // ---- the rows, held to policy WITHOUT rowsOf (see WHAT WAS EXECUTED ON THE BASE above) ----
  // (a) ROWS AGREE WITH THE LISTS: the lists are executed (in the history, by the base), so a row may only restate them
  const rowsOffTheLists = (matrix) => {
    const off = [];
    for (const id of Object.keys(matrix)) {
      const m = matrix[id];
      const adv = new Set(m.advertised), def = new Set(m.deferred), gr = new Set(m.granted), wx = new Set(m.withheldExplained), un = new Set(m.unavailable);
      for (const n of Object.keys(m.rows)) {
        const r = m.rows[n];
        if ((r.state === 'advertised') !== adv.has(n)) off.push(id + ' ' + n + ': advertised row <-> advertised list');
        if ((r.state === 'deferred') !== (def.has(n) && !adv.has(n))) off.push(id + ' ' + n + ': deferred row <-> deferred list');
        if (r.state === 'granted' && !(gr.has(n) && !adv.has(n) && !def.has(n))) off.push(id + ' ' + n + ': granted row is granted and not on the wire');
        if (r.state === 'withheld' && (adv.has(n) || def.has(n))) off.push(id + ' ' + n + ': a withheld row is on the wire');
        if ((r.why != null) !== wx.has(n)) off.push(id + ' ' + n + ': a why <-> a withheld explanation');
        if (/^unavailable:/.test(r.reason || '') !== (un.has(n) && r.state === 'deferred')) off.push(id + ' ' + n + ': an unavailable reason <-> an unavailable tool');
        if ((r.state === 'withheld' || r.state === 'deferred') !== !!r.reason) off.push(id + ' ' + n + ': a reason exactly when withheld or deferred');
        if (/^authority:/.test(r.reason || '') && r.reason !== 'authority:' + r.impact) off.push(id + ' ' + n + ': an authority reason names the row\'s own impact');
      }
      for (const n of m.granted.concat(m.advertised, m.deferred, m.withheldExplained, m.unavailable)) if (!m.rows[n]) off.push(id + ' ' + n + ': a listed tool has no row');
    }
    return off;
  };
  A.eq(rowsOffTheLists(snapshot), [], 'in all ' + ids.length + ' scenarios every row restates the executed lists, and every listed tool has a row');
  A.eq(rowsOffTheLists(history), [], '...and in the history, whose lists the base executed');
  // (b) named rows, literal values hand-checked against the declarations and policy (748b0's; 0.14.2's for the readers):
  //   shell.exec / terminal.start: workbench, scope execute, workspace-process, requiresConsent  -> broker:workbench:execute
  //   terminal.read / status, shell.bg.read: workbench, scope read, external-unknown, not a connector -> exact:workbench:read
  //   channel.targets: comms, scope read, external-unknown, not a connector                      -> exact:comms:read
  //   web_request: web, scope write, external-credentialed, requiresConsent                      -> broker:web:write
  //   web_search: web, scope read, no consent (impact inferred external-service)                 -> none
  //   fs.write: cabinet, scope write, requiresConsent (impact inferred none)                     -> broker:cabinet:write
  //   channel.send: comms, scope execute, external-unknown, not a connector                      -> exact:comms:execute
  //   (permissions.js dangerKey = capability + ':' + scope; inputpolicy.js authorize: a non-connector external-unknown
  //   call is a one-shot exact confirmation, never the standing-grant broker)
  {
    const pick = (r) => r.state === 'absent' ? r : { state: r.state, impact: r.impact, consent: r.consent, source: r.source, reason: r.reason || null };
    const pins = [
      ['desktop.floor@ask', 'shell.exec', 'advertised', 'workspace-process', 'broker:workbench:execute', 'workbench/placed', null],
      ['desktop.floor@ask', 'terminal.start', 'advertised', 'workspace-process', 'broker:workbench:execute', 'workbench/placed', null],
      ['desktop.floor@ask', 'terminal.read', 'advertised', 'external-unknown', 'exact:workbench:read', 'workbench/placed', null],
      ['desktop.floor@ask', 'terminal.status', 'advertised', 'external-unknown', 'exact:workbench:read', 'workbench/placed', null],
      ['desktop.floor@ask', 'shell.bg.read', 'advertised', 'external-unknown', 'exact:workbench:read', 'workbench/placed', null],
      ['desktop.floor@ask', 'channel.targets', 'advertised', 'external-unknown', 'exact:comms:read', 'dish/placed', null],
      ['desktop.floor@ask', 'web_request', 'advertised', 'external-credentialed', 'broker:web:write', 'dish/placed', null],
      ['desktop.floor@ask', 'web_search', 'advertised', 'external-service', 'none', 'dish/placed', null],
      ['desktop.floor@ask', 'fs.write', 'advertised', 'none', 'broker:cabinet:write', 'cabinet/placed', null],
      ['routine.schedule@ask', 'web_request', 'advertised', 'external-credentialed', 'broker:web:write', 'dish/office', null],
      ['routine.schedule@ask', 'channel.send', 'withheld', 'external-unknown', 'exact:comms:execute', 'dish/office', 'authority:external-unknown'],
      ['routine.schedule@ask', 'channel.targets', 'withheld', 'external-unknown', 'exact:comms:read', 'dish/office', 'authority:external-unknown'],
      ['routine.schedule@ask', 'fs.write', 'advertised', 'none', 'broker:cabinet:write', 'cabinet/office', null],
      ['routine.bay@ask', 'shell.exec', 'withheld', 'workspace-process', 'broker:workbench:execute', 'workbench/bay', 'authority:workspace-process'],
      ['routine.bay@ask', 'terminal.start', 'withheld', 'workspace-process', 'broker:workbench:execute', 'workbench/bay', 'authority:workspace-process'],
      ['routine.bay@ask', 'terminal.read', 'withheld', 'external-unknown', 'exact:workbench:read', 'workbench/bay', 'authority:external-unknown'],
      ['routine.schedule.granted@ask', 'shell.exec', 'advertised', 'workspace-process', 'broker:workbench:execute', 'workbench/routine-grant', null],
      ['routine.schedule.granted@ask', 'terminal.start', 'advertised', 'workspace-process', 'broker:workbench:execute', 'workbench/routine-grant', null],
      ['routine.schedule.granted@ask', 'terminal.read', 'withheld', 'external-unknown', 'exact:workbench:read', 'workbench/routine-grant', 'authority:external-unknown'],
      ['channel.owner@ask', 'terminal.read', 'advertised', 'external-unknown', 'exact:workbench:read', 'workbench/owner-dm', null],
      ['worker@full', 'terminal.read', 'advertised', 'external-unknown', 'exact:workbench:read', 'workbench/placed', null]
    ];
    for (const [id, name, state, impact, consent, source, reason] of pins) {
      A.eq(pick(cell(id, name)), { state, impact, consent, source, reason }, id + ' ' + name + ': the row is the hand-checked value');
    }
    A.eq(cell('routine.schedule@ask', 'shell.exec').state, 'absent', 'routine.schedule@ask: no workbench in the office and no grant, so no shell.exec row');
    A.eq(cell('routine.schedule@ask', 'terminal.start').state, 'absent', '...and no terminal.start row');
  }
  // (c) the limiting reasons, against the run authority itself (inputpolicy.js, unchanged since 748b0), not limitOf
  {
    const { makeRunAuthority } = require('../sidecar/inputpolicy.js');
    const reg = Catalog.buildCatalog();
    const tool = (n) => reg.get(n);
    const unattended = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: [] });
    const granted = makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: ['workbench'] });
    A.eq(['shell.exec', 'terminal.start', 'terminal.read', 'web_request', 'channel.send'].map(n => unattended.project(tool(n))), [false, false, false, true, false],
      'an ungranted unattended run: no host process, no unknown external effect, no terminal read; web requests stay (the routine.bay@ask / routine.schedule@ask rows)');
    A.eq(READERS.map(n => unattended.project(tool(n))), [false, false, false, false], '...and none of the four readers');
    A.eq(['shell.exec', 'terminal.start'].map(n => granted.project(tool(n))), [true, true], 'a routine granted the terminal is offered it (the routine.schedule.granted@ask rows)');
    A.eq(READERS.map(n => granted.project(tool(n))), [false, false, false, false], '...but not the readers: the grant starts a terminal, it does not read one');
    A.eq(READERS.map(n => makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: [], ownerTrusted: true }).project(tool(n))), [true, true, true, true], 'an owner DM keeps the four readers (the channel.owner@ask rows)');
    A.eq(READERS.map(n => makeRunAuthority({ surface: 'autonomous', isTask: true, unattendedGrants: [], fullAccess: () => true }).project(tool(n))), [true, true, true, true], '...and so does Full Access (the worker@full rows)');
    let asked = 0;
    const watched = makeRunAuthority({ surface: 'interactive', isTask: true, confirm: async () => { asked++; return 'always'; } });
    A.eq(watched.project(tool('channel.send')), true, 'a watched run is offered channel.send (desktop.floor@ask)');
    const auth = await watched.authorize({ id: 'c1', name: 'channel.send', args: {} }, tool('channel.send'));
    A.ok(auth && auth.ok === true && auth.oneShot === true && asked === 1, '...and a call is one exact confirmation even when the answer is "always": the exact: consent class, not broker:');
    for (const n of READERS) {
      asked = 0;
      A.eq(watched.project(tool(n)), true, 'a watched run is offered ' + n + ' (desktop.floor@ask)');
      const read = await watched.authorize({ id: 'c-' + n, name: n, args: {} }, tool(n));
      A.ok(read && read.ok === true && read.oneShot === true && asked === 1, '...and each call of it is one exact confirmation too, even when the answer is "always"');
    }
  }

  // ---- the instrument bites: a declaration change and a runOnce source change both show up as cells ----
  {
    const mutated = await C.projectMatrix(ROOT, C.scenarios().find(s => s.id === 'worker@ask'), {
      registry: (() => { const r = Catalog.buildCatalog(); const t = r.get('terminal.read'); t.impact = IMPACTS.NONE; return r; })()
    });
    const d = C.diffMatrix({ 'worker@ask': snapshot['worker@ask'] }, { 'worker@ask': mutated });
    A.ok(d.some(l => /terminal\.read/.test(l)), 'MUTATION 1 (terminal.read declared none again, the class 748b0 gave it) is a non-empty diff on worker@ask: ' + d.slice(0, 2).join(' | '));
    A.eq(mutated.rows['terminal.read'], history['worker@ask'].rows['terminal.read'], '...and puts back exactly the row the history holds');
  }
  {
    const s = C.scenarios().find(x => x.id === 'routine.schedule.granted@ask');
    const cap = await C.runOnceMatrix(ROOT, s, { extend: { normalizeUnattendedGrants: () => new Set() } });
    const d = C.diffMatrix({ [s.id]: snapshot[s.id] }, { [s.id]: C.cellsFromRunOnce(cap, ROOT) });
    A.ok(d.some(l => /shell\.exec/.test(l)), 'MUTATION 2 (runOnce drops the routine\'s recorded grants) is a non-empty diff: ' + d.slice(0, 2).join(' | '));
  }

  // ---- 3. the declared catalogue (tools/catalog.js) is the run's: every factory runOnceCore calls, nothing else ----
  // (declared impact itself, and register()'s refusal of an undeclared host tool: test/register-impact.test.js)
  const catalog = Catalog.buildCatalog();
  A.ok(catalog.list().length >= 140, 'the declared catalogue holds every host tool a run registers (' + catalog.list().length + ')');
  {
    const res = await Catalog.buildCatalog().dispatch({ id: 'x', name: 'fs.read', args: { path: 'a' } }, {});
    A.ok(res.isError && /catalogue declaration/.test(String(res.content)), 'a catalogue tool never runs, whoever dispatches it');
  }
  // the catalogue is the run's: every factory runOnceCore calls, and nothing else
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const called = Array.from(new Set((core.match(/\bmake[A-Z][A-Za-z]*Tools?\(/g) || []).map(m => m.slice(0, -1))));
    const alternates = ['makeCuaComputerTools'];   // the cua driver's computer.use: the same declaration as makeComputerTools
    const expected = called.filter(n => alternates.indexOf(n) < 0).concat(['makeWidgetTools']).sort();
    A.eq(Catalog.FACTORY_NAMES.slice().sort(), expected, 'tools/catalog.js builds exactly the factories runOnceCore registers (+ the module-level widget tools)');
    A.ok(/widgetTools\.register\(registry\)/.test(core) && /const widgetTools = makeWidgetTools\(/.test(readSidecarIndex()), 'the widget tools are the module-level makeWidgetTools a run registers');
    A.ok(/registerTaskBriefTools\(registry, /.test(core), 'the Task Brief controls a briefed run registers are in the catalogue too');
    A.eq(C.FACTORIES.map(f => f[0]).sort(), Catalog.FACTORY_NAMES.slice().sort(), 'the base list the history was captured with names the same factories');
  }

  // ---- the readouts ask the same projection ----
  {
    const idx = readSidecarIndex();   // deliberately index.js itself: these are its own wiring
    const core = sidecarTopLevelFunction('runOnceCore');
    A.ok(/let projection = ProjectTools\.projectTools\(projectionAgent, projectionOrigin, projectionRole, projectionFacts\);/.test(core), 'runOnceCore decides its tools with ProjectTools.projectTools');
    A.ok(/const deferredNames = projection\.deferredNames;/.test(core) && /const coreNames = projection\.coreNames;/.test(core), 'the wire lists are the projection\'s');
    const preview = sidecarTopLevelFunction('toolsetsPreview');
    A.ok(/ProjectTools\.projectTools\(\{ id: agentId \}, origin, role, facts\)/.test(preview) && /ToolCatalog\.buildCatalog\(\)/.test(preview)
      && /registerRoomTools\(registry, projectedStation, agentId, providerId\)/.test(preview), 'GET /api/toolsets previews a COMMS run through the same projection, catalogue and room tools');
    A.ok(/toolsetsPreview\(agentId, extraObjects, fromQuery \? 'query' : 'saved'\)/.test(sidecarTopLevelFunction('handleToolsetsList')), 'handleToolsetsList answers with that preview');
    A.ok(/ProjectTools\.projectStation\(/.test(sidecarTopLevelFunction('runSlashForChannel')), 'a channel\'s /tools reads the room from the same projection');
    A.ok(/projectionFacts\.dynamicTools = await registerRoomTools\(registry, projectedStation, agentId, providerId\);/.test(core), 'the run registers its room\'s connector/plugin tools through the one shared helper');
    A.ok(!/composeOffice\(|stationWithObject\(|enforceRunAuthority\(|withheldCommandTools\(/.test(idx), 'index.js keeps no second copy of the office, augmentation, authority or withheld assembly');
  }

  A.report('authority-census.test');
})().catch(e => { console.error('FAIL: authority-census.test threw — ' + (e && e.stack || e)); process.exit(1); });
