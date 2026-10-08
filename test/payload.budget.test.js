/* node test/payload.budget.test.js — the PER-CALL PAYLOAD BUDGET (w2 footprint, 2026-09-22).

   Every model call re-sends the system prompt and every advertised tool schema. Nothing guarded that growth: a
   Hermes-parity audit measured StarNet at 34,867 system chars + 47 tools per call on a working floor, against
   13,595 + 25 for Hermes on the same machine. This test builds the two layouts that matter from the REAL request
   bytes a private sidecar sends to a fake model, prints what it measured so growth is visible in review, and pins
   an upper budget with headroom:

     default-new-install  the floor a fresh station boots with (WorldModel.starterDoc() -> World.heroCaps), the
                          interactive LEAD run, ASK approval, no connectors, no media/Spotify credentials.
     fully-granted-floor  the same station with the master bypass on: every CAP_REGISTRY object is materialized.

   A budget failure is a REVIEW prompt, not a bug report: if the growth is intended, raise the budget in the same
   commit and say why. Also re-asserts the chat-diet law: a non-task turn carries NO tools on the wire. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const WM = require('../frontend/app/worldmodel.js');

const MARK = 'PAYLOAD_BUDGET_PROBE';
const HOST = '127.0.0.1';
/* Measured 2026-09-23 (agent/w2-footprint, node-pty loadable, no media key, no Spotify token):
     default-new-install  36,924 system chars | 76 tools | 57,315 tool bytes   (before this lane: 36,575 | 78 | 59,452)
     fully-granted-floor  37,173 system chars | 76 tools | 57,315 tool bytes   (before this lane: 36,883 | 86 | 61,556)
   Budgets carry ~6% headroom. Biggest default-floor sections: INSTALLED SKILLS ~12.4K, operator manual ~9.3K,
   [HARNESS] ~7.0K, [ORCHESTRATION] ~4.3K, FINISH THE JOB ~2.6K.
   Re-measured 2026-09-23 on the wave-2 integration tree (trunk 0ea1bbb71 + all three wave-2 lanes): both layouts
   36,967 / 37,188 system chars | 79 tools | 60,931 tool bytes. The +3 tools / +3.6 KB is the STUDIO DaVinci Resolve edit
   bay (resolve_timeline_file / resolve_status / resolve_control, eefd36fe8) that landed on trunk after the measurement
   above — intended growth, so the tool budgets were raised here with the same ~6% headroom.
   PROMPT DIET 2026-09-23 (agent/w3-prompt-diet, progressive disclosure — nothing removed, moved one tool call away):
     default-new-install  36,929 -> 23,174 system chars | 79 -> 80 tools | 60,931 -> 61,626 tool bytes
     fully-granted-floor  37,188 -> 23,395 system chars | 79 -> 80 tools | 60,931 -> 61,626 tool bytes
   INSTALLED SKILLS ~12.4K -> ~1.1K (one index line per offered recipe; skill.view serves the exact body by its
   library:<slug> name) and the operator manual ~9.3K -> ~6.3K (orientation + every behaviour rule stay inline; the
   navigation / props / troubleshooting reference sections are a TOC served verbatim by manual.read). The +1 tool /
   +695 B is manual.read plus skill.view's description naming installed recipes; the tool budgets above still hold.
   The system budgets drop to the new measurement + ~6% so the diet cannot silently regrow.
   STEP-IN 2026-09-30: browser.need_human is advertised on every run with a browser (it is the way out of a login /
   2FA / CAPTCHA wall, so it is never deferred): 84 tools | 64,918 tool bytes. Intended growth; the byte budget moves
   to 65,300 (measurement + ~0.6%: the earlier headroom is spent, so the next tool owes a diet, not another raise).
   STATION BUILDER 2026-09-30: the lead's one-line pointer to the deferred builder ("to change the floor, tool_search
   \"station builder\" and claim only what station.build reports") replaces the old "configured in the station UI"
   sentence, and the three deferred builder tools are named in the deferred index: 24,606 / 24,827 system chars on the
   APPS trunk (7854c4241). Intended growth; the system budgets move by 50 (measurement + ~0.2%).
   STATION BUILDER 2026-10-01: station.test_line (the lead sends a test job down a line it built) and station.start_line
   (it sets what starts a line) join the deferred index: ", station_test_line, station_start_line" = +39. Note what else moves this number: the prompt carries the harness build id
   (git describe), whose length changes as other lanes add tags. It took trunk from 24,795 to 24,833 on the floor
   with no prompt change (038a62983). Measured 24,612 + 39 / 24,833 + 39; the system budgets move by 50 again.
   PINNED BUILD ID 2026-10-03: the run's build id is now a fixed release-shaped label (STARNET_BUILD_DESCRIBE below), so a
   tag elsewhere can never move this number again (an archive tag took the floor to 24,902 with no prompt change).
   10-06 ISSUE BATCH (#77, already on trunk e5e95c76b): team_dispatch's description now says where a worker's relative
   files land in a project-scoped conversation and why an ASK-mode worker has no shell (+570), image tools name the
   absolute location (+~130): trunk measured 65,999 tool bytes, over the 65,300 budget, and the HTTP gate went red.
   Intended growth: the byte budget moves to 66,100. station.status (#55) is DEFERRED for exactly this reason — it
   adds no schema, only ", station_status" (+16) to the deferred index: 24,694 / 24,915. System budgets move by 50. */
