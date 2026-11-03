/* node test/provider.codex-limit-truth.test.js — #158: "Your ChatGPT plan allowance is used up" while the account showed
   96% and 81% left, on gpt-6.1-sol. Which refusal the reporter got is not known, so this pins what the code can prove:
   a refusal's own code, plan, reset and usage meters reach the message the diagnostics store (and no free text or
   balance with them); a short wait or another code is never re-read as a spent plan because its text says "quota"; and
   meters on the refusing answer that show room are never contradicted by "used up". A spent plan stays exactly that.
   Zero network: injected fetch. */
'use strict';
const A = require('./_assert.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { friendlyError } = require('../frontend/app/friendlyerror.js');

const req = { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }], preStreamRetries: 0 };
async function refusal(status, body, headers) {
  const p = makeCodexProvider({ token: 'acc', fetch: async () => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) }) });
  try { for await (const e of p.stream(req)) { if (e && e.type === 'error') return e.error || e; } }
  catch (e) { return e; }
  return null;
}
// the browser's ladder: it sees only the sentence, never the body or the status field (friendlyerror.js kindFromRaw)
const page = err => friendlyError(String(err.message));
const METERS = { 'x-codex-primary-used-percent': '4', 'x-codex-primary-window-minutes': '300', 'x-codex-secondary-used-percent': '19', 'x-codex-secondary-window-minutes': '10080', 'x-codex-credits-balance': '12.34' };

