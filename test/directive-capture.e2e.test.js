'use strict';
/* node test/directive-capture.e2e.test.js — the directive is captured ONCE, before the files expand, and every reader of
   "what the Commander asked" reads that one wording (turn identity, commit 4; closes the directive/title half of e7dcb889;
   A2-ROOT-01, A2-SP-06, A2-FP-C01).

   Real sidecar (hermetic fixture) + real POST /api/run against a local mock provider (no money spent). Legs:
     1. PROOF: a captionless photo + notes.txt. The run's first model answer is an fs.read of a PNG, so the loop appends a
        real "[BEGIN EXTERNAL SCREEN CAPTURE" user turn. The run title is the label "[image: photo.png], [file: notes.txt]"
        (the base titled it with the expanded text: notes.txt's bytes); the directive row is the label (since the attachment
        rows step it no longer holds the expanded text) with the attachment refs and kind 'turn', and each file is an
        attachment row beside it; the capture turn is filed as kind 'capture'; the task
        brief's text, the persisted verdict packet's directive and a rating's feedback citation are the same label, and
        none of them holds the capture marker or the file's bytes. The brief and the packet name the directive row.
     2. control: a captioned photo is titled by its caption (pinned: passes on the base)
     3. null capture (controls, pass on the base): (n1) an internal system-only body with messages: [] and (n2) an
        assistant-only body each reach the provider exactly once and end done, with no TypeError noted, no directive
        row, no task brief and the base's run title ('')
     4. (n3) a captionless photo writes its directive (typed ?? content = its label; the base wrote none), and a retry of
        that turn with the same photo reuses it: one directive row, run.start keeps the turnId (no input conflict)
     5. safe packet text: a typed directive holding a token, plus a file: the persisted packet's directive is the directive
        row's typed words (redacted), and no durable derived store (packet, brief) holds the raw token */
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const TurnKinds = require('../frontend/app/turnkinds.js');
const { makeSkillStore } = require('../sidecar/skillstore.js');
const { digestOf } = require('../sidecar/skills/gate.js');
const skillGuard = require('../sidecar/skills/guard.js');
const skillPackages = require('../sidecar/skills/package.js');

const HOST = '127.0.0.1';
const AGENT = 'capturecheck';
// a valid 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const NOTES = 'NOTES-BYTES-SENTINEL: the walrus budget is 4000 credits';
const PHOTO = { id: 'a1b2c3d4e5', name: 'photo.png', path: '.attachments/a1b2c3d4e5.png', mediaType: 'image/png', kind: 'image', size: PNG.length };
const NOTE = { id: 'f6a7b8c9d0', name: 'notes.txt', path: '.attachments/f6a7b8c9d0.txt', mediaType: 'text/plain', kind: 'file', size: NOTES.length };
const LABEL = '[image: photo.png], [file: notes.txt]';
const CAPTION = 'CAPTION-SENTINEL what colour is this photo';
const TOKEN = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const OLDER = 'OLDER-DIRECTIVE-SENTINEL: an earlier conversation, never the current instruction';
const SKILL_NAME = 'Capture proof reader';
const KEY_NAME = 'CAPTURE_PROOF_API_KEY';
const mint = () => TurnKinds.mintTurnId(() => crypto.randomInt(0, 0x100000000) / 0x100000000);

// Seed an existing safe skill through the real store and package writer; the run must actually preload it and the
// rating route must discover it through its real packet. No fabricated loadedSkills or golden records.
function seedSkill(workspace) {
  const lines = [];
  const store = makeSkillStore({ stageReviews: false,
    io: { readAll: () => [], append: e => lines.push(JSON.stringify(e)) },
    clock: { now: () => Date.now() }, guard: skillGuard, digest: digestOf,
    packageStore: skillPackages.makePackageStore({ fs, pathMod: path, root: path.join(workspace, 'skill-packages') })
  });
  store.write({ agentId: AGENT, name: SKILL_NAME, summary: 'Read the supplied photo and notes faithfully.',
    body: 'Read the supplied source material. Describe the visible image and keep its notes distinct from the instruction.', createdBy: 'user' });
  fs.writeFileSync(path.join(workspace, 'skills.jsonl'), lines.join('\n') + '\n');
  return store.list(AGENT).find(s => s.name === SKILL_NAME).id;
}

