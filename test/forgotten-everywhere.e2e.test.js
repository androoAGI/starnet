'use strict';
/* node test/forgotten-everywhere.e2e.test.js - A DELETED SESSION IS FORGOTTEN EVERYWHERE A MODEL OR A RESPONSE CAN REACH IT, WITH THE AUX PASSES ON
   (turn identity doneMeans 3; qa/bugs/3e926b6a, 31042fab, 6e750350), through a REAL hermetic sidecar and a mock provider that records every request body.

   test/session-delete-forgets.e2e.test.js proves the transcript, recall, evidence, notebook and the attachment file with the aux passes OFF. This is
   the same delete with them ON and the derived stores filled - the class the other registry proofs (forget-stores, the census) cover store by store,
   run end to end:

     ONE STATION. A session S says "quokka" everywhere: its run (typed words, an attached file with the word in its name and its text, two notebook
     memories, an aux reflection that proposes a fact), a verdict packet parked for the run, a golden minted from it, an interest learned from it, a
     dossier belief learned from it, and a declined proposal that quotes it. A session T (a) reads S through recall_conversation (so T's own run
     quotes S: its packet and golden must go too) and (b) is the control that must stay. W is the session deleted BEFORE this ledger's first read
     (adopted: transcript and titles forgotten, memory kept - I7 limit d, the "wombat" control).
     THE DELETE (the save the page sends, with and without a restart):
       every upstream body after it     holds no word of S - the main runs, the aux reflection, the study pass, whatever fires
       interests / packets / goldens    the entries sourced from S, and from T's reading run, are gone; the controls stay
       dossier                          the block learned from S is cleared, a late push naming S is refused (admitted:false), the page's complete re-push lands
       declined                         still on disk (the reject list), and from the first delete it only suppresses: a proposal equal to it is dropped,
                                        and its words are in no aux prompt (dedupOnly)
       cross-session recall             a later run of T finds T and never S; GET /api/runs lists no run of S or of T's reading run
       attachment file                  the file S attached is gone from the agent's workspace; the file another session attached stays
     THE NAMED LIMITS (I7), each a passing control: (a) adopted stamps - W's golden and dossier belief stay; (b) cron-jobs - a routine the Commander made
     is kept; (c) paraphrase - a later reply that only paraphrases S stays (no word of S, nothing to match); (d) session.list titles are metadata
     (test/forget.tool-quotes.http.test.js, "the recorded limit").
   RED at the previous commit: no source on an interest, packet, golden or dossier belief, no write gate, declined texts in the aux prompt. */
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { runContextOf, recallOf } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';
const S = 'ws_quokka', T = 'ws_keep', W = 'ws_old', K = 'ws_fresh';
const WORD = /quokka|uniqueword|Wallaby/i;
const DECLINED = 'the quokka sanctuary treasurer prefers Perth';
const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : (c == null ? '' : String(c)));
const until = async (fn, label, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 100)); } };

