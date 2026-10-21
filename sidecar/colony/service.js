'use strict';
const crypto = require('node:crypto');
const { makeDurableJsonStore } = require('../durable-store.js');
const Core = require('./core.js');
const Processes = require('./processes.js');

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
  function artifact(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) Core.fail('COLONY_INVALID_ARTIFACT');
    const file = path.join(root, 'colony', 'artifacts', hash + '.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) Core.fail('COLONY_INVALID_ARTIFACT');
    const bytes = fs.readFileSync(file); if (sha(bytes) !== hash) Core.fail('COLONY_ARTIFACT_CHANGED'); return JSON.parse(bytes);
  }
  async function uploadAsset(body) {
    if (body.expectedRevision !== read().revision) Core.fail('COLONY_REVISION_CONFLICT');
    if (body.rightsConfirmed !== true || typeof body.png !== 'string' || body.png.length > 12 * 1024 * 1024) Core.fail('COLONY_ASSET_UNCONFIRMED');
    const bytes = Buffer.from(body.png, 'base64');
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') Core.fail('COLONY_PNG_REQUIRED');
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    if (!w || !h || w * h > 8000000 || w > 4096 || h > 4096) Core.fail('COLONY_IMAGE_TOO_LARGE');
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(bytes), canvas = createCanvas(w, h); canvas.getContext('2d').drawImage(img, 0, 0);
    const hash = writeImage(canvas.toBuffer('image/png'));
    return command({ type: 'asset.register', verified: true, rightsConfirmed: true, businessUnitId: body.businessUnitId, account: body.account, sha256: hash, expectedRevision: body.expectedRevision });
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
      if (!Processes.isPins(t)) {
        const images = [];
        if (t.outputKind === 'social') {
          for (const item of t.items) {
            const asset = s.assets?.[item.assetId];
            if (!asset || asset.businessUnitId !== t.businessUnitId || asset.account !== t.account || !asset.rightsConfirmed) Core.fail('COLONY_ASSET_SCOPE_UNCONFIRMED');
            image(asset.sha256); images.push({ pinId: item.id, businessUnitId: t.businessUnitId, sha256: asset.sha256, mime: 'image/png', version: asset.sha256 });
          }
        }
        if (t.outputKind === 'site_quality') {
          const needed = ['mobile', 'links'].concat(t.inputs.change_package.affectsTools ? ['tools'] : []);
          const checks = t.inputs.checks || [];
          if (!needed.every(kind => checks.some(c => c.kind === kind && c.confirmed === true && c.passed === true && c.version === t.inputs.change_package.version && t.sources.some(src => src.id === c.sourceId)))) {
            return command({ type: 'task.block', taskId, expectedRevision, reason: 'actual_versioned_mobile_link_or_tool_checks_missing' });
          }
          const screenshots = t.inputs.screenshots || [];
          if (!screenshots.length) return command({ type: 'task.block', taskId, expectedRevision, reason: 'actual_mobile_screenshot_required' });
          for (const entry of screenshots) {
            const asset = s.assets?.[entry.id];
            if (!asset || asset.businessUnitId !== t.businessUnitId || asset.account !== t.account) Core.fail('COLONY_ASSET_SCOPE_UNCONFIRMED');
            image(asset.sha256); images.push({ pinId: entry.pageId || '*', businessUnitId: t.businessUnitId, sha256: asset.sha256, mime: 'image/png', version: asset.sha256 });
          }
        }
        const bytes = Buffer.from(JSON.stringify({ businessUnitId: t.businessUnitId, processId: t.processId, processVersion: t.processVersion, inputs: t.inputs, items: t.items, sources: t.sources }, null, 2));
        const hash = sha(bytes), file = path.join(root, 'colony', 'artifacts', hash + '.json');
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(file)) require('../durable-write.js').writeFileDurable({ fs, path }, file, bytes);
        artifact(hash);
        await command({ type: 'task.package', taskId, expectedRevision, verified: true, artifacts: [{ businessUnitId: t.businessUnitId, sha256: hash, mime: 'application/json', version: hash }, ...images] });
        const current = read();
        return command({ type: 'task.formal', taskId, expectedRevision: current.revision, verified: true, digest: Core.snapshotDigest(current.tasks[taskId]) });
      }
      try { for (const artifact of t.artifacts) image(artifact.sha256); }
      catch (_) { return command({ type: 'task.block', taskId, expectedRevision, reason: 'artifact_missing_or_changed' }); }
      return command({ type: 'task.formal', taskId, expectedRevision, verified: true, digest: Core.snapshotDigest(t) });
    }
    Core.fail('COLONY_NOT_TECHNICAL_STEP');
  }
  async function run(taskId, expectedRevision, reserve, execute) {
    const s = read(), t = s.tasks[taskId];
    if (!t) Core.fail('COLONY_TASK_NOT_FOUND');
    if (Core.nextStep(t) === 'formal' || (Core.nextStep(t) === 'design' && Processes.isPins(t))) return technical(taskId, expectedRevision);
    if (typeof execute !== 'function') Core.fail('COLONY_RUNTIME_NOT_CONNECTED');
    const started = await command({ type: 'attempt.start', taskId, expectedRevision, reserve });
    const a = started.result; live.add(a.id);
    let response;
    const began = now();
    try {
      const imageRefs = a.stepId === 'review' && t.outputKind === 'social' ? t.inputs.owned_assets.map(x => s.assets[x.id])
        : a.stepId === 'review' && t.outputKind === 'site_quality' ? t.inputs.screenshots.map(x => s.assets[x.id])
        : a.stepId === 'review' ? a.context.artifacts.filter(x => x.mime === 'image/png')
        : a.stepId === 'design' && t.outputKind === 'social' ? t.inputs.owned_assets.map(x => s.assets[x.id]) : [];
      const images = imageRefs.map(x => ({
        type: 'image_url', image_url: { url: 'data:image/png;base64,' + image(x.sha256).toString('base64') }
      }));
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
            const current = read().tasks[taskId], attempt = current && current.attempts.find(x => x.id === finish.attemptId);
            if (error.code && attempt && (Processes.REPAIRABLE_OUTPUT_ERRORS.has(error.code) && attempt.stepId !== 'review' || attempt.stepId === 'review' && (current.reviewRetries || 0) < 1)) {
              return command({ type: 'attempt.reject_output', taskId, attemptId: a.id, usage, reason: error.code,
              feedback: Processes.outputRepairHint(error.code), expectedRevision: read().revision });
            }
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
        if (['COLONY_BUDGET_EXHAUSTED', 'COLONY_POOL_BUDGET_EXHAUSTED', 'COLONY_POOL_SPEND_UNKNOWN', 'COLONY_REVISION_LIMIT'].includes(error.code)) {
          return command({ type: 'task.block', taskId, expectedRevision: read().revision, reason: error.code });
        }
        throw error;
      }
      if (!['queued', 'needs_revision'].includes(out.result.status)) return out;
      if (Core.limitKeys(out.result).some(k => out.result.spent[k] + perRun[k] > out.result.budget[k])) {
        return command({ type: 'task.block', taskId, expectedRevision: read().revision, reason: 'remaining_budget_below_next_reservation' });
      }
    }
  }
  async function recover(expectedRevision) { return command({ type: 'recovery.scan', expectedRevision, liveAttempts: [...live] }); }
  function view() {
    const s = read();
    return { ...s, observedAt: now(), online: true, realPilotAccepted: false,
      processes: Object.fromEntries(Object.entries(s.processes).map(([id, p]) => {
        const roles = p.roles.filter(role => role !== 'design' || p.outputKind !== 'pins');
        const configured = roles.every(role => { const wire = s.configuration.models['colony_' + p.businessUnitId + '_' + role]; return wire && (!deps.ready || deps.ready(wire) === true); });
        const fixerWire = p.qualityLoop?.fixerRole && s.configuration.models['colony_' + p.businessUnitId + '_' + p.qualityLoop.fixerRole];
        const fixerConfigured = !!fixerWire && (!deps.ready || deps.ready(fixerWire) === true);
        return [id, { ...p, nativeBlueprint: s.configuration.installation?.mappings?.[id]?.blueprint || null,
          enabled: p.implemented && s.configuration.enabled && configured, configured, fixerConfigured }];
      })),
      limitations: [s.configuration.installation ? 'BU-Räume und Pipelines sind eingerichtet; der echte Pilot ist noch offen.' : 'BU-Räume/Pipelines: Vorschau vorhanden; Einrichtung muss noch konsistent aktiviert werden.',
        'Pinterest-Dashboard: Snapshot-Vorschau, noch keine Verbindung oder Schreibintegration.',
        'KVP: Fallaufnahme vorhanden; unabhängige Verbesserungsevaluation und automatische Übernahme noch offen.',
        'Interne Fachabläufe erzeugen geprüfte Entwürfe. Versand, Shopänderungen und Veröffentlichung sind weiterhin nicht angeschlossen oder freigegeben.',
        'Vor jedem Auftrag sind echte Quellen, prozessspezifische Eingaben, bestätigte Konten und Token-/Zeitbudgets erforderlich.'],
      inbox: Object.values(s.tasks).filter(t => !t.testOnly && t.status === 'ready_for_approval' && Core.quality(t)).map(t => ({
        taskId: t.id, businessUnitId: t.businessUnitId, digest: Core.snapshotDigest(t), pinIds: Core.selections(t).map(p => p.id),
        account: t.account, audience: t.audience, schedule: t.schedule, summary: t.review.summary || '', actions: s.processes[t.processId].actions.length ? s.processes[t.processId].actions : ['accept'] })),
      team: s.agents.map(a => {
        const active = Object.values(s.tasks).flatMap(t => t.attempts.filter(x => x.state === 'running' && live.has(x.id) && x.agentId === a.id)
          .map(x => ({ ...x, processId: t.processId, artifactVersions: t.artifacts.map(v => v.version) })));
        const pending = Object.values(s.tasks).filter(t => !t.testOnly && t.businessUnitId === a.businessUnitId && t.status === 'blocked');
        const decision = Object.values(s.tasks).some(t => !t.testOnly && t.businessUnitId === a.businessUnitId && t.status === 'ready_for_approval');
        const configured = !!s.configuration.models[a.id];
        const ready = configured && typeof deps.ready === 'function' && deps.ready(s.configuration.models[a.id]) === true;
        const executionConnected = Object.values(s.processes).some(p => p.businessUnitId === a.businessUnitId && p.implemented &&
          (p.roles.includes(a.role) || p.qualityLoop?.fixerRole === a.role));
        return { ...a, executionConnected, state: active.length ? 'active' : !ready ? 'offline' : !executionConnected || pending.length ? 'waiting_external' : decision ? 'waiting_user' : 'available',
          runs: active.map(x => ({ runId: x.runId, taskId: x.taskId, processId: x.processId, stepId: x.stepId, artifactVersions: x.artifactVersions })), configured: !!s.configuration.models[a.id],
          nativeInstalled: !!s.configuration.installation?.agentIds.includes(a.id) };
      }) };
  }
  return { read, view, command, run, runToGate, recover, technical, image, artifact, uploadAsset, modelDefaults: () => deps.modelDefaults?.() || {}, exclusive: fn => store.mutex.run('colony', fn) };
}
module.exports = { makeService };