const BUDGET = {
  'default-new-install': { systemChars: 24750, tools: 84, toolBytes: 66100 },
  'fully-granted-floor': { systemChars: 24950, tools: 84, toolBytes: 66100 }
};

(async () => {
  const bodies = [];
  const llm = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const system = (body.messages || []).filter(m => m.role === 'system').map(m => String(m.content)).join('\n');
    if (system.indexOf(MARK) >= 0) bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => llm.listen(0, HOST, r));
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  Object.assign(env, { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0' });
  // the prompt carries the harness build id: pinned to a release-shaped label so the measurement is the PROMPT, not whichever
  // tag `git describe` finds nearest this checkout (an archive/<lane>-<sha> tag added 13 chars and failed the gate, 10-03)
  env.STARNET_BUILD_DESCRIBE = 'v0.12.5-1587-gac98203c2-dirty';
  const fixture = SidecarFixture.create({ prefix: 'starnet-payload-budget-', timeoutMs: 20000, env });
  const starter = [];
  for (const p of WM.starterDoc().props) { const c = WM.capForProp(p.t); if (c && c !== 'computer' && c !== 'connector' && starter.indexOf(c) < 0) starter.push(c); }
  async function measure(isTask) {
    bodies.length = 0;
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'custom', baseUrl: 'http://' + HOST + ':' + llm.address().port + '/v1', key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask,
      placed: starter.map(objectType => ({ objectType })), stationPlaced: starter.map(objectType => ({ objectType })),
      system: MARK + ': payload budget probe.', messages: [{ role: 'user', content: 'Summarize what you can do.' }] }) });
    A.eq(r.status, 200, 'run accepted');
    await r.text();
    A.eq(bodies.length, 1, 'exactly one foreground model call');
    const b = bodies[0] || { messages: [] };
    const tools = Array.isArray(b.tools) ? b.tools : [];
    return {
      systemChars: b.messages.filter(m => m.role === 'system').reduce((n, m) => n + String(m.content).length, 0),
      tools: tools.length,
      toolBytes: tools.length ? Buffer.byteLength(JSON.stringify(tools)) : 0
    };
  }
  try {
    await fixture.start();
    A.eq(starter.slice().sort(), ['cabinet', 'dish', 'notebook', 'studio', 'workbench'], 'the starter floor is the five essentials (worldmodel.js starterDoc)');
    const measured = {};
    measured['default-new-install'] = await measure(true);
    const chat = await measure(false);
    A.eq(chat.tools, 0, 'chat diet: a non-task turn carries NO tools on the wire');
    A.eq((await fixture.json('POST', '/api/permissions/bypass', { on: true })).status, 200, 'master bypass on (every capability object materialized)');
    measured['fully-granted-floor'] = await measure(true);
    for (const id of Object.keys(BUDGET)) {
      const m = measured[id], b = BUDGET[id];
      console.log('[payload] ' + id + ': system ' + m.systemChars + ' chars (budget ' + b.systemChars + ') | ' + m.tools + ' tools (budget ' + b.tools + ') | '
        + m.toolBytes + ' tool bytes (budget ' + b.toolBytes + ')');
      A.ok(m.systemChars <= b.systemChars, id + ': system prompt ' + m.systemChars + ' chars within budget ' + b.systemChars);
      A.ok(m.tools <= b.tools, id + ': ' + m.tools + ' advertised tools within budget ' + b.tools);
      A.ok(m.toolBytes <= b.toolBytes, id + ': ' + m.toolBytes + ' tool-schema bytes within budget ' + b.toolBytes);
      A.ok(m.tools > 10 && m.systemChars > 5000, id + ': the measurement saw a real task payload (not an empty request)');
    }
  } finally {
    await fixture.dispose();
    await new Promise(r => llm.close(r));
  }
  A.report('payload.budget');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
