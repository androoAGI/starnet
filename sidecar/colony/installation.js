'use strict';

// One sidecar owns the workspace. A durable intent fences ALL readers/writers
// while the four existing representations are materialized. A crash resumes
// only when every file is still exactly BEFORE or AFTER, never over foreign work.
const { readJsonResilient, writeJsonResilient } = require('../durable-store.js');
const { writeFileDurable } = require('../durable-write.js');
const { digest, fail } = require('./core.js');
const FILES = ['agent.save.json', 'agent.roster.json', 'routing.plan.json', 'colony/state.json'];
function makeInstallation({ fs, path, root, now, newId }) {
  const journalFile = path.join(root, 'colony', 'installation.json');
  let busy = false;
  function raw(name) {
    if (!FILES.includes(name)) fail('COLONY_INVALID_INSTALLATION_PATH');
    try {
      const file = path.join(root, name), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) fail('COLONY_INVALID_INSTALLATION_SOURCE');
      return fs.readFileSync(file, 'utf8');
    }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  function journal() {
    const r = readJsonResilient({ fs }, journalFile);
    if (r.status === 'absent') return null;
    if (r.status !== 'ok') fail('COLONY_INSTALLATION_JOURNAL_RECOVERY_REQUIRED');
    const j = r.value;
    if (!j || j.version !== 1 || !['pending', 'committed', 'rolling_back', 'rolled_back'].includes(j.state) ||
      !Array.isArray(j.parts) || j.parts.length !== FILES.length || j.parts.some((p, i) => p.name !== FILES[i]) ||
      j.parts.some(p => p.before !== null && typeof p.before !== 'string' || typeof p.after !== 'string' || digest(p.after) !== p.afterDigest || digest(p.before) !== p.beforeDigest)) fail('COLONY_INVALID_INSTALLATION_JOURNAL');
    return j;
  }
  function saveJournal(j) {
    fs.mkdirSync(path.dirname(journalFile), { recursive: true, mode: 0o700 });
    writeJsonResilient({ fs, path }, journalFile, j);
    if (digest(journal()) !== digest(j)) fail('COLONY_INSTALLATION_NOT_DURABLE');
  }
  function backup(id, parts) {
    const dir = path.join(root, 'colony', 'backups', id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const p of parts) if (p.before !== null) writeFileDurable({ fs, path }, path.join(dir, p.name.replace(/\//g, '__')), p.before);
    writeFileDurable({ fs, path }, path.join(dir, 'manifest.json'), JSON.stringify(parts.map(p => ({ name: p.name, present: p.before !== null, digest: p.beforeDigest }))));
    return path.join('colony', 'backups', id);
  }
  function materialize(j, target) {
    // Verify all preconditions before touching any representation.
    for (const p of j.parts) {
      const current = raw(p.name);
      if (current !== p.before && current !== p.after) fail('COLONY_INSTALLATION_FOREIGN_WRITE');
    }
    for (const p of j.parts) {
      const file = path.join(root, p.name), bytes = p[target];
      if (raw(p.name) === bytes) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (bytes === null) fs.unlinkSync(file); // only this exact file, created by this installation
      else writeFileDurable({ fs, path }, file, bytes);
    }
    for (const p of j.parts) if (raw(p.name) !== p[target]) fail('COLONY_INSTALLATION_READBACK_FAILED');
  }
  function recover() {
    const j = journal();
    if (!j || !['pending', 'rolling_back'].includes(j.state)) return { changed: false, state: j && j.state || 'absent' };
    busy = true;
    try {
      const rollback = j.state === 'rolling_back'; materialize(j, rollback ? 'before' : 'after');
      j.state = rollback ? 'rolled_back' : 'committed'; j.settledAt = now(); saveJournal(j);
      return { changed: true, state: j.state, commitId: j.id };
    } finally { busy = false; }
  }
  function assertReady() {
    const j = journal();
    if (busy || j && ['pending', 'rolling_back'].includes(j.state)) fail('COLONY_INSTALLATION_PENDING');
  }
  function status() {
    const j = journal();
    if (!j) return { state: 'absent', installed: false };
    return { state: j.state, installed: j.state === 'committed', commitId: j.id, saveRevision: j.saveRevision, backup: j.backup,
      baseStationDigest: j.baseStationDigest, stationDigest: j.stationDigest, agentIds: j.agentIds, mappings: j.mappings, rooms: j.rooms };
  }
  function preview(currentState, prepare) {
    assertReady();
    const value = raw('agent.save.json'); if (!value) fail('COLONY_NATIVE_SAVE_REQUIRED');
    const wrapper = JSON.parse(value), doc = wrapper.doc;
    if (!doc || !doc.agent) fail('COLONY_NATIVE_SAVE_REQUIRED');
    const prepared = prepare(doc);
    // Compare semantic station content, not volatile timestamps/dirty flags from
    // routine browser heartbeats. Save/state revisions still fence concurrent edits.
    const station = doc.station, agents = [doc.agent, ...(doc.agents || [])].filter(Boolean).map(a => a.id);
    return { nativeSaveRevision: doc._saveRevision || 0, stateRevision: currentState.revision,
      previewDigest: digest({ station, agents, stateRevision: currentState.revision, target: prepared.save.station }),
      original: doc, prepared };
  }
  function install(currentState, args, prepare, bind) {
    const p = preview(currentState, prepare);
    if (args.expectedSaveRevision !== p.nativeSaveRevision || args.expectedStateRevision !== p.stateRevision || args.previewDigest !== p.previewDigest) fail('COLONY_INSTALLATION_REVISION_CONFLICT');
    const old = journal(); if (old && old.state !== 'rolled_back') fail('COLONY_ALREADY_INSTALLED');
    const id = newId(), stamp = now(), target = p.prepared.save;
    target._saveRevision = p.nativeSaveRevision + 1; target._saveDirty = false;
    target.updatedAt = Math.max(stamp, (p.original.updatedAt || 0) + 1);
    const installation = { commitId: id, version: 1, baseStationDigest: digest(p.original.station) };
    target.colonyInstallation = installation;
    const previousRoster = raw('agent.roster.json');
    const oldRows = previousRoster ? JSON.parse(previousRoster).agents : [];
    if (!Array.isArray(oldRows)) fail('COLONY_INVALID_NATIVE_ROSTER');
    const ids = new Set(oldRows.map(a => a.agentId));
    const rows = structuredClone(oldRows);
    // Existing identities/settings are never reconstructed from a stale Save.
    // Only new identities are added to the actual roster.
    for (const a of target.agents || []) if (!ids.has(a.id)) {
      ids.add(a.id); rows.push({ agentId: a.id, name: a.name || a.id, model: a.model || '', provider: a.provider || target.agent.provider || 'custom',
        system: a.purpose || '', role: a.role || 'specialist', approvalMode: a.approvalMode || 'ask', executionProfile: a.executionProfile || 'station-gear',
        skills: a.skills || [], workshop: !!a.workshop });
    }
    if (!ids.has(target.agent.id)) rows.unshift({ agentId: target.agent.id, name: target.agent.name, model: target.agent.model || '',
      provider: target.agent.provider || 'custom', system: target.agent.purpose || '', approvalMode: target.agent.approvalMode || 'ask' });
    const agentIds = target.agents.filter(a => /^colony_(lifestruct|ashveil|homestackr)_/.test(a.id)).map(a => a.id);
    const nextState = bind(currentState, { commitId: id, mappings: p.prepared.mappings, rooms: p.prepared.rooms, agentIds });
    const values = [JSON.stringify({ ...JSON.parse(raw('agent.save.json')), version: 1, agentId: target.agent.id,
      updatedAt: target.updatedAt, requestUpdatedAt: target.updatedAt, savedAt: stamp, doc: target }),
      JSON.stringify({ ...(previousRoster ? JSON.parse(previousRoster) : {}), version: 1, updatedAt: Math.max(stamp, Number(previousRoster && JSON.parse(previousRoster).updatedAt || 0) + 1), agents: rows }),
      JSON.stringify(p.prepared.plan), JSON.stringify(nextState)];
    const parts = FILES.map((name, i) => { const before = raw(name); return { name, before, after: values[i], beforeDigest: digest(before), afterDigest: digest(values[i]) }; });
    const j = { version: 1, id, state: 'pending', at: stamp, parts, saveRevision: target._saveRevision,
      baseStationDigest: digest(p.original.station), stationDigest: digest(target.station), agentIds, mappings: p.prepared.mappings, rooms: p.prepared.rooms };
    busy = true;
    try {
      j.backup = backup(id, parts);
      saveJournal(j); materialize(j, 'after'); j.state = 'committed'; j.settledAt = now(); saveJournal(j);
    }
    finally { busy = false; }
    return status();
  }
  function rollback(commitId) {
    assertReady(); const j = journal();
    if (!j || j.state !== 'committed' || j.id !== commitId) fail('COLONY_INSTALLATION_NOT_CURRENT');
    // A new conversation or config edit is user work. Never undo it with a snapshot.
    if (j.parts.some(p => raw(p.name) !== p.after)) fail('COLONY_ROLLBACK_HAS_NEWER_WORK');
    j.state = 'rolling_back'; saveJournal(j); return recover();
  }
  function acceptsSave(doc) {
    assertReady(); const j = journal(); if (!j || j.state !== 'committed') return true;
    return doc.colonyInstallation?.commitId === j.id && j.agentIds.every(id => (doc.agents || []).some(a => a.id === id));
  }
  function acceptsRoster(body) {
    assertReady(); const j = journal(); if (!j || j.state !== 'committed') return true;
    return body.colonyInstallation?.commitId === j.id && j.agentIds.every(id => (body.agents || []).some(a => a.agentId === id));
  }
  function acceptsPlan(plan) {
    assertReady(); const j = journal(); if (!j || j.state !== 'committed') return true;
    return !!plan && Object.values(j.mappings).every(m => m.steps.every(id => plan.agentOfDock && plan.agentOfDock[id]));
  }
  return { recover, assertReady, status, preview, install, rollback, acceptsSave, acceptsRoster, acceptsPlan };
}
module.exports = { makeInstallation, FILES };
