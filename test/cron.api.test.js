/* node test/cron.api.test.js — boot-level end-to-end test of the /api/cron ROUTINES CRUD surface.
   Spawns the real Node host (sidecar/index.js) against an ISOLATED temp workspace on an ephemeral port, with
   NO key (so zero model spend), and drives the routine CRUD + preview + the run-now guard over real sockets:
     - POST /api/cron            create (interval + 5-field cron -> ok; unparseable -> 400)
     - GET  /api/cron            the snapshot the panel renders (enabled:false when the tick is unarmed)
     - POST /api/cron/preview    next-5 fire times for an interval; one for a once; 400 on garbage
     - POST /api/cron/update     edit a field + pause/resume via the enabled flag
     - POST /api/cron/run        no provider credentials -> 400 (guard, zero spend); unknown id -> 404
     - protected-state recovery  zero cron.jobs.json, reboot, and prove routines recover from cron.jobs.json.bak
     - POST /api/cron/remove     delete; then a SECOND boot proves the job persisted to cron.jobs.json
   Mirrors sidecar.http.test.js; NOT in test:fast (a child-process boot test shouldn't gate other agents).
   Run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const { makeRunJournal } = require('../sidecar/run-journal.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, workspaces, attemptsLeft) {
  return new Promise((resolve, reject) => {
    // Sandbox the ambient credential roots too: the codex-token migration (codex-token-store.js
    // candidateCodexTokenFiles) deliberately searches LOCALAPPDATA/APPDATA/XDG_DATA_HOME for a live
    // ChatGPT login and migrates it INTO the workspace — on a dev machine with ChatGPT connected that
    // makes "no provider credentials" false and run-now legitimately answers 200. Point those roots
    // into the scratch dir so this test's premise holds on every machine.
    const appSandbox = path.join(workspaces, '_appdata');
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1',
        LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, workspaces, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-')));
  fs.mkdirSync(path.join(ws, 'channels'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'channels', 'chatmap.json'), JSON.stringify({ version: 1, chats: { dev_target: { chatId: 'cron-dev', channel: 'dev', agentId: 'cron_brief' } } }), 'utf8');
  let booted = await boot(8890 + (process.pid % 60), ws, 20);
  let child = booted.child, port = booted.port;
  const B = () => 'http://' + HOST + ':' + port;
  let apiToken = '';
  async function refreshToken() {
    apiToken = await bootToken(B(), B());
  }
  await refreshToken();
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;   // hardened: GET data routes are token-gated too now
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    // ---- create: a valid interval routine ----
    const create = await j('POST', '/api/cron', { name: 'Morning brief', prompt: 'summarize AI news', schedule: 'every 30m', agentId: 'cron_brief' });
    A.eq(create.status, 200, 'POST /api/cron (valid) -> 200');
    A.ok(create.body.ok && create.body.job && create.body.job.id, 'create returns the new job with an id');
    const id = create.body.job.id;
    A.eq(create.body.job.schedule.kind, 'interval', 'schedule parsed to an interval');
    A.eq(create.body.job.agentId, 'cron_brief', 'agentId stored');
    A.ok(create.body.job.nextRunAt, 'an enabled interval job is armed with a nextRunAt');
    const roster = await j('POST', '/api/roster', { agents: [{ agentId: 'cron_brief', system: 'ROSTER SYSTEM', name: 'Briefing Agent', model: 'roster/model', provider: 'codex', role: 'news briefings' }] });
    A.eq(roster.status, 200, 'POST /api/roster -> 200');
    A.eq(roster.body.count, 1, 'roster stores the selected cron agent identity');
    const rosterPath = path.join(ws, 'agent.roster.json');
    A.ok(fs.existsSync(rosterPath), 'agent roster mirror persisted for headless cron');
    const rosterDisk = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    A.eq(rosterDisk.agents[0].agentId, 'cron_brief', 'persisted roster carries the agentId');
    A.eq(rosterDisk.agents[0].provider, 'codex', 'persisted roster carries the selected provider');

    // ---- create: a valid 5-field cron routine is accepted and armed ----
    const cronExpr = await j('POST', '/api/cron', { name: 'Daily brief', prompt: 'daily summary', schedule: '0 9 * * *', agentId: 'cron_brief', provider: 'codex' });
    A.eq(cronExpr.status, 200, '5-field cron expr -> 200');
    A.eq(cronExpr.body.job.schedule.kind, 'cron', 'cron schedule stored as cron');
    A.eq(cronExpr.body.job.provider, 'codex', 'cron routine can pin a provider');
    A.ok(cronExpr.body.job.nextRunAt, 'an enabled cron job is armed with a nextRunAt');
    const cronId = cronExpr.body.job.id;

    // ---- create: an optional IANA tz is HONORED so a wall-clock cadence fires on LOCAL time (item #4, additive) ----
    const tzCreate = await j('POST', '/api/cron', { name: 'Local morning', prompt: 'brief', schedule: '0 9 * * *', agentId: 'cron_brief', provider: 'codex', tz: 'America/New_York' });
    A.eq(tzCreate.status, 200, 'a create carrying a valid IANA tz -> 200');
    A.eq(tzCreate.body.job.schedule.tz, 'America/New_York', 'the created cron schedule persists the caller tz (fires on local 9:00, not UTC)');
    const tzBad = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: '0 9 * * *', tz: 'Mars/Olympus' });
    A.eq(tzBad.status, 400, 'an INVALID tz is rejected at create (never a silent UTC fallback that lies about fire time)');
    // remove the tz job so the persistence/removal counts below (which pin an exact job total) stay stable.
    await j('POST', '/api/cron/remove', { id: tzCreate.body.job.id });

    // ---- create: bad inputs are refused (not silently stored as un-fireable) ----
    const badSched = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: 'whenever i feel like it' });
    A.eq(badSched.status, 400, 'unparseable schedule -> 400');
    const badCronExpr = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: '61 * * * *' });
    A.eq(badCronExpr.status, 400, 'invalid cron expr -> 400');
    const badAgent = await j('POST', '/api/cron', { name: 'x', prompt: 'y', schedule: 'every 1h', agentId: '../escape' });
    A.eq(badAgent.status, 400, 'malformed routine agentId -> 400');

    // ---- list: the snapshot the panel renders; enabled:false because SKYNET_CRON_ENABLED is unset ----
    const list = await j('GET', '/api/cron');
    A.eq(list.status, 200, 'GET /api/cron -> 200');
    A.eq(list.body.jobs.length, 2, 'two routines listed');
    A.eq(list.body.enabled, false, 'enabled:false — the tick is honestly reported as unarmed');
    A.ok(JSON.stringify(list.body).indexOf('sk-') < 0, 'no key-shaped secret in the snapshot');

    // ---- preview: next-5 for an interval, one for a once, 400 on garbage ----
    const pv = await j('POST', '/api/cron/preview', { schedule: 'every 1h' });
    A.eq(pv.status, 200, 'preview -> 200');
    A.eq(pv.body.kind, 'interval', 'preview kind interval');
    A.eq(pv.body.next.length, 5, 'preview returns 5 fire times');
    const d0 = Date.parse(pv.body.next[0]), d1 = Date.parse(pv.body.next[1]);
    A.ok(Math.abs((d1 - d0) - 3600000) < 1000, 'consecutive fire times are one hour apart');
    const pvOnce = await j('POST', '/api/cron/preview', { schedule: 'in 2h' });
    A.eq(pvOnce.body.kind, 'once', 'preview kind once');
    A.eq(pvOnce.body.next.length, 1, 'a once schedule previews exactly one fire');
    const pvCron = await j('POST', '/api/cron/preview', { schedule: '*/30 * * * *' });
    A.eq(pvCron.status, 200, 'preview of valid cron -> 200');
    A.eq(pvCron.body.kind, 'cron', 'preview kind cron');
    A.eq(pvCron.body.next.length, 5, 'cron preview returns 5 fire times');
    const pvBad = await j('POST', '/api/cron/preview', { schedule: 'nonsense!!' });
    A.eq(pvBad.status, 400, 'preview of garbage -> 400');

    // ---- preview: a tz-aware cron schedule returns its IANA tz + a human LOCAL-time string per fire (G4.1) ----
    const pvTz = await j('POST', '/api/cron/preview', { schedule: '0 9 * * *', tz: 'America/New_York' });
    A.eq(pvTz.status, 200, 'preview of a tz cron -> 200');
    A.eq(pvTz.body.tz, 'America/New_York', 'preview echoes the resolved IANA tz');
    A.ok(Array.isArray(pvTz.body.localNext) && pvTz.body.localNext.length === 5, 'preview returns a local-time string per fire');
    A.ok(/\b(9:00\s*AM|09:00)\b/i.test(pvTz.body.localNext[0]) && /(EST|EDT)/.test(pvTz.body.localNext[0]), 'the local-time string reads 9:00 AM in EST/EDT, not UTC');
    // a typo'd tz fails the parse (400) — never a silent UTC fallback (the lie this guards against).
    const pvTzBad = await j('POST', '/api/cron/preview', { schedule: '0 9 * * *', tz: 'America/New_Yrok' });
    A.eq(pvTzBad.status, 400, 'a tz typo -> 400 (no silent UTC fallback)');

    // ---- update: rename + pause, then resume ----
    const upd = await j('POST', '/api/cron/update', { id, patch: { name: 'Renamed brief', enabled: false } });
    A.eq(upd.status, 200, 'update -> 200');
    A.eq(upd.body.job.name, 'Renamed brief', 'name edited');
    A.eq(upd.body.job.enabled, false, 'paused via enabled:false');
    A.eq(upd.body.job.state, 'paused', 'state paused');
    const res = await j('POST', '/api/cron/update', { id, patch: { enabled: true } });
    A.eq(res.body.job.enabled, true, 'resumed via enabled:true');
    A.eq(res.body.job.state, 'scheduled', 'state scheduled after resume');
    A.ok(res.body.job.nextRunAt, 're-armed nextRunAt on resume');
    const updMissing = await j('POST', '/api/cron/update', { id: 'nope', patch: { name: 'z' } });
    A.eq(updMissing.status, 404, 'update of an unknown id -> 404');
    const updBadAgent = await j('POST', '/api/cron/update', { id, patch: { agentId: 'bad agent!' } });
    A.eq(updBadAgent.status, 400, 'update rejects a malformed agentId');
    const updBadProvider = await j('POST', '/api/cron/update', { id, patch: { provider: 'bad-provider' } });
    A.eq(updBadProvider.status, 400, 'update rejects an unknown provider');

    // ---- run-now: guarded (no provider credentials -> 400; unknown id -> 404) — zero spend ----
    const runNoKey = await j('POST', '/api/cron/run', { id });
    A.eq(runNoKey.status, 400, 'run-now with no provider credentials -> 400 (no spend)');
    const runMissing = await j('POST', '/api/cron/run', { id: 'nope' });
    A.eq(runMissing.status, 404, 'run-now of an unknown id -> 404');

    // ---- script-only: a safe workspace script runs with no model and no provider credential ----
    const agentWs = path.join(ws, 'cron_brief');
    fs.mkdirSync(agentWs, { recursive: true });
    fs.writeFileSync(path.join(agentWs, 'health.js'), 'console.log("script-only result")\n', 'utf8');
    const scriptCreate = await j('POST', '/api/cron', {
      name: 'Script health', prompt: 'run the local health check', schedule: 'every 1h', agentId: 'cron_brief',
      script: 'health.js', noAgent: true, unattendedGrants: ['workbench'],
      deliver: 'targets:dev_target', attachToSession: true
    });
    A.eq(scriptCreate.status, 200, 'script-only routine creates with an explicit workbench grant');
    A.eq(scriptCreate.body.job.noAgent, true, 'script-only mode is returned by the API');
    const scriptRun = await j('POST', '/api/cron/run', { id: scriptCreate.body.job.id });
    A.eq(scriptRun.status, 200, 'script-only Run Now needs no provider credential');
    A.ok(String(scriptRun.body).includes('script-only result'), 'script stdout is the final routine result');
    const scriptSnap = await j('GET', '/api/cron');
    const scriptJob = scriptSnap.body.jobs.find(x => x.id === scriptCreate.body.job.id);
    A.eq(scriptJob.lastStatus, 'ok', 'script-only completion is durably successful');
    A.eq(scriptJob.lastOutput, 'script-only result', 'script-only stdout is durable for delivery/contextFrom');
    const delivered = await j('GET', '/api/dev/replies?chatId=cron-dev');
    A.ok((delivered.body.replies || []).some(x => String(x.text || '').includes('script-only result')), 'specific-target delivery carries the actual final output');
    const continued = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'cron_brief.history.json'), 'utf8'));
    A.ok((continued.messages || []).some(x => x.role === 'assistant' && x.content === 'script-only result'), 'delivered output is folded into channel history for continuation');
    const scriptTranscript = await j('GET', '/api/transcript?agent=cron_brief&stream=' + encodeURIComponent('cron-' + scriptJob.lastRunId) + '&limit=20');
    A.ok((scriptTranscript.body.turns || []).some(t => t.role === 'assistant' && t.content === 'script-only result'), 'script-only output is recoverable in its continuable cron session');
    await j('POST', '/api/cron/remove', { id: scriptCreate.body.job.id });

    // ---- persistence: the routine survives a fresh boot on the same workspace ----
    A.ok(fs.existsSync(path.join(ws, 'cron.jobs.json')), 'cron.jobs.json written to the workspace');
    const interrupted = makeRunJournal({ dir: path.join(ws, '.run-journal') });
    interrupted.begin({ runId: 'interrupted-cron-run', agentId: 'cron_brief', streamId: 'cron-interrupted-cron-run', trigger: 'schedule', cronJobId: 'routine-recovery-proof', cronJobName: 'Recovery proof' });
    interrupted.checkpoint('interrupted-cron-run', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'partial safe checkpoint' }] });
    interrupted.begin({ runId: 'uncertain-cron-run', agentId: 'cron_brief', streamId: 'cron-uncertain-cron-run', trigger: 'schedule', cronJobId: 'routine-uncertain-proof', cronJobName: 'Uncertain proof' });
    interrupted.checkpoint('uncertain-cron-run', { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'about to update the external system' }] });
    interrupted.toolIntent('uncertain-cron-run', { callId: 'mutating-call-1', name: 'connector.update', mutating: true });
    try { child.kill(); } catch (_) {} await sleep(200);
    booted = await boot(port + 100, ws, 20); child = booted.child; port = booted.port;
    await refreshToken();
    const after = await j('GET', '/api/cron');
    A.eq(after.body.jobs.length, 2, 'the routines persisted across a restart');
    A.ok(after.body.jobs.some(job => job.name === 'Renamed brief'), 'the edited name persisted');
    A.ok(after.body.jobs.some(job => job.schedule && job.schedule.kind === 'cron'), 'the cron routine persisted');
    A.ok(after.body.jobs.some(job => job.provider === 'codex'), 'the routine provider persisted');
    const recoveries = await j('GET', '/api/run-recoveries');
    const interruptedCron = (recoveries.body.recoveries || []).find(row => row.runId === 'interrupted-cron-run');
    A.ok(interruptedCron, 'an interrupted scheduled run is discoverable after host restart');
    A.eq(interruptedCron.trigger, 'schedule', 'recovery truth preserves the scheduled trigger');
    A.eq(interruptedCron.cronJobId, 'routine-recovery-proof', 'recovery truth identifies the originating routine');
    A.eq(interruptedCron.cronJobName, 'Recovery proof', 'recovery truth carries the human routine name');
    A.eq(interruptedCron.status, 'resumable', 'a checkpoint without an uncertain mutation is honestly resumable');
    const uncertainCron = (recoveries.body.recoveries || []).find(row => row.runId === 'uncertain-cron-run');
    A.eq(uncertainCron.status, 'needs_review', 'an unmatched mutating call is visibly review-required');
    A.eq(uncertainCron.uncertain, [{ callId: 'mutating-call-1', name: 'connector.update' }], 'the operator sees bounded uncertainty without tool arguments');
    A.ok(uncertainCron.recoveryToken, 'the read snapshot carries a stale-decision guard');
    const unauthorizedResolution = await fetch(B() + '/api/run-recoveries/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        runId: 'uncertain-cron-run', agentId: 'cron_brief', resolutionId: 'api-resolution-1', recoveryToken: uncertainCron.recoveryToken,
        confirmedNoReplay: true, outcomes: [{ callId: 'mutating-call-1', outcome: 'happened' }]
      })
    });
    A.eq(unauthorizedResolution.status, 403, 'an unauthenticated local request cannot resolve preserved work');
    const wrongOwner = await j('POST', '/api/run-recoveries/resolve', {
      runId: 'uncertain-cron-run', agentId: 'agent', resolutionId: 'api-resolution-1', recoveryToken: uncertainCron.recoveryToken,
      confirmedNoReplay: true, outcomes: [{ callId: 'mutating-call-1', outcome: 'happened' }]
    });
    A.eq(wrongOwner.status, 403, 'a caller cannot resolve a run under a different agent owner');
    const incomplete = await j('POST', '/api/run-recoveries/resolve', {
      runId: 'uncertain-cron-run', agentId: 'cron_brief', resolutionId: 'api-resolution-1', recoveryToken: uncertainCron.recoveryToken,
      confirmedNoReplay: true, outcomes: []
    });
    A.eq(incomplete.status, 409, 'resolution must account for every uncertain call');
    const noConsent = await j('POST', '/api/run-recoveries/resolve', {
      runId: 'uncertain-cron-run', agentId: 'cron_brief', resolutionId: 'api-resolution-1', recoveryToken: uncertainCron.recoveryToken,
      outcomes: [{ callId: 'mutating-call-1', outcome: 'happened' }]
    });
    A.eq(noConsent.status, 400, 'resolution requires explicit no-replay acknowledgement');
    const resolveUncertain = await j('POST', '/api/run-recoveries/resolve', {
      runId: 'uncertain-cron-run', agentId: 'cron_brief', resolutionId: 'api-resolution-1', recoveryToken: uncertainCron.recoveryToken,
      confirmedNoReplay: true, outcomes: [{ callId: 'mutating-call-1', outcome: 'happened' }], note: 'verified in destination audit log'
    });
    A.eq(resolveUncertain.status, 200, 'an explicit complete operator verdict resolves the preserved run');
    A.eq(resolveUncertain.body.recovery.status, 'resolved', 'the response is truthful about the non-replayed resolution');
    A.eq(resolveUncertain.body.recovery.resolution.outcomes[0].outcome, 'happened', 'the response includes the audited outcome');
    const retryResolution = await j('POST', '/api/run-recoveries/resolve', {
      runId: 'uncertain-cron-run', agentId: 'cron_brief', resolutionId: 'api-resolution-1', recoveryToken: uncertainCron.recoveryToken,
      confirmedNoReplay: true, outcomes: [{ callId: 'mutating-call-1', outcome: 'happened' }], note: 'verified in destination audit log'
    });
    A.eq(retryResolution.status, 200, 'retrying an accepted resolution id is idempotent even with its original snapshot token');
    const overwriteResolution = await j('POST', '/api/run-recoveries/resolve', {
      runId: 'uncertain-cron-run', agentId: 'cron_brief', resolutionId: 'api-resolution-2', recoveryToken: uncertainCron.recoveryToken,
      confirmedNoReplay: true, outcomes: [{ callId: 'mutating-call-1', outcome: 'did_not_happen' }]
    });
    A.eq(overwriteResolution.status, 409, 'a later conflicting verdict cannot overwrite the audit record');
    const restartedScriptTranscript = await j('GET', '/api/transcript?agent=cron_brief&stream=' + encodeURIComponent('cron-' + scriptJob.lastRunId) + '&limit=20');
    A.ok((restartedScriptTranscript.body.turns || []).some(t => t.role === 'assistant' && t.content === 'script-only result'), 'completed routine output remains retrievable from durable history after host restart');

    // ---- protected-state recovery: a torn main file restores from the last-known-good .bak ----
    const cronPath = path.join(ws, 'cron.jobs.json');
    const cronBak = cronPath + '.bak';
    A.ok(fs.existsSync(cronBak), 'cron.jobs.json.bak exists after routine updates');
    const bakJobs = JSON.parse(fs.readFileSync(cronBak, 'utf8')).jobs || [];
    A.ok(bakJobs.length >= 1, 'cron.jobs.json.bak contains routine jobs, not an empty snapshot');
    try { child.kill(); } catch (_) {} await sleep(200);
    fs.writeFileSync(cronPath, '');   // simulate a hard kill/torn write that left the protected main empty
    booted = await boot(port + 200, ws, 20); child = booted.child; port = booted.port;
    await refreshToken();
    const recovered = await j('GET', '/api/cron');
    A.eq(recovered.body.jobs.length, 3, 'torn cron.jobs.json recovered from .bak on boot');
    A.ok(recovered.body.jobs.some(job => job.name === 'Renamed brief'), 'recovered routine keeps the edited name');
    A.ok(recovered.body.jobs.some(job => job.schedule && job.schedule.kind === 'cron'), 'recovered routine keeps the cron schedule');
    const recoveriesAfterReboot = await j('GET', '/api/run-recoveries');
    const durableResolution = (recoveriesAfterReboot.body.recoveries || []).find(row => row.runId === 'uncertain-cron-run');
    A.eq(durableResolution.status, 'resolved', 'the operator resolution survives a second host boot');
    A.eq(durableResolution.resolution.note, 'verified in destination audit log', 'the audit note survives restart');
    A.eq(durableResolution.canResolve, false, 'a resolved journal cannot be decided again after restart');

    // ---- remove: delete then confirm gone ----
    const rm = await j('POST', '/api/cron/remove', { id });
    A.eq(rm.status, 200, 'remove -> 200');
    const rmCron = await j('POST', '/api/cron/remove', { id: cronId });
    A.eq(rmCron.status, 200, 'remove cron -> 200');
    await j('POST', '/api/cron/remove', { id: scriptCreate.body.job.id }); // the protected backup intentionally restored it
    const empty = await j('GET', '/api/cron');
    A.eq(empty.body.jobs.length, 0, 'routine removed');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('cron.api.test');
})().catch(e => { console.log('FAIL: cron.api.test threw — ' + (e && e.stack || e)); process.exit(1); });
