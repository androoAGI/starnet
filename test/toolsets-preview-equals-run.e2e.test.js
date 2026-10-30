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
   (the type alone) grants no plugin tool on either side, and the preview says so in `assumes`.

   An id /api/run refuses is unbound on both sides too, and the preview says it was the id, not a missing binding. That
   includes an id with a comma inside: the client encodes each ?placed= entry before the ',' join (tsPlacedQuery, run here
   from the client source), so sample_plugin,x stays one refused id and never binds sample_plugin. A trailing space stays
   in the id as well (sample_plugin<space> is refused, never trimmed into sample_plugin). The world model never holds
   such an id (bindPlugin and placePluginTerminal refuse it, and the doc load keeps a pluginId only trimmed and only when
   it passes /api/run's own pattern), so these rows guard the wire against a hand-built request; no terminal a Commander
   binds produces one.

   Every row is placed as World.heroCaps hands it to COMMS: the run receives those objects, and the preview is requested
   on the exact wire the TOOLSETS client builds from them, tsPlacedQuery's per-entry encoding, then the whole value
   encoded again as tsRefresh sends it. So a server that stopped decoding each entry fails the bound row. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { pluginToolName } = require('../sidecar/plugin-tools.js');

const SAMPLE = 'sample_plugin';
const SAMPLE_TOOL = pluginToolName(SAMPLE, 'inspect');
// why a plugin terminal is unbound, word for word: named by its type alone, or by an id the run refuses
const UNBOUND = /^a plugin terminal named without its plugin \(placed=plugin, not plugin:<pluginId>\) is unbound: it projects no plugin tools, here or in a run$/;
const REFUSED = /^a plugin terminal named plugin:<pluginId> whose id \/api\/run refuses is unbound: it projects no plugin tools, here or in a run$/;
// a binding with a comma inside: the run refuses it, and the part before the comma is a real approved plugin
const COMMA_ID = SAMPLE + ',x';
const COMMA_QUERY = encodeURIComponent('plugin:' + COMMA_ID);   // the one entry tsPlacedQuery sends for it (checked below)
// a binding with a trailing space: the run refuses it, and the trimmed id is a real approved plugin
const SPACE_ID = SAMPLE + ' ';
const SPACE_QUERY = 'plugin%3A' + SAMPLE + '%20';               // the one entry tsPlacedQuery sends for it (checked below)

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

const TASK = 'List what is in my project folder and summarize it.';
// the run's own call to the provider: its last message is the task. The station's background jobs (the scout's topic
// extraction, the quest master) share this scripted provider and can land between a row's count and the run's call
function isRunRequest(body) {
  const ms = (body && body.messages) || [];
  const last = ms[ms.length - 1];
  return !!last && last.role === 'user' && typeof last.content === 'string' && last.content.endsWith(TASK);
}

async function runTask(fixture, placed) {
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'sk-or-v1-preview-fake', provider: 'openrouter', model: 'test/model', agentId: 'scout',
      streamId: 'preview-' + Date.now(), isTask: true, placed,
      messages: [{ role: 'user', content: TASK }]
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

    // the ordinary TOOLSETS client names a bound plugin terminal by its binding, as COMMS hands it to /api/run, and
    // encodes each entry on its own before the ',' join, so a comma inside a binding never splits it
    const CONN = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'connectors.js'), 'utf8');
    const placedQuerySrc = A.fnBody(CONN, 'function tsPlacedQuery(');
    const clientQuery = placedQuerySrc ? vm.runInNewContext('(' + placedQuerySrc + ')') : null;
    A.ok(typeof clientQuery === 'function' && /'&placed=' \+ encodeURIComponent\(tsPlacedQuery\(caps\)\)/.test(CONN), 'the TOOLSETS client builds ?placed= from World.heroCaps with tsPlacedQuery');
    A.eq(clientQuery ? clientQuery([{ objectType: 'workbench' }, { objectType: 'plugin', pluginId: SAMPLE }, { objectType: 'plugin' }]) : null,
      'workbench,plugin%3A' + SAMPLE + ',plugin', 'the TOOLSETS client sends a bound plugin terminal as plugin:<pluginId>, an unbound one by its type');
    A.eq(clientQuery ? clientQuery([{ objectType: 'plugin', pluginId: COMMA_ID }]) : null, COMMA_QUERY,
      'the TOOLSETS client sends a binding with a comma inside as ONE encoded entry');
    A.eq(clientQuery ? clientQuery([{ objectType: 'plugin', pluginId: SPACE_ID }]) : null, SPACE_QUERY,
      'the TOOLSETS client sends a binding with a trailing space as ONE encoded entry, the space kept');
    // every row's preview goes out on that client wire. Should the client's builder be unreadable (failed above), the rows
    // still judge the server on the contract it is pinned to (each entry encoded alone, then the ',' join)
    const placedQuery = clientQuery || (caps => caps.map(c => encodeURIComponent(c.objectType === 'plugin' && c.pluginId ? 'plugin:' + c.pluginId : c.objectType)).join(','));

    // each row is a World.heroCaps-shaped placement: the run is placed with it as COMMS sends it
    const cases = [
      { placed: [{ objectType: 'workbench' }, { objectType: 'dish' }, { objectType: 'cabinet' }] },
      { placed: [] },
      { label: 'a bound plugin terminal', placed: [{ objectType: 'plugin', pluginId: SAMPLE }], offers: SAMPLE_TOOL },
      { label: 'an unbound plugin terminal', placed: [{ objectType: 'plugin' }], unbound: UNBOUND },
      // the preview trusts a named plugin no more than /api/run does: an id its rule refuses is unbound, here and in the run
      { label: 'a refused plugin id', placed: [{ objectType: 'plugin', pluginId: '../' + SAMPLE }], unbound: REFUSED },
      // ...a comma inside the id included: the run is placed with { objectType: 'plugin', pluginId: 'sample_plugin,x' },
      // and the preview reads the client's one entry as that same refused id, never as sample_plugin
      { label: 'a plugin id with a comma inside', placed: [{ objectType: 'plugin', pluginId: COMMA_ID }], unbound: REFUSED },
      // ...and a trailing space: the preview keeps it in the id the run refuses, never trims it into sample_plugin
      { label: 'a plugin id with a trailing space', placed: [{ objectType: 'plugin', pluginId: SPACE_ID }], unbound: REFUSED }
    ];
    for (const c of cases) {
      const placed = c.placed;
      const label = c.label || (placed.length ? placed.map(o => o.objectType).join('+') : 'nothing placed');
      // the request tsRefresh makes: the agent, then tsPlacedQuery(caps) encoded again as one value
      const view = (await fixture.json('GET', '/api/toolsets?agent=' + encodeURIComponent('scout') + '&placed=' + encodeURIComponent(placedQuery(placed)))).body;
      A.ok(Array.isArray(view.toolsets) && view.toolsets.length > 0, label + ': the family rows are still there');
      const run = view.run || {};
      A.eq(run.context && run.context.origin, 'desktop-comms', label + ': the preview names the run it describes (a COMMS task)');
      A.eq(run.context && run.context.role, 'lead', label + ': ...as the lead');
      A.eq(run.context && run.context.placement, 'query', label + ': ...on the placement this request named');
      A.ok(Array.isArray(run.assumes) && run.assumes.length >= 1, label + ': the facts only one request carries are named, never guessed');
      A.ok(Array.isArray(run.advertised) && run.advertised.length > 0 && Array.isArray(run.deferred), label + ': advertised and deferred are listed apart');

      const before = provider.requests.length;
      await runTask(fixture, placed);
      const first = provider.requests.slice(before).find(isRunRequest);   // found by its task, never by its index
      A.ok(first && Array.isArray(first.tools), label + ': the provider received the run\'s tool list');
      const wire = ((first && first.tools) || []).map(t => t.function && t.function.name).filter(Boolean).sort();
      const previewed = run.advertised.map(n => String(n).replace(/\./g, '_')).sort();
      if (c.offers) A.ok(wire.indexOf(c.offers) >= 0, label + ': the run offers the bound plugin\'s tool (' + c.offers + ')');
      if (c.unbound) {
        const other = c.unbound === UNBOUND ? REFUSED : UNBOUND;
        A.ok(!wire.some(n => /^plugin__/.test(n)) && !previewed.some(n => /^plugin__/.test(n)), label + ': no plugin tool on either side');
        A.ok(run.assumes.some(a => c.unbound.test(a)), label + ': the preview says why the terminal is unbound and that it projects no plugin tools, here or in a run');
        A.ok(!run.assumes.some(a => other.test(a)), label + ': ...and names no other cause');
      } else {
        A.ok(!run.assumes.some(a => UNBOUND.test(a) || REFUSED.test(a)), label + ': no unbound-terminal caveat when every terminal names its plugin');
      }
      A.eq(previewed, wire, label + ': GET /api/toolsets advertised EQUALS the provider\'s tool list, name for name');
      const onWire = new Set(wire);
      A.ok(run.deferred.every(n => !onWire.has(String(n).replace(/\./g, '_'))), label + ': a deferred tool is never on the wire (tool_search reveals it)');
      for (const n of run.advertised) A.ok(run.rows && run.rows[n] && run.rows[n].state === 'advertised', label + ': ' + n + ' has its row, advertised');
    }
  } finally {
    await fixture.dispose();
    provider.server.close();
  }
  A.report('toolsets-preview-equals-run.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
