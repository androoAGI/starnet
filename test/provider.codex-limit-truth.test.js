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
    A.eq(friendlyError('codex http 429 — Codex quota exceeded, please try again in 12 minutes').kind, 'rate_limit', 'a stated wait of minutes too');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded').kind, 'quota_exhausted', 'bare "quota exceeded" on a plan with no contrary fact stays the plan (org P03)');
    A.eq(friendlyError('codex http 429 — Codex quota exceeded, try again in 4h 12m').kind, 'quota_exhausted', 'a stated wait of hours stays the plan');
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
  }
  A.report('provider.codex-limit-truth.test');
})().catch(e => { console.log('FAIL: provider.codex-limit-truth.test threw -- ' + (e && e.stack || e)); process.exit(1); });
