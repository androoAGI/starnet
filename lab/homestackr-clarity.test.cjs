'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const WM = require('../frontend/app/worldmodel.js');
const { create } = require('./workflow.cjs');
const { prepare: author } = require('./colony-authoring.cjs');
const { prepare } = require('./homestackr-clarity.cjs');
const H = require('../frontend/app/homestackr-workflows.js');
const { PROCESSES } = require('../sidecar/colony/catalog.js');

function fixture() {
  const st = WM.create(WM.starterDoc()), spec = require('./fixtures/lifestruct.json');
  create(st, spec, new Set(spec.steps.map(s => s.agentId)));
  const built = author({ _saveRevision: 47, agent: { id: 'agent' }, agents: [{ id: 'life_content' }, { id: 'life_review' }], station: st.serialize(), workstreams: [{ id: 'keep-chat', messages: ['preserve'] }] });
  const save = built.save;
  save.colonyInstallation = { commitId: 'test-installation' };
  // A legacy pipeline remains byte-for-byte untouched by the migration.
  save.station.props.push({ id: 'legacy-marker', t: 'desk', x: 0, y: 0, label: 'Keep legacy work' });
  for (const [id, mapping] of Object.entries(built.mappings).filter(([id]) => /^H/.test(id))) {
    for (const [i, pid] of mapping.steps.entries()) {
      const prop = save.station.props.find(p => p.id === pid), role = PROCESSES[id].roles[i];
      prop.label = role;
      prop.brief = 'Marke HomeStackR, Ablauf ' + id + '. Fachaufträge nur über die Business-Steuerung mit Versions-/Budgetnachweisen ausführen. Kein Versand, Upload oder Veröffentlichen. ' + (role === 'review' ? 'Unabhängig prüfen; nicht selbst überarbeiten oder menschliche Freigabe ersetzen.' : 'Nur belegte Quellen und freigegebene interne Werkzeuge verwenden.');
      prop.hands = 'Versionierte Artefaktreferenzen und konkrete Befunde; keine Selbstfreigabe.';
    }
  }
  return { save, installation: { installed: true, state: 'committed', commitId: 'test-installation', mappings: built.mappings } };
}

test('specific German tasks have bounded instructions, hand-offs and no implied activation', () => {
  for (const [id, definition] of Object.entries(H.processes)) {
    assert.equal(definition.steps.length, PROCESSES[id].roles.length);
    assert.equal(PROCESSES[id].implemented, true);
    assert.equal(PROCESSES[id].enabled, false, 'an implemented internal handler is not an activation');
    for (const s of definition.steps) {
      assert.ok(s.label.length <= 48 && s.brief.length <= 2000 && s.hands.length <= 160);
      assert.match(s.brief, /BLOCKIERT/);
      assert.match(s.brief, /Keine Website-\/Repo-Änderungen/);
      assert.match(s.brief, /manuellen Freigabe/);
    }
  }
});

test('migration changes only the thirteen H01–H05 instruction records; preserves all other work', () => {
  const { save, installation } = fixture(), original = structuredClone(save);
  const result = prepare(save, installation);
  assert.equal(result.changed.length, 13);
  assert.deepEqual(save, original, 'input untouched');
  const ids = new Set(result.changed.map(s => s.step));
  for (const prop of result.save.station.props) {
    const before = original.station.props.find(p => p.id === prop.id);
    if (!ids.has(prop.id)) assert.deepEqual(prop, before);
    else {
      const geometry = p => Object.fromEntries(Object.entries(p).filter(([key]) => !['label', 'brief', 'hands'].includes(key)));
      assert.deepEqual(geometry(prop), geometry(before));
    }
  }
  const withoutProps = s => ({ ...s, station: { ...s.station, props: null }, updatedAt: null });
  assert.deepEqual(withoutProps(result.save), withoutProps(original));
  assert.deepEqual(result.plan.errors, []);
  assert.equal(result.save._saveRevision, 47);
  assert.deepEqual(prepare(result.save, installation).changed, [], 'idempotent');
});

