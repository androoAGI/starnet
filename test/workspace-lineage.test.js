/* node test/workspace-lineage.test.js — prior-state evidence structurally dominates onboarding. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectWorkspaceLineage } = require('../sidecar/workspace-lineage.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-lineage-'));
const current = path.join(root, 'current', 'workspaces');
const legacy = path.join(root, 'legacy', 'workspaces');
const snapshots = path.join(root, 'current', 'update-snapshots');
fs.mkdirSync(current, { recursive: true });
try {
  fs.writeFileSync(path.join(current, '.starnet-workspace-owner.json'), '{}');
  fs.writeFileSync(path.join(current, '.schema-version.json'), '{}');
  fs.writeFileSync(path.join(current, '.migrated'), '1');
  fs.writeFileSync(path.join(current, '.migration-receipt.json'), JSON.stringify({ version: 1, validated: true, sourceRoots: [], files: [] }));
  let v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'runtime/schema/migration infrastructure, including an empty migration receipt, is a genuine first run');
  A.eq(v.onboardingAllowed, true, 'onboarding is allowed only with zero evidence');

  // E-STOP/scheduler bookkeeping (2026-08-25): the desktop shell fires POST /api/halt on EVERY clean quit,
  // which writes these files even on a station that was never created. They stranded a fresh install on the
  // recovery gate after one open+quit. They are INFRA — a file the sidecar writes stationlessly is never
  // proof a Commander created a station.
  for (const f of ['loops.halt.json', 'nightshift.state.json', 'cron.halt.json', 'nightshift.state.json.bak']) {
    fs.writeFileSync(path.join(current, f), '{"halted":true}');
  }
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'quit-path E-STOP bookkeeping (loops/nightshift/cron halt state) is not prior-station evidence');
  A.eq(v.onboardingAllowed, true, 'a fresh install that was opened and closed once still onboards');
  for (const f of ['loops.halt.json', 'nightshift.state.json', 'cron.halt.json', 'nightshift.state.json.bak']) {
    fs.unlinkSync(path.join(current, f));
  }

  // Quest-refresh scheduler bookkeeping (#123): armQuestRefresh's boot catch-up tick persists
  // _station.questrefresh.json (+ .bak via saveResilient) ~3 s into EVERY boot — no key, no station needed (the
  // cycle records an honest 'skipped'). It matched the `_station.*.json` evidence alternative, so a fresh install
  // opened and closed once gated on its next boot, and START FRESH held only until the following boot's tick
  // wrote the file straight back. Same class as the E-STOP case above, different writer.
  for (const f of ['_station.questrefresh.json', '_station.questrefresh.json.bak']) {
    fs.writeFileSync(path.join(current, f), '{"v":1,"state":{"v":1,"ledger":[{"outcome":"skipped"}]}}');
  }
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'quest-refresh scheduler bookkeeping (_station.questrefresh.json + .bak) is not prior-station evidence');
  A.eq(v.onboardingAllowed, true, 'a fresh install whose boot tick already ran still onboards');
  // the carve-out is that ONE scheduler file, not the _station.* family: a real station-wide authority still gates.
  fs.writeFileSync(path.join(current, '_station.quests.json'), '{"v":1}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'other _station.* authorities (_station.quests.json) remain prior-station evidence');
  for (const f of ['_station.quests.json', '_station.questrefresh.json', '_station.questrefresh.json.bak']) {
    fs.unlinkSync(path.join(current, f));
  }

  fs.writeFileSync(path.join(current, 'future-cache-v2.json'), '{"cache":true}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, false, 'unknown cache files cannot become prior-station evidence by denylist omission');
  fs.unlinkSync(path.join(current, 'future-cache-v2.json'));

  fs.writeFileSync(path.join(current, 'ledger.jsonl'), '{"event":"prior-work"}\n');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'known durable station ledgers still block destructive first-run inference when the save is missing');
  fs.unlinkSync(path.join(current, 'ledger.jsonl'));

  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'agent.save.json'), '{"version":5}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'state in a legacy workspace is prior-install evidence');
  A.eq(v.evidence[0].kind, 'legacy-workspace', 'evidence names its legacy source');

  fs.rmSync(legacy, { recursive: true, force: true });
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'pre-2.0-1.starnet-backup.json'), '{}');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.evidence[0].kind, 'update-snapshot', 'verified update-snapshot presence blocks genesis');

  fs.rmSync(snapshots, { recursive: true, force: true });
  fs.writeFileSync(path.join(current, '.migration-pending'), '1');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.evidence.some(x => x.kind === 'migration-pending'), true, 'interrupted migration blocks genesis');

  fs.unlinkSync(path.join(current, '.migration-pending'));
  fs.writeFileSync(path.join(current, 'agent.save.json.corrupt-9'), 'forensic');
  v = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(v.priorInstallEvidence, true, 'forensic corrupt generation remains prior-state evidence');

  const app = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
  const check = app.indexOf('lineage.priorInstallEvidence === true');
  const splash = app.indexOf('showSplash();', check);
  A.ok(check > 0 && splash > check, 'lineage gate structurally dominates the final onboarding call');
  const fn = app.slice(app.indexOf('function showPriorStateGate'), app.indexOf('/* ---------- boot ---------- */'));
  A.eq(fn.includes('startCreation('), false, 'Recovery Mode has no route into fresh creation');
  A.ok(fn.includes("show('screen-lineage')"), 'prior-state evidence renders the dedicated recovery screen');
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  const screen = html.slice(html.indexOf('<section id="screen-lineage"'), html.indexOf('<!-- ============ GAME', html.indexOf('<section id="screen-lineage"')));
  A.ok(screen.includes('READ ONLY') && screen.includes('btn-lineage-restore') && screen.includes('btn-lineage-retry'), 'Recovery Mode offers restore/retry and declares read-only posture');
  A.ok(screen.includes('btn-lineage-recover') && screen.includes('btn-lineage-report'), 'Recovery Mode offers verified candidate recovery and a redacted report without Terminal work');
  A.ok(fn.includes('/api/lineage/recover') && fn.includes('/api/lineage/report'), 'Recovery Mode wires both actions to authenticated sidecar truth');
  // START FRESH is NOT a bypass: it is sidecar-backed (quarantine + marker, never a delete) and the page still
  // has no route into startCreation. The lock is the SHAPE — the button exists, it is wired to the sidecar
  // route, and nothing on the screen creates a station client-side.
  A.ok(screen.includes('btn-lineage-fresh'), 'Recovery Mode offers START FRESH (the third exit)');
  A.ok(fn.includes('/api/lineage/start-fresh'), 'START FRESH is wired to the sidecar quarantine route, never a client-side wipe');
  A.eq(/CREATE.*STATION/i.test(screen), false, 'Recovery Mode exposes no client-side create-station bypass');

  // startFresh(): quarantines current-workspace state (never deletes), acknowledges external roots, and the
  // next inspection allows onboarding.
  const { startFresh } = require('../sidecar/workspace-lineage.js');
  fs.writeFileSync(path.join(current, 'ledger.jsonl'), '{"event":"failed-first-run"}\n');
  fs.writeFileSync(path.join(current, 'loops.json'), '{}');
  fs.writeFileSync(path.join(current, 'loops.halt.json'), '{}');         // infra (E-STOP bookkeeping): stays put
  fs.writeFileSync(path.join(current, 'liveprices.cache.json'), '{}');   // infra: stays put
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'agent.save.json'), '{"version":5}');
  fs.mkdirSync(snapshots, { recursive: true });
  fs.writeFileSync(path.join(snapshots, 'x.starnet-backup.json'), '{}');
  let before = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(before.priorInstallEvidence, true, 'fixture: the gate would fire');
  const fresh = startFresh({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform, now: () => Date.UTC(2026, 7, 22, 12, 0, 0) });
  A.eq(fresh.ok, true, 'start fresh succeeds');
  A.ok(fresh.moved.includes('ledger.jsonl') && fresh.moved.includes('loops.json'), 'every current-workspace state file moved');
  A.eq(fresh.moved.includes('liveprices.cache.json'), false, 'infrastructure never moves');
  A.eq(fresh.moved.includes('loops.halt.json'), false, 'E-STOP bookkeeping is infrastructure and never moves');
  A.eq(fs.existsSync(path.join(fresh.quarantine, 'ledger.jsonl')), true, 'moved files live on in quarantine (never deleted)');
  A.eq(fs.existsSync(path.join(current, 'ledger.jsonl')), false, 'the live workspace no longer holds the stale state');
  A.eq(fs.existsSync(path.join(current, 'liveprices.cache.json')), true, 'infrastructure files are untouched');
  A.eq(fs.existsSync(path.join(legacy, 'agent.save.json')), true, 'a legacy root is acknowledged, never moved or deleted');
  A.eq(fresh.quarantine.indexOf(path.join(root, 'current', 'workspace-quarantine')) === 0, true, 'quarantine is a SIBLING of the workspace, so it is never re-read as evidence');
  const after = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(after.priorInstallEvidence, false, 'after START FRESH the gate no longer fires');
  A.eq(after.onboardingAllowed, true, 'onboarding is allowed');
  // the marker never suppresses CURRENT-workspace evidence: a real save that appears later still counts.
  fs.writeFileSync(path.join(current, 'agent.save.json'), '{"version":5}');
  const later = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [legacy], snapshotsRoot: snapshots, platform: process.platform });
  A.eq(later.priorInstallEvidence, true, 'live-workspace state after a fresh start is still honored as evidence');
  fs.unlinkSync(path.join(current, 'agent.save.json'));
  fs.rmSync(legacy, { recursive: true, force: true });
  fs.rmSync(snapshots, { recursive: true, force: true });
  fs.unlinkSync(path.join(current, '.fresh-start.json'));

  // START FRESH DRAINS PAST THE LISTING PAGE: meaningfulEntries caps each listing at 40 (bounded gate
  // evidence), but a real station with a full roster easily exceeds 40 state files. Moving one page and
  // returning ok left the remainder as live evidence — the gate stayed shut and the station was torn.
  {
    const many = [];
    for (let i = 0; i < 23; i++) { many.push('crew' + String(i).padStart(2, '0') + '.notebook.json', 'crew' + String(i).padStart(2, '0') + '.todo.json'); }
    many.push('agent.save.json', 'agent.roster.json', 'ledger.jsonl');
    for (const f of many) fs.writeFileSync(path.join(current, f), '{"v":1}');
    A.ok(many.length > 40, 'fixture exceeds one 40-entry listing page (' + many.length + ' files)');
    const big = startFresh({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform, now: () => Date.UTC(2026, 7, 28, 12, 0, 0) });
    A.eq(big.ok, true, 'start fresh succeeds on a >40-file station');
    A.eq(big.moved.length, many.length, 'EVERY state file moved (' + big.moved.length + '/' + many.length + '), not just the first listing page');
    const bigAfter = inspectWorkspaceLineage({ fs, path, workspaceRoot: current, candidateRoots: [], snapshotsRoot: snapshots, platform: process.platform });
    A.eq(bigAfter.onboardingAllowed, true, 'the gate opens — no current-workspace evidence remains');
    for (const f of many) A.eq(fs.existsSync(path.join(big.quarantine, f)), true, 'quarantine holds ' + f);
    fs.unlinkSync(path.join(current, '.fresh-start.json'));
  }
  A.report('workspace-lineage.test');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
