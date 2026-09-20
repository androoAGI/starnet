'use strict';
// Drives the real HTTP/run/registry/native/image path with a deterministic local
// provider. Only a fresh fixture file/tab is edited; no user document is touched.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { bootToken } = require('../../test/_httpToken');
async function run(base) {
  const root = path.resolve(__dirname, '../../.qa_tmp/cua-production');
  fs.mkdirSync(root, { recursive: true });
  const filename = 'starnet-production-' + randomUUID().slice(0, 8) + '.txt';
  const file = path.join(root, filename);
  const initial = 'StarNet production fixture.\r\n';
  const addition = 'Saved through the real StarNet run.';
  fs.writeFileSync(file, initial, { flag: 'wx' });
  const token = await bootToken(base, base);
  const request = async (route, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { Origin: base, 'X-StarNet-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response;
  };
  let step = 0, target, providerError, imageSeen = false;
  const receipts = [];
  const provider = http.createServer(async (req, res) => {
    if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture-model', supported_parameters: ['tools'], context_length: 128000 }] })); }
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (!body.tools?.length) {
      res.setHeader('Content-Type', 'text/event-stream');
      return res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'No auxiliary changes.' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    }
    imageSeen ||= (body.messages || []).some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
    res.setHeader('Content-Type', 'text/event-stream');
    const send = delta => res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    try {
      assert.ok(body.tools.some(t => t.function.name === 'computer_use'), 'registered computer tool projected to model');
      const lastTool = body.messages.filter(m => m.role === 'tool').pop();
      let state;
      if (step > 0) {
        const content = typeof lastTool?.content === 'string' ? lastTool.content : lastTool?.content?.filter(p => p.type === 'text').map(p => p.text).join('\n');
        try { state = JSON.parse(content); } catch { throw new Error('Unexpected computer result: ' + String(content).slice(0, 180)); }
        assert.ok(!state.refusal, JSON.stringify(state.refusal));
        receipts.push({ step, operation: state.operation, effect: state.effect || null });
      }
      const pick = (label, role) => {
        assert.ok(state.window_title.includes(filename), 'fixture tab still selected');
        const rows = state.elements.filter(e => e.label === label && (!role || e.role === role));
        assert.equal(rows.length, 1, 'unique fixture element ' + label);
        return rows[0].element_token;
      };
      let action, parameters;
      switch (step++) {
        case 0: action = 'launch_app'; parameters = { path: path.join(process.env.SystemRoot, 'System32/notepad.exe'), additional_arguments: [file] }; break;
        case 1: {
          const windows = state.windows.filter(w => w.title.includes(filename));
          assert.equal(windows.length, 1); target = { pid: state.pid, window_id: windows[0].window_id };
          action = 'get_window_state'; parameters = target; break;
        }
        case 2: action = 'type_text'; parameters = { ...target, element_token: pick('Text editor', 'Document'), text: addition }; break;
        case 3: action = 'get_window_state'; parameters = { ...target, include_screenshot: false }; break;
        case 4:
          assert.equal(state.elements.find(e => e.role === 'Document').value.replace(/\r\n?/g, '\n'), (initial + addition).replace(/\r\n?/g, '\n'));
          action = 'click'; parameters = { ...target, element_token: pick('File', 'MenuItem') }; break;
        case 5: action = 'get_window_state'; parameters = { ...target, include_screenshot: false }; break;
        case 6: action = 'click'; parameters = { ...target, element_token: pick('Save', 'MenuItem') }; break;
        case 7: action = 'get_window_state'; parameters = { ...target, include_screenshot: false }; break;
        case 8: {
          assert.equal(fs.readFileSync(file, 'utf8'), initial + addition, 'independent disk verification');
          assert.ok(state.window_title.includes(filename));
          const tab = state.elements.find(e => e.role === 'TabItem' && e.label.startsWith(filename + '.'));
          const close = state.elements.find(e => e.label === 'Close Tab' && e.parent_index === tab?.element_index);
          assert.ok(close, 'close only the newly created fixture tab');
          action = 'click'; parameters = { ...target, element_token: close.element_token }; break;
        }
        default: send({ content: 'Fixture saved and independently verified on disk.' });
      }
      if (action) send({ tool_calls: [{ index: 0, id: 'native_' + step, type: 'function', function: { name: 'computer_use', arguments: JSON.stringify({ action, parameters }) } }] });
    } catch (e) { providerError = e; send({ content: 'Fixture stopped: ' + e.message }); }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await (await request('/api/computer-control', { action: 'check' })).json()).checked, true);
    assert.equal((await (await request('/api/computer-control', { action: 'select', backend: 'cua' })).json()).backend, 'cua');
    await request('/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'NOVA', provider: 'ollama', model: 'fixture-model', approvalMode: 'full' }] });
    const response = await request('/api/run', { provider: 'ollama', baseUrl: 'http://127.0.0.1:' + provider.address().port + '/v1', model: 'fixture-model', agentId: 'agent', isTask: true, maxTurns: 20, messages: [{ role: 'user', content: 'Run the isolated native computer fixture, save and verify it.' }] });
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    fs.writeFileSync(path.join(root, 'http-events.json'), JSON.stringify(events, null, 2));
    if (providerError) throw providerError;
    assert.equal(step, 10, 'all native workflow stages completed');
    assert.ok(imageSeen, 'real screenshot reached the driving model');
    const receipt = { date: new Date().toISOString(), steps: step, imageSeen, diskVerified: true, receipts, eventTypes: [...new Set(events.map(e => e.name))] };
    fs.writeFileSync(path.join(root, 'production-receipt.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt));
  } finally { await new Promise(resolve => provider.close(resolve)); }
}
if (require.main === module) run(process.argv[2] || 'http://127.0.0.1:18941').catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { run };
