/* node test/loop.truncated-args-refuse.test.js — a tool call whose arguments were CUT OFF mid-value never runs.

   Audit probe (2026-09-22): fs_write args '{"path":"src/app.js","content":"function main() {\n  initDatabase();\n  startServ'
   arrived with finish_reason 'tool_calls' (routers rewrite length -> tool_calls; streams can be cut). The repair
   ladder closed the dangling string, the call validated, and a 47-char truncated file was written while the run
   ended 'done'. This pins the fix: a repair that had to CLOSE AN OPEN STRING is refused — run() is never called,
   the model is told the call was NOT executed and must be reissued complete, no tool.args.repaired is claimed —
   while harmless structural truncation (a missing closing brace) still repairs and runs exactly as before.
   Scripted provider, no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const sanitize = require('../sidecar/providers/sanitize.js');

const priceOf = () => ({ in: 1, out: 2 });
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const READ_SCHEMA = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, limit: { type: 'number' } } };
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));
const TRUNCATED = '{"path":"src/app.js","content":"function main() {\\n  initDatabase();\\n  startServ';
const COMPLETE = '{"path":"src/app.js","content":"function main() {\\n  initDatabase();\\n  startServer();\\n}\\n"}';

function scripted(turns, inspect) {
  let calls = 0;
  return {
    async *stream(req) {
      const index = calls++;
      if (inspect) inspect(req, index);
      const turn = turns[index] || [{ type: 'done', finishReason: 'stop' }];
      for (const ev of turn) yield ev;
    },
    priceOf, contextLimit: () => 8000, callCount: () => calls
  };
}
const call = (id, name, args, finishReason) => [
  { type: 'tool_start', index: 0, id, name }, { type: 'tool_args', index: 0, chunk: args }, { type: 'done', finishReason: finishReason || 'tool_calls' }
];
const say = (text) => [{ type: 'text', delta: text }, { type: 'done', finishReason: 'stop' }];

// Every assistant tool_call id is answered by exactly one tool message, and every tool message answers a call.
function pairedTranscript(messages) {
  const open = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) open.set(tc.id, (open.get(tc.id) || 0) + 1);
    if (m.role === 'tool') {
      if (!open.get(m.tool_call_id)) return false;
      open.set(m.tool_call_id, open.get(m.tool_call_id) - 1);
    }
  }
  return Array.from(open.values()).every(n => n === 0);
}

async function run(turns, reg, tools) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  const requests = [];
  const provider = scripted(turns, (req) => requests.push(req.messages.map(m => Object.assign({}, m))));
  const messages = [{ role: 'user', content: 'write the server entrypoint' }];
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf }), model: 'm', agentId: 'a', runId: 'r',
    tools: tools || toolDefs('fs_write', 'fs_read'), limits: { maxIters: 6, grace: false, verifyOnStop: false },
    dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx()
  });
  return { res, seq, messages, requests };
}

(async () => {
  // ---- 1. the pure seam: the detailed repair reports a closed string; the old contract is unchanged ----
  {
    const d = sanitize.repairToolCallArgumentsDetailed(TRUNCATED);
    A.eq(d.closedOpenString, true, 'a value cut off inside its string is reported as closedOpenString');
    A.notThrows(() => JSON.parse(d.text), 'the repaired text still parses (the refusal is the caller\'s decision)');
    A.eq(sanitize.repairToolCallArguments(TRUNCATED), d.text, 'the string-returning export is byte-identical to the detailed text');
    A.eq(sanitize.repairToolCallArgumentsDetailed('{"path":"a.txt","limit":10').closedOpenString, false, 'a missing closing brace loses no value');
    A.eq(sanitize.repairToolCallArgumentsDetailed('{"a":1,}').closedOpenString, false, 'a trailing comma loses no value');
    A.eq(sanitize.repairToolCallArgumentsDetailed('{"k":"line1\nline2"}').closedOpenString, false, 'escaping a raw newline in a CLOSED string loses no value');
    A.eq(sanitize.repairToolCallArgumentsDetailed('{"k":"a\tb","c":"cut').closedOpenString, true, 'the composed pass closing a string is still a cut-off value');
    A.eq(sanitize.repairToolCallArgumentsDetailed('not json').closedOpenString, false, 'an unrepairable payload never claims a closed string');
  }

  // ---- 2. THE AUDIT PROBE: truncated write + finish_reason tool_calls -> never executed, model told to reissue ----
  {
    const writes = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => { writes.push(a); return 'wrote ' + a.path + ' (' + a.content.length + ' chars)'; } });
    const { res, seq, messages, requests } = await run([
      call('w1', 'fs_write', TRUNCATED, 'tool_calls'),
      call('w2', 'fs_write', COMPLETE, 'tool_calls'),
      say('Wrote the complete entrypoint.')
    ], reg);
    A.eq(writes.length, 1, 'only the complete reissued write executed — the truncated one never reached run()');
    A.eq(writes[0] && writes[0].content, 'function main() {\n  initDatabase();\n  startServer();\n}\n', 'the file body written is the complete one');
    A.eq(seq.filter(e => e.name === 'tool.args.repaired').length, 0, 'a refused call is never announced as repaired');
    const first = seq.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'w1');
    A.ok(first && first.payload.isError === true && first.payload.ok === false, 'the truncated call is reported as an error result, never a success');
    const toolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'w1');
    A.ok(toolMsg && /cut off mid-value/.test(toolMsg.content), 'the tool result says the arguments were cut off');
    A.ok(toolMsg && /NOT executed/.test(toolMsg.content), 'the tool result says the call was NOT executed');
    A.ok(toolMsg && /Reissue the complete call/.test(toolMsg.content), 'the tool result tells the model to reissue the complete call');
    A.ok(requests[1] && requests[1].some(m => m.role === 'tool' && /NOT executed/.test(String(m.content))), 'the NEXT model request actually carries the refusal');
    A.ok(pairedTranscript(messages), 'the transcript stays provider-valid (every call answered exactly once)');
    A.eq(res.reason, 'done', 'the run completes on the reissued call');
  }

  // ---- 3. same cut with NO finish reason (a stream cut clean) and with 'stop' — refused either way ----
  for (const fr of [undefined, 'stop']) {
    const writes = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => { writes.push(a); return 'wrote'; } });
    const turns = [
      [{ type: 'tool_start', index: 0, id: 'w1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: TRUNCATED }, { type: 'done', finishReason: fr }],
      say('I could not finish the write.')
    ];
    const { messages } = await run(turns, reg);
    A.eq(writes.length, 0, 'finishReason ' + String(fr) + ': the truncated write never executes');
    const toolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === 'w1');
    A.ok(toolMsg && /NOT executed/.test(toolMsg.content), 'finishReason ' + String(fr) + ': the refusal reaches the model');
  }

  // ---- 4. HARMLESS STRUCTURAL TRUNCATION STILL REPAIRS: a read missing only its closing brace runs ----
  {
    const reads = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_read', schema: READ_SCHEMA, run: async (a) => { reads.push(a); return 'line1\nline2'; } });
    const { seq, messages, res } = await run([call('r1', 'fs_read', '{"path":"a.txt","limit":10'), say('Read it.')], reg);
    A.eq(reads.length, 1, 'the structurally-truncated read still runs');
    A.eq(reads[0], { path: 'a.txt', limit: 10 }, 'with exactly the arguments the model sent');
    const rep = seq.filter(e => e.name === 'tool.args.repaired');
    A.eq(rep.length, 1, 'and it is announced as repaired (unchanged behavior)');
    const asst = messages.find(m => m.role === 'assistant' && m.tool_calls);
    A.notThrows(() => JSON.parse(asst.tool_calls[0].function.arguments), 'the replayed assistant arguments are the repaired valid JSON');
    A.eq(res.reason, 'done', 'the run completes');
  }

  // ---- 5. A REPAIR NEVER REWRITES THE FILE BODY: a real trailing comma after the last arg, commas inside the value ----
  {
    const writes = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => { writes.push(a); return 'wrote'; } });
    const body = 'const parts = s.split(/[\\s,]+/);\nconst cells = row.match(/[^,]+/g);\nconst xs = [1, 2, 3,];\n';
    const broken = '{"path":"src/split.js","content":' + JSON.stringify(body) + ',}';
    const { seq, messages, res } = await run([call('s1', 'fs_write', broken), say('Wrote it.')], reg);
    A.eq(writes.length, 1, 'the write with a trailing comma after its last arg is repaired and runs');
    A.eq(writes[0] && writes[0].content, body, 'the file body written is byte-identical to what the model sent');
    A.eq(seq.filter(e => e.name === 'tool.args.repaired').length, 1, 'it is announced as repaired');
    const asst = messages.find(m => m.role === 'assistant' && m.tool_calls);
    A.eq(JSON.parse(asst.tool_calls[0].function.arguments).content, body, 'the replayed assistant arguments carry the same body');
    A.eq(res.reason, 'done', 'the run completes');
  }

  A.report('loop.truncated-args-refuse.test');
})().catch(e => { console.log('FAIL: loop.truncated-args-refuse.test threw -- ' + (e && e.stack || e)); process.exit(1); });
