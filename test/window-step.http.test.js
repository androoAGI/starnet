/* node test/window-step.http.test.js: THE WINDOW STEP ON THE WIRE (cost lane W2.6; STARNET_WINDOW_STEP, off by default).

   A real sidecar, a recording provider, a 190-row chat. The page is modelled the way chat.js posts a long chat: the newest
   120 rows it holds (read back from the station with their durable ids), the new directive last, its token budget beside.
     OFF (the switch unset): the provider is handed exactly the posted window, 119 rows of history and the directive; its
        first row and the earlier-conversation note are different bytes on every send, and run start names no step.
     ON  (STARNET_WINDOW_STEP=1, the same station restarted): the history opens on a 40-row mark of the stream. Between two
        marks a request's history is a byte prefix of the next request's and the earlier note is the same bytes; the send
        that crosses a mark moves the start by 40 rows once. Never fewer rows than OFF sends. Run start tells the page how
        many rows and dialogue tokens the step added.
   The recording provider is a Chat Completions route for a non-Claude model, so the host notes ride the newest user turn
   (provider.js projectRoles 'chat'); on a Claude route the earlier note is part of the leading system block, in front of
   the whole history, which is why its bytes must hold still between two marks. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const UserText = require('../frontend/app/usertext.js');
const Gauge = require('../frontend/app/ctxgauge.js');

const requests = [], words = m => UserText.flatten(m && m.content, UserText.OPENAI);
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => {
    if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 200000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
    requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'STEP_REPLY_' + requests.length + ' ' + 'r'.repeat(600) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
});
const SEED = 190, STREAM = 'long';
const HOST_TURN = 'user:<host_turn>The conversation so far continues below.</host_turn>';   // the boundary a window that opens on a reply gets
const seedText = n => 'ROW_' + String(n).padStart(4, '0') + ' ' + (n % 2 ? 'a' : 'q').repeat(n % 2 ? 700 : 240);
const seedLine = n => (n % 2 ? 'assistant:' : 'user:') + seedText(n);
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fx = SidecarFixture.create({ prefix: 'window-step-http-', env: {
    STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_MAX_CONCURRENT_AGENTS: '1', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_AUX_BUDGET: '0'
  } });
  const quick = Object.create(fs); quick.fsyncSync = () => {};
  const io = makeSegmentedTranscriptIo({ fs: quick, path, root: path.join(fx.workspace, 'transcript-history-v2'), segmentBytes: 1 << 20, schedule() {} });
  const at = Date.now();
  for (let n = 0; n < SEED; n++) io.appendDurable({ streamId: STREAM, agentId: 'agent', role: n % 2 ? 'assistant' : 'user', content: seedText(n), ts: at - 600000 + n,
    turnId: 'step_seed_' + String(n >> 1).padStart(6, '0'), kind: 'turn', directive: n % 2 === 0 });
  io.close();
  let serial = 0;
  // the page: the newest 120 rows it holds, as the station gave them back (ids and all), with the new directive last
  async function send(text) {
    const read = await fx.json('GET', '/api/transcript?agent=agent&stream=' + STREAM + '&limit=400');
    const held = (read.body.turns || []).filter(t => t && (t.role === 'user' || t.role === 'assistant'))
      .map(t => ({ role: t.role, content: t.content, rowId: t.rowId, streamId: STREAM, turnId: t.turnId }));
    const now = Date.now(), turnId = 'step_http_' + String(++serial).padStart(6, '0');
    const posted = held.slice(-119).concat([{ role: 'user', content: text, turnId, turnAt: now }]);
    const before = requests.length;
    const response = await fx.json('POST', '/api/run', { model: 'test/model', provider: 'openrouter', key: 'fixture', agentId: 'agent',
      streamId: STREAM, turnId, turnAt: now, clientNow: now, windowTokens: 100000, isTask: false, messages: posted });
    const events = response.status === 200 ? String(response.text).trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const start = events.find(e => e.name === 'agent.run.start' && !e.payload.parentRunId);
    const body = requests.slice(before)[0] || { messages: [] };
    // what the provider was handed: the history (every turn before the newest user turn), and the earlier-conversation note
    const turns = body.messages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => m.role + ':' + words(m));
    const newest = turns.at(-1) || '', earlier = body.messages.map(words).join('\n').match(/<conversation_summary>[\s\S]*?<\/conversation_summary>/);
    return { status: response.status, held: held.length, posted: posted.slice(0, -1).map(m => m.role + ':' + m.content), history: turns.slice(0, -1).filter(line => line !== HOST_TURN),
      boundary: turns[0] === HOST_TURN, carries: newest.endsWith(text), note: earlier ? earlier[0] : '', step: start && start.payload.windowStep,
      end: events.filter(e => e.name === 'agent.run.end' && !e.payload.parentRunId).at(-1)?.payload };
  }
  const prefixOf = (a, b) => b.history.length > a.history.length && a.history.every((line, i) => b.history[i] === line);
  try {
    /* ---------- OFF: the posted window, as before ---------- */
    await fx.start();
    const a = await send('OFF_ASK_ONE'), b = await send('OFF_ASK_TWO');
    A.eq([a.status, a.end?.outcome, b.end?.outcome, a.carries && b.carries], [200, 'succeeded', 'succeeded', true], 'off: both sends complete and carry their directive');
    A.eq([a.held >= 120, a.history.length, b.history.length], [true, 119, 119], 'off: the provider is handed the 119 posted rows of history');
    A.eq([a.history, b.history], [a.posted, b.posted], 'off: exactly the posted window, in order');
    A.eq([a.history[0], b.history[0]], [seedLine(SEED - 119), seedLine(SEED - 117)], 'off: the first history row slides by one exchange per send (rows 71, then 73)');
    A.ok(a.note && b.note && a.note !== b.note && !prefixOf(a, b), 'off: the earlier note and the history are different bytes on the next send');
    A.eq([a.step, b.step], [undefined, undefined], 'off: run start names no window step');
    await fx.stop();

    /* ---------- ON: the same station, the switch on ---------- */
    await fx.start({ STARNET_WINDOW_STEP: '1' });
    const c = await send('ON_ASK_ONE'), d = await send('ON_ASK_TWO'), e = await send('ON_ASK_THREE');   // 195, 197, 199 rows: mark 40
    A.eq([c.end?.outcome, d.end?.outcome, e.end?.outcome, c.carries && d.carries && e.carries], ['succeeded', 'succeeded', 'succeeded', true], 'on: the sends complete and carry their directive');
    A.eq([c.history[0], d.history[0], e.history[0]], [seedLine(40), seedLine(40), seedLine(40)], 'on: the history opens on the 40-row mark at or before the sliding start (row 40)');
    A.eq([c.history.length, d.history.length, e.history.length], [154, 156, 158], 'on: every row from the mark to the directive (154, 156, 158 of history), never fewer than the 119 off sends');
    A.ok(prefixOf(c, d) && prefixOf(d, e), 'on: between two marks a request\'s history is a byte prefix of the next request\'s');
    A.eq([d.history[c.history.length], d.history[c.history.length + 1].slice(0, 22)], ['user:ON_ASK_ONE', 'assistant:STEP_REPLY_3'], 'on: and what follows it is the exchange just finished');
    A.ok(c.note && c.note === d.note && d.note === e.note, 'on: between two marks the earlier-conversation note is the same bytes');
    A.ok(c.note.includes(seedText(38).slice(0, 60)) && !c.note.includes(seedText(40).slice(0, 60)), 'on: the note carries the rows before the mark (row 38) and not the window\'s own (row 40)');
    A.eq(c.history.slice(-119), c.posted, 'on: the 119 posted rows ride as posted, after the station\'s rows');
    A.eq([c.boundary, a.boundary], [false, true], 'on: a mark is a Commander message, so the request needs no host boundary turn in front (off opened on a reply and got one)');
    const added = c.history.length - 119;
    A.eq([c.step && c.step.rows, d.step && d.step.rows, e.step && e.step.rows], [added, added + 2, added + 4], 'on: run start names the rows the step put in front (35, 37, 39)');
    const want = Gauge.estimateMessages(Array.from({ length: added }, (_, i) => ({ role: (40 + i) % 2 ? 'assistant' : 'user', content: seedText(40 + i) })));
    A.eq(c.step && c.step.delta, want, 'on: and their dialogue tokens by the page\'s own ruler');
    const f = await send('ON_ASK_FOUR'), g = await send('ON_ASK_FIVE');   // 201, 203 rows: the mark moves to 80
    A.eq([f.history[0], g.history[0], f.history.length, g.history.length], [seedLine(80), seedLine(80), 120, 122], 'on: crossing a mark moves the start 40 rows once (row 80: 120, then 122 rows of history)');
    A.ok(!prefixOf(e, f) && prefixOf(f, g) && f.note !== e.note && f.note === g.note, 'on: that one send rewrites the history and the note; the next opens on its bytes again');
  } finally { await fx.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  A.report('window-step.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
