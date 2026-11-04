'use strict';
/* Test-only private route and authority injection into the real host. It never
   ships in index.js and permits only this allocated fixture's synthetic origin. */
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const target = path.resolve(__dirname, '../../sidecar/index.js');
const upstream = new URL(process.env.LINE_ENTRY_FIXTURE_UPSTREAM).origin;
const fixtureRoot = path.resolve(process.env.LINE_ENTRY_FIXTURE_ROOT || '');
if (!path.basename(fixtureRoot).startsWith('line-entry-host-')) throw new Error('entry fixture requires its allocated workspace');
const originalFetch = globalThis.fetch;
globalThis.fetch = function (url) {
  if (new URL(String(url && url.url || url)).origin !== upstream) return Promise.reject(new Error('entry fixture refused non-fixture network'));
  return originalFetch.apply(this, arguments);
};
const realRead = fs.readFileSync.bind(fs), realRename = fs.renameSync.bind(fs);
fs.renameSync = function (from, to) {
  if (path.resolve(String(to)) === path.join(fixtureRoot, 'line-jobs.json')) {
    const mode = JSON.parse(realRead(path.join(fixtureRoot, 'fixture-control.json'), 'utf8'));
    if (typeof mode.failObservationRunId === 'string') {
      const next = JSON.parse(realRead(from, 'utf8'));
      if (next.jobs.some(j => j.entryAdmission && j.entryAdmission.state === 'observed'
        && j.entryAdmission.binding.entryRunId === mode.failObservationRunId)) throw Object.assign(new Error('fixture observation write refused'), { code: 'EIO' });
    }
  }
  return realRename(from, to);
};
const compile = Module.prototype._compile;
Module.prototype._compile = function (source, filename) {
  if (path.resolve(filename) !== target) return compile.call(this, source, filename);
  const old = process.env.LINE_ENTRY_HOST_CONTROL_INDEX;
  if (old) {
    source = realRead(old, 'utf8');
    const hash = crypto.createHash('sha256').update(source).digest('hex');
    if (hash !== process.env.LINE_ENTRY_HOST_CONTROL_SHA256) throw new Error('entry control source hash mismatch');
    console.log('CONTROL_SOURCE LINE_ENTRY_HOST_CONTROL_INDEX SHA256=' + hash);
  }
  // Both control and current receive the SAME new private helper fixture. The
  // exact old host still lacks dequeue/finalizer integration; no method error is
  // counted as the expected failure.
  if (!source.includes("const LineEntryInvocation = require('./routing/line-entry-invocation.js')")) {
    source = "const LineEntryInvocation = require('./routing/line-entry-invocation.js');\n" + source;
  }
  const factory = 'const lineEntryInvocations = LineEntryInvocation.makeEntryInvocation({ prepare: lineJobsPrepareEntry,\n  checkpoint: lineJobsCheckpointEntry, run: options => runOnce(options), authority: null });';
  if (!source.includes(factory)) {
    const boundary = '/* Private H3 checkpoint bridge.';
    if (!source.includes(boundary)) throw new Error('entry fixture host owner boundary missing');
    source = source.replace(boundary, factory + '\n' + boundary);
  }
  source = source.replace(factory, factory.replace('authority: null', 'authority: __entryFixtureAuthority'));
  const routes = 'const ROUTES = [';
  if (!source.includes(routes)) throw new Error('entry fixture route owner boundary missing');
  source = source.replace(routes, routes + '\n  { m: "POST", exact: "/api/_entry-fixture", h: __entryFixtureRun },');
  source += '\n' + String.raw`
async function __entryFixtureAuthority({ receipt }) {
  const allowed = JSON.parse(fs.readFileSync(path.join(WORKSPACES, 'fixture-authority.json'), 'utf8'));
  // Synthetic fresh authority input, only for this test. No posted routing plan
  // or production saved-floor policy is represented by this fixture callback.
  return allowed.inputDigest === receipt.inputDigest && JSON.stringify(allowed.binding) === JSON.stringify(receipt.binding);
}
async function __entryFixtureRun(req, res) {
  const body = await readJsonBody(req, readBody, 1 << 20, res); if (!body) return;
  const request = body.receipt;
  if (!LineJobs.get(lineJobs, body.job.id)) lineJobsSet(s => LineJobs.start(s, Object.assign({}, body.job, { at: request.at })));
  request.ledgerId = lineJobsEnrollAccounting().ledgerId;
  const b = request.binding;
  const plan = router.getPlan();
  const routing = { hash: plan && plan.hash, lineId: router.lineOfDock(b.entryNode.dockId),
    agentId: router.agentOfDock(b.entryNode.dockId), intakePresent: !!(plan && plan.sources.some(s => s.propId === b.intakeId)) };
  const out = await lineEntryInvocations.execute(body.job.id, request, {
    runId: b.entryRunId, workitemId: b.workitemId, agentId: b.entryNode.agentId, dockId: b.entryNode.dockId,
    lineId: b.lineId, streamId: b.streamId, messages: [{ role: 'user', content: request.input.text }],
    provider: 'openrouter', model: 'test/model', key: 'entry-fixture-key',
    isTask: false, surface: 'autonomous', reflect: false, trigger: 'event', resumeSeed: false, emit() {}
  });
  respondJson(res, 200, { invoked: out.invoked, confirmed: out.confirmed, receipt: out.receipt, usageStatus: out.usageStatus,
    executionError: out.executionError ? String(out.executionError.code || 'execution_error') : null,
    observationError: out.observationError ? String(out.observationError.code || 'observation_error') : null,
    diagnostic: { execution: out.executionError ? String(out.executionError.message || out.executionError) : null,
      observation: out.observationError ? String(out.observationError.message || out.observationError) : null,
      terminal: out.terminalEvidence }, routing,
    live: runTable.size() });
}
`;
  return compile.call(this, source, filename);
};
