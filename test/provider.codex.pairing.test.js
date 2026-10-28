/* node test/provider.codex.pairing.test.js — the Codex (Responses) wire never sends an unpaired tool call or result.
   The Responses backend 400-rejects a request whose input holds a function_call_output with no matching
   function_call ("No tool call found for function call output with call_id …") or a call with no output.
   A transcript that lost one side of a pair (restart/resume/compaction seam) used to replay the orphan on
   EVERY later turn — the chat was permanently bricked (reported live from a Telegram user, call_recovered_3).

   The wire used to keep a second pairing pass of its own inside messagesToInput; the provider-conformance-suite lane
   (2026-10-27) deleted it, because the one shared pre-send pass (provider.js prepareWireMessages -> repairToolPairs)
   runs first on every request. So these cases now drive the WHOLE wire — makeCodexProvider with an injected fetch,
   the request body it actually sends — and pin the same invariants: every function_call in the built input has
   exactly one matching function_call_output and vice versa, with no information silently dropped. Zero network. */
'use strict';
const A = require('./_assert.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');

const sse = lines => new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
// the input items the Codex wire sends for `messages` (a system prompt leads, as every run's request does)
async function wireInput(messages) {
  let body = null;
  const p = makeCodexProvider({ token: 't', fetch: async (url, init) => {
    body = JSON.parse(init.body);
    return sse(['data: ' + JSON.stringify({ type: 'response.completed', response: {} })]);
  } });
  for await (const _ of p.stream({ model: 'gpt-5.5', messages: [{ role: 'system', content: 'SYS' }].concat(messages) })) { /* drain */ }
  return body.input;
}

function pairingHolds(input) {
  const calls = new Map(), outs = new Map();
  for (const it of input) {
    if (it && it.type === 'function_call') calls.set(it.call_id, (calls.get(it.call_id) || 0) + 1);
    if (it && it.type === 'function_call_output') outs.set(it.call_id, (outs.get(it.call_id) || 0) + 1);
  }
  if (calls.size !== outs.size) return false;
  for (const [id, n] of calls) if (n !== 1 || outs.get(id) !== 1 || !id) return false;
  // and every output comes AFTER its call
  const seen = new Set();
  for (const it of input) {
    if (it && it.type === 'function_call') seen.add(it.call_id);
    if (it && it.type === 'function_call_output' && !seen.has(it.call_id)) return false;
  }
  return true;
}
const userText = it => (it && it.role === 'user' && Array.isArray(it.content)) ? it.content.map(p => p.text || '').join('') : '';

(async () => {
  // A. a well-formed transcript passes through unchanged (the repair is inert on healthy history)
  {
    const input = await wireInput([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { name: 'web_search', arguments: '{"q":1}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'result body' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'thanks' }
    ]);
    A.eq(input[1], { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"q":1}' }, 'healthy call unchanged');
    A.eq(input[2], { type: 'function_call_output', call_id: 'call_1', output: 'result body' }, 'healthy result unchanged');
    A.ok(pairingHolds(input), 'healthy transcript pairs');
  }

  // B. THE REPORTED BUG: an orphaned tool result (its call lost from the transcript) must never become a
  //    function_call_output — it is downgraded to a labeled user message, content preserved.
  {
    const input = await wireInput([
      { role: 'user', content: 'continue' },
      { role: 'tool', tool_call_id: 'call_recovered_3', content: 'the orphaned body' }
    ]);
    A.ok(!input.some(it => it.type === 'function_call_output'), 'orphan result emits NO function_call_output');
    const down = input.find(it => /call_recovered_3/.test(userText(it)));
    A.ok(down, 'orphan downgraded to a labeled user message naming the call id');
    A.ok(/recovered tool result/.test(userText(down)) && /the orphaned body/.test(userText(down)), 'orphan labelled as recovered, content preserved');
    A.ok(pairingHolds(input), 'orphaned-result transcript pairs');
  }

  // C. the reverse orphan: an assistant call whose result never landed gets a synthesized output right after it
  {
    const input = await wireInput([
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_lost', function: { name: 'fs_read', arguments: '{}' } }] },
      { role: 'user', content: 'still there?' }
    ]);
    const ci = input.findIndex(it => it.type === 'function_call' && it.call_id === 'call_lost');
    A.ok(ci >= 0, 'the unanswered call is kept');
    A.eq(input[ci + 1] && input[ci + 1].type, 'function_call_output', 'synthesized output directly after the call');
    A.ok(/no recorded result/.test(input[ci + 1].output), 'synthesized output states the truth');
    A.ok(pairingHolds(input), 'unanswered-call transcript pairs');
  }

  // D. a duplicate result for an already-answered call is downgraded, not double-paired
  {
    const input = await wireInput([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_9', content: 'first' },
      { role: 'tool', tool_call_id: 'call_9', content: 'second (duplicate)' }
    ]);
    A.eq(input.filter(it => it.type === 'function_call_output').length, 1, 'exactly one output for the call');
    A.ok(input.some(it => /second \(duplicate\)/.test(userText(it))), 'duplicate preserved as user text');
    A.ok(pairingHolds(input), 'duplicate-result transcript pairs');
  }

  // E. an assistant tool_call that arrived with NO id gets a deterministic minted id — never an empty call_id
  {
    const input = await wireInput([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'noop', arguments: '{}' } }] }
    ]);
    const call = input.find(it => it.type === 'function_call');
    A.eq(call.call_id, 'call_local_1', 'empty id minted deterministically');
    A.ok(pairingHolds(input), 'minted-id transcript pairs');
  }

  // F. parallel calls with interleaved results still pair (open-map, not adjacency)
  {
    const input = await wireInput([
      { role: 'user', content: 'both' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', function: { name: 't1', arguments: '{}' } },
        { id: 'b', function: { name: 't2', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'b', content: 'B' },
      { role: 'tool', tool_call_id: 'a', content: 'A' }
    ]);
    A.ok(pairingHolds(input), 'parallel interleaved results pair');
    A.eq(input.filter(it => it.type === 'function_call_output').length, 2, 'both outputs kept as real outputs');
  }

  A.report('provider.codex.pairing.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
