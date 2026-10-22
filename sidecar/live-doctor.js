/* sidecar/live-doctor.js — pure orchestration + receipt formatting for the opt-in live doctor.

   The host injects every probe. This module owns the small truthful vocabulary and the bounded,
   secret-free receipt. A row may only claim ROUND-TRIP PROVEN when its injected probe returns that
   exact state; configuration or a cached handle is never promoted here.
*/
'use strict';

const STATES = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  REFUSED: 'refused',
  UNREACHABLE: 'unreachable',
  AUTHENTICATED: 'authenticated',
  ROUND_TRIP: 'round-trip-proven'
});
const ALLOWED = new Set(Object.values(STATES));

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/gi, '[redacted-key]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}/gi, '[redacted-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted-jwt]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-hex]')
    .replace(/([?&](?:api[_-]?)?(?:token|key|secret|password|auth)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(:\/\/)[^/@\s]+:[^/@\s]+@/g, '$1[redacted]@')
    .replace(/\b(?:bearer|token|key|secret|password)\b\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ').trim().slice(0, max || 240);
}

function row(kind, id, label, result, startedAt, endedAt) {
  result = result || {};
  const state = ALLOWED.has(result.state) ? result.state : STATES.UNREACHABLE;
  return {
    kind: clean(kind, 32), id: clean(id, 80), label: clean(label || id, 120), state,
    startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
    latencyMs: Math.max(0, Math.round(endedAt - startedAt)), detail: clean(result.detail, 240)
  };
}

function receiptText(report) {
  const lines = [
    'AGENT OS LIVE DOCTOR',
    'when: ' + report.startedAt + ' -> ' + report.endedAt,
    'agent: ' + (report.agentId || '(none)'),
    'result: ' + report.summary.roundTrip + ' round-trip proven; ' + report.summary.authenticated
      + ' authenticated; ' + report.summary.failed + ' failed; ' + report.summary.notConfigured + ' not configured',
    ''
  ];
  for (const r of report.rows) {
    lines.push('[' + r.state.toUpperCase() + '] ' + r.kind + ' / ' + r.label + ' — ' + r.latencyMs + 'ms'
      + (r.detail ? ' — ' + r.detail : ''));
  }
  lines.push('', 'No keys, tokens, prompts, transcripts, command output, or message contents are included.');
  return lines.join('\n');
}

async function runLiveDoctor(opts) {
  opts = opts || {};
  if (opts.confirmed !== true) {
    const e = new Error('explicit live-probe consent is required'); e.code = 'LIVE_DOCTOR_CONSENT_REQUIRED'; throw e;
  }
  const clock = opts.clock;
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock.now injection is required');
  const started = clock.now();
  const tasks = Array.isArray(opts.targets) ? opts.targets.slice(0, 64) : [];
  const probeTimeoutMs = Math.max(1000, Math.min(60000, Number(opts.probeTimeoutMs) || 35000));
  // Every target is independent. Run them concurrently so total wall time is bounded by the slowest probe,
  // not connector-count × timeout. Promise.all preserves the target order in the exported receipt.
  const rows = await Promise.all(tasks.map(async target => {
    const at = clock.now();
    let result;
    let timer = null;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => target.probe()),
        new Promise(resolve => { timer = setTimeout(() => resolve({ state: STATES.UNREACHABLE, detail: 'probe timed out' }), probeTimeoutMs); })
      ]);
    }
    catch (e) { result = { state: STATES.UNREACHABLE, detail: (e && e.message) || 'probe failed' }; }
    finally { if (timer) clearTimeout(timer); }
    const done = clock.now();
    return row(target.kind, target.id, target.label, result, at, done);
  }));
  const ended = clock.now();
  const summary = {
    roundTrip: rows.filter(r => r.state === STATES.ROUND_TRIP).length,
    authenticated: rows.filter(r => r.state === STATES.AUTHENTICATED).length,
    failed: rows.filter(r => r.state === STATES.REFUSED || r.state === STATES.UNREACHABLE).length,
    notConfigured: rows.filter(r => r.state === STATES.NOT_CONFIGURED).length
  };
  const report = {
    version: 1, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(),
    durationMs: Math.max(0, Math.round(ended - started)), agentId: clean(opts.agentId, 80), rows, summary
  };
  return { report, text: receiptText(report) };
}

function failureState(error) {
  const s = String((error && (error.code || error.message)) || error || '').toLowerCase();
  if (/not.configured|missing|no .*configured|configuration.required/.test(s)) return STATES.NOT_CONFIGURED;
  if (/401|403|unauthori[sz]ed|forbidden|rejected|refused|permission|denied/.test(s)) return STATES.REFUSED;
  return STATES.UNREACHABLE;
}

module.exports = { STATES, runLiveDoctor, receiptText, failureState, _internals: { clean, row } };
