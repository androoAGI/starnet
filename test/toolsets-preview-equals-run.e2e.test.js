/* node test/toolsets-preview-equals-run.e2e.test.js — GET /api/toolsets previews the run it names, exactly (authority-census).

   The lane's done-means: "/api/toolsets equals the captured provider tool list". The TOOLSETS readout used to describe
   capability FAMILIES (effectiveToolsets: granted by a prop / the profile / Full Access), while the run later applied the
   run authority, availability, crew and connector deferral and its own internal controls — so no readout could promise
   what the model would be offered (a5 R5, Q8). Its `run` section now names ONE context — a task the Commander sends this
   agent from COMMS (desktop lead, interactive, a Task Brief, first turn) on a placement — and is decided by the same
   ProjectTools.projectTools that run calls. This test asks for that preview, then sends that very task through the real
   /api/run with a scripted provider and compares the preview's advertised list with the tool list the provider actually
   received, name for name (after the wire's dot -> underscore mapping). Deferred stays deferred: never on the wire, still
   listed. The family rows are unchanged beside it.

   A PLUGIN TERMINAL is per-instance (A5-PROJ-01): COMMS sends World.heroCaps' { objectType: 'plugin', pluginId } and the
   run projects that approved plugin's tools; a preview that kept only the type ('plugin') offered none of them. The
   TOOLSETS client now names a bound terminal plugin:<pluginId> in ?placed=, the preview maps it with /api/run's own rule,
   and the bound case below requires the plugin's tool on the provider's wire BEFORE it checks equality. An unbound one
   (the type alone) grants no plugin tool on either side, and the preview says so in `assumes`. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { pluginToolName } = require('../sidecar/plugin-tools.js');

const SAMPLE = 'sample_plugin';
const SAMPLE_TOOL = pluginToolName(SAMPLE, 'inspect');
const UNBOUND = /plugin terminal named without its plugin/;

// a real plugin folder in the fixture's plugins dir, approved by its exact digest through the real routes (its own process)
async function installApprovedPlugin(fixture, id) {
  const dir = path.join(fixture.workspace, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'Sample', version: '1.0.0', description: 'A5-PROJ-01 witness', main: 'index.js' }) + '\n');
  fs.writeFileSync(path.join(dir, 'index.js'), "module.exports = { register(api) { api.tool({ name: 'inspect', description: 'Inspect the sample.', readOnly: true, parameters: { type: 'object', properties: {} }, run: async () => ({ ok: true }) }); } };\n");
  const found = ((await fixture.json('GET', '/api/plugins')).body.plugins || []).find(p => p.id === id);
  A.ok(found && found.digest && found.pending, 'the sample plugin is installed and awaits approval');
  const allowed = await fixture.json('POST', '/api/plugins/allow', { id, digest: found.digest });
  A.eq(allowed.status, 200, 'the sample plugin is approved by its exact digest');
  const live = ((await fixture.json('GET', '/api/plugins')).body.plugins || []).find(p => p.id === id);
  A.ok(live && live.active && (live.tools || []).indexOf('inspect') >= 0, 'the approved plugin runs in its process and registered its inspect tool');
}

function startCapturingProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Looked.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

async function runTask(fixture, placed) {
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'sk-or-v1-preview-fake', provider: 'openrouter', model: 'test/model', agentId: 'scout',
      streamId: 'preview-' + Date.now(), isTask: true, placed,
      messages: [{ role: 'user', content: 'List what is in my project folder and summarize it.' }]
    })
  });
  A.eq(response.status, 200, 'the real /api/run admitted the task');
  const reader = response.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
}

(async () => {
  const provider = await startCapturingProvider();
  const fixture = SidecarFixture.create({
    prefix: 'sk-preview-',
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-preview-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-preview-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '0'
    }
  });
  try {
    await fixture.start();
    const seeded = await fixture.json('POST', '/api/roster', {
      updatedAt: 100, agents: [{ agentId: 'scout', system: 'You are SCOUT.', name: 'SCOUT', provider: 'openrouter', model: 'test/model', approvalMode: 'ask' }]
    });
    A.ok(seeded.body && seeded.body.ok === true, 'SCOUT runs in ASK');

    await installApprovedPlugin(fixture, SAMPLE);

    // the ordinary TOOLSETS client names a bound plugin terminal by its binding, as COMMS hands it to /api/run
    const CONN = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'connectors.js'), 'utf8');
    A.ok(/c\.objectType === 'plugin' && c\.pluginId \? 'plugin:' \+ c\.pluginId : c\.objectType/.test(CONN)
      && /'&placed=' \+ encodeURIComponent\(placedQuery\.join\(','\)\)/.test(CONN), 'the TOOLSETS client sends a bound plugin terminal as plugin:<pluginId>');

    const cases = [
      { query: 'workbench,dish,cabinet', placed: ['workbench', 'dish', 'cabinet'] },
      { query: '', placed: [] },
      { label: 'a bound plugin terminal', query: 'plugin:' + SAMPLE, placed: [{ objectType: 'plugin', pluginId: SAMPLE }], offers: SAMPLE_TOOL },
      { label: 'an unbound plugin terminal', query: 'plugin', placed: ['plugin'], unbound: true }
    ];
    for (const c of cases) {
      const placed = c.placed;
      const label = c.label || (placed.length ? placed.join('+') : 'nothing placed');
      const view = (await fixture.json('GET', '/api/toolsets?agent=scout&placed=' + encodeURIComponent(c.query))).body;
      A.ok(Array.isArray(view.toolsets) && view.toolsets.length > 0, label + ': the family rows are still there');
      const run = view.run || {};
      A.eq(run.context && run.context.origin, 'desktop-comms', label + ': the preview names the run it describes (a COMMS task)');
      A.eq(run.context && run.context.role, 'lead', label + ': ...as the lead');
      A.eq(run.context && run.context.placement, 'query', label + ': ...on the placement this request named');
      A.ok(Array.isArray(run.assumes) && run.assumes.length >= 1, label + ': the facts only one request carries are named, never guessed');
      A.ok(Array.isArray(run.advertised) && run.advertised.length > 0 && Array.isArray(run.deferred), label + ': advertised and deferred are listed apart');

      const before = provider.requests.length;
      await runTask(fixture, placed);
      const first = provider.requests[before];
      A.ok(first && Array.isArray(first.tools), label + ': the provider received the run\'s tool list');
      const wire = (first.tools || []).map(t => t.function && t.function.name).filter(Boolean).sort();
      const previewed = run.advertised.map(n => String(n).replace(/\./g, '_')).sort();
      if (c.offers) A.ok(wire.indexOf(c.offers) >= 0, label + ': the run offers the bound plugin\'s tool (' + c.offers + ')');
      if (c.unbound) {
        A.ok(!wire.some(n => /^plugin__/.test(n)) && !previewed.some(n => /^plugin__/.test(n)), label + ': no plugin tool on either side');
        A.ok(run.assumes.some(a => UNBOUND.test(a)), label + ': the preview says an unbound plugin terminal projects no plugin tools');
      } else {
        A.ok(!run.assumes.some(a => UNBOUND.test(a)), label + ': no unbound-terminal caveat when every terminal names its plugin');
      }
      A.eq(previewed, wire, label + ': GET /api/toolsets advertised EQUALS the provider\'s tool list, name for name');
      const onWire = new Set(wire);
      A.ok(run.deferred.every(n => !onWire.has(String(n).replace(/\./g, '_'))), label + ': a deferred tool is never on the wire (tool_search reveals it)');
      for (const n of run.advertised) A.ok(run.rows && run.rows[n] && run.rows[n].state === 'advertised', label + ': ' + n + ' has its row, advertised');
    }
    // the preview trusts a named plugin no more than /api/run does: an id its rule refuses is an unbound terminal
    {
      const view = (await fixture.json('GET', '/api/toolsets?agent=scout&placed=' + encodeURIComponent('plugin:../' + SAMPLE))).body;
      const run = view.run || {};
      A.ok(Array.isArray(run.advertised) && !run.advertised.some(n => /^plugin__/.test(n)), 'a refused plugin id projects no plugin tool');
      A.ok((run.assumes || []).some(a => UNBOUND.test(a)), '...and is disclosed as an unbound terminal');
    }
  } finally {
    await fixture.dispose();
    provider.server.close();
  }
  A.report('toolsets-preview-equals-run.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
