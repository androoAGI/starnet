/* node test/loop.credential-live.test.js — a run in flight stops sending a key that was removed or replaced on the station, at
   its next call (credential-store lane, step S3; decision 7; family B1, credential sources).

   THE BUG. A run resolves its keys as it starts and builds one provider adapter on each: its primary, every backup key it may
   rotate onto, every provider fallback (index.js runOnceCore). The loop sent every later call on those adapters and re-checked
   only spend before each attempt (loop.js stopForSpend), never the credential. So a key the Commander removed or rotated
   under SETTINGS → AI & MODELS, or a browser page removed or replaced, kept billing for the rest of a long run: every later
   turn, a retry, a rotation, a fallback and a compaction fold went out on it.

   THE FIX. The loop asks o.credentialGone(adapter), with the adapter about to be called, before every call: at the top of each
   turn and of each attempt, beside the spend stop (the first call, a retry, a credential rotation, a model or provider
   fallback), before a paid compaction fold, and before the compress recovery folds. '' = still held; a sentence = the run ends
   'error' with it before the request goes out (shared/events.js unchanged). A stream already running finishes its tokens.
   index.js answers from the credential store's inFlight() watch (sidecar/credential-store.js): a key a station layer held as
   the run resolved it, and its caller did not send in this request, is watched, and holds() says whether any layer — the
   keychain, the environment, the page copy — still holds it, as a key or in a pool.

   WHY THE ADAPTER, NOT A (provider, credKey) PAIR: the loop's activeCredKey is not always the key the next call sends. A model
   fallback after a rotation goes back to the PRIMARY adapter while activeCredKey still names the rotation key (row 4), and a
   keyless provider fallback leaves the previous key there (row 5). The adapter the loop is about to call is the key it sends.

   A — the loop, each provider faked at its stream edge (red at a3af8dafd, whose loop ignores the option):
     1. the primary's key is removed MID-STREAM: that stream finishes every token, its tool runs, turn 2 never goes out, and the
        run ends 'error' with the sentence (agent.run.error, failureStage 'credential')
     2. a rotation onto a backup key that is gone never goes out; a held one does
     3. a provider fallback whose key is gone never goes out
     4. a model fallback after a rotation goes back to the primary adapter, whose key is gone: asked about THAT adapter
     5. a keyless provider fallback after the primary's key went: it sends no key, so it runs (no false stop)
     6. a retry whose key is removed during its backoff never goes out
     7. a paid compaction fold on a fallback whose key is gone: the summarizer is never called
     8. a context overflow whose key is gone: no fold, no failover, the run ends with the sentence
     9. guards: no option = every call goes out as before; a check that throws reads as held
   B — the credential store, loaded after A so a tree without it reports instead of stopping:
     10. holds() over every layer, and what ends it
     11. inFlight() + runAgentLoop over a real store and the real page copy (engine-credential.js): a page REMOVE, a keychain
         REMOVE, a rotation and a cleared pool stop the run at its next call; a body key (sentByCaller) and a channel's own key
         are never stopped; a key held as the run resolved it but removed before its adapter was built stops the first call
   C — index.js wires it: every keyed adapter runOnceCore builds is watched (a census of selectProvider({ key })), the loop is
       handed credentialGone, the aux vision call asks too, and the post-run passes on the run's adapter are skipped. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeContext } = require('../sidecar/context.js');
const EC = require('../sidecar/engine-credential.js');
const Reg = require('../sidecar/providers/registry.js');
const { readSidecarSource, functionSourceIn, sidecarTopLevelFunction } = require('./helpers/source.js');

const priceOf = () => ({ in: 1, out: 2 });
const cost = () => makeCostEngine({ priceOf });
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
// a provider adapter faked at its stream edge: `key` is the key it sends (none = keyless); every call is logged by name
function adapter(name, key, calls, script, window) {
  let n = 0;
  return { name, key, priceOf, contextLimit: () => window || 0, stream: (req) => { n++; calls.push(name); return script(n, req); } };
}
const said = key => 'the key ' + key + ' was removed or replaced';
// the host's answer, as index.js gives it: '' while the adapter's key is held (or it sends none), else the sentence
const goneFrom = held => a => (a && a.key && !held.has(a.key)) ? said(a.key) : '';
const tokens = seq => seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
const errors = seq => seq.filter(e => e.name === 'agent.run.error').map(e => e.payload.message);
const ends = seq => seq.filter(e => e.name === 'agent.run.end').map(e => e.payload.reason);
const stoppedFor = (res, seq, key, label) => {
  A.eq([res.reason, res.failureStage, res.failureCode], ['error', 'credential', 'credential_removed'], label + ': the run ends error, at the credential stage');
  A.eq(errors(seq), [said(key)], label + ': one agent.run.error carries the host\'s sentence');
  A.eq(ends(seq), ['error'], label + ': one run end, reason error (shared/events.js unchanged)');
};
const textTurn = text => async function* () { yield { type: 'text', delta: text }; yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }; yield { type: 'done', finishReason: 'stop' }; };
const rateLimited = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });
const overloaded = () => new Error('Our servers are currently overloaded. Please try again later.');
const timedOut = () => Object.assign(new Error('provider stream idle timed out after 120000ms'), { code: 'PROVIDER_STREAM_TIMEOUT' });
const tooLong = () => new Error('prompt is too long: 215000 tokens > 200000 maximum');
// a history long enough that a small window wants it folded, and with turns old enough to fold
const LONG = [{ role: 'user', content: 'the task' }];
for (let i = 0; i < 8; i++) LONG.push({ role: 'assistant', content: 'progress note ' + i + ' ' + 'x'.repeat(600) }, { role: 'user', content: 'go on ' + i + ' ' + 'y'.repeat(600) });

(async () => {
  /* ================= A. the loop ================= */

  // 1. the key goes while turn 1 streams: the stream finishes, its tool runs, and turn 2 never goes out
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP']), ran = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'look', schema: { type: 'object', properties: {} }, run: async () => { ran.push('look'); return 'looked'; } });
    const P = adapter('P', 'KP', calls, async function* (n) {
      if (n > 1) { yield { type: 'text', delta: 'TURN TWO WENT OUT' }; yield { type: 'done', finishReason: 'stop' }; return; }
      yield { type: 'text', delta: 'first half, ' };
      held.delete('KP');   // removed in Settings while this stream runs
      yield { type: 'text', delta: 'second half' };
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'look' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } };
      yield { type: 'done', finishReason: 'tool_calls' };
    });
    const hooked = [];
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r1',
      tools: [], dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), clock: { now: () => Date.now() }, limits: { maxIters: 5 },
      hooks: { invoke: async (name) => { hooked.push(name); return null; } }, credKey: 'KP', credentialGone: goneFrom(held) });
    A.eq(calls, ['P'], '1: turn 2 never goes out on the removed key');
    A.eq(tokens(seq), 'first half, second half', '1: the stream that was running when the key went finished every token (never cut mid-stream)');
    A.eq(ran, ['look'], '1: its tool call ran: the turn completed');
    stoppedFor(res, seq, 'KP', '1');
    A.eq([res.turns, hooked.filter(h => h === 'pre_llm_call').length], [1, 1], '1: it stops at the top of turn 2, like the spend stop: the turn that never went out is not counted, nor announced to a pre_llm_call hook');
    A.ok(res.messages.some(m => m.role === 'tool' && /looked/.test(String(m.content))), '1: the finished turn and its tool result stay in the run\'s messages');
  }

  // 2. a credential rotation onto a backup key that is gone never goes out (and one that is still held does)
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP']);   // the backup KR was removed before the run reached it
    const P = adapter('P', 'KP', calls, async function* () { throw rateLimited(); });
    const R = adapter('R', 'KR', calls, textTurn('rotated'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r2',
      credKey: 'KP', fallbacks: [{ provider: R, model: 'm', credKey: 'KR' }], credentialGone: goneFrom(held), sleep: async () => {} });
    A.eq(calls, ['P'], '2: the rotation onto the removed backup key never goes out');
    stoppedFor(res, seq, 'KR', '2');
    const ok = setup(), calls2 = [];
    const P2 = adapter('P', 'KP', calls2, async function* () { throw rateLimited(); });
    const R2 = adapter('R', 'KR', calls2, textTurn('rotated'));
    const res2 = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P2, emit: ok.emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r2b',
      credKey: 'KP', fallbacks: [{ provider: R2, model: 'm', credKey: 'KR' }], credentialGone: goneFrom(new Set(['KP', 'KR'])), sleep: async () => {} });
    A.eq([calls2, res2.reason, errors(ok.seq)], [['P', 'R'], 'done', []], '2: a rotation onto a backup key that is still held goes out as before');
  }

  // 3. a provider fallback whose key is gone never goes out
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP', 'KF']);
    const P = adapter('P', 'KP', calls, async function* () { held.delete('KF'); throw overloaded(); });
    const F = adapter('F', 'KF', calls, textTurn('fallback served'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r3',
      credKey: 'KP', fallbacks: [{ provider: F, providerId: 'other', model: 'fm', credKey: 'KF' }], credentialGone: goneFrom(held), sleep: async () => {} });
    A.eq(calls, ['P'], '3: the provider fallback on a removed key never goes out');
    stoppedFor(res, seq, 'KF', '3');
  }

  // 4. a model fallback after a rotation is the PRIMARY adapter again: the check asks about it, whatever activeCredKey says
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP', 'KR']), outgoing = [];
    const P = adapter('P', 'KP', calls, async function* () { throw rateLimited(); });
    const R = adapter('R', 'KR', calls, async function* () { held.delete('KP'); throw rateLimited(); });   // the primary's key goes now
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r4',
      credKey: 'KP', fallbacks: [{ provider: R, model: 'm', credKey: 'KR' }, { provider: P, model: 'm2' }],
      onFallback: ({ credKey }) => outgoing.push(credKey), credentialGone: goneFrom(held), sleep: async () => {} });
    A.eq(calls, ['P', 'R'], '4: the model fallback, back on the primary adapter, never goes out on its removed key');
    A.eq(outgoing, ['KP', 'KR'], '4: (the loop\'s live credKey was the rotation key KR, which is still held: a check on it would have let KP go out)');
    stoppedFor(res, seq, 'KP', '4');
  }

  // 5. a keyless provider fallback after the primary's key went sends no key: it runs (no false stop)
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP']);
    const P = adapter('P', 'KP', calls, async function* () { held.delete('KP'); throw overloaded(); });
    const L = adapter('L', '', calls, textTurn('the local server answered'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r5',
      credKey: 'KP', fallbacks: [{ provider: L, providerId: 'ollama', model: 'llama', credKey: null }], credentialGone: goneFrom(held), sleep: async () => {} });
    A.eq([calls, res.reason, errors(seq)], [['P', 'L'], 'done', []], '5: the keyless fallback runs although the loop\'s credKey still names the removed key');
  }

  // 6. a retry whose key is removed during its backoff never goes out
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP']);
    const P = adapter('P', 'KP', calls, async function* () { throw timedOut(); });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r6',
      credKey: 'KP', credentialGone: goneFrom(held), sleep: async () => { held.delete('KP'); } });
    A.eq(calls, ['P'], '6: the retry after the backoff never goes out on the key removed during it');
    stoppedFor(res, seq, 'KP', '6');
  }

  // 7. a paid compaction fold rides the adapter's key too: on a fallback whose key is gone, the summarizer is never called
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP', 'KF']), folded = [];
    const P = adapter('P', 'KP', calls, async function* () { held.delete('KF'); throw overloaded(); });
    const F = adapter('F', 'KF', calls, textTurn('fallback served'), 900);   // a small window: the fallback's preflight wants a fold
    const ctx = makeContext({ contextLimit: 200000, compactAt: 0.65, keepTail: 2 });
    const res = await runAgentLoop({ messages: LONG.slice(), provider: P, emit, cost: cost(), model: 'big', agentId: 'a', runId: 'r7', context: ctx,
      summarize: async (older, prev, live) => { folded.push(live && live.provider && live.provider.name); return 'folded'; },
      credKey: 'KP', fallbacks: [{ provider: F, providerId: 'other', model: 'small', credKey: 'KF' }], credentialGone: goneFrom(held), sleep: async () => {} });
    A.eq(folded, [], '7: no paid fold goes out on the fallback\'s removed key');
    A.eq(calls, ['P'], '7: ...and neither does its first call');
    stoppedFor(res, seq, 'KF', '7');
    // the same run with the fallback's key held does fold on it: the row above is not vacuous
    const ok = setup(), folded2 = [];
    const P2 = adapter('P', 'KP', [], async function* () { throw overloaded(); });
    const F2 = adapter('F', 'KF', [], textTurn('fallback served'), 900);
    await runAgentLoop({ messages: LONG.slice(), provider: P2, emit: ok.emit, cost: cost(), model: 'big', agentId: 'a', runId: 'r7b', context: makeContext({ contextLimit: 200000, compactAt: 0.65, keepTail: 2 }),
      summarize: async (older, prev, live) => { folded2.push(live && live.provider && live.provider.name); return 'folded'; },
      credKey: 'KP', fallbacks: [{ provider: F2, providerId: 'other', model: 'small', credKey: 'KF' }], credentialGone: goneFrom(new Set(['KP', 'KF'])), sleep: async () => {} });
    A.ok(folded2.length >= 1 && folded2.every(n => n === 'F'), '7: with the key held the fallback\'s preflight folds on it (' + JSON.stringify(folded2) + ')');
  }

  // 8. a context overflow whose key is gone: no fold, no failover — the run ends with the sentence
  {
    const { seq, emit } = setup();
    const calls = [], held = new Set(['KP', 'KF']), folded = [];
    const P = adapter('P', 'KP', calls, async function* () { held.delete('KP'); throw tooLong(); });
    const F = adapter('F', 'KF', calls, textTurn('fallback served'));
    const res = await runAgentLoop({ messages: LONG.slice(), provider: P, emit, cost: cost(), model: 'big', agentId: 'a', runId: 'r8', context: makeContext({ contextLimit: 200000, compactAt: 0.65, keepTail: 2 }),
      summarize: async (older, prev, live) => { folded.push(live && live.provider && live.provider.name); return 'folded'; },
      credKey: 'KP', fallbacks: [{ provider: F, providerId: 'other', model: 'small', credKey: 'KF' }], credentialGone: goneFrom(held), sleep: async () => {} });
    A.eq([folded, calls, seq.filter(e => e.name === 'provider.fallback').length], [[], ['P'], 0], '8: the overflow neither folds nor fails over on the removed key');
    stoppedFor(res, seq, 'KP', '8');
  }

  // 9. guards: without the option every call goes out as before; a check that throws reads as held
  for (const [label, credentialGone] of [['no option', undefined], ['a throwing check', () => { throw new Error('store unreachable'); }]]) {
    const { seq, emit } = setup();
    const calls = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'look', schema: { type: 'object', properties: {} }, run: async () => 'looked' });
    const P = adapter('P', 'KP', calls, async function* (n) {
      if (n > 1) { yield { type: 'text', delta: 'second turn' }; yield { type: 'done', finishReason: 'stop' }; return; }
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'look' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'done', finishReason: 'tool_calls' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'go' }], provider: P, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r9',
      tools: [], dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), clock: { now: () => Date.now() }, limits: { maxIters: 5 }, credKey: 'KP', credentialGone });
    A.eq([calls, res.reason, errors(seq)], [['P', 'P'], 'done', []], '9 (' + label + '): every call goes out and the run ends done');
  }

  /* ================= B. the credential store (loaded now, so a tree without it reports above) ================= */
  let CS = null, G = null;
  try { CS = require('../sidecar/credential-store.js'); G = require('./helpers/credential-store-sandbox.js'); }
  catch (e) { A.ok(false, 'B: sidecar/credential-store.js loads (' + ((e && e.message) || e).split('\n')[0] + ')'); }
  if (CS && G && typeof (CS.makeCredentialStore && G.sandboxStore) === 'function') {
    // the env readers index.js uses (envFirst reads the bare name, then STARNET_, then SKYNET_), over a fixed environment
    const envReaders = env => {
      const text = readSidecarSource();
      const body = ['ENV', 'envFirstName', 'envFirst'].map(n => functionSourceIn(text, n)).join('\n');
      return new Function('process', "'use strict';\n" + body + '\nreturn { ENV, envFirstName, envFirst };')({ env });
    };
    // a station: the desktop keychain (pushed), the operator's environment, and the browser page's copy, the real one
    const station = () => {
      const env = { ANTHROPIC_API_KEY: 'en-ant', STARNET_KEY_POOL_ANTHROPIC: 'en-pool-1,en-pool-2', OPENROUTER_API_KEY: 'en-or' };
      const engineKeys = EC.makeEngineKeys({ load: () => ({ version: 1, providers: {
        custom: { key: 'pg-cu', keyPool: ['pg-cu-pool'], baseUrl: 'http://u.test/v1', rev: 'r1' }, mistral: { key: 'pg-mis', rev: 'r1' } } }),
        persist: () => true, verify: () => true, newRev: () => 'r2' });
      const store = G.sandboxStore(Object.assign({ engineKeys, runtimeKeys: { anthropic: 'kc-ant' }, runtimeKeyPools: { anthropic: ['kc-pool'] },
        resolveCreditsConfig: () => ({ url: 'http://cloud.test', apiKey: 'linked-token' }) }, envReaders(env)));
      return { store, engineKeys };
    };
    // the host's answer over the watch, as index.js builds it (runKeyGone: engineCredentialError's in-flight form)
    const goneVia = w => a => {
      const id = w.gone(a);
      if (!id) return '';
      const p = Reg.getProviderProfile(id);
      return EC.credentialError({ id, label: p.label, kind: 'removed', what: 'this run', env: (p.keyEnv || []).find(n => /_API_KEY$/.test(n)) || (p.keyEnv || [])[0] || '' });
    };

    // 10. holds(): each layer's key and pool entry; never anything else; and what ends it
    {
      const { store, engineKeys } = station();
      const H = (p, k) => store.holds(p, k);
      A.eq([H('anthropic', 'kc-ant'), H('anthropic', 'kc-pool'), H('anthropic', 'en-ant'), H('anthropic', 'en-pool-2'), H('custom', 'pg-cu'), H('custom', 'pg-cu-pool'), H('claude', 'kc-ant')],
        [true, true, true, true, true, true, true], '10: the keychain\'s, the environment\'s and the page copy\'s keys and pool entries are held (an alias names its provider)');
      A.eq([H('openai', 'kc-ant'), H('custom', 'en-ant'), H('nonesuch', 'kc-ant'), H('starnet', 'linked-token'), H('codex', 'kc-ant'), H('grok', 'kc-ant'), H('anthropic', ''), H('anthropic', 'stranger')],
        [false, false, false, false, false, false, false, false], '10: never another provider\'s key, an unknown provider\'s, the linked token, a sign-in\'s, an empty key or a stranger\'s');
      for (const id of ['starnet', 'codex', 'grok']) store.push(id, { key: 'kc-' + id });
      A.eq([H('starnet', 'kc-starnet'), H('codex', 'kc-codex'), H('grok', 'kc-grok')], [false, false, false],
        '10: a key pushed under StarNet\'s or a sign-in\'s name is never one a run sends (the linked account and the sign-ins resolve their own), so never held');
      store.push('openrouter', { key: 'kc-or' });
      A.eq([H('openrouter', 'kc-or'), H('openrouter', 'en-or')], [true, true], '10: a keychain push never hides the environment\'s own key (the variable is still set)');
      store.push('anthropic', { key: 'kc-ant-2' });
      A.eq([H('anthropic', 'kc-ant'), H('anthropic', 'kc-ant-2')], [false, true], '10: a rotation ends the old key and holds the new one');
      store.push('anthropic', { key: 'kc-ant-3', keyPool: ['kc-ant-2'] });
      A.eq(H('anthropic', 'kc-ant-2'), true, '10: a key moved into the pool is still held');
      store.push('anthropic', { key: '', keyPool: [] });
      A.eq([H('anthropic', 'kc-ant-3'), H('anthropic', 'kc-pool'), H('anthropic', 'en-ant')], [false, false, true], '10: a REMOVE and a cleared pool end the keychain\'s; the environment\'s key is still there');
      A.eq(engineKeys.put('custom', {}).ok, true, 'fixture: the page REMOVEs its CUSTOM copy');
      A.eq([H('custom', 'pg-cu'), H('custom', 'pg-cu-pool')], [false, false], '10: a page REMOVE ends its key and its pool');
    }

    // 11. the watch over a real store, through runAgentLoop
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'look', schema: { type: 'object', properties: {} }, run: async () => 'looked' });
    // turn 1 runs `during` while its stream is open, then asks for a tool; turn 2 answers
    const twoTurns = (name, key, calls, during) => adapter(name, key, calls, async function* (n) {
      if (n > 1) { yield { type: 'text', delta: 'second turn' }; yield { type: 'done', finishReason: 'stop' }; return; }
      yield { type: 'text', delta: 'working' };
      if (during) during();
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'look' }; yield { type: 'tool_args', index: 0, chunk: '{}' }; yield { type: 'done', finishReason: 'tool_calls' };
    });
    const run = (P, w, extra) => { const s = setup(); return runAgentLoop(Object.assign({ messages: [{ role: 'user', content: 'go' }], provider: P, emit: s.emit, cost: cost(), model: 'm', agentId: 'a', runId: 'w',
      tools: [], dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx(), clock: { now: () => Date.now() }, limits: { maxIters: 5 }, credentialGone: goneVia(w), sleep: async () => {} }, extra || {}))
      .then(res => ({ res, seq: s.seq })); };
    const sentence = id => { const p = Reg.getProviderProfile(id); return EC.credentialError({ id, label: p.label, kind: 'removed', what: 'this run', env: (p.keyEnv || []).find(n => /_API_KEY$/.test(n)) || (p.keyEnv || [])[0] || '' }); };
    A.ok(/^the CUSTOM key this run started on was removed or replaced on this station, so it stopped before its next model call — run it again to use the key the station holds now, or add one under SETTINGS → AI & MODELS, or set CUSTOM_OPENAI_KEY in the environment that starts StarNet$/.test(sentence('custom')),
      '11: the in-flight sentence names the provider, why, and both exits: ' + sentence('custom'));
    const rows = [
      ['a page REMOVE', 'custom', 'pg-cu', {}, (s, e) => e.put('custom', {}), true],
      ['a page rotation', 'custom', 'pg-cu', {}, (s, e) => e.put('custom', { key: 'pg-cu-NEW', baseUrl: 'http://u.test/v1' }), true],
      ['a keychain REMOVE', 'anthropic', 'kc-ant', {}, s => s.push('anthropic', { key: '' }), true],
      ['a keychain rotation', 'anthropic', 'kc-ant', {}, s => s.push('anthropic', { key: 'kc-ant-NEW' }), true],
      ['a cleared pool, for a backup key', 'anthropic', 'kc-pool', {}, s => s.push('anthropic', { keyPool: [] }), true],
      ['a page REMOVE, on a key its caller sent in this request', 'custom', 'pg-cu', { sentByCaller: true }, (s, e) => e.put('custom', {}), false],
      ['a page REMOVE, on a channel\'s own key the station never held', 'custom', 'own-channel-key', {}, (s, e) => e.put('custom', {}), false],
      ['a keychain push of another provider', 'anthropic', 'kc-ant', {}, s => s.push('openrouter', { key: '' }), false],
      ['a page save that keeps the key and moves its endpoint', 'custom', 'pg-cu', {}, (s, e) => e.put('custom', { key: 'pg-cu', keyPool: ['pg-cu-pool'], baseUrl: 'http://moved.test/v1' }), false]
    ];
    for (const [label, id, key, opts, change, stops] of rows) {
      const { store, engineKeys } = station();
      const w = store.inFlight();
      const calls = [];
      const P = w.watch(twoTurns('P', key, calls, () => change(store, engineKeys)), id, key, opts);
      const { res, seq } = await run(P, w);
      if (stops) {
        A.eq([calls, res.reason, res.failureStage, errors(seq)], [['P'], 'error', 'credential', [sentence(id)]], '11: ' + label + ' stops the run before turn 2, with the sentence');
      } else {
        A.eq([calls, res.reason, errors(seq)], [['P', 'P'], 'done', []], '11: ' + label + ' never stops the run');
      }
    }
    // a key held as the run resolved it, removed before its adapter was built (runOnceCore's runKeyWatch.held): the first call stops
    {
      const { store } = station();
      const w = store.inFlight();
      const heldThen = store.holds('anthropic', 'kc-ant');
      store.push('anthropic', { key: '' });
      const calls = [];
      const P = w.watch(twoTurns('P', 'kc-ant', calls), 'anthropic', 'kc-ant', { held: heldThen });
      const { res } = await run(P, w);
      A.eq([heldThen, calls, res.reason, res.failureStage], [true, [], 'error', 'credential'], '11: removed between the run resolving its key and building its adapter: no call goes out');
      const w2 = store.inFlight(), calls2 = [];
      const Q = w2.watch(twoTurns('Q', 'kc-ant', calls2), 'anthropic', 'kc-ant');
      A.eq([(await run(Q, w2)).res.reason, calls2], ['done', ['Q', 'Q']], '11: (a key no layer holds when its adapter is built, and no earlier sighting, is a caller\'s own: never stopped)');
    }
    // the adapter a rotation or a provider fallback would use is watched on ITS key, through the loop
    {
      const { store } = station();
      const w = store.inFlight();
      const calls = [];
      const P = w.watch(adapter('P', 'kc-ant', calls, async function* () { store.push('anthropic', { keyPool: [] }); throw rateLimited(); }), 'anthropic', 'kc-ant');
      const R = w.watch(adapter('R', 'kc-pool', calls, textTurn('rotated')), 'anthropic', 'kc-pool');
      const { res } = await run(P, w, { credKey: 'kc-ant', fallbacks: [{ provider: R, model: 'm', credKey: 'kc-pool' }] });
      A.eq([calls, res.reason, res.failureStage], [['P'], 'error', 'credential'], '11: the pool was cleared during the primary\'s call: the rotation onto its backup key never goes out');
    }
  }

  /* ================= C. index.js wires it for every keyed adapter a run builds ================= */
  {
    // runOnceCore's own text (a brace matcher runs past its end; the top-level slice stops at its closing brace)
    const core = sidecarTopLevelFunction('runOnceCore');
    A.ok(core.length > 100000 && /\n\}$/.test(core), 'fixture: runOnceCore is sliced whole (' + core.length + ' chars)');
    const keyed = [];
    for (let i = core.indexOf('selectProvider({'); i >= 0; i = core.indexOf('selectProvider({', i + 1)) {
      const lit = core.slice(i, core.indexOf('})', i) + 2);
      if (/[{,]\s*key\s*[:,}]/.test(lit)) keyed.push({ watched: core.slice(i - 'runWatch.watch('.length, i) === 'runWatch.watch(', lit: lit.slice(0, 90) });
    }
    A.ok(keyed.length >= 4, 'C: the census sees runOnceCore\'s keyed adapters (the primary, the warm backup, each rotation entry, each provider fallback): ' + keyed.length);
    A.eq(keyed.filter(k => !k.watched).map(k => k.lit), [], 'C: EVERY adapter runOnceCore builds on a key is watched on that key (runWatch.watch)');
    const after = core.indexOf('const runKey = providerRuntimeKey(providerId, callerCredential ? key : \'\');');
    A.ok(after > 0 && /const runKeyWatch = \{ held: credStore\.holds\(providerId, runKey\), sentByCaller: callerCredential && o\.keyInRequest === true \};/.test(core.slice(after, after + 1500)),
      'C: the primary\'s key is judged held as the run resolves it (its adapter is built after the run\'s awaits), and a body key is the caller\'s');
    A.ok(/\n      credentialGone: runKeyGone,/.test(core), 'C: the loop is handed credentialGone');
    A.ok(/const runKeyGone = adapter => \{ const id = runWatch\.gone\(adapter\); return id \? engineCredentialError\(id, 'this run', true\) : ''; \};/.test(core), 'C: ...answering with the in-flight sentence');
    A.ok(/const keyGone = runKeyGone\(auxVisionProvider\); if \(keyGone\) throw new Error\(keyGone\);/.test(core), 'C: the aux vision call (image_analyze on the run\'s own adapter) asks too');
    A.ok(/const _keyGone = !!runKeyGone\(provider\);\n  if \(_capReached \|\| _keyGone\) _auxCandidates\.length = 0;/.test(core) && /isTask && !internal && !_keyGone\) \{/.test(core),
      'C: the post-run passes and the parked verdict review, which ride the run\'s adapter, are skipped once its key is gone');
  }

  A.report('loop.credential-live');
})();
