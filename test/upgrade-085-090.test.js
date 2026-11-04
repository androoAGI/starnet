/* node test/upgrade-085-090.test.js — released v0.8.5 -> v0.9 candidate state-safety contract.

   This is deliberately fixture-driven and disposable. It never opens the real desktop data root or keychain.
   The fixture is the persisted shape shipped by tag v0.8.5; the readers/writers are the candidate modules.
   It also models a rollback reader with the released save ceiling (v5), proving candidate-only fields are
   refused rather than silently normalized away by the older frontend. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');
const Workstreams = require('../frontend/app/workstreams.js');
const UpdateCore = require('../frontend/app/updatecore.js');
const cronStore = require('../sidecar/cron-store.js');
const budgetCaps = require('../sidecar/budgetcaps.js');
const fallbackChain = require('../sidecar/fallbackchain.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { makeMemoryStore } = require('../sidecar/memory-store.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const WorkspaceRecovery = require('../sidecar/workspace-recovery.js');

const SAVE_KEY = 'starnet.save';
const RELEASE_SAVE_VERSION = 5;
const CANDIDATE_SAVE_VERSION = 7;   // 6 shipped the title-provenance bit (0.9); 7 lets a history name rows the station holds (historyref.js)

class MemoryStorage {
  constructor(seed) { this.map = new Map(Object.entries(seed || {}).map(([k, v]) => [String(k), String(v)])); }
  get length() { return this.map.size; }
  key(i) { return Array.from(this.map.keys())[i] || null; }
  getItem(k) { return this.map.has(String(k)) ? this.map.get(String(k)) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(String(k)); }
}

function loadSave(storage, releasedCeiling) {
  let source = fs.readFileSync(path.join(__dirname, '../frontend/app/save.js'), 'utf8');
  if (releasedCeiling != null) {
    source = source.replace(/const CURRENT = \d+;/, 'const CURRENT = ' + Number(releasedCeiling) + ';');
  }
  const sandbox = { localStorage: storage, Workstreams, console: { warn() {}, log() {}, error() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.__Save = Save;', sandbox, { filename: 'frontend/app/save.js' });
  return sandbox.__Save;
}

function releasedSave() {
  return {
    schema: 'starnet.save', version: RELEASE_SAVE_VERSION, updatedAt: 1700000000000,
    agent: {
      id: 'agent', name: 'NOVA', provider: 'openrouter', credentialRef: 'provider:openrouter',
      docs: { identity: 'You are NOVA.', purpose: 'Protect the migration.', manual: 'Be terse.' },
      stats: { xp: 120, level: 3, lifetimeXp: 340, confidence: 61, samples: 8, counters: { runs: 8 }, milestones: ['first-run'] }
    },
    agents: [
      { id: 'agent', name: 'NOVA', provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
      { id: 'scout', name: 'SCOUT', provider: 'openrouter', model: 'openai/gpt-4o' }
    ],
    station: { rooms: { command: { id: 'command', name: 'Command' } }, order: ['command'], props: [{ id: 'desk1', kind: 'desk', x: 3, y: 4, agentId: 'agent' }] },
    usage: { tokens: 4200, cost: 0.0891, calls: 8 },
    stationStats: { xp: 200, level: 4, lifetimeXp: 540, confidence: 58, samples: 12, counters: {}, milestones: [] },
    profile: { v: 1, tags: { research: 3 }, seed: 'builder', enabled: true, total: 3 },
    worksignal: { v: 1, ewma: { web: 0.4 }, updatedAt: 1699500000000 },
    dossier: { v: 1, dims: { identity: ['builder'], stack: ['node'], goals: ['ship'], style: [], standing_orders: [], pain: [], ambition: [] }, seededFrom: {}, updatedAt: 1699000000000 },
    workstreams: [{
      id: 'ws_general', title: null, agentId: 'agent', lane: 'active', kind: 'chat', projectRoot: null,
      history: [{ role: 'user', content: 'preserve this conversation' }], runIds: ['run-085'], deliverables: [],
      cost: { tokens: 4200, usd: 0.0891, calls: 8 }, pinned: true, archived: false, titleAuto: true,
      createdAt: 1699000000000, lastActiveAt: 1700000000000, lastReadAt: 1700000000000
    }],
    activeId: 'ws_general', generalId: 'ws_general',
    settings: { textSize: 'large', theme: 'amber', sound: false },
    release085UnknownUserField: { nested: ['must', 'survive'] }
  };
}

// 1. Exact released save -> candidate migration, including byte-exact interruption backup.
const oldDoc = releasedSave();
const oldRaw = JSON.stringify(oldDoc);
const storage = new MemoryStorage({ [SAVE_KEY]: oldRaw });
const Save = loadSave(storage);
const status = Save.loadStatus();
A.eq(Save.CURRENT, CANDIDATE_SAVE_VERSION, 'candidate advances the save schema beyond released v0.8.5');
A.eq(status.status, 'ok', 'candidate accepts the released v0.8.5 save');
A.eq(status.doc.version, CANDIDATE_SAVE_VERSION, 'v0.8.5 save migrates to candidate schema in memory');
A.eq(storage.getItem(SAVE_KEY), oldRaw, 'load-time migration leaves the released save bytes untouched');
A.eq(storage.getItem(Save.PRE_MIGRATE_BACKUP_KEY), oldRaw, 'interrupted migration has an exact v0.8.5 recovery copy');
A.eq(status.doc.agent, oldDoc.agent, 'agent identity, docs, model/provider and credential reference survive');
A.eq(status.doc.agents, oldDoc.agents, 'the complete workspace roster survives');
A.eq(status.doc.station, oldDoc.station, 'rooms and placed station objects survive');
A.eq(status.doc.workstreams[0].history, oldDoc.workstreams[0].history, 'conversation history survives');
A.eq(status.doc.settings, oldDoc.settings, 'user settings survive');
A.eq(status.doc.release085UnknownUserField, oldDoc.release085UnknownUserField, 'unknown v0.8.5 user state survives');
A.eq(status.doc.workstreams[0].titleStrong, false, 'v5->v6 seeds explicit weak-title provenance without inventing strength');

// 2. Candidate save -> released rollback reader. v0.8.5 must refuse it byte-for-byte instead of dropping
// candidate-only titleStrong during Workstreams.init()/serialize(). This is the defect this schema bump closes.
const candidateDoc = JSON.parse(JSON.stringify(status.doc));
candidateDoc.workstreams[0].title = 'Updater Migration Audit';
candidateDoc.workstreams[0].titleStrong = true;
const candidateRaw = JSON.stringify(candidateDoc);
const rollbackStorage = new MemoryStorage({ [SAVE_KEY]: candidateRaw });
const ReleasedSave = loadSave(rollbackStorage, RELEASE_SAVE_VERSION);
const rollbackStatus = ReleasedSave.loadStatus();
A.eq(rollbackStatus.status, 'future', 'released v0.8.5 refuses candidate schema instead of adopting it');
A.eq(rollbackStatus.version, CANDIDATE_SAVE_VERSION, 'rollback refusal names the candidate schema version');
A.eq(rollbackStorage.getItem(SAVE_KEY), candidateRaw, 'rollback attempt leaves candidate state byte-for-byte untouched');
A.eq(rollbackStorage.getItem(ReleasedSave.PRE_MIGRATE_BACKUP_KEY), null, 'rollback refusal does not overwrite the recovery backup');

// 3. Sidecar workspace stores: v0.8.5 envelopes are still decoded, re-saved, restarted and recovered.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upgrade-085-090-'));
try {
  const saveStore = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => 1700000000100 } });
  A.ok(saveStore.save('agent', oldDoc).ok, 'released workspace save fixture persists in a disposable root');
  A.eq(makeSaveStore({ fs, pathMod: path, root, clock: { now: () => 1700000000200 } }).load('agent'), oldDoc,
    'fresh candidate save-store instance reads the v0.8.5 workspace unchanged');

  const memory = makeMemoryStore({ fs, path, workspaces: root });
  const notebook = [{ id: 'm1', title: 'Upgrade safety', body: 'Migration safety matters.', ts: 1 }];
  const todo = [{ id: 't1', text: 'ship 0.9 safely', done: false }];
  memory.set('notebook:agent', notebook);
  memory.set('todo:agent', todo);
  const memoryRestart = makeMemoryStore({ fs, path, workspaces: root });
  A.eq(memoryRestart.get('notebook:agent'), notebook, 'memories survive a candidate restart');
  A.eq(memoryRestart.get('todo:agent'), todo, 'memory-backed plans survive a candidate restart');

  const routine = {
    id: 'morning', name: 'Morning research', prompt: 'summarize overnight news',
    schedule: { kind: 'cron', expr: '0 8 * * *' }, agentId: 'scout', model: 'openai/gpt-4o',
    provider: 'openrouter', deliver: 'notebook', enabled: true, state: 'scheduled',
    createdAt: '2026-08-02T12:00:00.000Z', nextRunAt: '2026-08-03T12:00:00.000Z',
    repeat: { times: null, completed: 0 }, meta: { recipeId: 'morning-research' }
  };
  const routines = cronStore.loadEnvelope({ version: 1, jobs: [routine] });
  A.eq(routines.jobs[0], routine, 'v0.8.5 routine fields and bindings load without reshape');
  A.eq(cronStore.toEnvelope(routines.jobs).jobs[0], routine, 'routine round-trip preserves its full record');

  const budgetFile = path.join(root, 'budget.json');
  fs.writeFileSync(budgetFile, JSON.stringify({ version: 1, caps: { perRun: 1.25, perDay: 8 } }));
  const budgetStore = makeDomainStore({
    fs, path, file: budgetFile, version: 1, defaults: () => ({}),
    normalize: value => budgetCaps.cleanOverrides(value || {}), encode: value => ({ caps: value }),
    decode: envelope => envelope && envelope.caps
  });
  A.eq(budgetStore.load().value, { perRun: 1.25, perDay: 8 }, 'v0.8.5 budget settings decode in the candidate');

  const fallbackFile = path.join(root, 'fallback.json');
  const models = ['openai/gpt-4o', 'anthropic/claude-sonnet-4.5'];
  fs.writeFileSync(fallbackFile, JSON.stringify({ version: 1, models }));
  const fallbackStore = makeDomainStore({
    fs, path, file: fallbackFile, version: 1, defaults: () => null,
    normalize: value => Array.isArray(value) ? fallbackChain.cleanChain(value) : null,
    encode: value => ({ models: value }), decode: envelope => envelope && envelope.models
  });
  A.eq(fallbackStore.load().value, models, 'v0.8.5 fallback-model settings decode in the candidate');
  fallbackStore.save(models);
  fs.writeFileSync(fallbackFile, '{interrupted write');
  A.eq(fallbackStore.load().value, models, 'interrupted settings write recovers the last known-good .bak');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

// 4. Updater preferences are local metadata, not disposable runtime state: skips/reminders/backoff survive hydrate.
const updater085 = {
  v: 1, autoCheck: false, lastCheckAt: 100, nextCheckAt: 200, remindAfter: 300,
  ignoredVersion: '0.9.0', notifiedVersion: '0.9.0', failureCount: 3
};
// every 0.8.5 field survives; fields added since (availableVersion) hydrate to their empty default
A.eq(UpdateCore.hydrateSettings(updater085), {
  v: 1, autoCheck: false, lastCheckAt: 100, nextCheckAt: 200, remindAfter: 300,
  ignoredVersion: '0.9.0', notifiedVersion: '0.9.0', availableVersion: '', failureCount: 3
}, 'v0.8.5 updater metadata survives candidate hydration');

// 5. Cross-platform/native invariants available to this host: canonical app-data root, retry markers, stable
// keychain references, failed-install restoration, and restart after a successful non-Windows install.
const mainRs = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
const credentialsRs = fs.readFileSync(path.join(__dirname, '../src-tauri/src/credentials.rs'), 'utf8');
A.ok(/app\.path\(\)\s*\.app_data_dir\(\)/.test(mainRs) && /join\("workspaces"\)/.test(mainRs),
  'Windows and macOS use the stable bundle app-data directory for the live workspace');
A.ok(/cfg\(windows\)[\s\S]*?to_lowercase\(\)[\s\S]*?cfg\(not\(windows\)\)[\s\S]*?a == b/.test(mainRs),
  'Windows path identity is case-insensitive while macOS/non-Windows path identity is exact');
const migrationStart = mainRs.indexOf('fn migrate_workspace_data(');
const migrationEnd = mainRs.indexOf('\n#[cfg(test)]', migrationStart);
const migrationRs = mainRs.slice(migrationStart, migrationEnd);
const pendingStage = migrationRs.indexOf('std::fs::write(stage.join(MIGRATION_PENDING_MARKER)');
const copyToStage = migrationRs.indexOf('copy_missing_dir(source, &stage)');
const sealStage = migrationRs.indexOf('std::fs::write(stage.join(MIGRATION_MARKER)');
const revalidateStage = migrationRs.lastIndexOf('validate_staged_generation(&stage, &receipt)');
const activateStage = migrationRs.lastIndexOf('activate_staged_generation(current, &stage)');
A.ok(migrationStart >= 0 && migrationEnd > migrationStart, 'workspace migration implementation is present');
A.ok(pendingStage >= 0 && pendingStage < copyToStage,
  'workspace migration marks the sibling stage pending before copying user state');
A.ok(copyToStage < sealStage && sealStage < revalidateStage && revalidateStage < activateStage,
  'workspace migration seals and revalidates the copied generation before atomic activation');
A.ok(/if let Err\(e\) = install_result[\s\S]*?\*guard = Some\(update\)/.test(mainRs),
  'a failed native update restores the verified pending update for retry');
A.ok(/UpdateInstallEvent::Installing[\s\S]*?app\.restart\(\)/.test(mainRs),
  'a successful macOS/non-Windows update reaches the explicit restart path');
A.ok(/const KEYCHAIN_SERVICE: &str = "ai\.skynet\.harness"/.test(credentialsRs),
  'candidate keeps the released OS keychain service namespace');
A.ok(/"openrouter" => KEYCHAIN_ACCOUNT\.to_string\(\)/.test(credentialsRs) && /format!\("provider:\{id\}"\)/.test(credentialsRs),
  'candidate keeps the released provider credential account references');
A.ok(/format!\("channel:\{channel\}"\)/.test(credentialsRs) && /read_channel_token\(channel\)[\s\S]*?keychain_has_it[\s\S]*?remove\("token"\)/.test(credentialsRs),
  'channel credentials keep their account references and plaintext is stripped only after read-back proof');

// 6. Intel macOS path split: a released v0.8.5 durable save under the manual-sidecar shelf self-heals into
// the desktop bundle-id shelf before stores open, survives the candidate reader, and leaves the source intact.
const intelHome = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-upgrade-085-intel-mac-'));
try {
  const legacyMac = path.join(intelHome, '.local', 'share', 'StarNet', 'workspaces');
  const desktopMac = path.join(intelHome, 'Library', 'Application Support', 'ai.skynet.harness', 'workspaces');
  fs.mkdirSync(legacyMac, { recursive: true });
  makeSaveStore({ fs, pathMod: path, root: legacyMac, clock: { now: () => 1700000000100 } }).save('agent', oldDoc);
  const sourceBytes = fs.readFileSync(path.join(legacyMac, 'agent.save.json'));
  const recovered = WorkspaceRecovery.applyPendingRecovery({
    fs, path, platform: 'darwin', home: intelHome, workspaceRoot: desktopMac,
    candidateRoots: [legacyMac], auto: true, now: () => 1700000000200,
    scratchRoots: []   // this mkdtemp home STANDS IN for a real user home; the tmpdir auto-guard is exercised in workspace-recovery.test.js
  });
  A.eq(recovered.applied, true, 'Intel macOS fixture automatically activates one v0.8.5 manual-sidecar station');
  A.eq(makeSaveStore({ fs, pathMod: path, root: desktopMac, clock: { now: () => 1700000000300 } }).load('agent'), oldDoc,
    'patched desktop store reads the recovered v0.8.5 station without field loss');
  A.eq(fs.readFileSync(path.join(legacyMac, 'agent.save.json')), sourceBytes,
    'Intel macOS recovery leaves the released source generation byte-exact');
  A.ok(fs.existsSync(path.join(desktopMac, '.migration-receipt.json')) && fs.existsSync(path.join(desktopMac, '.migrated')),
    'Intel macOS activation leaves a validated migration receipt and one-shot marker');
} finally {
  fs.rmSync(intelHome, { recursive: true, force: true });
}

A.report('upgrade-085-090');
