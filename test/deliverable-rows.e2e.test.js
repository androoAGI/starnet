'use strict';
/* node test/deliverable-rows.e2e.test.js — the files a run wrote are rows of the station's own transcript, exact and openable
   from the station alone (turn identity, commit 10; design A2-SP-C01).

   Boots the real sidecar and a scripted local model. A routine's Run Now (no page anywhere) writes 'report · v2.md',
   'a · b.png', 'clip.mp3' and 'clip.mp4' through the real fs tools, plus one write the jail refuses. Off the station's
   own routes it proves:
     1. GET /api/transcript holds exactly one deliverable row per written file, with the exact path (middle dots and all) and
        the right media, the writing agent's workspace, root '' and the run's ids; the refused write has no row;
     2. after a station restart the same rows come back with the same row ids, and /api/file, called with the adapted args
        (agent = row.deliverable.workspace, path = row.deliverable.path), returns the exact bytes the tools wrote;
     3. a file written by another agent opens in THAT agent's workspace and is not found in the first agent's;
     4. a file a project run wrote opens under the project's currently blessed root and is refused once the grant is gone;
     5. a path that drifts through a junction out of the jail is still refused by the existing open owner;
     6. the rows are display only: model replay holds the reply and no file row, recall finds a file by its display prose
        and never by its folders, and the run's artifact ledger and recap card are unchanged;
     7. the agent's deliverable_note names the one file it proves ('main') and no other.
   RED at 4152883a1: no deliverable rows exist, so GET holds no file rows. On http.list. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const Kinds = require('../frontend/app/turnkinds.js');
const Merge = require('../frontend/app/turnmerge.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const REPORT = 'report · v2.md', IMAGE = 'a · b.png', AUDIO = 'clip.mp3', VIDEO = 'clip.mp4', DRIFT = 'drift/x.md';
const BYTES = { [REPORT]: '# Report v2\nbytes-of-the-report · exact', [IMAGE]: 'PNG-a-b-bytes', [AUDIO]: 'MP3-bytes', [VIDEO]: 'MP4-bytes', [DRIFT]: 'inside-the-jail' };
const WORKER_FILE = 'worker-note.md', WORKER_BYTES = 'the worker wrote this', PROJECT_FILE = 'src/project-note.md', PROJECT_BYTES = 'inside the project';

// the scripted model: one tool call per turn, chosen by the run's own marker word and by how many results it has seen
function scripted(marker, steps) {
  return { marker, steps };
}
const PLANS = [
  scripted('FILES_RUN', [
    ['fs_write', { path: REPORT, content: BYTES[REPORT] }], ['fs_write', { path: IMAGE, content: BYTES[IMAGE] }], ['fs_write', { path: AUDIO, content: BYTES[AUDIO] }],
    ['fs_write', { path: VIDEO, content: BYTES[VIDEO] }], ['fs_write', { path: '../escape.md', content: 'refused by the jail' }],
    ['fs_write', { path: DRIFT, content: BYTES[DRIFT] }],
    ['deliverable_note', { title: 'The v2 report', summary: 'Four files and a note.', kind: 'files', main: REPORT }]]),
  scripted('WORKER_RUN', [['fs_write', { path: WORKER_FILE, content: WORKER_BYTES }]]),
  scripted('PROJECT_RUN', [['fs_write', { path: PROJECT_FILE, content: PROJECT_BYTES }]])
];

function startModel(requests) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); return res.end(); }
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const messages = Array.isArray(body.messages) ? body.messages : [], tools = (body.tools || []).map(t => t && t.function && t.function.name);
        const lastUser = messages.map(m => m.role).lastIndexOf('user');
        const words = String(userWords(messages[lastUser] || {}) || '');   // the Commander's own words: earlier runs' titles ride the run-context note
        const plan = PLANS.find(p => words.includes(p.marker));
        const after = messages.slice(lastUser + 1);
        const used = after.filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const call = (name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: name + '_' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        };
        const say = text => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        };
        if (!plan || !tools.length) say('Noted.');
        else if (tools.includes('brief_proceed') && !used.includes('brief_proceed')) call('brief_proceed', { objective: 'Write the files', deliverable: 'the files' });
        else {
          const done = used.filter(n => n !== 'brief_proceed').length, step = plan.steps[done];
          if (step) call(step[0], step[1]); else say('Wrote the files. ' + plan.marker + '_DONE');
        }
        res.write('data: [DONE]\n\n'); res.end();
      });
    });
    server.listen(0, HOST, () => resolve(server));
  });
}

const ndjson = text => String(text || '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
const rowsOf = body => (body && Array.isArray(body.turns) ? body.turns : []);
const fileRowsOf = body => rowsOf(body).filter(row => row.kind === 'deliverable');

(async () => {
  const requests = [];
  const model = await startModel(requests);
  const base = 'http://' + HOST + ':' + model.address().port + '/api/v1';
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-file-rows-'));
  fs.mkdirSync(path.join(scratch, 'project'), { recursive: true });
  const project = fs.realpathSync(path.join(scratch, 'project'));
  const outside = path.join(scratch, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const fixture = SidecarFixture.create({ prefix: 'starnet-file-rows-', timeoutMs: 40000, env: {
    SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-file-rows-fixture', STARNET_OPENROUTER_KEY: 'sk-or-v1-file-rows-fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_CRON_TICK_MS: '5000', STARNET_CRON_TICK_MS: '5000',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_EDGE_TTS: '0', SKYNET_QUEST_REFRESH_MS: '0', SKYNET_SCOUT: '0', SKYNET_THREAD_MINE: '0'
  } });
  const grants = path.join(fixture.workspace, 'permissions.allow.json');
  const jail = agent => path.join(fixture.workspace, agent);
  try {
    fs.writeFileSync(grants, JSON.stringify({ allow: ['path:' + project] }));
    await fixture.start();
    A.eq((await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'Lead', model: 'test/model', provider: 'openrouter' },
      { agentId: 'worker-1', name: 'Worker', model: 'test/model', provider: 'openrouter' }] })).status, 200, 'fixture: roster saved');

    /* 1. a routine's Run Now with no page anywhere */
    const created = await fixture.json('POST', '/api/cron', { name: 'File rows proof', prompt: 'FILES_RUN: write the files and name them.', schedule: 'every 24h', agentId: 'agent', model: 'test/model', provider: 'openrouter' });
    A.eq(created.status, 200, 'the routine is created');
    const jobId = created.body.job.id;
    const run = await fixture.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId }) });
    A.eq(run.status, 200, 'Run Now enters the real routine owner');
    const events = ndjson(await run.text());
    const start = events.find(e => e.name === 'agent.run.start' && e.payload && !e.payload.parentRunId);
    const runId = start && start.payload.runId, stream = 'cron-' + runId;
    A.ok(!!runId, 'the run has an id: ' + runId);
    const results = events.filter(e => e.name === 'agent.tool_result' && e.payload).map(e => ({ ok: !!e.payload.ok && !e.payload.isError, id: e.payload.callId, why: String(e.payload.summary || e.payload.reason || '').slice(0, 120) }));
    A.ok(results.filter(r => r.ok).length >= 6 && results.some(r => !r.ok), 'fixture: the real tools wrote the files and the jail refused the escape (' + JSON.stringify(results) + ')');
    for (const [name, bytes] of Object.entries(BYTES)) A.eq(fs.readFileSync(path.join(jail('agent'), name), 'utf8'), bytes, 'fixture: the tool wrote ' + name);
    A.ok(!fs.existsSync(path.join(fixture.workspace, 'escape.md')), 'fixture: the refused write left nothing behind');

    const read = async () => { const got = await fixture.json('GET', '/api/transcript?stream=' + encodeURIComponent(stream) + '&limit=200'); A.eq(got.status, 200, 'the transcript route answers'); return got.body; };
    let body = await read(), files = fileRowsOf(body);
    const WRITTEN = [REPORT, IMAGE, AUDIO, VIDEO, DRIFT];
    const MEDIA = { [REPORT]: 'file', [IMAGE]: 'image', [AUDIO]: 'audio', [VIDEO]: 'video', [DRIFT]: 'file' };
    A.eq(files.map(r => r.deliverable.path), WRITTEN, 'GET holds one deliverable row per written file, exact paths, in the order they were written');
    A.eq(files.map(r => r.deliverable.media), WRITTEN.map(p => MEDIA[p]), 'with the right media');
    A.ok(files.every(r => r.role === 'system' && r.deliverable.workspace === 'agent' && r.deliverable.root === '' && r.sourceRunId === runId && r.turnId === Kinds.runTurnId(runId) && Number.isSafeInteger(r.rowId) && r.rowId > 0), 'each names the writing agent, no root, the run and its turn');
    A.ok(files.every(r => r.deliverable.path.length <= 260 && !/^[\\/]|^[A-Za-z]:|\.\./.test(r.deliverable.path)), 'and no path is shortened, absolute or climbing');
    A.ok(!files.some(r => /escape/.test(r.deliverable.path)), 'the write the jail refused has no row');
    A.eq(files.find(r => r.deliverable.path === REPORT).deliverable.name, 'The v2 report', 'the note names the one file it proved (main)');
    A.eq(files.filter(r => r.deliverable.path !== REPORT).map(r => r.deliverable.name), [IMAGE, AUDIO, VIDEO, 'x.md'], 'and every other row is named by its basename');
    const reply = rowsOf(body).find(r => r.role === 'assistant' && /FILES_RUN_DONE/.test(r.content || ''));
    A.ok(!!reply && files.every(r => r.rowId < reply.rowId), 'the file rows precede the reply that names them: ' + JSON.stringify(rowsOf(body).map(r => [r.rowId, r.role, r.kind, String(r.content || '').slice(0, 24)])));
    const ids = files.map(r => r.rowId);

    /* the rows reach display but never the model's window; recall finds a file by its prose, not its folders */
    const replay = await fixture.json('GET', '/api/transcript?stream=' + encodeURIComponent(stream) + '&view=model-replay&limit=200');
    A.ok(replay.status === 200 && !rowsOf(replay.body).some(r => r.kind === 'deliverable' || (r.deliverable != null)), 'model replay carries no file row');
    const runs = (await fixture.json('GET', '/api/runs?agent=agent&runId=' + runId)).body.runs || [];
    const record = runs.find(r => r.runId === runId) || {};
    A.eq((record.artifacts || []).map(a => a.path), WRITTEN, 'the run\'s artifact ledger (the recap card\'s source) is unchanged and still lists every written file');
    A.ok(!(record.artifacts || []).some(a => 'cut' in a), 'and carries no new field');
    A.eq(record.deliverable && record.deliverable.title, 'The v2 report', 'the run record keeps its note');

    /* 2. a restart, with nothing of any page: the same rows, and the bytes behind each */
    await fixture.restart();
    body = await read(); files = fileRowsOf(body);
    A.eq(files.map(r => [r.rowId, r.deliverable.path, r.deliverable.media]), WRITTEN.map((p, i) => [ids[i], p, MEDIA[p]]), 'after a restart GET holds the same rows with the same row ids');
    for (const row of files) {
      const args = Merge.deliverableOf(row);
      A.ok(!!args && args.title === row.deliverable.path && args.agentId === 'agent' && args.root === '' && args.runId === runId, 'the page adapter yields the record: ' + row.deliverable.path);
      const opened = await fixture.request('/api/file?agent=' + encodeURIComponent(args.agentId) + '&path=' + encodeURIComponent(args.title));
      A.eq([opened.status, await opened.text()], [200, BYTES[row.deliverable.path]], '/api/file with the adapted args returns the exact bytes: ' + row.deliverable.path);
    }
    const recall = rowsOf((await fixture.json('GET', '/api/transcript?stream=' + encodeURIComponent(stream) + '&limit=200')).body);
    A.ok(recall.length >= files.length + 2, 'fixture: the stream still holds its directive and reply');

    /* 3. a file another agent wrote opens in that agent's workspace only */
    const worker = await fixture.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', agentId: 'worker-1', isTask: true, streamId: 'worker-stream', messages: [{ role: 'user', content: 'WORKER_RUN: write your note.' }] });
    A.eq(worker.status, 200, 'the worker run streams');
    const wrows = fileRowsOf((await fixture.json('GET', '/api/transcript?stream=worker-stream&agent=worker-1&limit=100')).body);
    A.eq(wrows.map(r => [r.deliverable.path, r.deliverable.workspace, r.deliverable.root, r.agentId]), [[WORKER_FILE, 'worker-1', '', 'worker-1']], 'the worker\'s file row names the worker\'s workspace');
    const own = await fixture.request('/api/file?agent=worker-1&path=' + encodeURIComponent(WORKER_FILE));
    A.eq([own.status, await own.text()], [200, WORKER_BYTES], 'it opens in the worker\'s own workspace');
    const wrong = await fixture.request('/api/file?agent=agent&path=' + encodeURIComponent(WORKER_FILE));
    A.eq(wrong.status, 404, 'and is not found in the lead\'s');

    /* 4. a project run: the file opens under the project's blessed root, and only while it is blessed */
    const proj = await fixture.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', agentId: 'agent', isTask: true, streamId: 'project-stream', projectRoot: project, messages: [{ role: 'user', content: 'PROJECT_RUN: write into the project.' }] });
    A.eq(proj.status, 200, 'the project run streams');
    const prows = fileRowsOf((await fixture.json('GET', '/api/transcript?stream=project-stream&limit=100')).body);
    A.eq(prows.map(r => [r.deliverable.path, r.deliverable.workspace, r.deliverable.root]), [[PROJECT_FILE, 'agent', project]], 'the project run\'s file row names the project root and the relative path');
    A.eq(fs.readFileSync(path.join(project, PROJECT_FILE), 'utf8'), PROJECT_BYTES, 'fixture: the file is inside the project');
    const pargs = Merge.deliverableOf(prows[0]);
    const openProject = () => fixture.request('/api/file?agent=' + encodeURIComponent(pargs.agentId) + '&path=' + encodeURIComponent(pargs.title) + '&project=' + encodeURIComponent(pargs.root));
    const opened = await openProject();
    A.eq([opened.status, await opened.text()], [200, PROJECT_BYTES], 'with the adapted args (agent, path, project) /api/file returns the project file');
    const inJail = await fixture.request('/api/file?agent=agent&path=' + encodeURIComponent(PROJECT_FILE));
    A.eq(inJail.status, 404, 'while the same relative path in the agent\'s own workspace is a different (absent) file');
    const revoked = await fixture.json('POST', '/api/permissions/revoke', { key: 'path:' + project });
    A.eq(revoked.status, 200, 'fixture: the project grant is withdrawn');
    const refused = await openProject();
    A.eq(refused.status, 403, 'once the grant is withdrawn the existing open owner refuses the project file');
    A.ok(!(await refused.text()).includes(PROJECT_BYTES), 'and serves none of its bytes');

    /* 5. a path that drifts out of the jail through a junction is still refused */
    const driftDir = path.join(jail('agent'), 'drift');
    fs.rmSync(driftDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(outside, 'x.md'), 'OUTSIDE-the-jail');
    let linked = true;
    try { fs.symlinkSync(outside, driftDir, 'junction'); } catch (_) { linked = false; }
    if (linked) {
      const drifted = await fixture.request('/api/file?agent=agent&path=' + encodeURIComponent(DRIFT));
      A.ok(drifted.status === 403 || drifted.status === 404, 'a row\'s path that now resolves outside the jail is refused by the existing owner (got ' + drifted.status + ')');
      A.ok(!(await drifted.text()).includes('OUTSIDE'), 'and the outside bytes are never served');
    } else console.log('NOTE: junction creation is not permitted here; the drift leg was skipped');

    /* 6. the stream's display holds the chips, model replay never; a rerun of the page's merge finds the same address */
    const display = rowsOf(await read());
    A.eq(display.filter(r => r.kind === 'deliverable').length, WRITTEN.length, 'display still holds each chip once after all of this');
  } catch (error) {
    A.ok(false, 'threw: ' + ((error && error.stack) || error) + '\n' + fixture.output().slice(-3000));
  } finally {
    await fixture.dispose();
    await new Promise(resolve => { model.closeAllConnections && model.closeAllConnections(); model.close(resolve); });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  A.report('deliverable-rows.e2e');
})();
