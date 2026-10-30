/* node test/effective-toolsets.availability.test.js — a granted tool the host can PROVE will fail is deferred, with
   the reason and the fix, and stays discoverable; anything uncertain stays advertised.

   A. the pure signal table (sidecar/capability/effective-toolsets.js unavailableTools/unavailableLine), its drift
      guard against CAP_REGISTRY, and tool.search's caveat line.
   B. the REAL seam: a private sidecar on the default new-install floor plus a jukebox, with no media key, no
      Spotify token and the Edge voice floor on. image_generate and every spotify_* tool are off the wire and named
      with their fix; voice_generate / image_analyze (uncertain) stay advertised; routine_notepad (not a routine
      run) is off the wire but not announced. The model searches for image generation, the result says why it
      cannot work and how to enable it, and the revealed declaration carries the same fact. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostText } = require('./helpers/host-notes.js');   // system + the user-side <run_context> note (per-run ids)
const { AVAILABILITY_SIGNALS, unavailableTools, unavailableLine } = require('../sidecar/capability/effective-toolsets.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const WM = require('../frontend/app/worldmodel.js');

const MARK = 'AVAILABILITY_PROBE';
const HOST = '127.0.0.1';

(async () => {
  // ---- A. pure ----
  {
    const granted = Object.values(CAP_REGISTRY).flat().map(g => g.tool);
    for (const s of AVAILABILITY_SIGNALS) for (const t of s.tools) A.ok(granted.indexOf(t) >= 0, 'signal ' + s.id + ' names a real CAP_REGISTRY grant: ' + t);

    const none = unavailableTools({}, granted);
    A.eq(none.byTool, {}, 'no facts = nothing deferred (unknown is never certain)');
    A.eq(unavailableTools({ mediaRoute: true, spotifyConnected: true, ptyRuntime: true, voiceRoute: true, routineRun: true }, granted).byTool, {}, 'every service available = nothing deferred');

    const media = unavailableTools({ mediaRoute: false }, granted);
    A.eq(Object.keys(media.byTool), ['image_generate'], 'no media route defers exactly image_generate');
    A.ok(/OpenAI or OpenRouter/.test(media.byTool.image_generate.enable), 'and says how to enable it');
    A.ok(media.byTool.image_analyze === undefined, 'image_analyze (falls back to the run model) is not touched');

    A.eq(unavailableTools({ mediaRoute: undefined }, granted).byTool, {}, 'an UNKNOWN media route stays advertised');
    A.eq(unavailableTools({ spotifyConnected: false }, ['fs.read']).byTool, {}, 'a signal only defers tools this run was granted');
    A.eq(unavailableTools({ spotifyConnected: false }, granted).bySignal.spotify.length, 8, 'Spotify not connected defers all 8 spotify tools');
    A.eq(unavailableTools({ ptyRuntime: false }, granted).bySignal.pty, ['terminal.start', 'terminal.write', 'terminal.resize', 'terminal.interrupt'],
      'no PTY defers the four live-pty verbs; status/read/stop still answer for recorded sessions');

    const all = unavailableTools({ mediaRoute: false, spotifyConnected: false, routineRun: false }, granted);
    const line = unavailableLine(all.bySignal);
    A.ok(line.indexOf('image_generate') >= 0 && line.indexOf('spotify_*') >= 0, 'the prompt line names each announced signal');
    A.ok(line.indexOf('routine_notepad') < 0, 'routine.notepad is found by search but never announced');
    A.ok(/Never claim one of these worked/.test(line), 'the line forbids claiming the dead tool worked');
    A.eq(unavailableLine({}), '', 'nothing unavailable = no new prompt bytes');
    A.eq(unavailableLine(unavailableTools({ routineRun: false }, granted).bySignal), '', 'a silent-only signal adds no prompt bytes');

    // Discoverable via tool.search, with the fix named, and still revealable.
    const registry = makeRegistry();
    registry.register({ impact: 'none', name: 'image_generate', capability: 'studio', scope: 'write', requiresConsent: true,
      description: 'Generate an image from a text prompt and save it to your workspace.',
      schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } }, run: async () => ({ content: 'x' }) });
    registry.register({ impact: 'synthetic-browser', name: 'browser.pdf', capability: 'web', scope: 'read', requiresConsent: false,
      description: 'Save the current page as a PDF.', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'x' }) });
    makeToolSearchTool({ registry }).register(registry);
    const ctx = makeCapCtx({ agentId: 'a', room: 'r', hasCompute: true, tools: ['image_generate', 'browser.pdf', 'tool.search'],
      deferred: ['image_generate', 'browser.pdf'], unavailable: media.byTool, approvalRules: {} });
    A.eq(Object.keys(ctx.unavailable), ['image_generate'], 'capCtx carries the unavailable map to tool.search');
    const hit = await registry.get('tool.search').run({ query: 'generate an image' }, ctx);
    A.ok(hit.content.indexOf('image_generate') >= 0 && hit.content.indexOf('NOT USABLE RIGHT NOW') >= 0, 'search finds the unavailable tool and says it cannot work');
    A.ok(hit.content.indexOf('OpenAI or OpenRouter') >= 0, 'search names how to enable it');
    A.eq(hit.control && hit.control.revealTools, ['image_generate'], 'it is still revealed (the Commander may fix it mid-run)');
    const pdf = await registry.get('tool.search').run({ query: 'save the page as a pdf' }, ctx);
    A.ok(pdf.content.indexOf('NOT USABLE') < 0, 'an available deferred tool gets no caveat');
  }

  // ---- B. the live seam ----
  const bodies = [];
  const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const llm = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const msgs = body.messages || [];
    const system = msgs.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    if (system.indexOf(MARK) >= 0) bodies.push(body);
    if (system.indexOf(MARK) >= 0 && !msgs.some(m => m.role === 'tool')) {
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'tool_search', arguments: '{"query":"generate an image"}' } }] } }] });
      sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    } else { sse(res, { choices: [{ delta: { content: 'noted' } }] }); sse(res, done); }
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => llm.listen(0, HOST, r));
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0' });
  const fixture = SidecarFixture.create({ prefix: 'starnet-availability-', timeoutMs: 20000, env });
  // The DEFAULT new-install floor, exactly as World.heroCaps projects WorldModel.starterDoc() — plus a jukebox.
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  let ptyLoads = false; try { require('node-pty'); ptyLoads = true; } catch (_) { ptyLoads = false; }
  try {
    await fixture.start();
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'custom', baseUrl: 'http://' + HOST + ':' + llm.address().port + '/v1', key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true,
      placed: starter.concat(['jukebox']).map(objectType => ({ objectType })), system: MARK + ': availability probe.',
      messages: [{ role: 'user', content: 'Make me a logo image.' }] }) });
    A.eq(r.status, 200, 'run accepted');
    const events = (await r.text()).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    A.eq((events.filter(e => e.name === 'agent.run.end').pop() || {}).payload.reason, 'done', 'run completes');
    A.ok(bodies.length >= 2, 'two scripted model turns (got ' + bodies.length + ')');
    const [t1, t2] = bodies;
    const n1 = t1.tools.map(t => t.function.name);
    const sys = t1.messages.filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    A.ok(n1.indexOf('image_generate') < 0, 'CERTAIN (no media route): image_generate is off the wire');
    A.eq(n1.filter(n => /^spotify_/.test(n)), [], 'CERTAIN (no Spotify token): every spotify tool is off the wire');
    A.ok(n1.indexOf('routine_notepad') < 0, 'CERTAIN (not a routine run): routine_notepad is off the wire');
    A.ok(n1.indexOf('voice_generate') >= 0, 'voice_generate stays advertised (the Edge floor is on)');
    A.ok(n1.indexOf('image_analyze') >= 0, 'UNCERTAIN: image_analyze stays advertised');
    A.eq(n1.indexOf('terminal_start') >= 0, ptyLoads, 'terminal_start is advertised exactly when node-pty loads on this machine');
    A.ok(sys.indexOf('image_generate — no image-generation connection is configured') >= 0, 'the prompt names the dead tool and its reason');
    A.ok(sys.indexOf('spotify_* — Spotify is not connected') >= 0, 'the prompt names Spotify and its reason');
    A.ok(sys.indexOf('routine_notepad') < 0, 'routine_notepad is never announced');
    const partial = (sys.match(/These exist and you CAN use them: ([^.]*)\./) || [])[1] || '';
    A.ok(partial.length > 0 && partial.indexOf('image_generate') < 0 && partial.indexOf('spotify_') < 0, 'a dead tool is never listed under "you CAN use them"');
    const host = hostText(t1.messages);   // the per-run ids ride the run-context note, after the system prompt
    A.ok(host.indexOf('Granted tools that CANNOT work right now') >= 0 && host.lastIndexOf('Run id:') > host.indexOf('Granted tools that CANNOT work right now'), 'the line rides before the per-run ids (prompt-cache prefix law)');
    const result = t2.messages.filter(m => m.role === 'tool').map(m => String(m.content)).join('\n');
    A.ok(result.indexOf('image_generate') >= 0 && result.indexOf('NOT USABLE RIGHT NOW') >= 0 && result.indexOf('OpenAI or OpenRouter') >= 0,
      'tool_search finds image_generate and says why it cannot work and how to enable it');
    const decl = t2.tools.find(t => t.function.name === 'image_generate');
    A.ok(decl && /^NOT USABLE RIGHT NOW: no image-generation connection/.test(decl.function.description), 'the revealed declaration carries the reason too');
  } finally {
    await fixture.dispose();
    await new Promise(r => llm.close(r));
  }
  A.report('effective-toolsets.availability');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
