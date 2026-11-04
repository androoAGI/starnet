/* node test/update-state-parity.test.js — the update STATE-PARITY gate (UPDATE_STATE_SAFETY_AUDIT P1.4).
 *
 * INVARIANT UNDER TEST: "an update may change CODE, never STATE." After a version upgrade, every byte of the
 * user's world — save doc, roster, station build, workstreams, cron routines, notebook memory — must be
 * byte-preserved or losslessly migrated. This gate is the automated proof the audit asked for.
 *
 * SCOPE (honest, per starnet-verify — say what is proven vs deferred):
 *   PROVEN HERE, deterministically + filesystem-only + no-LLM + in-process (test:fast-eligible):
 *     (1) SAME-CODE REBOOT PARITY. A realistic workspace is seeded on a real temp dir through the REAL sidecar
 *         store writers (savestore.js, memory-store.js notebook, cron-store.js, durable-store.js roster
 *         envelope). We snapshot the loaded state, then simulate a process restart on the SAME dir by building
 *         FRESH store instances (exactly how save.test.js proves durability: `s = mk(fs)` a second time) and
 *         re-reading. A deep-diff asserts byte/structure parity — the only field allowed to move is the save
 *         envelope's server-receive `savedAt` stamp (documented, non-state) and the roster envelope updatedAt on
 *         a deliberate re-save. Any other drift fails with a readable diff.
 *     (2) RE-SAVE FIELD PRESERVATION. New code that re-saves the roster must NOT drop fields it doesn't model
 *         (P1.1 forward-compat). We round-trip a roster carrying an unknown-to-this-version per-agent field
 *         through the same reshape path the sidecar uses and assert the field survives.
 *     (3) FRONTEND SAVE MIGRATION LOSSLESSNESS. Save.migrate() (frontend/app/save.js) is run in a Node vm
 *         sandbox (save.js has no module.export; Workstreams IS require-able and is injected) on a seeded v1
 *         doc and a current-version doc. We assert the ladder stamps the version correctly and drops NO input
 *         field — every field either survives verbatim or is explicitly folded by a documented migration.
 *
 *   DEFERRED (belongs to the release train, NOT this gate):
 *     - A true OLD-BINARY -> NEW-BINARY matrix (install vN, build a station, install vN+1, diff) needs two real
 *       builds + a CDP-driven live app. That is the release-train variant the audit names; this gate proves the
 *       STORE LAYER + migration ladder, which is where every tonight-class bug (P0.1-P1.3) actually lands.
 */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { makeSaveStore } = require('../sidecar/savestore.js');
const { makeMemoryStore } = require('../sidecar/memory-store.js');
const cronStore = require('../sidecar/cron-store.js');
const { readJsonResilient, writeJsonResilient } = require('../sidecar/durable-store.js');

// ---------------------------------------------------------------------------------------------------------
// temp workspace on the real fs (deterministic reads/writes; no network, no LLM, no child process).
// ---------------------------------------------------------------------------------------------------------
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-parity-'));
const clock = { now: () => 1700000000000 };   // fixed clock so savedAt is deterministic across the run
function cleanup() { try { fs.rmSync(WS, { recursive: true, force: true }); } catch (_) {} }
process.on('exit', cleanup);

// store constructors that mirror the sidecar's exact wiring (same factories, same file naming).
const mkSave = () => makeSaveStore({ fs, pathMod: path, root: WS, clock });
const mkNotebook = () => makeMemoryStore({ fs, path, workspaces: WS, writeDurable: undefined });
const ROSTER_FILE = path.join(WS, 'agent.roster.json');
const CRON_FILE = path.join(WS, 'cron.jobs.json');
const loadRoster = () => { const r = readJsonResilient({ fs }, ROSTER_FILE); return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined; };
const saveRoster = (env) => writeJsonResilient({ fs, path }, ROSTER_FILE, env);
const loadCron = () => { const r = readJsonResilient({ fs }, CRON_FILE); return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined; };
const saveCron = (env) => writeJsonResilient({ fs, path }, CRON_FILE, env);

