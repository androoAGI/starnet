/* node test/unattended-hold.e2e.test.js — THE UNATTENDED HOLD on a REAL sidecar (cost fix W3.1). Part of test:http.

   A hermetic SidecarFixture (temp workspace + profile; every fetch to a host that is not loopback refused, so nothing here can
   reach a real provider or spend anything) signed in to a loopback "ChatGPT": the codex Responses wire, with its x-codex-*
   window headers. It is the station's only route, so every start below goes out on a subscription window. The window reading
   is SEEDED at 92% with its reset 2 h ahead, as the provider said it a minute before boot (WORKSPACES/.usage/subscriptions.json),
   and the upstream keeps saying whatever percentage the test sets on every call it answers.
   Locks:
     1. at 92% each unattended start is held with NO provider call and ONE truthful ledger row naming the reading, its source
        and the reset: an away-shift beat the night-shift driver fires, a routine's scheduled fire, a loop's tick and an away
        build (the away-workshop routine's shift). The night shift's status and the LOOPS window say the same.
     2. the user's own message on the same provider runs, at 92%.
     3. at 89% (the provider said so on the user's next message) every one of them goes.
     4. 2M weighted tokens of unattended work in the last 24 h pause unattended starts (the rail), never the user's message;
        RESUME — re-arming the posture, the control that turns unattended work on — lets them through, and the resume
        survives a restart. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const IPC = 'unattended-hold-e2e-ipc-token-0123456789';
const MODEL = 'gpt-5.5';
const MARK = { user: 'UNATTENDED-E2E-USER', routine: 'UNATTENDED-E2E-ROUTINE', loop: 'UNATTENDED-E2E-LOOP', build: 'UNATTENDED-E2E-BUILD' };
const SOURCE = 'x-codex-* response headers';
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/profile': { email: 'plan@example.test' } })).toString('base64url') + '.fixture';
const HOUR = 3600000;

function sse(parts) { return parts.map(p => typeof p === 'string' ? p : 'data: ' + JSON.stringify(p)).join('\n\n') + '\n\n'; }
const reply = text => sse([{ type: 'response.output_text.delta', output_index: 0, delta: text },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, output_tokens_details: { reasoning_tokens: 0 } } } },
  'data: [DONE]']);

// the loopback ChatGPT: every POST is a model call, classified by what it carries and answered with the window the test sets
function startUpstream(win) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ slug: MODEL, visibility: 'list', priority: 1 }] }));
      }
      // classified by the call's LAST user turn (the directive it was sent to do), never by context it quotes: a beat's
      // propose turn may well quote the user's own recent messages
      let last = raw;
      try {
        const turns = (JSON.parse(raw).input || []).filter(m => m && m.role === 'user');
        const t = turns[turns.length - 1];
        if (t) last = Array.isArray(t.content) ? t.content.map(p => (p && p.text) || '').join('\n') : String(t.content || '');
      } catch (_) { /* not JSON: classify the raw body */ }
      const kind = (/JOB:/.test(last) && /GROUNDS:/.test(last)) ? 'beat' : last.indexOf(MARK.user) >= 0 ? 'user' : last.indexOf(MARK.routine) >= 0 ? 'routine'
        : last.indexOf(MARK.loop) >= 0 ? 'loop' : last.indexOf(MARK.build) >= 0 ? 'build' : 'other';
      calls.push({ kind, at: Date.now(), pct: win.pct, said: kind === 'other' ? last.slice(-160) : undefined });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'x-codex-primary-used-percent': String(win.pct), 'x-codex-primary-window-minutes': '300',
        'x-codex-primary-reset-at': String(Math.floor(win.resetsAt / 1000)) });
      res.end(reply(kind === 'user' ? 'Hello from the plan.' : 'Nothing to do.'));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port })));
}