(async () => {
  // the refusal's own facts stay on the reported message; free text and the balance do not
  {
    const err = await refusal(429, { error: { message: 'The usage limit has been reached', type: 'usage_limit_reached', plan_type: 'plus', resets_in_seconds: 1234, note: 'free <text> here' } }, METERS);
    const msg = String(err.message);
    A.ok(/^codex http 429 — The usage limit has been reached \[provider: /.test(msg), 'the provider\'s text and the adapter label stay first: ' + msg);
    for (const fact of ['type=usage_limit_reached', 'plan=plus', 'resets_in_seconds=1234', 'primary-used-percent=4', 'primary-window-minutes=300', 'secondary-used-percent=19']) A.ok(msg.includes(fact), 'diagnostics keep ' + fact + ': ' + msg);
    A.ok(!/12\.34|free <text>/.test(msg), 'the credit balance and free-form fields are not copied: ' + msg);
    A.eq(classifyApiError(err, { model: req.model }).message, msg, 'the classifier reports that same message (agent.run.error -> the diagnostics ring)');
    A.eq(classifyApiError(err, { model: req.model }).reason, 'quota_exhausted', 'the provider\'s own code still decides: no retry');
    // meters that show room are never contradicted
    const v = page(err);
    A.eq(v.kind, 'quota_exhausted', 'still terminal, no doomed retry');
    A.ok(!/used up/.test(v.userMessage), 'room on the meters is never called used up: ' + v.userMessage);
    A.ok(/4% and 19% used/.test(v.userMessage) && /may be one specific to this model/.test(v.userMessage) && /model dock/.test(v.userMessage), 'it quotes the meters and offers another model: ' + v.userMessage);
    A.ok(v.raw.includes('type=usage_limit_reached'), 'the raw text keeps the code for a report');
  }
  // a window the meters show as spent is still "used up"
  {
    const err = await refusal(429, { error: { message: 'The usage limit has been reached', code: 'usage_limit_reached' } }, { 'x-codex-primary-used-percent': '100', 'x-codex-secondary-used-percent': '19' });
    A.ok(/plan allowance is used up/.test(page(err).userMessage), 'a meter at its limit keeps the spent copy: ' + page(err).userMessage);
    const bare = await refusal(429, { error: { message: 'The usage limit has been reached', code: 'usage_limit_reached' } });
    A.ok(/plan allowance is used up/.test(page(bare).userMessage), 'no meters at all: the provider\'s code stands: ' + page(bare).userMessage);
  }
  // SHORT WINDOW: the word "quota" no longer makes a wait into a spent plan
  {
    const coded = await refusal(429, { error: { message: 'Codex quota exceeded for this window', code: 'rate_limit_exceeded' } });
    A.eq(page(coded).kind, 'rate_limit', 'code rate_limit_exceeded + "quota" stays a rate limit in the browser: ' + page(coded).kind);
    A.eq(classifyApiError(coded, {}).reason, 'rate_limit', 'and in the sidecar');
    const wait = await refusal(429, { error: { message: 'Codex quota exceeded, try again in 30s' } });
    A.eq(page(wait).kind, 'rate_limit', 'a stated wait of seconds is a rate limit: ' + page(wait).userMessage);
    const twelve = friendlyError('codex http 429 — Codex quota exceeded, please try again in 12 minutes');
    A.eq(twelve.kind, 'rate_limit', 'a stated wait of minutes too');
    A.ok(/about 12 minutes/.test(twelve.userMessage) && !/few seconds/.test(twelve.userMessage), 'and its copy says how long: ' + twelve.userMessage);
    A.ok(/few seconds/.test(friendlyError('codex http 429 — Codex quota exceeded, try again in 30s').userMessage), 'seconds stay "a few seconds"');
    // the bound: a stated wait past 15 minutes is a window, however it is spelled
    for (const wait of ['86400s', '604800 seconds', '299 minutes', '45 minutes', '7200 seconds', '18000s', '16 minutes', '1h', '2 days'])
      A.eq(friendlyError('codex http 429 — Codex quota exceeded, try again in ' + wait).kind, 'quota_exhausted', 'a wait of ' + wait + ' is the plan');
    for (const wait of ['30s', '500ms', '59 seconds', '5m 30s', '15 minutes', '900 seconds'])
      A.eq(friendlyError('codex http 429 — Codex quota exceeded, try again in ' + wait).kind, 'rate_limit', 'a wait of ' + wait + ' is a wait');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded, try again in 14m 90s').kind, 'quota_exhausted', 'units add up: 15.5 minutes is past the bound');
    // the provider's codes for a spent plan, and its numbers against any code
    for (const code of ['quota_exceeded', 'plan_quota_exceeded', 'usage_not_included', 'usage_limit_reached', 'insufficient_quota'])
      A.eq(friendlyError('codex http 429 — Codex quota exceeded [provider: code=' + code + ']').kind, 'quota_exhausted', 'code ' + code + ' is the plan');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded [provider: code=rate_limit_exceeded]').kind, 'rate_limit', 'rate_limit_exceeded alone stays a rate limit');
    for (const fact of ['secondary-used-percent=100', 'resets_in_seconds=400000', 'resets_in_seconds=901'])
      A.eq(friendlyError('codex http 429 — Codex quota exceeded [provider: code=rate_limit_exceeded; ' + fact + ']').kind, 'quota_exhausted', fact + ' beats the code');
    // a live run's error reaches the page coded: the station's rate_limit holds against the word, and never against the provider's numbers
    for (const fact of ['secondary-used-percent=100', 'resets_in_seconds=400000', 'resets_in_seconds=901'])
      A.eq(friendlyError('codex http 429 — Codex quota exceeded [provider: code=rate_limit_exceeded; ' + fact + ']', null, { code: 'rate_limit' }).kind, 'quota_exhausted', fact + ' beats the station\'s code too');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded, try again in 2 days', null, { code: 'rate_limit' }).kind, 'quota_exhausted', 'and so does a long stated wait');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded', null, { code: 'rate_limit' }).kind, 'rate_limit', 'the word alone stays a coded rate limit');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded [provider: code=rate_limit_exceeded; secondary-used-percent=99; resets_in_seconds=900]', null, { code: 'rate_limit' }).kind, 'rate_limit', 'numbers short of the bound stay one too');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded [provider: code=rate_limit_exceeded; resets_in_seconds=900]').kind, 'rate_limit', 'a reset at the bound is still a wait');
    A.eq(friendlyError('codex http 429 — Too many requests, try again in 30s [provider: secondary-used-percent=100]').kind, 'quota_exhausted', 'a meter at its limit beats a short wait and needs no word "quota"');
    A.eq(friendlyError('codex http 429 — Too many requests, try again in 30s [provider: secondary-used-percent=99]').kind, 'rate_limit', '99% is not at its limit');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded').kind, 'quota_exhausted', 'bare "quota exceeded" on a plan with no contrary fact stays the plan (org P03)');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded, try again in 4h 12m').kind, 'quota_exhausted', 'a stated wait of hours stays the plan');
  }
  // the meters' boundary: room is below 90 on EVERY meter, and the room copy quotes them
  {
    const room = n => /may be one specific to this model/.test(friendlyError('codex http 429 — The usage limit has been reached [provider: code=usage_limit_reached; primary-used-percent=' + n + ']').userMessage);
    for (const n of [0, 4, 19, 20, 50, 89, 89.9]) A.eq(room(n), true, n + '% shows room');
    for (const n of [90, 95, 99, 100, 120]) A.eq(room(n), false, n + '% does not');
    A.eq(room('abc'), false, 'a meter that is no number shows nothing');
    const mixed = friendlyError('codex http 429 — The usage limit has been reached [provider: code=usage_limit_reached; primary-used-percent=4; secondary-used-percent=100]');
    A.ok(/plan allowance is used up/.test(mixed.userMessage), 'one spent meter beats a roomy one');
  }
  // the 16-fact cap keeps the worst meter, whatever order the headers came in
  {
    const many = {};
    for (let i = 0; i < 30; i++) { many['x-codex-m' + String(i).padStart(2, '0') + '-used-percent'] = String(i); many['x-codex-m' + String(i).padStart(2, '0') + '-window-minutes'] = '300'; }
    many['x-codex-zz-secondary-used-percent'] = '100';
    const err = await refusal(429, { error: { message: 'The usage limit has been reached', code: 'usage_limit_reached' } }, many);
    const block = /\[provider: ([^\]]*)\]/.exec(String(err.message))[1].split('; ');
    A.eq(block.length, 16, 'the block stays capped: ' + block.length);
    A.ok(block.includes('zz-secondary-used-percent=100'), 'the meter at 100 is kept: ' + block.join(' '));
    A.ok(block.includes('m29-used-percent=29') && !block.some(f => /-window-minutes=/.test(f)), 'percentages fill the cap first, fullest first');
    A.ok(/plan allowance is used up/.test(page(err).userMessage), 'and the copy never says the meters show room: ' + page(err).userMessage);
    const few = await refusal(429, { error: { message: 'x', code: 'usage_limit_reached' } }, { 'x-codex-a-window-minutes': '300', 'x-codex-b-used-percent': '7', 'x-codex-c-used-percent': '9' });
    A.ok(/a-window-minutes=300; b-used-percent=7; c-used-percent=9/.test(String(few.message)), 'under the cap everything stays, in arrival order: ' + few.message);
    const noisy = await refusal(429, { error: { message: 'x', code: 'usage_limit_reached' } }, { 'x-codex-a-used-percent': '7 percent (see plan)', 'x-codex-b-used-percent': '9' });
    A.ok(!/a-used-percent/.test(String(noisy.message)) && /b-used-percent=9/.test(String(noisy.message)), 'a value that is no slug is never copied: ' + noisy.message);
  }
  // A MODEL THE PLAN CANNOT RUN never reads as a spent allowance
  {
    const err = await refusal(400, { detail: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." });
    A.eq(classifyApiError(err, { model: req.model }).reason, 'model_not_found', 'sidecar: the refusal is the model');
    const v = page(err);
    A.eq(v.kind, 'model_not_found', 'browser: the refusal is the model');
    A.ok(/gpt-6\.1-sol/.test(v.userMessage) && !/allowance/.test(v.userMessage), 'it names the model, never the allowance: ' + v.userMessage);
  }
  // a mid-stream failure keeps its code in the message too
  {
    const sse = 'data: ' + JSON.stringify({ type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'limit' } } }) + '\n\n';
    const p = makeCodexProvider({ token: 'acc', fetch: async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) });
    let err = null;
    try { for await (const e of p.stream(req)) { if (e && e.type === 'error') { err = e.error || e; break; } } } catch (e) { err = e; }
    A.ok(err && /\[provider: code=usage_limit_reached\]/.test(err.message), 'stream failure keeps its code: ' + (err && err.message));
    for (const [event, shape] of [['error', { type: 'error', error: { code: 'usage_limit_reached', message: 'limit' } }], ['flat error', { type: 'error', code: 'usage_limit_reached', message: 'limit' }]]) {
      const body = 'data: ' + JSON.stringify(shape) + '\n\n';
      const q = makeCodexProvider({ token: 'acc', fetch: async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }) });
      let got = null;
      try { for await (const e of q.stream(req)) { if (e && e.type === 'error') { got = e.error || e; break; } } } catch (e) { got = e; }
      A.ok(got && /^codex stream error: limit \[provider: code=usage_limit_reached\]/.test(got.message), 'the stream ' + event + ' block keeps its code: ' + (got && got.message));
    }
  }
  A.report('provider.codex-limit-truth.test');
})().catch(e => { console.log('FAIL: provider.codex-limit-truth.test threw -- ' + (e && e.stack || e)); process.exit(1); });
