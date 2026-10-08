/* node test/slaglog.test.js — the SLAG post-mortem. A pure heuristic: a wasted-spend run.end reason
   (+ the signals already on the bus: turn count, last reconciled cache ratio) -> a real { title, cause,
   fix }. Under test: each waste reason gets actionable wording; budget splits on a cold vs warm cache;
   unknown signals never fabricate a number; the recent-ring caps. */
'use strict';
const A = require('./_assert.js');
const SlagLog = require('../frontend/app/slaglog.js');

// ---- every waste reason yields a non-empty, actionable post-mortem ----
for (const r of ['max_iters', 'budget', 'error', 'refusal']) {
  const d = SlagLog.diagnose(r, {});
  A.eq(d.reason, r, r + ': echoes reason');
  A.ok(d.title && d.cause && d.fix, r + ': has title+cause+fix');
  A.ok(d.fix.length > 8, r + ': fix is real guidance');
}

// ---- max_iters names the turn count when known, stays general when not ----
A.ok(SlagLog.diagnose('max_iters', { turns: 10 }).cause.indexOf('10') >= 0, 'max_iters surfaces turns');
A.ok(SlagLog.diagnose('max_iters', {}).cause.indexOf('budget') >= 0, 'max_iters w/o turns stays general');

// ---- budget splits on cache temperature: cold cache gets the SMELTER lesson ----
const cold = SlagLog.diagnose('budget', { cacheFrac: 0.05 });
A.ok(cold.title.indexOf('cold cache') >= 0, 'cold cache -> smelter diagnosis');
A.ok(cold.cause.indexOf('5%') >= 0, 'cold cache cites the real %');
A.ok(/stable/i.test(cold.fix), 'cold cache fix = keep prompt stable');
const warm = SlagLog.diagnose('budget', { cacheFrac: 0.6 });
A.ok(warm.title.indexOf('cold cache') < 0, 'warm cache -> the plain budget diagnosis');
A.ok(/envelope|split|budget/i.test(warm.fix), 'warm budget fix = raise/split');
// an UNKNOWN cache ratio must not fabricate a % or assume cold
const unk = SlagLog.diagnose('budget', {});
A.ok(unk.title.indexOf('cold cache') < 0, 'unknown cache -> not asserted cold');

// ---- unknown / missing reason degrades safely, never throws ----
A.notThrows(() => SlagLog.diagnose(undefined, null), 'missing reason+ctx safe');
A.eq(SlagLog.diagnose('weird', {}).title, 'unproductive run', 'unknown reason -> generic post-mortem');

// ---- line(): a single-line summary for a notification ----
const ln = SlagLog.line(SlagLog.diagnose('refusal', {}));
A.ok(ln.indexOf('—') >= 0 && ln.length > 12, 'line() = "title — fix"');
A.eq(SlagLog.line(null), '', 'line(null) is empty, not a throw');

// ---- the recent ring records and caps ----
const log = SlagLog.create(3);
A.eq(log.recent().length, 0, 'fresh log empty');
log.record('budget', { cacheFrac: 0.1 });
log.record('error', {});
A.eq(log.recent().length, 2, 'records accumulate');
A.eq(log.recent()[0].reason, 'budget', 'order preserved');
log.record('refusal', {}); log.record('max_iters', { turns: 5 });
A.eq(log.recent().length, 3, 'ring caps at 3');
A.eq(log.recent()[0].reason, 'error', 'oldest dropped first');
log.reset();
A.eq(log.recent().length, 0, 'reset clears the ring');

// an errored run's fix names things a person can do — there is no "agent log" (first-hour walk 2026-09-28)
{
  const e = SlagLog.diagnose('error', {});
  A.ok(!/agent log/i.test(e.fix) && /RECORD/.test(e.fix) && /send the request again/i.test(e.fix) && /diagnostics/.test(e.fix), 'errored-run fix points at RECORD, a resend and copy diagnostics: ' + e.fix);
}

// a KNOWN error class names its own door — never "send it again, report it" for an empty wallet (2026-10-07)
{
  const billing = SlagLog.diagnose('error', { error: { kind: 'billing', msg: 'Your provider account is out of credit — top it up, then try again.' } });
  A.eq(billing.title, 'errored out', 'a known-cause error keeps the errored-out title (the quest still reads "N runs errored out")');
  A.ok(/out of credit/.test(billing.fix) && !/report/i.test(billing.fix) && !/diagnostics/.test(billing.fix), 'an empty wallet names the top-up, not a bug report: ' + billing.fix);
  const unknown = SlagLog.diagnose('error', { error: { kind: 'unknown', msg: 'Something went wrong on that turn — try again.' } });
  A.ok(/diagnostics/.test(unknown.fix) && /report/.test(unknown.fix), 'an UNKNOWN error keeps the resend + report fix (it may be our bug)');
  const local = SlagLog.diagnose('error', { error: { kind: 'server_error', msg: 'The local StarNet service hit an error' } });
  A.ok(/report/.test(local.fix), 'a local server_error keeps the report fix');
  const rec = SlagLog.create(); rec.record('error', { agentId: 'hero' }); rec.record('budget', {});
  A.eq(rec.recent()[0].agentId, 'hero', 'a recorded post-mortem remembers which agent failed');
  A.eq(rec.recent()[1].agentId, undefined, 'no agent given → none invented');
}
A.report('slaglog.test');