test('migration refuses user-edited instructions, wrong mappings and unconfirmed installs', () => {
  const { save, installation } = fixture();
  const p = save.station.props.find(p => p.id === installation.mappings.H03.steps[0]);
  p.brief = 'My own task';
  const before = structuredClone(save);
  assert.throws(() => prepare(save, installation), /user instructions preserved/);
  assert.deepEqual(save, before);
  assert.throws(() => prepare(save, { ...installation, commitId: 'different' }), /not confirmed/);
  const wrong = structuredClone(installation); wrong.mappings.H01.steps = ['unknown'];
  assert.throws(() => prepare(save, wrong), /mapping mismatch/);
});

test('business status uses the confirmed process; missing/failed API never claims ready', () => {
  const installation = { mappings: { H03: { businessUnitId: 'homestackr', intake: 'in' } } };
  const agents = ['colony_homestackr_research'];
  assert.equal(H.describe('in', agents, installation, { processes: PROCESSES }).label, 'Modell oder Freigabe fehlt');
  assert.equal(H.describe('in', agents, installation, { processes: { H03: { ...PROCESSES.H03, enabled: true } } }).label, 'Über Business-Steuerung');
  assert.equal(H.describe('in', agents, installation, { processes: { H03: { ...PROCESSES.H03, implemented: false } } }).label, 'Noch nicht eingerichtet');
  assert.equal(H.describe('in', agents, installation, null).label, 'Status nicht bestätigt');
  assert.equal(H.describe('in', agents, null, null).label, 'Status nicht bestätigt');
  assert.equal(H.describe('legacy', ['hsr_research'], installation, null), null);
  assert.equal(H.describe('other', ['nova'], installation, null), null);
  assert.equal(H.describe('in', agents, installation, { processes: { H03: { businessUnitId: 'homestackr', implemented: true } } }).label, 'Modell oder Freigabe fehlt');
  assert.equal(H.describe('in', agents, installation, { processes: { H03: { businessUnitId: 'homestackr', implemented: true, enabled: true } } }).label, 'Über Business-Steuerung');
});

test('native list and line show tasks/results, distinguish legacy and never offer direct HomeStackR runs', async () => {
  const fetched = [], ctx = vm.createContext({
    module: { exports: {} }, HomeStackRWorkflows: H,
    window: { ColonyRoomState: { mappings: { H03: { businessUnitId: 'homestackr', intake: 'in' } } }, ColonyProcessState: { processes: PROCESSES } },
    document: { querySelector: () => null }, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: url => { fetched.push(url); return Promise.resolve({ status: 200, json: async () => ({ jobs: [] }) }); }
  });
  vm.runInContext(fs.readFileSync(require.resolve('../frontend/app/windows/workflows.js'), 'utf8'), ctx);
  const WW = ctx.module.exports;
  const line = { key: 'in', intakeId: 'in', name: 'H03 · Pinterest', ready: { ready: true }, steps: H.processes.H03.steps.map((s, i) => ({ ...s, id: 'bay' + i, n: i + 1, desk: true, agentId: 'colony_homestackr_' + PROCESSES.H03.roles[i] })) };
  const html = WW._lineHTML(null, line), list = WW._listHTML({ lines: [line] });
  for (const s of line.steps) { assert.ok(html.includes(s.label)); assert.ok(html.includes(s.hands)); }
  assert.match(html, /Ergebnis:/);
  assert.match(html, /wfw-readable/);
  assert.match(html, /Qualitätsschleife/);
  assert.match(html, /Korrekturrunden/);
  assert.match(html, /Modell oder Freigabe fehlt/);
  assert.doesNotMatch(html + list, /READY TO RUN|SEND A JOB|id="wfw-job"/);
  WW._send(line, 'must not run', null);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(fetched, []);
  assert.equal(WW._state.out, null);
  ctx.window.ColonyProcessState = null;
  assert.match(WW._lineHTML(null, line), /Status nicht bestätigt/);
  const legacy = { ...line, key: 'old', intakeId: 'old', steps: line.steps.map(s => ({ ...s, agentId: 'hsr_writer' })) };
  assert.match(WW._lineHTML(null, legacy), /Ältere Linie/);
  assert.match(WW._lineHTML(null, legacy), /SEND A JOB/);
});