// the boot entry: the real sidecar with every fetch to a host that is not loopback refused (no real provider, no spend)
function bootEntry(dir) {
  const entry = path.join(dir, 'boot.js');
  const indexJs = path.resolve(__dirname, '..', 'sidecar', 'index.js');
  fs.writeFileSync(entry, "'use strict';\nconst real = globalThis.fetch;\n" +
    "globalThis.fetch = function (url) { const u = String((url && url.url) || url); return /^https?:[/][/](127[.]0[.]0[.]1|localhost)[:/]/.test(u) ? real.apply(this, arguments) : Promise.reject(new Error('unattended-hold.e2e: no network in this test (' + u + ')')); };\n" +
    'require(' + JSON.stringify(indexJs) + ');\n');
  return entry;
}

function hotBeliefs(now) {
  const b = t => [{ text: t, createdAt: now, updatedAt: now }];
  return { known: ['goals', 'pain', 'stack', 'ambition'], beliefs: { goals: b('ship the StarNet beta to 100 users'), pain: b('manual release notes eat my fridays'), stack: b('node and a pixel-art canvas'), ambition: b('a living agent station people watch') } };
}

(async () => {
  const win = { pct: 92, resetsAt: Date.now() + 2 * HOUR };
  const seenAt = Date.now() - 60000;
  const up = await startUpstream(win);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-hold-e2e-'));
  const ENV = { STARNET_IPC_TOKEN: IPC, STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_REMOTE_RELAY: 'off', SKYNET_REMOTE_RELAY: 'off',
    SKYNET_BUDGET_PER_RUN: '10', SKYNET_BUDGET_PER_AGENT: '0', SKYNET_BUDGET_PER_DAY: '0', SKYNET_BUDGET_GLOBAL: '0',
    // no background pass spends a call of its own between the doors (each would be a call this test did not ask for)
    STARNET_SKILL_REVIEW: '0', SKYNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_SCOUT: '0',
    STARNET_QUEST_REFRESH: '0', SKYNET_QUEST_REFRESH: '0', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '',
    // the drivers at test speed: the night shift ticks every 150 ms and counts the Commander away after 1 ms; routines tick every
    // 300 ms; the loop driver's own 5 s floor; the away-workshop routine fires 2 s after it is armed
    SKYNET_NIGHTSHIFT_TICK_MS: '150', SKYNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_BEAT_MS: '1',
    SKYNET_CRON_TICK_MS: '300', STARNET_CRON_TICK_MS: '300', SKYNET_LOOP_TICK_MS: '5000', STARNET_LOOP_TICK_MS: '5000',
    SKYNET_WORKSHOP_SHIFT_SCHEDULE: 'in 2s', STARNET_WORKSHOP_SHIFT_SCHEDULE: 'in 2s' };
  for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY', 'XAI_API_KEY', 'CREDITS_API_KEY']) {
    ENV[name] = ''; ENV['STARNET_' + name] = ''; ENV['SKYNET_' + name] = '';
  }
  const fx = SidecarFixture.create({ prefix: 'unattended-hold-e2e-', timeoutMs: 30000, entry: bootEntry(scratch), env: ENV });
  const ws = fx.workspace;
  const usage = path.join(ws, '.usage');
  const ledger = async () => { const b = (await fx.json('GET', '/api/autonomy/ledger?limit=500')).body; return (b && Array.isArray(b.entries)) ? b.entries : []; };
  const status = async () => (await fx.json('GET', '/api/nightshift/status')).body || {};
  const until = async (pred, maxMs) => { for (const end = Date.now() + maxMs; Date.now() < end; await sleep(150)) { if (await pred()) return true; } return !!(await pred()); };
  const kinds = since => up.calls.filter(c => c.at >= since).map(c => c.kind);
  // each routine has a name of its own: the mint gate hands back the EXISTING routine for a near-same name (Jaccard >= 0.6)
  const routine = async (prompt, schedule, name) => {
    let r = null;
    // the routine store answers "busy — retry" while another writer holds its lock (seen right after a boot): retry, as the error asks
    for (let i = 0; i < 20; i++) {
      r = await fx.json('POST', '/api/cron', { name, prompt, schedule: schedule || 'in 2s', agentId: 'agent' });
      if (!(r.status === 500 && /busy/.test(String(r.text)))) break;
      await sleep(100);
    }
    A.ok(r.body && !r.body.duplicate, 'a new routine, not an earlier one handed back: ' + name);
    A.eq(r.status, 200, 'a routine is saved: ' + String(r.text).slice(0, 200));
    return (r.body && (r.body.job || r.body).id) || '';
  };
  const userRun = async (words) => {
    const r = await fx.json('POST', '/api/run', { agentId: 'agent', provider: 'codex', model: MODEL, internal: true, isTask: false, messages: [{ role: 'user', content: MARK.user + ' ' + words }] });
    const events = String(r.text || '').split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
    const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
    const start = (events.find(e => e.name === 'agent.run.start') || {}).payload || {};
    return { status: r.status, reason: end.reason, runId: String(end.runId || start.runId || ''), text: String(r.text || '').slice(0, 300) };
  };
  const posture = (resume) => fx.json('POST', '/api/autonomy/posture', Object.assign({ posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 12 }, beliefs: hotBeliefs(Date.now()) }, resume ? { resumeHalt: true } : {}));
  const holdRow = (e, binding) => e && e.binding === binding || (e && e.detail && e.detail.hold === binding);
  // a boot, and the page's push of the ChatGPT sign-in's endpoint (the loopback fake) that every page load makes
  const boot = async () => {
    await fx.start();
    const pushed = await fx.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'codex', key: '', baseUrl: up.base + '/codex' }) });
    A.eq(pushed.status, 200, 'the ChatGPT sign-in\'s endpoint is the loopback fake');
  };
  try {
    // ---- the seeded station: a founded station, the ChatGPT sign-in, the scheduler armed, and the provider's last word: 92% ----
    seedActiveStation(ws);
    fs.mkdirSync(path.join(ws, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'codex', 'tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'Bearer' }));
    fs.writeFileSync(path.join(ws, 'cron.armed.json'), JSON.stringify({ version: 1, armed: true }));
    fs.mkdirSync(usage, { recursive: true });
    fs.writeFileSync(path.join(usage, 'subscriptions.json'), JSON.stringify({ v: 1, providers: { codex: { primary: {
      windows: [{ id: 'primary', label: '5-hour', usedPct: 92, resetsAt: win.resetsAt, status: '', minutes: 300 }], seenAt } } } }));
    await boot();
    A.eq((await fx.json('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false })).status, 200, 'no memory pass spends a call of its own');

    /* ===== 1. at 92%, every unattended start is held: no call, one truthful row each ===== */
    const t0 = Date.now();
    A.eq((await fx.json('POST', '/api/workshop/grant', { agentId: 'agent', on: true })).status, 200, 'the away workshop is granted (its routine is armed, firing in 2 s)');
    const queued = await fx.json('POST', '/api/workshop/queue', { agentId: 'agent', title: MARK.build + ' a tiny haiku generator', detail: 'one file' });
    A.ok(queued.body && queued.body.ok === true, 'a build is queued, so an away shift that is not held has something to build');
    const routineId = await routine(MARK.routine + ' write the morning note', 'in 2s', 'harbor ledger');
    const loop = await fx.json('POST', '/api/loops', { objective: MARK.loop + ' find bugs in the station', agentId: 'agent', name: 'e2e loop' });
    A.ok(loop.body && loop.body.ok === true, 'a standing loop is created');
    const loopId = (loop.body && loop.body.loop && loop.body.loop.id) || '';
    const armed = await posture(false);
    A.ok(armed.body && armed.body.ok === true, 'the night shift is armed (leash, reach sandbox, a hot dossier)');
    const cronJobs = (await fx.json('GET', '/api/cron')).body.jobs || [];
    const shift = cronJobs.find(j => j && j.meta && j.meta.workshop === true);
    A.ok(!!shift, 'the away-workshop routine exists');
    const shiftId = (shift && shift.id) || '';

    const held = (rows, pred) => rows.filter(e => Number(e.ts) >= t0 && pred(e));
    const rowsOf = rows => ({
      beat: held(rows, e => e.source === 'nightshift' && e.kind === 'decline' && e.binding === 'window-reserve'),
      routine: held(rows, e => e.source === 'cron' && e.jobId === routineId && holdRow(e, 'window-reserve')),
      build: held(rows, e => e.source === 'cron' && e.jobId === shiftId && holdRow(e, 'window-reserve')),
      loop: held(rows, e => e.source === 'loop' && e.jobId === loopId && holdRow(e, 'window-reserve'))
    });
    await until(async () => { const r = rowsOf(await ledger()); return r.beat.length && r.routine.length && r.build.length && r.loop.length; }, 20000);
    await sleep(1500);   // a few more night-shift ticks and routine ticks: still nothing on the wire, still one row each
    const rows = rowsOf(await ledger());
    A.eq(kinds(t0), [], 'at 92% NOTHING reached the provider: no beat, no routine, no loop pass, no away build');
    for (const [name, list] of Object.entries(rows)) {
      A.eq(list.length, 1, name + ': exactly one ledger row for the held start (edge-triggered: later held ticks fold into it) — ' + JSON.stringify(list).slice(0, 400));
      const d = (list[0] && list[0].detail) || {};
      A.eq([d.provider, d.account, d.window, d.usedPct, d.resetsAt, d.seenAt, d.source], ['codex', 'primary', '5-hour', 92, win.resetsAt, seenAt, SOURCE],
        name + ': the row names the reading, its sign-in, when it was read, its source and the reset — ' + JSON.stringify(d));
    }
    A.eq((rows.routine[0] || {}).detail && rows.routine[0].detail.origin, 'routine', 'the routine\'s row says a routine fire was held');
    A.eq((rows.build[0] || {}).detail && rows.build[0].detail.origin, 'workshop', 'the away shift\'s row says an away build was held');
    A.ok(rows.beat[0] && rows.beat[0].detail && rows.beat[0].detail.preSpend === true, 'the beat was held before the leash was spent');
    const s1 = await status();
    A.eq([s1.binding, s1.hold && s1.hold.why && s1.hold.why.usedPct], ['window-reserve', 92], 'the night shift\'s status names the hold and the reading — ' + JSON.stringify([s1.binding, s1.hold]));
    A.eq(s1.beatsUsedToday, 0, 'no leash unit was spent');
    const loopRow = ((await fx.json('GET', '/api/loops')).body.loops || []).find(l => l.id === loopId) || {};
    A.ok(loopRow.binding === 'precheck' && /92%/.test(loopRow.bindingDetail || '') && /codex/.test(loopRow.bindingDetail || '') && loopRow.wouldFire === false && !loopRow.iterationCount,
      'the LOOPS window shows the loop waiting, in the hold\'s words, no pass taken — ' + JSON.stringify({ b: loopRow.binding, d: loopRow.bindingDetail, w: loopRow.wouldFire, n: loopRow.iterationCount }));

    /* ===== 2. the user's own message on the same provider runs ===== */
    const t1 = Date.now();
    const mine = await userRun('say hello');
    A.eq([mine.status, mine.reason], [200, 'done'], 'the Commander\'s own message runs at 92% — ' + mine.text);
    A.ok(kinds(t1).indexOf('user') >= 0, 'and its call reached the provider');
    await sleep(1200);
    A.eq(kinds(t1).filter(k => k !== 'user'), [], 'the user\'s message did not open the door for unattended work');

    /* ===== 3. at 89% every unattended start goes ===== */
    win.pct = 89;
    const t2 = Date.now();
    const again = await userRun('one more');
    A.eq([again.status, again.reason], [200, 'done'], 'the next message runs; the provider now says 89% — ' + again.text);
    const routine2 = await routine(MARK.routine + ' second note', 'in 1s', 'lighthouse tally');
    A.ok(!!routine2, 'a second routine is scheduled');
    A.eq((await fx.json('POST', '/api/workshop/grant', { agentId: 'agent', on: false })).status, 200, 'the away workshop is re-armed (off) ...');
    A.eq((await fx.json('POST', '/api/workshop/grant', { agentId: 'agent', on: true })).status, 200, '... and on: its routine fires in 2 s');
    const went = k => kinds(t2).indexOf(k) >= 0;
    await until(async () => went('beat'), 25000);
    A.ok(went('beat'), 'at 89% an away-shift beat goes: ' + JSON.stringify(kinds(t2)));
    const s2 = await status();
    A.ok(s2.binding !== 'window-reserve' && !s2.hold, 'the night shift\'s status no longer names the hold: ' + s2.binding);
    // one away beat is the proof: the dial goes back to WAIT, so the day's leash is still there for the rail's turn below
    A.eq((await fx.json('POST', '/api/autonomy/posture', { posture: { initiative: 'wait', reach: 'sandbox', leashPerDay: 12 } })).status, 200, 'the night shift is stood down (WAIT)');
    await until(async () => went('routine') && went('loop') && went('build'), 25000);
    if (!went('routine')) {
      const job = ((await fx.json('GET', '/api/cron')).body.jobs || []).find(j => j && j.id === routine2) || {};
      const rows = (await ledger()).filter(e => e.jobId === routine2);
      console.log('DIAG routine2: ' + JSON.stringify({ job: { state: job.state, enabled: job.enabled, nextRunAt: job.nextRunAt, lastRunAt: job.lastRunAt, lastStatus: job.lastStatus, lastError: job.lastError, fireClaim: job.fireClaim, blockedConfig: job.blockedConfig, schedule: job.schedule }, rows: rows.slice(-6) }).slice(0, 1500));
      console.log('DIAG other calls: ' + JSON.stringify(up.calls.filter(c => c.at >= t2 && c.kind === 'other').map(c => c.said)).slice(0, 1500));
    }
    A.ok(went('routine'), 'at 89% a routine fire goes');
    A.ok(went('loop'), 'at 89% a loop tick goes');
    A.ok(went('build'), 'at 89% an away build goes');

    /* ===== 4. the 24-hour rail, RESUME, and a restart ===== */
    await fx.stop();
    // what ran above, as its usage receipts say it: every unattended start stamped with who started it, the user's message never
    const calls = path.join(usage, 'calls.jsonl');
    const receipts = () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const ran = receipts().filter(r => r.at >= t2);
    const origins = Array.from(new Set(ran.map(r => r.origin).filter(Boolean))).sort();
    A.eq(origins, ['loop', 'nightshift', 'routine', 'workshop'], 'each unattended start\'s calls carry who started it: ' + JSON.stringify(ran.map(r => [r.origin || '-', r.ref || '-']).slice(0, 40)));
    const mineRows = ran.filter(r => r.runId === again.runId);
    A.ok(mineRows.length > 0 && mineRows.every(r => !r.origin), 'the user\'s own message is never stamped unattended: ' + JSON.stringify(mineRows.map(r => r.origin || '-')));
    win.pct = 50;
    const now = Date.now();
    // three unattended routine fires of 700k fresh input each in the last hour: 2.1M weighted (the rail is 2M); and the Commander's own 9M,
    // which never counts
    const seed = [];
    for (let i = 0; i < 3; i++) seed.push({ v: 1, at: now - (50 - i * 10) * 60000, ms: 1000, provider: 'codex', account: 'primary', model: MODEL, uncachedIn: 700000, cacheRead: 0, cacheWrite: 0, out: 0, reasoning: 0, end: 'done', origin: 'routine', ref: 'seeded', start: 'seeded-' + i });
    seed.push({ v: 1, at: now - 20 * 60000, ms: 1000, provider: 'codex', account: 'primary', model: MODEL, uncachedIn: 9000000, cacheRead: 0, cacheWrite: 0, out: 0, reasoning: 0, end: 'done' });
    fs.appendFileSync(calls, seed.map(r => JSON.stringify(r)).join('\n') + '\n');
    // the rail's own count: the unattended calls of the last 24 h, weighted (fresh input, cache writes and output whole, a cache read at 1/10)
    const weigh = r => (r.uncachedIn || 0) + (r.cacheWrite || 0) + (r.cacheRead || 0) / 10 + (r.out || 0);
    const railCount = Math.round(receipts().filter(r => r.origin && r.at > Date.now() - 24 * HOUR && !r.usageMissing).reduce((s, r) => s + weigh(r), 0));
    await boot();
    A.ok((await posture(false)).body.ok === true, 'the night shift is armed again (no RESUME asked)');
    const t3 = Date.now();
    const routine3 = await routine(MARK.routine + ' third note', 'in 1s', 'orchard census');
    await until(async () => { const r = await ledger(); return held(r, e => e.ts >= t3 && e.source === 'nightshift' && e.binding === 'unattended-rail').length && held(r, e => e.ts >= t3 && e.jobId === routine3 && holdRow(e, 'unattended-rail')).length; }, 15000);
    const r3 = await ledger();
    const railBeat = held(r3, e => e.ts >= t3 && e.source === 'nightshift' && e.binding === 'unattended-rail');
    const railFire = held(r3, e => e.ts >= t3 && e.jobId === routine3 && holdRow(e, 'unattended-rail'));
    A.eq([railBeat.length, railFire.length], [1, 1], 'over the rail: the beat and the routine fire are each paused, one row each');
    const rd = (railBeat[0] && railBeat[0].detail) || {};
    A.eq([rd.tokens, rd.limit], [railCount, 2000000], 'the row names the weighted unattended count and the rail — ' + JSON.stringify(rd));
    A.ok(railCount >= 2100000 && railCount < 2200000, 'that count is the three seeded fires and the real unattended calls above, never the Commander\'s 9M: ' + railCount);
    A.ok(Number(rd.liftsAt) > now && /re-arm/.test(String(rd.note || '')), 'and when it lifts on its own, and how to resume it — ' + rd.note);
    A.eq(kinds(t3), [], 'no unattended start reached the provider');
    const s3 = await status();
    A.eq(s3.binding, 'unattended-rail', 'the night shift\'s status says it is paused by the rail');
    const t4 = Date.now();
    const third = await userRun('still me');
    A.eq([third.status, third.reason], [200, 'done'], 'the Commander\'s own message runs past the rail — ' + third.text);
    const resume = await posture(true);
    A.eq([resume.status, resume.body && resume.body.railResumed], [200, true], 'RESUME: re-arming the posture resumes unattended work — ' + String(resume.text).slice(0, 300));
    await until(async () => kinds(t4).indexOf('beat') >= 0, 15000);
    A.ok(kinds(t4).indexOf('beat') >= 0, 'after RESUME the next beat goes: ' + JSON.stringify(kinds(t4)));
    const notAgain = await posture(true);
    A.eq(notAgain.body && notAgain.body.railResumed, false, 'a re-arm while the rail is not holding resumes nothing (the count is not reset)');
    await fx.stop();
    await boot();
    await sleep(1500);
    const s4 = await status();
    A.ok(s4.binding !== 'unattended-rail', 'the resume survives a restart: ' + s4.binding);
    const rearmed = await posture(true);
    A.eq(rearmed.body && rearmed.body.railResumed, false, 'after the restart the rail still counts from the RESUME, so a re-arm has nothing to lift');
  } finally {
    await fx.dispose().catch(() => {});
    await new Promise(r => up.server.close(r));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('unattended-hold.e2e.test');
})().catch(e => { console.log('FAIL: unattended-hold.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
