/* node test/fold-from-prefix.http.test.js: THE FOLD FROM THE PREFIX THROUGH A REAL STATION (cost lane W2.7; STARNET_FOLD_FROM_PREFIX).

   One real sidecar, a recording model upstream on the OpenRouter wire with a Claude model id (so the adapter places explicit
   cache anchors), a task that reads nine 20,000-character files until the run passes its fold line. The free elision tier
   is switched off (STARNET_COMPACT_MICRO=0), so the fold is the paid one.
     OFF (the switch unset): the fold is the chunked one, as before: toolless summarizer requests under the summary prompt,
        none of them the run's own request, and agent.compact says nothing of a prefix.
     ON  (STARNET_FOLD_FROM_PREFIX=1, the same station restarted): the fold is ONE request. It is the run's previous
        request, message for message, then the turn made since, then one host turn with the summarize instruction; the
        tools are the run's bytes; no tool choice other than the run's own is sent; its cache anchors sit only where the
        previous request put them. The run goes on from the summary and finishes, and agent.compact says prefix. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const MODEL = 'anthropic/claude-test', READS = 9;
const text = c => (typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : ''));
const bare = v => JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x));
const anchored = m => JSON.stringify(m).includes('"cache_control"');
const SUMMARY = ['## Active Task', 'Read every big file and report.', '## Completed', '- big-1.txt to big-6.txt read: FOLD_FACT_7Q2', '## Remaining Work', '- the rest of the files'].join('\n');
const requests = [];   // every chat request: { kind, body, raw, task }
const issued = new Map();
function kindOf(body) {
  const system = (body.messages || []).filter(m => m && m.role === 'system').map(m => text(m.content)).join('\n');
  if (/You (compress an earlier slice|maintain a running summary) of an agent conversation/.test(system)) return 'chunk';
  const last = (body.messages || []).at(-1);
  return last && last.role === 'user' && text(last.content).indexOf('<host_turn>\nThe host is folding this conversation') === 0 ? 'prefix' : 'run';
}
const server = http.createServer(async (req, res) => {
  if (String(req.url).indexOf('/models') >= 0) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 100000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
  }
  let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
  let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
  const kind = kindOf(body), all = (body.messages || []).map(m => text(m && m.content)).join('\n');
  const task = (/FOLDTASK_(OFF|ON)/.exec(all) || [])[0] || '';
  requests.push({ kind, body, raw, task });
  const usage = { prompt_tokens: Math.ceil(raw.length / 3.6), completion_tokens: 20, total_tokens: Math.ceil(raw.length / 3.6) + 20 };
  const say = reply => { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n'); };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const read = (body.tools || []).map(d => d && d.function && d.function.name).find(name => /^fs[._]read$/.test(String(name)));
  if (kind !== 'run') say(SUMMARY);
  else if (task && read && (issued.get(task) || 0) < READS) {
    const n = (issued.get(task) || 0) + 1; issued.set(task, n);
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + task + '_' + n, type: 'function', function: { name: read, arguments: JSON.stringify({ path: 'big-' + n + '.txt' }) } }] } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
  } else say(task ? 'FOLD_DONE ' + task : 'NONE');
  res.end('data: [DONE]\n\n');
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fx = SidecarFixture.create({ prefix: 'fold-prefix-http-', env: {
    STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_DEFAULT_MODEL: MODEL, SKYNET_DEFAULT_MODEL: MODEL, STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0',
    STARNET_COMPACT_MICRO: '0'
  } });
  const home = path.join(fx.workspace, 'agent');
  fs.mkdirSync(home, { recursive: true });
  for (let n = 1; n <= READS; n++) { let s = 'big file ' + n + '\n'; let i = 0; while (s.length < 20000) s += 'row ' + (i++) + ' of file ' + n + ', plain filler text for the fold.\n'; fs.writeFileSync(path.join(home, 'big-' + n + '.txt'), s.slice(0, 20000)); }
  const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
  async function run(task) {
    const from = requests.length;
    const response = await fx.json('POST', '/api/run', { model: MODEL, provider: 'openrouter', key: 'fixture', agentId: 'agent', streamId: 'fold-' + task.toLowerCase(),
      isTask: true, placed: FLOOR, stationPlaced: FLOOR, messages: [{ role: 'user', content: task + ' read big-1.txt to big-' + READS + '.txt one at a time and report' }] });
    const events = response.status === 200 ? String(response.text).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    // the run's own requests name the task; a chunk of the chunked fold carries only the folded turns (the task's own message is pinned)
    const mine = requests.slice(from).filter(r => r.task === task || r.kind === 'chunk');
    return { status: response.status, end: events.filter(e => e.name === 'agent.run.end' && !e.payload.parentRunId).at(-1)?.payload,
      compacts: events.filter(e => e.name === 'agent.compact').map(e => e.payload), runs: mine.filter(r => r.kind === 'run'), folds: mine.filter(r => r.kind !== 'run'), all: mine };
  }
  try {
    /* ---------- OFF: the chunked fold, as before ---------- */
    await fx.start();
    const off = await run('FOLDTASK_OFF');
    A.eq([off.status, off.end?.outcome, issued.get('FOLDTASK_OFF')], [200, 'succeeded', READS], 'off: the task reads its nine files and finishes');
    A.ok(off.folds.length >= 2 && off.folds.every(f => f.kind === 'chunk' && !f.body.tools && !anchored(f.body)), 'off: the fold is ' + off.folds.length + ' toolless chunk requests with no cache anchor');
    A.eq([off.compacts.filter(c => c.reason === 'context').length, off.compacts.some(c => 'prefix' in c || 'prefixWhy' in c)], [1, false], 'off: one paid fold, and agent.compact says nothing of a prefix');
    await fx.stop();

    /* ---------- ON: one request from the run's own prefix ---------- */
    await fx.start({ STARNET_FOLD_FROM_PREFIX: '1' });
    const on = await run('FOLDTASK_ON');
    A.eq([on.status, on.end?.outcome, issued.get('FOLDTASK_ON')], [200, 'succeeded', READS], 'on: the task reads its nine files and finishes');
    A.eq([on.folds.length, on.folds[0] && on.folds[0].kind], [1, 'prefix'], 'on: the fold is ONE request from the run\'s own prefix');
    const fold = on.folds[0], at = on.all.indexOf(fold), prev = on.all.slice(0, at).filter(r => r.kind === 'run').at(-1), next = on.all.slice(at + 1).find(r => r.kind === 'run');
    const was = prev.body.messages, now = fold.body.messages;
    A.ok(now.length > was.length && was.every((m, i) => bare(m) === bare(now[i])), 'on: the run\'s previous request is, message for message, the start of the fold request (' + was.length + ' of ' + now.length + ' messages)');
    A.eq([bare(fold.body.tools) === bare(prev.body.tools), fold.body.tool_choice, prev.body.tool_choice, fold.body.model, JSON.stringify(fold.body.reasoning) === JSON.stringify(prev.body.reasoning)],
      [true, 'auto', 'auto', MODEL, true], 'on: the tools are the run\'s bytes, and the tool choice, model and effort are the run\'s own');
    const tail = now.slice(was.length);
    A.eq([tail.at(-1).role, text(tail.at(-1).content).includes('Summarize the earlier part of the conversation above so it can replace the raw turns.'), tail.slice(0, -1).map(m => m.role).join(',')],
      ['user', true, 'assistant,tool'], 'on: after it come the turn made since (the call and its result) and one host turn with the instruction');
    const wasAnchors = was.map((m, i) => (anchored(m) ? i : -1)).filter(i => i >= 0), nowAnchors = now.map((m, i) => (anchored(m) ? i : -1)).filter(i => i >= 0);
    A.ok(wasAnchors.length >= 2 && JSON.stringify(nowAnchors) === JSON.stringify(wasAnchors) && nowAnchors.every(i => JSON.stringify(now[i]) === JSON.stringify(was[i])),
      'on: its cache anchors are the previous request\'s, on the same messages (' + JSON.stringify(wasAnchors) + '), and nothing after them is anchored: the fold reads and writes nothing');
    const share = was.reduce((n, m) => n + Buffer.byteLength(bare(m)), 0) / now.reduce((n, m) => n + Buffer.byteLength(bare(m)), 0);
    console.log('[fold-from-prefix.http] off: ' + off.folds.length + ' chunk requests, ' + off.folds.reduce((n, f) => n + Buffer.byteLength(f.raw), 0) + ' bytes; on: 1 request, ' + Buffer.byteLength(fold.raw) + ' bytes, '
      + (100 * share).toFixed(1) + '% of its message bytes the previous request\'s (plus the same system prompt and tools)');
    A.ok(share > 0.8, 'on: more than 80% of the fold\'s message bytes are the previous request\'s');
    A.eq([on.compacts.filter(c => c.reason === 'context').length, on.compacts.find(c => c.reason === 'context')?.prefix, on.compacts.find(c => c.reason === 'context')?.chunks], [1, true, 1], 'on: agent.compact says the summary came from the prefix');
    A.ok(next && next.body.messages.some(m => text(m.content).includes('FOLD_FACT_7Q2')), 'on: the run goes on with the summary standing in for the folded turns');
  } finally { await fx.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  A.report('fold-from-prefix.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
