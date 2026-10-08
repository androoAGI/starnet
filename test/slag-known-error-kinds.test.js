'use strict';
/* node test/slag-known-error-kinds.test.js — a failed run's post-mortem names the REAL door for every error kind the
   page classifies (audit B3, 2026-10-08).

   slaglog.js KNOWN_ERROR_KINDS predated the 10-07 StarNet-credit kinds, so a refused StarNet link (managed_credit_link —
   not retryable, its door is RELINK) or an unanswered balance check (managed_credit_unavailable — try again) became a
   maintenance quest saying "send the request again… copy the diagnostics and report it". And a stalled BUILD's beat
   (workqueststore.js stallBeat) passed no error at all, so even an empty wallet read as a StarNet bug to report.

   Locked here, by running the code:
     1. DRIFT LOCK — every kind friendlyerror.js can return is sorted into exactly one post-mortem bucket; a new Friendly
        kind fails this test until someone decides which door its post-mortem names;
     2. the sidecar's three real managed-admission refusals (read from sidecar/index.js), through the real Friendly ladder
        and the real SlagLog, name relink / retry / top up — never "report it";
     3. a stalled build whose run errored on a refused link says relink, using the run's own agent.run.error text. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Friendly = require('../frontend/app/friendlyerror.js');
const SlagLog = require('../frontend/app/slaglog.js');

const friendlySrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
const host = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');

/* ---- 1. every Friendly kind has a decided post-mortem ---- */
const KINDS = {};
{
  const body = A.fnBody(friendlySrc, 'const KINDS = {');
  A.ok(body.length > 500 && body.length < 20000, 'friendlyerror.js KINDS table located (length guard)');
  for (const m of body.matchAll(/^\s+([a-z_]+):\s*\{\s*retryable:\s*(true|false)/gm)) KINDS[m[1]] = m[2] === 'true';
}
// the door each kind's post-mortem names. NAMED: the kind's own message is the fix, and a resend will not fix it.
// RETRY: the kind's own message is the fix, and the cause says a resend in a moment can go through (never "will not fix").
// GENERIC: StarNet's own fault is plausible (or the cause is unknown) — keep "see RECORD, resend, report it if it repeats".
// NOT_A_FAILURE: a deliberate stop never becomes a post-mortem (it ends 'cancelled', not 'error').
const BUCKET = {
  billing: 'NAMED', managed_credit: 'NAMED', managed_credit_link: 'NAMED', auth: 'NAMED', no_model: 'NAMED', oauth: 'NAMED',
  grok_oauth_unavailable: 'NAMED', quota_exhausted: 'NAMED', model_not_found: 'NAMED', context_overflow: 'NAMED',
  content_policy_blocked: 'NAMED', capdenied: 'NAMED', spotify_not_connected: 'NAMED', stale_session: 'NAMED', spend_unknown: 'NAMED',
  managed_credit_unavailable: 'RETRY', managed_credit_held: 'RETRY', provider_server_error: 'RETRY', provider_unreachable: 'RETRY', rate_limit: 'RETRY', agent_busy: 'RETRY',
  unknown: 'GENERIC', server_error: 'GENERIC', network: 'GENERIC', timeout: 'GENERIC',
  user_abort: 'NOT_A_FAILURE'
};
A.eq(Object.keys(KINDS).sort(), Object.keys(BUCKET).sort(),
  'every Friendly kind has a decided post-mortem bucket (a NEW kind must be sorted here, and into slaglog.js, before it ships)');
const NOT_FIXABLE_BY_RESEND = /will not fix/;
for (const kind of Object.keys(BUCKET)) {
  const msg = 'THE ' + kind.toUpperCase() + ' DOOR';
  const d = SlagLog.diagnose('error', { error: { kind, msg } });
  A.eq(d.title, 'errored out', kind + ': the post-mortem title stays "errored out" (the quest reads "N runs errored out")');
  if (BUCKET[kind] === 'NAMED') {
    A.eq(d.fix, msg, kind + ': the fix is the kind\'s own door');
    A.ok(NOT_FIXABLE_BY_RESEND.test(d.cause), kind + ': the cause says a resend will not fix it');
    A.ok(KINDS[kind] === false, kind + ': a NAMED kind is one Friendly marks not retryable');
  } else if (BUCKET[kind] === 'RETRY') {
    A.eq(d.fix, msg, kind + ': the fix is the kind\'s own door');
    A.ok(!NOT_FIXABLE_BY_RESEND.test(d.cause) && /resend in a moment/.test(d.cause), kind + ': the cause says a retry can go through: ' + d.cause);
    A.ok(KINDS[kind] === true, kind + ': a RETRY kind is one Friendly marks retryable');
  } else if (BUCKET[kind] === 'GENERIC') {
    A.ok(/report it/.test(d.fix) && /diagnostics/.test(d.fix), kind + ': keeps the resend + report fix (it may be StarNet\'s own bug)');
  }
}

/* ---- 2. the sidecar's real admission refusals → Friendly → SlagLog ---- */
// the refusal wording lives in budgetcaps.managedRefusalMessage (moved there with audit B11's held refusal); the
// admission path must still build its refusal from it, so these are the sidecar's real strings
A.ok(/budgetCaps\.managedRefusalMessage\(\{ exhausted, linkRefused, held: [^\n]*\}\)/.test(host), 'refuseManaged builds its refusal from budgetcaps.managedRefusalMessage');
const refusalOf = require(path.join(__dirname, '..', 'sidecar', 'budgetcaps.js')).managedRefusalMessage;
const refusedLink = refusalOf({ linkRefused: true }).message;
const unanswered = refusalOf({}).message;
const outOf = refusalOf({ exhausted: true }).message;
const heldBy = refusalOf({ exhausted: true, held: { counted: true, runs: 2, usd: 4 }, balanceUsd: 0 }).message;
A.ok(/refused this station's link/.test(refusedLink) && /did not answer/.test(unanswered) && /^Out of managed credit/.test(outOf) && /held by 2 running StarNet runs/.test(heldBy),
  'the sidecar still emits the refused-link, unanswered, out-of-credit and held refusals');
const postMortem = (text) => {
  const v = Friendly.friendlyError(new Error(text));
  return { kind: v.kind, d: SlagLog.diagnose('error', { error: { kind: v.kind, msg: v.userMessage } }) };
};
{
  const r = postMortem(refusedLink);
  A.eq(r.kind, 'managed_credit_link', 'a refused link classifies as managed_credit_link');
  A.ok(/Relink it/.test(r.d.fix) && /credits are safe/.test(r.d.fix), 'a refused link\'s post-mortem says relink: ' + r.d.fix);
  A.ok(!/report it|diagnostics|send the request again/.test(r.d.fix), 'a refused link is never "send it again, report it"');
}
{
  const r = postMortem(unanswered);
  A.eq(r.kind, 'managed_credit_unavailable', 'an unanswered balance check classifies as managed_credit_unavailable');
  A.ok(/couldn't check your credit balance/.test(r.d.fix) && /Try again in a moment/.test(r.d.fix), 'an unanswered check says the balance could not be read, try again: ' + r.d.fix);
  A.ok(!/report it|diagnostics/.test(r.d.fix) && !NOT_FIXABLE_BY_RESEND.test(r.d.cause), 'an unanswered check is never "report it", and never "a resend will not fix it"');
  A.ok(!/out of StarNet credits|top up/i.test(r.d.fix), 'an unanswered check never claims an empty wallet');
}
{
  const r = postMortem(outOf);
  A.eq(r.kind, 'managed_credit', 'a reported empty wallet classifies as managed_credit');
  A.ok(/out of StarNet credits/.test(r.d.fix), 'only a reported empty wallet says top up');
}
{
  const r = postMortem(heldBy);
  A.eq(r.kind, 'managed_credit_held', 'a balance held by running runs classifies as managed_credit_held');
  A.ok(/still working/.test(r.d.fix) && !/out of StarNet credits|report it|diagnostics/.test(r.d.fix), 'a held balance says wait, never empty or report it: ' + r.d.fix);
  A.ok(!NOT_FIXABLE_BY_RESEND.test(r.d.cause) && /resend in a moment/.test(r.d.cause), 'a held balance is a retry: a resend after the runs settle can go through');
}

/* ---- 3. a stalled BUILD names the run's own error door (workqueststore.js stallBeat) ---- */
global.localStorage = { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } };
global.WorkQuests = require('../frontend/app/workquests.js');
global.Recipes = { get: () => null, requiredMissing: () => [] };
const listeners = {};
global.U = { bus: { emit: () => { throw new Error('LAW VIOLATION: workqueststore must never emit on U.bus'); }, on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); } } };
const notifs = [];
global.StationUI = { rerender() {}, notify: (txt, cls) => notifs.push({ txt, cls }) };
global.SlagLog = SlagLog;
global.Friendly = Friendly;
const { WorkQuestStore } = require('../frontend/app/workqueststore.js');
const fire = (name, p) => (listeners[name] || []).forEach(fn => fn(p));
WorkQuestStore.init();
A.eq((listeners['agent.run.end'] || []).length, 1, 'the store subscribes to run.end once');
{
  WorkQuestStore.accept({ title: 'the price watcher', build: { kind: 'workflow', recipeId: null } });
  fire('agent.run.start', { agentId: 'agent', runId: 'run-link', trigger: 'directive' });
  fire('agent.run.error', { agentId: 'agent', runId: 'run-link', transient: false, reason: 'billing', message: refusedLink });
  notifs.length = 0;
  fire('agent.run.end', { agentId: 'agent', runId: 'run-link', reason: 'error', turns: 0, usd: 0 });
  A.eq(notifs.length, 1, 'a stalled build surfaces exactly one beat');
  A.ok(/price watcher/.test(notifs[0].txt) && /Relink it/.test(notifs[0].txt), 'a build stalled on a refused link says relink: ' + notifs[0].txt);
  A.ok(!/report it|diagnostics/.test(notifs[0].txt), 'a refused link never tells the Commander to report StarNet');
  A.eq(notifs[0].cls, 'warn', 'the beat stays in the neutral WARN family');
}
{
  // a run with NO recorded error keeps the honest generic fix, and an error from an UNBOUND run never leaks into it
  WorkQuestStore.accept({ title: 'the weekly roundup', build: { kind: 'workflow', recipeId: null } });
  fire('agent.run.error', { agentId: 'agent', runId: 'someone-else', transient: false, message: refusedLink });
  fire('agent.run.start', { agentId: 'agent', runId: 'run-plain', trigger: 'directive' });
  notifs.length = 0;
  fire('agent.run.end', { agentId: 'agent', runId: 'run-plain', reason: 'error', turns: 2, usd: 0.01 });
  A.ok(notifs.length === 1 && /report it/.test(notifs[0].txt) && !/Relink/.test(notifs[0].txt), 'an errored build with no error text of its own keeps the generic fix: ' + (notifs[0] && notifs[0].txt));
}
A.report('slag-known-error-kinds.test');
