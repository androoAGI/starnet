/* node dev/native-defer-check.js [model] -- W2.4 NATIVE DEFERRAL on the REAL Anthropic API. It spends real money (four
   short requests, about a dime on claude-opus-5-5, the default model): a person runs it, an agent never does. An agent
   may run  node dev/native-defer-check.js --dry  which builds and prints the same four requests and sends nothing.

   WHAT ONLY A REAL CALL CAN ANSWER (test/native-defer.invariant.test.js proves the rest against the documented rules):
     1. ACCEPTED    the API takes `defer_loading: true` on a tool and a `tool_reference` block inside a client
                    tool_result, with the headers this adapter sends (no beta header for them). A refusal is the
                    adapter's own fallback firing (it prints the API's words) and this check says FAIL.
     2. CALLABLE    after a reveal sent as a reference, the model calls the revealed tool.
     3. NOT BILLED  declaring deferred tools up front adds no prompt tokens (the first request of each arm is the same
                    prompt; only the declarations differ).
     4. CACHE       the request after a reveal reads the prompt cache with the switch on, and re-writes it with the
                    switch off (the provider's own usage: cache read and cache write tokens).

   Both arms go through the REAL adapter (sidecar/providers/anthropic.js), exactly as the loop calls it: `off` sends
   what the loop sends today (the revealed definition appended to tools), `on` adds the loop's nativeDefer field. Each
   arm's system prompt opens with its own nonce, so the arms never share a cached prefix.

   KEY: ONLY from the environment variable STARNET_NATIVE_DEFER_KEY (an Anthropic API key). It is read once and deleted
   from process.env; it goes to the adapter in memory and to POST https://api.anthropic.com/v1/messages, nowhere else
   (the adapter's model-list read is answered locally). It is never printed, logged or written. */
'use strict';
const path = require('path');
const Anthropic = require(path.join(__dirname, '..', 'sidecar', 'providers', 'anthropic.js'));

const DRY = process.argv.indexOf('--dry') >= 0;
const MODEL = process.argv.slice(2).find(a => a.indexOf('--') !== 0) || 'claude-opus-5-5';
const KEY = DRY ? '' : String(process.env.STARNET_NATIVE_DEFER_KEY || '').trim();
delete process.env.STARNET_NATIVE_DEFER_KEY;
if (!DRY && !KEY) { console.log('Set STARNET_NATIVE_DEFER_KEY to an Anthropic API key (or pass --dry to send nothing).'); process.exit(2); }

const NL = String.fromCharCode(10);
const fn = (name, description, arg) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: { [arg]: { type: 'string' } }, required: [arg] } } });
const CORE = [fn('fs_read', 'Read a file in the workspace.', 'path'), fn('tool_search', 'Find a granted tool that is not listed yet. Call it before saying a tool is missing.', 'query')];
const DEFERRED = [fn('page_screenshot', 'Capture a screenshot of the current page as an image.', 'name'), fn('page_upload', 'Attach a local file to a file input on the page.', 'path')];
// long enough to be cached on every model (the largest documented minimum is 4096 tokens)
const standing = () => { let s = ''; for (let i = 0; s.length < 26000; i++) s += 'Standing order ' + i + ': keep the Commander informed, cite what you read, and never guess a file\'s contents.' + NL; return s; };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function requests(arm) {
  const prefix = 'Native deferral check ' + arm + ' ' + Date.now().toString(36) + '. You are a station agent.' + NL + standing();
  const system = { role: 'system', content: prefix + NL + NL + '[HARNESS] These exist and you CAN use them (load one with tool_search first): page_screenshot, page_upload.' };
  const first = [system, { role: 'user', content: 'Read notes.txt, then take a screenshot of the page and name it "after".' },
    { role: 'assistant', content: '', tool_calls: [call('toolu_check_1', 'fs_read', { path: 'notes.txt' })] },
    { role: 'tool', tool_call_id: 'toolu_check_1', content: 'notes.txt: the page is loaded and ready.' }];
  const afterReveal = first.concat([
    { role: 'assistant', content: '', tool_calls: [call('toolu_check_2', 'tool_search', { query: 'screenshot' })] },
    { role: 'tool', tool_call_id: 'toolu_check_2', content: 'Now available to call for the rest of this run:' + NL + '- page_screenshot (name): Capture a screenshot of the current page as an image.' }]);
  const base = { model: MODEL, cacheSystemPrefix: prefix, maxTokens: 1024 };
  const on = arm === 'on';
  return [
    Object.assign({}, base, { messages: first, tools: CORE }, on ? { nativeDefer: { deferred: DEFERRED, reveals: [] } } : {}),
    // the loop appends the revealed definition to `tools` on every route; with the switch on it also says which result revealed it
    Object.assign({}, base, { messages: afterReveal, tools: CORE.concat([DEFERRED[0]]) }, on ? { nativeDefer: { deferred: DEFERRED, reveals: [{ id: 'toolu_check_2', names: ['page_screenshot'] }] } } : {})
  ];
}

