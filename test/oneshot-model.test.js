/* node test/oneshot-model.test.js — the W3.5 one-shot model resolver (sidecar/oneshot-model.js) and the records that say
   the model as it ran. Pure units + source pins; the end-to-end proof is test/oneshot-small-model.invariant.test.js.

   A. pick(): the family's small model, only from the catalog; the user's aux model wins; the switches; no family = run model
   B. call(): one retry on the run model for an error, a refusal, malformed output or an empty reply — never for a usable or
      NONE reply, never after the pass gave up
   C. guard(): the title run — a usable reply replays unchanged; an unusable one yields only its billing facts and throws an
      error errorClass files as oneshot_unusable (shouldFallback); other models pass straight through
   D. titleOf() agrees with frontend/app/chat.js cleanTitle on a corpus; the page marks its title run; the station reads it
   E. records: the aux meter books one row per model that ran (the served model when the provider names one); receipts too
   F. claude-cli: `haiku` priced as Haiku 5.5; a stop estimate prices the model the CLI said it served */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const OneShot = require('../sidecar/oneshot-model.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeLedger, makeAuxMeter } = require('../sidecar/ledger.js');
const { makeUsageReceipts } = require('../sidecar/usage-receipts.js');
const cli = require('../sidecar/providers/claude-cli.js');
const prices = require('../sidecar/providers/prices.js');
const { readSidecarIndex } = require('./helpers/source');

const ON = { smallOn: true };
const pick = (kind, runModel, models, extra) => OneShot.pick(kind, Object.assign({ runModel, models }, ON, extra || {}));

(async () => {
  // ---- A. pick ----------------------------------------------------------------------------------------------------------
  {
    const OR = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-5.5', 'anthropic/claude-3.5-haiku', 'openai/gpt-5.4-mini', 'anthropic/claude-haiku-5.5:thinking'];
    A.eq(pick('study', 'anthropic/claude-sonnet-5.5', OR).model, 'anthropic/claude-haiku-5.5', 'OpenRouter Claude run: the newest haiku of the same vendor prefix');
    A.eq(pick('study', 'anthropic/claude-sonnet-5.5', OR).small, true, '...marked small (the one retry applies)');
    A.eq(pick('study', 'anthropic/claude-opus-5.5', ['anthropic/claude-opus-5.5', 'openai/gpt-5.4-mini']).model, 'anthropic/claude-opus-5.5', 'no haiku in the catalog: the run model (never another vendor\'s mini)');
    A.eq(pick('threadmine', 'claude-sonnet-5-5', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5']).model, 'claude-haiku-5-5', 'Anthropic API: the newest haiku id the catalog lists');
    A.eq(pick('threadmine', 'claude-sonnet-5-5', ['claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001']).model, 'claude-haiku-4-5', 'a tie on the version: the undated id');
    const CLI = cli._internals.MODELS.map(m => m.id);
    A.eq(pick('scout', 'claude-sonnet-5-5', CLI).model, 'haiku', 'claude-cli: the `haiku` alias the catalog lists (it follows the newest Haiku) beats the dated Haiku 4.5 id');
    A.eq(pick('scout', 'sonnet', CLI).model, 'haiku', 'claude-cli on the `sonnet` alias: same family, the haiku alias');
    A.eq(pick('scout', 'claude-opus-5-5[1m]', CLI).model, 'haiku', 'a [1m] run model reads as its family');
    A.eq(pick('scout', 'haiku', CLI), { kind: 'scout', model: 'haiku', runModel: 'haiku', small: false, why: 'already-small' }, 'a run already on the small model keeps it, no retry');
    A.eq(pick('study', 'gpt-5.5', ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']).model, 'gpt-5.4-mini', 'Codex/OpenAI: the -mini the catalog lists');
    A.eq(pick('study', 'gpt-5.5', ['gpt-5.5', 'gpt-4o-mini', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-05', 'gpt-4o-mini-tts']).model, 'gpt-5.4-mini', 'the newest mini, the undated alias; never a tts variant');
    A.eq(pick('study', 'gpt-5.4-mini', ['gpt-5.5', 'gpt-5.4-mini']).why, 'already-small', 'a mini run is already small');
    A.eq(pick('study', 'gemini-3-pro', ['gemini-3-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image']).model, 'gemini-2.5-flash-lite', 'Gemini: flash-lite, never an image variant');
    A.eq(pick('study', 'mistral-large-latest', ['mistral-large-latest', 'mistral-small-latest']).why, 'unknown-family', 'a family this resolver does not know keeps the run model');
    A.eq(pick('study', 'run/model', ['run/model', 'aux/cheap']).model, 'run/model', 'an unrecognised id keeps the run model');
    A.eq(pick('study', 'claude-sonnet-5-5', []).why, 'no-catalog', 'no catalog: the run model, and the host may read the catalog and ask again');
    // the user's own aux model always wins (no retry: that setting's behavior is unchanged)
    A.eq(pick('study', 'claude-sonnet-5-5', CLI, { explicit: 'aux/cheap' }), { kind: 'study', model: 'aux/cheap', runModel: 'claude-sonnet-5-5', small: false, why: 'explicit' }, 'STARNET_AUX_MODEL wins over the family pick');
    // switches: reflection only with its own switch; the master switch off moves nothing; other kinds are not small passes
    A.eq(pick('reflection', 'claude-sonnet-5-5', CLI).model, 'claude-sonnet-5-5', 'reflection stays on the run model by default');
    A.eq(pick('reflection', 'claude-sonnet-5-5', CLI, { reflectionOn: true }).model, 'haiku', 'reflection moves only with its own switch');
    A.eq(pick('title', 'claude-sonnet-5-5', CLI, { smallOn: false }).why, 'switch-off', 'STARNET_AUX_SMALL_MODEL=0 keeps every pass on the run model');
    A.eq(pick('reflection', 'claude-sonnet-5-5', CLI, { smallOn: false, reflectionOn: true }).why, 'switch-off', 'the master switch off wins over the reflection switch');
    A.eq(pick('failure-review', 'claude-sonnet-5-5', CLI).why, 'not-a-small-pass', 'the failure review is not a small-model pass');
    A.eq(pick('skill-review', 'claude-sonnet-5-5', CLI).model, 'claude-sonnet-5-5', 'nor the skill review (a tool loop)');
    for (const k of ['study', 'threadmine', 'scout', 'title']) A.eq(OneShot.KINDS[k], 'on', k + ' is on by default (Andrew, 11-08)');
    A.eq(OneShot.KINDS.reflection, 'switch', 'reflection is behind its own switch');
  }

  // ---- B. call: the one retry -------------------------------------------------------------------------------------------
  {
    const plan = { kind: 'study', model: 'small', runModel: 'run', small: true };
    const accept = t => OneShot.isNone(t) || /^DIM:/m.test(t);
    const script = replies => { const seen = []; return { seen, attempt: async (m) => { seen.push(m); const r = replies[seen.length - 1]; if (r instanceof Error) throw r; return r; } }; };
    for (const [why, first] of [['error', new Error('400 bad request')], ['refusal', "I'm sorry, I can't help with that."], ['malformed', 'Here are some thoughts.'], ['empty', '   ']]) {
      const s = script([first, 'DIM: craft ADD likes tests']);
      const r = await OneShot.call(plan, s.attempt, accept);
      A.eq(s.seen, ['small', 'run'], why + ': the small model first, then ONE retry on the run model');
      A.eq([r.text, r.model, r.retried], ['DIM: craft ADD likes tests', 'run', why], why + ': the run model\'s reply is the pass\'s, and the reason is named');
    }
    for (const ok of ['NONE', '**NONE**', 'NONE.', 'DIM: craft ADD likes tests']) {
      const s = script([ok]);
      const r = await OneShot.call(plan, s.attempt, accept);
      A.eq([s.seen, r.model, r.retried], [['small'], 'small', ''], JSON.stringify(ok) + ': a usable reply is kept, no second call');
    }
    {
      const s = script(['garbage', 'still garbage']);
      const r = await OneShot.call(plan, s.attempt, accept);
      A.eq(s.seen.length, 2, 'the retry is ONCE: an unusable run-model reply is the pass\'s answer, never a third call');
      A.eq(r.text, 'still garbage', '...and is handed to the pass as it came');
    }
    {
      const s = script([new Error('aborted')]);
      let threw = false;
      try { await OneShot.call(plan, s.attempt, accept, { aborted: () => true }); } catch (_) { threw = true; }
      A.ok(threw && s.seen.length === 1, 'a pass that gave up (its timeout) is never retried');
    }
    {
      const s = script(['x']);
      const r = await OneShot.call({ kind: 'study', model: 'run', runModel: 'run', small: false }, s.attempt, accept);
      A.eq([s.seen, r.text], [['run'], 'x'], 'a plan that is not small calls once, as before (whatever it answered)');
    }
    {
      const s = script([new Error('boom')]);
      let threw = false;
      try { await OneShot.call({ kind: 'study', model: 'run', runModel: 'run', small: false }, s.attempt, accept); } catch (_) { threw = true; }
      A.ok(threw, 'a run-model failure still reaches the pass (its meter books it; the pass catches it as before)');
    }
  }

  // ---- C. guard: the title run inside the loop ---------------------------------------------------------------------------
  {
    const plan = { kind: 'title', model: 'small', runModel: 'run', small: true };
    const prov = (events, fail) => ({ priceOf: () => null, async *stream(req) { for (const e of events) yield e; if (fail) throw fail; } });
    const drain = async (p, req) => { const out = []; let err = null; try { for await (const e of p.stream(req)) out.push(e); } catch (e) { err = e; } return { out, err }; };
    const usage = { type: 'usage', usage: { prompt_tokens: 40, completion_tokens: 4 } };
    const titleOk = t => !!OneShot.titleOf(t);
    const good = OneShot.guard(prov([{ type: 'text', delta: 'Staging ' }, { type: 'text', delta: 'Rollback Rebuild' }, usage, { type: 'done', finishReason: 'stop' }]), plan, titleOk);
    const g = await drain(good, { model: 'small' });
    A.eq([g.err, g.out.map(e => e.type)], [null, ['text', 'text', 'usage', 'done']], 'a usable small reply replays unchanged');
    const bad = OneShot.guard(prov([{ type: 'generation', id: 'gen-1' }, { type: 'text', delta: "Here's a title for your session about the rollback work" }, usage, { type: 'done', finishReason: 'stop' }]), plan, titleOk);
    const b = await drain(bad, { model: 'small' });
    A.eq(b.out.map(e => e.type), ['generation', 'usage'], 'an unusable reply yields only its billing facts (the loop books the small call)');
    A.ok(b.err && b.err.oneShotUnusable === true && b.err.oneShotWhy === 'malformed', 'and throws the guard\'s own verdict: a sentence is no title (' + (b.err && b.err.oneShotWhy) + ')');
    const no = await drain(OneShot.guard(prov([{ type: 'text', delta: "I'm sorry, I can't help with that." }, usage]), plan, titleOk), { model: 'small' });
    A.ok(no.err && no.err.oneShotWhy === 'refusal', 'a refusal is named as one (' + (no.err && no.err.oneShotWhy) + ')');
    const cls = classifyApiError(b.err, {});
    A.eq([cls.reason, cls.shouldFallback, cls.retryable, cls.shouldRotateCredential, cls.shouldCompress], ['oneshot_unusable', true, false, false, false], 'errorClass files it as oneshot_unusable: fall back once, no resend on the small model, no key rotation');
    const boom = Object.assign(new Error('upstream 500'), { status: 500 });
    const e = await drain(OneShot.guard(prov([usage], boom), plan, titleOk), { model: 'small' });
    A.ok(e.err && e.err.oneShotUnusable && e.err.cause === boom && classifyApiError(e.err, {}).reason === 'oneshot_unusable', 'a failed small call becomes the same one fallback, its provider error kept as the cause');
    const thru = await drain(OneShot.guard(prov([{ type: 'text', delta: 'whatever the run model says' }, usage], null), plan, titleOk), { model: 'run' });
    A.eq([thru.err, thru.out.length], [null, 2], 'the run model\'s call passes straight through the guard');
    const ac = new AbortController(); ac.abort();
    const stopped = await drain(OneShot.guard(prov([usage, { type: 'text', delta: 'x' }], null), plan, titleOk), { model: 'small', signal: ac.signal });
    A.ok(!stopped.err && stopped.out.every(x => x.type === 'usage'), 'a Stop never turns into a second call');
    const raw = prov([]);
    const wrapped = OneShot.guard(raw, plan, titleOk);
    A.ok(OneShot.innerOf(wrapped) === raw && OneShot.innerOf(raw) === null, 'the guard names the adapter it wraps (the run\'s credential watch reads through it)');
    A.ok(OneShot.guard(raw, { kind: 'title', model: 'run', runModel: 'run', small: false }, titleOk) === raw, 'a plan that is not small leaves the adapter untouched');
    A.eq(OneShot.fallbackEntry(raw, 'openrouter', plan), { provider: raw, providerId: 'openrouter', model: 'run' }, 'the run model heads the fallback chain on the same adapter');
  }

  // ---- D. the title: one verdict on both sides; the page marks the run; the station reads the mark ------------------------
  {
    const chat = fs.readFileSync(path.join(__dirname, '../frontend/app/chat.js'), 'utf8');
    const at = chat.indexOf('  function cleanTitle(raw) {');
    const end = chat.indexOf('  /* DISCONNECT', at);
    A.ok(at > 0 && end > at, 'fixture: chat.js cleanTitle sliced');
    const ctx = {}; vm.createContext(ctx); vm.runInContext(chat.slice(at, end) + '\nthis.cleanTitle = cleanTitle;', ctx);
    const corpus = ['Staging Rollback Rebuild', '"Quoted Title"', '# Heading Title', 'Title: Deploy Fix', 'Fix the build.', '', '   ', 'NONE',
      "I'm sorry, I can't help with that.", "Here's a title: Deploy", 'I can do that', 'Sorry', 'A'.repeat(65), 'A'.repeat(64), '<think>hmm</think>Real Title',
      'Line One\nLine Two', '**Bold Title**', 'As an AI I cannot', 'Kubernetes Ops Review —', 'Title — Payment Retry Audit'];
    for (const t of corpus) A.eq(OneShot.titleOf(t), ctx.cleanTitle(t), 'titleOf agrees with the page\'s cleanTitle on ' + JSON.stringify(t.slice(0, 40)));
    const retitle = chat.slice(chat.indexOf('  async function maybeRetitle('), at);
    A.ok(/Harness\.chat\(\{[^\n]*internal: true, oneShot: 'title'/.test(retitle), 'maybeRetitle marks its call as the session title');
    const harness = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
    A.ok(/if \(internal && oneShot === 'title'\) reqBody\.oneShot = 'title';/.test(harness), 'Harness.chat forwards the mark for an internal run only');
    const idx = readSidecarIndex();
    A.ok(/oneShot: \(internal && body && body\.oneShot === 'title'\) \? 'title' : undefined/.test(idx), 'the station reads the mark on internal runs only');
    A.ok(/if \(internal && o\.oneShot === 'title'\) \{/.test(idx) && /OneShot\.guard\(provider, titlePlan, t => !!OneShot\.titleOf\(t\)\)/.test(idx), 'runOnceCore guards the title run with the title verdict');
    A.ok(/const runKeyGone = adapter => \{ const id = runWatch\.gone\(adapter\) \|\| runWatch\.gone\(OneShot\.innerOf\(adapter\)\);/.test(idx), 'the credential watch reads through the guard');
    for (const [fn, kind] of [['runStudy', 'study'], ['runThreadMine', 'threadmine'], ['runScoutCycle', 'scout'], ['runReflection', 'reflection']]) {
      const at2 = idx.indexOf('async function ' + fn + '(');
      const body = idx.slice(at2, idx.indexOf('\n}\n', at2));
      A.ok(body.indexOf("oneShotStream('" + kind + "', o, spend, req, ") > 0, fn + ' calls through the one resolver as ' + kind);
    }
    A.ok(!/oneShotStream\('failure-review'/.test(idx), 'the failure review keeps the run model (not one of Andrew\'s passes)');
  }

  // ---- E. records: one ledger row per model that ran; the served model names it; receipts the same ------------------------
  {
    const rows = []; const io = { readAll: () => rows.slice(), append: e => rows.push(e) };
    const L = makeLedger({ io, clock: { now: () => 5e6 } });
    const cost = { reconcile: (u, model) => ({ usd: (model === 'run' ? 10 : 1) * (u.prompt_tokens + u.completion_tokens) / 1e6, tokensIn: u.prompt_tokens, tokensOut: u.completion_tokens, cachedTokens: 0 }) };
    const prov = (events, fail) => ({ async *stream() { for (const e of events) yield e; if (fail) throw fail; } });
    const m = makeAuxMeter({ ledger: L, kind: 'study' });
    try { await m.stream(prov([{ type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 5 } }], new Error('400')), { model: 'small' }, cost); } catch (_) {}
    await m.stream(prov([{ type: 'text', delta: 'NONE' }, { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 2 } }]), { model: 'run' }, cost);
    A.eq(m.calls(), 2, 'the meter counted both calls');
    const last = m.book({ runId: 'r1', agentId: 'a', model: 'run' });
    A.eq(rows.map(r => [r.model, r.tokens, Math.round(r.usd * 1e6), r.aux]), [['small', 105, 105, 'study'], ['run', 102, 1020, 'study']], 'one row per model that ran, each with its own tokens and dollars');
    A.ok(last === rows[1], 'book() returns the last row (the model the pass ended on)');
    A.eq(m.book({ runId: 'r1', agentId: 'a', model: 'run' }), null, 'booked once');
    rows.length = 0;
    const m2 = makeAuxMeter({ ledger: L, kind: 'scout' });
    await m2.stream(prov([{ type: 'usage', model: 'claude-haiku-5-5', usage: { prompt_tokens: 10, completion_tokens: 1 } }]), { model: 'haiku' }, cost);
    m2.book({ runId: 'r2', agentId: 'a', model: 'haiku' });
    A.eq(rows.map(r => r.model), ['claude-haiku-5-5'], 'the row names the model the provider said served the call, not the alias asked for');
    rows.length = 0;
    const m3 = makeAuxMeter({ ledger: L, kind: 'reflection' });
    await m3.stream(prov([{ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 1 } }]), { model: 'run' }, cost);
    await m3.stream(prov([{ type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 2 } }]), { model: 'run' }, cost);
    m3.book({ runId: 'r3', agentId: 'a', model: 'run' });
    A.eq(rows.map(r => [r.model, r.tokens]), [['run', 33]], 'a pass on one model books ONE row, summed, as before');

    const R = makeUsageReceipts({ clock: { now: () => 1000 } });
    const wrapped = R.wrap({ async *stream() { yield { type: 'usage', model: 'claude-haiku-5-5', usage: { prompt_tokens: 5, completion_tokens: 1 } }; yield { type: 'done', finishReason: 'stop' }; } }, { provider: 'claude-cli' });
    for await (const _ of wrapped.stream({ model: 'haiku' })) { /* drain */ }
    const plain = R.wrap({ async *stream() { yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 1 } }; yield { type: 'done', finishReason: 'stop' }; } }, { provider: 'openrouter' });
    for await (const _ of plain.stream({ model: 'anthropic/claude-haiku-5.5' })) { /* drain */ }
    A.eq(R.records().map(r => r.model), ['claude-haiku-5-5', 'anthropic/claude-haiku-5.5'], 'a receipt says the served model when the provider names one, else the model asked for');
  }

  // ---- F. claude-cli: the alias, and a stop priced as the model the CLI served -------------------------------------------
  {
    const u = { input_tokens: 1e6, output_tokens: 1e6 };
    const h55 = prices.priceOf('anthropic', 'claude-haiku-5-5'), h45 = prices.priceOf('anthropic', 'claude-haiku-4-5');
    A.eq(cli._internals.estimateUsd(u, 'haiku'), cli._internals.estimateUsd(u, 'claude-haiku-5-5'), '`haiku` is priced as claude-haiku-5-5');
    A.ok(Math.abs(cli._internals.estimateUsd(u, 'haiku') - (h55.in + h55.out)) < 1e-9 && h45.in > h55.in, 'at Haiku 5.5 list rates, below Haiku 4.5\'s');
    for (const a of ['opus', 'sonnet']) A.eq(cli._internals.estimateUsd(u, a), cli._internals.estimateUsd(u, 'claude-' + a + '-5-5'), a + ' is still priced as the model it follows');
    // an API-key sign-in on an older CLI that serves `haiku` on Haiku 4.5: the stop's estimate prices what was served
    const spawn = () => {
      const child = new EventEmitter();
      const s = () => { const x = new EventEmitter(); x.setEncoding = () => {}; return x; };
      child.stdout = s(); child.stderr = s(); child.pid = 4244; child.exitCode = null;
      child.kill = () => { if (child.exitCode == null) { child.exitCode = null; child.emit('exit', null); child.emit('close', null); } };
      child.stdin = { on() {}, end() { setImmediate(() => {
        const lines = [
          { type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5-20251001', tools: [] },
          { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1000000, output_tokens: 1 } } } },
          { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '<function_calls>\n<invoke name="fs_read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</function_calls>' } } }
        ];
        for (const l of lines) child.stdout.emit('data', JSON.stringify(l) + '\n');
      }); } };
      return child;
    };
    const p = cli.makeClaudeCliProvider({ spawn, fs: { statSync() { return { isFile: () => true }; }, writeFileSync() {}, unlinkSync() {} }, bin: 'claude.exe', env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' }, platform: 'linux', idleMs: 3000 });
    const tools = [{ type: 'function', function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
    const evs = [];
    for await (const e of p.stream({ model: 'haiku', tools, messages: [{ role: 'user', content: 'read a.txt' }] })) evs.push(e);
    const use = evs.filter(e => e.type === 'usage').pop();
    A.eq(use && use.model, 'claude-haiku-4-5-20251001', 'the stop\'s usage names the model the CLI served');
    const out = use ? use.usage.completion_tokens : 0;
    const want = (1e6 * h45.in + out * h45.out) / 1e6;
    A.ok(use && Math.abs(use.usage.cost - want) < 1e-6, 'the stop is priced as the served Haiku 4.5, not the alias table ($' + (use && use.usage.cost) + ' vs $' + want + ')');
  }

  A.report('oneshot-model.test');
})().catch(e => { console.log('FAIL: oneshot-model.test threw - ' + (e && e.stack || e)); process.exit(1); });