function startMock() {
  const state = { mode: 'plain', calls: [], sawCapture: false };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: ['test/model', 'test/aux'].map(id => ({ id, context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        state.calls.push(body);
        const request = JSON.parse(body);
        const isMain = body.indexOf('[RUNTIME]') >= 0;     // only a task run carries the full agent system prompt
        const capture = body.indexOf('BEGIN EXTERNAL SCREEN CAPTURE') >= 0;
        if (isMain && capture) state.sawCapture = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (isMain && state.mode === 'save' && !(request.messages || []).some(m => m.role === 'tool' && m.tool_call_id === 'brief_1')) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'brief_1', type: 'function', function: { name: 'brief_proceed', arguments: JSON.stringify({ objective: 'Save the requested API key and review the implementation plan', deliverable: 'A saved key and a short review', assumptions: ['Use the service named by the Commander'] }) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        } else if (isMain && state.mode === 'save' && !(request.messages || []).some(m => m.role === 'tool' && m.tool_call_id === 'save_1')) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'save_1', type: 'function', function: { name: 'keys_save', arguments: JSON.stringify({ service: 'Capture Proof' }) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        } else if (isMain && state.mode === 'shot' && !capture) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fs.read', arguments: JSON.stringify({ path: 'pic.png' }) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: isMain ? 'It is a single dark pixel; the notes are read.' : 'NONE' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

const parse = text => String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const sleep = ms => new Promise(res => setTimeout(res, ms));
async function poll(fn, tries) { for (let i = 0; i < (tries || 40); i++) { const v = await fn(); if (v) return v; await sleep(100); } return null; }

(async () => {
  const mock = await startMock();
  const fx = SidecarFixture.create({ prefix: 'sk-dircapture-', env: {
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_QUEST_REFRESH: '0', SKYNET_AUX_BUDGET: '0', SKYNET_AUX_MODEL: 'test/aux',
    SKYNET_SCOUT: '0', SKYNET_THREAD_MINE: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_EDGE_TTS: '0', SKYNET_CRON_ENABLED: '0'
  } });
  const skillId = seedSkill(fx.workspace);
  await fx.start();
  const diskRows = stream => {
    const root = path.join(fx.workspace, 'transcript-history-v2');
    const out = [];
    if (!fs.existsSync(root)) return out;
    for (const f of fs.readdirSync(root).filter(n => /^segment-\d{6}\.jsonl$/.test(n)).sort()) for (const line of fs.readFileSync(path.join(root, f), 'utf8').split('\n')) {
      if (!line.trim()) continue; try { const r = JSON.parse(line); if (r && (!stream || r.streamId === stream)) out.push(r); } catch (_) {}
    }
    return out;
  };
  const briefs = () => {
    try { const raw = JSON.parse(fs.readFileSync(path.join(fx.workspace, 'task-briefs.json'), 'utf8')); const v = raw && (raw['task-briefs'] || raw.value || raw); return (v && Array.isArray(v.briefs)) ? v.briefs : []; } catch (_) { return []; }
  };
  const packets = () => {
    try { const raw = JSON.parse(fs.readFileSync(path.join(fx.workspace, 'verdict.packets.json'), 'utf8')); const v = raw && (raw.rows ? raw : (raw.value || raw)); return Array.isArray(v.rows) ? v.rows : []; } catch (_) { return []; }
  };
  const runRow = async runId => poll(async () => (((await fx.json('GET', '/api/runs?agent=' + AGENT + '&runId=' + runId + '&limit=50')).body || {}).runs || []).find(x => x.runId === runId) || null);
  const goldens = () => {
    const raw = JSON.parse(fs.readFileSync(path.join(fx.workspace, 'skill-goldens.json'), 'utf8'));
    return Object.values(raw).flat().filter(r => r && r.runId);
  };
  const studyCalls = () => mock.state.calls.map(b => JSON.parse(b)).filter(b => (b.messages || []).some(m => m.role === 'system' && String(m.content).startsWith('You update a durable profile')));
  const studyDirective = b => { const prompt = String(((b.messages || []).find(m => m.role === 'user') || {}).content || ''); return (prompt.match(/THE DIRECTIVE:\n([\s\S]*?)\n\nTHE WORK:/) || [])[1]; };
  const withOlder = latest => [{ role: 'user', content: OLDER }, { role: 'assistant', content: 'That earlier exchange is finished.' }, latest];
  const tagCount = tag => { let n = 0; const re = /\[failopen\] ([^\s]+) \(x(\d+)\)/g; let m; while ((m = re.exec(fx.output()))) if (m[1] === tag) n = Math.max(n, Number(m[2])); return n; };
  async function run(body, mode) {
    mock.state.mode = mode || 'plain';
    const before = mock.state.calls.length;
    // the page names a turn with its time pair (TurnMerge.sendIds), so the station can prove a fresh turn absent
    if (body.turnId && body.turnAt === undefined) { const t = Date.now(); body = Object.assign({ turnAt: t, clientNow: t }, body); }
    const r = await fx.json('POST', '/api/run', Object.assign({ key: 'sk-or-v1-dircapture-fake', model: 'test/model', agentId: AGENT,
      placed: [{ objectType: 'cabinet' }, { objectType: 'dish' }, { objectType: 'notebook' }], preloadSkills: body.isTask ? [SKILL_NAME] : [] }, body));
    const events = parse(r.text);
    const start = (events.find(e => e.name === 'agent.run.start' && e.payload && !e.payload.parentRunId) || {}).payload || {};
    const end = (events.filter(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === start.runId).pop() || {}).payload || {};
    if (end.reason === 'error') throw new Error('fixture run failed before its proof: ' + JSON.stringify(events.filter(e => e.name === 'agent.run.error')) + '\nsidecar: ' + fx.output().slice(-2400));
    return { status: r.status, events, start, end, runId: start.runId || '', calls: mock.state.calls.slice(before) };
  }
  try {
    await fx.json('POST', '/api/memory/config', { reflectEnabled: false, failureReviewEnabled: false });   // keep the study path; no unrelated reflection calls
    const ws = path.join(fx.workspace, AGENT);
    fs.mkdirSync(path.join(ws, '.attachments'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'pic.png'), PNG);
    fs.writeFileSync(path.join(ws, PHOTO.path), PNG);
    fs.writeFileSync(path.join(ws, NOTE.path), NOTES, 'utf8');

    // ---------------- 1. PROOF: a captionless photo + notes.txt ----------------
    const S1 = 'cap-proof', T1 = mint();
    const r1 = await run({ isTask: true, streamId: S1, turnId: T1, messages: withOlder({ role: 'user', content: '', attachments: [PHOTO, NOTE] }) }, 'shot');
    A.eq(r1.status, 200, 'fixture: the run stream opens');
    A.ok(r1.runId, 'fixture: the run started');
    const tool = r1.events.find(e => e.name === 'agent.tool_result');
    A.ok(tool && !(tool.payload && tool.payload.isError), 'fixture: the fs.read of the PNG ran');
    A.ok(mock.state.sawCapture, 'fixture: the PNG\'s pixels reached the model as the loop\'s screen-capture user turn');
    A.ok(r1.calls.some(b => b.indexOf('NOTES-BYTES-SENTINEL') >= 0), 'fixture: the model read notes.txt (the expansion is unchanged)');
    A.eq(r1.end.reason, 'done', 'fixture: the run finished');
    const row1 = await runRow(r1.runId);
    A.eq(row1 && row1.title, LABEL, 'PROOF e7dcb889: a captionless attachment turn is titled by its label (the base: the expanded text with the file\'s bytes)');
    A.ok(row1 && !/SCREEN CAPTURE|NOTES-BYTES-SENTINEL/.test(row1.title || ''), 'the title holds neither the capture marker nor the file\'s bytes: ' + JSON.stringify(row1 && row1.title));
    A.eq([row1 && row1.wordless, row1 && row1.taintedBy], [true, 'user attachment'], 'the run record says its directive carried no words (the "worked recently" projection leaves such a run out), and the run still holds the attachment it sent');
    const rows1 = diskRows(S1).filter(x => x.sourceRunId === r1.runId);
    const dir1 = rows1.filter(x => x.role === 'user' && x.directive === true);
    A.eq(dir1.length, 1, 'one directive row');
    const d1 = dir1[0] || {};
    // (attachment rows, S3) the directive row holds the label of a captionless turn, never the expanded text whose file bytes are a third
    // party's. The files ride as attachment rows beside it; the model's own copy of the turn is unchanged (checked above). The label is built
    // from the files' NAMES, a third party's text, so with no typed words it is not the Commander's words and is never written clean (repair:
    // a clean owner row feeds RECENT ACTIVITY, interests and briefs): it carries the attachment stamp.
    A.ok(!/NOTES-BYTES-SENTINEL|SCREEN CAPTURE/.test(String(d1.content || '')), 'the directive row\'s content holds neither the file\'s bytes nor the capture marker');
    A.eq([d1.content, d1.typed, d1.turnId, d1.kind, (d1.attachments || []).map(a => a.id), d1.taint, d1.taintKnown], [LABEL, undefined, T1, 'turn', [PHOTO.id, NOTE.id], 'user attachment', true], 'the directive row is the label (typed equals content, so it is not stored twice), its turn, kind turn, the attachment refs, and the attachment stamp (no typed words: not the Commander\'s words, never a clean owner row)');
    const files1 = rows1.filter(x => x.kind === 'attachment');
    const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
    A.eq(files1.map(x => [x.role, x.turnId, x.taint, x.content, x.attachment && x.attachment.id, x.attachment && x.attachment.size, x.attachment && x.attachment.sha256]),
      [['system', T1, 'user attachment', '[attached: photo.png]', PHOTO.id, PNG.length, sha(PNG)], ['system', T1, 'user attachment', '[attached: notes.txt]', NOTE.id, Buffer.byteLength(NOTES), sha(Buffer.from(NOTES))]],
      'each file is an attachment row of the turn, stamped with the attachment source, with the size and sha256 of the bytes the run read');
    A.ok(rows1.every(x => x.role === 'assistant' || x.kind === 'attachment' || JSON.stringify(x).indexOf('NOTES-BYTES-SENTINEL') < 0), 'and no stored user or system row holds the file\'s bytes');
    A.ok(!JSON.stringify(d1.attachments || []).includes(NOTES) && (d1.attachments || []).every(a => a.path.indexOf('.attachments/') === 0), 'attachment refs only, never bytes');
    A.eq(r1.start.directiveRowId, d1.rowId, 'run.start names that directive row');
    const shot = rows1.find(x => x.role === 'user' && /^\[BEGIN EXTERNAL SCREEN CAPTURE/.test(String(x.content || '')));
    A.ok(!!shot, 'fixture: the capture turn reached the transcript');
    A.eq([shot && shot.kind, shot && shot.directive, shot && shot.turnId], ['capture', undefined, T1], 'the loop\'s capture turn is filed as kind capture (station speech), never as a directive');
    A.ok(rows1.filter(x => x.role === 'assistant').length >= 1 && rows1.filter(x => x.role === 'assistant').every(x => x.kind === 'turn' && x.turnId === T1), 'the run\'s assistant rows are kind turn, under the turn');
    const brief1 = await poll(async () => { const b = briefs().find(x => x.originalRunId === r1.runId); return b && b.directiveRowId ? b : null; });
    A.ok(!!briefs().find(x => x.originalRunId === r1.runId), 'fixture: the task run opened a task brief');
    A.eq([brief1 && brief1.originalDirective, brief1 && brief1.directiveRowId], [LABEL, d1.rowId], 'the task brief reads the same label and names the directive row');
    const pkt1 = await poll(async () => { const p = packets().find(x => x.runId === r1.runId); return p && p.packet && p.packet.directive ? p : null; }, 60);
    A.eq(pkt1 && pkt1.packet.directive, { rowId: d1.rowId, text: LABEL }, 'the persisted verdict packet carries the directive { rowId, text } (what a rating after a restart reads)');
    A.eq(pkt1 && pkt1.packet.streamId, S1, 'and its stream');
    A.ok(pkt1 && pkt1.packet.loadedSkills.some(s => s.id === skillId), 'fixture: the run actually loaded the seeded skill');
    // The attachment/capture taints this run, so the learning gate deliberately withholds study. Prior ordinary
    // text does not override that gate or become this run's directive. The eligible saved-key legs below observe
    // the actual study request, while this leg proves the captionless wording through the real packet/golden.
    A.eq(studyCalls().length, 0, 'the tainted attachment/capture run launches no study, even with prior ordinary text');
    const rated = await fx.json('POST', '/api/growth/ratings', { runId: r1.runId, verdict: 'great', epoch: 1 });
    A.ok(rated.body && rated.body.ok && rated.body.feedbackMemory && rated.body.feedbackMemory.stored === true, 'fixture: the rating stored a feedback memory: ' + JSON.stringify(rated.body).slice(0, 300));
    A.eq(rated.body && rated.body.goldensMinted, 1, 'the immediate great rating mints the real loaded skill golden');
    A.eq((goldens().find(g => g.runId === r1.runId) || {}).directive, LABEL, 'the golden reads exactly the latest captionless label, never the earlier directive');
    const fbs = (((await fx.json('GET', '/api/memory/records?agent=' + AGENT)).body || {}).records || []).filter(x => x.origin === 'feedback');
    A.eq(fbs.length, 1, 'fixture: one feedback memory (the only rating)');
    const fbText = String((fbs[0] && (fbs[0].body || fbs[0].content)) || '');
    A.ok(fbText.indexOf('LIKED the result of: ' + LABEL) >= 0, 'the feedback citation (FeedbackMemory.directiveFor) is the same label: ' + JSON.stringify(fbText.slice(0, 200)));
    A.ok(!/SCREEN CAPTURE|NOTES-BYTES-SENTINEL/.test(fbText), 'and holds neither the capture marker nor the file\'s bytes');

    // ---------------- 2. control: a captioned photo is titled by its caption ----------------
    const S2 = 'cap-caption';
    const r2 = await run({ isTask: true, streamId: S2, turnId: mint(), messages: [{ role: 'user', content: CAPTION, attachments: [PHOTO] }] });
    A.eq(r2.end.reason, 'done', 'fixture: the captioned run finished');
    A.eq(((await runRow(r2.runId)) || {}).title, CAPTION, 'control: a captioned photo is titled by its caption');
    A.eq(((await runRow(r2.runId)) || {}).wordless, undefined, 'control: a captioned photo\'s run is not wordless');
    const d2 = diskRows(S2).find(x => x.sourceRunId === r2.runId && x.directive === true) || {};
    A.eq([d2.content, d2.typed, (d2.attachments || []).map(a => a.id)], [CAPTION, undefined, [PHOTO.id]], 'control: its directive row is the caption (typed equals content, so it is not stored twice)');

    // ---------------- 3. null capture (controls) ----------------
    const noted = () => (fx.output().match(/TypeError/g) || []).length;
    const typeErrorsBefore = noted();
    const n1 = await run({ internal: true, system: 'reply OK', messages: [] });
    A.eq([n1.status, n1.end.reason], [200, 'done'], 'n1: an internal system-only run with messages: [] ends done');
    A.eq(n1.calls.filter(b => b.indexOf('reply OK') >= 0).length, 1, 'n1: it reaches the provider exactly once');
    A.eq(diskRows().filter(x => x.sourceRunId === n1.runId && x.role === 'user').length, 0, 'n1: no directive row');
    A.ok(!briefs().some(x => x.originalRunId === n1.runId), 'n1: no task brief');
    A.eq(((await runRow(n1.runId)) || {}).title, '', 'n1: the base\'s run title (no user words: empty)');
    const S4 = 'cap-null-assistant';
    const n2 = await run({ isTask: true, streamId: S4, messages: [{ role: 'assistant', content: 'hello' }] });
    A.eq([n2.status, n2.end.reason], [200, 'done'], 'n2: an assistant-only run ends done');
    A.eq(n2.calls.filter(b => b.indexOf('[RUNTIME]') >= 0).length, 1, 'n2: it reaches the provider exactly once');
    A.eq(diskRows(S4).filter(x => x.role === 'user').length, 0, 'n2: no directive row');
    A.ok(!briefs().some(x => x.originalRunId === n2.runId), 'n2: no task brief (the gate reads the null capture\'s empty wording)');
    A.eq(((await runRow(n2.runId)) || {}).title, '', 'n2: the base\'s run title (empty)');
    A.eq(noted() - typeErrorsBefore, 0, 'n1, n2: no TypeError anywhere (every reader is null-safe)');

    // ---------------- 4. n3: a captionless photo, then a retry of that turn ----------------
    const S5 = 'cap-retry', T5 = mint(), t5 = Date.now();
    const photoTurn = [{ role: 'user', content: '', attachments: [PHOTO] }];
    const r5 = await run({ isTask: true, streamId: S5, turnId: T5, turnAt: t5, clientNow: t5, messages: photoTurn });
    A.eq(r5.end.reason, 'done', 'fixture: the captionless run finished');
    const d5 = diskRows(S5).filter(x => x.directive === true);
    A.eq(d5.length, 1, 'n3: a captionless photo writes its directive row (the base wrote none: its expanded text is empty)');
    A.eq([d5[0] && (d5[0].typed != null ? d5[0].typed : d5[0].content), d5[0] && (d5[0].attachments || []).map(a => a.id)], ['[image: photo.png]', [PHOTO.id]], 'n3: typed ?? content is its label (captured, not null), with its ref');
    const conflictsBefore = tagCount('turn.reuse.conflict.input');
    const r5b = await run({ isTask: true, streamId: S5, turnId: T5, retryOf: T5, turnAt: t5, clientNow: Date.now(), turnRowId: d5[0] && d5[0].rowId, retryUserRunId: r5.runId, messages: photoTurn });
    A.eq(r5b.end.reason, 'done', 'fixture: the retry finished');
    A.eq(r5b.start.turnId, T5, 'n3: the retry keeps its turnId (no input conflict)');
    A.eq(diskRows(S5).filter(x => x.directive === true).length, 1, 'n3: the retry reuses the directive (one directive row)');
    A.eq(r5b.start.directiveRowId, d5[0] && d5[0].rowId, 'n3: the retry\'s run.start names the reused row');
    A.eq(tagCount('turn.reuse.conflict.input') - conflictsBefore, 0, 'n3: no input conflict counted');

    // ---------------- 5. safe packet text ----------------
    const S6 = 'cap-safe', T6 = mint();
    const r6 = await run({ isTask: true, streamId: S6, turnId: T6, messages: [{ role: 'user', content: 'review the notes, my token is ' + TOKEN, attachments: [NOTE] }] });
    A.eq(r6.end.reason, 'done', 'fixture: the token run finished');
    const d6 = diskRows(S6).find(x => x.sourceRunId === r6.runId && x.directive === true) || {};
    // the clean directive's content IS the typed words (redacted); typed is stored only when it differs from the content
    const words6 = d6.typed != null ? d6.typed : d6.content;
    A.ok(typeof words6 === 'string' && words6.indexOf('[redacted-key]') >= 0 && words6.indexOf(TOKEN) < 0 && words6.indexOf('NOTES-BYTES-SENTINEL') < 0, 'fixture: the directive row\'s words are redacted and hold no file bytes: ' + JSON.stringify(words6));
    const pkt6 = await poll(async () => { const p = packets().find(x => x.runId === r6.runId); return p && p.packet && p.packet.directive ? p : null; }, 60);
    A.eq(pkt6 && pkt6.packet.directive.text, words6, 'the persisted packet\'s directive is the directive row\'s stored words (the safe form)');
    A.eq(pkt6 && pkt6.packet.directive.rowId, d6.rowId, 'and names that row');
    A.ok(fs.readFileSync(path.join(fx.workspace, 'verdict.packets.json'), 'utf8').indexOf(TOKEN) < 0, 'no raw token in the persisted packets');
    A.ok(diskRows(S6).every(x => JSON.stringify(x).indexOf(TOKEN) < 0), 'no raw token in the transcript rows');

    // An unsaved vendor-shaped key may reach the live owner run (keys.save needs its hint), but study is a derived
    // prompt. The provider's held-value guard alone cannot scrub this value: it has not entered API KEYS yet.
    const unsavedText = 'Review the implementation plan with my token ' + TOKEN + '. Explain the order of the proposed changes, the evidence needed to verify each stage, and how the final review will distinguish a completed task from a temporary interruption.';
    const unsavedBefore = studyCalls().length;
    const unsaved = await run({ isTask: true, streamId: 'cap-unsaved-study', turnId: mint(), messages: [{ role: 'user', content: unsavedText }] });
    A.eq(unsaved.end.reason, 'done', 'the eligible unsaved-key run completed');
    A.ok(!(((await fx.json('GET', '/api/servicekeys')).body || {}).keys || []).some(k => k.envVar === KEY_NAME), 'the auxiliary control value is not a held service key');
    const unsavedRow = diskRows('cap-unsaved-study').find(x => x.sourceRunId === unsaved.runId && x.directive === true) || {};
    const unsavedStudy = await poll(async () => studyCalls().slice(unsavedBefore).find(b => String(studyDirective(b)).startsWith('Review the implementation plan with my token ')));
    A.ok(!!unsavedStudy, 'the real auxiliary request runs for the unsaved-key control');
    A.eq(unsavedStudy && studyDirective(unsavedStudy), unsavedRow.typed != null ? unsavedRow.typed : unsavedRow.content, 'the auxiliary directive uses the same safe wording as the canonical unsaved-key row');
    A.ok(unsavedStudy && !JSON.stringify(unsavedStudy).includes(TOKEN), 'the complete auxiliary request contains no raw unsaved key');

    // ---------------- 6. a SAVED key: immediate praise and praise after a real restart ----------------
    // Save through the real tool first. Its web capability deliberately taints that run; it cannot supply an
    // eligible study transcript. Internal brief controls report taskbrief.settled, not agent.tool_result.
    const saveStudyBefore = studyCalls().length;
    const keySave = await run({ isTask: true, streamId: 'cap-key-save', turnId: mint(), preloadSkills: [],
      messages: [{ role: 'user', content: 'Save my Capture Proof API key ' + TOKEN + ' for the later implementation review.' }] }, 'save');
    A.eq(keySave.end.reason, 'done', 'the real key-save run completed');
    A.ok(keySave.events.some(e => e.name === 'taskbrief.settled' && e.payload.runId === keySave.runId), 'the real task brief is settled before saving the key');
    const saveRequest = keySave.calls.map(b => JSON.parse(b)).find(b => JSON.stringify(b).includes('[RUNTIME]'));
    A.ok(saveRequest && (saveRequest.tools || []).some(t => t.function && t.function.name === 'keys_save'), 'the provider was offered the real keys_save wire tool');
    const keyResult = keySave.events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'save_1');
    A.ok(keyResult && keyResult.payload.ok && keyResult.payload.summary === 'saved ' + KEY_NAME,
      'the real keys.save tool saved the fake key by service name: ' + JSON.stringify(keyResult && keyResult.payload));
    const storedKeys = ((await fx.json('GET', '/api/servicekeys')).body || {}).keys || [];
    A.ok(storedKeys.some(k => k.envVar === KEY_NAME), 'the service-key store confirms the successful save');
    A.eq(((await runRow(keySave.runId)) || {}).taintedBy, 'keys.save', 'the key-save result retains its existing web-capability taint');
    A.eq(studyCalls().length, saveStudyBefore, 'the key-save run does not bypass its study eligibility veto');

    // Fresh text-only streams now reference the actually held key without replaying the tainted save. The older
    // exchange is written by a real run so its provenance is provable; no directive reader may resurrect it.
    for (const when of ['immediate', 'restart']) {
      const sid = 'cap-saved-' + when;
      const prior = await run({ isTask: true, streamId: sid, turnId: mint(), preloadSkills: [], messages: [{ role: 'user', content: OLDER }] });
      A.eq(prior.end.reason, 'done', when + ': the prior exchange has real canonical provenance');
      const history = diskRows(sid).filter(x => x.sourceRunId === prior.runId && ['user', 'assistant'].includes(x.role));
      A.eq(history.map(x => x.role), ['user', 'assistant'], when + ': replay only the actual prior exchange');
      const text = 'Review the implementation plan using my Capture Proof API key ' + TOKEN + ' for the ' + when + ' proof. Explain the order of changes and the evidence needed to verify each stage, then describe how the final review establishes that the task is complete.';
      const studyBefore = studyCalls().length;
      const saved = await run({ isTask: true, streamId: sid, turnId: mint(), messages: history.concat({ role: 'user', content: text }) });
      A.eq(saved.end.reason, 'done', when + ': the eligible known-key run completed');
      const completed = await runRow(saved.runId);
      A.ok(completed && !completed.taintedBy, when + ': the completed known-key run has no taint latch');
      const directive = diskRows(sid).find(x => x.sourceRunId === saved.runId && x.directive === true) || {};
      const canonical = directive.typed != null ? directive.typed : directive.content;
      A.ok(typeof canonical === 'string' && canonical.includes('[' + KEY_NAME + ' saved in API KEYS]') && !canonical.includes(TOKEN), when + ': canonical typed wording names the saved key');
      const packet = await poll(async () => { const p = packets().find(x => x.runId === saved.runId); return p && p.packet && p.packet.directive ? p.packet : null; });
      A.eq(packet && packet.directive, { rowId: directive.rowId, text: canonical }, when + ': the persisted packet agrees with the canonical directive');
      A.ok(packet && packet.loadedSkills.some(s => s.id === skillId), when + ': the packet names the actually loaded skill');
      const study = await poll(async () => studyCalls().slice(studyBefore).find(b => String(studyDirective(b)).includes('for the ' + when + ' proof.')));
      A.ok(!!study, when + ': the real auxiliary study request was observed');
      A.eq(study && studyDirective(study), canonical, when + ': the study directive agrees with the saved-key canonical wording');
      A.ok(study && !String(studyDirective(study)).includes(OLDER), when + ': the study directive never resurrects prior ordinary text');
      A.ok(study && !JSON.stringify(study).includes(TOKEN), when + ': the complete auxiliary request contains no raw saved key');
      if (when === 'restart') {
        await fx.restart();
        const restored = packets().find(x => x.runId === saved.runId);
        A.eq(restored && restored.packet && restored.packet.directive, { rowId: directive.rowId, text: canonical }, 'restart: the packet directive survived the sidecar restart');
      }
      const praise = await fx.json('POST', '/api/growth/ratings', { runId: saved.runId, verdict: 'great', epoch: 1 });
      A.eq(praise.body && praise.body.goldensMinted, 1, when + ': great freezes the actually loaded skill');
      A.eq((goldens().find(g => g.runId === saved.runId) || {}).directive, canonical, when + ': the golden carries canonical safe wording');
      A.ok(!/OLDER-DIRECTIVE|SCREEN CAPTURE|NOTES-BYTES/.test((goldens().find(g => g.runId === saved.runId) || {}).directive || ''), when + ': the golden never substitutes older or expanded words');
      for (const name of ['skill-goldens.json', 'verdict.packets.json', 'task-briefs.json']) {
        A.ok(!fs.readFileSync(path.join(fx.workspace, name), 'utf8').includes(TOKEN), when + ': no raw saved key in ' + name);
      }
    }
  } finally {
    await fx.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('directive-capture.e2e');
})().catch(e => { console.log('FAIL: directive-capture.e2e threw — ' + (e && e.stack || e)); process.exit(1); });