function startUpstream() {
  const state = { phase: 'seed', calls: [], seq: 0, reflectAnswer: 'NONE' };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
      if (!req.url.includes('/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'tool_choice'] }] }));
      }
      let body = {}; try { body = JSON.parse(raw); } catch (_) { body = {}; }
      const messages = body.messages || [];
      const auxiliary = !(body.tools || []).length && /reflect|thread|ideas|summar|study|belief/i.test(text(messages[0] && messages[0].content));
      state.calls.push({ phase: state.phase, auxiliary, body, at: Date.now() });
      let delta = {}, finish = 'stop';
      const tool = (name, args) => { delta = { tool_calls: [{ index: 0, id: 'fe_' + (++state.seq), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finish = 'tool_calls'; };
      const lastUser = messages.map(m => m.role).lastIndexOf('user');
      const done = name => messages.slice(lastUser + 1).filter(m => (m.tool_calls || []).some(t => t.function && t.function.name === name)).length;
      const offered = name => (body.tools || []).some(t => t.function && t.function.name === name);
      if (auxiliary) delta.content = /reflect/i.test(text(messages[0].content)) ? state.reflectAnswer : 'NONE';
      else if (offered('brief_proceed') && !done('brief_proceed')) tool('brief_proceed', { objective: 'Answer the Commander' });
      else if (state.phase === 'seed') {
        if (done('notebook_write') === 0) tool('notebook_write', { title: 'Quokka codeword', body: 'The quokka codeword is Wallaby-Seven' });
        else if (done('notebook_write') === 1) tool('notebook_write', { title: 'Quokka pet', body: 'The Commander keeps a pet quokka named Wallaby-Nine', scope: 'global' });
        else delta.content = 'Reply to: echo session uniqueword quokka - done. The quokka sanctuary is a long-running project that the Commander wants to keep going for many months, with a treasurer, a roster of keepers and a yearly fundraiser in the spring.';
      } else if (state.phase === 'read') {
        if (done('recall_conversation') === 0) tool('recall_conversation', { query: 'quokka', scope: 'all' });
        else delta.content = 'Found the other session: it was about the quokka sanctuary and its treasurer. I will fold that into the platypus plan for the Commander, who wants a detailed plan with milestones and owners.';
      } else if (state.phase === 'probe') {
        if (done('recall_conversation') === 0) tool('recall_conversation', { query: 'echo session', scope: 'all' });
        else delta.content = 'Here is what I found about the platypus plan, with nothing else of note, and the next milestones for the launch team to review before Friday.';
      } else delta.content = 'Platypus plan noted, with owners, milestones and a launch checklist the team can review together before Friday morning.';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}
function hermeticEnv(base) {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  // the aux passes are ON (reflection, study; no AUX_BUDGET=0 off-switch) - the point of this file
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    SKYNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'fe-fixture', SKYNET_DEFAULT_MODEL: 'test/model' });
}

(async () => {
  const up = await startUpstream();
  const fixture = SidecarFixture.create({ prefix: 'starnet-forgotten-everywhere-', timeoutMs: 40000, env: hermeticEnv(up.base) });
  const json = (method, route, body) => fixture.json(method, route, body);
  const ws = file => path.join(fixture.workspace, file);
  const readJson = file => { try { return JSON.parse(fs.readFileSync(ws(file), 'utf8')); } catch (_) { return null; } };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const runIds = {};
  async function run(phase, streamId, words, extra) {
    up.state.phase = phase;
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({
      provider: 'openrouter', model: 'test/model', agentId: 'agent', isTask: true, reflect: true, recurring: true, streamId, surface: 'interactive',
      system: 'You are NOVA.', objects: ['computer', 'notebook'], messages: [{ role: 'user', content: words }] }, extra || {})) });
    const raw = await r.text();
    A.eq(r.status, 200, phase + ': the run streams');
    const events = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const start = events.find(e => e.name === 'agent.run.start'), end = events.find(e => e.name === 'agent.run.end');
    A.eq(end && end.payload && end.payload.reason, 'done', phase + ': the run finishes (' + JSON.stringify(events.slice(-2)).slice(0, 300) + ')');
    return { runId: start && start.payload && start.payload.runId, events };
  }
  const fileStatus = async ref => (await fixture.request('/api/file?agent=agent&path=' + encodeURIComponent(ref.path), { headers: { 'X-StarNet-Token': fixture.token } })).status;
  const listedRuns = async () => ((await json('GET', '/api/runs?agent=*&limit=300')).body.runs || []);
  let revision = 0;
  const save = async extra => {
    const r = await json('POST', '/api/save', Object.assign({ agent: { id: 'agent', name: 'NOVA', createdAt: 1 }, updatedAt: Date.now(), _saveRevision: revision,
      workstreams: [{ id: T, title: 'Platypus plan', history: [] }, { id: K, title: null, history: [] }] }, extra));
    A.eq(r.status === 200 && r.body && r.body.ok, true, 'the save lands: ' + JSON.stringify(r.body));
    revision = (r.body && r.body.saveRevision) || revision + 1;
  };

  try {
    // ---- the ledger already holds W's delete from before its first read: adopted (memory kept) ----
    const now = Date.now();
    const ledger = require('../sidecar/session-tombstones.js').makeSessionTombstones({ fs, path, file: ws('session-tombstones.json'), now: () => now - 20000 });
    ledger.observe([W], [W]);
    A.eq(ledger.adopted().map(e => e.id), [W], 'setup: the ledger holds an adopted stamp for the old session');
    fs.writeFileSync(ws('runs.jsonl'), JSON.stringify({ runId: 'run_wombat_1', agentId: 'agent', streamId: W, ts: now - 30000, reason: 'done', directive: 'plan the wombat habitat' }) + '\n');

    await fixture.start();
    A.eq((await json('POST', '/api/memory/config', { reflectCooldownMs: 0, studyCooldownMs: 0 })).status, 200, 'the aux cooldowns are off (every run may reflect and study)');

    // ---- 1. S says "quokka" everywhere; T reads it; K is the plain control ----
    const upload = async (name, body) => (await json('POST', '/api/attachments', { agent: 'agent', name, dataUrl: 'data:text/plain;base64,' + Buffer.from(body).toString('base64') })).body;
    const goneFile = await upload('quokka-notes.txt', 'kept notes about the quokka'), keepFile = await upload('platypus-notes.txt', 'kept notes about the platypus');
    A.ok(goneFile && goneFile.ok && keepFile && keepFile.ok, 'both sessions\' files are uploaded into the agent\'s workspace');
    up.state.reflectAnswer = 'FACT: the quokka sanctuary opens on the first Friday of spring';
    runIds.S = (await run('seed', S, 'echo session uniqueword quokka', { messages: [{ role: 'user', content: 'echo session uniqueword quokka', attachments: [goneFile] }] })).runId;
    up.state.reflectAnswer = 'NONE';
    runIds.K = (await run('keep', K, 'Draft the platypus launch plan for Friday with owners and milestones')).runId;
    runIds.T = (await run('read', T, 'Review the plan from the other session and fold it into the platypus launch plan')).runId;
    await run('keep', T, 'Review the attached platypus notes', { messages: [{ role: 'user', content: 'Review the attached platypus notes', attachments: [keepFile] }] });
    A.ok(runIds.S && runIds.K && runIds.T, 'the three runs have ids');
    const reader = (await listedRuns()).find(r => r.runId === runIds.T);
    A.ok(reader, 'the reading run is in the run list before the delete');

    // a routine the Commander made (Q4: kept), quoting the word on purpose
    const cron = await json('POST', '/api/cron', { name: 'Quokka check', prompt: 'summarize the quokka sanctuary news', schedule: 'every 30m', agentId: 'cron_brief' });
    A.ok(cron.status === 200 && cron.body && cron.body.ok !== false, 'setup: a routine the Commander made is created: ' + JSON.stringify(cron.body).slice(0, 200));

    // the stores a run does not fill by itself here, written the way the sidecar writes them (the real modules), while it is stopped
    await fixture.stop();
    const Int = require('../sidecar/interests.js');
    let interests = Int.fresh(now);
    interests = Int.normalize({ topics: {}, trustedTopics: {
      'quokka-sanctuary': { label: 'quokka sanctuary', w: 3, n: 3, lastAt: now, ev: [{ q: 'echo session uniqueword quokka', at: now, src: { streamId: S, runId: runIds.S, rowId: 1 } }] },
      'platypus-launch': { label: 'platypus launch', w: 2, n: 2, lastAt: now, ev: [{ q: 'draft the platypus launch plan', at: now, src: { streamId: K, runId: runIds.K, rowId: 1 } }] } } }, now);
    fs.writeFileSync(ws('scout.interests.json'), JSON.stringify({ v: 1, state: interests }));
    const golden = (runId, directive) => ({ runId, mintedAt: now, directive, output: directive });
    const packetRow = (runId, streamId, words) => ({ runId, at: now, packet: { agentId: 'agent', streamId, directive: { rowId: 1, text: words }, messages: [{ role: 'user', content: words }, { role: 'assistant', content: 'done: ' + words }], reason: 'done' } });
    fs.writeFileSync(ws('verdict.packets.json'), JSON.stringify({ v: 2, rows: [packetRow(runIds.S, S, 'echo session uniqueword quokka'), packetRow(runIds.T, T, 'Review the plan from the other session'), packetRow(runIds.K, K, 'Draft the platypus launch plan')] }));
    fs.writeFileSync(ws('skill-goldens.json'), JSON.stringify({
      'agent\u0000skill_a': [golden(runIds.S, 'echo session uniqueword quokka'), golden(runIds.K, 'Draft the platypus launch plan')],
      'agent\u0000skill_b': [golden(runIds.T, 'Review the quokka plan'), golden('run_wombat_1', 'plan the wombat habitat')] }));
    await require('../sidecar/memory-store.js').makeMemoryStore({ fs, path, workspaces: fixture.workspace }).update('declined:agent', () => [DECLINED]);
    fs.writeFileSync(ws('_commander.dossier.json'), JSON.stringify({ block: 'WHAT YOU KNOW: ships the quokka tracker', setAt: now, sourceRunIds: [runIds.S], complete: true }));
    await fixture.start();

    // before the delete: the seeded stores read back, and the natural ones were written
    const goldens = async () => Object.values((await json('GET', '/api/agent-skills/goldens?agent=agent')).body.bySkill || {}).flat().map(g => g.runId);
    A.ok((await goldens()).includes(runIds.S) && (await goldens()).includes(runIds.T) && (await goldens()).includes('run_wombat_1') && (await goldens()).includes(runIds.K), 'before the delete the goldens of S, of the reading run T, of K and of the adopted session are served: ' + JSON.stringify(await goldens()));
    const packets = () => ((readJson('verdict.packets.json') || {}).rows || []);
    const packetRuns = () => packets().map(r => r.runId);
    A.ok(packetRuns().includes(runIds.S) && packetRuns().includes(runIds.T) && packetRuns().includes(runIds.K), 'before the delete the parked packets of S, of the run that read S and of the control are on disk: ' + JSON.stringify(packetRuns()));
    A.ok(readJson('scout.interests.json').state.trustedTopics['quokka-sanctuary'], 'before the delete the interest learned from S is on disk');
    A.eq(JSON.parse(fs.readFileSync(ws('_commander.dossier.json'), 'utf8')).block.includes('quokka'), true, 'before the delete the dossier block learned from S is on disk');
    A.ok((await listedRuns()).some(r => r.streamId === S), 'before the delete GET /api/runs lists S');

    // ---- 2. the Commander deletes S ----
    const callsBefore = up.state.calls.length;
    await save({ deletedIds: [W, S], forgetIds: [S] });   // W stays in deletedIds only: the ledger holds it as adopted, and a forgetIds entry that left the list would be a fresh delete when it came back
    await until(async () => !(await goldens()).includes(runIds.S) && readJson('_commander.dossier.json').block === '' && !packetRuns().includes(runIds.S), 'the purge pass ran over every store');

    async function provesForgotten(label) {
      // sources gone, controls kept
      const g = await goldens();
      A.ok(!g.includes(runIds.S) && !g.includes(runIds.T), label + ' GOLDENS: the golden of S and of the run that READ S are gone: ' + JSON.stringify(g));
      A.ok(g.includes(runIds.K) && g.includes('run_wombat_1'), label + ' GOLDENS: the control run\'s stays, and so does the one of the ADOPTED session (limit a): ' + JSON.stringify(g) + ' K=' + runIds.K);
      const topics = (readJson('scout.interests.json').state || {}).trustedTopics || {};
      A.ok(!topics['quokka-sanctuary'] && topics['platypus-launch'], label + ' INTERESTS: the topic learned from S is gone and the control topic stays: ' + Object.keys(topics));
      const rows = packets();
      A.ok(!rows.some(r => r.runId === runIds.S || r.runId === runIds.T), label + ' VERDICT PACKETS: no packet of S or of the run that read S: ' + JSON.stringify(rows.map(r => r.runId)));
      A.eq(readJson('_commander.dossier.json').block, '', label + ' DOSSIER: the block learned from S is cleared');
      const late = await json('POST', '/api/dossier', { block: 'WHAT YOU KNOW: ships the quokka tracker', sourceRunIds: [runIds.S], complete: true });
      A.eq([late.body.ok, late.body.admitted], [true, false], label + ' DOSSIER: a late push naming S is refused (admitted:false)');
      const re = await json('POST', '/api/dossier', { block: 'WHAT YOU KNOW: ships the platypus plan', sourceRunIds: [runIds.K], complete: true });
      A.eq(re.body.admitted, true, label + ' DOSSIER: the page\'s complete re-push naming only live runs lands');
      await json('POST', '/api/dossier', { block: '' });
      const runs = await listedRuns();
      A.ok(!runs.some(r => r.streamId === S || r.runId === runIds.S || r.runId === runIds.T), label + ' RUN TITLES: GET /api/runs lists no run of S, nor the run that read it');
      A.ok(runs.some(r => r.runId === runIds.K), label + ' RUN TITLES: the control run is still listed');
      A.eq((await json('GET', '/api/transcript?stream=' + S)).body.turns || [], [], label + ' HISTORY: S reads empty');
      let gone = 200;
      for (let i = 0; i < 100; i++) { gone = await fileStatus(goneFile); if (gone !== 200) break; await wait(50); }
      A.ok(gone !== 200, label + ' ATTACHMENT FILES: the file S attached is gone (' + gone + ')');
      A.eq(await fileStatus(keepFile), 200, label + ' ATTACHMENT FILES: the other session\'s file is served');
      // the named limits, each a passing control
      A.ok(((await json('GET', '/api/cron')).body.jobs || (await json('GET', '/api/cron')).body || []).length >= 1, label + ' LIMIT b: the routine the Commander made is kept');
      A.ok(fs.readFileSync(ws('agent.declined.json'), 'utf8').includes('treasurer prefers Perth'), label + ' DECLINED: the reject list is kept on disk (Q5)');
    }
    await provesForgotten('after the delete:');

    // ---- 3. what the model is handed after it: the main runs and every aux pass ----
    up.state.reflectAnswer = 'FACT: ' + DECLINED + '\nFACT: the platypus launch is on the second Friday of spring';
    const probe = await run('probe', K, 'what do you know about the kangaroo plan from before, and what is open on the platypus launch checklist');
    const after = await run('keep', K, 'continue the platypus plan with owners and milestones for the next week please, and list what is still open on the launch checklist');
    const afterBodies = () => up.state.calls.slice(callsBefore).filter(c => !c.auxiliary).map(c => c.body);
    const bodyText = b => (b.messages || []).map((m, i, all) => (i === all.map(x => x.role).lastIndexOf('user') ? (runContextOf([m]) + recallOf([m])) : text(m.content) + JSON.stringify(m.tool_calls || ''))).join('\n');
    await wait(1500);   // the aux passes run behind the reply
    const everything = up.state.calls.slice(callsBefore);
    const leaked = everything.filter(c => WORD.test(c.auxiliary ? JSON.stringify(c.body.messages) : bodyText(c.body)));
    A.eq(leaked.map(c => (c.auxiliary ? 'aux ' : 'run ') + (JSON.stringify(c.body.messages).match(/.{0,60}(quokka|uniqueword|Wallaby).{0,60}/i) || [''])[0]), [], 'no upstream body after the delete - main run or aux pass - holds a word of S');
    A.ok(afterBodies().length >= 3 && everything.some(c => c.auxiliary), 'the later runs and at least one aux pass reached the model (' + everything.length + ' calls, ' + everything.filter(c => c.auxiliary).length + ' aux)');
    const plat = afterBodies().map(bodyText).join('\n');
    A.ok(/platypus/.test(plat), 'the control session still reads: the platypus words reach the model');
    // declined: only suppresses - a reflection that proposes it is dropped, and its words were in no aux prompt
    const pending = (await json('GET', '/api/memory/pending?agent=agent')).body;
    const proposed = JSON.stringify(pending);
    A.ok(!/quokka sanctuary treasurer/.test(proposed), 'DECLINED: a reflection that proposes the declined text yields no proposal (dedupOnly suppresses it)');
    A.ok(everything.filter(c => c.auxiliary).every(c => !/treasurer prefers Perth/.test(JSON.stringify(c.body.messages))), 'DECLINED: the declined text is in no aux prompt');
    // limit c: a paraphrase that names nothing of S is not a quote
    A.ok(after.runId && probe.runId, 'the post-delete runs finished');

    // ---- 4. a restart keeps it forgotten ----
    await fixture.restart();
    await provesForgotten('after a restart:');
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('forgotten-everywhere.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
