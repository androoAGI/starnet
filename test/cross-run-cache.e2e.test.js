/* node test/cross-run-cache.e2e.test.js — CROSS-RUN CACHE (token-burn follow-up, 2026-10-17), through the REAL request
   assembly of a hermetic sidecar.

   A server-composed persona (routine fires, line hops, night-shift beats, loops, workshop shifts) used to fold the whole
   station evidence pack into its system prompt — topic counts, open threads, recent activity, verdict tallies and the
   TRACK RECORD's "finished clean X of N recent runs". Those change with every run, so no two runs of one routine sent
   the same system prompt and no provider served the prefix from cache across runs (on a real station 321 of 321
   same-agent hop pairs differed; the Codex cache route is a hash of that prompt, so the route moved too).

   1. Two Run Now fires of one routine send a BYTE-IDENTICAL system prompt and tool array.
   2. That prompt carries the persona, the routine note and the Commander's dossier (standing context) — and none of the
      observed evidence; the evidence (here a real TRACK RECORD line folded from seeded run history) rides the run's own
      <run_context> note, which still differs per run.
   3. STARNET_STABLE_PREFIX=0 puts the evidence back in the system prompt (the kill switch keeps the old shape).
   4. Every host site that feeds a server-composed persona into a run asks for the evidence (static pin), so a new site
      cannot silently drop it.
   No external inference: a mock OpenRouter upstream records every body. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostNotes, runContextOf } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const MARK = 'CROSS_RUN_CACHE_PROBE';
const DOSSIER = 'Commander dossier: CROSS_RUN_DOSSIER_MARK prefers terse status reports.';
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const leadingSystem = body => { const m = (body.messages || [])[0]; return m && m.role === 'system' ? text(m.content) : ''; };

function startUpstream() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
    if (body && leadingSystem(body).indexOf(MARK) >= 0) bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, bodies, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

function hermeticEnv(base, extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    SKYNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-cross-run-fake', SKYNET_DEFAULT_MODEL: 'test/model' }, extra || {});
}

// five finished routine runs in the last day: outcomes.js folds them into "scheduled runs — finished clean 5 of 5"
function seedHistory(ws) {
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({ runId: 'seed-' + i, agentId: 'scribe', provider: 'openrouter', model: 'test/model', reason: 'done', turns: 1, tokens: 20, usd: 0,
      streamId: 'cron-seed-' + i, startedAt: now - 3600000 * (i + 1), endedAt: now - 3600000 * (i + 1) + 1000, ts: now - 3600000 * (i + 1) + 1000 });
  }
  fs.writeFileSync(path.join(ws, 'runs.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

async function station(up, extraEnv) {
  const fixture = SidecarFixture.create({ prefix: 'starnet-cross-run-', timeoutMs: 30000, env: hermeticEnv(up.base, extraEnv) });
  seedHistory(fixture.workspace);
  await fixture.start();
  A.eq((await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
    { agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: 'test/model' },
    { agentId: 'scribe', name: 'SCRIBE', role: 'researcher', provider: 'openrouter', model: 'test/model', system: MARK + ': you are the station scribe.' }] })).status, 200, 'roster saved');
  A.eq((await fixture.json('POST', '/api/dossier', { block: DOSSIER })).status, 200, 'dossier saved');
  const created = await fixture.json('POST', '/api/cron', { name: 'Status', prompt: 'Report station status in one word.', schedule: 'every 1h', agentId: 'scribe', provider: 'openrouter', model: 'test/model' });
  A.eq(created.status, 200, 'routine created');
  return { fixture, jobId: created.body.job.id };
}

async function runNow(fixture, up, jobId) {
  const from = up.bodies.length;
  const r = await fixture.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
  A.eq(r.status, 200, 'Run Now streams');
  const events = (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const end = events.find(e => e.name === 'agent.run.end');
  A.eq(end && end.payload && end.payload.reason, 'done', 'the fire completes');
  return up.bodies.slice(from);
}

function staticPin() {
  const root = path.resolve(__dirname, '..', 'sidecar');
  const lines = readSidecarSource().split('\n');
  let sites = 0;
  lines.forEach((line, i) => {
    if (!/system:[^\n]*cronSystemFor\(/.test(line)) return;
    sites++;
    A.ok(lines.slice(i, i + 3).join('\n').indexOf('stationEvidence') >= 0, 'index.js:' + (i + 1) + ' feeds a server-composed persona into a run and asks for the station evidence');
  });
  A.ok(sites >= 7, 'the pin found the persona-fed run sites (' + sites + ')');
  for (const f of ['cron-driver.js', 'loopjob-driver.js', path.join('remote', 'host.js')]) {
    A.ok(/stationEvidence: true/.test(fs.readFileSync(path.join(root, f), 'utf8')), f + ': a driver-launched run asks for the station evidence');
  }
}

(async () => {
  staticPin();
  const up = await startUpstream();
  let st = null;
  try {
    // ---- 1 + 2: two fires of one routine ----
    st = await station(up);
    const f1 = await runNow(st.fixture, up, st.jobId);
    // the Commander works in between: the station's observed evidence (RECENT ACTIVITY) changes before the next fire
    const chat = await st.fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'openrouter', model: 'test/model', agentId: 'agent', isTask: true, streamId: 'owner-chat', surface: 'interactive',
      system: 'You are NOVA.', messages: [{ role: 'user', content: 'Draft the CROSS_RUN_ACTIVITY_MARK launch email for Friday' }] }) });
    A.eq(chat.status, 200, 'an owner chat runs between the fires');
    await chat.text();
    const f2 = await runNow(st.fixture, up, st.jobId);
    A.ok(f1.length >= 1 && f2.length >= 1, 'both fires reached the model');
    const [b1, b2] = [f1[0], f2[0]];
    const sys1 = leadingSystem(b1), sys2 = leadingSystem(b2);
    A.eq(sys2, sys1, 'the routine\'s system prompt is BYTE-IDENTICAL across two fires');
    A.eq(JSON.stringify(b2.tools), JSON.stringify(b1.tools), 'the tool array is byte-identical across the two fires');
    A.ok(sys1.indexOf(MARK) >= 0 && sys1.indexOf('[ROUTINE]') >= 0, 'the system prompt carries the persona and the routine note');
    A.ok(sys1.indexOf('CROSS_RUN_DOSSIER_MARK') >= 0, 'the Commander\'s dossier (standing context) stays in the system prompt');
    A.ok(sys1.indexOf('<commander_evidence') < 0 && sys1.indexOf('TRACK RECORD:') < 0, 'no observed evidence in the system prompt');
    const note1 = runContextOf(b1.messages), note2 = runContextOf(b2.messages);
    A.ok(note1.indexOf('<commander_evidence provenance="observed; weak; never override the current request">') >= 0, 'the evidence block rides the run-context note, fenced as weak evidence');
    A.ok(/TRACK RECORD: scheduled runs — finished clean \d+ of \d+ recent runs/.test(note1), 'the seeded run history reached the run as a TRACK RECORD line');
    A.ok(note1.indexOf('CROSS_RUN_DOSSIER_MARK') < 0, 'the dossier is not repeated in the run-context note');
    A.eq(hostNotes(b1.messages, 'run_context').length, 1, 'exactly one run-context note');
    A.ok(note1 !== note2, 'each fire still gets its own run context');
    A.ok(note1.indexOf('CROSS_RUN_ACTIVITY_MARK') < 0 && note2.indexOf('RECENT ACTIVITY: ') >= 0 && note2.indexOf('CROSS_RUN_ACTIVITY_MARK') >= 0,
      'the owner chat between the fires reached the second fire as RECENT ACTIVITY (the evidence really changed)');
    A.ok(sys2.indexOf('CROSS_RUN_ACTIVITY_MARK') < 0, '…and the system prompt stayed the same bytes anyway');
    await st.fixture.dispose(); st = null;

    // ---- 3: the kill switch restores the old placement ----
    st = await station(up, { STARNET_STABLE_PREFIX: '0' });
    const k1 = await runNow(st.fixture, up, st.jobId);
    const offSys = leadingSystem(k1[0]);
    A.ok(/TRACK RECORD: scheduled runs — finished clean/.test(offSys), 'STARNET_STABLE_PREFIX=0: the evidence is back in the system prompt');
    A.eq(hostNotes(k1[0].messages, 'run_context').length, 0, 'STARNET_STABLE_PREFIX=0: no run-context note');
  } finally {
    if (st) await st.fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('cross-run-cache.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
