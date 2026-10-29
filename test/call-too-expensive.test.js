/* node test/call-too-expensive.test.js — the StarNet credit relay's per-call price ceiling (starnet-cloud
   THE CREDIT RESERVATION, live 2026-10-27, GitHub #53 follow-up). The relay answers HTTP 400 code
   `call_too_expensive` "This request could cost more than the $2.00 StarNet allows for one call. Send a shorter
   prompt or pick a cheaper model." when a prompt ALONE costs more than one call may. That fell through classify400
   to format_error, and COMMS read "Something went wrong on that turn — try again" with a RETRY the relay refuses
   identically. Locks both ladders: the sidecar classifier (node) and the browser's own text ladder (where
   classifyApiError is null), plus the recovery and failure-review consequences. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');
const { classifyApiError, REASONS } = require('../sidecar/providers/errorClass.js');
const P = require('../sidecar/recovery-policy.js');
const FR = require('../sidecar/failreview.js');
const { friendlyError } = require('../frontend/app/friendlyerror.js');

const RELAY_TEXT = 'This request could cost more than the $2.00 StarNet allows for one call. Send a shorter prompt or pick a cheaper model.';
// the shape sidecar/providers/openrouter.js throws for a non-OK answer: its own label + status, the body for the code
function relayErr(text, extraBody) {
  const err = new Error('openrouter http 400 — ' + text);
  err.status = 400;
  err.body = Object.assign({ error: { message: text, type: 'invalid_request', code: 'call_too_expensive' } }, extraBody || {});
  err.ownMessage = true;
  return err;
}

// ---- 1. sidecar classifier ----
{
  const v = classifyApiError(relayErr(RELAY_TEXT), { contextLimit: 1000000, approxTokens: 150000 });
  A.eq(v.reason, 'call_too_expensive', 'the relay ceiling refusal is its own reason, not format_error');
  A.eq([v.retryable, v.shouldCompress, v.shouldFallback, v.shouldRotateCredential], [false, false, true, false],
    'no resend, no silent fold, a configured fallback model may fit, the credential is fine');
  // the code alone (a relay that rewords its sentence) and the sentence alone (a body the adapter dropped) both count
  const codeOnly = new Error('openrouter http 400 — refused'); codeOnly.status = 400;
  codeOnly.body = { error: { message: 'refused', code: 'call_too_expensive' } }; codeOnly.ownMessage = true;
  A.eq(classifyApiError(codeOnly, {}).reason, 'call_too_expensive', 'code call_too_expensive alone');
  const textOnly = new Error('openrouter http 400 — ' + RELAY_TEXT.replace('$2.00', '$5')); textOnly.status = 400;
  A.eq(classifyApiError(textOnly, {}).reason, 'call_too_expensive', 'the sentence alone, at another configured ceiling');
  // a near miss is still not this class
  const other = new Error('openrouter http 400 — this request costs more than expected'); other.status = 400;
  A.eq(classifyApiError(other, {}).reason, 'format_error', 'an unrelated 400 that mentions cost stays format_error');
  // a 402 (the balance hold) stays billing — that is the OTHER relay refusal, and the app self-heals it
  const hold = new Error('openrouter http 402 — insufficient StarNet credits: this call holds up to $0.5761'); hold.status = 402;
  A.eq(classifyApiError(hold, {}).reason, 'billing', 'the 402 balance hold is not call_too_expensive');
  A.ok(REASONS.call_too_expensive && typeof REASONS.call_too_expensive.retryable === 'boolean', 'registered in REASONS');
}

// ---- 2. recovery: fallback when one is configured, otherwise fail at once (never the retry ladder) ----
{
  const cls = classifyApiError(relayErr(RELAY_TEXT), {});
  A.eq(P.providerFailure({ classification: cls, hasFallback: true, canCompress: true, recoveriesUsed: 0, maxRecoveries: 2 }).action,
    'fallback', 'a configured fallback model is tried');
  const alone = P.providerFailure({ classification: cls, hasFallback: false, canCompress: true, recoveriesUsed: 0, maxRecoveries: 2, retriesUsed: 0 });
  A.eq([alone.action, alone.reason], ['fail', 'call_too_expensive'], 'no fallback: the turn ends with its own reason, no retry, no fold');
}

// ---- 3. the failure review skips a same-model review of a priced-out run ----
{
  const run = { failureStage: 'provider_stream', failureCode: 'call_too_expensive' };
  A.eq(FR.providerRefused(run, {}), true, 'same model: no review');
  A.eq(FR.providerRefused(run, { separateModel: true }), false,
    'a separate aux model may still review it');
}

// ---- 4. COMMS copy: node path (delegates to the classifier) ----
{
  const v = friendlyError(relayErr(RELAY_TEXT));
  A.eq(v.kind, 'call_too_expensive', 'node ladder kind');
  A.eq(v.retryable, false, 'no ↻ Try again on a refusal a resend repeats');
  A.ok(/\$2\.00 StarNet allows for one call/.test(v.userMessage), 'quotes the ceiling the relay named: ' + v.userMessage);
  A.ok(/nothing was charged/.test(v.userMessage) && /fresh chat/.test(v.userMessage) && /cheaper model/.test(v.userMessage),
    'says nothing was charged and names both fixes');
  A.ok(!/something went wrong/i.test(v.userMessage), 'never the generic copy');
}

// ---- 5. COMMS copy: the BROWSER path (classifyApiError is null there — the half real users execute) ----
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__F = Friendly;', sandbox, { filename: 'friendlyerror.js' });
  const F = sandbox.__F;
  const v = F.friendlyError(new Error('openrouter http 400 — ' + RELAY_TEXT));
  A.eq(v.kind, 'call_too_expensive', 'browser ladder kind');
  A.ok(/\$2\.00 StarNet allows for one call/.test(v.userMessage), 'browser copy quotes the ceiling');
  const five = F.friendlyError(new Error('openrouter http 400 — ' + RELAY_TEXT.replace('$2.00', '$5.00')));
  A.ok(/\$5\.00 StarNet allows/.test(five.userMessage), 'a raised ceiling is quoted as the relay said it, never as $2');
  // no status in the text (an in-band relay message): the message ladder still finds it
  A.eq(F.friendlyError(new Error(RELAY_TEXT)).kind, 'call_too_expensive', 'browser ladder with no status');
  A.eq(F._internals.kindFromRaw('openrouter http 400 — bad request', null), 'unknown', 'a plain 400 is unchanged');
  // ---- 6. the door matches the copy: it says pick a cheaper model from the model dock, so the button opens the dock ----
  A.ok(/model dock/.test(v.userMessage) && /model dock/.test(F.KINDS.call_too_expensive.msg), 'the copy (and its fallback) names the model dock');
  A.eq(F.actionButton(v).label, '▸ PICK A MODEL', 'browser: the button opens the model dock, not AI & MODELS');
  A.eq(require('../frontend/app/friendlyerror.js').actionButton(friendlyError(relayErr(RELAY_TEXT))).label, '▸ PICK A MODEL', 'node: the same door');
}

A.report('call-too-expensive');
