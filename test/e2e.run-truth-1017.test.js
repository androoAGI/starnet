/* node test/e2e.run-truth-1017.test.js — real-sidecar proof for three user reports against v0.13.5 (2026-10-17).

   1. releases#6 — A WIDGET REFRESH CAN PUBLISH ITS WIDGET. "Create & fetch" sends the refresh to the agent open in COMMS,
      on the widget's own conversation ('widget-<id>'), and tells it to publish with widget.set. widget.set rode only the
      NOTEBOOK prop + MEMORY switch, so a run without a placed notebook never held it: the agent searched for the tool for
      22 turns until stopped and the widget stayed empty. The run on a configured widget's own conversation now holds
      widget.get + widget.set, for that widget id only (another id is refused); a run on any other conversation still
      holds neither.

   2. releases#7 (+ #9) — WHICH RUNS PROPOSE MEMORIES. A Deny does not end a run: the agent carries on and the run ends
      done, so it reached reflection like finished work and the reflector turned the refusal into a standing belief
      queued under MEMORY > Awaiting your decision. A run whose approval was not given now proposes nothing (an
      approved twin still does). A FAILED run keeps the failure review it was built for, and its proposals carry the
      'failure-review' origin the card draws as "⚠ failed run". A stopped run proposes nothing.

   Boots the actual sidecar (hermetic fixture) on a scripted local model. ASK mode, no props placed (the interactive
   office is compute-only), exactly the station the report describes. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords, firstUserWords } = require('./helpers/host-notes.js');

const HOST = '127.0.0.1';

function startMockProvider() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        const messages = parsed.messages || [];
        const toolNames = (parsed.tools || []).map(t => t && t.function && t.function.name);
        const lastUser = messages.map(m => m.role).lastIndexOf('user');
        const user = String(userWords(messages[lastUser] || {}) || '');
        const used = messages.slice(lastUser + 1).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        const lastTool = String((messages.slice(lastUser + 1).filter(m => m.role === 'tool').pop() || {}).content || '');
        const sys = String((messages[0] && messages[0].role === 'system' && messages[0].content) || '');
        const prompt = messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
        requests.push({ user, toolNames, lastTool, aux: !parsed.tools || !parsed.tools.length });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const call = (name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: name + '_' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
        };
        const say = text => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
        };
        const widgetId = (/using id="([a-z0-9-]+)"/.exec(user) || [])[1] || '';
        if (!parsed.tools || !parsed.tools.length) {
          // the post-run passes: failure review asks for LESSON lines, reflection for FACT/PREFERENCE lines
          if (/FAILED/.test(sys)) say('LESSON: Always confirm where the weekly report data lives before drafting the report.');
          else if (/reflecting/.test(sys) && /REPORTFILE/.test(prompt)) say('PREFERENCE: The Commander never wants weekly reports longer than one page.');
          else say('NONE');
          res.write('data: [DONE]\n\n'); res.end(); return;
        }
        // a slow model turn the Commander stops with ■ before it answers (the station drops this stream on the stop)
        if (/STOPME/.test(user) && used.indexOf('brief_proceed') >= 0) { setTimeout(() => { if (res.destroyed || res.writableEnded) return; say('late'); res.write('data: [DONE]\n\n'); res.end(); }, 4000); return; }
        if (toolNames.indexOf('brief_proceed') >= 0 && used.indexOf('brief_proceed') < 0) call('brief_proceed', { objective: 'Do the task', deliverable: 'the requested result' });
        else if (/^Refresh my saved widget/.test(user)) {
          if (toolNames.indexOf('widget_set') < 0) say('NO_WIDGET_TOOL');
          else if (used.indexOf('widget_get') < 0) call('widget_get', { id: widgetId });
          else if (used.indexOf('widget_set') < 0) call('widget_set', { id: widgetId, version: 1, value: '$12.34', sub: 'this month' });
          // then reaches for ANOTHER configured widget: the widget's own run may publish only its own id
          else if (used.filter(n => n === 'widget_set').length === 1) call('widget_set', { id: 'w-other1017', version: 1, value: '$99' });
          else say('Published the AI spend widget.');
        } else if (/REPORTFILE/.test(user)) {
          if (used.indexOf('fs_write') < 0) call('fs_write', { path: 'report.md', content: '# Weekly report\n' });
          else say(/said no/.test(lastTool) ? 'You declined writing report.md, so it was not created.' : 'Wrote report.md.');
        } else if (/FAILME/.test(firstUserWords(messages))) {
          // announces forever -> the run fails (incomplete_work). Matched on the run's OPENING words: the loop's announce
          // nudge is a fenced host message that rides user-side on this chat wire (provider.js projectRoles), so after
          // the first nudge the newest user turn is the host's, never the Commander's FAILME
          say('Let me write the weekly report now.');
        } else say('ok');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// POST /api/run and read its NDJSON to the end; onEvent may answer prompts
async function runTo(B, H, body, onEvent) {
  const res = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify(Object.assign({ key: 'sk-or-v1-local-proof', model: 'test/model', agentId: 'agent', isTask: true, placed: [] }, body)) });
  A.eq(res.status, 200, 'POST /api/run streams');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '', runId = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.name === 'agent.run.start' && ev.payload && !runId) runId = ev.payload.runId;
      events.push(ev);
      if (onEvent) await onEvent(ev, runId);
    }
  }
  const end = events.find(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === runId);
  return { runId, events, reason: end && end.payload.reason };
}

(async () => {
  const mock = await startMockProvider();
  const fixture = SidecarFixture.create({ prefix: 'sk-run-truth-', env: {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', STARNET_OPENROUTER_KEY: 'sk-or-v1-local-proof',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
  } });
  try {
    await fixture.start();
    const B = fixture.baseUrl, token = fixture.token;
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const roster = await fetch(B + '/api/roster', { method: 'POST', headers: H, body: JSON.stringify({ agents: [{ agentId: 'agent', system: 'LEAD', name: 'NOVA', model: 'test/model' }] }) });
    A.eq(roster.status, 200, 'the agent is on the roster');

    /* ---------- 1. releases#6: the widget's own refresh run holds widget.set and publishes ---------- */
    {
      const id = 'w-runtruth1017';
      const made = await (await fetch(B + '/api/widgets/configure', { method: 'POST', headers: H, body: JSON.stringify({
        id, label: 'AI spend', request: 'total spend this month from the ledger', display: 'metric', source: { kind: 'agent', id: 'starnet' } }) })).json();
      A.ok(made.widget && made.widget.config && made.widget.config.version === 1, 'Connected apps > StarNet > Create: the widget is configured (version 1)');
      const second = await fetch(B + '/api/widgets/configure', { method: 'POST', headers: H, body: JSON.stringify({
        id: 'w-other1017', label: 'Other', request: 'something else', display: 'metric', source: { kind: 'agent', id: 'starnet' } }) });
      A.eq(second.status, 200, 'a second configured widget exists (the one this refresh must not touch)');
      const ask = await (await fetch(B + '/api/widgets/request', { method: 'POST', headers: H, body: JSON.stringify({ id }) })).json();
      A.ok(/Publish the result with widget\.set/.test(ask.prompt || ''), 'the refresh instruction tells the agent to publish with widget.set');

      // the same instruction on an ordinary conversation: no notebook placed, so the tool is still not granted there
      const plain = await runTo(B, H, { streamId: 'ws_plain', messages: [{ role: 'user', content: ask.prompt }] });
      const plainReq = mock.requests.filter(r => !r.aux && /^Refresh my saved widget/.test(r.user));
      A.ok(plainReq.length > 0 && plainReq.every(r => r.toolNames.indexOf('widget_set') < 0), 'an ordinary conversation without a notebook still holds no widget.set (the grant is scoped)');
      A.eq(plain.reason, 'done', 'that run ends on its own');
      mock.requests.length = 0;

      // the widget's own conversation (frontend/app/widgets.js openWidgetTask: 'widget-' + id)
      const own = await runTo(B, H, { streamId: 'widget-' + id, messages: [{ role: 'user', content: ask.prompt }] });
      const ownReq = mock.requests.filter(r => !r.aux && /^Refresh my saved widget/.test(r.user));
      A.ok(ownReq.length > 0 && ownReq.every(r => r.toolNames.indexOf('widget_set') >= 0 && r.toolNames.indexOf('widget_get') >= 0), 'the refresh run on the widget\'s conversation advertises widget.get + widget.set');
      A.ok(!ownReq.some(r => r.toolNames.indexOf('notebook_write') >= 0), 'and only those two: no other notebook tool rides along');
      const results = own.events.filter(e => e.name === 'agent.tool_result').map(e => e.payload);
      A.ok(results.length === 3 && !results[0].isError && !results[1].isError, 'widget.get and widget.set both ran: ' + JSON.stringify(results.map(p => p.summary)));
      A.ok(results[2] && results[2].isError === true, 'a widget.set naming ANOTHER widget from this run is refused');
      const told = ownReq.map(r => r.lastTool).filter(t => /cannot read or publish widget/.test(t)).pop() || '';
      A.ok(/This run updates widget "w-runtruth1017" only; it cannot read or publish widget "w-other1017"./.test(told), 'with a short clear error the agent reads: ' + told.slice(0, 140));
      A.eq(own.reason, 'done', 'the refresh run ends done (no tool hunt)');
      const list = await (await fetch(B + '/api/widgets', { headers: H })).json();
      const w = (list.widgets || []).find(x => x.id === id);
      A.ok(w && w.value === '$12.34' && w.sub === 'this month', 'the widget shows the published reading');
      A.eq(w && w.agentId, 'agent', 'attributed to the agent that actually published it');
      A.eq(w && w.runId, own.runId, 'and to the refresh run');
      const other = (list.widgets || []).find(x => x.id === 'w-other1017');
      A.ok(other && other.value === null && !other.updatedAt, 'the other widget was not touched');
    }

    /* ---------- 2. releases#7 (+ #9): which runs put proposals in MEMORY > Awaiting your decision ---------- */
    {
      const pendingOf = async runId => (((await (await fetch(B + '/api/memory/pending?agent=agent', { headers: H })).json()).pending) || []).filter(p => p.runId === runId);
      const answer = decision => async (ev, runId) => {
        if (ev.name === 'permission.prompt' && ev.payload) await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId, promptId: ev.payload.promptId, decision }) });
      };
      // the Commander presses Deny: the agent carries on without the write and the run ends done (issue #9 reported "failed")
      const denied = await runTo(B, H, { streamId: 'ws_deny', placed: ['cabinet'], messages: [{ role: 'user', content: 'REPORTFILE: write report.md with this week\'s summary.' }] }, answer('deny'));
      const deniedWrite = denied.events.find(e => e.name === 'agent.tool_result' && e.payload && e.payload.summary === 'denied');
      A.ok(!!deniedWrite && deniedWrite.payload.isError === true, 'the Deny reaches the agent as the broker\'s "denied" result (nothing was written)');
      A.eq(denied.reason, 'done', 'a Deny never ends the run as an error: the agent carries on and the run ends done');
      // the same work, approved: reflection does propose from it (the control that makes the next check mean something)
      const approved = await runTo(B, H, { streamId: 'ws_approve', placed: ['cabinet'], messages: [{ role: 'user', content: 'REPORTFILE: write report.md with this week\'s summary.' }] }, answer('once'));
      A.eq(approved.reason, 'done', 'the approved run ends done');
      let approvedPending = [];
      for (let i = 0; i < 100 && !approvedPending.length; i++) { await new Promise(r => setTimeout(r, 100)); approvedPending = await pendingOf(approved.runId); }
      A.ok(approvedPending.length === 1 && /never wants weekly reports/.test(approvedPending[0].content), 'control: reflection on an approved run proposes its belief for a decision');
      A.eq((await pendingOf(denied.runId)).length, 0, 'a run whose approval was denied proposes NO memories (it once proposed "never wants …" from the Deny)');

      // a run that FAILS keeps the failure review it was designed for, and every proposal it raises is marked as such
      const failed = await runTo(B, H, { streamId: 'ws_fail', messages: [{ role: 'user', content: 'FAILME: write the weekly report.' }] });
      A.eq(failed.reason, 'error', 'the failing run ends error');
      let failedPending = [];
      for (let i = 0; i < 100 && !failedPending.length; i++) { await new Promise(r => setTimeout(r, 100)); failedPending = await pendingOf(failed.runId); }
      A.ok(failedPending.length > 0 && failedPending.every(p => p.origin === 'failure-review'), 'a failed run\'s proposals are failure-review lessons, carrying the origin MEMORY marks "⚠ failed run": ' + JSON.stringify(failedPending.map(p => p.origin)));
      A.ok(/'failure-review': '⚠ failed run'/.test(require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/stationui.js'), 'utf8')), 'and the Awaiting-your-decision card draws that origin as "⚠ failed run"');

      // the Commander stops a run with ■ before the model answers: it proposes nothing
      const stopped = await runTo(B, H, { streamId: 'ws_stop', messages: [{ role: 'user', content: 'STOPME: write the weekly report.' }] }, async (ev, runId) => {
        // ■ while the model is still thinking (its turn takes 4 s; brief_proceed is hidden, so no tool result marks the moment)
        if (ev.name === 'agent.run.start' && runId) setTimeout(() => { fetch(B + '/api/cancel', { method: 'POST', headers: H, body: JSON.stringify({ runId }) }).catch(() => {}); }, 1500);
      });
      A.eq(stopped.reason, 'cancelled', 'the stopped run ends cancelled');
      await new Promise(r => setTimeout(r, 1500));
      A.eq((await pendingOf(stopped.runId)).length, 0, 'a stopped run proposes no memories');
    }
  } catch (e) {
    e.message += '\nsidecar output (tail):\n' + fixture.output().slice(-4000);
    throw e;
  } finally {
    await fixture.dispose();
    if (mock.server.closeAllConnections) mock.server.closeAllConnections();
    await new Promise(r => mock.server.close(r));
  }
  A.report('e2e.run-truth-1017.test');
})().catch(e => { console.log('FAIL: e2e.run-truth-1017.test threw - ' + (e && e.stack || e)); process.exit(1); });