const sent = [];
async function wire(url, init) {
  const u = String(url), method = String((init && init.method) || 'GET').toUpperCase();
  if (method !== 'POST' || u !== 'https://api.anthropic.com/v1/messages') return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  const headers = Object.assign({}, init.headers);
  delete headers['x-api-key'];
  sent.push({ headers, body: JSON.parse(init.body) });
  if (!DRY) return fetch(u, init);
  const sse = [{ type: 'message_start', message: { id: 'msg_dry', usage: { input_tokens: 0, output_tokens: 0 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }, { type: 'message_stop' }];
  return new Response(sse.map(e => 'data: ' + JSON.stringify(e)).join(NL + NL) + NL + NL, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function send(provider, req) {
  const out = { calls: [], prompt: 0, read: 0, write: 0, error: '' };
  try {
    for await (const ev of provider.stream(Object.assign({ preStreamRetries: 0 }, req))) {
      if (ev.type === 'tool_start') out.calls.push(ev.name);
      if (ev.type === 'usage' && ev.usage) {
        const d = ev.usage.prompt_tokens_details || {};
        out.prompt = Number(ev.usage.prompt_tokens) || out.prompt;
        out.read = Number(d.cached_tokens) || out.read;
        out.write = Number(d.cache_creation_tokens) || out.write;
      }
    }
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 300); }
  return out;
}

(async () => {
  const provider = Anthropic.makeAnthropicProvider({ fetch: wire, key: KEY || 'dry-run', reasoningEffort: 'medium' });
  if (!provider.nativeDefer(MODEL)) { console.log(MODEL + ' is not on the adapter\'s support list: it takes the old path, and there is nothing to check.'); process.exit(2); }
  const res = {};
  for (const arm of ['on', 'off']) {
    const [first, afterReveal] = requests(arm);
    res[arm] = { first: await send(provider, first), after: await send(provider, afterReveal) };
  }
  const shape = b => ({ tools: (b.tools || []).map(t => t.name + (t.defer_loading ? ' (defer_loading)' : '') + (t.cache_control ? ' (cache anchor)' : '')),
    references: JSON.stringify(b.messages).split('"tool_reference"').length - 1 });
  console.log('model ' + MODEL + (DRY ? ' (dry run: nothing was sent)' : ''));
  sent.forEach((s, i) => console.log('request ' + (i + 1) + ' [' + (i < 2 ? 'on' : 'off') + (i % 2 ? ', after the reveal' : ', first') + '] anthropic-beta: ' + (s.headers['anthropic-beta'] || '(none)') + ' ' + JSON.stringify(shape(s.body))));
  if (DRY) { process.exit(0); }
  for (const arm of ['on', 'off']) for (const k of ['first', 'after']) {
    const r = res[arm][k];
    console.log(arm + ' ' + (k === 'first' ? 'first request     ' : 'after the reveal  ') + ': prompt ' + r.prompt + ' tokens, cache read ' + r.read + ', cache write ' + r.write + ', called ' + JSON.stringify(r.calls) + (r.error ? ', ERROR ' + r.error : ''));
  }
  const on = res.on, off = res.off;
  const refused = Anthropic._internals.deferRefused.size > 0;
  const verdicts = [
    ['1 ACCEPTED   (no refusal, no error)', !refused && !on.first.error && !on.after.error],
    ['2 CALLABLE   (the model called page_screenshot after the reveal)', !refused && on.after.calls.indexOf('page_screenshot') >= 0],
    ['3 NOT BILLED (first request: ' + on.first.prompt + ' prompt tokens on, ' + off.first.prompt + ' off)', !refused && on.first.prompt > 0 && Math.abs(on.first.prompt - off.first.prompt) <= 60],
    ['4 CACHE      (after the reveal: read ' + on.after.read + ' / wrote ' + on.after.write + ' on, read ' + off.after.read + ' / wrote ' + off.after.write + ' off)', !refused && on.after.read > 0 && on.after.write < off.after.write]
  ];
  for (const [what, ok] of verdicts) console.log((ok ? 'PASS ' : 'FAIL ') + what);
  if (refused) console.log('The API refused the fields; the adapter fell back to the old path (its words are in the [failopen] line above).');
  process.exit(verdicts.every(v => v[1]) ? 0 : 1);
})().catch(e => { console.log('THREW', (e && e.stack) || e); process.exit(1); });