// ---------------------------------------------------------------------------------------------------------
// FIXTURE — a realistic seeded station: hero + a specialist crew member, a station build with desks + a bay
// bound to the specialist, workstreams, an agent-bound cron routine, and notebook memory. Modeled on the real
// dev/fixtures/seed-workspace + the shapes the stores persist.
// ---------------------------------------------------------------------------------------------------------
const HERO_STATS = { xp: 120, level: 3, lifetimeXp: 340, confidence: 61, samples: 8, counters: { runs: 8 }, milestones: ['first-run'] };
const SAVE_DOC = {
  schema: 'starnet.save', version: 6, updatedAt: 1700000000000,
  agent: {
    id: 'agent', name: 'NOVA', color: '#5ad0ff', model: 'anthropic/claude-sonnet-4.5', personaId: 'worker-homie',
    purpose: 'always-ready dev test agent', specialtyId: null, createdAt: 1699000000000,
    docs: { identity: 'You are NOVA.', purpose: 'test agent', manual: 'brief', context: 'dev build' },
    stats: HERO_STATS
  },
  agents: [
    { id: 'agent', name: 'NOVA', color: '#5ad0ff', model: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', skin: 'default', personaId: 'worker-homie' },
    { id: 'scout', name: 'SCOUT', color: '#ffd05a', model: 'openai/gpt-4o', provider: 'openrouter', skin: 'researcher', personaId: 'worker-nerd', specialtyId: 'researcher' }
  ],
  usage: { tokens: 4200, cost: 0.0891, calls: 8 }, prov: 'openrouter',
  station: {
    props: [
      { id: 'desk1', kind: 'desk', x: 3, y: 4, agentId: 'agent' },
      { id: 'desk2', kind: 'desk', x: 7, y: 4, agentId: 'scout' },
      { id: 'bay1', kind: 'bay', x: 10, y: 2, agentId: 'scout' }
    ],
    floor: 'grid'
  },
  stationStats: { xp: 200, level: 4, lifetimeXp: 540, confidence: 58, samples: 12, counters: {}, milestones: [] },
  profile: { v: 1, tags: { research: 3, coding: 1 }, seed: 'builder', enabled: true, total: 4 },
  worksignal: { v: 1, ewma: { web: 0.4, fs: 0.2 }, updatedAt: 1699500000000 },
  dossier: { v: 1, dims: { identity: ['builder'], stack: ['node'], goals: ['ship'], style: [], standing_orders: [], pain: [], ambition: [] }, seededFrom: { identity: 'onboarding' }, updatedAt: 1699000000000 },
  workstreams: [
    { id: 'ws_general', title: null, lane: 'active', roomId: null, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello Commander' }], cost: { tokens: 4200, usd: 0.0891, calls: 8 } },
    { id: 'ws_abc', title: 'Research spike', lane: 'shipped', roomId: null, history: [{ role: 'user', content: 'research X' }], cost: { tokens: 0, usd: 0, calls: 0 } }
  ],
  activeId: 'ws_general', generalId: 'ws_general'
};

const ROSTER_ENV = {
  version: 1, updatedAt: 1700000000000,
  agents: [
    { agentId: 'agent', system: 'You are NOVA.', name: 'NOVA', model: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', role: 'general assistant', approvalMode: 'ask', skills: ['web', 'fs'], reasoningEffort: null },
    { agentId: 'scout', system: 'You are SCOUT, a researcher.', name: 'SCOUT', model: 'openai/gpt-4o', provider: 'openrouter', role: 'researcher', approvalMode: 'full', skills: ['web'], reasoningEffort: 'high' }
  ]
};

const CRON_JOBS = [
  cronStore.makeJob({ name: 'Morning research', prompt: 'summarize overnight news', schedule: { kind: 'daily', at: '08:00' }, agentId: 'scout', model: 'openai/gpt-4o', provider: 'openrouter', deliver: 'notebook' }, { id: 'job_research', now: 1700000000000 })
];

const NOTEBOOK_NOVA = ['Commander prefers terse replies.', 'The station boots from a golden fixture.'];
const NOTEBOOK_SCOUT = ['Researcher: cite sources, no speculation.'];

// ---------------------------------------------------------------------------------------------------------
// SEED — write the fixture through the REAL store writers (as a running sidecar would).
// ---------------------------------------------------------------------------------------------------------
{
  const save = mkSave();
  A.eq(save.save('agent', SAVE_DOC).ok, true, 'seed: save doc persisted');
  saveRoster(ROSTER_ENV);
  saveCron(cronStore.toEnvelope(CRON_JOBS));
  const nb = mkNotebook();
  nb.set('notebook:agent', NOTEBOOK_NOVA);
  nb.set('notebook:scout', NOTEBOOK_SCOUT);
}

// deep-read the full station state through fresh stores. Returns a normalized snapshot object.
function readWorld() {
  const save = mkSave();
  const nb = mkNotebook();
  return {
    save: save.load('agent'),
    roster: loadRoster(),
    cron: cronStore.loadEnvelope(loadCron()),
    notebook: { agent: nb.get('notebook:agent'), scout: nb.get('notebook:scout') }
  };
}

// ---------------------------------------------------------------------------------------------------------
// (2) SNAPSHOT PASS — first boot loads the seeded world.
// ---------------------------------------------------------------------------------------------------------
const snap = readWorld();
A.eq(snap.save.agent.name, 'NOVA', 'snapshot: hero loaded');
A.eq(snap.save.agents.length, 2, 'snapshot: crew (hero + specialist) loaded');
A.eq(snap.save.station.props.filter(p => p.kind === 'bay')[0].agentId, 'scout', 'snapshot: bay bound to the specialist');
A.eq(snap.save.workstreams.length, 2, 'snapshot: workstreams loaded');
A.eq(snap.roster.agents.length, 2, 'snapshot: roster has both agents');
A.eq(snap.cron.jobs.length, 1, 'snapshot: cron routine loaded');
A.eq(snap.cron.jobs[0].agentId, 'scout', 'snapshot: cron routine bound to the specialist');
A.eq(snap.notebook.agent, NOTEBOOK_NOVA, 'snapshot: hero notebook loaded');
A.eq(snap.notebook.scout, NOTEBOOK_SCOUT, 'snapshot: specialist notebook loaded');

// ---------------------------------------------------------------------------------------------------------
// (3) REBOOT PASS — "new version boots on old data". No re-write between passes: fresh stores re-read the SAME
// dir and must return byte/structure-identical state. This is the core same-code parity assertion.
// ---------------------------------------------------------------------------------------------------------
const reboot = readWorld();
A.eq(reboot.save, snap.save, 'REBOOT PARITY: save doc is byte-identical after a restart');
A.eq(reboot.roster, snap.roster, 'REBOOT PARITY: roster envelope is byte-identical after a restart');
A.eq(reboot.cron, snap.cron, 'REBOOT PARITY: cron routines are byte-identical after a restart');
A.eq(reboot.notebook, snap.notebook, 'REBOOT PARITY: notebook memory is byte-identical after a restart');

// belt-and-suspenders: a whole-world deep-diff of the two passes (everything except the documented savedAt stamp,
// which readWorld() already discards by reading .doc, not the envelope). Any unexpected drift shows as a readable diff.
{
  const a = JSON.stringify(snap), b = JSON.stringify(reboot);
  A.ok(a === b, 'REBOOT PARITY: full-world snapshot deep-equals the reboot read (no drift)\n  snap:   ' + a.slice(0, 400) + '\n  reboot: ' + b.slice(0, 400));
}

// ---------------------------------------------------------------------------------------------------------
// (4) RE-SAVE FIELD PRESERVATION (P1.1) — new code re-saving state must not drop fields it doesn't model.
// Simulate the sidecar's roster reshape-on-save: an unknown-to-this-version per-agent field must survive a
// round-trip. Mirrors sidecar/index.js saveAgentRoster()'s ROSTER_KNOWN_FIELDS + preserved-unknown-fields spread.
// ---------------------------------------------------------------------------------------------------------
{
  const ROSTER_KNOWN_FIELDS = ['agentId', 'system', 'name', 'model', 'provider', 'role', 'approvalMode', 'skills', 'reasoningEffort'];
  // a roster written by a NEWER frontend that added a field this version doesn't know about.
  const futureRoster = {
    version: 1, updatedAt: 1700000001000,
    agents: [Object.assign({}, ROSTER_ENV.agents[1], { futureVibeScore: 0.99, anotherNewField: { nested: true } })]
  };
  saveRoster(futureRoster);
  // the reshape older code applies on its next re-save: rebuild known fields, spread unknown fields under them.
  const loaded = loadRoster();
  const reshaped = {
    version: 1, updatedAt: loaded.updatedAt,
    agents: loaded.agents.map(a => {
      const known = { agentId: a.agentId, system: a.system || '', name: a.name || a.agentId, model: a.model || null, provider: a.provider || null, role: a.role || '', skills: Array.isArray(a.skills) ? a.skills : [], reasoningEffort: a.reasoningEffort || null };
      const preserved = {};
      for (const k of Object.keys(a)) { if (!ROSTER_KNOWN_FIELDS.includes(k)) preserved[k] = a[k]; }
      return Object.assign(preserved, known);
    })
  };
  saveRoster(reshaped);
  const after = loadRoster();
  A.eq(after.agents[0].futureVibeScore, 0.99, 'RE-SAVE PRESERVES: an unknown scalar field survives a re-save by older code');
  A.eq(after.agents[0].anotherNewField, { nested: true }, 'RE-SAVE PRESERVES: an unknown nested field survives a re-save');
  A.eq(after.agents[0].name, 'SCOUT', 'RE-SAVE PRESERVES: known fields still present');
  // restore the canonical roster so nothing downstream reads the future-field fixture.
  saveRoster(ROSTER_ENV);
}

// ---------------------------------------------------------------------------------------------------------
// (5) FRONTEND SAVE MIGRATION LOSSLESSNESS — run Save.migrate() (frontend/app/save.js) in a vm sandbox.
// save.js has no module.export (its migration lives inline + delegates v1 to Workstreams.migrateV1, which IS
// require-able); load it in an isolated context with a localStorage stub + the real Workstreams injected, then
// migrate a v1 doc and a current-version doc and assert losslessness.
// ---------------------------------------------------------------------------------------------------------
// Build a fresh Save module in its own vm sandbox with a localStorage stub + the real (require-able) Workstreams
// injected. save.js has NO module.export and does NOT expose migrate() publicly — so we exercise the REAL
// production migration path: seed the localStorage key, then Save.load() (which runs migrate() internally). The
// returned `set` lets the caller seed the stored raw doc; `load` reads+migrates it exactly as boot does.
function loadSaveModule() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'save.js'), 'utf8');
  const store = {};
  const sandbox = {
    Workstreams: require('../frontend/app/workstreams.js'),
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    console: { warn() {}, info() {}, log() {} },
    module: undefined
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__Save = Save;', sandbox, { filename: 'save.js' });
  // migrate(doc) via the real load path: stash the doc under the save KEY, then load() (migrates in place).
  const migrateViaLoad = (doc) => { store['starnet.save'] = JSON.stringify(doc); delete store['starnet.save.pre-migrate.backup']; return sandbox.__Save.load(); };
  return { Save: sandbox.__Save, migrateViaLoad };
}

{
  const { Save, migrateViaLoad } = loadSaveModule();
  A.eq(Save.CURRENT, 7, 'migration: CURRENT schema version is 7 (update the fixtures if this bumps)');

  // --- v1 doc: the oldest schema (single flat history). Every top-level field must survive or be folded. ---
  const V1 = {
    schema: 'starnet.save', version: 1,
    agent: { id: 'agent', name: 'ULTRON', model: 'anthropic/claude-sonnet-4.5', purpose: 'serve' },
    history: [{ role: 'user', content: 'what is my purpose?' }, { role: 'assistant', content: 'to serve, Commander.' }],
    usage: { tokens: 1200, cost: 0.0345, calls: 3 },
    updatedAt: 1700000000000
  };
  const m1 = migrateViaLoad(V1);
  A.eq(m1.version, 7, 'v1->v7: version stamped to CURRENT');
  // losslessness: the identity + lifetime usage carried to the root untouched.
  A.eq(m1.agent.name, 'ULTRON', 'v1->v7: agent identity preserved');
  A.eq(m1.agent.purpose, 'serve', 'v1->v7: agent custom field preserved (no silent drop)');
  A.eq(m1.usage, V1.usage, 'v1->v7: lifetime usage preserved verbatim at the root');
  // the v1 flat history is FOLDED (documented) into a General workstream — not dropped.
  A.ok(Array.isArray(m1.workstreams) && m1.workstreams.length === 1, 'v1->v7: history folded into exactly one General workstream (not dropped)');
  A.eq(m1.workstreams[0].history, V1.history, 'v1->v7: the v1 history rides into General verbatim (lossless fold)');
  A.eq(m1.workstreams[0].cost, { tokens: 1200, usd: 0.0345, calls: 3 }, 'v1->v7: General cost SEEDED from lifetime usage (nothing invented, nothing lost)');
  A.eq(m1.activeId, 'ws_general', 'v1->v7: activeId set to General');
  // each later migration seeds its slice (stats/profile/dossier) — present + valid, never null.
  A.ok(m1.agent.stats && typeof m1.agent.stats === 'object', 'v1->v7: agent growth stats seeded (v2)');
  A.ok(m1.profile && m1.profile.v === 1, 'v1->v7: personalization profile seeded (v3)');
  A.ok(m1.dossier && m1.dossier.v === 1, 'v1->v7: commander dossier seeded (v4)');
  A.eq(m1.workstreams[0].titleStrong, false, 'v1->v7: title provenance is explicitly weak unless proved strong (v5->v6)');
  // NO v1 USER-STATE field was silently dropped. Every original key is accounted for as exactly one of:
  //   - survived verbatim (agent, usage)
  //   - documented FOLD into a new home (history -> workstreams)
  //   - an ENVELOPE stamp the writer re-applies on every persist (schema, updatedAt) — Save.write() re-adds both
  //     with Object.assign({ schema, version, updatedAt: Date.now() }, state), so the migrator dropping them from
  //     its intermediate output is not state loss: the next persist reconstructs them. We PROVE that here rather
  //     than asserting a false "every key present after migrate()" invariant.
  const foldedFromV1 = new Set(['history']);        // history -> workstreams (documented v1->v2 fold)
  const envelopeStamps = new Set(['schema', 'updatedAt']);   // re-stamped by Save.write() on every persist
  for (const k of Object.keys(V1)) {
    if (foldedFromV1.has(k) || envelopeStamps.has(k)) continue;
    A.ok(k in m1, 'v1->v7: user-state field "' + k + '" survived migration (no silent drop)');
  }
  // prove the envelope stamps are reconstructed by a write (they are NOT lost — the writer owns them).
  const rewritten = Save.write(m1);
  A.eq(rewritten.schema, 'starnet.save', 'v1->v7: Save.write() re-stamps the schema tag (envelope field, not lost)');
  A.eq(rewritten.version, 7, 'v1->v7: Save.write() stamps the current version');
  A.ok(typeof rewritten.updatedAt === 'number' && rewritten.updatedAt > 0, 'v1->v7: Save.write() re-stamps updatedAt (envelope field, not lost)');

  // --- v6 doc (every install before history-by-reference): the migration is the identity but for the stamp. An inline history IS a valid
  // v7 history, so nothing is moved, folded or re-keyed; packing happens later, as rows are sealed (frontend/app/historyref.js). ---
  const V6 = JSON.parse(JSON.stringify(SAVE_DOC));
  A.eq(V6.version, 6, 'fixture: the seeded save is a v6 one');
  const m6 = migrateViaLoad(JSON.parse(JSON.stringify(V6)));
  A.eq(m6.version, 7, 'v6->v7: version stamped to CURRENT');
  A.eq(m6, Object.assign(JSON.parse(JSON.stringify(V6)), { version: 7 }), 'v6->v7: a v6 doc migrates losslessly (every field and every history row exactly as saved, only the stamp moves)');

  // --- current-version doc: migration must be an IDEMPOTENT no-op (byte-identical), never re-stamp/re-fold. ---
  const CUR = JSON.parse(JSON.stringify(SAVE_DOC));
  CUR.version = 7;
  const mCur = migrateViaLoad(CUR);
  A.eq(mCur.version, 7, 'v7->v7: version stays CURRENT');
  A.eq(mCur, CUR, 'v7->v7: a current-version doc migrates losslessly (byte-identical, no field churn)');
}

// --- (4) MANUAL-FALLBACK ENDPOINT PARITY. updates.js bakes RELEASES_PAGE (the human releases
// page behind DOWNLOAD LATEST MANUALLY) as a second copy of the repo slug that tauri.conf.json's
// updater endpoint carries. If the releases repo ever moves and only one is updated, the manual
// fallback would silently send users to a dead/stale page — exactly when the auto-updater is
// already failing. Lock the two to the same owner/repo.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.resolve(__dirname, '..');
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8').replace(/^﻿/, ''));
  const endpoint = conf.plugins.updater.endpoints[0];
  const updatesSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'updates.js'), 'utf8');
  const pageMatch = updatesSrc.match(/RELEASES_PAGE = '([^']+)'/);
  A.ok(pageMatch, 'updates.js declares RELEASES_PAGE');
  const slugOf = u => (String(u).match(/github\.com\/([^/]+\/[^/]+)\//) || [])[1];
  A.eq(slugOf(pageMatch[1] + '/'), slugOf(endpoint),
    'manual-fallback releases page and the baked updater endpoint point at the SAME owner/repo');
  A.ok(/\/releases\/latest$/.test(pageMatch[1]), 'manual fallback points at /releases/latest (never a pinned tag)');
}

A.report('update-state-parity');
