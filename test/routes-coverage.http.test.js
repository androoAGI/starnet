/* node test/routes-coverage.http.test.js — direct HTTP-path coverage for 19 sidecar routes that were
   live-proven truthful during the routes-area Atlas audit but carried NO machine test on the HTTP path
   itself (Atlas finding 43edd6f5, EL-3: a shipped promise should not be unguarded). Boots the REAL host
   (sidecar/index.js) against an isolated temp workspace on a free ephemeral port, then drives each route
   over real sockets with a happy path + an honest-failure assertion (and the token gate on a sample).

   ZERO model spend: none of these routes hit a provider — they read/serve store + descriptor state, or
   validate-and-reject. Provider keys are cleared so no route can wander onto the network. The dialog/native
   and network-live siblings from the finding (POST /api/projects/pickfolder, GET /api/auth/{codex,grok,kimi}/
   models) stay KNOWN by nature; /api/auth/codex/status IS covered here (status is offline-truthful).

   NOT in test:fast (a child-process boot test shouldn't gate other agents' merges); run via test:http. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// spawn the host; resolve once it logs its listen URL, retry the next port on EADDRINUSE.
function boot(port, workspaces, attemptsLeft, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port), STARNET_PORT: String(port),
        SKYNET_WORKSPACES: workspaces, STARNET_WORKSPACES: workspaces,
        // clear every provider key so no route can reach the network (determinism + zero spend).
        OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', SKYNET_OPENROUTER_KEY: '',
        OPENROUTER_API_KEY: '', STARNET_OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '', STARNET_ANTHROPIC_API_KEY: '', SKYNET_ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '', STARNET_GEMINI_API_KEY: '', SKYNET_GEMINI_API_KEY: '',
        // keep DEV off by default so POST /api/dev/inbound proves its 404 gate deterministically.
        STARNET_DEV: '', SKYNET_DEV: '',
        STARNET_APP_VERSION: '9.9.9-routes-test'
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, workspaces, attemptsLeft - 1, extraEnv)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routes-'));
  const booted = await boot(await allocatePort(), ws, 20);
  const { child, port } = booted;
  const B = 'http://' + HOST + ':' + port;
  let apiToken = '';
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    if (apiToken) headers['Origin'] = B;
    const r = await fetch(B + p, { method: m, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };
  // a raw (tokenless) call to prove the auth seam gates a route.
  const raw = (m, p, body) => fetch(B + p, { method: m, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });

  try {
    apiToken = await bootToken(B, B);
    A.ok(apiToken.length >= 32, 'served index.html carried a high-entropy API token');

    const streaming = await j('POST', '/api/local-voice/stream?action=audio&id=expired');
    A.eq(streaming.status, 200, 'stream route accepts query parameters');
    A.ok(/expired/.test(streaming.body.error || ''), 'unknown streaming session returns a JSON recovery reason');
    const opened = await j('POST', '/api/local-voice/stream?action=open');
    A.eq(opened.status, 200, 'open uses the same authenticated query route');
    if (opened.body.id) {
      const cancelled = await j('POST', '/api/local-voice/stream?action=cancel&id=' + encodeURIComponent(opened.body.id));
      A.eq(cancelled.status, 200, 'stream session is released without running a model');
      const again = await j('POST', '/api/local-voice/stream?action=finish&id=' + encodeURIComponent(opened.body.id));
      A.ok(/expired/.test(again.body.error || ''), 'cancelled session cannot be finalized');
    } else A.ok(/unavailable/.test(opened.body.error || ''), 'missing local models are explicit');

    // ---- the auth seam gates these data routes (spot-check across GET + POST; the finding notes none are exempt) ----
    for (const [m, p] of [['GET', '/api/quests'], ['GET', '/api/journey'], ['GET', '/api/toolsets'], ['GET', '/api/widgets'], ['GET', '/api/workspace/dir?agent=agent'], ['POST', '/api/activity'], ['POST', '/api/dev/inbound'], ['POST', '/api/local-voice/stream?action=open']]) {
      const g = await raw(m, p, m === 'POST' ? {} : undefined);
      A.eq(g.status, 403, m + ' ' + p + ' WITHOUT a token -> 403 (auth seam holds)');
    }

    // ---- (1) GET /api/nightshift/drafts — an empty night is an honest empty list ----
    const drafts = await j('GET', '/api/nightshift/drafts');
    A.eq(drafts.status, 200, 'GET /api/nightshift/drafts -> 200');
    A.ok(Array.isArray(drafts.body.drafts), 'drafts route returns {drafts:[...]} (empty on a fresh workspace)');
    A.eq(drafts.body.drafts.length, 0, 'fresh workspace has no night-shift drafts');

    // ---- (2) GET /api/quests — the ledger read ----
    const quests0 = await j('GET', '/api/quests');
    A.eq(quests0.status, 200, 'GET /api/quests -> 200');
    A.eq(quests0.body.ok, true, 'quests route reports ok:true');
    A.ok(Array.isArray(quests0.body.quests), 'quests route returns a quests array');

    // ---- (3) POST /api/quests/mint — happy path mints an id; bad JSON -> 400 ----
    const mint = await j('POST', '/api/quests/mint', { title: 'HTTP coverage quest', contract: { type: 'artifact', key: 'coverage.txt' }, desc: 'seeded by the routes coverage test', steps: [{ key: 's1', label: 'do the thing' }] });
    A.eq(mint.status, 200, 'POST /api/quests/mint (valid title+contract) -> 200');
    A.eq(mint.body.ok, true, 'mint reports ok:true');
    A.ok(mint.body.id && typeof mint.body.id === 'string', 'mint returns the new quest id');
    const questId = mint.body.id;
    const mintBad = await fetch(B + '/api/quests/mint', { method: 'POST', headers: { 'X-StarNet-Token': apiToken, Origin: B }, body: '{not json' });
    A.eq(mintBad.status, 400, 'POST /api/quests/mint with malformed JSON -> 400');
    // the minted quest is now visible in the ledger read (the store round-trip is real)
    const quests1 = await j('GET', '/api/quests');
    A.ok(quests1.body.quests.some(q => q && q.id === questId), 'the minted quest appears in GET /api/quests');

    // ---- (4) POST /api/quests/update — happy tick; missing id -> 400; unknown op -> 400 ----
    const upd = await j('POST', '/api/quests/update', { id: questId, op: 'tick' });
    A.eq(upd.status, 200, 'POST /api/quests/update {op:tick} -> 200');
    A.eq(typeof upd.body.ok, 'boolean', 'update returns an ok boolean');
    const updNoId = await j('POST', '/api/quests/update', { op: 'tick' });
    A.eq(updNoId.status, 400, 'POST /api/quests/update without an id -> 400');
    A.eq(updNoId.body.error, 'which quest?', 'update names the missing id honestly');
    const updBadOp = await j('POST', '/api/quests/update', { id: questId, op: 'nonsense' });
    A.eq(updBadOp.status, 400, 'POST /api/quests/update with an unknown op -> 400');
    A.eq(updBadOp.body.error, 'unknown op', 'update rejects an unknown op by name');

    // ---- (5) POST /api/quests/confirm — happy verdict; missing id -> 400 ----
    const conf = await j('POST', '/api/quests/confirm', { id: questId, ok: true, note: 'coverage confirm' });
    A.eq(conf.status, 200, 'POST /api/quests/confirm {ok:true} -> 200');
    A.eq(typeof conf.body.ok, 'boolean', 'confirm returns an ok boolean (whether a verdict was recorded)');
    const confNoId = await j('POST', '/api/quests/confirm', { ok: true });
    A.eq(confNoId.status, 400, 'POST /api/quests/confirm without an id -> 400');

    // ---- (6) POST /api/quests/dismiss — happy path (removes the seeded quest); missing id -> 400 ----
    const dismNoId = await j('POST', '/api/quests/dismiss', {});
    A.eq(dismNoId.status, 400, 'POST /api/quests/dismiss without an id -> 400');
    const dism = await j('POST', '/api/quests/dismiss', { id: questId });
    A.eq(dism.status, 200, 'POST /api/quests/dismiss {id} -> 200');
    A.eq(typeof dism.body.ok, 'boolean', 'dismiss returns an ok boolean');

    // ---- Commander journey: durable metric round-trip + honest invalid operation ----
    const journey0 = await j('GET', '/api/journey');
    A.eq(journey0.status, 200, 'GET /api/journey -> 200');
    A.eq(journey0.body.journey.evolution.goalsReached, 0, 'fresh journey makes no progress claim');
    const metric = await j('POST', '/api/journey', { op: 'metric.create', goalId: 'goal:http', label: 'Paying users', baseline: 0, target: 10, unit: 'users' });
    A.eq(metric.status, 200, 'POST /api/journey metric.create -> 200');
    A.ok(metric.body.ok && metric.body.metric.id, 'metric.create returns the durable metric id');
    const metricReached = await j('POST', '/api/journey', { op: 'metric.update', id: metric.body.metric.id, current: 10, note: 'Commander checked billing' });
    A.eq(metricReached.status, 200, 'POST /api/journey metric.update -> 200');
    A.eq(metricReached.body.journey.evolution.goalsReached, 0, 'reaching one metric cannot overclaim the whole life goal');
    A.eq(metricReached.body.journey.outcomes[0].kind, 'metric', 'reached metric still lands as a provenance-bearing outcome');
    const journey1 = await j('GET', '/api/journey');
    A.eq(journey1.body.journey.metrics[0].current, 10, 'journey metric survives a real HTTP read-after-write');
    const journeyBad = await j('POST', '/api/journey', { op: 'invent.level' });
    A.eq(journeyBad.status, 400, 'unknown journey operation -> 400');
    const journeyReset = await j('POST', '/api/journey', { op: 'journey.reset', epoch: 2 });
    A.eq(journeyReset.status, 200, 'journey reset advances to a new Commander generation');
    const staleJourney = await j('POST', '/api/journey', { op: 'metric.create', epoch: 1, label: 'Stale tab metric', baseline: 0, target: 1 });
    A.eq(staleJourney.status, 409, 'a stale Commander generation cannot mutate the new journey');
    const currentJourney = await j('POST', '/api/journey', { op: 'metric.create', epoch: 2, label: 'Current tab metric', baseline: 0, target: 1 });
    A.eq(currentJourney.status, 200, 'the active Commander generation can mutate its journey');

    // ---- (7) POST /api/activity — arrival IS the signal; always 200 with the recorded timestamp ----
    const before = Date.now();
    const act = await j('POST', '/api/activity', {});
    A.eq(act.status, 200, 'POST /api/activity -> 200');
    A.eq(act.body.ok, true, 'activity reports ok:true');
    A.ok(typeof act.body.at === 'number' && act.body.at >= before - 1000, 'activity returns the recorded lastUserActivityAt (a real number, not a guess)');

    // ---- (8) POST /api/dev/inbound — dev-gated: on a NON-dev boot the route 404s (the gate holds) ----
    const devInbound = await j('POST', '/api/dev/inbound', { text: 'ping' });
    A.eq(devInbound.status, 404, 'POST /api/dev/inbound on a non-dev boot -> 404 (STARNET_DEV gate holds)');
    A.eq(devInbound.body.error, 'not found', 'the dev-gate 404 is honest');

    // ---- (9) POST /api/workshop/remove — no-such-idea -> 404; bad agentId -> 400 ----
    const rmBadAgent = await j('POST', '/api/workshop/remove', { agentId: 'bad agent!', backlogId: 'x' });
    A.eq(rmBadAgent.status, 400, 'POST /api/workshop/remove with an invalid agentId -> 400');
    A.eq(rmBadAgent.body.error, 'choose a valid agent', 'workshop/remove validates the agent id by name');
    const rmMissing = await j('POST', '/api/workshop/remove', { agentId: 'agent', backlogId: 'no-such-idea-xyz' });
    A.eq(rmMissing.status, 404, 'POST /api/workshop/remove for an unknown idea -> 404');
    A.eq(rmMissing.body.ok, false, 'workshop/remove reports ok:false when nothing was removed');

    // ---- (10) GET /api/auth/codex/status — offline-truthful status, never a token ----
    const codex = await j('GET', '/api/auth/codex/status');
    A.eq(codex.status, 200, 'GET /api/auth/codex/status -> 200');
    A.eq(typeof codex.body.connected, 'boolean', 'codex status reports a connected boolean');
    A.ok(JSON.stringify(codex.body).indexOf('sk-') < 0, 'codex status leaks no key-shaped secret');

    // ---- (11) GET /api/channels/telegram/status — configured/connected truth, no token echoed ----
    const tg = await j('GET', '/api/channels/telegram/status');
    A.eq(tg.status, 200, 'GET /api/channels/telegram/status -> 200');
    A.eq(tg.body.configured, false, 'unconfigured telegram reports configured:false');
    A.eq(typeof tg.body.connected, 'boolean', 'telegram status reports a connected boolean');
    A.ok(typeof tg.body.state === 'string', 'telegram status reports a transport state string');

    // ---- (12) GET /api/execution — the execution-environment descriptor ----
    const exec = await j('GET', '/api/execution');
    A.eq(exec.status, 200, 'GET /api/execution -> 200');
    A.ok(exec.body && typeof exec.body === 'object' && !Array.isArray(exec.body), 'execution returns a descriptor object');

    // ---- (13) GET /api/fallback/chain — the model fallback chain readout ----
    const fb = await j('GET', '/api/fallback/chain');
    A.eq(fb.status, 200, 'GET /api/fallback/chain -> 200');
    A.ok(Array.isArray(fb.body.chain), 'fallback chain returns a chain array');
    A.eq(typeof fb.body.saved, 'boolean', 'fallback chain reports whether a saved override exists');
    A.ok(Array.isArray(fb.body.envDefault), 'fallback chain exposes the env default chain');
    A.eq(typeof fb.body.maxEntries, 'number', 'fallback chain exposes maxEntries');

    // ---- (14) GET /api/fs/dirstat — honest-in-body: non-absolute vs a real dir (the workspace itself) ----
    const dsRel = await j('GET', '/api/fs/dirstat?path=' + encodeURIComponent('not/absolute'));
    A.eq(dsRel.status, 200, 'GET /api/fs/dirstat (non-absolute) -> 200 (honest-fail in the body, never a 5xx)');
    A.eq(dsRel.body.exists, false, 'a non-absolute path is reported not-existing');
    A.eq(dsRel.body.reason, 'not-absolute', 'the reason names the non-absolute path');
    const dsReal = await j('GET', '/api/fs/dirstat?path=' + encodeURIComponent(ws));
    A.eq(dsReal.status, 200, 'GET /api/fs/dirstat (a real dir inside WORKSPACES) -> 200');
    A.eq(dsReal.body.exists, true, 'the workspace dir is reported existing');
    A.eq(dsReal.body.isDir, true, 'the workspace dir is reported as a directory');

    // ---- (15) GET /api/spotify/status — connection truth, never a token ----
    const sp = await j('GET', '/api/spotify/status');
    A.eq(sp.status, 200, 'GET /api/spotify/status -> 200');
    A.eq(typeof sp.body.connected, 'boolean', 'spotify status reports a connected boolean');
    A.eq(sp.body.connected, false, 'unconfigured spotify is not connected');
    A.ok(JSON.stringify(sp.body).indexOf('sk-') < 0 && JSON.stringify(sp.body).indexOf('Bearer') < 0, 'spotify status leaks no token');

    // ---- (16) GET /api/study/proposals — happy readout; a bad agent id is forbidden ----
    const study = await j('GET', '/api/study/proposals?agent=agent&run=nope');
    A.eq(study.status, 200, 'GET /api/study/proposals -> 200');
    A.ok(Array.isArray(study.body.proposals), 'study proposals returns a proposals array (empty on a fresh workspace)');
    const studyBad = await fetch(B + '/api/study/proposals?agent=' + encodeURIComponent('../evil'), { headers: { 'X-StarNet-Token': apiToken, Origin: B } });
    A.eq(studyBad.status, 403, 'GET /api/study/proposals with a jail-escape agent id -> 403');

    // ---- (17) GET /api/toolsets — the placeable-capability catalog ----
    const ts = await j('GET', '/api/toolsets');
    A.eq(ts.status, 200, 'GET /api/toolsets -> 200');
    A.ok(Array.isArray(ts.body.toolsets) && ts.body.toolsets.length > 0, 'toolsets returns a non-empty catalog');
    A.ok(ts.body.toolsets.every(t => t && typeof t.id === 'string' && typeof t.enabled === 'boolean'), 'every toolset row carries an id + enabled flag');

    // ---- (18) GET /api/widgets — the agent-fed widget readouts ----
    const wid = await j('GET', '/api/widgets');
    A.eq(wid.status, 200, 'GET /api/widgets -> 200');
    A.ok(wid.body && Object.prototype.hasOwnProperty.call(wid.body, 'widgets'), 'widgets route returns a {widgets} payload');

    // ---- (19) GET /api/workspace/dir — jailed abs path; a jail-escape agent id is forbidden ----
    const wdir = await j('GET', '/api/workspace/dir?agent=agent');
    A.eq(wdir.status, 200, 'GET /api/workspace/dir?agent=agent -> 200');
    A.ok(typeof wdir.body.dir === 'string' && wdir.body.dir.length > 0, 'workspace/dir returns an absolute jailed path');
    A.ok(wdir.body.dir.indexOf(ws) >= 0, 'the returned dir is jailed under the WORKSPACES root');
    const wdirEscape = await fetch(B + '/api/workspace/dir?agent=' + encodeURIComponent('../../etc'), { headers: { 'X-StarNet-Token': apiToken, Origin: B } });
    A.eq(wdirEscape.status, 403, 'GET /api/workspace/dir with a jail-escape agent id -> 403');

  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('routes-coverage.http.test');
})().catch(e => { console.log('FAIL: routes-coverage.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
