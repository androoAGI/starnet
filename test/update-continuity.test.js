#!/usr/bin/env node
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

(async () => {
  const C = await import('../scripts/lib/update-continuity.mjs');
  const fixture = C.populatedFixture('nonce', 100);
  const legacy = structuredClone(fixture.workstreams);
  const hydrated = legacy.map(w => ({ ...w, parentStreamId: null, projectHome: false }));
  A.eq(C.normalizeLegacyWorkstreamDefaults(hydrated), legacy, 'only neutral project defaults are equivalent to legacy absence');
  A.eq(hydrated[0].projectHome, false, 'normalization leaves captured evidence unchanged');
  for (const changed of [
    { parentStreamId: 'real-parent' }, { projectHome: true },
    { parentStreamId: '' }, { projectHome: 0 }, { history: [] }, { title: 'lost title' },
    // the 0.13.5 session defaults are neutral only at exactly null / false / '' / null
    { projectRootAt: 0 }, { worker: 0 }, { lastRunReason: null }, { pendingJoin: {} }
  ]) {
    const altered = [{ ...hydrated[0], ...changed }];
    A.eq(C.stableJson(C.normalizeLegacyWorkstreamDefaults(altered)) === C.stableJson(legacy), false, 'semantic change is not hidden: ' + JSON.stringify(changed));
  }
  // 0.13.3 -> 0.13.5: the REAL frontend/app/workstreams.js, loaded in a vm the way the page loads it, hydrates a session
  // 0.13.3 saved. make() gives it four new fields at neutral values (projectRootAt null, worker false, lastRunReason '',
  // pendingJoin null). The public canary must read exactly that as the expected migration, and still fail on a real value.
  {
    const loadWorkstreams = () => {
      const sandbox = {}; sandbox.globalThis = sandbox; vm.createContext(sandbox);
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/workstreams.js'), 'utf8'), sandbox, { filename: 'workstreams.js' });
      return sandbox.Workstreams;
    };
    // the canary fixture's conversation exactly as 0.13.3 (b35cf4ee3) make() persisted it
    const v0133 = { id: 'canary-work', title: 'Update continuity', agentId: 'agent', conversationMode: 'direct', roomId: null, lane: 'active', kind: 'chat',
      projectRoot: null, parentStreamId: null, projectHome: false, history: [{ role: 'user', content: 'preserve-nonce' }], runIds: [], connectorHandoff: null,
      lastRunOk: null, lastModel: '', deliverables: [], cost: { tokens: 0, usd: 0, calls: 0 }, pinned: false, archived: false, titleAuto: true,
      titleStrong: false, automation: null, createdAt: 100, lastActiveAt: 100, lastReadAt: 100 };
    // boot -> persist, as the updated app does it: Workstreams.init over the saved slice, then the JSON the save carries
    const hydrate = streams => {
      const W = loadWorkstreams();
      W.init({ workstreams: JSON.parse(JSON.stringify(streams)), activeId: 'canary-work', generalId: 'canary-work' });
      return JSON.parse(JSON.stringify(W.serialize().workstreams));
    };
    const same = (a, b) => C.stableJson(C.normalizeLegacyWorkstreamDefaults(a)) === C.stableJson(C.normalizeLegacyWorkstreamDefaults(b));
    const upgraded = hydrate([v0133]);
    A.eq(Object.keys(upgraded[0]).filter(k => !(k in v0133)).sort(), ['lastRunReason', 'pendingJoin', 'projectRootAt', 'worker'],
      'the current app adds exactly four fields to a 0.13.3 session (a new one needs a checker decision here)');
    A.eq([upgraded[0].projectRootAt, upgraded[0].worker, upgraded[0].lastRunReason, upgraded[0].pendingJoin], [null, false, '', null],
      'the four added fields arrive at their neutral values');
    A.eq(same([v0133], upgraded), true, 'a 0.13.3 session hydrated by the current app compares equal (the expected migration)');
    A.eq(same(upgraded, hydrate(upgraded)), true, 'the upgraded session compares equal across a second restart');
    A.eq(upgraded[0].worker, false, 'normalization leaves the hydrated evidence unchanged');
    const real = {
      projectRootAt: 1700000000000, worker: true, lastRunReason: 'stopped',
      pendingJoin: { runId: 'run-1', ids: ['scout'], at: 5 }
    };
    for (const [field, value] of Object.entries(real)) {
      // the update invented a real value: hydrate a 0.13.3 session that carries it, through the same real make()
      const invented = hydrate([{ ...v0133, [field]: value }]);
      A.eq(invented[0][field], value, 'the current app keeps a real ' + field);
      A.eq(same([v0133], invented), false, 'a real ' + field + ' appearing across the update still fails');
      // a real value lost across a restart (back to the neutral default) still fails too
      A.eq(same(invented, upgraded), false, 'a real ' + field + ' reset to its default still fails');
    }
  }
  // Agent colours: a missing colour becoming a crew palette suit is the one permitted change (roster hydration
  // since the 2026-09-23 security audit). Anything else about a colour must still fail the comparison.
  {
    const prior = C.continuityProjection({ local: fixture, durable: fixture });
    const paint = (state, color) => { const out = structuredClone(state); for (const k of ['local', 'durable']) out[k].agents[1].color = color; return out; };
    const same = (a, b) => C.stableJson(a) === C.stableJson(b);
    const assigned = paint(prior, '#7bc88a');
    A.eq(same(C.adoptAssignedSuitColors(prior, assigned), assigned), true, 'a missing colour may become a crew palette suit');
    const offPalette = paint(prior, '#123456');
    A.eq(same(C.adoptAssignedSuitColors(prior, offPalette), offPalette), false, 'a missing colour replaced by a non-palette colour still fails');
    const coloured = paint(prior, '#d99a5a');
    const recoloured = paint(prior, '#7bc88a');
    A.eq(same(C.adoptAssignedSuitColors(coloured, recoloured), recoloured), false, 'a change to an existing colour is never hidden');
    A.eq(same(C.adoptAssignedSuitColors(coloured, coloured), coloured), true, 'an unchanged colour compares equal');
    // the top-level lead record (0.13 gives a lead with no valid colour the gold suit)
    const leadless = { local: { agent: { id: 'agent' }, agents: [] } };
    const gold = { local: { agent: { id: 'agent', color: '#ffd34a' }, agents: [] } };
    A.eq(same(C.adoptAssignedSuitColors(leadless, gold), gold), true, 'a lead with no colour may take the gold suit');
    A.eq(same(C.adoptAssignedSuitColors(leadless, { local: { agent: { id: 'agent', color: '#123456' }, agents: [] } }), { local: { agent: { id: 'agent', color: '#123456' }, agents: [] } }), false, 'a lead given a non-palette colour still fails');
    // the station schema 1 -> 2 step
    const v1 = { local: { station: { version: 1, props: [{ id: 'd' }] } } };
    const v2 = { local: { station: { version: 2, props: [{ id: 'd' }], links: [] } } };
    A.eq(same(C.adoptStationSchemaV2(v1, v2), v2), true, 'station schema 1 -> 2 with an empty links list is the expected migration');
    A.eq(same(C.adoptStationSchemaV2(v1, { local: { station: { version: 2, props: [], links: [] } } }), { local: { station: { version: 2, props: [], links: [] } } }), false, 'a station that lost a prop still fails');
    A.eq(same(C.adoptStationSchemaV2(v1, { local: { station: { version: 2, props: [{ id: 'd' }], links: [{ from: 'a', to: 'b' }] } } }), { local: { station: { version: 2, props: [{ id: 'd' }], links: [{ from: 'a', to: 'b' }] } } }), false, 'invented links still fail');
    // the save schema 6 -> 7 step: the version, and the legacy mark on a kept row, and nothing else
    const row = { role: 'user', content: 'keep me' };
    const s6 = { local: { version: 6, workstreams: [{ id: 'w', history: [row] }] } };
    const s7 = (rows, version) => ({ local: { version: version || 7, workstreams: [{ id: 'w', history: rows }] } });
    const marked = { ...row, legacy: true };
    A.eq(same(C.adoptSaveV7(s6, s7([marked])), s7([marked])), true, 'save 6 -> 7 with the legacy mark on a kept row is the expected migration');
    A.eq(same(C.adoptSaveV7(s6, s7([row])), s7([row])), true, 'save 6 -> 7 with an unmarked row is expected too');
    const changed = { role: 'user', content: 'changed', legacy: true };
    A.eq(same(C.adoptSaveV7(s6, s7([changed])), s7([changed])), false, 'a row whose text changed across 6 -> 7 still fails');
    A.eq(same(C.adoptSaveV7(s6, s7([])), s7([])), false, 'a row lost across 6 -> 7 still fails');
    A.eq(same(C.adoptSaveV7(s6, s7([marked, marked])), s7([marked, marked])), false, 'a row gained across 6 -> 7 still fails');
    A.eq(same(C.adoptSaveV7(s6, s7([marked], 8)), s7([marked], 8)), false, 'a version step other than 6 -> 7 is not this migration');
    const suits = /const SUITS = (\[[^\]]+\])/.exec(fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8'));
    A.ok(suits, 'app.js still declares the crew SUITS palette');
    A.eq(suits ? JSON.parse(suits[1].replace(/'/g, '"')) : null, C.CREW_SUITS.slice(), 'verifier palette matches the app crew SUITS');
  }
  const snapshot = { sentinel: { nonce: 'nonce', purpose: 'update-continuity' }, local: fixture, durable: Object.assign({}, fixture, { updatedAt: 200 }) };
  const receipt = C.buildReceipt({
    before: snapshot, after: snapshot,
    beforeVersion: '1.2.3', targetVersion: '1.2.4', afterVersion: '1.2.4',
    installerArtifact: 'StarNet_1.2.4_setup.exe', installerArtifactSha256: 'a'.repeat(64), installerGone: true,
    relaunched: true, installedExeSha256: 'b'.repeat(64)
  });
  A.eq(receipt.state.equal, true, 'timestamps are excluded while semantic state remains equal');
  A.eq(C.validateReceipt(receipt), { ok: true, errors: [] }, 'complete exact receipt passes');
  const reset = JSON.parse(JSON.stringify(receipt));
  reset.state.afterFingerprint = '0'.repeat(64);
  A.eq(C.validateReceipt(reset).ok, false, 'reset-looking state parity fails closed');
  const hung = JSON.parse(JSON.stringify(receipt));
  hung.installer.processGone = false;
  A.eq(C.validateReceipt(hung).ok, false, 'hung installer fails closed');
  const noRelaunch = JSON.parse(JSON.stringify(receipt));
  noRelaunch.relaunch.observed = false;
  A.eq(C.validateReceipt(noRelaunch).ok, false, 'missing relaunch fails closed');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-promotion-'));
  try {
    const dist = path.join(temp, 'dist'); fs.mkdirSync(dist);
    const artifact = path.join(dist, 'StarNet_1.2.4_setup.exe'); fs.writeFileSync(artifact, 'exact-installer');
    const artifactHash = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    const make = updatePath => C.buildReceipt({
      path: updatePath, before: snapshot, after: snapshot,
      beforeVersion: updatePath === 'latest-to-next' ? '1.2.3' : '1.1.9', targetVersion: '1.2.4', afterVersion: '1.2.4',
      installerArtifact: path.basename(artifact), installerArtifactSha256: artifactHash, installerGone: true,
      relaunched: true, installedExeSha256: 'b'.repeat(64)
    });
    const receipts = ['latest-to-next', 'n-minus-one-to-next'].map((updatePath, index) => {
      const file = path.join(temp, 'receipt-' + index + '.json'); fs.writeFileSync(file, JSON.stringify(make(updatePath))); return file;
    });
    const gate = path.resolve(__dirname, '../scripts/release-promotion-gate.mjs');
    const run = spawnSync(process.execPath, [gate, '--receipt', receipts[0], '--receipt', receipts[1], '--dist', dist, '--version', '1.2.4', '--min-soak-hours', '0', '--out', path.join(temp, 'verdict.json')], { encoding: 'utf8' });
    A.eq(run.status, 0, 'promotion gate accepts both exact populated-state paths: ' + String(run.stderr || run.stdout));
    fs.writeFileSync(artifact, 'different-installer');
    const swapped = spawnSync(process.execPath, [gate, '--receipt', receipts[0], '--receipt', receipts[1], '--dist', dist, '--version', '1.2.4', '--min-soak-hours', '0', '--out', path.join(temp, 'bad.json')], { encoding: 'utf8' });
    A.eq(swapped.status, 1, 'promotion gate refuses an installer whose bytes differ from canary');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  A.report('update-continuity.test');
})().catch(error => { console.error(error); process.exit(1); });
