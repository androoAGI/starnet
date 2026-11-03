'use strict';
// A verdict given AFTER a sidecar restart still reaches its skill review: the run-end packet is persisted
// (provider-free) and restored on boot; the review rebuilds a provider from the agent's current config and its
// prompt carries the Commander's verdict and correction. Before, the packet lived in RAM and the verdict taught nothing.
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {bootToken} = require('./_httpToken.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written
const root = path.resolve(__dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-verdict-packets-'));
const EPOCH = seedActiveStation(workspace).save.agent.createdAt;   // a rating names its station's founding (the save's agent.createdAt)
let child, base, headers, out = '';
const seen = [];
const hung = [];   // the cold-model probe's review requests: never answered, so the pass's own deadline cancels them
const mock = http.createServer((req, res) => {
  if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({data: [{id: 'test/model', context_length: 128000, pricing: {prompt: '0', completion: '0'}, supported_parameters: ['tools']}]})); }
  let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
    try { seen.push(JSON.parse(raw)); } catch (_) {}
    const review = raw.indexOf('COMMANDER VERDICT ON THIS RUN') >= 0;
    // the cold-model probe's review: no byte ever comes back (a local model still loading, a provider that hung once).
    // Matched FIRST: it runs last, and its review prompt also names the earlier probe runs.
    if (review && raw.indexOf('cold-model probe') >= 0) { hung.push(res); return; }
    // the outage probe's review: the provider refuses before the pass changes anything
    if (review && raw.indexOf('provider-outage probe') >= 0) { res.writeHead(400, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({error: {message: 'invalid request: malformed json body field'}})); }
    res.writeHead(200, {'Content-Type': 'text/event-stream'});
    // the ceiling probe's review: a tool call every turn, so the pass ends on its own 6-turn ceiling (max_iters)
    if (review && raw.indexOf('iteration-ceiling probe') >= 0) {
      res.write('data: ' + JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: 'call_' + seen.length, type: 'function', function: {name: 'skill_list', arguments: '{}'}}]}}]}) + '\n\n');
      res.write('data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 5, completion_tokens: 5, total_tokens: 10}}) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.write('data: ' + JSON.stringify({choices: [{delta: {content: 'Done: the weekly report is written.'}}]}) + '\n\n');
    res.write('data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 5, completion_tokens: 5, total_tokens: 10}}) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
});
async function boot() {
  const socket = http.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(r => socket.close(r));
  base = 'http://127.0.0.1:' + port; out = '';
  child = spawn(process.execPath, ['sidecar/index.js'], {cwd: root, env: {...process.env, SKYNET_WORKSPACES: workspace, SKYNET_PORT: String(port), SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:' + mock.address().port + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-packets-fixture', SKYNET_EDGE_TTS: '0', SKYNET_VERDICT_REVIEW_GRACE_MS: '6000', SKYNET_SKILL_REVIEW_TIMEOUT_MS: '8000', SKYNET_SKILL_CURATOR:'0', SKYNET_SCOUT:'0', SKYNET_QUEST_REFRESH:'0'}, stdio: ['ignore', 'pipe', 'pipe']});
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('boot timeout: ' + out.slice(-1200))), 90000); const read = d => { out += d; if (out.includes('Open in your browser:')) { clearTimeout(timer); resolve(); } }; child.stdout.on('data', read); child.stderr.on('data', read); child.once('exit', c => { clearTimeout(timer); if (c) reject(new Error('boot exit ' + c + out.slice(-1200))); }); });
  headers = {'Content-Type': 'application/json', 'X-StarNet-Token': await bootToken(base, base), Origin: base};
}
async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
async function api(url, body) { const r = await fetch(base + url, {headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body)}); return {status: r.status, body: await r.json()}; }
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); } return !!fn(); };
(async () => {
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  try {
    await boot();
    A.ok((await api('/api/roster', {agents: [{agentId: 'agent', name: 'Hero', model: 'test/model', provider: 'openrouter'}]})).body.ok, 'roster saved');
    const r = await fetch(base + '/api/run', {method: 'POST', headers, body: JSON.stringify({agentId: 'agent', key: 'sk-or-v1-packets-fixture', model: 'test/model', isTask: true, messages: [{role: 'user', content: 'Write the weekly status report for the board.'}]})});
    const end = (await r.text()).split('\n').filter(Boolean).map(s => JSON.parse(s)).find(e => e.name === 'agent.run.end');
    A.eq(end && end.payload.reason, 'done', 'task run completed');
    const file = path.join(workspace, 'verdict.packets.json');
    A.ok(await until(() => fs.existsSync(file), 5000), 'the run-end packet is written to disk');
    const onDisk = fs.readFileSync(file, 'utf8');
    A.ok(onDisk.indexOf(end.payload.runId) >= 0, 'for this run');
    A.ok(onDisk.indexOf('sk-or-v1-packets-fixture') < 0, 'no credential on disk');

    await stop(); await boot();
    A.ok(/\[skills\] restored 1 verdict review packet/.test(out), 'the packet is restored on boot');
    const before = seen.length;
    const rated = await api('/api/growth/ratings', {runId: end.payload.runId, verdict: 'miss', epoch: EPOCH, correction: 'three bullets, not an essay'});
    A.ok(rated.body.ok && rated.body.skillReviewArmed === true, 'the post-restart verdict armed a review: ' + JSON.stringify(rated.body));
    const armed = JSON.parse(fs.readFileSync(file, 'utf8')).rows.find(row => row.runId === end.payload.runId);
    A.ok(armed && armed.state === 'held' && armed.reviewStatus === 'pending', 'armed grace job is durable before HTTP acknowledges it');
    await stop(); await boot();
    A.ok(/\[skills\] restored 1 verdict review packet/.test(out), 'armed review job restores across a second restart');
    const reviewed = await until(() => seen.slice(before).some(b => JSON.stringify(b.messages || []).indexOf('COMMANDER VERDICT ON THIS RUN: MISSED') >= 0), 15000);
    A.ok(reviewed, 'the review ran on a rebuilt provider, with the verdict in its prompt');
    const req = seen.slice(before).find(b => JSON.stringify(b.messages || []).indexOf('COMMANDER VERDICT ON THIS RUN') >= 0);
    A.ok(req && JSON.stringify(req.messages).indexOf('three bullets, not an essay') >= 0, 'and the Commander\'s correction');
    A.ok(req && JSON.stringify(req.messages).indexOf('Write the weekly status report') >= 0, 'over the restored transcript');
    A.ok(await until(() => !JSON.parse(fs.readFileSync(file, 'utf8')).rows.some(row => row.runId === end.payload.runId && row.state === 'held' && row.reviewStatus !== 'completed'), 5000), 'successful review durably leaves the held queue');
    const completedCalls=seen.length; await stop(); await boot();
    await new Promise(resolve=>setTimeout(resolve,300));
    A.eq(seen.length,completedCalls,'completed review is not re-dispatched after another restart');

    // A review pass that stopped on its OWN ceiling did its work: it completes, never a paid retry (audit 10-11).
    // Negative: a pass whose provider failed before it changed anything stays queued for its retry.
    const taskRun = async directive => (await (await fetch(base + '/api/run', {method: 'POST', headers, body: JSON.stringify({agentId: 'agent', key: 'sk-or-v1-packets-fixture', model: 'test/model', isTask: true, messages: [{role: 'user', content: directive}]})})).text()).split('\n').filter(Boolean).map(s => JSON.parse(s)).find(e => e.name === 'agent.run.end');
    const heldRow = id => JSON.parse(fs.readFileSync(file, 'utf8')).rows.find(row => row.runId === id && row.state === 'held');
    const reviewCalls = probe => seen.filter(b => { const s = JSON.stringify(b.messages || []); return s.indexOf('COMMANDER VERDICT ON THIS RUN') >= 0 && s.indexOf(probe) >= 0; }).length;
    const ceiling = await taskRun('Draft the iteration-ceiling probe memo.');
    A.eq(ceiling && ceiling.payload.reason, 'done', 'ceiling probe run completed');
    A.ok((await api('/api/growth/ratings', {runId: ceiling.payload.runId, verdict: 'miss', epoch: EPOCH})).body.skillReviewArmed === true, 'ceiling probe review armed');
    A.ok(await until(() => reviewCalls('iteration-ceiling probe') >= 6 && (heldRow(ceiling.payload.runId) || {}).reviewStatus !== 'running', 20000), 'the ceiling probe review ran to its turn ceiling');
    A.eq(reviewCalls('iteration-ceiling probe'), 6, 'one pass of six turns (maxIters), no second pass');
    const ceilingRow = heldRow(ceiling.payload.runId);
    A.ok(!ceilingRow || ceilingRow.reviewStatus === 'completed', 'RATCHET: a max_iters review is durably completed instead of queued for a paid retry: ' + JSON.stringify(ceilingRow && {reviewStatus: ceilingRow.reviewStatus, attempts: ceilingRow.attempts}));
    const outage = await taskRun('Draft the provider-outage probe memo.');
    A.eq(outage && outage.payload.reason, 'done', 'outage probe run completed');
    A.ok((await api('/api/growth/ratings', {runId: outage.payload.runId, verdict: 'miss', epoch: EPOCH})).body.skillReviewArmed === true, 'outage probe review armed');
    A.ok(await until(() => reviewCalls('provider-outage probe') >= 1 && ((heldRow(outage.payload.runId) || {}).attempts || 0) >= 1 && heldRow(outage.payload.runId).reviewStatus !== 'running', 20000), 'the outage probe review pass ended');
    const outageRow = heldRow(outage.payload.runId);
    A.ok(outageRow && outageRow.reviewStatus === 'pending' && outageRow.attempts === 1, 'a review whose provider failed before any skill change is kept for a retry: ' + JSON.stringify(outageRow && {reviewStatus: outageRow.reviewStatus, attempts: outageRow.attempts}));
    // A pass the 45s deadline cancelled BEFORE the model produced anything did no work: it keeps its bounded retry (audit 10-12).
    const cold = await taskRun('Draft the cold-model probe memo.');
    A.eq(cold && cold.payload.reason, 'done', 'cold-model probe run completed');
    A.ok((await api('/api/growth/ratings', {runId: cold.payload.runId, verdict: 'miss', epoch: EPOCH})).body.skillReviewArmed === true, 'cold-model probe review armed');
    A.ok(await until(() => reviewCalls('cold-model probe') >= 1 && (heldRow(cold.payload.runId) || {}).reviewStatus !== 'running', 30000), 'the cold-model probe review pass hit its deadline');
    A.eq(hung.length, 1, 'its one provider call hung with no byte back, so only the deadline could end the pass');
    const coldRow = heldRow(cold.payload.runId);
    A.ok(coldRow && coldRow.reviewStatus === 'pending' && coldRow.attempts === 1, 'RATCHET: a review cancelled by its deadline before the model produced anything is kept for a retry: ' + JSON.stringify(coldRow && {reviewStatus: coldRow.reviewStatus, attempts: coldRow.attempts}));
    A.eq(reviewCalls('cold-model probe'), 1, 'one cancelled pass so far (the retry waits its own delay)');
  } finally { for (const res of hung) { try { res.destroy(); } catch (e) { console.error('hung mock response close failed:', e && e.message); } } await stop(); await new Promise(r => mock.close(r)); fs.rmSync(workspace, {recursive: true, force: true}); }
  A.report('verdictpackets.http');
})().catch(e => { console.error(e); process.exit(1); });
