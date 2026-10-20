'use strict';
const crypto = require('node:crypto');
const { makeDurableJsonStore } = require('../durable-store.js');
const Core = require('./core.js');

function makeService(deps) {
  const { fs, path, root, now, newId } = deps;
  const store = makeDurableJsonStore({ fs, path, fileFor: () => path.join(root, 'colony', 'state.json') });
  const live = new Set();
  function read() {
    const r = store.readKey('colony');
    if (r.status === 'absent') return Core.initial();
    // A backup can predate a decision or dispatch. Never auto-authorize from it.
    if (r.status !== 'ok') Core.fail('COLONY_STORE_REQUIRES_OPERATOR_RECOVERY');
    return structuredClone(Core.validate(r.value));
  }
  async function command(c) {
    const raw = JSON.stringify(c), scrub = deps.redact || require('../context.js').redact;
    if (scrub(raw) !== raw) Core.fail('COLONY_SECRET_IN_INPUT');
    let result, revision;
    await store.update('colony', () => {
      const out = Core.reduce(read(), c, { now: now(), id: newId() });
      result = out.result; revision = out.state.revision; return out.state;
    });
    return { revision, result };
  }
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  function imageFile(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) Core.fail('COLONY_INVALID_IMAGE_ID');
    return path.join(root, 'colony', 'artifacts', hash + '.png');
  }
  function image(hash) {
    const file = imageFile(hash), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) Core.fail('COLONY_INVALID_IMAGE');
    const bytes = fs.readFileSync(file); if (sha(bytes) !== hash) Core.fail('COLONY_IMAGE_CHANGED');
    return bytes;
  }
  function writeImage(bytes) {
    const hash = sha(bytes), file = imageFile(hash);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) {
      require('../durable-write.js').writeFileDurable({ fs, path }, file, bytes);
      fs.chmodSync(file, 0o600);
    }
    image(hash); return hash;
  }
  async function technical(taskId, expectedRevision) {
    const s = read(), t = s.tasks[taskId];
    if (!t) Core.fail('COLONY_TASK_NOT_FOUND');
    if (s.revision !== expectedRevision) Core.fail('COLONY_REVISION_CONFLICT');
    const step = Core.nextStep(t);
    if (step === 'design') {
      // Rendering is deterministic backend work, not a decorative model call.
      const render = deps.render || require('./visual.js').renderPin;
      const artifacts = structuredClone(t.artifacts);
      for (const pin of t.pins) {
        if (artifacts.some(a => a.pinId === pin.id)) continue;
        let bytes;
        try { bytes = await render(pin, s.brands[t.businessUnitId]); }
        catch (_) { return command({ type: 'task.technical_revision', taskId, expectedRevision, pinId: pin.id, reason: 'Das Overlay passt nicht in das geprüfte Bildlayout; Text gezielt kürzen.' }); }
        artifacts.push({ pinId: pin.id, businessUnitId: t.businessUnitId, sha256: writeImage(bytes), mime: 'image/png' });
      }
      return command({ type: 'task.design', taskId, artifacts, expectedRevision });
    }
    if (step === 'formal') {
      try { for (const artifact of t.artifacts) image(artifact.sha256); }
      catch (_) { return command({ type: 'task.block', taskId, expectedRevision, reason: 'artifact_missing_or_changed' }); }
      return command({ type: 'task.formal', taskId, expectedRevision, verified: true, digest: Core.snapshotDigest(t) });
    }
    Core.fail('COLONY_NOT_TECHNICAL_STEP');
  }
  async function run(taskId, expectedRevision, reserve, execute) {
    const s = read(), t = s.tasks[taskId];
    if (!t) Core.fail('COLONY_TASK_NOT_FOUND');
    if (['design', 'formal'].includes(Core.nextStep(t))) return technical(taskId, expectedRevision);
    if (typeof execute !== 'function') Core.fail('COLONY_RUNTIME_NOT_CONNECTED');
    const started = await command({ type: 'attempt.start', taskId, expectedRevision, reserve });
    const a = started.result; live.add(a.id);
    let response;
    const began = now();
    try {
      const images = a.stepId === 'review' ? a.context.artifacts.map(x => ({
        type: 'image_url', image_url: { url: 'data:image/png;base64,' + image(x.sha256).toString('base64') }
      })) : [];
      response = await execute({ ...a, images });
    } catch (error) {
      response = { ok: false, error: String(error.code || 'COLONY_RUNTIME_FAILED'), usage: null };
    }
    try {
      const usage = response.usage ? { ...response.usage, ms: now() - began } : null;
      const finish = { type: 'attempt.finish', taskId, attemptId: a.id, usage, ok: response.ok === true,
        output: response.output, error: response.error || 'runtime_result_unverified' };
      // An unrelated completed task may have advanced the aggregate revision. Only
      // retry this internal settlement, with the exact attempt fence still checked.
      return await store.mutex.run('settlement', async () => {
        for (let tries = 0; tries < 4; tries++) {
          try { return await command({ ...finish, expectedRevision: read().revision }); }
          catch (error) {
            if (error.code === 'COLONY_REVISION_CONFLICT') continue;
            if (error.code && error.code !== 'COLONY_STALE_ATTEMPT' && error.code !== 'COLONY_HOST_REQUIRED') {
              // Invalid output still cost money. Settle the same usage and block.
              return command({ ...finish, expectedRevision: read().revision, ok: false, error: error.code });
            }
            throw error;
          }
        }
        Core.fail('COLONY_SETTLEMENT_RETRY_REQUIRED');
      });
    } finally { live.delete(a.id); }
  }
  async function runToGate(taskId, expectedRevision, perRun, execute) {
    if (read().revision !== expectedRevision) Core.fail('COLONY_REVISION_CONFLICT');
    if (!read().configuration.enabled) Core.fail('COLONY_EXECUTION_NOT_ENABLED');
    for (;;) {
      const s = read(), t = s.tasks[taskId];
      if (!t) Core.fail('COLONY_TASK_NOT_FOUND');
      if (!['queued', 'needs_revision'].includes(t.status)) return { revision: s.revision, result: t };
      let out;
      try { out = await run(taskId, s.revision, perRun, execute); }
      catch (error) {
        if (['COLONY_BUDGET_EXHAUSTED', 'COLONY_POOL_BUDGET_EXHAUSTED', 'COLONY_POOL_SPEND_UNKNOWN'].includes(error.code)) {
          return command({ type: 'task.block', taskId, expectedRevision: read().revision, reason: error.code });
        }
        throw error;
      }
      if (!['queued', 'needs_revision'].includes(out.result.status)) return out;
      if (Object.keys(perRun).some(k => out.result.spent[k] + perRun[k] > out.result.budget[k])) {
        return command({ type: 'task.block', taskId, expectedRevision: read().revision, reason: 'remaining_budget_below_next_reservation' });
      }
    }
  }
  async function recover(expectedRevision) { return command({ type: 'recovery.scan', expectedRevision, liveAttempts: [...live] }); }
  function view() {
    const s = read();
    return { ...s, observedAt: now(), online: true, realPilotAccepted: false,
      limitations: [s.configuration.installation ? 'BU-Räume und Pipelines sind eingerichtet; der echte Pilot ist noch offen.' : 'BU-Räume/Pipelines: Vorschau vorhanden; Einrichtung muss noch konsistent aktiviert werden.',
        'Pinterest-Dashboard: Snapshot-Vorschau, noch keine Verbindung oder Schreibintegration.',
        'KVP: Fallaufnahme vorhanden; unabhängige Verbesserungsevaluation und automatische Übernahme noch offen.',
        'L02a/L02b, L03, Ashveil und HomeStackR: katalogisiert, noch keine ausführbaren Fachprozesse.',
        'Reale Quellen, bestätigte Konten, Modelle und konkrete Arbeitsbudgets sind noch vom Betreiber festzulegen.'],
      inbox: Object.values(s.tasks).filter(t => t.status === 'ready_for_approval' && Core.quality(t)).map(t => ({
        taskId: t.id, businessUnitId: t.businessUnitId, digest: Core.snapshotDigest(t), pinIds: t.pins.map(p => p.id),
        account: t.account, audience: t.audience, schedule: t.schedule, actions: s.processes[t.processId].actions })),
      team: s.agents.map(a => {
        const active = Object.values(s.tasks).flatMap(t => t.attempts.filter(x => x.state === 'running' && live.has(x.id) && x.agentId === a.id)
          .map(x => ({ ...x, processId: t.processId, artifactVersions: t.artifacts.map(v => v.version) })));
        const pending = Object.values(s.tasks).filter(t => t.businessUnitId === a.businessUnitId && t.status === 'blocked');
        const decision = Object.values(s.tasks).some(t => t.businessUnitId === a.businessUnitId && t.status === 'ready_for_approval');
        const configured = !!s.configuration.models[a.id];
        const ready = configured && typeof deps.ready === 'function' && deps.ready(s.configuration.models[a.id]) === true;
        return { ...a, state: active.length ? 'active' : !ready ? 'offline' : pending.length ? 'waiting_external' : decision ? 'waiting_user' : 'available',
          runs: active.map(x => ({ runId: x.runId, taskId: x.taskId, processId: x.processId, stepId: x.stepId, artifactVersions: x.artifactVersions })), configured: !!s.configuration.models[a.id],
          nativeInstalled: !!s.configuration.installation?.agentIds.includes(a.id) };
      }) };
  }
  return { read, view, command, run, runToGate, recover, technical, image, exclusive: fn => store.mutex.run('colony', fn) };
}
module.exports = { makeService };
